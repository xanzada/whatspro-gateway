'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const pathMod = require('path');

const { BaileysClient, MessageMedia, __test } = require('../services/baileysClient');

// Every test drives the real BaileysClient with a fake Baileys module, so a
// regression in the wwebjs-shaped surface the manager depends on fails here
// rather than in production. No network, no auth folder outside tmp.

const quietLogger = { log: () => {}, warn: () => {}, error: () => {} };

function fakeBaileys(overrides = {}) {
  const sockets = [];
  const sentMessages = [];
  const rejectedCalls = [];
  const socketOptions = [];

  const loader = async () => ({
    default: options => {
      socketOptions.push(options);
      const listeners = new Map();
      const sock = {
        user: { id: '77000000000:5@s.whatsapp.net', name: 'Bekaba' },
        ev: {
          on: (name, fn) => { listeners.set(name, [...(listeners.get(name) || []), fn]); },
          removeAllListeners: () => listeners.clear()
        },
        end: () => {},
        logout: async () => {},
        readMessages: async () => {},
        sendPresenceUpdate: async () => {},
        rejectCall: async (id, from) => { rejectedCalls.push([id, from]); },
        sendMessage: async (jid, content) => {
          sentMessages.push({ jid, content });
          return {
            key: { remoteJid: jid, fromMe: true, id: `SENT-${sentMessages.length}` },
            message: typeof content.text === 'string' ? { conversation: content.text } : { imageMessage: {} },
            status: 1
          };
        },
        signalRepository: { lidMapping: {} },
        emit: (name, payload) => { for (const fn of listeners.get(name) || []) fn(payload); }
      };
      sockets.push(sock);
      return sock;
    },
    useMultiFileAuthState: async () => ({ state: {}, saveCreds: async () => {} }),
    fetchLatestBaileysVersion: async () => ({ version: [2, 3, 4] }),
    DisconnectReason: { loggedOut: 401, badSession: 500, restartRequired: 515, connectionClosed: 428 },
    Browsers: { ubuntu: () => ['Ubuntu', 'Chrome', '120'] },
    getContentType: content => {
      if (!content) return undefined;
      return Object.keys(content).find(key => key === 'conversation' || key.endsWith('Message'));
    },
    normalizeMessageContent: content => content || null,
    downloadMediaMessage: async () => Buffer.from('decrypted-bytes'),
    ...overrides
  });

  return { loader, sockets, sentMessages, rejectedCalls, socketOptions };
}

function tmpAuthDir(name) {
  return fs.mkdtempSync(pathMod.join(os.tmpdir(), `bc-${name}-`));
}

async function withClient(name, fake, run, options = {}) {
  __test._setBaileysForTest(fake.loader);
  const authDir = tmpAuthDir(name);
  const client = new BaileysClient({ instanceId: name, authDir, logger: quietLogger, ...options });
  try {
    await client.initialize();
    await run(client);
  } finally {
    await client.destroy();
    __test._setBaileysForTest(null);
    fs.rmSync(authDir, { recursive: true, force: true });
  }
}

function textMessage(overrides = {}) {
  return {
    key: { remoteJid: '77476884956@s.whatsapp.net', fromMe: false, id: 'MSG-1' },
    message: { conversation: 'сәлем' },
    messageTimestamp: { low: 1770000000, high: 0, unsigned: true },
    pushName: 'Аружан',
    ...overrides
  };
}

const IMAGE_NODE = {
  mimetype: 'image/jpeg',
  caption: 'қарашы',
  mediaKey: Buffer.from('0123456789abcdef'),
  directPath: '/v/t62.7118-24/12345?ccb=11-4',
  url: 'https://mmg.whatsapp.net/v/t62.7118-24/12345',
  fileSha256: Buffer.alloc(32, 7),
  fileLength: { low: 4096, high: 0, unsigned: true }
};

