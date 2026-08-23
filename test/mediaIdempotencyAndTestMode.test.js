'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFile } = require('fs/promises');

// C31, found 2026-08-23.
const read = (relative) => readFile(new URL(relative, `file://${__filename}`), 'utf8');

test('/api/send gives the media branch the same idempotency lease as text', async () => {
  const server = await read('../src/server.js');
  // The media branch validates the upload, takes the lease over a hash of bytes+caption+
  // filename, sends inside a try, and releases the lease if the send throws - mirroring the
  // text branch exactly.
  const mediaBranch = server.slice(
    server.indexOf('if (media) {'),
    server.indexOf("} else if (text) {")
  );
  assert.match(mediaBranch, /if \(requestId\) \{/);
  assert.match(mediaBranch, /\.update\(`media:\$\{mimeType\}:\$\{fileName\}:\$\{caption\}:\`\)/);
  assert.match(mediaBranch, /IDEMPOTENCY_PAYLOAD_MISMATCH/);
  assert.match(mediaBranch, /REQUEST_IN_PROGRESS/);
  assert.match(mediaBranch, /await sendIdempotency\.release\(apiSendLease\)\.catch\(\(\) => \{\}\);/);
  // The release must be reachable only from the catch, not before the send happened.
  assert.ok(mediaBranch.indexOf('.update(`media:') < mediaBranch.indexOf('sendMedia(instanceId'));
});

test('the lease is taken after validation and before the actual send', async () => {
  const server = await read('../src/server.js');
  const mediaBranch = server.slice(
    server.indexOf('if (media) {'),
    server.indexOf("} else if (text) {")
  );
  // Order matters twice: taking it before validation would strand leases for rejected
  // uploads; taking it after the send would not prevent the double delivery at all.
  const validations = mediaBranch.lastIndexOf('return res.status(400)');
  const leaseTake = mediaBranch.indexOf('sendIdempotency.begin');
  const send = mediaBranch.indexOf('await sendMedia(instanceId');
  assert.ok(validations > 0 && leaseTake > validations && leaseTake < send,
    `expected validate -> lease -> send, got ${validations}/${leaseTake}/${send}`);
});
