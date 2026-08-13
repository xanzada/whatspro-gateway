'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createSosRevision, expectedSignature, verifyBridgeRequest } = require('../services/platformBridge');

const MASTER = 'test-chat-bridge-master-key-with-32-bytes';
const NOW = 1_785_000_000_000;
const TIMESTAMP = String(Math.floor(NOW / 1000));

function request(overrides = {}) {
  const base = {
    instanceId: 'prestige',
    headerInstance: 'prestige',
    requestId: 'req_12345678',
    timestamp: TIMESTAMP,
  };
  const input = { ...base, ...overrides };
  return {
    ...input,
    signature: overrides.signature || expectedSignature(MASTER, input.requestId, input.instanceId, input.timestamp),
  };
}

test('the Platform SOS bridge verifies the exact instance-scoped HMAC contract', () => {
  assert.equal(verifyBridgeRequest(request(), { masterKey: MASTER, nowMs: NOW }).ok, true);
  assert.equal(verifyBridgeRequest(request({ headerInstance: 'other' }), { masterKey: MASTER, nowMs: NOW }).error, 'INSTANCE_MISMATCH');
  assert.equal(verifyBridgeRequest(request({ signature: 'v1=' + '0'.repeat(64) }), { masterKey: MASTER, nowMs: NOW }).error, 'BAD_SIGNATURE');
  assert.equal(verifyBridgeRequest(request({ timestamp: String(Number(TIMESTAMP) - 301) }), { masterKey: MASTER, nowMs: NOW }).error, 'STALE_TIMESTAMP');
});

test('the bridge revision and count input include unread SOS only', () => {
  const rows = [
    { phone: '77015550101', sosUnread: true, sosSignalId: 'sig_1', sosCreatedAt: NOW - 1 },
    { phone: '77015550102', sosUnread: false, sosSignalId: 'sig_2', sosCreatedAt: NOW - 2 },
  ];
  assert.match(createSosRevision('prestige', rows), /^rev_[a-f0-9]{24}$/);
  assert.equal(
    createSosRevision('prestige', rows),
    createSosRevision('prestige', [rows[0]]),
    'acknowledged cases are excluded from the unread revision',
  );
});
