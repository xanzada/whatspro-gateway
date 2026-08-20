const test = require('node:test');
const assert = require('node:assert/strict');
const { __test } = require('../services/incomingWebhook');

function fakeStore(currentState) {
  const calls = [];
  return {
    calls,
    async getState() { return currentState; },
    async appendMessageOnce(instanceId, phone, entry, options) {
      calls.push({ instanceId, phone, entry, options });
      return { ...entry, inserted: true, stale: false };
    }
  };
}

const base = { instanceId: 'prestige', phone: '77001234567', timestamp: 1785400000, body: 'salemet' };
const deps = (store) => ({ store, publishEvent: async () => {}, redisOpen: true });

test('a client reply in an operator-handled chat keeps the operator column', async () => {
  const store = fakeStore('operator');
  await __test.saveIncomingMessage({ ...base, messageId: 'op-1' }, deps(store));
  assert.equal(store.calls.length, 1);
  assert.equal(store.calls[0].options.state, undefined, 'state preserved: no bounce back to new');
});

test('a client reply in an archived chat keeps it archived', async () => {
  const store = fakeStore('archive');
  await __test.saveIncomingMessage({ ...base, messageId: 'ar-1' }, deps(store));
  assert.equal(store.calls[0].options.state, undefined);
});

test('a reply in an ordinary chat still lands in new', async () => {
  const store = fakeStore('all');
  await __test.saveIncomingMessage({ ...base, messageId: 'nw-1' }, deps(store));
  assert.equal(store.calls[0].options.state, 'new');
});

test('a store without getState keeps the legacy new behavior', async () => {
  const calls = [];
  const store = { calls, async appendMessageOnce(i, p, e, o) { calls.push(o); return { ...e, inserted: true }; } };
  await __test.saveIncomingMessage({ ...base, messageId: 'lg-1' }, deps(store));
  assert.equal(calls[0].state, 'new');
});
