const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');

const axios = require('axios');
const crypto = require('node:crypto');
const qrcode = require('qrcode');
const qrcodeTerminal = require('qrcode-terminal');
const { redisClient } = require('../config/redis');
const fs = require('fs');
const path = require('path');

const { isGroupOrStatusJid, normalizePhoneFromCandidates, toWhatsAppChatId } = require('./phoneUtils');
const { forwardIncomingWhatsAppMessage } = require('./incomingWebhook');
const { markOperatorActive, OPERATOR_ACTIVE_SECONDS } = require('./operatorLock');
const { appendMessage, storeMedia, updateMessageReceipt, MAX_MEDIA_BYTES } = require('./chatStore');
const { publishChatEvent } = require('./chatEvents');

const CHAT_STANDARD_TTL_SECONDS = 24 * 60 * 60;
const CHAT_ARCHIVE_TTL_SECONDS = 72 * 60 * 60;
const MEDIA_CDN_TIMEOUT_MS = 12000;
const MEDIA_DOWNLOAD_TIMEOUT_MS = 25000;
const MEDIA_PIPELINE_TIMEOUT_MS = 30000;
const MAX_CONCURRENT_MEDIA_DOWNLOADS = 2;
const MEDIA_DOWNLOAD_COOLDOWN_MS = 15000;
const MAX_MEDIA_BASE64_LENGTH = Math.ceil(MAX_MEDIA_BYTES / 3) * 4;
const localBotSends = new Map();
const permanentMediaFailures = new Set();
const mediaDownloadJobs = new Map();
const mediaDownloadCooldowns = new Map();
const mediaRecoveryJobs = new Map();
const mediaRecoveryMisses = new Set();
let activeMediaDownloads = 0;

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

function shouldRetryMediaError(error) {
    return error?.permanent !== true;
}

function decodeWhatsAppBase64(value, code) {
    if (Buffer.isBuffer(value)) return Buffer.from(value);
    const raw = String(value || '').trim().replace(/-/g, '+').replace(/_/g, '/');
    if (!raw || !/^[A-Za-z0-9+/]*={0,2}$/.test(raw)) throw new Error(code);
    const padded = raw.padEnd(Math.ceil(raw.length / 4) * 4, '=');
    const decoded = Buffer.from(padded, 'base64');
    if (!decoded.length) throw new Error(code);
    return decoded;
}

function verifyWhatsAppSha256(data, expected, code) {
    if (!expected) return;
    const expectedHash = decodeWhatsAppBase64(expected, code);
    const actualHash = crypto.createHash('sha256').update(data).digest();
    if (expectedHash.length !== actualHash.length || !crypto.timingSafeEqual(expectedHash, actualHash)) {
        throw new Error(code);
    }
}

function decryptWhatsAppMedia(encryptedData, mediaKey, mediaType = 'audio') {
    const encrypted = Buffer.isBuffer(encryptedData) ? encryptedData : Buffer.from(encryptedData || []);
    if (encrypted.length < 27 || encrypted.length > MAX_MEDIA_BYTES + 1024) {
        throw new Error('MEDIA_CDN_PAYLOAD_INVALID');
    }
    const key = decodeWhatsAppBase64(mediaKey, 'MEDIA_CDN_KEY_INVALID');
    if (key.length !== 32) throw new Error('MEDIA_CDN_KEY_INVALID');
    const type = String(mediaType || 'audio').toLowerCase();
    const label = type === 'ptt' || type === 'audio' ? 'Audio' : type.charAt(0).toUpperCase() + type.slice(1);
    const expanded = Buffer.from(crypto.hkdfSync(
        'sha256', key, Buffer.alloc(32), Buffer.from(`WhatsApp ${label} Keys`), 112
    ));
    const iv = expanded.subarray(0, 16);
    const cipherKey = expanded.subarray(16, 48);
    const macKey = expanded.subarray(48, 80);
    const ciphertext = encrypted.subarray(0, -10);
    const receivedMac = encrypted.subarray(-10);
    const expectedMac = crypto.createHmac('sha256', macKey)
        .update(Buffer.concat([iv, ciphertext]))
        .digest()
        .subarray(0, 10);
    if (!crypto.timingSafeEqual(receivedMac, expectedMac)) throw new Error('MEDIA_CDN_MAC_INVALID');
    try {
        const decipher = crypto.createDecipheriv('aes-256-cbc', cipherKey, iv);
        const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
        if (!decrypted.length || decrypted.length > MAX_MEDIA_BYTES) throw new Error('MEDIA_CDN_PAYLOAD_INVALID');
        return decrypted;
    } catch (error) {
        if (error?.message === 'MEDIA_CDN_PAYLOAD_INVALID') throw error;
        throw new Error('MEDIA_CDN_DECRYPT_FAILED');
    }
}