test('the raw QR string is emitted for the manager to render, and ready follows the open socket', async () => {
  const fake = fakeBaileys();
  const codes = [];
  let readyCount = 0;

  await withClient('qr', fake, async client => {
    client.on('qr', qr => codes.push(qr));
    client.on('ready', () => { readyCount += 1; });

    fake.sockets[0].emit('connection.update', { connection: 'connecting', qr: 'QR-RAW-1' });
    assert.deepEqual(codes, ['QR-RAW-1'], 'a PNG here would break the manager, which renders it itself');
    assert.equal(client.getState(), null, 'a pending scan is not a connection');

    fake.sockets[0].emit('connection.update', { connection: 'open' });
    assert.equal(readyCount, 1);
    assert.equal(client.getState(), 'CONNECTED');
    assert.equal(client.info.wid._serialized, '77000000000@s.whatsapp.net', 'the device suffix must be stripped');
    assert.equal(client.info.wid.user, '77000000000');
  });
});

test('a socket is never allowed to sync history into the webhook', async () => {
  const fake = fakeBaileys();
  await withClient('nohistory', fake, async () => {
    const options = fake.socketOptions[0];
    assert.equal(options.syncFullHistory, false);
    assert.equal(typeof options.shouldSyncHistoryMessage, 'function');
    assert.equal(options.shouldSyncHistoryMessage(), false);
    // Marking online suppresses notifications on the owner's own phone.
    assert.equal(options.markOnlineOnConnect, false, 'the default must be false');
  });

  const explicit = fakeBaileys();
  await withClient('online', explicit, async () => {
    assert.equal(explicit.socketOptions[0].markOnlineOnConnect, true);
  }, { markOnlineOnConnect: true });
});

test('an inbound text arrives in the wwebjs shape the manager reads', async () => {
  const fake = fakeBaileys();
  const seen = [];

  await withClient('text', fake, async client => {
    client.on('message', msg => seen.push(msg));
    fake.sockets[0].emit('connection.update', { connection: 'open' });
    fake.sockets[0].emit('messages.upsert', { type: 'notify', messages: [textMessage()] });

    assert.equal(seen.length, 1);
    const msg = seen[0];
    assert.equal(msg.type, 'chat');
    assert.equal(msg.body, 'сәлем');
    assert.equal(msg.fromMe, false);
    assert.equal(msg.hasMedia, false);
    assert.equal(msg.from, '77476884956@s.whatsapp.net');
    assert.equal(msg.to, '77000000000@s.whatsapp.net');
    assert.equal(msg.id.id, 'MSG-1');
    assert.equal(msg.id.remote, '77476884956@s.whatsapp.net');
    assert.equal(msg.id.fromMe, false);
    assert.equal(
      msg.id._serialized, 'false_77476884956@s.whatsapp.net_MSG-1',
      'the manager looks messages up in exactly this form'
    );
    // The manager multiplies by 1000 itself, so this must be seconds and the
    // protobuf Long must already be unwrapped.
    assert.equal(msg.timestamp, 1770000000);
    assert.equal(msg._data.notifyName, 'Аружан');
    assert.equal(msg._data.id.id, 'MSG-1');

    const contact = await msg.getContact();
    assert.equal(contact.id._serialized, '77476884956@s.whatsapp.net');
    assert.equal(contact.number, '77476884956');
    assert.equal(contact.pushname, 'Аружан');
    assert.equal(contact.name, 'Аружан');
    assert.equal(contact.isMyContact, false, 'a linked device has no address book');
    assert.equal(contact.isWAContact, true);
    assert.equal(contact.isUser, true);
    assert.equal(contact.isMe, false);
  });
});

