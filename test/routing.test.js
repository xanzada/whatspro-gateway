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
    assert.equal(response.status, 200, asset);
    assert.match(response.headers.get('content-type') || '', /javascript/);
  }

  const legacy = await fetch(base + '/?instance=prestige', { redirect: 'manual' });
  assert.equal(legacy.status, 302);
  assert.equal(legacy.headers.get('location'), '/chat.html?instance=prestige');

  const protectedApi = await fetch(base + '/api/chat/inbox/prestige');
  assert.equal(protectedApi.status, 401);
});
