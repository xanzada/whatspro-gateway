require('dotenv').config();

const crypto = require('crypto');
const axios = require('axios');
const express = require('express');
const fs = require('fs/promises');
const path = require('path');
const { connectRedis, redisClient, getRedisState } = require('../config/redis');
const {
  startWhatsAppInstance,
  startSessionSupervisor,
  stopWhatsAppInstance,
  getInstanceStatus,
  sendWhatsAppText,
  sendMedia,
  sendPresence,
  getBase64Media,
  recoverChatMedia,
  shutdownWhatsAppClients,
  getCallWatcherQr,
  usesSingleQr
} = require('../services/whatsappManager');
const qrcode = require('qrcode');
const { callWatcherStatus } = require('../services/callWatcher');
const { isValidChatPhone, normalizePhone } = require('../services/phoneUtils');
const { OPERATOR_ACTIVE_SECONDS, markOperatorActive, operatorActiveKey } = require('../services/operatorLock');
const { chatStore, MAX_MEDIA_BYTES } = require('../services/chatStore');
const { sosStore } = require('../services/sosStore');
const llmWorkspace = require('../services/llmWorkspace');
const runtimeSettings = require('../services/runtimeSettings');
const { publishChatEvent, subscribeChatEvents } = require('../services/chatEvents');
const { createChatMediaHandler } = require('../services/chatMedia');
const { parseScoredMembers, scanKeys } = require('../services/redisReply');
// Called through the module object rather than destructured so the tenant-token
// lookup stays a seam the isolation tests can stand in for.
const tenantStore = require('../services/tenantStore');
const tenantMemoryStore = require('../services/tenantMemoryStore');
const tenantReadiness = require('../services/tenantReadiness');
const { evaluateAll } = tenantReadiness;
const tenantAdmin = require('../services/tenantAdmin');
const tenantWorkbook = require('../services/tenantWorkbook');
const { allowsPhone, getTestModePolicy } = require('../services/testModePolicy');
const { getOpenBotWebhookUrl, startIncomingWalWorker } = require('../services/incomingWebhook');
const { incomingWalSummary } = require('../services/incomingWal');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const INSTANCE_STORE_KEY = 'whatspro:instances';
const SCAN_REQUESTS_KEY = 'whatspro:scan-requests';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const CHAT_HTML_PATH = path.join(PUBLIC_DIR, 'chat.html');
const CHAT_STANDARD_TTL_SECONDS = 24 * 60 * 60;
const CHAT_ARCHIVE_TTL_SECONDS = 72 * 60 * 60;
const SESSION_SECRET = process.env.WHATSPRO_SESSION_SECRET || process.env.WHATSPRO_API_TOKEN || crypto.randomBytes(32).toString('hex');
const MIN_ADMIN_PASSWORD_LENGTH = 10;
const SSE_MAX_LIFETIME_MS = 60 * 60 * 1000;
const CHAT_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
// A chat token that has just aged out may still buy its own replacement. The panel
// lives inside the Hub iframe and has no login of its own, so demanding an admin
// session on renewal would strand the operator behind a silent 401 (that is exactly
// what the 24h TTL used to do). A validly signed token is proof the caller already
// held one, and third-party cookies are blocked in many browsers, so this - not a
// cookie - is the primary renewal proof.
const CHAT_TOKEN_RENEWAL_GRACE_MS = 30 * 24 * 60 * 60 * 1000;
// The panel grant is the cookie half of the same proof, for the case where the tab
// was reloaded without a token to hand back. 30 days, so the operator never logs in
// again during normal work.
const PANEL_GRANT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CONNECT_TOKEN_TTL_MS = 72 * 60 * 60 * 1000;
const CONNECT_RATE_WINDOW_SECONDS = 10 * 60;
const CONNECT_RATE_LIMIT = 480;
const loginAttempts = new Map();
const operatorEffectJobs = new Map();
const sendCompletionJobs = new Map();
const liveSendWalPaths = new Set();
// Ambiguous sends are kept on disk as a terminal record, so they are reported once
// instead of on every 5s recovery pass.
const ambiguousSendWalLogged = new Set();
// An intent record this process did not write is only orphaned once it is old enough
// that no in-flight send could still own it.
const SEND_INTENT_STALE_MS = Math.max(1000, Number(process.env.WHATSPRO_SEND_INTENT_STALE_MS || 120000));
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
  ambiguousSendWalLogged.delete(walPath);
}

