'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const managerSrc = fs.readFileSync(path.join(__dirname, '..', 'services', 'whatsappManager.js'), 'utf8');
const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
const chatJsSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'chat.js'), 'utf8');

// ---------------------------------------------------------------------------- C2
// stopWhatsAppInstance calls client.logout() and deletes both session folders, so
// afterwards the restaurant needs a physical QR rescan. The panel's "Қайта іске
// қосу" button and the tenant pause switch both routed through it, so an operator
// clearing a hiccup took the restaurant offline until somebody walked to the phone
// (found 2026-08-22). Unlinking must stay reachable only where the name says so.

test('stopWhatsAppInstance can stop without unlinking the device', async () => {
  const manager = require('../services/whatsappManager');
  assert.equal(typeof manager.stopWhatsAppInstance, 'function');
  // The signature must carry the option, otherwise the routes below silently wipe.
  assert.match(managerSrc, /async function stopWhatsAppInstance\(instanceId, options = \{\}\)/);
  assert.match(managerSrc, /const wipeCredentials = options\.wipeCredentials !== false;/,
    'default must stay destructive so /api/wa/logout keeps working');
});

test('a non-wiping stop skips logout and both credential folders', () => {
  const fn = managerSrc.slice(
    managerSrc.indexOf('async function stopWhatsAppInstance(instanceId, options = {})'),
    managerSrc.indexOf('async function shutdownWhatsAppClients')
  );
  assert.match(fn, /if \(wipeCredentials\) await client\.logout\(\);/,
    'logout is what unlinks the device on WhatsApp side');
  assert.match(fn, /if \(!wipeCredentials\) \{/, 'and it must return before the folder removal');
  const guard = fn.slice(fn.indexOf('if (!wipeCredentials) {'), fn.indexOf('removeSessionFolder'));
  assert.match(guard, /return \{ success: true[^}]*credentialsPreserved: true \}/);
});

test('the panel restart button reconnects instead of unlinking', () => {
  const route = serverSrc.slice(
    serverSrc.indexOf("app.post('/api/wa/restart/:instanceId'"),
    serverSrc.indexOf("app.post('/api/wa/logout'")
  );
  assert.match(route, /stopWhatsAppInstance\(instanceId, \{ wipeCredentials: false \}\)/,
    'restart must preserve the pairing');
});

test('pausing a tenant preserves the pairing, as its comment always promised', () => {
  const route = serverSrc.slice(
    serverSrc.indexOf("app.post('/api/wa/tenants/:instanceId/active'"),
    serverSrc.indexOf("app.post('/api/wa/tenants/:instanceId/bot-enabled'")
  );
  assert.match(route, /wipeCredentials: false/);
});

test('logout still unlinks - that route is named for what it does', () => {
  const route = serverSrc.slice(
    serverSrc.indexOf("app.post('/api/wa/logout'"),
    serverSrc.indexOf("app.post('/api/send'")
  );
  assert.match(route, /await stopWhatsAppInstance\(instanceId\)/);
  assert.doesNotMatch(route, /wipeCredentials/, 'no option means the destructive default');
});

// ---------------------------------------------------------------------------- C7
// "While an operator is typing the bot stays silent" had no write path at all: the
// lock was set only AFTER a send completed. A customer message arriving while the
// operator composed was forwarded to Openbot and answered automatically, so the
// customer received a bot answer and a human answer to the same question.

