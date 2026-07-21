require('dotenv').config();

const crypto = require('crypto');
const express = require('express');
const fs = require('fs/promises');
const path = require('path');
const { connectRedis, redisClient } = require('../config/redis');
const {
  startWhatsAppInstance,
  stopWhatsAppInstance,
  getInstanceStatus,
  sendWhatsAppText,
  sendMedia,
  sendPresence,
  getBase64Media,
  shutdownWhatsAppClients
} = require('../services/whatsappManager');
const { normalizePhone } = require('../services/phoneUtils');
const { OPERATOR_ACTIVE_SECONDS, operatorActiveKey } = require('../services/operatorLock');
const { chatStore, MAX_MEDIA_BYTES } = require('../services/chatStore');
const { publishChatEvent, subscribeChatEvents } = require('../services/chatEvents');
const { createChatMediaHandler } = require('../services/chatMedia');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const INSTANCE_STORE_KEY = 'whatspro:instances';
const SCAN_REQUESTS_KEY = 'whatspro:scan-requests';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const CHAT_HTML_PATH = path.join(PUBLIC_DIR, 'chat.html');
const CHAT_STANDARD_TTL_SECONDS = 24 * 60 * 60;
const CHAT_ARCHIVE_TTL_SECONDS = 72 * 60 * 60;
const SESSION_SECRET = process.env.WHATSPRO_SESSION_SECRET || process.env.WHATSPRO_API_TOKEN || crypto.randomBytes(32).toString('hex');
const SSE_MAX_CONNECTIONS_PER_CLIENT = 20;
const SSE_MAX_CONNECTIONS_TOTAL = 500;
const SSE_MAX_LIFETIME_MS = 60 * 60 * 1000;
const sseConnections = new Map();
let sseConnectionTotal = 0;
const loginAttempts = new Map();
const operatorEffectJobs = new Map();
const sendCompletionJobs = new Map();
const liveSendWalPaths = new Set();
let walRecoveryComplete = false;
const SEND_LEASE_TTL_SECONDS = 24 * 60 * 60;
const SEND_RESULT_TTL_SECONDS = 24 * 60 * 60;
const OPERATOR_EFFECT_OUTBOX_KEY = 'chatwoot:operator-effects-outbox';
const SEND_WAL_DIR = path.resolve(process.env.WHATSPRO_SEND_WAL_DIR || path.join(process.cwd(), '.whatspro-send-wal'));

function isValidSendRequestId(value) {
  return /^[A-Za-z0-9_-]{8,128}$/.test(String(value || ''));
}

function createSendIdempotency(redis, options = {}) {
  const now = options.now || Date.now;
  const local = new Map();

  function pruneLocal() {
    const timestamp = now();
    for (const [key, item] of local) if (item.expiresAt <= timestamp) local.delete(key);
  }

  function keyFor(instanceId, phone, requestId) {
    return `chatwoot:send-idempotency:${instanceId}:${phone}:${requestId}`;
  }

  async function begin(instanceId, phone, requestId, payloadHash = '') {
    if (!isValidSendRequestId(requestId)) throw new Error('INVALID_REQUEST_ID');
    pruneLocal();
    const key = keyFor(instanceId, phone, requestId);
    const localExisting = local.get(key);
    if (localExisting && localExisting.payloadHash !== payloadHash) return { acquired: false, conflict: true };
    if (localExisting?.response) return { acquired: false, response: localExisting.response, effectData: localExisting.effectData };
    if (localExisting) return { acquired: false, inProgress: true };
    const token = `pending:${crypto.randomBytes(16).toString('hex')}`;
    const pendingValue = `${token}:${payloadHash}`;
    if (redis.isOpen) {
      try {
        const acquired = await redis.sendCommand(['SET', key, pendingValue, 'NX', 'EX', String(SEND_LEASE_TTL_SECONDS)]);
        if (acquired === 'OK') {
          local.set(key, { token, payloadHash, expiresAt: now() + SEND_LEASE_TTL_SECONDS * 1000 });
          return { acquired: true, backend: 'redis', key, token, pendingValue, payloadHash };
        }
        const existing = String(await redis.sendCommand(['GET', key]) || '');
        if (existing.startsWith('done:')) {
          try {
            const completed = JSON.parse(existing.slice(5));
            if (completed.payloadHash !== payloadHash) return { acquired: false, conflict: true };
            return { acquired: false, response: completed.response, effectKey: completed.effectKey || '' };
          } catch { /* treat malformed value as busy */ }
        }
        if (!existing.endsWith(`:${payloadHash}`)) return { acquired: false, conflict: true };
        return { acquired: false, inProgress: true };
      } catch { /* Redis outage falls through to the process-local guard. */ }
    }
    local.set(key, { token, payloadHash, expiresAt: now() + SEND_LEASE_TTL_SECONDS * 1000 });
    return { acquired: true, backend: 'local', key, token, pendingValue, payloadHash };
  }

  async function complete(lease, response, effectData = null) {
    const current = local.get(lease.key);
    if (current && current.token !== lease.token) return false;
    const expiresAt = now() + SEND_RESULT_TTL_SECONDS * 1000;
    local.set(lease.key, { token: lease.token, payloadHash: lease.payloadHash, response, effectData, expiresAt });
    if (lease.backend === 'redis' && !redis.isOpen) {
      const latest = local.get(lease.key);
      if (latest?.token === lease.token) local.delete(lease.key);
      return false;
    }
    if (lease.backend === 'redis') {
      const effectKey = effectData?.effectKey || '';
      const completed = `done:${JSON.stringify({ payloadHash: lease.payloadHash, response, effectKey })}`;
      const script = effectKey
        ? "if redis.call('GET', KEYS[1]) == ARGV[1] then redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3]); redis.call('SET', KEYS[2], ARGV[4], 'EX', ARGV[3]); redis.call('ZADD', KEYS[3], ARGV[5], KEYS[2]); return 1 end return 0"
        : "if redis.call('GET', KEYS[1]) == ARGV[1] then redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3]); return 1 end return 0";
      const commandArgs = effectKey
        ? ['EVAL', script, '3', lease.key, effectKey, OPERATOR_EFFECT_OUTBOX_KEY, lease.pendingValue, completed, String(SEND_RESULT_TTL_SECONDS), JSON.stringify(effectData.payload), String(now())]
        : ['EVAL', script, '1', lease.key, lease.pendingValue, completed, String(SEND_RESULT_TTL_SECONDS)];
      const changed = await redis.sendCommand(commandArgs).catch(() => 0);
      if (Number(changed) !== 1) {
        const latest = local.get(lease.key);
        if (latest?.token === lease.token) local.delete(lease.key);
        return false;
      }
    }
    return true;
  }

  async function renew(lease) {
    const current = local.get(lease.key);
    if (!current || current.token !== lease.token || current.response) return false;
    current.expiresAt = now() + SEND_LEASE_TTL_SECONDS * 1000;
    if (lease.backend !== 'redis' || !redis.isOpen) return true;
    const script = "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('EXPIRE', KEYS[1], ARGV[2]) end return 0";
    return Number(await redis.sendCommand(['EVAL', script, '1', lease.key, lease.pendingValue, String(SEND_LEASE_TTL_SECONDS)]).catch(() => 0)) === 1;
  }

  async function release(lease) {
    if (!lease?.acquired) return;
    const existing = local.get(lease.key);
    if (existing?.token === lease.token) local.delete(lease.key);
    if (lease.backend === 'redis' && redis.isOpen) {
      const script = "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0";
      await redis.sendCommand(['EVAL', script, '1', lease.key, lease.pendingValue]).catch(() => {});
    }
  }

  return { begin, complete, release, renew };
}

const sendIdempotency = createSendIdempotency(redisClient);

function sendWalPath(leaseKey) {
  return path.join(SEND_WAL_DIR, `${crypto.createHash('sha256').update(String(leaseKey)).digest('hex')}.json`);
}

