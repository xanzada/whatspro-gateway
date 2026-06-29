const axios = require('axios');
const { redisClient } = require('../config/redis');
const { normalizePhoneFromCandidates } = require('./phoneUtils');

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

function inboxKey(instanceId) {
  return `chatwoot:inbox:${instanceId}`;
}

function buildHistoryEntry(payload, instanceId, phone, timestamp) {
  const body = String(payload.body || payload.text || payload.data?.message?.conversation || '').trim();
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
    pushName: payload.pushName || payload.data?.pushName || '',
    createdAt: timestamp,
    source: payload.source || 'whatspro'
  };
}

async function saveIncomingMessage(payload) {
  const instanceId = normalizeInstanceId(payload.instanceId || payload.instance);
  const phone = getPayloadPhone(payload);
  if (!instanceId || !phone) return { skipped: true, reason: 'missing_instance_or_phone' };
  if (!redisClient.isOpen) return { skipped: true, reason: 'redis_not_connected' };

  const timestamp = Date.now();
  const entry = buildHistoryEntry(payload, instanceId, phone, timestamp);

  await Promise.all([
    redisClient.sendCommand(['RPUSH', historyKey(instanceId, phone), JSON.stringify(entry)]),
    redisClient.sendCommand(['ZADD', inboxKey(instanceId), String(timestamp), phone])
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
  const [redisResult, openBotResult] = await Promise.allSettled([
    saveIncomingMessage(payload),
    forwardToOpenBot(payload)
  ]);

  if (redisResult.status === 'rejected') {
    console.error(`[INBOX REDIS] failed elapsed=${Date.now() - started}ms error=${redisResult.reason?.message || redisResult.reason}`);
  }

  if (openBotResult.status === 'rejected') {
    console.error(`[OPENBOT WEBHOOK] failed elapsed=${Date.now() - started}ms status=${openBotResult.reason?.response?.status || '-'} error=${openBotResult.reason?.message || openBotResult.reason}`);
    throw openBotResult.reason;
  }

  return {
    redis: redisResult.status === 'fulfilled' ? redisResult.value : { success: false },
    openbot: openBotResult.value
  };
}

module.exports = { forwardIncomingWhatsAppMessage, getOpenBotWebhookUrl, getOpenBotWebhookToken, saveIncomingMessage };
