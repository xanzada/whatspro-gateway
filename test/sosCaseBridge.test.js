'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { createClient } = require('redis');
const { createSosStore } = require('../services/sosStore');
const { redisClient } = require('../config/redis');
const { chatStore } = require('../services/chatStore');
process.env.WHATSPRO_TEST_MODE_ENABLED = 'false';
const effectWalDir = require('node:os').tmpdir() + '/sos-effect-route-' + process.pid;
process.env.WHATSPRO_SEND_WAL_DIR = effectWalDir;
const { app } = require('../src/server');
const enabled = Boolean(process.env.AUDIT_REDIS_SOCKET);
const real = enabled ? createClient({ socket: { path: process.env.AUDIT_REDIS_SOCKET, reconnectStrategy: false }, disableOfflineQueue: true }) : null;
const instance = 'sos-bridge-fixture';
const phone = '77000000002';
const otherPhone = '77000000003';
const markerKey = () => 'chatwoot:sos:' + instance + ':' + phone;
const unreadKey = () => 'chatwoot:sos-unread:' + instance + ':' + phone;
const activeKey = () => 'operator_case_active:' + instance + ':' + phone;
const caseKey = id => 'operator_case:' + instance + ':' + id;
const historyKey = () => 'chatwoot:history:' + instance + ':' + phone;
const store = enabled ? createSosStore(real) : null;
async function json(key) { const raw = await real.get(key); return raw ? JSON.parse(raw) : null; }
async function seed(id = 'oc_fixture_1', overrides = {}) {
  const now = Date.now();
  const item = { id, instanceId: instance, phone, status: 'open', unread: true, highlight: 'red',
    kind: 'complaint', createdAt: now - 5000, updatedAt: now - 5000, summary: 'synthetic complaint', ...overrides };
  const marker = { caseId: id, signalId: 'signal-' + id, kind: 'complaint', startedAt: now - 1000, expiresAt: now + 86400000 };
  await real.multi().set(caseKey(id), JSON.stringify(item), { EX: 604800 })
    .set(activeKey(), id, { EX: 604800 }).set(markerKey(), JSON.stringify(marker), { EX: 86400 })
    .set(unreadKey(), marker.signalId, { EX: 86400 })
    .zAdd('chatwoot:sos:' + instance, [{ score: marker.expiresAt, value: phone }]).exec();
  return { item, marker };
}
async function route(action) {
  const handlers = app.router.stack.find(layer => layer.route?.path === '/api/chat/action/:instanceId/:phone').route.stack;
  assert.equal(handlers[1].handle.name, 'requireChatUiOrApi');
  let response, status = 200;
  await handlers.at(-1).handle({ params: { instanceId: instance, phone }, body: { action },
    apiAuth: { scope: 'tenant', instanceId: instance } },
    { status(code) { status = code; return this; }, json(value) { response = value; return this; } });
  return { status, response };
}

async function inbox() {
  const handlers = app.router.stack.find(layer => layer.route?.path === '/api/chat/inbox/:instanceId').route.stack;
  let response;
  await handlers.at(-1).handle({ params: { instanceId: instance }, query: { limit: '100' } },
    { status() { return this; }, json(value) { response = value; return this; } });
  return response.items;
}
test.before(async () => { if (enabled) { real.on('error', () => {}); await real.connect(); assert.equal(await real.ping(), 'PONG'); } });
test.beforeEach(async t => {
  if (!enabled) return;
  // This database is reachable only through an audit-owned Unix socket in a network-none container.
  await real.flushDb();
  for (const name of ['log', 'warn', 'error']) t.mock.method(console, name, () => {});
  Object.defineProperty(redisClient, 'isOpen', { configurable: true, value: true });
  t.mock.method(redisClient, 'sendCommand', args => real.sendCommand(args));
  t.mock.method(redisClient, 'publish', (...args) => real.publish(...args));
  t.mock.method(redisClient, 'scanIterator', (...args) => real.scanIterator(...args));
});
test.after(async () => { if (enabled) { delete redisClient.isOpen; if (real.isOpen) await real.quit(); } fs.rmSync(effectWalDir, { recursive: true, force: true }); });

