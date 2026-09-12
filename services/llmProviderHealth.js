'use strict';

const HEALTH_KEY = 'whatspro:llm-health:v1';
const POOLS = new Set(['text', 'media']);
const STATUS_RANK = { healthy: 0, unknown: 1, suspect: 2, unavailable: 3 };
const RUNTIME_OBSERVATION_HOLD_MS = 60_000;
const CANONICAL_ERROR_CODES = new Set([
  'DAILY_CHECKIN_REQUIRED', 'UNSUPPORTED_MEDIA', 'QUOTA_EXHAUSTED', 'RATE_LIMITED',
  'PAYMENT_REQUIRED', 'AUTHENTICATION_FAILED', 'FORBIDDEN', 'MODEL_NOT_FOUND',
  'TIMEOUT', 'NETWORK_ERROR', 'EMPTY_RESPONSE', 'UPSTREAM_5XX', 'BAD_REQUEST',
  'PROVIDER_ERROR'
]);

function createSilentWavBase64() {
  const sampleRate = 8000;
  const sampleCount = 80;
  const dataBytes = sampleCount * 2;
  const wav = Buffer.alloc(44 + dataBytes);
  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(36 + dataBytes, 4);
  wav.write('WAVE', 8, 'ascii');
  wav.write('fmt ', 12, 'ascii');
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36, 'ascii');
  wav.writeUInt32LE(dataBytes, 40);
  return wav.toString('base64');
}

const SILENT_WAV_BASE64 = createSilentWavBase64();

function boundedNumber(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, parsed));
}

function sanitizeErrorCode(value) {
  const raw = String(value || '').trim().toUpperCase();
  if (CANONICAL_ERROR_CODES.has(raw)) return raw;
  if (/DAILY[^A-Z0-9]*CHECK[ -]?IN/.test(raw)) return 'DAILY_CHECKIN_REQUIRED';
  if (/UNSUPPORTED.*(?:MEDIA|FILE|AUDIO|IMAGE)|MEDIA.*UNSUPPORTED/.test(raw)) return 'UNSUPPORTED_MEDIA';
  if (/QUOTA|LIMIT_EXHAUSTED|NO[_ ]?TOKENS?/.test(raw)) return 'QUOTA_EXHAUSTED';
  if (/RATE[_ ]?LIMIT|HTTP[_ :]*429|\b429\b/.test(raw)) return 'RATE_LIMITED';
  if (/PAYMENT|CREDIT|HTTP[_ :]*402|\b402\b/.test(raw)) return 'PAYMENT_REQUIRED';
  if (/AUTH|INVALID[_ ]?(?:API[_ ]?)?KEY|HTTP[_ :]*401|\b401\b/.test(raw)) return 'AUTHENTICATION_FAILED';
  if (/FORBIDDEN|HTTP[_ :]*403|\b403\b/.test(raw)) return 'FORBIDDEN';
  if (/MODEL[_ ]?NOT[_ ]?FOUND|HTTP[_ :]*404|\b404\b/.test(raw)) return 'MODEL_NOT_FOUND';
  if (/TIMEOUT|TIMED[_ ]?OUT|HTTP[_ :]*408|\b408\b/.test(raw)) return 'TIMEOUT';
  if (/NETWORK|ECONN|ENOTFOUND|EAI_AGAIN|SOCKET/.test(raw)) return 'NETWORK_ERROR';
  if (/EMPTY[_ ]?RESPONSE|NO[_ ]?CONTENT/.test(raw)) return 'EMPTY_RESPONSE';
  if (/HTTP[_ :]*5\d\d|\b5\d\d\b|SERVER[_ ]?ERROR/.test(raw)) return 'UPSTREAM_5XX';
  if (/BAD[_ ]?REQUEST|HTTP[_ :]*400|\b400\b/.test(raw)) return 'BAD_REQUEST';
  return 'PROVIDER_ERROR';
}

function invalidOutcome(code = 'INVALID_OUTCOME') {
  const error = new Error(code);
  error.statusCode = 400;
  return error;
}

