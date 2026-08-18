'use strict';

// A drop-in replacement for whatsapp-web.js's `Client`, backed by Baileys.
//
// whatsappManager.js is ~1700 lines of transport-agnostic logic — queues, Redis
// history, retry ladders, test-mode policy, operator locks — written against the
// whatsapp-web.js event and method surface. Re-shaping that surface would touch
// every one of those lines. So this class speaks Baileys on one side and emits
// wwebjs-*shaped* objects on the other. The shapes below are deliberately
// wwebjs's, warts included (`false_<chatId>_<id>`, ack numbers off by one from
// the wire, `_data.mediaData`), because that is the smallest safe diff.
//
// The lifecycle here is callWatcher.js's, which is the integration already
// running in production: cached ESM import, one re-arming reconnect path, a
// watchdog behind it, a monotonic generation guard so a stale socket cannot
// speak, and the rule that only `loggedOut` is terminal.

const EventEmitter = require('node:events');
const fs = require('fs');

// A seam so tests can hand in a fake Baileys instead of the real one. Baileys 7
// is ESM-only, so every symbol has to come through this import — a top-level
// require() of it would throw at load time under CommonJS.
let baileysPromise;
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

const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 60000;
const WATCHDOG_MS = 30000;
const MESSAGE_CACHE_LIMIT = 500;
const UNREAD_KEYS_PER_CHAT = 20;

// `auth_failure` is the one event that costs a human a physical phone scan: the
// manager answers it by deleting the credential folder. Baileys raises
// `badSession` (500) for a genuinely corrupt store, but the same code also
// arrives after a write that could not complete — a full disk being the case
// this deployment actually has to fear. So the first one is treated as a
// reconnect and only a second one inside this window is believed. A truly
// unusable store fails again within seconds, which costs nothing; a transient
// one no longer costs a trip to the restaurant.
const BAD_SESSION_GRACE_MS = 10 * 60 * 1000;

// fetchLatestBaileysVersion() is a network call on the connect path. Without a
// deadline a hung endpoint holds the socket in limbo: the watchdog fires,
// schedules another connect, and the hung fetches pile up behind each other.
// Baileys' own bundled version is a perfectly good fallback.
const VERSION_FETCH_TIMEOUT_MS = 8000;

function reconnectDelay(attempt) {
    return Math.min(RECONNECT_BASE_MS * 2 ** Math.max(0, attempt - 1), RECONNECT_MAX_MS);
}

// proto.WebMessageInfo.Status. Kept as a literal table because the enum only
// exists inside the ESM module and acks have to be mapped synchronously.
const STATUS_BY_NAME = { ERROR: 0, PENDING: 1, SERVER_ACK: 2, DELIVERY_ACK: 3, READ: 4, PLAYED: 5 };

// Baileys counts ERROR=0, PENDING=1, SERVER_ACK=2, DELIVERY_ACK=3, READ=4,
// PLAYED=5; wwebjs counts PENDING=0, SERVER=1, DEVICE=2, READ=3, PLAYED=4. The
// manager thresholds at `>= 3 -> read`, so handing it the wire number would
// mark every delivered message as read. ERROR becomes -1 rather than -1-by-
// accident, so a rejected message can be shown as failed instead of pending.
function ackFromStatus(status) {
    if (status === null || status === undefined || status === '') return null;
    const raw = typeof status === 'string'
        ? (Object.prototype.hasOwnProperty.call(STATUS_BY_NAME, status.toUpperCase())
            ? STATUS_BY_NAME[status.toUpperCase()]
            : Number(status))
        : Number(status);
    if (!Number.isFinite(raw)) return null;
    return raw <= STATUS_BY_NAME.ERROR ? -1 : raw - 1;
}

// protobuf longs arrive as {low, high, unsigned} or Long instances depending on
// how the message was decoded, and the manager multiplies timestamps by 1000.
function longToNumber(value) {
    if (value === null || value === undefined) return 0;
    if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
    if (typeof value === 'bigint') return Number(value);
    if (typeof value.toNumber === 'function') {
        try { return value.toNumber(); } catch { return 0; }
    }
    if (typeof value.low === 'number') return value.low + (Number(value.high) || 0) * 4294967296;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
}

// filehash and mediaKey travel through Redis and back into
// downloadContentFromMessage, which accepts base64 for the key, and the
// manager's verifyMediaFileHash() base64-decodes the hash. Bytes would not
// survive that round trip.
function toBase64(value) {
    if (value === null || value === undefined || value === '') return undefined;
    if (typeof value === 'string') return value;
    try {
        const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
        return buffer.length ? buffer.toString('base64') : undefined;
    } catch {
        return undefined;
    }
}

const DEVICE_JID_RE = /^([^@:]+)(?::\d+)?@(.+)$/;

// A JID that arrives with a device suffix (`7700...:12@s.whatsapp.net`) is the
// same person as one without. The manager keys Redis history off the phone, so a
// device suffix leaking through would split one conversation into several.
function stripDevice(jid) {
    const raw = String(jid || '').trim();
    if (!raw || !raw.includes('@')) return raw;
    const match = raw.match(DEVICE_JID_RE);
    return match ? `${match[1]}@${match[2]}` : raw;
}

