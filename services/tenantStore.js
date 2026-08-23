'use strict';

const { redisClient } = require('../config/redis');
const {
  deleteSnapshot,
  findSnapshot,
  listSnapshot,
  replaceSnapshot,
  snapshotSummary,
  upsertSnapshot
} = require('./tenantSnapshot');

const TENANT_STORE_KEY = 'whatspro:tenants:v1';
const ALEMI_INSTANCE_INDEX_KEY = 'whatspro:alemi-instance-owner:v1';

function cleanString(value, fallback = '') {
  const text = String(value ?? fallback ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  return text || fallback;
}

function normalizeInstance(value) {
  const instance = cleanString(value);
  return /^[A-Za-z0-9_-]{2,64}$/.test(instance) ? instance : '';
}

function normalizeAlemiInstance(value) {
  const instance = cleanString(value);
  return /^[A-Za-z0-9_-]{2,128}$/.test(instance) ? instance : '';
}

function alemiInstanceConflict(instance) {
  const error = new Error('ALEMI_INSTANCE_ALREADY_EXISTS');
  error.statusCode = 409;
  error.fields = ['alemiInstance'];
  error.instanceId = instance;
  return error;
}

// HSETNX is the cross-process uniqueness gate. It runs before the tenant write,
// so two replicas onboarding the same Alemi instance cannot both win.
async function claimAlemiInstance(alemiInstance, ownerInstance) {
  if (!alemiInstance) return false;
  const claimed = await redisClient.sendCommand(['HSETNX', ALEMI_INSTANCE_INDEX_KEY, alemiInstance, ownerInstance]);
  if (Number(claimed) === 1) return true;
  const owner = await redisClient.hGet(ALEMI_INSTANCE_INDEX_KEY, alemiInstance);
  if (owner === ownerInstance) return false;
  throw alemiInstanceConflict(alemiInstance);
}

async function releaseAlemiInstance(alemiInstance, ownerInstance) {
  if (!alemiInstance) return;
  const owner = await redisClient.hGet(ALEMI_INSTANCE_INDEX_KEY, alemiInstance);
  if (owner === ownerInstance) await redisClient.hDel(ALEMI_INSTANCE_INDEX_KEY, alemiInstance);
}

function normalizeColor(value, fallback = '') {
  const text = cleanString(value);
  return /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(text) ? text : fallback;
}

function pickFirst(record, keys, fallback = '') {
  for (const key of keys) {
    const value = record?.[key];
    if (value !== undefined && value !== null && String(value).trim()) return String(value).trim();
  }
  return fallback;
}

function unavailable() {
  const error = new Error('PLATFORM_STORE_UNAVAILABLE');
  error.statusCode = 503;
  return error;
}

function requireRedis() {
  if (!redisUsable()) throw unavailable();
}

function redisUsable() {
  return Boolean(
    redisClient.isReady ||
    (process.env.NODE_TEST_CONTEXT && redisClient.isOpen)
  );
}

function parseRow(raw) {
  try {
    const row = JSON.parse(String(raw || ''));
    return row && typeof row === 'object' && !Array.isArray(row) ? row : null;
  } catch {
    return null;
  }
}

function sanitizeTenantConfig(record, instance) {
  if (!record) {
    return {
      instance,
      found: false,
      branding: {
        name: instance || 'WhatsPro',
        accentColor: '#0f9f7a',
        secondaryColor: '#2563eb',
        backgroundColor: '#f5f7fb'
      },
      operations: {}
    };
  }
  const tenantInstance = normalizeInstance(pickFirst(record, ['instance_id', 'instance'], instance));
  if (instance && tenantInstance && tenantInstance !== instance) return sanitizeTenantConfig(null, instance);
  return {
    instance: tenantInstance,
    found: true,
    branding: {
      name: pickFirst(record, ['brand', 'chat_title'], tenantInstance || 'WhatsPro'),
      subtitle: pickFirst(record, ['chat_subtitle', 'description', 'address'], ''),
      logoUrl: pickFirst(record, ['logo_url', 'logoUrl'], ''),
      accentColor: normalizeColor(pickFirst(record, ['chat_accent_color', 'accent_color']), '#0f9f7a'),
      secondaryColor: normalizeColor(pickFirst(record, ['chat_secondary_color', 'secondary_color']), '#2563eb'),
      backgroundColor: normalizeColor(pickFirst(record, ['chat_background_color', 'background_color']), '#f5f7fb')
    },
    operations: {
      timezone: pickFirst(record, ['timezone', 'time_zone'], ''),
      locale: pickFirst(record, ['locale', 'language'], ''),
      workHours: pickFirst(record, ['work_hours', 'workHours'], ''),
      phone: pickFirst(record, ['whatsapp_phone', 'whatspro_phone'], '')
    }
  };
}

// The snapshot is a disaster-recovery mirror of Redis, not a write-through cache.
// findRow is on the hot path - getTestModePolicy runs per inbound message, isBotEnabled
// per message, handleIncomingCall per call, /api/chat/inbox every 5s per open panel -
// and every successful read used to call upsertSnapshot, which serialises EVERY tenant
// and rewrites the whole file behind a serialised write queue. So the gateway wrote the
// full snapshot to disk in proportion to traffic multiplied by tenant count, and inbox
// polls queued behind that write chain together with message ingestion (found
// 2026-08-22). Mirror only when the row actually differs from what is already on disk.
function sameSnapshotRow(a, b) {
  if (!a || !b) return false;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

// The hub knows a restaurant by its alemi_instance; we know it by instance_id. They are
// the same string for some tenants and different for others (kebab1 vs kabab-1), and the
// hub's integration page links the chat panel using ITS id - so every tenant whose ids
// differ had a dead panel, while the inbox answered an empty list rather than an error
// (found 2026-08-23). The ownership index is already maintained on create/update/delete,
// so resolving through it adds no new state to keep in sync.
async function resolveInstanceAlias(instanceValue) {
  const requested = normalizeInstance(instanceValue);
  if (!requested) return null;
  // A canonical id always wins, so an alias can never shadow a real tenant.
  if (await findRow(requested)) return requested;
  if (redisUsable()) {
    try {
      const owner = await redisClient.hGet(ALEMI_INSTANCE_INDEX_KEY, requested);
      const normalizedOwner = normalizeInstance(owner);
      if (normalizedOwner && (await findRow(normalizedOwner))) return normalizedOwner;
    } catch (error) {
      console.warn(`[TENANT STORE] alias lookup failed (${requested}):`, error.message);
    }
  }
  // Redis unavailable, or no index entry: fall back to a scan of what we can see. The
  // snapshot mirrors every row, so a restart during a Redis outage still resolves.
  try {
    const rows = await listTenantRecords();
    const match = (Array.isArray(rows) ? rows : []).find(
      (row) => normalizeInstance(row?.alemi_instance) === requested
    );
    const matchedId = normalizeInstance(match?.instance_id);
    if (matchedId) return matchedId;
  } catch {
    // Nothing further to try; the caller reports TENANT_NOT_FOUND as before.
  }
  return null;
}

async function findRow(instanceValue) {
  const instance = normalizeInstance(instanceValue);
  if (!instance) return null;
  if (redisUsable()) {
    try {
      const row = parseRow(await redisClient.hGet(TENANT_STORE_KEY, instance));
      if (row) {
        const mirrored = await findSnapshot(instance).catch(() => null);
        if (!sameSnapshotRow(row, mirrored)) {
          await upsertSnapshot(row).catch(error => console.warn('[TENANT SNAPSHOT] write failed:', error.message));
        }
        return row;
      }
      return await findSnapshot(instance);
    } catch (error) {
      console.warn(`[TENANT STORE] Redis read failed (${instance}), using snapshot:`, error.message);
    }
  }
  return findSnapshot(instance);
}

async function listTenantRecords() {
  let records = [];
  if (redisUsable()) {
    try {
      const values = Object.values(await redisClient.hGetAll(TENANT_STORE_KEY));
      records = values.map(parseRow).filter(Boolean);
      if (records.length) {
        await replaceSnapshot(records).catch(error => console.warn('[TENANT SNAPSHOT] replace failed:', error.message));
      }
    } catch (error) {
      console.warn('[TENANT STORE] Redis list failed, using snapshot:', error.message);
    }
  }
  if (!records.length) records = await listSnapshot();
  return records.sort((a, b) => String(a.brand || a.instance_id).localeCompare(String(b.brand || b.instance_id)));
}

async function createRow(row) {
  requireRedis();
  const instance = normalizeInstance(row?.instance_id);
  if (!instance) throw new Error('BAD_INSTANCE_ID');
  const stored = { ...row, instance_id: instance, created_at: row.created_at || new Date().toISOString(), updated_at: new Date().toISOString() };
  const alemiInstance = normalizeAlemiInstance(stored.alemi_instance);
  if (stored.alemi_instance && !alemiInstance) throw alemiInstanceConflict(stored.alemi_instance);
  const claimed = await claimAlemiInstance(alemiInstance, instance);
  try {
    const created = await redisClient.sendCommand(['HSETNX', TENANT_STORE_KEY, instance, JSON.stringify(stored)]);
    if (Number(created) !== 1) {
      const error = new Error('TENANT_ALREADY_EXISTS');
      error.statusCode = 409;
      throw error;
    }
  } catch (error) {
    if (claimed) await releaseAlemiInstance(alemiInstance, instance).catch(() => {});
    throw error;
  }
  await upsertSnapshot(stored).catch(error => console.warn('[TENANT SNAPSHOT] create mirror failed:', error.message));
  return stored;
}

async function updateRow(instanceValue, patch) {
  const instance = normalizeInstance(instanceValue);
  const existing = await findRow(instance);
  if (!existing) {
    const error = new Error('TENANT_NOT_FOUND');
    error.statusCode = 404;
    throw error;
  }
  const stored = { ...existing, ...patch, instance_id: instance, created_at: existing.created_at || new Date().toISOString(), updated_at: new Date().toISOString() };
  const previousAlemiInstance = normalizeAlemiInstance(existing.alemi_instance);
  const alemiInstance = normalizeAlemiInstance(stored.alemi_instance);
  if (stored.alemi_instance && !alemiInstance) throw alemiInstanceConflict(stored.alemi_instance);
  const claimed = await claimAlemiInstance(alemiInstance, instance);
  try {
    await redisClient.hSet(TENANT_STORE_KEY, instance, JSON.stringify(stored));
  } catch (error) {
    if (claimed) await releaseAlemiInstance(alemiInstance, instance).catch(() => {});
    throw error;
  }
  if (previousAlemiInstance && previousAlemiInstance !== alemiInstance) {
    await releaseAlemiInstance(previousAlemiInstance, instance);
  }
  await upsertSnapshot(stored).catch(error => console.warn('[TENANT SNAPSHOT] update mirror failed:', error.message));
  return stored;
}

async function deleteRow(instanceValue) {
  const instance = normalizeInstance(instanceValue);
  requireRedis();
  const existing = await findRow(instance);
  const deleted = await redisClient.hDel(TENANT_STORE_KEY, instance);
  if (!deleted) {
    const error = new Error('TENANT_NOT_FOUND');
    error.statusCode = 404;
    throw error;
  }
  await releaseAlemiInstance(normalizeAlemiInstance(existing?.alemi_instance), instance);
  await deleteSnapshot(instance).catch(error => console.warn('[TENANT SNAPSHOT] delete mirror failed:', error.message));
  return true;
}

async function getTenantChatConfig(instanceValue) {
  const instance = normalizeInstance(instanceValue);
  if (!instance) return sanitizeTenantConfig(null, instance);
  return sanitizeTenantConfig(await findRow(instance), instance);
}

async function getTenantApiToken(instanceValue) {
  const row = await findRow(instanceValue);
  return cleanString(pickFirst(row, ['whatspro_api_token', 'api_token'], ''));
}

async function getStorageSummary() {
  const snapshot = await snapshotSummary();
  const tenants = redisUsable()
    ? await redisClient.hLen(TENANT_STORE_KEY).catch(() => snapshot.tenants)
    : snapshot.tenants;
  return {
    backend: redisUsable() ? 'redis+snapshot' : 'snapshot',
    keyVersion: 1,
    tenants,
    initialized: tenants > 0,
    redisReady: redisUsable(),
    snapshotReady: snapshot.ready,
    snapshotUpdatedAt: snapshot.updatedAt
  };
}

module.exports = {
  ALEMI_INSTANCE_INDEX_KEY,
  resolveInstanceAlias,
  TENANT_STORE_KEY,
  createRow,
  deleteRow,
  findRow,
  getStorageSummary,
  getTenantApiToken,
  getTenantChatConfig,
  listTenantRecords,
  normalizeInstance,
  sanitizeTenantConfig,
  updateRow,
  __test: { cleanString, normalizeColor, parseRow, pickFirst }
};
