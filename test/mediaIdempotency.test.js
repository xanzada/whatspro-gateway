'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFile } = require('fs/promises');

// C31 only. C32's claim was withdrawn after the existing suite refuted it: test mode with
// an empty allow-list is fail-closed BY DESIGN - the operator explicitly enabled test mode,
// which means "this restaurant is not ready for real guests". Letting every phone through
// when the list is empty would have let an unfinished bot message real guests.

const policy = require('../services/testModePolicy.js');
const read = (relative) => readFile(new URL(relative, `file://${__filename}`), 'utf8');

test('/api/send gives the media branch the same idempotency lease as text', async () => {
  const server = await read('../src/server.js');
  const mediaBranch = server.slice(
    server.indexOf('if (media) {'),
    server.indexOf("} else if (text) {")
  );
  // Before: the lease was text-only, so an HTTP timeout on Openbot's side - which retries
  // its own outbox - delivered the same photo or Kaspi receipt PDF to the guest twice.
  assert.match(mediaBranch, /if \(requestId\) \{/);
  assert.match(mediaBranch, /\.update\(`media:\$\{mimeType\}:\$\{fileName\}:\$\{caption\}:\`\)/);
  assert.match(mediaBranch, /IDEMPOTENCY_PAYLOAD_MISMATCH/);
  assert.match(mediaBranch, /REQUEST_IN_PROGRESS/);
  assert.match(mediaBranch, /await sendIdempotency\.release\(apiSendLease\)\.catch\(\(\) => \{\}\);/);
});

test('the lease is taken after validation and before the actual send', async () => {
  const server = await read('../src/server.js');
  const mediaBranch = server.slice(
    server.indexOf('if (media) {'),
    server.indexOf("} else if (text) {")
  );
  const validations = mediaBranch.lastIndexOf('return res.status(400)');
  const leaseTake = mediaBranch.indexOf('sendIdempotency.begin');
  const send = mediaBranch.indexOf('await sendMedia(instanceId');
  assert.ok(validations > 0 && leaseTake > validations && leaseTake < send,
    `expected validate -> lease -> send, got ${validations}/${leaseTake}/${send}`);
});

test('the hash covers everything that changes what the guest receives', async () => {
  const server = await read('../src/server.js');
  const mediaBranch = server.slice(
    server.indexOf('if (media) {'),
    server.indexOf("} else if (text) {")
  );
  // Same bytes but a different caption or filename IS a different message to the guest, so
  // a retry under those must be a conflict, not a silent replay of the first one.
  assert.match(mediaBranch, /media:\$\{mimeType\}:\$\{fileName\}:\$\{caption\}/);
  assert.match(mediaBranch, /\.update\(encoded\)/);
});