test('clear resolves the owned canonical case atomically and preserves its TTL and history', { skip: !enabled }, async () => {
  await seed(); await real.rPush(historyKey(), 'synthetic existing transcript');
  const beforeTtl = await real.ttl(caseKey('oc_fixture_1'));
  assert.equal(await store.clear(instance, phone), true);
  const item = await json(caseKey('oc_fixture_1'));
  assert.equal(item.status, 'resolved'); assert.equal(item.unread, false); assert.equal(item.highlight, '');
  assert.ok(item.resolvedAt > item.createdAt); assert.ok(item.updatedAt >= item.resolvedAt);
  const afterTtl = await real.ttl(caseKey(item.id));
  assert.ok(afterTtl <= beforeTtl && afterTtl >= beforeTtl - 2);
  assert.equal(await real.get(activeKey()), null); assert.equal(await real.get(markerKey()), null);
  assert.equal(await real.exists(unreadKey()), 0); assert.equal(await real.zScore('chatwoot:sos:' + instance, phone), null);
  assert.equal(await real.lLen(historyKey()), 1);
});
test('view acknowledges canonical unread but preserves the open case and active pointer', { skip: !enabled }, async () => {
  await seed(); await route('view');
  const item = await json(caseKey('oc_fixture_1'));
  assert.equal(item.unread, false); assert.equal(item.status, 'open'); assert.equal(item.highlight, 'red');
  assert.equal(await real.get(activeKey()), item.id); assert.ok(await real.get(markerKey()));
  assert.equal(await real.exists(unreadKey()), 0);
});
test('legacy marker without a caseId clears its SOS and preserves the unknown active case', { skip: !enabled }, async () => {
  await seed(); const previous = await real.get(caseKey('oc_fixture_1'));
  await real.set(markerKey(), JSON.stringify({ kind: 'complaint', startedAt: Date.now() }), { EX: 86400 });
  assert.equal(await store.clear(instance, phone), true);
  assert.equal(await real.get(markerKey()), null); assert.equal(await real.get(activeKey()), 'oc_fixture_1');
  assert.equal(await real.get(caseKey('oc_fixture_1')), previous);
});
test('tenant, phone and case identity mismatches grant no authority over canonical records', { skip: !enabled }, async () => {
  for (const foreign of [{ instanceId: 'foreign' }, { phone: otherPhone }, { id: 'other-case' }]) {
    await seed('oc_fixture_1', foreign); const original = await real.get(caseKey('oc_fixture_1'));
    await store.clear(instance, phone);
    assert.equal(await real.get(caseKey('oc_fixture_1')), original);
    assert.equal(await real.get(activeKey()), 'oc_fixture_1'); assert.equal(await real.get(markerKey()), null);
  }
});
test('a new active pointer survives resolution of the previously associated case', { skip: !enabled }, async () => {
  await seed(); await real.set(activeKey(), 'oc_new_active', { EX: 604800 });
  await store.clear(instance, phone);
  assert.equal((await json(caseKey('oc_fixture_1'))).status, 'resolved');
  assert.equal(await real.get(activeKey()), 'oc_new_active');
});
test('a replaced marker between snapshot and Lua execution preserves the new escalation', { skip: !enabled }, async () => {
  await seed();
  let replaced = false;
  const racing = createSosStore({ async sendCommand(args) {
    if (args[0] === 'EVAL' && !replaced) { replaced = true; await seed('oc_fixture_new'); }
    return real.sendCommand(args);
  } });
  assert.equal(await racing.clear(instance, phone), false);
  assert.equal((await json(markerKey())).caseId, 'oc_fixture_new');
  assert.equal((await json(caseKey('oc_fixture_new'))).status, 'open');
  assert.equal(await real.get(activeKey()), 'oc_fixture_new'); assert.equal(await real.exists(unreadKey()), 1);
  assert.equal((await racing.list(instance))[0].sosCaseId, 'oc_fixture_new');
});
test('canonical update ahead of its SOS transaction is preserved for the new escalation', { skip: !enabled }, async () => {
  await seed('oc_fixture_1', { updatedAt: Date.now() + 1000 });
  assert.equal(await store.clear(instance, phone), false);
  assert.ok(await real.get(markerKey())); assert.equal(await real.get(activeKey()), 'oc_fixture_1');
  assert.equal((await json(caseKey('oc_fixture_1'))).status, 'open');
});
test('a missing marker never resolves or removes an unknown active case', { skip: !enabled }, async () => {
  await seed(); await real.del(markerKey());
  await store.clear(instance, phone);
  assert.equal(await real.get(activeKey()), 'oc_fixture_1');
  assert.equal((await json(caseKey('oc_fixture_1'))).status, 'open');
});
test('Redis mutation errors propagate instead of reporting successful SOS clearance', { skip: !enabled }, async () => {
  await seed();
  const failing = createSosStore({ async sendCommand(args) {
    if (args[0] === 'EVAL' || args[0] === 'DEL') throw new Error('SYNTHETIC_REDIS_UNAVAILABLE');
    return real.sendCommand(args);
  } });
  await assert.rejects(() => failing.clear(instance, phone), /SYNTHETIC_REDIS_UNAVAILABLE/);
  assert.ok(await real.get(markerKey()));
});
test('actual close, archive and delete routes resolve the associated canonical case', { skip: !enabled }, async () => {
  for (const action of ['close', 'archive', 'delete']) {
    await seed('oc_' + action);
    const result = await route(action);
    assert.equal(result.status, 200); assert.equal(result.response.success, true);
    assert.equal((await json(caseKey('oc_' + action))).status, 'resolved');
    assert.equal(await real.get(activeKey()), null); assert.equal(await real.get(markerKey()), null);
  }
});
test('a new SOS remains listed after the chat archive transaction races with resolution', { skip: !enabled }, async t => {
  await seed();
  await real.rPush(historyKey(), JSON.stringify({ id: 'fixture-history', direction: 'incoming', text: 'synthetic complaint', createdAt: Date.now() }));
  const original = chatStore.applyAction;
  t.mock.method(chatStore, 'applyAction', async (...args) => {
    const result = await original(...args); await seed('oc_after_archive'); return result;
  });
  await route('close');
  assert.equal(await chatStore.getState(instance, phone), 'archive');
  const rows = await store.list(instance);
  assert.equal(rows.length, 1); assert.equal(rows[0].sosCaseId, 'oc_after_archive'); assert.equal(rows[0].sosUnread, true);
  assert.equal((await json(caseKey('oc_after_archive'))).status, 'open');
  const items = await inbox();
  assert.equal(items.length, 1); assert.equal(items[0].state, 'archive');
  assert.equal(items[0].sosCaseId, 'oc_after_archive');
  assert.equal(require('../public/chat-core').chatColumn(items[0]), 'sos');

});
test('an actual route fails when Redis rejects the SOS bridge mutation', { skip: !enabled }, async t => {
  await seed();
  t.mock.method(redisClient, 'sendCommand', async args => {
    if (args[0] === 'EVAL' && String(args[1]).includes('operator_case')) throw new Error('SYNTHETIC_REDIS_UNAVAILABLE');
    return real.sendCommand(args);
  });
  await assert.rejects(() => route('close'), /SYNTHETIC_REDIS_UNAVAILABLE/);
});

function openBotHarness() {
  const root = process.env.AUDIT_OPENBOT_ROOT;
  const ts = require(path.join(root, 'node_modules/typescript'));
  const calls = { hub: 0, admin: 0, requestIds: [] };
  const cache = {};
  const modules = {
    './redis.service.js': { redisClient: real, connectRedis: async () => {}, CHAT_HISTORY_TTL_SECONDS: 604800 },
    '../utils/intentText.js': { isLikelyMenuQuestion: () => false },
    './platformConfig.service.js': { getRestaurantConfig: async () => ({ instance_id: instance, admin_phone: '77000000009' }) },
    './alemiApi.service.js': { reportOperatorSos: async () => { calls.hub++; return { ok: true }; } },
    '../transport/whatspro.client.js': { sendWhatsProMessage: async payload => {
      calls.admin++; calls.requestIds.push(payload.requestId); return { acknowledged: true, queued: false };
    } }
  };
  function load(name) {
    if (cache[name]) return cache[name];
    const exports = {};
    const source = fs.readFileSync(path.join(root, 'src/services', name + '.ts'), 'utf8');
    const compiled = ts.transpileModule(source, { compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true
    } }).outputText;
    vm.runInNewContext(compiled, { exports, Date, console, setInterval, clearInterval, require(dependency) {
      if (dependency === 'node:crypto') return crypto;
      if (name === 'operatorCase.service' && dependency === './operatorNotification.service.js') {
        return { queueOperatorCaseNotifications: load('operatorNotification.service').queueOperatorCaseNotifications,
          drainOperatorNotifications: async () => [] };
      }
      if (dependency === './durableNotification.service.js') return load('durableNotification.service');
      if (modules[dependency]) return modules[dependency];
      throw new Error('Unapproved integration dependency ' + dependency);
    } });
    cache[name] = exports; return exports;
  }
  return { calls, cases: load('operatorCase.service'), notifications: load('operatorNotification.service') };
}
test('close then new complaint creates a new actual OpenBot case and independent delivery ledger', {
  skip: !enabled || !process.env.AUDIT_OPENBOT_ROOT
}, async () => {
  const h = openBotHarness();
  const input = { instanceId: instance, phone, kind: 'complaint', summary: 'synthetic complaint', source: 'ai_tool_escalate_to_admin' };
  const first = await h.cases.createOperatorCase({ ...input, signalId: 'fixture-first-signal' });
  await h.notifications.drainOperatorNotifications([{ instance_id: instance }]);
  assert.equal(h.calls.hub, 1); assert.equal(h.calls.admin, 1);
  const oldAdminKey = h.notifications.operatorNotificationKey(instance, first.id, 'admin');
  assert.equal((await json(oldAdminKey)).status, 'delivered');
  await route('close');
  const second = await h.cases.createOperatorCase({ ...input, summary: 'new synthetic incident', signalId: 'fixture-new-signal' });
  assert.notEqual(second.id, first.id);
  assert.equal((await json(caseKey(first.id))).status, 'resolved');
  const newAdminKey = h.notifications.operatorNotificationKey(instance, second.id, 'admin');
  assert.equal((await json(newAdminKey)).status, 'pending');
  await h.notifications.drainOperatorNotifications([{ instance_id: instance }]);
  assert.equal(h.calls.hub, 2); assert.equal(h.calls.admin, 2);
  assert.notEqual(h.calls.requestIds[0], h.calls.requestIds[1]);
  assert.equal((await json(oldAdminKey)).status, 'delivered'); assert.equal((await json(newAdminKey)).status, 'delivered');
  const listed = await store.list(instance);
  assert.equal(listed[0].sosCaseId, second.id); assert.equal(listed[0].sosUnread, true);
});

