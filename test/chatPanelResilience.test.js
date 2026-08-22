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

  // The mint is no longer public. It used to hand a 24h instance-scoped token to
  // any caller, which let the open internet read every restaurant's chats and
  // receipt PDFs, send WhatsApp as the restaurant and delete conversations
  // (reproduced against the live endpoint 2026-08-22). The panel obtains its
  // proof from the shell render, which is where the renewal grant is issued, so
  // the operator still never sees a login. Full coverage of the auth matrix lives
  // in test/chatSessionAuth.test.js.
  const anonymous = await fetch(base + '/api/chat/session/prestige');
  assert.equal(anonymous.status, 401, 'the mint must refuse an anonymous caller');

  const shell = await fetch(base + '/chat.html?instance=prestige');
  assert.equal(shell.status, 200);
  const setCookie = (shell.headers.getSetCookie
    ? shell.headers.getSetCookie()
    : [shell.headers.get('set-cookie')].filter(Boolean))
    .map(String)
    .find(value => value.startsWith('whatspro_panel='));
  assert.ok(setCookie, 'the shell render must issue the panel grant');
  const grantCookie = setCookie.split(';')[0];

  const minted = await fetch(base + '/api/chat/session/prestige', {
    headers: { cookie: grantCookie }
  });
  assert.equal(minted.status, 200, 'a panel holding the grant renews without a login');
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


// The PDF broke three times over, each time for a different browser reason:
//   1. window.open answers with a truthy blank window once the bytes have been
//      awaited, so the viewer used to be skipped entirely;
//   2. Android Chrome refuses to paint a PDF inside a frame;
//   3. Yandex Browser blocks a blob: URL inside a frame and paints its own
//      "site blocked" page over the viewer, which is what an operator reported
//      seeing even after the viewer itself opened correctly.
// Nothing about the browser's own PDF handling is trusted now: the bytes are
// drawn onto canvas by pdf.js.
test('documents are drawn onto canvas instead of handed to the browser', () => {
  const code = chatJs.split('\n').filter(line => !line.trim().startsWith('//')).join('\n');
  assert.match(code, /showMediaViewer\(\{ isDocument: true, bytes: bytes, directUrl: mediaUrl\(id\) \}\)/);
  assert.match(code, /async function renderPdfInto/);
  assert.match(code, /lib\.getDocument\(\{ data: new Uint8Array\(bytes\) \}\)/);
  assert.match(code, /container\.appendChild\(canvas\)/);
  assert.doesNotMatch(code, /if \(opened\)/);
  assert.doesNotMatch(code, /opened = window\.open/);
  assert.ok(chatHtml.includes('id="media-pdf"'), 'the viewer needs a canvas container');
  assert.match(chatHtml, /\.media-pdf canvas \{/);
});

test('no blob URL is ever handed to a frame, which is what Yandex blocked', () => {
  const code = chatJs.split('\n').filter(line => !line.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(code, /frame\.src = objectUrl/);
  const assignments = code.match(/frame\.src = [A-Za-z]+/g) || [];
  assert.deepEqual(assignments, ['frame.src = directUrl'], 'a frame may only ever get the plain same-origin URL');
  assert.match(code, /download\.href = isDocument \? directUrl : objectUrl/);
  assert.match(code, /window\.open\(isDocument \? directUrl : objectUrl/);
});

test('the pdf.js bundle ships from the dependency and degrades to the frame', () => {
  assert.match(chatJs, /script\.src = '\/vendor\/pdfjs\/pdf\.js'/);
  assert.match(chatJs, /workerSrc = '\/vendor\/pdfjs\/pdf\.worker\.js'/);
  assert.match(chatJs, /renderPdfInto\(pdfBox, media\.bytes\)\.catch\(/);
  assert.match(serverJs, /app\.get\('\/vendor\/pdfjs\/pdf\.js'/);
  assert.match(serverJs, /app\.get\('\/vendor\/pdfjs\/pdf\.worker\.js'/);
  assert.match(serverJs, /if \(!file\) return res\.status\(404\)\.end\(\)/);
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.ok(pkg.dependencies['pdfjs-dist'], 'pdfjs-dist must be a runtime dependency, not a vendored copy');
});

test('images stay images and never collide with the document path', () => {
  assert.match(chatJs, /image\.hidden = isDocument/);
  assert.match(chatJs, /else image\.src = objectUrl/);
  assert.match(chatJs, /showMediaViewer\(\{ isDocument: false, objectUrl: URL\.createObjectURL\(blob\)/);
  assert.match(chatJs, /function isMobileViewer/);
});

test('the served pdf.js bundle is a real file rather than a 404', async t => {
  const { app } = require('../src/server');
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;

  const main = await fetch(base + '/vendor/pdfjs/pdf.js');
  assert.equal(main.status, 200);
  assert.match(main.headers.get('content-type') || '', /javascript/);
  const body = await main.text();
  assert.ok(body.length > 100000, 'the bundle looks truncated: ' + body.length + ' bytes');

  const worker = await fetch(base + '/vendor/pdfjs/pdf.worker.js');
  assert.equal(worker.status, 200);
});

test('operator errors are localized, not raw fetch text', () => {
  assert.doesNotMatch(chatJs, /showToast\(error\.message, true\)/);
  assert.match(chatJs, /showToast\(t\('actionFailed'\), true\)/);
  for (const key of ['viewerOpen', 'viewerNote', 'actionFailed']) {
    const hits = chatJs.split(key + ':').length - 1;
    assert.equal(hits, 2, key + ' must exist in both kk and ru, found ' + hits);
  }
});
