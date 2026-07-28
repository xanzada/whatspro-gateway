const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { app } = require('../src/server');

test('chat routes and static assets serve the new operator UI', async t => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));

  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  for (const route of ['/chat.html?instance=prestige', '/chat?instance=prestige']) {
    const response = await fetch(base + route, { redirect: 'manual' });
    const html = await response.text();
    assert.equal(response.status, 200, route);
    assert.match(response.headers.get('content-type') || '', /text\/html/);
    assert.match(html, /<script src="\/chat-core\.js"><\/script>/);
    assert.match(html, /<script src="\/chat\.js"><\/script>/);
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

  const invalidTenant = await fetch(base + '/chat.html?instance=%28bad%2Ceq%2Cfilter%29');
  assert.equal(invalidTenant.status, 400);

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

  const statusRoute = source.slice(source.indexOf("app.get('/api/wa/status/:instanceId'"), source.indexOf("app.post('/api/wa/instances'"));
  assert.match(statusRoute, /status\?\.hasStoredSession/);
  assert.match(statusRoute, /await startWhatsAppInstance\(instanceId\)/, 'a stored session automatically reconnects when status is read');

  const boot = source.slice(source.indexOf('async function boot()'), source.indexOf('if (require.main === module)'));
  assert.match(boot, /const instances = await listInstances\(\)/);
  assert.match(boot, /await startWhatsAppInstance\(inst\.instanceId\)/, 'all persisted instances restore after a deployment');
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


test('Redis compose keeps shared override support and durable local AOF', async () => {
  const compose = await require('node:fs/promises').readFile(require('node:path').join(__dirname, '..', 'docker-compose.yml'), 'utf8');
  assert.match(compose, /REDIS_URL=\$\{REDIS_URL:-redis:\/\/redis_local:6379\}/);
  assert.match(compose, /--appendonly["']?,?\s*["']yes/);
  assert.match(compose, /--appendfsync["']?,?\s*["']everysec/);
});
