'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { __test: serverTest } = require('../src/server');
const nocodb = require('../services/nocodbConfig');

// A restaurant may hold its own key. It must open that restaurant and nothing
// else, or handing 50 tenants their keys hands each of them all the others.
test('a tenant key opens its own instance and no other', async t => {
  const original = nocodb.getTenantApiToken;
  const tokens = { alpha: 'alpha-secret-token', beta: 'beta-secret-token' };
  nocodb.getTenantApiToken = async instanceId => tokens[instanceId] || '';
  t.after(() => { nocodb.getTenantApiToken = original; });

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

test('an owner-only route rejects a tenant key because it names no instance', async t => {
  const original = nocodb.getTenantApiToken;
  nocodb.getTenantApiToken = async () => 'alpha-secret-token';
  t.after(() => { nocodb.getTenantApiToken = original; });

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
