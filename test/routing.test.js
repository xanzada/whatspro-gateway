const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { app, __test: serverHelpers } = require('../src/server');

test('chat routes and static assets serve the new operator UI', async t => {
  const tenantStore = require('../services/tenantStore');
  const originalConfig = tenantStore.getTenantChatConfig;
  tenantStore.getTenantChatConfig = async instance => tenantStore.sanitizeTenantConfig(
    instance === 'prestige' ? { instance_id: instance, brand: 'Prestige' } : null,
    instance
  );
  t.after(() => { tenantStore.getTenantChatConfig = originalConfig; });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));

  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  const favicon = await fetch(base + '/favicon.ico');
  assert.equal(favicon.status, 204);

  for (const route of ['/connect', '/connect.html']) {
    const response = await fetch(base + route);
    assert.equal(response.status, 200, route);
    assert.match(await response.text(), /id="qr-frame"/);
  }

  for (const route of ['/chat.html?instance=prestige', '/chat?instance=prestige']) {
    const response = await fetch(base + route, { redirect: 'manual' });
    const html = await response.text();
    assert.equal(response.status, 200, route);
    assert.match(response.headers.get('content-type') || '', /text\/html/);
    // Bundles are cache-busted with the build version so a long-open panel can
    // never strand already-shipped fixes (live complaint 2026-08-21).
    assert.match(html, /<script src="\/chat-core\.js\?v=\d+"><\/script>/);
    assert.match(html, /<script src="\/chat\.js\?v=\d+"><\/script>/);
    assert.doesNotMatch(html, /Загрузка Chatwoot/i);
  }

  for (const asset of ['/chat.js', '/chat-core.js']) {
    const response = await fetch(base + asset);
    const source = await response.text();
    assert.equal(response.status, 200, asset);
    assert.match(response.headers.get('content-type') || '', /javascript/);
    if (asset === '/chat.js') assert.doesNotMatch(source, /location\.assign\([^)]*returnTo/);
  }

  const legacy = await fetch(base + '/?instance=prestige', { redirect: 'manual' });
  assert.equal(legacy.status, 302);
  assert.equal(legacy.headers.get('location'), '/chat.html?instance=prestige');

  const protectedApi = await fetch(base + '/api/chat/inbox/prestige');
  assert.equal(protectedApi.status, 401);

  for (const route of ['/chat.html', '/chat', '/inbox']) {
    const response = await fetch(base + route);
    const body = await response.text();
    assert.equal(response.status, 400, `${route} must fail closed without an exact instance`);
    assert.doesNotMatch(body, /prestige/i, `${route} must not expose a default tenant`);
  }

  const invalidTenant = await fetch(base + '/chat.html?instance=%28bad%2Ceq%2Cfilter%29');
  assert.equal(invalidTenant.status, 400);
  const unknownTenant = await fetch(base + '/chat.html?instance=missing-tenant');
  assert.equal(unknownTenant.status, 404);

  const previousUser = process.env.WHATSPRO_USER;
  const previousPassword = process.env.WHATSPRO_PASSWORD;
  delete process.env.WHATSPRO_PASSWORD;
  const defaultLogin = await fetch(base + '/api/whatspro/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'change-me' })
  });
  assert.equal(defaultLogin.status, 503);

  process.env.WHATSPRO_USER = 'qa-admin';
  process.env.WHATSPRO_PASSWORD = 'SafePass10';
  const sessionLogin = await fetch(base + '/api/whatspro/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'qa-admin', password: 'SafePass10', remember: false })
  });
  assert.equal(sessionLogin.status, 200);
  assert.doesNotMatch(sessionLogin.headers.get('set-cookie') || '', /Max-Age=/i, 'unchecked remember uses a browser-session cookie');

  const rememberedLogin = await fetch(base + '/api/whatspro/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'qa-admin', password: 'SafePass10', remember: true })
  });
  assert.equal(rememberedLogin.status, 200);
  assert.match(rememberedLogin.headers.get('set-cookie') || '', /Max-Age=2592000/i, 'checked remember keeps the admin session for 30 days');

  if (previousUser == null) delete process.env.WHATSPRO_USER;
  else process.env.WHATSPRO_USER = previousUser;
  if (previousPassword == null) delete process.env.WHATSPRO_PASSWORD;
  else process.env.WHATSPRO_PASSWORD = previousPassword;

  const previousToken = process.env.WHATSPRO_API_TOKEN;
  process.env.WHATSPRO_API_TOKEN = 'routing-test-token';
  t.after(() => {
    if (previousToken == null) delete process.env.WHATSPRO_API_TOKEN;
    else process.env.WHATSPRO_API_TOKEN = previousToken;
  });
  const apiHeaders = { authorization: 'Bearer routing-test-token', 'content-type': 'application/json' };
  const badText = await fetch(base + '/api/send', {
    method: 'POST', headers: apiHeaders,
    body: JSON.stringify({ instanceId: 'prestige', phone: '77001234567', text: { unsafe: true } })
  });
  assert.equal(badText.status, 400);
  const badMedia = await fetch(base + '/api/send', {
    method: 'POST', headers: apiHeaders,
    body: JSON.stringify({ instanceId: 'prestige', phone: '77001234567', media: { base64: 'not base64!' } })
  });
  assert.equal(badMedia.status, 400);
});

