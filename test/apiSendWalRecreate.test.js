'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createClient } = require('redis');
const enabled = process.env.AUDIT_API_RECREATE_STAGE && process.env.AUDIT_REDIS_SOCKET;
const instanceId = 'api-recreate-fixture';
const phone = '77000000004';
const manager = require('../services/whatsappManager');
let sends = 0;
let outcome;
manager.sendWhatsAppText = async () => { sends++; return outcome; };
const { app, __test } = require('../src/server');
const { redisClient } = require('../config/redis');
const { chatStore } = require('../services/chatStore');
const real = enabled ? createClient({ socket: { path: process.env.AUDIT_REDIS_SOCKET, reconnectStrategy: false }, disableOfflineQueue: true }) : null;
async function route(requestId) {
  const send = app.router.stack.find(layer => layer.route?.path === '/api/send').route.stack.at(-1).handle;
  let status = 200, response;
  await send({ body: { instanceId, phone, requestId, text: 'synthetic recreate notice' },
    apiAuth: { scope: 'tenant', instanceId } },
    { status(code) { status = code; return this; }, json(value) { response = value; return this; } });
  return { status, response };
}
test.before(async () => {
  if (!enabled) return;
  assert.equal(__test.SEND_WAL_DIR, '/fixture_auth/.send-wal');
  assert.equal(__test.API_SEND_WAL_DIR, '/fixture_auth/.send-wal/api-send');
  real.on('error', () => {}); await real.connect(); await real.flushDb();
});
test.after(async () => { if (enabled) { delete redisClient.isOpen; if (real.isOpen) await real.quit(); } });
test('auth volume journal survives a fresh gateway container and loss of Redis leases', { skip: !enabled }, async t => {
  for (const name of ['log', 'warn', 'error']) t.mock.method(console, name, () => {});
  Object.defineProperty(redisClient, 'isOpen', { configurable: true, value: true });
  t.mock.method(redisClient, 'sendCommand', args => real.sendCommand(args));
  t.mock.method(redisClient, 'publish', (...args) => real.publish(...args));
  t.mock.method(chatStore, 'appendMessageOnce', async (_instance, _phone, entry) => ({ ...entry, inserted: true }));
  if (process.env.AUDIT_API_RECREATE_STAGE === 'write') {
    outcome = { success: true, ack: 1, messageId: 'SYNTHETIC-CONTAINER-ACK' };
    assert.equal((await route('recreate-accepted-fixture')).status, 200);
    outcome = { success: false, attempted: true, outcomeUnknown: true };
    assert.equal((await route('recreate-uncertain-fixture')).response.error, 'SEND_OUTCOME_UNKNOWN');
    assert.equal(sends, 2);
  } else {
    outcome = { success: true, ack: 1, messageId: 'MUST-NOT-BE-SENT' };
    await __test.recoverSendWal(redisClient);
    const accepted = await route('recreate-accepted-fixture');
    const uncertain = await route('recreate-uncertain-fixture');
    assert.equal(accepted.status, 200); assert.equal(accepted.response.replayed, true);
    assert.equal(accepted.response.messageId, 'SYNTHETIC-CONTAINER-ACK');
    assert.equal('delivered' in accepted.response, false);
    assert.equal(uncertain.status, 409); assert.equal(uncertain.response.error, 'SEND_OUTCOME_UNKNOWN');
    assert.equal(sends, 0, 'the fresh process must make no second transport attempt');
  }
  const expected = { pending: 0, uncertain: 1, accepted: 1, corrupt: 0 };
  assert.deepEqual(await __test.apiSendWalSummary(), expected);
  if (process.env.AUDIT_OLD_WAL_SOURCE) {
    const fs = require('node:fs');
    const source = fs.readFileSync(process.env.AUDIT_OLD_WAL_SOURCE, 'utf8');
    const start = source.indexOf('async function recoverSendWal(');
    const end = source.indexOf('\nasync function sweepExpiredChatIndexes', start);
    assert.ok(start > 0 && end > start);
    let touched = 0;
    const legacyScan = require('node:vm').runInNewContext(source.slice(start, end) + '\nrecoverSendWal', {
      fs: require('node:fs/promises'), path: require('node:path'), SEND_WAL_DIR: __test.SEND_WAL_DIR,
      liveSendWalPaths: new Set(), ambiguousSendWalLogged: new Set(), Date, console,
      markSendWalAmbiguous: async () => { touched++; }, removeSendWal: async () => { touched++; }
    });
    await legacyScan({ isOpen: true, sendCommand: async () => { touched++; return null; } });
    assert.equal(touched, 0, 'the actual old scanner must not read, replay or remove API records');
    assert.deepEqual(await __test.apiSendWalSummary(), expected);
  }
});
