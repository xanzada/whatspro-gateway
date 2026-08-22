const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

// The chat panel is framed by hub.alemi.kz and has no login of its own, so
// /api/chat/session/:instanceId used to mint a 24h instance-scoped chat token for
// anyone who asked. That token satisfies requireChatUiOrApi, which guards the
// inbox, the history, the media (Kaspi receipt PDFs), send and delete - so the
// open internet could read every restaurant's conversations, write as the
// restaurant, and destroy chats. Reproduced against the live public endpoint on
// 2026-08-22: GET /api/chat/session/prestige -> 200 with a working token.
//
// The fix must satisfy two requirements at once:
//   1. an anonymous caller gets nothing;
//   2. the operator is NEVER asked to log in - the panel renews itself.
// These tests pin both halves.

process.env.WHATSPRO_SESSION_SECRET = process.env.WHATSPRO_SESSION_SECRET || 'test-secret-for-panel-grant-checks';

function grantCookie(headers) {
  const raw = headers.getSetCookie ? headers.getSetCookie() : [headers.get('set-cookie')].filter(Boolean);
  return raw.map(String).find(value => value.startsWith('whatspro_panel=')) || '';
}

function cookieValue(setCookie) {
  return String(setCookie).split(';')[0];
}

async function startServer(t) {
  const tenantStore = require('../services/tenantStore');
  const original = tenantStore.getTenantChatConfig;
  tenantStore.getTenantChatConfig = async instance => tenantStore.sanitizeTenantConfig(
    instance === 'prestige' ? { instance_id: instance, brand: 'Prestige' } : null,
    instance
  );
  t.after(() => { tenantStore.getTenantChatConfig = original; });

  const { app } = require('../src/server');
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

test('an anonymous caller cannot mint a chat token', async t => {
  const base = await startServer(t);

  const anonymous = await fetch(`${base}/api/chat/session/prestige`);
  assert.equal(anonymous.status, 401, 'the mint must refuse a caller with no proof of prior access');
  const body = await anonymous.json().catch(() => ({}));
  assert.equal(body.chatToken, undefined, 'no token may leak in the refusal body');

  // A forged signature must not pass either.
  const forged = Buffer.from('prestige:' + (Date.now() + 60000)).toString('base64url') + '.deadbeef';
  const spoofed = await fetch(`${base}/api/chat/session/prestige`, {
    headers: { 'x-chat-token': forged, 'x-chat-instance': 'prestige' }
  });
  assert.equal(spoofed.status, 401, 'a forged token signature must not buy a real token');
});

test('the shell render hands out a panel grant that keeps the operator logged in', async t => {
  const base = await startServer(t);

  const shell = await fetch(`${base}/chat.html?instance=prestige`);
  assert.equal(shell.status, 200);
  const cookie = grantCookie(shell.headers);
  assert.ok(cookie, 'the shell must set whatspro_panel so the panel can renew itself');
  assert.match(cookie, /HttpOnly/i, 'the grant must not be readable from script');

  // The operator never logs in: the grant alone renews the token.
  const renewed = await fetch(`${base}/api/chat/session/prestige`, {
    headers: { cookie: cookieValue(cookie) }
  });
  assert.equal(renewed.status, 200, 'a panel holding the grant must renew without a login');
  const payload = await renewed.json();
  assert.equal(typeof payload.chatToken, 'string');
  assert.equal(payload.chatToken.split('.').length, 2);

  // And the renewed token really opens the guarded routes.
  const guarded = await fetch(`${base}/api/chat/action/prestige/77476884956`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-chat-token': payload.chatToken,
      'x-chat-instance': 'prestige'
    },
    body: JSON.stringify({ action: 'close' })
  });
  assert.notEqual(guarded.status, 401, 'a freshly renewed token must pass the chat auth gate');
});

test('a grant for one restaurant cannot mint a token for another', async t => {
  const base = await startServer(t);
  const shell = await fetch(`${base}/chat.html?instance=prestige`);
  const cookie = cookieValue(grantCookie(shell.headers));

  const crossTenant = await fetch(`${base}/api/chat/session/other-tenant`, {
    headers: { cookie }
  });
  assert.equal(crossTenant.status, 401, 'the grant is scoped to its own instance');
});