function validateOutcomePayload(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalidOutcome();
  const allowed = new Set(['entryId', 'pool', 'ok', 'latencyMs', 'errorCode', 'observedAt']);
  if (Object.keys(body).some(field => !allowed.has(field))) throw invalidOutcome('INVALID_OUTCOME_FIELDS');
  if (typeof body.entryId !== 'string' || !POOLS.has(body.pool) || typeof body.ok !== 'boolean') throw invalidOutcome();
  if (body.latencyMs != null && (!Number.isFinite(Number(body.latencyMs)) || Number(body.latencyMs) < 0)) throw invalidOutcome();
  if (body.errorCode != null && typeof body.errorCode !== 'string') throw invalidOutcome();
  if (body.observedAt != null && (typeof body.observedAt !== 'string' || !Number.isFinite(Date.parse(body.observedAt)))) throw invalidOutcome();
  return {
    entryId: body.entryId,
    pool: body.pool,
    ok: body.ok,
    latencyMs: body.latencyMs == null ? null : finiteLatency(body.latencyMs),
    errorCode: body.ok ? null : sanitizeErrorCode(body.errorCode),
    observedAt: body.observedAt || new Date().toISOString()
  };
}

function finiteLatency(value) {
  const latency = Number(value);
  if (!Number.isFinite(latency) || latency < 0) return null;
  return Math.min(Math.round(latency), 300_000);
}

function validObservedAt(value, now = Date.now()) {
  const parsed = Date.parse(String(value || ''));
  if (!Number.isFinite(parsed) || parsed > now + 5 * 60_000 || parsed < now - 30 * 86400_000) {
    return new Date(now).toISOString();
  }
  return new Date(parsed).toISOString();
}

function isUnavailableCode(code) {
  return new Set([
    'AUTHENTICATION_FAILED', 'PAYMENT_REQUIRED', 'FORBIDDEN', 'MODEL_NOT_FOUND',
    'BAD_REQUEST', 'RATE_LIMITED', 'QUOTA_EXHAUSTED', 'DAILY_CHECKIN_REQUIRED',
    'UNSUPPORTED_MEDIA'
  ]).has(code);
}

function observationStatus(ok, errorCode) {
  if (ok) return 'healthy';
  return isUnavailableCode(errorCode) ? 'unavailable' : 'suspect';
}

