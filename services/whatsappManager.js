const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');

const crypto = require('node:crypto');
const { Agent, Dispatcher } = require('undici');
const qrcode = require('qrcode');
const qrcodeTerminal = require('qrcode-terminal');
const { redisClient } = require('../config/redis');
const fs = require('fs');
const path = require('path');

const { isGroupOrStatusJid, normalizePhoneFromCandidates, toWhatsAppChatId } = require('./phoneUtils');
const { forwardIncomingWhatsAppMessage } = require('./incomingWebhook');
const { markOperatorActive, OPERATOR_ACTIVE_SECONDS } = require('./operatorLock');
const { appendMessageOnce, storeMedia, updateMessageReceipt, MAX_MEDIA_BYTES } = require('./chatStore');
const { publishChatEvent } = require('./chatEvents');
const { allowsPhone, getTestModePolicy, isPhoneAllowed } = require('./testModePolicy');

const WPP_CALL_BUNDLE_PATH = path.join(process.cwd(), 'node_modules', '@wppconnect', 'wa-js', 'dist', 'wppconnect-wa.js');
const wppCallApiLoads = new WeakMap();

const CHAT_STANDARD_TTL_SECONDS = 24 * 60 * 60;
const CHAT_ARCHIVE_TTL_SECONDS = 72 * 60 * 60;
const MEDIA_CDN_TIMEOUT_MS = 12000;
const MEDIA_DOWNLOAD_TIMEOUT_MS = 25000;
const MEDIA_PIPELINE_TIMEOUT_MS = 30000;
const MAX_CONCURRENT_MEDIA_DOWNLOADS = 2;
const MEDIA_DOWNLOAD_COOLDOWN_MS = 15000;
const MAX_MEDIA_BASE64_LENGTH = Math.ceil(MAX_MEDIA_BYTES / 3) * 4;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const localBotSends = new Map();
const permanentMediaFailures = new Set();
const mediaDownloadJobs = new Map();
const mediaDownloadCooldowns = new Map();
const mediaRecoveryJobs = new Map();
const mediaRecoveryMisses = new Set();

let activeMediaDownloads = 0;
let baileysMediaDownloaderPromise;

function isValidChatPhone(phone) {
    return /^\d{10,15}$/.test(String(phone || ''));
}

function chatMediaKey(instanceId, messageId) {
    return `chatwoot:media:${instanceId}:${messageId}`;
}

function normalizeMediaMime(value) {
    return String(value || '').split(';')[0].trim().toLowerCase();
}

function mediaMimeFrom(msg, media) {
    return normalizeMediaMime(media?.mimetype || msg?.mimetype || msg?._data?.mimetype || msg?._data?.mediaData?.mimetype);
}

function isQualifiedAudio(msg, media) {
    const type = String(msg?.type || '').trim().toLowerCase();
    const isSystem = ['system', 'notification', 'notification_template', 'e2e_notification', 'protocol'].includes(type);
    return !isSystem && Boolean(msg?.hasMedia) && mediaMimeFrom(msg, media).startsWith('audio/');
}

function isAudioCandidate(msg) {
    const hintedMime = mediaMimeFrom(msg);
    return Boolean(msg?.hasMedia) && (hintedMime.startsWith('audio/') || ['audio', 'ptt'].includes(String(msg?.type || '').toLowerCase()));
}

function isQualifiedImage(msg, media) {
    const type = String(msg?.type || '').trim().toLowerCase();
    const isSystem = ['system', 'notification', 'notification_template', 'e2e_notification', 'protocol'].includes(type);
    return !isSystem && Boolean(msg?.hasMedia) && (mediaMimeFrom(msg, media).startsWith('image/') || type === 'image');
}

function isQualifiedDocument(msg, media) {
    const type = String(msg?.type || '').trim().toLowerCase();
    const isSystem = ['system', 'notification', 'notification_template', 'e2e_notification', 'protocol'].includes(type);
    const mime = mediaMimeFrom(msg, media);
    // Kaspi receipts arrive as a document with no mimetype at all, so an untyped
    // document is admitted here and settled by the %PDF- check after download.
    return !isSystem && Boolean(msg?.hasMedia) && (mime === 'application/pdf' || (type === 'document' && !mime));
}

function isChatMediaCandidate(msg) {
    return isAudioCandidate(msg) || isQualifiedImage(msg) || isQualifiedDocument(msg);
}

function deliveryStatusFromAck(ack) {
    const value = Number(ack);
    if (value >= 3) return 'read';
    if (value === 2) return 'delivered';
    return 'sent';
}

function permanentMediaError(code) {
    const error = new Error(code);
    error.code = code;
    error.permanent = true;
    return error;
}

function validateAudioBase64(value) {
    const raw = String(value || '').trim();
    const dataUrl = raw.match(/^data:audio\/[^;,]+(?:;[^;,]+)*;base64,([\s\S]+)$/i);
    const base64 = String(dataUrl ? dataUrl[1] : raw).replace(/\s+/g, '');
    if (!base64 || base64.length % 4 !== 0 || base64.length > MAX_MEDIA_BASE64_LENGTH || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) {
        throw permanentMediaError('MEDIA_BASE64_INVALID');
    }
    const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
    const decodedBytes = (base64.length / 4) * 3 - padding;
    if (decodedBytes > MAX_MEDIA_BYTES) throw permanentMediaError('MEDIA_TOO_LARGE');
    const decoded = Buffer.from(base64, 'base64');
    if (!decoded.length || decoded.toString('base64') !== base64) {
        throw permanentMediaError('MEDIA_BASE64_INVALID');
    }
    return base64;
}

function validateImageBase64(value, mimeType) {
    const raw = String(value || '').trim();
    const dataUrl = raw.match(/^data:image\/[^;,]+(?:;[^;,]+)*;base64,([\s\S]+)$/i);
    const base64 = String(dataUrl ? dataUrl[1] : raw).replace(/\s+/g, '');
    if (!base64 || base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) throw permanentMediaError('MEDIA_BASE64_INVALID');
    const decoded = Buffer.from(base64, 'base64');
    if (!decoded.length || decoded.length > MAX_IMAGE_BYTES || decoded.toString('base64') !== base64) throw permanentMediaError(decoded.length > MAX_IMAGE_BYTES ? 'MEDIA_TOO_LARGE' : 'MEDIA_BASE64_INVALID');
    const mime = normalizeMediaMime(mimeType || 'image/jpeg');
    const valid = (mime === 'image/jpeg' && decoded.length >= 3 && decoded[0] === 0xff && decoded[1] === 0xd8 && decoded[2] === 0xff) ||
      (mime === 'image/png' && decoded.subarray(0, 8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]))) ||
      (mime === 'image/gif' && ['GIF87a','GIF89a'].includes(decoded.subarray(0, 6).toString('ascii'))) ||
      (mime === 'image/webp' && decoded.subarray(0, 4).toString('ascii') === 'RIFF' && decoded.subarray(8, 12).toString('ascii') === 'WEBP');
    if (!valid) throw permanentMediaError('IMAGE_SIGNATURE_INVALID');
    return base64;
}

function validateDocumentBase64(value) {
    const raw = String(value || '').trim();
    const dataUrl = raw.match(/^data:application\/pdf(?:;[^;,]+)*;base64,([\s\S]+)$/i);
    const base64 = String(dataUrl ? dataUrl[1] : raw).replace(/\s+/g, '');
    if (!base64 || base64.length % 4 !== 0 || base64.length > MAX_MEDIA_BASE64_LENGTH || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) {
        throw permanentMediaError('MEDIA_BASE64_INVALID');
    }
    const decoded = Buffer.from(base64, 'base64');
    if (!decoded.length || decoded.length > MAX_MEDIA_BYTES || decoded.toString('base64') !== base64) {
        throw permanentMediaError(decoded.length > MAX_MEDIA_BYTES ? 'MEDIA_TOO_LARGE' : 'MEDIA_BASE64_INVALID');
    }
    if (decoded.subarray(0, 5).toString('ascii') !== '%PDF-') throw permanentMediaError('DOCUMENT_SIGNATURE_INVALID');
    return base64;
}

function shouldRetryMediaError(error) {
    return error?.permanent !== true;
}

function verifyMediaFileHash(bytes, expectedHash) {
    if (!expectedHash) return;
    const raw = String(expectedHash).trim().replace(/-/g, '+').replace(/_/g, '/');
    const expected = Buffer.from(raw.padEnd(Math.ceil(raw.length / 4) * 4, '='), 'base64');
    const actual = crypto.createHash('sha256').update(bytes).digest();
    if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
        throw new Error('MEDIA_CDN_FILE_HASH_INVALID');
    }
}

async function getBaileysMediaDownloader() {
    if (!baileysMediaDownloaderPromise) {
        baileysMediaDownloaderPromise = import('@whiskeysockets/baileys')
            .then(module => module.downloadContentFromMessage)
            .catch(error => {
                baileysMediaDownloaderPromise = null;
                throw error;
            });
    }
    return baileysMediaDownloaderPromise;
}

async function collectMediaStream(stream, maxBytes = MAX_MEDIA_BYTES) {
    if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') {
        throw new Error('MEDIA_STREAM_INVALID');
    }
    const chunks = [];
    let total = 0;
    for await (const chunk of stream) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk || []);
        total += bytes.length;
        if (total > maxBytes) {
            if (typeof stream.destroy === 'function') stream.destroy();
            throw permanentMediaError('MEDIA_TOO_LARGE');
        }
        chunks.push(bytes);
    }
    if (!total) throw new Error('MEDIA_DOWNLOAD_EMPTY');
    return Buffer.concat(chunks, total);
}

class RestrictedMediaDispatcher extends Dispatcher {
    constructor(origin, timeoutMs = MEDIA_CDN_TIMEOUT_MS) {
        super();
        this.allowedOrigin = new URL(origin).origin;
        this.agent = new Agent({
            connect: { timeout: timeoutMs },
            headersTimeout: timeoutMs,
            bodyTimeout: timeoutMs,
            keepAliveTimeout: 1,
            keepAliveMaxTimeout: 1
        });
    }

    dispatch(options, handler) {
        let requestedOrigin;
        try {
            requestedOrigin = new URL(String(options.origin)).origin;
        } catch {
            requestedOrigin = '';
        }
        if (requestedOrigin !== this.allowedOrigin) {
            const error = new Error('MEDIA_CDN_HOST_INVALID');
            error.code = 'MEDIA_CDN_HOST_INVALID';
            queueMicrotask(() => handler.onError(error));
            return false;
        }
        return this.agent.dispatch(options, handler);
    }

    close() {
        return this.agent.close();
    }

    destroy(error) {
        return this.agent.destroy(error);
    }
}

function createMediaDispatcher(origin, timeoutMs) {
    return new RestrictedMediaDispatcher(origin, timeoutMs);
}

function baileysMediaSource(msg) {
    const data = msg?._data || {};
    const mediaData = data.mediaData || {};
    const rawDirectPath = String(data.directPath || mediaData.directPath || msg?.directPath || '').trim();
    const rawUrl = String(
        data.clientUrl || mediaData.clientUrl || data.url || mediaData.url ||
        data.deprecatedMms3Url || mediaData.deprecatedMms3Url || msg?.url || ''
    ).trim();
    const mediaKey = msg?.mediaKey || data.mediaKey || mediaData.mediaKey;
    if ((!rawDirectPath && !rawUrl) || !mediaKey) return null;
    let parsed;
    try {
        parsed = new URL(rawDirectPath || rawUrl, rawUrl || 'https://mmg.whatsapp.net');
    } catch {
        throw new Error('MEDIA_CDN_PATH_INVALID');
    }
    const hostname = parsed.hostname.toLowerCase();
    if (parsed.protocol !== 'https:' || (hostname !== 'whatsapp.net' && !hostname.endsWith('.whatsapp.net'))) {
        throw new Error('MEDIA_CDN_HOST_INVALID');
    }
    return {
        mediaKey,
        directPath: rawDirectPath ? `${parsed.pathname}${parsed.search}` : null,
        url: rawUrl || parsed.href,
        host: parsed.host
    };
}

async function downloadBaileysMessageMedia(msg, injectedDownloader, testOptions = {}) {
    const source = baileysMediaSource(msg);
    if (!source) return null;
    const data = msg?._data || {};
    const mediaData = data.mediaData || {};
    const expectedHash = data.filehash || mediaData.filehash;
    if (!expectedHash) return null;
    const downloader = injectedDownloader || await getBaileysMediaDownloader();
    const timeoutMs = Number(testOptions.timeoutMs) > 0 ? Number(testOptions.timeoutMs) : MEDIA_CDN_TIMEOUT_MS;
    const dispatcher = testOptions.dispatcher || createMediaDispatcher(`https://${source.host}`, timeoutMs);
    const task = (async () => {
        const stream = await downloader({
            mediaKey: source.mediaKey,
            directPath: source.directPath,
            url: source.url
        }, isQualifiedImage(msg) ? 'image' : isQualifiedDocument(msg) ? 'document' : 'audio', {
            host: source.host,
            options: { dispatcher }
        });
        const decrypted = await collectMediaStream(stream);
        verifyMediaFileHash(decrypted, expectedHash);
        return {
            data: decrypted.toString('base64'),
            mimetype: data.mimetype || mediaData.mimetype || msg?.mimetype || (String(msg?.type || '').toLowerCase() === 'image' ? 'image/jpeg' : String(msg?.type || '').toLowerCase() === 'document' ? 'application/pdf' : 'audio/ogg'),
            filename: data.filename || mediaData.filename || msg?.filename,
            filesize: decrypted.length
        };
    })();
    try {
        return await withTimeout(task, timeoutMs, 'MEDIA_CDN_TIMEOUT');
    } finally {
        await dispatcher.destroy().catch(() => {});
    }
}

function mediaFailureCode(error) {
    return String(error?.code || error?.message || error || 'unknown').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);
}

async function runWithMediaDownloadSlot(task) {
    if (activeMediaDownloads >= MAX_CONCURRENT_MEDIA_DOWNLOADS) throw new Error('MEDIA_DOWNLOAD_BUSY');
    activeMediaDownloads += 1;
    try {
        return await task();
    } finally {
        activeMediaDownloads -= 1;
    }
}

