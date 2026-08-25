'use strict';

const { redisClient } = require('../config/redis');

// Platform runtime controls the operator edits from the panel's Настройки
// page: the developer phone, the test-mode switch with its allow-list, and the
// production receipt filter. One Redis key, whole-document writes - the same
// pattern as the LLM workspace next door.
const SETTINGS_KEY = 'whatspro:runtime-settings:v1';

function clean(value, max = 64) {
  return String(value ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);
}

function normalizePhoneEntry(value) {
  const digits = String(value ?? '').replace(/\D/g, '');
  return digits.length >= 10 && digits.length <= 15 ? digits : '';
}

function normalizeFlag(value, fallback) {
  if (value === true) return true;
  if (value === false) return false;
  const text = String(value ?? '').trim().toLowerCase();
  if (text === 'true') return true;
  if (text === 'false') return false;
  return fallback;
}

function normalizeSettings(body = {}) {
  const phonesRaw = Array.isArray(body.test_allowed_phones)
    ? body.test_allowed_phones
    : String(body.test_allowed_phones ?? '').split(/[\n,;]+/);
  const seen = new Set();
  const phones = [];
  for (const item of phonesRaw) {
    const phone = normalizePhoneEntry(item);
    if (!phone || seen.has(phone)) continue;
    seen.add(phone);
    phones.push(phone);
    if (phones.length >= 20) break;
  }
  return {
    // Flags are tri-state on the wire: absent stays absent so OpenBot keeps its
    // env default until the operator actually touches the switch.
    developer_phone: clean(body.developer_phone, 32).replace(/[^\d+]/g, ''),
    test_mode_enabled: normalizeFlag(body.test_mode_enabled, undefined),
    test_allowed_phones: phones,
    receipt_filter_enabled: normalizeFlag(body.receipt_filter_enabled, undefined)
  };
}

async function getSettings() {
  try {
    if (!redisClient.isOpen) return {};
    const raw = await redisClient.get(SETTINGS_KEY);
    if (!raw) return {};
    return normalizeSettings(JSON.parse(raw));
  } catch {
    return {};
  }
}

async function saveSettings(body = {}) {
  if (!redisClient.isOpen) {
    const error = new Error('PLATFORM_STORE_UNAVAILABLE');
    error.statusCode = 503;
    throw error;
  }
  const settings = normalizeSettings(body);
  await redisClient.set(SETTINGS_KEY, JSON.stringify(settings));
  return settings;
}

module.exports = {
  getSettings,
  saveSettings,
  normalizeSettings,
  __test: { normalizePhoneEntry, normalizeFlag }
};
