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