async function downloadMessageMediaOnce(msg) {
    if (!msg?.hasMedia) return null;
    const messageId = String(msg?.id?._serialized || '').trim();
    const page = msg?.client?.pupPage;
    let blobDownloadError = null;
    let cdnDownloadError = null;

    const declaredSize = Number(msg?._data?.size || msg?._data?.mediaData?.size || 0);
    if (declaredSize > MAX_MEDIA_BYTES) throw permanentMediaError('MEDIA_TOO_LARGE');

    try {
        const media = await downloadBaileysMessageMedia(msg);
        if (media?.data) return media;
    } catch (error) {
        cdnDownloadError = error;
    }

    if (messageId && page && typeof page.evaluate === 'function') {
        try {
            const media = await withTimeout(page.evaluate(async (msgId, maxBytes) => {
                const { Msg } = window.require('WAWebCollections');
                const source = Msg.get(msgId) || (await Msg.getMessagesById([msgId]))?.messages?.[0];
                if (!source?.mediaData || source.mediaData.mediaStage === 'REUPLOADING') return null;
                if (Number(source.size || 0) > maxBytes) return { error: 'MEDIA_TOO_LARGE' };

                await source.downloadMedia({
                    downloadEvenIfExpensive: true,
                    rmrReason: 1,
                    isUserInitiated: true
                });

                const mediaStage = String(source.mediaData.mediaStage || '');
                if (mediaStage.includes('ERROR') || mediaStage === 'FETCHING') return null;

                const cache = window.require('WAWebMediaInMemoryBlobCache').InMemoryMediaBlobCache;
                const cached = cache.get(source.mediaObject?.filehash);
                const blob = cached || source.mediaObject?.mediaBlob?.forceToBlob?.();
                if (!blob || typeof blob.arrayBuffer !== 'function') return null;
                if (Number(blob.size || 0) > maxBytes) return { error: 'MEDIA_TOO_LARGE' };

                let data;
                if (typeof window.WWebJS?.arrayBufferToBase64Async === 'function') {
                    data = await window.WWebJS.arrayBufferToBase64Async(await blob.arrayBuffer());
                } else {
                    data = await new Promise((resolve, reject) => {
                        const reader = new FileReader();
                        reader.onload = () => resolve(String(reader.result || '').split(',', 2)[1] || '');
                        reader.onerror = () => reject(reader.error || new Error('MEDIA_BLOB_READ_FAILED'));
                        reader.readAsDataURL(blob);
                    });
                }

                return {
                    data,
                    mimetype: source.mimetype || blob.type || (String(msg?.type || '').toLowerCase() === 'image' ? 'image/jpeg' : 'audio/ogg'),
                    filename: source.filename,
                    filesize: source.size || blob.size
                };
            }, messageId, MAX_MEDIA_BYTES), MEDIA_DOWNLOAD_TIMEOUT_MS, 'MEDIA_DOWNLOAD_TIMEOUT');
            if (media?.error === 'MEDIA_TOO_LARGE') throw permanentMediaError('MEDIA_TOO_LARGE');
            if (media?.data) return media;
        } catch (error) {
            if (error?.permanent || error?.message === 'MEDIA_DOWNLOAD_TIMEOUT') throw error;
            blobDownloadError = error;
        }
    }

    try {
        const media = await withTimeout(msg.downloadMedia(), MEDIA_DOWNLOAD_TIMEOUT_MS, 'MEDIA_DOWNLOAD_TIMEOUT');
        if (media?.data) return media;
    } catch (error) {
        const failure = new Error(
            `MEDIA_DOWNLOAD_FAILED cdn=${mediaFailureCode(cdnDownloadError)} ` +
            `browser=${mediaFailureCode(blobDownloadError)} legacy=${mediaFailureCode(error)}`
        );
        failure.code = 'MEDIA_DOWNLOAD_FAILED';
        throw failure;
    }
    if (blobDownloadError) {
        throw blobDownloadError instanceof Error ? blobDownloadError : new Error(String(blobDownloadError));
    }
    return null;
}

async function downloadMessageMedia(msg, scope = '') {
    const messageId = String(msg?.id?._serialized || msg?.id?.id || '').trim();
    if (!messageId) return downloadMessageMediaOnce(msg);
    const jobKey = `${String(scope || 'unscoped')}:${messageId}`;
    const cooldownUntil = mediaDownloadCooldowns.get(jobKey) || 0;
    if (cooldownUntil > Date.now()) throw new Error('MEDIA_DOWNLOAD_COOLDOWN');
    if (cooldownUntil) mediaDownloadCooldowns.delete(jobKey);

    const current = mediaDownloadJobs.get(jobKey);
    if (current) return current;

    const job = withTimeout(
        runWithMediaDownloadSlot(() => downloadMessageMediaOnce(msg)),
        MEDIA_PIPELINE_TIMEOUT_MS,
        'MEDIA_DOWNLOAD_TIMEOUT'
    );
    mediaDownloadJobs.set(jobKey, job);
    try {
        const media = await job;
        mediaDownloadCooldowns.delete(jobKey);
        return media;
    } catch (error) {
        if (error?.message === 'MEDIA_DOWNLOAD_TIMEOUT') {
            mediaDownloadCooldowns.set(jobKey, Date.now() + MEDIA_DOWNLOAD_COOLDOWN_MS);
        }
        throw error;
    } finally {
        if (mediaDownloadJobs.get(jobKey) === job) mediaDownloadJobs.delete(jobKey);
    }
}

function incrementLocalBotSend(key, expiresAt = Date.now() + 20000, redisMarked = false) {
    const current = localBotSends.get(key);
    const count = current && current.expiresAt > Date.now() ? current.count : 0;
    const redisCount = current && current.expiresAt > Date.now() ? current.redisCount || 0 : 0;
    localBotSends.set(key, {
        count: count + 1,
        redisCount: redisCount + Number(redisMarked),
        expiresAt: Math.max(current?.expiresAt || 0, expiresAt)
    });
}

function takeLocalBotSend(key, timestamp = Date.now()) {
    const current = localBotSends.get(key);
    if (!current || current.expiresAt <= timestamp || current.count <= 0) {
        localBotSends.delete(key);
        return { matched: false, redisMarked: false };
    }
    const redisMarked = (current.redisCount || 0) > 0;
    if (current.count === 1) localBotSends.delete(key);
    else localBotSends.set(key, {
        ...current,
        count: current.count - 1,
        redisCount: Math.max(0, (current.redisCount || 0) - Number(redisMarked))
    });
    return { matched: true, redisMarked };
}

function consumeLocalBotSend(key, timestamp = Date.now()) {
    return takeLocalBotSend(key, timestamp).matched;
}

function releaseLocalBotSend(key, redisMarked = false) {
    const current = localBotSends.get(key);
    if (!current) return;
    if (current.count <= 1) localBotSends.delete(key);
    else localBotSends.set(key, {
        ...current,
        count: current.count - 1,
        redisCount: Math.max(0, (current.redisCount || 0) - Number(redisMarked))
    });
}

async function hasAuthoritativeMessage(instanceId, phone, messageId) {
    if (!redisClient.isOpen) return false;
    return Number(await redisClient.sendCommand([
        'SISMEMBER', `chatwoot:message-ids:${instanceId}:${phone}`, String(messageId || '')
    ]).catch(() => 0)) === 1;
}

async function removeOrphanedMedia(instanceId, phone, messageId) {
    if (!redisClient.isOpen) return;
    await Promise.all([
        redisClient.sendCommand(['DEL', chatMediaKey(instanceId, messageId)]).catch(() => 0),
        redisClient.sendCommand(['SREM', `chatwoot:media-ids:${instanceId}:${phone}`, messageId]).catch(() => 0)
    ]);
}

async function updatePersistedMediaMetadata(instanceId, phone, messageId, mediaType) {
    if (!redisClient.isOpen) return false;
    const key = `chatwoot:history:${instanceId}:${phone}`;
    const rows = await redisClient.sendCommand(['LRANGE', key, '-500', '-1']).catch(() => []);
    for (let index = rows.length - 1; index >= 0; index -= 1) {
        let entry;
        try { entry = JSON.parse(rows[index]); } catch { continue; }
        if (String(entry?.id || '') !== messageId) continue;
        entry.hasMedia = true;
        entry.mediaType = mediaType;
        entry.mediaKind = entry.mediaKind || entry.type || 'audio';
        entry.pendingMedia = false;
        await redisClient.sendCommand(['LSET', key, String(index), JSON.stringify(entry)]).catch(() => 0);
        return true;
    }
    return false;
}

async function persistMessageMedia(instanceId, phone, msg, options = {}) {
    if (!msg?.hasMedia || !redisClient.isOpen) return null;

    const messageId = String(msg?.id?.id || '').trim();

    if (!messageId) {
        throw permanentMediaError('MEDIA_MESSAGE_ID_MISSING');
    }

    if (options.requireExistingChat && !await hasAuthoritativeMessage(instanceId, phone, messageId)) return null;

    const media = await downloadMessageMedia(msg, `${instanceId}:${phone}`);

    if (!media?.data) {
        throw new Error('MEDIA_DOWNLOAD_EMPTY');
    }

    const isAudio = isQualifiedAudio(msg, media);
    const isImage = isQualifiedImage(msg, media);
    const isDocument = isQualifiedDocument(msg, media);
    if (!isAudio && !isImage && !isDocument) throw permanentMediaError('MEDIA_TYPE_UNSUPPORTED');
    const mediaType = mediaMimeFrom(msg, media) || (isImage ? 'image/jpeg' : isDocument ? 'application/pdf' : 'audio/ogg');

    const base64 = isImage
        ? validateImageBase64(media.data, mediaType)
        : isDocument
            ? validateDocumentBase64(media.data)
            : validateAudioBase64(media.data);
    const decoded = Buffer.from(base64, 'base64');
    if (!decoded.length) throw permanentMediaError('MEDIA_BASE64_INVALID');

    const mediaUrl = `data:${mediaType};base64,${base64}`;
    await storeMedia(instanceId, phone, messageId, base64, mediaType);
    if (options.requireExistingChat && !await hasAuthoritativeMessage(instanceId, phone, messageId)) {
        await removeOrphanedMedia(instanceId, phone, messageId);
        return null;
    }
    if (options.publishReady) {
        const updated = await updatePersistedMediaMetadata(instanceId, phone, messageId, mediaType);
        if (!updated) {
            await removeOrphanedMedia(instanceId, phone, messageId);
            return null;
        }
        await publishChatEvent({ type: 'media.ready', instanceId, phone, messageId, mediaType });
    }

    return {
        media: {
            ...media,
            mimetype: mediaType,
            data: base64
        },
        mediaUrl
    };
}

function scheduleMediaPersist(instanceId, phone, msg) {
    if (!isChatMediaCandidate(msg)) return;

    const delays = [1000, 3000, 7000, 15000, 30000];
    const failureKey = `${instanceId}:${phone}:${String(msg?.id?.id || '')}`;

    delays.forEach(delayMs => {
        setTimeout(async () => {
            try {
                if (permanentMediaFailures.has(failureKey)) return;
                const messageId = String(msg?.id?.id || '').trim();

                if (!messageId || !redisClient.isOpen) return;

                const exists = await redisClient
                    .sendCommand(['EXISTS', chatMediaKey(instanceId, messageId)])
                    .catch(() => 0);

                if (Number(exists) === 1) return;
                if (!await hasAuthoritativeMessage(instanceId, phone, messageId)) {
                    permanentMediaFailures.add(failureKey);
                    return;
                }

                const result = await persistMessageMedia(instanceId, phone, msg, { publishReady: true, requireExistingChat: true });
                if (!result) permanentMediaFailures.add(failureKey);
            } catch (error) {
                if (!shouldRetryMediaError(error)) {
                    permanentMediaFailures.add(failureKey);
                    return;
                }
                console.warn(
                    `[MEDIA RETRY] ${instanceId}: ${msg?.id?.id || '-'} ` +
                    `${error?.message || error}`
                );
            }
        }, delayMs);
    });
    const cleanupTimer = setTimeout(() => permanentMediaFailures.delete(failureKey), delays[delays.length - 1] + 1000);
    cleanupTimer.unref?.();
}

// Барлық активті сессиялар мен QR кодтарды жадыда сақтайтын объектілер
const clients = new Map();
const initializingClients = new Map();
const qrCodes = new Map();
const instanceStates = new Map();
const restartTimers = new Map();
const restartAttempts = new Map();
const authResetting = new Set();
const pendingTextQueues = new Map();
const flushTimers = new Map();
const intentionallyStopped = new Set();
// Every instance the process has ever been asked to run. The supervisor keeps
// this set connected until an operator explicitly stops or deletes it.
const supervisedInstances = new Set();
const stateCheckFailures = new Map();
const throttledLogs = new Map();
let supervisorTimer = null;

const jidMap = new Map();
let shutdownInProgress = false;

const AUTH_DATA_PATH = process.env.WHATSAPP_AUTH_PATH || '/app/whatsapp_auth';
const SESSION_RESTORE_TIMEOUT_MS = Number(process.env.WHATSAPP_RESTORE_TIMEOUT_MS || 120000);
const WA_STATE_TIMEOUT_MS = Number(process.env.WHATSAPP_STATE_TIMEOUT_MS || 2500);
const CHROME_LOCK_RESTART_DELAY_MS = Number(process.env.WHATSAPP_CHROME_LOCK_RESTART_DELAY_MS || 15000);
const WHATSAPP_RESTART_BASE_DELAY_MS = Number(process.env.WHATSAPP_RESTART_BASE_DELAY_MS || 5000);
const WHATSAPP_RESTART_MAX_DELAY_MS = Number(process.env.WHATSAPP_RESTART_MAX_DELAY_MS || 300000);
const WHATSAPP_RESOURCE_RESTART_BASE_DELAY_MS = Number(process.env.WHATSAPP_RESOURCE_RESTART_BASE_DELAY_MS || 30000);
const WHATSAPP_INITIALIZE_MAX_RETRIES = Number(process.env.WHATSAPP_INITIALIZE_MAX_RETRIES || 5);
const OUTGOING_TEXT_QUEUE_TTL_MS = Number(process.env.WHATSAPP_OUTGOING_QUEUE_TTL_MS || 5 * 60 * 1000);
const OUTGOING_TEXT_QUEUE_MAX = Number(process.env.WHATSAPP_OUTGOING_QUEUE_MAX || 50);
// A tenant that still holds stored credentials is expected back within seconds,
// so it never inherits the long generic restart ceiling.
const SESSION_RECONNECT_MAX_DELAY_MS = Number(process.env.WHATSAPP_SESSION_RECONNECT_MAX_DELAY_MS || 60000);
// Background watchdog sweep. Sessions must come back on their own, without
// waiting for a customer message or an operator opening the dashboard.
const SESSION_SUPERVISOR_INTERVAL_MS = Number(process.env.WHATSAPP_SUPERVISOR_INTERVAL_MS || 30000);
// getState() legitimately fails while WhatsApp Web re-syncs, so a client is only
// treated as dead after repeated consecutive failures.
const SESSION_HEALTH_FAILURE_LIMIT = Number(process.env.WHATSAPP_HEALTH_FAILURE_LIMIT || 3);
const LOG_THROTTLE_MS = Number(process.env.WHATSAPP_LOG_THROTTLE_MS || 60000);
// Restart delays carry up to a second of jitter, so two requests for the same
// nominal delay must still be treated as the same reconnect attempt.
const RESTART_DEDUPE_SLACK_MS = 2000;

function getSessionPath(instanceId) {
    return path.join(AUTH_DATA_PATH, `session-${instanceId}`);
}

function hasStoredSession(instanceId) {
    const sessionPath = getSessionPath(instanceId);
    if (!fs.existsSync(sessionPath)) return false;

    try {
        return fs.readdirSync(sessionPath).length > 0;
    } catch (error) {
        return false;
    }
}

function setInstanceState(instanceId, status, extra = {}) {
    instanceStates.set(instanceId, {
        status,
        updatedAt: Date.now(),
        ...extra
    });
}

function clearRestartTimer(instanceId) {
    const entry = restartTimers.get(instanceId);
    if (entry) clearTimeout(entry.timer || entry);
    restartTimers.delete(instanceId);
}

function getRestartTimerInfo(instanceId) {
    const entry = restartTimers.get(instanceId);
    if (!entry) return null;
    return { dueAt: entry.dueAt, reason: entry.reason };
}

