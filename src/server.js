require('dotenv').config();

const crypto = require('crypto');
const express = require('express');
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

const app = express();
const PORT = Number(process.env.PORT || 3000);
const INSTANCE_STORE_KEY = 'whatspro:instances';

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
  return res.status(403).json({ error: 'FORBIDDEN' });
}

function requireUiOrApi(req, res, next) {
  if (hasApiToken(req) || readSession(req)) return next();
  return res.status(401).json({ error: 'AUTH_REQUIRED' });
}

function isValidInstanceId(value = '') {
  return /^[a-zA-Z0-9_-]{2,64}$/.test(String(value));
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

function chatHistoryKey(instanceId, phone) {
  return `chatwoot:history:${instanceId}:${phone}`;
}

function chatInboxKey(instanceId) {
  return `chatwoot:inbox:${instanceId}`;
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

app.get('/health', (req, res) => res.json({ ok: true, service: 'whatspro' }));

app.get(['/whatspro', '/'], (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'whatspro.html'));
});

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

app.get('/api/chat/inbox/:instanceId', requireUiOrApi, async (req, res) => {
  const instanceId = String(req.params.instanceId || '').trim();
  if (!isValidInstanceId(instanceId)) return res.status(400).json({ error: 'BAD_INSTANCE_ID' });
  if (!redisClient.isOpen) return res.status(503).json({ error: 'REDIS_NOT_CONNECTED' });

  const limit = parseLimit(req.query.limit, 100, 500);
  const rows = await redisClient.sendCommand(['ZREVRANGE', chatInboxKey(instanceId), '0', String(limit - 1), 'WITHSCORES']);
  const items = [];
  for (let i = 0; i < rows.length; i += 2) {
    items.push({ phone: rows[i], updatedAt: Number(rows[i + 1]) || 0 });
  }

  res.json({ success: true, instanceId, phones: items.map(item => item.phone), items });
});

app.get('/api/chat/history/:instanceId/:phone', requireUiOrApi, async (req, res) => {
  const instanceId = String(req.params.instanceId || '').trim();
  const phone = normalizePhone(req.params.phone || '');
  if (!isValidInstanceId(instanceId)) return res.status(400).json({ error: 'BAD_INSTANCE_ID' });
  if (!phone) return res.status(400).json({ error: 'BAD_PHONE' });
  if (!redisClient.isOpen) return res.status(503).json({ error: 'REDIS_NOT_CONNECTED' });

  const limit = parseLimit(req.query.limit, 200, 1000);
  const rows = await redisClient.sendCommand(['LRANGE', chatHistoryKey(instanceId, phone), String(-limit), '-1']);
  const history = rows.map(parseHistoryEntry).filter(Boolean);

  res.json({ success: true, instanceId, phone, history });
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
  res.json(await getInstanceStatus(instanceId));
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

  let ok = true;
  if (media?.base64) {
    ok = await sendMedia(instanceId, phone, media.base64, media.fileName || media.mimeType || 'file', media.caption || text || '');
  } else if (text) {
    ok = await sendWhatsAppText(instanceId, phone, text);
  } else {
    return res.status(400).json({ error: 'TEXT_OR_MEDIA_REQUIRED' });
  }

  res.status(ok ? 200 : 503).json({ success: Boolean(ok) });
});

async function boot() {
  await connectRedis();
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
