'use strict';

const { redisClient } = require('../config/redis');

// The LLM key workspace: platform-wide pools the operator curates in the panel,
// OpenBot consumes for its text and media models. Two ordered lists — the first
// entry is the workhorse, every next one is a reserve the runtime hops to when
// the previous one fails. Stored whole in one Redis key: the pools are tiny,
// read on every generation through OpenBot's 60s cache, and written rarely.
const WORKSPACE_KEY = 'whatspro:llm-workspace:v1';
const TYPES = new Set(['openai', 'gemini']);
const DEFAULT_BASE_URL = {
  openai: 'https://openrouter.ai/api/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta'
};
const MAX_ENTRIES_PER_POOL = 12;

function clean(value, max = 200) {
  return String(value ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);
}

function normalizeBaseUrl(value, type) {
  const raw = String(value ?? '').trim().replace(/\/+$/, '');
  if (!raw) return DEFAULT_BASE_URL[type] || DEFAULT_BASE_URL.openai;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:') return DEFAULT_BASE_URL[type] || DEFAULT_BASE_URL.openai;
    return url.toString().replace(/\/+$/, '');
  } catch {
    return DEFAULT_BASE_URL[type] || DEFAULT_BASE_URL.openai;
  }
}

function normalizeEntry(raw) {
  // Legacy rows carried a provider select (gemini | openrouter); map it onto
  // the type + baseUrl pair so old saves keep working after the panel switched
  // to a free-text Base URL for any provider.
  let type = TYPES.has(String(raw?.type || '').trim().toLowerCase())
    ? String(raw.type).trim().toLowerCase()
    : '';
  let baseUrl = String(raw?.baseUrl ?? '').trim().replace(/\/+$/, '');
  if (!type && raw?.provider) {
    const legacy = String(raw.provider).trim().toLowerCase();
    if (legacy === 'gemini') { type = 'gemini'; baseUrl = baseUrl || DEFAULT_BASE_URL.gemini; }
    else if (legacy === 'openrouter') { type = 'openai'; baseUrl = baseUrl || DEFAULT_BASE_URL.openai; }
  }
  if (!type) type = 'openai';
  const name = clean(raw?.name, 80);
  const model = clean(raw?.model, 120);
  const key = String(raw?.key ?? '').replace(/\s+/g, '').slice(0, 400);
  if (!model || !key) return null;
  return {
    name: name || model,
    type,
    baseUrl: normalizeBaseUrl(baseUrl, type),
    model,
    key
  };
}

function normalizePool(list) {
  const raw = Array.isArray(list) ? list : [];
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    const entry = normalizeEntry(item);
    if (!entry) continue;
    const fingerprint = `${entry.type}|${entry.baseUrl}|${entry.model}|${entry.key}`;
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    out.push(entry);
    if (out.length >= MAX_ENTRIES_PER_POOL) break;
  }
  return out;
}

function normalizeWorkspace(body = {}) {
  return {
    text: normalizePool(body?.text),
    media: normalizePool(body?.media)
  };
}

async function getWorkspace() {
  try {
    if (!redisClient.isOpen) return { text: [], media: [] };
    const raw = await redisClient.get(WORKSPACE_KEY);
    if (!raw) return { text: [], media: [] };
    return normalizeWorkspace(JSON.parse(raw));
  } catch {
    // A broken stored payload must look like "no workspace", never like a
    // half-read pool that would put a truncated key on the wire.
    return { text: [], media: [] };
  }
}

async function saveWorkspace(body = {}) {
  if (!redisClient.isOpen) {
    const error = new Error('PLATFORM_STORE_UNAVAILABLE');
    error.statusCode = 503;
    throw error;
  }
  const workspace = normalizeWorkspace(body);
  await redisClient.set(WORKSPACE_KEY, JSON.stringify(workspace));
  return workspace;
}

module.exports = {
  getWorkspace,
  saveWorkspace,
  normalizeWorkspace,
  __test: { normalizeEntry, normalizePool }
};