// The manager builds chat ids with phoneUtils, which speaks wwebjs's `@c.us`.
// Baileys only answers to `@s.whatsapp.net`. Groups, LIDs and status@broadcast
// already use the same server on both sides.
function toBaileysJid(chatId) {
    const raw = String(chatId || '').trim();
    if (!raw) return '';
    if (/@c\.us$/i.test(raw)) return `${raw.split('@')[0]}@s.whatsapp.net`;
    if (raw.includes('@')) return raw;
    const digits = raw.replace(/\D/g, '');
    return digits ? `${digits}@s.whatsapp.net` : '';
}

function userOf(jid) {
    return String(jid || '').split('@')[0].split(':')[0];
}

function isGroupJid(jid) {
    return /@g\.us$/i.test(String(jid || ''));
}

// wwebjs's `type` vocabulary, which the manager's media classifiers switch on.
const TYPE_BY_CONTENT = {
    conversation: 'chat',
    extendedTextMessage: 'chat',
    imageMessage: 'image',
    videoMessage: 'video',
    ptvMessage: 'video',
    documentMessage: 'document',
    documentWithCaptionMessage: 'document',
    stickerMessage: 'sticker',
    audioMessage: 'audio',
    protocolMessage: 'protocol_message',
    senderKeyDistributionMessage: 'e2e_notification',
    call: 'call_log',
    callLogMesssage: 'call_log',
    callLogMessage: 'call_log'
};

const MEDIA_CONTENT_TYPES = new Set([
    'imageMessage', 'videoMessage', 'ptvMessage', 'audioMessage', 'documentMessage', 'stickerMessage'
]);

const BAILEYS_MEDIA_TYPE = {
    imageMessage: 'image',
    videoMessage: 'video',
    ptvMessage: 'video',
    audioMessage: 'audio',
    documentMessage: 'document',
    documentWithCaptionMessage: 'document',
    stickerMessage: 'sticker'
};

// A last-resort unwrap for ephemeral / view-once / caption wrappers, used only
// when the loaded module does not expose normalizeMessageContent.
function unwrapContent(content) {
    let current = content;
    for (let depth = 0; current && depth < 5; depth += 1) {
        const inner = current.ephemeralMessage?.message
            || current.viewOnceMessage?.message
            || current.viewOnceMessageV2?.message
            || current.viewOnceMessageV2Extension?.message
            || current.documentWithCaptionMessage?.message
            || current.editedMessage?.message;
        if (!inner) return current;
        current = inner;
    }
    return current;
}

function firstContentKey(content) {
    if (!content || typeof content !== 'object') return undefined;
    const keys = Object.keys(content).filter(key => content[key] !== null && content[key] !== undefined);
    return keys.find(key => key === 'conversation' || key.endsWith('Message')) || keys[0];
}

function bodyOf(content, contentType) {
    if (!content) return '';
    if (typeof content.conversation === 'string' && content.conversation) return content.conversation;
    const node = content[contentType];
    if (typeof node === 'string') return node;
    if (!node || typeof node !== 'object') return '';
    return String(node.text || node.caption || '');
}

function mediaNodeOf(content, contentType) {
    if (!content || !contentType) return null;
    if (!MEDIA_CONTENT_TYPES.has(contentType)) return null;
    const node = content[contentType];
    return node && typeof node === 'object' ? node : null;
}

// The manager builds `new MessageMedia(mime, base64, filename)` before every
// media send. Exported here so the require() at the top of whatsappManager.js
// can drop whatsapp-web.js entirely; the shape is identical, so an already
// constructed wwebjs MessageMedia also works as input to sendMessage().
class MessageMedia {
    constructor(mimetype, data, filename, filesize) {
        this.mimetype = mimetype;
        this.data = data;
        this.filename = filename;
        this.filesize = filesize;
    }

    static fromFilePath(filePath) {
        const b64 = fs.readFileSync(filePath, { encoding: 'base64' });
        return new MessageMedia('application/octet-stream', b64, require('path').basename(filePath));
    }
}

function isMediaLike(value) {
    return Boolean(value) && typeof value === 'object' && typeof value.data === 'string';
}

class BaileysClient extends EventEmitter {
    constructor(options = {}) {
        super();
        this.instanceId = String(options.instanceId || '');
        this.authDir = options.authDir;
        this.logger = options.logger || console;
        this.options = options;

        // Marking the number online suppresses notifications on the owner's
        // phone, which is the single most damaging default this transport has.
        this.markOnlineOnConnect = options.markOnlineOnConnect === true;

        this._sock = null;
        this._baileys = null;
        this._stopped = false;
        this._connected = false;
        this._loggedOut = false;
        this._awaitingScan = false;
        this._attempt = 0;
        this._generation = 0;
        this._timer = null;
        this._watchdog = null;
        this._lastSeen = 0;
        this._badSessionAt = 0;
        this._user = null;
        this._messages = new Map();
        // A second index on the bare message id. A receipt does not always carry
        // the chat's jid (see _messageForKey), and the id is unique per send.
        this._messagesById = new Map();
        this._unreadKeys = new Map();
        this._pushNames = new Map();
        this._contacts = new Map();

        // whatsapp-web.js exposes a puppeteer page. Every page-dependent branch
        // in the manager is guarded with `if (!page)`, so leaving this undefined
        // makes those branches no-op instead of throwing.
        this.pupPage = undefined;
        this.pupBrowser = undefined;
    }

