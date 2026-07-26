const axios = require('axios');

function positiveInt(value, fallback, minimum = 1) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum ? parsed : fallback;
}

const CACHE_TTL_MS = positiveInt(process.env.NOCODB_CONFIG_CACHE_MS, 300000, 1000);
const NEGATIVE_CACHE_TTL_MS = Math.min(CACHE_TTL_MS, positiveInt(process.env.NOCODB_CONFIG_NEGATIVE_CACHE_MS, 30000, 1000));
const CACHE_MAX_ENTRIES = positiveInt(process.env.NOCODB_CONFIG_CACHE_MAX, 500, 10);
const MAX_CONCURRENT_LOOKUPS = positiveInt(process.env.NOCODB_CONFIG_MAX_CONCURRENCY, 4);
const MAX_PENDING_LOOKUPS = positiveInt(process.env.NOCODB_CONFIG_MAX_PENDING, 32);
const LOOKUP_QUEUE_TIMEOUT_MS = positiveInt(process.env.NOCODB_CONFIG_QUEUE_TIMEOUT_MS, 1000, 50);
const CIRCUIT_BREAKER_MS = positiveInt(process.env.NOCODB_CONFIG_CIRCUIT_MS, 10000, 1000);
const cache = new Map();
const inflight = new Map();
let activeLookups = 0;
let pendingLookups = 0;
let circuitOpenUntil = 0;

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

function baseUrl() {
  return String(process.env.NOCODB_URL || '').replace(/\/+$/, '');
}

function tableId() {
  return cleanString(process.env.NOCODB_RESTAURANTS_TABLE_ID || process.env.NOCODB_TABLE_ID);
}

function tableUrl() {
  const base = baseUrl();
  const table = tableId();
  if (!base || !table) return '';
  return `${base}/api/v2/tables/${table}/records`;
}

function nocodbHeaders() {
  return { 'xc-token': process.env.NOCODB_TOKEN || '' };
}

function pickFirst(record, keys, fallback = '') {
  for (const key of keys) {
    const value = record?.[key];
    if (value !== undefined && value !== null && String(value).trim()) return String(value).trim();
  }
  return fallback;
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

  const tenantInstance = normalizeInstance(pickFirst(record, ['instance_id', 'instance', 'restaurant_instance', 'restaurantInstance'], instance));
  if (instance && tenantInstance && tenantInstance !== instance) return sanitizeTenantConfig(null, instance);
  return {
    instance: tenantInstance,
    found: true,
    branding: {
      name: pickFirst(record, ['brand', 'chat_title', 'brand_name', 'restaurant_name', 'name', 'title'], tenantInstance || 'WhatsPro'),
      subtitle: pickFirst(record, ['chat_subtitle', 'description', 'address'], ''),
      logoUrl: pickFirst(record, ['logo_url', 'logoUrl', 'brand_logo', 'brandLogo'], ''),
      accentColor: normalizeColor(pickFirst(record, ['chat_accent_color', 'accent_color', 'accentColor', 'primary_color', 'primaryColor']), '#0f9f7a'),
      secondaryColor: normalizeColor(pickFirst(record, ['chat_secondary_color', 'secondary_color', 'secondaryColor']), '#2563eb'),
      backgroundColor: normalizeColor(pickFirst(record, ['chat_background_color', 'background_color', 'backgroundColor']), '#f5f7fb')
    },
    operations: {
      timezone: pickFirst(record, ['timezone', 'time_zone', 'tz'], ''),
      locale: pickFirst(record, ['locale', 'language', 'lang'], ''),
      workHours: pickFirst(record, ['work_hours', 'workHours'], ''),
      phone: pickFirst(record, ['whatsapp_phone', 'whatspro_phone', 'bot_phone', 'receiver_phone'], '')
    }
  };
}

async function queryByColumn(instance, column) {
  const url = tableUrl();
  if (!url || !process.env.NOCODB_TOKEN) return null;
  const response = await axios.get(url, {
    headers: nocodbHeaders(),
    params: { where: `(${column},eq,${instance})`, limit: 1 },
    timeout: Number(process.env.NOCODB_TIMEOUT_MS || 8000)
  });
  const list = Array.isArray(response.data?.list) ? response.data.list : [];
  return list[0] || null;
}

function getCached(key, currentTime) {
  const cached = cache.get(key);
  if (!cached) return null;
  if (cached.expiresAt <= currentTime) {
    cache.delete(key);
    return null;
  }
  cache.delete(key);
  cache.set(key, cached);
  return cached.value;
}

function setCached(key, value, ttl) {
  while (cache.size >= CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value);
  cache.set(key, { value, expiresAt: Date.now() + ttl });
}

function openCircuit(error) {
  const retryAfter = Number(error?.response?.headers?.['retry-after'] || 0);
  const retryAfterMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 0;
  circuitOpenUntil = Date.now() + Math.max(CIRCUIT_BREAKER_MS, retryAfterMs);
}