test('an expired chat token renews itself, so a panel open for days never 401s', async t => {
  const base = await startServer(t);
  const { __test } = require('../src/server');

  // Exactly the state an operator hits after a weekend: signed by us, instance
  // matches, expiry in the past.
  const stale = __test.issueChatToken('prestige', Date.now() - 60 * 60 * 1000);
  const renewed = await fetch(`${base}/api/chat/session/prestige`, {
    headers: { 'x-chat-token': stale, 'x-chat-instance': 'prestige' }
  });
  assert.equal(renewed.status, 200, 'an aged-out token must buy its replacement');

  // Beyond the grace window it must stop working, otherwise a leaked token is
  // valid forever.
  const ancient = __test.issueChatToken('prestige', Date.now() - 400 * 24 * 60 * 60 * 1000);
  const refused = await fetch(`${base}/api/chat/session/prestige`, {
    headers: { 'x-chat-token': ancient, 'x-chat-instance': 'prestige' }
  });
  assert.equal(refused.status, 401, 'a token far outside the renewal window must not renew');
});

test('the panel grant is signed with its own prefix, so a chat token is not a grant', async t => {
  const { __test } = require('../src/server');
  const chatToken = __test.issueChatToken('prestige');
  const asCookie = { headers: { cookie: `whatspro_panel=${chatToken}` }, params: {} };
  assert.equal(
    __test.hasPanelGrant(asCookie, 'prestige'),
    false,
    'domain separation: a chat token pasted into the grant cookie must not authenticate'
  );

  const realGrant = __test.issuePanelGrant('prestige');
  assert.equal(
    __test.hasPanelGrant({ headers: { cookie: `whatspro_panel=${realGrant}` }, params: {} }, 'prestige'),
    true
  );
  assert.equal(
    __test.hasPanelGrant({ headers: { cookie: `whatspro_panel=${realGrant}` }, params: {} }, 'kabab-1'),
    false
  );
  const expired = __test.issuePanelGrant('prestige', Date.now() - 1000);
  assert.equal(
    __test.hasPanelGrant({ headers: { cookie: `whatspro_panel=${expired}` }, params: {} }, 'prestige'),
    false
  );
});

test('health/detailed stays open on loopback and closed from anywhere else', async t => {
  const base = await startServer(t);

  // The container healthcheck runs `fetch('http://127.0.0.1:3000/health/detailed')`
  // (docker-compose.yml). Breaking loopback would mark the tenant unhealthy and
  // restart it, so this must keep working with no credential.
  const local = await fetch(`${base}/health/detailed`);
  assert.equal(local.status, 200, 'the compose healthcheck calls this over loopback');
  const body = await local.json();
  assert.equal(body.service, 'whatspro');

  const { __test } = require('../src/server');
  assert.equal(__test.isLoopbackRequest({ ip: '127.0.0.1' }), true);
  assert.equal(__test.isLoopbackRequest({ ip: '::1' }), true);
  assert.equal(__test.isLoopbackRequest({ ip: '::ffff:127.0.0.1' }), true);
  // A public caller used to receive the Redis host, the Openbot host, the tenant
  // count and the instance ids still needing a QR scan - the ids needed to attack
  // the mint above.
  assert.equal(__test.isLoopbackRequest({ ip: '203.0.113.9' }), false);
  assert.equal(__test.isLoopbackRequest({ ip: '10.0.1.30' }), false, 'the Traefik hop is not loopback');
});

test('/health stays public and cheap for the liveness probe', async t => {
  const base = await startServer(t);
  const response = await fetch(`${base}/health`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body, { ok: true, service: 'whatspro' });
});

test('the panel sends its token back when renewing, not just the cookie', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const chatJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'chat.js'), 'utf8');
  // Third-party cookies are blocked in many browsers, so inside the Hub iframe the
  // header is the proof that actually arrives.
  assert.match(chatJs, /renewalHeaders\['x-chat-token'\] = chatToken/);
  assert.match(chatJs, /credentials: 'include'/);
});