    get info() {
        const jid = this._selfJid();
        if (!jid) return undefined;
        return {
            wid: { _serialized: jid, user: userOf(jid), server: jid.split('@')[1] || 's.whatsapp.net' },
            pushname: this._user?.name || this._user?.notify || ''
        };
    }

    getState() {
        // wwebjs answers 'CONNECTED' or a DISCONNECTED-ish value / null. The
        // manager treats a null as "starting", never as a reason to wipe creds.
        return this._connected ? 'CONNECTED' : null;
    }

    _selfJid() {
        const raw = this._user?.id || this._sock?.user?.id || '';
        return raw ? stripDevice(raw) : '';
    }

    _log(level, message) {
        const fn = typeof this.logger?.[level] === 'function'
            ? this.logger[level]
            : (typeof this.logger?.log === 'function' ? this.logger.log : null);
        if (fn) {
            try { fn.call(this.logger, `[BAILEYS] ${this.instanceId}: ${message}`); } catch (_) {}
        }
    }

    // Nothing that arrives on the socket may take the client down with it.
    _safeEmit(event, ...args) {
        try {
            this.emit(event, ...args);
        } catch (error) {
            this._log('error', `listener for '${event}' threw: ${error?.message || error}`);
        }
    }

    async initialize() {
        if (this._stopped) throw new Error('CLIENT_DESTROYED');
        if (this.authDir) fs.mkdirSync(this.authDir, { recursive: true });
        this._baileys = await loadBaileys();

        // A first connect that throws is reported to the caller, the way
        // wwebjs's initialize() does: the manager already owns a restart ladder
        // for that case and running two supervisors over one socket is how a
        // tenant ends up with duplicate sessions.
        await this._connect();

        this._watchdog = setInterval(() => this._watchdogTick(), this._watchdogMs());
        if (typeof this._watchdog?.unref === 'function') this._watchdog.unref();
        return this;
    }

    _watchdogMs() {
        const configured = Number(this.options.watchdogMs);
        return configured > 0 ? configured : WATCHDOG_MS;
    }

    // The last line of defence: anything that leaves the client down without a
    // pending retry — a throw that never armed one, a close event that never
    // arrived — is picked up within a cycle.
    _watchdogTick() {
        if (this._stopped || this._loggedOut || this._connected || this._timer) return;
        // A QR on screen means someone is mid-scan; tearing that socket down
        // invalidates the code they are looking at.
        if (this._awaitingScan) return;
        this._scheduleReconnect('watchdog found the socket down');
    }

    // One place that always re-arms. Every way this client could die for good
    // came from a reconnect chain that was allowed to end.
    _scheduleReconnect(reason, delayOverride) {
        if (this._stopped || this._loggedOut || this._timer) return;
        this._attempt += 1;
        const delay = delayOverride === undefined ? reconnectDelay(this._attempt) : delayOverride;
        this._log('warn', `${reason}, reconnecting in ${delay}ms`);
        this._timer = setTimeout(() => {
            this._timer = null;
            void this._connect().catch(error => {
                this._log('error', `reconnect failed: ${error?.message || error}`);
                this._scheduleReconnect('reconnect threw');
            });
        }, delay);
        if (typeof this._timer?.unref === 'function') this._timer.unref();
    }

    // A closed socket keeps its listeners, and a stale one still firing would
    // hand the same message to the webhook twice.
    _teardown(sock) {
        try { sock?.ev?.removeAllListeners?.(); } catch (_) {}
        try { sock?.end?.(undefined); } catch (_) {}
    }

    async _connect() {
        if (this._stopped) return null;
        const generation = (this._generation += 1);
        const isCurrent = () => !this._stopped && this._generation === generation;

        this._teardown(this._sock);
        this._sock = null;
        this._connected = false;

        const baileys = this._baileys || (this._baileys = await loadBaileys());
        const makeWASocket = baileys.default || baileys.makeWASocket;
        const { useMultiFileAuthState, fetchLatestBaileysVersion, Browsers } = baileys;

        const { state: authState, saveCreds } = await useMultiFileAuthState(this.authDir);
        const { version } = await this._latestVersion(fetchLatestBaileysVersion);

        const sock = makeWASocket({
            auth: authState,
            version,
            browser: Browsers ? Browsers.ubuntu('Chrome') : ['Ubuntu', 'Chrome', '120.0.0'],
            // A history sync would replay months of old chats straight into the
            // incoming webhook, which would re-answer conversations that ended
            // last spring. Both flags are required: the first stops the request,
            // the second refuses any chunk that arrives anyway.
            syncFullHistory: false,
            shouldSyncHistoryMessage: () => false,
            markOnlineOnConnect: this.markOnlineOnConnect,
            printQRInTerminal: false,
            logger: this.options.pino || require('pino')({ level: 'silent' })
        });
        this._sock = sock;

        if (typeof saveCreds === 'function') sock.ev.on('creds.update', saveCreds);
        this._wire(sock, isCurrent);
        return sock;
    }