test('a newly escalated SOS stays visible when a concurrent delete removed its old transcript', { skip: !enabled }, async t => {
  await seed();
  await real.rPush(historyKey(), JSON.stringify({ id: 'old-fixture-history', direction: 'incoming', text: 'synthetic complaint', createdAt: Date.now() }));
  const original = chatStore.applyAction;
  t.mock.method(chatStore, 'applyAction', async (...args) => {
    const result = await original(...args); await seed('oc_after_delete'); return result;
  });
  await route('delete');
  assert.equal(await real.lLen(historyKey()), 0);
  assert.equal((await store.list(instance))[0].sosCaseId, 'oc_after_delete');
  const rows = await inbox();
  assert.equal(rows.length, 1, 'active SOS must remain reachable without reconstructing deleted customer history');
  assert.equal(rows[0].sosCaseId, 'oc_after_delete');
  assert.equal(require('../public/chat-core').chatColumn(rows[0]), 'sos');
});

const Module = require('node:module');
const actualManager = require('../services/whatsappManager');
const originalManagerSend = actualManager.sendWhatsAppText;
let effectSendHook = async () => ({ success: true, messageId: 'SYNTHETIC-EFFECT-ACK', ack: 1 });
actualManager.sendWhatsAppText = (...args) => effectSendHook(...args);
const effectFilename = require.resolve('../src/server');
const effectModule = new Module(effectFilename, module);
effectModule.filename = effectFilename; effectModule.paths = Module._nodeModulePaths(path.dirname(effectFilename));
effectModule._compile(fs.readFileSync(effectFilename, 'utf8') + '\nObject.assign(module.exports.__test,{applyEffectForFixture:applyOperatorSendEffects,readyEffectRoute:()=>{walRecoveryComplete=true;},effectJobs:()=>Promise.all([...operatorEffectJobs.values(),...sendCompletionJobs.values()])});', effectFilename);
actualManager.sendWhatsAppText = originalManagerSend;
const applyEffect = effectModule.exports.__test.applyEffectForFixture;
function acceptedEffect(createdAt = Date.now()) {
  return { instanceId: instance, phone, expiresAt: Date.now() + 3600000,
    entry: { id: 'synthetic-accepted-effect-' + createdAt, instanceId: instance, phone, createdAt,
      text: 'synthetic accepted reply', role: 'operator', source: 'operator_panel', direction: 'outgoing', fromMe: true } };
}
async function assertNewSosPreserved(id) {
  assert.equal((await json(caseKey(id))).status, 'open');
  assert.equal(await real.get(activeKey()), id); assert.equal((await json(markerKey())).caseId, id);
  assert.equal(await real.get(unreadKey()), 'signal-' + id);
  assert.equal(await real.get('mute:' + instance + ':' + phone), null);
  assert.equal(await real.get('operator_active:' + instance + ':' + phone), null);
  assert.equal(require('../public/chat-core').chatColumn((await inbox())[0]), 'sos');
}
test('actual old accepted operator effects preserve newer SOS, state, unread and mute absence', { skip: !enabled }, async () => {
  const now = Date.now(); await seed('oc_effect_newer');
  await real.set('chatwoot:state:' + instance + ':' + phone, 'new', { EX: 86400 });
  await applyEffect(acceptedEffect(now - 10000));
  await assertNewSosPreserved('oc_effect_newer');
  assert.equal(await real.get('chatwoot:state:' + instance + ':' + phone), 'new');
  assert.equal(await real.lLen(historyKey()), 1, 'known accepted reply history still persists once');
});
test('actual current operator reply still resolves its older SOS and applies operator effects', { skip: !enabled }, async () => {
  await seed('oc_effect_older');
  const data = acceptedEffect(Date.now() + 1); await applyEffect(data);
  assert.equal((await json(caseKey('oc_effect_older'))).status, 'resolved');
  assert.equal(await real.get(markerKey()), null); assert.equal(await real.get(activeKey()), null);
  assert.equal(await real.get('mute:' + instance + ':' + phone), 'muted_by_operator_panel');
  assert.equal(await real.get('chatwoot:state:' + instance + ':' + phone), 'operator');
  assert.equal(await real.lLen(historyKey()), 1);
});
test('new escalation between history append and SOS clear survives old effect replay', { skip: !enabled }, async t => {
  await seed('oc_before_effect_append'); const data = acceptedEffect(Date.now() - 1000);
  const original = chatStore.appendMessageOnce;
  t.mock.method(chatStore, 'appendMessageOnce', async (...args) => {
    const result = await original(...args);
    await seed('oc_after_effect_append', { createdAt: data.entry.createdAt + 100, updatedAt: data.entry.createdAt + 100 });
    const marker = await json(markerKey()); marker.startedAt = data.entry.createdAt + 101;
    await real.set(markerKey(), JSON.stringify(marker), { EX: 86400 });
    await real.set('chatwoot:state:' + instance + ':' + phone, 'new', { EX: 86400 });
    return result;
  });
  await applyEffect(data); await assertNewSosPreserved('oc_after_effect_append');
  assert.equal(await real.get('chatwoot:state:' + instance + ':' + phone), 'new');
});
test('new escalation after SOS clear but before lock cannot be muted by older reply', { skip: !enabled }, async t => {
  const initial = await seed('oc_before_effect_clear');
  const data = acceptedEffect(initial.marker.startedAt + 1);
  const { sosStore } = require('../services/sosStore'), original = sosStore.clear;
  let clearReached = false;
  t.mock.method(sosStore, 'clear', async (...args) => {
    clearReached = true;
    const result = await original(...args);
    await seed('oc_after_effect_clear', { createdAt: data.entry.createdAt + 100, updatedAt: data.entry.createdAt + 100 });
    const marker = await json(markerKey()); marker.startedAt = data.entry.createdAt + 101;
    await real.set(markerKey(), JSON.stringify(marker), { EX: 86400 });
    await real.set('chatwoot:state:' + instance + ':' + phone, 'new', { EX: 86400 });
    return result;
  });
  await applyEffect(data); assert.equal(clearReached, true);
  await assertNewSosPreserved('oc_after_effect_clear');
});
test('operator append Lua protects escalation published at its Redis mutation boundary', { skip: !enabled }, async t => {
  await seed('oc_before_effect_lua'); const data = acceptedEffect(Date.now() - 1000);
  let injected = false;
  t.mock.method(redisClient, 'sendCommand', async args => {
    if (!injected && args[0] === 'EVAL' && String(args[1]).includes("local targetState = ARGV[5]")) {
      injected = true;
      await seed('oc_at_effect_lua', { createdAt: data.entry.createdAt + 100, updatedAt: data.entry.createdAt + 100 });
      const marker = await json(markerKey()); marker.startedAt = data.entry.createdAt + 101;
      await real.set(markerKey(), JSON.stringify(marker), { EX: 86400 });
      await real.set('chatwoot:state:' + instance + ':' + phone, 'new', { EX: 86400 });
    }
    return real.sendCommand(args);
  });
  await applyEffect(data); assert.equal(injected, true); await assertNewSosPreserved('oc_at_effect_lua');
  assert.equal(await real.get('chatwoot:state:' + instance + ':' + phone), 'new');
});

