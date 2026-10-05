'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const Module = require('node:module');
const walDir = path.join(os.tmpdir(), 'operator-wal-boundary-' + process.pid);
process.env.WHATSPRO_SEND_WAL_DIR = walDir;
process.env.WHATSPRO_SEND_INTENT_STALE_MS = '1000';
process.env.WHATSPRO_TEST_MODE_ENABLED = 'false';
const manager = require('../services/whatsappManager');
const { redisClient } = require('../config/redis');
const { chatStore } = require('../services/chatStore');
const instanceId = 'operator-wal-fixture';
const phone = '77000000005';
const privateMarker = 'SYNTHETIC_PRIVATE_TRANSPORT_PAYLOAD';
let sends = 0, appends = 0, clears = 0, mode;
const { sosStore } = require('../services/sosStore');
const sensitiveError = code => Object.assign(new Error(privateMarker + ' https://fixture.invalid/' + phone + ' Bearer SYNTHETIC_SECRET'), { code });
manager.sendWhatsAppText = async () => {
  sends++;
  if (mode === 'throw') throw sensitiveError('ECONNRESET');
  if (mode === 'unknown') return { success: false, attempted: true, outcomeUnknown: true };
  if (mode === 'success_unknown') return { success: true, outcomeUnknown: true, messageId: 'SYNTHETIC-OPERATOR-ACK', ack: 1 };
  if (mode === 'negative_ack') return { success: true, messageId: 'SYNTHETIC-OPERATOR-ACK', ack: -1 };
  if (mode === 'queued') return { success: true, queued: true, messageId: 'SYNTHETIC-OPERATOR-ACK' };
  return { success: true, messageId: 'SYNTHETIC-OPERATOR-ACK', ack: 1 };
};
// Compile the exact current server source, with test-only access to startup readiness
// and private schedulers. No production source/behavior is replaced. Readiness is set
// after actual recovery as boot does; transport and storage are the isolated seams.
const filename = require.resolve('../src/server');
const fixtureModule = new Module(filename, module);
fixtureModule.filename = filename;
fixtureModule.paths = Module._nodeModulePaths(path.dirname(filename));
fixtureModule._compile(fsSync.readFileSync(filename, 'utf8') + '\nObject.assign(module.exports.__test, {' +
  'readyForFixture:()=>{walRecoveryComplete=true;}, effectsForFixture:scheduleOperatorSendEffects,' +
  'completionForFixture:scheduleSendCompletion,jobsForFixture:()=>Promise.all([...operatorEffectJobs.values(),...sendCompletionJobs.values()])});', filename);