    // Ask WhatsApp which client version to claim, but never let that question
    // hold the connect path open. `undefined` makes Baileys use the version it
    // shipped with, which is what a fetch failure already fell back to.
    async _latestVersion(fetchLatestBaileysVersion) {
        if (typeof fetchLatestBaileysVersion !== 'function') return { version: undefined };
        const budget = Number(this.options.versionTimeoutMs) > 0
            ? Number(this.options.versionTimeoutMs)
            : VERSION_FETCH_TIMEOUT_MS;
        let timer;
        try {
            return await Promise.race([
                fetchLatestBaileysVersion(),
                new Promise(resolve => {
                    timer = setTimeout(() => {
                        this._log('warn', 'version lookup timed out, using the bundled version');
                        resolve({ version: undefined });
                    }, budget);
                    if (typeof timer?.unref === 'function') timer.unref();
                })
            ]);
        } catch (error) {
            this._log('warn', `version lookup failed (${error?.message || error}), using the bundled version`);
            return { version: undefined };
        } finally {
            if (timer) clearTimeout(timer);
        }
    }

    async destroy() {
        this._stopped = true;
        this._connected = false;
        if (this._timer) clearTimeout(this._timer);
        this._timer = null;
        if (this._watchdog) clearInterval(this._watchdog);
        this._watchdog = null;
        try { this._sock?.ev?.removeAllListeners?.(); } catch (_) {}
        try { await this._sock?.end?.(undefined); } catch (_) {}
        this._sock = null;
        this._messages.clear();
        this._messagesById.clear();
        this._unreadKeys.clear();
        this._contacts.clear();
        return true;
    }

    async logout() {
        this._loggedOut = true;
        if (this._timer) clearTimeout(this._timer);
        this._timer = null;
        try {
            if (typeof this._sock?.logout === 'function') await this._sock.logout();
        } catch (error) {
            this._log('warn', `logout failed: ${error?.message || error}`);
        }
        return true;
    }

    _wire(sock, isCurrent) {
        const guard = handler => payload => {
            if (!isCurrent()) return;
            try {
                handler(payload);
            } catch (error) {
                this._log('error', `event handler threw: ${error?.message || error}`);
            }
        };

        sock.ev.on('connection.update', guard(update => this._onConnectionUpdate(update, sock)));
        sock.ev.on('messages.upsert', guard(payload => this._onMessagesUpsert(payload)));
        sock.ev.on('messages.update', guard(updates => this._onMessagesUpdate(updates)));
        sock.ev.on('contacts.upsert', guard(contacts => this._rememberContacts(contacts)));
        sock.ev.on('contacts.update', guard(contacts => this._rememberContacts(contacts)));
        // A one-to-one chat reports delivery and read on the receipt stream, not
        // as a status on messages.update, so the panel stayed on a single tick
        // forever when only the latter was wired.
        sock.ev.on('message-receipt.update', guard(updates => this._onReceiptUpdate(updates)));
        sock.ev.on('call', guard(events => this._onCall(events, sock)));
        // A history chunk is dropped on the floor rather than trusted: the flags
        // above should prevent one, and a webhook replay is unrecoverable.
        sock.ev.on('messaging-history.set', guard(payload => this._rememberContacts(payload?.contacts)));
    }

    _rememberContacts(contacts) {
        for (const contact of Array.isArray(contacts) ? contacts : []) {
            const jid = stripDevice(contact?.id || contact?.jid || '');
            if (!jid || isGroupJid(jid)) continue;
            const previous = this._contacts.get(jid) || {};
            const next = { ...previous, ...contact, id: jid };
            // `name` is the owner's local address-book label. `notify` is only
            // the sender's public push name and must never classify a stranger
            // as a saved/private contact.
            if (Object.prototype.hasOwnProperty.call(contact, 'name') && !String(contact.name || '').trim()) {
                delete next.name;
            }
            this._contacts.set(jid, next);
        }
    }