// A send whose outcome WhatsApp never confirmed must not stay in `phase:'intent'`:
// recovery cannot resolve it and would refuse to finish, which blocks every operator
// send for every tenant. Recording it as a terminal `ambiguous` phase keeps the
// per-requestId duplicate guard (the WAL pre-check in the send route plus the pending
// idempotency lease) while letting recovery complete.
async function markSendWalAmbiguous(record, reason) {
  const walPath = await writeSendWal({ ...record, phase: 'ambiguous', reason, ambiguousAt: Date.now() });
  console.error(`[CHAT SEND WAL] ambiguous outcome recorded ${record.instanceId}/${record.phone}: ${reason}`);
  ambiguousSendWalLogged.add(walPath);
  return walPath;
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

function incomingApiToken(req) {
  return String(req.headers.authorization || '').replace(/^Bearer\s+/i, '')
    || String(req.headers['x-api-key'] || '');
}

// The gateway-wide token belongs to the operator of the platform: it is what
// Openbot carries and it reaches every instance. A restaurant's own token comes
// from its platform tenant record and unlocks that instance only, so handing a tenant their
// key can never expose the other tenants' chats.
function hasMasterApiToken(req) {
  const expected = process.env.WHATSPRO_API_TOKEN || '';
  return Boolean(expected) && safeEqual(incomingApiToken(req), expected);
}

function requireMasterApi(req, res, next) {
  if (!hasMasterApiToken(req)) return res.status(401).json({ error: 'AUTH_REQUIRED' });
  req.apiAuth = { scope: 'master' };
  return next();
}

function requestedInstanceId(req) {
  const candidate = req.params?.instanceId || req.body?.instanceId || req.query?.instance || req.headers['x-chat-instance'] || '';
  const instanceId = String(candidate).trim();
  return isValidInstanceId(instanceId) ? instanceId : '';
}

async function hasApiToken(req) {
  const incoming = incomingApiToken(req);
  if (!incoming) return false;
  if (hasMasterApiToken(req)) {
    req.apiAuth = { scope: 'master' };
    return true;
  }

  // Without a named instance there is nothing to scope to — listing every
  // instance stays an owner-only action.
  const instanceId = requestedInstanceId(req);
  if (!instanceId) return false;
  const tenantToken = await tenantStore.getTenantApiToken(instanceId).catch(() => '');
  if (!tenantToken || !safeEqual(incoming, tenantToken)) return false;
  req.apiAuth = { scope: 'tenant', instanceId };
  return true;
}

// On /api/send the body is parsed after authentication — a 23mb parse must not
// run for an unauthenticated caller — so a tenant token names its instance in a
// header. That leaves a gap the header alone cannot close: nothing stops a
// request authenticating as beta and then asking, in the parsed body, to send as
// alpha. This is where the two are made to agree.
function withinApiScope(req, instanceId) {
  const auth = req.apiAuth;
  if (!auth || auth.scope === 'master') return true;
  return auth.instanceId === String(instanceId || '').trim();
}

function issueChatToken(instanceId, expiresAt = Date.now() + CHAT_TOKEN_TTL_MS) {
  const payload = Buffer.from(`${instanceId}:${expiresAt}`).toString('base64url');
  const signature = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function hasScopedChatToken(req, tokenOverride = '') {
  try {
    const incoming = String(tokenOverride || req.headers['x-chat-token'] || req.query?.token || '');
    const [payload, signature, extra] = incoming.split('.');
    if (!payload || !signature || extra) return false;
    const expectedSignature = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
    if (!safeEqual(signature, expectedSignature)) return false;
    const decoded = Buffer.from(payload, 'base64url').toString('utf8');
    const separator = decoded.lastIndexOf(':');
    if (separator < 1) return false;
    const tokenInstance = decoded.slice(0, separator);
    const expiresAt = Number(decoded.slice(separator + 1));
    const requestedInstance = String(req.params?.instanceId || req.headers['x-chat-instance'] || '').trim();
    return isValidInstanceId(tokenInstance) && requestedInstance === tokenInstance && expiresAt > Date.now();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- panel grant
//
// WHY THIS EXISTS: /api/chat/session/:instanceId used to mint a 24h instance-scoped
// chat token for anyone who asked, with no credential at all. That token satisfies
// requireChatUiOrApi, so the open internet could read every restaurant's chats and
// receipt PDFs, send WhatsApp as the restaurant, and delete conversations
// (reproduced from the public endpoint 2026-08-22). The panel still must not ask an
// operator to log in - it is framed by hub.alemi.kz and has no login of its own -
// so the mint now requires proof of prior legitimate access instead of a password.

function issuePanelGrant(instanceId, expiresAt = Date.now() + PANEL_GRANT_TTL_MS) {
  const payload = Buffer.from(`${instanceId}:${expiresAt}`).toString('base64url');
  const signature = crypto.createHmac('sha256', SESSION_SECRET).update(`panel:${payload}`).digest('base64url');
  return `${payload}.${signature}`;
}

function hasPanelGrant(req, instanceId) {
  try {
    const raw = String(parseCookies(req).whatspro_panel || '');
    const [payload, signature, extra] = raw.split('.');
    if (!payload || !signature || extra) return false;
    const expected = crypto.createHmac('sha256', SESSION_SECRET).update(`panel:${payload}`).digest('base64url');
    if (!safeEqual(signature, expected)) return false;
    const decoded = Buffer.from(payload, 'base64url').toString('utf8');
    const separator = decoded.lastIndexOf(':');
    if (separator < 1) return false;
    const grantInstance = decoded.slice(0, separator);
    const expiresAt = Number(decoded.slice(separator + 1));
    return grantInstance === String(instanceId) && expiresAt > Date.now();
  } catch {
    return false;
  }
}

function setPanelGrant(res, instanceId) {
  // SameSite=None is required for the cookie to travel inside the Hub iframe, and
  // the browser only accepts it together with Secure. Behind Traefik the browser
  // sees HTTPS; in tests and local http there is no TLS, so fall back to Lax
  // rather than emit a cookie the browser silently drops.
  const crossSite = process.env.NODE_ENV === 'production';
  res.cookie('whatspro_panel', issuePanelGrant(instanceId), {
    httpOnly: true,
    sameSite: crossSite ? 'none' : 'lax',
    secure: crossSite,
    maxAge: PANEL_GRANT_TTL_MS,
    path: '/'
  });
}

// A chat token whose signature is ours and whose instance matches, accepted even
// after expiry but only inside the renewal grace window. Renewal proof only -
// never call this to authorise data access.
function hasRenewableChatToken(req, instanceId) {
  try {
    const incoming = String(req.headers['x-chat-token'] || req.query?.token || '');
    const [payload, signature, extra] = incoming.split('.');
    if (!payload || !signature || extra) return false;
    const expected = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
    if (!safeEqual(signature, expected)) return false;
    const decoded = Buffer.from(payload, 'base64url').toString('utf8');
    const separator = decoded.lastIndexOf(':');
    if (separator < 1) return false;
    const tokenInstance = decoded.slice(0, separator);
    const expiresAt = Number(decoded.slice(separator + 1));
    if (tokenInstance !== String(instanceId)) return false;
    return Number.isFinite(expiresAt) && Date.now() - expiresAt < CHAT_TOKEN_RENEWAL_GRACE_MS;
  } catch {
    return false;
  }
}

function isLoopbackRequest(req) {
  const raw = String(req.ip || req.socket?.remoteAddress || '');
  const host = raw.replace(/^::ffff:/, '');
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

function issueConnectToken(instanceId, expiresAt = Date.now() + CONNECT_TOKEN_TTL_MS) {
  const payload = Buffer.from(JSON.stringify({
    v: 1,
    scope: 'wa-connect',
    instanceId,
    expiresAt,
    nonce: crypto.randomBytes(12).toString('hex')
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function readConnectToken(token) {
  try {
    const [payload, signature, extra] = String(token || '').split('.');
    if (!payload || !signature || extra) return null;
    const expected = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
    if (!safeEqual(signature, expected)) return null;
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (parsed?.v !== 1 || parsed?.scope !== 'wa-connect') return null;
    if (!isValidInstanceId(parsed.instanceId) || Number(parsed.expiresAt) <= Date.now()) return null;
    return { instanceId: parsed.instanceId, expiresAt: Number(parsed.expiresAt) };
  } catch {
    return null;
  }
}

async function allowConnectPoll(req, token) {
  if (!redisClient.isOpen) return false;
  const fingerprint = crypto.createHash('sha256')
    .update(`${String(req.ip || '')}:${String(token || '')}`)
    .digest('hex')
    .slice(0, 32);
  const key = `whatspro:connect-rate:${fingerprint}`;
  const count = Number(await redisClient.incr(key));
  if (count === 1) await redisClient.expire(key, CONNECT_RATE_WINDOW_SECONDS);
  return count <= CONNECT_RATE_LIMIT;
}

function hasChatMediaToken(req) {
  const expected = process.env.WHATSPRO_API_TOKEN || '';
  const incoming = String(req.headers['x-chat-token'] || '') || String(req.query?.token || '');
  return Boolean((expected && incoming && safeEqual(incoming, expected)) || hasScopedChatToken(req, incoming));
}

// requireUiOrApi accepts a tenant's own token whenever the request names that
// tenant. That is right for reading and for the tenant's own settings, but four
// routes are platform-shaped: deleting the record (row + session + every Redis key),
// cloning a NEW instance id into the registry, rotating the credential Openbot
// holds, and approving a scan request. A leaked restaurant key could do all four
// irreversibly (found 2026-08-22), so they require the platform, not the tenant.
async function requirePlatformAdmin(req, res, next) {
  if (readSession(req)) return next();
  return requireMasterApi(req, res, next);
}

async function requireApi(req, res, next) {
  if (await hasApiToken(req)) return next();
  return res.status(401).json({ error: 'AUTH_REQUIRED' });
}

async function requireUiOrApi(req, res, next) {
  if (readSession(req) || await hasApiToken(req)) return next();
  return res.status(401).json({ error: 'AUTH_REQUIRED' });
}

function requireUiSession(req, res, next) {
  if (readSession(req)) return next();
  return res.status(401).json({ error: 'ADMIN_SESSION_REQUIRED' });
}

async function requireChatUiOrApi(req, res, next) {
  if (readSession(req) || hasScopedChatToken(req) || await hasApiToken(req)) return next();
  return res.status(401).json({ error: 'AUTH_REQUIRED' });
}

async function requireChatMediaAuth(req, res, next) {
  if (readSession(req) || hasChatMediaToken(req) || await hasApiToken(req)) return next();
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
  const configured = String(process.env.WHATSPRO_PUBLIC_URL || process.env.CHAT_PUBLIC_API_BASE || '').trim().replace(/\/+$/, '');
  if (configured) return configured;
  return `${req.protocol}://${req.get('host')}`;
}

function chatParentOrigin() {
  const fallback = 'https://hub.alemi.kz';
  try {
    const url = new URL(String(process.env.CHAT_PARENT_ORIGIN || fallback).trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return fallback;
    return url.origin;
  } catch (_) {
    return fallback;
  }
}

// Cache-bust the panel's static bundles with the process start time: operators
// keep the panel open for days, and a stale chat.js stranded already-shipped
// fixes (live complaint 2026-08-21: buttons and PDF "still broken" long after
// the server was fixed - the tab simply never reloaded the code).
const CHAT_ASSET_VERSION = String(Date.now());

async function renderChatHtml(req, res) {
  const requested = String(req.query.instance || '').trim();
  if (!isValidInstanceId(requested)) return res.status(400).json({ error: 'BAD_INSTANCE_ID' });
  // The hub's integration page links here with ITS identifier (alemi_instance), and this
  // shell used to look the tenant up by instance_id only - so the PAGE answered 404 before
  // any API call could happen. The first version of this fix covered the ten /api/chat/*
  // routes and missed this one, which is why it looked fixed under curl and was still
  // broken in a browser (found 2026-08-23).
  //
  // Everything below is built from the canonical id on purpose: issueChatToken and
  // setPanelGrant bind to it, and hasScopedChatToken compares the token's instance to the
  // canonicalised route param. A shell holding a "kebab1" token against a "kabab-1" route
  // would have every request it makes rejected.
  const instance = (await tenantStore.resolveInstanceAlias(requested).catch(() => null)) || requested;
  const tenant = await tenantStore.getTenantChatConfig(instance);
  if (!tenant?.found) return res.status(404).json({ error: 'TENANT_NOT_FOUND' });
  const config = {
    instance,
    branding: tenant.branding,
    chatToken: issueChatToken(instance),
    apiBase: publicApiBase(req),
    parentOrigin: chatParentOrigin(),
    endpoints: {
      inbox: '/api/chat/inbox',
      history: '/api/chat/history',
      send: '/api/chat/send',
      media: '/api/chat/media',
      session: '/api/chat/session',
      action: '/api/chat/action',
      lock: '/api/chat/operator-lock',
      events: '/api/chat/events'
    }
  };
  const html = (await fs.readFile(CHAT_HTML_PATH, 'utf8'))
    .replace('src="/chat-core.js"', `src="/chat-core.js?v=${CHAT_ASSET_VERSION}"`)
    .replace('src="/chat.js"', `src="/chat.js?v=${CHAT_ASSET_VERSION}"`);
  // The shell render is the one moment the panel is known to be legitimate, so it
  // is where the 30-day renewal grant is handed out. The operator never sees a
  // login because of this line.
  setPanelGrant(res, instance);
  if (instance !== requested) res.set('X-Chat-Instance', instance);
  const script = `<script>window.__CHAT_CONFIG__=${safeJsonForScript(config)};</script>`;
  res.set({ 'Cache-Control': 'no-store, max-age=0', Pragma: 'no-cache', Expires: '0' });
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

// Ghost guard: a linked-device LID (or its digits form, which the panel
// produces) resolves to the real phone through the persisted lid map, so an
// old ghost chat merges into the real conversation instead of failing to load
// with BAD_PHONE (live bug, 2026-08-21).
function resolveChatPhoneParam(instanceId, rawPhone) {
  return chatStore.resolveLidPhone(instanceId, rawPhone).catch(() => normalizePhone(rawPhone));
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
  const value = Number(entry?.createdAt || entry?.timestamp || entry?.time || 0) || 0;
  // Legacy and OpenBot-written rows store seconds; chatStore and chat-core normalise the
  // same way, so without this the row scores near zero and sinks in the inbox ZSET.
  return value > 0 && value < 1e12 ? value * 1000 : value;
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
  return chatStore.appendMessageOnce(instanceId, phone, entry, {
    state,
    preserveStateOnDuplicate: true
  });
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
  const stored = await chatStore.appendMessageOnce(instanceId, phone, entry, {
    state: 'operator', preserveArchive: true, preserveStateOnDuplicate: true
  });
  if (stored.stale) return;
  // An operator reply means the SOS is being handled - resolve the marker so
  // the chat leaves the SOS column immediately and lives in "Оператор" until
  // the operator closes it. The marker used to survive for up to an hour and
  // pinned the chat in the SOS column even while the operator was answering
  // (operator request, 2026-08-20). The inbox refetch after the published
  // event picks up sos=false on its own.
  await sosStore.clear(instanceId, phone).catch(() => {});
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
  const events = [publishChatEvent({ type: 'chat.message', instanceId, phone, messageId: entry.id, state: stored.state || 'operator' })];
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

async function recoverSendWal(redis = redisClient) {
  if (!redis.isOpen) return;
  const files = await fs.readdir(SEND_WAL_DIR).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error));
  for (const file of files.filter(name => /^[a-f0-9]{64}\.json$/.test(name))) {
    const walPath = path.join(SEND_WAL_DIR, file);
    let record;
    try { record = JSON.parse(await fs.readFile(walPath, 'utf8')); } catch { continue; }
    if (record?.phase === 'intent' && liveSendWalPaths.has(walPath)) continue;
    if (record?.phase === 'intent') {
      // Left behind by a crash or by the previous release, which kept intent records
      // on the transport-failure paths. Retire it as ambiguous instead of refusing
      // to finish recovery.
      if (Date.now() - Number(record.operationStartedAt || 0) < SEND_INTENT_STALE_MS) continue;
      await markSendWalAmbiguous(record, 'orphaned intent record found during recovery')
        .catch(error => console.error('[CHAT SEND WAL] ambiguous record update failed:', error?.message || error));
      continue;
    }
    if (record?.phase === 'ambiguous') {
      // Terminal. Kept only as long as the idempotency lease that guards a retry of
      // the same requestId; once that is gone the record has nothing left to protect.
      const leaseKey = record?.lease?.key || '';
      const current = leaseKey ? String(await redis.sendCommand(['GET', leaseKey]).catch(() => '') || '') : '';
      if (!current) {
        await removeSendWal(walPath).catch(error => console.error('[CHAT SEND WAL] ambiguous cleanup failed:', error.message));
        continue;
      }
      if (!ambiguousSendWalLogged.has(walPath)) {
        console.error(`[CHAT SEND WAL] ambiguous outcome awaiting operator review ${record.instanceId}/${record.phone}: ${record.reason || 'unknown'}`);
        ambiguousSendWalLogged.add(walPath);
      }
      continue;
    }
    if (!record?.lease?.key || !record?.response || !record?.effectData?.effectKey) continue;
    const current = String(await redis.sendCommand(['GET', record.lease.key]).catch(() => ''));
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
      const recovered = Number(await redis.sendCommand(['EVAL', script, '3', record.lease.key, record.effectData.effectKey,
        OPERATOR_EFFECT_OUTBOX_KEY, completed, String(SEND_RESULT_TTL_SECONDS), JSON.stringify(record.effectData.payload), String(Date.now())]).catch(() => 0));
      if (recovered === 1) {
        await removeSendWal(walPath);
        scheduleOperatorSendEffects(record.effectData.payload, record.effectData.effectKey);
      }
    }
  }
}

async function sweepExpiredChatIndexes() {
  if (!redisClient.isOpen) return;
  for await (const key of scanKeys(redisClient, 'chatwoot:expiry:*')) {
    const instanceId = key.slice('chatwoot:expiry:'.length);
    if (isValidInstanceId(instanceId)) await chatStore.pruneExpired(instanceId);
  }
}

// One scan per instance per LEGACY_SCAN_INTERVAL_MS, shared by every poller. The
// result is only a list of phones to consider, so a slightly stale list costs nothing:
// a genuinely new chat arrives through the inbox index, which is not cached.
const LEGACY_SCAN_INTERVAL_MS = Number(process.env.WHATSPRO_LEGACY_SCAN_INTERVAL_MS || 60000);
const legacyScanCache = new Map();

async function cachedLegacyHistoryKeys(instanceId) {
  const cached = legacyScanCache.get(instanceId);
  if (cached && Date.now() - cached.at < LEGACY_SCAN_INTERVAL_MS) return cached.rows;
  // A scan already in flight is shared rather than duplicated, so N concurrent polls
  // cause one scan.
  if (cached?.pending) return cached.pending;
  const pending = (async () => {
    const rows = [];
    for await (const key of scanKeys(redisClient, `history:${instanceId}:*`)) {
      const phone = normalizePhone(key.slice(`history:${instanceId}:`.length));
      if (isValidChatPhone(phone)) rows.push({ phone, updatedAt: 0 });
    }
    legacyScanCache.set(instanceId, { at: Date.now(), rows });
    return rows;
  })();
  legacyScanCache.set(instanceId, { at: cached?.at || 0, rows: cached?.rows || [], pending });
  try {
    return await pending;
  } catch (error) {
    legacyScanCache.delete(instanceId);
    console.warn(`[CHAT INBOX] legacy scan failed for ${instanceId}:`, error?.message || error);
    return cached?.rows || [];
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
// The container healthcheck calls this over loopback, so loopback stays open.
// From anywhere else it needs a credential: it published the Redis host, the
// Openbot host, the tenant count and the instance ids that still need a QR scan -
// exactly the ids an attacker needs to ask for (2026-08-22).
app.get('/health/detailed', async (req, res, next) => {
  if (isLoopbackRequest(req)) return next();
  if (readSession(req) || await hasApiToken(req)) return next();
  return res.status(401).json({ error: 'AUTH_REQUIRED' });
}, async (req, res) => {
  const redis = getRedisState();
  const storage = await tenantStore.getStorageSummary().catch(error => ({
    backend: 'unavailable',
    tenants: 0,
    initialized: false,
    error: error.message
  }));
  const inboundWal = await incomingWalSummary().catch(error => ({
    pending: -1,
    error: error.message
  }));
  const openbotUrl = getOpenBotWebhookUrl();
  let openbot = { ok: false, target: openbotUrl ? 'configured' : 'missing', status: 'not_checked' };
  if (openbotUrl) {
    try {
      const healthUrl = new URL('/health', openbotUrl).toString();
      const response = await axios.get(healthUrl, { timeout: 3000, validateStatus: () => true });
      openbot = {
        ok: response.status >= 200 && response.status < 400 && response.data?.ok === true,
        target: new URL(openbotUrl).host,
        status: response.status
      };
    } catch (error) {
      openbot = {
        ok: false,
        target: (() => { try { return new URL(openbotUrl).host; } catch { return 'invalid'; } })(),
        status: error.message
      };
    }
  }
  const instances = await listInstances().catch(() => []);
  const sessions = await Promise.all(
    instances.map(item => getInstanceStatus(item.instanceId).catch(() => ({ status: 'unknown' })))
  );
  const connected = sessions.filter(item => item?.status === 'connected').length;
  // A tenant that has lost its pairing needs a person to walk to a phone, so it
  // is the one WhatsApp condition that must not read as healthy. Reported by
  // instance id, which is a name an operator can act on and not a secret.
  // `ok` stays true on purpose: the container healthcheck asserts it, and
  // restarting the gateway is never the fix for a QR scan nobody has done yet.
  const needsScan = instances
    .map((item, at) => ({ instanceId: item.instanceId, status: sessions[at]?.status }))
    .filter(item => item.status === 'qr_required' || item.status === 'qr_ready')
    .map(item => item.instanceId);
  res.json({
    ok: true,
    service: 'whatspro',
    mode: redis.ready && openbot.ok && needsScan.length === 0 ? 'healthy' : 'degraded',
    checks: {
      redis,
      tenantStorage: storage,
      openbot,
      inboundWal,
      whatsapp: {
        tenants: instances.length,
        connected,
        needsScan
      }
    }
  });
});
app.get('/favicon.ico', (_req, res) => res.status(204).end());

// The operator shell is public so the canonical URL and its static assets can
// always render. Data and mutation endpoints remain protected by
// requireUiOrApi and surface their own authorization errors inside the frame.
app.get('/chat.html', (req, res, next) => {
  renderChatHtml(req, res).catch(next);
});

// Renewal, not issuance: a panel left open past the 24h TTL heals itself instead
// of stranding archive, delete and PDF behind a silent 401. It is NOT public -
// the caller must already hold a panel grant, a renewable chat token, an admin
// session or an API token. Handing a token to an anonymous caller was a full
// cross-tenant takeover (fixed 2026-08-22).
// Rewrites an alemi_instance in the URL to the canonical instance_id, for every chat
// route, BEFORE auth runs. Order matters: the scoped chat token and the panel grant are
// both bound to req.params.instanceId, so resolving after auth would mint a token for
// "kebab1" while the grant cookie says "kabab-1" and the two would fight. Resolving here
// means the whole request - auth, storage keys, cookie - speaks one id.
async function resolveChatInstance(req, res, next) {
  const requested = String(req.params?.instanceId || '').trim();
  if (!isValidInstanceId(requested)) return res.status(400).json({ error: 'BAD_INSTANCE_ID' });
  let canonical = requested;
  try {
    canonical = (await tenantStore.resolveInstanceAlias(requested)) || requested;
  } catch {
    canonical = requested;
  }
  if (canonical !== requested) {
    req.params.instanceId = canonical;
    // The panel needs to know, so it can pin the canonical id for later requests instead
    // of re-resolving on every call.
    res.set('X-Chat-Instance', canonical);
  }
  req.chatInstanceRequested = requested;
  return next();
}

app.get('/api/chat/session/:instanceId', resolveChatInstance, async (req, res) => {
  const instanceId = String(req.params.instanceId || '').trim();
  if (!isValidInstanceId(instanceId)) return res.status(400).json({ error: 'BAD_INSTANCE_ID' });
  const entitled = hasPanelGrant(req, instanceId)
    || hasRenewableChatToken(req, instanceId)
    || readSession(req)
    || await hasApiToken(req);
  if (!entitled) return res.status(401).json({ error: 'AUTH_REQUIRED' });
  const tenant = await tenantStore.getTenantChatConfig(instanceId).catch(() => null);
  if (!tenant?.found) return res.status(404).json({ error: 'TENANT_NOT_FOUND' });
  // Renewing also refreshes the grant, so an operator who keeps the panel open
  // never falls off the 30-day window.
  setPanelGrant(res, instanceId);
  res.set({ 'Cache-Control': 'no-store, max-age=0' });
  return res.json({ chatToken: issueChatToken(instanceId), expiresIn: Math.floor(CHAT_TOKEN_TTL_MS / 1000) });
});

app.get('/whatspro', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'whatspro.html'));
});

app.get('/tenants', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'tenants.html'));
});

app.get('/call-watcher', async (req, res, next) => {
  try {
    const instance = String(req.query.instance || '').trim();
    if (!isValidInstanceId(instance)) return res.status(400).json({ error: 'BAD_INSTANCE_ID' });
    const tenant = await tenantStore.getTenantChatConfig(instance);
    if (!tenant?.found) return res.status(404).json({ error: 'TENANT_NOT_FOUND' });
    return res.sendFile(path.join(PUBLIC_DIR, 'callwatcher.html'));
  } catch (error) {
    return next(error);
  }
});

app.get('/connect', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'connect.html'));
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

// pdf.js is served straight from the installed dependency instead of being
// copied into the repository, and the file name differs between builds, so it is
// resolved once here. If the dependency is ever missing these routes 404 and the
// panel falls back to the browser's own PDF handling instead of breaking.
const PDFJS_ASSETS = (() => {
  const exists = require('fs').existsSync;
  const base = path.join(__dirname, '..', 'node_modules', 'pdfjs-dist');
  const pick = (names) => {
    for (const name of names) {
      const full = path.join(base, name);
      if (exists(full)) return full;
    }
    return '';
  };
  return {
    main: pick(['legacy/build/pdf.min.js', 'legacy/build/pdf.js', 'build/pdf.min.js', 'build/pdf.js']),
    worker: pick(['legacy/build/pdf.worker.min.js', 'legacy/build/pdf.worker.js', 'build/pdf.worker.min.js', 'build/pdf.worker.js']),
  };
})();

const sendPdfjsAsset = (res, file) => {
  if (!file) return res.status(404).end();
  res.type('application/javascript');
  res.setHeader('Cache-Control', 'public, max-age=604800');
  return res.sendFile(file);
};

app.get('/vendor/pdfjs/pdf.js', (req, res) => sendPdfjsAsset(res, PDFJS_ASSETS.main));
app.get('/vendor/pdfjs/pdf.worker.js', (req, res) => sendPdfjsAsset(res, PDFJS_ASSETS.worker));

app.use(express.static(PUBLIC_DIR, { index: false }));

app.get(['/api/platform/session', '/api/whatspro/session'], async (req, res) => {
  const session = readSession(req);
  if (!session && !await hasApiToken(req)) return res.status(401).json({ error: 'AUTH_REQUIRED' });
  res.json({ authenticated: true, username: session?.username || process.env.WHATSPRO_USER || 'admin' });
});

app.post(['/api/platform/login', '/api/whatspro/login'], (req, res) => {
  const configuredUser = String(process.env.WHATSPRO_USER || 'admin');
  const configuredPassword = String(process.env.WHATSPRO_PASSWORD || '');
  if (configuredPassword.length < MIN_ADMIN_PASSWORD_LENGTH || ['change-me', 'password', 'admin123'].includes(configuredPassword.toLowerCase())) {
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
  const remember = req.body?.remember === true;
  const cookieOptions = { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' };
  if (remember) cookieOptions.maxAge = 30 * 86400 * 1000;
  res.cookie('whatspro_session', signSession(username), cookieOptions);
  res.json({ success: true, username });
});

app.post(['/api/platform/logout', '/api/whatspro/logout'], (req, res) => {
  res.clearCookie('whatspro_session');
  res.json({ success: true });
});

// Platform-wide answers are owner-only. Reproduced live 2026-08-23 with a real tenant token:
// GET /api/wa/instances?instance=kabab-1 returned BOTH instances, /api/wa/tenants returned
// the readiness report for every tenant, and PUT /api/wa/shared-prompt rewrote the system
// prompt of every tenant on prompt_mode=shared. hasApiToken accepts a tenant token as long
// as the request names its OWN instance, and naming yourself satisfied the scope check while
// the handler stayed platform-wide. withinApiScope was written for exactly this class of
// mistake and had simply never been applied to routes whose answer is the whole platform.
app.get('/api/wa/instances', requirePlatformAdmin, async (req, res) => {
  res.json({ success: true, instances: await listInstances() });
});

  // Onboarding a restaurant is one platform-owned record. These two routes read
  // Redis and answer whether each record is operationally complete,
// including the collisions that only exist between rows. They return pass/fail
// codes and never a field's value, so the token stays where it lives.
app.get('/api/wa/tenants', requirePlatformAdmin, async (req, res) => {
  let records;
  try {
    records = await tenantStore.listTenantRecords();
  } catch (error) {
    return res.status(503).json({ error: 'PLATFORM_STORE_UNAVAILABLE', message: error?.message || String(error) });
  }
  const sessions = await listInstances().catch(() => []);
  // The credential probe is what turns "the hub returns 401" from a log line nobody reads
  // into a row in the panel. Read-only and non-blocking: a hub outage reports UNREACHABLE,
  // not a fault (added 2026-08-23 after a misspelled alemi_instance went unnoticed for days).
  const hubProbes = await tenantReadiness.probeAlemiCredentials(records).catch(() => ({}));
  res.json({ success: true, ...evaluateAll(records, { sessions, hubProbes }) });
});

app.get('/api/wa/backups/tenants.xlsx', requireUiSession, async (req, res) => {
  try {
    const instanceId = String(req.query?.instanceId || '').trim();
    let records = await tenantAdmin.listRows();
    if (instanceId) {
      if (!isValidInstanceId(instanceId)) return res.status(400).json({ error: 'BAD_INSTANCE_ID' });
      records = records.filter(row => String(row.instance_id || '') === instanceId);
      if (!records.length) return res.status(404).json({ error: 'TENANT_NOT_FOUND' });
    }
    const filename = `whatspro-${tenantWorkbook.safeFilename(instanceId || 'all')}-${new Date().toISOString().slice(0, 10)}.xlsx`;
    const file = await tenantWorkbook.exportWorkbook(records, instanceId ? 'single' : 'all');
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    });
    return res.send(file);
  } catch (error) {
    return adminError(res, error);
  }
});

app.post(
  '/api/wa/backups/tenants/import',
  requireUiSession,
  express.raw({
    type: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/octet-stream'],
    limit: '8mb'
  }),
  async (req, res) => {
    try {
      if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'BACKUP_FILE_REQUIRED' });
      const parsed = await tenantWorkbook.importWorkbook(req.body);
      const result = await tenantAdmin.importTenants(parsed.rows, {
        publicBase: publicApiBase(req),
        sharedPrompt: await readSharedPrompt()
      });
      const rowsByInstance = new Map(parsed.rows.map(row => [row.instance_id, row]));
      await Promise.all(result.createdInstances.map(instanceId => {
        const row = rowsByInstance.get(instanceId);
        return saveInstance(instanceId, String(row?.brand || instanceId));
      }));
      const activeRows = parsed.rows.filter(row => row.active !== false);
      await Promise.all(activeRows.map(row => startWhatsAppInstance(row.instance_id)
        .catch(error => console.warn('[TENANT:IMPORT] start failed', row.instance_id, error?.message || error))));
      return res.json({ success: true, scope: parsed.scope, ...result, activeStarted: activeRows.length });
    } catch (error) {
      return adminError(res, error);
    }
  }
);

// Registered before /api/wa/tenants/:instanceId so no restaurant named
// "alemi-secret" can shadow it. The panel asks for a key instead of a person
// inventing one twice; the value is checked against every stored key before it is
// offered and nothing is written here.
app.get('/api/wa/tenants/alemi-secret/suggest', requireUiOrApi, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    return res.json({ success: true, secret: await tenantAdmin.suggestAlemiSecret() });
  } catch (error) {
    return adminError(res, error);
  }
});

