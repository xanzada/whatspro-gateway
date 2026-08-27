'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('embedded chat reports only aggregate SOS unread state to the configured Hub origin', () => {
  const root = path.join(__dirname, '..');
  const client = fs.readFileSync(path.join(root, 'public', 'chat.js'), 'utf8');
  const server = fs.readFileSync(path.join(root, 'src', 'server.js'), 'utf8');

  assert.match(server, /parentOrigin:\s*chatParentOrigin\(\)/);
  assert.match(server, /CHAT_PARENT_ORIGIN\s*\|\|\s*fallback/);
  assert.match(client, /type:\s*'platform\.chat\.sos-unread'/);
  assert.match(client, /schema_version:\s*1/);
  assert.match(client, /instance:\s*instanceId/);
  assert.match(client, /sos_unread:\s*count/);
  assert.match(client, /window\.parent\.postMessage\([\s\S]*?\},\s*parentOrigin\)/);
  assert.doesNotMatch(client, /window\.parent\.postMessage\([\s\S]*?,\s*['"]\*['"]\s*\)/);
  assert.match(client, /state\.chats\s*=\s*chats;\s*publishParentSosUnread\(\);/);
  assert.doesNotMatch(
    client.slice(client.indexOf('function publishParentSosUnread'), client.indexOf('function headers')),
    /(?:phone|summary|message)\s*:/i
  );
});

// The postMessage above only exists while the panel is on screen. The site also has to
// be able to ask, so the badge is right the moment the cabinet opens.
test('the SOS count is readable without opening the panel, and reading it never acknowledges', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  const route = server.slice(
    server.indexOf("app.get('/api/chat/sos-count/:instanceId'"),
    server.indexOf("app.post('/api/wa/start'")
  );

  assert.ok(route, 'sos-count route is registered');
  assert.match(route, /resolveChatInstance,\s*requireChatUiOrApi/);
  assert.match(route, /withinApiScope\(req,\s*instanceId\)/);
  assert.match(route, /sos_unread:\s*unread/);
  assert.match(route, /sos_open:\s*total/);
  assert.match(route, /allowsPhone\(testModePolicy,\s*phone\)/);
  // A poll that acknowledged would erase the very signal the operator has not read yet.
  assert.doesNotMatch(route, /sosStore\.(acknowledge|clear)/);
});