    _onConnectionUpdate(update, sock) {
        const { connection, lastDisconnect, qr } = update || {};
        const { DisconnectReason } = this._baileys || {};

        if (qr) {
            this._awaitingScan = true;
            this._lastSeen = Date.now();
            // The raw string, not a PNG: the manager renders it with `qrcode`
            // and decides whether it may ever reach a log.
            this._safeEmit('qr', qr);
        }

        if (connection === 'open') {
            this._attempt = 0;
            this._connected = true;
            this._awaitingScan = false;
            this._loggedOut = false;
            this._badSessionAt = 0;
            this._lastSeen = Date.now();
            this._user = sock?.user || this._user;
            this._log('log', 'socket open');
            this._safeEmit('ready');
            return;
        }

        if (connection !== 'close') return;

        this._connected = false;
        this._awaitingScan = false;
        if (this._stopped) return;

        const code = lastDisconnect?.error?.output?.statusCode;

        // Only the phone unlinking the device is terminal. 408, 428, 440 and a
        // requested restart are WhatsApp asking us to come back — surfacing any
        // of them as 'disconnected' would make the manager delete the session
        // folder and demand a fresh QR scan for a network blip.
        if (code === DisconnectReason?.loggedOut) {
            this._loggedOut = true;
            this._log('warn', 'unlinked from the phone, a fresh QR scan is required');
            this._safeEmit('disconnected', 'LOGOUT');
            return;
        }

        if (DisconnectReason?.badSession !== undefined && code === DisconnectReason.badSession) {
            const previous = this._badSessionAt;
            this._badSessionAt = Date.now();
            if (!previous || this._badSessionAt - previous > BAD_SESSION_GRACE_MS) {
                // Deleting credentials costs a physical QR scan, so the first one
                // is not believed. See BAD_SESSION_GRACE_MS.
                this._scheduleReconnect(`credentials rejected (${code}), retrying once before giving up on them`);
                return;
            }
            this._log('warn', 'credentials rejected twice, reporting auth_failure');
            this._safeEmit('auth_failure', `bad_session (${code})`);
            return;
        }

        if (DisconnectReason?.restartRequired !== undefined && code === DisconnectReason.restartRequired) {
            // Baileys asks for this immediately after a successful pairing.
            // Backing off here leaves a freshly scanned tenant dark for seconds.
            this._scheduleReconnect('restart required after pairing', 0);
            return;
        }

        this._scheduleReconnect(`socket closed (${code || 'unknown'})`);
    }

    _onMessagesUpsert(payload) {
        const { messages, type } = payload || {};
        // 'notify' is a live message, 'append' is the echo of one sent from the
        // owner's own phone — which is exactly the operator-handoff signal the
        // manager listens for. Anything else is a sync artefact.
        if (type && type !== 'notify' && type !== 'append') return;

        for (const waMessage of [].concat(messages || [])) {
            try {
                if (!waMessage?.key?.id) continue;
                const msg = this._buildMessage(waMessage);
                if (!msg) continue;
                this._cacheMessage(msg);

                // Baileys delivers the account's own messages on the same
                // channel; wwebjs never did. Emitting those as 'message' would
                // push every bot reply back into the incoming webhook and loop.
                if (msg.fromMe) {
                    this._safeEmit('message_create', msg);
                    continue;
                }
                this._rememberUnread(msg, waMessage);
                // Groups and status@broadcast are passed through: the manager
                // runs isGroupOrStatusJid() itself and its filtering is what the
                // noise-filter tests cover.
                this._safeEmit('message', msg);
            } catch (error) {
                this._log('error', `upsert handling failed: ${error?.message || error}`);
            }
        }
    }

    _onMessagesUpdate(updates) {
        for (const entry of [].concat(updates || [])) {
            try {
                const status = entry?.update?.status;
                const ack = ackFromStatus(status);
                if (ack === null) continue;
                const msg = this._messageForKey(entry.key);
                if (!msg) continue;
                msg.ack = ack;
                this._safeEmit('message_ack', msg, ack);
            } catch (error) {
                this._log('error', `ack handling failed: ${error?.message || error}`);
            }
        }
    }

    _onReceiptUpdate(updates) {
        for (const entry of [].concat(updates || [])) {
            try {
                const receipt = entry?.receipt || {};
                // wwebjs numbering: 2 is delivered, 3 is read. A played voice
                // note is still 'read' as far as the panel is concerned.
                let ack = null;
                if (receipt.readTimestamp || receipt.playedTimestamp) ack = 3;
                else if (receipt.receiptTimestamp) ack = 2;
                if (ack === null) continue;
                const msg = this._messageForKey(entry.key);
                if (!msg) continue;
                if (Number(msg.ack) >= ack) continue;
                msg.ack = ack;
                this._safeEmit('message_ack', msg, ack);
            } catch (error) {
                this._log('error', `receipt handling failed: ${error?.message || error}`);
            }
        }
    }

    _onCall(events, sock) {
        for (const event of [].concat(events || [])) {
            try {
                if (!event || event.fromMe === true || event.outgoing === true) continue;
                const status = String(event.status || event.state || '').toLowerCase();
                // 'terminate' / 'reject' / 'accept' are the tail of a call that
                // is already over; claiming those would greet the caller twice.
                if (status && status !== 'offer' && status !== 'ringing') continue;

                const id = String(event.id || event.callId || '');
                const from = stripDevice(event.from || event.chatId || event.peerJid || '');
                const call = {
                    id,
                    from,
                    chatId: stripDevice(event.chatId || from),
                    peerJid: from,
                    isVideo: Boolean(event.isVideo),
                    isGroup: Boolean(event.isGroup),
                    // wwebjs sees a call as a companion device the server will
                    // not accept a rejection from, which is why the manager has
                    // to inject wa-js. On this socket the reject stanza is ours
                    // to send, so the first rung of that ladder is unnecessary.
                    canHandleLocally: true,
                    status: status || 'offer',
                    timestamp: event.date instanceof Date
                        ? Math.floor(event.date.getTime() / 1000)
                        : Math.floor(Date.now() / 1000),
                    reject: () => this.rejectCall(id, from)
                };
                this._safeEmit('call', call);
            } catch (error) {
                this._log('error', `call handling failed: ${error?.message || error}`);
            }
        }
    }

