const test = require('node:test');
const assert = require('node:assert/strict');

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

  const previousPassword = process.env.WHATSPRO_PASSWORD;
  delete process.env.WHATSPRO_PASSWORD;
  const defaultLogin = await fetch(base + '/api/whatspro/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'change-me' })
  });
  assert.equal(defaultLogin.status, 503);
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

test('chat audio hydration uses validated JSON media as a Data URI', async () => {
  const source = await require('node:fs/promises').readFile(require('node:path').join(__dirname, '..', 'public', 'chat.js'), 'utf8');
  assert.match(source, /await response\.json\(\)/);
  assert.match(source, /'data:' \+ mediaType \+ ';base64,' \+ base64/);
  assert.doesNotMatch(source, /response\.arrayBuffer\(\)|URL\.createObjectURL\(blob\)/);
  assert.match(source, /console\.error\('Audio play error:', error\)/);
});

test('chat search normalizes Kazakhstan 8-prefixes and permits phone substrings', async () => {
  const source = await require('node:fs/promises').readFile(require('node:path').join(__dirname, '..', 'public', 'chat.js'), 'utf8');
  assert.match(source, /phoneQuery\.charAt\(0\) === '8' && phoneQuery\.length > 1/);
  assert.match(source, /phoneQuery = '7' \+ phoneQuery\.slice\(1\)/);
  assert.match(source, /phone\.indexOf\(phoneQuery\) >= 0/);
});
