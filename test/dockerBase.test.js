const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('production image uses a Debian release with active package metadata', () => {
  const dockerfile = fs.readFileSync(path.join(__dirname, '..', 'Dockerfile'), 'utf8');
  assert.match(dockerfile, /^FROM node:22-bookworm-slim$/m);
  assert.doesNotMatch(dockerfile, /bullseye/i);
});
