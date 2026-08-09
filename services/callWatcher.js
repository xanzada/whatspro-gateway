'use strict';

// Why this exists at all:
//
// A linked WhatsApp Web session never receives an incoming call. The server
// rings the phone and, once the call ends, sends the browser a call-log chat
// entry — which is what the page actually observed here: chat.new_message
// arrived on every attempt, call.incoming_call never did, with three verified
// hooks in place. No amount of page-side wiring can surface an event the
// server does not route to the page.
//
// The protocol clients (Baileys, and Evolution API on top of it) see calls
// because the call offer is a stanza on the socket, not a page event. So the
// call path moves to a small Baileys socket per tenant, and only the call
// path: the offer is rejected here, over the same socket that saw it, and the
// greeting is still delivered by the existing whatsapp-web.js session through
// the existing dispatcher. Logic and architecture are unchanged.
//
// Operationally this is a second linked device for the same number. WhatsApp
// allows four, and it needs its own one-time QR scan per tenant.

const fs = require('fs');
const path = require('path');

let baileysPromise;
function loadBaileys() {
    if (!baileysPromise) {
        baileysPromise = import('@whiskeysockets/baileys').catch(err => {
            baileysPromise = null;
            throw err;
        });
    }
    return baileysPromise;
}

const watchers = new Map();

const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 60000;

function reconnectDelay(attempt) {
    return Math.min(RECONNECT_BASE_MS * 2 ** Math.max(0, attempt - 1), RECONNECT_MAX_MS);
}

// The offer is the only status worth acting on: 'terminate' and 'reject' are
// the tail of a call already over, and claiming those would double-greet.
function isIncomingOffer(event) {
    if (!event || event.isGroup) return false;
    if (event.fromMe === true || event.outgoing === true) return false;
    const status = String(event.status || event.state || '').toLowerCase();
    return status === '' || status === 'offer' || status === 'ringing';
}

async function startCallWatcher(instanceId, options = {}) {
    if (watchers.has(instanceId)) return watchers.get(instanceId);

    const authDir = options.authDir;
    const onIncomingCall = options.onIncomingCall || (() => {});
    const onQr = options.onQr;
    const logger = options.logger || console;

    const state = { instanceId, sock: null, stopped: false, attempt: 0, connected: false };
    watchers.set(instanceId, state);

    fs.mkdirSync(authDir, { recursive: true });

    const baileys = await loadBaileys();
    const makeWASocket = baileys.default || baileys.makeWASocket;
    const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers } = baileys;

    const connect = async () => {
        if (state.stopped) return;

        const { state: authState, saveCreds } = await useMultiFileAuthState(authDir);
        const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));

        const sock = makeWASocket({
            auth: authState,
            version,
            // A call watcher must never mark the number online or pull history:
            // the whatsapp-web.js session owns presence and messages.
            browser: Browsers ? Browsers.ubuntu('Chrome') : ['Ubuntu', 'Chrome', '120.0.0'],
            markOnlineOnConnect: false,
            syncFullHistory: false,
            shouldSyncHistoryMessage: () => false,
            printQRInTerminal: false,
            logger: options.pino || require('pino')({ level: 'silent' })
        });
        state.sock = sock;

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', update => {
            const { connection, lastDisconnect, qr } = update;

            if (qr && typeof onQr === 'function') onQr(qr);

            if (connection === 'open') {
                state.attempt = 0;
                state.connected = true;
                logger.log(`[CALL WATCHER] ${instanceId}: socket open, watching for call offers`);
                return;
            }

            if (connection === 'close') {
                state.connected = false;
                const code = lastDisconnect?.error?.output?.statusCode;
                if (state.stopped) return;
                if (code === DisconnectReason?.loggedOut) {
                    logger.warn(`[CALL WATCHER] ${instanceId}: logged out, needs a fresh QR scan`);
                    return;
                }
                state.attempt += 1;
                const delay = reconnectDelay(state.attempt);
                logger.warn(`[CALL WATCHER] ${instanceId}: socket closed (${code || 'unknown'}), reconnecting in ${delay}ms`);
                state.timer = setTimeout(() => void connect().catch(err =>
                    logger.error(`[CALL WATCHER] ${instanceId}: reconnect failed: ${err?.message || err}`)), delay);
            }
        });

        sock.ev.on('call', events => {
            for (const event of [].concat(events || [])) {
                // A ringing call emits a status update several times a second, so
                // only the two states that change what we do are worth a line.
                if (event?.status === 'offer' || event?.status === 'terminate') {
                    logger.log(`[CALL WATCHER] ${instanceId}: call ${event.status} from ${event.from || event.chatId || 'unknown'}`);
                }
                if (!isIncomingOffer(event)) continue;
                void onIncomingCall(event, sock);
            }
        });

        return sock;
    };

    await connect();
    return state;
}

// Rejecting over the socket that saw the offer is the whole point: it is the
// same path Baileys itself documents, and it needs both ids.
async function rejectViaSocket(sock, call) {
    if (!sock || typeof sock.rejectCall !== 'function') return false;
    const id = call?.id || call?.callId;
    const from = call?.from || call?.chatId || call?.peerJid;
    if (!id || !from) return false;
    await sock.rejectCall(id, from);
    return true;
}

function stopCallWatcher(instanceId) {
    const state = watchers.get(instanceId);
    if (!state) return false;
    state.stopped = true;
    if (state.timer) clearTimeout(state.timer);
    try { state.sock?.end?.(undefined); } catch (_) {}
    watchers.delete(instanceId);
    return true;
}

function callWatcherStatus(instanceId) {
    const state = watchers.get(instanceId);
    return { watching: Boolean(state), connected: Boolean(state?.connected) };
}

module.exports = {
    startCallWatcher,
    stopCallWatcher,
    callWatcherStatus,
    rejectViaSocket,
    __test: { isIncomingOffer, reconnectDelay }
};
