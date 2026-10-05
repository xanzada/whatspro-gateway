'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { BaileysClient } = require('../services/baileysClient');
const { __test: manager } = require('../services/whatsappManager');
const tenantAdmin = require('../services/tenantAdmin');
const tenantStore = require('../services/tenantStore');
const { app, __test: server } = require('../src/server');
const phone = '77000000001';
const KK = 'Қоңырауға жауап бере алмаймыз. Сұрағыңызды осы жерге жаза аласыз 🙂';
const RU = 'Мы не можем ответить на звонок. Напишите, пожалуйста, сюда 🙂';

function deps(row, deliveries = []) {
  return {
    tenantAdmin: { findRow: async () => row },
    getTestModePolicy: async () => ({ enabled: false }),
    resolvePhone: async () => phone,
    isPhoneAllowed: async () => true,
    getHistory: async () => [],
    getStoredLanguage: async () => null,
    deliverText: async (_client, instanceId, recipient, text) => {
      deliveries.push({ instanceId, recipient, text });
      return { success: true, ack: 0 };
    }
  };
}
test.beforeEach(t => {
  manager.seenCallIds.clear();
  for (const method of ['log', 'warn', 'error']) t.mock.method(console, method, () => {});
});
test.afterEach(() => manager.seenCallIds.clear());

test('call replies use the latest customer language, ignoring the operator and neutral media', async () => {
  const deliveries = [];
  for (const [history, locale, expected] of [
    [[{ direction: 'incoming', text: 'Донер қанша?', createdAt: 1 }], 'ru', KK],
    [[{ direction: 'incoming', text: 'Сәлем', createdAt: 1 }, { direction: 'incoming', text: 'Можно меню?', createdAt: 2 }, { direction: 'outgoing', text: 'Қош келдіңіз', createdAt: 3 }], 'kk', RU],
    [[{ direction: 'incoming', text: 'Привет', createdAt: 1 }, { direction: 'incoming', text: '', createdAt: 2 }], 'kk', RU],
    [[], 'ru-RU', RU],
    [[], '', KK]
  ]) {
    await manager.handleIncomingCall('call-fixture', {}, { id: 'localized', from: phone }, {
      ...deps({ calls_disabled: true, locale }, deliveries),
      rejectCall: async () => true,
      getHistory: async () => history
    });
    assert.equal(deliveries.at(-1).text, expected);
  }
});

test('a structured failed send is not reported as a delivered call reply', async () => {
  for (const sendResult of [{ success: false }, { success: true, ack: -1 }, false, null]) {
    const result = await manager.handleIncomingCall('call-fixture', {}, { from: phone }, {
      ...deps({ calls_disabled: true }),
      rejectCall: async () => true,
      deliverText: async () => sendResult
    });
    assert.equal(result.replied, false);
  }
});

test('an unavailable config cannot leave the rejection waiting indefinitely', async () => {
  let release;
  const delayed = new Promise(resolve => { release = resolve; });
  const started = Date.now();
  let rejectedAt = 0;
  const unblock = setTimeout(() => release({ calls_disabled: true }), 750);
  try {
    const result = await manager.handleIncomingCall('call-fixture', {}, { from: phone }, {
      ...deps(null),
      tenantAdmin: { findRow: () => delayed },
      rejectCall: async () => { rejectedAt = Date.now(); return true; }
    });
    assert.equal(result.rejected, true);
    assert.ok(rejectedAt - started < 650, 'reject within the 500ms config budget');
  } finally {
    clearTimeout(unblock);
    release({ calls_disabled: true });
  }
});