const { app, __test: server } = fixtureModule.exports;
const values = new Map();
let logs = [], getError = false, getCalls = 0, sequence = 0, requestId;
function key(id = requestId) { return 'chatwoot:send-idempotency:' + instanceId + ':' + phone + ':' + id; }
function lease(id = requestId) {
  const payloadHash = crypto.createHash('sha256').update('synthetic operator reply').digest('hex');
  return { acquired: true, backend: 'redis', key: key(id), token: 'fixture-token', pendingValue: 'pending:fixture-token:' + payloadHash, payloadHash };
}
async function seed(phase = 'ambiguous', id = requestId) {
  return server.writeSendWal({ phase, lease: lease(id), instanceId, phone,
    reason: privateMarker + ' ' + phone, ambiguousAt: Date.now(), operationStartedAt: Date.now() - 600000 });
}
async function current(id = requestId) { return JSON.parse(await fs.readFile(server.sendWalPath(key(id)), 'utf8')); }
async function invoke(id = requestId) {
  const stack = app.router.stack.find(layer => layer.route?.path === '/api/chat/send/:instanceId/:phone').route.stack;
  assert.equal(stack[1].handle.name, 'requireChatUiOrApi');
  let status = 200, response;
  await stack.at(-1).handle({ params: { instanceId, phone }, body: { requestId: id, text: 'synthetic operator reply' } },
    { status(code) { status = code; return this; }, json(payload) { response = payload; return this; } });
  return { status, response };
}
async function recover() { await server.recoverSendWal(redisClient); server.readyForFixture(); }
function assertPrivateLogs() {
  const joined = logs.join('\n');
  assert.ok(!joined.includes(phone), 'no raw phone in operator log paths');
  assert.ok(!joined.includes(privateMarker), 'no error payload in logs');
  assert.ok(!joined.includes('SYNTHETIC_SECRET'), 'no token body in logs');
  assert.ok(!joined.includes(key()), 'no full lease key in logs');
  assert.ok(!joined.includes('https://fixture.invalid'), 'no raw transport URL/body in logs');
}
function effectData(id = requestId) {
  return { effectKey: 'chatwoot:operator-effect:' + instanceId + ':' + phone + ':' + id,
    payload: { instanceId, phone, expiresAt: Date.now() + 3600000,
      entry: { id: 'accepted-' + id, createdAt: Date.now(), text: 'synthetic operator reply', role: 'operator',
        source: 'operator_panel', direction: 'outgoing', fromMe: true } } };
}
test.beforeEach(async t => {
  requestId = 'operator-fixture-request-' + (++sequence);
  await fs.rm(walDir, { recursive: true, force: true }); await fs.mkdir(walDir, { recursive: true });
  sends = 0; appends = 0; clears = 0; mode = 'accepted'; getError = false; getCalls = 0; values.clear(); logs = [];
  for (const name of ['error', 'warn', 'log']) t.mock.method(console, name, (...args) => logs.push(args.map(String).join(' ')));
  Object.defineProperty(redisClient, 'isOpen', { configurable: true, value: true });
  t.mock.method(chatStore, 'appendMessageOnce', async (_instance, _phone, entry) => { appends++; return { ...entry, inserted: true, state: 'operator' }; });
  t.mock.method(sosStore, 'clear', async () => { clears++; return true; });
  t.mock.method(redisClient, 'publish', async () => 0);
  t.mock.method(redisClient, 'sendCommand', async args => {
    const [command, itemKey, value] = args;
    if (command === 'GET') {
      getCalls++; if (getError) throw sensitiveError('ECONNRESET');
      return values.get(itemKey) || null;
    }
    if (command === 'SET') { if (args.includes('NX') && values.has(itemKey)) return null; values.set(itemKey, value); return 'OK'; }
    if (command === 'DEL') { values.delete(itemKey); return 1; }
    if (command === 'EVAL') {
      const script = String(args[1]), count = Number(args[2]);
      const keys = args.slice(3, 3 + count), argv = args.slice(3 + count);
      if (script.startsWith("if redis.call('EXISTS', KEYS[1]) == 0")) {
        if (values.has(keys[0])) return 0;
        values.set(keys[0], argv[0]); values.set(keys[1], argv[2]); return 1;
      }
      if (script.startsWith("if redis.call('GET', KEYS[1]) == ARGV[1]")) {
        if (values.get(keys[0]) !== argv[0]) return 0;
        if (script.includes("redis.call('SET'")) {
          values.set(keys[0], argv[1]); if (count > 1) values.set(keys[1], argv[3]);
        } else if (script.includes("redis.call('DEL'")) values.delete(keys[0]);
        return 1;
      }
      if (script.includes('-- operator_case')) return 0;
      return 1;
    }
    if (['ZRANGE', 'LRANGE', 'SMEMBERS'].includes(command)) return [];
    return 0;
  });
  server.readyForFixture();
});
test.afterEach(async () => { await server.jobsForFixture(); });
test.after(async () => { delete redisClient.isOpen; await fs.rm(walDir, { recursive: true, force: true }); });

