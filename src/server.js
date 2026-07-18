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
  shutdownWhatsAppClients
} = require('../services/whatsappManager');
const { normalizePhone } = require('../services/phoneUtils');
const { markOperatorActive } = require('../services/operatorLock');
const { getTenantChatConfig } = require('../services/nocodbConfig');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const INSTANCE_STORE_KEY = 'whatspro:instances';
const SCAN_REQUESTS_KEY = 'whatspro:scan-requests';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const CHAT_HTML_PATH = path.join(PUBLIC_DIR, 'chat.html');

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
      send: '/api/chat/send'
    }
  };
  const html = await fs.readFile(CHAT_HTML_PATH, 'utf8');
  const script = `<script>window.__CHAT_CONFIG__=${safeJsonForScript(config)};</script>`;
  res.type('html').send(html.replace('<!--__CHAT_CONFIG__-->', script));
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

async function saveChatHistoryEntry(instanceId, phone, entry) {
  if (!redisClient.isOpen) return;

  const createdAt = Number(entry.createdAt || Date.now());
  await Promise.all([
    redisClient.sendCommand(['RPUSH', chatHistoryKey(instanceId, phone), JSON.stringify({ ...entry, createdAt })]),
    redisClient.sendCommand(['ZADD', chatInboxKey(instanceId), String(createdAt), phone])
  ]);
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
  if (!phone) return res.status(400).json({ error: 'BAD_PHONE' });
  if (!redisClient.isOpen) return res.status(503).json({ error: 'REDIS_NOT_CONNECTED' });

  const limit = parseLimit(req.query.limit, 200, 1000);
  
  const [chatRows, openbotRows] = await Promise.all([
    redisClient.sendCommand(['LRANGE', chatHistoryKey(instanceId, phone), String(-limit), '-1']),
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

app.post('/api/chat/action/:instanceId/:phone', requireUiOrApi, async (req, res) => {
    const instanceId = String(req.params.instanceId || '').trim();
    const phone = String(req.params.phone || '').replace(/\D/g, '');
    const action = req.body?.action;

    if (!isValidInstanceId(instanceId)) return res.status(400).json({ error: 'BAD_INSTANCE_ID' });
    if (!phone) return res.status(400).json({ error: 'BAD_PHONE' });

    if (action === 'close') {
        await redisClient.sendCommand(['SADD', `chatwoot:archive:${instanceId}`, phone]);
    } else if (action === 'restore') {
        await redisClient.sendCommand(['SREM', `chatwoot:archive:${instanceId}`, phone]);
    } else if (action === 'delete') {
        await redisClient.sendCommand(['SREM', `chatwoot:archive:${instanceId}`, phone]);
        const allMembers = await redisClient.sendCommand(['ZRANGE', chatInboxKey(instanceId), '0', '-1']);
        const membersToDelete = allMembers.filter(m => m.startsWith(phone));
        if (membersToDelete.length > 0) {
            await redisClient.sendCommand(['ZREM', chatInboxKey(instanceId), ...membersToDelete]);
        }
        await redisClient.sendCommand(['DEL', `chatwoot:history:${instanceId}:${phone}`]);
    }
    res.json({ success: true });
});

app.post('/api/chat/send/:instanceId/:phone', requireUiOrApi, async (req, res) => {
    const instanceId = String(req.params.instanceId || '').trim();
    const phone = String(req.params.phone || '').replace(/\D/g, '');
    const { text } = req.body || {};

    if (!isValidInstanceId(instanceId)) return res.status(400).json({ error: 'BAD_INSTANCE_ID' });
    if (!phone) return res.status(400).json({ error: 'BAD_PHONE' });
    if (!text) return res.status(400).json({ error: 'TEXT_REQUIRED' });

    const ok = await sendWhatsAppText(instanceId, phone, text);
    
    if (ok) {
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
  if (!cleanPhone) return res.status(400).json({ error: 'INVALID_PHONE_FORMAT' });

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

  if (ok && text) {
    await saveChatHistoryEntry(instanceId, cleanPhone, {
      id: `api:${Date.now()}:${cleanPhone}`,
      instanceId,
      phone: cleanPhone,
      direction: 'outgoing',
      fromMe: true,
      role: 'assistant',
      text,
      body: text,
      type: media ? 'media' : 'chat',
      source: 'api_send'
    });
  }

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