test('Baileys event sequences reject and reply once, isolate tenants, and use current toggle', async t => {
  const rows = new Map([['call-alpha', { calls_disabled: true }], ['call-beta', { calls_disabled: false }]]);
  const updates = [];
  t.mock.method(tenantStore, 'findRow', async id => rows.get(id) || null);
  t.mock.method(tenantStore, 'updateRow', async (id, patch) => {
    rows.set(id, { ...rows.get(id), ...patch });
    updates.push({ id, patch });
  });
  const pending = [];
  const deliveries = [];
  const rejects = [];
  const clientFor = instanceId => {
    const client = new BaileysClient({ instanceId, logger: { log() {}, warn() {}, error() {} } });
    const socket = { rejectCall: async (id, from) => rejects.push({ instanceId, id, from }) };
    client._sock = socket;
    client.on('call', call => pending.push(manager.dispatchIncomingCall(instanceId, client, call, 'baileys', {
      ...deps(null, deliveries),
      tenantAdmin,
      rejectCall: async (_active, incoming) => incoming.reject()
    })));
    return { client, socket };
  };
  const alpha = clientFor('call-alpha');
  const beta = clientFor('call-beta');
  const offer = id => ({ id, from: phone + '@s.whatsapp.net', status: 'offer' });
  alpha.client._onCall([offer('shared'), offer('shared'), { ...offer('shared'), status: 'terminate' }], alpha.socket);
  beta.client._onCall([offer('shared')], beta.socket);
  await Promise.all(pending.splice(0));
  assert.deepEqual(rejects.map(x => [x.instanceId, x.id]), [['call-alpha', 'shared']]);
  assert.equal(deliveries.length, 1);

  // The actual API handler calls the actual admin/store path; no HTTP listener or auth state.
  const route = app.router.stack.find(layer => layer.route?.path === '/api/wa/tenants/:instanceId/calls-disabled').route;
  assert.equal(route.stack.length, 2, 'authorization middleware remains before the handler');
  const request = async (instanceId, disabled) => {
    let code = 200;
    let body;
    await route.stack.at(-1).handle({ params: { instanceId }, body: { disabled } }, {
      status(value) { code = value; return this; },
      json(value) { body = value; return this; }
    });
    return { code, body };
  };
  assert.equal((await request('call-alpha', false)).body.callsDisabled, false);
  alpha.client._onCall([offer('enabled')], alpha.socket);
  await Promise.all(pending.splice(0));
  assert.equal(rejects.length, 1);
  assert.equal(deliveries.length, 1);
  assert.equal((await request('call-alpha', true)).body.callsDisabled, true);
  alpha.client._onCall([offer('disabled-again')], alpha.socket);
  await Promise.all(pending.splice(0));
  assert.equal(rejects.length, 2);
  assert.equal(deliveries.length, 2);
  assert.deepEqual(updates.map(x => x.patch.calls_disabled), [false, true]);

  for (const invalid of ['false', 0, null, undefined, {}]) {
    assert.equal((await request('call-alpha', invalid)).code, 400, 'invalid bodies must not change call state');
  }
  assert.equal(updates.length, 2);
});

test('a call reject retains the offer socket when the client reconnects before config resolves', async () => {
  let resolveConfig;
  const config = new Promise(resolve => { resolveConfig = resolve; });
  const oldRejects = [];
  const newRejects = [];
  const client = new BaileysClient({ instanceId: 'call-reconnect' });
  const oldSocket = { rejectCall: async (...args) => oldRejects.push(args) };
  const newSocket = { rejectCall: async (...args) => newRejects.push(args) };
  client._sock = oldSocket;
  let pending;
  client.on('call', call => {
    pending = manager.dispatchIncomingCall('call-reconnect', client, call, 'baileys', {
      ...deps(null),
      tenantAdmin: { findRow: () => config },
      rejectCall: async (_active, incoming) => incoming.reject()
    });
  });
  client._onCall([{ id: 'reconnect-offer', from: phone + '@s.whatsapp.net', status: 'offer' }], oldSocket);
  client._sock = newSocket;
  resolveConfig({ calls_disabled: true });
  await pending;
  assert.deepEqual(oldRejects, [['reconnect-offer', phone + '@s.whatsapp.net']]);
  assert.deepEqual(newRejects, []);
});

test('unknown instance rejects safely and a malformed calls flag does not enable calls', async () => {
  for (const row of [null, {}, { calls_disabled: 'false' }, { calls_disabled: 0 }]) {
    let rejects = 0;
    const result = await manager.handleIncomingCall('unknown-fixture', {}, { from: phone }, {
      ...deps(row),
      rejectCall: async () => { rejects++; return true; }
    });
    assert.equal(rejects, 1);
    assert.equal(result.rejected, true);
  }
});

