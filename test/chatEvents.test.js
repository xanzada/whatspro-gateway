const test = require('node:test');
const assert = require('node:assert/strict');

const { publishChatEvent, subscribeChatEvents } = require('../services/chatEvents');

test('chat events stay isolated by instance when Redis is unavailable', async () => {
  const received = [];
  const unsubscribe = await subscribeChatEvents('tenant-a', event => received.push(event));

  await publishChatEvent({ type: 'chat.changed', instanceId: 'tenant-b', phone: '+77000000001' });
  await publishChatEvent({ type: 'chat.changed', instanceId: 'tenant-a', phone: '+77000000002' });

  unsubscribe();
  assert.equal(received.length, 1);
  assert.equal(received[0].instanceId, 'tenant-a');
  assert.equal(received[0].phone, '77000000002');
  assert.match(received[0].eventId, /\S+/);
});

test('invalid subscriptions and events are rejected', async () => {
  await assert.rejects(() => subscribeChatEvents('', () => {}), /SUBSCRIPTION_INVALID/);
  await assert.rejects(() => publishChatEvent({ type: 'chat.changed' }), /INSTANCE_REQUIRED/);
});
