'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const walDir = path.join(os.tmpdir(), 'api-wal-crossaudit-' + process.pid);
process.env.WHATSPRO_SEND_WAL_DIR = walDir;
const { redisClient } = require('../config/redis');
const { chatStore } = require('../services/chatStore');
const manager = require('../services/whatsappManager');
const originalSendMedia = manager.sendMedia;
let sendResult;
let sends = 0;
let throwSend = false;
manager.sendWhatsAppText = manager.sendMedia = async () => {
  sends++;
  if (throwSend) { const error = new Error('synthetic transport timeout'); error.sendAttempted = true; throw error; }
  return sendResult;
};
let server = require('../src/server');
const values = new Map();
const phone = '77000000001';
const instanceId = 'api-wal-fixture';
let testIndex = 0;
let requestId;
function key(id = requestId) { return 'chatwoot:send-idempotency:' + instanceId + ':' + phone + ':' + id; }
function file(id = requestId) { return path.join(walDir, 'api-send', crypto.createHash('sha256').update(key(id)).digest('hex') + '.json'); }
async function record(id = requestId) { return JSON.parse(await fs.readFile(file(id), 'utf8')); }
async function invoke(body = {}, currentServer = server) {
  const route = currentServer.app.router.stack.find(layer => layer.route?.path === '/api/send').route;
  assert.equal(route.stack[0].handle.name, 'requireApi');
  let status = 200;
  let response;
  await route.stack.at(-1).handle({
    body: { instanceId, phone, requestId, text: 'synthetic notice', ...body },
    apiAuth: { scope: 'tenant', instanceId }
  }, {
    status(code) { status = code; return this; },
    json(value) { response = value; return this; }
  });
  return { status, response };
}
test.beforeEach(async t => {
  requestId = 'fixture-request-' + (++testIndex);
  sends = 0; throwSend = false; values.clear();
  sendResult = { success: false, attempted: true, outcomeUnknown: true };
  for (const name of ['log', 'warn', 'error']) t.mock.method(console, name, () => {});
  Object.defineProperty(redisClient, 'isOpen', { configurable: true, value: true });
  t.mock.method(chatStore, 'resolveLidPhone', async (_instance, value) => String(value).replace(/\D/g, ''));
  t.mock.method(chatStore, 'appendMessageOnce', async (_instance, _phone, entry) => ({ ...entry, inserted: true }));
  t.mock.method(redisClient, 'publish', async () => 0);
  t.mock.method(redisClient, 'sendCommand', async args => {
    const [cmd, itemKey, value] = args;
    if (cmd === 'GET') return values.get(itemKey) || null;
    if (cmd === 'SET') {
      if (args.includes('NX') && values.has(itemKey)) return null;
      values.set(itemKey, value); return 'OK';
    }
    if (cmd === 'EVAL') {
      const keyCount = Number(args[2]);
      const guardedKey = args[3];
      const argv = args.slice(3 + keyCount);
      if (values.get(guardedKey) !== argv[0]) return 0;
      if (String(args[1]).includes("redis.call('DEL'")) { values.delete(guardedKey); return 1; }
      if (String(args[1]).includes("redis.call('SET'")) { values.set(guardedKey, argv[1]); return 1; }
      return 1;
    }
    if (['LRANGE', 'ZRANGE', 'HGETALL'].includes(cmd)) return [];
    return 0;
  });
  await fs.mkdir(walDir, { recursive: true });
});
test.after(async () => { delete redisClient.isOpen; await fs.rm(walDir, { recursive: true, force: true }); });

test('uncertain text ACK preserves requestId lease and durable record; retry never resends', async () => {
  const first = await invoke();
  const retry = await invoke();
  assert.equal(first.status, 409);
  assert.equal(first.response.error, 'SEND_OUTCOME_UNKNOWN');
  assert.equal(first.response.success, false);
  assert.equal(first.response.outcomeUnknown, true);
  assert.equal(retry.status, 409);
  assert.equal(sends, 1);
  assert.ok(values.has(key()));
  const saved = await record();
  assert.deepEqual(await fs.readdir(walDir), ['api-send'], 'legacy root-level scanners cannot see API records');
  assert.equal(saved.kind, 'api_send');
  assert.equal(saved.phase, 'ambiguous');
  assert.equal(saved.requestId, requestId);
  assert.equal('text' in saved, false, 'journal does not retain customer message or media payload');
});

