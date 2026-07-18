const axios = require('axios');
const { redisClient } = require('../config/redis');
const { normalizePhoneFromCandidates } = require('./phoneUtils');

const CHAT_STANDARD_TTL_SECONDS = 24 * 60 * 60;
const CHAT_ARCHIVE_TTL_SECONDS = 72 * 60 * 60;

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

function isValidChatPhone(phone) {
  return /^\d{10,15}$/.test(String(phone || ''));
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

function historyKey(instanceId, phone) {
  return `chatwoot:history:${instanceId}:${phone}`;
}

function openbotHistoryKey(instanceId, phone) {
  return `history:${instanceId}:${phone}`;
}

function inboxKey(instanceId) {
  return `chatwoot:inbox:${instanceId}`;
}

function archiveKey(instanceId) {
  return `chatwoot:archive:${instanceId}`;
}

function operatorActiveKey(instanceId, phone) {
  return `operator_active:${instanceId}:${phone}`;
}

function muteKey(instanceId, phone) {
  return `mute:${instanceId}:${phone}`;
}

async function shouldSkipOpenBot(payload = {}) {
  if (!redisClient.isOpen) return false;

  const instanceId = normalizeInstanceId(payload.instanceId || payload.instance);
  const phone = getPayloadPhone(payload);
  if (!instanceId || !isValidChatPhone(phone)) return false;

  const [operatorTtl, muteTtl] = await Promise.all([
    redisClient.sendCommand(['TTL', operatorActiveKey(instanceId, phone)]).catch(() => -2),
    redisClient.sendCommand(['TTL', muteKey(instanceId, phone)]).catch(() => -2)
  ]);

  return Number(operatorTtl) > 0 || Number(muteTtl) > 0;
}

function buildHistoryEntry(payload, instanceId, phone, timestamp) {
  const body = String(payload.body || payload.text || payload.data?.message?.conversation || '').trim();
  const mediaData = String(payload.mediaData || payload.data?.mediaData || '').trim();
  const mediaType = String(payload.mediaType || payload.data?.mediaType || '').trim();
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
    hasMedia: Boolean(payload.hasMedia),
    mediaData,
    mediaType,
    mediaKind,
    pushName: payload.pushName || payload.data?.pushName || '',
    contactName,
    createdAt: timestamp,
    source: payload.source || 'whatspro'
  };
}

async function saveIncomingMessage(payload) {
  const instanceId = normalizeInstanceId(payload.instanceId || payload.instance);
  const phone = getPayloadPhone(payload);
  if (!instanceId || isGroupOrStatusPayload(payload) || !isValidChatPhone(phone)) return { skipped: true, reason: 'missing_instance_or_phone' };
  if (!redisClient.isOpen) return { skipped: true, reason: 'redis_not_connected' };

  const timestamp = Date.now();
  const entry = buildHistoryEntry(payload, instanceId, phone, timestamp);

  await Promise.all([
    redisClient.sendCommand(['RPUSH', historyKey(instanceId, phone), JSON.stringify(entry)]),
    redisClient.sendCommand(['ZADD', inboxKey(instanceId), String(timestamp), phone])
  ]);
  const archived = await redisClient.sendCommand(['SISMEMBER', archiveKey(instanceId), phone]).catch(() => 0);
  const ttlSeconds = Number(archived) === 1 ? CHAT_ARCHIVE_TTL_SECONDS : CHAT_STANDARD_TTL_SECONDS;
  await Promise.all([
    redisClient.sendCommand(['EXPIRE', historyKey(instanceId, phone), String(ttlSeconds)]),
    redisClient.sendCommand(['EXPIRE', openbotHistoryKey(instanceId, phone), String(ttlSeconds)]).catch(() => 0)
  ]);

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
  const started = Date.now();
  const skipOpenBot = await shouldSkipOpenBot(payload);
  
  // Redis-ке жазу өте жылдам, оны күтуге болады
  const redisResult = await saveIncomingMessage(payload).catch(err => {
      console.error(`[INBOX REDIS] failed elapsed=${Date.now() - started}ms error=${err.message}`);
      return { success: false, error: err };
  });
  
  if (redisResult.skipped) {
      return { redis: redisResult, openbot: { skipped: true, reason: redisResult.reason } };
  }

  // Webhook-ты фондық режимде (background) жібереміз, Node.js процесін тоқтатпаймыз
  if (!skipOpenBot) {
      forwardToOpenBot(payload).catch(err => {
          console.error(`[OPENBOT WEBHOOK BACKGROUND] failed elapsed=${Date.now() - started}ms error=${err.message}`);
      });
  }

  return {
    redis: redisResult,
    openbot: { status: 'processing_in_background' }
  };
}

module.exports = { forwardIncomingWhatsAppMessage, getOpenBotWebhookUrl, getOpenBotWebhookToken, saveIncomingMessage };