function parseJsonObject(value) {
  if (value && typeof value === 'object') return value;
  const text = String(value || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

async function isSuccessfulProbePayload(response, type) {
  if (!response?.ok || typeof response.json !== 'function') return false;
  let payload;
  try { payload = await response.json(); } catch { return false; }
  const content = type === 'gemini'
    ? payload?.candidates?.[0]?.content?.parts?.map(part => part?.text || '').join('')
    : payload?.choices?.[0]?.message?.content;
  return parseJsonObject(content)?.ok === true;
}

function normalizeRecords(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const [id, item] of Object.entries(raw)) {
    if (!/^llm_[A-Za-z0-9_-]{20,80}$/.test(id) || !item || typeof item !== 'object') continue;
    const status = Object.hasOwn(STATUS_RANK, item.status) ? item.status : 'unknown';
    out[id] = {
      status,
      source: item.source === 'runtime' ? 'runtime' : item.source === 'probe' ? 'probe' : 'none',
      lastCheckedAt: validObservedAt(item.lastCheckedAt),
      latencyMs: finiteLatency(item.latencyMs),
      errorCode: item.errorCode ? sanitizeErrorCode(item.errorCode) : null,
      consecutiveFailures: Math.max(0, Math.min(1000, Number(item.consecutiveFailures) || 0))
    };
  }
  return out;
}

function sortWorkspaceByHealth(workspace, records = {}) {
  const sortPool = list => (Array.isArray(list) ? list : [])
    .map((entry, index) => ({ entry, index }))
    .sort((left, right) => {
      const leftRecord = records[left.entry.id];
      const rightRecord = records[right.entry.id];
      const leftRank = STATUS_RANK[leftRecord?.status] ?? STATUS_RANK.unknown;
      const rightRank = STATUS_RANK[rightRecord?.status] ?? STATUS_RANK.unknown;
      if (leftRank !== rightRank) return leftRank - rightRank;
      // Probe latency only breaks ties between providers proven healthy. This
      // keeps the operator's order for unknown/error states while placing the
      // fastest known-good lane on the customer hot path.
      if (leftRecord?.status === 'healthy' && rightRecord?.status === 'healthy') {
        const latencyDelta = (leftRecord.latencyMs ?? Number.MAX_SAFE_INTEGER) - (rightRecord.latencyMs ?? Number.MAX_SAFE_INTEGER);
        if (latencyDelta) return latencyDelta;
      }
      return left.index - right.index;
    })
    .map(item => item.entry);
  return { text: sortPool(workspace?.text), media: sortPool(workspace?.media) };
}

function findEntry(workspace, pool, entryId) {
  if (!POOLS.has(pool)) return null;
  return (workspace?.[pool] || []).find(entry => entry.id === entryId) || null;
}

function publicRecord(entry, pool, record) {
  return {
    entryId: entry.id,
    pool,
    status: record?.status || 'unknown',
    source: record?.source || 'none',
    lastCheckedAt: record?.lastCheckedAt || null,
    latencyMs: record?.latencyMs ?? null,
    errorCode: record?.errorCode || null,
    consecutiveFailures: record?.consecutiveFailures || 0
  };
}

function probeDue(record, now = Date.now(), baseIntervalMs = 60_000) {
  if (!record?.lastCheckedAt) return true;
  const age = now - Date.parse(record.lastCheckedAt);
  if (!Number.isFinite(age) || age < 0) return true;
  return age >= baseIntervalMs;
}

function createLlmProviderHealth(options = {}) {
  const redis = options.redis;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const timeoutMs = boundedNumber(options.timeoutMs ?? process.env.LLM_PROBE_TIMEOUT_MS, 8000, 100, 15_000);
  const concurrency = Math.round(boundedNumber(options.concurrency ?? process.env.LLM_PROBE_CONCURRENCY, 2, 1, 4));
  const intervalMs = boundedNumber(options.intervalMs ?? process.env.LLM_PROBE_INTERVAL_MS, 60_000, 30_000, 3_600_000);
  let mutationTail = Promise.resolve();
  let timer = null;
  let sweepInFlight = false;

  async function readRecords() {
    if (!redis?.isOpen) return {};
    try {
      return normalizeRecords(JSON.parse(await redis.get(HEALTH_KEY) || '{}'));
    } catch {
      return {};
    }
  }

  function mutateRecords(mutator) {
    const operation = mutationTail.then(async () => {
      const records = await readRecords();
      const result = await mutator(records);
      if (redis?.isOpen) await redis.set(HEALTH_KEY, JSON.stringify(records));
      return result;
    });
    mutationTail = operation.catch(() => {});
    return operation;
  }

  async function applyObservation(entry, pool, observation) {
    const checkedAt = validObservedAt(observation.observedAt);
    const checkedTime = Date.parse(checkedAt);
    return mutateRecords(records => {
      const previous = records[entry.id];
      const previousTime = Date.parse(previous?.lastCheckedAt || '') || 0;
      if (checkedTime < previousTime) return publicRecord(entry, pool, previous);
      if (observation.source === 'probe' && previous?.source === 'runtime' && checkedTime - previousTime < RUNTIME_OBSERVATION_HOLD_MS) {
        return publicRecord(entry, pool, previous);
      }
      const errorCode = observation.ok ? null : sanitizeErrorCode(observation.errorCode);
      const status = observationStatus(Boolean(observation.ok), errorCode || '');
      const next = {
        status,
        source: observation.source,
        lastCheckedAt: checkedAt,
        latencyMs: finiteLatency(observation.latencyMs),
        errorCode,
        consecutiveFailures: observation.ok ? 0 : Math.min(1000, (previous?.consecutiveFailures || 0) + 1)
      };
      records[entry.id] = next;
      return publicRecord(entry, pool, next);
    });
  }

  async function probe(entry, pool) {
    const startedAt = Date.now();
    const controller = new AbortController();
    let timeout;
    const deadline = new Promise((_, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        const error = new Error('PROBE_TIMEOUT');
        error.name = 'AbortError';
        reject(error);
      }, timeoutMs);
      timeout.unref?.();
    });
    let response;
    try {
      const mediaProbe = pool === 'media';
      if (entry.type === 'gemini') {
        const base = String(entry.baseUrl || '').replace(/\/+$/, '');
        const model = String(entry.model || '').replace(/^models\//, '');
        response = await Promise.race([fetchImpl(`${base}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(entry.key)}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: mediaProbe
              ? [{ text: 'Return only {"ok":true} as JSON after reading this audio.' }, { inlineData: { mimeType: 'audio/wav', data: SILENT_WAV_BASE64 } }]
              : [{ text: 'Return only {"ok":true} as JSON.' }] }],
            generationConfig: { maxOutputTokens: 16, responseMimeType: 'application/json' }
          }),
          signal: controller.signal
        }), deadline]);
      } else {
        const base = String(entry.baseUrl || '').replace(/\/+$/, '');
        response = await Promise.race([fetchImpl(`${base}/chat/completions`, {
          method: 'POST',
          headers: { authorization: `Bearer ${entry.key}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            model: entry.model,
            messages: [{ role: 'user', content: mediaProbe
              ? [{ type: 'text', text: 'Return only {"ok":true} as JSON after reading this audio.' }, { type: 'input_audio', input_audio: { data: SILENT_WAV_BASE64, format: 'wav' } }]
              : 'Return only {"ok":true} as JSON.' }],
            response_format: { type: 'json_object' },
            max_tokens: 16,
            temperature: 0
          }),
          signal: controller.signal
        }), deadline]);
      }
      const validPayload = await isSuccessfulProbePayload(response, entry.type);
      return applyObservation(entry, pool, {
        source: 'probe', ok: validPayload,
        errorCode: validPayload ? null : response?.ok ? 'EMPTY_RESPONSE' : `HTTP_${Number(response?.status) || 0}`,
        latencyMs: Date.now() - startedAt,
        observedAt: new Date().toISOString()
      });
    } catch (error) {
      const code = error?.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK_ERROR';
      return applyObservation(entry, pool, {
        source: 'probe', ok: false, errorCode: code,
        latencyMs: Date.now() - startedAt,
        observedAt: new Date().toISOString()
      });
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  async function runJobs(jobs) {
    let cursor = 0;
    const worker = async () => {
      while (cursor < jobs.length) {
        const job = jobs[cursor++];
        await probe(job.entry, job.pool);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));
  }

  async function checkAll(workspace) {
    const jobs = [];
    for (const pool of ['text', 'media']) {
      for (const entry of workspace?.[pool] || []) jobs.push({ entry, pool });
    }
    await runJobs(jobs);
    return getHealth(workspace);
  }

  async function checkDue(workspace) {
    const records = await readRecords();
    const jobs = [];
    for (const pool of ['text', 'media']) {
      for (const entry of workspace?.[pool] || []) {
        if (probeDue(records[entry.id], Date.now(), intervalMs)) jobs.push({ entry, pool });
      }
    }
    await runJobs(jobs);
    return getHealth(workspace);
  }

  async function checkOne(workspace, pool, entryId) {
    const entry = findEntry(workspace, pool, entryId);
    if (!entry) {
      const error = new Error('UNKNOWN_LLM_ENTRY');
      error.statusCode = 404;
      throw error;
    }
    return probe(entry, pool);
  }

  async function recordOutcome(workspace, outcome) {
    const pool = String(outcome?.pool || '');
    const entryId = String(outcome?.entryId || '');
    const entry = findEntry(workspace, pool, entryId);
    if (!entry) {
      const error = new Error('UNKNOWN_LLM_ENTRY');
      error.statusCode = 404;
      throw error;
    }
    return applyObservation(entry, pool, {
      source: 'runtime',
      ok: outcome.ok === true,
      latencyMs: outcome.latencyMs,
      errorCode: outcome.ok === true ? null : sanitizeErrorCode(outcome.errorCode),
      observedAt: outcome.observedAt
    });
  }

  async function getHealth(workspace) {
    const records = await readRecords();
    return {
      text: (workspace?.text || []).map(entry => publicRecord(entry, 'text', records[entry.id])),
      media: (workspace?.media || []).map(entry => publicRecord(entry, 'media', records[entry.id]))
    };
  }

  async function getRuntimeWorkspace(workspace) {
    const records = await readRecords();
    const sorted = sortWorkspaceByHealth(workspace, records);
    const decorate = (entry, pool) => {
      const record = publicRecord(entry, pool, records[entry.id]);
      return {
        ...entry,
        health: {
          status: record.status,
          lastCheckedAt: record.lastCheckedAt,
          latencyMs: record.latencyMs,
          errorCode: record.errorCode
        }
      };
    };
    return {
      text: sorted.text.map(entry => decorate(entry, 'text')),
      media: sorted.media.map(entry => decorate(entry, 'media'))
    };
  }

  function start(getWorkspace) {
    if (timer) return;
    const sweep = async () => {
      if (sweepInFlight) return;
      sweepInFlight = true;
      try { await checkDue(await getWorkspace()); } catch { /* next periodic sweep retries */ }
      finally { sweepInFlight = false; }
    };
    void sweep();
    timer = setInterval(() => { void sweep(); }, intervalMs);
    timer.unref?.();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { getHealth, getRuntimeWorkspace, checkAll, checkDue, checkOne, recordOutcome, start, stop };
}

module.exports = {
  HEALTH_KEY,
  createLlmProviderHealth,
  sanitizeErrorCode,
  validateOutcomePayload,
  sortWorkspaceByHealth,
  __test: { observationStatus, normalizeRecords, validObservedAt, finiteLatency, boundedNumber, probeDue, createSilentWavBase64, isSuccessfulProbePayload }
};
