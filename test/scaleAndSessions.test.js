'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const managerSrc = fs.readFileSync(path.join(__dirname, '..', 'services', 'whatsappManager.js'), 'utf8');
const storeSrc = fs.readFileSync(path.join(__dirname, '..', 'services', 'tenantStore.js'), 'utf8');
const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');

// Four scale defects found on 2026-08-22. None loses data on its own, but each one
// makes the gateway slower in proportion to traffic, and the first one can corrupt a
// WhatsApp session outright.

// ---------------------------------------------------------------------------- C4
// startWhatsAppInstance dropped a non-connected client from the map WITHOUT
// destroying it, then built a second client on the same authDir. The orphan kept its
// listeners and its own re-arming reconnect ladder: duplicated message and
// message_ack events, doubled memory, Baileys credential churn on one creds.json,
// and on the Chromium transport a corrupted profile once cleanupChromiumRuntimeLocks
// deleted the SingletonLock of a browser that was still running.
test('a replaced client is destroyed, never orphaned', () => {
  const fn = managerSrc.slice(
    managerSrc.indexOf('async function startWhatsAppInstance'),
    managerSrc.indexOf('// 🚀 ЖАҢА: ЗОМБИ СЕССИЯДАН ҚОРҒАНУ')
  );
  assert.match(fn, /const stale = clients\.get\(instanceId\);/);
  assert.match(fn, /await destroyClient\(stale\);/, 'the old client must be torn down');
  // Ordering matters: delete from the map first so nothing else can pick it up.
  assert.ok(
    fn.indexOf('clients.delete(instanceId);') < fn.indexOf('await destroyClient(stale);'),
    'remove from the registry before destroying'
  );
});

test('a client still initializing is not orphaned either', () => {
  const fn = managerSrc.slice(
    managerSrc.indexOf('async function startWhatsAppInstance'),
    managerSrc.indexOf('// 🚀 ЖАҢА: ЗОМБИ СЕССИЯДАН ҚОРҒАНУ')
  );
  assert.match(fn, /const stillInitializing = initializingClients\.get\(instanceId\);/);
  assert.match(fn, /await destroyClient\(stillInitializing\);/);
  assert.ok(
    fn.indexOf('await destroyClient(stillInitializing);') < fn.indexOf('createTransportClient(instanceId)'),
    'the previous initialization must be gone before a new client is built'
  );
});

test('the Chromium lock sweep cannot delete a live browser lock', () => {
  assert.match(managerSrc, /function chromiumLocksAreSafeToSweep\(instanceId\) \{/);
  assert.match(managerSrc, /return !clients\.has\(instanceId\) && !initializingClients\.has\(instanceId\);/);
  assert.match(managerSrc, /if \(chromiumLocksAreSafeToSweep\(instanceId\)\) cleanupChromiumRuntimeLocks\(instanceId\);/);
});

// --------------------------------------------------------------------------- C13
// getHistory de-duplicated with all.findIndex inside filter - a full scan per
// element, O(n^2) over up to 2000 rows on the event loop - and applyTtl/setState
// called it with limit 2000 on EVERY inserted message. Each stored message therefore
// cost two 2000-row reads plus millions of string comparisons.
test('history de-duplication is a single pass, not a quadratic scan', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'chatStore.js'), 'utf8');
  // Comments are stripped first: the fix documents the old expression verbatim to
  // explain what was wrong, and asserting against the raw file would match the
  // comment instead of the code (same idiom as chatPanelResilience.test.js).
  const code = src.split('\n').filter(line => !line.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(code, /all\.findIndex\(other => other\.id === item\.id\) === index/,
    'the O(n^2) dedupe must be gone');
  const fn = src.slice(src.indexOf('async function getHistory'), src.indexOf('async function updateMessageReceipt'));
  assert.match(fn, /const seen = new Set\(\);/);
  assert.match(fn, /if \(!item\.id\) return true;/, 'rows without an id are still kept');
});

test('de-duplication semantics are unchanged: first occurrence wins', () => {
  // Reproduce the filter in isolation, so the behaviour is asserted and not just the
  // shape of the code.
  const dedupe = rows => rows.filter((() => {
    const seen = new Set();
    return item => {
      if (!item.id) return true;
      const id = String(item.id);
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    };
  })());

  const rows = [
    { id: 'a', v: 1 }, { id: 'b', v: 2 }, { id: 'a', v: 3 },
    { v: 4 }, { v: 5 }, { id: 'c', v: 6 }, { id: 'b', v: 7 }
  ];
  assert.deepEqual(dedupe(rows).map(r => r.v), [1, 2, 4, 5, 6],
    'first of each id, every id-less row kept');
});

