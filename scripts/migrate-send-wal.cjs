'use strict';
// Offline, explicit operator migration. Never sends, replays, or deletes a WAL record.
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

async function migrateSendWal(sourceInput, targetInput) {
  if (!path.isAbsolute(sourceInput || '') || !path.isAbsolute(targetInput || '')) throw new Error('ABSOLUTE_DIRECTORIES_REQUIRED');
  const source = path.resolve(sourceInput);
  const target = path.resolve(targetInput);
  if (source === target || target.startsWith(source + path.sep) || source.startsWith(target + path.sep)) throw new Error('DISTINCT_DIRECTORIES_REQUIRED');
  const sourceStat = await fs.lstat(source);
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) throw new Error('REGULAR_DIRECTORIES_REQUIRED');
  await fs.mkdir(target, { recursive: true, mode: 0o700 });
  const targetStat = await fs.lstat(target);
  if (!targetStat.isDirectory() || targetStat.isSymbolicLink()) throw new Error('REGULAR_DIRECTORIES_REQUIRED');
  const result = { copied: 0, alreadyPresent: 0, retainedOtherFiles: 0 };
  const records = [];
  // Check every existing record before copying any, so a conflict is never overwritten.
  for (const name of (await fs.readdir(source)).sort()) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) { result.retainedOtherFiles++; continue; }
    const origin = path.join(source, name);
    const destination = path.join(target, name);
    const stat = await fs.lstat(origin);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('REGULAR_FILES_REQUIRED');
    const data = await fs.readFile(origin);
    let existing = null;
    try {
      const targetRecordStat = await fs.lstat(destination);
      if (!targetRecordStat.isFile() || targetRecordStat.isSymbolicLink()) throw new Error('REGULAR_FILES_REQUIRED');
      existing = await fs.readFile(destination);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (existing !== null) {
      if (!data.equals(existing)) throw new Error('SEND_WAL_MIGRATION_CONFLICT');
      result.alreadyPresent++;
    } else records.push({ destination, data });
  }
  for (const { destination, data } of records) {
    const temporary = destination + '.migration-' + process.pid + '-' + randomUUID() + '.tmp';
    let handle;
    try {
      handle = await fs.open(temporary, 'wx', 0o600);
      await handle.writeFile(data);
      await handle.sync();
      await handle.close();
      handle = null;
      // A hard link publishes a complete fsynced record without replacing anything.
      await fs.link(temporary, destination);
      result.copied++;
    } finally {
      if (handle) await handle.close();
      await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }
  const directory = await fs.open(target, 'r');
  try { await directory.sync(); } finally { await directory.close(); }
  return result;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length !== 2) {
    console.error('Usage: node scripts/migrate-send-wal.cjs /absolute/legacy-wal /absolute/persistent-wal');
    process.exitCode = 1;
  } else {
    migrateSendWal(args[0], args[1]).then(result => console.log(JSON.stringify(result))).catch(error => {
      // Error codes only. No filenames, customer content, phones, or record dumps.
      const known = ['ABSOLUTE_DIRECTORIES_REQUIRED', 'DISTINCT_DIRECTORIES_REQUIRED', 'REGULAR_DIRECTORIES_REQUIRED', 'REGULAR_FILES_REQUIRED', 'SEND_WAL_MIGRATION_CONFLICT'];
      console.error(known.includes(error.message) ? error.message : 'SEND_WAL_MIGRATION_FAILED');
      process.exitCode = 1;
    });
  }
}
module.exports = { migrateSendWal };

