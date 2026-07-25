const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const { Readable } = require('node:stream');

const { __test: whatsappTest } = require('../services/whatsappManager');

const { __test: webhookTest } = require('../services/incomingWebhook');
const { __test: serverTest } = require('../src/server');

function encryptedWhatsAppAudio(plaintext, mediaKey) {
  const expanded = Buffer.from(crypto.hkdfSync('sha256', mediaKey, Buffer.alloc(32), Buffer.from('WhatsApp Audio Keys'), 112));
  const iv = expanded.subarray(0, 16);
  const cipherKey = expanded.subarray(16, 48);
  const macKey = expanded.subarray(48, 80);
  const cipher = crypto.createCipheriv('aes-256-cbc', cipherKey, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const mac = crypto.createHmac('sha256', macKey).update(Buffer.concat([iv, ciphertext])).digest().subarray(0, 10);
  return Buffer.concat([ciphertext, mac]);
}

test('chat media accepts audio and photos while rejecting unsupported media', () => {
  assert.equal(whatsappTest.isQualifiedAudio({ hasMedia: true }, { mimetype: 'audio/ogg; codecs=opus' }), true);
  assert.equal(whatsappTest.isQualifiedAudio({ hasMedia: true, type: 'ptt' }, { mimetype: 'image/jpeg' }), false);
  assert.equal(whatsappTest.isQualifiedAudio({ hasMedia: false }, { mimetype: 'audio/ogg' }), false);
  assert.equal(whatsappTest.isQualifiedAudio({ hasMedia: true, type: 'notification_template' }, { mimetype: 'audio/ogg' }), false);

  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64');
  const image = webhookTest.buildHistoryEntry({ type: 'image', hasMedia: true, mediaType: 'image/jpeg', mediaData: jpeg }, 'acme', '77001234567', 1);
  assert.equal(image.hasMedia, true);
  assert.equal(image.mediaData, jpeg);
  assert.equal(whatsappTest.isQualifiedImage({ hasMedia: true, type: 'image', mimetype: 'image/jpeg' }), true);
  assert.equal(whatsappTest.validateImageBase64(jpeg, 'image/jpeg'), jpeg);
  assert.throws(() => whatsappTest.validateImageBase64('YWJj', 'image/jpeg'), /IMAGE_SIGNATURE_INVALID/);
  const audio = webhookTest.buildHistoryEntry({ hasMedia: true, mediaType: 'audio/webm', mediaData: 'YWJj' }, 'acme', '77001234567', 1);
  assert.equal(audio.hasMedia, true);
  assert.equal(audio.mediaType, 'audio/webm');
  const system = webhookTest.buildHistoryEntry({ type: 'notification_template', hasMedia: true, mediaType: 'audio/ogg', mediaData: 'YWJj' }, 'acme', '77001234567', 1);
  assert.equal(system.hasMedia, false);
});

test('incoming ingestion forwards audio data and MIME through the idempotent append path', async () => {
  const captured = [];
  const dependencies = {
    redisOpen: true,
    store: { appendMessageOnce: async (...args) => { captured.push(args); return { inserted: true, stale: false }; } },
    publishEvent: async () => {}
  };
  await webhookTest.saveIncomingMessage({
    instanceId: 'acme', phone: '77001234567', messageId: 'voice1', type: 'ptt',
    hasMedia: true, mediaType: 'audio/ogg', mediaData: 'YWJj'
  }, dependencies);
  assert.equal(captured[0][2].mediaData, 'YWJj');
  assert.equal(captured[0][2].mediaType, 'audio/ogg');
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
  assert.equal(whatsappTest.validateAudioBase64('data:audio/ogg;base64, YWJj\n'), 'YWJj');
  for (const value of ['not base64!', 'A'.repeat(whatsappTest.MAX_MEDIA_BASE64_LENGTH + 4)]) {
    assert.throws(() => whatsappTest.validateAudioBase64(value), error => error.permanent === true);
  }
  assert.equal(whatsappTest.shouldRetryMediaError(Object.assign(new Error('bad'), { permanent: true })), false);
  assert.equal(whatsappTest.shouldRetryMediaError(new Error('temporary download failure')), true);
});

test('audio downloader uses the Baileys media stream for WhatsApp PTT messages', async () => {
  const plaintext = Buffer.from('OggS\u0000\u0002WhatsPro-OpusHead-voice-note');
  const mediaKey = Buffer.alloc(32, 7).toString('base64');
  const msg = {
    hasMedia: true,
    type: 'ptt',
    mimetype: 'audio/ogg; codecs=opus',
    mediaKey,
    _data: {
      directPath: '/v/t62.7117-24/test-audio.enc?ccb=11-4',
      clientUrl: 'https://mmg-fna.whatsapp.net/v/t62.7117-24/test-audio.enc?ccb=11-4',
      filehash: crypto.createHash('sha256').update(plaintext).digest('base64')
    }
  };

  let received;
  const media = await whatsappTest.downloadBaileysMessageMedia(msg, async (...args) => {
    received = args;
    return Readable.from([plaintext.subarray(0, 8), plaintext.subarray(8)]);
  });
  assert.deepEqual(received[0], {
    mediaKey,
    directPath: '/v/t62.7117-24/test-audio.enc?ccb=11-4',
    url: 'https://mmg-fna.whatsapp.net/v/t62.7117-24/test-audio.enc?ccb=11-4'
  });
  assert.equal(received[1], 'audio');
  assert.equal(received[2].host, 'mmg-fna.whatsapp.net');
  assert.equal(typeof received[2].options.dispatcher?.dispatch, 'function');
  assert.deepEqual(media, {
    data: plaintext.toString('base64'),
    mimetype: 'audio/ogg; codecs=opus',
    filename: undefined,
    filesize: plaintext.length
  });
});

test('Baileys media stream is stopped before it can exceed the audio size limit', async () => {
  await assert.rejects(
    () => whatsappTest.collectMediaStream(Readable.from([Buffer.alloc(5), Buffer.alloc(6)]), 10),
    error => error?.permanent === true && error?.code === 'MEDIA_TOO_LARGE'
  );
});

test('media dispatcher rejects redirects outside the original CDN origin', async t => {
  const target = http.createServer((request, response) => response.end('private'));
  const source = http.createServer((request, response) => {
    response.writeHead(302, { Location: `http://localhost:${target.address().port}/private` });
    response.end();
  });
  await Promise.all([target, source].map(server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve))));
  t.after(() => Promise.all([target, source].map(server => new Promise(resolve => server.close(resolve)))));
  const origin = `http://127.0.0.1:${source.address().port}`;
  const dispatcher = whatsappTest.createMediaDispatcher(origin, 1000);
  t.after(() => dispatcher.destroy().catch(() => {}));
  await assert.rejects(
    () => fetch(`${origin}/audio`, { dispatcher }),
    error => error?.cause?.code === 'MEDIA_CDN_HOST_INVALID'
  );
});

