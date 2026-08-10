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
// A seam so tests can hand in a fake Baileys instead of the real one.
let baileysLoader = () => import('@whiskeysockets/baileys');
function loadBaileys() {
    if (!baileysPromise) {
        baileysPromise = baileysLoader().catch(err => {
            baileysPromise = null;
            throw err;
        });
    }
    return baileysPromise;
}

const watchers = new Map();

const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 60000;
const WATCHDOG_MS = 30000;

// Date.now is injected as a seam so tests can hold it still.
let nowMs = () => Date.now();

// Set CALL_SPY=1 to dump what actually arrives on the socket. A ringing call
// updates several times a second, so each kind of line is throttled rather than
// left to flood the log. Off by default: this is a diagnostic, not telemetry.
const SPY_THROTTLE_MS = 1000;
const spySeen = new Map();

// A CALL_SPY file next to the session folders turns the spy on as well as the
// env var. Dokploy owns the compose env, so setting a variable means recreating
// the container; a file can be dropped into a running one, which is the only way
// to catch a call that is happening right now.
function spyEnabled(authDir) {
    if (process.env.CALL_SPY === '1') return true;
    try {
        return fs.existsSync(path.join(path.dirname(authDir), 'CALL_SPY'));
    } catch {
        return false;
    }
}

function spy(log, instanceId, label, payload, authDir) {
    if (!spyEnabled(authDir)) return;
    const key = `${instanceId}:${label}`;
    const last = spySeen.get(key) || 0;
    if (nowMs() - last < SPY_THROTTLE_MS) return;
    spySeen.set(key, nowMs());
    let body;
    try {
        body = JSON.stringify(payload, (_k, v) => (typeof v === 'bigint' ? String(v) : v));
    } catch {
        body = String(payload);
    }
    log.log(`[CALL SPY] ${instanceId} ${label}: ${String(body).slice(0, 900)}`);
}

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

    const state = { instanceId, sock: null, stopped: false, attempt: 0, connected: false, awaitingScan: false, generation: 0, timer: null, watchdog: null };
    watchers.set(instanceId, state);

    fs.mkdirSync(authDir, { recursive: true });

    const baileys = await loadBaileys();
    const makeWASocket = baileys.default || baileys.makeWASocket;
    const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers } = baileys;

    // Every way this watcher could die for good came from a reconnect chain that
    // was allowed to end: a connect() that threw took its own retry down with
    // it, and a logout parked the socket forever. So reconnecting goes through
    // one place that always re-arms, and a watchdog re-arms it even when that
    // place is never reached.
    function scheduleReconnect(reason, delayOverride) {
        if (state.stopped || state.timer) return;
        state.attempt += 1;
        const delay = delayOverride === undefined ? reconnectDelay(state.attempt) : delayOverride;
        logger.warn(`[CALL WATCHER] ${instanceId}: ${reason}, reconnecting in ${delay}ms`);
        state.timer = setTimeout(() => {
            state.timer = null;
            void connect().catch(err => {
                logger.error(`[CALL WATCHER] ${instanceId}: reconnect failed: ${err?.message || err}`);
                scheduleReconnect('reconnect threw');
            });
        }, delay);
    }

    // A closed socket keeps its listeners, and a stale one still firing would
    // hand the same call to the rejection ladder twice.
    function teardown(sock) {
        try { sock?.ev?.removeAllListeners?.(); } catch (_) {}
        try { sock?.end?.(undefined); } catch (_) {}
    }

    const connect = async () => {
        if (state.stopped) return;
        const generation = (state.generation += 1);
        const isCurrent = () => !state.stopped && state.generation === generation;

        teardown(state.sock);
        state.sock = null;
        state.connected = false;

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

        // The raw stanza, one level below the parsed 'call' event. If a call
        // reaches the socket but baileys never surfaces it, this is where that
        // shows up — and the difference between the two is the whole diagnosis.
        if (spyEnabled(authDir) && typeof sock.ws?.on === 'function') {
            for (const tag of ['CB:call', 'CB:ack,class:call', 'CB:offer']) {
                sock.ws.on(tag, node => spy(logger, instanceId, `raw ${tag}`, node, authDir));
            }
        }

        sock.ev.on('connection.update', update => {
            if (!isCurrent()) return;
            const { connection, lastDisconnect, qr } = update;

            // A QR on screen means someone is mid-scan. Tearing that socket down
            // invalidates the code they are looking at, so the watchdog has to
            // leave it alone until the scan lands or the socket closes by itself.
            if (qr) {
                state.awaitingScan = true;
                state.lastSeen = nowMs();
                if (typeof onQr === 'function') onQr(qr);
            }

            if (connection === 'open') {
                state.attempt = 0;
                state.connected = true;
                state.awaitingScan = false;
                state.lastSeen = nowMs();
                logger.log(`[CALL WATCHER] ${instanceId}: socket open, watching for call offers`);
                return;
            }

            if (connection === 'close') {
                state.connected = false;
                state.awaitingScan = false;
                const code = lastDisconnect?.error?.output?.statusCode;
                if (state.stopped) return;
                // Only the phone unlinking the device is terminal. Everything
                // else — 408, 428, 440, a restart, a network blip — is WhatsApp
                // asking us to come back, so it must not look like a logout.
                if (code === DisconnectReason?.loggedOut) {
                    state.loggedOut = true;
                    logger.warn(`[CALL WATCHER] ${instanceId}: unlinked from the phone, needs a fresh QR scan`);
                    if (typeof options.onLoggedOut === 'function') {
                        try { options.onLoggedOut(instanceId); } catch (_) {}
                    }
                    return;
                }
                scheduleReconnect(`socket closed (${code || 'unknown'})`);
            }
        });

        sock.ev.on('call', events => {
            if (!isCurrent()) return;
            state.lastSeen = nowMs();
            spy(logger, instanceId, 'call', events, authDir);
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

    // The last line of defence. Whatever leaves the watcher down without a
    // pending retry — a throw somewhere that never armed one, a close event that
    // never arrived — is picked up within a cycle. It is what makes "down for
    // good" a state this watcher cannot sit in.
    state.watchdog = setInterval(() => {
        if (state.stopped || state.loggedOut || state.connected || state.timer) return;
        if (state.awaitingScan) return;
        scheduleReconnect('watchdog found the socket down');
    }, Number(options.watchdogMs) > 0 ? Number(options.watchdogMs) : WATCHDOG_MS);
    if (typeof state.watchdog?.unref === 'function') state.watchdog.unref();

    await connect().catch(err => {
        logger.error(`[CALL WATCHER] ${instanceId}: first connect failed: ${err?.message || err}`);
        scheduleReconnect('first connect failed');
    });
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
    if (state.watchdog) clearInterval(state.watchdog);
    try { state.sock?.ev?.removeAllListeners?.(); } catch (_) {}
    try { state.sock?.sendPresenceUpdate?.('unavailable'); } catch (_) {}
    try { state.sock?.end?.(undefined); } catch (_) {}
    watchers.delete(instanceId);
    return true;
}

function callWatcherStatus(instanceId) {
    const state = watchers.get(instanceId);
    return {
        watching: Boolean(state),
        connected: Boolean(state?.connected),
        // Only true when the phone unlinked the device. It is the one state a
        // rescan can fix, and the only one the panel should ask about.
        loggedOut: Boolean(state?.loggedOut),
        // A QR is on screen and a person is expected to scan it.
        awaitingScan: Boolean(state?.awaitingScan),
        reconnecting: Boolean(state?.timer),
        attempts: Number(state?.attempt || 0)
    };
}

module.exports = {
    startCallWatcher,
    stopCallWatcher,
    callWatcherStatus,
    rejectViaSocket,
    __test: {
        isIncomingOffer,
        reconnectDelay,
        _setNowForTest: fn => { nowMs = fn; },
        _setBaileysForTest: loader => {
            baileysPromise = null;
            baileysLoader = loader || (() => import('@whiskeysockets/baileys'));
        },
        _getWatchersForTest: () => watchers
    }
};
