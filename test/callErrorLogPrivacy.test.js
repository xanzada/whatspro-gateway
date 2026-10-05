'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const Module = require('node:module'), { EventEmitter } = require('node:events');
const authFixture = path.join(os.tmpdir(), 'call-error-privacy-auth-' + process.pid);
process.env.WHATSAPP_AUTH_PATH = authFixture;
process.env.WHATSPRO_TRANSPORT = 'baileys';
process.env.WHATSPRO_TEST_MODE_ENABLED = 'false';
const manager = require('../services/whatsappManager');
const { redisClient } = require('../config/redis');
const phone = '77000000009', lid = '991234567890129@lid';
const body = 'SYNTHETIC_PRIVATE_BODY', token = 'SYNTHETIC_TOKEN';
const privateError = () => Object.assign(new Error(body + ' Bearer ' + token + ' ' + phone), { code: 'ECONNRESET' });
const call = () => ({ id: token + '-' + phone, from: lid });
let logs, localRejects, localSends, modules;
function assertPrivacy() {
  const text = logs.join('\n');
  for (const value of [phone, lid, body, token, 'Bearer'])
    assert.equal(text.includes(value), false, 'call diagnostic contains private fixture data');
}
function loadActualManager(t, transport = 'baileys', clientType) {
  const filename = require.resolve('../services/whatsappManager');
  const previous = process.env.WHATSPRO_TRANSPORT;
  process.env.WHATSPRO_TRANSPORT = transport;
  if (clientType) {
    const originalLoad = Module._load;
    t.mock.method(Module, '_load', function (request, parent, isMain) {
      if (parent?.filename === filename && request === 'whatsapp-web.js')
        return { Client: clientType, LocalAuth: class LocalAuth {} };
      if (parent?.filename === filename && request === './callWatcher')
        return { startCallWatcher: async () => {}, stopCallWatcher() {}, callWatcherStatus: () => ({ connected: false }) };
      return originalLoad.call(this, request, parent, isMain);
    });
  }
  const fixture = new Module(filename, module);
  fixture.filename = filename; fixture.paths = Module._nodeModulePaths(path.dirname(filename));
  // Exact product source, with a test-only access suffix; functions are not transformed.
  fixture._compile(fs.readFileSync(filename, 'utf8') +
    '\nmodule.exports.__test.callPrivacy={ensureWppCallApi,readWppCallBundle,reportCallHookHealth};', filename);
  process.env.WHATSPRO_TRANSPORT = previous;
  modules.push(fixture.exports);
  return fixture.exports;
}
function localPage(callApi, options = {}) {
  let stage = 0;
  global.window = options.ready ? { WPP: { isReady: true, call: callApi } } : {};
  return { evaluate: async (fnOrSource, ...args) => {
    const current = stage++;
    if (typeof fnOrSource === 'string') {
      if (options.injectError) throw privateError();
      global.window.WPP = { isReady: true, call: callApi, loader: { loaderType: options.loader || 'meta' } };
      return undefined;
    }
    if (options.waitError && current === 2) throw privateError();
    return fnOrSource(...args);
  } };
}
test.beforeEach(t => {
  logs = []; localRejects = 0; localSends = 0; modules = [];
  for (const name of ['log', 'warn', 'error'])
    t.mock.method(console, name, (...args) => logs.push(args.map(String).join(' ')));
  Object.defineProperty(redisClient, 'isOpen', { configurable: true, value: false });
});
test.afterEach(async () => {
  for (const m of modules)
    for (const instance of m.clients.keys()) {
      m.__test.clearPendingTextQueue(instance); m.__test.clearRestartTimer(instance);
      await m.stopWhatsAppInstance(instance, { wipeCredentials: false });
    }
  manager.__test.seenCallIds.clear(); delete redisClient.isOpen; delete global.window;
  assert.equal(localSends, 0, 'no fake transport send is allowed');
});
test.after(() => fs.rmSync(authFixture, { recursive: true, force: true }));
test('actual inner rejection catch preserves policy blocking and hides transport error data', async () => {
  const result = await manager.__test.handleIncomingCall('call-inner-fixture', {}, call(), {
    tenantAdmin: { findRow: async () => ({ calls_disabled: true }) },
    rejectCall: async () => { localRejects++; throw privateError(); },
    getTestModePolicy: async () => ({ enabled: true }),
    resolvePhone: async () => phone, isPhoneAllowed: async () => false,
    deliverText: async () => { localSends++; throw new Error('unexpected send'); }
  });
  assert.equal(result.rejected, false); assert.equal(result.replied, false);
  assert.equal(result.reason, 'test_mode_blocked'); assert.equal(localRejects, 1);
  assertPrivacy(); assert.ok(logs.some(x => x.includes('CALL_REJECTION_FAILED') && x.includes('ECONNRESET')));
});
test('actual cold bundle evaluation failure preserves unavailable result with safe diagnostics', async t => {
  const m = loadActualManager(t), page = localPage({}, { injectError: true });
  assert.equal(await m.__test.callPrivacy.ensureWppCallApi({ pupPage: page }), false);
  assertPrivacy();
});
test('actual readiness wait failure preserves unavailable result with safe diagnostics', async t => {
  const m = loadActualManager(t), page = localPage({}, { waitError: true });
  assert.equal(await m.__test.callPrivacy.ensureWppCallApi({ pupPage: page }), false);
  assertPrivacy();
});
for (const ready of [true, false]) {
  test('actual ' + (ready ? 'warm' : 'cold') + ' interface failure preserves ready return and hides serialized error', async t => {
    const m = loadActualManager(t), page = localPage({ enableCallInterface: async () => { throw privateError(); } }, { ready });
    assert.equal(await m.__test.callPrivacy.ensureWppCallApi({ pupPage: page }), true);
    assertPrivacy();
  });
}
test('actual reject ladder readiness failure still attempts native fallback without private error', async () => {
  const result = await manager.__test.rejectIncomingCallReliably({
    pupPage: { evaluate() { throw privateError(); } }
  }, { ...call(), reject: async () => { localRejects++; } });
  assert.equal(result, true); assert.equal(localRejects, 1);
  assertPrivacy();
});
test('actual native rejection failure returns false and hides raw exception body', async () => {
  const result = await manager.__test.rejectIncomingCallReliably({}, {
    ...call(), reject: async () => { localRejects++; throw privateError(); }
  });
  assert.equal(result, false); assert.equal(localRejects, 1); assertPrivacy();
});
test('actual serialized WPP rejection failure preserves fallback and hides private outcome', async () => {
  const page = localPage({
    enableCallInterface: async () => {},
    reject: async () => { localRejects++; throw privateError(); }
  }, { ready: true });
  const result = await manager.__test.rejectIncomingCallReliably({ pupPage: page }, {
    ...call(), reject: async () => { localRejects++; }
  });
  assert.equal(result, true); assert.equal(localRejects, 2); assertPrivacy();
});
test('actual confirmed WPP rejection keeps true outcome without logging call ID', async () => {
  const page = localPage({
    enableCallInterface: async () => {},
    reject: async () => { localRejects++; return true; }
  }, { ready: true });
  const result = await manager.__test.rejectIncomingCallReliably({ pupPage: page }, call());
  assert.equal(result, true); assert.equal(localRejects, 1); assertPrivacy();
});
test('actual raw WWebJS bridge preserves successful fallback without logging call ID', async () => {
  global.window = { WWebJS: { rejectCall: async () => { localRejects++; } } };
  const page = { evaluate: async (fn, ...args) => {
    if (args.length === 2) return fn(...args);
    return false;
  } };
  const result = await manager.__test.rejectIncomingCallReliably({ pupPage: page }, call());
  assert.equal(result, true); assert.equal(localRejects, 1); assertPrivacy();
});
test('actual call hook health failure emits safe error metadata', async t => {
  const m = loadActualManager(t);
  await m.__test.callPrivacy.reportCallHookHealth('call-hook-fixture', {
    pupPage: { evaluate: async () => { throw privateError(); } }
  });
  assertPrivacy();
});
test('actual missing call bundle keeps empty fallback and does not log private read error', async t => {
  const m = loadActualManager(t), originalRead = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', function (filename, ...args) {
    if (String(filename).endsWith('wppconnect-wa.js')) throw privateError();
    return originalRead.call(this, filename, ...args);
  });
  assert.equal(m.__test.callPrivacy.readWppCallBundle(), '');
  assertPrivacy();
});
test('actual startup ready callback catches call preload failure without private diagnostic', async t => {
  class LocalClient extends EventEmitter {
    constructor() { super(); this.pupPage = { evaluate() { throw privateError(); } }; }
    async initialize() { this.emit('ready'); }
    async destroy() {}
    async getState() { return 'CONNECTED'; }
  }
  const m = loadActualManager(t, 'wwebjs', LocalClient);
  assert.equal((await m.startWhatsAppInstance('call-preload-fixture')).success, true);
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(m.clients.get('call-preload-fixture') instanceof LocalClient);
  assertPrivacy();
});
test('actual loader metadata remains bounded even if page returns private data', async t => {
  const m = loadActualManager(t), page = localPage({ enableCallInterface: async () => {} }, { loader: body + token + phone });
  assert.equal(await m.__test.callPrivacy.ensureWppCallApi({ pupPage: page }), true);
  assertPrivacy();
});