test('Baileys timeout destroys the underlying media dispatcher', async () => {
  let destroyed = 0;
  const dispatcher = {
    dispatch() {},
    destroy: async () => { destroyed += 1; }
  };
  const plaintext = Buffer.from('OggS-timeout');
  await assert.rejects(() => whatsappTest.downloadBaileysMessageMedia({
    hasMedia: true,
    type: 'ptt',
    mediaKey: Buffer.alloc(32, 3).toString('base64'),
    _data: {
      directPath: '/v/t62.7117-24/stalled.enc',
      mimetype: 'audio/ogg',
      filehash: crypto.createHash('sha256').update(plaintext).digest('base64')
    }
  }, async () => new Promise(() => {}), { timeoutMs: 20, dispatcher }), /MEDIA_CDN_TIMEOUT/);
  assert.equal(destroyed, 1);
});

test('installed Baileys downloader decrypts the exact WhatsApp audio payload', async () => {
  const plaintext = Buffer.from('OggS\u0000\u0002OpusHead-WhatsPro-voice-note');
  const mediaKey = Buffer.alloc(32, 9);
  const encrypted = encryptedWhatsAppAudio(plaintext, mediaKey);
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    assert.equal(String(url), 'https://mmg.whatsapp.net/v/t62.7117-24/real-baileys.enc');
    assert.equal(options.headers.Origin, 'https://web.whatsapp.com');
    return new Response(encrypted, { status: 200, headers: { 'Content-Type': 'application/octet-stream' } });
  };
  try {
    const { downloadContentFromMessage } = await import('@whiskeysockets/baileys');
    const media = await whatsappTest.downloadBaileysMessageMedia({
      hasMedia: true,
      type: 'ptt',
      mediaKey: mediaKey.toString('base64'),
      _data: {
        directPath: '/v/t62.7117-24/real-baileys.enc',
        clientUrl: 'https://mmg.whatsapp.net/v/t62.7117-24/real-baileys.enc',
        mimetype: 'audio/ogg; codecs=opus',
        filehash: crypto.createHash('sha256').update(plaintext).digest('base64')
      }
    }, downloadContentFromMessage);
    assert.deepEqual(Buffer.from(media.data, 'base64'), plaintext);
  } finally {
    global.fetch = originalFetch;
  }
});

