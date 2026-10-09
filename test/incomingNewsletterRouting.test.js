'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const syncFs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');

const fixtureRoot = syncFs.mkdtempSync(path.join(os.tmpdir(), 'newsletter-routing-'));
process.env.WHATSAPP_AUTH_PATH = path.join(fixtureRoot, 'auth');
process.env.WHATSPRO_TRANSPORT = 'baileys';
process.env.WHATSPRO_TEST_MODE_ENABLED = 'false';
const customerPhone = '70000000123';
const customerJid = customerPhone + '@c.us';
const newsletterJid = '120363000000000999@newsletter';
const legacyPhone = '120363000000000';
const phoneUtils = require('../services/phoneUtils');
const axios = require('axios');
const managerFilename = require.resolve('../services/whatsappManager');
const walFilename = require.resolve('../services/incomingWal');
const incomingFilename = require.resolve('../services/incomingWebhook');
let forwarded, normalizations, contactLookups, sequence = 0;
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (parent?.filename === managerFilename && request === './incomingWebhook') {
    return { forwardIncomingWhatsAppMessage: async payload => {
      forwarded.push(payload);
      return { durable: true };
    } };
  }
  if (parent?.filename === managerFilename && request === './phoneUtils') {
    return { ...phoneUtils, normalizePhoneFromCandidates: (...args) => {
      normalizations++;
      return phoneUtils.normalizePhoneFromCandidates(...args);
    } };
  }
  return originalLoad.call(this, request, parent, isMain);
};
let manager;
try { manager = require('../services/whatsappManager'); }
finally { Module._load = originalLoad; }
const { BaileysClient } = require('../services/baileysClient');
const { redisClient } = require('../config/redis');

test.after(async () => { await fs.rm(fixtureRoot, { recursive: true, force: true }); });

function quiet(t) {
  for (const method of ['log', 'warn', 'error']) t.mock.method(console, method, () => {});
}
function customerPayload(id, extra = {}) {
  return {
    instanceId: 'newsletter-fixture', messageId: id, sender: customerJid,
    normalizedPhone: customerPhone, senderPhone: customerPhone, body: 'synthetic customer content',
    type: 'chat', hasMedia: false, timestamp: Date.now(),
    data: { key: { remoteJid: customerJid }, contact: { id: customerJid } },
    ...extra
  };
}
async function walFixture(t) {
  const dir = await fs.mkdtemp(path.join(fixtureRoot, 'wal-'));
  const previous = process.env.WHATSPRO_INBOUND_WAL_DIR;
  const previousWebhook = process.env.OPENBOT_WEBHOOK_URL;
  process.env.OPENBOT_WEBHOOK_URL = 'https://fixture.invalid/webhook';
  process.env.WHATSPRO_INBOUND_WAL_DIR = dir;
  delete require.cache[walFilename]; delete require.cache[incomingFilename];
  const wal = require(walFilename), incoming = require(incomingFilename);
  t.after(() => {
    delete require.cache[walFilename]; delete require.cache[incomingFilename];
    if (previous === undefined) delete process.env.WHATSPRO_INBOUND_WAL_DIR;
    else process.env.WHATSPRO_INBOUND_WAL_DIR = previous;
    if (previousWebhook === undefined) delete process.env.OPENBOT_WEBHOOK_URL;
    else process.env.OPENBOT_WEBHOOK_URL = previousWebhook;
  });
  return { dir, wal, incoming };
}
async function callbackFixture(t) {
  quiet(t);
  forwarded = []; normalizations = 0; contactLookups = 0;
  const instance = 'newsletter-callback-' + (++sequence);
  let sends = 0, calls = 0;
  Object.defineProperty(redisClient, 'isOpen', { configurable: true, value: false });
  t.mock.method(redisClient, 'sendCommand', async args => {
    if (args[0] === 'SISMEMBER' || args[0] === 'EVAL') return 1;
    if (args[0] === 'GET') return null;
    if (args[0] === 'TYPE') return 'none';
    return 0;
  });
  t.mock.method(redisClient, 'publish', async () => 0);
  t.mock.method(BaileysClient.prototype, 'initialize', async function() {
    this._connected = true; this.emit('ready');
  });
  t.mock.method(BaileysClient.prototype, 'destroy', async function() {
    this._connected = false; this._stopped = true;
  });
  t.mock.method(BaileysClient.prototype, 'sendMessage', async () => {
    sends++; throw new Error('unexpected provider send');
  });
  t.mock.method(BaileysClient.prototype, 'rejectCall', async () => {
    calls++; throw new Error('unexpected provider call');
  });
  assert.equal((await manager.startWhatsAppInstance(instance)).success, true);
  const client = manager.clients.get(instance);
  assert.equal(client._sock, null);
  normalizations = 0;
  t.after(async () => {
    manager.__test.clearPendingTextQueue(instance); manager.__test.clearRestartTimer(instance);
    if (manager.clients.has(instance)) await manager.stopWhatsAppInstance(instance, { wipeCredentials: false });
    manager.__test.clearJidMap(); manager.__test.clearMediaDownloadJobs(); delete redisClient.isOpen;
    assert.equal(sends, 0); assert.equal(calls, 0);
  });
  const message = (extra = {}) => ({
    from: customerJid, fromMe: false, type: 'chat', body: 'synthetic customer content',
    hasMedia: false, id: { id: 'callback-' + sequence, remote: customerJid },
    getContact: async () => {
      contactLookups++;
      return { id: { _serialized: customerJid }, number: customerPhone, isMyContact: true };
    },
    ...extra
  });
  return { handle: client.listeners('message')[0], message };
}

