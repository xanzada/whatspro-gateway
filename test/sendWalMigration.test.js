'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const filename = createHash('sha256').update('fixture-request').digest('hex') + '.json';
const fixture = Buffer.from(JSON.stringify({ phase: 'ambiguous', lease: { key: 'fixture' }, text: 'synthetic' }));
async function dirs(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wal-migration-fixture-'));
  const source = path.join(root, 'legacy');
  const target = path.join(root, 'auth', '.send-wal');
  await fs.mkdir(source);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, source, target };
}
test('WAL migration preserves records byte-for-byte and leaves every source intact', async t => {
  const { source, target } = await dirs(t);
  await fs.writeFile(path.join(source, filename), fixture);
  await fs.writeFile(path.join(source, 'unfinished.tmp'), 'retain source temporary');
  const { migrateSendWal } = require('../scripts/migrate-send-wal.cjs');
  const result = await migrateSendWal(source, target);
  assert.deepEqual(result, { copied: 1, alreadyPresent: 0, retainedOtherFiles: 1 });
  assert.deepEqual(await fs.readFile(path.join(target, filename)), fixture);
  assert.deepEqual(await fs.readFile(path.join(source, filename)), fixture);
  assert.equal(await fs.readFile(path.join(source, 'unfinished.tmp'), 'utf8'), 'retain source temporary');
  assert.equal((await fs.stat(path.join(target, filename))).mode & 0o777, 0o600);
  assert.equal((await fs.stat(target)).mode & 0o777, 0o700);
  assert.deepEqual(await migrateSendWal(source, target), { copied: 0, alreadyPresent: 1, retainedOtherFiles: 1 });
});
test('WAL migration refuses divergent destination records and retains both originals', async t => {
  const { source, target } = await dirs(t);
  await fs.mkdir(target, { recursive: true });
  await fs.writeFile(path.join(source, filename), fixture);
  await fs.writeFile(path.join(target, filename), 'different existing destination');
  const { migrateSendWal } = require('../scripts/migrate-send-wal.cjs');
  await assert.rejects(() => migrateSendWal(source, target), /SEND_WAL_MIGRATION_CONFLICT/);
  assert.deepEqual(await fs.readFile(path.join(source, filename)), fixture);
  assert.equal(await fs.readFile(path.join(target, filename), 'utf8'), 'different existing destination');
});
test('WAL migration rejects overlapping directories and symlinked records', async t => {
  const { root, source, target } = await dirs(t);
  const { migrateSendWal } = require('../scripts/migrate-send-wal.cjs');
  await assert.rejects(() => migrateSendWal(source, source), /DISTINCT_DIRECTORIES_REQUIRED/);
  await assert.rejects(() => migrateSendWal(source, path.join(source, 'nested')), /DISTINCT_DIRECTORIES_REQUIRED/);
  const outside = path.join(root, 'outside.json');
  await fs.writeFile(outside, fixture);
  await fs.symlink(outside, path.join(source, filename));
  await assert.rejects(() => migrateSendWal(source, target), /REGULAR_FILES_REQUIRED/);
  await assert.rejects(() => fs.readFile(path.join(target, filename)), error => error.code === 'ENOENT');
});