async function writeSendWal(record) {
  await fs.mkdir(SEND_WAL_DIR, { recursive: true, mode: 0o700 });
  const target = sendWalPath(record.lease.key);
  const temporary = `${target}.${process.pid}.tmp`;
  const handle = await fs.open(temporary, 'w', 0o600);
  try {
    await handle.writeFile(JSON.stringify(record), 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temporary, target);
  let directory;
  try {
    directory = await fs.open(SEND_WAL_DIR, 'r');
    await directory.sync();
  } catch (error) {
    const unsupportedOnWindows = process.platform === 'win32' && ['EINVAL', 'ENOTSUP', 'EISDIR', 'EPERM'].includes(error.code);
    if (!unsupportedOnWindows) throw error;
  } finally {
    if (directory) await directory.close();
  }
  return target;
}

async function removeSendWal(walPath) {
  if (walPath) await fs.unlink(walPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
}

const configuredProxyHops = String(process.env.TRUST_PROXY_HOPS || '').trim();
app.set('trust proxy', /^\d+$/.test(configuredProxyHops) ? Number(configuredProxyHops) : false);
const smallJsonParser = express.json({ limit: '256kb' });
const smallFormParser = express.urlencoded({ extended: true, limit: '64kb' });
const apiSendJsonParser = express.json({ limit: '23mb' });
app.use((req, res, next) => req.path === '/api/send' ? next() : smallJsonParser(req, res, next));
app.use((req, res, next) => req.path === '/api/send' ? next() : smallFormParser(req, res, next));

function safeEqual(a = '', b = '') {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function parseCookies(req) {
  return Object.fromEntries(String(req.headers.cookie || '')
    .split(';')
    .map(part => part.trim())
    .filter(Boolean)
    .map(part => {
      const index = part.indexOf('=');
      return [decodeURIComponent(part.slice(0, index)), decodeURIComponent(part.slice(index + 1))];
    }));
}

function signSession(username) {
  const payload = `${username}:${Date.now()}`;
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
  return Buffer.from(`${payload}:${sig}`).toString('base64url');
}

function readSession(req) {
  try {
    const raw = parseCookies(req).whatspro_session;
    if (!raw) return null;
    const decoded = Buffer.from(raw, 'base64url').toString('utf8');
    const parts = decoded.split(':');
    const sig = parts.pop();
    const payload = parts.join(':');
    const expected = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
    if (!safeEqual(sig, expected)) return null;
    const [username, ts] = parts;
    if (Date.now() - Number(ts || 0) > 30 * 86400 * 1000) return null;
    return { username };
  } catch {
    return null;
  }
}

function hasApiToken(req) {
  const expected = process.env.WHATSPRO_API_TOKEN || '';
  const incoming = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '')
    || String(req.headers['x-api-key'] || '');
  return expected && safeEqual(incoming, expected);
}

function hasChatMediaToken(req) {
  const expected = process.env.WHATSPRO_API_TOKEN || '';
  const incoming = String(req.headers['x-chat-token'] || '') || String(req.query?.token || '');
  return Boolean(expected && incoming && safeEqual(incoming, expected));
}

function requireApi(req, res, next) {
  if (hasApiToken(req)) return next();
  return res.status(401).json({ error: 'AUTH_REQUIRED' });
}

function requireUiOrApi(req, res, next) {
  if (hasApiToken(req) || readSession(req)) return next();
  return res.status(401).json({ error: 'AUTH_REQUIRED' });
}

function requireChatMediaAuth(req, res, next) {
  if (hasApiToken(req) || hasChatMediaToken(req) || readSession(req)) return next();
  return res.status(401).json({ error: 'AUTH_REQUIRED' });
}

function isValidInstanceId(value = '') {
  return /^[a-zA-Z0-9_-]{2,64}$/.test(String(value));
}

function safeJsonForScript(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function publicApiBase(req) {
  const configured = String(process.env.CHAT_PUBLIC_API_BASE || '').trim().replace(/\/+$/, '');
  if (configured) return configured;
  return `${req.protocol}://${req.get('host')}`;
}

async function renderChatHtml(req, res) {
  const instance = String(req.query.instance || '').trim();
  if (instance && !isValidInstanceId(instance)) return res.status(400).json({ error: 'BAD_INSTANCE_ID' });
  const config = {
    instance,
    apiBase: publicApiBase(req),
    endpoints: {
      inbox: '/api/chat/inbox',
      history: '/api/chat/history',
      send: '/api/chat/send',
      media: '/api/chat/media',
      action: '/api/chat/action',
      lock: '/api/chat/operator-lock',
      events: '/api/chat/events'
    }
  };
  const html = await fs.readFile(CHAT_HTML_PATH, 'utf8');
  const script = `<script>window.__CHAT_CONFIG__=${safeJsonForScript(config)};</script>`;
  res.set('Cache-Control', 'no-store, max-age=0');
  const renderedHtml = html.includes('<!--__CHAT_CONFIG__-->')
  ? html.replace('<!--__CHAT_CONFIG__-->', script)
  : html.replace('</head>', `${script}</head>`);

res.type('html').send(renderedHtml);
}

async function saveInstance(instanceId, label = '') {
  if (redisClient.isOpen) {
    await redisClient.hSet(INSTANCE_STORE_KEY, instanceId, JSON.stringify({ instanceId, label: label || instanceId, savedAt: Date.now() }));
  }
}

async function listInstances() {
  if (!redisClient.isOpen) return [];
  const rows = await redisClient.hGetAll(INSTANCE_STORE_KEY);
  return Promise.all(Object.values(rows).map(async raw => {
    const item = JSON.parse(raw);
    return { ...item, ...(await getInstanceStatus(item.instanceId)) };
  }));
}

async function listScanRequests() {
  if (!redisClient.isOpen) return [];
  const rows = await redisClient.hGetAll(SCAN_REQUESTS_KEY);
  return Object.values(rows).map(raw => JSON.parse(raw));
}

async function getScanRequest(requestId) {
  if (!redisClient.isOpen) return null;
  const raw = await redisClient.hGet(SCAN_REQUESTS_KEY, requestId);
  return raw ? JSON.parse(raw) : null;
}

async function saveScanRequest(requestId, data) {
  if (!redisClient.isOpen) return;
  await redisClient.hSet(SCAN_REQUESTS_KEY, requestId, JSON.stringify({ ...data, id: requestId, createdAt: Date.now() }));
}

async function updateScanRequest(requestId, data) {
  if (!redisClient.isOpen) return;
  const existing = await getScanRequest(requestId);
  if (!existing) return;
  await redisClient.hSet(SCAN_REQUESTS_KEY, requestId, JSON.stringify({ ...existing, ...data }));
}

async function deleteScanRequest(requestId) {
  if (!redisClient.isOpen) return;
  await redisClient.hDel(SCAN_REQUESTS_KEY, requestId);
}

function chatHistoryKey(instanceId, phone) {
  return `chatwoot:history:${instanceId}:${phone}`;
}

function chatInboxKey(instanceId) {
  return `chatwoot:inbox:${instanceId}`;
}

function chatArchiveKey(instanceId) {
  return `chatwoot:archive:${instanceId}`;
}

function chatArchiveMarkerKey(instanceId, phone) {
  return `chatwoot:archive:${instanceId}:${phone}`;
}

function chatViewedKey(instanceId) {
  return `chatwoot:viewed:${instanceId}`;
}

function chatMediaKey(instanceId, messageId) {
  return `chatwoot:media:${instanceId}:${messageId}`;
}

function openbotHistoryKey(instanceId, phone) {
  return `history:${instanceId}:${phone}`;
}

function parseLimit(value, fallback = 100, max = 500) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(Math.floor(parsed), max);
}

function parseHistoryEntry(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function getEntryCreatedAt(entry) {
  return Number(entry?.createdAt || entry?.timestamp || entry?.time || 0) || 0;
}

function isOperatorEntry(entry) {
  const source = String(entry?.source || '').toLowerCase();
  return source === 'operator_panel';
}

function isBotEntry(entry) {
  const role = String(entry?.role || '').toLowerCase();
  return role === 'assistant' || role === 'model' || role === 'bot';
}

function isOutgoingEntry(entry) {
  const role = String(entry?.role || '').toLowerCase();
  return entry?.direction === 'outgoing' || entry?.fromMe === true || isOperatorEntry(entry) || isBotEntry(entry) || role === 'system';
}

function entryPreview(entry) {
  if (!entry) return '';
  const text = String(entry.text || entry.body || '').trim();
  if (text) return text;
  return entry.hasMedia ? '[Media file]' : '';
}

function isValidChatPhone(phone) {
  return /^\d{10,15}$/.test(String(phone || ''));
}

function normalizeChatEntry(entry) {
  const role = String(entry.role || '').toLowerCase();
  const direction = entry.direction || (entry.fromMe === true || ['assistant', 'model', 'operator'].includes(role) ? 'outgoing' : 'incoming');
  return {
    ...entry,
    direction,
    fromMe: entry.fromMe === true || direction === 'outgoing',
    text: entry.text || entry.body || '',
    body: entry.body || entry.text || '',
    createdAt: Number(entry.createdAt || entry.timestamp || Date.now())
  };
}

async function expireChatKeys(instanceId, phone, ttlSeconds) {
  await Promise.all([
    redisClient.sendCommand(['EXPIRE', chatHistoryKey(instanceId, phone), String(ttlSeconds)]),
    redisClient.sendCommand(['EXPIRE', openbotHistoryKey(instanceId, phone), String(ttlSeconds)]).catch(() => 0)
  ]);
}

async function chatTtlSeconds(instanceId, phone) {
  const archived = await redisClient.sendCommand(['SISMEMBER', chatArchiveKey(instanceId), phone]).catch(() => 0);
  return Number(archived) === 1 ? CHAT_ARCHIVE_TTL_SECONDS : CHAT_STANDARD_TTL_SECONDS;
}

async function saveChatHistoryEntry(instanceId, phone, entry) {
  if (!redisClient.isOpen || !isValidChatPhone(phone)) return;
  const state = isOperatorEntry(entry) ? 'operator' : undefined;
  return chatStore.appendMessage(instanceId, phone, entry, { state });
}

function parseInboxListEntry(raw) {
  const value = String(raw || '').trim();
  if (!value) return null;

  const parsed = parseHistoryEntry(value);
  if (parsed && typeof parsed === 'object') {
    const phone = normalizePhone(parsed.phone || parsed.senderPhone || parsed.from || '');
    if (!isValidChatPhone(phone)) return null;
    return { phone, updatedAt: getEntryCreatedAt(parsed) || Date.now() };
  }

  const [phonePart, scorePart] = value.split(/[,|]/);
  const phone = normalizePhone(phonePart);
  if (!isValidChatPhone(phone)) return null;
  return { phone, updatedAt: Number(scorePart) || 0 };
}

async function readInboxEntries(instanceId, limit) {
  return chatStore.readInbox(instanceId, limit);
}

function remainingOperatorTtl(expiresAt, now = Date.now()) {
  return Math.max(0, Math.ceil((Number(expiresAt || 0) - now) / 1000));
}

async function applyOperatorSendEffects(data) {
  if (!redisClient.isOpen) throw new Error('REDIS_NOT_CONNECTED');
  const { instanceId, phone, entry, expiresAt } = data;
  const remainingTtl = remainingOperatorTtl(expiresAt);
  const stored = await chatStore.appendMessageOnce(instanceId, phone, entry, { state: 'operator' });
  if (stored.stale) return;
  if (remainingTtl > 0) {
    const lockScript = [
      "local deletedAt = tonumber(redis.call('GET', KEYS[1]) or '0')",
      'if deletedAt >= tonumber(ARGV[1]) then return 0 end',
      "redis.call('SET', KEYS[2], 'operator_panel', 'EX', ARGV[2])",
      "redis.call('SET', KEYS[3], 'muted_by_operator_panel', 'EX', ARGV[2])",
      'return 1'
    ].join('\n');
    const locked = Number(await redisClient.sendCommand(['EVAL', lockScript, '3', `chatwoot:deleted:${instanceId}:${phone}`,
      operatorActiveKey(instanceId, phone), `mute:${instanceId}:${phone}`, String(entry.createdAt), String(remainingTtl)]));
    if (locked !== 1) return;
  }
  const events = [publishChatEvent({ type: 'chat.message', instanceId, phone, messageId: entry.id, state: 'operator' })];
  if (remainingTtl > 0) events.push(publishChatEvent({ type: 'lock.changed', instanceId, phone, ttl: remainingTtl, expiresAt }));
  await Promise.all(events);
}

async function loadOperatorEffect(effectKey) {
  if (!effectKey || !redisClient.isOpen) return null;
  const raw = await redisClient.sendCommand(['GET', effectKey]).catch(() => '');
  try { return raw ? JSON.parse(raw) : null; } catch { return null; }
}

async function clearOperatorEffect(effectKey) {
  if (!effectKey || !redisClient.isOpen) return;
  await Promise.all([
    redisClient.sendCommand(['DEL', effectKey]).catch(() => 0),
    redisClient.sendCommand(['ZREM', OPERATOR_EFFECT_OUTBOX_KEY, effectKey]).catch(() => 0)
  ]);
}

function scheduleOperatorSendEffects(data, effectKey = '') {
  const jobKey = `${data.instanceId}:${data.phone}:${data.entry.id}`;
  if (operatorEffectJobs.has(jobKey)) return operatorEffectJobs.get(jobKey);
  const retryDelays = [0, 100, 300, 1000, 3000, 5000, 10000, 20000];
  const job = (async () => {
    let lastError;
    for (const waitMs of retryDelays) {
      if (waitMs) await new Promise(resolve => setTimeout(resolve, waitMs));
      try {
        await applyOperatorSendEffects(data);
        await clearOperatorEffect(effectKey);
        return true;
      } catch (error) {
        lastError = error;
      }
    }
    console.error(`[CHAT SEND SIDE EFFECT] ${data.instanceId}/${data.phone}:`, lastError?.message || lastError);
    return false;
  })().finally(() => operatorEffectJobs.delete(jobKey));
  operatorEffectJobs.set(jobKey, job);
  return job;
}

function scheduleSendCompletion(lease, response, effectData, walPath = '') {
  if (sendCompletionJobs.has(lease.key)) return sendCompletionJobs.get(lease.key);
  const deadline = Date.now() + SEND_LEASE_TTL_SECONDS * 1000;
  const job = (async () => {
    while (Date.now() < deadline) {
      if (await sendIdempotency.complete(lease, response, effectData)) {
        await removeSendWal(walPath);
        scheduleOperatorSendEffects(effectData.payload, effectData.effectKey);
        return true;
      }
      await new Promise(resolve => {
        const timer = setTimeout(resolve, 2000);
        timer.unref?.();
      });
    }
    console.error(`[CHAT SEND] ${effectData.payload.instanceId}/${effectData.payload.phone}: durable completion deadline expired.`);
    return false;
  })().finally(() => sendCompletionJobs.delete(lease.key));
  sendCompletionJobs.set(lease.key, job);
  return job;
}

async function drainOperatorEffectOutbox() {
  if (!redisClient.isOpen) return;
  const effectKeys = await redisClient.sendCommand(['ZRANGE', OPERATOR_EFFECT_OUTBOX_KEY, '0', '99']).catch(() => []);
  for (const effectKey of effectKeys) {
    const data = await loadOperatorEffect(effectKey);
    if (!data) await clearOperatorEffect(effectKey);
    else scheduleOperatorSendEffects(data, effectKey);
  }
}

async function recoverSendWal() {
  if (!redisClient.isOpen) return;
  const files = await fs.readdir(SEND_WAL_DIR).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error));
  let ambiguousIntent = false;
  for (const file of files.filter(name => /^[a-f0-9]{64}\.json$/.test(name))) {
    const walPath = path.join(SEND_WAL_DIR, file);
    let record;
    try { record = JSON.parse(await fs.readFile(walPath, 'utf8')); } catch { continue; }
    if (record?.phase === 'intent' && liveSendWalPaths.has(walPath)) continue;
    if (record?.phase === 'intent') {
      ambiguousIntent = true;
      continue;
    }
    if (!record?.lease?.key || !record?.response || !record?.effectData?.effectKey) continue;
    const current = String(await redisClient.sendCommand(['GET', record.lease.key]).catch(() => ''));
    if (current.startsWith('done:')) {
      await removeSendWal(walPath);
      continue;
    }
    if (current === record.lease.pendingValue) {
      scheduleSendCompletion(record.lease, record.response, record.effectData, walPath);
      continue;
    }
    if (!current) {
      const completed = `done:${JSON.stringify({ payloadHash: record.lease.payloadHash, response: record.response, effectKey: record.effectData.effectKey })}`;
      const script = "if redis.call('EXISTS', KEYS[1]) == 0 then redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2]); redis.call('SET', KEYS[2], ARGV[3], 'EX', ARGV[2]); redis.call('ZADD', KEYS[3], ARGV[4], KEYS[2]); return 1 end return 0";
      const recovered = Number(await redisClient.sendCommand(['EVAL', script, '3', record.lease.key, record.effectData.effectKey,
        OPERATOR_EFFECT_OUTBOX_KEY, completed, String(SEND_RESULT_TTL_SECONDS), JSON.stringify(record.effectData.payload), String(Date.now())]).catch(() => 0));
      if (recovered === 1) {
        await removeSendWal(walPath);
        scheduleOperatorSendEffects(record.effectData.payload, record.effectData.effectKey);
      }
    }
  }
  if (ambiguousIntent) throw new Error('AMBIGUOUS_SEND_INTENT_REQUIRES_RECONCILIATION');
}

async function sweepExpiredChatIndexes() {
  if (!redisClient.isOpen) return;
  for await (const key of redisClient.scanIterator({ MATCH: 'chatwoot:expiry:*', COUNT: 100 })) {
    const instanceId = String(key).slice('chatwoot:expiry:'.length);
    if (isValidInstanceId(instanceId)) await chatStore.pruneExpired(instanceId);
  }
}

function summarizeChat(item, historyRows, viewedAt, archived) {
  const history = historyRows.map(parseHistoryEntry).filter(Boolean).map(normalizeChatEntry);
  const last = [...history].reverse().find(entry => entryPreview(entry)) || history[history.length - 1] || null;
  const lastAt = getEntryCreatedAt(last) || item.updatedAt || 0;
  let latestCustomerAt = 0;
  let latestOperatorAt = 0;
  let latestBotAt = 0;
  let hasOperator = false;
  let hasCustomerMessage = false;
  let displayName = '';

  for (const entry of history) {
    const createdAt = getEntryCreatedAt(entry);
    const contactName = String(entry.contactName || entry.displayName || entry.pushName || entry.contact?.name || entry.contact?.shortName || '').trim();
    if (contactName && !/^client$/i.test(contactName)) displayName = contactName;
    if (isOperatorEntry(entry)) {
      hasOperator = true;
      latestOperatorAt = Math.max(latestOperatorAt, createdAt);
    } else if (isBotEntry(entry) || isOutgoingEntry(entry)) {
      latestBotAt = Math.max(latestBotAt, createdAt);
    } else if (!isOutgoingEntry(entry)) {
      if (entryPreview(entry)) {
        hasCustomerMessage = true;
        latestCustomerAt = Math.max(latestCustomerAt, createdAt);
      }
    }
  }

  const unread = !archived && latestCustomerAt > Math.max(viewedAt, latestOperatorAt, latestBotAt);

  return {
    phone: item.phone,
    displayName,
    updatedAt: item.updatedAt,
    lastAt,
    lastText: entryPreview(last) || 'Open conversation',
    unread,
    viewed: viewedAt > 0 && viewedAt >= latestCustomerAt && !hasOperator,
    hasOperator,
    hasCustomerMessage,
    closed: archived
  };
}

app.get('/health', (req, res) => res.json({ ok: true, service: 'whatspro' }));

// The operator shell is public so the canonical URL and its static assets can
// always render. Data and mutation endpoints remain protected by
// requireUiOrApi and surface their own authorization errors inside the frame.
app.get('/chat.html', (req, res, next) => {
  renderChatHtml(req, res).catch(next);
});

app.get('/whatspro', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'whatspro.html'));
});