test('attempted failure without an explicit unknown flag is conservative; media uses the same guard', async () => {
  sendResult = { success: false, attempted: true };
  const text = await invoke();
  assert.equal(text.status, 409);
  requestId += '-media';
  sendResult = { success: false, attempted: true, outcomeUnknown: true };
  const payload = { text: '', media: { base64: Buffer.from('synthetic').toString('base64'), mimeType: 'image/png', fileName: 'fixture.png' } };
  const first = await invoke(payload);
  const retry = await invoke(payload);
  assert.equal(first.status, 409);
  assert.equal(retry.status, 409);
  assert.equal(sends, 2);
  assert.equal((await record()).phase, 'ambiguous');
});

test('an unexpected transport exception records uncertainty instead of releasing the lease', async () => {
  throwSend = true;
  const result = await invoke();
  assert.equal(result.status, 409);
  assert.equal(result.response.error, 'SEND_OUTCOME_UNKNOWN');
  assert.equal((await record()).phase, 'ambiguous');
  assert.ok(values.has(key()));
});

test('a proven nonattempted failure releases the lease and permits a later safe send', async () => {
  sendResult = { success: false, attempted: false };
  assert.equal((await invoke()).status, 503);
  await assert.rejects(() => fs.readFile(file()), error => error.code === 'ENOENT');
  assert.equal(values.has(key()), false);
  sendResult = { success: true, messageId: 'SYNTHETIC-ACK', ack: 1 };
  assert.equal((await invoke()).status, 200);
  assert.equal(sends, 2);
});

test('a WAL failure aborts before network and releases only the unsent lease', async t => {
  t.mock.method(fs, 'open', async () => { const error = new Error('synthetic disk full'); error.code = 'ENOSPC'; throw error; });
  const result = await invoke();
  assert.equal(result.status, 507);
  assert.equal(result.response.error, 'SEND_WAL_UNAVAILABLE');
  assert.equal(sends, 0);
  assert.equal(values.has(key()), false);
});

test('transport acceptance is journaled and replayed after recreate and loss of Redis lease', async () => {
  sendResult = { success: true, messageId: 'SYNTHETIC-ACK', ack: 1 };
  const first = await invoke();
  assert.equal(first.status, 200);
  assert.equal((await record()).phase, 'accepted');
  values.clear();
  delete require.cache[require.resolve('../src/server')];
  server = require('../src/server'); // fresh process-local idempotency state, same persistent directory
  const retry = await invoke();
  assert.equal(retry.status, 200);
  assert.equal(retry.response.success, true);
  assert.equal(retry.response.replayed, true);
  assert.equal('delivered' in retry.response, false);
  assert.equal(sends, 1);
});

test('changed payload under an uncertain requestId is a conflict, never another send', async () => {
  await invoke();
  const changed = await invoke({ text: 'different synthetic notice' });
  assert.equal(changed.status, 409);
  assert.equal(changed.response.error, 'IDEMPOTENCY_PAYLOAD_MISMATCH');
  assert.equal(sends, 1);
});

test('recovery never deletes API uncertain records just because Redis expired or was lost', async () => {
  await invoke();
  values.clear();
  await server.__test.recoverSendWal(redisClient);
  assert.equal((await record()).phase, 'ambiguous');
  const retry = await invoke();
  assert.equal(retry.status, 409);
  assert.equal(sends, 1);
});

test('a persisted intent without a live operation is conservatively uncertain after recreation', async () => {
  const hash = crypto.createHash('sha256').update('synthetic notice').digest('hex');
  await server.__test.writeSendWal({
    kind: 'api_send', phase: 'intent', instanceId, phone, requestId,
    lease: { key: key(), payloadHash: hash, pendingValue: 'pending-fixture:' + hash, backend: 'redis', acquired: true },
    operationStartedAt: Date.now() - 600000
  });
  await server.__test.recoverSendWal(redisClient);
  assert.equal((await record()).phase, 'ambiguous');
  const retry = await invoke();
  assert.equal(retry.status, 409);
  assert.equal(sends, 0, 'crash-before-send is safe but requires reconciliation');
});

