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

function cleanString(value, fallback = '') {
  const text = String(value ?? fallback ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  return text || fallback;
}

function normalizeInstance(value) {
  const instance = cleanString(value);
  return /^[A-Za-z0-9_-]{2,64}$/.test(instance) ? instance : '';
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

async function findRow(instanceValue) {
  const instance = normalizeInstance(instanceValue);
  if (!instance) return null;
  if (redisUsable()) {
    try {
      const row = parseRow(await redisClient.hGet(TENANT_STORE_KEY, instance));
      if (row) await upsertSnapshot(row).catch(error => console.warn('[TENANT SNAPSHOT] write failed:', error.message));
      return row || await findSnapshot(instance);
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
  const created = await redisClient.sendCommand(['HSETNX', TENANT_STORE_KEY, instance, JSON.stringify(stored)]);
  if (Number(created) !== 1) {
    const error = new Error('TENANT_ALREADY_EXISTS');
    error.statusCode = 409;
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
  await redisClient.hSet(TENANT_STORE_KEY, instance, JSON.stringify(stored));
  await upsertSnapshot(stored).catch(error => console.warn('[TENANT SNAPSHOT] update mirror failed:', error.message));
  return stored;
}

async function deleteRow(instanceValue) {
  const instance = normalizeInstance(instanceValue);
  requireRedis();
  const deleted = await redisClient.hDel(TENANT_STORE_KEY, instance);
  if (!deleted) {
    const error = new Error('TENANT_NOT_FOUND');
    error.statusCode = 404;
    throw error;
  }
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
