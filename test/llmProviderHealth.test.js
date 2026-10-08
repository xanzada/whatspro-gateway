'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createLlmProviderHealth,
  sanitizeErrorCode,
  sortWorkspaceByHealth,
  validateOutcomePayload
} = require('../services/llmProviderHealth');
const { normalizeWorkspace } = require('../services/llmWorkspace');
const { probeDue } = require('../services/llmProviderHealth').__test;

class MemoryRedis {
  constructor() { this.data = new Map(); this.isOpen = true; }
  async get(key) { return this.data.get(key) || null; }
  async set(key, value) { this.data.set(key, value); return 'OK'; }
}

function entry(id, name, type = 'openai') {
  return {
    id, name, type,
    baseUrl: type === 'gemini' ? 'https://generativelanguage.googleapis.com/v1beta' : 'https://provider.example/v1',
    model: type === 'gemini' ? 'gemini-2.5-flash' : 'free-chat',
    key: `secret-${name}`
  };
}

test('workspace assigns opaque stable ids without deriving them from keys', () => {
  const first = normalizeWorkspace({ text: [{ name: 'One', model: 'm', key: 'top-secret' }] });
  assert.match(first.text[0].id, /^llm_[A-Za-z0-9_-]{20,}$/);
  assert.equal(first.text[0].id.includes('top-secret'), false);
  const second = normalizeWorkspace(first);
  assert.equal(second.text[0].id, first.text[0].id);
});

test('healthy-first sorting does not mutate configured operator order', () => {
  const workspace = { text: [entry('llm_unknown_123456789012', 'unknown'), entry('llm_good_123456789012345', 'good'), entry('llm_bad_1234567890123456', 'bad')], media: [] };
  const records = {
    llm_good_123456789012345: { status: 'healthy' },
    llm_bad_1234567890123456: { status: 'unavailable' }
  };
  const sorted = sortWorkspaceByHealth(workspace, records);
  assert.deepEqual(workspace.text.map(item => item.name), ['unknown', 'good', 'bad']);
  assert.deepEqual(sorted.text.map(item => item.name), ['good', 'unknown', 'bad']);
});

test('healthy providers use measured latency only as a runtime tie-breaker', () => {
  const workspace = { text: [entry('llm_slow_123456789012345', 'slow'), entry('llm_fast_123456789012345', 'fast')], media: [] };
  const records = {
    llm_slow_123456789012345: { status: 'healthy', latencyMs: 4800 },
    llm_fast_123456789012345: { status: 'healthy', latencyMs: 700 }
  };
  const sorted = sortWorkspaceByHealth(workspace, records);
  assert.deepEqual(workspace.text.map(item => item.name), ['slow', 'fast']);
  assert.deepEqual(sorted.text.map(item => item.name), ['fast', 'slow']);
});

test('active provider checks are refused without outbound requests or health writes', async () => {
  const redis = new MemoryRedis(); const calls = [];
  const health = createLlmProviderHealth({ redis, fetchImpl: async (...args) => { calls.push(args); throw new Error('FORBIDDEN_SYNTHETIC_FETCH'); } });
  const workspace = { text: [entry('llm_a_12345678901234567890', 'a')], media: [] };
  await assert.rejects(() => health.checkAll(workspace), /ACTIVE_LLM_KEY_CHECKS_DISABLED/);
  assert.deepEqual(calls, []); assert.equal(redis.data.size, 0);
  const report = await health.getHealth(workspace); assert.equal(report.text[0].status, 'unknown');
});

test('disabled checks never manufacture a healthy observation', async () => {
  const redis = new MemoryRedis(); let calls = 0;
  const health = createLlmProviderHealth({ redis, fetchImpl: async () => { calls += 1; return { ok: true, status: 200 }; } });
  const workspace = { text: [entry('llm_empty_123456789012345', 'empty')], media: [] };
  await assert.rejects(() => health.checkAll(workspace), /ACTIVE_LLM_KEY_CHECKS_DISABLED/);
  const report = await health.getHealth(workspace);
  assert.equal(calls, 0); assert.equal(report.text[0].status, 'unknown'); assert.equal(report.text[0].lastCheckedAt, null);
});

test('runtime outcomes immediately rank providers and reject unknown ids', async () => {
  const redis = new MemoryRedis();
  const health = createLlmProviderHealth({
    redis,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: '{"ok":true}' } }] })
    }),
    timeoutMs: 100
  });
  const workspace = { text: [entry('llm_live_1234567890123456', 'live'), entry('llm_reserve_12345678901234', 'reserve')], media: [] };
  await health.recordOutcome(workspace, { entryId: workspace.text[1].id, pool: 'text', ok: true, latencyMs: 9, observedAt: new Date().toISOString() });
  await health.recordOutcome(workspace, {
    entryId: workspace.text[0].id, pool: 'text', ok: false, latencyMs: 18,
    errorCode: 'payment required: raw provider message', observedAt: new Date().toISOString()
  });
  const runtime = await health.getRuntimeWorkspace(workspace);
  assert.deepEqual(runtime.text.map(item => item.name), ['reserve', 'live']);
  assert.equal(runtime.text[0].health.status, 'healthy');
  assert.equal(runtime.text[1].health.status, 'unavailable');
  const report = await health.getHealth(workspace);
  assert.equal(report.text[0].source, 'runtime');
  assert.equal(report.text[0].status, 'unavailable');
  assert.equal(report.text[0].errorCode, 'PAYMENT_REQUIRED');
  await assert.rejects(() => health.recordOutcome(workspace, { entryId: 'llm_missing_1234567890123', pool: 'text', ok: true }), /UNKNOWN_LLM_ENTRY/);
});

