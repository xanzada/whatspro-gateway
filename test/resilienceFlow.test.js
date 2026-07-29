'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { processIncomingRecord } = require('../services/incomingWebhook');
const { recordId } = require('../services/incomingWal');
const { __test: snapshotTest } = require('../services/tenantSnapshot');

test('Chat Redis failure does not block delivery to OpenBot', async () => {
  const record = {
    id: 'volatile:redis-down',
    payload: { instanceId: 'tenant-a', phone: '77000000001', messageId: 'm-1', text: 'hello' },
    pendingRedis: true,
    pendingOpenBot: true,
    attempts: 0
  };
  const result = await processIncomingRecord(record, {
    saveIncomingMessage: async () => ({ skipped: true, reason: 'redis_not_connected' }),
    shouldSkipOpenBot: async () => false,
    forwardToOpenBot: async () => ({ delivered: true, status: 200 })
  });
  assert.equal(result.pendingRedis, true);
  assert.equal(result.pendingOpenBot, false);
});

test('OpenBot failure does not lose the copy already saved for Chat', async () => {
  const record = {
    id: 'volatile:openbot-down',
    payload: { instanceId: 'tenant-a', phone: '77000000001', messageId: 'm-2', text: 'hello' },
    pendingRedis: true,
    pendingOpenBot: true,
    attempts: 0
  };
  const result = await processIncomingRecord(record, {
    saveIncomingMessage: async () => ({ saved: true }),
    shouldSkipOpenBot: async () => false,
    forwardToOpenBot: async () => { throw new Error('ECONNREFUSED'); }
  });
  assert.equal(result.pendingRedis, false);
  assert.equal(result.pendingOpenBot, true);
  assert.match(result.lastError, /ECONNREFUSED/);
});

test('inbound WAL identities are isolated by tenant instance', () => {
  const payload = { phone: '77000000001', messageId: 'same-message', text: 'hello' };
  assert.notEqual(
    recordId({ ...payload, instanceId: 'tenant-a' }),
    recordId({ ...payload, instanceId: 'tenant-b' })
  );
});

test('tenant snapshot rejects rows stored under another tenant key', () => {
  const safe = snapshotTest.safeRows({
    'tenant-a': { instance_id: 'tenant-a', brand: 'A' },
    'tenant-b': { instance_id: 'tenant-a', brand: 'cross-tenant' },
    '../escape': { instance_id: '../escape' }
  });
  assert.deepEqual(Object.keys(safe), ['tenant-a']);
});

test('production wiring starts retry workers and exposes dependency health', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  const incoming = fs.readFileSync(path.join(__dirname, '..', 'services', 'incomingWebhook.js'), 'utf8');
  assert.match(server, /await tenantStore\.listTenantRecords\(\)/);
  assert.match(server, /startIncomingWalWorker\(\)/);
  assert.match(server, /app\.get\('\/health\/detailed'/);
  assert.match(server, /const sessions = await Promise\.all\(/);
  assert.match(incoming, /pendingRedis/);
  assert.match(incoming, /pendingOpenBot/);
});