    // Rejecting over the socket that saw the offer is the whole point, and
    // Baileys needs both ids.
    async rejectCall(callId, from) {
        const id = String(callId || '');
        const peer = stripDevice(from || '');
        if (!id || !peer) return false;
        if (typeof this._sock?.rejectCall !== 'function') return false;
        await this._sock.rejectCall(id, peer);
        return true;
    }

    _normalizeContent(message) {
        const normalize = this._baileys?.normalizeMessageContent;
        if (typeof normalize === 'function') {
            try { return normalize(message) || null; } catch (_) {}
        }
        return unwrapContent(message) || null;
    }

    _contentTypeOf(content) {
        const getContentType = this._baileys?.getContentType;
        if (typeof getContentType === 'function') {
            try {
                const type = getContentType(content);
                if (type) return type;
            } catch (_) {}
        }
        return firstContentKey(content);
    }

    // The wwebjs Message shape, field for field. `_data` in particular is not
    // decoration: whatsappManager.js:235-296 reads directPath / clientUrl /
    // mediaKey / filehash straight out of it and hands them to Baileys'
    // downloadContentFromMessage, so that CDN-decrypt path keeps working
    // unchanged as long as this node is populated from the media proto.
    _buildMessage(waMessage) {
        const key = waMessage.key || {};
        const content = this._normalizeContent(waMessage.message);
        const contentType = this._contentTypeOf(content);
        const media = mediaNodeOf(content, contentType);

        const remote = stripDevice(key.remoteJid || '');
        const participant = key.participant ? stripDevice(key.participant) : undefined;
        const fromMe = Boolean(key.fromMe);
        const me = this._selfJid();
        const messageId = String(key.id || '');

        const type = contentType === 'audioMessage'
            ? (media?.ptt ? 'ptt' : 'audio')
            : (TYPE_BY_CONTENT[contentType] || (content ? 'chat' : 'e2e_notification'));

        const id = {
            fromMe,
            remote,
            id: messageId,
            participant,
            // The manager looks messages up as `false_<chatId>_<id>`
            // (whatsappManager.js:2770), so the participant suffix wwebjs adds
            // for group messages is deliberately left out.
            _serialized: `${fromMe ? 'true' : 'false'}_${remote}_${messageId}`
        };

        const from = fromMe ? (me || remote) : remote;
        const to = fromMe ? remote : (me || remote);
        const timestamp = Math.floor(longToNumber(waMessage.messageTimestamp)) || Math.floor(Date.now() / 1000);
        const notifyName = waMessage.pushName || this._pushNames.get(participant || remote) || undefined;
        if (waMessage.pushName) this._pushNames.set(participant || remote, waMessage.pushName);

        const mimetype = media?.mimetype || undefined;
        const filename = media?.fileName || media?.title || undefined;
        const mediaKey = toBase64(media?.mediaKey);
        const directPath = media?.directPath || undefined;
        const clientUrl = media?.url || undefined;
        const size = longToNumber(media?.fileLength) || undefined;
        const filehash = toBase64(media?.fileSha256);

        const mediaData = {
            mimetype, filename, size, filehash, directPath,
            clientUrl, url: clientUrl, mediaKey,
            type, mediaStage: media ? 'RESOLVED' : undefined
        };

        const msg = {
            id,
            from,
            to,
            author: participant,
            fromMe,
            body: bodyOf(content, contentType),
            // Seconds, not milliseconds: the manager multiplies by 1000 itself
            // (whatsappManager.js:1598).
            timestamp,
            type,
            hasMedia: Boolean(media),
            isStatus: remote === 'status@broadcast',
            isGroupMsg: isGroupJid(remote),
            deviceType: 'baileys',
            ack: ackFromStatus(waMessage.status),
            mimetype,
            filename,
            mediaKey,
            directPath,
            url: clientUrl,
            _data: {
                notifyName,
                id: { ...id },
                author: participant,
                from,
                to,
                t: timestamp,
                type,
                mimetype, filename, size, filehash,
                directPath, clientUrl, url: clientUrl, mediaKey,
                mediaData
            },
            _baileys: waMessage,
            downloadMedia: () => this._downloadMedia(waMessage, media, contentType),
            getContact: () => this._contactFromMessage(msg)
        };
        return msg;
    }

    _cacheMessage(msg) {
        this._messages.set(msg.id._serialized, msg);
        this._messagesById.set(String(msg.id.id), msg);
        if (this._messages.size > MESSAGE_CACHE_LIMIT) {
            const oldest = this._messages.keys().next().value;
            const evicted = this._messages.get(oldest);
            this._messages.delete(oldest);
            if (evicted && this._messagesById.get(String(evicted.id.id)) === evicted) {
                this._messagesById.delete(String(evicted.id.id));
            }
        }
    }

    _rememberUnread(msg, waMessage) {
        const jid = msg.id.remote;
        if (!jid) return;
        const keys = this._unreadKeys.get(jid) || [];
        keys.push(waMessage.key);
        while (keys.length > UNREAD_KEYS_PER_CHAT) keys.shift();
        this._unreadKeys.set(jid, keys);
    }

