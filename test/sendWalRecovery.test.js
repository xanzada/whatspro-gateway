'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const walDir = path.join(os.tmpdir(), `whatspro-send-wal-test-${process.pid}`);
process.env.WHATSPRO_SEND_WAL_DIR = walDir;
process.env.WHATSPRO_SEND_INTENT_STALE_MS = '1000';

const { __test: serverTest } = require('../src/server');

// Minimal stand-in for the idempotency keyspace recovery reads.
class FakeRedis {
  constructor() { this.isOpen = true; this.values = new Map(); }
  async sendCommand(args) {
    const [command, key] = args;
    if (command === 'GET') return this.values.has(key) ? this.values.get(key) : null;
    return 0;
  }
}

function leaseFor(requestId, hash = 'hash') {
  const key = `chatwoot:send-idempotency:acme:77001234567:${requestId}`;
  return { acquired: true, backend: 'redis', key, token: 'token', pendingValue: `pending:token:${hash}`, payloadHash: hash };
}

test.after(() => fs.rm(walDir, { recursive: true, force: true }));

test('a poisoned intent record is retired instead of blocking every send', async () => {
  const redis = new FakeRedis();
  const lease = leaseFor('request_poisoned1');
  redis.values.set(lease.key, lease.pendingValue);
  const walPath = await serverTest.writeSendWal({
    phase: 'intent', lease, instanceId: 'acme', phone: '77001234567', text: 'hi',
    operationStartedAt: Date.now() - 600000
  });

  // The deployed version threw AMBIGUOUS_SEND_INTENT_REQUIRES_RECONCILIATION here, which
  // left walRecoveryComplete false forever and turned every send into a 503.
  await serverTest.recoverSendWal(redis);
  const promoted = JSON.parse(await fs.readFile(walPath, 'utf8'));
  assert.equal(promoted.phase, 'ambiguous');
  assert.match(promoted.reason, /orphaned intent/);

  // Terminal: repeated passes stay quiet and keep completing.
  await serverTest.recoverSendWal(redis);
  assert.equal(JSON.parse(await fs.readFile(walPath, 'utf8')).phase, 'ambiguous');

  // Once the idempotency lease it guards is gone, the record has nothing left to protect.
  redis.values.delete(lease.key);
  await serverTest.recoverSendWal(redis);
  await assert.rejects(fs.readFile(walPath, 'utf8'), error => error.code === 'ENOENT');
});

test('a live intent record is left alone by a concurrent recovery pass', async () => {
  const redis = new FakeRedis();
  const lease = leaseFor('request_inflight1');
  redis.values.set(lease.key, lease.pendingValue);
  const walPath = await serverTest.writeSendWal({
    phase: 'intent', lease, instanceId: 'acme', phone: '77001234567', text: 'hi',
    operationStartedAt: Date.now()
  });
  await serverTest.recoverSendWal(redis);
  assert.equal(JSON.parse(await fs.readFile(walPath, 'utf8')).phase, 'intent');
  await fs.unlink(walPath);
});

test('the per-requestId guard still refuses a duplicate send', async () => {
  const redis = new FakeRedis();
  redis.sendCommand = async args => {
    const [command, key, value] = args;
    if (command === 'SET') {
      if (redis.values.has(key)) return null;
      redis.values.set(key, value);
      return 'OK';
    }
    if (command === 'GET') return redis.values.has(key) ? redis.values.get(key) : null;
    return 0;
  };
  const guard = serverTest.createSendIdempotency(redis);
  const first = await guard.begin('acme', '77001234567', 'request_duplicate1', 'hash-a');
  assert.equal(first.acquired, true);
  const duplicate = await guard.begin('acme', '77001234567', 'request_duplicate1', 'hash-a');
  assert.equal(duplicate.acquired, false);
  assert.equal(duplicate.inProgress, true);
  const mismatched = await guard.begin('acme', '77001234567', 'request_duplicate1', 'hash-b');
  assert.equal(mismatched.conflict, true);
});

test('the send route rejects a retry of an ambiguous request and reports failed acks', async () => {
  const source = await fs.readFile(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  const route = source.slice(source.indexOf("app.post('/api/chat/send/:instanceId/:phone'"));
  assert.match(route, /priorWal\?\.phase === 'intent' \|\| priorWal\?\.phase === 'ambiguous'/);
  assert.match(route, /markSendWalAmbiguous\(intentRecord/);
  assert.doesNotMatch(route.slice(0, route.indexOf('/api/chat/operator-lock')), /walRecoveryComplete = false/);
  assert.match(route, /Number\(sendResult\?\.ack\) < 0 \? 'failed'/);
  assert.doesNotMatch(source, /AMBIGUOUS_SEND_INTENT_REQUIRES_RECONCILIATION/);
});

test('inbox ordering normalises second-precision timestamps to milliseconds', () => {
  const seconds = 1754800000;
  assert.equal(serverTest.getEntryCreatedAt({ createdAt: seconds }), seconds * 1000);
  assert.equal(serverTest.getEntryCreatedAt({ timestamp: seconds }), seconds * 1000);
  assert.equal(serverTest.getEntryCreatedAt({ time: seconds }), seconds * 1000);
  assert.equal(serverTest.getEntryCreatedAt({ createdAt: seconds * 1000 }), seconds * 1000);
  assert.equal(serverTest.getEntryCreatedAt({}), 0);
  assert.equal(serverTest.getEntryCreatedAt(null), 0);
  assert.equal(serverTest.getEntryCreatedAt({ createdAt: 'nope' }), 0);
});
