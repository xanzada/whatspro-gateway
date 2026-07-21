const test = require('node:test');
const assert = require('node:assert/strict');

const { __test: whatsappTest } = require('../services/whatsappManager');
const { __test: webhookTest } = require('../services/incomingWebhook');
const { __test: serverTest } = require('../src/server');

test('audio requires hasMedia and an audio MIME type', () => {
  assert.equal(whatsappTest.isQualifiedAudio({ hasMedia: true }, { mimetype: 'audio/ogg; codecs=opus' }), true);
  assert.equal(whatsappTest.isQualifiedAudio({ hasMedia: true, type: 'ptt' }, { mimetype: 'image/jpeg' }), false);
  assert.equal(whatsappTest.isQualifiedAudio({ hasMedia: false }, { mimetype: 'audio/ogg' }), false);
  assert.equal(whatsappTest.isQualifiedAudio({ hasMedia: true, type: 'notification_template' }, { mimetype: 'audio/ogg' }), false);

  const nonAudio = webhookTest.buildHistoryEntry({ hasMedia: true, mediaType: 'image/jpeg', mediaData: 'YWJj' }, 'acme', '77001234567', 1);
  assert.equal(nonAudio.hasMedia, false);
  assert.equal(nonAudio.mediaData, '');
  const audio = webhookTest.buildHistoryEntry({ hasMedia: true, mediaType: 'audio/webm', mediaData: 'YWJj' }, 'acme', '77001234567', 1);
  assert.equal(audio.hasMedia, true);
  assert.equal(audio.mediaType, 'audio/webm');
  const system = webhookTest.buildHistoryEntry({ type: 'notification_template', hasMedia: true, mediaType: 'audio/ogg', mediaData: 'YWJj' }, 'acme', '77001234567', 1);
  assert.equal(system.hasMedia, false);
});

test('WhatsApp ACK values map to sent, delivered and read', () => {
  assert.equal(whatsappTest.deliveryStatusFromAck(1), 'sent');
  assert.equal(whatsappTest.deliveryStatusFromAck(2), 'delivered');
  assert.equal(whatsappTest.deliveryStatusFromAck(3), 'read');
  assert.equal(whatsappTest.deliveryStatusFromAck(4), 'read');
});

test('bot-send suppression counts concurrent sends and clears failed sends', () => {
  const key = 'bot_sending:acme:77001234567';
  const now = Date.now();
  whatsappTest.clearLocalBotSends();
  whatsappTest.incrementLocalBotSend(key, now + 1000);
  whatsappTest.incrementLocalBotSend(key, now + 1000);
  assert.equal(whatsappTest.consumeLocalBotSend(key, now), true);
  assert.equal(whatsappTest.consumeLocalBotSend(key, now), true);
  assert.equal(whatsappTest.consumeLocalBotSend(key, now), false);

  whatsappTest.incrementLocalBotSend(key, now + 1000);
  whatsappTest.releaseLocalBotSend(key);
  assert.equal(whatsappTest.consumeLocalBotSend(key, now), false);
});

test('empty native audio creates a durable placeholder for deferred metadata', () => {
  const entry = whatsappTest.buildOperatorHistoryEntry('acme', '77001234567', '', 'whatsapp_app', 'voice1', {
    pendingAudio: true,
    hasMedia: false,
    mediaKind: 'ptt'
  }, 1000);
  assert.equal(entry.id, 'voice1');
  assert.equal(entry.type, 'audio');
  assert.equal(entry.hasMedia, false);
  assert.equal(entry.pendingMedia, true);
});

test('base64 validation rejects malformed and oversized media as permanent failures', () => {
  assert.equal(whatsappTest.validateAudioBase64('YWJj'), 'YWJj');
  for (const value of ['not base64!', 'A'.repeat(whatsappTest.MAX_MEDIA_BASE64_LENGTH + 4)]) {
    assert.throws(() => whatsappTest.validateAudioBase64(value), error => error.permanent === true);
  }
  assert.equal(whatsappTest.shouldRetryMediaError(Object.assign(new Error('bad'), { permanent: true })), false);
  assert.equal(whatsappTest.shouldRetryMediaError(new Error('temporary download failure')), true);
});