// Repeated identical warnings used to fill the log with tens of thousands of
// lines per day, which hid the events that actually mattered.
function logThrottled(key, message, level = 'warn') {
    const now = Date.now();
    const entry = throttledLogs.get(key);
    if (entry && now - entry.at < LOG_THROTTLE_MS) {
        entry.suppressed += 1;
        return false;
    }

    const suppressed = entry ? entry.suppressed : 0;
    throttledLogs.set(key, { at: now, suppressed: 0 });
    const suffix = suppressed > 0 ? ` (+${suppressed} similar suppressed)` : '';
    const write = console[level] || console.log;
    write(`${message}${suffix}`);
    return true;
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function calculateRestartDelay(instanceId, requestedDelayMs = 3000, reason = 'restart', options = {}) {
    const countAttempt = options.countAttempt !== false;
    const attempts = countAttempt
        ? (restartAttempts.get(instanceId) || 0) + 1
        : Math.max(1, restartAttempts.get(instanceId) || 1);
    if (countAttempt) restartAttempts.set(instanceId, attempts);

    const resourceFailure = isChromiumResourceError(reason);
    const baseDelay = resourceFailure ? WHATSAPP_RESOURCE_RESTART_BASE_DELAY_MS : WHATSAPP_RESTART_BASE_DELAY_MS;
    // A stored session reconnects on a short ceiling. Only a tenant that needs a
    // human to scan a QR is allowed to back off for minutes.
    const ceiling = options.hasStoredSession ? SESSION_RECONNECT_MAX_DELAY_MS : WHATSAPP_RESTART_MAX_DELAY_MS;
    const maxDelay = Math.max(baseDelay, ceiling);
    const exponentialDelay = baseDelay * Math.pow(2, Math.min(attempts - 1, 6));
    const jitter = Math.floor(Math.random() * 1000);
    const requested = Math.max(Number(requestedDelayMs) || 0, Math.min(exponentialDelay, maxDelay));

    return Math.min(requested + jitter, maxDelay + 1000);
}

function resetRestartAttempts(instanceId) {
    restartAttempts.delete(instanceId);
}

function getRestartAttempts(instanceId) {
    return restartAttempts.get(instanceId) || 0;
}

function buildReconnectPlan(reason, options = {}) {
    const attempts = Math.max(0, Number(options.attempts) || 0);
    const configuredMax = Number(options.maxRetries);
    const maxRetries = Math.max(0, Number.isFinite(configuredMax) ? Math.floor(configuredMax) : 1);
    const hasStoredSession = Boolean(options.hasStoredSession);
    const freshQr = !hasStoredSession || /LOGOUT|UNPAIRED|QR_START_TIMEOUT|AUTH[_\s-]?FAIL/i.test(String(reason || ''));

    return {
        // Stored credentials are only invalidated by the owner unlinking the
        // device in WhatsApp or by an operator deleting the tenant here, so a
        // session restore retries for as long as the folder exists. Only a
        // fresh-QR lifecycle, which needs a human with a phone, is budgeted.
        shouldRetry: freshQr ? attempts < maxRetries : true,
        allowQrRequired: freshQr,
        mode: freshQr ? 'fresh_qr' : 'session_restore'
    };
}

function isAuthenticationFailureReason(reason) {
    return /DISCONNECTED|LOGOUT|UNPAIRED|UNPAIRED_IDLE|AUTH[_\s-]?FAIL|AUTHENTICATION|INVALID[_\s-]?(SESSION|CREDENTIAL|AUTH)|SESSION[_\s-]?CLOSED|NOT[_\s-]?LOGGED|401|403/i.test(String(reason || ''));
}

function queueOutgoingText(instanceId, phone, text, reason = 'client_not_ready', attempts = 0) {
    if (!text) return;

    const queue = pendingTextQueues.get(instanceId) || [];
    queue.push({
        phone,
        text,
        reason,
        attempts,
        createdAt: Date.now()
    });

    while (queue.length > OUTGOING_TEXT_QUEUE_MAX) queue.shift();
    pendingTextQueues.set(instanceId, queue);
    console.warn(`[WHATSAPP QUEUE] ${instanceId} -> ${phone}: queued text (${reason}). pending=${queue.length}`);
}

function scheduleFlush(instanceId, delayMs = 1000) {
    const current = flushTimers.get(instanceId);
    if (current) clearTimeout(current);

    flushTimers.set(instanceId, setTimeout(() => {
        flushTimers.delete(instanceId);
        flushPendingOutgoingText(instanceId).catch(error => {
            console.error(`[WHATSAPP QUEUE] ${instanceId} flush failed:`, error.message);
        });
    }, delayMs));
}

function scheduleRestart(instanceId, delayMs = 3000, reason = 'restart', options = {}) {
    if (shutdownInProgress) return;
    if (intentionallyStopped.has(instanceId)) return;

    const storedSession = hasStoredSession(instanceId);
    // A tenant waiting for a human to scan a QR must not be yanked out of that
    // state by background traffic, but one holding credentials always reconnects.
    if (instanceStates.get(instanceId)?.status === 'qr_required' && !options.allowQrRequired && !storedSession) return;

    const pending = restartTimers.get(instanceId);
    const requestedDueAt = Date.now() + Math.max(0, Number(delayMs) || 0);
    if (pending && pending.dueAt <= requestedDueAt + RESTART_DEDUPE_SLACK_MS) {
        // Keep the earliest pending reconnect. Clearing and re-arming the timer
        // on every status poll or queued message is what previously pushed the
        // restart permanently into the future and starved reconnection.
        return;
    }

    clearRestartTimer(instanceId);
    const finalDelayMs = calculateRestartDelay(instanceId, delayMs, reason, {
        hasStoredSession: storedSession,
        countAttempt: options.countAttempt
    });
    setInstanceState(instanceId, 'restarting', { reason, nextRestartInMs: finalDelayMs });
    logThrottled(`restart:${instanceId}:${reason}`, `[WHATSAPP] ${instanceId} restart scheduled in ${finalDelayMs}ms (${reason}).`);
    const timer = setTimeout(() => {
        restartTimers.delete(instanceId);
        if (!clients.has(instanceId) && !intentionallyStopped.has(instanceId)) {
            instanceStates.delete(instanceId);
            startWhatsAppInstance(instanceId).catch(error => {
                console.error(`[WHATSAPP] ${instanceId} restart failed:`, error.message);
            });
        }
    }, finalDelayMs);
    if (typeof timer.unref === 'function') timer.unref();
    restartTimers.set(instanceId, { timer, dueAt: Date.now() + finalDelayMs, reason });
}

// Non-destructive reconnect request used by traffic paths. It never deletes
// credentials and never disturbs an in-flight startup.
function requestReconnect(instanceId, reason = 'reconnect_requested') {
    if (shutdownInProgress || intentionallyStopped.has(instanceId)) return false;
    if (clients.has(instanceId)) return false;
    if (initializingClients.has(instanceId)) return false;
    if (restartTimers.has(instanceId)) return false;
    if (qrCodes.has(instanceId)) return false;

    scheduleRestart(instanceId, 5000, reason);
    return true;
}

// Drops queued outgoing text that outlived its TTL. This runs before any client
// check so a missing client can never keep the queue alive forever.
function purgeExpiredOutgoingText(instanceId) {
    const queue = pendingTextQueues.get(instanceId) || [];
    if (!queue.length) return queue;

    const now = Date.now();
    const alive = queue.filter(item => {
        if (now - item.createdAt <= OUTGOING_TEXT_QUEUE_TTL_MS) return true;
        console.warn(`[WHATSAPP QUEUE] ${instanceId} -> ${item.phone}: dropped expired text (${item.reason}).`);
        return false;
    });

    if (alive.length) pendingTextQueues.set(instanceId, alive);
    else pendingTextQueues.delete(instanceId);

    return alive;
}

// A single failed health probe means nothing; several in a row mean the browser
// is gone. Credentials are never touched here.
function registerHealthFailure(instanceId, reason = 'state_check_failed') {
    const failures = (stateCheckFailures.get(instanceId) || 0) + 1;
    stateCheckFailures.set(instanceId, failures);
    if (failures < SESSION_HEALTH_FAILURE_LIMIT) return failures;

    stateCheckFailures.delete(instanceId);
    clients.delete(instanceId);
    setInstanceState(instanceId, 'disconnected', { reason });
    scheduleRestart(instanceId, 5000, `health_check_failed`);
    return failures;
}

// 24/7 watchdog: brings back anything that is not connected, with no dependency
// on customer traffic or on an operator opening the dashboard.
async function reviveSupervisedInstances() {
    if (shutdownInProgress) return;

    for (const instanceId of [...supervisedInstances]) {
        if (intentionallyStopped.has(instanceId)) continue;

        try {
            if (clients.has(instanceId)) {
                // Probing the status is enough: it detects a closed browser or a
                // repeatedly unresponsive client and hands it to the scheduler.
                await getInstanceStatus(instanceId);
                continue;
            }

            if (initializingClients.has(instanceId)) continue;
            if (restartTimers.has(instanceId)) continue;
            if (qrCodes.has(instanceId)) continue;

            const state = instanceStates.get(instanceId);
            if (state && ['starting', 'qr_ready', 'restoring_session', 'restarting'].includes(state.status)) continue;

            logThrottled(`supervisor:${instanceId}`, `[WHATSAPP SUPERVISOR] ${instanceId} is not connected; reconnecting.`);
            instanceStates.delete(instanceId);
            await startWhatsAppInstance(instanceId);
        } catch (error) {
            console.error(`[WHATSAPP SUPERVISOR] ${instanceId} revive failed:`, error?.message || error);
        }
    }
}

function startSessionSupervisor() {
    if (supervisorTimer) return supervisorTimer;

    supervisorTimer = setInterval(() => {
        reviveSupervisedInstances().catch(error => {
            console.error('[WHATSAPP SUPERVISOR] sweep failed:', error?.message || error);
        });
    }, SESSION_SUPERVISOR_INTERVAL_MS);
    if (typeof supervisorTimer.unref === 'function') supervisorTimer.unref();
    console.log(`[WHATSAPP SUPERVISOR] session watchdog started (${SESSION_SUPERVISOR_INTERVAL_MS}ms).`);
    return supervisorTimer;
}

function stopSessionSupervisor() {
    if (supervisorTimer) clearInterval(supervisorTimer);
    supervisorTimer = null;
}

function removeSessionFolder(instanceId, reason = 'manual') {
    const sessionPath = getSessionPath(instanceId);
    if (!fs.existsSync(sessionPath)) return;

    fs.rmSync(sessionPath, { recursive: true, force: true });
    console.log(`[WHATSAPP] ${instanceId} session folder cleared (${reason}).`);
}

async function resetInvalidSession(instanceId, client, reason = 'auth_invalid', startFreshQr = true) {
    if (authResetting.has(instanceId)) {
        setInstanceState(instanceId, 'qr_required', { reason, hasStoredSession: false });
        return { success: true, status: 'qr_required', reason };
    }

    authResetting.add(instanceId);
    clearRestartTimer(instanceId);
    resetRestartAttempts(instanceId);
    qrCodes.delete(instanceId);
    clients.delete(instanceId);
    initializingClients.delete(instanceId);
    pendingTextQueues.delete(instanceId);

    const flushTimer = flushTimers.get(instanceId);
    if (flushTimer) clearTimeout(flushTimer);
    flushTimers.delete(instanceId);

    setInstanceState(instanceId, 'qr_required', { reason, hasStoredSession: false });

    try {
        if (client) await destroyClient(client);
    } catch (error) {}

    removeSessionFolder(instanceId, reason);
    cleanupChromiumRuntimeLocks(instanceId);
    console.warn(`[WHATSAPP] ${instanceId} invalid session reset; QR required (${reason}).`);

    authResetting.delete(instanceId);

 if (startFreshQr && !shutdownInProgress && !intentionallyStopped.has(instanceId)) {
        setTimeout(() => {
            startWhatsAppInstance(instanceId, { freshAfterAuthReset: true }).catch(error => {
                console.error(`[WHATSAPP] ${instanceId} QR start failed:`, error.message);
            });
        }, 5000); // 5 секунд күтіп барып жаңа QR сұрайды (шексіз циклді біржолата блоктайды)
    }

    return { success: true, status: 'qr_required', reason };
}

function isChromiumProfileLockError(error) {
    return /profile appears to be in use|process_singleton|SingletonLock|Code:\s*21/i.test(String(error?.message || error || ''));
}

function isChromiumResourceError(error) {
    return /Resource temporarily unavailable|posix_spawn|chrome_crashpad_handler|crashpad|ENOMEM|EAGAIN|Code:\s*null|Failed to launch the browser process|Target closed|Requesting main frame too early|Protocol error|Navigating frame was detached|browser has disconnected/i.test(String(error?.message || error || ''));
}

function cleanupChromiumRuntimeLocks(instanceId) {
    const sessionPath = getSessionPath(instanceId);
    if (!fs.existsSync(sessionPath)) return 0;

    const stack = [sessionPath];
    let removed = 0;

    while (stack.length) {
        const current = stack.pop();
        let entries = [];
        try {
            entries = fs.readdirSync(current, { withFileTypes: true });
        } catch (error) {
            continue;
        }

        for (const entry of entries) {
            const fullPath = path.join(current, entry.name);
            if (entry.isDirectory()) {
                if (/^(Crashpad|Crash Reports)$/i.test(entry.name)) {
                    try {
                        fs.rmSync(fullPath, { recursive: true, force: true });
                        removed += 1;
                    } catch (error) {}
                    continue;
                }
                stack.push(fullPath);
                continue;
            }

            if (/^(SingletonLock|SingletonSocket|SingletonCookie|DevToolsActivePort)$/i.test(entry.name)) {
                try {
                    fs.rmSync(fullPath, { force: true });
                    removed += 1;
                } catch (error) {}
            }
        }
    }

    if (removed > 0) {
        console.warn(`[WHATSAPP] ${instanceId} removed ${removed} stale Chromium runtime lock file(s).`);
    }

    return removed;
}

async function destroyClient(client) {
    try {
        await client.destroy();
    } catch (error) {}
}

function isClientPageClosed(client) {
    try {
        return Boolean(client?.pupPage?.isClosed?.());
    } catch (error) {
        return true;
    }
}

function isConnectedState(state) {
    return String(state || '').toUpperCase() === 'CONNECTED';
}

async function getReadyClient(instanceId) {
    const client = clients.get(instanceId);
    if (!client) return null;

    if (isClientPageClosed(client)) {
        clients.delete(instanceId);
        setInstanceState(instanceId, 'disconnected', { reason: 'browser_page_closed' });
        scheduleRestart(instanceId, 3000, 'browser_page_closed');
        return null;
    }

    return client;
}

function withTimeout(promise, ms, label) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(label)), ms);
    });

    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function getContactPhoneFromMessage(msg) {
    if (typeof msg.getContact !== 'function') return '';

    try {
        const contact = await withTimeout(msg.getContact(), 2000, 'CONTACT_LOOKUP_TIMEOUT');
        return normalizePhoneFromCandidates([
            contact?.number,
            contact?.id?._serialized,
            contact?.id?.user,
            contact?.userid
        ]);
    } catch (error) {
        return '';
    }
}

