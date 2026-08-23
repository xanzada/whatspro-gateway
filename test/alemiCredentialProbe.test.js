'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// C22, found 2026-08-23: nothing ever asked the hub whether a tenant's Alemi credential
// works. The one check that looked related, alemiInstanceMatchCheck, compared
// alemi_instance to our own instance_id - two values that legitimately differ (kabab-1 vs
// kebab1) - so it sat permanently yellow for healthy tenants and was indistinguishable
// from the tenant that was genuinely broken. A single transposed vowel (kabab1 where the
// hub has kebab1) silenced a restaurant's runtime reads for days while the panel showed
// nothing but that same warning.

const readiness = require('../services/tenantReadiness.js');
const { probeAlemiCredential, probeAlemiCredentials, hubCredentialCheck, alemiInstanceMatchCheck, evaluateAll } = readiness;

const ROW = (over = {}) => ({
  instance_id: 'kabab-1',
  brand: 'Kebab',
  whatsapp_phone: '+77476884956',
  domain: 'kebab1.alemi.kz',
  address: 'x',
  work_hours: '10-22',
  alemi_api_url: 'https://hub.alemi.kz',
  alemi_instance: 'kebab1',
  alemi_secret: 'secret123456',
  whatspro_base_url: 'https://whatspro.alemi.kz',
  whatspro_api_token: 't'.repeat(40),
  system_prompt: 'p',
  webhook_secret: 'w'.repeat(40),
  kanban_secret: 'k'.repeat(40),
  dev_phone: '+77476884956',
  active: true,
  ...over,
});

function fakeFetch(handler) {
  return async (url, init) => handler(url, init);
}

test('the probe signs exactly what openbot signs', async () => {
  let seen = null;
  await probeAlemiCredential(ROW(), fakeFetch(async (url, init) => {
    seen = { url, init };
    return { ok: true, status: 200 };
  }));

  // If this shape drifts from alemiApi.service.ts the probe becomes a lie, so it is
  // asserted field by field rather than trusted.
  assert.equal(seen.url, 'https://hub.alemi.kz/v1/integrations/bot/commands');
  assert.equal(seen.init.method, 'POST');
  const body = JSON.parse(seen.init.body);
  assert.equal(body.command, 'runtime.status.get');
  assert.equal(body.instance, 'kebab1');
  assert.equal(body.schema_version, 1);
  assert.deepEqual(body.data, {});
  assert.match(body.command_id, /^cmd_[0-9A-F]{26}$/);

  const headers = seen.init.headers;
  assert.equal(headers['X-Platform-Instance'], 'kebab1');
  assert.equal(headers['X-Command-Id'], body.command_id);
  assert.match(headers['X-Command-Timestamp'], /^\d{10}$/);
  // HMAC-SHA256 over "<ts>.<rawBody>", prefixed v1=, hex.
  const crypto = require('crypto');
  const expected = 'v1=' + crypto
    .createHmac('sha256', 'secret123456')
    .update(`${headers['X-Command-Timestamp']}.${seen.init.body}`, 'utf8')
    .digest('hex');
  assert.equal(headers['X-Command-Signature'], expected);
});

test('the probe classifies accepted, rejected and unreachable apart', async () => {
  assert.deepEqual(
    await probeAlemiCredential(ROW(), fakeFetch(async () => ({ ok: true, status: 200 }))),
    { status: 'accepted', httpStatus: 200 }
  );
  assert.deepEqual(
    await probeAlemiCredential(ROW(), fakeFetch(async () => ({ ok: false, status: 401 }))),
    { status: 'rejected', httpStatus: 401 }
  );
  // A network failure says nothing about the credential and must not be reported as one.
  const dead = await probeAlemiCredential(ROW(), fakeFetch(async () => { throw new Error('ECONNRESET'); }));
  assert.equal(dead.status, 'unreachable');
});

test('an incomplete row is skipped rather than probed', async () => {
  for (const missing of ['alemi_instance', 'alemi_secret', 'alemi_api_url']) {
    const result = await probeAlemiCredential(ROW({ [missing]: '' }), fakeFetch(async () => {
      throw new Error('must not reach the network');
    }));
    assert.deepEqual(result, { status: 'skipped', reason: 'INCOMPLETE' });
  }
});

