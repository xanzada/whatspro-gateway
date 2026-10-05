'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
module.exports = function createMediaApiFixture(label) {
  const walDir = path.join(os.tmpdir(), label + '-' + process.pid);
  process.env.WHATSPRO_SEND_WAL_DIR = walDir;
  const { redisClient } = require('../../config/redis');
  const { chatStore } = require('../../services/chatStore');
  const manager = require('../../services/whatsappManager');
  const values = new Map();
  let sends = 0, sequence = 0, requestId, outcome, onSend;
  const phone = '77000000001', instanceId = 'independent-media-fixture';
  manager.sendWhatsAppText = manager.sendMedia = async (...args) => {
    sends++;
    if (onSend) await onSend(args);
    if (outcome instanceof Error) throw outcome;
    return outcome;
  };
  const server = require('../../src/server');
  const key = () => 'chatwoot:send-idempotency:' + instanceId + ':' + phone + ':' + requestId;
  const file = () => path.join(walDir, 'api-send', crypto.createHash('sha256').update(key()).digest('hex') + '.json');
  const fixture = {
    values,
    get sends() { return sends; },
    get requestId() { return requestId; },
    key,
    nextId() { requestId = 'independent-media-' + (++sequence); return requestId; },
    setOutcome(value) { outcome = value; },
    setOnSend(value) { onSend = value; },
    record: async () => JSON.parse(await fs.readFile(file(), 'utf8')),
    async hasRecord() { try { await fs.access(file()); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } },
    media(overrides = {}) { return { text: '', media: { base64: Buffer.from('synthetic-media-bytes').toString('base64'), mimeType: 'image/png', fileName: 'fixture.png', caption: 'synthetic caption', ...overrides } }; },
    async invoke(body = {}) {
      const route = server.app.router.stack.find(layer => layer.route?.path === '/api/send').route;
      assert.equal(route.stack[0].handle.name, 'requireApi');
      let status = 200, response;
      await route.stack.at(-1).handle({
        body: { instanceId, phone, requestId, text: 'synthetic notice', ...body },
        apiAuth: { scope: 'tenant', instanceId }
      }, { status(code) { status = code; return this; }, json(value) { response = value; return this; } });
      return { status, response };
    }
  };
  test.beforeEach(async t => {
    fixture.nextId(); sends = 0; values.clear(); onSend = null;
    outcome = { success: true, ack: 1, messageId: 'SYNTHETIC-MEDIA-ACK' };
    for (const name of ['log', 'warn', 'error']) t.mock.method(console, name, () => {});
    Object.defineProperty(redisClient, 'isOpen', { configurable: true, value: true });
    t.mock.method(chatStore, 'resolveLidPhone', async (_instance, value) => String(value).replace(/\D/g, ''));
    t.mock.method(chatStore, 'appendMessageOnce', async (_instance, _phone, entry) => ({ ...entry, inserted: true }));
    t.mock.method(redisClient, 'publish', async () => 0);
    t.mock.method(redisClient, 'sendCommand', async args => {
      const [cmd, itemKey, value] = args;
      if (cmd === 'GET') return values.get(itemKey) || null;
      if (cmd === 'SET') { if (args.includes('NX') && values.has(itemKey)) return null; values.set(itemKey, value); return 'OK'; }
      if (cmd === 'EVAL') {
        const argv = args.slice(3 + Number(args[2])), guardedKey = args[3];
        if (values.get(guardedKey) !== argv[0]) return 0;
        if (String(args[1]).includes("redis.call('DEL'")) { values.delete(guardedKey); return 1; }
        if (String(args[1]).includes("redis.call('SET'")) { values.set(guardedKey, argv[1]); return 1; }
        return 1;
      }
      if (['LRANGE', 'ZRANGE', 'HGETALL'].includes(cmd)) return [];
      return 0;
    });
    await fs.mkdir(walDir, { recursive: true });
  });
  test.after(async () => { delete redisClient.isOpen; await fs.rm(walDir, { recursive: true, force: true }); });
  return fixture;
};