test('an inbound image carries the media node the CDN-decrypt path needs', async () => {
  const fake = fakeBaileys();
  const seen = [];

  await withClient('image', fake, async client => {
    client.on('message', msg => seen.push(msg));
    fake.sockets[0].emit('connection.update', { connection: 'open' });
    fake.sockets[0].emit('messages.upsert', {
      type: 'notify',
      messages: [textMessage({ message: { imageMessage: IMAGE_NODE }, key: { remoteJid: '77476884956@s.whatsapp.net', fromMe: false, id: 'IMG-1' } })]
    });

    const msg = seen[0];
    assert.equal(msg.type, 'image');
    assert.equal(msg.hasMedia, true);
    assert.equal(msg.body, 'қарашы', 'a caption is the body, the way wwebjs reports it');
    assert.equal(msg.mimetype, 'image/jpeg');

    // whatsappManager.js:235-296 reads all of these out of _data and hands them
    // to Baileys' downloadContentFromMessage.
    assert.equal(msg._data.directPath, '/v/t62.7118-24/12345?ccb=11-4');
    assert.equal(msg._data.clientUrl, 'https://mmg.whatsapp.net/v/t62.7118-24/12345');
    assert.equal(msg._data.mediaData.directPath, '/v/t62.7118-24/12345?ccb=11-4');
    assert.equal(msg._data.size, 4096);
    // Bytes would not survive the Redis round trip, and verifyMediaFileHash
    // base64-decodes the hash.
    assert.equal(msg.mediaKey, Buffer.from('0123456789abcdef').toString('base64'));
    assert.equal(msg._data.filehash, Buffer.alloc(32, 7).toString('base64'));

    const media = await msg.downloadMedia();
    assert.equal(media.mimetype, 'image/jpeg');
    assert.equal(Buffer.from(media.data, 'base64').toString(), 'decrypted-bytes');
  });
});

test('a voice note is ptt and a plain audio file is not', async () => {
  const fake = fakeBaileys();
  const seen = [];

  await withClient('ptt', fake, async client => {
    client.on('message', msg => seen.push(msg));
    fake.sockets[0].emit('connection.update', { connection: 'open' });
    fake.sockets[0].emit('messages.upsert', {
      type: 'notify',
      messages: [
        textMessage({ key: { remoteJid: '7747@s.whatsapp.net', fromMe: false, id: 'A1' }, message: { audioMessage: { ...IMAGE_NODE, mimetype: 'audio/ogg; codecs=opus', ptt: true } } }),
        textMessage({ key: { remoteJid: '7747@s.whatsapp.net', fromMe: false, id: 'A2' }, message: { audioMessage: { ...IMAGE_NODE, mimetype: 'audio/mpeg' } } })
      ]
    });

    assert.deepEqual(seen.map(msg => msg.type), ['ptt', 'audio']);
    assert.equal(seen[0].hasMedia, true);
  });
});

test("the account's own messages are message_create and never message", async () => {
  const fake = fakeBaileys();
  const inbound = [];
  const outbound = [];

  await withClient('own', fake, async client => {
    client.on('message', msg => inbound.push(msg));
    client.on('message_create', msg => outbound.push(msg));
    fake.sockets[0].emit('connection.update', { connection: 'open' });
    fake.sockets[0].emit('messages.upsert', {
      // 'append' is how the echo of a reply typed on the owner's own phone
      // arrives, which is the operator-handoff signal the manager listens for.
      type: 'append',
      messages: [textMessage({ key: { remoteJid: '77476884956@s.whatsapp.net', fromMe: true, id: 'OUT-1' }, message: { conversation: 'жақсы' }, pushName: undefined })]
    });

    assert.equal(inbound.length, 0, 'emitting an own message as inbound would loop it back through the webhook');
    assert.equal(outbound.length, 1);
    assert.equal(outbound[0].fromMe, true);
    assert.equal(outbound[0].to, '77476884956@s.whatsapp.net', 'the manager resolves the phone from msg.to');
    assert.equal(outbound[0].from, '77000000000@s.whatsapp.net');
    assert.equal(outbound[0].id._serialized, 'true_77476884956@s.whatsapp.net_OUT-1');
  });
});

