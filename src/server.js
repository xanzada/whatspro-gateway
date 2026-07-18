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

const app = express();
const PORT = Number(process.env.PORT || 3000);
const INSTANCE_STORE_KEY = 'whatspro:instances';
const SCAN_REQUESTS_KEY = 'whatspro:scan-requests';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const CHAT_HTML_PATH = path.join(PUBLIC_DIR, 'chat.html');
const CHAT_STANDARD_TTL_SECONDS = 24 * 60 * 60;
const CHAT_ARCHIVE_TTL_SECONDS = 72 * 60 * 60;
const CHAT_ACCESS_SECRET = process.env.CHAT_ACCESS_SECRET || process.env.WHATSPRO_SESSION_SECRET || process.env.WHATSPRO_API_TOKEN || 'dev';

app.set('trust proxy', true);
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));

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
  const sig = crypto.createHmac('sha256', process.env.WHATSPRO_SESSION_SECRET || 'dev').update(payload).digest('hex');
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
    const expected = crypto.createHmac('sha256', process.env.WHATSPRO_SESSION_SECRET || 'dev').update(payload).digest('hex');
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

function signChatToken(instanceId) {
  return crypto.createHmac('sha256', CHAT_ACCESS_SECRET).update(String(instanceId || '')).digest('hex');
}

function hasChatToken(req) {
  const instanceId = String(req.params?.instanceId || req.body?.instanceId || req.query?.instance || req.headers['x-chat-instance'] || '').trim();
  const token = String(req.headers['x-chat-token'] || req.query?.chatToken || '');
  return Boolean(instanceId && token && safeEqual(token, signChatToken(instanceId)));
}

function requireApi(req, res, next) {
  if (hasApiToken(req)) return next();
  return res.status(401).json({ error: 'AUTH_REQUIRED' });
}