async function invokeEffectRoute(id) {
  effectModule.exports.__test.readyEffectRoute();
  const route = effectModule.exports.app.router.stack.find(layer => layer.route?.path === '/api/chat/send/:instanceId/:phone').route.stack.at(-1).handle;
  let status = 200, response;
  await route({ params: { instanceId: instance, phone }, body: { requestId: id, text: 'synthetic accepted reply' } },
    { status(code) { status = code; return this; }, json(value) { response = value; return this; } });
  await effectModule.exports.__test.effectJobs();
  return { status, response };
}
async function publishSameMs(id, now, revision, signal) {
  await seed(id, { createdAt: now, updatedAt: now, revision });
  const marker = await json(markerKey()); marker.startedAt = now; marker.caseRevision = revision; marker.signalId = signal;
  await real.set(markerKey(), JSON.stringify(marker), { EX: 86400 }); await real.set(unreadKey(), signal, { EX: 86400 });
  await real.set('chatwoot:state:' + instance + ':' + phone, 'new', { EX: 86400 });
}
test('actual operator route snapshot protects a same-ms new signal on the same canonical case', { skip: !enabled }, async t => {
  const now = Date.now(); await publishSameMs('oc_same_ms_effect', now - 1000, 'revision-before', 'signal-before');
  t.mock.method(Date, 'now', () => now);
  effectSendHook = async () => {
    await publishSameMs('oc_same_ms_effect', now, 'revision-after', 'signal-after');
    return { success: true, messageId: 'SYNTHETIC-SAME-MS-ACK', ack: 1 };
  };
  const result = await invokeEffectRoute('same-ms-operator-request');
  assert.equal(result.status, 200); assert.equal(result.response.messageId, 'SYNTHETIC-SAME-MS-ACK');
  assert.equal((await json(caseKey('oc_same_ms_effect'))).revision, 'revision-after');
  assert.equal((await json(caseKey('oc_same_ms_effect'))).status, 'open');
  assert.equal((await json(markerKey())).signalId, 'signal-after');
  assert.equal(await real.get(activeKey()), 'oc_same_ms_effect');
  assert.equal(await real.get(unreadKey()), 'signal-after');
  assert.equal(await real.get('chatwoot:state:' + instance + ':' + phone), 'new');
  assert.equal(await real.get('mute:' + instance + ':' + phone), null);
  assert.equal(await real.lLen(historyKey()), 1);
  assert.equal(require('../public/chat-core').chatColumn((await inbox())[0]), 'sos');
});
test('actual operator route snapshot protects same-ms canonical revision ahead of marker publication', { skip: !enabled }, async t => {
  const now = Date.now(); await publishSameMs('oc_canonical_ahead_effect', now - 1000, 'revision-before', 'signal-before');
  t.mock.method(Date, 'now', () => now);
  effectSendHook = async () => {
    const item = await json(caseKey('oc_canonical_ahead_effect')); item.revision = 'revision-after'; item.updatedAt = now;
    await real.set(caseKey(item.id), JSON.stringify(item), { KEEPTTL: true });
    await real.set('chatwoot:state:' + instance + ':' + phone, 'new', { EX: 86400 });
    return { success: true, messageId: 'SYNTHETIC-CANONICAL-AHEAD-ACK', ack: 1 };
  };
  assert.equal((await invokeEffectRoute('canonical-ahead-operator-request')).status, 200);
  assert.equal((await json(caseKey('oc_canonical_ahead_effect'))).status, 'open');
  assert.equal((await json(caseKey('oc_canonical_ahead_effect'))).revision, 'revision-after');
  assert.equal((await json(markerKey())).caseRevision, 'revision-before');
  assert.equal(await real.get(activeKey()), 'oc_canonical_ahead_effect');
  assert.equal(await real.get('chatwoot:state:' + instance + ':' + phone), 'new');
  assert.equal(await real.get('mute:' + instance + ':' + phone), null); assert.equal(await real.lLen(historyKey()), 1);
});
test('actual operator route with an original empty SOS snapshot preserves a later same-ms incident', { skip: !enabled }, async t => {
  const now = Date.now(); t.mock.method(Date, 'now', () => now);
  effectSendHook = async () => {
    await publishSameMs('oc_new_after_empty_snapshot', now, 'revision-new', 'signal-new');
    return { success: true, messageId: 'SYNTHETIC-EMPTY-SNAPSHOT-ACK', ack: 1 };
  };
  assert.equal((await invokeEffectRoute('empty-snapshot-operator-request')).status, 200);
  assert.equal((await json(caseKey('oc_new_after_empty_snapshot'))).status, 'open');
  assert.equal(await real.get(unreadKey()), 'signal-new');
  assert.equal(await real.get('chatwoot:state:' + instance + ':' + phone), 'new');
  assert.equal(await real.get('mute:' + instance + ':' + phone), null); assert.equal(await real.lLen(historyKey()), 1);
});
test('actual operator route snapshot still resolves its original version and mutes after successful clear', { skip: !enabled }, async t => {
  const now = Date.now(); await publishSameMs('oc_original_effect', now - 1000, 'revision-original', 'signal-original');
  t.mock.method(Date, 'now', () => now);
  effectSendHook = async () => ({ success: true, messageId: 'SYNTHETIC-ORIGINAL-SNAPSHOT-ACK', ack: 1 });
  assert.equal((await invokeEffectRoute('original-snapshot-operator-request')).status, 200);
  assert.equal((await json(caseKey('oc_original_effect'))).status, 'resolved');
  assert.equal(await real.get(markerKey()), null); assert.equal(await real.get(activeKey()), null);
  assert.equal(await real.get('mute:' + instance + ':' + phone), 'muted_by_operator_panel');
  assert.equal(await real.get('chatwoot:state:' + instance + ':' + phone), 'operator'); assert.equal(await real.lLen(historyKey()), 1);
});
test('ordinary close refuses a marker/canonical revision mismatch without clearing unread', { skip: !enabled }, async () => {
  const now = Date.now(); await publishSameMs('oc_close_revision_mismatch', now - 1000, 'revision-before', 'signal-before');
  const item = await json(caseKey('oc_close_revision_mismatch')); item.revision = 'revision-after';
  await real.set(caseKey(item.id), JSON.stringify(item), { KEEPTTL: true });
  assert.equal(await store.clear(instance, phone), false);
  assert.equal((await json(caseKey(item.id))).status, 'open'); assert.equal(await real.get(activeKey()), item.id);
  assert.equal((await json(markerKey())).caseRevision, 'revision-before'); assert.equal(await real.get(unreadKey()), 'signal-before');
});