test('a group message and a status broadcast still reach the manager, which does its own filtering', async () => {
  const fake = fakeBaileys();
  const seen = [];

  await withClient('groups', fake, async client => {
    client.on('message', msg => seen.push(msg));
    fake.sockets[0].emit('connection.update', { connection: 'open' });
    fake.sockets[0].emit('messages.upsert', {
      type: 'notify',
      messages: [
        textMessage({ key: { remoteJid: '12345-6789@g.us', fromMe: false, id: 'G1', participant: '7747@s.whatsapp.net' } }),
        textMessage({ key: { remoteJid: 'status@broadcast', fromMe: false, id: 'S1', participant: '7747@s.whatsapp.net' } })
      ]
    });

    assert.deepEqual(seen.map(msg => msg.from), ['12345-6789@g.us', 'status@broadcast']);
    assert.equal(seen[0].author, '7747@s.whatsapp.net', 'wwebjs puts the group sender in author');
    assert.equal(seen[0].isGroupMsg, true);
  });
});

test('acks are renumbered to wwebjs, off-by-one included, and a failure is -1', async () => {
  const fake = fakeBaileys();
  const acks = [];

  await withClient('acks', fake, async client => {
    client.on('message_ack', (msg, ack) => acks.push([msg.id.id, ack]));
    fake.sockets[0].emit('connection.update', { connection: 'open' });

    const key = { remoteJid: '77476884956@s.whatsapp.net', fromMe: true, id: 'ACK-1' };
    fake.sockets[0].emit('messages.upsert', { type: 'append', messages: [textMessage({ key, message: { conversation: 'hi' } })] });

    // Baileys PENDING=1 SERVER_ACK=2 DELIVERY_ACK=3 READ=4 PLAYED=5;
    // wwebjs PENDING=0 SERVER=1 DEVICE=2 READ=3 PLAYED=4. The manager thresholds
    // at >= 3 -> read, so passing the wire number through would report every
    // delivered message as read.
    fake.sockets[0].emit('messages.update', [{ key, update: { status: 1 } }]);
    fake.sockets[0].emit('messages.update', [{ key, update: { status: 2 } }]);
    fake.sockets[0].emit('messages.update', [{ key, update: { status: 3 } }]);
    fake.sockets[0].emit('messages.update', [{ key, update: { status: 4 } }]);
    fake.sockets[0].emit('messages.update', [{ key, update: { status: 5 } }]);
    // A rejected message: ERROR=0 must become -1 so it can be shown as failed
    // rather than sitting at 'sent' forever.
    fake.sockets[0].emit('messages.update', [{ key, update: { status: 0 } }]);
    // Enum names arrive instead of numbers on some paths.
    fake.sockets[0].emit('messages.update', [{ key, update: { status: 'READ' } }]);
    // An update with no status at all is not an ack.
    fake.sockets[0].emit('messages.update', [{ key, update: { reactions: [] } }]);

    assert.deepEqual(acks.map(entry => entry[1]), [0, 1, 2, 3, 4, -1, 3]);
    assert.equal(acks[0][0], 'ACK-1');
    assert.equal(__test.ackFromStatus(undefined), null);
  });
});

test('an ack for a message this process never saw still resolves a phone', async () => {
  const fake = fakeBaileys();
  const acks = [];

  await withClient('coldack', fake, async client => {
    client.on('message_ack', (msg, ack) => acks.push({ to: msg.to, id: msg.id.id, fromMe: msg.fromMe, ack }));
    fake.sockets[0].emit('connection.update', { connection: 'open' });
    fake.sockets[0].emit('messages.update', [{
      key: { remoteJid: '77476884956@s.whatsapp.net', fromMe: true, id: 'OLD-1' },
      update: { status: 3 }
    }]);

    assert.equal(acks.length, 1);
    assert.equal(acks[0].to, '77476884956@s.whatsapp.net');
    assert.equal(acks[0].fromMe, true);
    assert.equal(acks[0].ack, 2);
  });
});

