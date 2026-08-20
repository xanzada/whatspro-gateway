const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

const { app } = require('../src/server');
const { publishChatEvent } = require('../services/chatEvents');

function configFromHtml(html) {
  const match = html.match(/window\.__CHAT_CONFIG__=({[\s\S]*?});<\/script>/);
  assert.ok(match, 'chat config must be embedded');
  return JSON.parse(match[1]);
}

async function nextDataEvent(response, timeoutMs = 1000) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const read = (async () => {
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error('SSE_CLOSED');
        buffer += decoder.decode(chunk.value, { stream: true });
        const blocks = buffer.split(/\r?\n\r?\n/);
        buffer = blocks.pop();
        for (const block of blocks) {
          const data = block.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
          if (data) return JSON.parse(data);
        }
      }
    } finally {
      reader.releaseLock();
    }
  })();
  return Promise.race([
    read,
    new Promise((_, reject) => setTimeout(() => reject(new Error('SSE_TIMEOUT')), timeoutMs))
  ]);
}

test('three same-instance SSE viewers receive one event within one second', async t => {
  const tenantStore = require('../services/tenantStore');
  const originalConfig = tenantStore.getTenantChatConfig;
  tenantStore.getTenantChatConfig = async instance => tenantStore.sanitizeTenantConfig(
    instance === 'tenant-live' ? { instance_id: instance, brand: 'Tenant Live' } : null,
    instance
  );
  t.after(() => { tenantStore.getTenantChatConfig = originalConfig; });
  const server = app.listen(0, '127.0.0.1');
  const controllers = [new AbortController(), new AbortController(), new AbortController()];
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  t.after(() => {
    controllers.forEach(controller => controller.abort());
    server.closeAllConnections();
    return new Promise(resolve => server.close(resolve));
  });

  const base = `http://127.0.0.1:${server.address().port}`;
  const shellResponses = await Promise.all([0, 1, 2].map(() => fetch(`${base}/chat.html?instance=tenant-live`)));
  const configs = await Promise.all(shellResponses.map(async response => configFromHtml(await response.text())));
  const config = configs[0];
  shellResponses.forEach(response => assert.equal(response.headers.get('cache-control'), 'no-store, max-age=0'));
  configs.forEach(deviceConfig => {
    assert.equal(deviceConfig.instance, 'tenant-live');
    assert.match(deviceConfig.chatToken, /\S+/);
  });
  const inboxResponses = await Promise.all(configs.map(deviceConfig => fetch(`${base}/api/chat/inbox/tenant-live`, {
    headers: { 'x-chat-token': deviceConfig.chatToken, 'x-chat-instance': 'tenant-live' }
  })));
  inboxResponses.forEach(response => assert.notEqual(response.status, 401));

  const unauthorized = await fetch(`${base}/api/chat/inbox/tenant-live`);
  assert.equal(unauthorized.status, 401);
  const wrongTenant = await fetch(`${base}/api/chat/inbox/tenant-other`, {
    headers: { 'x-chat-token': config.chatToken, 'x-chat-instance': 'tenant-live' }
  });
  assert.equal(wrongTenant.status, 401);
  const adminWithChatToken = await fetch(`${base}/api/wa/instances`, {
    headers: { 'x-chat-token': config.chatToken, 'x-chat-instance': 'tenant-live' }
  });
  assert.equal(adminWithChatToken.status, 401);

  const responses = await Promise.all(controllers.map((controller, index) => fetch(`${base}/api/chat/events/tenant-live`, {
    headers: {
      Accept: 'text/event-stream',
      'x-chat-token': configs[index].chatToken,
      'x-chat-instance': 'tenant-live'
    },
    signal: controller.signal
  })));

  for (const response of responses) {
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') || '', /^text\/event-stream/);
    assert.equal(response.headers.get('cache-control'), 'no-cache, no-transform');
    assert.equal(response.headers.get('connection'), 'keep-alive');
    assert.equal(response.headers.get('x-accel-buffering'), 'no');
  }

  await new Promise(resolve => setTimeout(resolve, 50));
  const pending = responses.map(response => nextDataEvent(response));
  await publishChatEvent({ type: 'chat.message', instanceId: 'tenant-live', phone: '77001234567', messageId: 'live-1' });
  const received = await Promise.all(pending);
  assert.equal(received.length, 3);
  received.forEach(event => {
    assert.equal(event.instanceId, 'tenant-live');
    assert.equal(event.messageId, 'live-1');
  });

  controllers[0].abort();
  await new Promise(resolve => setTimeout(resolve, 50));
  const remaining = responses.slice(1).map(response => nextDataEvent(response));
  await publishChatEvent({ type: 'message.ack', instanceId: 'tenant-live', phone: '77001234567', messageId: 'live-1', deliveryStatus: 'read' });
  const afterDisconnect = await Promise.all(remaining);
  assert.equal(afterDisconnect.length, 2);
  afterDisconnect.forEach(event => assert.equal(event.deliveryStatus, 'read'));
});

test('SSE has no per-viewer replacement/cap and background polling failures are logged', async () => {
  const serverSource = await fs.readFile(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  const route = serverSource.slice(serverSource.indexOf("app.get('/api/chat/events/:instanceId'"), serverSource.indexOf("app.get('/api/chat/inbox-legacy/:instanceId'"));
  assert.doesNotMatch(route, /SSE_MAX_CONNECTIONS|sseConnections|TOO_MANY_EVENT_STREAMS/);
  assert.match(route, /subscribeChatEvents\(instanceId/);
  assert.match(route, /res\.flush\?\.\(\)/);
  assert.match(route, /res\.once\('close', cleanup\)/);

  const clientSource = await fs.readFile(path.join(__dirname, '..', 'public', 'chat.js'), 'utf8');
  assert.match(clientSource, /requestError\.status = response\.status/);
  // A stale 24h chat token triggers exactly one reload to mint a fresh token
  // instead of a dead console error (operator report, 2026-08-20).
  assert.match(clientSource, /handleAuthFailure\(\)/);
  assert.match(clientSource, /sessionStorage\.setItem\('chatAuthReloadAt'/);
  assert.match(clientSource, /console\.error\('Inbox load failed for instance', instanceId/);
  assert.match(clientSource, /console\.error\('History load failed for instance', instanceId/);
});
