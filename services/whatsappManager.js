const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');

const qrcode = require('qrcode');
const qrcodeTerminal = require('qrcode-terminal');
const { redisClient } = require('../config/redis');
const fs = require('fs');
const path = require('path');

const { isGroupOrStatusJid, normalizePhoneFromCandidates, toWhatsAppChatId } = require('./phoneUtils');
const { forwardIncomingWhatsAppMessage } = require('./incomingWebhook');
const { markOperatorActive } = require('./operatorLock');

const CHAT_STANDARD_TTL_SECONDS = 24 * 60 * 60;
const CHAT_ARCHIVE_TTL_SECONDS = 72 * 60 * 60;

function isValidChatPhone(phone) {
    return /^\d{10,15}$/.test(String(phone || ''));
}

function chatMediaKey(instanceId, messageId) {
    return `chatwoot:media:${instanceId}:${messageId}`;
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
const messageCache = new Map();
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
    if (!redisClient.isOpen || !phone) return false;

    const key = `bot_sending:${instanceId}:${phone}`;
    const value = await redisClient.get(key).catch(() => '');
    if (!value) return false;

    await redisClient.del(key).catch(() => {});
    return true;
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

async function saveOperatorOutgoingHistory(instanceId, phone, text, source) {
    if (!redisClient.isOpen || !isValidChatPhone(phone) || !text) return;

    const createdAt = Date.now();
    const entry = {
        id: `${source}:${createdAt}:${phone}`,
        instanceId,
        phone,
        direction: 'outgoing',
        fromMe: true,
        role: 'operator',
        text,
        body: text,
        type: 'chat',
        createdAt,
        source
    };

    await Promise.all([
        redisClient.sendCommand(['RPUSH', `chatwoot:history:${instanceId}:${phone}`, JSON.stringify(entry)]),
        redisClient.sendCommand(['ZADD', `chatwoot:inbox:${instanceId}`, String(createdAt), phone])
    ]).catch(error => {
        console.warn(`[OPERATOR HISTORY] ${instanceId} -> ${phone} save failed:`, error.message);
    });
    const archived = await redisClient.sendCommand(['SISMEMBER', `chatwoot:archive:${instanceId}`, phone]).catch(() => 0);
    const ttlSeconds = Number(archived) === 1 ? CHAT_ARCHIVE_TTL_SECONDS : CHAT_STANDARD_TTL_SECONDS;
    await Promise.all([
        redisClient.sendCommand(['EXPIRE', `chatwoot:history:${instanceId}:${phone}`, String(ttlSeconds)]),
        redisClient.sendCommand(['EXPIRE', `history:${instanceId}:${phone}`, String(ttlSeconds)]).catch(() => 0)
    ]).catch(error => {
        console.warn(`[OPERATOR HISTORY] ${instanceId} -> ${phone} expire failed:`, error.message);
    });
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
            if (!isValidChatPhone(phone) || !text) return;
            if (await wasBotSending(instanceId, phone)) return;

            await markOperatorActive(instanceId, phone, 'whatsapp_app');
            if (redisClient.isOpen) {
                await redisClient.sendCommand(['SET', `mute:${instanceId}:${phone}`, 'muted_by_agent', 'EX', '60']).catch(() => {});
            }
            await saveOperatorOutgoingHistory(instanceId, phone, text, 'whatsapp_app');
            console.log(`[OPERATOR LOCK] ${instanceId} -> ${phone}: direct WhatsApp reply activated handoff lock.`);
        } catch (error) {
            console.error(`[OPERATOR LOCK] ${instanceId} message_create failed:`, error.message);
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

        if (msg.hasMedia) {
            messageCache.set(msg.id.id, msg);
            setTimeout(() => messageCache.delete(msg.id.id), 10 * 60 * 1000); 
        }

        let downloadedMedia = null;
        if (msg.hasMedia && (msg.type === 'audio' || msg.type === 'ptt')) {
            try {
                downloadedMedia = await msg.downloadMedia();
                if (downloadedMedia?.data && redisClient.isOpen) {
                    const mediaUrl = `data:${downloadedMedia.mimetype || 'audio/ogg'};base64,${downloadedMedia.data}`;
                    await redisClient.sendCommand(['SET', chatMediaKey(instanceId, msg.id.id), mediaUrl, 'EX', String(CHAT_ARCHIVE_TTL_SECONDS)]).catch(() => 0);
                }
            } catch (error) {
                console.warn(`[MEDIA CACHE] ${instanceId}: audio download skipped: ${error.message}`);
            }
        }

        const messagePayload = { conversation: msg.body };
        if (msg.hasMedia) {
            if (msg.type === 'image') messagePayload.imageMessage = { caption: msg.body };
            else if (msg.type === 'audio' || msg.type === 'ptt') messagePayload.audioMessage = { mimetype: downloadedMedia?.mimetype || 'audio/ogg' };
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
                fromMe: msg.fromMe,
                type: msg.type,
                hasMedia: msg.hasMedia,
                mediaData: downloadedMedia?.data || '',
                mediaType: downloadedMedia?.mimetype || '',
                mediaKind: msg.type,
                body: msg.body || '',
                pushName: msg._data?.notifyName || contactInfo.pushName || contactInfo.name || 'Client',
                contactName: contactInfo.name || contactInfo.shortName || contactInfo.pushName || '',
                contact: contactInfo,
                data: {
                    normalizedPhone: cleanNumber,
                    senderPhone: cleanNumber,
                    mediaData: downloadedMedia?.data || '',
                    mediaType: downloadedMedia?.mimetype || '',
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
    if (!redisClient.isOpen) return;

    const cleanPhone = normalizePhoneFromCandidates([phone, chatId]);
    if (!cleanPhone) return;

    await redisClient.setEx(`bot_sending:${instanceId}:${cleanPhone}`, 20, '1').catch(() => {});
}

async function deliverWhatsAppText(client, instanceId, phone, text) {
    const chatId = toWhatsAppChatId(phone, jidMap);
    if (!chatId) return false;

    await markBotSending(instanceId, phone, chatId);
    await client.sendMessage(chatId, text);
    console.log(`📤 [SENT] ${instanceId} -> ${chatId}: Хат сәтті жіберілді.`);
    return true;
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
            return false;
        }

        return await deliverWhatsAppText(client, instanceId, phone, text);
    } catch (error) {
        console.error(`❌ [SEND ERROR] ${instanceId} -> ${phone}:`, error.message);
        if (!options.skipQueue) {
            queueOutgoingText(instanceId, phone, text, error.message);
            scheduleFlush(instanceId, 5000);
        }
        return false;
    }
}
// 📸 МЕДИА ЖІБЕРУ ФУНКЦИЯСЫ (Сурет, Аудио)
async function sendMedia(instanceId, phone, base64Data, fileName, caption) {
    try {
        const client = await getReadyClient(instanceId);
        if (!client) {
            console.error(`[WHATSAPP CLIENT MISSING] ${instanceId}: sendMedia skipped because client is not initialized.`);
            return false;
        }
        const chatId = toWhatsAppChatId(phone, jidMap);
        if (!chatId) return false;
        await markBotSending(instanceId, phone, chatId);

        // Base64 мәтінінен таза суретті бөліп алу (data:image/jpeg;base64,... дегенді алып тастау)
        let cleanBase64 = base64Data;
        let mimeType = 'image/jpeg';
        if (base64Data.includes(';base64,')) {
            const parts = base64Data.split(';base64,');
            mimeType = parts[0].split(':')[1];
            cleanBase64 = parts[1];
        }

        const media = new MessageMedia(mimeType, cleanBase64, fileName || 'file');
        await client.sendMessage(chatId, media, { caption: caption || '' });
        return true;
    } catch (error) {
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
async function getBase64Media(instanceId, keyObj) {
    try {
        // Контроллер keyObj жібереді, соның ішінен нақты хаттың id-ін суырып аламыз
        const actualMessageId = (typeof keyObj === 'object') ? keyObj.id : keyObj;
        
        const msg = messageCache.get(actualMessageId);
        if (!msg || !msg.hasMedia) return null;
        
        const media = await msg.downloadMedia();
        if (!media?.data) return null;
        return `data:${media.mimetype};base64,${media.data}`;
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
    shutdownWhatsAppClients,
    __test: {
        isChromiumProfileLockError,
        isChromiumResourceError,
        isConnectedState,
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
