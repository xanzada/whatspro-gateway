const axios = require('axios');

const CACHE_TTL_MS = Number(process.env.NOCODB_CONFIG_CACHE_MS || 300000);
const cache = new Map();

function cleanString(value, fallback = '') {
  const text = String(value ?? fallback ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  return text || fallback;
}

function normalizeInstance(value) {
  return cleanString(value).slice(0, 80);
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
  return {
    instance: tenantInstance,
    found: true,
    branding: {
      name: pickFirst(record, ['chat_title', 'brand_name', 'restaurant_name', 'name', 'title'], tenantInstance || 'WhatsPro'),
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

async function getTenantChatConfig(instanceValue) {
  const instance = normalizeInstance(instanceValue);
  if (!instance) return sanitizeTenantConfig(null, '');

  const cacheKey = `chat:${instance}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  let record = null;
  for (const column of ['instance_id', 'instance', 'restaurant_instance', 'restaurantInstance']) {
    try {
      record = await queryByColumn(instance, column);
      if (record) break;
    } catch (error) {
      console.warn(`[NOCODB:CHAT] lookup failed column=${column} instance=${instance}:`, error?.message || error);
    }
  }

  const value = sanitizeTenantConfig(record, instance);
  cache.set(cacheKey, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value;
}

module.exports = {
  getTenantChatConfig
};