test('malformed matching revisions never authorize canonical SOS closure', { skip: !enabled }, async () => {
  const now = Date.now(); await publishSameMs('oc_malformed_revision', now - 1000, false, 'signal-malformed');
  assert.equal(await store.clear(instance, phone), false);
  assert.equal((await json(caseKey('oc_malformed_revision'))).status, 'open');
  assert.equal(await real.get(activeKey()), 'oc_malformed_revision'); assert.equal(await real.get(unreadKey()), 'signal-malformed');
});

test('protected old reply bounds newly created history/dedup TTL while preserving newer SOS', { skip: !enabled }, async () => {
  const {item}=await seed();const now=Date.now();
  const entry=await chatStore.appendMessageOnce(instance,phone,{id:'old-protected-retention',text:'synthetic accepted reply',role:'operator',source:'operator_panel',createdAt:now-10000},{state:'operator',protectNewerSos:true,preserveArchive:true});
  assert.equal(entry.sosProtected,true);
  assert.ok(await real.ttl(historyKey())>0);assert.ok(await real.ttl(historyKey())<=86400);
  assert.ok(await real.ttl('chatwoot:message-ids:'+instance+':'+phone)>0);
  assert.equal((await json(caseKey(item.id))).status,'open');assert.ok(await real.get(markerKey()));
});
test('protected old reply preserves archive/history retention and bounds new media by remaining retention', { skip: !enabled }, async () => {
  await seed();const now=Date.now();
  const state='chatwoot:state:'+instance+':'+phone,archive='chatwoot:archive:'+instance+':'+phone;
  const dedup='chatwoot:message-ids:'+instance+':'+phone,mediaIds='chatwoot:media-ids:'+instance+':'+phone;
  await real.multi().set(state,'archive',{EX:600}).set(archive,String(now-20000),{EX:600})
    .rPush(historyKey(),'synthetic archived history').expire(historyKey(),600).sAdd(dedup,'archived-entry').expire(dedup,600)
    .sAdd(mediaIds,'old-media').expire(mediaIds,400).exec();
  const historyTtl=await real.ttl(historyKey()),dedupTtl=await real.ttl(dedup),stateTtl=await real.ttl(state),archiveTtl=await real.ttl(archive),mediaIdsTtl=await real.ttl(mediaIds);
  const entry=await chatStore.appendMessageOnce(instance,phone,{id:'old-protected-media',text:'synthetic accepted attachment',role:'operator',source:'operator_panel',createdAt:now-10000,mediaData:'aGVsbG8=',mediaType:'image/png'},{state:'operator',protectNewerSos:true,preserveArchive:true});
  assert.equal(entry.sosProtected,true);assert.equal(await real.get(state),'archive');
  for(const [key,prior] of [[historyKey(),historyTtl],[dedup,dedupTtl],[state,stateTtl],[archive,archiveTtl]]) {
    const ttl=await real.ttl(key);assert.ok(ttl>0 && ttl<=prior && ttl>=prior-2,key+' retained TTL');
  }
  assert.ok(await real.ttl('chatwoot:media:'+instance+':old-protected-media')>0);
  assert.ok(await real.ttl('chatwoot:media:'+instance+':old-protected-media')<=mediaIdsTtl);
  assert.ok(await real.ttl(mediaIds)<=mediaIdsTtl,'existing media retention is not extended by stale effect');
  assert.ok(await real.get(markerKey()));assert.equal(await real.zScore('chatwoot:inbox:'+instance,phone),null);
});


// The hour/day boundaries are accelerated by expiring only private fixture keys.
// Production TTL values and the real Lua operations are asserted before acceleration.
for (const [state, seconds] of [['operator', 10800], ['all', 86400], ['archive', 259200]]) {
  test('chat retention policy: real Redis ' + state + ' boundary, media and durable-record separation',
    { skip: !enabled }, async () => {
      let clock = Date.now();
      const { createChatStore } = require('../services/chatStore');
      const cs = createChatStore(real, { now: () => clock });
      const p = phone, base = clock;
      const obligation = 'private-retention-obligation:' + state;
      await real.set(obligation, 'synthetic durable delivery obligation');
      await cs.appendMessageOnce(instance, p, { id: 'retention-media', role: state === 'operator' ? 'operator' : 'client',
        hasMedia: true, mediaData: 'YWJj', mediaType: 'audio/ogg', createdAt: base }, { state });
      const scoped = [cs.keys.history(instance, p), cs.keys.state(instance, p), cs.keys.messageIds(instance, p),
        cs.keys.mediaIds(instance, p), cs.keys.media(instance, 'retention-media')];
      for (const key of scoped) {
        const ttl = await real.ttl(key);
        assert.ok(ttl <= seconds && ttl >= seconds - 2, key + ' policy TTL');
      }
      assert.equal(Number(await real.zScore(cs.keys.expiry(instance), p)), base + seconds * 1000);
      clock = base + seconds * 1000 - 1;
      assert.equal((await cs.readInbox(instance)).length, 1, 'visible immediately before boundary');
      for (const key of scoped) await real.pExpireAt(key, Date.now() - 1);
      clock = base + seconds * 1000;
      await cs.pruneExpired(instance);
      assert.equal((await cs.readInbox(instance)).length, 0, 'absent at accelerated Redis expiry');
      assert.deepEqual(await cs.getHistory(instance, p), []);
      assert.equal(await cs.readMedia(instance, 'retention-media'), null);
      assert.equal(await real.get(obligation), 'synthetic durable delivery obligation');
      assert.equal(await real.ttl(obligation), -1);
    });
}

test('chat retention policy: real Redis duplicate ACK does not extend operator retention',
  { skip: !enabled }, async () => {
    let clock = Date.now();
    const { createChatStore } = require('../services/chatStore');
    const cs = createChatStore(real, { now: () => clock });
    const entry = { id: 'retention-once', role: 'operator', createdAt: clock };
    await cs.appendMessageOnce(instance, phone, entry, { state: 'operator', preserveStateOnDuplicate: true });
    const score = await real.zScore(cs.keys.expiry(instance), phone), ttl = await real.ttl(historyKey());
    clock += 3600_000;
    const result = await cs.appendMessageOnce(instance, phone, entry, { state: 'operator', preserveStateOnDuplicate: true });
    assert.equal(result.inserted, false);
    assert.equal(await real.zScore(cs.keys.expiry(instance), phone), score);
    assert.ok(await real.ttl(historyKey()) <= ttl && await real.ttl(historyKey()) >= ttl - 2);
    assert.equal(Number(score), entry.createdAt + 10800_000);
    assert.equal(await real.lLen(historyKey()), 1);
  });

test('chat retention policy: real Redis no-TTL operator repair uses three hours',
  { skip: !enabled }, async () => {
    const now = Date.now(), { createChatStore } = require('../services/chatStore');
    const cs = createChatStore(real, { now: () => now });
    await cs.appendMessageOnce(instance, phone, { id: 'repair-ttl', role: 'operator', createdAt: now }, { state: 'operator' });
    for (const key of [historyKey(), cs.keys.state(instance, phone)]) await real.persist(key);
    await real.zAdd(cs.keys.expiry(instance), [{ score: now - 1, value: phone }]);
    await cs.pruneExpired(instance);
    const ttl = await real.ttl(historyKey());
    assert.ok(ttl > 0 && ttl <= 10800 && ttl >= 10798);
    assert.equal(Number(await real.zScore(cs.keys.expiry(instance), phone)), now + 10800_000);
  });

