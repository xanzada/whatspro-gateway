'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), Module = require('node:module');
const authFixture = path.join(os.tmpdir(), 'operational-privacy-auth-' + process.pid);
process.env.WHATSAPP_AUTH_PATH = authFixture; process.env.WHATSPRO_TRANSPORT = 'baileys';
process.env.WHATSPRO_TEST_MODE_ENABLED = 'false';
const manager = require('../services/whatsappManager'), { BaileysClient } = require('../services/baileysClient');
const { redisClient } = require('../config/redis'), tenantAdmin = require('../services/tenantAdmin');
const { createChatStore } = require('../services/chatStore');
const phone = '77000000008', lid = '991234567890123@lid';
const privateBody = 'SYNTHETIC_PRIVATE_BODY', token = 'SYNTHETIC_TOKEN';
let logs, instance, sequence = 0, wireCalls = 0, wireSends = 0;
const privateError = (code = 'ECONNRESET') => Object.assign(new Error(privateBody + ' Bearer ' + token + ' ' + phone), { code });
// Test-only access to a private browser binding: compile the exact source with one
// export suffix, never alter functions, replace dispatch, or create a browser/socket.
const filename = require.resolve('../services/whatsappManager'), fixture = new Module(filename, module);
fixture.filename = filename; fixture.paths = Module._nodeModulePaths(path.dirname(filename));
fixture._compile(fs.readFileSync(filename, 'utf8') + '\nmodule.exports.__test.watchForPrivacyFixture=watchWppIncomingCalls;', filename);
const watch = fixture.exports.__test.watchForPrivacyFixture;
function privateLogsAbsent() {
  const text = logs.join('\n');
  for (const value of [phone, lid, privateBody, token, 'Bearer', 'https://fixture.invalid'])
    assert.equal(text.includes(value), false, 'operational diagnostic contains private fixture data');
}
test.beforeEach(t => {
  instance = 'operational-privacy-' + (++sequence); logs = []; wireCalls = 0; wireSends = 0;
  for (const name of ['log', 'warn', 'error']) t.mock.method(console, name, (...args) => logs.push(args.map(String).join(' ')));
  Object.defineProperty(redisClient, 'isOpen', { configurable: true, value: false });
  t.mock.method(tenantAdmin, 'findRow', async () => ({ test_mode_enabled: false, calls_disabled: false }));
  t.mock.method(BaileysClient.prototype, 'initialize', async function () { this._connected = true; this.emit('ready'); });
  t.mock.method(BaileysClient.prototype, 'destroy', async function () { this._connected = false; this._stopped = true; });
  t.mock.method(BaileysClient.prototype, 'rejectCall', async () => { wireCalls++; throw new Error('unexpected call'); });
  t.mock.method(BaileysClient.prototype, 'sendMessage', async () => { wireSends++; throw new Error('unexpected send'); });
});
test.afterEach(async () => {
  manager.__test.clearPendingTextQueue(instance); manager.__test.clearRestartTimer(instance);
  if (manager.clients.has(instance)) await manager.stopWhatsAppInstance(instance, { wipeCredentials: false });
  manager.__test.clearJidMap(); manager.__test.clearLocalBotSends(); manager.__test.seenCallIds.clear(); delete redisClient.isOpen;
  assert.equal(wireCalls, 0); assert.equal(wireSends, 0);
});
test.after(() => fs.rmSync(authFixture, { recursive: true, force: true }));
test('actual fallback call contact resolution preserves phone/LID routing without logging identities', async () => {
  const result = await manager.__test.resolveCallPhone({ getContactById: async () => ({
    id: { _serialized: lid }, number: phone, isMe: false, isUser: true
  }) }, { from: lid });
  assert.equal(result, phone); privateLogsAbsent();
});
test('actual successful LID resolver preserves canonical phone without logging mapping', async () => {
  const result = await manager.__test.getOutgoingPhoneFromMessage({ getContactLidAndPhone: async () => [{ lid, pn: phone + '@s.whatsapp.net' }] },
    { fromMe: true, to: lid, id: { remote: lid } });
  assert.equal(result, phone); privateLogsAbsent();
});
test('actual LID lookup failure logs a finite safe code instead of arbitrary body or code', async () => {
  await manager.__test.getOutgoingPhoneFromMessage({ getContactLidAndPhone: async () => { throw privateError(phone + token); } },
    { fromMe: true, to: lid, id: { remote: lid } });
  assert.ok(logs.some(line => line.includes('SEND_OPERATION_FAILED'))); privateLogsAbsent();
});
for (const method of ['sendPresence', 'markAsRead']) {
  test('actual ' + method + ' failure preserves false result without private logs', async () => {
    manager.clients.set(instance, { getState: async () => 'CONNECTED', getChatById: async () => { throw privateError(); }, destroy: async () => {} });
    assert.equal(await manager[method](instance, phone, 'typing'), false); privateLogsAbsent();
  });
}
test('presence read and typing still invoke only their selected local client methods', async () => {
  let read = 0, typing = 0;
  manager.clients.set(instance, { getChatById: async () => ({ sendSeen: async () => { read++; }, sendStateTyping: async () => { typing++; } }), destroy: async () => {} });
  assert.equal(await manager.sendPresence(instance, phone, 'read'), true);
  assert.equal(await manager.sendPresence(instance, phone, 'typing'), true);
  assert.equal(read, 1); assert.equal(typing, 1); privateLogsAbsent();
});
test('actual WPP callback logs safe shape metadata and still dispatches an outgoing synthetic payload', async () => {
  let binding;
  const client = { pupPage: { exposeFunction: async (_name, callback) => { binding = callback; }, evaluate: async () => true, on() {} } };
  assert.equal(await watch(instance, client), true);
  binding({ id: token, from: lid, number: phone, fromMe: true, outgoing: true,
    via: privateBody, isVideo: true, isGroup: false, nested: { secret: token } });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(logs.some(line => /source=wa-js/.test(line))); privateLogsAbsent();
});

