'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const tenantStore = require('../services/tenantStore');
const tenantAdmin = require('../services/tenantAdmin');

// Deleting a restaurant has to take three things with it: its row, its WhatsApp
// pairing and its cache. The pairing is the delicate one — it is deliberately
// kept across restarts and deploys, so the only thing that may ever remove it is
// its tenant going away. These tests pin the ordering and the failure handling,
// because a half-finished delete that drops the row first would leave a session
// still answering WhatsApp for a restaurant that no longer exists.
function stubStore(row = { instanceId: 'doomed', brand: 'Doomed' }) {
  const original = { findRow: tenantStore.findRow, deleteRow: tenantStore.deleteRow };
  const calls = [];
  tenantStore.findRow = async () => row;
  tenantStore.deleteRow = async instanceId => { calls.push(`deleteRow:${instanceId}`); return true; };
  return {
    calls,
    restore() { Object.assign(tenantStore, original); },
  };
}

function deps(calls, overrides = {}) {
  return {
    whatsappManager: {
      async stopWhatsAppInstance(instanceId) {
        calls.push(`stop:${instanceId}`);
        if (overrides.stopFails) throw new Error('CLIENT_BUSY');
      },
    },
    tenantPurge: {
      async purgeTenantRedisKeys(redis, instanceId) {
        calls.push(`purge:${instanceId}`);
        if (overrides.purgeFails) throw new Error('REDIS_TIMEOUT');
        return { instance: instanceId, keys: 13, deleted: 13, families: { history: 1, 'chatwoot:inbox': 1 } };
      },
    },
    redisClient: { isOpen: true },
  };
}

test('deleting a restaurant clears its session and its cache, and drops the row last', async () => {
  const store = stubStore();
  try {
    const result = await tenantAdmin.deleteTenant('doomed', deps(store.calls));

    assert.deepEqual(store.calls, ['stop:doomed', 'purge:doomed', 'deleteRow:doomed'],
      'the row is the last thing to go, so a failure never orphans a live session');
    assert.equal(result.deleted, true);
    assert.equal(result.sessionCleared, true);
    assert.equal(result.cacheKeysDeleted, 13);
    assert.deepEqual(result.failures, []);
  } finally {
    store.restore();
  }
});

test('a session that will not stop is reported but does not keep the tenant alive', async () => {
  const store = stubStore();
  try {
    const result = await tenantAdmin.deleteTenant('doomed', deps(store.calls, { stopFails: true }));

    assert.ok(store.calls.includes('deleteRow:doomed'), 'the operator asked for a delete and gets one');
    assert.equal(result.sessionCleared, false);
    assert.deepEqual(result.failures, ['session:CLIENT_BUSY'],
      'silently swallowing this would leave WhatsApp credentials nobody knows about');
    assert.equal(result.cacheKeysDeleted, 13, 'the cache is still purged');
  } finally {
    store.restore();
  }
});

test('a Redis that cannot be purged is reported, not hidden', async () => {
  const store = stubStore();
  try {
    const result = await tenantAdmin.deleteTenant('doomed', deps(store.calls, { purgeFails: true }));

    assert.ok(store.calls.includes('deleteRow:doomed'));
    assert.equal(result.sessionCleared, true);
    assert.equal(result.cacheKeysDeleted, 0);
    assert.deepEqual(result.failures, ['cache:REDIS_TIMEOUT']);
  } finally {
    store.restore();
  }
});

test('an unknown restaurant is a 404 and touches nothing', async () => {
  const store = stubStore(null);
  try {
    await assert.rejects(
      () => tenantAdmin.deleteTenant('never-existed', deps(store.calls)),
      error => error.message === 'TENANT_NOT_FOUND' && error.statusCode === 404,
    );
    assert.deepEqual(store.calls, [], 'no session stop, no purge, no row delete');
  } finally {
    store.restore();
  }
});