class FakeIdempotencyRedis {
  constructor(open = true) { this.isOpen = open; this.values = new Map(); }
  async sendCommand(args) {
    if (args[0] === 'SET' && args.includes('NX')) {
      if (this.values.has(args[1])) return null;
      this.values.set(args[1], args[2]); return 'OK';
    }
    if (args[0] === 'SET') { this.values.set(args[1], args[2]); return 'OK'; }
    if (args[0] === 'GET') return this.values.get(args[1]) || null;
    if (args[0] === 'EVAL') {
      if (args[2] === '3') {
        if (this.values.get(args[3]) !== args[6]) return 0;
        this.values.set(args[3], args[7]);
        this.values.set(args[4], args[9]);
        this.values.set(args[5], [args[4]]);
        return 1;
      }
      const key = args[3]; const expected = args[4];
      if (this.values.get(key) !== expected) return 0;
      if (args.length >= 7) { this.values.set(key, args[5]); return 1; }
      if (args.length === 6) return 1;
      this.values.delete(key); return 1;
    }
    throw new Error(`unsupported ${args[0]}`);
  }
}

test('send idempotency replays success and releases failed attempts', async () => {
  const redis = new FakeIdempotencyRedis();
  const guard = serverTest.createSendIdempotency(redis, { now: () => 100 });
  const hash = 'a'.repeat(64);
  const first = await guard.begin('acme', '77001234567', 'request_1234', hash);
  assert.equal(first.acquired, true);
  await guard.complete(first, { success: true, messageId: 'm1' });
  const replay = await serverTest.createSendIdempotency(redis, { now: () => 100 }).begin('acme', '77001234567', 'request_1234', hash);
  assert.deepEqual(replay.response, { success: true, messageId: 'm1' });
  assert.equal((await guard.begin('acme', '77001234567', 'request_1234', 'b'.repeat(64))).conflict, true);

  const failed = await guard.begin('acme', '77001234567', 'request_5678', hash);
  await guard.release(failed);
  assert.equal((await guard.begin('acme', '77001234567', 'request_5678', hash)).acquired, true);

  const stale = await guard.begin('acme', '77001234567', 'request_stale', hash);
  redis.values.set(stale.key, `pending:new-owner:${hash}`);
  assert.equal(await guard.complete(stale, { success: true, messageId: 'stale' }), false);
  assert.equal(redis.values.get(stale.key), `pending:new-owner:${hash}`);

  const durable = await guard.begin('acme', '77001234567', 'request_durable', hash);
  const effectKey = 'chatwoot:operator-effect:acme:77001234567:request_durable';
  assert.equal(await guard.complete(durable, { success: true, messageId: 'm2' }, {
    effectKey, payload: { instanceId: 'acme', phone: '77001234567', expiresAt: 160, entry: { id: 'm2' } }
  }), true);
  assert.match(redis.values.get(effectKey), /"messageId"|"instanceId"/);
  assert.deepEqual(redis.values.get('chatwoot:operator-effects-outbox'), [effectKey]);
});

test('send idempotency validates request ids and falls back locally', async () => {
  const redis = new FakeIdempotencyRedis(false);
  const guard = serverTest.createSendIdempotency(redis, { now: () => 100 });
  const hash = 'a'.repeat(64);
  assert.equal(serverTest.isValidSendRequestId('bad space'), false);
  assert.equal(serverTest.isValidSendRequestId('request_1234'), true);
  const first = await guard.begin('acme', '77001234567', 'request_1234', hash);
  assert.equal(first.acquired, true);
  const duplicate = await guard.begin('acme', '77001234567', 'request_1234', hash);
  assert.equal(duplicate.inProgress, true);

  const redisGuard = serverTest.createSendIdempotency(redis, { now: () => 100 });
  redis.isOpen = true;
  const redisLease = await redisGuard.begin('acme', '77001234567', 'request_redis1', hash);
  redis.isOpen = false;
  assert.equal((await redisGuard.begin('acme', '77001234567', 'request_redis1', hash)).inProgress, true);
  await redisGuard.release(redisLease);
});

test('operator effect repair preserves the original lock expiry', () => {
  assert.equal(serverTest.remainingOperatorTtl(160_000, 100_000), 60);
  assert.equal(serverTest.remainingOperatorTtl(99_000, 100_000), 0);
});