test('actual duplicate call dispatch preserves one claim without logging its private ID', async () => {
  manager.__test.seenCallIds.clear();
  const call = { id: token + phone, from: lid };
  await manager.__test.dispatchIncomingCall(instance, {}, call, 'wa-js');
  await manager.__test.dispatchIncomingCall(instance, {}, call, 'wwebjs');
  assert.equal(manager.__test.seenCallIds.size, 1);
  privateLogsAbsent();
  assert.ok(logs.some(line => line.includes('DUPLICATE_IGNORED')));
});
test('actual call dispatch failure retains one claim and catches a private exception safely', async () => {
  manager.__test.seenCallIds.clear();
  await manager.__test.dispatchIncomingCall(instance, {}, { id: token + phone, from: lid }, 'wa-js', {
    tenantAdmin: { findRow: async () => ({ calls_disabled: true }) },
    rejectCall: async () => false,
    getTestModePolicy: async () => ({ enabled: false }),
    resolvePhone: async () => { throw privateError(); }
  });
  assert.equal(manager.__test.seenCallIds.size, 1);
  privateLogsAbsent();
  assert.ok(logs.some(line => line.includes('CALL_DISPATCH_FAILED') && line.includes('ECONNRESET')));
});

for (const stage of ['binding', 'subscribe']) {
  test('actual WPP ' + stage + ' failure preserves false result without raw exception log', async () => {
    const client = { pupPage: {
      exposeFunction: async () => { if (stage === 'binding') throw privateError(); },
      evaluate: async () => { throw privateError(); }, on() {}
    } };
    assert.equal(await watch(instance, client), false); privateLogsAbsent();
  });
}
function fakeRedis(commands, failLock = false) {
  return async args => {
    commands.push(args);
    if (args[0] === 'GET') return null;
    if (args[0] === 'TYPE') return 'none';
    if (args[0] === 'SET') { if (failLock && String(args[1]).startsWith('operator_active:')) throw privateError(); return 'OK'; }
    if (['SMEMBERS', 'LRANGE'].includes(args[0])) return [];
    if (args[0] === 'EVAL') return String(args[1]).includes('local targetState') ? [1, 'operator'] : 0;
    return 0;
  };
}
for (const failed of [false, true]) {
  test('actual message_create callback ' + (failed ? 'failure' : 'success') + ' retains operator routing with private diagnostics', async t => {
    const commands = [];
    Object.defineProperty(redisClient, 'isOpen', { configurable: true, value: true });
    t.mock.method(redisClient, 'sendCommand', fakeRedis(commands, failed)); t.mock.method(redisClient, 'publish', async () => 0);
    assert.equal((await manager.startWhatsAppInstance(instance)).success, true);
    const client = manager.clients.get(instance);
    assert.ok(client instanceof BaileysClient); assert.equal(client._sock, null);
    await client.listeners('message_create')[0]({ fromMe: true, to: phone + '@c.us', body: 'synthetic operator reply', id: { id: token, remote: phone + '@c.us' } });
    assert.ok(commands.some(args => args[0] === 'SET' && args[1] === 'operator_active:' + instance + ':' + phone));
    if (!failed) assert.ok(commands.some(args => args[0] === 'EVAL' && String(args[1]).includes('local targetState')));
    privateLogsAbsent();
  });
}
test('actual missing-media append retains entry and emits a safe diagnostic only', async () => {
  const commands = [], store = createChatStore({ sendCommand: fakeRedis(commands) }, { now: () => 1700000000000 });
  const result = await store.appendMessageOnce(instance, phone, { id: phone + '-' + token, hasMedia: true, type: 'ptt', createdAt: 1700000000000 }, { state: 'new' });
  assert.equal(result.inserted, true); assert.equal(result.hasMedia, true);
  assert.equal(logs.length, 1); assert.ok(logs[0].includes('MEDIA_DATA_MISSING')); privateLogsAbsent();
});
