'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

// Three ways an inbound customer message could be lost or duplicated, all found on
// 2026-08-22 by tracing WhatsApp -> WAL -> Redis -> Openbot end to end.

// ---------------------------------------------------------------------------- C3
// normalizePhone canonicalises a Kazakhstan number, but it used to return '' for
// every other country. whatsappManager.js then hit `if (!isValidChatPhone(...))
// return;` and dropped the message BEFORE the WAL, before the store, before
// Openbot, with no log line at all. A customer writing from +998 / +90 / +49 simply
// vanished: no inbox row, no bot reply, nothing to diagnose.
test('an international sender is kept instead of being silently dropped', () => {
  const { normalizePhone, isValidChatPhone } = require('../services/phoneUtils');

  // Uzbekistan, Turkey, Germany, Russia - all real neighbours of this business.
  assert.equal(normalizePhone('998901234567'), '998901234567');
  assert.equal(normalizePhone('+90 532 123 45 67'), '905321234567');
  assert.equal(normalizePhone('+49 151 23456789'), '4915123456789');

  // And whatever comes back must pass the gate that used to reject it, otherwise
  // the message is still discarded one line later.
  for (const raw of ['998901234567', '+90 532 123 45 67', '+49 151 23456789']) {
    assert.equal(isValidChatPhone(normalizePhone(raw)), true, `${raw} must survive the chat-phone gate`);
  }
});

test('Kazakhstan canonicalisation is unchanged, so existing Redis keys still match', () => {
  const { normalizePhone } = require('../services/phoneUtils');
  assert.equal(normalizePhone('8 (776) 915-61-84'), '77769156184');
  assert.equal(normalizePhone('+7 776 915 61 84'), '77769156184');
  assert.equal(normalizePhone('7769156184'), '77769156184');
  // Junk must still be rejected - the fix must not turn noise into a chat.
  assert.equal(normalizePhone('120363000000000@g.us'), '');
  assert.equal(normalizePhone('status@broadcast'), '');
  assert.equal(normalizePhone('abc'), '');
  assert.equal(normalizePhone('12345'), '', 'too short to be a phone');
  // A LID keeps its suffix (ghost-chat fix, 2026-08-21).
  assert.equal(normalizePhone('63037268607157@lid'), '63037268607157@lid');
});

test('the panel resolves a phone to the same identity the server filed it under', () => {
  const core = require('../public/chat-core.js');
  const { normalizePhone } = require('../services/phoneUtils');
  // If these two disagree the chat exists on the server but its history never
  // loads in the panel.
  for (const raw of ['8 (776) 915-61-84', '+7 776 915 61 84', '7769156184', '998901234567', '63037268607157@lid']) {
    assert.equal(core.normalizePhone(raw), normalizePhone(raw), `panel and server must agree on ${raw}`);
  }
});

test('the last drop point before the WAL is logged, never silent', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'services', 'whatsappManager.js'), 'utf8');
  const guard = source.slice(source.indexOf('if (!isValidChatPhone(cleanNumber))'), source.indexOf('if (!isValidChatPhone(cleanNumber))') + 600);
  assert.match(guard, /INBOUND DROP/, 'a discarded customer message must leave a trace');
});

// ------------------------------------------------------------------------ C6 / C9
// The WAL is the durability guarantee: disk intent is written before Redis and
// before Openbot. Two defects broke that guarantee at the two ends.

function withWalDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wal-test-'));
  const previous = process.env.WHATSPRO_INBOUND_WAL_DIR;
  process.env.WHATSPRO_INBOUND_WAL_DIR = dir;
  // The module reads the directory at require time.
  delete require.cache[require.resolve('../services/incomingWal')];
  const wal = require('../services/incomingWal');
  t.after(() => {
    if (previous === undefined) delete process.env.WHATSPRO_INBOUND_WAL_DIR;
    else process.env.WHATSPRO_INBOUND_WAL_DIR = previous;
    delete require.cache[require.resolve('../services/incomingWal')];
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { wal, dir };
}

const payload = (id = 'MSG-1') => ({
  instanceId: 'prestige',
  messageId: id,
  phone: '77769156184',
  timestamp: 1787323244,
  text: 'Сәлем, тапсырыс бергім келеді'
});

test('an undelivered record survives the age sweep instead of being destroyed', async t => {
  const { wal, dir } = withWalDir(t);

  const record = await wal.enqueueIncoming(payload('OLD-1'));
  assert.ok(record, 'a fresh message must be enqueued');
  assert.equal(record.pendingOpenBot, true);

  // Age it past the 7-day ceiling while it is still undelivered - exactly the
  // state a long Openbot or Redis outage produces.
  const file = wal.__test.walPath(record.id);
  const aged = JSON.parse(await fsp.readFile(file, 'utf8'));
  aged.createdAt = Date.now() - 30 * 24 * 60 * 60 * 1000;
  await fsp.writeFile(file, JSON.stringify(aged));

  const listed = await wal.__test.readAllIncoming();
  assert.equal(listed.length, 1, 'an undelivered customer message must never be deleted by the age sweep');
  assert.equal(listed[0].id, record.id);
  assert.ok(fs.existsSync(file), 'the record file must still be on disk');

  const summary = await wal.incomingWalSummary();
  assert.equal(summary.stuck, 1, 'a kept-but-aged record must be visible in the health summary');
});

test('a fully delivered record past the age ceiling is cleaned up', async t => {
  const { wal } = withWalDir(t);

  const record = await wal.enqueueIncoming(payload('OLD-2'));
  const file = wal.__test.walPath(record.id);
  const done = JSON.parse(await fsp.readFile(file, 'utf8'));
  done.createdAt = Date.now() - 30 * 24 * 60 * 60 * 1000;
  done.pendingRedis = false;
  done.pendingOpenBot = false;
  await fsp.writeFile(file, JSON.stringify(done));

  const listed = await wal.__test.readAllIncoming();
  assert.equal(listed.length, 0);
  assert.equal(fs.existsSync(file), false, 'nothing is pending, so the file may go');
});

test('the drain cap applies to the oldest records, not to readdir order', async t => {
  const previousMax = process.env.WHATSPRO_INBOUND_WAL_MAX;
  process.env.WHATSPRO_INBOUND_WAL_MAX = '100';
  t.after(() => {
    if (previousMax === undefined) delete process.env.WHATSPRO_INBOUND_WAL_MAX;
    else process.env.WHATSPRO_INBOUND_WAL_MAX = previousMax;
  });
  const { wal } = withWalDir(t);

  const ids = [];
  for (let index = 0; index < 6; index += 1) {
    const record = await wal.enqueueIncoming(payload(`ORDER-${index}`));
    const file = wal.__test.walPath(record.id);
    const stored = JSON.parse(await fsp.readFile(file, 'utf8'));
    // Deliberately out of creation order on disk.
    stored.createdAt = 1_000_000 + (6 - index) * 1000;
    await fsp.writeFile(file, JSON.stringify(stored));
    ids.push({ id: record.id, createdAt: stored.createdAt });
  }

  const listed = await wal.__test.readAllIncoming();
  const order = listed.map(record => Number(record.createdAt));
  assert.deepEqual(order, [...order].sort((a, b) => a - b), 'records must be ordered oldest first');
});

test('a re-delivered message is not forwarded to Openbot twice', async t => {
  const { wal } = withWalDir(t);

  const first = await wal.enqueueIncoming(payload('DUP-1'));
  assert.ok(first);

  // Both legs complete - this is what processIncomingRecord does on success.
  first.pendingRedis = false;
  first.pendingOpenBot = false;
  const finished = await wal.updateIncoming(first);
  assert.equal(finished, null, 'a completed record leaves the pending set');
  assert.equal(fs.existsSync(wal.__test.walPath(first.id)), false);
  assert.equal(await wal.__test.hasTombstone(first.id), true, 'completion must be remembered');

  // WhatsApp replays messages.upsert after a reconnect. The record id is
  // content-addressed, so this is byte-for-byte the same message.
  const replay = await wal.enqueueIncoming(payload('DUP-1'));
  assert.equal(replay, null, 'a replay of a completed message must not become new work');
  assert.equal(fs.existsSync(wal.__test.walPath(first.id)), false, 'no new WAL entry may appear');
});

test('a different message from the same customer is still accepted', async t => {
  const { wal } = withWalDir(t);
  const first = await wal.enqueueIncoming(payload('SEQ-1'));
  first.pendingRedis = false;
  first.pendingOpenBot = false;
  await wal.updateIncoming(first);

  const second = await wal.enqueueIncoming(payload('SEQ-2'));
  assert.ok(second, 'the tombstone is per message, not per customer');
  assert.notEqual(second.id, first.id);
});

test('the tombstone expires, so the WAL directory cannot grow forever', async t => {
  const { wal } = withWalDir(t);
  const record = await wal.enqueueIncoming(payload('TTL-1'));
  record.pendingRedis = false;
  record.pendingOpenBot = false;
  await wal.updateIncoming(record);

  const tombstone = wal.__test.tombstonePath(record.id);
  assert.ok(fs.existsSync(tombstone));
  await fsp.writeFile(tombstone, JSON.stringify({ id: record.id, doneAt: Date.now() - 40 * 24 * 60 * 60 * 1000 }));

  assert.equal(await wal.__test.hasTombstone(record.id), false, 'an expired tombstone stops blocking');
  await wal.__test.readAllIncoming();
  assert.equal(fs.existsSync(tombstone), false, 'and the sweep removes it');
});

test('the webhook reports an already-delivered replay instead of forwarding it', async t => {
  const { wal } = withWalDir(t);
  delete require.cache[require.resolve('../services/incomingWebhook')];
  const webhook = require('../services/incomingWebhook');
  t.after(() => { delete require.cache[require.resolve('../services/incomingWebhook')]; });

  const record = await wal.enqueueIncoming(payload('WH-1'));
  record.pendingRedis = false;
  record.pendingOpenBot = false;
  await wal.updateIncoming(record);

  const result = await webhook.forwardIncomingWhatsAppMessage(payload('WH-1'));
  assert.equal(result.openbot.status, 'skipped');
  assert.equal(result.openbot.reason, 'already_delivered');
  assert.equal(result.durable, true);
});