test('the operator lock has a write path', () => {
  // resolveChatInstance sits in front of the auth middleware on every chat route, so the
  // hub's alemi_instance in the URL is rewritten to our instance_id before the token is
  // checked (C25, 2026-08-23). The write path itself is unchanged.
  assert.match(serverSrc, /app\.post\('\/api\/chat\/operator-lock\/:instanceId\/:phone', resolveChatInstance, requireChatUiOrApi/,
    'a POST route must exist, not only the read-only GET');
  const route = serverSrc.slice(
    serverSrc.indexOf("app.post('/api/chat/operator-lock/:instanceId/:phone'"),
    serverSrc.indexOf("app.get('/api/chat/operator-lock/:instanceId/:phone'")
  );
  assert.match(route, /markOperatorActive\(instanceId, phone, 'operator_typing'\)/);
  assert.match(route, /publishChatEvent\(\{ type: 'lock\.changed'/, 'other panels must see it too');
  assert.match(route, /allowsPhone\(await getTestModePolicy\(instanceId\), phone\)/, 'test mode still applies');
});

test('the lock write path is imported, not referenced out of thin air', () => {
  assert.match(serverSrc, /const \{ OPERATOR_ACTIVE_SECONDS, markOperatorActive, operatorActiveKey \} = require\('\.\.\/services\/operatorLock'\)/);
});

test('the composer claims the lock while the operator types', () => {
  assert.match(chatJsSrc, /async function claimTypingLock\(\)/);
  assert.match(chatJsSrc, /if \(el\.messageInput\.value\.trim\(\)\) claimTypingLock\(\)/,
    'typing must claim it, not only sending');
  assert.match(chatJsSrc, /LOCK_CLAIM_INTERVAL_MS = 15000/, 'debounced so it is not one request per keystroke');
  assert.match(chatJsSrc, /lockClaimAt = 0;\s*\n\s*\}/, 'a failed claim must let the next keystroke retry');
});

test('the lock can never stick, because it is a SET with EX', () => {
  const lock = fs.readFileSync(path.join(__dirname, '..', 'services', 'operatorLock.js'), 'utf8');
  assert.match(lock, /'SET', operatorActiveKey\(instanceId, phone\), source, 'EX'/,
    'a stuck lock would silence the bot permanently for that guest');
});

// --------------------------------------------------------------------------- C10
// requireUiOrApi accepts a tenant's own token whenever the request names that
// tenant. Four routes are platform-shaped, and a leaked restaurant key could use
// them irreversibly: delete the record, clone a new instance id into the registry,
// rotate the credential Openbot holds, approve a scan request.

test('platform-shaped routes require the platform, not a tenant token', () => {
  assert.match(serverSrc, /async function requirePlatformAdmin\(req, res, next\) \{/);
  const fn = serverSrc.slice(serverSrc.indexOf('async function requirePlatformAdmin'), serverSrc.indexOf('async function requireApi'));
  assert.match(fn, /if \(readSession\(req\)\) return next\(\);/, 'the admin UI session still works');
  assert.match(fn, /return requireMasterApi\(req, res, next\);/, 'otherwise only the master token');

  for (const route of [
    "app.delete('/api/wa/tenants/:instanceId'",
    "app.post('/api/wa/tenants/:instanceId/clone'",
    "app.post('/api/wa/tenants/:instanceId/rotate'",
    "app.post('/api/wa/scan-requests/:requestId/approve'"
  ]) {
    const index = serverSrc.indexOf(route);
    assert.ok(index > 0, `${route} must exist`);
    const declaration = serverSrc.slice(index, index + 220);
    assert.match(declaration, /requirePlatformAdmin/, `${route} must not accept a tenant token`);
  }
});

test('a tenant keeps control of its own settings', () => {
  // Narrowing must not lock a restaurant out of the things it legitimately owns.
  for (const route of [
    "app.patch('/api/wa/tenants/:instanceId'",
    "app.post('/api/wa/tenants/:instanceId/bot-enabled'",
    "app.post('/api/wa/tenants/:instanceId/active'",
    "app.get('/api/wa/tenants/:instanceId/settings'"
  ]) {
    const index = serverSrc.indexOf(route);
    assert.ok(index > 0, `${route} must exist`);
    assert.match(serverSrc.slice(index, index + 200), /requireUiOrApi/, `${route} must stay tenant-usable`);
  }
});
