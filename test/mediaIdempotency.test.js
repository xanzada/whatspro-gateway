'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fixture = require('./helpers/mediaApiFixture.cjs')('media-idempotency-runtime');

test('/api/send replays accepted text and media identities without a second transport attempt', async () => {
  for (const body of [{ text: 'synthetic text' }, fixture.media()]) {
    fixture.nextId();
    const before = fixture.sends;
    const first = await fixture.invoke(body);
    const retry = await fixture.invoke(body);
    assert.equal(first.status, 200); assert.equal(retry.status, 200);
    assert.equal(retry.response.replayed, true);
    assert.equal(retry.response.messageId, 'SYNTHETIC-MEDIA-ACK');
    assert.equal(fixture.sends, before + 1);
    assert.equal((await fixture.record()).phase, 'accepted');
    assert.equal('delivered' in retry.response, false, 'transport acceptance is not customer-device delivery');
  }
});

test('media validation precedes lease and WAL; both are durable before transport', async () => {
  const invalid = await fixture.invoke(fixture.media({ base64: '***' }));
  assert.equal(invalid.status, 400); assert.equal(fixture.sends, 0);
  assert.equal(fixture.values.has(fixture.key()), false);
  assert.equal(await fixture.hasRecord(), false);
  fixture.setOnSend(async () => {
    assert.equal(fixture.values.has(fixture.key()), true);
    const saved = await fixture.record();
    assert.equal(saved.kind, 'api_send'); assert.equal(saved.requestId, fixture.requestId);
    assert.notEqual(saved.phase, 'accepted', 'ACK cannot be stored before transport');
  });
  assert.equal((await fixture.invoke(fixture.media())).status, 200);
  assert.equal(fixture.sends, 1);
});

test('same requestId with changed media bytes, caption, filename or MIME is a conflict before send', async () => {
  for (const changed of [
    { base64: Buffer.from('different synthetic bytes').toString('base64') },
    { caption: 'different caption' }, { fileName: 'different.png' }, { mimeType: 'image/jpeg' }
  ]) {
    fixture.nextId();
    const before = fixture.sends;
    assert.equal((await fixture.invoke(fixture.media())).status, 200);
    const conflict = await fixture.invoke(fixture.media(changed));
    assert.equal(conflict.status, 409);
    assert.equal(conflict.response.error, 'IDEMPOTENCY_PAYLOAD_MISMATCH');
    assert.equal(fixture.sends, before + 1);
    assert.equal((await fixture.record()).phase, 'accepted');
  }
});