app.get('/api/wa/tenants/:instanceId', requireUiOrApi, async (req, res) => {
  const instanceId = String(req.params.instanceId || '').trim();
  if (!isValidInstanceId(instanceId)) return res.status(400).json({ error: 'BAD_INSTANCE_ID' });
  let records;
  try {
    records = await tenantStore.listTenantRecords();
  } catch (error) {
    return res.status(503).json({ error: 'PLATFORM_STORE_UNAVAILABLE', message: error?.message || String(error) });
  }
  const sessions = await listInstances().catch(() => []);
  const report = evaluateAll(records, { sessions });
  const tenant = report.tenants.find(entry => entry.instanceId === instanceId);
  if (!tenant) return res.status(404).json({ error: 'TENANT_NOT_IN_TABLE', instanceId });
  res.json({
    success: true,
    ...tenant,
    collisions: report.collisions.filter(entry => entry.instances.includes(instanceId))
  });
});

// Everything below is the admin panel behind /tenants. It exists so adding a
// restaurant is a form rather than sixteen columns, and so no human ever chooses
// a token — that choice is how two tenants end up sharing one.
const SHARED_PROMPT_KEY = 'whatspro:shared-prompt';

async function readSharedPrompt() {
  if (!redisClient.isOpen) return '';
  return String(await redisClient.get(SHARED_PROMPT_KEY) || '');
}