async function wasBotSending(instanceId, phone) {
    if (!phone) return false;

    const key = `bot_sending:${instanceId}:${phone}`;
    const localMarker = takeLocalBotSend(key);
    const localMatch = localMarker.matched;
    if (!redisClient.isOpen) return localMatch;
    const script = [
        "local count = tonumber(redis.call('GET', KEYS[1]) or '0')",
        "if count <= 0 then return 0 end",
        "if count == 1 then redis.call('DEL', KEYS[1]) else redis.call('DECR', KEYS[1]) end",
        'return 1'
    ].join('\n');
    const shouldConsumeRedis = !localMatch || localMarker.redisMarked;
    const redisMatch = shouldConsumeRedis && Number(await redisClient.sendCommand(['EVAL', script, '1', key]).catch(() => 0)) === 1;
    return localMatch || redisMatch;
}

async function releaseBotSending(marker) {
    const key = typeof marker === 'string' ? marker : marker?.key;
    if (!key) return;
    releaseLocalBotSend(key, Boolean(marker?.redisMarked));
    if (!redisClient.isOpen || (typeof marker === 'object' && !marker.redisMarked)) return;
    const script = [
        "local count = tonumber(redis.call('GET', KEYS[1]) or '0')",
        "if count <= 0 then return 0 end",
        "if count == 1 then redis.call('DEL', KEYS[1]) else redis.call('DECR', KEYS[1]) end",
        'return 1'
    ].join('\n');
    await redisClient.sendCommand(['EVAL', script, '1', key]).catch(() => 0);
}

async function getOutgoingPhoneFromMessage(client, msg) {
    const candidates = [
        msg?.to,
        msg?._data?.to,
        msg?.id?.remote,
        msg?._data?.id?.remote,
        msg?._data?.from,
        msg?.from
    ];

    let phone = normalizePhoneFromCandidates(candidates);
    if (!phone && typeof getPhoneFromLid === 'function') {
        phone = await getPhoneFromLid(client, candidates);
    }
    if (!phone) {
        phone = await getContactPhoneFromMessage(msg);
    }

    return phone;
}

function buildOperatorHistoryEntry(instanceId, phone, text, source, messageId, media = {}, createdAt = Date.now()) {
    return {
        id: String(messageId || `${source}:${createdAt}:${phone}`),
        instanceId,
        phone,
        direction: 'outgoing',
        fromMe: true,
        role: 'operator',
        text,
        body: text,
        type: media.hasMedia || media.pendingAudio ? 'audio' : 'chat',
        hasMedia: Boolean(media.hasMedia),
        mediaType: media.hasMedia ? media.mediaType : '',
        mediaKind: media.hasMedia || media.pendingAudio ? (media.mediaKind || 'audio') : '',
        pendingMedia: Boolean(media.pendingAudio && !media.hasMedia),
        createdAt,
        source,
        deliveryStatus: 'sent'
    };
}

async function saveOperatorOutgoingHistory(instanceId, phone, text, source, messageId, media = {}) {
    if (!redisClient.isOpen || !isValidChatPhone(phone) || (!text && !media.hasMedia && !media.pendingAudio)) return null;

    const entry = buildOperatorHistoryEntry(instanceId, phone, text, source, messageId, media);

    const stored = await appendMessageOnce(instanceId, phone, entry, {
        state: 'operator', preserveArchive: true, preserveStateOnDuplicate: true
    });
    if (stored.stale) return null;
    if (stored.inserted) await publishChatEvent({ type: 'history.append', instanceId, phone, message: stored });
    return stored;
}

async function getContactInfoFromMessage(msg) {
    if (typeof msg.getContact !== 'function') return {};

    try {
        const contact = await withTimeout(msg.getContact(), 1500, 'CONTACT_LOOKUP_TIMEOUT');
        return {
            id: contact?.id?._serialized || '',
            number: contact?.number || contact?.id?.user || contact?.userid || '',
            name: contact?.name || '',
            shortName: contact?.shortName || '',
            pushName: contact?.pushname || contact?.pushName || msg?._data?.notifyName || '',
            isMyContact: Boolean(contact?.isMyContact),
            isWAContact: Boolean(contact?.isWAContact)
        };
    } catch (error) {
        return {};
    }
}

async function getPhoneFromLid(client, values = []) {
    if (typeof client.getContactLidAndPhone !== 'function') return '';

    const lid = values.find(value => typeof value === 'string' && value.endsWith('@lid'));
    if (!lid) return '';

    try {
        const result = await withTimeout(client.getContactLidAndPhone([lid]), 3000, 'LID_PHONE_LOOKUP_TIMEOUT');
        const phone = normalizePhoneFromCandidates([
            result?.[0]?.pn,
            result?.[0]?.phone
        ]);

        if (phone) console.log(`✅ [LID RESOLVER] ${lid} -> ${phone}@c.us`);
        return phone;
    } catch (error) {
        console.warn(`⚠️ [LID RESOLVER] ${lid} -> phone табылмады:`, error.message);
        return '';
    }
}

// 1. ЖАҢА ИНСТАНС ҚОСУ НЕ ЖҮКТЕУ ФУНКЦИЯСЫ
async function startWhatsAppInstance(instanceId, options = {}) {
    if (shutdownInProgress) {
        return { success: false, message: 'Server is shutting down.', status: 'stopping' };
    }

    if (clients.has(instanceId)) {
        const currentStatus = await getInstanceStatus(instanceId);
        if (currentStatus.status === 'connected') {
            return { success: true, message: 'Already connected.', ...currentStatus };
        }
        clients.delete(instanceId);
    }

    const currentState = instanceStates.get(instanceId);
    if (currentState && ['starting', 'qr_ready', 'restoring_session', 'restarting'].includes(currentState.status)) {
        return {
            success: true,
            message: 'Instance is already starting.',
            ...currentState,
            qr: currentState.status === 'qr_ready' ? qrCodes.get(instanceId) : undefined
        };
    }

    if (clients.has(instanceId)) {
        return { success: true, message: 'Бұл инстанс қосылып тұр.' };
    }

    clearRestartTimer(instanceId);
    intentionallyStopped.delete(instanceId);
    supervisedInstances.add(instanceId);
    stateCheckFailures.delete(instanceId);
    const sessionExists = hasStoredSession(instanceId);
    setInstanceState(instanceId, sessionExists ? 'restoring_session' : 'qr_required', { hasStoredSession: sessionExists });
    if (sessionExists) {
        console.log(`[WHATSAPP] ${instanceId} stored session found; single restore attempt without QR.`);
    } else if (!options.freshAfterAuthReset) {
        console.log(`[WHATSAPP] ${instanceId} no stored session; QR required.`);
    }
    cleanupChromiumRuntimeLocks(instanceId);
    console.log(`🚀 [WHATSAPP] ${instanceId} үшін жаңа сессия іске қосылуда...`);

   const client = new Client({
        authStrategy: new LocalAuth({ 
            clientId: instanceId,
            dataPath: AUTH_DATA_PATH
        }),
        puppeteer: {
            headless: true,
            executablePath: fs.existsSync('/usr/bin/chromium-browser') ? '/usr/bin/chromium-browser' : (fs.existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : '/usr/bin/chromium'),
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-default-browser-check',
                '--no-zygote',
                '--disable-gpu',
                '--disable-extensions',
                '--disable-background-networking',
                '--disable-sync',
                '--disable-crash-reporter',
                '--disable-crashpad',
                '--disable-breakpad',
                '--disable-features=Translate,BackForwardCache',
                // WhatsApp Web decides during the handshake whether this device
                // can take a call, and it asks the browser for an audio input to
                // do it. Headless Chromium has no microphone, so it answered no
                // and the server never routed calls here at all: the page saw
                // the missed-call chat entry and no call.incoming_call event.
                // These make Chromium report a silent fake microphone.
                '--use-fake-device-for-media-stream',
                '--use-fake-ui-for-media-stream',
                '--allow-file-access-from-files',
                '--autoplay-policy=no-user-gesture-required'
            ]
        }
    });
    initializingClients.set(instanceId, client);

    // 🚀 ЖАҢА: ЗОМБИ СЕССИЯДАН ҚОРҒАНУ (WATCHDOG TIMER)
    let isReady = false;
    const watchdog = setTimeout(async () => {
        if (!isReady && !qrCodes.has(instanceId)) {
            if (shutdownInProgress || intentionallyStopped.has(instanceId)) return;
            if (sessionExists) {
                console.warn(`[WHATSAPP] ${instanceId} stored session restore timed out; preserving credentials for a bounded retry.`);
                await destroyClient(client);
                initializingClients.delete(instanceId);
                cleanupChromiumRuntimeLocks(instanceId);
                clients.delete(instanceId);
                qrCodes.delete(instanceId);
                const recovery = buildReconnectPlan('restore_timeout', {
                    attempts: getRestartAttempts(instanceId),
                    maxRetries: WHATSAPP_INITIALIZE_MAX_RETRIES,
                    hasStoredSession: true
                });
                if (recovery.shouldRetry) {
                    scheduleRestart(instanceId, 5000, 'restore_timeout');
                } else {
                    setInstanceState(instanceId, 'qr_required', {
                        reason: 'restore_timeout',
                        hasStoredSession: true
                    });
                    console.error(`[WHATSAPP] ${instanceId} restore retry budget exhausted; credentials were preserved for operator recovery.`);
                }
                return;
            }
            console.warn(`[WHATSAPP] ${instanceId} QR startup timed out; scheduling a bounded fresh QR retry.`);
            await destroyClient(client);
            initializingClients.delete(instanceId);
            cleanupChromiumRuntimeLocks(instanceId);
            clients.delete(instanceId);
            qrCodes.delete(instanceId);
            setInstanceState(instanceId, 'qr_required', { reason: 'qr_start_timeout', hasStoredSession: false });
            const recovery = buildReconnectPlan('qr_start_timeout', {
                attempts: getRestartAttempts(instanceId),
                maxRetries: WHATSAPP_INITIALIZE_MAX_RETRIES,
                hasStoredSession: false
            });
            if (recovery.shouldRetry) {
                scheduleRestart(instanceId, 5000, 'qr_start_timeout', { allowQrRequired: recovery.allowQrRequired });
            }
            return;
        }
    }, SESSION_RESTORE_TIMEOUT_MS); // restore can be slow after deploy

    // 2. QR КОД ПАЙДА БОЛҒАНДА
    client.on('qr', async (qr) => {
        if (shutdownInProgress || intentionallyStopped.has(instanceId)) {
            clearTimeout(watchdog);
            qrCodes.delete(instanceId);
            initializingClients.delete(instanceId);
            await destroyClient(client);
            return;
        }

        clearTimeout(watchdog); // 🚀 QR келсе, таймерді тоқтатамыз
        setInstanceState(instanceId, 'qr_ready');
        console.log(`⏳ [WHATSAPP] ${instanceId} үшін QR код дайын! Сканерлеу күтілуде...`);
        // A live QR grants access to the WhatsApp account. Keep it out of
        // centralized production logs; the signed onboarding UI is the only
        // supported sharing surface.
        if (process.env.NODE_ENV !== 'production' && process.env.LOG_QR_TO_TERMINAL === 'true') {
            qrcodeTerminal.generate(qr, { small: true });
        }
        try {
            const qrImageUrl = await qrcode.toDataURL(qr);
            qrCodes.set(instanceId, qrImageUrl);
        } catch (err) {
            console.error(`❌ [WHATSAPP] QR генерация қатесі:`, err.message);
        }
    });

    // 3. СӘТТІ ҚОСЫЛҒАНДА
    client.on('ready', () => {
        isReady = true;
        if (shutdownInProgress || intentionallyStopped.has(instanceId)) {
            initializingClients.delete(instanceId);
            qrCodes.delete(instanceId);
            destroyClient(client).catch(() => {});
            return;
        }

        resetRestartAttempts(instanceId);
        clearTimeout(watchdog); // 🚀 Қосылса, таймерді тоқтатамыз
        console.log(`✅ [WHATSAPP] ${instanceId} сәтті қосылды және жұмысқа дайын!`);
        qrCodes.delete(instanceId); 
        setInstanceState(instanceId, 'connected');
        initializingClients.delete(instanceId);
        
        // 🚀 ЕҢ МАҢЫЗДЫ ӨЗГЕРІС: Инстансты тек 100% ҚОСЫЛҒАНДА ғана жадыға жазамыз!
        clients.set(instanceId, client);
        scheduleFlush(instanceId, 500);

        // The call API is primed here rather than on the first call: injecting
        // the bundle takes a couple of seconds, and a caller only rings for
        // about fifteen. Paying that cost while the phone is ringing is how a
        // rejection arrives too late to stop it.
        void ensureWppCallApi(client)
            .then(async ready => {
                console.log(`[WHATSAPP CALL] ${instanceId}: call API ${ready ? 'ready' : 'unavailable'}`);
                if (ready) await watchWppIncomingCalls(instanceId, client);
                await reportCallHookHealth(instanceId, client);
            })
            .catch(err => console.warn(`[WHATSAPP CALL] ${instanceId}: call API preload failed: ${err?.message || err}`));
    });

    // 4. БАЙЛАНЫС ҮЗІЛГЕНДЕ
   client.on('disconnected', async (reason) => {
        const reasonText = String(reason || '').toUpperCase();
        console.log(`⚠️ [WHATSAPP] ${instanceId} байланыс үзілді! Себебі:`, reasonText);
        
        initializingClients.delete(instanceId);
        clients.delete(instanceId);
        qrCodes.delete(instanceId);
        clearTimeout(watchdog);
        await destroyClient(client);
        cleanupChromiumRuntimeLocks(instanceId);

        if (intentionallyStopped.has(instanceId)) return;

        if (reasonText.includes('LOGOUT') || reasonText.includes('UNPAIRED')) {
            console.log(`❌ [WHATSAPP] ${instanceId} ТЕЛЕФОННАН ШЫҒЫП КЕТТІ (LOGOUT).`);
            removeSessionFolder(instanceId, 'logout_by_user');
            setInstanceState(instanceId, 'qr_required', { reason: 'Телефоннан шығып кеттіңіз. Жаңа QR күтіңіз.', hasStoredSession: false });
            const recovery = buildReconnectPlan(reasonText, {
                attempts: getRestartAttempts(instanceId),
                maxRetries: WHATSAPP_INITIALIZE_MAX_RETRIES,
                hasStoredSession: false
            });
            if (recovery.shouldRetry) {
                scheduleRestart(instanceId, 5000, 'logout_unpaired', { allowQrRequired: recovery.allowQrRequired });
            }
            return;
        }

        setInstanceState(instanceId, 'disconnected', { reason: reasonText });
        scheduleRestart(instanceId, 10000, reasonText || 'disconnected');
    });

    // 4.1. АВТОРИЗАЦИЯ ҚАТЕСІ БОЛҒАНДА
    client.on('auth_failure', async (msg) => {
        console.error(`❌ [WHATSAPP] ${instanceId} АВТОРИЗАЦИЯ ҚАТЕСІ:`, msg);
        initializingClients.delete(instanceId);
        clients.delete(instanceId);
        qrCodes.delete(instanceId);
        clearTimeout(watchdog);
        setInstanceState(instanceId, 'qr_required', { reason: String(msg || 'auth_failure'), hasStoredSession: false });

        if (!intentionallyStopped.has(instanceId)) {
            await resetInvalidSession(instanceId, client, `auth_failure: ${String(msg || '')}`, true);
        } else {
            await destroyClient(client);
        }
    });

    // 5. ЖАҢА ХАТ КЕЛГЕНДЕ
    client.on('message_create', async (msg) => {
        try {
            if (!msg?.fromMe) return;
            if (isGroupOrStatusJid(msg.to) || isGroupOrStatusJid(msg.from) || isGroupOrStatusJid(msg?._data?.id?.remote)) return;

            const text = String(msg.body || '').trim();
            const phone = await getOutgoingPhoneFromMessage(client, msg);
            if (!isValidChatPhone(phone)) return;
            if (!(await isPhoneAllowed(instanceId, phone))) return;
            if (await wasBotSending(instanceId, phone)) return;

            await markOperatorActive(instanceId, phone, 'whatsapp_app');
            if (redisClient.isOpen) {
                await redisClient.sendCommand(['SET', `mute:${instanceId}:${phone}`, 'muted_by_agent', 'EX', String(OPERATOR_ACTIVE_SECONDS)]).catch(() => {});
            }
            const audioCandidate = isAudioCandidate(msg);
            const hintedMediaType = mediaMimeFrom(msg);
            const hasAudioHint = isQualifiedAudio(msg, hintedMediaType ? { mimetype: hintedMediaType } : null);
            await saveOperatorOutgoingHistory(instanceId, phone, text, 'whatsapp_app', msg?.id?.id, {
                hasMedia: hasAudioHint,
                pendingAudio: audioCandidate,
                mediaType: hasAudioHint ? hintedMediaType : '',
                mediaKind: audioCandidate ? String(msg.type || 'audio') : ''
            });
            if (audioCandidate) {
                scheduleMediaPersist(instanceId, phone, msg);
                try {
                    await persistMessageMedia(instanceId, phone, msg, { publishReady: true, requireExistingChat: true });
                } catch (error) {
                    if (!shouldRetryMediaError(error)) {
                        permanentMediaFailures.add(`${instanceId}:${phone}:${String(msg?.id?.id || '')}`);
                    }
                }
            }
            await publishChatEvent({
                type: 'lock.changed',
                instanceId,
                phone,
                ttl: OPERATOR_ACTIVE_SECONDS,
                expiresAt: Date.now() + OPERATOR_ACTIVE_SECONDS * 1000
            });
            console.log(`[OPERATOR LOCK] ${instanceId} -> ${phone}: direct WhatsApp reply activated handoff lock.`);
        } catch (error) {
            console.error(`[OPERATOR LOCK] ${instanceId} message_create failed:`, error.message);
        }
    });

    client.on('message_ack', async (msg, ack) => {
        try {
            if (!msg?.fromMe) return;
            const phone = await getOutgoingPhoneFromMessage(client, msg);
            const messageId = String(msg?.id?.id || '').trim();
            if (!isValidChatPhone(phone) || !messageId) return;

            const deliveryStatus = deliveryStatusFromAck(ack);
            let updated = false;
            for (const retryDelay of [0, 200, 500, 1000, 2000]) {
                if (retryDelay) await delay(retryDelay);
                updated = await updateMessageReceipt(instanceId, phone, messageId, deliveryStatus);
                if (updated) break;
            }
            if (!updated) return;
            await publishChatEvent({
                type: 'message.ack',
                instanceId,
                phone,
                messageId,
                deliveryStatus
            });
        } catch (error) {
            console.warn(`[MESSAGE ACK] ${instanceId}:`, error.message);
        }
    });

    client.on('message', async (msg) => {
        if (isGroupOrStatusJid(msg.from)) return;

        let realSender = msg.from;
        let cleanNumber = '';
        let contactInfo = {};

        try {
            const possibleJids = [
                msg.author, msg._data?.author, msg.id?.participant,
                msg._data?.id?.participant, msg._data?.id?.remote,
                msg._data?.from, msg._data?.sender?.id,
                msg._data?.sender?.userid, msg.from
            ];

            cleanNumber = normalizePhoneFromCandidates(possibleJids);
            if (!cleanNumber && typeof getPhoneFromLid === 'function') {
                cleanNumber = await getPhoneFromLid(client, possibleJids);
            }
            if (typeof getContactInfoFromMessage === 'function') {
                contactInfo = await getContactInfoFromMessage(msg);
            }
            if (!cleanNumber) {
                cleanNumber = normalizePhoneFromCandidates([
                    contactInfo.number, contactInfo.id
                ]);
            }
            if (!isValidChatPhone(cleanNumber)) return;

            if (cleanNumber) {
                realSender = `${cleanNumber}@c.us`; 
                jidMap.set(cleanNumber, msg.from);  
            }
        } catch (err) {}

        console.log(`📥 [${instanceId}] Жаңа хат: ${msg.from} -> ${msg.body}`);

       
        scheduleMediaPersist(instanceId, cleanNumber, msg);

        let downloadedMedia = null;
        if (isChatMediaCandidate(msg)) {
            try {
                downloadedMedia = (await persistMessageMedia(instanceId, cleanNumber, msg))?.media || null;
            } catch (error) {
                if (!shouldRetryMediaError(error)) {
                    permanentMediaFailures.add(`${instanceId}:${cleanNumber}:${String(msg?.id?.id || '')}`);
                }
                console.warn(`[MEDIA CACHE] ${instanceId}: media download skipped: ${error.message}`);
            }
        }

        const hintedMediaType = mediaMimeFrom(msg);
        const effectiveMediaType = downloadedMedia?.mimetype || hintedMediaType || (msg.type === 'image' ? 'image/jpeg' : '');
        const hasAudio = isQualifiedAudio(msg, downloadedMedia || (effectiveMediaType ? { mimetype: effectiveMediaType } : null));
        const hasImage = isQualifiedImage(msg, downloadedMedia || (effectiveMediaType ? { mimetype: effectiveMediaType } : null));
        const hasDocument = isQualifiedDocument(msg, downloadedMedia || (effectiveMediaType ? { mimetype: effectiveMediaType } : null));
        const hasSupportedMedia = hasAudio || hasImage || hasDocument;
        const messagePayload = { conversation: msg.body };
        if (msg.hasMedia) {
            if (msg.type === 'image') messagePayload.imageMessage = { caption: msg.body };
            else if (hasAudio) messagePayload.audioMessage = { mimetype: effectiveMediaType };
            else if (msg.type === 'video') messagePayload.videoMessage = {};
            else if (msg.type === 'document') messagePayload.documentMessage = { mimetype: 'application/pdf', caption: msg.body };
        }

        try {
            await forwardIncomingWhatsAppMessage({
                event: 'messages.upsert',
                source: 'whatspro',
                instance: instanceId,
                instanceId,
                sender: realSender,
                normalizedPhone: cleanNumber,
                senderPhone: cleanNumber,
                messageId: msg.id.id,
                timestamp: Number(msg.timestamp || 0) ? Number(msg.timestamp) * 1000 : Date.now(),
                fromMe: msg.fromMe,
                type: msg.type,
                hasMedia: hasSupportedMedia,
                mediaData: downloadedMedia?.data || '',
                mediaType: hasSupportedMedia ? effectiveMediaType : '',
                mediaKind: msg.type,
                body: msg.body || '',
                pushName: msg._data?.notifyName || contactInfo.pushName || contactInfo.name || 'Client',
                contactName: contactInfo.name || contactInfo.shortName || contactInfo.pushName || '',
                contact: contactInfo,
                data: {
                    normalizedPhone: cleanNumber,
                    senderPhone: cleanNumber,
                    mediaData: downloadedMedia?.data || '',
                    mediaType: hasSupportedMedia ? effectiveMediaType : '',
                    mediaKind: msg.type,
                    key: {
                        remoteJid: realSender,
                        fromMe: msg.fromMe,
                        id: msg.id.id
                    },
                    message: messagePayload,
                    pushName: msg._data?.notifyName || contactInfo.pushName || contactInfo.name || 'Client',
                    contact: contactInfo,
                    contactName: contactInfo.name || contactInfo.shortName || contactInfo.pushName || '',
                    isMyContact: Boolean(contactInfo.isMyContact)
                }
            });
            if (downloadedMedia && hasSupportedMedia) {
                await publishChatEvent({
                    type: 'media.ready',
                    instanceId,
                    phone: cleanNumber,
                    messageId: String(msg.id.id),
                    mediaType: effectiveMediaType
                });
            }
        } catch (error) {
            console.error(`❌ [ADAPTER ERROR] ${instanceId}:`, error);
        }
    });

    client.on('call', call => {
        console.log(`[WHATSAPP CALL RAW] ${instanceId} (source=wwebjs) ->`, typeof call === 'object' ? JSON.stringify(call) : String(call));
        void dispatchIncomingCall(instanceId, client, call, 'wwebjs');
    });

