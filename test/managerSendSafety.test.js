
'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const manager = require('../services/whatsappManager');
const { redisClient } = require('../config/redis');
const instance = 'actual-manager-safety-fixture', phone = '77000000006';
const secret = 'SYNTHETIC_PRIVATE_BODY', token = 'SYNTHETIC_TOKEN';
let logs = [], outcome, attempts;
const failure = () => Object.assign(new Error(secret + ' https://fixture.invalid/' + phone + ' Bearer ' + token), { code: 'ECONNRESET' });
test.beforeEach(t => {
  logs = []; attempts = 0; outcome = { id: { id: 'SYNTHETIC-ACK' }, ack: 1 };
  for (const name of ['log', 'warn', 'error']) t.mock.method(console, name, (...args) => logs.push(args.map(String).join(' ')));
  Object.defineProperty(redisClient, 'isOpen', { configurable: true, value: false });
  manager.clients.set(instance, { sendMessage: async () => { attempts++; if (outcome instanceof Error) throw outcome; return outcome; } });
  manager.__test.instanceTransports.set(instance, 'baileys');
});
test.afterEach(() => {
  manager.clients.delete(instance); manager.__test.instanceTransports.delete(instance);
  manager.__test.clearPendingTextQueue(instance); manager.__test.clearRestartTimer(instance);
  manager.__test.clearLocalBotSends(); delete redisClient.isOpen;
});
function privacy() {
  const text = logs.join('\n');
  for (const value of [phone, phone + '@c.us', phone + '@s.whatsapp.net', secret, token, 'https://fixture.invalid'])
    assert.ok(!text.includes(value), 'send logs must omit ' + value);
}
const sendText = () => manager.sendWhatsAppText(instance, phone, 'synthetic message', { skipQueue: true });
const sendMedia = () => manager.sendMedia(instance, phone, 'data:image/png;base64,YQ==', 'fixture.png', 'synthetic caption', { skipQueue: true });
for (const [kind, send] of [['text', sendText], ['media', sendMedia]]) {
  test('actual manager ' + kind + ' exception preserves unknown but omits private log/response body', async () => {
    outcome = failure();
    const result = await send();
    assert.equal(attempts, 1); assert.equal(result.success, false); assert.equal(result.attempted, true);
    assert.equal(result.outcomeUnknown, true);
    assert.ok(!JSON.stringify(result).includes(secret)); assert.ok(!JSON.stringify(result).includes(token));
    privacy();
  });
  test('actual manager ' + kind + ' negative ACK is conservative uncertainty', async () => {
    outcome.ack = -1;
    const result = await send();
    assert.equal(result.success, false); assert.equal(result.outcomeUnknown, true);
    assert.equal(result.attempted, true); assert.equal(result.ack, -1); privacy();
  });
  test('actual manager ' + kind + ' confirmed acceptance remains successful without raw identity log', async () => {
    const result = await send();
    assert.equal(result.success, true); assert.equal(result.messageId, 'SYNTHETIC-ACK');
    assert.equal(result.ack, 1); assert.equal(attempts, 1); privacy();
  });
}
test('actual outgoing queue log and stored reason reject arbitrary private error bodies', async () => {
  manager.__test.queueOutgoingText(instance, phone, 'synthetic message', failure().message);
  manager.__test.queueOutgoingMedia(instance, phone, { base64Data: 'YQ==', fileName: 'fixture.png' }, failure().message);
  const queued = manager.__test.getPendingTextQueue(instance);
  assert.equal(queued.length, 2);
  assert.ok(queued.every(item => !item.reason.includes(secret) && !item.reason.includes(phone)));
  queued.forEach(item => { item.createdAt = 0; });
  manager.__test.purgeExpiredOutgoingText(instance);
  assert.equal(manager.__test.getPendingTextQueue(instance).length, 0); privacy();
});

for (const field of ['outcomeUnknown', 'queued']) {
  test('actual manager contradictory ' + field + ' metadata is never known acceptance', async () => {
    outcome[field] = true; outcome.success = true;
    const result = await sendText();
    assert.equal(result.success, false); assert.equal(result.outcomeUnknown, true); assert.equal(result.attempted, true);
    assert.equal(attempts, 1); privacy();
  });
}
