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

test('provider probes are bounded, concurrency-limited, and never persist secrets or raw bodies', async () => {
  const redis = new MemoryRedis();
  let active = 0;
  let peak = 0;
  const fetchImpl = async (_url, options) => {
    active += 1;
    peak = Math.max(peak, active);
    assert.equal(JSON.stringify(options).includes('secret-'), true, 'credential is used only on the outbound request');
    await new Promise(resolve => setTimeout(resolve, 10));
    active -= 1;
    return { ok: false, status: 402, text: async () => 'RAW BODY WITH secret-leak' };
  };
  const health = createLlmProviderHealth({ redis, fetchImpl, concurrency: 2, timeoutMs: 100 });
  const workspace = { text: [entry('llm_a_12345678901234567890', 'a'), entry('llm_b_12345678901234567890', 'b'), entry('llm_c_12345678901234567890', 'c')], media: [] };
  await health.checkAll(workspace);
  assert.equal(peak, 2);
  const stored = redis.data.get('whatspro:llm-health:v1');
  assert.equal(stored.includes('secret-'), false);
  assert.equal(stored.includes('RAW BODY'), false);
  const report = await health.getHealth(workspace);
  assert.equal(report.text[0].status, 'unavailable');
  assert.equal(report.text[0].errorCode, 'PAYMENT_REQUIRED');
});

test('HTTP 200 without a valid probe result is not marked healthy', async () => {
  const redis = new MemoryRedis();
  const health = createLlmProviderHealth({
    redis,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ choices: [] }) }),
    timeoutMs: 100
  });
  const workspace = { text: [entry('llm_empty_123456789012345', 'empty')], media: [] };
  await health.checkAll(workspace);
  const report = await health.getHealth(workspace);
  assert.equal(report.text[0].status, 'suspect');
  assert.equal(report.text[0].errorCode, 'EMPTY_RESPONSE');
});

test('runtime outcomes immediately override a recent probe and reject unknown ids', async () => {
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
  await health.checkAll(workspace);
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

test('a provider that ignores AbortSignal is still bounded by the probe deadline', async () => {
  const redis = new MemoryRedis();
  const health = createLlmProviderHealth({ redis, fetchImpl: async () => new Promise(() => {}), timeoutMs: 100 });
  const workspace = { text: [entry('llm_hang_1234567890123456', 'hang')], media: [] };
  const started = Date.now();
  await health.checkAll(workspace);
  assert.equal(Date.now() - started < 500, true);
  const report = await health.getHealth(workspace);
  assert.equal(report.text[0].status, 'suspect');
  assert.equal(report.text[0].errorCode, 'TIMEOUT');
});

test('automatic probes recheck every provider once every 15 minutes (900_000 ms)', () => {
  const now = Date.now();
  assert.equal(probeDue({ status: 'healthy', lastCheckedAt: new Date(now - 899_000).toISOString() }, now), false);
  assert.equal(probeDue({ status: 'healthy', lastCheckedAt: new Date(now - 901_000).toISOString() }, now), true);
  assert.equal(probeDue({ status: 'unavailable', consecutiveFailures: 9, lastCheckedAt: new Date(now - 899_000).toISOString() }, now), false);
  assert.equal(probeDue({ status: 'unavailable', consecutiveFailures: 9, lastCheckedAt: new Date(now - 901_000).toISOString() }, now), true);
});

test('media probes check openai models with zero tokens and gemini audio with silent WAV', async () => {
  const redis = new MemoryRedis();
  const requests = [];
  const health = createLlmProviderHealth({
    redis,
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      if (options.method === 'GET') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ object: 'list', data: [{ id: 'model-1' }] })
        };
      }
      const body = JSON.parse(options.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({ candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }] })
      };
    },
    timeoutMs: 100
  });
  const workspace = {
    text: [],
    media: [entry('llm_audio_openai_1234567890', 'audio-openai'), entry('llm_audio_gemini_1234567890', 'audio-gemini', 'gemini')]
  };
  await health.checkAll(workspace);
  // OpenAI media probe uses GET /models (0 tokens)
  assert.equal(requests[0].options.method, 'GET');
  assert.equal(requests[0].url, 'https://provider.example/v1/models');
  assert.equal(requests[0].options.body, undefined);

  // Gemini media probe exercises inline audio
  assert.equal(requests[1].options.method, 'POST');
  const geminiBody = JSON.parse(requests[1].options.body);
  const geminiAudio = geminiBody.contents[0].parts.find(item => item.inlineData).inlineData;
  assert.equal(geminiAudio.mimeType, 'audio/wav');
  assert.match(geminiAudio.data, /^UklGR/);
});

test('openai-compatible providers in text and media pools probe GET /models with 0 tokens', async () => {
  const redis = new MemoryRedis();
  const calls = [];
  const health = createLlmProviderHealth({
    redis,
    fetchImpl: async (url, options) => {
      calls.push({ url, method: options.method });
      return {
        ok: true,
        status: 200,
        json: async () => ({ object: 'list', data: [{ id: 'gemini-3.8-flash' }] })
      };
    },
    timeoutMs: 100
  });
  const workspace = {
    text: [entry('llm_a6api_text_1234567890', 'a6api-text')],
    media: [entry('llm_a6api_media_123456789', 'a6api-media')]
  };
  const report = await health.checkAll(workspace);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].url, 'https://provider.example/v1/models');
  assert.equal(calls[1].method, 'GET');
  assert.equal(calls[1].url, 'https://provider.example/v1/models');
  assert.equal(report.text[0].status, 'healthy');
  assert.equal(report.text[0].totalTokens, 0);
  assert.equal(report.media[0].status, 'healthy');
  assert.equal(report.media[0].totalTokens, 0);
});
