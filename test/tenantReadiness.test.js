'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { evaluateTenant, evaluateAll, collisionsAcross } = require('../services/tenantReadiness');
const { __test: serverTest } = require('../src/server');
const tenantStore = require('../services/tenantStore');

function completeRow(overrides = {}) {
  return {
    instance_id: 'prestige',
    whatsapp_phone: '77015550101',
    domain: 'prestige.kz',
    whatspro_base_url: 'https://wa.alemi.kz',
    whatspro_api_token: 'a'.repeat(32),
    system_prompt: 'x'.repeat(400),
    webhook_secret: 'b'.repeat(24),
    kanban_secret: 'c'.repeat(24),
    brand: 'Prestige',
    work_hours: '10:00-23:00',
    address: 'Абай даңғылы 10',
    dev_phone: '77015550999',
    ...overrides
  };
}

function checkFor(report, id) {
  return report.checks.find(check => check.id === id);
}

test('a fully filled row reports ready with nothing outstanding', () => {
  const report = evaluateTenant(completeRow());
  assert.equal(report.instanceId, 'prestige');
  assert.equal(report.brand, 'Prestige');
  assert.equal(report.summary.ready, true);
  assert.deepEqual(report.summary.blocking, []);
  assert.deepEqual(report.summary.warnings, []);
});

test('tenant list exposes bot control without changing WhatsApp active state', () => {
  const paused = evaluateTenant(completeRow({ active: true, bot_enabled: false }));
  assert.equal(paused.active, true);
  assert.equal(paused.botEnabled, false);
  assert.equal(evaluateTenant(completeRow()).botEnabled, true, 'legacy rows remain enabled by default');
});

test('every column the bot cannot run without blocks readiness on its own', () => {
  for (const column of ['whatsapp_phone', 'domain', 'whatspro_base_url', 'whatspro_api_token', 'system_prompt', 'webhook_secret']) {
    const report = evaluateTenant(completeRow({ [column]: '' }));
    assert.equal(report.summary.ready, false, `${column} missing must block`);
    assert.deepEqual(report.summary.blocking, [column]);
    assert.equal(checkFor(report, column).code, 'MISSING');
  }
});

test('a column that is filled but unusable is caught, not counted as done', () => {
  // The failure this exists for: somebody pastes "wa.alemi.kz" without the
  // scheme, and the send URL silently never resolves.
  assert.equal(checkFor(evaluateTenant(completeRow({ whatspro_base_url: 'wa.alemi.kz' })), 'whatspro_base_url').code, 'INVALID');
  assert.equal(checkFor(evaluateTenant(completeRow({ whatsapp_phone: '7701' })), 'whatsapp_phone').code, 'INVALID');
  assert.equal(checkFor(evaluateTenant(completeRow({ whatspro_api_token: 'short' })), 'whatspro_api_token').code, 'INVALID');
  assert.equal(checkFor(evaluateTenant(completeRow({ system_prompt: 'Сәлем айт' })), 'system_prompt').code, 'INVALID');
  assert.equal(checkFor(evaluateTenant(completeRow({ domain: 'not a domain' })), 'domain').code, 'INVALID');
});

test('the site column is accepted in every shape an operator writes it', () => {
  for (const domain of ['prestige.kz', 'https://prestige.kz', 'https://prestige.kz/', 'http://sub.prestige.kz/index.php']) {
    assert.equal(checkFor(evaluateTenant(completeRow({ domain })), 'domain').ok, true, domain);
  }
});

test('a missing nicety warns without holding the restaurant back', () => {
  const report = evaluateTenant(completeRow({ address: '', dev_phone: '' }));
  assert.equal(report.summary.ready, true, 'the bot still takes orders');
  assert.deepEqual(report.summary.warnings.sort(), ['address', 'dev_phone']);
});

test('alternate column spellings count as filled', () => {
  const row = completeRow();
  delete row.whatsapp_phone;
  delete row.domain;
  row.bot_phone = '77015550101';
  row.site_url = 'prestige.kz';
  const report = evaluateTenant(row);
  assert.equal(report.summary.ready, true);
});

test('two restaurants sharing one WhatsApp number is reported as a collision', () => {
  const collisions = collisionsAcross([
    completeRow({ instance_id: 'prestige' }),
    completeRow({ instance_id: 'shymkent', whatspro_api_token: 'd'.repeat(32) })
  ]);
  const shared = collisions.find(entry => entry.kind === 'shared_whatsapp_phone');
  assert.ok(shared, 'the same number in two rows must surface');
  assert.deepEqual(shared.instances.sort(), ['prestige', 'shymkent']);
});