    // An ack arrives as a bare key. The cached message carries the chat and the
    // media node the manager needs; without one, a minimal message is
    // synthesised so an ack for a send made before a restart is not lost.
    _messageForKey(key) {
        if (!key?.id) return null;
        const remote = stripDevice(key.remoteJid || '');
        const fromMe = Boolean(key.fromMe);
        const serialized = `${fromMe ? 'true' : 'false'}_${remote}_${String(key.id)}`;
        const cached = this._messages.get(serialized);
        if (cached) return cached;
        // A delivery or read receipt for a message we sent does not always name
        // the chat: some stanzas arrive addressed to this account's own jid, and
        // filing the ack off that would credit the operator's own number instead
        // of the customer's — which is exactly how every outgoing message stayed
        // on one tick while a receipts hash for our own number filled up. The id
        // is unique per send, so the message cached when it was sent wins.
        const byId = this._messagesById.get(String(key.id));
        if (byId && Boolean(byId.fromMe) === fromMe) return byId;
        return this._buildMessage({ key, message: null, messageTimestamp: Math.floor(Date.now() / 1000) });
    }

    async _downloadMedia(waMessage, media, contentType) {
        if (!media) return null;
        const baileys = this._baileys || (this._baileys = await loadBaileys());
        const mimetype = media.mimetype || undefined;
        const filename = media.fileName || media.title || undefined;

        if (typeof baileys.downloadMediaMessage === 'function') {
            const buffer = await baileys.downloadMediaMessage(waMessage, 'buffer', {}, {
                logger: this.options.pino,
                reuploadRequest: typeof this._sock?.updateMediaMessage === 'function'
                    ? this._sock.updateMediaMessage
                    : undefined
            });
            const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
            if (!bytes.length) return null;
            return { mimetype, data: bytes.toString('base64'), filename, filesize: bytes.length };
        }

        if (typeof baileys.downloadContentFromMessage !== 'function') return null;
        const stream = await baileys.downloadContentFromMessage(
            { mediaKey: media.mediaKey, directPath: media.directPath, url: media.url },
            BAILEYS_MEDIA_TYPE[contentType] || 'document'
        );
        const chunks = [];
        for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk || []));
        const bytes = Buffer.concat(chunks);
        if (!bytes.length) return null;
        return { mimetype, data: bytes.toString('base64'), filename, filesize: bytes.length };
    }

    _contactFromMessage(msg) {
        const jid = msg.fromMe ? msg.to : (msg.author || msg.from);
        const pushName = msg._data?.notifyName || this._pushNames.get(jid) || '';
        return this._contactShape(jid, pushName, msg.fromMe);
    }

    _contactShape(jid, pushName, isMe = false) {
        const normalized = stripDevice(jid || '');
        const user = userOf(normalized);
        const saved = this._contacts.get(normalized) || {};
        const localName = String(saved.name || '').trim();
        const publicName = String(saved.notify || pushName || '').trim();
        return {
            id: {
                _serialized: normalized,
                user,
                server: normalized.split('@')[1] || 's.whatsapp.net'
            },
            number: user,
            name: localName || publicName,
            shortName: localName || publicName,
            pushname: publicName,
            isMyContact: Boolean(localName),
            isWAContact: Boolean(normalized),
            isMe: Boolean(isMe),
            isUser: !isGroupJid(normalized),
            isGroup: isGroupJid(normalized),
            isBusiness: false,
            isEnterprise: false
        };
    }

    async getContactById(jid) {
        const normalized = stripDevice(toBaileysJid(jid));
        if (!normalized) return null;
        const me = this._selfJid();
        return this._contactShape(normalized, this._pushNames.get(normalized) || '', normalized === me);
    }

    // Returns Baileys' own {pn, lid} pairs. The manager treats an empty array as
    // "unknown" and falls through to its other resolvers, so a failure here must
    // never throw.
    async getContactLidAndPhone(jids = []) {
        const input = [].concat(jids || []).map(value => String(value || '').trim()).filter(Boolean);
        if (!input.length) return [];
        const store = this._sock?.signalRepository?.lidMapping;
        const out = [];

        const lids = input.filter(value => /@lid$/i.test(value));
        const pns = [...new Set(input.filter(value => !/@lid$/i.test(value)).map(toBaileysJid).filter(Boolean))];

        try {
            if (lids.length && typeof store?.getPNsForLIDs === 'function') {
                out.push(...((await store.getPNsForLIDs(lids)) || []));
            }
            if (pns.length && typeof store?.getLIDsForPNs === 'function') {
                out.push(...((await store.getLIDsForPNs(pns)) || []));
            }
        } catch (error) {
            this._log('warn', `LID mapping lookup failed: ${error?.message || error}`);
        }

        // A number the mapping store has never seen can still be confirmed to
        // exist on WhatsApp, which is enough for the manager to keep the phone.
        if (!out.length && pns.length && typeof this._sock?.onWhatsApp === 'function') {
            try {
                const results = (await this._sock.onWhatsApp(...pns)) || [];
                for (const entry of results) {
                    if (!entry?.exists) continue;
                    out.push({ pn: stripDevice(entry.jid || ''), lid: String(entry.lid || '') });
                }
            } catch (error) {
                this._log('warn', `onWhatsApp lookup failed: ${error?.message || error}`);
            }
        }

        return out.filter(entry => entry && (entry.pn || entry.lid));
    }

    async getMessageById(serializedId) {
        const raw = String(serializedId || '').trim();
        if (!raw) return null;
        const direct = this._messages.get(raw);
        if (direct) return direct;
        // The manager always asks with a `false_` prefix even for its own sends.
        const parts = raw.split('_');
        const messageId = parts[parts.length - 1];
        for (const msg of this._messages.values()) {
            if (msg.id.id === messageId) return msg;
        }
        return null;
    }

    getChatById(chatId) {
        const jid = toBaileysJid(chatId);
        if (!jid) return Promise.reject(new Error('CHAT_ID_INVALID'));
        const self = this;
        return Promise.resolve({
            id: { _serialized: jid, user: userOf(jid), server: jid.split('@')[1] || 's.whatsapp.net' },
            isGroup: isGroupJid(jid),
            name: self._pushNames.get(jid) || '',

            async sendSeen() {
                const keys = self._unreadKeys.get(jid) || [];
                if (!keys.length || typeof self._sock?.readMessages !== 'function') return false;
                await self._sock.readMessages(keys);
                self._unreadKeys.delete(jid);
                return true;
            },

            async sendStateTyping() {
                if (typeof self._sock?.sendPresenceUpdate !== 'function') return false;
                await self._sock.sendPresenceUpdate('composing', jid);
                return true;
            },

            async sendStateRecording() {
                if (typeof self._sock?.sendPresenceUpdate !== 'function') return false;
                await self._sock.sendPresenceUpdate('recording', jid);
                return true;
            },

            async clearState() {
                if (typeof self._sock?.sendPresenceUpdate !== 'function') return false;
                await self._sock.sendPresenceUpdate('paused', jid);
                return true;
            },

            // Baileys 7 ships no message store, so this can only answer from
            // what this process has seen since it started. See the note in
            // findMessageForMediaRecovery about what that costs.
            async fetchMessages({ limit = 50 } = {}) {
                const found = [];
                for (const msg of self._messages.values()) {
                    if (msg.id.remote === jid) found.push(msg);
                }
                return found.slice(-Math.max(1, Number(limit) || 50));
            },

            sendMessage(content, options) {
                return self.sendMessage(jid, content, options);
            }
        });
    }

    _buildSendContent(contentOrMedia, options = {}) {
        if (typeof contentOrMedia === 'string') return { text: contentOrMedia };
        if (!isMediaLike(contentOrMedia)) {
            // Already a Baileys content object; passed through untouched.
            if (contentOrMedia && typeof contentOrMedia === 'object') return contentOrMedia;
            throw new Error('SEND_CONTENT_INVALID');
        }

        const raw = String(contentOrMedia.data || '');
        const base64 = raw.includes(';base64,') ? raw.split(';base64,')[1] : raw;
        const buffer = Buffer.from(base64, 'base64');
        if (!buffer.length) throw new Error('SEND_MEDIA_EMPTY');

        const mimetype = String(contentOrMedia.mimetype || 'application/octet-stream').split(';')[0].trim();
        const caption = options.caption ? String(options.caption) : undefined;
        const fileName = contentOrMedia.filename || options.filename || undefined;

        if (options.sendMediaAsSticker === true) return { sticker: buffer };
        if (mimetype.startsWith('image/')) return { image: buffer, mimetype, caption, fileName };
        if (mimetype.startsWith('video/')) return { video: buffer, mimetype, caption, fileName };
        if (mimetype.startsWith('audio/')) {
            // A voice note and an audio file are the same bytes with a different
            // flag, and the manager's audio replies are meant to be voice notes.
            return { audio: buffer, mimetype, ptt: options.sendAudioAsVoice === true };
        }
        return { document: buffer, mimetype, fileName: fileName || 'file', caption };
    }

    async sendMessage(chatId, contentOrMedia, options = {}) {
        const jid = toBaileysJid(chatId);
        if (!jid) throw new Error('CHAT_ID_INVALID');
        if (typeof this._sock?.sendMessage !== 'function') throw new Error('SOCKET_NOT_READY');

        const content = this._buildSendContent(contentOrMedia, options || {});
        const sent = await this._sock.sendMessage(jid, content);
        if (!sent) return null;

        const msg = this._buildMessage(sent.key ? sent : { key: { remoteJid: jid, fromMe: true, id: '' }, message: null });
        this._cacheMessage(msg);
        return msg;
    }
}

module.exports = {
    BaileysClient,
    MessageMedia,
    __test: {
        ackFromStatus,
        reconnectDelay,
        longToNumber,
        stripDevice,
        toBaileysJid,
        _setBaileysForTest: loader => {
            baileysPromise = null;
            baileysLoader = loader || (() => import('@whiskeysockets/baileys'));
        }
    }
};
