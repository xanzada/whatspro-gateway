'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFile } = require('fs/promises');

// C25, found 2026-08-23 by the owner: chat.html?instance=kebab1 would not open.
//
// The hub's integration page links the panel using ITS id (alemi_instance); whatspro
// resolves tenants by instance_id. Measured live:
//
//   /api/chat/session/kebab1   -> 404 TENANT_NOT_FOUND    (the panel dies here)
//   /api/chat/session/kabab-1  -> 200 chatToken
//   /api/chat/inbox/kebab1     -> 200 { items: [] }       (worse than 404: reads as
//                                                          "the customer never wrote")
//
// prestige hides it because both ids are the same string there. With 20-30 restaurants,
// every tenant whose ids differ has a dead panel.

const tenantStore = require('../services/tenantStore.js');
const read = (relative) => readFile(new URL(relative, `file://${__filename}`), 'utf8');

test('the resolver is exported and tolerates junk without throwing', async () => {
  assert.equal(typeof tenantStore.resolveInstanceAlias, 'function');
  // Redis is unreachable in this suite, so these exercise the fallback path.
  assert.equal(await tenantStore.resolveInstanceAlias(''), null);
  assert.equal(await tenantStore.resolveInstanceAlias(null), null);
  assert.equal(await tenantStore.resolveInstanceAlias('   '), null);
  // An unknown id resolves to null rather than inventing a tenant.
  assert.equal(await tenantStore.resolveInstanceAlias('definitely-not-a-tenant'), null);
});

test('a canonical id always wins, so an alias can never shadow a real tenant', async () => {
  const source = await read('../services/tenantStore.js');
  const fn = source.slice(source.indexOf('async function resolveInstanceAlias'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  // The findRow check must come BEFORE the index lookup. Otherwise a tenant whose
  // instance_id happens to equal another tenant's alemi_instance would be hijacked.
  assert.ok(
    body.indexOf('if (await findRow(requested)) return requested;') <
      body.indexOf('ALEMI_INSTANCE_INDEX_KEY'),
    'the canonical lookup has to run first'
  );
  // And the resolved owner must itself exist, or a stale index entry would point at a
  // deleted tenant.
  assert.match(body, /normalizedOwner && \(await findRow\(normalizedOwner\)\)/);
});

test('the resolver survives Redis being down', async () => {
  const source = await read('../services/tenantStore.js');
  const fn = source.slice(source.indexOf('async function resolveInstanceAlias'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  // The snapshot mirrors every row, so a restart during an outage still resolves the
  // alias instead of showing every operator a dead panel.
  assert.match(body, /listTenantRecords\(\)/);
  assert.match(body, /normalizeInstance\(row\?\.alemi_instance\) === requested/);
});

test('every chat route resolves the alias, not just the one that 404ed', async () => {
  const server = await read('../src/server.js');
  // Fixing only /session would open the panel and then break sending, media and the
  // operator lock - each of which takes :instanceId separately.
  const routes = [
    "app.get('/api/chat/session/:instanceId', resolveChatInstance",
    "app.get('/api/chat/inbox/:instanceId', resolveChatInstance",
    "app.get('/api/chat/events/:instanceId', resolveChatInstance",
    "app.get('/api/chat/inbox-legacy/:instanceId', resolveChatInstance",
    "app.get('/api/chat/history/:instanceId/:phone', resolveChatInstance",
    "app.get('/api/chat/media/:instanceId/:messageId', resolveChatInstance",
    "app.post('/api/chat/send/:instanceId/:phone', resolveChatInstance",
    "app.post('/api/chat/operator-lock/:instanceId/:phone', resolveChatInstance",
    "app.get('/api/chat/operator-lock/:instanceId/:phone', resolveChatInstance",
    "app.post('/api/chat/action/:instanceId/:phone', resolveChatInstance",
  ];
  for (const route of routes) {
    assert.ok(server.includes(route), `missing alias resolution: ${route}`);
  }
});

test('the alias is resolved BEFORE auth, so one id owns the whole request', async () => {
  const server = await read('../src/server.js');
  // hasScopedChatToken compares the token's instance against req.params.instanceId, and
  // setPanelGrant writes a cookie for it. Resolving after auth would mint a token for
  // "kebab1" while the grant said "kabab-1", and the two would fight on every renewal.
  assert.match(server, /app\.get\('\/api\/chat\/session\/:instanceId', resolveChatInstance, async/);
  assert.match(
    server,
    /app\.get\('\/api\/chat\/inbox\/:instanceId', resolveChatInstance, requireChatUiOrApi/,
    'resolveChatInstance must precede the auth middleware'
  );
  const mw = server.slice(server.indexOf('async function resolveChatInstance'));
  const body = mw.slice(0, mw.indexOf('\n}'));
  assert.match(body, /req\.params\.instanceId = canonical;/);
  // A bad id is still rejected up front rather than reaching storage.
  assert.match(body, /if \(!isValidInstanceId\(requested\)\) return res\.status\(400\)/);
  // A resolver failure must not take the route down; the request continues with the
  // requested id and the route reports TENANT_NOT_FOUND exactly as before.
  assert.match(body, /catch \{\s*\n\s*canonical = requested;/);
});

test('the panel is told the canonical id so it stops using the alias', async () => {
  const server = await read('../src/server.js');
  const mw = server.slice(server.indexOf('async function resolveChatInstance'));
  const body = mw.slice(0, mw.indexOf('\n}'));
  assert.match(body, /res\.set\('X-Chat-Instance', canonical\)/);
  // Only when it actually changed - no header noise on the common case.
  assert.ok(body.indexOf('if (canonical !== requested)') < body.indexOf("res.set('X-Chat-Instance'"));
});
