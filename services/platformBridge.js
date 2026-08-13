'use strict';

const crypto = require('crypto');

const REQUEST_WINDOW_SECONDS = 300;
const REQUEST_ID_RE = /^req_[A-Za-z0-9_-]{8,128}$/;
const INSTANCE_RE = /^[A-Za-z0-9_-]{2,64}$/;

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function instanceKey(masterKey, instanceId) {
  return crypto.createHmac('sha256', masterKey)
    .update(`platform:chat-bridge:v1:${instanceId}`, 'utf8')
    .digest();
}

function expectedSignature(masterKey, requestId, instanceId, timestamp) {
  const canonical = ['chat-sos-unread-v1', requestId, instanceId, timestamp].join('\n');
  return `v1=${crypto.createHmac('sha256', instanceKey(masterKey, instanceId)).update(canonical, 'utf8').digest('hex')}`;
}

function verifyBridgeRequest(input, options = {}) {
  const masterKey = String(options.masterKey || '');
  const nowMs = Number(options.nowMs || Date.now());
  const instanceId = String(input?.instanceId || '').trim();
  const headerInstance = String(input?.headerInstance || '').trim();
  const requestId = String(input?.requestId || '').trim();
  const timestamp = String(input?.timestamp || '').trim();
  const signature = String(input?.signature || '').trim();
  if (masterKey.length < 32) return { ok: false, error: 'BRIDGE_NOT_CONFIGURED' };
  if (!INSTANCE_RE.test(instanceId) || headerInstance !== instanceId) return { ok: false, error: 'INSTANCE_MISMATCH' };
  if (!REQUEST_ID_RE.test(requestId)) return { ok: false, error: 'BAD_REQUEST_ID' };
  if (!/^\d{10}$/.test(timestamp) || Math.abs(Math.floor(nowMs / 1000) - Number(timestamp)) > REQUEST_WINDOW_SECONDS) {
    return { ok: false, error: 'STALE_TIMESTAMP' };
  }
  const expected = expectedSignature(masterKey, requestId, instanceId, timestamp);
  if (!/^v1=[a-f0-9]{64}$/.test(signature) || !safeEqual(signature, expected)) {
    return { ok: false, error: 'BAD_SIGNATURE' };
  }
  return { ok: true, instanceId, requestId, timestamp };
}

function createSosRevision(instanceId, rows) {
  const canonical = (Array.isArray(rows) ? rows : [])
    .filter(row => row?.sosUnread)
    .map(row => [String(row.phone || ''), String(row.sosSignalId || ''), Number(row.sosCreatedAt || 0)])
    .sort((a, b) => a.join(':').localeCompare(b.join(':')));
  return `rev_${crypto.createHash('sha256').update(JSON.stringify([instanceId, canonical])).digest('hex').slice(0, 24)}`;
}

module.exports = { REQUEST_WINDOW_SECONDS, createSosRevision, expectedSignature, verifyBridgeRequest };