test('expired operator lease retains unknown WAL and actual retry makes zero transport attempts', async () => {
  await seed(); await recover();
  assert.equal((await current()).phase, 'ambiguous');
  const retry = await invoke();
  assert.equal(retry.status, 409); assert.equal(retry.response.error, 'SEND_OUTCOME_UNKNOWN'); assert.equal(sends, 0);
  // Recovery completes and a different request still makes progress.
  assert.equal((await invoke(requestId + '-other')).status, 200); assert.equal(sends, 1);
  assert.equal((await current()).phase, 'ambiguous'); assertPrivateLogs();
});
test('Redis GET outage is never absence; operator unknown remains durable and blocked', async () => {
  await seed(); getError = true; await recover();
  assert.equal((await current()).phase, 'ambiguous');
  assert.equal(getCalls, 0, 'unknown retention must not depend on a Redis lookup');
  assert.equal((await invoke()).status, 409); assert.equal(sends, 0); assertPrivateLogs();
});
test('offline recovery promotes stale operator intent and keeps per-request guard', async () => {
  await seed('intent'); Object.defineProperty(redisClient, 'isOpen', { configurable: true, value: false });
  await recover();
  const saved = await current();
  assert.equal(saved.phase, 'ambiguous'); assert.equal(saved.reason, 'RECOVERED_ORPHAN_INTENT');
  Object.defineProperty(redisClient, 'isOpen', { configurable: true, value: true });
  assert.equal((await invoke()).status, 409); assert.equal(sends, 0); assertPrivateLogs();
});
test('actual uncertain send remains blocked after lease loss and only stores a reason code', async () => {
  mode = 'unknown'; assert.equal((await invoke()).status, 409);
  const saved = await current();
  assert.equal(saved.phase, 'ambiguous'); assert.equal(saved.reason, 'TRANSPORT_OUTCOME_UNKNOWN');
  values.clear(); await recover(); assert.equal((await invoke()).status, 409); assert.equal(sends, 1); assertPrivateLogs();
});
test('actual thrown transport error stores code-only uncertainty and never logs private body', async () => {
  mode = 'throw'; assert.equal((await invoke()).status, 409);
  const saved = await current();
  assert.equal(saved.reason, 'TRANSPORT_ERROR'); assert.ok(!saved.reason.includes(privateMarker));
  values.clear(); await recover(); assert.equal((await invoke()).status, 409); assert.equal(sends, 1); assertPrivateLogs();
});
test('pre-send WAL write failure is not an attempt and logs only safe metadata', async t => {
  t.mock.method(fs, 'open', async () => { throw sensitiveError('ENOSPC'); });
  assert.equal((await invoke()).status, 507); assert.equal(sends, 0); assertPrivateLogs();
});
test('accepted-state journal write error preserves known acceptance without leaking error body', async t => {
  const originalOpen = fs.open; let writes = 0;
  t.mock.method(fs, 'open', async (target, ...args) => {
    if (String(target).endsWith('.tmp') && ++writes === 2) throw sensitiveError('ENOSPC');
    return originalOpen(target, ...args);
  });
  assert.equal((await invoke()).status, 200); assert.equal(sends, 1); assertPrivateLogs();
});
test('accepted operator record with missing Redis lease restores completion and effects without resend', async () => {
  const owned = lease(), effects = effectData();
  const wal = await server.writeSendWal({ phase: 'accepted', lease: owned,
    response: { success: true, messageId: 'SYNTHETIC-OPERATOR-ACK', ttl: 3600, expiresAt: Date.now() + 3600000 }, effectData: effects });
  await recover();
  await assert.rejects(() => fs.readFile(wal), error => error.code === 'ENOENT');
  for (let i = 0; i < 20 && appends === 0; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(appends, 1); assert.equal((await invoke()).response.replayed, true); assert.equal(sends, 0);
});
test('accepted record with owned pending lease completes and preserves its side effects', async () => {
  const owned = lease(), effects = effectData(); values.set(owned.key, owned.pendingValue);
  const wal = await server.writeSendWal({ phase: 'accepted', lease: owned,
    response: { success: true, messageId: 'SYNTHETIC-OPERATOR-ACK' }, effectData: effects });
  await recover();
  for (let i = 0; i < 30 && !String(values.get(owned.key)).startsWith('done:'); i++) await new Promise(resolve => setImmediate(resolve));
  assert.ok(String(values.get(owned.key)).startsWith('done:'));
  for (let i = 0; i < 30; i++) { try { await fs.access(wal); } catch { break; } await new Promise(resolve => setImmediate(resolve)); }
  await assert.rejects(() => fs.readFile(wal), error => error.code === 'ENOENT');
  assert.equal((await invoke()).response.replayed, true); assert.equal(sends, 0);
});
test('side-effect retry exhaustion logs hashed identity and safe error code', async t => {
  t.mock.method(chatStore, 'appendMessageOnce', async () => { throw sensitiveError('ENOSPC'); });
  t.mock.method(global, 'setTimeout', callback => { queueMicrotask(callback); return { unref() {} }; });
  assert.equal(await server.effectsForFixture(effectData().payload), false);
  assertPrivateLogs();
});
test('durable completion deadline logs hashed identity without recipient data', async t => {
  let calls = 0; const base = Date.now(); const effects = effectData();
  t.mock.method(Date, 'now', () => calls++ ? base + 2 * 86400000 : base);
  assert.equal(await server.completionForFixture(lease(), { success: true }, effects), false);
  assertPrivateLogs();
});

test('accepted operator GET failure retains confirmed WAL without interpreting failure as absence', async () => {
  const owned = lease(), effects = effectData();
  const wal = await server.writeSendWal({ phase: 'accepted', lease: owned,
    response: { success: true, messageId: 'SYNTHETIC-OPERATOR-ACK' }, effectData: effects });
  getError = true; await recover();
  assert.equal(JSON.parse(await fs.readFile(wal, 'utf8')).phase, 'accepted');
  assert.equal(appends, 0); assert.equal(sends, 0); assertPrivateLogs();
});

for (const uncertainMode of ['success_unknown', 'negative_ack', 'queued']) {
  test('actual route treats ' + uncertainMode + ' as unknown before acceptance or SOS effects', async () => {
    mode = uncertainMode;
    const result = await invoke();
    assert.equal(result.status, 409); assert.equal(result.response.error, 'SEND_OUTCOME_UNKNOWN');
    assert.equal((await current()).phase, 'ambiguous');
    assert.ok(String(values.get(key())).startsWith('pending:'));
    assert.equal(appends, 0); assert.equal(clears, 0);
    values.clear();
    assert.equal((await invoke()).status, 409); assert.equal(sends, 1);
    assert.equal(appends, 0); assert.equal(clears, 0); assertPrivateLogs();
  });
}
async function acceptedRecord() {
  return { phase: 'accepted', lease: lease(),
    response: { success: true, messageId: 'SYNTHETIC-STORED-ACK', ttl: 3600, expiresAt: Date.now() + 3600000 },
    effectData: effectData() };
}
test('accepted disk WAL is replayed before periodic recovery with zero wire attempts', async () => {
  const record = await acceptedRecord(), wal = await server.writeSendWal(record);
  const result = await invoke();
  assert.equal(result.status, 200); assert.equal(result.response.replayed, true);
  assert.equal(result.response.messageId, record.response.messageId); assert.equal(sends, 0);
  await server.jobsForFixture();
  assert.equal(appends, 1); assert.equal(clears, 1);
  assert.ok(String(values.get(key())).startsWith('done:'));
  await assert.rejects(() => fs.readFile(wal), error => error.code === 'ENOENT');
  assert.equal((await invoke()).response.messageId, record.response.messageId); assert.equal(sends, 0);
});
test('accepted disk WAL remains unchanged on Redis read failure and returns persistence pending', async () => {
  const record = await acceptedRecord(), wal = await server.writeSendWal(record);
  const before = await fs.readFile(wal, 'utf8'); getError = true;
  const result = await invoke();
  assert.equal(result.status, 202); assert.equal(result.response.replayed, true);
  assert.equal(result.response.persistencePending, true); assert.equal(sends, 0);
  assert.equal(await fs.readFile(wal, 'utf8'), before);
  assert.equal(appends, 0); assert.equal(clears, 0); assertPrivateLogs();
});
test('accepted WAL payload conflict fails closed before lease acquisition or send', async () => {
  const record = await acceptedRecord(); record.lease.payloadHash = 'different-payload-hash';
  const wal = await server.writeSendWal(record), before = await fs.readFile(wal, 'utf8');
  const result = await invoke();
  assert.equal(result.status, 409); assert.equal(result.response.error, 'IDEMPOTENCY_PAYLOAD_MISMATCH');
  assert.equal(sends, 0); assert.equal(values.size, 0); assert.equal(appends, 0);
  assert.equal(await fs.readFile(wal, 'utf8'), before);
});
for (const corruptPart of ['effectIdentity', 'effectPayload', 'acceptedResponse', 'phase', 'sosSnapshot']) {
  test('accepted WAL corruption ' + corruptPart + ' fails closed with no effects or overwrite', async () => {
    const record = await acceptedRecord();
    if (corruptPart === 'effectIdentity') record.effectData.payload.phone = '77000000099';
    if (corruptPart === 'effectPayload') record.effectData.payload.entry.text = 'another payload';
    if (corruptPart === 'acceptedResponse') record.response.outcomeUnknown = true;
    if (corruptPart === 'phase') record.phase = 'unrecognized';
    if (corruptPart === 'sosSnapshot') record.effectData.payload.sosSnapshot = { marker: '' };
    const wal = await server.writeSendWal(record), before = await fs.readFile(wal, 'utf8');
    const result = await invoke();
    assert.equal(result.status, 503); assert.equal(result.response.error, 'SEND_RECOVERY_CORRUPT');
    assert.equal(sends, 0); assert.equal(appends, 0); assert.equal(clears, 0);
    assert.equal(await fs.readFile(wal, 'utf8'), before);
  });
}

test('accepted disk WAL with pending ownership schedules completion before any wire attempt', async () => {
  const record = await acceptedRecord(); values.set(record.lease.key, record.lease.pendingValue);
  const wal = await server.writeSendWal(record);
  const result = await invoke();
  assert.equal(result.status, 202); assert.equal(result.response.replayed, true); assert.equal(sends, 0);
  await server.jobsForFixture();
  assert.ok(String(values.get(key())).startsWith('done:')); assert.equal(appends, 1); assert.equal(clears, 1);
  await assert.rejects(() => fs.readFile(wal), error => error.code === 'ENOENT');
});
test('accepted retry does not repeat finished effects or clear a newer SOS', async () => {
  const record = await acceptedRecord(); await server.writeSendWal(record);
  values.set(key(), 'done:' + JSON.stringify({ payloadHash: record.lease.payloadHash, response: record.response, effectKey: record.effectData.effectKey }));
  const result = await invoke();
  assert.equal(result.status, 200); assert.equal(result.response.replayed, true);
  await server.jobsForFixture();
  assert.equal(sends, 0); assert.equal(appends, 0); assert.equal(clears, 0);
});
test('corrupt accepted record survives periodic recovery and the actual retry remains blocked', async () => {
  const record = await acceptedRecord(); record.effectData.payload.entry.text = 'corrupt stored text';
  const wal = await server.writeSendWal(record), before = await fs.readFile(wal, 'utf8');
  await recover();
  assert.equal(await fs.readFile(wal, 'utf8'), before); assert.equal(getCalls, 0);
  const result = await invoke();
  assert.equal(result.status, 503); assert.equal(sends, 0); assert.equal(appends, 0); assert.equal(clears, 0);
});
test('conflicting Redis completion never deletes or overwrites known accepted disk WAL', async () => {
  const record = await acceptedRecord(), wal = await server.writeSendWal(record), before = await fs.readFile(wal, 'utf8');
  values.set(key(), 'done:' + JSON.stringify({ payloadHash: 'different-hash', response: record.response }));
  const result = await invoke();
  assert.equal(result.status, 202); assert.equal(result.response.messageId, record.response.messageId);
  assert.equal(result.response.persistencePending, true); assert.equal(sends, 0);
  assert.equal(await fs.readFile(wal, 'utf8'), before); assert.equal(appends, 0); assert.equal(clears, 0);
});

test('original SOS snapshot read failure is a proven pre-wire failure and releases the lease', async () => {
  getError = true;
  const result = await invoke();
  assert.equal(result.status, 503); assert.equal(result.response.error, 'SEND_STATE_UNAVAILABLE');
  assert.equal(sends, 0); assert.equal(values.has(key()), false);
  await assert.rejects(() => current(), error => error.code === 'ENOENT');
  assert.equal(appends, 0); assert.equal(clears, 0); assertPrivateLogs();
});
