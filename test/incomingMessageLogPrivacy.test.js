'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const Module = require('node:module'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const authFixture = path.join(os.tmpdir(), 'inbound-privacy-auth-' + process.pid);
process.env.WHATSAPP_AUTH_PATH = authFixture;
process.env.WHATSPRO_TRANSPORT = 'baileys'; process.env.WHATSPRO_TEST_MODE_ENABLED = 'false';
const phone = '77000000004', body = 'SYNTHETIC_CUSTOMER_PRIVATE_TEXT';
const token = 'SYNTHETIC_INBOUND_TOKEN', errorBody = 'SYNTHETIC_PRIVATE_ERROR';
const privateError = (code = 'ECONNRESET') => Object.assign(new Error(errorBody + ' Bearer ' + token + ' ' + phone), { code });
let adapterFailure = false, receiptFailure = false, forwards, receipts, published, commands, logs, instance, client, sequence = 0;
let localCalls, localSends;
const managerFilename = require.resolve('../services/whatsappManager'), originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (parent?.filename === managerFilename && request === './incomingWebhook') {
    return { forwardIncomingWhatsAppMessage: async payload => {
      forwards.push(payload);
      if (adapterFailure) throw privateError();
      return { ok: true };
    } };
  }
  if (parent?.filename === managerFilename && request === './chatStore') {
    const actual = originalLoad.call(this, request, parent, isMain);
    return { ...actual, updateMessageReceipt: async (...args) => {
      receipts.push(args);
      if (receiptFailure) throw privateError(token + phone);
      return actual.updateMessageReceipt(...args);
    } };
  }
  return originalLoad.call(this, request, parent, isMain);
};
let manager;
try { manager = require('../services/whatsappManager'); } finally { Module._load = originalLoad; }
const { BaileysClient } = require('../services/baileysClient'), { redisClient } = require('../config/redis');
const tenantAdmin = require('../services/tenantAdmin');
function message(extra = {}) {
  return { from: phone + '@c.us', fromMe: false, body, type: 'chat', hasMedia: false,
    id: { id: token + '-' + phone, remote: phone + '@c.us' },
    getContact: async () => ({ number: phone, id: { _serialized: phone + '@c.us' }, name: 'Fixture', isMyContact: true }),
    ...extra };
}
function assertPrivateLogsAbsent() {
  const text = logs.join('\n');
  for (const value of [phone, body, token, errorBody, 'Bearer'])
    assert.equal(text.includes(value), false, 'inbound callback diagnostic contains private fixture data');
}
function assertForwardedPayload() {
  assert.equal(forwards.length, 1); const payload = forwards[0];
  assert.equal(payload.body, body); assert.equal(payload.data.message.conversation, body);
  assert.equal(payload.normalizedPhone, phone);
  assert.equal(payload.data.key.remoteJid, phone + '@c.us');
  assert.equal(payload.data.key.fromMe, false);
}
test.beforeEach(async t => {
  instance = 'inbound-privacy-' + (++sequence);
  forwards = []; receipts = []; commands = []; published = []; logs = [];
  adapterFailure = false; receiptFailure = false; localCalls = 0; localSends = 0;
  for (const name of ['log', 'warn', 'error'])
    t.mock.method(console, name, (...args) => logs.push(args.map(String).join(' ')));
  Object.defineProperty(redisClient, 'isOpen', { configurable: true, value: false });
  t.mock.method(redisClient, 'sendCommand', async args => {
    commands.push(args);
    if (args[0] === 'SISMEMBER') return 1;
    if (args[0] === 'EVAL') return 1;
    if (args[0] === 'TYPE') return 'none';
    if (args[0] === 'GET') return null;
    return 0;
  });
  t.mock.method(redisClient, 'publish', async (channel, raw) => { published.push({ channel, event: JSON.parse(raw) }); return 0; });
  t.mock.method(tenantAdmin, 'findRow', async () => ({ test_mode_enabled: false, calls_disabled: false }));
  t.mock.method(BaileysClient.prototype, 'initialize', async function () { this._connected = true; this.emit('ready'); });
  t.mock.method(BaileysClient.prototype, 'destroy', async function () { this._connected = false; this._stopped = true; });
  t.mock.method(BaileysClient.prototype, 'sendMessage', async () => { localSends++; throw new Error('unexpected send'); });
  t.mock.method(BaileysClient.prototype, 'rejectCall', async () => { localCalls++; throw new Error('unexpected call'); });
  assert.equal((await manager.startWhatsAppInstance(instance)).success, true);
  client = manager.clients.get(instance);
  assert.ok(client instanceof BaileysClient); assert.equal(client._sock, null);
});
test.afterEach(async () => {
  manager.__test.clearPendingTextQueue(instance); manager.__test.clearRestartTimer(instance);
  if (manager.clients.has(instance)) await manager.stopWhatsAppInstance(instance, { wipeCredentials: false });
  manager.__test.clearJidMap(); manager.__test.clearMediaDownloadJobs(); delete redisClient.isOpen;
  assert.equal(localCalls, 0); assert.equal(localSends, 0);
});
test.after(() => fs.rmSync(authFixture, { recursive: true, force: true }));
for (const fail of [false, true]) {
  test('actual registered inbound ' + (fail ? 'adapter failure' : 'success') + ' preserves private payload internally', async () => {
    adapterFailure = fail;
    assert.equal(await client.listeners('message')[0](message()), undefined);
    assertForwardedPayload(); assertPrivateLogsAbsent();
    if (fail) assert.ok(logs.some(x => x.includes('ADAPTER_ERROR') && x.includes('ECONNRESET')));
  });
}
test('actual inbound shape diagnostics never print an arbitrary message type', async () => {
  await client.listeners('message')[0](message({ type: token + phone }));
  assertForwardedPayload(); assertPrivateLogsAbsent();
});
test('actual inbound media failure keeps text and routing, but hides arbitrary transport error code', async t => {
  Object.defineProperty(redisClient, 'isOpen', { configurable: true, value: true });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let downloads = 0;
  await client.listeners('message')[0](message({ hasMedia: true, type: 'ptt', mimetype: 'audio/ogg',
    downloadMedia: async () => { downloads++; throw privateError(token + phone); }
  }));
  assert.equal(downloads, 1); assertForwardedPayload(); assertPrivateLogsAbsent();
  assert.ok(logs.some(x => x.includes('MEDIA_CACHE_FAILED') && x.includes('SEND_OPERATION_FAILED')));
});
test('actual scheduled media retry retains its attempt and does not disclose message ID/error', async t => {
  Object.defineProperty(redisClient, 'isOpen', { configurable: true, value: true });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let downloads = 0;
  await client.listeners('message')[0](message({ hasMedia: true, type: 'ptt', mimetype: 'audio/ogg',
    downloadMedia: async () => { downloads++; throw privateError(token + phone); }
  }));
  logs.length = 0;
  t.mock.timers.tick(1000);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(downloads, 2);
  assert.ok(commands.some(args => args[0] === 'SISMEMBER'));
  assertPrivateLogsAbsent();
});
for (const fail of [false, true]) {
  test('actual registered ACK ' + (fail ? 'failure' : 'success') + ' preserves receipt identity and private diagnostics', async () => {
    receiptFailure = fail;
    Object.defineProperty(redisClient, 'isOpen', { configurable: true, value: true });
    await client.listeners('message_ack')[0]({ ...message(), fromMe: true, to: phone + '@c.us' }, 3);
    assert.deepEqual(receipts, [[instance, phone, token + '-' + phone, 'read']]);
    if (!fail) {
      assert.ok(commands.some(args => args[0] === 'EVAL'));
      assert.equal(published.length, 1); assert.equal(published[0].event.type, 'message.ack');
      assert.equal(published[0].event.phone, phone); assert.equal(published[0].event.deliveryStatus, 'read');
    } else {
      assert.equal(published.length, 0);
    }
    assertPrivateLogsAbsent();
  });
}
test('actual incoming callback still filters group/status messages before forwarding', async () => {
  await client.listeners('message')[0](message({ from: '12000000004@g.us' }));
  await client.listeners('message')[0](message({ from: 'status@broadcast' }));
  assert.equal(forwards.length, 0); assertPrivateLogsAbsent();
});
