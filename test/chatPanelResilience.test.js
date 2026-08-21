const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const chatJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'chat.js'), 'utf8');
const chatHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'chat.html'), 'utf8');
const serverJs = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');

// Operators reported archive and delete doing nothing at all, with no error.
// Chrome's "prevent this page from creating additional dialogs" checkbox and
// framed embeds both make window.confirm() return false forever, which silently
// aborted the action before any request was sent.
test('archive and delete never depend on a suppressible native dialog', () => {
  const code = chatJs.split('\n').filter(line => !line.trim().startsWith('//')).join('\n');
  assert.ok(!/window\.confirm\(/.test(code), 'chat.js must not gate actions behind a native dialog');
  assert.match(chatJs, /await confirmDialog\(/);
  assert.ok(chatHtml.includes('id="confirm-backdrop"'));
  assert.ok(chatHtml.includes('id="confirm-ok"'));
  assert.ok(chatHtml.includes('id="confirm-cancel"'));
});

// A panel open past the 24h token TTL used to fail every control at once, and
// the reload guard swallowed the click without any feedback.
test('a stale chat token is re-minted and the request replayed once', () => {
  assert.match(chatJs, /function refreshChatToken/);
  assert.match(chatJs, /return requestJson\(url, options, true\)/);
  assert.match(chatJs, /endpoints\.session \|\| '\/api\/chat\/session'/);
  assert.match(serverJs, /app\.get\('\/api\/chat\/session\/:instanceId'/);
  assert.match(serverJs, /session: '\/api\/chat\/session'/);
});

// The PDF card relied on a popup plus a token in the query string, so it broke
// when the tab was blocked or the token had aged out.
test('documents and images open without a popup or a URL token', () => {
  assert.match(chatJs, /createObjectURL/);
  assert.match(chatJs, /function handleMediaOpenClick/);
  assert.ok(chatJs.includes('data-media-id'));
  assert.match(chatJs, /el\.messages\.addEventListener\('click', handleMediaOpenClick\)/);
  assert.ok(chatHtml.includes('id="media-viewer"'));
  assert.ok(chatHtml.includes('id="media-frame"'));
});

test('failed media opens surface a visible error instead of failing silently', () => {
  assert.match(chatJs, /showToast\(t\('mediaFailed'\), true\)/);
  assert.match(chatJs, /mediaFailed: '/);
});

test('the session endpoint mints a token the guarded chat routes accept', async t => {
  const tenantStore = require('../services/tenantStore');
  const originalConfig = tenantStore.getTenantChatConfig;
  tenantStore.getTenantChatConfig = async instance => tenantStore.sanitizeTenantConfig(
    instance === 'prestige' ? { instance_id: instance, brand: 'Prestige' } : null,
    instance
  );
  t.after(() => { tenantStore.getTenantChatConfig = originalConfig; });

  const { app } = require('../src/server');
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  const bad = await fetch(base + '/api/chat/session/!!');
  assert.equal(bad.status, 400);

  const minted = await fetch(base + '/api/chat/session/prestige');
  assert.equal(minted.status, 200);
  const payload = await minted.json();
  assert.equal(typeof payload.chatToken, 'string');
  assert.equal(payload.chatToken.split('.').length, 2);

  const rejected = await fetch(base + '/api/chat/action/prestige/77476884956', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'close' })
  });
  assert.equal(rejected.status, 401);

  const accepted = await fetch(base + '/api/chat/action/prestige/77476884956', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-chat-token': payload.chatToken,
      'x-chat-instance': 'prestige'
    },
    body: JSON.stringify({ action: 'close' })
  });
  assert.notEqual(accepted.status, 401, 'a freshly minted token must pass the chat auth gate');
});


// A truthy-but-blank window from Safari, Android WebView or an in-app browser
// made openMedia return before the viewer ever opened, so the operator saw
// nothing at all when tapping a PDF. The viewer is now the only automatic path.
test('the media viewer never depends on window.open succeeding', () => {
  const code = chatJs.split('\n').filter(line => !line.trim().startsWith('//')).join('\n');
  assert.match(code, /showMediaViewer\(URL\.createObjectURL\(blob\), isDocument\)/);
  assert.doesNotMatch(code, /if \(opened\)/);
  assert.doesNotMatch(code, /opened = window\.open/);
  assert.match(code, /openBtn\.onclick = function \(\) \{ try \{ window\.open\(objectUrl/);
});

test('phones get download and open affordances because framed PDFs stay blank there', () => {
  assert.match(chatJs, /function isMobileViewer/);
  assert.match(chatJs, /var inlinePdf = isDocument && !isMobileViewer\(\)/);
  assert.match(chatJs, /frame\.hidden = !inlinePdf/);
  assert.match(chatJs, /note\.hidden = !isDocument \|\| inlinePdf/);
  for (const id of ['media-open', 'media-note', 'media-image']) {
    assert.ok(chatHtml.includes('id="' + id + '"'), 'missing #' + id);
  }
});

test('images render as images and documents as a frame, never both', () => {
  assert.match(chatJs, /image\.hidden = isDocument/);
  assert.match(chatJs, /else image\.src = objectUrl/);
  assert.match(chatJs, /if \(inlinePdf\) frame\.src = objectUrl/);
});

test('operator errors are localized, not raw fetch text', () => {
  assert.doesNotMatch(chatJs, /showToast\(error\.message, true\)/);
  assert.match(chatJs, /showToast\(t\('actionFailed'\), true\)/);
  for (const key of ['viewerOpen', 'viewerNote', 'actionFailed']) {
    const hits = chatJs.split(key + ':').length - 1;
    assert.equal(hits, 2, key + ' must exist in both kk and ru, found ' + hits);
  }
});