test('error codes are bounded allowlisted metadata', () => {
  assert.equal(sanitizeErrorCode('openai 402: key=secret'), 'PAYMENT_REQUIRED');
  assert.equal(sanitizeErrorCode('provider said private-prompt-value'), 'PROVIDER_ERROR');
  assert.equal(sanitizeErrorCode('Daily check-in required to use free'), 'DAILY_CHECKIN_REQUIRED');
  assert.equal(sanitizeErrorCode('UPSTREAM_5XX'), 'UPSTREAM_5XX');
});

test('runtime outcome payload rejects every extra field and returns only allowlisted metadata', () => {
  assert.throws(() => validateOutcomePayload({
    entryId: 'llm_live_1234567890123456', pool: 'text', ok: false,
    errorCode: 'HTTP 500', prompt: 'must never be accepted'
  }), /INVALID_OUTCOME_FIELDS/);
  assert.deepEqual(Object.keys(validateOutcomePayload({
    entryId: 'llm_live_1234567890123456', pool: 'text', ok: true, latencyMs: 9
  })).sort(), [
    'completionTokens', 'cost', 'entryId', 'errorCode', 'isPaid', 'latencyMs',
    'observedAt', 'ok', 'pool', 'promptTokens', 'totalTokens'
  ]);
});

test('disabled checks do not invoke a provider that would never settle', async () => {
  const redis = new MemoryRedis(); let calls = 0;
  const health = createLlmProviderHealth({ redis, fetchImpl: async () => { calls += 1; return new Promise(() => {}); } });
  const workspace = { text: [entry('llm_hang_1234567890123456', 'hang')], media: [] };
  await assert.rejects(() => health.checkAll(workspace), /ACTIVE_LLM_KEY_CHECKS_DISABLED/);
  assert.equal(calls, 0); assert.equal(redis.data.size, 0);
  const report = await health.getHealth(workspace); assert.equal(report.text[0].status, 'unknown');
});

test('historical probeDue metadata predicate remains pure; automatic scheduling is disabled', () => {
  const now = Date.now();
  assert.equal(probeDue({ status: 'healthy', lastCheckedAt: new Date(now - 899_000).toISOString() }, now), false);
  assert.equal(probeDue({ status: 'healthy', lastCheckedAt: new Date(now - 901_000).toISOString() }, now), true);
  assert.equal(probeDue({ status: 'unavailable', consecutiveFailures: 9, lastCheckedAt: new Date(now - 899_000).toISOString() }, now), false);
  assert.equal(probeDue({ status: 'unavailable', consecutiveFailures: 9, lastCheckedAt: new Date(now - 901_000).toISOString() }, now), true);
});

test('media key checks perform neither models GET nor Gemini generation', async () => {
  const redis = new MemoryRedis(); const requests = [];
  const health = createLlmProviderHealth({ redis, fetchImpl: async (...args) => { requests.push(args); throw new Error('FORBIDDEN_SYNTHETIC_FETCH'); } });
  const workspace = { text: [], media: [entry('llm_audio_openai_1234567890', 'audio-openai'), entry('llm_audio_gemini_1234567890', 'audio-gemini', 'gemini')] };
  await assert.rejects(() => health.checkAll(workspace), /ACTIVE_LLM_KEY_CHECKS_DISABLED/);
  assert.deepEqual(requests, []); assert.equal(redis.data.size, 0);
});

test('text and media keys retain passive unknown health without validating models', async () => {
  const redis = new MemoryRedis(); const calls = [];
  const health = createLlmProviderHealth({ redis, fetchImpl: async (...args) => { calls.push(args); throw new Error('FORBIDDEN_SYNTHETIC_FETCH'); } });
  const workspace = { text: [entry('llm_a6api_text_1234567890', 'a6api-text')], media: [entry('llm_a6api_media_123456789', 'a6api-media')] };
  await assert.rejects(() => health.checkAll(workspace), /ACTIVE_LLM_KEY_CHECKS_DISABLED/);
  const report = await health.getHealth(workspace);
  assert.deepEqual(calls, []); assert.equal(report.text[0].status, 'unknown'); assert.equal(report.text[0].totalTokens, 0); assert.equal(report.media[0].status, 'unknown'); assert.equal(report.media[0].totalTokens, 0);
});
