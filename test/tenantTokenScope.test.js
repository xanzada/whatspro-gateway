'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFile } = require('fs/promises');

// C26, found 2026-08-23 and reproduced live with kabab-1's real tenant token:
//
//   GET  /api/wa/instances?instance=kabab-1   -> 200  instances=2 [prestige, kabab-1]
//   GET  /api/wa/tenants?instance=kabab-1     -> 200  tenants=2   [prestige, kabab-1]
//   GET  /api/wa/shared-prompt?instance=...   -> 200  prompt len=1363
//   POST /api/wa/statuses (both instances)    -> 200  live WhatsApp state of prestige
//
// And the write: PUT /api/wa/shared-prompt calls applySharedPrompt platform-wide, so one
// restaurant's key silently re-personalises every tenant on prompt_mode=shared.
//
// hasApiToken accepts a tenant token whenever the request NAMES its own instance, and
// requestedInstanceId reads ?instance= / body.instanceId / x-chat-instance. The comment on
// that function ("listing every instance stays an owner-only action") holds only while the
// instance is unnamed; naming yourself satisfied the scope check while the handler stayed
// platform-wide.

const read = (relative) => readFile(new URL(relative, `file://${__filename}`), 'utf8');

const PLATFORM_WIDE = [
  "app.get('/api/wa/instances'",
  "app.get('/api/wa/tenants'",
  "app.get('/api/wa/shared-prompt'",
  "app.put('/api/wa/shared-prompt'",
  "app.post('/api/wa/tenants'",
  "app.post('/api/wa/instances'",
  "app.get('/api/wa/tenant-defaults'",
  "app.get('/api/wa/platform-storage'",
  "app.get('/api/wa/scan-requests'",
  "app.post('/api/wa/scan-requests'",
  "app.get('/api/wa/scan-invitations'",
  "app.post('/api/wa/logout'",
];

// Keyed by an opaque id that belongs to whoever created the request, not to the caller.
const OPAQUE_ID = [
  "app.get('/api/wa/scan-requests/:requestId'",
  "app.post('/api/wa/scan-requests/:requestId/reject'",
  "app.post('/api/wa/scan-requests/:requestId/open'",
];

test('every platform-wide route is owner-only', async () => {
  const server = await read('../src/server.js');
  for (const route of [...PLATFORM_WIDE, ...OPAQUE_ID]) {
    const idx = server.indexOf(route);
    assert.ok(idx > 0, `route missing: ${route}`);
    const line = server.slice(idx, server.indexOf('\n', idx));
    assert.match(
      line,
      /requirePlatformAdmin/,
      `${route} answers about the platform, so a tenant token must not reach it: ${line.trim()}`
    );
  }
});

test('a tenant keeps every route that is its own business', async () => {
  const server = await read('../src/server.js');
  // These are what a tenant token is FOR. Taking them away would break Openbot and the
  // restaurant's own panel, so the fix must not over-reach.
  const tenantOwn = [
    "app.get('/api/wa/tenants/:instanceId'",
    "app.get('/api/wa/tenants/:instanceId/settings'",
    "app.patch('/api/wa/tenants/:instanceId'",
    "app.post('/api/wa/tenants/:instanceId/active'",
    "app.post('/api/wa/tenants/:instanceId/bot-enabled'",
    "app.post('/api/wa/tenants/:instanceId/connect-link'",
    "app.get('/api/wa/status/:instanceId'",
    "app.post('/api/wa/restart/:instanceId'",
  ];
  for (const route of tenantOwn) {
    const idx = server.indexOf(route);
    assert.ok(idx > 0, `route missing: ${route}`);
    const line = server.slice(idx, server.indexOf('\n', idx));
    assert.match(line, /requireUiOrApi/, `${route} must stay reachable by its own tenant`);
  }
});

test('a route that takes the instance from the body checks the scope', async () => {
  const server = await read('../src/server.js');
  // /api/wa/start is legitimately called by Openbot for its own tenant, so it is scoped
  // rather than forbidden - the same reason withinApiScope exists on the send path.
  const start = server.slice(server.indexOf("app.post('/api/wa/start'"));
  const body = start.slice(0, start.indexOf('\n});'));
  assert.match(body, /withinApiScope\(req, instanceId\)/);
  assert.match(body, /INSTANCE_SCOPE_MISMATCH/);
  // The scope check must run before anything is created or started.
  assert.ok(body.indexOf('withinApiScope') < body.indexOf('saveInstance'));
  assert.ok(body.indexOf('withinApiScope') < body.indexOf('startWhatsAppInstance'));
});

test('a status list may only contain instances the caller owns', async () => {
  const server = await read('../src/server.js');
  const statuses = server.slice(server.indexOf("app.post('/api/wa/statuses'"));
  const body = statuses.slice(0, statuses.indexOf('\n});'));
  // A tenant polling its own status is the legitimate use, so this is scoped per id rather
  // than owner-only.
  assert.match(body, /instanceIds\.every\(instanceId => withinApiScope\(req, instanceId\)\)/);
  assert.match(body, /INSTANCE_SCOPE_MISMATCH/);
  // And it must run after the id validation, before any lookup.
  assert.ok(body.indexOf('BAD_INSTANCE_IDS') < body.indexOf('withinApiScope'));
});

test('requirePlatformAdmin still lets the operator panel in', async () => {
  const server = await read('../src/server.js');
  const fn = server.slice(server.indexOf('async function requirePlatformAdmin'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  // The panel authenticates with a same-origin session cookie, not a token, so tightening
  // these routes must not lock the owner out of their own UI.
  assert.match(body, /if \(readSession\(req\)\) return next\(\);/);
  assert.match(body, /requireMasterApi\(req, res, next\)/);
});