function adminError(res, error) {
  const status = Number(error?.statusCode || 0);
  if (status >= 400 && status < 600) {
    return res.status(status).json({ error: error.message, fields: error.fields || undefined });
  }
  console.error('[TENANT:ADMIN]', error?.message || error);
  return res.status(502).json({ error: 'TENANT_WRITE_FAILED', message: error?.message || String(error) });
}

// The form derives an id and a domain while you type. It has to ask what the
// suffix is rather than guess, so the same defaults hold in the browser and on
// the server instead of drifting apart.
app.get('/api/wa/tenant-defaults', requirePlatformAdmin, (req, res) => {
  res.json({
    success: true,
    domainSuffix: String(process.env.WHATSPRO_TENANT_DOMAIN_SUFFIX || '').replace(/^\.+/, ''),
    workHours: String(process.env.WHATSPRO_DEFAULT_WORK_HOURS || '09:00 - 03:00')
  });
});

app.get('/api/wa/platform-storage', requirePlatformAdmin, async (req, res) => {
  try {
    res.json({ success: true, ...(await tenantStore.getStorageSummary()) });
  } catch (error) {
    res.status(503).json({ error: 'PLATFORM_STORE_UNAVAILABLE', message: error?.message || String(error) });
  }
});

app.get('/api/wa/runtime-configs', requireMasterApi, async (req, res) => {
  try {
    const configs = await tenantStore.listTenantRecords();
    const publicBase = publicApiBase(req);
    res.json({ success: true, configs: configs.map(config => tenantAdmin.runtimeListTenant(config, publicBase)) });
  } catch (error) {
    res.status(error?.statusCode || 503).json({ error: error?.message || 'PLATFORM_STORE_UNAVAILABLE' });
  }
});

app.get('/api/wa/runtime-configs/:instanceId', requireMasterApi, async (req, res) => {
  try {
    const config = await tenantStore.findRow(req.params.instanceId);
    if (!config) return res.status(404).json({ error: 'TENANT_NOT_FOUND' });
    res.json({ success: true, config: tenantAdmin.runtimeTenant(config, publicApiBase(req)) });
  } catch (error) {
    res.status(error?.statusCode || 503).json({ error: error?.message || 'PLATFORM_STORE_UNAVAILABLE' });
  }
});

app.get('/api/wa/runtime-configs/:instanceId/memories', requireMasterApi, async (req, res) => {
  try {
    res.json({ success: true, memories: await tenantMemoryStore.listMemories(req.params.instanceId) });
  } catch (error) {
    res.status(error?.statusCode || 503).json({ error: error?.message || 'PLATFORM_STORE_UNAVAILABLE' });
  }
});

app.post('/api/wa/runtime-configs/:instanceId/memories', requireMasterApi, async (req, res) => {
  try {
    res.status(201).json({ success: true, memory: await tenantMemoryStore.addMemory(req.params.instanceId, req.body || {}) });
  } catch (error) {
    res.status(error?.statusCode || 503).json({ error: error?.message || 'PLATFORM_STORE_UNAVAILABLE' });
  }
});

app.get('/api/wa/shared-prompt', requirePlatformAdmin, async (req, res) => {
  res.json({ success: true, prompt: await readSharedPrompt() });
});

app.put('/api/wa/shared-prompt', requirePlatformAdmin, async (req, res) => {
  const prompt = String(req.body?.prompt || '').replace(/\r\n/g, '\n').trim().slice(0, 20000);
  if (!redisClient.isOpen) return res.status(503).json({ error: 'REDIS_UNAVAILABLE' });
  await redisClient.set(SHARED_PROMPT_KEY, prompt);
  try {
    // Saving without applying would leave the table disagreeing with the panel,
    // so the write and the propagation are one action.
    const result = await tenantAdmin.applySharedPrompt(prompt);
    res.json({ success: true, ...result });
  } catch (error) {
    return adminError(res, error);
  }
});

// The LLM key workspace ("Жұмыс кеңістігі"): two ordered key pools — text and
// media. GET accepts the master token because OpenBot polls it every minute to
// rebuild its model chains; PUT is the panel saving the arrangement.
app.get('/api/wa/llm-workspace', requirePlatformAdmin, async (req, res) => {
  try {
    res.json({ success: true, workspace: await llmWorkspace.getWorkspace() });
  } catch (error) {
    return adminError(res, error);
  }
});

app.put('/api/wa/llm-workspace', requirePlatformAdmin, async (req, res) => {
  try {
    const workspace = await llmWorkspace.saveWorkspace(req.body || {});
    res.json({ success: true, workspace });
  } catch (error) {
    return adminError(res, error);
  }
});

// Runtime controls (developer phone, test mode + allow-list, receipt filter).
// Same auth split as the key workspace: master token for OpenBot's poller,
// panel session for saving.
app.get('/api/wa/runtime-settings', requirePlatformAdmin, async (req, res) => {
  try {
    res.json({ success: true, settings: await runtimeSettings.getSettings() });
  } catch (error) {
    return adminError(res, error);
  }
});

app.put('/api/wa/runtime-settings', requirePlatformAdmin, async (req, res) => {
  try {
    const settings = await runtimeSettings.saveSettings(req.body || {});
    res.json({ success: true, settings });
  } catch (error) {
    return adminError(res, error);
  }
});

app.get('/api/wa/tenants/:instanceId/settings', requireUiOrApi, async (req, res) => {
  const instanceId = String(req.params.instanceId || '').trim();
  if (!isValidInstanceId(instanceId)) return res.status(400).json({ error: 'BAD_INSTANCE_ID' });
  try {
    const row = await tenantAdmin.findRow(instanceId);
    if (!row) return res.status(404).json({ error: 'TENANT_NOT_FOUND' });
    res.json({ success: true, tenant: tenantAdmin.presentableTenant(row) });
  } catch (error) {
    return adminError(res, error);
  }
});

// Owner-only for the same reason as /api/wa/instances above: a tenant token satisfies
// requireUiOrApi by naming itself, and these routes answer about - or act on - the platform
// rather than the caller's own restaurant. Scan requests and invitations are keyed by an
// opaque id that belongs to whoever asked for it, not to the caller (found 2026-08-23).
app.post('/api/wa/tenants', requirePlatformAdmin, async (req, res) => {
  try {
    const result = await tenantAdmin.createTenant(req.body || {}, {
      publicBase: publicApiBase(req),
      sharedPrompt: await readSharedPrompt()
    });
    // A restaurant that exists in the table but not in the instance list cannot
    // be scanned, and scanning is the next thing the operator will want to do.
    await saveInstance(result.instanceId, String(req.body?.brand || result.instanceId));
    res.status(201).json({ success: true, ...result });
  } catch (error) {
    return adminError(res, error);
  }
});