async function acquireLookupSlot() {
  if (activeLookups < MAX_CONCURRENT_LOOKUPS) {
    activeLookups += 1;
    return true;
  }
  if (pendingLookups >= MAX_PENDING_LOOKUPS) return false;
  pendingLookups += 1;
  const deadline = Date.now() + LOOKUP_QUEUE_TIMEOUT_MS;
  try {
    while (activeLookups >= MAX_CONCURRENT_LOOKUPS && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    if (activeLookups >= MAX_CONCURRENT_LOOKUPS || Date.now() < circuitOpenUntil) return false;
    activeLookups += 1;
    return true;
  } finally {
    pendingLookups -= 1;
  }
}

async function loadTenantConfig(instance, cacheKey) {
  let transportFailed = false;
  let record = null;

  for (const column of ['instance_id', 'instance', 'restaurant_instance', 'restaurantInstance']) {
    try {
      record = await queryByColumn(instance, column);
      if (record) break;
    } catch (error) {
      console.warn(`[NOCODB:CHAT] lookup failed column=${column} instance=${instance}:`, error?.message || error);
      const status = Number(error?.response?.status || 0);
      if (!status || status === 408 || status === 425 || status === 429 || status >= 500) {
        transportFailed = true;
        openCircuit(error);
        break;
      }
    }
  }

  const value = sanitizeTenantConfig(record, instance);
  if (!transportFailed) setCached(cacheKey, value, record ? CACHE_TTL_MS : NEGATIVE_CACHE_TTL_MS);
  return value;
}

async function getTenantChatConfig(instanceValue) {
  const instance = normalizeInstance(instanceValue);
  if (!instance) return sanitizeTenantConfig(null, '');

  const cacheKey = `chat:${instance}`;
  const currentTime = Date.now();
  const cached = getCached(cacheKey, currentTime);
  if (cached) return cached;
  if (inflight.has(cacheKey)) return inflight.get(cacheKey);
  if (currentTime < circuitOpenUntil) return sanitizeTenantConfig(null, instance);
  const lookup = (async () => {
    if (!await acquireLookupSlot()) return sanitizeTenantConfig(null, instance);
    try {
      return await loadTenantConfig(instance, cacheKey);
    } finally {
      activeLookups -= 1;
    }
  })().finally(() => inflight.delete(cacheKey));
  inflight.set(cacheKey, lookup);
  return lookup;
}

// Deliberately separate from getTenantChatConfig: that object is rendered into
// the operator page, so a secret must never travel with it. This returns the
// token alone, cached under its own key, and nothing else about the tenant.
async function getTenantApiToken(instanceValue) {
  const instance = normalizeInstance(instanceValue);
  if (!instance) return '';

  const cacheKey = `token:${instance}`;
  const currentTime = Date.now();
  const cached = getCached(cacheKey, currentTime);
  if (cached !== null && cached !== undefined) return cached;
  if (inflight.has(cacheKey)) return inflight.get(cacheKey);
  if (currentTime < circuitOpenUntil) return '';

  const lookup = (async () => {
    if (!await acquireLookupSlot()) return '';
    try {
      let record = null;
      let transportFailed = false;
      for (const column of ['instance_id', 'instance', 'restaurant_instance', 'restaurantInstance']) {
        try {
          record = await queryByColumn(instance, column);
          if (record) break;
        } catch (error) {
          const status = Number(error?.response?.status || 0);
          if (!status || status === 408 || status === 425 || status === 429 || status >= 500) {
            transportFailed = true;
            openCircuit(error);
            break;
          }
        }
      }
      const token = String(pickFirst(record, ['whatspro_api_token', 'whatsproApiToken', 'api_token', 'apiToken'], '') || '').trim();
      // A tenant whose row exists but carries no token is cached as "no token"
      // so a missing field cannot hammer NocoDB on every request.
      if (!transportFailed) setCached(cacheKey, token, record ? CACHE_TTL_MS : NEGATIVE_CACHE_TTL_MS);
      return token;
    } finally {
      activeLookups -= 1;
    }
  })().finally(() => inflight.delete(cacheKey));
  inflight.set(cacheKey, lookup);
  return lookup;
}

// The readiness check needs whole rows, not one sanitized tenant. It is an owner
// action, it runs when somebody is adding a restaurant rather than on every
// request, and the rows carry tokens — so it takes its own short cache and its
// result must never leave the process except as pass/fail.
const TENANT_LIST_CACHE_MS = Math.min(CACHE_TTL_MS, 60000);

async function listTenantRecords() {
  const url = tableUrl();
  if (!url || !process.env.NOCODB_TOKEN) return [];
  const cacheKey = 'rows:all';
  const cached = getCached(cacheKey, Date.now());
  if (cached) return cached;
  if (inflight.has(cacheKey)) return inflight.get(cacheKey);

  const lookup = (async () => {
    const response = await axios.get(url, {
      headers: nocodbHeaders(),
      params: { limit: 1000 },
      timeout: Number(process.env.NOCODB_TIMEOUT_MS || 8000)
    });
    const rows = Array.isArray(response.data?.list) ? response.data.list : [];
    setCached(cacheKey, rows, TENANT_LIST_CACHE_MS);
    return rows;
  })().finally(() => inflight.delete(cacheKey));
  inflight.set(cacheKey, lookup);
  return lookup;
}

function resetForTests() {
  cache.clear();
  inflight.clear();
  activeLookups = 0;
  pendingLookups = 0;
  circuitOpenUntil = 0;
}

module.exports = {
  getTenantApiToken,
  getTenantChatConfig,
  listTenantRecords,
  sanitizeTenantConfig,
  __test: {
    reset: resetForTests,
    stats: () => ({ cacheSize: cache.size, inflightSize: inflight.size, activeLookups, pendingLookups, circuitOpenUntil })
  }
};
