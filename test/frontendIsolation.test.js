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

test('tenant UIs never fall back to a prestige restaurant', () => {
  const chat = read('public/chat.js');
  const callWatcher = read('public/callwatcher.js');
  const whatspro = read('public/whatspro.html');

  assert.doesNotMatch(chat, /\|\|\s*['"]prestige['"]/);
  assert.doesNotMatch(callWatcher, /\|\|\s*['"]prestige['"]/);
  assert.doesNotMatch(whatspro, /placeholder="prestige"/);
});

test('The Alemi Secret Key row carries a generate and a copy control everywhere it is editable', () => {
  const tenants = read('public/tenants.js');
  const css = read('public/tenants.css');

  // One helper renders both buttons, and it is used on all three editable inputs:
  // the wizard step, the rotate-secret modal and the restaurant detail row.
  assert.match(tenants, /data-generate-secret="' \+ attr\(inputId\)/);
  assert.match(tenants, /data-copy-input="' \+ attr\(inputId\)/);
  ['wizard-alemi-secret', 'alemi-secret-input', 'detail-alemi-secret'].forEach((inputId) => {
    assert.match(tenants, new RegExp(`secretActions\\('${inputId}'\\)`), `${inputId} misses the secret controls`);
  });
  assert.match(tenants, /class="secret-row"/);
  assert.match(css, /\.secret-row \{/);

  // 12 mixed-charset characters, drawn from the CSPRNG with rejection sampling.
  assert.match(tenants, /generateMixedSecret\(SECRET_LENGTH\)/);
  assert.match(tenants, /var SECRET_LENGTH = 12;/);
  assert.match(tenants, /getRandomValues/);
  assert.match(tenants, /Math\.floor\(256 \/ bound\) \* bound/);

  // The alphabet keeps one class of each kind and drops the characters an operator
  // cannot retype reliably.
  const classes = tenants.match(/var SECRET_CLASSES = \[([^\]]+)\];/);
  assert.ok(classes, 'the alphabet must live in a single SECRET_CLASSES constant');
  const alphabet = (classes[1].match(/'[^']*'/g) || []).map((part) => part.slice(1, -1));
  assert.deepEqual(alphabet, ['23456789', 'ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnopqrstuvwxyz', '-_.']);
  ['0', '1', 'I', 'O', 'l'].forEach((char) => {
    assert.ok(alphabet.join('').indexOf(char) < 0, `${char} is too easy to misread to stay in the alphabet`);
  });

  // The server hands out a key that collides with no other tenant; a failed
  // request still fills the field, but warns that uniqueness is unconfirmed.
  assert.match(tenants, /api\('GET', '\/api\/wa\/tenants\/alemi-secret\/suggest'\)/);
  assert.match(tenants, /t\('secretUniqueUnconfirmed'\)/);
  assert.match(tenants, /\.catch\(function \(\) \{[\s\S]*?fillSecretInput\(input, local\)/);

  // A duplicate key is reported in the operator's language, never as a raw code.
  assert.match(tenants, /code === 'ALEMI_SECRET_DUPLICATE'[\s\S]*?t\('secretDuplicate'\)/);
  assert.match(tenants, /secretErrorMessage\(error\)/);

  // The key itself must never be echoed into a toast body.
  assert.match(tenants, /copyText\(copyValue, \{ title: t\('secretCopied'\), secret: true \}\)/);
  assert.match(tenants, /opts\.secret \? '' : text/);

  // The detail row saves through the same write-only endpoint as the modal.
  assert.match(tenants, /data-secret-input="detail-alemi-secret"/);
  assert.match(tenants, /\/alemi-secret', \{ secret: secretValue \}/);

  // The row has to survive a phone: the input on its own line, controls below.
  const phoneBlock = css.slice(css.indexOf('@media (max-width: 620px)'));
  assert.match(phoneBlock, /\.secret-row input \{[^}]*flex: 1 1 100%/);
  assert.match(phoneBlock, /\.secret-row \.button \{[^}]*min-height: 40px/);

  // A too-short key comes back as the shared field-validation code, so the field
  // list is what routes it to a translated message instead of a raw error string.
  assert.match(tenants, /TENANT_FIELDS_INVALID'[\s\S]*?indexOf\('alemiSecret'\)[\s\S]*?t\('secretTooShort'\)/);

  ['generateSecret', 'copySecret', 'secretCopied', 'secretGenerated', 'secretEmptyToCopy', 'secretGenerateFailed',
    'secretUniqueUnconfirmed', 'secretDuplicate', 'secretTooShort']
    .forEach((key) => {
      const hits = tenants.match(new RegExp(`${key}:`, 'g')) || [];
      assert.equal(hits.length, 2, `${key} must be translated in both kk and ru`);
    });
});
