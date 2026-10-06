'use strict';

const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const walDirectory = path.resolve(
  process.env.WHATSPRO_INBOUND_WAL_DIR ||
  path.join(
    process.env.WHATSAPP_AUTH_PATH || path.join(process.cwd(), 'whatsapp_auth'),
    'incoming-wal'
  )
);
const maxRecords = Math.max(100, Number(process.env.WHATSPRO_INBOUND_WAL_MAX || 2000));
const maxAgeMs = Math.max(60_000, Number(process.env.WHATSPRO_INBOUND_WAL_MAX_AGE_MS || 7 * 24 * 60 * 60 * 1000));
const tombstoneTtlMs = Math.max(60_000, Number(process.env.WHATSPRO_INBOUND_WAL_TOMBSTONE_TTL_MS || 24 * 60 * 60 * 1000));
const agedRecordsLogged = new Set();
const recordLocks = new Map();
const safeCodes = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN',
  'EIO', 'ENOSPC', 'EACCES', 'EPERM', 'ENOENT', 'INCOMING_OPERATION_FAILED',
  'INCOMING_WAL_RECORD_WRITE_FAILED', 'INCOMING_WAL_COMPLETION_MARKER_FAILED',
  'INCOMING_WAL_REMOVE_FAILED', 'INCOMING_WAL_READ_FAILED',
  'redis_not_connected', 'openbot_not_delivered', 'OPENBOT_WEBHOOK_URL_missing',
  'missing_instance_or_phone', 'non_conversational', 'test_mode_blocked', 'stale_message', 'duplicate_message']);

