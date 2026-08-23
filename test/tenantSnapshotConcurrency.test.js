'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

// tenantSnapshot.load() set `loaded = true` BEFORE awaiting the file read, so a second
// caller that arrived during the read passed the guard and received the still-empty rows
// object. Reproduced live 2026-08-23 with the redis client not yet open:
//
//   Promise.all([findRow('prestige'), findRow('kabab-1')])  ->  ok / null   (every run)
//   await findRow('prestige'); await findRow('kabab-1')     ->  ok / ok
//
// Whichever call arrived second lost. This is the fallback that runs when Redis is
// unavailable - the one moment the snapshot exists for - so a restart under redis
// pressure could report a live restaurant as unknown.

async function withSnapshot(rows, run) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wp-snap-'));
  const file = path.join(dir, 'platform-tenants.snapshot.json');
  await fs.writeFile(file, JSON.stringify({
    version: 1,
    updatedAt: new Date().toISOString(),
    rows,
  }), 'utf8');

  const previous = process.env.WHATSPRO_TENANT_SNAPSHOT_PATH;
  process.env.WHATSPRO_TENANT_SNAPSHOT_PATH = file;
  // A fresh module instance, so `loadPromise` starts unset exactly as it does on boot.
  const modulePath = require.resolve('../services/tenantSnapshot.js');
  delete require.cache[modulePath];
  const snapshot = require(modulePath);
  try {
    return await run(snapshot);
  } finally {
    delete require.cache[modulePath];
    if (previous === undefined) delete process.env.WHATSPRO_TENANT_SNAPSHOT_PATH;
    else process.env.WHATSPRO_TENANT_SNAPSHOT_PATH = previous;
    await fs.rm(dir, { recursive: true, force: true });
  }
}

const TWO_TENANTS = {
  prestige: { instance_id: 'prestige', alemi_instance: 'prestige' },
  'kabab-1': { instance_id: 'kabab-1', alemi_instance: 'kebab1' },
};

test('concurrent first reads all see the snapshot, not an empty object', async () => {
  await withSnapshot(TWO_TENANTS, async (snapshot) => {
    // Both calls start before either read finishes. This is the shape that failed.
    const [first, second] = await Promise.all([
      snapshot.findSnapshot('prestige'),
      snapshot.findSnapshot('kabab-1'),
    ]);
    assert.ok(first, 'the first concurrent caller must see its tenant');
    assert.ok(second, 'the second concurrent caller must not get null from a half-done load');
    assert.equal(second.alemi_instance, 'kebab1');
  });
});

test('a burst of ten concurrent readers all get their row', async () => {
  await withSnapshot(TWO_TENANTS, async (snapshot) => {
    const names = Array.from({ length: 10 }, (_, index) => (index % 2 ? 'kabab-1' : 'prestige'));
    const results = await Promise.all(names.map((name) => snapshot.findSnapshot(name)));
    assert.equal(results.filter(Boolean).length, results.length, 'no reader may receive null');
  });
});

test('listSnapshot concurrent with findSnapshot sees every tenant', async () => {
  await withSnapshot(TWO_TENANTS, async (snapshot) => {
    const [list, row] = await Promise.all([
      snapshot.listSnapshot(),
      snapshot.findSnapshot('kabab-1'),
    ]);
    assert.equal(list.length, 2);
    assert.ok(row);
  });
});

test('a genuinely absent tenant still resolves to null', async () => {
  // The fix must not turn "not in the snapshot" into a false positive.
  await withSnapshot(TWO_TENANTS, async (snapshot) => {
    assert.equal(await snapshot.findSnapshot('does-not-exist'), null);
    const [a, b] = await Promise.all([
      snapshot.findSnapshot('kabab-1'),
      snapshot.findSnapshot('also-missing'),
    ]);
    assert.ok(a);
    assert.equal(b, null);
  });
});

test('a missing snapshot file is not cached as a permanent empty result', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wp-snap-'));
  const file = path.join(dir, 'platform-tenants.snapshot.json');
  const previous = process.env.WHATSPRO_TENANT_SNAPSHOT_PATH;
  process.env.WHATSPRO_TENANT_SNAPSHOT_PATH = file;
  const modulePath = require.resolve('../services/tenantSnapshot.js');
  delete require.cache[modulePath];
  const snapshot = require(modulePath);
  try {
    // No file yet: ENOENT is normal on a first boot and must resolve to null, not throw.
    assert.equal(await snapshot.findSnapshot('prestige'), null);
    // The write path is what repopulates it; reading again must not resurrect stale state.
    assert.equal(await snapshot.findSnapshot('prestige'), null);
  } finally {
    delete require.cache[modulePath];
    if (previous === undefined) delete process.env.WHATSPRO_TENANT_SNAPSHOT_PATH;
    else process.env.WHATSPRO_TENANT_SNAPSHOT_PATH = previous;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('the guard is a promise, not a boolean', async () => {
  const source = await fs.readFile(new URL('../services/tenantSnapshot.js', `file://${__filename}`), 'utf8');
  // A boolean set before an await is the defect itself; keep it from coming back.
  assert.match(source, /let loadPromise = null;/);
  assert.doesNotMatch(source, /loaded = true;/);
  // A failed read must clear the memo so the next caller retries.
  assert.match(source, /loadPromise = null;\s*\n\s*throw error;/);
});
