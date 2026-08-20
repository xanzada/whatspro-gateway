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

test('an inbound message from a linked-device LID files under the resolved real phone', async () => {
  // Live bug 2026-08-21: a chat keyed by the raw LID is a ghost whose history
  // never loads in the panel (BAD_PHONE). The persisted lid map resolves it
  // before anything is stored.
  const store = fakeStore('all');
  const depsWithMap = { ...deps(store), resolveLidPhone: async (id, value) => value === '224043110273161@lid' ? '77476884956' : '' };
  const result = await __test.saveIncomingMessage({ ...base, phone: '224043110273161@lid', messageId: 'lid-1' }, depsWithMap);
  assert.equal(result.saved, true);
  assert.equal(store.calls[0].phone, '77476884956');
});

test('an unmapped LID keeps its own identity instead of vanishing', async () => {
  const store = fakeStore('all');
  const depsNoMap = { ...deps(store), resolveLidPhone: async () => '' };
  const result = await __test.saveIncomingMessage({ ...base, phone: '224043110273161@lid', messageId: 'lid-2' }, depsNoMap);
  assert.equal(result.saved, true);
  assert.equal(store.calls[0].phone, '224043110273161@lid');
});