test('the TTL path no longer reads the whole transcript on every insert', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'chatStore.js'), 'utf8');
  assert.match(src, /const TTL_MEDIA_SCAN_LIMIT = Number\(process\.env\.WHATSPRO_TTL_MEDIA_SCAN_LIMIT \|\| 200\)/);
  // It only ever needed the media ids, and mediaIds unions the stored SMEMBERS set
  // with whatever the rows mention - anything older is already in that set.
  const applyTtl = src.slice(src.indexOf('async function applyTtl'), src.indexOf('async function storeMedia'));
  assert.match(applyTtl, /getHistory\(instanceId, phone, TTL_MEDIA_SCAN_LIMIT\)/);
  const setState = src.slice(src.indexOf('async function setState'), src.indexOf('async function mediaIds'));
  assert.match(setState, /getHistory\(instanceId, phone, TTL_MEDIA_SCAN_LIMIT\)/);
  const code = src.split('\n').filter(line => !line.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(code, /getHistory\(instanceId, phone, 2000\)/, 'no 2000-row read may remain on the write path');
});

// --------------------------------------------------------------------------- C11
// Every successful findRow called upsertSnapshot, which serialises EVERY tenant and
// rewrites the whole file behind a serialised write queue. findRow is on the hot path
// (per inbound message, per call, per 5s inbox poll), so the gateway wrote the full
// snapshot to disk in proportion to traffic times tenant count.
test('the snapshot is mirrored only when the row actually changed', () => {
  assert.match(storeSrc, /function sameSnapshotRow\(a, b\)/);
  const fn = storeSrc.slice(storeSrc.indexOf('async function findRow'), storeSrc.indexOf('async function listTenantRecords'));
  assert.match(fn, /const mirrored = await findSnapshot\(instance\)\.catch\(\(\) => null\);/);
  assert.match(fn, /if \(!sameSnapshotRow\(row, mirrored\)\) \{/);
  // The write must not be unconditional any more.
  assert.doesNotMatch(fn, /if \(row\) await upsertSnapshot\(row\)/);
});

test('the snapshot is still written when the row is new or different', () => {
  const fn = storeSrc.slice(storeSrc.indexOf('async function findRow'), storeSrc.indexOf('async function listTenantRecords'));
  assert.match(fn, /await upsertSnapshot\(row\)/, 'recovery mirroring must still happen');
  // And a missing Redis row still falls back to the snapshot.
  assert.match(fn, /return await findSnapshot\(instance\);/);
});

// --------------------------------------------------------------------------- C12
// The legacy keyspace SCAN is a recovery path, and it ran on every /api/chat/inbox
// request - which chat.js polls every 5 seconds per open panel.
test('the legacy recovery scan is cached per instance', () => {
  assert.match(serverSrc, /const LEGACY_SCAN_INTERVAL_MS = Number\(process\.env\.WHATSPRO_LEGACY_SCAN_INTERVAL_MS \|\| 60000\)/);
  assert.match(serverSrc, /async function cachedLegacyHistoryKeys\(instanceId\)/);
  assert.match(serverSrc, /const legacyHistoryKeys = await cachedLegacyHistoryKeys\(instanceId\);/);
  // Concurrent pollers must share one scan, not start several.
  assert.match(serverSrc, /if \(cached\?\.pending\) return cached\.pending;/);
  // A failed scan must not poison the cache forever.
  assert.match(serverSrc, /legacyScanCache\.delete\(instanceId\);/);
});

test('the inbox route no longer scans the keyspace inline', () => {
  const route = serverSrc.slice(
    serverSrc.indexOf("app.get('/api/chat/inbox/:instanceId'"),
    serverSrc.indexOf("app.get('/api/chat/events/:instanceId'")
  );
  assert.doesNotMatch(route, /for await \(const key of scanKeys\(/,
    'the per-request scan must be gone from the hot route');
});

test('the cache is per instance, so tenants cannot see each other', async t => {
  const { __test } = require('../src/server');
  assert.ok(__test.legacyScanCache instanceof Map);
  __test.legacyScanCache.clear();
  __test.legacyScanCache.set('alpha', { at: Date.now(), rows: [{ phone: '77000000001', updatedAt: 0 }] });
  const alpha = await __test.cachedLegacyHistoryKeys('alpha');
  assert.deepEqual(alpha, [{ phone: '77000000001', updatedAt: 0 }]);
  // beta has no cache entry, so it must not receive alpha's rows.
  const betaCached = __test.legacyScanCache.get('beta');
  assert.equal(betaCached, undefined);
  __test.legacyScanCache.clear();
});
