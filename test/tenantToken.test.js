'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { __test: serverTest } = require('../src/server');
const tenantStore = require('../services/tenantStore');

// A restaurant may hold its own key. It must open that restaurant and nothing
// else, or handing 50 tenants their keys hands each of them all the others.
test('a tenant key opens its own instance and no other', async t => {
  const original = tenantStore.getTenantApiToken;
  const tokens = { alpha: 'alpha-secret-token', beta: 'beta-secret-token' };
  tenantStore.getTenantApiToken = async instanceId => tokens[instanceId] || '';
  t.after(() => { tenantStore.getTenantApiToken = original; });

  const previousMaster = process.env.WHATSPRO_API_TOKEN;
  process.env.WHATSPRO_API_TOKEN = 'platform-master-token';
  t.after(() => {
    if (previousMaster === undefined) delete process.env.WHATSPRO_API_TOKEN;
    else process.env.WHATSPRO_API_TOKEN = previousMaster;
  });

  const app = express();
  app.get('/api/chat/inbox/:instanceId', serverTest.requireChatUiOrApi, (req, res) => res.json({ ok: true, instanceId: req.params.instanceId }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api/chat/inbox`;
  const call = (instance, token) => fetch(`${base}/${instance}`, { headers: { 'x-api-key': token } }).then(r => r.status);

  assert.equal(await call('alpha', 'alpha-secret-token'), 200, 'own instance opens');
  assert.equal(await call('beta', 'beta-secret-token'), 200, 'the other tenant opens its own too');
  assert.equal(await call('beta', 'alpha-secret-token'), 401, 'alpha must never reach beta');
  assert.equal(await call('alpha', 'beta-secret-token'), 401, 'beta must never reach alpha');
  assert.equal(await call('alpha', 'platform-master-token'), 200, 'the platform key still reaches everything');
  assert.equal(await call('beta', 'platform-master-token'), 200);
  assert.equal(await call('alpha', 'not-a-token'), 401, 'an unknown key opens nothing');
  assert.equal(await call('gamma', 'alpha-secret-token'), 401, 'an instance with no key of its own stays closed');
});

// /api/send authenticates before parsing its body, so the instance can only come
// from a header there. That opens a second question the header cannot answer on
// its own: what stops a request authenticating as beta and then asking the parsed
// body to send as alpha.
test('a tenant key authenticates a send by header and cannot then send as another instance', async t => {
  const original = tenantStore.getTenantApiToken;
  const tokens = { alpha: 'alpha-secret-token', beta: 'beta-secret-token' };
  tenantStore.getTenantApiToken = async instanceId => tokens[instanceId] || '';
  t.after(() => { tenantStore.getTenantApiToken = original; });

  const previousMaster = process.env.WHATSPRO_API_TOKEN;
  process.env.WHATSPRO_API_TOKEN = 'platform-master-token';
  t.after(() => {
    if (previousMaster === undefined) delete process.env.WHATSPRO_API_TOKEN;
    else process.env.WHATSPRO_API_TOKEN = previousMaster;
  });

  const app = express();
  // The real route parses the body after the guard, exactly as production does.
  app.post('/api/send', serverTest.requireApi, express.json(), (req, res) => {
    const instanceId = String(req.body?.instanceId || '');
    if (!serverTest.withinApiScope(req, instanceId)) return res.status(403).json({ error: 'INSTANCE_OUT_OF_SCOPE' });
    res.json({ ok: true, instanceId });
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/send`;

  const send = (token, headerInstance, bodyInstance) => fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': token,
      ...(headerInstance ? { 'x-chat-instance': headerInstance } : {})
    },
    body: JSON.stringify({ instanceId: bodyInstance, phone: '77015550101', text: 'hi' })
  }).then(response => response.status);

  assert.equal(await send('alpha-secret-token', 'alpha', 'alpha'), 200, 'a restaurant sends its own message');
  assert.equal(await send('alpha-secret-token', 'alpha', 'beta'), 403, 'and cannot send as somebody else');
  assert.equal(await send('alpha-secret-token', 'beta', 'beta'), 401, 'claiming beta with alpha\'s key fails at the door');
  assert.equal(await send('alpha-secret-token', '', 'alpha'), 401, 'without the header there is nothing to scope to');
  assert.equal(await send('platform-master-token', '', 'alpha'), 200, 'the platform key still sends for anyone');
  assert.equal(await send('platform-master-token', '', 'beta'), 200);
});

test('an owner-only route rejects a tenant key because it names no instance', async t => {
  const original = tenantStore.getTenantApiToken;
  tenantStore.getTenantApiToken = async () => 'alpha-secret-token';
  t.after(() => { tenantStore.getTenantApiToken = original; });

  const previousMaster = process.env.WHATSPRO_API_TOKEN;
  process.env.WHATSPRO_API_TOKEN = 'platform-master-token';
  t.after(() => {
    if (previousMaster === undefined) delete process.env.WHATSPRO_API_TOKEN;
    else process.env.WHATSPRO_API_TOKEN = previousMaster;
  });

  const app = express();
  app.get('/api/wa/instances', serverTest.requireUiOrApi, (_req, res) => res.json({ ok: true }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/wa/instances`;

  const tenant = await fetch(url, { headers: { 'x-api-key': 'alpha-secret-token' } });
  assert.equal(tenant.status, 401, 'listing every restaurant is not a tenant action');
  const master = await fetch(url, { headers: { 'x-api-key': 'platform-master-token' } });
  assert.equal(master.status, 200, 'the platform key still lists them');
});