app.get(['/chat', '/inbox'], (req, res, next) => {
  renderChatHtml(req, res).catch(next);
});

app.get('/', (req, res) => {
  const instance = String(req.query.instance || '').trim();
  if (isValidInstanceId(instance)) {
    return res.redirect(302, `/chat.html?instance=${encodeURIComponent(instance)}`);
  }

  return res.sendFile(path.join(PUBLIC_DIR, 'whatspro.html'));
});

app.use(express.static(PUBLIC_DIR, { index: false }));

app.get('/api/whatspro/session', (req, res) => {
  const session = readSession(req);
  if (!session && !hasApiToken(req)) return res.status(401).json({ error: 'AUTH_REQUIRED' });
  res.json({ authenticated: true, username: session?.username || process.env.WHATSPRO_USER || 'admin' });
});

app.post('/api/whatspro/login', (req, res) => {
  const configuredUser = String(process.env.WHATSPRO_USER || 'admin');
  const configuredPassword = String(process.env.WHATSPRO_PASSWORD || '');
  if (configuredPassword.length < 12 || ['change-me', 'password', 'admin123'].includes(configuredPassword.toLowerCase())) {
    return res.status(503).json({ error: 'LOGIN_NOT_CONFIGURED' });
  }
  const username = String(req.body?.username || '');
  const password = String(req.body?.password || '');
  if (username.length > 64 || password.length > 256) return res.status(400).json({ error: 'INVALID_CREDENTIALS' });
  const now = Date.now();
  if (loginAttempts.size >= 1000) {
    for (const [key, value] of loginAttempts) if (value.resetAt <= now) loginAttempts.delete(key);
  }
  const attemptKey = String(req.ip || 'unknown');
  if (!loginAttempts.has(attemptKey) && loginAttempts.size >= 10000) {
    return res.status(503).json({ error: 'LOGIN_THROTTLE_BUSY' });
  }
  const attempt = loginAttempts.get(attemptKey) || { count: 0, resetAt: Date.now() + 15 * 60 * 1000 };
  if (attempt.resetAt <= now) { attempt.count = 0; attempt.resetAt = now + 15 * 60 * 1000; }
  if (attempt.count >= 5) {
    res.set('Retry-After', String(Math.max(1, Math.ceil((attempt.resetAt - Date.now()) / 1000))));
    return res.status(429).json({ error: 'TOO_MANY_LOGIN_ATTEMPTS' });
  }
  if (!safeEqual(username, configuredUser) || !safeEqual(password, configuredPassword)) {
    attempt.count += 1;
    loginAttempts.set(attemptKey, attempt);
    return res.status(401).json({ error: 'INVALID_CREDENTIALS' });
  }
  loginAttempts.delete(attemptKey);
  res.cookie('whatspro_session', signSession(username), { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 30 * 86400 * 1000 });
  res.json({ success: true, username });
});