test('client QR links are signed, scoped and expiring', () => {
  const valid = serverHelpers.issueConnectToken('prestige', Date.now() + 60_000);
  assert.deepEqual(serverHelpers.readConnectToken(valid).instanceId, 'prestige');
  assert.equal(serverHelpers.readConnectToken(valid + 'x'), null, 'a modified signature is rejected');
  assert.equal(serverHelpers.readConnectToken(serverHelpers.issueConnectToken('prestige', Date.now() - 1)), null, 'an expired link is rejected');
});

test('tenant shell contains an accessible responsive login gate', async () => {
  const markup = await require('node:fs/promises').readFile(require('node:path').join(__dirname, '..', 'public', 'tenants.html'), 'utf8');
  const source = await require('node:fs/promises').readFile(require('node:path').join(__dirname, '..', 'public', 'tenants.js'), 'utf8');
  assert.match(markup, /<form class="login-form" id="login-form" novalidate>/);
  assert.match(markup, /label for="login-username"/);
  assert.match(markup, /label for="login-password"/);
  assert.match(markup, /autocomplete="username"/);
  assert.match(markup, /autocomplete="current-password"/);
  assert.match(markup, /id="login-error" role="alert" aria-live="assertive"/);
  assert.match(source, /remember: remember/);
  assert.doesNotMatch(source, /localStorage\.setItem\([^,]*password/i, 'the remember option must never persist a plaintext password');
});

test('tenant onboarding configures Alemi per restaurant and lets the authenticated admin view its key', async () => {
  const fs = require('node:fs/promises');
  const path = require('node:path');
  const markup = await fs.readFile(path.join(__dirname, '..', 'public', 'tenants.html'), 'utf8');
  const ui = await fs.readFile(path.join(__dirname, '..', 'public', 'tenants.js'), 'utf8');
  const server = await fs.readFile(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');

  assert.match(markup, /<script src="\/tenants\.js"><\/script>/, 'the tested dynamic wizard is the script used by tenants.html');
  assert.match(ui, /name="alemiApiUrl" type="url"/);
  assert.match(ui, /name="alemiInstance"/);
  assert.match(ui, /name="alemiSecret" type="text"/);
  assert.match(ui, /autocomplete="off"/);
  assert.match(ui, /data-action="alemi-secret"/);
  assert.match(ui, /https:\/\/hub\.alemi\.kz/);
  assert.match(ui, /ale(mi)?SecretSet/);
  assert.doesNotMatch(ui, /localStorage\.setItem\([^,]*(?:alemi|secret)/i);
  assert.match(server, /app\.get\('\/api\/wa\/tenants\/:instanceId\/alemi-secret', requireUiSession/,
    'only an authenticated admin session may reveal one restaurant key');
  const editFlow = ui.slice(ui.indexOf('function openEdit('), ui.indexOf('function openDuplicate('));
  assert.match(editFlow, /loadAlemiSecret\(instanceId\)/);
  assert.match(editFlow, /alemiSecret:\s*secret/);

  const listRoute = server.slice(server.indexOf("app.get('/api/wa/runtime-configs'"), server.indexOf("app.get('/api/wa/runtime-configs/:instanceId'"));
  assert.match(listRoute, /runtimeListTenant/);
  const secretRoute = server.slice(server.indexOf("app.post('/api/wa/tenants/:instanceId/alemi-secret'"), server.indexOf('// Pausing is not a flag'));
  assert.match(secretRoute, /requireUiOrApi/);
  assert.match(secretRoute, /tenantAdmin\.setAlemiSecret/);
  assert.doesNotMatch(secretRoute, /res\.json\(\{[^}]*\bsecret\s*:/is, 'the response must not echo the submitted key');
});

test('Alemi key reveal is exact-instance, session-only and never cacheable', async t => {
  const tenantAdmin = require('../services/tenantAdmin');
  const originalReveal = tenantAdmin.revealAlemiSecret;
  tenantAdmin.revealAlemiSecret = async instanceId => ({ instanceId, secret: 'visible-admin-key' });
  t.after(() => { tenantAdmin.revealAlemiSecret = originalReveal; });

  const listener = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { listener.once('listening', resolve); listener.once('error', reject); });
  t.after(() => new Promise(resolve => listener.close(resolve)));
  const url = `http://127.0.0.1:${listener.address().port}/api/wa/tenants/prestige/alemi-secret`;

  const unauthenticated = await fetch(url, { headers: { 'x-api-key': 'even-a-master-api-token-is-not-a-ui-session' } });
  assert.equal(unauthenticated.status, 401);

  const response = await fetch(url, {
    headers: { cookie: `whatspro_session=${serverHelpers.signSession('admin')}` }
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), {
    success: true,
    instanceId: 'prestige',
    secret: 'visible-admin-key'
  });
});

test('Alemi key API accepts a write-only value and returns presence only', async t => {
  const tenantAdmin = require('../services/tenantAdmin');
  const originalSet = tenantAdmin.setAlemiSecret;
  const previousToken = process.env.WHATSPRO_API_TOKEN;
  let received = '';
  tenantAdmin.setAlemiSecret = async (instanceId, secret) => {
    received = secret;
    return { instanceId, alemiSecretSet: true };
  };
  process.env.WHATSPRO_API_TOKEN = 'alemi-route-master-token';
  t.after(() => {
    tenantAdmin.setAlemiSecret = originalSet;
    if (previousToken === undefined) delete process.env.WHATSPRO_API_TOKEN;
    else process.env.WHATSPRO_API_TOKEN = previousToken;
  });

  const listener = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { listener.once('listening', resolve); listener.once('error', reject); });
  t.after(() => new Promise(resolve => listener.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${listener.address().port}/api/wa/tenants/prestige/alemi-secret`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'alemi-route-master-token' },
    body: JSON.stringify({ secret: 'write-only-alemi-secret' })
  });
  const raw = await response.text();
  assert.equal(response.status, 200);
  assert.equal(received, 'write-only-alemi-secret');
  assert.equal(raw.includes('write-only-alemi-secret'), false);
  assert.deepEqual(JSON.parse(raw), { success: true, instanceId: 'prestige', alemiSecretSet: true });
});

test('chat audio hydration delegates playback and ranges to the native media URL', async () => {
  const source = await require('node:fs/promises').readFile(require('node:path').join(__dirname, '..', 'public', 'chat.js'), 'utf8');
  const markup = await require('node:fs/promises').readFile(require('node:path').join(__dirname, '..', 'public', 'chat.html'), 'utf8');
  const hydration = source.slice(source.indexOf('async function loadAudio'), source.indexOf('async function loadInbox'));
  assert.match(hydration, /bindAudio\(wrapper, audio, mediaUrl,/);
  assert.doesNotMatch(hydration, /response\.blob\(\)|response\.arrayBuffer\(\)|response\.json\(\)|URL\.createObjectURL/);
  assert.doesNotMatch(hydration, /canPlayType\(/);
  assert.match(hydration, /query\.set\('fmt', 'mp4'\)/);
  assert.match(hydration, /localStorage\.getItem\('token_key'\)/);
  assert.match(hydration, /query\.set\('token', mediaToken\)/);
  assert.match(hydration, /query\.set\('phone', state\.activePhone\)/);
  const audioTemplate = source.slice(source.indexOf("content = '<div class=\"audio-player\""), source.indexOf("'<button class=\"audio-speed\""));
  assert.doesNotMatch(audioTemplate, /\sdisabled(?:\s|>)/);
  assert.match(audioTemplate, /preload="none"/);
  assert.match(source, /el\.messages\.addEventListener\('click', handleAudioPlayClick\)/);
  assert.match(source, /var eventsBound = false;/);
  assert.match(source, /function bindEvents\(\) \{\s*if \(eventsBound\) return;\s*eventsBound = true;/);
  assert.doesNotMatch(source, /(?:play|button)\.addEventListener\('click',\s*handleAudioPlayClick\)/);
  assert.match(source, /target\.closest\('\.audio-play'\)/);
  assert.match(source, /console\.log\('PLAY BUTTON CLICKED', event\.target\)/);
  assert.match(source, /console\.log\('CALLING AUDIO PLAY', audio\)/);
  assert.match(source, /console\.error\('Play Promise failed:', error\)/);
  assert.match(source, /console\.error\('Audio failed to load'/);
  assert.match(source, /code: audio\.error && audio\.error\.code/);
  assert.match(markup, /\.audio-play\s*\{[^}]*pointer-events\s*:\s*auto[^}]*z-index\s*:\s*2/s);
  assert.match(markup, /\.audio-play\s*>\s*\*\s*\{\s*pointer-events\s*:\s*none\s*;?\s*\}/);
});

test('chat media route delegates to the compliant file handler', async () => {
  const source = await require('node:fs/promises').readFile(require('node:path').join(__dirname, '..', 'src', 'server.js'), 'utf8');
  const route = source.slice(source.indexOf("app.get('/api/chat/media/:instanceId/:messageId'"), source.indexOf("app.post('/api/chat/send/:instanceId/:phone'"));
  assert.match(route, /requireChatMediaAuth/);
  assert.match(route, /serveChatMedia\(req, res\)/);
});

test('tenant QR and automatic reconnect use the same WhatsPro instance manager', async () => {
  const source = await require('node:fs/promises').readFile(require('node:path').join(__dirname, '..', 'src', 'server.js'), 'utf8');
  const startRoute = source.slice(source.indexOf("app.post('/api/wa/start'"), source.indexOf("app.get('/api/wa/status/:instanceId'"));
  assert.match(startRoute, /await saveInstance\(instanceId, label\)/, 'QR starts from the persisted shared instance');
  assert.match(startRoute, /await startWhatsAppInstance\(instanceId\)/);
  assert.match(startRoute, /await getInstanceStatus\(instanceId\)/, 'the QR returned to the tenant panel is the manager QR');

  const liveStatusHelper = source.slice(source.indexOf('async function readLiveStatus'), source.indexOf("app.post('/api/wa/statuses'"));
  assert.match(liveStatusHelper, /status\?\.hasStoredSession/);
  assert.match(liveStatusHelper, /await startWhatsAppInstance\(instanceId\)/, 'a stored session automatically reconnects when status is read');
  const bulkStatusRoute = source.slice(source.indexOf("app.post('/api/wa/statuses'"), source.indexOf("app.get('/api/wa/status/:instanceId'"));
  assert.match(bulkStatusRoute, /Promise\.all/);
  assert.match(bulkStatusRoute, /readLiveStatus\(instanceId\)/, 'the dashboard batches status reads without changing reconnect behavior');

  const boot = source.slice(source.indexOf('async function boot()'), source.indexOf('if (require.main === module)'));
  assert.match(boot, /const instances = await listInstances\(\)/);
  assert.match(boot, /await startWhatsAppInstance\(inst\.instanceId\)/, 'all persisted instances restore after a deployment');

  const connectRoute = source.slice(source.indexOf("app.get('/api/wa/connect/:token/status'"), source.indexOf("app.delete('/api/wa/tenants/:instanceId'"));
  assert.match(connectRoute, /readConnectToken\(token\)/);
  assert.match(connectRoute, /startWhatsAppInstance\(scoped\.instanceId\)/, 'a shared QR starts the exact same persisted manager instance');
  assert.doesNotMatch(connectRoute, /whatspro_api_token|webhook_secret|SESSION_SECRET/, 'the public response never exposes tenant or platform secrets');

  const botRoute = source.slice(source.indexOf("app.post('/api/wa/tenants/:instanceId/bot-enabled'"), source.indexOf("app.post('/api/wa/tenants/:instanceId/connect-link'"));
  assert.match(botRoute, /tenantAdmin\.setBotEnabled/);
  assert.doesNotMatch(botRoute, /stopWhatsAppInstance/, 'pausing the bot must leave WhatsApp connected');
});

test('chat search normalizes Kazakhstan 8-prefixes and permits phone substrings', async () => {
  const source = await require('node:fs/promises').readFile(require('node:path').join(__dirname, '..', 'public', 'chat.js'), 'utf8');
  assert.match(source, /phoneQuery\.charAt\(0\) === '8' && phoneQuery\.length > 1/);
  assert.match(source, /phoneQuery = '7' \+ phoneQuery\.slice\(1\)/);
  assert.match(source, /phone\.indexOf\(phoneQuery\) >= 0/);
});

test('chat header uses tenant brand config and archived chats keep the composer enabled', async t => {
  const tenantStore = require('../services/tenantStore');
  const originalConfig = tenantStore.getTenantChatConfig;
  tenantStore.getTenantChatConfig = async instance => tenantStore.sanitizeTenantConfig({ instance_id: instance, brand: 'Astana Grill' }, instance);
  t.after(() => { tenantStore.getTenantChatConfig = originalConfig; });

  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/chat.html?instance=brandtenant`);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /"branding":\{"name":"Astana Grill"/);

  const source = await require('node:fs/promises').readFile(require('node:path').join(__dirname, '..', 'public', 'chat.js'), 'utf8');
  assert.match(source, /var branding = config\.branding/);
  assert.match(source, /branding\.name/);
  const composer = source.slice(source.indexOf('function updateComposer()'), source.indexOf('function renderReceipt'));
  assert.doesNotMatch(composer, /disabled\s*=.*archived/);
});


test('deploy config requires the shared Redis and does not start a stale tenant store', async () => {
  const fs = require('node:fs/promises');
  const path = require('node:path');
  const compose = await fs.readFile(path.join(__dirname, '..', 'docker-compose.yml'), 'utf8');
  assert.match(compose, /REDIS_URL=\$\{REDIS_URL:\?[^}]+\}/);
  assert.doesNotMatch(compose, /redis_local|whatspro_redis_data/);
  const whatsproService = compose.slice(compose.indexOf('\n  whatspro:'), compose.indexOf('\n  backup:'));
  assert.match(whatsproService, /networks:\s*\r?\n\s*- default\s*\r?\n\s*- dokploy-network/);
  assert.match(whatsproService, /\/health\/detailed/);

  const dockerfile = await fs.readFile(path.join(__dirname, '..', 'Dockerfile'), 'utf8');
  assert.match(dockerfile, /RUN npm ci --omit=dev/);

  const example = await fs.readFile(path.join(__dirname, '..', '.env.example'), 'utf8');
  assert.match(example, /^WHATSPRO_PUBLIC_URL=https:\/\/whatspro\.alemi\.kz$/m);
  assert.match(example, /^WHATSPRO_TENANT_DOMAIN_SUFFIX=alemi\.kz$/m);
  assert.match(example, /^OPENBOT_WEBHOOK_URL=https:\/\/openbot\.alemi\.kz\/whatspro-webhook$/m);
});

test('runtime config hands the bot every functional field but no credential it never reads', async t => {
  const tenantStore = require('../services/tenantStore');
  const originalFindRow = tenantStore.findRow;
  const previousToken = process.env.WHATSPRO_API_TOKEN;
  const previousPublicUrl = process.env.WHATSPRO_PUBLIC_URL;
  process.env.WHATSPRO_API_TOKEN = 'runtime-config-master-token';
  process.env.WHATSPRO_PUBLIC_URL = 'https://whatspro.example.test';
  tenantStore.findRow = async instanceId => ({
    instance_id: instanceId,
    brand: 'Prestige',
    domain: 'prestige.alemi.kz',
    address: 'Абай 1',
    work_hours: '09:00 - 03:00',
    system_prompt: 'сен Prestige ботысың',
    prompt_mode: 'custom',
    active: true,
    bot_enabled: true,
    calls_disabled: true,
    alemi_api_url: 'https://hub.alemi.kz',
    alemi_instance: 'prestige-hub',
    alemi_secret: 'alemi-hmac-key',
    whatspro_api_token: 'wp-tenant-token',
    webhook_secret: 'hook-site-secret',
    crm_secret_token: 'crm-kanban-token',
    kanban_secret: 'kanban-retired-secret',
    crm_webhook_secret: 'crm-hook-secret'
  });
  t.after(() => {
    tenantStore.findRow = originalFindRow;
    if (previousToken === undefined) delete process.env.WHATSPRO_API_TOKEN;
    else process.env.WHATSPRO_API_TOKEN = previousToken;
    if (previousPublicUrl === undefined) delete process.env.WHATSPRO_PUBLIC_URL;
    else process.env.WHATSPRO_PUBLIC_URL = previousPublicUrl;
  });

  const listener = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { listener.once('listening', resolve); listener.once('error', reject); });
  t.after(() => new Promise(resolve => listener.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${listener.address().port}/api/wa/runtime-configs/prestige`, {
    headers: { 'x-api-key': 'runtime-config-master-token' }
  });
  const raw = await response.text();
  assert.equal(response.status, 200);
  const config = JSON.parse(raw).config;

  // The bot signs its Alemi calls with this and sends with the tenant token, so
  // both must survive the redaction.
  assert.equal(config.alemi_secret, 'alemi-hmac-key');
  assert.equal(config.whatspro_api_token, 'wp-tenant-token');
  assert.equal(config.webhook_secret, 'hook-site-secret');
  assert.equal(config.crm_secret_token, 'crm-kanban-token');
  for (const [field, value] of [
    ['instance_id', 'prestige'],
    ['brand', 'Prestige'],
    ['domain', 'prestige.alemi.kz'],
    ['address', 'Абай 1'],
    ['work_hours', '09:00 - 03:00'],
    ['system_prompt', 'сен Prestige ботысың'],
    ['prompt_mode', 'custom'],
    ['alemi_api_url', 'https://hub.alemi.kz'],
    ['alemi_instance', 'prestige-hub'],
    ['bot_enabled', true],
    ['calls_disabled', true],
    ['active', true],
    ['whatspro_send_url', 'https://whatspro.example.test/api/send'],
    ['whatspro_presence_url', 'https://whatspro.example.test/api/presence']
  ]) {
    assert.equal(config[field], value, `${field} is functional and must stay in the runtime payload`);
  }

  for (const dropped of ['kanban_secret', 'kanbanSecret', 'crm_webhook_secret', 'crmWebhookSecret']) {
    assert.equal(dropped in config, false, `${dropped} is never read by the bot and must not be disclosed`);
  }
  assert.equal(raw.includes('kanban-retired-secret'), false);
  assert.equal(raw.includes('crm-hook-secret'), false);
});

// A restaurant that has lost its WhatsApp pairing needs a person to pick up a
// phone, and nothing about that is visible from `/health`. It has to show as
// degraded and name the instance — but `ok` must stay true, because the
// container healthcheck asserts it and restarting the gateway is never the fix
// for a QR scan nobody has done yet.
test('detailed health names the instances that need a QR scan without failing the healthcheck', async t => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));

  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/health/detailed`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.ok, true, 'the container healthcheck asserts ok === true');
  assert.ok(Array.isArray(body.checks.whatsapp.needsScan), 'the operator needs the instance ids, not just a count');
  assert.equal(typeof body.checks.whatsapp.connected, 'number');
  assert.ok(['healthy', 'degraded'].includes(body.mode));

  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'src', 'server.js'), 'utf8');
  assert.match(source, /needsScan\.length === 0 \? 'healthy' : 'degraded'/,
    'a tenant waiting on a scan must not be able to read as healthy');
});