function safeIncomingErrorCode(value) {
  const code = typeof value === 'string' ? value : value?.code;
  return safeCodes.has(code) ? code : 'INCOMING_OPERATION_FAILED';
}
function safeIncomingLastError(value) {
  if (!value) return '';
  const text = String(value);
  const stage = text.startsWith('redis:') ? 'redis:' : text.startsWith('openbot:') ? 'openbot:' : '';
  return stage + safeIncomingErrorCode(stage ? text.slice(stage.length) : text);
}
function incomingLogReference(record) {
  return crypto.createHash('sha256').update(String(record?.id || recordId(record?.payload || record || {}))).digest('hex').slice(0, 16);
}
function logIncomingFailure(event, record, error) {
  console.warn('[INBOUND WAL] operation=' + incomingLogReference(record) + ' event=' + event + ' code=' + safeIncomingErrorCode(error));
}
function walFailure(code, cause, preventVolatileDelivery = false) {
  const error = new Error(code, { cause });
  error.code = code;
  error.preventVolatileDelivery = preventVolatileDelivery;
  return error;
}
async function withRecordLock(id, operation) {
  const previous = recordLocks.get(id) || Promise.resolve();
  let release;
  const current = new Promise(resolve => { release = resolve; });
  recordLocks.set(id, current);
  await previous;
  try { return await operation(); }
  finally { release(); if (recordLocks.get(id) === current) recordLocks.delete(id); }
}
function recordId(payload) {
  const instance = String(payload?.instanceId || payload?.instance || '').trim();
  const messageId = String(payload?.messageId || payload?.id || payload?._data?.id?.id || '').trim();
  const phone = String(payload?.phone || payload?.from || payload?.sender || '').replace(/\D/g, '');
  const timestamp = String(payload?.timestamp || payload?.t || '');
  const text = String(payload?.text || payload?.body || '');
  return crypto.createHash('sha256')
    .update(`${instance}|${messageId}|${phone}|${timestamp}|${text}`)
    .digest('hex');
}
function walPath(id) {
  return path.join(walDirectory, `${id}.json`);
}
function tombstonePath(id) {
  return path.join(walDirectory, `${id}.done`);
}
function isCompleted(record) { return record?.pendingRedis === false && record?.pendingOpenBot === false; }
async function syncFile(filePath) {
  const handle = await fs.open(filePath, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}
async function syncDirectory() { await syncFile(walDirectory); }
async function atomicWrite(filePath, value) {
  await fs.mkdir(walDirectory, { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    // Keep writeFile as the actual fault boundary; sync content and rename metadata.
    await fs.writeFile(temporary, JSON.stringify(value), { encoding: 'utf8', mode: 0o600 });
    await syncFile(temporary);
    await fs.rename(temporary, filePath);
    await syncDirectory();
  } catch (error) {
    await fs.unlink(temporary).catch(() => {});
    throw error;
  }
}
async function readRecord(filePath, strict = false) {
  try {
    const record = JSON.parse(await fs.readFile(filePath, 'utf8'));
    if (record && typeof record === 'object') return record;
    throw new Error('INVALID_WAL_RECORD');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    if (strict) throw walFailure('INCOMING_WAL_READ_FAILED', error, true);
    return null;
  }
}
async function hasTombstone(id) {
  const record = await readRecord(tombstonePath(id), true);
  if (!record) return false;
  const doneAt = Number(record.doneAt);
  if (record.id !== id || !Number.isFinite(doneAt) || doneAt <= 0)
    throw walFailure('INCOMING_WAL_READ_FAILED', undefined, true);
  if (Date.now() - doneAt > tombstoneTtlMs) {
    await fs.unlink(tombstonePath(id)).catch(error => {
      if (error.code !== 'ENOENT') throw walFailure('INCOMING_WAL_REMOVE_FAILED', error, true);
    });
    return false;
  }
  return true;
}
async function enqueueIncoming(payload) {
  const id = recordId(payload);
  return withRecordLock(id, async () => {
    if (await hasTombstone(id)) return null;
    const existing = await readRecord(walPath(id), true);
    const record = {
      id, payload, createdAt: Number(existing?.createdAt || Date.now()), updatedAt: Date.now(),
      attempts: Number(existing?.attempts || 0), nextAttemptAt: Number(existing?.nextAttemptAt || 0),
      pendingRedis: existing?.pendingRedis !== false, pendingOpenBot: existing?.pendingOpenBot !== false,
      lastError: safeIncomingLastError(existing?.lastError),
      ...(existing?.completedAt ? { completedAt: existing.completedAt } : {})
    };
    try { await atomicWrite(walPath(id), record); }
    catch (error) { throw walFailure('INCOMING_WAL_RECORD_WRITE_FAILED', error,
      existing?.pendingRedis === false || existing?.pendingOpenBot === false); }
    return record;
  });
}
async function removeIncoming(id) {
  try { await fs.unlink(walPath(id)); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  await syncDirectory();
}
async function finishCompleted(record) {
  // The completed checkpoint is already durable. If the marker or removal fails,
  // retain that proof and surface failure; never recreate both delivery legs.
  try { await atomicWrite(tombstonePath(record.id), { id: record.id, doneAt: Date.now() }); }
  catch (error) { throw walFailure('INCOMING_WAL_COMPLETION_MARKER_FAILED', error, true); }
  try { await removeIncoming(record.id); }
  catch (error) { throw walFailure('INCOMING_WAL_REMOVE_FAILED', error, true); }
  return null;
}
async function updateIncoming(record) {
  return withRecordLock(record.id, async () => {
    const existing = await readRecord(walPath(record.id), true);
    if (!existing && await hasTombstone(record.id)) return null;
    const next = { ...record, updatedAt: Date.now(),
      pendingRedis: existing?.pendingRedis === false ? false : record.pendingRedis !== false,
      pendingOpenBot: existing?.pendingOpenBot === false ? false : record.pendingOpenBot !== false,
      attempts: Math.max(Number(existing?.attempts || 0), Number(record.attempts || 0)),
      lastError: safeIncomingLastError(record.lastError) };
    if (isCompleted(next)) next.completedAt = Number(existing?.completedAt || record.completedAt || Date.now());
    try { await atomicWrite(walPath(next.id), next); }
    catch (error) { throw walFailure('INCOMING_WAL_RECORD_WRITE_FAILED', error,
      existing?.pendingRedis === false || existing?.pendingOpenBot === false); }
    return isCompleted(next) ? finishCompleted(next) : next;
  });
}
async function completeIncoming(id) {
  const record = await readRecord(walPath(id), true);
  if (record) return updateIncoming({ ...record, pendingRedis: false, pendingOpenBot: false });
  if (await hasTombstone(id)) return null;
  throw walFailure('INCOMING_WAL_READ_FAILED', undefined, true);
}
async function readIncomingState(id) {
  return withRecordLock(id, async () => {
    const record = await readRecord(walPath(id), true);
    if (record) return { pendingRedis: record.pendingRedis !== false, pendingOpenBot: record.pendingOpenBot !== false,
      attempts: Number(record.attempts || 0), completedAt: record.completedAt };
    return await hasTombstone(id) ? { pendingRedis: false, pendingOpenBot: false } : null;
  });
}
async function readAllIncoming() {
  await fs.mkdir(walDirectory, { recursive: true, mode: 0o700 });
  const entries = await fs.readdir(walDirectory);
  const now = Date.now();
  for (const name of entries.filter(entry => /^[a-f0-9]{64}\.done$/.test(entry))) {
    const id = name.slice(0, -5);
    try { await hasTombstone(id); }
    catch (error) { logIncomingFailure('TOMBSTONE_READ_FAILED', { id }, error); }
  }
  const records = [];
  for (const name of entries.filter(entry => /^[a-f0-9]{64}\.json$/.test(entry))) {
    const filePath = path.join(walDirectory, name);
    let record;
    try { record = await readRecord(filePath, true); }
    catch (error) { logIncomingFailure('RECORD_READ_FAILED', { id: name.slice(0, -5) }, error); continue; }
    if (!record) continue;
    if (isCompleted(record)) {
      // Legacy completed files also need fresh durable proof. Creation age is
      // never a reason to delete completion without a protected dedup window.
      try { await updateIncoming(record); continue; }
      catch (error) {
        logIncomingFailure('COMPLETION_RETRY_FAILED', record, error);
        const retained = await readRecord(filePath, true).catch(() => record);
        if (retained) records.push(retained);
        continue;
      }
    }
    record.lastError = safeIncomingLastError(record.lastError);
    if (now - Number(record.createdAt || 0) > maxAgeMs && !agedRecordsLogged.has(record.id)) {
      agedRecordsLogged.add(record.id);
      const attempts = Number(record.attempts);
      console.warn('[INBOUND WAL] operation=' + incomingLogReference(record) + ' event=AGED_UNDELIVERED attempts=' +
        (Number.isFinite(attempts) ? Math.max(0, Math.min(1000000, attempts)) : 0) + ' code=' +
        safeIncomingErrorCode(record.lastError.replace(/^(redis|openbot):/, '')));
    }
    records.push(record);
  }
  records.sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0));
  return records.slice(0, maxRecords);
}
async function listIncoming(limit = 50) {
  const now = Date.now();
  return (await readAllIncoming())
    .filter(record => Number(record.nextAttemptAt || 0) <= now)
    .sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0))
    .slice(0, limit);
}
async function incomingWalSummary() {
  const records = await readAllIncoming();
  const now = Date.now();
  return {
    directory: walDirectory,
    pending: records.length,
    pendingRedis: records.filter(record => record.pendingRedis).length,
    pendingOpenBot: records.filter(record => record.pendingOpenBot).length,
    // Undelivered past the max age: kept rather than destroyed, so it must be
    // visible to whoever reads the health report.
    stuck: records.filter(record => now - Number(record.createdAt || 0) > maxAgeMs).length
  };
}
module.exports = {
  enqueueIncoming,
  incomingWalSummary,
  listIncoming,
  recordId,
  removeIncoming,
  updateIncoming,
  readIncomingState,
  safeIncomingErrorCode,
  safeIncomingLastError,
  incomingLogReference,
  logIncomingFailure,
  __test: { walPath, tombstonePath, hasTombstone, completeIncoming, readAllIncoming }
};