test('SOS retention policy: real Redis one-hour signal expires without resolving durable case or delivery obligations',
  { skip: !enabled }, async () => {
    const { item, marker } = await seed('retention-durable-case');
    let clock = marker.startedAt + 3600_000 - 1;
    const projected = createSosStore(real, { now: () => clock });
    const canonical = await real.get(caseKey(item.id)), active = await real.get(activeKey());
    const raw = await real.get(markerKey()), unread = await real.get(unreadKey());
    const score = await real.zScore('chatwoot:sos:' + instance, phone);
    const caseTtl = await real.ttl(caseKey(item.id));
    assert.equal((await projected.list(instance)).length, 1);
    const signalDeadline = marker.startedAt + 3600_000;
    for (const key of [markerKey(), unreadKey()]) {
      assert.equal(Number(await real.sendCommand(['PEXPIRETIME', key])), signalDeadline);
    }
    clock += 1;
    // Accelerate only private attention-key expiry; the injected clock does not advance Redis TIME.
    for (const key of [markerKey(), unreadKey()]) await real.pExpireAt(key, Date.now() - 1);
    assert.deepEqual(await projected.list(instance), []);
    assert.equal(await real.get(caseKey(item.id)), canonical);
    assert.equal(await real.get(activeKey()), active);
    // Current policy expires proved attention storage, without resolving durable obligations.
    assert.equal(await real.get(markerKey()), null);
    assert.equal(await real.get(unreadKey()), null);
    assert.equal(await real.zScore('chatwoot:sos:' + instance, phone), null);
    assert.ok(await real.ttl(caseKey(item.id)) <= caseTtl && await real.ttl(caseKey(item.id)) >= caseTtl - 2);
  });

test('SOS retention policy: real Redis late accepted ACK preserves a newer one-hour signal and retention',
  { skip: !enabled }, async () => {
    const now = Date.now();
    await seed('retention-old-signal');
    const before = await store.effectSnapshot(instance, phone);
    await seed('retention-new-signal', { updatedAt: now + 1 });
    const snapshot = await store.effectSnapshot(instance, phone);
    const result = await chatStore.appendMessageOnce(instance, phone,
      { id: 'retention-late-ACK', role: 'operator', createdAt: now - 10000 },
      { state: 'operator', protectNewerSos: true, preserveArchive: true, sosSnapshot: before });
    assert.equal(result.sosProtected, true);
    assert.deepEqual(await store.effectSnapshot(instance, phone), snapshot);
    assert.equal((await json(caseKey('retention-new-signal'))).status, 'open');
    const rows = await createSosStore(real, { now: () => now }).list(instance);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].sosCaseId, 'retention-new-signal');
    assert.ok(rows[0].sosExpiresAt <= now + 3600_000);
  });

test('chat retention policy: real Redis existing live24h operator expires from stored activity without read refresh',
  { skip: !enabled }, async () => {
    const { createChatStore } = require('../services/chatStore');
    const base = Date.now(); let clock = base + 7200_000;
    const cs = createChatStore(real, { now: () => clock });
    const msg = { id: 'old-policy-media', role: 'operator', hasMedia: true, createdAt: base };
    await real.multi().rPush(historyKey(), JSON.stringify(msg)).expire(historyKey(), 86400)
      .set(cs.keys.state(instance, phone), 'operator', { EX: 86400 })
      .sAdd(cs.keys.mediaIds(instance, phone), msg.id).expire(cs.keys.mediaIds(instance, phone), 86400)
      .set(cs.keys.media(instance, msg.id), 'data:audio/ogg;base64,YWJj', { EX: 86400 })
      .zAdd(cs.keys.inbox(instance), [{ score: base, value: phone }])
      .zAdd(cs.keys.expiry(instance), [{ score: base + 86400_000, value: phone }]).exec();
    assert.equal((await cs.readInbox(instance)).length, 1);
    assert.equal(Number(await real.zScore(cs.keys.expiry(instance), phone)), base + 10800_000);
    const firstTtl = await real.ttl(historyKey());
    assert.ok(firstTtl <= 3600 && firstTtl >= 3598, 'shorten relative to stored activity, never read time');
    clock += 600_000;
    assert.equal((await cs.getHistory(instance, phone)).length, 1);
    assert.ok(await real.ttl(historyKey()) <= 3000 && await real.ttl(historyKey()) >= 2998);
    clock = base + 10800_000;
    await cs.pruneExpired(instance);
    assert.equal((await cs.readInbox(instance)).length, 0);
    assert.deepEqual(await cs.getHistory(instance, phone), []);
    assert.equal(await cs.readMedia(instance, msg.id), null);
  });

test('chat retention policy: real Redis old operator transition timestamp wins over older message timestamp',
  { skip: !enabled }, async () => {
    const { createChatStore } = require('../services/chatStore');
    const transition = Date.now(); let clock = transition + 10800_000 - 1;
    const cs = createChatStore(real, { now: () => clock });
    await real.multi().rPush(historyKey(), JSON.stringify({ id: 'old-transition', createdAt: transition - 86400_000 }))
      .expire(historyKey(), 86400).set(cs.keys.state(instance, phone), 'operator', { EX: 86400 })
      .zAdd(cs.keys.inbox(instance), [{ score: transition - 86400_000, value: phone }])
      .zAdd(cs.keys.expiry(instance), [{ score: transition + 86400_000, value: phone }]).exec();
    assert.equal((await cs.readInbox(instance)).length, 1);
    assert.equal(Number(await real.zScore(cs.keys.expiry(instance), phone)), transition + 10800_000);
    clock += 1;
    assert.deepEqual(await cs.getHistory(instance, phone), []);
    assert.equal((await cs.readInbox(instance)).length, 0);
  });

test('chat retention policy: real Redis old expiry snapshot never deletes renewed operator history',
  { skip: !enabled }, async () => {
    const { createChatStore } = require('../services/chatStore');
    const base = Date.now(); let clock = base + 10800_000;
    const cs = createChatStore(real, { now: () => clock });
    await real.multi().rPush(historyKey(), JSON.stringify({ id: 'old-race', createdAt: base }))
      .expire(historyKey(), 86400).set(cs.keys.state(instance, phone), 'operator', { EX: 86400 })
      .zAdd(cs.keys.inbox(instance), [{ score: base, value: phone }])
      .zAdd(cs.keys.expiry(instance), [{ score: base + 86400_000, value: phone }]).exec();
    let raced = false;
    const guarded = createChatStore({ sendCommand: async args => {
      if (!raced && args[0] === 'EVAL' && args[1].includes('operatorRetentionPolicy')) {
        raced = true;
        await cs.appendMessageOnce(instance, phone, { id: 'renewed-race', createdAt: clock }, { state: 'operator' });
      }
      return real.sendCommand(args);
    } }, { now: () => clock });
    await guarded.pruneExpired(instance);
    assert.equal(raced, true, 'inject renewal immediately before the atomic policy boundary');
    assert.equal(await real.lLen(historyKey()), 2);
    assert.equal((await cs.getHistory(instance, phone)).length, 2);
    assert.equal(Number(await real.zScore(cs.keys.expiry(instance), phone)), clock + 10800_000);
  });

