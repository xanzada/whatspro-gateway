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

async function atomicWrite(filePath, value) {
  await fs.mkdir(walDirectory, { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(value), { encoding: 'utf8', mode: 0o600 });
  await fs.rename(temporary, filePath);
}

async function readRecord(filePath) {
  try {
    const record = JSON.parse(await fs.readFile(filePath, 'utf8'));
    return record && typeof record === 'object' ? record : null;
  } catch {
    return null;
  }
}

async function enqueueIncoming(payload) {
  const id = recordId(payload);
  const filePath = walPath(id);
  const existing = await readRecord(filePath);
  const record = {
    id,
    payload,
    createdAt: Number(existing?.createdAt || Date.now()),
    updatedAt: Date.now(),
    attempts: Number(existing?.attempts || 0),
    nextAttemptAt: Number(existing?.nextAttemptAt || 0),
    pendingRedis: existing?.pendingRedis !== false,
    pendingOpenBot: existing?.pendingOpenBot !== false,
    lastError: String(existing?.lastError || '')
  };
  await atomicWrite(filePath, record);
  return record;
}

async function updateIncoming(record) {
  const next = { ...record, updatedAt: Date.now() };
  if (!next.pendingRedis && !next.pendingOpenBot) {
    await removeIncoming(next.id);
    return null;
  }
  await atomicWrite(walPath(next.id), next);
  return next;
}

async function removeIncoming(id) {
  await fs.unlink(walPath(id)).catch(error => {
    if (error.code !== 'ENOENT') throw error;
  });
}

async function readAllIncoming() {
  await fs.mkdir(walDirectory, { recursive: true, mode: 0o700 });
  const names = (await fs.readdir(walDirectory))
    .filter(name => /^[a-f0-9]{64}\.json$/.test(name))
    .slice(0, maxRecords);
  const records = [];
  const now = Date.now();
  for (const name of names) {
    const filePath = path.join(walDirectory, name);
    const record = await readRecord(filePath);
    if (!record || now - Number(record.createdAt || 0) > maxAgeMs) {
      await fs.unlink(filePath).catch(() => {});
      continue;
    }
    records.push(record);
  }
  return records;
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
  return {
    directory: walDirectory,
    pending: records.length,
    pendingRedis: records.filter(record => record.pendingRedis).length,
    pendingOpenBot: records.filter(record => record.pendingOpenBot).length
  };
}

module.exports = {
  enqueueIncoming,
  incomingWalSummary,
  listIncoming,
  recordId,
  removeIncoming,
  updateIncoming,
  __test: { walPath }
};