client.initialize().catch(async err => {
        console.error(`❌ [WHATSAPP] ${instanceId} ИНИЦИАЛИЗАЦИЯ ҚАТЕСІ:`, err.message);
        clearTimeout(watchdog);
        initializingClients.delete(instanceId);
        clients.delete(instanceId);
        qrCodes.delete(instanceId);
        await destroyClient(client);

        if (shutdownInProgress || intentionallyStopped.has(instanceId)) return;

        const recovery = buildReconnectPlan('init_failed', {
            attempts: getRestartAttempts(instanceId),
            maxRetries: WHATSAPP_INITIALIZE_MAX_RETRIES,
            hasStoredSession: hasStoredSession(instanceId)
        });
        if (recovery.shouldRetry) {
            setInstanceState(instanceId, 'error', { reason: `Қате: ${err.message}` });
            scheduleRestart(instanceId, 15000, 'init_failed', { allowQrRequired: recovery.allowQrRequired });
        } else {
            setInstanceState(instanceId, 'error', { reason: `initialize_retries_exhausted: ${err.message}` });
            console.error(`[WHATSAPP] ${instanceId} initialize retry budget exhausted.`);
        }
    });

    return { success: true, message: 'Инстанс іске қосылуда. Күте тұрыңыз...' };
}

async function stopWhatsAppInstance(instanceId) {
    intentionallyStopped.add(instanceId);
    supervisedInstances.delete(instanceId);
    stateCheckFailures.delete(instanceId);
    clearRestartTimer(instanceId);
    pendingTextQueues.delete(instanceId);
    const flushTimer = flushTimers.get(instanceId);
    if (flushTimer) clearTimeout(flushTimer);
    flushTimers.delete(instanceId);
    qrCodes.delete(instanceId);
    setInstanceState(instanceId, 'stopped');

    const initializingClient = initializingClients.get(instanceId);
    if (initializingClient) {
        try {
            await destroyClient(initializingClient);
        } catch (err) {
            console.error(`[WHATSAPP] ${instanceId} initializing client stop failed:`, err.message);
        } finally {
            initializingClients.delete(instanceId);
        }
    }

    // 🚀 ЕГЕР КЛИЕНТ ЖАДЫДА БАР БОЛСА, ОНЫ ТОҚТАТАМЫЗ
    if (clients.has(instanceId)) {
        const client = await getReadyClient(instanceId);
        try {
            await client.logout();
            await client.destroy();
        } catch (err) {
            console.error(`⚠️ [WHATSAPP] ${instanceId} клиентті тоқтату кезіндегі қате:`, err.message);
        } finally {
            clients.delete(instanceId);
        }
    }


    // 🚀 ЕҢ БАСТЫСЫ: ПАПКАДАҒЫ КЭШ ФАЙЛДАРДЫ ТАМЫРЫМЕН ЖОЮ!
    try {
        removeSessionFolder(instanceId, 'stopped_by_admin');
        console.log(`🗑️ [WHATSAPP] ${instanceId} сессиясы админнің бұйрығымен ТҮБЕГЕЙЛІ ӨШІРІЛДІ!`);
    } catch (err) {
        console.error(`❌ [WHATSAPP] ${instanceId} папканы өшіру қатесі:`, err.message);
    }

    return { success: true, message: 'Logged out and session cleared successfully' };
}

async function shutdownWhatsAppClients(reason = 'process_shutdown') {
    shutdownInProgress = true;

    const instanceIds = [...new Set([
        ...clients.keys(),
        ...initializingClients.keys(),
        ...restartTimers.keys(),
        ...flushTimers.keys()
    ])];

    for (const instanceId of instanceIds) {
        intentionallyStopped.add(instanceId);
        clearRestartTimer(instanceId);
        const flushTimer = flushTimers.get(instanceId);
        if (flushTimer) clearTimeout(flushTimer);
        flushTimers.delete(instanceId);
        pendingTextQueues.delete(instanceId);
        qrCodes.delete(instanceId);
    }

    const clientsToDestroy = new Map([
        ...initializingClients.entries(),
        ...clients.entries()
    ]);

    await Promise.all([...clientsToDestroy.entries()].map(async ([instanceId, client]) => {
        try {
            await destroyClient(client);
            cleanupChromiumRuntimeLocks(instanceId);
            setInstanceState(instanceId, 'stopped', { reason });
        } catch (error) {
            console.error(`[WHATSAPP] ${instanceId} shutdown destroy failed:`, error.message);
        }
    }));

    clients.clear();
    initializingClients.clear();
}

// 6. QR КОДТЫ НЕМЕСЕ СТАТУСТЫ КӨРУ ФУНКЦИЯСЫ
async function getInstanceStatus(instanceId) {
    const storedSession = hasStoredSession(instanceId);

    if (qrCodes.has(instanceId)) {
        return { status: 'qr_ready', qr: qrCodes.get(instanceId), hasStoredSession: storedSession };
    }

    const client = clients.get(instanceId);
    if (!client) {
        if (initializingClients.has(instanceId)) {
            return { ...(instanceStates.get(instanceId) || { status: storedSession ? 'restoring_session' : 'starting' }), hasStoredSession: storedSession };
        }
        return { ...(instanceStates.get(instanceId) || { status: 'not_running' }), hasStoredSession: storedSession };
    }

    if (isClientPageClosed(client)) {
        clients.delete(instanceId);
        setInstanceState(instanceId, 'disconnected', { reason: 'browser_page_closed' });
        scheduleRestart(instanceId, 3000, 'browser_page_closed');
        return instanceStates.get(instanceId);
    }

    try {
        const state = await withTimeout(client.getState(), WA_STATE_TIMEOUT_MS, 'WA_STATE_TIMEOUT');
        if (isConnectedState(state) || client.info?.wid) {
            stateCheckFailures.delete(instanceId);
            resetRestartAttempts(instanceId);
            setInstanceState(instanceId, 'connected', { waState: state || 'CONNECTED' });
            return { status: 'connected', waState: state || 'CONNECTED', hasStoredSession: storedSession };
        }

        // Reading a status must never destroy credentials. getState() returns
        // null or a DISCONNECTED-ish value during a perfectly normal reconnect,
        // and the dashboard polls this for every tenant every few seconds, so
        // deleting the session folder here unpaired healthy tenants. Only the
        // WhatsApp 'disconnected' / 'auth_failure' events or an explicit
        // operator action may clear stored credentials.
        const status = state ? 'starting' : 'disconnected';
        setInstanceState(instanceId, status, { waState: state || null });
        if (status === 'disconnected') registerHealthFailure(instanceId, `state_${state || 'NULL'}`);
        else stateCheckFailures.delete(instanceId);

        return { ...instanceStates.get(instanceId), hasStoredSession: storedSession };
    } catch (error) {
        registerHealthFailure(instanceId, error.message || 'state_check_failed');
        return { ...(instanceStates.get(instanceId) || { status: 'starting' }), hasStoredSession: storedSession };
    }
}