test('only the phone unlinking the device is terminal; a 408 reconnects with backoff', async () => {
  const unlinked = fakeBaileys();
  const reasons = [];

  await withClient('unlink', unlinked, async client => {
    client.on('disconnected', reason => reasons.push(reason));
    unlinked.sockets[0].emit('connection.update', { connection: 'open' });
    unlinked.sockets[0].emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 401 } } }
    });

    // The manager matches on LOGOUT / UNPAIRED to clear the session folder.
    assert.deepEqual(reasons, ['LOGOUT']);
    await new Promise(resolve => setTimeout(resolve, 2300));
    assert.equal(unlinked.sockets.length, 1, 'an unlink must not retry forever');
  }, { watchdogMs: 150 });

  const blip = fakeBaileys();
  const blipReasons = [];
  await withClient('blip', blip, async client => {
    client.on('disconnected', reason => blipReasons.push(reason));
    blip.sockets[0].emit('connection.update', { connection: 'open' });
    blip.sockets[0].emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 408 } } }
    });

    assert.deepEqual(blipReasons, [], 'a blip reported as disconnected would make the manager wipe the session');
    assert.equal(blip.sockets.length, 1, 'the retry is armed, not immediate');

    await new Promise(resolve => setTimeout(resolve, 2300));
    assert.equal(blip.sockets.length, 2, 'the client reconnected on its own');

    blip.sockets[1].emit('connection.update', { connection: 'open' });
    assert.equal(client.getState(), 'CONNECTED', 'a successful reconnect is a live client again');
  });

  assert.equal(__test.reconnectDelay(1), 2000);
  assert.equal(__test.reconnectDelay(2), 4000);
  assert.equal(__test.reconnectDelay(3), 8000);
  assert.equal(__test.reconnectDelay(50), 60000, 'a phone left off must not spin at full speed');
});

test('a corrupt session is reported as auth_failure so the manager can reset it', async () => {
  const fake = fakeBaileys();
  const failures = [];

  await withClient('badsession', fake, async client => {
    client.on('auth_failure', reason => failures.push(String(reason)));
    fake.sockets[0].emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 500 } } }
    });

    assert.equal(failures.length, 1);
    assert.match(failures[0], /bad_session/);
  });
});

test('a stale socket that keeps firing after a reconnect is ignored', async () => {
  const fake = fakeBaileys();
  const seen = [];

  await withClient('stale', fake, async client => {
    client.on('message', msg => seen.push(msg.id.id));
    fake.sockets[0].emit('connection.update', { connection: 'open' });
    fake.sockets[0].emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 440 } } }
    });
    await new Promise(resolve => setTimeout(resolve, 2300));
    assert.equal(fake.sockets.length, 2);

    // A late event on the previous generation would forward the same message to
    // the webhook twice.
    fake.sockets[0].emit('messages.upsert', { type: 'notify', messages: [textMessage({ key: { remoteJid: '7747@s.whatsapp.net', fromMe: false, id: 'OLD' } })] });
    fake.sockets[1].emit('messages.upsert', { type: 'notify', messages: [textMessage({ key: { remoteJid: '7747@s.whatsapp.net', fromMe: false, id: 'NEW' } })] });

    assert.deepEqual(seen, ['NEW']);
  });
});

test('a destroyed client is deaf, timers and all', async () => {
  const fake = fakeBaileys();
  const seen = [];
  __test._setBaileysForTest(fake.loader);
  const authDir = tmpAuthDir('destroy');
  const client = new BaileysClient({ instanceId: 'destroy', authDir, logger: quietLogger, watchdogMs: 150 });

  try {
    await client.initialize();
    client.on('message', msg => seen.push(msg.id.id));
    fake.sockets[0].emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 428 } } }
    });

    await client.destroy();
    assert.equal(client.getState(), null);

    fake.sockets[0].emit('messages.upsert', { type: 'notify', messages: [textMessage({ key: { remoteJid: '7747@s.whatsapp.net', fromMe: false, id: 'AFTER' } })] });
    await new Promise(resolve => setTimeout(resolve, 2300));

    assert.deepEqual(seen, []);
    assert.equal(fake.sockets.length, 1, 'a destroyed client must not reopen a socket');
  } finally {
    __test._setBaileysForTest(null);
    fs.rmSync(authDir, { recursive: true, force: true });
  }
});