const historyAdmissionAxes = [
  ['canonical reject plus legacy empty preserves metadata', null, [], false, true],
  ['legacy reject plus canonical empty preserves metadata', [], null, false, true],
  ['both rejects preserve metadata', null, null, false, true],
  ['both successful empty reads retain cleanup', [], [], false, false],
  ['nonempty canonical keeps priority over rejected legacy', [{ id: 'canonical-admitted', text: 'canonical', createdAt: Date.now() }], null, false, true],
  ['nonempty legacy remains fallback for observed empty canonical', [], [{ id: 'legacy-admitted', text: 'legacy', createdAt: Date.now() }], false, true],
  ['live SOS remains reachable with an uncertain history read', null, [], true, true]
];
for (const [name, canonical, legacy, hasSos, preserve] of historyAdmissionAxes) {
  test('chat retention policy: inbox history admission ' + name, { skip: !enabled }, async t => {
    const marker = 'synthetic archive marker';
    await real.multi().set('chatwoot:state:' + instance + ':' + phone, 'archive', { EX: 259200 })
      .set('chatwoot:archive:' + instance + ':' + phone, marker, { EX: 259200 })
      .sAdd('chatwoot:archive:' + instance, phone)
      .zAdd('chatwoot:inbox:' + instance, [{ score: Date.now(), value: phone }])
      .zAdd('chatwoot:viewed:' + instance, [{ score: Date.now() - 1, value: phone }]).exec();
    if (hasSos) await seed('history-admission-case');
    const before = {
      inbox: await real.zScore('chatwoot:inbox:' + instance, phone),
      viewed: await real.zScore('chatwoot:viewed:' + instance, phone),
      marker: await real.get('chatwoot:archive:' + instance + ':' + phone),
      markerTtl: await real.ttl('chatwoot:archive:' + instance + ':' + phone)
    };
    let reads = 0;
    t.mock.method(redisClient, 'sendCommand', async args => {
      if (args[0] === 'LRANGE' && args[2] === '-500') {
        const result = args[1] === historyKey() ? canonical : args[1] === 'history:' + instance + ':' + phone ? legacy : undefined;
        if (result !== undefined) {
          reads += 1;
          if (result === null) throw new Error('synthetic isolated history read failure');
          return result.map(row => JSON.stringify(row));
        }
      }
      return real.sendCommand(args);
    });
    const rows = await inbox();
    assert.equal(reads, 2, 'real handler independently attempted both history reads');
    assert.equal(await real.zScore('chatwoot:inbox:' + instance, phone), preserve ? before.inbox : null);
    assert.equal(await real.zScore('chatwoot:viewed:' + instance, phone), preserve ? before.viewed : null);
    assert.equal(Boolean(await real.sIsMember('chatwoot:archive:' + instance, phone)), preserve);
    assert.equal(await real.get('chatwoot:archive:' + instance + ':' + phone), preserve ? marker : null);
    if (preserve) {
      const ttl = await real.ttl('chatwoot:archive:' + instance + ':' + phone);
      assert.ok(ttl <= before.markerTtl && ttl >= before.markerTtl - 2);
    }
    if (canonical?.length) assert.equal(rows[0].lastText, 'canonical');
    if (!canonical?.length && legacy?.length) assert.equal(rows[0].lastText, 'legacy');
    if (hasSos) assert.equal(rows[0].sosCaseId, 'history-admission-case');
    if ((!canonical?.length && !legacy?.length) && !hasSos) assert.deepEqual(rows, []);
  });
}

test('chat retention policy: real Redis opening new history acknowledges without extending the one-day deadline',
  { skip: !enabled }, async () => {
    const { createChatStore } = require('../services/chatStore');
    const base = Date.now(); let clock = base;
    const cs = createChatStore(real, { now: () => clock });
    await cs.appendMessageOnce(instance, phone, { id: 'view-no-refresh', createdAt: base }, { state: 'new' });
    const expiry = await real.zScore(cs.keys.expiry(instance), phone);
    const ttl = await real.ttl(historyKey());
    clock += 3600_000;
    await cs.applyAction(instance, phone, 'view');
    assert.equal(await cs.getState(instance, phone), 'all');
    assert.equal(await real.zScore(cs.keys.expiry(instance), phone), expiry);
    assert.ok(await real.ttl(historyKey()) <= ttl && await real.ttl(historyKey()) >= ttl - 2);
    await cs.getHistory(instance, phone);
    assert.equal(await real.zScore(cs.keys.expiry(instance), phone), expiry);
  });

test('chat retention policy: real Redis stale view cannot overwrite a concurrent operator transition or its deadline',
  { skip: !enabled }, async () => {
    const { createChatStore } = require('../services/chatStore');
    const base = Date.now(); const cs = createChatStore(real, { now: () => base });
    await cs.appendMessageOnce(instance, phone, { id: 'before-view-race', createdAt: base }, { state: 'new' });
    let raced = false;
    const guarded = createChatStore({ sendCommand: async args => {
      if (!raced && args[0] === 'EVAL' && args[1].includes('viewWithoutRetentionRefresh')) {
        raced = true;
        await cs.appendMessageOnce(instance, phone, { id: 'operator-during-view', createdAt: base }, { state: 'operator' });
      }
      return real.sendCommand(args);
    } }, { now: () => base });
    await guarded.applyAction(instance, phone, 'view');
    assert.equal(raced, true);
    assert.equal(await cs.getState(instance, phone), 'operator');
    assert.equal(Number(await real.zScore(cs.keys.expiry(instance), phone)), base + 10800_000);
    assert.equal(await real.lLen(historyKey()), 2);
  });

for (const older of ['expired', 'unknown']) {
  test('SOS retention policy: pagination admits fresh signal after ' + older + ' retained marker', { skip: !enabled }, async () => {
    const now = Math.floor(Date.now() / 1000) * 1000, ss = createSosStore(real, { now: () => now });
    const old = {caseId: 'oc_old_retained', signalId: 'old', expiresAt: now + 22 * 3600000};
    if (older === 'expired') old.startedAt = now - 2 * 3600000;
    const raw = JSON.stringify(old), fresh = {caseId: 'oc_fresh_visible', signalId: 'fresh', startedAt: now - 60000, expiresAt: now + 86400000 - 60000};
    await real.multi().set(ss.keys.marker(instance, phone), raw, {EX: 86400})
      .zAdd(ss.keys.index(instance), [{score: old.expiresAt, value: phone}])
      .set(ss.keys.marker(instance, otherPhone), JSON.stringify(fresh), {EX: 86400})
      .zAdd(ss.keys.index(instance), [{score: fresh.expiresAt, value: otherPhone}]).exec();
    const rows = await ss.list(instance, 1);
    assert.equal(rows.length, 1); assert.equal(rows[0].phone, otherPhone); assert.equal(rows[0].sosSignalId, 'fresh');
    assert.equal(await real.get(ss.keys.marker(instance, phone)), raw);
  });
}