test('send WAL defaults to the same persistent auth tree as Docker, with explicit override supported', () => {
  assert.equal(server.resolveSendWalDir({}, '/srv/whatspro'), '/srv/whatspro/whatsapp_auth/.send-wal');
  assert.equal(server.resolveSendWalDir({ WHATSAPP_AUTH_PATH: '/persistent/auth' }, '/srv/whatspro'), '/persistent/auth/.send-wal');
  assert.equal(server.resolveSendWalDir({ WHATSAPP_AUTH_PATH: '/persistent/auth', WHATSPRO_SEND_WAL_DIR: '/persistent/outbox' }, '/srv/whatspro'), '/persistent/outbox');
});


test('the shared language key is tenant scoped and context lookup happens after rejecting', async t => {
  const { redisClient } = require('../config/redis');
  const actions = [];
  t.mock.method(redisClient, 'sendCommand', async args => {
    actions.push(args);
    return 'ru';
  });
  const deliveries = [];
  const options = deps({ calls_disabled: true, locale: 'kk' }, deliveries);
  delete options.getStoredLanguage;
  await manager.handleIncomingCall('call-lang-fixture', {}, { from: phone }, {
    ...options,
    rejectCall: async () => { actions.push('reject'); return true; }
  });
  assert.deepEqual(actions, ['reject', ['GET', 'lang:call-lang-fixture:' + phone]]);
  assert.equal(deliveries[0].text, RU);
});

test('test mode and a failed policy lookup block the reply but still reject', async () => {
  for (const getTestModePolicy of [
    async () => ({ enabled: true, devPhones: ['77000000002'] }),
    async () => { throw new Error('policy unavailable'); }
  ]) {
    let rejected = 0;
    let delivered = 0;
    const options = deps({ calls_disabled: true });
    delete options.isPhoneAllowed;
    const result = await manager.handleIncomingCall('call-policy-fixture', {}, { from: phone }, {
      ...options,
      getTestModePolicy,
      rejectCall: async () => { rejected++; return true; },
      deliverText: async () => { delivered++; return { success: true }; }
    });
    assert.equal(rejected, 1);
    assert.equal(delivered, 0);
    assert.equal(result.replied, false);
  }
});

test('a nonresponding rejection is attempted once and cannot withhold the call reply forever', async () => {
  let release;
  const hung = new Promise(resolve => { release = resolve; });
  const unblock = setTimeout(() => release(true), 2300);
  let attempts = 0;
  const started = Date.now();
  try {
    const result = await manager.handleIncomingCall('call-hung-fixture', {}, { from: phone }, {
      ...deps({ calls_disabled: true }),
      rejectCall: () => { attempts++; return hung; }
    });
    assert.equal(attempts, 1);
    assert.equal(result.rejected, false, 'unconfirmed rejection is reported honestly');
    assert.equal(result.replied, true);
    assert.ok(Date.now() - started < 2200, 'reply after the 2 second reject budget');
  } finally {
    clearTimeout(unblock);
    release(true);
  }
});


test('tenant create and general update reject invalid call toggles before any write', async t => {
  let writes = 0;
  t.mock.method(tenantStore, 'findRow', async id => id === 'call-invalid' ? { instance_id: id, brand: 'Synthetic', alemi_instance: id, alemi_api_url: 'https://fixture.invalid', calls_disabled: true } : null);
  t.mock.method(tenantStore, 'listTenantRecords', async () => []);
  t.mock.method(tenantStore, 'updateRow', async () => { writes++; });
  t.mock.method(tenantStore, 'createRow', async () => { writes++; });
  for (const callsDisabled of ['false', 0, null, {}]) {
    await assert.rejects(() => tenantAdmin.createTenant({ instanceId: 'call-new-invalid', brand: 'Synthetic', alemiSecret: 'synthetic-key-for-fixture', callsDisabled }), error => error.message === 'CALLS_DISABLED_BOOLEAN_REQUIRED' && error.statusCode === 400);
    await assert.rejects(() => tenantAdmin.updateTenant('call-invalid', { callsDisabled }), error => error.message === 'CALLS_DISABLED_BOOLEAN_REQUIRED' && error.statusCode === 400);
  }
  assert.equal(writes, 0);
});

