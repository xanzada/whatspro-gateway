const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const compose = fs.readFileSync(path.join(root, 'docker-compose.yml'), 'utf8');
const backup = fs.readFileSync(path.join(root, 'backup', 'backup.sh'), 'utf8');
const restore = fs.readFileSync(path.join(root, 'backup', 'restore.sh'), 'utf8');

test('backup sidecar reads WhatsApp auth without writing to the live volume', () => {
  assert.match(compose, /whatsapp_auth:\/source\/whatsapp_auth:ro/);
  assert.match(compose, /BACKUP_ENABLED: \$\{BACKUP_ENABLED:-false\}/);
  assert.match(compose, /REDIS_URL: \$\{BACKUP_REDIS_URL:-redis:\/\/redis_local:6379\}/);
  assert.match(compose, /backup:[\s\S]+networks:[\s\S]+dokploy-network/);
  assert.match(compose, /backup_state:\/work/);
});

test('offsite snapshots are encrypted, split and alternated', () => {
  assert.match(backup, /age -r "\$\{recipient\}"/);
  assert.match(backup, /split -b 90m/);
  assert.match(backup, /BACKUP_GIT_BRANCH_PREFIX.*slot/);
  assert.match(backup, /StrictHostKeyChecking=yes/);
  assert.match(backup, /cd "\$\{stage\}"[\s\S]+sha256sum snapshot\.tar\.zst\.age\.part-\*/);
  assert.match(backup, /--exclude='\*\/Cache\/\*'/);
  assert.match(backup, /\[\[ -s "\$\{stage\}\/redis\.rdb" \]\]/);
  assert.match(backup, /push --quiet --force[\s\S]+\|\| return 1/);
  assert.doesNotMatch(backup, /BEGIN OPENSSH PRIVATE KEY/);
});

test('restore verifies encrypted parts and decrypted payload hashes', () => {
  assert.match(restore, /encrypted-parts\.sha256[\s\S]+sha256sum -c -/);
  assert.match(restore, /age -d -i/);
  assert.match(restore, /redisSha256/);
  assert.match(restore, /whatsappAuthSha256/);
});
