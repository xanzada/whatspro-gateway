'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const testMode = require('../services/testModePolicy');
const { __test: webhookTest } = require('../services/incomingWebhook');
const { __test: whatsappTest } = require('../services/whatsappManager');

test('strict test mode allows only the tenant developer phone', async () => {
  const dependencies = {
    env: { TEST_MODE_ENABLED: 'true' },
    findRow: async () => ({ instance_id: 'prestige', dev_phone: '+7 776 915 61 84' })
  };

  const policy = await testMode.getTestModePolicy('prestige', dependencies);
  assert.deepEqual(policy, { enabled: true, devPhone: '77769156184' });
  assert.equal(testMode.allowsPhone(policy, '+7 776 915 61 84'), true);
  assert.equal(testMode.allowsPhone(policy, '+7 702 275 42 35'), false);
  assert.deepEqual(
    testMode.filterAllowedPhones(policy, [{ phone: '77769156184' }, { phone: '77022754235' }]),
    [{ phone: '77769156184' }]
  );
});

test('test mode stays fail-closed when the developer phone is missing', async () => {
  const policy = await testMode.getTestModePolicy('prestige', {
    env: { TEST_MODE_ENABLED: 'true' },
    findRow: async () => ({ instance_id: 'prestige', dev_phone: '' })
  });

  assert.deepEqual(policy, { enabled: true, devPhone: '' });
  assert.equal(testMode.allowsPhone(policy, '77769156184'), false);
});

test('incoming storage is skipped before a foreign test-mode phone can create a chat', async () => {
  let appends = 0;
  const result = await webhookTest.saveIncomingMessage({
    instanceId: 'prestige', phone: '77022754235', messageId: 'foreign-1', body: 'hello'
  }, {
    redisOpen: true,
    isPhoneAllowed: async () => false,
    store: { appendMessageOnce: async () => { appends += 1; return { inserted: true }; } },
    publishEvent: async () => {}
  });

  assert.deepEqual(result, { skipped: true, reason: 'test_mode_blocked', instanceId: 'prestige', phone: '77022754235' });
  assert.equal(appends, 0);
});

test('call handling rejects everyone, replies only to the allowed phone via bot delivery', async () => {
  const calls = [];
  const call = { from: '77769156184@c.us', reject: async () => { calls.push('reject'); } };
  const client = { sendMessage: async () => { throw new Error('direct client.sendMessage must not be used'); } };
  const delivered = [];

  const allowed = await whatsappTest.handleIncomingCall('prestige', client, call, {
    isPhoneAllowed: async () => true,
    deliverText: async (...args) => { delivered.push(args); return { success: true }; }
  });
  assert.deepEqual(allowed, { rejected: true, replied: true, phone: '77769156184' });
  assert.deepEqual(calls, ['reject']);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0][1], 'prestige');
  assert.equal(delivered[0][2], '77769156184');
  assert.match(delivered[0][3], /мәтінмен немесе аудиохабарламамен/i);

  const blockedCall = { from: '77022754235@c.us', reject: async () => { calls.push('reject-blocked'); } };
  const blocked = await whatsappTest.handleIncomingCall('prestige', client, blockedCall, {
    isPhoneAllowed: async () => false,
    deliverText: async () => { throw new Error('blocked caller must not receive a message'); }
  });
  assert.deepEqual(blocked, { rejected: true, replied: false, phone: '77022754235', reason: 'test_mode_blocked' });
  assert.deepEqual(calls, ['reject', 'reject-blocked']);
});
