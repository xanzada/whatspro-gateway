const test = require('node:test');
const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const path = require('node:path');

const { __test: whatsappTest } = require('../services/whatsappManager');

test('a stored session restore is retried indefinitely, never abandoned', () => {
  assert.deepEqual(
    whatsappTest.buildReconnectPlan('init_failed', {
      attempts: 0,
      maxRetries: 2,
      hasStoredSession: true
    }),
    {
      shouldRetry: true,
      allowQrRequired: false,
      mode: 'session_restore'
    }
  );
  // Abandoning a restore left a paired tenant offline until someone noticed.
  // Credentials are only invalidated by an owner unlink or a tenant deletion,
  // so the restore keeps retrying for as long as they exist.
  assert.equal(
    whatsappTest.buildReconnectPlan('init_failed', {
      attempts: 2,
      maxRetries: 2,
      hasStoredSession: true
    }).shouldRetry,
    true
  );
});

test('logout and QR startup timeout automatically start a fresh QR lifecycle', () => {
  for (const reason of ['LOGOUT', 'UNPAIRED', 'qr_start_timeout']) {
    assert.deepEqual(
      whatsappTest.buildReconnectPlan(reason, {
        attempts: 0,
        maxRetries: 1,
        hasStoredSession: false
      }),
      {
        shouldRetry: true,
        allowQrRequired: true,
        mode: 'fresh_qr'
      },
      reason
    );
  }
});

test('runtime lifecycle handlers use the reconnect policy', async () => {
  const source = await readFile(path.join(__dirname, '..', 'services', 'whatsappManager.js'), 'utf8');
  assert.match(source, /buildReconnectPlan\('qr_start_timeout'/);
  assert.match(source, /buildReconnectPlan\(reasonText/);
  assert.match(source, /buildReconnectPlan\('init_failed'/);
});

test('a slow persisted-session restore is retried without deleting credentials', async () => {
  const source = await readFile(path.join(__dirname, '..', 'services', 'whatsappManager.js'), 'utf8');
  assert.match(source, /buildReconnectPlan\('restore_timeout'/);
  assert.doesNotMatch(source, /resetInvalidSession\(instanceId, client, 'restore_timeout'/);
});
