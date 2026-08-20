'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { createChatMediaHandler } = require('../services/chatMedia');

function fakeRes() {
  return {
    headers: {},
    statusCode: 0,
    body: null,
    set(name, value) { if (typeof name === 'string') { this.headers[name] = value; return this; } Object.assign(this.headers, name); return this; },
    status(code) { this.statusCode = code; return this; },
    send(b) { this.body = b; return this; },
    json(o) { this.jsonBody = o; return this; },
    sendFile() { return this; },
  };
}

test('a stored PDF is served inline without a viewer-blocking sandbox header', async () => {
  // A bare `Content-Security-Policy: sandbox` made browsers block their own
  // built-in PDF viewer, so the operator's receipt "would not open".
  const pdfBytes = Buffer.from('%PDF-1.4 fake minimal receipt pdf for the test %%EOF');
  const handler = createChatMediaHandler({
    readMedia: async () => 'data:application/pdf;base64,' + pdfBytes.toString('base64'),
  });
  const res = fakeRes();
  await handler({ params: { instanceId: 'prestige', messageId: 'm1' }, query: {} }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['Content-Type'], 'application/pdf');
  assert.match(String(res.headers['Content-Disposition']), /^inline/);
  assert.equal(res.headers['Content-Security-Policy'], undefined);
  assert.equal(res.headers['X-Content-Type-Options'], 'nosniff');
  assert.equal(Buffer.isBuffer(res.body), true);
  assert.equal(res.body.length, pdfBytes.length);
});

test('a missing media blob answers 404 MEDIA_NOT_READY with a retry hint', async () => {
  const handler = createChatMediaHandler({ readMedia: async () => '' });
  const res = fakeRes();
  await handler({ params: { instanceId: 'prestige', messageId: 'gone' }, query: {} }, res);
  assert.equal(res.statusCode, 404);
  assert.equal(res.jsonBody.error, 'MEDIA_NOT_READY');
  assert.equal(res.headers['Retry-After'], '3');
});