test('a paused restaurant is not probed at all', async () => {
  const probes = await probeAlemiCredentials([ROW({ active: false })], {
    fetchImpl: async () => { throw new Error('must not reach the network'); },
  });
  assert.deepEqual(probes['kabab-1'], { status: 'skipped', reason: 'INACTIVE' });
});

test('a hub outage does not paint the panel red', () => {
  // UNREACHABLE and NOT_PROBED are both ok:true. Reporting a transport failure as a
  // credential fault would turn every hub blip into a page full of faults.
  assert.equal(hubCredentialCheck({ status: 'unreachable', reason: 'TIMEOUT' }).ok, true);
  assert.equal(hubCredentialCheck({ status: 'unreachable', reason: 'TIMEOUT' }).code, 'UNREACHABLE');
  assert.equal(hubCredentialCheck(null).ok, true);
  assert.equal(hubCredentialCheck(null).code, 'NOT_PROBED');
  assert.equal(hubCredentialCheck({ status: 'skipped', reason: 'INACTIVE' }).code, 'NOT_PROBED');
});

test('a rejected credential is a visible, non-blocking warning naming the status', () => {
  const check = hubCredentialCheck({ status: 'rejected', httpStatus: 401 });
  assert.equal(check.ok, false);
  assert.equal(check.code, 'REJECTED_401');
  // Never blocking: a restaurant taking orders must not be declared unready because a
  // signed probe failed once.
  assert.equal(check.level, 'recommended');
  // The hub returns the same 401 for a wrong secret and for an unknown instance, so the
  // guidance has to say both.
  assert.match(check.why, /instance/i);
});

test('a divergence the hub accepts stops being a warning', () => {
  // This is the row that was permanently yellow: instance_id kabab-1, alemi_instance
  // kebab1, credential proven working.
  const accepted = alemiInstanceMatchCheck(ROW(), { status: 'accepted', httpStatus: 200 });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.code, 'DIVERGENT_BUT_ACCEPTED');
});

test('a divergence the hub rejects becomes the prime suspect', () => {
  const rejected = alemiInstanceMatchCheck(ROW({ alemi_instance: 'kabab1' }), { status: 'rejected', httpStatus: 401 });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, 'MISMATCH_AND_REJECTED');
  // The advice must name the actual failure mode: compare the spelling letter by letter.
  assert.match(rejected.why, /kebab1 \/ kabab1/);
});

test('without a probe the check behaves exactly as before', () => {
  assert.equal(alemiInstanceMatchCheck(ROW()).code, 'MISMATCH');
  assert.equal(alemiInstanceMatchCheck(ROW({ alemi_instance: 'kabab-1' })).code, 'OK');
  // And an empty alemi_instance is left to its own required check, not double-reported.
  assert.equal(alemiInstanceMatchCheck(ROW({ alemi_instance: '' })).ok, true);
});

test('the healthy production pair raises neither alemi warning', () => {
  const rows = [
    ROW(),
    ROW({ instance_id: 'prestige', alemi_instance: 'prestige', domain: 'storefront-test-0805.alemi.kz', whatsapp_phone: '+77769156184' }),
  ];
  const probes = { 'kabab-1': { status: 'accepted', httpStatus: 200 }, prestige: { status: 'accepted', httpStatus: 200 } };
  const report = evaluateAll(rows, { hubProbes: probes });
  for (const tenant of report.tenants) {
    // Scoped to the two checks this change owns: the fixture is not a complete row, and
    // asserting on every unrelated field would make this test fail for the wrong reason.
    assert.equal(
      tenant.summary.warnings.includes('alemi_instance_match'),
      false,
      `${tenant.instanceId}: a divergence the hub accepts must not warn`
    );
    assert.equal(
      tenant.summary.warnings.includes('alemi_credential_accepted'),
      false,
      `${tenant.instanceId}: a working credential must not warn`
    );
  }
});

test('evaluateAll without hubProbes adds no credential check', () => {
  // The xlsx export path deliberately spends no network call, so the check must be absent
  // rather than present-and-guessing.
  const report = evaluateAll([ROW()], {});
  const ids = report.tenants[0].checks.map((check) => check.id);
  assert.equal(ids.includes('alemi_credential_accepted'), false);
});
