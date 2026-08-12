'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { purgeTenantRedisKeys, collectTenantKeys, keyFamily, PROTECTED_KEYS } = require('../services/tenantPurge');

// A tenant leaves keys in both apps' namespaces because both share this Redis.
// This is the real shape of what a deleted restaurant leaves behind, taken from
// the live keyspace: some carry a TTL and would drain, some never expire.
const LIVE_SHAPED_KEYS = [
  'history:doomed:77015550101',
  'chatwoot:inbox:doomed',
  'chatwoot:viewed:doomed:77015550101',
  'chatwoot:send-idempotency:doomed:abc',
  'whatspro:tenant-memory:v1:doomed',
  'menu_context:v2:doomed:kk',
  'menu_context_backup:v2:doomed:kk',
  'runtime_status:doomed',
  'kanban_lock:doomed:5f2c:status',
  'shift_note:doomed:note-1',
  'operator_case_active:doomed:77015550101',
  'config:doomed',
  'mute:doomed:77015550101',
  // A neighbour tenant and the registries, none of which may be touched.
  'history:prestige:77769156184',
  'runtime_status:prestige',
  'whatspro:tenants:v1',
  'whatspro:instances',
  'whatspro:alemi-instance-owner:v1',
  'whatspro:shared-prompt',
];

function fakeRedis(keys = LIVE_SHAPED_KEYS) {
  const store = new Set(keys);
  return {
    isOpen: true,
    deleted: [],
    delCalls: 0,
    // Batched, like node-redis 6: one SCAN round yields an array of keys.
    async *scanIterator({ MATCH }) {
      const expression = new RegExp(`^${String(MATCH).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
      const matched = [...store].filter(key => expression.test(key));
      for (let at = 0; at < matched.length; at += 3) yield matched.slice(at, at + 3);
    },
    async del(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      this.delCalls += 1;
      let removed = 0;
      for (const key of list) {
        if (store.delete(key)) { this.deleted.push(key); removed += 1; }
      }
      return removed;
    },
    has(key) { return store.has(key); },
    size() { return store.size; },
  };
}

test('every key the deleted tenant owns is found, whatever segment its id sits in', async () => {
  const found = await collectTenantKeys(fakeRedis(), 'doomed');

  assert.ok(found.includes('runtime_status:doomed'), 'id as the last segment');
  assert.ok(found.includes('history:doomed:77015550101'), 'id in the middle');
  assert.ok(found.includes('menu_context:v2:doomed:kk'), 'a schema segment before the id');
  assert.ok(found.includes('chatwoot:send-idempotency:doomed:abc'), 'a two-word family before the id');
  assert.ok(found.includes('whatspro:tenant-memory:v1:doomed'), "the gateway's own namespace");
  assert.equal(found.length, 13);
});

test('a neighbour tenant and the registries survive the purge', async () => {
  const redis = fakeRedis();
  await purgeTenantRedisKeys(redis, 'doomed');

  assert.ok(redis.has('history:prestige:77769156184'), 'another restaurant keeps its chat history');
  assert.ok(redis.has('runtime_status:prestige'));
  for (const key of PROTECTED_KEYS) {
    if (key === 'whatspro:scan-requests') continue;
    assert.ok(redis.has(key), `${key} must survive`);
  }
});

test('the keys that never expire are the ones actually removed', async () => {
  const redis = fakeRedis();
  const summary = await purgeTenantRedisKeys(redis, 'doomed');

  assert.equal(summary.deleted, 13);
  for (const key of ['chatwoot:inbox:doomed', 'whatspro:tenant-memory:v1:doomed', 'chatwoot:viewed:doomed:77015550101']) {
    assert.ok(!redis.has(key), `${key} would otherwise sit in Redis forever`);
  }
});

test('the summary reports families, not customer identifiers', async () => {
  const summary = await purgeTenantRedisKeys(fakeRedis(), 'doomed', { dryRun: true });

  assert.equal(summary.families['history'], 1);
  assert.equal(summary.families['menu_context:v2'], 1);
  assert.equal(summary.families['chatwoot:viewed'], 1);
  const reported = Object.keys(summary.families).join(' ');
  assert.doesNotMatch(reported, /77015550101|note-1|5f2c/, 'a family name carries no phone, note or order id');
});

test('a dry run reports what it would delete and deletes nothing', async () => {
  const redis = fakeRedis();
  const summary = await purgeTenantRedisKeys(redis, 'doomed', { dryRun: true });

  assert.equal(summary.keys, 13);
  assert.equal(summary.deleted, 0);
  assert.equal(redis.deleted.length, 0);
  assert.equal(redis.size(), LIVE_SHAPED_KEYS.length);
});

test('an id that is a prefix of a live tenant does not take that tenant with it', async () => {
  const redis = fakeRedis(['runtime_status:prest', 'runtime_status:prestige', 'history:prestige:777']);
  await purgeTenantRedisKeys(redis, 'prest');

  assert.ok(!redis.has('runtime_status:prest'));
  assert.ok(redis.has('runtime_status:prestige'), 'prestige is not prest');
  assert.ok(redis.has('history:prestige:777'));
});

test('a closed or missing Redis is reported, not thrown through', async () => {
  assert.equal((await purgeTenantRedisKeys({ isOpen: false }, 'doomed')).deleted, 0);
  assert.equal((await purgeTenantRedisKeys(null, 'doomed')).deleted, 0);
  assert.equal((await purgeTenantRedisKeys(fakeRedis(), '  ')).deleted, 0);
});

test('deletion is batched so a large tenant is not one enormous DEL', async () => {
  const keys = Array.from({ length: 450 }, (_, index) => `history:doomed:7701555${String(index).padStart(4, '0')}`);
  const redis = fakeRedis(keys);
  const summary = await purgeTenantRedisKeys(redis, 'doomed');

  assert.equal(summary.deleted, 450);
  assert.equal(redis.size(), 0);
  assert.equal(redis.delCalls, 3, '200 per batch');
});

test('keyFamily stops at the instance id', () => {
  assert.equal(keyFamily('history:doomed:7701', 'doomed'), 'history');
  assert.equal(keyFamily('menu_context:v2:doomed:kk', 'doomed'), 'menu_context:v2');
  assert.equal(keyFamily('runtime_status:doomed', 'doomed'), 'runtime_status');
});