test('two restaurants sharing one API token is reported, because one could read the other', () => {
  const collisions = collisionsAcross([
    completeRow({ instance_id: 'prestige' }),
    completeRow({ instance_id: 'shymkent', whatsapp_phone: '77015550202' })
  ]);
  const shared = collisions.find(entry => entry.kind === 'shared_api_token');
  assert.ok(shared);
  assert.deepEqual(shared.instances.sort(), ['prestige', 'shymkent']);
});

test('a duplicated instance_id is reported because which row wins is not defined', () => {
  const collisions = collisionsAcross([
    completeRow({ whatsapp_phone: '77015550101' }),
    completeRow({ whatsapp_phone: '77015550202', whatspro_api_token: 'd'.repeat(32) })
  ]);
  assert.equal(collisions.filter(entry => entry.kind === 'duplicate_instance_id').length, 1);
});

test('a colliding restaurant is not counted as ready even though its own row is perfect', () => {
  const report = evaluateAll([
    completeRow({ instance_id: 'prestige' }),
    completeRow({ instance_id: 'shymkent', whatspro_api_token: 'd'.repeat(32) })
  ]);
  assert.equal(report.total, 2);
  assert.equal(report.ready, 0, 'a shared number makes both unsafe, not neither');
  assert.equal(report.tenants.every(tenant => tenant.summary.ready === false), true);
});

test('fifty clean restaurants all read as ready and produce no collisions', () => {
  const rows = Array.from({ length: 50 }, (_, index) => completeRow({
    instance_id: `rest${index}`,
    brand: `Restaurant ${index}`,
    whatsapp_phone: `7701555${String(index).padStart(4, '0')}`,
    whatspro_api_token: `token${String(index).padStart(2, '0')}${'z'.repeat(26)}`,
    domain: `rest${index}.kz`
  }));
  const report = evaluateAll(rows);
  assert.equal(report.total, 50);
  assert.equal(report.ready, 50);
  assert.deepEqual(report.collisions, []);
});

test('rows with no instance_id are ignored rather than reported as broken tenants', () => {
  const report = evaluateAll([completeRow(), { brand: 'Draft row', address: 'somewhere' }, null]);
  assert.equal(report.total, 1);
});

test('a perfect row with no WhatsApp session is still not ready', () => {
  const withoutSession = evaluateTenant(completeRow(), { sessions: [] });
  assert.equal(withoutSession.summary.ready, false);
  assert.deepEqual(withoutSession.summary.blocking, ['whatsapp_session']);

  const scannedButDown = evaluateTenant(completeRow(), { sessions: [{ instanceId: 'prestige', status: 'qr_required' }] });
  assert.equal(scannedButDown.summary.ready, false);
  assert.equal(checkFor(scannedButDown, 'whatsapp_session').code, 'STATUS_QR_REQUIRED');

  const live = evaluateTenant(completeRow(), { sessions: [{ instanceId: 'prestige', status: 'connected' }] });
  assert.equal(live.summary.ready, true);
});

test('the readiness route is owner-only and never returns a secret', async t => {
  const originalList = tenantStore.listTenantRecords;
  tenantStore.listTenantRecords = async () => [completeRow()];
  t.after(() => { tenantStore.listTenantRecords = originalList; });

  const previousMaster = process.env.WHATSPRO_API_TOKEN;
  process.env.WHATSPRO_API_TOKEN = 'platform-master-token';
  t.after(() => {
    if (previousMaster === undefined) delete process.env.WHATSPRO_API_TOKEN;
    else process.env.WHATSPRO_API_TOKEN = previousMaster;
  });

  const app = express();
  app.get('/api/wa/tenants', serverTest.requireUiOrApi, async (_req, res) => {
    const records = await tenantStore.listTenantRecords();
    res.json({ success: true, ...evaluateAll(records, { sessions: [] }) });
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/wa/tenants`;

  assert.equal((await fetch(url)).status, 401, 'the checklist lists every restaurant, so it is owner-only');

  const response = await fetch(url, { headers: { 'x-api-key': 'platform-master-token' } });
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.equal(body.includes('a'.repeat(32)), false, 'the API token must never appear in the report');
  assert.equal(body.includes('b'.repeat(24)), false, 'nor the webhook secret');
  assert.equal(JSON.parse(body).tenants[0].instanceId, 'prestige');
});