app.post('/api/whatspro/logout', (req, res) => {
  res.clearCookie('whatspro_session');
  res.json({ success: true });
});

app.get('/api/wa/instances', requireUiOrApi, async (req, res) => {
  res.json({ success: true, instances: await listInstances() });
});

app.get('/api/wa/scan-requests', requireUiOrApi, async (req, res) => {
  res.json({ success: true, requests: await listScanRequests() });
});

app.post('/api/wa/scan-requests', requireUiOrApi, async (req, res) => {
  const { name, contact } = req.body || {};
  if (!name || !contact) return res.status(400).json({ error: 'NAME_AND_CONTACT_REQUIRED' });
  const requestId = `req_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  await saveScanRequest(requestId, { requestedName: name, contact, status: 'pending' });
  res.status(201).json({ success: true, request: { id: requestId, requestedName: name, contact, status: 'pending', createdAt: Date.now() } });
});

app.post('/api/wa/scan-requests/:requestId/approve', requireUiOrApi, async (req, res) => {
  const requestId = String(req.params.requestId || '').trim();
  const { instanceId, label } = req.body || {};
  if (!instanceId || !label) return res.status(400).json({ error: 'INSTANCE_ID_AND_LABEL_REQUIRED' });
  if (!isValidInstanceId(instanceId)) return res.status(400).json({ error: 'BAD_INSTANCE_ID' });
  await updateScanRequest(requestId, { instanceId, label, status: 'approved' });
  res.json({ success: true });
});

app.post('/api/wa/scan-requests/:requestId/reject', requireUiOrApi, async (req, res) => {
  const requestId = String(req.params.requestId || '').trim();
  await updateScanRequest(requestId, { status: 'rejected' });
  res.json({ success: true });
});

app.post('/api/wa/scan-requests/:requestId/open', requireUiOrApi, async (req, res) => {
  const requestId = String(req.params.requestId || '').trim();
  const request = await getScanRequest(requestId);
  if (!request) return res.status(404).json({ error: 'REQUEST_NOT_FOUND' });
  res.json({ success: true, request });
});

app.get('/api/wa/scan-requests/:requestId', requireUiOrApi, async (req, res) => {
  const requestId = String(req.params.requestId || '').trim();
  const request = await getScanRequest(requestId);
  if (!request) return res.status(404).json({ error: 'REQUEST_NOT_FOUND' });
  res.json({ success: true, request });
});

app.get('/api/wa/scan-invitations', requireUiOrApi, async (req, res) => {
  const requestId = `req_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  await saveScanRequest(requestId, { status: 'pending' });
  res.status(201).json({ success: true, request: { id: requestId } });
});