async function legacyRetentionSignal(now, startedAt = now - 600000) {
  const id = 'oc_legacy_retention', revision = 'legacy_revision', startedMs = Number(startedAt) < 1e12 ? Number(startedAt) * 1000 : Number(startedAt);
  const canonical = JSON.stringify({id, instanceId: instance, phone, status: 'open', revision, createdAt: startedMs - 1000, updatedAt: startedMs, unread: true});
  const marker = JSON.stringify({caseId: id, caseRevision: revision, signalId: 'legacy_signal', startedAt, expiresAt: now + 86400000});
  const planKey = 'operator_notification:' + instance + ':' + id + ':hub', plan = JSON.stringify({status: 'pending', payload: {caseId: id, signalId: 'legacy_signal'}});
  await real.multi().set(caseKey(id), canonical, {EX: 604800}).set(activeKey(), id, {EX: 604800})
    .set(markerKey(), marker, {EX: 86400}).set(unreadKey(), 'legacy_signal', {EX: 86400})
    .zAdd('chatwoot:sos:' + instance, [{score: now + 86400000, value: phone}])
    .rPush(historyKey(), 'synthetic retained history').set(planKey, plan).exec();
  return {id, canonical, marker, planKey, plan};
}
async function assertLegacyDurable(q) {
  assert.equal(await real.get(caseKey(q.id)), q.canonical); assert.equal(await real.get(activeKey()), q.id);
  assert.equal(await real.lLen(historyKey()), 1); assert.equal(await real.get(q.planKey), q.plan);
  assert.equal(await real.ttl(q.planKey), -1); assert.ok(await real.ttl(caseKey(q.id)) > 604790);
}
for (const encoding of ['milliseconds', 'seconds']) {
  test('SOS retention policy: legacy physical ' + encoding + ' origin caps live signal without durable mutation', {skip: !enabled}, async () => {
    const now = Math.floor(Date.now() / 1000) * 1000, started = now - 600000;
    const q = await legacyRetentionSignal(now, encoding === 'seconds' ? started / 1000 : started);
    const rows = await createSosStore(real, {now: () => now}).list(instance, 1);
    assert.equal(rows.length, 1); assert.equal(rows[0].sosExpiresAt, started + 3600000);
    for (const key of [markerKey(), unreadKey()]) {const ttl = await real.ttl(key); assert.ok(ttl > 2990 && ttl <= 3000);}
    assert.equal(await real.zScore('chatwoot:sos:' + instance, phone), started + 3600000);
    assert.equal(await real.get(markerKey()), q.marker); await assertLegacyDurable(q);
  });
}
test('SOS retention policy: legacy physical overdue signal removes only attention artifacts', {skip: !enabled}, async () => {
  const now = Math.floor(Date.now() / 1000) * 1000, q = await legacyRetentionSignal(now, now - 7200000);
  assert.deepEqual(await createSosStore(real, {now: () => now}).list(instance), []);
  assert.equal(await real.get(markerKey()), null); assert.equal(await real.get(unreadKey()), null);
  assert.equal(await real.zScore('chatwoot:sos:' + instance, phone), null); await assertLegacyDurable(q);
});
test('SOS retention policy: legacy physical read never extends an already shorter TTL or score', {skip: !enabled}, async () => {
  const now = Math.floor(Date.now() / 1000) * 1000, q = await legacyRetentionSignal(now);
  await real.expire(markerKey(), 1800); await real.expire(unreadKey(), 1700);
  await real.zAdd('chatwoot:sos:' + instance, [{score: now + 1200000, value: phone}]);
  await createSosStore(real, {now: () => now}).list(instance);
  assert.ok(await real.ttl(markerKey()) <= 1800); assert.ok(await real.ttl(unreadKey()) <= 1700);
  assert.equal(await real.zScore('chatwoot:sos:' + instance, phone), now + 1200000); await assertLegacyDurable(q);
});
test('SOS retention policy: legacy physical stale clamp preserves a newer exact marker and unread', {skip: !enabled}, async () => {
  const now = Math.floor(Date.now() / 1000) * 1000, q = await legacyRetentionSignal(now), newer = JSON.stringify({caseId: q.id, caseRevision: 'new_revision', signalId: 'new_signal', startedAt: now, expiresAt: now + 3600000});
  let raced = false;
  const wrapped = {async sendCommand(args) {
    if (!raced && args[0] === 'EVAL' && args[1].includes('SOS_LEGACY_SIGNAL_RETENTION_CLAMP')) {
      raced = true;
      await real.multi().set(markerKey(), newer, {EX: 3600}).set(unreadKey(), 'new_signal', {EX: 3600})
        .set(caseKey(q.id), JSON.stringify({...JSON.parse(q.canonical), revision: 'new_revision', updatedAt: now}), {KEEPTTL: true})
        .zAdd('chatwoot:sos:' + instance, [{score: now + 3600000, value: phone}]).exec();
    }
    return real.sendCommand(args);
  }};
  await createSosStore(wrapped, {now: () => now}).list(instance);
  assert.equal(raced, true); assert.equal(await real.get(markerKey()), newer); assert.equal(await real.get(unreadKey()), 'new_signal');
  assert.ok(await real.ttl(markerKey()) > 3590); assert.equal(await real.zScore('chatwoot:sos:' + instance, phone), now + 3600000);
  assert.equal(await real.get(q.planKey), q.plan); assert.equal(await real.lLen(historyKey()), 1);
});
for (const mismatch of ['unknown_origin', 'foreign_case', 'foreign_active', 'unread_mismatch']) {
  test('SOS retention policy: legacy physical unproven ' + mismatch + ' stays byte exact with original TTL', {skip: !enabled}, async () => {
    const now = Math.floor(Date.now() / 1000) * 1000, q = await legacyRetentionSignal(now);
    if (mismatch === 'unknown_origin') {const m = JSON.parse(q.marker); delete m.startedAt; await real.set(markerKey(), JSON.stringify(m), {KEEPTTL: true});}
    if (mismatch === 'foreign_case') await real.set(caseKey(q.id), JSON.stringify({...JSON.parse(q.canonical), instanceId: 'other_tenant'}), {KEEPTTL: true});
    if (mismatch === 'foreign_active') await real.set(activeKey(), 'oc_other', {KEEPTTL: true});
    if (mismatch === 'unread_mismatch') await real.set(unreadKey(), 'unproven_new_signal', {KEEPTTL: true});
    const raw = await real.get(markerKey()), unread = await real.get(unreadKey()), score = await real.zScore('chatwoot:sos:' + instance, phone);
    await createSosStore(real, {now: () => now}).list(instance);
    assert.equal(await real.get(markerKey()), raw); assert.equal(await real.get(unreadKey()), unread);
    assert.equal(await real.zScore('chatwoot:sos:' + instance, phone), score);
    assert.ok(await real.ttl(markerKey()) > 86390); assert.equal(await real.get(q.planKey), q.plan);
  });
}

test('SOS retention policy: legacy physical expiry is absolute and never starts a new hour on read', {skip: !enabled}, async () => {
  let now = Math.floor(Date.now() / 1000) * 1000; const started = now - 600000;
  const q = await legacyRetentionSignal(now, started), ss = createSosStore(real, {now: () => now});
  await ss.list(instance);
  for (const key of [markerKey(), unreadKey()]) assert.equal(Number(await real.sendCommand(['PEXPIRETIME', key])), started + 3600000);
  now += 60000; await ss.list(instance);
  for (const key of [markerKey(), unreadKey()]) assert.equal(Number(await real.sendCommand(['PEXPIRETIME', key])), started + 3600000);
  await assertLegacyDurable(q);
});