test('newsletter detector uses current routing metadata, including retained sender contact', () => {
  assert.equal(typeof phoneUtils.isNewsletterPayload, 'function');
  for (const shape of [
    { from: newsletterJid },
    { key: { remoteJid: newsletterJid } },
    { id: { remote: newsletterJid } },
    { _data: { id: { remote: newsletterJid } } },
    { _baileys: { key: { remoteJid: newsletterJid } } },
    { sender: legacyPhone + '@c.us', contact: { id: newsletterJid } },
    { sender: legacyPhone + '@c.us', data: { contact: { id: { _serialized: newsletterJid } } } },
    { data: { key: { remoteJid: ' ' + newsletterJid.toUpperCase() + ' ' } } }
  ]) assert.equal(phoneUtils.isNewsletterPayload(shape), true);
});

test('actual registered callback rejects canonical newsletter before phone/contact/media work', async t => {
  const { handle, message } = await callbackFixture(t);
  let downloads = 0;
  await handle(message({
    from: newsletterJid, id: { id: 'newsletter-canonical', remote: newsletterJid },
    type: 'video', hasMedia: true,
    downloadMedia: async () => { downloads++; throw new Error('unexpected media lookup'); }
  }));
  assert.equal(normalizations, 0); assert.equal(contactLookups, 0);
  assert.equal(downloads, 0); assert.equal(forwarded.length, 0);
});

test('actual callback rejects retained newsletter contact before sender rewrite/media/forward', async t => {
  const { handle, message } = await callbackFixture(t);
  let downloads = 0;
  await handle(message({
    from: legacyPhone + '@c.us', type: 'video', hasMedia: true,
    getContact: async () => {
      contactLookups++;
      return { id: { _serialized: newsletterJid }, number: legacyPhone, isMyContact: true };
    },
    downloadMedia: async () => { downloads++; throw new Error('unexpected media lookup'); }
  }));
  assert.equal(contactLookups, 1); assert.equal(downloads, 0); assert.equal(forwarded.length, 0);
});

for (const type of ['chat', 'video']) test('actual customer ' + type + ' callback still forwards unchanged', async t => {
  const { handle, message } = await callbackFixture(t);
  await handle(message({ type }));
  assert.equal(forwarded.length, 1); assert.equal(forwarded[0].normalizedPhone, customerPhone);
  assert.equal(forwarded[0].type, type); assert.equal(forwarded[0].body, 'synthetic customer content');
  assert.equal(forwarded[0].data.key.remoteJid, customerJid);
});

test('actual forwarded newsletter content remains a customer conversation', async t => {
  const { handle, message } = await callbackFixture(t);
  const contextInfo = { isForwarded: true, forwardedNewsletterMessageInfo: { newsletterJid } };
  await handle(message({
    body: 'forwarded @newsletter content',
    _baileys: { key: { remoteJid: customerJid }, message: { extendedTextMessage: { contextInfo } } },
    _data: { id: { remote: customerJid }, contextInfo }
  }));
  assert.equal(forwarded.length, 1); assert.equal(forwarded[0].normalizedPhone, customerPhone);
  assert.equal(forwarded[0].body, 'forwarded @newsletter content');
  assert.equal(phoneUtils.isNewsletterPayload({
    ...customerPayload('forwarded'), body: newsletterJid,
    data: { key: { remoteJid: customerJid }, message: { extendedTextMessage: { contextInfo } } }
  }), false);
});

test('incoming newsletter admission performs no WAL write or transport attempt', async t => {
  quiet(t);
  const { dir, incoming } = await walFixture(t);
  let writes = 0, transports = 0;
  t.mock.method(fs, 'writeFile', async () => { writes++; throw new Error('unexpected WAL write'); });
  t.mock.method(axios, 'post', async () => { transports++; throw new Error('unexpected transport'); });
  const result = await incoming.forwardIncomingWhatsAppMessage(customerPayload('newsletter-admission', {
    sender: newsletterJid, contact: { id: newsletterJid }
  }));
  assert.equal(result.openbot.status, 'skipped'); assert.equal(result.openbot.reason, 'non_conversational');
  assert.equal(result.redis.status, 'skipped'); assert.equal(result.durable, false);
  assert.equal(writes, 0); assert.equal(transports, 0); assert.deepEqual(await fs.readdir(dir), []);
});

