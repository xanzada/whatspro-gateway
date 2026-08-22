const axios = require('axios');
const { redisClient } = require('../config/redis');
const { isValidChatPhone, normalizePhoneFromCandidates } = require('./phoneUtils');
const { chatStore } = require('./chatStore');
const { publishChatEvent } = require('./chatEvents');
const { isPhoneAllowed } = require('./testModePolicy');
const {
  enqueueIncoming,
  listIncoming,
  updateIncoming
} = require('./incomingWal');

const activeWalRecords = new Set();
let drainTimer = null;

function stripUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined));
}

function getOpenBotWebhookUrl() {
  const raw = String(process.env.OPENBOT_WEBHOOK_URL || '').trim();
  if (!raw) return '';

  const unquoted = raw.replace(/^['"]|['"]$/g, '').trim();
  return unquoted.split(/[\r\n,]+/).map(item => item.trim()).filter(Boolean)[0] || '';
}

function getOpenBotWebhookToken() {
  return String(process.env.OPENBOT_WEBHOOK_TOKEN || '').trim().replace(/^['"]|['"]$/g, '').trim();
}

function normalizeInstanceId(value = '') {
  const instanceId = String(value || '').trim();
  return /^[a-zA-Z0-9_-]{2,64}$/.test(instanceId) ? instanceId : '';
}

function isGroupOrStatusPayload(payload = {}) {
  const values = [
    payload.sender,
    payload.from,
    payload.phone,
    payload.data?.key?.remoteJid,
    payload.data?.from,
    payload.data?.chatId
  ].map(value => String(value || '').toLowerCase());

  return values.some(value => value.includes('@g.us') || value.includes('status@broadcast') || value.includes('@broadcast'));
}

const PROTOCOL_NOISE_TYPES = new Set([
  'system',
  'notification',
  'notification_template',
  'e2e_notification',
  'protocol',
  'protocol_message',
  'app_state_sync',
  'history_sync'
]);

/**
 * Phantom-contact filter.
 *
 * WhatsApp emits protocol events (encryption notices, template notices, app
 * state syncs) for numbers that never sent a single real message. They used
 * to be appended to the chat store exactly like customer texts, so the
 * operator inbox filled with "new" contacts nobody ever wrote to. Only real
 * conversational content - text or supported media - may create a chat.
 */
function isNonConversationalPayload(payload = {}) {
  const type = String(payload.type || payload.mediaKind || '').trim().toLowerCase();
  if (PROTOCOL_NOISE_TYPES.has(type)) return true;
  if (payload.fromMe === true || payload.data?.key?.fromMe === true) return false;
  const body = String(payload.body || payload.text || payload.data?.message?.conversation || '').trim();
  if (body) return false;
  if (Boolean(payload.hasMedia)) return false;
  // No type at all means the event had no message content worth showing.
  return !type || type === 'chat' || type === 'message';
}

function getPayloadPhone(payload = {}) {
  return normalizePhoneFromCandidates([
    payload.normalizedPhone,
    payload.senderPhone,
    payload.phone,
    payload.sender,
    payload.data?.normalizedPhone,
    payload.data?.senderPhone,
    payload.data?.key?.remoteJid
  ]);
}

function operatorActiveKey(instanceId, phone) {
  return `operator_active:${instanceId}:${phone}`;
}

function muteKey(instanceId, phone) {
  return `mute:${instanceId}:${phone}`;
}

/**
 * A paused bot must actually stay quiet.
 *
 * `bot_enabled: false` is how an operator takes a restaurant off auto-reply
 * without unlinking its WhatsApp session, and it was honoured everywhere except
 * here -- the message was still POSTed to OpenBot, which answered it. The check
 * lives on the forward only: the chat store still records everything, so the
 * operator inbox keeps working while the bot sleeps.
 *
 * A row that predates the field, or one this gateway cannot read, is treated as
 * enabled. Failing closed here would silence every tenant on a Redis blip.
 */
async function isBotEnabled(instanceId, dependencies = {}) {
  const findRow = dependencies.findRow || require('./tenantStore').findRow;
  const row = await findRow(instanceId).catch(() => null);
  if (!row) return true;
  const value = row.bot_enabled ?? row.botEnabled;
  if (value === undefined || value === null || value === '') return true;
  return !['0', 'false', 'no', 'off'].includes(String(value).trim().toLowerCase());
}

async function shouldSkipOpenBot(payload = {}, dependencies = {}) {
  const instanceId = normalizeInstanceId(payload.instanceId || payload.instance);
  const phone = getPayloadPhone(payload);
  if (!instanceId || !isValidChatPhone(phone)) return false;
  if (!(await (dependencies.isPhoneAllowed || isPhoneAllowed)(instanceId, phone))) return true;
  if (!(await isBotEnabled(instanceId, dependencies))) return true;
  if (!redisClient.isOpen) return false;

  const [operatorTtl, muteTtl] = await Promise.all([
    redisClient.sendCommand(['TTL', operatorActiveKey(instanceId, phone)]).catch(() => -2),
    redisClient.sendCommand(['TTL', muteKey(instanceId, phone)]).catch(() => -2)
  ]);

  return Number(operatorTtl) > 0 || Number(muteTtl) > 0;
}

function buildHistoryEntry(payload, instanceId, phone, timestamp) {
  const body = String(payload.body || payload.text || payload.data?.message?.conversation || '').trim();
  const rawMediaData = String(payload.mediaData || payload.data?.mediaData || '').trim();
  const rawMediaType = String(payload.mediaType || payload.data?.mediaType || '').split(';')[0].trim().toLowerCase();
  const type = String(payload.type || '').trim().toLowerCase();
  const isSystem = ['system', 'notification', 'notification_template', 'e2e_notification', 'protocol'].includes(type);
  const hasAudio = !isSystem && Boolean(payload.hasMedia) && rawMediaType.startsWith('audio/');
  const hasImage = !isSystem && Boolean(payload.hasMedia) && (rawMediaType.startsWith('image/') || type === 'image');
  // A document with no declared mime is the Kaspi receipt case; whatsappManager
  // has already settled it on the %PDF- signature before this entry is built.
  const hasDocument = !isSystem && Boolean(payload.hasMedia) && (rawMediaType === 'application/pdf' || (type === 'document' && !rawMediaType));
  const hasSupportedMedia = hasAudio || hasImage || hasDocument;
  const mediaData = hasSupportedMedia ? rawMediaData : '';
  const mediaType = hasImage && !rawMediaType
    ? 'image/jpeg'
    : hasDocument && !rawMediaType
      ? 'application/pdf'
      : hasSupportedMedia ? rawMediaType : '';
  const mediaKind = String(payload.mediaKind || payload.type || '').trim();
  const contactName = String(payload.contactName || payload.data?.contactName || payload.contact?.name || payload.data?.contact?.name || '').trim();
  return {
    id: String(payload.messageId || payload.data?.key?.id || `${timestamp}:${phone}`),
    instanceId,
    phone,
    direction: payload.fromMe === true || payload.data?.key?.fromMe === true ? 'outgoing' : 'incoming',
    fromMe: payload.fromMe === true || payload.data?.key?.fromMe === true,
    body,
    text: body,
    type: payload.type || 'chat',
    hasMedia: hasSupportedMedia,
    mediaData,
    mediaType,
    mediaKind,
    pushName: payload.pushName || payload.data?.pushName || '',
    contactName,
    createdAt: timestamp,
    source: payload.source || 'whatspro'
  };
}

async function saveIncomingMessage(payload, dependencies = {}) {
  const store = dependencies.store || chatStore;
  const publishEvent = dependencies.publishEvent || publishChatEvent;
  const instanceId = normalizeInstanceId(payload.instanceId || payload.instance);
  const rawPhone = getPayloadPhone(payload);
  // A linked-device LID must resolve to the real phone before anything is
  // stored: a chat filed under the LID is a ghost whose history never loads in
  // the panel (live bug, 2026-08-21). The mapping is persisted by the
  // transport's resolver, so this stays fast and offline-safe.
  const resolveLid = dependencies.resolveLidPhone
    || ((id, value) => (typeof chatStore.resolveLidPhone === 'function' ? chatStore.resolveLidPhone(id, value) : Promise.resolve('')));
  const phone = rawPhone && /@lid$/i.test(rawPhone)
    ? (await resolveLid(instanceId, rawPhone).catch(() => '')) || rawPhone
    : rawPhone;
  if (!instanceId || isGroupOrStatusPayload(payload) || !isValidChatPhone(phone)) return { skipped: true, reason: 'missing_instance_or_phone' };
  if (isNonConversationalPayload(payload)) return { skipped: true, reason: 'non_conversational' };
  const allowed = await (dependencies.isPhoneAllowed || isPhoneAllowed)(instanceId, phone);
  if (!allowed) return { skipped: true, reason: 'test_mode_blocked', instanceId, phone };
  const redisOpen = dependencies.redisOpen ??
    (redisClient.isReady === undefined ? redisClient.isOpen : redisClient.isReady);
  if (!redisOpen) return { skipped: true, reason: 'redis_not_connected' };

  const rawTimestamp = Number(payload.timestamp || payload.messageTimestamp || payload.data?.messageTimestamp || 0);
  const timestamp = rawTimestamp > 0 ? (rawTimestamp < 1e12 ? rawTimestamp * 1000 : rawTimestamp) : Date.now();
  const entry = buildHistoryEntry(payload, instanceId, phone, timestamp);

  // A chat the operator has taken over (or an archived one) must not jump back
  // to "new" on every client reply: the client answering the operator IS the
  // operator conversation. The unread badge still comes from the unread flag;
  // the column stays where the operator put it (live complaint, 2026-08-20).
  const currentState = entry.direction === 'incoming' && typeof store.getState === 'function'
    ? await store.getState(instanceId, phone).catch(() => '')
    : '';
  const state = entry.direction === 'incoming'
    ? (currentState === 'operator' || currentState === 'archive' ? undefined : 'new')
    : undefined;
  const stored = await store.appendMessageOnce(instanceId, phone, entry, { state, preserveStateOnDuplicate: true });
  if (stored.stale || !stored.inserted) return { skipped: true, reason: stored.stale ? 'stale_message' : 'duplicate_message', instanceId, phone, timestamp };
  await publishEvent({ type: 'chat.message', instanceId, phone, messageId: entry.id, state }).catch(() => {});

  return { saved: true, instanceId, phone, timestamp };
}

async function forwardToOpenBot(payload) {
  const url = getOpenBotWebhookUrl();
  if (!url) {
    console.warn('[OPENBOT WEBHOOK] skipped: OPENBOT_WEBHOOK_URL is not configured');
    return { skipped: true, reason: 'OPENBOT_WEBHOOK_URL_missing' };
  }

  const started = Date.now();
  const token = getOpenBotWebhookToken();

  const response = await axios.post(url, payload, {
    timeout: Number(process.env.OPENBOT_WEBHOOK_TIMEOUT_MS || 8000),
    headers: stripUndefined({
      authorization: token ? `Bearer ${token}` : undefined,
      'x-api-key': token || undefined,
      'content-type': 'application/json'
    })
  });

  console.log(`[OPENBOT WEBHOOK] delivered status=${response.status} elapsed=${Date.now() - started}ms instance=${payload.instanceId || payload.instance || '-'} messageId=${payload.messageId || '-'}`);
  return { delivered: true, status: response.status };
}

async function forwardIncomingWhatsAppMessage(payload) {
  let record;
  try {
    // Disk intent is written before either dependency is called. A container
    // restart therefore cannot lose the customer's message between WhatsApp,
    // Chat Redis and OpenBot.
    record = await enqueueIncoming(payload);
    if (!record) {
      // The WAL already completed this exact message; a re-delivery must not be
      // forwarded to Openbot a second time (2026-08-22).
      return {
        redis: { status: 'skipped', reason: 'already_delivered' },
        openbot: { status: 'skipped', reason: 'already_delivered' },
        durable: true
      };
    }
  } catch (error) {
    console.error('[INBOUND WAL] enqueue failed:', error.message);
    record = {
      id: `volatile:${Date.now()}`,
      payload,
      pendingRedis: true,
      pendingOpenBot: true,
      attempts: 0
    };
  }

  void processIncomingRecord(record).catch(error => {
    console.error(`[INBOUND WAL] background delivery failed id=${record.id}:`, error.message);
  });

  return {
    redis: { status: 'processing_in_background' },
    openbot: { status: 'processing_in_background' },
    durable: !String(record.id).startsWith('volatile:')
  };
}

async function processIncomingRecord(record, dependencies = {}) {
  if (!record?.id || activeWalRecords.has(record.id)) return record;
  activeWalRecords.add(record.id);
  const started = Date.now();
  try {
    if (record.pendingRedis) {
      try {
        const redisResult = await (dependencies.saveIncomingMessage || saveIncomingMessage)(record.payload);
        if (redisResult?.saved || (redisResult?.skipped && redisResult.reason !== 'redis_not_connected')) {
          record.pendingRedis = false;
        } else {
          record.lastError = String(redisResult?.reason || 'redis_not_connected');
        }
      } catch (error) {
        record.lastError = `redis:${error.message}`;
        console.error(`[INBOX REDIS] failed elapsed=${Date.now() - started}ms error=${error.message}`);
      }
    }

    if (record.pendingOpenBot) {
      try {
        const skip = isNonConversationalPayload(record.payload) ||
          await (dependencies.shouldSkipOpenBot || shouldSkipOpenBot)(record.payload);
        if (skip) {
          record.pendingOpenBot = false;
        } else {
          const result = await (dependencies.forwardToOpenBot || forwardToOpenBot)(record.payload);
          if (result?.delivered) record.pendingOpenBot = false;
          else record.lastError = String(result?.reason || 'openbot_not_delivered');
        }
      } catch (error) {
        record.lastError = `openbot:${error.message}`;
        console.error(`[OPENBOT WEBHOOK BACKGROUND] failed elapsed=${Date.now() - started}ms error=${error.message}`);
      }
    }

    record.attempts = Number(record.attempts || 0) + 1;
    record.nextAttemptAt = Date.now() + Math.min(60_000, 1000 * (2 ** Math.min(record.attempts, 6)));
    if (!String(record.id).startsWith('volatile:')) await updateIncoming(record);
    return record;
  } finally {
    activeWalRecords.delete(record.id);
  }
}

async function drainIncomingWal(limit = 25) {
  const records = await listIncoming(limit);
  for (const record of records) await processIncomingRecord(record);
  return records.length;
}

function startIncomingWalWorker() {
  if (drainTimer) return drainTimer;
  void drainIncomingWal().catch(error => console.warn('[INBOUND WAL] initial drain failed:', error.message));
  drainTimer = setInterval(() => {
    void drainIncomingWal().catch(error => console.warn('[INBOUND WAL] drain failed:', error.message));
  }, Math.max(1000, Number(process.env.WHATSPRO_INBOUND_WAL_INTERVAL_MS || 5000)));
  drainTimer.unref?.();
  return drainTimer;
}

module.exports = {
  drainIncomingWal,
  forwardIncomingWhatsAppMessage,
  getOpenBotWebhookUrl,
  getOpenBotWebhookToken,
  processIncomingRecord,
  saveIncomingMessage,
  startIncomingWalWorker,
  __test: { buildHistoryEntry, isBotEnabled, isNonConversationalPayload, saveIncomingMessage, shouldSkipOpenBot }
};
