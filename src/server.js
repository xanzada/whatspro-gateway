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
const { markOperatorActive, OPERATOR_ACTIVE_SECONDS, operatorActiveKey } = require('../services/operatorLock');
const { getTenantChatConfig } = require('../services/nocodbConfig');
const { chatStore, MAX_MEDIA_BYTES } = require('../services/chatStore');
const { publishChatEvent, subscribeChatEvents } = require('../services/chatEvents');

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

function requireApi(req, res, next) {
  if (hasApiToken(req)) return next();
  return res.status(401).json({ error: 'AUTH_REQUIRED' });
}

function requireUiOrApi(req, res, next) {
  if (hasApiToken(req) || readSession(req)) return next();
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
  const tenant = await getTenantChatConfig(instance);
  const config = {
    ...tenant,
    instance: tenant.instance || instance,
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
// requireUiOrApi; chat.js redirects unauthenticated operators to login.
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
  if (!safeEqual(username, process.env.WHATSPRO_USER || 'admin') || !safeEqual(password, process.env.WHATSPRO_PASSWORD || 'change-me')) {
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

app.get('/api/chat/media/:instanceId/:messageId', requireUiOrApi, async (req, res) => {
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

    try {
        const mediaData = await chatStore.readMedia(instanceId, messageId);

        if (!mediaData) {
            res.set('Retry-After', '3');
            return res.status(404).json({ error: 'MEDIA_NOT_READY' });
        }

        const raw = String(mediaData).trim();
        const match = raw.match(/^data:([^;,]+);base64,([\s\S]+)$/i);

        if (!match) {
            return res.status(422).json({ error: 'INVALID_MEDIA_DATA' });
        }

        const mediaType = String(match[1] || 'audio/ogg')
            .trim()
            .toLowerCase();

        if (!mediaType.startsWith('audio/')) {
            return res.status(415).json({ error: 'UNSUPPORTED_MEDIA_TYPE' });
        }

        const base64 = String(match[2] || '').replace(/\s+/g, '');

        if (!base64 || base64.length > Math.ceil(MAX_MEDIA_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) {
            return res.status(422).json({ error: 'EMPTY_MEDIA_DATA' });
        }

        const buffer = Buffer.from(base64, 'base64');

        if (!buffer.length || buffer.length > MAX_MEDIA_BYTES) {
            return res.status(422).json({ error: 'INVALID_MEDIA_BUFFER' });
        }

        res.set({
            'Content-Type': mediaType,
            'Content-Length': String(buffer.length),
            'Content-Disposition': 'inline',
            'Cache-Control': 'private, max-age=3600',
            'X-Content-Type-Options': 'nosniff'
        });

        return res.status(200).send(buffer);
    } catch (error) {
        console.error(
            `[CHAT MEDIA] ${instanceId}/${messageId}:`,
            error?.stack || error?.message || error
        );

        return res.status(500).json({ error: 'MEDIA_READ_FAILED' });
    }
});
app.post('/api/chat/send/:instanceId/:phone', requireUiOrApi, async (req, res) => {
    const instanceId = String(req.params.instanceId || '').trim();
    const phone = String(req.params.phone || '').replace(/\D/g, '');
    const { text } = req.body || {};

    if (!isValidInstanceId(instanceId)) return res.status(400).json({ error: 'BAD_INSTANCE_ID' });
    if (!isValidChatPhone(phone)) return res.status(400).json({ error: 'BAD_PHONE' });
    if (!text) return res.status(400).json({ error: 'TEXT_REQUIRED' });

    const sendResult = await sendWhatsAppText(instanceId, phone, text);
    const ok = Boolean(sendResult?.success || sendResult);
    
    if (ok) {
        await Promise.all([
            markOperatorActive(instanceId, phone, 'operator_panel'),
            redisClient.isOpen ? redisClient.sendCommand(['SET', `mute:${instanceId}:${phone}`, 'muted_by_operator_panel', 'EX', String(OPERATOR_ACTIVE_SECONDS)]).catch(() => null) : Promise.resolve(null)
        ]);
        const saved = await saveChatHistoryEntry(instanceId, phone, {
            id: sendResult?.messageId || `operator:${Date.now()}:${phone}`,
            instanceId,
            phone,
            direction: 'outgoing',
            fromMe: true,
            role: 'operator',
            text,
            body: text,
            type: 'chat',
            deliveryStatus: 'sent',
            source: 'operator_panel'
        });
        await publishChatEvent({ type: 'chat.message', instanceId, phone, messageId: saved.id, state: 'operator' }).catch(() => {});
    }

    const expiresAt = ok ? Date.now() + OPERATOR_ACTIVE_SECONDS * 1000 : 0;
    res.status(ok ? 200 : 503).json({
      success: Boolean(ok),
      messageId: sendResult?.messageId || '',
      ttl: ok ? OPERATOR_ACTIVE_SECONDS : 0,
      expiresAt
    });
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
  const { instanceId, phone, text, media } = req.body || {};
  
  if (!isValidInstanceId(instanceId)) return res.status(400).json({ error: 'BAD_INSTANCE_ID' });
  if (!phone) return res.status(400).json({ error: 'PHONE_REQUIRED' });

  // 1-ӨЗГЕРІС: Міндетті түрде телефонды нормализациялау (RC-7 шешімі)
  // Бұл 8707, +7707 форматтарының барлығын таза 7707... форматына әкеледі.
  const cleanPhone = normalizePhone(phone);
  if (!isValidChatPhone(cleanPhone)) return res.status(400).json({ error: 'INVALID_PHONE_FORMAT' });

  let sendResult = { success: true };
  
  // 2-ӨЗГЕРІС: Медиа жіберу логикасын қауіпсіздендіру және cleanPhone қолдану
  if (media) {
    if (media.base64) {
      if (String(media.base64).length > Math.ceil(MAX_MEDIA_BYTES / 3) * 4 + 128) {
        return res.status(413).json({ error: 'MEDIA_TOO_LARGE' });
      }
      sendResult = await sendMedia(instanceId, cleanPhone, media.base64, media.fileName || media.mimeType || 'file', media.caption || text || '');
    } else {
      console.warn(`[API:SEND] Warning: Media object received but missing 'base64' property for phone ${cleanPhone}`);
      // Егер медиа қате болса, бірақ мәтін болса, құламай мәтінді жібереміз
      if (text) sendResult = await sendWhatsAppText(instanceId, cleanPhone, text);
      else return res.status(400).json({ error: 'INVALID_MEDIA_PAYLOAD' });
    }
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
      text: text || '',
      body: text || '',
      type: media ? 'audio' : 'chat',
      hasMedia: Boolean(media),
      mediaData: (media && media.base64) ? media.base64 : '',
      mediaType: (media && media.mimeType) ? media.mimeType : 'audio/ogg',
      deliveryStatus: 'sent',
      source: 'api_send'
    });
    await publishChatEvent({ type: 'chat.message', instanceId, phone: cleanPhone, messageId: saved.id }).catch(() => {});
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
  const expiryTimer = setInterval(() => {
    sweepExpiredChatIndexes().catch(error => console.warn('[CHAT EXPIRY] sweep failed:', error.message));
  }, 60000);
  expiryTimer.unref();
  
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

module.exports = { app, boot, renderChatHtml };
