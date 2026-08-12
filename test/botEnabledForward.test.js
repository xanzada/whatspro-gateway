const test = require('node:test');
const assert = require('node:assert/strict');
const { __test } = require('../services/incomingWebhook');

// A paused bot used to keep answering: `bot_enabled: false` was honoured by the
// admin panel and by tenant readiness, but not on the path that actually forwards
// a customer's message to OpenBot.
const payload = { instanceId: 'prestige', phone: '77001234567', body: 'сәлем' };
const allowAll = { isPhoneAllowed: async () => true };

test('a paused bot does not get the customer message forwarded', async () => {
  const skip = await __test.shouldSkipOpenBot(payload, {
    ...allowAll,
    findRow: async () => ({ instance_id: 'prestige', bot_enabled: false })
  });
  assert.equal(skip, true);
});

test('an enabled bot is still forwarded to', async () => {
  const skip = await __test.shouldSkipOpenBot(payload, {
    ...allowAll,
    findRow: async () => ({ instance_id: 'prestige', bot_enabled: true })
  });
  assert.equal(skip, false);
});

test('a row that predates the field is treated as enabled', async () => {
  assert.equal(await __test.isBotEnabled('prestige', { findRow: async () => ({ instance_id: 'prestige' }) }), true);
});

// Failing closed on an unreadable row would silence every tenant on a Redis blip.
test('an unreadable tenant row is treated as enabled, not as paused', async () => {
  assert.equal(await __test.isBotEnabled('prestige', { findRow: async () => { throw new Error('REDIS_UNAVAILABLE'); } }), true);
  assert.equal(await __test.isBotEnabled('prestige', { findRow: async () => null }), true);
});

// The flag survives a round trip through JSON storage and an operator form, so it
// can arrive as a string rather than a boolean.
test('the flag is read the same whether it is a boolean or a string', async () => {
  for (const value of [false, 'false', 'FALSE', '0', 'no', 'off']) {
    assert.equal(await __test.isBotEnabled('prestige', { findRow: async () => ({ bot_enabled: value }) }), false, String(value));
  }
  for (const value of [true, 'true', '1', 'yes', 'on']) {
    assert.equal(await __test.isBotEnabled('prestige', { findRow: async () => ({ bot_enabled: value }) }), true, String(value));
  }
});

test('the camelCase spelling is honoured too', async () => {
  assert.equal(await __test.isBotEnabled('prestige', { findRow: async () => ({ botEnabled: false }) }), false);
});

// Pausing the bot must not blind the operator inbox -- the chat store keeps
// recording, which is the whole point of pausing rather than unlinking.
test('a paused bot still has its incoming messages stored for the operator', async () => {
  const calls = [];
  const result = await __test.saveIncomingMessage(
    { ...payload, timestamp: 1785400000 },
    {
      store: {
        async appendMessageOnce(instanceId, phone, entry, options) {
          calls.push({ instanceId, phone, entry, options });
          return { ...entry, inserted: true, stale: false };
        }
      },
      publishEvent: async () => {},
      redisOpen: true,
      isPhoneAllowed: async () => true
    }
  );
  assert.equal(result.saved, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].entry.body, 'сәлем');
});