test('audio downloader uses WhatsApp blob cache path when legacy downloadMedia is broken', async () => {
  const calls = [];
  const voice = Buffer.from('OggS-voice-payload');
  let downloadOptions = null;
  const source = {
    mediaData: { mediaStage: 'RESOLVED' },
    mediaObject: { filehash: 'voice-hash' },
    mimetype: 'audio/ogg', filename: 'voice.ogg', size: voice.length,
    downloadMedia: async options => { downloadOptions = options; }
  };
  const msg = {
    hasMedia: true,
    id: { _serialized: 'false_224043110273161@lid_AUDIO1' },
    downloadMedia: async () => { throw new Error('legacy downloader must not run'); },
    client: {
      pupPage: {
        evaluate: async (resolver, messageId) => {
          calls.push({ source: String(resolver), messageId });
          global.window = {
            require(name) {
              if (name === 'WAWebCollections') return { Msg: { get: () => source } };
              if (name === 'WAWebMediaInMemoryBlobCache') {
                return { InMemoryMediaBlobCache: { get: () => new Blob([voice], { type: 'audio/ogg' }) } };
              }
              throw new Error(`unexpected module ${name}`);
            },
            WWebJS: {}
          };
          global.FileReader = class {
            readAsDataURL(blob) {
              blob.arrayBuffer().then(buffer => {
                this.result = `data:${blob.type};base64,${Buffer.from(buffer).toString('base64')}`;
                this.onload();
              }, error => { this.error = error; this.onerror(); });
            }
          };
          try { return await resolver(messageId, whatsappTest.MAX_MEDIA_BYTES); }
          finally { delete global.window; delete global.FileReader; }
        }
      }
    }
  };

  assert.deepEqual(await whatsappTest.downloadMessageMedia(msg), {
    data: voice.toString('base64'), mimetype: 'audio/ogg', filename: 'voice.ogg', filesize: voice.length
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].messageId, msg.id._serialized);
  assert.deepEqual(downloadOptions, { downloadEvenIfExpensive: true, rmrReason: 1, isUserInitiated: true });
  assert.match(calls[0].source, /isUserInitiated:\s*true/);
  assert.match(calls[0].source, /WAWebMediaInMemoryBlobCache/);
  assert.match(calls[0].source, /forceToBlob/);
  assert.match(calls[0].source, /arrayBufferToBase64Async/);
  assert.match(calls[0].source, /new FileReader\(\)/);
});

test('audio downloader rejects declared oversized media before allocating the blob', async () => {
  let arrayBufferCalls = 0;
  let legacyCalls = 0;
  const source = {
    mediaData: { mediaStage: 'RESOLVED' },
    mediaObject: { filehash: 'oversized' },
    mimetype: 'audio/ogg', size: whatsappTest.MAX_MEDIA_BYTES + 1,
    downloadMedia: async () => {}
  };
  const msg = {
    hasMedia: true,
    id: { _serialized: 'false_224043110273161@lid_AUDIO2' },
    downloadMedia: async () => { legacyCalls += 1; },
    client: { pupPage: { evaluate: async (resolver, messageId, maxBytes) => {
      global.window = {
        require(name) {
          if (name === 'WAWebCollections') return { Msg: { get: () => source } };
          if (name === 'WAWebMediaInMemoryBlobCache') return { InMemoryMediaBlobCache: { get: () => ({ size: source.size, arrayBuffer: async () => { arrayBufferCalls += 1; return new ArrayBuffer(1); } }) } };
          throw new Error(`unexpected module ${name}`);
        },
        WWebJS: { arrayBufferToBase64Async: async () => 'AA==' }
      };
      try { return await resolver(messageId, maxBytes); }
      finally { delete global.window; }
    } } }
  };

  await assert.rejects(() => whatsappTest.downloadMessageMedia(msg), error => error.permanent === true && error.message === 'MEDIA_TOO_LARGE');
  assert.equal(arrayBufferCalls, 0);
  assert.equal(legacyCalls, 0);
});

