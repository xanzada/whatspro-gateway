'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { __test, rejectViaSocket } = require('../services/callWatcher');

// The watcher exists because a linked web session never receives a call offer.
// These cover the two decisions it makes on its own: which socket events are a
// live incoming call, and how it rejects one.

test('only a live incoming offer is treated as a call', () => {
  const { isIncomingOffer } = __test;

  assert.equal(isIncomingOffer({ id: 'a', from: '77001234567@s.whatsapp.net' }), true);
  assert.equal(isIncomingOffer({ id: 'a', status: 'offer' }), true);
  assert.equal(isIncomingOffer({ id: 'a', status: 'ringing' }), true);

  // The tail of a call already over would double-greet the caller.
  assert.equal(isIncomingOffer({ id: 'a', status: 'terminate' }), false);
  assert.equal(isIncomingOffer({ id: 'a', status: 'reject' }), false);
  assert.equal(isIncomingOffer({ id: 'a', status: 'accept' }), false);

  assert.equal(isIncomingOffer({ id: 'a', fromMe: true }), false);
  assert.equal(isIncomingOffer({ id: 'a', outgoing: true }), false);
  assert.equal(isIncomingOffer({ id: 'a', isGroup: true }), false);
  assert.equal(isIncomingOffer(null), false);
});

test('rejection goes over the socket that saw the offer, with both ids', async () => {
  const calls = [];
  const sock = { rejectCall: async (id, from) => { calls.push([id, from]); } };

  const ok = await rejectViaSocket(sock, { id: 'CALL-1', from: '77001234567@s.whatsapp.net' });

  assert.equal(ok, true);
  assert.deepEqual(calls, [['CALL-1', '77001234567@s.whatsapp.net']]);
});

test('an incomplete call or a socket without rejectCall reports failure rather than throwing', async () => {
  assert.equal(await rejectViaSocket(null, { id: 'a', from: 'b' }), false);
  assert.equal(await rejectViaSocket({}, { id: 'a', from: 'b' }), false);
  assert.equal(await rejectViaSocket({ rejectCall: async () => {} }, { id: 'a' }), false);
  assert.equal(await rejectViaSocket({ rejectCall: async () => {} }, { from: 'b' }), false);
});

test('reconnect backs off and stays bounded', () => {
  const { reconnectDelay } = __test;

  assert.equal(reconnectDelay(1), 2000);
  assert.equal(reconnectDelay(2), 4000);
  assert.equal(reconnectDelay(3), 8000);
  // A tenant whose phone stays off must not spin at full speed forever.
  assert.equal(reconnectDelay(50), 60000);
});

// The lifecycle below is the actual promise made to a restaurant: once scanned,
// the watcher stays up on its own. These drive the real startCallWatcher with a
// fake Baileys, so a regression in the reconnect chain fails here.

const os = require('os');
const fs = require('fs');
const pathMod = require('path');
const { startCallWatcher, stopCallWatcher, callWatcherStatus } = require('../services/callWatcher');

function fakeBaileys(onSocket) {
  const sockets = [];
  const loader = async () => ({
    default: () => {
      const listeners = new Map();
      const sock = {
        ev: {
          on: (name, fn) => { listeners.set(name, [...(listeners.get(name) || []), fn]); },
          removeAllListeners: () => listeners.clear()
        },
        end: () => {},
        rejectCall: async () => {},
        emit: (name, payload) => { for (const fn of listeners.get(name) || []) fn(payload); }
      };
      sockets.push(sock);
      if (onSocket) onSocket(sock);
      return sock;
    },
    useMultiFileAuthState: async () => ({ state: {}, saveCreds: async () => {} }),
    fetchLatestBaileysVersion: async () => ({ version: [2, 3, 4] }),
    DisconnectReason: { loggedOut: 401 },
    Browsers: { ubuntu: () => ['Ubuntu', 'Chrome', '120'] }
  });
  return { loader, sockets };
}

const quietLogger = { log: () => {}, warn: () => {}, error: () => {} };

function tmpAuthDir(name) {
  return fs.mkdtempSync(pathMod.join(os.tmpdir(), `cw-${name}-`));
}

async function withWatcher(instanceId, fake, run, options = {}) {
  __test._setBaileysForTest(fake.loader);
  const authDir = tmpAuthDir(instanceId);
  try {
    await startCallWatcher(instanceId, { authDir, logger: quietLogger, ...options });
    await run();
  } finally {
    stopCallWatcher(instanceId);
    __test._setBaileysForTest(null);
    fs.rmSync(authDir, { recursive: true, force: true });
  }
}

test('a dropped socket reconnects itself without any human action', async () => {
  const fake = fakeBaileys();

  await withWatcher('reconnects', fake, async () => {
    fake.sockets[0].emit('connection.update', { connection: 'open' });
    assert.equal(callWatcherStatus('reconnects').connected, true);

    // 428 is what WhatsApp sends on an ordinary network blip.
    fake.sockets[0].emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 428 } } }
    });

    assert.equal(callWatcherStatus('reconnects').connected, false);
    assert.equal(callWatcherStatus('reconnects').reconnecting, true, 'a retry must be armed');

    await new Promise(resolve => setTimeout(resolve, 2200));
    assert.equal(fake.sockets.length, 2, 'the watcher must have opened a fresh socket');

    fake.sockets[1].emit('connection.update', { connection: 'open' });
    const status = callWatcherStatus('reconnects');
    assert.equal(status.connected, true);
    assert.equal(status.attempts, 0, 'a successful reconnect resets the backoff');
    assert.equal(status.loggedOut, false, 'a blip must never look like an unlink');
  });
});