async function markBotSending(instanceId, phone, chatId) {
    const cleanPhone = normalizePhoneFromCandidates([phone, chatId]);
    if (!cleanPhone) return null;

    const key = `bot_sending:${instanceId}:${cleanPhone}`;
    let redisMarked = false;
    if (redisClient.isOpen) {
        const script = "local count = redis.call('INCR', KEYS[1]); redis.call('EXPIRE', KEYS[1], ARGV[1]); return count";
        redisMarked = Number(await redisClient.sendCommand(['EVAL', script, '1', key, '20']).catch(() => 0)) > 0;
    }
    incrementLocalBotSend(key, Date.now() + 20000, redisMarked);
    return { key, redisMarked };
}

async function deliverWhatsAppText(client, instanceId, phone, text) {
    const chatId = toWhatsAppChatId(phone, jidMap);
    if (!chatId) return false;

    const markerKey = await markBotSending(instanceId, phone, chatId);
    let message;
    try {
        message = await client.sendMessage(chatId, text);
    } catch (error) {
        await releaseBotSending(markerKey);
        error.sendAttempted = true;
        throw error;
    }
    console.log(`📤 [SENT] ${instanceId} -> ${chatId}: Хат сәтті жіберілді.`);
    return {
        success: true,
        messageId: String(message?.id?.id || ''),
        ack: Number(message?.ack || 0)
    };
}



/**
 * Loads the WPP bundle into the WhatsApp Web page and turns on its call
 * interface.
 *
 * `enableCallInterface()` matters as much as the bundle itself: WhatsApp Web
 * treats itself as a companion device that does not handle calls, so an
 * incoming call arrives with `canHandleLocally: false` and a reject stanza for
 * it is dropped. Enabling the interface is what makes the page a participant
 * the server will accept a rejection from.
 *
 * The result is cached per page. A page that already answered `isReady` skips
 * the injection entirely, so this is cheap to call on every incoming call, and
 * `startWhatsAppInstance` primes it on `ready` so the first real call does not
 * pay the ~2s bundle load while the phone is ringing.
 */
// Two independent sources report the same incoming call: whatsapp-web.js's
// `call` event, which works by monkey-patching `Map.set` on an internal
// WhatsApp collection (Client.js) and goes silent without warning whenever that
// internal shape changes, and wa-js's own `call.incoming_call` event. Whichever
// arrives first wins; the loser is dropped here so the caller is not rejected
// and greeted twice.
const seenCallIds = new Map();
const SEEN_CALL_TTL_MS = 2 * 60 * 1000;

function claimCall(instanceId, callId, source) {
    const now = Date.now();
    for (const [key, at] of seenCallIds) {
        if (now - at > SEEN_CALL_TTL_MS) seenCallIds.delete(key);
    }
    // A call with no id cannot be deduplicated by id, so it is keyed by tenant
    // and second — two sources reporting the same idless call land together.
    const key = `${instanceId}:${callId || `anon-${Math.floor(now / 1000)}`}`;
    const claimedAt = seenCallIds.get(key);
    if (claimedAt !== undefined) {
        console.log(`[WHATSAPP CALL] ${instanceId}: ${callId || '(no id)'} already handled ${now - claimedAt}ms ago, ignoring duplicate from ${source}`);
        return false;
    }
    seenCallIds.set(key, now);
    return true;
}

function dispatchIncomingCall(instanceId, client, call, source) {
    const callId = call?.id === undefined || call?.id === null ? '' : String(call.id);
    // Outgoing calls are filtered downstream too, but claiming one here would
    // make the real incoming call that follows look like a duplicate.
    if (call?.fromMe || call?.outgoing) {
        console.log(`[WHATSAPP CALL] ${instanceId}: outgoing call ${callId || '(no id)'} from ${source}, ignoring`);
        return Promise.resolve();
    }
    if (!claimCall(instanceId, callId, source)) return Promise.resolve();
    // A call-log entry arrives after the call has already ended, so there is
    // nothing left to reject — attempting it would just log a failure. The
    // greeting is still owed to the caller, and handleIncomingCall is left
    // otherwise untouched.
    const options = source === 'call_log'
        ? { rejectCall: async () => false }
        : undefined;
    return handleIncomingCall(instanceId, client, call, options).catch(error => {
        console.error(`[WHATSAPP CALL] ${instanceId} (source=${source}):`, error.message);
    });
}

// Read once and kept in memory: the bundle is ~500 KB and every session that
// starts would otherwise re-read it from disk.
let wppBundleSource;
function readWppCallBundle() {
    if (wppBundleSource === undefined) {
        try {
            wppBundleSource = fs.readFileSync(WPP_CALL_BUNDLE_PATH, 'utf8');
        } catch (error) {
            wppBundleSource = '';
            console.error(`[WHATSAPP CALL] WPP bundle unreadable at ${WPP_CALL_BUNDLE_PATH}: ${error.message}`);
        }
    }
    return wppBundleSource;
}

// The second call source. wa-js emits `call.incoming_call` from its own
// registration inside WhatsApp's call model, independent of the `Map.set` patch
// whatsapp-web.js relies on, so it keeps reporting when that patch stops. The
// binding is re-exposed on every page load because navigation wipes both the
// injected bundle and the binding itself.
const wppCallWatchers = new WeakSet();

async function watchWppIncomingCalls(instanceId, client) {
    const page = client?.pupPage;
    if (!page || typeof page.exposeFunction !== 'function') return false;
    if (wppCallWatchers.has(page)) return true;
    wppCallWatchers.add(page);

    const BINDING = '__wpproIncomingCall';
    try {
        await page.exposeFunction(BINDING, payload => {
            // Spy frames report event names only; they are diagnostics, not calls,
            // and must never reach the rejection ladder.
            if (payload && payload.spy) {
                const shape = payload.shape ? ` shape=${JSON.stringify(payload.shape)}` : '';
                console.log(`[WHATSAPP CALL SPY] ${instanceId}: page event -> ${payload.spy}${shape}`);
                return;
            }
            const source = payload?.via === 'callstore' ? 'callstore' : (payload?.via === 'call_log' ? 'call_log' : 'wa-js');
            console.log(`[WHATSAPP CALL RAW] ${instanceId} (source=${source}) ->`, JSON.stringify(payload));
            void dispatchIncomingCall(instanceId, client, payload, source);
        });
    } catch (error) {
        // Already exposed from an earlier load of this same page: harmless.
        if (!/already exists|has been already registered/i.test(error.message || '')) {
            wppCallWatchers.delete(page);
            console.warn(`[WHATSAPP CALL] ${instanceId}: wa-js call binding failed: ${error.message}`);
            return false;
        }
    }

    const subscribe = () => page.evaluate(binding => {
        if (!window.WPP?.on || window.__wpproCallHooked) return false;
        window.WPP.on('call.incoming_call', call => {
            try {
                window[binding]({
                    id: call?.id,
                    from: call?.sender?._serialized || call?.sender?.user || call?.peerJid?._serialized || null,
                    isVideo: Boolean(call?.isVideo),
                    isGroup: Boolean(call?.isGroup),
                    offerTime: call?.offerTime ?? null,
                });
            } catch (_) { /* the page must never break on our listener */ }
        });
        window.__wpproCallHooked = true;

        // Third source, owned by us. wa-js publishes `call.incoming_call` only
        // from its own wrapper around CallStore.processIncomingCall, installed at
        // injection time; if that wrapper was never installed, wrapping the store
        // ourselves here still sees the call. Chaining preserves whatever wrapper
        // is already in place, so nothing that works today stops working.
        try {
            const store = window.WPP?.whatsapp?.CallStore;
            if (store && typeof store.processIncomingCall === 'function' && !window.__wpproOwnCallHook) {
                const original = store.processIncomingCall.bind(store);
                store.processIncomingCall = function (...args) {
                    const call = original(...args);
                    try {
                        if (call) {
                            window[binding]({
                                id: call.id,
                                from: call.peerJid?._serialized || call.peerJid || null,
                                isVideo: Boolean(call.isVideo),
                                isGroup: Boolean(call.isGroup),
                                offerTime: call.offerTime ?? null,
                                via: 'callstore',
                            });
                        }
                    } catch (_) { /* never break WhatsApp's own call handling */ }
                    return call;
                };
                window.__wpproOwnCallHook = true;
            }
        } catch (_) { /* the store is optional; the events above still stand */ }

        // Fourth source: the call-log entry. On multi-device WhatsApp does not
        // route a ring to a linked device at all — it rings the phone and sends
        // the web session only the missed-call log message. That is why the three
        // sources above stay silent while `chat.new_message` fires on every call.
        // This cannot reject the call (the server never offered it here), but it
        // is the only signal a linked device gets, so it still greets the caller.
        try {
            if (!window.__wpproCallLogHook) {
                window.WPP.on('chat.new_message', msg => {
                    try {
                        const type = String(msg?.type || '');
                        const subtype = String(msg?.subtype || '');
                        const isCallLog = type === 'call_log' || /call/i.test(type) || /call|voice|video/i.test(subtype);
                        if (!isCallLog || msg?.id?.fromMe) return;
                        window[binding]({
                            id: msg?.callId || msg?.id?._serialized || msg?.id?.id || null,
                            from: msg?.from?._serialized || msg?.from || msg?.author?._serialized || null,
                            isVideo: /video/i.test(subtype) || /video/i.test(type),
                            isGroup: Boolean(msg?.isGroupMsg),
                            offerTime: msg?.t ?? null,
                            via: 'call_log',
                        });
                    } catch (_) { /* never break the page's message handling */ }
                });
                window.__wpproCallLogHook = true;
            }
        } catch (_) { /* optional source; the three above still stand */ }

        // The spy: every wa-js event, so a ring that reaches the page is visible
        // in the log even when no call listener recognises it.
        try {
            if (window.WPP?.onAny && !window.__wpproSpy) {
                window.__wpproSpyCount = 0;
                window.WPP.onAny(function (name) {
                    // Every event, not just call-shaped ones. The question this
                    // answers is whether a ring reaches the page at all, and
                    // filtering by name assumes the answer. Capped so a busy
                    // session cannot flood the log.
                    if (typeof name !== 'string') return;
                    const isCall = /call/i.test(name);
                    if (!isCall && window.__wpproSpyCount >= 150) return;
                    window.__wpproSpyCount += 1;
                    // For messages, the shape decides which field marks a call.
                    // Guessing it wrong is what let the last round pass silently,
                    // so log the shape instead of assuming it.
                    let shape = null;
                    try {
                        const msg = arguments[1];
                        if (name === 'chat.new_message' && msg) {
                            shape = {
                                type: msg.type ?? null,
                                subtype: msg.subtype ?? null,
                                callId: msg.callId ?? null,
                                keys: Object.keys(msg).slice(0, 40),
                            };
                        }
                    } catch (_) {}
                    try { window[binding]({ spy: name, shape }); } catch (_) {}
                });
                window.__wpproSpy = true;
            }
        } catch (_) {}

        return true;
    }, BINDING);

    // The fake microphone still goes through a permission prompt, and a headless
    // page has nobody to answer it. Granting it up front is what lets WhatsApp
    // Web advertise itself as able to take a call.
    await page.browserContext()
        .overridePermissions('https://web.whatsapp.com', ['microphone', 'notifications'])
        .catch(err => console.warn(`[WHATSAPP CALL] ${instanceId}: microphone permission grant failed: ${err?.message || err}`));

    const hooked = await subscribe().catch(err => {
        console.warn(`[WHATSAPP CALL] ${instanceId}: wa-js call subscribe failed: ${err?.message || err}`);
        return false;
    });
    console.log(`[WHATSAPP CALL] ${instanceId}: wa-js incoming_call listener ${hooked ? 'attached' : 'not attached'}`);

    // A reload drops the listener silently; re-attaching is what keeps the
    // second source from quietly becoming as dead as the first.
    page.on('framenavigated', frame => {
        if (frame !== page.mainFrame()) return;
        void ensureWppCallApi(client)
            .then(ready => (ready ? subscribe() : false))
            .then(ok => ok && console.log(`[WHATSAPP CALL] ${instanceId}: wa-js listener re-attached after navigation`))
            .catch(() => {});
    });
    return hooked;
}

// Reports whether each source is actually wired, at startup rather than at ring
// time. A call every source missed leaves no trace at all, so the state of the
// hooks is logged while there is still time to see it.
async function reportCallHookHealth(instanceId, client) {
    const page = client?.pupPage;
    if (!page || typeof page.evaluate !== 'function') return;
    const health = await page.evaluate(() => {
        // whatsapp-web.js patches Map.set on WAWebCallCollection, not on
        // window.Store.Call — checking the latter reported "not patched" for a
        // page where the patch was fine, so the collection is resolved the same
        // way the library does before drawing any conclusion from it.
        let collection = null;
        try { collection = window.require?.('WAWebCallCollection') ?? null; } catch (_) {}
        const legacy = window.Store?.Call || window.Store?.CallCollection || null;
        const internalMap = collection && Object.values(collection).find(v => v instanceof Map);

        return {
            wppReady: Boolean(window.WPP?.isReady),
            wppOn: typeof window.WPP?.on === 'function',
            wppRejectCall: typeof window.WPP?.call?.rejectCall === 'function',
            wajsListener: Boolean(window.__wpproCallHooked),
            // Both the module the library actually patches and the legacy Store
            // path, so a false here means "really missing", not "looked wrong".
            wwebjsCollection: Boolean(collection || legacy),
            wwebjsPatched: Boolean(internalMap && !/native code/.test(String(internalMap.set))),
            // wa-js reports incoming calls by wrapping CallStore.processIncomingCall.
            // If that store is missing, its event is as dead as the patch above,
            // and the listener count tells us whether anyone is actually subscribed.
            callStore: typeof window.WPP?.whatsapp?.CallStore,
            processIncomingCall: typeof window.WPP?.whatsapp?.CallStore?.processIncomingCall,
            incomingListeners: Number(window.WPP?.ev?.listenerCount?.('call.incoming_call') ?? -1),
            ownHook: Boolean(window.__wpproOwnCallHook),
            // Calls WhatsApp itself is holding right now. A ringing phone with
            // an empty collection means the ring never reached this browser.
            liveCalls: internalMap ? internalMap.size : -1,
        };
    }).catch(err => ({ error: err?.message || String(err) }));

    console.log(`[WHATSAPP CALL HOOKS] ${instanceId} ->`, JSON.stringify(health));
    // ownHook is ours and does not depend on either library's detection, so it
    // counts as a source here.
    if (health && !health.error && !health.wajsListener && !health.wwebjsPatched && !health.ownHook) {
        console.error(`[WHATSAPP CALL HOOKS] ${instanceId}: NO call source is attached — incoming calls will not be rejected`);
    }
}