app.patch('/api/wa/tenants/:instanceId', requireUiOrApi, async (req, res) => {
  const instanceId = String(req.params.instanceId || '').trim();
  if (!isValidInstanceId(instanceId)) return res.status(400).json({ error: 'BAD_INSTANCE_ID' });
  try {
    const result = await tenantAdmin.updateTenant(instanceId, req.body || {}, {
      publicBase: publicApiBase(req),
      sharedPrompt: await readSharedPrompt()
    });
    res.json({ success: true, ...result });
  } catch (error) {
    return adminError(res, error);
  }
});

app.post('/api/wa/tenants/:instanceId/clone', requirePlatformAdmin, async (req, res) => {
  const instanceId = String(req.params.instanceId || '').trim();
  if (!isValidInstanceId(instanceId)) return res.status(400).json({ error: 'BAD_INSTANCE_ID' });
  try {
    const result = await tenantAdmin.cloneTenant(instanceId, req.body || {}, {
      publicBase: publicApiBase(req),
      sharedPrompt: await readSharedPrompt()
    });
    await saveInstance(result.instanceId, String(req.body?.brand || result.instanceId));
    res.status(201).json({ success: true, ...result });
  } catch (error) {
    return adminError(res, error);
  }
});

app.post('/api/wa/tenants/:instanceId/rotate', requirePlatformAdmin, async (req, res) => {
  const instanceId = String(req.params.instanceId || '').trim();
  if (!isValidInstanceId(instanceId)) return res.status(400).json({ error: 'BAD_INSTANCE_ID' });
  try {
    res.json({ success: true, ...(await tenantAdmin.rotateSecrets(instanceId, { publicBase: publicApiBase(req) })) });
  } catch (error) {
    return adminError(res, error);
  }
});

// The owner deliberately keeps the Alemi credential visible in the restaurant
// editor. Reading is stricter than writing: only a signed admin UI session can
// reveal one exact instance, and the response must never enter a browser cache.
app.get('/api/wa/tenants/:instanceId/alemi-secret', requireUiSession, async (req, res) => {
  const instanceId = String(req.params.instanceId || '').trim();
  if (!isValidInstanceId(instanceId)) return res.status(400).json({ error: 'BAD_INSTANCE_ID' });
  res.set('Cache-Control', 'no-store');
  res.set('Pragma', 'no-cache');
  try {
    res.json({ success: true, ...(await tenantAdmin.revealAlemiSecret(instanceId)) });
  } catch (error) {
    return adminError(res, error);
  }
});

// Writes stay on their dedicated exact-instance endpoint and never echo the
// submitted value in the response.
app.post('/api/wa/tenants/:instanceId/alemi-secret', requireUiOrApi, async (req, res) => {
  const instanceId = String(req.params.instanceId || '').trim();
  if (!isValidInstanceId(instanceId)) return res.status(400).json({ error: 'BAD_INSTANCE_ID' });
  try {
    res.json({ success: true, ...(await tenantAdmin.setAlemiSecret(instanceId, req.body?.secret)) });
  } catch (error) {
    return adminError(res, error);
  }
});

// Pausing is not a flag the bot is asked to respect — it is the WhatsApp session
// going away. Nothing arrives, so nothing can be answered by mistake.
app.post('/api/wa/tenants/:instanceId/active', requireUiOrApi, async (req, res) => {
  const instanceId = String(req.params.instanceId || '').trim();
  if (!isValidInstanceId(instanceId)) return res.status(400).json({ error: 'BAD_INSTANCE_ID' });
  const active = Boolean(req.body?.active);
  try {
    const result = await tenantAdmin.setActive(instanceId, active);
    if (active) await startWhatsAppInstance(instanceId).catch(error => console.warn('[TENANT:ADMIN] start failed', instanceId, error?.message || error));
    // Pausing keeps the pairing: the comment above has always promised that
    // resuming never asks for another QR, but the destructive stop broke it.
    else await stopWhatsAppInstance(instanceId, { wipeCredentials: false }).catch(error => console.warn('[TENANT:ADMIN] stop failed', instanceId, error?.message || error));
    res.json({ success: true, ...result });
  } catch (error) {
    return adminError(res, error);
  }
});

// Bot control is deliberately separate from WhatsApp lifecycle. A paused bot
// keeps its authenticated session online, so resuming never asks the client to
// scan another QR code.
app.post('/api/wa/tenants/:instanceId/bot-enabled', requireUiOrApi, async (req, res) => {
  const instanceId = String(req.params.instanceId || '').trim();
  if (!isValidInstanceId(instanceId)) return res.status(400).json({ error: 'BAD_INSTANCE_ID' });
  try {
    res.json({ success: true, ...(await tenantAdmin.setBotEnabled(instanceId, Boolean(req.body?.enabled))) });
  } catch (error) {
    return adminError(res, error);
  }
});

// Calls ride the main socket now, so a linked tenant is already watching and
// this answers connected without a code. The route stays for the panel and for
// tenants pinned back to the Chromium transport, which still need their own.
app.get('/api/wa/tenants/:instanceId/call-watcher', requireUiOrApi, async (req, res) => {
  const instanceId = String(req.params.instanceId || '').trim();
  if (!isValidInstanceId(instanceId)) return res.status(400).json({ error: 'BAD_INSTANCE_ID' });
  try {
    if (usesSingleQr(instanceId)) {
      const live = await getInstanceStatus(instanceId);
      const connected = String(live?.status || '') === 'connected';
      res.set('Cache-Control', 'no-store');
      return res.json({
        success: true,
        connected,
        watching: connected,
        awaitingScan: false,
        loggedOut: false,
        qr: null,
        singleQr: true
      });
    }
    const status = require('../services/callWatcher').callWatcherStatus(instanceId);
    const pending = require('../services/whatsappManager').getCallWatcherQr(instanceId);
    res.set('Cache-Control', 'no-store');
    res.json({
      success: true,
      connected: Boolean(status.connected),
      watching: Boolean(status.watching),
      // A code on screen nobody has scanned yet and a watcher that is down look
      // the same from the outside, and only one of them is waiting on a person.
      awaitingScan: Boolean(status.awaitingScan),
      loggedOut: Boolean(status.loggedOut),
      qr: pending ? await require('qrcode').toDataURL(pending.qr) : null
    });
  } catch (error) {
    return adminError(res, error);
  }
});

app.post('/api/wa/tenants/:instanceId/calls-disabled', requireUiOrApi, async (req, res) => {
  const instanceId = String(req.params.instanceId || '').trim();
  if (!isValidInstanceId(instanceId)) return res.status(400).json({ error: 'BAD_INSTANCE_ID' });
  try {
    res.json({ success: true, ...(await tenantAdmin.setCallsDisabled(instanceId, Boolean(req.body?.disabled))) });
  } catch (error) {
    return adminError(res, error);
  }
});

app.post('/api/wa/tenants/:instanceId/connect-link', requireUiOrApi, async (req, res) => {
  const instanceId = String(req.params.instanceId || '').trim();
  if (!isValidInstanceId(instanceId)) return res.status(400).json({ error: 'BAD_INSTANCE_ID' });
  try {
    const tenant = await tenantAdmin.findRow(instanceId);
    if (!tenant) return res.status(404).json({ error: 'TENANT_NOT_FOUND' });
    const expiresAt = Date.now() + CONNECT_TOKEN_TTL_MS;
    const token = issueConnectToken(instanceId, expiresAt);
    const locale = req.body?.locale === 'ru' ? 'ru' : 'kk';
    const url = `${publicApiBase(req)}/connect?token=${encodeURIComponent(token)}&lang=${locale}`;
    res.status(201).json({ success: true, url, expiresAt });
  } catch (error) {
    return adminError(res, error);
  }
});

app.get('/api/wa/connect/:token/status', async (req, res) => {
  const token = String(req.params.token || '');
  const scoped = readConnectToken(token);
  if (!scoped) return res.status(401).json({ error: 'CONNECT_LINK_INVALID_OR_EXPIRED' });
  try {
    if (!(await allowConnectPoll(req, token))) return res.status(429).json({ error: 'CONNECT_RATE_LIMITED' });
    const tenant = await tenantAdmin.findRow(scoped.instanceId);
    if (!tenant) return res.status(404).json({ error: 'TENANT_NOT_FOUND' });
    let live = await getInstanceStatus(scoped.instanceId);
    if (!['connected', 'qr_ready', 'starting', 'initializing', 'restoring_session'].includes(String(live?.status || ''))) {
      await startWhatsAppInstance(scoped.instanceId);
      live = await getInstanceStatus(scoped.instanceId);
    }
    // One scan links the device for messages and calls alike, so onboarding is
    // done the moment the main socket is up. A tenant pinned to the Chromium
    // transport still needs the second linked device, and still gets it here.
    const singleQr = usesSingleQr(scoped.instanceId);
    const watcher = singleQr ? { connected: true } : callWatcherStatus(scoped.instanceId);
    const watcherQr = singleQr || watcher.connected ? null : getCallWatcherQr(scoped.instanceId);
    const mainConnected = String(live?.status || '') === 'connected';

    res.set('Cache-Control', 'no-store');
    res.json({
      success: true,
      brand: String(tenant.brand || 'WhatsPro').slice(0, 120),
      status: String(live?.status || 'unknown'),
      qr: live?.qr || null,
      step: mainConnected ? (watcher.connected ? 'done' : 'calls') : 'session',
      callsConnected: Boolean(watcher.connected),
      callsQr: mainConnected && watcherQr ? await qrcode.toDataURL(watcherQr.qr) : null,
      singleQr,
      expiresAt: scoped.expiresAt
    });
  } catch (error) {
    res.status(error?.statusCode || 503).json({ error: error?.message || 'CONNECT_STATUS_UNAVAILABLE' });
  }
});

app.delete('/api/wa/tenants/:instanceId', requirePlatformAdmin, async (req, res) => {
  const instanceId = String(req.params.instanceId || '').trim();
  if (!isValidInstanceId(instanceId)) return res.status(400).json({ error: 'BAD_INSTANCE_ID' });
  // Deleting a restaurant removes its row, its WhatsApp session and every cache
  // key under its instance id (tenantAdmin.deleteTenant owns that cascade).
  // Typing the name is what separates that from a mis-tap on a phone.
  if (String(req.body?.confirm || '') !== instanceId) return res.status(400).json({ error: 'CONFIRM_INSTANCE_ID_REQUIRED' });
  try {
    const result = await tenantAdmin.deleteTenant(instanceId);
    if (redisClient.isOpen) await redisClient.hDel(INSTANCE_STORE_KEY, instanceId).catch(() => undefined);
    res.json({ success: true, ...result });
  } catch (error) {
    return adminError(res, error);
  }
});

app.get('/api/wa/scan-requests', requirePlatformAdmin, async (req, res) => {
  res.json({ success: true, requests: await listScanRequests() });
});