app.get('/api/chat/inbox/:instanceId', requireUiOrApi, async (req, res) => {
  const instanceId = String(req.params.instanceId || '').trim();
  if (!isValidInstanceId(instanceId)) return res.status(400).json({ error: 'BAD_INSTANCE_ID' });
  if (!redisClient.isOpen) return res.status(503).json({ error: 'REDIS_NOT_CONNECTED' });

  const limit = parseLimit(req.query.limit, 100, 500);
  const inboxRows = await readInboxEntries(instanceId, limit * 2);
  const legacyHistoryKeys = [];
  for await (const key of redisClient.scanIterator({ MATCH: `history:${instanceId}:*`, COUNT: 100 })) {
    const phone = normalizePhone(String(key).slice(`history:${instanceId}:`.length));
    if (isValidChatPhone(phone)) legacyHistoryKeys.push({ phone, updatedAt: 0 });
  }
  const candidates = [];
  const seen = new Set();

  for (const row of [...inboxRows, ...legacyHistoryKeys]) {
    const phone = normalizePhone(row.phone);
    if (!isValidChatPhone(phone) || seen.has(phone)) continue;
    seen.add(phone);
    candidates.push({ phone, updatedAt: Number(row.updatedAt) || 0 });
    if (candidates.length >= limit) break;
  }

  const [archiveRows, histories, openbotHistories, viewedScores, states] = await Promise.all([
    redisClient.sendCommand(['SMEMBERS', chatArchiveKey(instanceId)]).catch(() => []),
    Promise.all(candidates.map(item => redisClient.sendCommand(['LRANGE', chatHistoryKey(instanceId, item.phone), '-80', '-1']).catch(() => []))),
    Promise.all(candidates.map(item => redisClient.sendCommand(['LRANGE', openbotHistoryKey(instanceId, item.phone), '-80', '-1']).catch(() => []))),
    Promise.all(candidates.map(item => redisClient.sendCommand(['ZSCORE', chatViewedKey(instanceId), item.phone]).catch(() => null))),
    Promise.all(candidates.map(item => chatStore.getState(instanceId, item.phone)))
  ]);
  const archiveSet = new Set((archiveRows || []).map(normalizePhone).filter(Boolean));
  const items = [];
  const stalePhones = [];

  candidates.forEach((item, index) => {
    const historyRows = [...(histories[index] || []), ...(openbotHistories[index] || [])];
    if (!historyRows.length) {
      stalePhones.push(item.phone);
      return;
    }
    const summary = summarizeChat(item, historyRows, Number(viewedScores[index]) || 0, archiveSet.has(item.phone));
    if (!summary.hasCustomerMessage) {
      stalePhones.push(item.phone);
      return;
    }
    const state = states[index] || (summary.closed ? 'archive' : summary.hasOperator ? 'operator' : summary.unread ? 'new' : 'all');
    items.push({
      ...summary,
      state,
      unread: state === 'new',
      viewed: state === 'all',
      hasOperator: state === 'operator',
      closed: state === 'archive'
    });
  });

  await Promise.all(stalePhones.map(phone => Promise.all([
    redisClient.sendCommand(['ZREM', chatInboxKey(instanceId), phone]).catch(() => 0),
    redisClient.sendCommand(['SREM', chatArchiveKey(instanceId), phone]).catch(() => 0),
    redisClient.sendCommand(['ZREM', chatViewedKey(instanceId), phone]).catch(() => 0),
    redisClient.sendCommand(['DEL', chatArchiveMarkerKey(instanceId, phone)]).catch(() => 0)
  ])));

  items.sort((a, b) => Number(b.lastAt || b.updatedAt || 0) - Number(a.lastAt || a.updatedAt || 0));

  res.json({ success: true, instanceId, items });
});