function requireUiOrApi(req, res, next) {
  if (hasApiToken(req) || readSession(req) || hasChatToken(req)) return next();
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
    chatToken: signChatToken(tenant.instance || instance),
    endpoints: {
      inbox: '/api/chat/inbox',
      history: '/api/chat/history',
      send: '/api/chat/send',
      media: '/api/chat/media',
      action: '/api/chat/action'
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

  const createdAt = Number(entry.createdAt || Date.now());
  await Promise.all([
    redisClient.sendCommand(['RPUSH', chatHistoryKey(instanceId, phone), JSON.stringify({ ...entry, createdAt })]),
    redisClient.sendCommand(['ZADD', chatInboxKey(instanceId), String(createdAt), phone])
  ]);
  await expireChatKeys(instanceId, phone, await chatTtlSeconds(instanceId, phone));
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
  const key = chatInboxKey(instanceId);
  try {
    const rows = await redisClient.sendCommand(['ZREVRANGE', key, '0', String(limit - 1), 'WITHSCORES']);
    const entries = [];
    for (let i = 0; i < rows.length; i += 2) {
      const phone = normalizePhone(String(rows[i] || '').split(',')[0]);
      if (isValidChatPhone(phone)) entries.push({ phone, updatedAt: Number(rows[i + 1]) || 0 });
    }
    return entries;
  } catch (error) {
    const rows = await redisClient.sendCommand(['LRANGE', key, '0', String(limit - 1)]).catch(() => []);
    return rows.map(parseInboxListEntry).filter(Boolean);
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
  if (req.query.instance) {
    return renderChatHtml(req, res).catch(error => {
      console.error('[CHAT] render failed:', error?.stack || error?.message || error);
      res.status(500).send('Chat render failed');
    });
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
  if (!safeEqual(username, process.env.WHATSPRO_USER || 'admin') || !safeEqual(password, process.env.WHATSPRO_PASSWORD || 'change-me')) {
    return res.status(401).json({ error: 'INVALID_CREDENTIALS' });
  }
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
  const candidates = [];
  const seen = new Set();

  for (const row of inboxRows) {
    const phone = normalizePhone(row.phone);
    if (!isValidChatPhone(phone) || seen.has(phone)) continue;
    seen.add(phone);
    candidates.push({ phone, updatedAt: Number(row.updatedAt) || 0 });
    if (candidates.length >= limit) break;
  }

  const [archiveRows, histories, openbotHistories, viewedScores] = await Promise.all([
    redisClient.sendCommand(['SMEMBERS', chatArchiveKey(instanceId)]).catch(() => []),
    Promise.all(candidates.map(item => redisClient.sendCommand(['LRANGE', chatHistoryKey(instanceId, item.phone), '-80', '-1']).catch(() => []))),
    Promise.all(candidates.map(item => redisClient.sendCommand(['LRANGE', openbotHistoryKey(instanceId, item.phone), '-80', '-1']).catch(() => []))),
    Promise.all(candidates.map(item => redisClient.sendCommand(['ZSCORE', chatViewedKey(instanceId), item.phone]).catch(() => null)))
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
    items.push(summary);
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
  
  const [chatRows, openbotRows] = await Promise.all([
    redisClient.sendCommand(['LRANGE', chatHistoryKey(instanceId, phone), String(-limit), '-1']).catch(() => []),
    redisClient.sendCommand(['LRANGE', openbotHistoryKey(instanceId, phone), String(-limit), '-1']).catch(() => [])
  ]);
  
  const chatHistory = chatRows.map(parseHistoryEntry).filter(Boolean).map(normalizeChatEntry);
  const openbotHistory = openbotRows
    .map(parseHistoryEntry)
    .filter(Boolean)
    .filter(entry => ['assistant', 'model', 'operator'].includes(String(entry.role || '').toLowerCase()))
    .map(normalizeChatEntry);
    
  const history = [...chatHistory, ...openbotHistory]
    .sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0))
    .slice(-limit);

  res.json({ success: true, instanceId, phone, history });
});

app.get('/api/chat/media/:instanceId/:messageId', requireUiOrApi, async (req, res) => {
  const instanceId = String(req.params.instanceId || '').trim();
  const messageId = String(req.params.messageId || '').trim();
  if (!isValidInstanceId(instanceId)) return res.status(400).json({ error: 'BAD_INSTANCE_ID' });
  if (!messageId || messageId.length > 200 || /[\s/\\]/.test(messageId)) return res.status(400).json({ error: 'BAD_MESSAGE_ID' });

  const persisted = await redisClient.sendCommand(['GET', chatMediaKey(instanceId, messageId)]).catch(() => '');
  const mediaData = persisted ? '' : await getBase64Media(instanceId, messageId);
  const result = persisted || mediaData;
  if (result && !persisted) {
    await redisClient.sendCommand(['SET', chatMediaKey(instanceId, messageId), result, 'EX', String(CHAT_ARCHIVE_TTL_SECONDS)]).catch(() => 0);
  }
  if (!result) return res.status(404).json({ error: 'MEDIA_NOT_FOUND' });
  res.json({ success: true, instanceId, messageId, mediaData: result });
});

app.get('/api/chat/operator-lock/:instanceId/:phone', requireUiOrApi, async (req, res) => {
  const instanceId = String(req.params.instanceId || '').trim();
  const phone = normalizePhone(req.params.phone || '');
  if (!isValidInstanceId(instanceId)) return res.status(400).json({ error: 'BAD_INSTANCE_ID' });
  if (!isValidChatPhone(phone)) return res.status(400).json({ error: 'BAD_PHONE' });
  if (!redisClient.isOpen) return res.status(503).json({ error: 'REDIS_NOT_CONNECTED' });

  const ttl = await redisClient.sendCommand(['TTL', operatorActiveKey(instanceId, phone)]).catch(() => -2);
  res.json({ success: true, instanceId, phone, ttl: Math.max(0, Number(ttl) || 0), total: OPERATOR_ACTIVE_SECONDS });
});

app.post('/api/chat/action/:instanceId/:phone', requireUiOrApi, async (req, res) => {
    const instanceId = String(req.params.instanceId || '').trim();
    const phone = normalizePhone(req.params.phone || '');
    const action = req.body?.action;

    if (!isValidInstanceId(instanceId)) return res.status(400).json({ error: 'BAD_INSTANCE_ID' });
    if (!isValidChatPhone(phone)) return res.status(400).json({ error: 'BAD_PHONE' });

    if (!redisClient.isOpen) return res.status(503).json({ error: 'REDIS_NOT_CONNECTED' });

    if (action === 'view') {
        const viewedAt = Date.now();
        await Promise.all([
            redisClient.sendCommand(['ZADD', chatViewedKey(instanceId), String(viewedAt), phone]),
            redisClient.sendCommand(['ZADD', chatInboxKey(instanceId), String(viewedAt), phone])
        ]);
    } else if (action === 'close') {
        await Promise.all([
            redisClient.sendCommand(['SADD', chatArchiveKey(instanceId), phone]),
            redisClient.sendCommand(['SET', chatArchiveMarkerKey(instanceId, phone), '1', 'EX', String(CHAT_ARCHIVE_TTL_SECONDS)]),
            redisClient.sendCommand(['ZREM', chatViewedKey(instanceId), phone]).catch(() => 0),
            expireChatKeys(instanceId, phone, CHAT_ARCHIVE_TTL_SECONDS)
        ]);
    } else if (action === 'restore') {
        await Promise.all([
            redisClient.sendCommand(['SREM', chatArchiveKey(instanceId), phone]),
            redisClient.sendCommand(['DEL', chatArchiveMarkerKey(instanceId, phone)]),
            expireChatKeys(instanceId, phone, CHAT_STANDARD_TTL_SECONDS)
        ]);
    } else if (action === 'delete') {
        await Promise.all([
            redisClient.sendCommand(['SADD', chatArchiveKey(instanceId), phone]),
            redisClient.sendCommand(['SET', chatArchiveMarkerKey(instanceId, phone), '1', 'EX', String(CHAT_ARCHIVE_TTL_SECONDS)])
        ]);
        const allMembers = await redisClient.sendCommand(['ZRANGE', chatInboxKey(instanceId), '0', '-1']).catch(() => []);
        const membersToDelete = allMembers.filter(m => m.startsWith(phone));
        if (membersToDelete.length) {
            await redisClient.sendCommand(['ZREM', chatInboxKey(instanceId), ...membersToDelete]);
        } else {
            await redisClient.sendCommand(['ZREM', chatInboxKey(instanceId), phone]).catch(() => 0);
        }
        await redisClient.sendCommand(['ZREM', chatViewedKey(instanceId), phone]).catch(() => 0);
        await redisClient.sendCommand(['DEL', chatHistoryKey(instanceId, phone)]);
        await redisClient.sendCommand(['DEL', openbotHistoryKey(instanceId, phone)]).catch(() => 0);
        await Promise.all([
            redisClient.sendCommand(['SREM', chatArchiveKey(instanceId), phone]).catch(() => 0),
            redisClient.sendCommand(['DEL', chatArchiveMarkerKey(instanceId, phone)]).catch(() => 0)
        ]);
    } else {
        return res.status(400).json({ error: 'BAD_ACTION' });
    }
    res.json({ success: true });
});

app.post('/api/chat/send/:instanceId/:phone', requireUiOrApi, async (req, res) => {
    const instanceId = String(req.params.instanceId || '').trim();
    const phone = String(req.params.phone || '').replace(/\D/g, '');
    const { text } = req.body || {};

    if (!isValidInstanceId(instanceId)) return res.status(400).json({ error: 'BAD_INSTANCE_ID' });
    if (!isValidChatPhone(phone)) return res.status(400).json({ error: 'BAD_PHONE' });
    if (!text) return res.status(400).json({ error: 'TEXT_REQUIRED' });

    const ok = await sendWhatsAppText(instanceId, phone, text);
    
    if (ok) {
        await Promise.all([
            markOperatorActive(instanceId, phone, 'operator_panel'),
            redisClient.isOpen ? redisClient.sendCommand(['SET', `mute:${instanceId}:${phone}`, 'muted_by_operator_panel', 'EX', String(OPERATOR_ACTIVE_SECONDS)]).catch(() => null) : Promise.resolve(null)
        ]);
        await saveChatHistoryEntry(instanceId, phone, {
            id: `operator:${Date.now()}:${phone}`,
            instanceId,
            phone,
            direction: 'outgoing',
            fromMe: true,
            role: 'operator',
            text,
            body: text,
            type: 'chat',
            source: 'operator_panel'
        });
    }

    res.status(ok ? 200 : 503).json({ success: Boolean(ok) });
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

app.post('/api/send', requireApi, async (req, res) => {
  const { instanceId, phone, text, media } = req.body || {};
  
  if (!isValidInstanceId(instanceId)) return res.status(400).json({ error: 'BAD_INSTANCE_ID' });
  if (!phone) return res.status(400).json({ error: 'PHONE_REQUIRED' });

  // 1-ӨЗГЕРІС: Міндетті түрде телефонды нормализациялау (RC-7 шешімі)
  // Бұл 8707, +7707 форматтарының барлығын таза 7707... форматына әкеледі.
  const cleanPhone = normalizePhone(phone);
  if (!isValidChatPhone(cleanPhone)) return res.status(400).json({ error: 'INVALID_PHONE_FORMAT' });

  let ok = true;
  
  // 2-ӨЗГЕРІС: Медиа жіберу логикасын қауіпсіздендіру және cleanPhone қолдану
  if (media) {
    if (media.base64) {
      ok = await sendMedia(instanceId, cleanPhone, media.base64, media.fileName || media.mimeType || 'file', media.caption || text || '');
    } else {
      console.warn(`[API:SEND] Warning: Media object received but missing 'base64' property for phone ${cleanPhone}`);
      // Егер медиа қате болса, бірақ мәтін болса, құламай мәтінді жібереміз
      if (text) ok = await sendWhatsAppText(instanceId, cleanPhone, text);
      else return res.status(400).json({ error: 'INVALID_MEDIA_PAYLOAD' });
    }
  } else if (text) {
    ok = await sendWhatsAppText(instanceId, cleanPhone, text);
  } else {
    return res.status(400).json({ error: 'TEXT_OR_MEDIA_REQUIRED' });
  }

  if (ok && (text || media)) {
    await saveChatHistoryEntry(instanceId, cleanPhone, {
      id: `api:${Date.now()}:${cleanPhone}`,
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
      source: 'api_send'
    });
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
  await connectRedis();
  
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

  app.listen(PORT, () => console.log(`[WhatsPro] listening on :${PORT}`));
}

process.on('SIGTERM', async () => {
  await shutdownWhatsAppClients().catch(() => {});
  process.exit(0);
});

boot().catch(error => {
  console.error('[WhatsPro] boot failed:', error);
  process.exit(1);
});