async function ensureWppCallApi(client) {
    const page = client?.pupPage;
    if (!page || typeof page.evaluate !== 'function') return false;

    const alreadyReady = await page.evaluate(() => Boolean(window.WPP?.isReady)).catch(() => false);
    if (alreadyReady) {
        // The interface flag does not survive a page navigation, so it is
        // re-asserted rather than assumed. It is idempotent. A failure here is
        // worth a line: without the call interface WhatsApp Web stays a
        // companion device that reports canHandleLocally false, and the server
        // drops the reject stanza — which looks exactly like a working
        // rejection from this side.
        const enabled = await page.evaluate(async () => {
            try {
                await window.WPP?.call?.enableCallInterface?.();
                return { ok: true };
            } catch (err) {
                return { ok: false, error: String(err?.message || err) };
            }
        }).catch(err => ({ ok: false, error: String(err?.message || err) }));
        if (!enabled?.ok) console.warn(`[WHATSAPP CALL] enableCallInterface failed: ${enabled?.error || 'unknown'}`);
        return true;
    }

    let loading = wppCallApiLoads.get(page);
    if (!loading) {
        loading = (async () => {
            const source = readWppCallBundle();
            if (!source) return false;

            // Injected by evaluating the source rather than via addScriptTag.
            // A <script> tag is subject to the page's Content-Security-Policy,
            // and web.whatsapp.com sends a script-src that refuses it — the
            // tag lands, the browser declines to run it, and Puppeteer reports
            // no error at all. That is why this used to report "call API
            // unavailable" with nothing else in the log. Evaluating goes
            // through CDP Runtime.evaluate, which CSP does not apply to.
            const injected = await page.evaluate(source).then(() => true).catch(err => {
                console.warn(`[WHATSAPP CALL] WPP bundle evaluation failed: ${err?.message || err}`);
                return false;
            });
            if (!injected) return false;

            // Wait until the bundle has finished hooking the page. wa-js drives
            // WhatsApp through one of two module systems and reports which in
            // `loader.loaderType`: the classic 'webpack' one, or the 'meta'
            // loader that WhatsApp Web moved to. The old code only waited on
            // `WPP.webpack.onReady`, which does not exist under the meta loader
            // — so it gave up instantly and every rejection fell through to the
            // unverified path. `loader.onReady` is the module-system-agnostic
            // callback, and the isReady poll covers a bundle that became ready
            // between injection and this call.
            const outcome = await page.evaluate(() => new Promise(resolve => {
                const started = Date.now();
                let settled = false;
                const finish = async () => {
                    if (settled) return;
                    settled = true;
                    let interfaceError = '';
                    try {
                        await window.WPP?.call?.enableCallInterface?.();
                    } catch (err) {
                        interfaceError = String(err?.message || err);
                    }
                    resolve({ ready: true, interfaceError });
                };
                const poll = () => {
                    if (settled) return;
                    if (window.WPP?.isReady) return void finish();
                    if (Date.now() - started > 20000) return resolve({ ready: false });
                    setTimeout(poll, 250);
                };
                if (typeof window.WPP?.loader?.onReady === 'function') window.WPP.loader.onReady(finish);
                else if (typeof window.WPP?.webpack?.onReady === 'function') window.WPP.webpack.onReady(finish);
                poll();
            })).catch(err => {
                console.warn(`[WHATSAPP CALL] WPP readiness wait failed: ${err?.message || err}`);
                return { ready: false };
            });

            const loaderType = await page.evaluate(() => String(window.WPP?.loader?.loaderType || 'unknown')).catch(() => 'unknown');
            if (outcome?.interfaceError) {
                console.warn(`[WHATSAPP CALL] enableCallInterface failed: ${outcome.interfaceError}`);
            }
            if (outcome?.ready) console.log(`[WHATSAPP CALL] WPP call API ready (loader=${loaderType})`);
            else console.warn(`[WHATSAPP CALL] WPP never became ready (loader=${loaderType}), falling back to whatsapp-web.js`);
            return Boolean(outcome?.ready);
        })();
        wppCallApiLoads.set(page, loading);
        void loading.finally(() => {
            if (wppCallApiLoads.get(page) === loading) wppCallApiLoads.delete(page);
        }).catch(() => {});
    }

    return Boolean(await loading);
}

/**
 * Call rejection, ordered by how much the transport actually verifies.
 *
 * WPP goes first. Its reject() establishes the E2E session for the caller
 * before sending (`ensureE2ESessions`), checks the call is really in
 * INCOMING_RING, and sends through the live `sendSmaxStanza` path — so a
 * `true` from it means WhatsApp accepted the stanza.
 *
 * whatsapp-web.js `call.reject()` is the fallback, not the primary. It casts
 * the stanza through the deprecated `deprecatedCastStanza` API, skips the E2E
 * handshake, and resolves `undefined` no matter what the server did. Calling
 * it first is how this used to report "succeeded" on calls that kept ringing:
 * it can never fail, so WPP was never reached.
 */
async function rejectIncomingCallReliably(client, call) {
    const page = client?.pupPage;
    const callId = String(call?.id?._serialized || call?.id?.id || call?.id || '').trim();

    // 1. WPP — the only path that confirms the server took the rejection.
    if (page) {
        // Three seconds, not fifteen. `ready` already primed this, so a hit
        // here is the cached promise resolving instantly. Waiting out a cold
        // load while the caller is ringing just means rejecting a call that
        // has already stopped — the fallback is the better use of that time.
        const wppReady = await withTimeout(ensureWppCallApi(client), 3000, 'WPP_CALL_API_TIMEOUT').catch(err => {
            console.warn(`[WHATSAPP CALL] WPP not ready in time (${err?.message || err}), using fallback`);
            return false;
        });

        if (wppReady) {
            const outcome = await withTimeout(page.evaluate(async id => {
                if (typeof window.WPP?.call?.reject !== 'function') return { ok: false, error: 'WPP_REJECT_MISSING' };
                try {
                    // An empty id makes WPP reject whichever call is ringing,
                    // which is what we want when the id did not survive the
                    // trip from whatsapp-web.js.
                    const result = await window.WPP.call.reject(id || undefined);
                    return { ok: result !== false };
                } catch (err) {
                    return { ok: false, error: String(err?.code || err?.message || err) };
                }
            }, callId), 8000, 'WPP_CALL_REJECT_TIMEOUT').catch(err => ({ ok: false, error: String(err?.message || err) }));

            if (outcome?.ok) {
                console.log(`[WHATSAPP CALL] WPP reject confirmed for ${callId || '<ringing>'}`);
                return true;
            }
            console.warn(`[WHATSAPP CALL] WPP reject failed for ${callId || '<ringing>'}: ${outcome?.error || 'unknown'}`);
        } else {
            console.warn('[WHATSAPP CALL] WPP call API unavailable, falling back to whatsapp-web.js');
        }
    }

    // 2. whatsapp-web.js native reject — unverified, but better than ringing.
    if (typeof call?.reject === 'function') {
        try {
            await withTimeout(call.reject(), 5000, 'WWEB_CALL_REJECT_TIMEOUT');
            console.log(`[WHATSAPP CALL] whatsapp-web.js reject sent for ${callId || '<unknown>'} (unverified)`);
            return true;
        } catch (err) {
            console.warn(`[WHATSAPP CALL] whatsapp-web.js reject failed: ${err?.message || err}`);
        }
    }

    // 3. Raw WWebJS bridge, for calls that arrived without a Call wrapper.
    const peerJid = serializeWhatsAppJid(call?.from);
    if (page && peerJid && callId) {
        const rejectedByNative = await withTimeout(page.evaluate(async (jid, id) => {
            try {
                if (typeof window?.WWebJS?.rejectCall !== 'function') return false;
                await window.WWebJS.rejectCall(jid, id);
                return true;
            } catch (err) {
                return false;
            }
        }, peerJid, callId), 5000, 'WWEB_BRIDGE_REJECT_TIMEOUT').catch(() => false);

        if (rejectedByNative) {
            console.log(`[WHATSAPP CALL] WWebJS bridge reject sent for ${callId} (unverified)`);
            return true;
        }
    }

    return false;
}

function serializeWhatsAppJid(value) {
    if (typeof value === 'string') return value.trim();
    if (!value || typeof value !== 'object') return '';

    const serialized = value._serialized || value.serialized;
    if (typeof serialized === 'string' && serialized.trim()) return serialized.trim();

    const user = String(value.user || '').trim();
    const server = String(value.server || '').trim();
    return user && server ? `${user}@${server}` : '';
}

function canonicalizeWhatsAppJid(value) {
    const jid = String(value || '').trim();
    return jid.replace(/^([^@]+):\d+@(lid|c\.us|s\.whatsapp\.net)$/i, '$1@$2');
}

function collectWhatsAppIdentityCandidates(value, maxDepth = 5) {
    const candidates = [];
    const seen = new Set();

    function add(candidate) {
        const normalized = typeof candidate === 'string' ? candidate.trim() : '';
        if (normalized && !candidates.includes(normalized)) candidates.push(normalized);
    }

    function visit(current, depth) {
        if (typeof current === 'string') {
            add(current);
            return;
        }
        if (!current || typeof current !== 'object' || depth > maxDepth || seen.has(current)) return;
        seen.add(current);

        add(serializeWhatsAppJid(current));
        if (typeof current.toString === 'function' && current.toString !== Object.prototype.toString) {
            try {
                const rendered = current.toString();
                if (rendered !== '[object Object]') add(rendered);
            } catch (error) {}
        }

        if (current instanceof Map) {
            for (const [key, nested] of current.entries()) {
                visit(key, depth + 1);
                visit(nested, depth + 1);
            }
            return;
        }
        if (current instanceof Set) {
            for (const nested of current.values()) visit(nested, depth + 1);
            return;
        }

        for (const [key, nested] of Object.entries(current)) {
            if (key.includes('@')) add(key);
            if (typeof nested === 'number' && /phone|number|user/i.test(key)) add(String(nested));
            else visit(nested, depth + 1);
        }
    }

    visit(value, 0);
    return candidates;
}

function describeCallIdentityShape(call) {
    const candidates = collectWhatsAppIdentityCandidates({
        from: call?.from,
        peerJid: call?.peerJid,
        id: call?.id,
        participants: call?.participants
    });
    return {
        fromType: Array.isArray(call?.from) ? 'array' : typeof call?.from,
        fromKeys: call?.from && typeof call.from === 'object' ? Object.keys(call.from).slice(0, 12) : [],
        participantType: Array.isArray(call?.participants) ? 'array' : typeof call?.participants,
        participantKeys: call?.participants && typeof call.participants === 'object'
            ? Object.keys(call.participants).slice(0, 12).map(key => key.includes('@') ? `*@${key.split('@').pop()}` : key)
            : [],
        jidKinds: [...new Set(candidates.filter(value => value.includes('@')).map(value => `*@${value.split('@').pop()}`))],
        hasDeviceSuffix: candidates.some(value => /^[^@]+:\d+@/.test(value))
    };
}

function getDirectCallPhoneCandidates(call) {
    const candidates = [];
    for (const value of [call?.from, call?.peerJid]) {
        const jid = serializeWhatsAppJid(value);
        if (jid && !/@lid$/i.test(jid)) candidates.push(jid);
    }

    const participants = call?.participants;
    const entries = !participants || typeof participants !== 'object'
        ? []
        : Array.isArray(participants)
            ? participants
            : [...Object.keys(participants), ...Object.values(participants)];
    for (const participant of entries) {
        if (typeof participant === 'string') {
            if (/@(c\.us|s\.whatsapp\.net)$/i.test(participant)) candidates.push(participant);
            continue;
        }
        if (!participant || typeof participant !== 'object') continue;
        for (const value of [participant, participant.jid, participant.id]) {
            const jid = serializeWhatsAppJid(value);
            if (/@(c\.us|s\.whatsapp\.net)$/i.test(jid)) candidates.push(jid);
        }
        candidates.push(participant.phoneNumber, participant.number);
    }
    return candidates.filter(Boolean);
}

async function resolveCallPhone(client, call, knownPhone = '') {
    const identityCandidates = collectWhatsAppIdentityCandidates({
        from: call?.from,
        peerJid: call?.peerJid,
        id: call?.id,
        participants: call?.participants
    });
    const rawJids = [...new Set(identityCandidates
        .filter(value => /@(lid|c\.us|s\.whatsapp\.net)$/i.test(value))
        .map(canonicalizeWhatsAppJid))];
    const rawJid = rawJids[0] || '';
    const direct = normalizePhoneFromCandidates(getDirectCallPhoneCandidates(call));
    if (direct) return direct;

    for (const [phone, jid] of jidMap.entries()) {
        if (rawJids.includes(canonicalizeWhatsAppJid(jid))) return phone;
    }

    if (!rawJid) return '';
    if (typeof client?.getContactLidAndPhone === 'function') {
        const mappings = await withTimeout(client.getContactLidAndPhone(rawJids), 3000, 'CALL_LID_LOOKUP_TIMEOUT').catch(() => []);
        const mapping = (Array.isArray(mappings) ? mappings : []).find(item => rawJids.includes(String(item?.lid || ''))) || mappings?.[0];
        const mappedPhone = normalizePhoneFromCandidates([mapping?.pn, mapping?.phone]);
        if (mappedPhone) {
            jidMap.set(mappedPhone, String(mapping?.lid || rawJid));
            return mappedPhone;
        }

        const normalizedKnownPhone = normalizePhoneFromCandidates([knownPhone]);
        if (normalizedKnownPhone) {
            const knownMappings = await withTimeout(
                client.getContactLidAndPhone([`${normalizedKnownPhone}@c.us`]),
                3000,
                'CALL_KNOWN_PHONE_LOOKUP_TIMEOUT'
            ).catch(() => []);
            const knownMapping = (Array.isArray(knownMappings) ? knownMappings : []).find(item => rawJids.includes(String(item?.lid || '')));
            const verifiedPhone = normalizePhoneFromCandidates([knownMapping?.pn, knownMapping?.phone]);
            if (verifiedPhone === normalizedKnownPhone) {
                jidMap.set(verifiedPhone, String(knownMapping?.lid || rawJid));
                return verifiedPhone;
            }
        }
    }

    if (typeof client?.getContactById !== 'function') return '';
    const contact = await withTimeout(client.getContactById(rawJid), 3000, 'CALL_CONTACT_LOOKUP_TIMEOUT').catch(() => null);
    
    console.log(`[WHATSAPP CALL] getContactById(${rawJid}) returned:`, contact ? JSON.stringify({
        id: contact.id, number: contact.number, isMe: contact.isMe, isUser: contact.isUser
    }) : 'null');
    
    const resolved = normalizePhoneFromCandidates([
        contact?.number,
        contact?.userid,
        contact?.id?.user,
        contact?.id?._serialized
    ]);
    if (resolved) jidMap.set(resolved, rawJid);
    return resolved;
}

const CALL_REJECTION_TEXT = 'Сәлеметсіз бе! 👋 Кешіріңіз, қоңырауды қабылдай алмаймыз 🙏 Сізге қалай көмектесе аламыз? Сұрағыңызды осы жерге хабарлама түрінде жазыңыз — жауап береміз! 😊';