app.get('/api/chat/events/:instanceId', requireUiOrApi, async (req, res) => {
  const instanceId = String(req.params.instanceId || '').trim();
  if (!isValidInstanceId(instanceId)) return res.status(400).json({ error: 'BAD_INSTANCE_ID' });
  const sessionToken = parseCookies(req).whatspro_session || '';
  const incomingApiToken = String(req.headers.authorization || req.headers['x-api-key'] || '');
  const principal = crypto.createHash('sha256').update(sessionToken || incomingApiToken || req.ip).digest('hex').slice(0, 24);
  const connectionKey = `${principal}:${instanceId}`;
  const connectionCount = sseConnections.get(connectionKey) || 0;
  if (connectionCount >= SSE_MAX_CONNECTIONS_PER_CLIENT || sseConnectionTotal >= SSE_MAX_CONNECTIONS_TOTAL) {
    return res.status(429).json({ error: 'TOO_MANY_EVENT_STREAMS' });
  }
  sseConnections.set(connectionKey, connectionCount + 1);
  sseConnectionTotal += 1;

  res.set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders();
  res.write('retry: 3000\n\n');

  let unsubscribe = () => {};
  const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 20000);
  const maxLifetime = setTimeout(() => res.end(), SSE_MAX_LIFETIME_MS);
  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    clearInterval(heartbeat);
    clearTimeout(maxLifetime);
    unsubscribe();
    const remaining = Math.max(0, (sseConnections.get(connectionKey) || 1) - 1);
    if (remaining) sseConnections.set(connectionKey, remaining);
    else sseConnections.delete(connectionKey);
    sseConnectionTotal = Math.max(0, sseConnectionTotal - 1);
  };
  req.once('close', cleanup);

  try {
    const teardown = await subscribeChatEvents(instanceId, event => {
      if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`);
    });
    if (cleanedUp || req.destroyed) teardown();
    else unsubscribe = teardown;
  } catch (error) {
    cleanup();
    if (!res.writableEnded) res.end(`event: error\ndata: ${JSON.stringify({ error: 'EVENT_STREAM_UNAVAILABLE' })}\n\n`);
  }
});

app.get('/api/chat/inbox-legacy/:instanceId', requireUiOrApi, async (req, res) => {
  const instanceId = String(req.params.instanceId || '').trim();
  if (!isValidInstanceId(instanceId)) return res.status(400).json({ error: 'BAD_INSTANCE_ID' });
  if (!redisClient.isOpen) return res.status(503).json({ error: 'REDIS_NOT_CONNECTED' });

  const limit = parseLimit(req.query.limit, 100, 500);
  const rows = await redisClient.sendCommand(['ZREVRANGE', chatInboxKey(instanceId), '0', String(limit - 1), 'WITHSCORES']);

  const items = [];
  const phones = [];
  const seen = new Set();

  for (let i = 0; i < rows.length; i += 2) {
    const rawPhone = rows[i];
    // Спамды тазалау
    const purePhone = rawPhone.split(',')[0].replace(/\D/g, '');
    if (!purePhone || seen.has(purePhone)) continue;

    seen.add(purePhone);
    phones.push(purePhone);
    items.push({ phone: purePhone, updatedAt: Number(rows[i + 1]) || 0 });
  }

  if (phones.length > 0) {
      const archivedKeys = await redisClient.sendCommand(['SMEMBERS', `chatwoot:archive:${instanceId}`]).catch(() => []);
      const archiveSet = new Set(archivedKeys || []);

      const lastMessages = await Promise.all(
          phones.map(p => redisClient.sendCommand(['LRANGE', `chatwoot:history:${instanceId}:${p}`, '-1', '-1']).catch(() => []))
      );

      items.forEach((item, idx) => {
          item.closed = archiveSet.has(item.phone);
          const rawMsg = lastMessages[idx]?.[0];
          let msg = null;
          try { if (rawMsg) msg = JSON.parse(rawMsg); } catch(e){}

          item.lastText = msg ? (msg.text || msg.body || (msg.hasMedia ? '[Медиа файл]' : '...')) : 'Open conversation';
          const fromMe = msg ? (msg.direction === 'outgoing' || msg.fromMe === true || msg.role === 'operator' || msg.role === 'assistant') : false;
          item.unread = !fromMe;
          item.hasOperator = fromMe;
      });
  }

  res.json({ success: true, instanceId, items });
});

app.get('/api/chat/history/:instanceId/:phone', requireUiOrApi, async (req, res) => {
  const instanceId = String(req.params.instanceId || '').trim();
  const phone = normalizePhone(req.params.phone || '');
  if (!isValidInstanceId(instanceId)) return res.status(400).json({ error: 'BAD_INSTANCE_ID' });
  if (!isValidChatPhone(phone)) return res.status(400).json({ error: 'BAD_PHONE' });
  if (!redisClient.isOpen) return res.status(503).json({ error: 'REDIS_NOT_CONNECTED' });

  const limit = parseLimit(req.query.limit, 200, 1000);
  
  const history = await chatStore.getHistory(instanceId, phone, limit);

  res.json({ success: true, instanceId, phone, history });
});

const serveChatMedia = createChatMediaHandler({
    readMedia: (instanceId, messageId) => redisClient.sendCommand(['GET', chatMediaKey(instanceId, messageId)]).catch(() => '')
});

app.get('/api/chat/media/:instanceId/:messageId', requireChatMediaAuth, async (req, res) => {
    const instanceId = String(req.params.instanceId || '').trim();
    const messageId = String(req.params.messageId || '').trim();

    if (!isValidInstanceId(instanceId)) {
        return res.status(400).json({ error: 'BAD_INSTANCE_ID' });
    }

    if (!messageId || messageId.length > 256) {
        return res.status(400).json({ error: 'BAD_MESSAGE_ID' });
    }

    if (!redisClient.isOpen) {
        return res.status(503).json({ error: 'REDIS_NOT_CONNECTED' });
    }

    return serveChatMedia(req, res);
});
app.post('/api/chat/send/:instanceId/:phone', requireUiOrApi, async (req, res) => {
    const instanceId = String(req.params.instanceId || '').trim();
    const phone = String(req.params.phone || '').replace(/\D/g, '');
    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    const requestId = String(req.body?.requestId || '');

    if (!isValidInstanceId(instanceId)) return res.status(400).json({ error: 'BAD_INSTANCE_ID' });
    if (!isValidChatPhone(phone)) return res.status(400).json({ error: 'BAD_PHONE' });
    if (!text || text.length > 4096) return res.status(400).json({ error: 'TEXT_REQUIRED' });
    if (!isValidSendRequestId(requestId)) return res.status(400).json({ error: 'BAD_REQUEST_ID' });
    if (!walRecoveryComplete) return res.status(503).json({ error: 'SEND_RECOVERY_NOT_READY' });
    if (!redisClient.isOpen) return res.status(503).json({ error: 'REDIS_NOT_CONNECTED' });
    const operationStartedAt = Date.now();

    const effectDataFor = (response, deliveryStatus = 'sent') => ({
      instanceId,
      phone,
      expiresAt: Date.now() + OPERATOR_ACTIVE_SECONDS * 1000,
      entry: {
        id: String(response?.messageId || `operator:${requestId}`),
        instanceId,
        phone,
        direction: 'outgoing',
        fromMe: true,
        role: 'operator',
        text,
        body: text,
        type: 'chat',
        createdAt: operationStartedAt,
        deliveryStatus,
        source: 'operator_panel'
      }
    });

    const payloadHash = crypto.createHash('sha256').update(text).digest('hex');
    const idempotencyKey = `chatwoot:send-idempotency:${instanceId}:${phone}:${requestId}`;
    try {
      const priorWal = JSON.parse(await fs.readFile(sendWalPath(idempotencyKey), 'utf8'));
      if (priorWal?.phase === 'intent') return res.status(409).json({ error: 'SEND_OUTCOME_UNKNOWN' });
    } catch (error) {
      if (error.code !== 'ENOENT') return res.status(503).json({ error: 'SEND_RECOVERY_CORRUPT' });
    }
    const lease = await sendIdempotency.begin(instanceId, phone, requestId, payloadHash);
    if (lease.acquired && lease.backend !== 'redis') {
      await sendIdempotency.release(lease);
      return res.status(503).json({ error: 'REDIS_IDEMPOTENCY_UNAVAILABLE' });
    }
    if (lease.conflict) return res.status(409).json({ error: 'IDEMPOTENCY_PAYLOAD_MISMATCH' });
    if (lease.response) {
      const replayEffect = lease.effectData?.payload || await loadOperatorEffect(lease.effectKey);
      if (replayEffect) scheduleOperatorSendEffects(replayEffect, lease.effectKey || lease.effectData?.effectKey || '');
      return res.json({ ...lease.response, replayed: true });
    }
    if (!lease.acquired) return res.status(409).json({ error: 'REQUEST_IN_PROGRESS' });

    let walPath;
    try {
      walPath = await writeSendWal({ phase: 'intent', lease, instanceId, phone, text, operationStartedAt });
      liveSendWalPaths.add(walPath);
    } catch (error) {
      await sendIdempotency.release(lease);
      console.error(`[CHAT SEND WAL] ${instanceId}/${phone}:`, error?.message || error);
      return res.status(507).json({ error: 'SEND_WAL_UNAVAILABLE' });
    }

    let sendResult;
    const renewTimer = setInterval(() => sendIdempotency.renew(lease).catch(() => {}), 30000);
    renewTimer.unref?.();
    try {
      sendResult = await sendWhatsAppText(instanceId, phone, text, { skipQueue: true });
    } catch (error) {
      liveSendWalPaths.delete(walPath);
      walRecoveryComplete = false;
      console.error(`[CHAT SEND] ${instanceId}/${phone}:`, error?.message || error);
      return res.status(409).json({ error: 'SEND_OUTCOME_UNKNOWN' });
    } finally {
      clearInterval(renewTimer);
    }
    const ok = sendResult && typeof sendResult === 'object' ? sendResult.success === true : Boolean(sendResult);
    if (!ok && sendResult?.outcomeUnknown) {
      liveSendWalPaths.delete(walPath);
      walRecoveryComplete = false;
      return res.status(409).json({ error: 'SEND_OUTCOME_UNKNOWN' });
    }
    if (!ok) {
      await sendIdempotency.release(lease);
      await removeSendWal(walPath).catch(() => {});
      liveSendWalPaths.delete(walPath);
      return res.status(503).json({ success: false, messageId: '', ttl: 0, expiresAt: 0 });
    }

    const expiresAt = Date.now() + OPERATOR_ACTIVE_SECONDS * 1000;
    const responsePayload = {
      success: true,
      messageId: sendResult?.messageId || '',
      ttl: OPERATOR_ACTIVE_SECONDS,
      expiresAt
    };
    const deliveryStatus = Number(sendResult?.ack) >= 3 ? 'read' : Number(sendResult?.ack) >= 2 ? 'delivered' : 'sent';
    const effectPayload = effectDataFor(responsePayload, deliveryStatus);
    const effectKey = `chatwoot:operator-effect:${instanceId}:${phone}:${requestId}`;
    const effectData = { effectKey, payload: effectPayload };
    try { walPath = await writeSendWal({ phase: 'accepted', lease, response: responsePayload, effectData }); }
    catch (error) { console.error(`[CHAT SEND WAL] accepted-state update failed ${instanceId}/${phone}:`, error?.message || error); }
    const completed = await sendIdempotency.complete(lease, responsePayload, effectData);
    if (completed) {
      await removeSendWal(walPath).catch(error => console.error('[CHAT SEND WAL] cleanup failed:', error.message));
      liveSendWalPaths.delete(walPath);
    }
    if (!completed) console.error(`[CHAT SEND] ${instanceId}/${phone}: idempotency lease ownership was lost after WhatsApp accepted the message.`);
    const effectsJob = completed
      ? scheduleOperatorSendEffects(effectPayload, effectKey)
      : scheduleSendCompletion(lease, responsePayload, effectData, walPath).finally(() => liveSendWalPaths.delete(walPath));
    await Promise.race([effectsJob, new Promise(resolve => setTimeout(resolve, 1000))]);
    res.status(completed ? 200 : 202).json({ ...responsePayload, persistencePending: !completed });
});
app.get('/api/chat/operator-lock/:instanceId/:phone', requireUiOrApi, async (req, res) => {
  const instanceId = String(req.params.instanceId || '').trim();
  const phone = normalizePhone(req.params.phone || '');
  if (!isValidInstanceId(instanceId) || !isValidChatPhone(phone)) return res.status(400).json({ error: 'BAD_CHAT_REQUEST' });
  const ttl = redisClient.isOpen ? await redisClient.sendCommand(['TTL', operatorActiveKey(instanceId, phone)]).catch(() => 0) : 0;
  const safeTtl = Math.max(0, Number(ttl) || 0);
  return res.json({ success: true, instanceId, phone, ttl: safeTtl, expiresAt: safeTtl ? Date.now() + safeTtl * 1000 : 0 });
});

app.post('/api/chat/action/:instanceId/:phone', requireUiOrApi, async (req, res) => {
  const instanceId = String(req.params.instanceId || '').trim();
  const phone = normalizePhone(req.params.phone || '');
  const action = String(req.body?.action || '').trim().toLowerCase();
  if (!isValidInstanceId(instanceId) || !isValidChatPhone(phone)) return res.status(400).json({ error: 'BAD_CHAT_REQUEST' });
  if (!['view', 'close', 'archive', 'restore', 'delete'].includes(action)) return res.status(400).json({ error: 'BAD_ACTION' });
  if (!redisClient.isOpen) return res.status(503).json({ error: 'REDIS_NOT_CONNECTED' });
  await chatStore.applyAction(instanceId, phone, action);
  await publishChatEvent({ type: 'chat.action', instanceId, phone, action }).catch(() => {});
  return res.json({ success: true, instanceId, phone, action });
});

app.post('/api/wa/start', requireUiOrApi, async (req, res) => {
  const instanceId = String(req.body?.instanceId || '').trim();
  const label = String(req.body?.label || '').trim();
  if (!isValidInstanceId(instanceId)) return res.status(400).json({ error: 'BAD_INSTANCE_ID' });
  await saveInstance(instanceId, label);
  const result = await startWhatsAppInstance(instanceId);
  res.json({ success: true, ...result, ...(await getInstanceStatus(instanceId)) });
});

app.get('/api/wa/status/:instanceId', requireUiOrApi, async (req, res) => {
  const instanceId = String(req.params.instanceId || '').trim();
  if (!isValidInstanceId(instanceId)) return res.status(400).json({ error: 'BAD_INSTANCE_ID' });
  let status = await getInstanceStatus(instanceId);
  if (status?.hasStoredSession && ['not_running', 'stopped', 'disconnected'].includes(String(status.status || ''))) {
    await startWhatsAppInstance(instanceId);
    status = await getInstanceStatus(instanceId);
  }
  res.json(status);
});

// Инстансты қосу (whatspro.html интерфейсі үшін)
app.post('/api/wa/instances', requireUiOrApi, async (req, res) => {
  const instanceId = String(req.body?.instanceId || '').trim();
  const label = String(req.body?.label || '').trim();
  if (!isValidInstanceId(instanceId)) return res.status(400).json({ error: 'BAD_INSTANCE_ID' });
  await saveInstance(instanceId, label);
  res.json({ success: true, instanceId, label });
});

// Инстансты өшіру (whatspro.html интерфейсі үшін)
app.delete('/api/wa/instances/:instanceId', requireUiOrApi, async (req, res) => {
  const instanceId = String(req.params.instanceId || '').trim();
  if (!isValidInstanceId(instanceId)) return res.status(400).json({ error: 'BAD_INSTANCE_ID' });
  await stopWhatsAppInstance(instanceId).catch(() => {});
  if (redisClient.isOpen) await redisClient.hDel(INSTANCE_STORE_KEY, instanceId);
  res.json({ success: true });
});

app.post('/api/wa/restart/:instanceId', requireUiOrApi, async (req, res) => {
  const instanceId = String(req.params.instanceId || '').trim();
  if (!isValidInstanceId(instanceId)) return res.status(400).json({ error: 'BAD_INSTANCE_ID' });
  await stopWhatsAppInstance(instanceId).catch(() => {});
  const result = await startWhatsAppInstance(instanceId);
  res.json({ success: true, ...result, ...(await getInstanceStatus(instanceId)) });
});

app.post('/api/wa/logout', requireUiOrApi, async (req, res) => {
  const instanceId = String(req.body?.instanceId || '').trim();
  if (!isValidInstanceId(instanceId)) return res.status(400).json({ error: 'BAD_INSTANCE_ID' });
  res.json(await stopWhatsAppInstance(instanceId));
});

app.post('/api/send', requireApi, apiSendJsonParser, async (req, res) => {
  const { instanceId, phone } = req.body || {};
  if (req.body?.text != null && typeof req.body.text !== 'string') return res.status(400).json({ error: 'INVALID_TEXT' });
  const text = String(req.body?.text || '').trim();
  if (text.length > 4096) return res.status(400).json({ error: 'TEXT_TOO_LONG' });
  const media = req.body?.media;
  if (media != null && (!media || typeof media !== 'object' || Array.isArray(media))) return res.status(400).json({ error: 'INVALID_MEDIA_PAYLOAD' });
  
  if (!isValidInstanceId(instanceId)) return res.status(400).json({ error: 'BAD_INSTANCE_ID' });
  if (!phone) return res.status(400).json({ error: 'PHONE_REQUIRED' });

  // 1-ӨЗГЕРІС: Міндетті түрде телефонды нормализациялау (RC-7 шешімі)
  // Бұл 8707, +7707 форматтарының барлығын таза 7707... форматына әкеледі.
  const cleanPhone = normalizePhone(phone);
  if (!isValidChatPhone(cleanPhone)) return res.status(400).json({ error: 'INVALID_PHONE_FORMAT' });

  let sendResult = { success: true };
  let effectiveMediaType = '';
  let audioMediaData = '';
  
  // 2-ӨЗГЕРІС: Медиа жіберу логикасын қауіпсіздендіру және cleanPhone қолдану
  if (media) {
    if (typeof media.base64 !== 'string') return res.status(400).json({ error: 'INVALID_MEDIA_PAYLOAD' });
    if (media.caption != null && typeof media.caption !== 'string') return res.status(400).json({ error: 'INVALID_MEDIA_CAPTION' });
    if (media.fileName != null && typeof media.fileName !== 'string') return res.status(400).json({ error: 'INVALID_MEDIA_FILENAME' });
    if (media.mimeType != null && typeof media.mimeType !== 'string') return res.status(400).json({ error: 'INVALID_MEDIA_TYPE' });
    const caption = String(media.caption || text || '').trim();
    const fileName = String(media.fileName || 'file').trim();
    const dataMatch = media.base64.match(/^data:([^;,]+);base64,([\s\S]+)$/i);
    if (media.base64.includes(';base64,') && !dataMatch) return res.status(400).json({ error: 'INVALID_MEDIA_BASE64' });
    const declaredMime = String(media.mimeType || '').split(';')[0].trim().toLowerCase();
    const embeddedMime = String(dataMatch?.[1] || '').trim().toLowerCase();
    const mimeType = declaredMime || embeddedMime;
    if (declaredMime && embeddedMime && declaredMime !== embeddedMime) return res.status(400).json({ error: 'MEDIA_TYPE_MISMATCH' });
    if (!mimeType) return res.status(400).json({ error: 'MEDIA_TYPE_REQUIRED' });
    const encoded = String(dataMatch?.[2] || media.base64).replace(/\s+/g, '');
    if (caption.length > 4096) return res.status(400).json({ error: 'MEDIA_CAPTION_TOO_LONG' });
    if (!fileName || fileName.length > 128 || /[\\/\0-\x1f]/.test(fileName)) return res.status(400).json({ error: 'INVALID_MEDIA_FILENAME' });
    if (mimeType && !/^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/.test(mimeType)) return res.status(400).json({ error: 'INVALID_MEDIA_TYPE' });
    if (!encoded || encoded.length > Math.ceil(MAX_MEDIA_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
      return res.status(encoded.length > Math.ceil(MAX_MEDIA_BYTES / 3) * 4 ? 413 : 400).json({ error: 'INVALID_MEDIA_BASE64' });
    }
    const decodedLength = Buffer.from(encoded, 'base64').length;
    if (!decodedLength || decodedLength > MAX_MEDIA_BYTES) return res.status(decodedLength > MAX_MEDIA_BYTES ? 413 : 400).json({ error: 'INVALID_MEDIA_BASE64' });
    const mediaPayload = mimeType ? `data:${mimeType};base64,${encoded}` : encoded;
    effectiveMediaType = mimeType;
    if (mimeType.startsWith('audio/')) audioMediaData = encoded;
    sendResult = await sendMedia(instanceId, cleanPhone, mediaPayload, fileName, caption);
  } else if (text) {
    sendResult = await sendWhatsAppText(instanceId, cleanPhone, text);
  } else {
    return res.status(400).json({ error: 'TEXT_OR_MEDIA_REQUIRED' });
  }

  const ok = Boolean(sendResult?.success || sendResult);
  if (ok && (text || media)) {
    const saved = await saveChatHistoryEntry(instanceId, cleanPhone, {
      id: sendResult?.messageId || `api:${Date.now()}:${cleanPhone}`,
      instanceId,
      phone: cleanPhone,
      direction: 'outgoing',
      fromMe: true,
      role: 'assistant',
      text,
      body: text,
      type: audioMediaData ? 'audio' : media ? 'media' : 'chat',
      hasMedia: Boolean(audioMediaData),
      mediaData: audioMediaData,
      mediaType: audioMediaData ? effectiveMediaType : '',
      deliveryStatus: 'sent',
      source: 'api_send'
    });
    await publishChatEvent({ type: 'chat.message', instanceId, phone: cleanPhone, messageId: saved?.id || sendResult?.messageId || '' }).catch(() => {});
  }

  res.status(ok ? 200 : 503).json({ success: Boolean(ok) });
});

app.post('/api/presence', requireApi, async (req, res) => {
  const { instanceId, instance, phone } = req.body || {};
  const cleanInstanceId = String(instanceId || instance || '').trim();
  const cleanPhone = normalizePhone(phone);
  if (!isValidInstanceId(cleanInstanceId)) return res.status(400).json({ error: 'BAD_INSTANCE_ID' });
  if (!isValidChatPhone(cleanPhone)) return res.status(400).json({ error: 'INVALID_PHONE_FORMAT' });

  const ok = await sendPresence(cleanInstanceId, cleanPhone);
  res.status(ok ? 200 : 503).json({ success: Boolean(ok) });
});

async function boot() {
  if (process.env.NODE_ENV === 'production') {
    const missing = [
      (!process.env.WHATSPRO_SESSION_SECRET && !process.env.WHATSPRO_API_TOKEN) && 'WHATSPRO_SESSION_SECRET or WHATSPRO_API_TOKEN',
      !process.env.WHATSPRO_PASSWORD && 'WHATSPRO_PASSWORD',
      !process.env.WHATSPRO_API_TOKEN && 'WHATSPRO_API_TOKEN'
    ].filter(Boolean);
    if (missing.length) console.warn(`[SECURITY] Missing recommended production settings: ${missing.join(', ')}`);
    const weakPassword = String(process.env.WHATSPRO_PASSWORD || '');
    if (weakPassword.length < 12 || ['change-me', 'password', 'admin123'].includes(weakPassword.toLowerCase())) {
      console.warn('[SECURITY] WHATSPRO_PASSWORD should be at least 12 characters and not a known default');
    }
    if (SESSION_SECRET.length < 32 || String(process.env.WHATSPRO_API_TOKEN || '').length < 32) {
      console.warn('[SECURITY] Production session and API secrets should be at least 32 characters');
    }
  }

  // Bind HTTP before optional infrastructure initialization. This guarantees
  // that health checks and the operator UI remain routable even when Redis or
  // WhatsApp session restoration is slow/unavailable during deployment.
  const server = await new Promise((resolve, reject) => {
    const listener = app.listen(PORT, () => {
      console.log(`[WhatsPro] listening on :${PORT}`);
      resolve(listener);
    });
    listener.once('error', reject);
  });

  await connectRedis();
  await sweepExpiredChatIndexes().catch(error => console.warn('[CHAT EXPIRY] initial sweep failed:', error.message));
  try {
    await recoverSendWal();
    walRecoveryComplete = true;
  } catch (error) {
    walRecoveryComplete = false;
    console.warn('[CHAT SEND WAL] initial recovery failed:', error.message);
  }
  await drainOperatorEffectOutbox().catch(error => console.warn('[CHAT EFFECTS] initial drain failed:', error.message));
  const expiryTimer = setInterval(() => {
    sweepExpiredChatIndexes().catch(error => console.warn('[CHAT EXPIRY] sweep failed:', error.message));
  }, 60000);
  expiryTimer.unref();
  const effectTimer = setInterval(() => {
    recoverSendWal().then(() => { walRecoveryComplete = true; }).catch(error => {
      walRecoveryComplete = false;
      console.warn('[CHAT SEND WAL] recovery failed:', error.message);
    });
    drainOperatorEffectOutbox().catch(error => console.warn('[CHAT EFFECTS] drain failed:', error.message));
  }, 5000);
  effectTimer.unref();
  
  console.log('[WhatsPro] Сервер қосылды. Барлық сақталған сессиялар автоматты түрде іске қосылады...');
  try {
    const instances = await listInstances();
    for (const inst of instances) {
       // Сессиясы болса да, болмаса да оятамыз. 
       // Сессиясы жоқтар автоматты түрде QR код дайындап күтіп тұрады.
       console.log(`[BOOT] Автоқосылу (QR немесе Сессия): ${inst.instanceId}`);
       startWhatsAppInstance(inst.instanceId).catch(err => {
           console.error(`[BOOT] ${inst.instanceId} қосылу қатесі:`, err.message);
       });
    }
  } catch (err) {
    console.error('[BOOT] Автоқосылу кезіндегі қате:', err);
  }

  return server;
}

process.on('SIGTERM', async () => {
  await shutdownWhatsAppClients().catch(() => {});
  process.exit(0);
});

if (require.main === module) {
  boot().catch(error => {
    console.error('[WhatsPro] boot failed:', error);
    process.exit(1);
  });
}

module.exports = {
  app,
  boot,
  renderChatHtml,
  __test: { createSendIdempotency, isValidSendRequestId, remainingOperatorTtl, hasChatMediaToken }
};
