'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { __test, rejectViaSocket } = require('../services/callWatcher');

// The watcher exists because a linked web session never receives a call offer.
// These cover the two decisions it makes on its own: which socket events are a
// live incoming call, and how it rejects one.

test('only a live incoming offer is treated as a call', () => {
  const { isIncomingOffer } = __test;

  assert.equal(isIncomingOffer({ id: 'a', from: '77001234567@s.whatsapp.net' }), true);
  assert.equal(isIncomingOffer({ id: 'a', status: 'offer' }), true);
  assert.equal(isIncomingOffer({ id: 'a', status: 'ringing' }), true);

  // The tail of a call already over would double-greet the caller.
  assert.equal(isIncomingOffer({ id: 'a', status: 'terminate' }), false);
  assert.equal(isIncomingOffer({ id: 'a', status: 'reject' }), false);
  assert.equal(isIncomingOffer({ id: 'a', status: 'accept' }), false);

  assert.equal(isIncomingOffer({ id: 'a', fromMe: true }), false);
  assert.equal(isIncomingOffer({ id: 'a', outgoing: true }), false);
  assert.equal(isIncomingOffer({ id: 'a', isGroup: true }), false);
  assert.equal(isIncomingOffer(null), false);
});

test('rejection goes over the socket that saw the offer, with both ids', async () => {
  const calls = [];
  const sock = { rejectCall: async (id, from) => { calls.push([id, from]); } };

  const ok = await rejectViaSocket(sock, { id: 'CALL-1', from: '77001234567@s.whatsapp.net' });

  assert.equal(ok, true);
  assert.deepEqual(calls, [['CALL-1', '77001234567@s.whatsapp.net']]);
});

test('an incomplete call or a socket without rejectCall reports failure rather than throwing', async () => {
  assert.equal(await rejectViaSocket(null, { id: 'a', from: 'b' }), false);
  assert.equal(await rejectViaSocket({}, { id: 'a', from: 'b' }), false);
  assert.equal(await rejectViaSocket({ rejectCall: async () => {} }, { id: 'a' }), false);
  assert.equal(await rejectViaSocket({ rejectCall: async () => {} }, { from: 'b' }), false);
});

test('reconnect backs off and stays bounded', () => {
  const { reconnectDelay } = __test;

  assert.equal(reconnectDelay(1), 2000);
  assert.equal(reconnectDelay(2), 4000);
  assert.equal(reconnectDelay(3), 8000);
  // A tenant whose phone stays off must not spin at full speed forever.
  assert.equal(reconnectDelay(50), 60000);
});