async function handleIncomingCall(instanceId, client, call, dependencies = {}) {
    if (call?.fromMe === true) return { rejected: false, replied: false, phone: '', reason: 'outgoing_call' };

    const admin = dependencies.tenantAdmin || require('./tenantAdmin');
    const tenantRow = await admin.findRow(instanceId).catch(() => null);
    // Rejecting is the default. A tenant with no row yet, or a row written
    // before this column existed, is a tenant nobody has staffed for phone
    // calls — letting those ring through is the worse failure.
    const callsDisabled = tenantRow?.calls_disabled === undefined || tenantRow?.calls_disabled === null ? true : Boolean(tenantRow.calls_disabled);

    if (callsDisabled) {
        console.log(`[WHATSAPP CALL] ${instanceId}: calls are disabled by configuration, rejecting and sending message.`);

        const rejectCall = dependencies.rejectCall || rejectIncomingCallReliably;
        let rejected = false;
        try {
            rejected = (await rejectCall(client, call)) === true;
        } catch (error) {
            console.warn(`[WHATSAPP CALL] ${instanceId}: call rejection threw: ${error.message}`);
        }
        // The reply is not gated on the rejection succeeding. This tenant does
        // not answer calls at all, so the greeting is correct either way, and
        // an unconfirmed reject is exactly the case where the caller is left
        // with nothing to go on. Only the log distinguishes the two.
        if (!rejected) {
            console.warn(`[WHATSAPP CALL] ${instanceId}: rejection unconfirmed, replying anyway so the caller is not left silent.`);
        }

        const policy = await (dependencies.getTestModePolicy || getTestModePolicy)(instanceId);
        const resolvePhone = dependencies.resolvePhone || resolveCallPhone;
        const phone = await resolvePhone(client, call, policy.enabled ? policy.devPhone : '');
        if (!isValidChatPhone(phone)) {
            console.warn(`[WHATSAPP CALL] ${instanceId}: caller phone could not be resolved. shape=${JSON.stringify(describeCallIdentityShape(call))}`);
            return { rejected, replied: false, phone: '', reason: 'bad_phone' };
        }

        const allowed = dependencies.isPhoneAllowed
            ? await dependencies.isPhoneAllowed(instanceId, phone)
            : allowsPhone(policy, phone);
        if (!allowed) {
            console.log(`[WHATSAPP CALL] ${instanceId} -> ${phone}: no reply, blocked by test-mode policy.`);
            return { rejected, replied: false, phone, reason: 'test_mode_blocked' };
        }

        const deliverText = dependencies.deliverText || deliverWhatsAppText;
        const sent = await deliverText(client, instanceId, phone, CALL_REJECTION_TEXT)
            .catch(error => {
                console.error(`[WHATSAPP CALL] ${instanceId} -> ${phone}: greeting delivery failed: ${error.message}`);
                return null;
            });
        console.log(`[WHATSAPP CALL] ${instanceId} -> ${phone}: rejected=${rejected} replied=${Boolean(sent)}`);
        return { rejected, replied: Boolean(sent), phone };
    }

    console.log(`[WHATSAPP CALL] ${instanceId}: calls are enabled, allowing call to proceed.`);
    return { rejected: false, replied: false, phone: '', reason: 'calls_enabled' };
}

async function flushPendingOutgoingText(instanceId) {
    // Expiry is applied first. It used to sit behind the client check, so while
    // a client was missing the queue could never drain and the retry loop ran
    // forever, re-arming the restart timer every few seconds.
    const queue = purgeExpiredOutgoingText(instanceId);
    if (!queue.length) return;

    const client = await getReadyClient(instanceId);
    if (!client) {
        // Reconnecting is the supervisor's job, not the send queue's.
        requestReconnect(instanceId, 'outgoing_text_waiting_for_client');
        scheduleFlush(instanceId, 10000);
        return;
    }

    pendingTextQueues.set(instanceId, []);
    const retry = [];

    for (const item of queue) {
        try {
            const sent = await deliverWhatsAppText(client, instanceId, item.phone, item.text);
            if (!sent && item.attempts < 3) {
                retry.push({ ...item, attempts: item.attempts + 1, reason: 'retry_no_chat_id' });
            }
        } catch (error) {
            console.error(`[WHATSAPP QUEUE] ${instanceId} -> ${item.phone}: retry send failed:`, error.message);
            if (item.attempts < 3) {
                retry.push({ ...item, attempts: item.attempts + 1, reason: error.message });
            }
        }

        await delay(250);
    }

    if (retry.length) {
        pendingTextQueues.set(instanceId, retry);
        scheduleFlush(instanceId, 5000);
    }
}

// ==========================================
// 🚀 ХАТ ЖІБЕРУ ФУНКЦИЯЛАРЫ
// ==========================================

async function sendWhatsAppText(instanceId, phone, text, options = {}) {
    try {
        const client = await getReadyClient(instanceId);
        if (!client) {
            console.error(`[WHATSAPP CLIENT MISSING] ${instanceId}: sendWhatsAppText skipped because client is not initialized.`);
            if (!options.skipQueue) {
                queueOutgoingText(instanceId, phone, text, 'client_missing');
                requestReconnect(instanceId, 'outgoing_text_client_missing');
                scheduleFlush(instanceId, 10000);
            }
            return options.skipQueue ? { success: false, attempted: false } : false;
        }

        const result = await deliverWhatsAppText(client, instanceId, phone, text);
        return result || (options.skipQueue ? { success: false, attempted: false } : false);
    } catch (error) {
        console.error(`❌ [SEND ERROR] ${instanceId} -> ${phone}:`, error.message);
        if (options.skipQueue) {
            const attempted = error?.sendAttempted === true;
            return { success: false, attempted, outcomeUnknown: attempted, error: error.message };
        }
        if (!options.skipQueue) {
            queueOutgoingText(instanceId, phone, text, error.message);
            scheduleFlush(instanceId, 5000);
        }
        return false;
    }
}
// 📸 МЕДИА ЖІБЕРУ ФУНКЦИЯСЫ (Сурет, Аудио)
async function sendMedia(instanceId, phone, base64Data, fileName, caption) {
    let markerKey = '';
    try {
        const client = await getReadyClient(instanceId);
        if (!client) {
            console.error(`[WHATSAPP CLIENT MISSING] ${instanceId}: sendMedia skipped because client is not initialized.`);
            return false;
        }
        const chatId = toWhatsAppChatId(phone, jidMap);
        if (!chatId) return false;
        markerKey = await markBotSending(instanceId, phone, chatId);

        // Base64 мәтінінен таза суретті бөліп алу (data:image/jpeg;base64,... дегенді алып тастау)
        let cleanBase64 = base64Data;
        let mimeType = 'image/jpeg';
        if (base64Data.includes(';base64,')) {
            const parts = base64Data.split(';base64,');
            mimeType = parts[0].split(':')[1];
            cleanBase64 = parts[1];
        }

        const media = new MessageMedia(mimeType, cleanBase64, fileName || 'file');
        const message = await client.sendMessage(chatId, media, { caption: caption || '' });
        return {
            success: true,
            messageId: String(message?.id?.id || ''),
            ack: Number(message?.ack || 0)
        };
    } catch (error) {
        await releaseBotSending(markerKey);
        console.error(`❌ [MEDIA ERROR] ${instanceId}:`, error.message);
        return false;
    }
}

// 👀 ОҚЫЛДЫ ДЕП БЕЛГІЛЕУ (Көк құсбелгі)
async function markAsRead(instanceId, phone) {
    try {
        const client = await getReadyClient(instanceId);
        if (!client) {
            console.error(`[WHATSAPP CLIENT MISSING] ${instanceId}: markAsRead skipped because client is not initialized.`);
            return false;
        }
        const chatId = toWhatsAppChatId(phone, jidMap);
        if (!chatId) return false;
        const chat = await client.getChatById(chatId);
        await chat.sendSeen();
        return true;
    } catch (error) {
        console.error(`[MARK AS READ ERROR] ${instanceId} -> ${phone}:`, error.message);
        return false;
    }
}

// ✍️ "ЖАЗЫП ЖАТЫР..." СТАТУСЫН КӨРСЕТУ (Presence)
async function sendPresence(instanceId, phone) {
    try {
        const client = clients.get(instanceId);
        if (!client) {
            console.error(`[WHATSAPP CLIENT MISSING] ${instanceId}: sendPresence skipped because client is not initialized.`);
            return false;
        }
        const chatId = toWhatsAppChatId(phone, jidMap);
        if (!chatId) return false;
        const chat = await client.getChatById(chatId);
        await chat.sendStateTyping();
        return true;
    } catch (error) {
        console.error(`[PRESENCE ERROR] ${instanceId} -> ${phone}:`, error.message);
        return false;
    }
}

// 📥 КЛИЕНТТЕН КЕЛГЕН СУРЕТ/АУДИОНЫ ЖҮКТЕП АЛУ (Base64 форматына)
async function findMessageForMediaRecovery(client, phone, messageId) {
    const initialChatId = toWhatsAppChatId(phone, jidMap);
    if (!client || !initialChatId || !messageId) return null;

    const chatIds = [initialChatId];
    const phoneChatId = `${phone}@c.us`;
    if (!chatIds.includes(phoneChatId)) chatIds.push(phoneChatId);
    if (typeof client.getContactLidAndPhone === 'function') {
        const mappings = await withTimeout(
            client.getContactLidAndPhone([phoneChatId]), 3000, 'MEDIA_LID_LOOKUP_TIMEOUT'
        ).catch(() => []);
        for (const mapping of Array.isArray(mappings) ? mappings : []) {
            if (normalizePhoneFromCandidates([mapping?.pn]) !== phone) continue;
            for (const candidate of [mapping?.lid, mapping?.pn]) {
                const chatId = String(candidate || '').trim();
                if (chatId && !chatIds.includes(chatId)) chatIds.push(chatId);
            }
        }
    }

    for (const chatId of chatIds) {
        if (typeof client.getMessageById === 'function') {
            const direct = await withTimeout(
                client.getMessageById(`false_${chatId}_${messageId}`), 3000, 'MEDIA_MESSAGE_LOOKUP_TIMEOUT'
            ).catch(() => null);
            if (String(direct?.id?.id || '') === messageId) {
                jidMap.set(phone, chatId);
                return direct;
            }
        }
        const chat = await withTimeout(client.getChatById(chatId), 3000, 'MEDIA_CHAT_LOOKUP_TIMEOUT').catch(() => null);
        if (!chat || typeof chat.fetchMessages !== 'function') continue;
        const messages = await withTimeout(
            chat.fetchMessages({ limit: 200 }), 5000, 'MEDIA_HISTORY_LOOKUP_TIMEOUT'
        ).catch(() => []);
        const found = messages.find(message => String(message?.id?.id || '') === messageId);
        if (found) {
            jidMap.set(phone, chatId);
            return found;
        }
    }
    return null;
}

async function recoverChatMedia(instanceId, phone, messageId) {
    const cleanPhone = normalizePhoneFromCandidates([phone]);
    const cleanMessageId = String(messageId || '').trim();
    if (!redisClient.isOpen || !isValidChatPhone(cleanPhone) || !cleanMessageId) return null;

    const existing = await redisClient.sendCommand(['GET', chatMediaKey(instanceId, cleanMessageId)]).catch(() => '');
    if (existing) return existing;
    if (!await hasAuthoritativeMessage(instanceId, cleanPhone, cleanMessageId)) return null;

    const recoveryKey = `${instanceId}:${cleanPhone}:${cleanMessageId}`;
    if (mediaRecoveryMisses.has(recoveryKey)) return null;
    const current = mediaRecoveryJobs.get(recoveryKey);
    if (current) return current;

    const job = (async () => {
        const client = await getReadyClient(instanceId);
        if (!client) return null;
        const message = await withTimeout(
            findMessageForMediaRecovery(client, cleanPhone, cleanMessageId), 15000, 'MEDIA_RECOVERY_LOOKUP_TIMEOUT'
        ).catch(() => null);
        if (!isChatMediaCandidate(message)) return null;
        const persisted = await persistMessageMedia(instanceId, cleanPhone, message, {
            requireExistingChat: true,
            publishReady: true
        });
        return persisted?.mediaUrl || null;
    })();
    mediaRecoveryJobs.set(recoveryKey, job);
    try {
        const mediaData = await job;
        if (mediaData) mediaRecoveryMisses.delete(recoveryKey);
        else {
            mediaRecoveryMisses.add(recoveryKey);
            const expiry = setTimeout(() => mediaRecoveryMisses.delete(recoveryKey), 5000);
            expiry.unref?.();
        }
        return mediaData;
    } finally {
        if (mediaRecoveryJobs.get(recoveryKey) === job) mediaRecoveryJobs.delete(recoveryKey);
    }
}

async function getBase64Media(instanceId, keyObj) {
    try {
        const actualMessageId = (typeof keyObj === 'object') ? keyObj.id : keyObj;
        // Тек Redis-тен оқимыз. Егер жоқ болса, демек әлі жүктелмеген немесе өшіп қалған.
        const persisted = await redisClient.sendCommand(['GET', chatMediaKey(instanceId, actualMessageId)]).catch(() => '');
        return persisted || null;
    } catch (error) {
        console.error(`❌ [DOWNLOAD MEDIA ERROR] ${instanceId}:`, error.message);
        return null;
    }
}
module.exports = {
    startWhatsAppInstance,
    startSessionSupervisor,
    stopSessionSupervisor,
    getInstanceStatus,
    clients,
    stopWhatsAppInstance,
    sendWhatsAppText,
    sendMedia,
    markAsRead,
    sendPresence,
    getBase64Media,
    recoverChatMedia,
    shutdownWhatsAppClients,
    __test: {
        isChromiumProfileLockError,
        isChromiumResourceError,
        isConnectedState,
        isQualifiedAudio,
        isQualifiedImage,
        isQualifiedDocument,
        isChatMediaCandidate,
        deliveryStatusFromAck,
        MAX_MEDIA_BYTES,
        MAX_IMAGE_BYTES,
        MAX_MEDIA_BASE64_LENGTH,
        validateAudioBase64,
        validateImageBase64,
        validateDocumentBase64,
        shouldRetryMediaError,
        collectMediaStream,
        createMediaDispatcher,
        downloadBaileysMessageMedia,
        downloadMessageMedia,
        findMessageForMediaRecovery,
        clearMediaDownloadJobs() {
            mediaDownloadJobs.clear();
            mediaDownloadCooldowns.clear();
            activeMediaDownloads = 0;
        },
        incrementLocalBotSend,
        consumeLocalBotSend,
        releaseLocalBotSend,
        clearLocalBotSends() {
            localBotSends.clear();
        },
        clearJidMap() {
            jidMap.clear();
        },
        buildOperatorHistoryEntry,

        rejectIncomingCallReliably,
        handleIncomingCall,
        dispatchIncomingCall,
        seenCallIds,
        resolveCallPhone,
        queueOutgoingText,
        clearRestartTimer,
        scheduleFlush,
        getPendingTextQueue(instanceId) {
            return pendingTextQueues.get(instanceId) || [];
        },
        clearPendingTextQueue(instanceId) {
            pendingTextQueues.delete(instanceId);
        },
        buildReconnectPlan,
        calculateRestartDelay,
        scheduleRestart,
        getRestartTimerInfo,
        getRestartAttempts,
        resetRestartAttempts,
        requestReconnect,
        purgeExpiredOutgoingText,
        flushPendingOutgoingText,
        registerHealthFailure,
        reviveSupervisedInstances,
        logThrottled,
        supervisedInstances
    }
};
