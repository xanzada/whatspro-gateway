const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const whatsapp = require('../services/whatsappManager');
const { __test: managerTest } = whatsapp;
const { __test: serverTest } = require('../src/server');

const instanceId = 'queue-safety-fixture';

test.afterEach(() => {
  whatsapp.clients.delete(instanceId);
  managerTest.clearPendingTextQueue(instanceId);
  managerTest.clearLocalBotSends();
});

test('API-style sends never enqueue a second copy while the caller owns retries', async (t) => {
  t.mock.method(console, 'error', () => {});
  assert.deepEqual(
    await whatsapp.sendWhatsAppText(instanceId, '77000000001', 'hello', { skipQueue: true }),
    { success: false, attempted: false },
  );
  assert.equal(
    await whatsapp.sendMedia(instanceId, '77000000001', 'ZmFrZQ==', 'test.txt', '', { skipQueue: true }),
    false,
  );
  assert.equal(managerTest.getPendingTextQueue(instanceId).length, 0);
});

test('failed flush retains messages queued while the old delivery was awaiting I/O', async (t) => {
  t.mock.method(console, 'error', () => {});
  managerTest.queueOutgoingText(instanceId, '77000000001', 'old', 'fixture');
  whatsapp.clients.set(instanceId, {
    sendMessage: async () => {
      managerTest.queueOutgoingText(instanceId, '77000000002', 'new', 'concurrent');
      throw new Error('fixture transport failure');
    },
  });

  await managerTest.flushPendingOutgoingText(instanceId);
  assert.deepEqual(
    managerTest.getPendingTextQueue(instanceId).map(({ text, attempts }) => ({ text, attempts })),
    [{ text: 'old', attempts: 1 }, { text: 'new', attempts: 0 }],
  );
});

test('send success is explicit; a structured failure object is never truthy success', () => {
  assert.equal(serverTest.isSuccessfulApiSend(true), true);
  assert.equal(serverTest.isSuccessfulApiSend({ success: true, messageId: 'fixture' }), true);
  for (const result of [false, null, undefined, { success: false }, { success: false, attempted: true, outcomeUnknown: true }]) {
    assert.equal(serverTest.isSuccessfulApiSend(result), false);
  }
});

test('/api/send wires text and media through non-queueing manager calls', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  const route = source.slice(source.indexOf("app.post('/api/send'"), source.indexOf("app.post('/api/presence'"));
  assert.match(route, /sendMedia\([^;]+\{ skipQueue: true \}\)/s);
  assert.match(route, /sendWhatsAppText\([^;]+\{ skipQueue: true \}\)/s);
  assert.match(route, /const ok = isSuccessfulApiSend\(sendResult\)/);
});