app.post('/api/wa/scan-requests', requirePlatformAdmin, async (req, res) => {
  const { name, contact } = req.body || {};
  if (!name || !contact) return res.status(400).json({ error: 'NAME_AND_CONTACT_REQUIRED' });
  const requestId = `req_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  await saveScanRequest(requestId, { requestedName: name, contact, status: 'pending' });
  res.status(201).json({ success: true, request: { id: requestId, requestedName: name, contact, status: 'pending', createdAt: Date.now() } });
});

app.post('/api/wa/scan-requests/:requestId/approve', requirePlatformAdmin, async (req, res) => {
  const requestId = String(req.params.requestId || '').trim();
  const { instanceId, label } = req.body || {};
  if (!instanceId || !label) return res.status(400).json({ error: 'INSTANCE_ID_AND_LABEL_REQUIRED' });
  if (!isValidInstanceId(instanceId)) return res.status(400).json({ error: 'BAD_INSTANCE_ID' });
  await updateScanRequest(requestId, { instanceId, label, status: 'approved' });
  res.json({ success: true });
});

app.post('/api/wa/scan-requests/:requestId/reject', requirePlatformAdmin, async (req, res) => {
  const requestId = String(req.params.requestId || '').trim();
  await updateScanRequest(requestId, { status: 'rejected' });
  res.json({ success: true });
});

app.post('/api/wa/scan-requests/:requestId/open', requirePlatformAdmin, async (req, res) => {
  const requestId = String(req.params.requestId || '').trim();
  const request = await getScanRequest(requestId);
  if (!request) return res.status(404).json({ error: 'REQUEST_NOT_FOUND' });
  res.json({ success: true, request });
});

app.get('/api/wa/scan-requests/:requestId', requirePlatformAdmin, async (req, res) => {
  const requestId = String(req.params.requestId || '').trim();
  const request = await getScanRequest(requestId);
  if (!request) return res.status(404).json({ error: 'REQUEST_NOT_FOUND' });
  res.json({ success: true, request });
});

app.get('/api/wa/scan-invitations', requirePlatformAdmin, async (req, res) => {
  const requestId = `req_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  await saveScanRequest(requestId, { status: 'pending' });
  res.status(201).json({ success: true, request: { id: requestId } });
});

