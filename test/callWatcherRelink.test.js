'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// The watcher keeps its credentials on disk, so this has to be pointed at a
// throwaway directory before the manager reads the path at load time.
const AUTH_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-relink-'));
process.env.WHATSAPP_AUTH_PATH = AUTH_ROOT;

const { __test: wa } = require('../services/whatsappManager');
const callWatcher = require('../services/callWatcher');

// An unlink is the one close code the watcher will not retry, by design: dead
// credentials cannot be reconnected, only rescanned. So somebody has to ask for
// that rescan, and before this the answer was "a redeploy".

function fakeBaileys() {
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
      return sock;
    },
    useMultiFileAuthState: async () => ({ state: {}, saveCreds: async () => {} }),
    fetchLatestBaileysVersion: async () => ({ version: [2, 3, 4] }),
    DisconnectReason: { loggedOut: 401 },
    Browsers: { ubuntu: () => ['Ubuntu', 'Chrome', '120'] }
  });
  return { loader, sockets };
}

async function waitFor(check, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return false;
}

test('an unlinked watcher clears its dead credentials and comes back asking for a scan', async () => {
  const fake = fakeBaileys();
  callWatcher.__test._setBaileysForTest(fake.loader);
  const instanceId = 'relinks';

  try {
    await wa.startCallWatcherFor(instanceId, {});
    assert.equal(fake.sockets.length, 1);

    const authDir = wa.callWatcherAuthDir(instanceId);
    assert.equal(fs.existsSync(authDir), true, 'the watcher stores credentials on disk');

    // A code was handed out and is now on screen; the unlink invalidates it.
    fake.sockets[0].emit('connection.update', { connection: 'connecting', qr: 'QR-OLD' });
    assert.equal(wa.callWatcherQrs.has(instanceId), true);

    fake.sockets[0].emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 401 } } }
    });

    assert.equal(
      await waitFor(() => fake.sockets.length === 2), true,
      'the watcher must be brought back up rather than left parked'
    );
    assert.equal(wa.callWatcherQrs.has(instanceId), false, 'the invalidated code is dropped');
    assert.equal(callWatcher.callWatcherStatus(instanceId).loggedOut, false, 'the fresh socket is not logged out');

    // A phone that keeps refusing the device must not turn into socket churn.
    fake.sockets[1].emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 401 } } }
    });
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(fake.sockets.length, 2, 'the relink cooldown holds the second attempt back');
  } finally {
    callWatcher.stopCallWatcher(instanceId);
    wa.callWatcherQrs.delete(instanceId);
    wa.callWatcherRelinks.delete(instanceId);
    callWatcher.__test._setBaileysForTest(null);
    fs.rmSync(AUTH_ROOT, { recursive: true, force: true });
  }
});