test('sendMessage takes text and takes a MessageMedia, and both answer with id.id', async () => {
  const fake = fakeBaileys();

  await withClient('send', fake, async client => {
    fake.sockets[0].emit('connection.update', { connection: 'open' });

    // The manager builds chat ids with phoneUtils, which speaks wwebjs's @c.us.
    const text = await client.sendMessage('77476884956@c.us', 'сәлем');
    assert.equal(fake.sentMessages[0].jid, '77476884956@s.whatsapp.net', '@c.us would not be routed by Baileys');
    assert.deepEqual(fake.sentMessages[0].content, { text: 'сәлем' });
    assert.equal(text.id.id, 'SENT-1');
    assert.equal(text.fromMe, true);
    assert.equal(text.ack, 0, 'Baileys PENDING=1 is wwebjs PENDING=0');

    const media = new MessageMedia('image/jpeg', Buffer.from('jpeg-bytes').toString('base64'), 'kaspi.jpg');
    const image = await client.sendMessage('77476884956@c.us', media, { caption: 'чек' });
    assert.equal(fake.sentMessages[1].content.caption, 'чек');
    assert.equal(fake.sentMessages[1].content.image.toString(), 'jpeg-bytes');
    assert.equal(image.id.id, 'SENT-2');

    const voice = new MessageMedia('audio/ogg; codecs=opus', Buffer.from('ogg').toString('base64'), 'v.ogg');
    await client.sendMessage('77476884956@c.us', voice, { sendAudioAsVoice: true });
    assert.equal(fake.sentMessages[2].content.ptt, true, 'an audio reply is meant to be a voice note');
    assert.equal(fake.sentMessages[2].content.mimetype, 'audio/ogg');

    const doc = new MessageMedia('application/pdf', Buffer.from('%PDF-1.4').toString('base64'), 'receipt.pdf');
    await client.sendMessage('77476884956@c.us', doc);
    assert.equal(fake.sentMessages[3].content.fileName, 'receipt.pdf');
    assert.equal(fake.sentMessages[3].content.document.toString(), '%PDF-1.4');

    // A data-URL prefix is what the panel sends; it must not end up in the bytes.
    await client.sendMessage('77476884956@c.us', new MessageMedia('image/png', `data:image/png;base64,${Buffer.from('png').toString('base64')}`, 'a.png'));
    assert.equal(fake.sentMessages[4].content.image.toString(), 'png');
  });
});

test('a call offer is rejected over the socket that saw it, with both ids', async () => {
  const fake = fakeBaileys();
  const calls = [];

  await withClient('calls', fake, async client => {
    client.on('call', call => calls.push(call));
    fake.sockets[0].emit('connection.update', { connection: 'open' });
    fake.sockets[0].emit('call', [{ id: 'CALL-1', from: '77476884956:9@s.whatsapp.net', chatId: '77476884956@s.whatsapp.net', status: 'offer', isVideo: true, date: new Date(1770000000000) }]);
    // The tail of a call already over would double-greet the caller.
    fake.sockets[0].emit('call', [{ id: 'CALL-1', from: '77476884956@s.whatsapp.net', status: 'terminate' }]);
    fake.sockets[0].emit('call', [{ id: 'CALL-2', from: '77476884956@s.whatsapp.net', status: 'offer', fromMe: true }]);

    assert.deepEqual(calls.map(call => call.id), ['CALL-1']);
    const call = calls[0];
    assert.equal(call.from, '77476884956@s.whatsapp.net', 'the device suffix must be stripped');
    assert.equal(call.isVideo, true);
    assert.equal(call.isGroup, false);
    // wwebjs needed wa-js injected before the server would take its rejection;
    // on this socket the stanza is ours to send.
    assert.equal(call.canHandleLocally, true);

    assert.equal(await call.reject(), true);
    assert.deepEqual(fake.rejectedCalls, [['CALL-1', '77476884956@s.whatsapp.net']]);

    assert.equal(await client.rejectCall('CALL-9', ''), false, 'both ids are required');
    assert.equal(await client.rejectCall('', '7747@s.whatsapp.net'), false);
    assert.equal(fake.rejectedCalls.length, 1);
  });
});

