'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { __test: wa } = require('../services/whatsappManager');

const managerSource = fs.readFileSync(path.join(__dirname, '..', 'services', 'whatsappManager.js'), 'utf8');
const serverSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');

function sliceBetween(source, startNeedle, endNeedle) {
  const start = source.indexOf(startNeedle);
  const end = source.indexOf(endNeedle);
  assert.ok(start >= 0, 'missing ' + startNeedle);
  assert.ok(end > start, 'missing ' + endNeedle);
  return source.slice(start, end);
}

test('a stored session keeps reconnecting forever until the owner unlinks it', () => {
  const plan = wa.buildReconnectPlan('disconnected', {
    attempts: 99,
    maxRetries: 1,
    hasStoredSession: true
  });
  assert.deepEqual(plan, {
    shouldRetry: true,
    allowQrRequired: false,
    mode: 'session_restore'
  });
});

test('an explicit unlink still respects the fresh QR retry budget', () => {
  const exhausted = wa.buildReconnectPlan('LOGOUT', {
    attempts: 5,
    maxRetries: 5,
    hasStoredSession: false
  });
  assert.equal(exhausted.mode, 'fresh_qr');
  assert.equal(exhausted.shouldRetry, false);
});

test('session restore backoff never grows into a multi-minute stall', () => {
  let maxDelay = 0;
  for (let i = 0; i < 25; i += 1) {
    maxDelay = Math.max(maxDelay, wa.calculateRestartDelay('backoff-tenant', 3000, 'disconnected', { hasStoredSession: true }));
  }
  wa.resetRestartAttempts('backoff-tenant');
  assert.ok(maxDelay <= 61000, 'session restore delay grew to ' + maxDelay + 'ms');
});

test('repeated reconnect requests keep the earliest timer instead of re-arming it', () => {
  const instanceId = 'dedupe-tenant';
  wa.resetRestartAttempts(instanceId);
  wa.scheduleRestart(instanceId, 5000, 'disconnected');
  const first = wa.getRestartTimerInfo(instanceId);
  assert.ok(first, 'no restart timer was armed');

  for (let i = 0; i < 25; i += 1) {
    wa.scheduleRestart(instanceId, 5000, 'outgoing_text_waiting_for_client');
  }

  const latest = wa.getRestartTimerInfo(instanceId);
  assert.equal(latest.dueAt, first.dueAt, 'the pending reconnect was pushed into the future');
  assert.equal(wa.getRestartAttempts(instanceId), 1, 'duplicate requests inflated the backoff counter');

  wa.clearRestartTimer(instanceId);
  wa.resetRestartAttempts(instanceId);
});

test('expired queued text is purged even while the client is missing', async () => {
  const instanceId = 'queue-tenant';
  wa.clearPendingTextQueue(instanceId);
  wa.queueOutgoingText(instanceId, '77000000001', 'hello', 'client_missing');

  const queue = wa.getPendingTextQueue(instanceId);
  assert.equal(queue.length, 1);
  queue[0].createdAt = Date.now() - (60 * 60 * 1000);

  await wa.flushPendingOutgoingText(instanceId);
  assert.equal(wa.getPendingTextQueue(instanceId).length, 0, 'expired text kept the retry loop alive forever');

  wa.clearPendingTextQueue(instanceId);
  wa.clearRestartTimer(instanceId);
  wa.resetRestartAttempts(instanceId);
});

test('status polling is read only and never destroys credentials', () => {
  const status = sliceBetween(managerSource, 'async function getInstanceStatus', 'async function markBotSending');
  assert.doesNotMatch(status, /resetInvalidSession/);
  assert.doesNotMatch(status, /removeSessionFolder/);
});

test('the outgoing text queue never drives the restart scheduler', () => {
  const flush = sliceBetween(managerSource, 'async function flushPendingOutgoingText', 'async function sendWhatsAppText');
  assert.doesNotMatch(flush, /scheduleRestart/);
  assert.doesNotMatch(managerSource, /queued_text_waiting_for_client/);
  assert.doesNotMatch(managerSource, /queued_text_client_missing/);
});

test('a background supervisor keeps every registered session connected 24/7', () => {
  assert.match(managerSource, /function startSessionSupervisor/);
  assert.match(managerSource, /SESSION_SUPERVISOR_INTERVAL_MS/);
  assert.match(managerSource, /function reviveSupervisedInstances/);
  assert.match(serverSource, /startSessionSupervisor\(\)/);
});

test('a deploy restart preserves credentials so no QR rescan is needed', () => {
  const shutdown = sliceBetween(managerSource, 'async function shutdownWhatsAppClients', 'async function getInstanceStatus');
  assert.doesNotMatch(shutdown, /removeSessionFolder/);
  assert.doesNotMatch(shutdown, /\.logout\(/);
});