async function fetchWhatsAppMediaBytes(url) {
    try {
        const response = await axios.get(url, {
            responseType: 'arraybuffer',
            timeout: MEDIA_CDN_TIMEOUT_MS,
            maxRedirects: 0,
            maxContentLength: MAX_MEDIA_BYTES + 1024,
            maxBodyLength: MAX_MEDIA_BYTES + 1024,
            headers: {
                Accept: '*/*',
                Origin: 'https://web.whatsapp.com',
                Referer: 'https://web.whatsapp.com/'
            }
        });
        return Buffer.isBuffer(response.data) ? response.data : Buffer.from(response.data || []);
    } catch (error) {
        const status = Number(error?.response?.status || 0);
        throw new Error(status ? `MEDIA_CDN_HTTP_${status}` : 'MEDIA_CDN_REQUEST_FAILED');
    }
}

async function downloadEncryptedMessageMedia(msg, requestBinary = fetchWhatsAppMediaBytes) {
    const data = msg?._data || {};
    const mediaData = data.mediaData || {};
    const directPath = String(data.directPath || mediaData.directPath || msg?.directPath || '').trim();
    const mediaKey = msg?.mediaKey || data.mediaKey || mediaData.mediaKey;
    if (!directPath || !mediaKey) return null;

    let parsed;
    try {
        parsed = new URL(directPath, 'https://mmg.whatsapp.net');
    } catch {
        throw new Error('MEDIA_CDN_PATH_INVALID');
    }
    const downloadUrl = `https://mmg.whatsapp.net${parsed.pathname}${parsed.search}`;
    const downloaded = await requestBinary(downloadUrl);
    const encrypted = Buffer.isBuffer(downloaded) ? downloaded : Buffer.from(downloaded || []);
    verifyWhatsAppSha256(encrypted, data.encFilehash || mediaData.encFilehash, 'MEDIA_CDN_ENCRYPTED_HASH_INVALID');
    const decrypted = decryptWhatsAppMedia(encrypted, mediaKey, msg?.type || data.type || 'audio');
    verifyWhatsAppSha256(decrypted, data.filehash || mediaData.filehash, 'MEDIA_CDN_FILE_HASH_INVALID');
    return {
        data: decrypted.toString('base64'),
        mimetype: data.mimetype || mediaData.mimetype || msg?.mimetype || 'audio/ogg',
        filename: data.filename || mediaData.filename || msg?.filename,
        filesize: decrypted.length
    };
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
        const media = await downloadEncryptedMessageMedia(msg);
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
                    mimetype: source.mimetype || blob.type || 'audio/ogg',
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

async function updatePersistedAudioMetadata(instanceId, phone, messageId, mediaType) {
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

    if (!isQualifiedAudio(msg, media)) throw permanentMediaError('MEDIA_NOT_AUDIO');
    const mediaType = mediaMimeFrom(msg, media);

    const base64 = validateAudioBase64(media.data);
    const decoded = Buffer.from(base64, 'base64');
    if (!decoded.length) throw permanentMediaError('MEDIA_BASE64_INVALID');

    const mediaUrl = `data:${mediaType};base64,${base64}`;
    await storeMedia(instanceId, phone, messageId, base64, mediaType);
    if (options.requireExistingChat && !await hasAuthoritativeMessage(instanceId, phone, messageId)) {
        await removeOrphanedMedia(instanceId, phone, messageId);
        return null;
    }
    if (options.publishReady) {
        const updated = await updatePersistedAudioMetadata(instanceId, phone, messageId, mediaType);
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
    if (!isAudioCandidate(msg)) return;

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

const jidMap = new Map();
let shutdownInProgress = false;

const AUTH_DATA_PATH = process.env.WHATSAPP_AUTH_PATH || '/app/whatsapp_auth';
const SESSION_RESTORE_TIMEOUT_MS = Number(process.env.WHATSAPP_RESTORE_TIMEOUT_MS || 120000);
const WA_STATE_TIMEOUT_MS = Number(process.env.WHATSAPP_STATE_TIMEOUT_MS || 2500);
const CHROME_LOCK_RESTART_DELAY_MS = Number(process.env.WHATSAPP_CHROME_LOCK_RESTART_DELAY_MS || 15000);
const WHATSAPP_RESTART_BASE_DELAY_MS = Number(process.env.WHATSAPP_RESTART_BASE_DELAY_MS || 5000);
const WHATSAPP_RESTART_MAX_DELAY_MS = Number(process.env.WHATSAPP_RESTART_MAX_DELAY_MS || 300000);
const WHATSAPP_RESOURCE_RESTART_BASE_DELAY_MS = Number(process.env.WHATSAPP_RESOURCE_RESTART_BASE_DELAY_MS || 30000);
const WHATSAPP_INITIALIZE_MAX_RETRIES = Number(process.env.WHATSAPP_INITIALIZE_MAX_RETRIES || 1);
const OUTGOING_TEXT_QUEUE_TTL_MS = Number(process.env.WHATSAPP_OUTGOING_QUEUE_TTL_MS || 5 * 60 * 1000);
const OUTGOING_TEXT_QUEUE_MAX = Number(process.env.WHATSAPP_OUTGOING_QUEUE_MAX || 50);

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
    const timer = restartTimers.get(instanceId);
    if (timer) clearTimeout(timer);
    restartTimers.delete(instanceId);
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function calculateRestartDelay(instanceId, requestedDelayMs = 3000, reason = 'restart') {
    const attempts = (restartAttempts.get(instanceId) || 0) + 1;
    restartAttempts.set(instanceId, attempts);

    const resourceFailure = isChromiumResourceError(reason);
    const baseDelay = resourceFailure ? WHATSAPP_RESOURCE_RESTART_BASE_DELAY_MS : WHATSAPP_RESTART_BASE_DELAY_MS;
    const maxDelay = Math.max(baseDelay, WHATSAPP_RESTART_MAX_DELAY_MS);
    const exponentialDelay = baseDelay * Math.pow(2, Math.min(attempts - 1, 6));
    const jitter = Math.floor(Math.random() * 1000);

    return Math.max(Number(requestedDelayMs) || 0, Math.min(exponentialDelay, maxDelay)) + jitter;
}

function resetRestartAttempts(instanceId) {
    restartAttempts.delete(instanceId);
}

function getRestartAttempts(instanceId) {
    return restartAttempts.get(instanceId) || 0;
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

function scheduleRestart(instanceId, delayMs = 3000, reason = 'restart') {
    if (shutdownInProgress) return;
    if (intentionallyStopped.has(instanceId)) return;
    if (instanceStates.get(instanceId)?.status === 'qr_required') return;

    clearRestartTimer(instanceId);
    const finalDelayMs = calculateRestartDelay(instanceId, delayMs, reason);
    setInstanceState(instanceId, 'restarting', { reason, nextRestartInMs: finalDelayMs });
    console.warn(`[WHATSAPP] ${instanceId} restart scheduled in ${finalDelayMs}ms (${reason}).`);
    restartTimers.set(instanceId, setTimeout(() => {
        restartTimers.delete(instanceId);
        if (!clients.has(instanceId) && !intentionallyStopped.has(instanceId)) {
            instanceStates.delete(instanceId);
            startWhatsAppInstance(instanceId).catch(error => {
                console.error(`[WHATSAPP] ${instanceId} restart failed:`, error.message);
            });
        }
    }, finalDelayMs));
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

    await appendMessage(instanceId, phone, entry, { state: 'operator' });
    await publishChatEvent({ type: 'history.append', instanceId, phone, message: entry });
    return entry;
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
                '--disable-features=Translate,BackForwardCache'
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
                await resetInvalidSession(instanceId, client, 'restore_timeout', true);
                return;
            }
            console.warn(`[WHATSAPP] ${instanceId} QR startup timed out; waiting for manual restart.`);
            await destroyClient(client);
            initializingClients.delete(instanceId);
            cleanupChromiumRuntimeLocks(instanceId);
            clients.delete(instanceId);
            qrCodes.delete(instanceId);
            setInstanceState(instanceId, 'qr_required', { reason: 'qr_start_timeout', hasStoredSession: false });
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
        qrcodeTerminal.generate(qr, { small: true });
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
        if (isAudioCandidate(msg)) {
            try {
                downloadedMedia = (await persistMessageMedia(instanceId, cleanNumber, msg))?.media || null;
            } catch (error) {
                if (!shouldRetryMediaError(error)) {
                    permanentMediaFailures.add(`${instanceId}:${cleanNumber}:${String(msg?.id?.id || '')}`);
                }
                console.warn(`[MEDIA CACHE] ${instanceId}: audio download skipped: ${error.message}`);
            }
        }

        const hintedMediaType = mediaMimeFrom(msg);
        const effectiveMediaType = downloadedMedia?.mimetype || hintedMediaType;
        const hasAudio = isQualifiedAudio(msg, downloadedMedia || (effectiveMediaType ? { mimetype: effectiveMediaType } : null));
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
                hasMedia: hasAudio,
                mediaData: downloadedMedia?.data || '',
                mediaType: hasAudio ? effectiveMediaType : '',
                mediaKind: msg.type,
                body: msg.body || '',
                pushName: msg._data?.notifyName || contactInfo.pushName || contactInfo.name || 'Client',
                contactName: contactInfo.name || contactInfo.shortName || contactInfo.pushName || '',
                contact: contactInfo,
                data: {
                    normalizedPhone: cleanNumber,
                    senderPhone: cleanNumber,
                    mediaData: downloadedMedia?.data || '',
                    mediaType: hasAudio ? effectiveMediaType : '',
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
            if (downloadedMedia && hasAudio) {
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

    client.on('call', async (call) => {
        try {
            await call.reject();
            await client.sendMessage(call.from, '🚫 Кешіріңіз, бот қоңырауларды қабылдамайды. Өтініш, сұрағыңызды мәтінмен немесе аудиохабарламамен жазыңыз 🙏');
        } catch (err) {}
    });

client.initialize().catch(async err => {
        console.error(`❌ [WHATSAPP] ${instanceId} ИНИЦИАЛИЗАЦИЯ ҚАТЕСІ:`, err.message);
        clearTimeout(watchdog);
        initializingClients.delete(instanceId);
        clients.delete(instanceId);
        qrCodes.delete(instanceId);
        await destroyClient(client);

        if (shutdownInProgress || intentionallyStopped.has(instanceId)) return;

        setInstanceState(instanceId, 'error', { reason: `Қате: ${err.message}` });
        scheduleRestart(instanceId, 15000, `init_failed`); // Шексіз циклді тоқтатып, 15 сек үзіліс жасаймыз
    });

    return { success: true, message: 'Инстанс іске қосылуда. Күте тұрыңыз...' };
}

async function stopWhatsAppInstance(instanceId) {
    intentionallyStopped.add(instanceId);
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
            setInstanceState(instanceId, 'connected', { waState: state || 'CONNECTED' });
            return { status: 'connected', waState: state || 'CONNECTED', hasStoredSession: storedSession };
        }

        if (storedSession && isAuthenticationFailureReason(state || 'DISCONNECTED')) {
            await resetInvalidSession(instanceId, client, `state_${state || 'DISCONNECTED'}`, true);
            return { ...(instanceStates.get(instanceId) || { status: 'qr_required' }), hasStoredSession: false };
        }

        const status = state ? 'starting' : 'disconnected';
        setInstanceState(instanceId, status, { waState: state || null });
        return instanceStates.get(instanceId);
    } catch (error) {
        clients.delete(instanceId);
        setInstanceState(instanceId, 'disconnected', { reason: error.message });
        scheduleRestart(instanceId, 3000, 'state_check_failed');
        return instanceStates.get(instanceId);
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

async function flushPendingOutgoingText(instanceId) {
    const queue = pendingTextQueues.get(instanceId) || [];
    if (!queue.length) return;

    const client = await getReadyClient(instanceId);
    if (!client) {
        scheduleRestart(instanceId, 3000, 'queued_text_waiting_for_client');
        scheduleFlush(instanceId, 5000);
        return;
    }

    pendingTextQueues.set(instanceId, []);
    const retry = [];
    const now = Date.now();

    for (const item of queue) {
        if (now - item.createdAt > OUTGOING_TEXT_QUEUE_TTL_MS) {
            console.warn(`[WHATSAPP QUEUE] ${instanceId} -> ${item.phone}: dropped expired text (${item.reason}).`);
            continue;
        }

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
                scheduleRestart(instanceId, 3000, 'queued_text_client_missing');
                scheduleFlush(instanceId, 5000);
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
        if (!isAudioCandidate(message)) return null;
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
        deliveryStatusFromAck,
        MAX_MEDIA_BYTES,
        MAX_MEDIA_BASE64_LENGTH,
        validateAudioBase64,
        shouldRetryMediaError,
        decryptWhatsAppMedia,
        fetchWhatsAppMediaBytes,
        downloadEncryptedMessageMedia,
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
        buildOperatorHistoryEntry,
        queueOutgoingText,
        clearRestartTimer,
        scheduleFlush,
        getPendingTextQueue(instanceId) {
            return pendingTextQueues.get(instanceId) || [];
        },
        clearPendingTextQueue(instanceId) {
            pendingTextQueues.delete(instanceId);
        }
    }
};