test('actual retained legacy WAL newsletter completes naturally in the existing drain and dedups replay', async t => {
  quiet(t);
  const { wal } = await walFixture(t);
  const payload = customerPayload('newsletter-legacy', {
    type: 'video', hasMedia: false, mediaData: '', normalizedPhone: legacyPhone, senderPhone: legacyPhone,
    sender: legacyPhone + '@c.us',
    data: { key: { remoteJid: legacyPhone + '@c.us' }, contact: { id: newsletterJid } }
  });
  const record = await wal.enqueueIncoming(payload);
  record.pendingRedis = false; record.attempts = 471; await wal.updateIncoming(record);
  // Reload the actual modules to consume the persisted legacy payload, not an in-memory replacement.
  delete require.cache[walFilename]; delete require.cache[incomingFilename];
  const coldWal = require(walFilename), coldIncoming = require(incomingFilename);
  let transports = 0;
  t.mock.method(axios, 'post', async () => { transports++; throw new Error('unexpected transport'); });
  assert.equal(await coldIncoming.drainIncomingWal(), 1);
  assert.equal(transports, 0); assert.deepEqual(await coldWal.listIncoming(), []);
  assert.equal(await coldWal.__test.hasTombstone(record.id), true);
  assert.equal(await coldWal.enqueueIncoming(payload), null);
});

test('newsletter history and OpenBot policy skip before customer-dependent lookups', async t => {
  const { incoming } = await walFixture(t);
  let lookups = 0;
  const fail = async () => { lookups++; throw new Error('unexpected customer lookup'); };
  const payload = customerPayload('history', {
    sender: newsletterJid, normalizedPhone: '123@lid',
    data: { contact: { id: newsletterJid } }
  });
  assert.deepEqual(await incoming.saveIncomingMessage(payload, {
    resolveLidPhone: fail, isPhoneAllowed: fail, store: { appendMessageOnce: fail }, redisOpen: true
  }), { skipped: true, reason: 'non_conversational' });
  assert.equal(await incoming.__test.shouldSkipOpenBot(payload, { isPhoneAllowed: fail, findRow: fail }), true);
  assert.equal(lookups, 0);
});

for (const type of ['chat', 'video']) test('actual customer ' + type + ' worker keeps both delivery legs', async t => {
  const { wal, incoming } = await walFixture(t);
  const payload = customerPayload('customer-worker-' + type, { type });
  const record = await wal.enqueueIncoming(payload);
  let saves = 0, forwards = 0;
  await incoming.processIncomingRecord(record, {
    saveIncomingMessage: async value => { saves++; assert.deepEqual(value, payload); return { saved: true }; },
    shouldSkipOpenBot: async () => false,
    forwardToOpenBot: async value => { forwards++; assert.deepEqual(value, payload); return { delivered: true }; }
  });
  assert.equal(saves, 1); assert.equal(forwards, 1); assert.equal(await wal.enqueueIncoming(payload), null);
});

test('routing detector rejects lookalike suffixes and ignores message-body/context origins', () => {
  for (const payload of [
    null, {}, { from: 'customer@newsletter.example' }, { sender: '@newsletter' },
    { contact: { id: { arbitrary: newsletterJid } } },
    { body: newsletterJid, text: newsletterJid },
    { data: { message: { extendedTextMessage: { contextInfo: {
      remoteJid: newsletterJid, participant: newsletterJid,
      forwardedNewsletterMessageInfo: { newsletterJid }
    } } } } }
  ]) assert.equal(phoneUtils.isNewsletterPayload(payload), false);
});

test('actual worker forwards a customer message containing newsletter-origin metadata', async t => {
  const { wal, incoming } = await walFixture(t);
  const payload = customerPayload('forwarded-worker', {
    body: 'forwarded @newsletter content',
    data: { key: { remoteJid: customerJid }, message: { extendedTextMessage: {
      contextInfo: { isForwarded: true, forwardedNewsletterMessageInfo: { newsletterJid } }
    } } }
  });
  const record = await wal.enqueueIncoming(payload);
  let saves = 0, forwards = 0;
  await incoming.processIncomingRecord(record, {
    saveIncomingMessage: async value => { saves++; assert.deepEqual(value, payload); return { saved: true }; },
    shouldSkipOpenBot: async () => false,
    forwardToOpenBot: async value => { forwards++; assert.deepEqual(value, payload); return { delivered: true }; }
  });
  assert.equal(saves, 1); assert.equal(forwards, 1); assert.equal(await wal.enqueueIncoming(payload), null);
});
