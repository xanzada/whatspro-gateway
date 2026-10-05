'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fixture = require('./helpers/mediaApiFixture.cjs')('media-idempotency-uncertainty');

test('uncertain media ACK retains lease and durable journal; retries cannot duplicate media', async () => {
  fixture.setOutcome({ success: false, attempted: true, outcomeUnknown: true });
  const first = await fixture.invoke(fixture.media());
  const retry = await fixture.invoke(fixture.media());
  assert.equal(first.status, 409); assert.equal(retry.status, 409);
  assert.equal(first.response.error, 'SEND_OUTCOME_UNKNOWN');
  assert.equal(fixture.sends, 1);
  assert.equal(fixture.values.has(fixture.key()), true);
  const saved = await fixture.record();
  assert.equal(saved.phase, 'ambiguous');
  assert.equal('text' in saved, false); assert.equal('media' in saved, false);
});

test('media transport exception preserves uncertainty; only a proven unsent failure permits retry', async () => {
  const error = new Error('synthetic timeout'); error.sendAttempted = true;
  fixture.setOutcome(error);
  assert.equal((await fixture.invoke(fixture.media())).status, 409);
  assert.equal((await fixture.invoke(fixture.media())).status, 409);
  assert.equal(fixture.sends, 1);
  assert.equal((await fixture.record()).phase, 'ambiguous');
  fixture.nextId();
  fixture.setOutcome({ success: false, attempted: false });
  assert.equal((await fixture.invoke(fixture.media())).status, 503);
  assert.equal(await fixture.hasRecord(), false);
  assert.equal(fixture.values.has(fixture.key()), false);
  fixture.setOutcome({ success: true, ack: 1, messageId: 'SYNTHETIC-RECOVERY-ACK' });
  assert.equal((await fixture.invoke(fixture.media())).status, 200);
  assert.equal(fixture.sends, 3);
});
