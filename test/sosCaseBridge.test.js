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
  await seed('oc_before_effect_append'); const data = acceptedEffect(Date.now());
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
  await seed('oc_before_effect_clear'); const data = acceptedEffect(Date.now() + 1);
  const { sosStore } = require('../services/sosStore'), original = sosStore.clear;
  t.mock.method(sosStore, 'clear', async (...args) => {
    const result = await original(...args);
    await seed('oc_after_effect_clear', { createdAt: data.entry.createdAt + 100, updatedAt: data.entry.createdAt + 100 });
    const marker = await json(markerKey()); marker.startedAt = data.entry.createdAt + 101;
    await real.set(markerKey(), JSON.stringify(marker), { EX: 86400 });
    await real.set('chatwoot:state:' + instance + ':' + phone, 'new', { EX: 86400 });
    return result;
  });
  await applyEffect(data); await assertNewSosPreserved('oc_after_effect_clear');
});
test('operator append Lua protects escalation published at its Redis mutation boundary', { skip: !enabled }, async t => {
  await seed('oc_before_effect_lua'); const data = acceptedEffect(Date.now());
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

