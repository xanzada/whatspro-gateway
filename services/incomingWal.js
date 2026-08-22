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
// A tombstone only has to outlive WhatsApp's own replay window, not the WAL itself.
const tombstoneTtlMs = Math.max(60_000, Number(process.env.WHATSPRO_INBOUND_WAL_TOMBSTONE_TTL_MS || 24 * 60 * 60 * 1000));
// An aged undelivered record is reported once, not on every 5s drain pass.
const agedRecordsLogged = new Set();

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
  if (await hasTombstone(id)) return null;
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
    await completeIncoming(next.id);
    return null;
  }
  await atomicWrite(walPath(next.id), next);
  return next;
}

// A finished record used to be deleted outright. The record id is content-addressed,
// so a re-delivery of the same WhatsApp message (a messages.upsert replay after a
// reconnect) then looked brand new and was forwarded to Openbot a SECOND time -
// Redis is protected by appendMessageOnce, the Openbot leg was not, so the customer
// got a second bot reply and, on an order intent, a duplicated order (2026-08-22).
// A small tombstone remembers the completion instead.
async function completeIncoming(id) {
  await removeIncoming(id);
  await atomicWrite(tombstonePath(id), { id, doneAt: Date.now() }).catch(() => {});
}

function tombstonePath(id) {
  return path.join(walDirectory, `${id}.done`);
}

async function hasTombstone(id) {
  try {
    const record = JSON.parse(await fs.readFile(tombstonePath(id), 'utf8'));
    if (Date.now() - Number(record?.doneAt || 0) > tombstoneTtlMs) {
      await fs.unlink(tombstonePath(id)).catch(() => {});
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function removeIncoming(id) {
  await fs.unlink(walPath(id)).catch(error => {
    if (error.code !== 'ENOENT') throw error;
  });
}

async function readAllIncoming() {
  await fs.mkdir(walDirectory, { recursive: true, mode: 0o700 });
  const entries = await fs.readdir(walDirectory);
  const names = entries.filter(name => /^[a-f0-9]{64}\.json$/.test(name));
  // Expired tombstones are the only thing this sweep may delete unconditionally.
  const now = Date.now();
  for (const name of entries.filter(entry => /^[a-f0-9]{64}\.done$/.test(entry))) {
    const filePath = path.join(walDirectory, name);
    const record = await readRecord(filePath);
    if (!record || now - Number(record.doneAt || 0) > tombstoneTtlMs) {
      await fs.unlink(filePath).catch(() => {});
    }
  }
  const records = [];
  for (const name of names) {
    const filePath = path.join(walDirectory, name);
    const record = await readRecord(filePath);
    if (!record) {
      await fs.unlink(filePath).catch(() => {});
      continue;
    }
    // WHY the age check no longer deletes: the sweep used to unlink anything older
    // than the max age whether or not it had ever been delivered, so a long Openbot
    // or Redis outage ended in permanent, silent loss of customer messages. Aged
    // undelivered work is kept and reported instead (2026-08-22).
    if (now - Number(record.createdAt || 0) > maxAgeMs) {
      if (!record.pendingRedis && !record.pendingOpenBot) {
        await fs.unlink(filePath).catch(() => {});
        continue;
      }
      if (!agedRecordsLogged.has(record.id)) {
        agedRecordsLogged.add(record.id);
        console.warn(`[INBOUND WAL] record still undelivered after ${Math.round(maxAgeMs / 3600000)}h, keeping it id=${record.id} attempts=${record.attempts || 0} lastError=${record.lastError || '-'}`);
      }
    }
    records.push(record);
  }
  // Cap AFTER ordering by age: the cap used to apply to readdir order, so once the
  // directory held more than maxRecords entries the ones beyond the cut were never
  // drained at all, in no predictable order.
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
  __test: { walPath, tombstonePath, hasTombstone, completeIncoming, readAllIncoming }
};