test('only expired accepted API journals are automatically retired, with aggregate counters', async () => {
  sendResult = { success: true, messageId: 'SYNTHETIC-ACK', ack: 1 };
  await invoke();
  const accepted = await record();
  accepted.retainedUntil = Date.now() - 1;
  await server.__test.writeSendWal(accepted);
  await server.__test.recoverSendWal(redisClient);
  await assert.rejects(() => fs.readFile(file()), error => error.code === 'ENOENT');
  const summary = await server.__test.apiSendWalSummary();
  assert.ok(summary.uncertain >= 1);
  assert.equal('phone' in summary, false);
  assert.equal('records' in summary, false);
});

test('legacy no-ID sends keep compatibility but report uncertainty explicitly', async () => {
  const result = await invoke({ requestId: '' });
  assert.equal(result.status, 409);
  assert.equal(result.response.outcomeUnknown, true);
  assert.equal(sends, 1);
});

test('media skipQueue preserves attempted/unknown outcome from actual manager transport', async t => {
  const mediaInstance = 'api-wal-media-fixture';
  manager.clients.set(mediaInstance, { sendMessage: async () => { throw new Error('synthetic lost media ACK'); } });
  t.after(() => {
    manager.clients.delete(mediaInstance);
    manager.__test.clearPendingTextQueue(mediaInstance);
    manager.__test.clearLocalBotSends();
  });
  const result = await originalSendMedia(mediaInstance, phone, 'data:image/png;base64,c3ludGhldGlj', 'fixture.png', '', { skipQueue: true });
  assert.equal(result.success, false);
  assert.equal(result.attempted, true);
  assert.equal(result.outcomeUnknown, true);
  assert.equal(manager.__test.getPendingTextQueue(mediaInstance).length, 0);
});


test('explicit unknown outcome overrides contradictory success or negative-ACK metadata', async () => {
  for (const metadata of [{ success: true, attempted: true, outcomeUnknown: true, ack: 1 },
    { success: false, attempted: true, outcomeUnknown: true, ack: -1 }]) {
    requestId += '-mixed';
    sendResult = metadata;
    assert.equal((await invoke()).status, 409);
    assert.equal((await record()).phase, 'ambiguous');
    assert.equal((await invoke()).response.error, 'SEND_OUTCOME_UNKNOWN');
  }
  assert.equal(sends, 2);
});
test('a known negative ACK is a failed send, never accepted or delivered', async () => {
  sendResult = { success: true, attempted: true, ack: -1 };
  const result = await invoke();
  assert.equal(result.status, 503); assert.equal(result.response.success, false);
  assert.equal(values.has(key()), false);
  await assert.rejects(() => fs.readFile(file()), error => error.code === 'ENOENT');
});
test('failure to journal transport acceptance retains intent and blocks a second attempt', async t => {
  const originalOpen = fs.open;
  let writes = 0;
  t.mock.method(fs, 'open', async (target, ...args) => {
    if (String(target).endsWith('.tmp') && ++writes === 2) {
      const error = new Error('synthetic accepted record disk failure'); error.code = 'ENOSPC'; throw error;
    }
    return originalOpen(target, ...args);
  });
  sendResult = { success: true, messageId: 'SYNTHETIC-ACK', ack: 1 };
  assert.equal((await invoke()).status, 409);
  assert.equal((await record()).phase, 'intent');
  assert.equal((await invoke()).status, 409); assert.equal(sends, 1);
  assert.ok(values.has(key()));
});
test('stable-ID sends fail before network when Redis cannot coordinate gateway processes', async () => {
  Object.defineProperty(redisClient, 'isOpen', { configurable: true, value: false });
  sendResult = { success: true, messageId: 'SYNTHETIC-ACK', ack: 1 };
  const result = await invoke();
  assert.equal(result.status, 503); assert.equal(result.response.error, 'REDIS_IDEMPOTENCY_UNAVAILABLE');
  assert.equal(sends, 0);
  await assert.rejects(() => fs.readFile(file()), error => error.code === 'ENOENT');
});
test('legacy clients without requestId retain successful-send compatibility', async () => {
  sendResult = { success: true, messageId: 'SYNTHETIC-ACK', ack: 1 };
  const result = await invoke({ requestId: '' });
  assert.equal(result.status, 200); assert.equal(result.response.success, true); assert.equal(sends, 1);
});