test('concurrent audio persistence shares one Chromium media download', async () => {
  whatsappTest.clearMediaDownloadJobs();
  let evaluateCalls = 0;
  let releaseDownload;
  const gate = new Promise(resolve => { releaseDownload = resolve; });
  const media = { data: 'T2dnUw==', mimetype: 'audio/ogg' };
  const msg = {
    hasMedia: true,
    id: { _serialized: 'false_224043110273161@lid_AUDIO3' },
    client: { pupPage: { evaluate: async () => { evaluateCalls += 1; await gate; return media; } } },
    downloadMedia: async () => { throw new Error('legacy downloader must not run'); }
  };

  const first = whatsappTest.downloadMessageMedia(msg);
  const second = whatsappTest.downloadMessageMedia(msg);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(evaluateCalls, 1);
  releaseDownload();
  assert.deepEqual(await Promise.all([first, second]), [media, media]);
  whatsappTest.clearMediaDownloadJobs();
});

test('audio download single-flight is isolated between tenants', async () => {
  whatsappTest.clearMediaDownloadJobs();
  const makeMessage = data => ({
    hasMedia: true,
    id: { _serialized: 'false_224043110273161@lid_SHARED_AUDIO_ID' },
    client: { pupPage: { evaluate: async () => ({ data, mimetype: 'audio/ogg' }) } },
    downloadMedia: async () => { throw new Error('legacy downloader must not run'); }
  });

  const [first, second] = await Promise.all([
    whatsappTest.downloadMessageMedia(makeMessage('VEVOQU5UX0E='), 'tenant-a:77000000001'),
    whatsappTest.downloadMessageMedia(makeMessage('VEVOQU5UX0I='), 'tenant-b:77000000002')
  ]);
  assert.equal(first.data, 'VEVOQU5UX0E=');
  assert.equal(second.data, 'VEVOQU5UX0I=');
  whatsappTest.clearMediaDownloadJobs();
});

test('audio downloads cap distinct concurrent media work', async () => {
  whatsappTest.clearMediaDownloadJobs();
  let releaseDownloads;
  const gate = new Promise(resolve => { releaseDownloads = resolve; });
  const makeMessage = id => ({
    hasMedia: true,
    id: { _serialized: `false_224043110273161@lid_${id}` },
    client: { pupPage: { evaluate: async () => { await gate; return { data: 'T2dnUw==', mimetype: 'audio/ogg' }; } } },
    downloadMedia: async () => { throw new Error('legacy downloader must not run'); }
  });
  const first = whatsappTest.downloadMessageMedia(makeMessage('BUSY1'), 'tenant:phone1');
  const second = whatsappTest.downloadMessageMedia(makeMessage('BUSY2'), 'tenant:phone2');
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(
    () => whatsappTest.downloadMessageMedia(makeMessage('BUSY3'), 'tenant:phone3'),
    /MEDIA_DOWNLOAD_BUSY/
  );
  releaseDownloads();
  await Promise.all([first, second]);
  whatsappTest.clearMediaDownloadJobs();
});

test('missing persisted audio can be found again in the WhatsApp chat history', async () => {
  const expected = { id: { id: 'AUDIO_MISSING' }, hasMedia: true, type: 'ptt' };
  let fetchLimit = 0;
  const client = {
    getMessageById: async () => null,
    getContactLidAndPhone: async userIds => {
      assert.deepEqual(userIds, ['77476884956@c.us']);
      return [{ lid: '224043110273161@lid', pn: '77476884956@c.us' }];
    },
    getChatById: async chatId => {
      if (chatId === '77476884956@c.us') throw new Error('PN chat is unavailable after linked-device restart');
      assert.equal(chatId, '224043110273161@lid');
      return {
        fetchMessages: async options => {
          fetchLimit = options.limit;
          return [{ id: { id: 'OTHER' } }, expected];
        }
      };
    }
  };

  assert.equal(await whatsappTest.findMessageForMediaRecovery(client, '77476884956', 'AUDIO_MISSING'), expected);
  assert.equal(fetchLimit, 200);
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

test('media authentication accepts the existing header and route query fallback', () => {
  const previous = process.env.WHATSPRO_API_TOKEN;
  process.env.WHATSPRO_API_TOKEN = 'media-test-token';
  try {
    assert.equal(serverTest.hasChatMediaToken({ headers: { 'x-chat-token': 'media-test-token' }, query: {} }), true);
    assert.equal(serverTest.hasChatMediaToken({ headers: {}, query: { token: 'media-test-token' } }), true);
    assert.equal(serverTest.hasChatMediaToken({ headers: {}, query: { token: 'wrong' } }), false);
  } finally {
    if (previous == null) delete process.env.WHATSPRO_API_TOKEN;
    else process.env.WHATSPRO_API_TOKEN = previous;
  }
});