test('the chat handle answers the four things the manager asks of it', async () => {
  const fake = fakeBaileys();
  const presence = [];
  const reads = [];

  await withClient('chat', fake, async client => {
    fake.sockets[0].emit('connection.update', { connection: 'open' });
    fake.sockets[0].sendPresenceUpdate = async (state, jid) => presence.push([state, jid]);
    fake.sockets[0].readMessages = async keys => reads.push(keys.map(key => key.id));
    fake.sockets[0].emit('messages.upsert', { type: 'notify', messages: [textMessage()] });

    const chat = await client.getChatById('77476884956@c.us');
    assert.equal(chat.id._serialized, '77476884956@s.whatsapp.net');
    assert.equal(await chat.sendStateTyping(), true);
    assert.deepEqual(presence, [['composing', '77476884956@s.whatsapp.net']]);
    assert.equal(await chat.sendSeen(), true);
    assert.deepEqual(reads, [['MSG-1']]);

    const history = await chat.fetchMessages({ limit: 10 });
    assert.deepEqual(history.map(msg => msg.id.id), ['MSG-1']);

    const found = await client.getMessageById('false_77476884956@s.whatsapp.net_MSG-1');
    assert.equal(found?.id?.id, 'MSG-1');
    assert.equal(await client.getMessageById('false_7747@c.us_NOPE'), null);
  });
});

test('LID mapping is answered from Baileys, and an unknown jid is an empty list rather than a throw', async () => {
  const fake = fakeBaileys();

  await withClient('lid', fake, async client => {
    fake.sockets[0].emit('connection.update', { connection: 'open' });
    fake.sockets[0].signalRepository.lidMapping = {
      getPNsForLIDs: async lids => lids.map(lid => ({ pn: '77476884956@s.whatsapp.net', lid })),
      getLIDsForPNs: async pns => pns.map(pn => ({ pn, lid: '99887766@lid' }))
    };

    const byLid = await client.getContactLidAndPhone(['12345@lid']);
    assert.deepEqual(byLid, [{ pn: '77476884956@s.whatsapp.net', lid: '12345@lid' }]);

    // The manager asks with @c.us; Baileys only knows @s.whatsapp.net.
    const byPhone = await client.getContactLidAndPhone(['77476884956@c.us']);
    assert.deepEqual(byPhone, [{ pn: '77476884956@s.whatsapp.net', lid: '99887766@lid' }]);

    fake.sockets[0].signalRepository.lidMapping = {
      getPNsForLIDs: async () => { throw new Error('store unavailable'); },
      getLIDsForPNs: async () => null
    };
    fake.sockets[0].onWhatsApp = async () => [{ jid: '77476884956@s.whatsapp.net', exists: true }];
    assert.deepEqual(
      await client.getContactLidAndPhone(['77476884956@c.us']),
      [{ pn: '77476884956@s.whatsapp.net', lid: '' }]
    );

    fake.sockets[0].onWhatsApp = async () => { throw new Error('offline'); };
    assert.deepEqual(await client.getContactLidAndPhone(['1@lid']), [], 'a failed lookup must not throw at the manager');
    assert.deepEqual(await client.getContactLidAndPhone([]), []);

    const contact = await client.getContactById('77476884956@c.us');
    assert.equal(contact.id._serialized, '77476884956@s.whatsapp.net');
    assert.equal(contact.isMyContact, false);
  });
});

test('a listener that throws does not take the socket down with it', async () => {
  const fake = fakeBaileys();
  const seen = [];

  await withClient('defensive', fake, async client => {
    client.on('message', () => { throw new Error('handler exploded'); });
    client.on('ready', () => seen.push('ready'));
    fake.sockets[0].emit('connection.update', { connection: 'open' });
    fake.sockets[0].emit('messages.upsert', { type: 'notify', messages: [textMessage()] });
    // Still alive, still connected, still delivering.
    assert.equal(client.getState(), 'CONNECTED');
    assert.deepEqual(seen, ['ready']);
  });
});
