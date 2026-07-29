const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

test('WhatsPro, Chat and Tenants frontends keep isolated asset entrypoints', () => {
  const tenants = read('public/tenants.html');
  const chat = read('public/chat.html');
  const whatspro = read('public/whatspro.html');

  assert.match(tenants, /href="\/tenants\.css"/);
  assert.match(tenants, /src="\/tenants\.js"/);
  assert.doesNotMatch(tenants, /src="\/(?:chat|chat-core)\.js"/);
  assert.doesNotMatch(tenants, /whatspro\.html/);

  assert.match(chat, /src="\/chat-core\.js"/);
  assert.match(chat, /src="\/chat\.js"/);
  assert.doesNotMatch(chat, /src="\/tenants\.js"/);
  assert.doesNotMatch(chat, /whatspro\.html/);

  assert.doesNotMatch(whatspro, /src="\/tenants\.js"/);
  assert.doesNotMatch(whatspro, /src="\/(?:chat|chat-core)\.js"/);
});

test('Tenants authenticates through its platform boundary while legacy aliases remain server-side', () => {
  const tenants = read('public/tenants.js');
  const server = read('src/server.js');

  assert.match(tenants, /\/api\/platform\/session/);
  assert.match(tenants, /\/api\/platform\/login/);
  assert.match(tenants, /\/api\/platform\/logout/);
  assert.doesNotMatch(tenants, /api\('(?:GET|POST)', '\/api\/whatspro\/(?:session|login|logout)'/);

  assert.match(server, /\['\/api\/platform\/session', '\/api\/whatspro\/session'\]/);
  assert.match(server, /\['\/api\/platform\/login', '\/api\/whatspro\/login'\]/);
  assert.match(server, /\['\/api\/platform\/logout', '\/api\/whatspro\/logout'\]/);
});

test('Each public UI keeps its own direct server route', () => {
  const server = read('src/server.js');

  assert.match(server, /app\.get\('\/whatspro'[\s\S]*?'whatspro\.html'/);
  assert.match(server, /app\.get\('\/tenants'[\s\S]*?'tenants\.html'/);
  assert.match(server, /app\.get\(\['\/chat', '\/inbox'\]/);
});