test('only the phone unlinking the device stops the watcher', async () => {
  const fake = fakeBaileys();
  const unlinked = [];

  await withWatcher('unlinked', fake, async () => {
    fake.sockets[0].emit('connection.update', { connection: 'open' });
    fake.sockets[0].emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 401 } } }
    });

    const status = callWatcherStatus('unlinked');
    assert.equal(status.loggedOut, true);
    assert.equal(status.reconnecting, false, 'an unlink must not retry forever');
    assert.deepEqual(unlinked, ['unlinked'], 'the platform is told a rescan is needed');

    await new Promise(resolve => setTimeout(resolve, 2200));
    assert.equal(fake.sockets.length, 1, 'no socket is reopened after an unlink');
  }, { onLoggedOut: id => unlinked.push(id) });
});

test('a call offer reaches the handler with the socket that saw it', async () => {
  const fake = fakeBaileys();
  const seen = [];

  await withWatcher('offers', fake, async () => {
    fake.sockets[0].emit('connection.update', { connection: 'open' });
    fake.sockets[0].emit('call', [{ id: 'C1', from: '77476884956@s.whatsapp.net', status: 'offer' }]);

    assert.equal(seen.length, 1);
    assert.equal(seen[0].call.id, 'C1');
    assert.equal(seen[0].sock, fake.sockets[0], 'rejection must go over the same socket');
  }, { onIncomingCall: (call, sock) => { seen.push({ call, sock }); } });
});

test('a stale socket that keeps firing is ignored after a reconnect', async () => {
  const fake = fakeBaileys();
  const seen = [];

  await withWatcher('stale', fake, async () => {
    fake.sockets[0].emit('connection.update', { connection: 'open' });
    fake.sockets[0].emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 440 } } }
    });
    await new Promise(resolve => setTimeout(resolve, 2200));
    assert.equal(fake.sockets.length, 2);

    // The old socket is a previous generation; a late event on it would
    // otherwise hand the same call to the rejection ladder twice.
    fake.sockets[0].emit('call', [{ id: 'OLD', from: '7747@s.whatsapp.net', status: 'offer' }]);
    fake.sockets[1].emit('call', [{ id: 'NEW', from: '7747@s.whatsapp.net', status: 'offer' }]);

    assert.deepEqual(seen.map(c => c.id), ['NEW']);
  }, { onIncomingCall: call => { seen.push(call); } });
});

test('a QR waiting to be scanned is left alone by the watchdog', async () => {
  const fake = fakeBaileys();
  const codes = [];

  await withWatcher('scanning', fake, async () => {
    fake.sockets[0].emit('connection.update', { connection: 'connecting', qr: 'QR-1' });
    assert.deepEqual(codes, ['QR-1']);
    assert.equal(callWatcherStatus('scanning').awaitingScan, true);

    // The watchdog is wound down to 150ms here, so this window covers several
    // of its cycles. Tearing the socket down would invalidate the code mid-scan.
    await new Promise(resolve => setTimeout(resolve, 700));
    assert.equal(
      callWatcherStatus('scanning').reconnecting, false,
      'the watchdog must not even arm a retry while a scan is pending'
    );
    assert.equal(fake.sockets.length, 1, 'the socket showing the QR must survive');
    assert.deepEqual(codes, ['QR-1'], 'the code on screen must not be replaced');

    fake.sockets[0].emit('connection.update', { connection: 'open' });
    const status = callWatcherStatus('scanning');
    assert.equal(status.awaitingScan, false, 'a landed scan clears the flag');
    assert.equal(status.connected, true);
  }, { onQr: qr => codes.push(qr), watchdogMs: 150 });
});

test('a connect that throws still leaves a retry armed', async () => {
  let attempts = 0;
  const fake = fakeBaileys();
  const failingLoader = async () => {
    const real = await fake.loader();
    return {
      ...real,
      default: (...args) => {
        attempts += 1;
        if (attempts === 1) throw new Error('socket construction failed');
        return real.default(...args);
      }
    };
  };

  __test._setBaileysForTest(failingLoader);
  const authDir = tmpAuthDir('throws');
  try {
    await startCallWatcher('throws', { authDir, logger: quietLogger });
    // The first connect blew up. Before, that took the retry chain down with
    // it and the tenant stayed dark until a redeploy.
    assert.equal(callWatcherStatus('throws').reconnecting, true);

    await new Promise(resolve => setTimeout(resolve, 2200));
    assert.equal(attempts, 2, 'the watcher retried on its own');
    assert.equal(callWatcherStatus('throws').watching, true);
  } finally {
    stopCallWatcher('throws');
    __test._setBaileysForTest(null);
    fs.rmSync(authDir, { recursive: true, force: true });
  }
});

test('stopping the watcher really stops it, timers and all', async () => {
  const fake = fakeBaileys();
  __test._setBaileysForTest(fake.loader);
  const authDir = tmpAuthDir('stops');

  try {
    await startCallWatcher('stops', { authDir, logger: quietLogger });
    fake.sockets[0].emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 428 } } }
    });
    assert.equal(callWatcherStatus('stops').reconnecting, true);

    assert.equal(stopCallWatcher('stops'), true);
    assert.deepEqual(callWatcherStatus('stops'), {
      watching: false, connected: false, loggedOut: false,
      awaitingScan: false, reconnecting: false, attempts: 0
    });

    await new Promise(resolve => setTimeout(resolve, 2200));
    assert.equal(fake.sockets.length, 1, 'a stopped watcher must not reopen a socket');
    assert.equal(__test._getWatchersForTest().has('stops'), false);
  } finally {
    __test._setBaileysForTest(null);
    fs.rmSync(authDir, { recursive: true, force: true });
  }
});