app.get('/api/chat/inbox/:instanceId', resolveChatInstance, requireChatUiOrApi, async (req, res) => {
  const instanceId = String(req.params.instanceId || '').trim();
  if (!isValidInstanceId(instanceId)) return res.status(400).json({ error: 'BAD_INSTANCE_ID' });
  if (!redisClient.isOpen) return res.status(503).json({ error: 'REDIS_NOT_CONNECTED' });

  const limit = parseLimit(req.query.limit, 100, 1000);
  const testModePolicy = await getTestModePolicy(instanceId);
  const [inboxRows, sosRows] = await Promise.all([
    readInboxEntries(instanceId, limit * 2),
    sosStore.list(instanceId, limit)
  ]);
  // The legacy scan is a RECOVERY path: it finds chats that exist only as Openbot's
  // `history:` key because the canonical inbox index lost them. It was running a full
  // keyspace SCAN on every request, and chat.js polls this every 5 seconds per open
  // panel - so with a few tenants and a few panels the gateway spent most of its Redis
  // budget scanning the shared keyspace, starving message ingestion on the same
  // connection (found 2026-08-22). Recovery does not need to happen 12 times a minute.
  const legacyHistoryKeys = await cachedLegacyHistoryKeys(instanceId);
  const candidates = [];
  const seen = new Set();

  for (const row of sosRows) {
    row.phone = await chatStore.resolveLidPhone(instanceId, row.phone).catch(() => row.phone);
  }
  for (const row of [...sosRows.map(row => ({ phone: row.phone, updatedAt: row.sosCreatedAt || 0 })), ...inboxRows, ...legacyHistoryKeys]) {
    // A linked-device LID resolves to the real phone before the dedupe check,
    // so a ghost LID chat merges into the real conversation instead of
    // haunting the panel as a second, unloadable entry (live bug, 2026-08-21).
    const phone = await chatStore.resolveLidPhone(instanceId, row.phone).catch(() => normalizePhone(row.phone));
    if (!isValidChatPhone(phone) || !allowsPhone(testModePolicy, phone) || seen.has(phone)) continue;
    seen.add(phone);
    candidates.push({ phone, updatedAt: Number(row.updatedAt) || 0 });
    if (candidates.length >= limit) break;
  }

  const sosByPhone = new Map(sosRows.map(row => [row.phone, row]));
  const [archiveRows, histories, openbotHistories, viewedScores, states] = await Promise.all([
    redisClient.sendCommand(['SMEMBERS', chatArchiveKey(instanceId)]).catch(() => []),
    // null, not [], on failure. An errored read used to be indistinguishable from "no
    // history", and the sweep below deletes the inbox index entry for a chat with no
    // history - so one transient Redis error made a live conversation vanish from the
    // operator panel and could resurface an archived chat as active (found 2026-08-23).
    Promise.all(candidates.map(item => redisClient.sendCommand(['LRANGE', chatHistoryKey(instanceId, item.phone), '-500', '-1']).catch(() => null))),
    Promise.all(candidates.map(item => redisClient.sendCommand(['LRANGE', openbotHistoryKey(instanceId, item.phone), '-500', '-1']).catch(() => null))),
    Promise.all(candidates.map(item => redisClient.sendCommand(['ZSCORE', chatViewedKey(instanceId), item.phone]).catch(() => null))),
    Promise.all(candidates.map(item => chatStore.getState(instanceId, item.phone)))
  ]);
  const archiveSet = new Set((archiveRows || []).map(normalizePhone).filter(Boolean));
  const items = [];
  const stalePhones = [];

  candidates.forEach((item, index) => {
    // The gateway timeline is canonical. OpenBot history is an internal model
    // memory and is used only to recover older chats that have no gateway rows.
    const gatewayRows = histories[index];
    const openbotRows = openbotHistories[index];
    // A failed read must never be treated as an empty chat: deleting index state on a blip
    // is how a real conversation disappears from the panel.
    const readFailed = gatewayRows === null && openbotRows === null;
    const historyRows = (gatewayRows && gatewayRows.length) ? gatewayRows : (openbotRows || []);
    if (!historyRows.length) {
      if (!readFailed) stalePhones.push(item.phone);
      return;
    }
    const summary = summarizeChat(item, historyRows, Number(viewedScores[index]) || 0, archiveSet.has(item.phone));
    const state = states[index] || (summary.closed ? 'archive' : summary.hasOperator ? 'operator' : summary.unread ? 'new' : 'all');
    const sos = sosByPhone.get(item.phone) || null;
    items.push({
      ...summary,
      state,
      // The computed flag, not a state test. summarizeChat derives unread from
      // latestCustomerAt vs viewedAt, and this line threw it away - so a customer reply
      // into a chat the operator had taken over (state 'operator') or archived showed NO
      // badge anywhere, which is the busiest case in a live shift. incomingWebhook stops
      // setting 'new' for those chats precisely because its comment promises "the unread
      // badge still comes from the unread flag"; nothing implemented that (found
      // 2026-08-23).
      unread: Boolean(summary.unread),
      viewed: state === 'all',
      hasOperator: state === 'operator',
      closed: state === 'archive',
      sos: Boolean(sos),
      sosUnread: Boolean(sos?.sosUnread),
      sosCreatedAt: Number(sos?.sosCreatedAt || 0),
      sosExpiresAt: Number(sos?.sosExpiresAt || 0),
      sosKind: String(sos?.sosKind || ''),
      sosSummary: String(sos?.sosSummary || ''),
      sosCaseId: String(sos?.sosCaseId || '')
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

app.get('/api/chat/events/:instanceId', resolveChatInstance, requireChatUiOrApi, async (req, res) => {
  const instanceId = String(req.params.instanceId || '').trim();
  if (!isValidInstanceId(instanceId)) return res.status(400).json({ error: 'BAD_INSTANCE_ID' });

  res.set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders();
  res.write('retry: 3000\n\n');
  res.flush?.();

  let unsubscribe = () => {};
  const heartbeat = setInterval(() => {
    if (res.writableEnded) return;
    res.write(': heartbeat\n\n');
    res.flush?.();
  }, 20000);
  const maxLifetime = setTimeout(() => res.end(), SSE_MAX_LIFETIME_MS);
  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    clearInterval(heartbeat);
    clearTimeout(maxLifetime);
    unsubscribe();
  };
  req.once('close', cleanup);
  res.once('close', cleanup);

  try {
    const teardown = await subscribeChatEvents(instanceId, event => {
      if (res.writableEnded) return;
      res.write(`data: ${JSON.stringify(event)}\n\n`);
      res.flush?.();
    });
    if (cleanedUp || req.destroyed) teardown();
    else unsubscribe = teardown;
  } catch (error) {
    cleanup();
    if (!res.writableEnded) res.end(`event: error\ndata: ${JSON.stringify({ error: 'EVENT_STREAM_UNAVAILABLE' })}\n\n`);
  }
});

app.get('/api/chat/inbox-legacy/:instanceId', resolveChatInstance, requireChatUiOrApi, async (req, res) => {
  const instanceId = String(req.params.instanceId || '').trim();
  if (!isValidInstanceId(instanceId)) return res.status(400).json({ error: 'BAD_INSTANCE_ID' });
  if (!redisClient.isOpen) return res.status(503).json({ error: 'REDIS_NOT_CONNECTED' });

  const limit = parseLimit(req.query.limit, 100, 500);
  const rows = await redisClient.sendCommand(['ZREVRANGE', chatInboxKey(instanceId), '0', String(limit - 1), 'WITHSCORES']);

  const items = [];
  const phones = [];
  const seen = new Set();

  for (const row of parseScoredMembers(rows)) {
    // Спамды тазалау
    const purePhone = row.member.split(',')[0].replace(/\D/g, '');
    if (!purePhone || seen.has(purePhone)) continue;

    seen.add(purePhone);
    phones.push(purePhone);
    items.push({ phone: purePhone, updatedAt: row.score });
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

app.get('/api/chat/history/:instanceId/:phone', resolveChatInstance, requireChatUiOrApi, async (req, res) => {
  const instanceId = String(req.params.instanceId || '').trim();
  const phone = await resolveChatPhoneParam(instanceId, req.params.phone);
  if (!isValidInstanceId(instanceId)) return res.status(400).json({ error: 'BAD_INSTANCE_ID' });
  if (!isValidChatPhone(phone)) return res.status(400).json({ error: 'BAD_PHONE' });
  if (!allowsPhone(await getTestModePolicy(instanceId), phone)) return res.status(403).json({ error: 'TEST_MODE_PHONE_BLOCKED' });
  if (!redisClient.isOpen) return res.status(503).json({ error: 'REDIS_NOT_CONNECTED' });

  const limit = parseLimit(req.query.limit, 200, 1000);
  
  const history = await chatStore.getHistory(instanceId, phone, limit);

  res.json({ success: true, instanceId, phone, history });
});

const serveChatMedia = createChatMediaHandler({
    readMedia: (instanceId, messageId) => redisClient.sendCommand(['GET', chatMediaKey(instanceId, messageId)]).catch(() => ''),
    recoverMedia: (instanceId, messageId, req) => recoverChatMedia(instanceId, req.query?.phone, messageId)
});

app.get('/api/chat/media/:instanceId/:messageId', resolveChatInstance, requireChatMediaAuth, async (req, res) => {
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
app.post('/api/chat/send/:instanceId/:phone', resolveChatInstance, requireChatUiOrApi, async (req, res) => {
    const instanceId = String(req.params.instanceId || '').trim();
    const phone = await resolveChatPhoneParam(instanceId, req.params.phone);
    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    const requestId = String(req.body?.requestId || '');

    if (!isValidInstanceId(instanceId)) return res.status(400).json({ error: 'BAD_INSTANCE_ID' });
    if (!isValidChatPhone(phone)) return res.status(400).json({ error: 'BAD_PHONE' });
    if (!allowsPhone(await getTestModePolicy(instanceId), phone)) return res.status(403).json({ error: 'TEST_MODE_PHONE_BLOCKED' });
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
      if (priorWal?.phase === 'intent' || priorWal?.phase === 'ambiguous') return res.status(409).json({ error: 'SEND_OUTCOME_UNKNOWN' });
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
    const intentRecord = { phase: 'intent', lease, instanceId, phone, text, operationStartedAt };
    try {
      walPath = await writeSendWal(intentRecord);
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
      await markSendWalAmbiguous(intentRecord, `transport error: ${error?.message || error}`)
        .catch(walError => console.error('[CHAT SEND WAL] ambiguous record update failed:', walError?.message || walError));
      console.error(`[CHAT SEND] ${instanceId}/${phone}:`, error?.message || error);
      return res.status(409).json({ error: 'SEND_OUTCOME_UNKNOWN' });
    } finally {
      clearInterval(renewTimer);
    }
    const ok = sendResult && typeof sendResult === 'object' ? sendResult.success === true : Boolean(sendResult);
    if (!ok && sendResult?.outcomeUnknown) {
      liveSendWalPaths.delete(walPath);
      await markSendWalAmbiguous(intentRecord, 'transport reported an unknown outcome')
        .catch(walError => console.error('[CHAT SEND WAL] ambiguous record update failed:', walError?.message || walError));
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
    // Acks arrive normalised to whatsapp-web.js numbering (PENDING=0, SERVER=1,
    // DEVICE=2, READ=3); the Baileys client additionally reports -1 for a message the
    // transport rejected, which must not read as "sent".
    const deliveryStatus = Number(sendResult?.ack) < 0 ? 'failed'
      : Number(sendResult?.ack) >= 3 ? 'read' : Number(sendResult?.ack) >= 2 ? 'delivered' : 'sent';
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
// The invariant "while an operator is typing the bot stays silent" had no write
// path: the lock was only set AFTER a send completed, so a customer message that
// arrived while the operator was composing was forwarded to Openbot and answered
// automatically - the customer got a bot answer and a human answer to the same
// question (found 2026-08-22). The composer now claims the lock while typing.
app.post('/api/chat/operator-lock/:instanceId/:phone', resolveChatInstance, requireChatUiOrApi, async (req, res) => {
  const instanceId = String(req.params.instanceId || '').trim();
  const phone = await resolveChatPhoneParam(instanceId, req.params.phone);
  if (!isValidInstanceId(instanceId) || !isValidChatPhone(phone)) return res.status(400).json({ error: 'BAD_CHAT_REQUEST' });
  if (!allowsPhone(await getTestModePolicy(instanceId), phone)) return res.status(403).json({ error: 'TEST_MODE_PHONE_BLOCKED' });
  if (!redisClient.isOpen) return res.status(503).json({ error: 'REDIS_NOT_CONNECTED' });
  // markOperatorActive uses SET ... EX, so a lock can never stick: the worst case
  // is OPERATOR_ACTIVE_SECONDS of silence after the operator stops typing.
  const marked = await markOperatorActive(instanceId, phone, 'operator_typing').catch(() => false);
  if (!marked) return res.status(503).json({ error: 'LOCK_NOT_SET' });
  const ttl = OPERATOR_ACTIVE_SECONDS;
  const expiresAt = Date.now() + ttl * 1000;
  await publishChatEvent({ type: 'lock.changed', instanceId, phone, ttl, expiresAt }).catch(() => undefined);
  return res.json({ success: true, instanceId, phone, ttl, expiresAt });
});

app.get('/api/chat/operator-lock/:instanceId/:phone', resolveChatInstance, requireChatUiOrApi, async (req, res) => {
  const instanceId = String(req.params.instanceId || '').trim();
  const phone = await resolveChatPhoneParam(instanceId, req.params.phone);
  if (!isValidInstanceId(instanceId) || !isValidChatPhone(phone)) return res.status(400).json({ error: 'BAD_CHAT_REQUEST' });
  if (!allowsPhone(await getTestModePolicy(instanceId), phone)) return res.status(403).json({ error: 'TEST_MODE_PHONE_BLOCKED' });
  const ttl = redisClient.isOpen ? await redisClient.sendCommand(['TTL', operatorActiveKey(instanceId, phone)]).catch(() => 0) : 0;
  const safeTtl = Math.max(0, Number(ttl) || 0);
  return res.json({ success: true, instanceId, phone, ttl: safeTtl, expiresAt: safeTtl ? Date.now() + safeTtl * 1000 : 0 });
});

app.post('/api/chat/action/:instanceId/:phone', resolveChatInstance, requireChatUiOrApi, async (req, res) => {
  const instanceId = String(req.params.instanceId || '').trim();
  const phone = await resolveChatPhoneParam(instanceId, req.params.phone);
  const action = String(req.body?.action || '').trim().toLowerCase();
  if (!isValidInstanceId(instanceId) || !isValidChatPhone(phone)) return res.status(400).json({ error: 'BAD_CHAT_REQUEST' });
  if (!allowsPhone(await getTestModePolicy(instanceId), phone)) return res.status(403).json({ error: 'TEST_MODE_PHONE_BLOCKED' });
  if (!['view', 'close', 'archive', 'restore', 'delete'].includes(action)) return res.status(400).json({ error: 'BAD_ACTION' });
  if (!redisClient.isOpen) return res.status(503).json({ error: 'REDIS_NOT_CONNECTED' });
  await chatStore.applyAction(instanceId, phone, action);
  if (action === 'view') await sosStore.acknowledge(instanceId, phone);
  // 'close' resolves the escalation the same way 'delete' does: an archived
  // chat must not stay pinned in the SOS column for the rest of the marker TTL
  // (operator request, 2026-08-20).
  if (action === 'delete' || action === 'close') await sosStore.clear(instanceId, phone);
  await publishChatEvent({ type: action === 'view' ? 'sos.acknowledged' : 'chat.action', instanceId, phone, action }).catch(() => {});
  return res.json({ success: true, instanceId, phone, action });
});

// The site needs the SOS count WITHOUT the operator opening the chat. The iframe
// postMessage (platform.chat.sos-unread) only fires while the panel is on screen, so a
// restaurant whose owner just looked at the cabinet saw a green button with no number
// even though a guest was waiting (owner report, 2026-08-27). This is the server-side
// half of the same fact: Hub polls it, gets the count, and paints the badge before
// anybody clicks anything.
//
// Deliberately a pure read of the SOS index - it never acknowledges, so polling can
// never clear a signal the operator has not seen. `revision` changes only when the
// count does, which lets the caller skip a repaint.
app.get('/api/chat/sos-count/:instanceId', resolveChatInstance, requireChatUiOrApi, async (req, res) => {
  const instanceId = String(req.params.instanceId || '').trim();
  if (!isValidInstanceId(instanceId)) return res.status(400).json({ error: 'BAD_INSTANCE_ID' });
  if (!withinApiScope(req, instanceId)) return res.status(403).json({ error: 'INSTANCE_SCOPE_MISMATCH' });
  if (!redisClient.isOpen) return res.status(503).json({ error: 'REDIS_NOT_CONNECTED' });
  // A test-mode tenant must not report guests the panel itself refuses to show, or the
  // badge would count a chat the operator cannot open.
  const testModePolicy = await getTestModePolicy(instanceId);
  const rows = await sosStore.list(instanceId, 1000).catch(() => null);
  if (rows === null) return res.status(503).json({ error: 'SOS_STATE_UNAVAILABLE' });
  let unread = 0;
  let total = 0;
  let latestAt = 0;
  for (const row of rows) {
    const phone = await chatStore.resolveLidPhone(instanceId, row.phone).catch(() => row.phone);
    if (!isValidChatPhone(phone) || !allowsPhone(testModePolicy, phone)) continue;
    total += 1;
    if (row.sosUnread) unread += 1;
    latestAt = Math.max(latestAt, Number(row.sosCreatedAt || 0));
  }
  res.set({ 'Cache-Control': 'no-store, max-age=0' });
  return res.json({
    success: true,
    instance: instanceId,
    schema_version: 1,
    sos_unread: unread,
    sos_open: total,
    latest_at: latestAt ? new Date(latestAt).toISOString() : null,
    observed_at: new Date().toISOString(),
    revision: `whatspro:${instanceId}:${unread}:${total}`
  });
});

app.post('/api/wa/start', requireUiOrApi, async (req, res) => {
  const instanceId = String(req.body?.instanceId || '').trim();
  const label = String(req.body?.label || '').trim();
  if (!isValidInstanceId(instanceId)) return res.status(400).json({ error: 'BAD_INSTANCE_ID' });
  // The instance arrives in the body, so the header-authenticated scope and the body
  // must be made to agree - the same reason withinApiScope exists on the send path.
  if (!withinApiScope(req, instanceId)) return res.status(403).json({ error: 'INSTANCE_SCOPE_MISMATCH' });
  await saveInstance(instanceId, label);
  const result = await startWhatsAppInstance(instanceId);
  res.json({ success: true, ...result, ...(await getInstanceStatus(instanceId)) });
});

async function readLiveStatus(instanceId) {
  let status = await getInstanceStatus(instanceId);
  if (status?.hasStoredSession && ['not_running', 'stopped', 'disconnected'].includes(String(status.status || ''))) {
    await startWhatsAppInstance(instanceId);
    status = await getInstanceStatus(instanceId);
  }
  return status;
}

app.post('/api/wa/statuses', requireUiOrApi, async (req, res) => {
  const instanceIds = Array.from(new Set(
    (Array.isArray(req.body?.instanceIds) ? req.body.instanceIds : [])
      .map(value => String(value || '').trim())
      .filter(Boolean)
  ));
  if (!instanceIds.length || instanceIds.length > 500 || instanceIds.some(instanceId => !isValidInstanceId(instanceId))) {
    return res.status(400).json({ error: 'BAD_INSTANCE_IDS' });
  }
  // A tenant token may poll its OWN status - that is the legitimate use - but asking for a
  // list containing anyone else is a cross-tenant read. withinApiScope is the same check the
  // send path uses to stop a request authenticating as one tenant and acting as another.
  if (!instanceIds.every(instanceId => withinApiScope(req, instanceId))) {
    return res.status(403).json({ error: 'INSTANCE_SCOPE_MISMATCH' });
  }
  const entries = await Promise.all(instanceIds.map(async instanceId => {
    try {
      return [instanceId, await readLiveStatus(instanceId)];
    } catch (error) {
      return [instanceId, { status: 'unavailable', __error: true }];
    }
  }));
  return res.json({ success: true, statuses: Object.fromEntries(entries) });
});

app.get('/api/wa/status/:instanceId', requireUiOrApi, async (req, res) => {
  const instanceId = String(req.params.instanceId || '').trim();
  if (!isValidInstanceId(instanceId)) return res.status(400).json({ error: 'BAD_INSTANCE_ID' });
  const status = await readLiveStatus(instanceId);
  res.json(status);
});

// Инстансты қосу (whatspro.html интерфейсі үшін)
app.post('/api/wa/instances', requirePlatformAdmin, async (req, res) => {
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

// "Restart" means reconnect, not unlink. It used to route through the destructive
// stop, so the panel button logged the device out and deleted the session folder -
// an operator clearing a hiccup took the restaurant offline until somebody walked
// to the phone with a QR code (found 2026-08-22). Unlinking lives at
// /api/wa/logout, whose name says what it does.
app.post('/api/wa/restart/:instanceId', requireUiOrApi, async (req, res) => {
  const instanceId = String(req.params.instanceId || '').trim();
  if (!isValidInstanceId(instanceId)) return res.status(400).json({ error: 'BAD_INSTANCE_ID' });
  await stopWhatsAppInstance(instanceId, { wipeCredentials: false }).catch(() => {});
  const result = await startWhatsAppInstance(instanceId);
  res.json({ success: true, ...result, ...(await getInstanceStatus(instanceId)) });
});

app.post('/api/wa/logout', requirePlatformAdmin, async (req, res) => {
  const instanceId = String(req.body?.instanceId || '').trim();
  if (!isValidInstanceId(instanceId)) return res.status(400).json({ error: 'BAD_INSTANCE_ID' });
  res.json(await stopWhatsAppInstance(instanceId));
});

app.post('/api/send', requireApi, apiSendJsonParser, async (req, res) => {
  const { instanceId, phone } = req.body || {};
  const requestId = String(req.body?.requestId || '').trim();
  if (req.body?.text != null && typeof req.body.text !== 'string') return res.status(400).json({ error: 'INVALID_TEXT' });
  const text = String(req.body?.text || '').trim();
  if (text.length > 4096) return res.status(400).json({ error: 'TEXT_TOO_LONG' });
  const media = req.body?.media;
  if (media != null && (!media || typeof media !== 'object' || Array.isArray(media))) return res.status(400).json({ error: 'INVALID_MEDIA_PAYLOAD' });
  
  if (!isValidInstanceId(instanceId)) return res.status(400).json({ error: 'BAD_INSTANCE_ID' });
  if (!withinApiScope(req, instanceId)) return res.status(403).json({ error: 'INSTANCE_OUT_OF_SCOPE' });
  if (!phone) return res.status(400).json({ error: 'PHONE_REQUIRED' });

  // 1-ӨЗГЕРІС: Міндетті түрде телефонды нормализациялау (RC-7 шешімі)
  // Бұл 8707, +7707 форматтарының барлығын таза 7707... форматына әкеледі.
  // A linked-device LID resolves to the canonical phone first, so the send,
  // the bot-send marker and the stored history entry all share one identity
  // (the raw LID made the bot reply look like a human operator, 2026-08-21).
  const cleanPhone = await resolveChatPhoneParam(instanceId, phone);
  if (!isValidChatPhone(cleanPhone)) return res.status(400).json({ error: 'INVALID_PHONE_FORMAT' });
  if (requestId && !isValidSendRequestId(requestId)) return res.status(400).json({ error: 'BAD_REQUEST_ID' });

  let sendResult = { success: true };
  let effectiveMediaType = '';
  let audioMediaData = '';
  let apiSendLease = null;
  
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
    // The text branch below has had an idempotency lease since the send WAL was written; the
    // media branch never did. So an HTTP timeout on the caller's side - Openbot retrying its
    // own outbox - delivered the same photo or Kaspi receipt PDF to the guest twice (found
    // 2026-08-23). Same mechanism, not a second one: the hash covers the bytes, the caption
    // and the filename, so a retry of the same upload replays while a different photo under a
    // reused requestId is the same 409 conflict text already gives.
    if (requestId) {
      const payloadHash = crypto
        .createHash('sha256')
        .update(`media:${mimeType}:${fileName}:${caption}:`)
        .update(encoded)
        .digest('hex');
      apiSendLease = await sendIdempotency.begin(instanceId, cleanPhone, requestId, payloadHash);
      if (apiSendLease.conflict) return res.status(409).json({ error: 'IDEMPOTENCY_PAYLOAD_MISMATCH' });
      if (apiSendLease.response) return res.json({ ...apiSendLease.response, replayed: true });
      if (!apiSendLease.acquired) return res.status(409).json({ error: 'REQUEST_IN_PROGRESS' });
    }
    try {
      sendResult = await sendMedia(instanceId, cleanPhone, mediaPayload, fileName, caption);
    } catch (error) {
      // Mirrors the text branch: a failed send must not strand the requestId, or a
      // legitimate retry of a message that never arrived would be refused forever.
      if (apiSendLease) await sendIdempotency.release(apiSendLease).catch(() => {});
      throw error;
    }
  } else if (text) {
    if (requestId) {
      const payloadHash = crypto.createHash('sha256').update(text).digest('hex');
      apiSendLease = await sendIdempotency.begin(instanceId, cleanPhone, requestId, payloadHash);
      if (apiSendLease.conflict) return res.status(409).json({ error: 'IDEMPOTENCY_PAYLOAD_MISMATCH' });
      if (apiSendLease.response) return res.json({ ...apiSendLease.response, replayed: true });
      if (!apiSendLease.acquired) return res.status(409).json({ error: 'REQUEST_IN_PROGRESS' });
    }
    try {
      sendResult = await sendWhatsAppText(instanceId, cleanPhone, text);
    } catch (error) {
      if (apiSendLease) await sendIdempotency.release(apiSendLease).catch(() => {});
      throw error;
    }
  } else {
    return res.status(400).json({ error: 'TEXT_OR_MEDIA_REQUIRED' });
  }

  const ok = Boolean(sendResult?.success || sendResult);
  const responsePayload = {
    success: ok,
    messageId: String(sendResult?.messageId || '')
  };
  if (apiSendLease) {
    if (ok) await sendIdempotency.complete(apiSendLease, responsePayload);
    else await sendIdempotency.release(apiSendLease);
  }
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
    if (saved?.inserted !== false) {
      await publishChatEvent({ type: 'chat.message', instanceId, phone: cleanPhone, messageId: saved?.id || sendResult?.messageId || '' }).catch(() => {});
    }
  }

  res.status(ok ? 200 : 503).json(responsePayload);
});

app.post('/api/presence', requireApi, async (req, res) => {
  const { instanceId, instance, phone, state } = req.body || {};
  const cleanInstanceId = String(instanceId || instance || '').trim();
  const cleanPhone = normalizePhone(phone);
  if (!isValidInstanceId(cleanInstanceId)) return res.status(400).json({ error: 'BAD_INSTANCE_ID' });
  if (!withinApiScope(req, cleanInstanceId)) return res.status(403).json({ error: 'INSTANCE_OUT_OF_SCOPE' });
  if (!isValidChatPhone(cleanPhone)) return res.status(400).json({ error: 'INVALID_PHONE_FORMAT' });

  // The caller's state was accepted and then dropped, so a 'read' request only
  // ever showed "typing…". Anything unrecognised keeps the old default.
  const cleanState = String(state || '').trim().toLowerCase() === 'read' ? 'read' : 'typing';
  const ok = await sendPresence(cleanInstanceId, cleanPhone, cleanState);
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
    if (weakPassword.length < MIN_ADMIN_PASSWORD_LENGTH || ['change-me', 'password', 'admin123'].includes(weakPassword.toLowerCase())) {
      console.warn(`[SECURITY] WHATSPRO_PASSWORD should be at least ${MIN_ADMIN_PASSWORD_LENGTH} characters and not a known default`);
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
  await tenantStore.listTenantRecords().catch(error => {
    console.warn('[TENANT SNAPSHOT] startup warm-up failed:', error.message);
  });
  await tenantAdmin.reconcileTransportUrls().catch(error => {
    console.warn('[TENANT TRANSPORT] startup reconciliation failed:', error.message);
  });
  startIncomingWalWorker();
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
    // Each instance boots its own Chromium, so starting them all at once turns a
    // restart into a thundering herd: with a tenant list of any size the host
    // runs out of memory before the first client is ready. Start a few at a
    // time and let each settle. Tune with WHATSPRO_BOOT_CONCURRENCY.
    const bootConcurrency = Math.max(1, Number(process.env.WHATSPRO_BOOT_CONCURRENCY || 2));
    const bootGap = Math.max(0, Number(process.env.WHATSPRO_BOOT_GAP_MS || 4000));
    console.log(`[BOOT] ${instances.length} инстанс, қатарлас ${bootConcurrency}, аралық ${bootGap}ms`);
    const queue = [...instances];
    const startNext = async () => {
      while (queue.length) {
        const inst = queue.shift();
        console.log(`[BOOT] Автоқосылу (QR немесе Сессия): ${inst.instanceId}`);
        await startWhatsAppInstance(inst.instanceId).catch(err => {
          console.error(`[BOOT] ${inst.instanceId} қосылу қатесі:`, err.message);
        });
        if (queue.length && bootGap) await new Promise(resolve => setTimeout(resolve, bootGap));
      }
    };
    // Not awaited: HTTP is already listening and must stay responsive while the
    // clients come up behind it.
    void Promise.all(Array.from({ length: Math.min(bootConcurrency, queue.length) }, startNext))
      .then(() => console.log('[BOOT] барлық инстанс өңделді'))
      .catch(err => console.error('[BOOT] кезек қатесі:', err?.message || err));
  } catch (err) {
    console.error('[BOOT] Автоқосылу кезіндегі қате:', err);
  }

  // Keeps every registered tenant connected 24/7 without waiting for customer
  // traffic, a dashboard visit, or a manual restart.
  startSessionSupervisor();

  return server;
}

// Node exits on an unhandled rejection by default, which here means dropping
// every live WhatsApp client over one missed .catch(). Log and keep serving,
// then let an uncaught exception restart us deliberately once the log is out.
// Mirrors the handlers Openbot already installs in src/server.ts.
process.on('unhandledRejection', reason => {
  console.error('[WhatsPro] unhandled rejection:', reason instanceof Error ? reason.stack || reason.message : reason);
});

process.on('uncaughtException', (error, origin) => {
  console.error(`[WhatsPro] uncaught exception (${origin}):`, error?.stack || error?.message || error);
  shutdownWhatsAppClients().catch(() => {});
  setTimeout(() => process.exit(1), 1500).unref();
});

// A deploy sends SIGTERM. Closing the browsers cleanly is what lets the stored
// credentials survive the restart, so no QR rescan is needed afterwards.
process.on('SIGTERM', async () => {
  await shutdownWhatsAppClients().catch(() => {});
  process.exit(0);
});

process.on('SIGINT', async () => {
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
  __test: {
    createSendIdempotency, isValidSendRequestId, remainingOperatorTtl, hasChatMediaToken,
    issuePanelGrant, hasPanelGrant, hasRenewableChatToken, isLoopbackRequest, issueChatToken,
    cachedLegacyHistoryKeys, legacyScanCache, LEGACY_SCAN_INTERVAL_MS,
    hasApiToken, requireApi, requireMasterApi, requireUiOrApi, requirePlatformAdmin, requireChatUiOrApi, requestedInstanceId, withinApiScope,
    issueConnectToken, readConnectToken, signSession,
    recoverSendWal, writeSendWal, sendWalPath, getEntryCreatedAt, SEND_WAL_DIR
  }
};
