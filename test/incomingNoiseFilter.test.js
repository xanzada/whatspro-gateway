const test = require('node:test');
const assert = require('node:assert/strict');
const { __test } = require('../services/incomingWebhook');

function fakeStore() {
  const calls = [];
  return {
    calls,
    async appendMessageOnce(instanceId, phone, entry, options) {
      calls.push({ instanceId, phone, entry, options });
      return { ...entry, inserted: true, stale: false };
    }
  };
}

const base = { instanceId: 'prestige', phone: '77001234567', timestamp: 1785400000 };
const deps = (store) => ({ store, publishEvent: async () => {}, redisOpen: true });

test('e2e notifications never create a chat entry', async () => {
  const store = fakeStore();
  const result = await __test.saveIncomingMessage(
    { ...base, type: 'e2e_notification', body: '', hasMedia: false }, deps(store));
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'non_conversational');
  assert.equal(store.calls.length, 0);
});

test('notification templates never create a chat entry', async () => {
  const store = fakeStore();
  const result = await __test.saveIncomingMessage(
    { ...base, type: 'notification_template', body: '', hasMedia: false }, deps(store));
  assert.equal(result.reason, 'non_conversational');
  assert.equal(store.calls.length, 0);
});

test('protocol messages never create a chat entry', async () => {
  const store = fakeStore();
  const result = await __test.saveIncomingMessage(
    { ...base, type: 'protocol_message', body: '', hasMedia: false }, deps(store));
  assert.equal(result.reason, 'non_conversational');
  assert.equal(store.calls.length, 0);
});

test('empty contentless events never create a chat entry', async () => {
  const store = fakeStore();
  const result = await __test.saveIncomingMessage(
    { ...base, type: 'chat', body: '', text: '', hasMedia: false }, deps(store));
  assert.equal(result.reason, 'non_conversational');
  assert.equal(store.calls.length, 0);
});

test('a real customer text still creates the chat entry', async () => {
  const store = fakeStore();
  const result = await __test.saveIncomingMessage(
    { ...base, type: 'chat', body: 'Сәлем, пицца бар ма?', hasMedia: false }, deps(store));
  assert.equal(result.saved, true);
  assert.equal(store.calls.length, 1);
  assert.equal(store.calls[0].options.state, 'new');
});

test('a real customer photo still creates the chat entry', async () => {
  const store = fakeStore();
  const result = await __test.saveIncomingMessage(
    { ...base, type: 'image', body: '', hasMedia: true, mediaType: 'image/jpeg', mediaData: 'QUJD' }, deps(store));
  assert.equal(result.saved, true);
  assert.equal(store.calls.length, 1);
});

test('outgoing operator/bot messages are never filtered', async () => {
  const store = fakeStore();
  const result = await __test.saveIncomingMessage(
    { ...base, type: 'chat', body: '', fromMe: true, hasMedia: false }, deps(store));
  assert.equal(result.saved, true);
  assert.equal(store.calls.length, 1);
  assert.equal(store.calls[0].options.state, undefined);
});

test('group and broadcast payloads stay rejected as before', async () => {
  const store = fakeStore();
  const result = await __test.saveIncomingMessage(
    { ...base, sender: '120363@g.us', type: 'chat', body: 'group text' }, deps(store));
  assert.equal(result.reason, 'missing_instance_or_phone');
  assert.equal(store.calls.length, 0);
});

test('the detector classifies every payload shape correctly', () => {
  const f = __test.isNonConversationalPayload;
  assert.equal(f({ type: 'e2e_notification' }), true);
  assert.equal(f({ type: 'protocol' }), true);
  assert.equal(f({ type: 'app_state_sync' }), true);
  assert.equal(f({ type: 'chat', body: 'сәлем' }), false);
  assert.equal(f({ type: 'image', hasMedia: true }), false);
  assert.equal(f({ type: 'chat', body: '', fromMe: true }), false);
  assert.equal(f({}), true);
});
