'use strict';

const { redisClient } = require('../config/redis');

// The LLM key workspace: platform-wide pools the operator curates in the panel,
// OpenBot consumes for its text and media models. Two ordered lists — the first
// entry is the workhorse, every next one is a reserve the runtime hops to when
// the previous one fails. Stored whole in one Redis key: the pools are tiny,
// read on every generation through OpenBot's 60s cache, and written rarely.
const WORKSPACE_KEY = 'whatspro:llm-workspace:v1';
const PROVIDERS = new Set(['gemini', 'openrouter']);
const MAX_ENTRIES_PER_POOL = 12;

function clean(value, max = 200) {
  return String(value ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);
}

function normalizeEntry(raw) {
  const provider = PROVIDERS.has(String(raw?.provider || '').trim().toLowerCase())
    ? String(raw.provider).trim().toLowerCase()
    : 'openrouter';
  const name = clean(raw?.name, 80);
  const model = clean(raw?.model, 120);
  const key = String(raw?.key ?? '').replace(/\s+/g, '').slice(0, 400);
  if (!model || !key) return null;
  return { name: name || model, provider, model, key };
}

function normalizePool(list) {
  const raw = Array.isArray(list) ? list : [];
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    const entry = normalizeEntry(item);
    if (!entry) continue;
    const fingerprint = `${entry.provider}|${entry.model}|${entry.key}`;
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
