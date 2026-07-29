'use strict';

const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const SNAPSHOT_VERSION = 1;
const snapshotEnabled = Boolean(
  String(process.env.WHATSPRO_TENANT_SNAPSHOT_PATH || process.env.WHATSAPP_AUTH_PATH || '').trim()
);
const snapshotPath = path.resolve(
  process.env.WHATSPRO_TENANT_SNAPSHOT_PATH ||
  path.join(
    process.env.WHATSAPP_AUTH_PATH || path.join(process.cwd(), 'whatsapp_auth'),
    'platform-tenants.snapshot.json'
  )
);

let loaded = false;
let rows = {};
let updatedAt = '';
let writeQueue = Promise.resolve();

function safeRows(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result = {};
  for (const [instance, row] of Object.entries(value)) {
    if (!/^[A-Za-z0-9_-]{2,64}$/.test(instance)) continue;
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    if (String(row.instance_id || '') !== instance) continue;
    result[instance] = row;
  }
  return result;
}

async function load() {
  if (loaded) return rows;
  loaded = true;
  if (!snapshotEnabled) return rows;
  try {
    const parsed = JSON.parse(await fs.readFile(snapshotPath, 'utf8'));
    if (Number(parsed?.version) === SNAPSHOT_VERSION) {
      rows = safeRows(parsed.rows);
      updatedAt = String(parsed.updatedAt || '');
    }
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn('[TENANT SNAPSHOT] read failed:', error.message);
  }
  return rows;
}

async function persist() {
  if (!snapshotEnabled) {
    updatedAt = new Date().toISOString();
    return;
  }
  const directory = path.dirname(snapshotPath);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${snapshotPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const payload = JSON.stringify({
    version: SNAPSHOT_VERSION,
    updatedAt: new Date().toISOString(),
    rows
  });
  await fs.writeFile(temporary, payload, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(temporary, snapshotPath);
  updatedAt = JSON.parse(payload).updatedAt;
}

async function mutate(operation) {
  await load();
  operation(rows);
  writeQueue = writeQueue.then(persist, persist);
  await writeQueue;
}

async function replaceSnapshot(records) {
  await mutate(current => {
    for (const key of Object.keys(current)) delete current[key];
    for (const row of records || []) {
      const instance = String(row?.instance_id || '');
      if (/^[A-Za-z0-9_-]{2,64}$/.test(instance)) current[instance] = row;
    }
  });
}

async function upsertSnapshot(row) {
  const instance = String(row?.instance_id || '');
  if (!/^[A-Za-z0-9_-]{2,64}$/.test(instance)) return false;
  await mutate(current => { current[instance] = row; });
  return true;
}

async function deleteSnapshot(instance) {
  await mutate(current => { delete current[String(instance || '')]; });
}

async function findSnapshot(instance) {
  await load();
  return rows[String(instance || '')] || null;
}

async function listSnapshot() {
  await load();
  return Object.values(rows);
}

async function snapshotSummary() {
  await load();
  return {
    path: snapshotPath,
    persisted: snapshotEnabled,
    tenants: Object.keys(rows).length,
    updatedAt,
    ready: Object.keys(rows).length > 0
  };
}

module.exports = {
  deleteSnapshot,
  findSnapshot,
  listSnapshot,
  replaceSnapshot,
  snapshotSummary,
  upsertSnapshot,
  __test: { safeRows }
};
