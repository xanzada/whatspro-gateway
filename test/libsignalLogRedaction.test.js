const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('libsignal closed-session logging never serializes Signal key material', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'node_modules', 'libsignal', 'src', 'session_record.js'),
    'utf8'
  );
  assert.doesNotMatch(source, /console\.info\([^\n]*oldestSession/);
  assert.match(source, /console\.info\("Removing old closed Signal session"\)/);
});
