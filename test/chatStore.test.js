const test = require('node:test');
const assert = require('node:assert/strict');

const { createChatStore, STANDARD_TTL_SECONDS, ARCHIVE_TTL_SECONDS } = require('../services/chatStore');

class FakeRedis {
  constructor() {
    this.data = new Map();
    this.expires = new Map();
    this.isOpen = true;
  }

  async sendCommand(args) {
    const command = args[0].toUpperCase();
    const key = args[1];
    const value = this.data.get(key);
    if (command === 'TYPE') return value?.type || 'none';
    if (command === 'DEL') return args.slice(1).reduce((n, item) => { this.expires.delete(item); return n + Number(this.data.delete(item)); }, 0);
    if (command === 'EXPIRE') { if (!value) return 0; this.expires.set(key, Number(args[2])); return 1; }
    if (command === 'TTL') return this.expires.get(key) ?? (value ? -1 : -2);
    if (command === 'GET') return value?.value ?? null;
    if (command === 'HGET') return value?.type === 'hash' ? value.value.get(args[2]) ?? null : null;
    if (command === 'HSET') {
      const row = value || { type: 'hash', value: new Map() };
      row.value.set(args[2], args[3]); this.data.set(key, row); return 1;
    }
    if (command === 'HGETALL') return value?.type === 'hash' ? [...value.value].flat() : [];
    if (command === 'SET') {
      if (args.includes('NX') && value) return null;
      this.data.set(key, { type: 'string', value: args[2] });
      const exIndex = args.indexOf('EX');
      if (exIndex >= 0) this.expires.set(key, Number(args[exIndex + 1]));
      return 'OK';
    }
    if (command === 'RPUSH') {
      const row = value || { type: 'list', value: [] };
      if (row.type !== 'list') throw new Error('WRONGTYPE');
      row.value.push(...args.slice(2)); this.data.set(key, row); return row.value.length;
    }
    if (command === 'LRANGE') {
      if (!value) return [];
      if (value.type !== 'list') throw new Error('WRONGTYPE');
      const start = Number(args[2]); const stop = Number(args[3]);
      const from = start < 0 ? Math.max(0, value.value.length + start) : start;
      const to = stop < 0 ? value.value.length + stop : stop;
      return value.value.slice(from, to + 1);
    }
    if (command === 'ZADD') {
      const row = value || { type: 'zset', value: new Map() };
      if (row.type !== 'zset') throw new Error('WRONGTYPE');
      for (let i = 2; i < args.length; i += 2) row.value.set(args[i + 1], Number(args[i]));
      this.data.set(key, row); return 1;
    }
    if (command === 'ZREVRANGE') {
      if (!value) return [];
      if (value.type !== 'zset') throw new Error('WRONGTYPE');
      const rows = [...value.value].sort((a, b) => b[1] - a[1]).slice(Number(args[2]), Number(args[3]) + 1);
      return args[4] === 'WITHSCORES' ? rows.flatMap(([member, score]) => [member, String(score)]) : rows.map(([member]) => member);
    }
    if (command === 'ZRANGEBYSCORE') {
      if (!value) return [];
      if (value.type !== 'zset') throw new Error('WRONGTYPE');
      const min = Number(args[2]); const max = Number(args[3]);
      return [...value.value].filter(([, score]) => score >= min && score <= max).map(([member]) => member);
    }
    if (command === 'ZREM') { if (value?.type !== 'zset') return 0; return Number(value.value.delete(args[2])); }
    if (command === 'SADD') {
      const row = value || { type: 'set', value: new Set() };
      args.slice(2).forEach(item => row.value.add(item)); this.data.set(key, row); return 1;
    }
    if (command === 'SREM') { if (value?.type !== 'set') return 0; return Number(value.value.delete(args[2])); }
    if (command === 'SMEMBERS') return value?.type === 'set' ? [...value.value] : [];
    if (command === 'SISMEMBER') return value?.type === 'set' && value.value.has(args[2]) ? 1 : 0;
    if (command === 'RENAME') { this.data.set(args[2], value); this.data.delete(key); return 'OK'; }
    if (command === 'EVAL' && args[2] === '14') {
      const deletedKey = args[3]; const member = args[17]; const deletedAt = args[18]; const ttl = Number(args[19]);
      this.data.set(deletedKey, { type: 'string', value: deletedAt }); this.expires.set(deletedKey, ttl);
      for (const item of args.slice(4, 13)) { this.data.delete(item); this.expires.delete(item); }
      for (const item of args.slice(13, 16)) this.data.get(item)?.value?.delete(member);
      this.data.get(args[16])?.value?.delete(member);
      return 1;
    }
    if (command === 'EVAL' && args[2] === '8' && args[1].includes("SADD")) {
      const historyKey = args[3]; const idsKey = args[4]; const deletedKey = args[5];
      const messageId = args[11]; const json = args[12]; const createdAt = Number(args[13]);
      if (Number(this.data.get(deletedKey)?.value || 0) >= createdAt) return -1;
      const ids = this.data.get(idsKey) || { type: 'set', value: new Set() };
      const inserted = !ids.value.has(messageId);
      if (inserted) {
        ids.value.add(messageId); this.data.set(idsKey, ids);
        const history = this.data.get(historyKey) || { type: 'list', value: [] };
        history.value.push(json); this.data.set(historyKey, history);
      }
      const phone = args[14]; const state = args[15]; const ttl = Number(args[16]);
      const inbox = this.data.get(args[6]) || { type: 'zset', value: new Map() };
      inbox.value.set(phone, createdAt); this.data.set(args[6], inbox);
      this.data.set(args[7], { type: 'string', value: state }); this.expires.set(args[7], ttl);
      const expiry = this.data.get(args[8]) || { type: 'zset', value: new Map() };
      expiry.value.set(phone, Number(args[17])); this.data.set(args[8], expiry);
      this.expires.set(historyKey, ttl); this.expires.set(idsKey, ttl);
      if (state !== 'archive') { this.data.delete(args[9]); this.data.get(args[10])?.value?.delete(phone); }
      return inserted ? 1 : 0;
    }
    throw new Error(`Unsupported command ${command}`);
  }

  async *scanIterator({ MATCH }) {
    const prefix = MATCH.replace('*', '');
    for (const key of this.data.keys()) if (key.startsWith(prefix)) yield key;
  }
}

test('incoming, viewed, operator and archive are exclusive states', async () => {
  const redis = new FakeRedis();
  const store = createChatStore(redis, { now: () => 1000 });
  await store.saveEntry('acme', '77001234567', { id: 'm1', text: 'hello', direction: 'incoming' }, { state: 'new' });
  assert.equal(await store.getState('acme', '77001234567'), 'new');
  await store.applyAction('acme', '77001234567', 'view');
  assert.equal(await store.getState('acme', '77001234567'), 'all');
  await store.saveEntry('acme', '77001234567', { id: 'm2', text: 'reply', role: 'operator', source: 'operator_panel' }, { state: 'operator' });
  assert.equal(await store.getState('acme', '77001234567'), 'operator');
  await store.applyAction('acme', '77001234567', 'view');
  assert.equal(await store.getState('acme', '77001234567'), 'operator');
  await store.applyAction('acme', '77001234567', 'archive');
  assert.equal(await store.getState('acme', '77001234567'), 'archive');
  await store.applyAction('acme', '77001234567', 'view');
  assert.equal(await store.getState('acme', '77001234567'), 'archive');
  assert.equal(redis.expires.get('chatwoot:history:acme:77001234567'), ARCHIVE_TTL_SECONDS);
  await store.applyAction('acme', '77001234567', 'restore');
  assert.equal(await store.getState('acme', '77001234567'), 'all');
});

test('media is stored separately, omitted from history, and follows chat TTL', async () => {
  const redis = new FakeRedis();
  const store = createChatStore(redis, { now: () => 2000 });
  await store.saveEntry('acme', '77001234567', { id: 'voice1', hasMedia: true, mediaType: 'audio/ogg', mediaData: 'YWJj' }, { state: 'new' });
  const history = await store.getHistory('acme', '77001234567');
  assert.equal(Object.hasOwn(history[0], 'mediaData'), false);
  assert.equal(await store.getMedia('acme', 'voice1'), 'data:audio/ogg;base64,YWJj');
  assert.equal(redis.expires.get('chatwoot:media:acme:voice1'), STANDARD_TTL_SECONDS);
  await store.applyAction('acme', '77001234567', 'archive');
  assert.equal(redis.expires.get('chatwoot:media:acme:voice1'), ARCHIVE_TTL_SECONDS);
});

test('hard delete removes history, media, locks and index membership', async () => {
  const redis = new FakeRedis();
  const store = createChatStore(redis);
  await store.saveEntry('acme', '77001234567', { id: 'voice1', hasMedia: true, mediaType: 'audio/ogg', mediaData: 'YWJj' }, { state: 'new' });
  await redis.sendCommand(['SET', 'operator_active:acme:77001234567', 'operator', 'EX', '60']);
  await redis.sendCommand(['SET', 'mute:acme:77001234567', 'operator', 'EX', '60']);
  await store.applyAction('acme', '77001234567', 'delete');
  for (const key of ['chatwoot:history:acme:77001234567', 'chatwoot:media:acme:voice1', 'operator_active:acme:77001234567', 'mute:acme:77001234567']) {
    assert.equal(redis.data.has(key), false, key);
  }
});

test('legacy LIST inbox is normalized to a sorted set without losing valid chats', async () => {
  const redis = new FakeRedis();
  await redis.sendCommand(['RPUSH', 'chatwoot:inbox:acme', JSON.stringify({ phone: '+7 700 123 45 67', createdAt: 10 }), 'bad-row', '77007654321,20']);
  await redis.sendCommand(['RPUSH', 'chatwoot:history:acme:77001234567', JSON.stringify({ id: 'a', direction: 'incoming' })]);
  await redis.sendCommand(['RPUSH', 'chatwoot:history:acme:77007654321', JSON.stringify({ id: 'b', direction: 'incoming' })]);
  const store = createChatStore(redis, { now: () => 30 });
  const rows = await store.readInbox('acme', 10);
  assert.deepEqual(rows, [{ phone: '77007654321', updatedAt: 20 }, { phone: '77001234567', updatedAt: 10 }]);
  assert.equal(await redis.sendCommand(['TYPE', 'chatwoot:inbox:acme']), 'zset');
});

test('append migrates a legacy LIST inbox before writing the new message', async () => {
  const redis = new FakeRedis();
  await redis.sendCommand(['RPUSH', 'chatwoot:inbox:acme', '77001234567,10']);
  const store = createChatStore(redis, { now: () => 20 });
  await store.appendMessage('acme', '77007654321', { id: 'new', text: 'new', direction: 'incoming' }, { state: 'new' });
  const rows = await store.readInbox('acme', 10);
  assert.deepEqual(rows.map(row => row.phone), ['77007654321']);
  assert.equal(await redis.sendCommand(['TYPE', 'chatwoot:inbox:acme']), 'zset');
});

test('readInbox prunes index members after authoritative chat keys expire', async () => {
  const redis = new FakeRedis();
  await redis.sendCommand(['ZADD', 'chatwoot:inbox:acme', '10', '77001234567']);
  await redis.sendCommand(['SADD', 'chatwoot:archive:acme', '77001234567']);
  await redis.sendCommand(['ZADD', 'chatwoot:viewed:acme', '10', '77001234567']);
  const store = createChatStore(redis);
  assert.deepEqual(await store.readInbox('acme', 10), []);
  assert.deepEqual(await redis.sendCommand(['SMEMBERS', 'chatwoot:archive:acme']), []);
});

test('concurrent legacy migrations keep the normalized inbox intact', async () => {
  const redis = new FakeRedis();
  await redis.sendCommand(['RPUSH', 'chatwoot:inbox:acme', '77001234567,10', '77007654321,20']);
  await redis.sendCommand(['RPUSH', 'chatwoot:history:acme:77001234567', '{}']);
  await redis.sendCommand(['RPUSH', 'chatwoot:history:acme:77007654321', '{}']);
  const store = createChatStore(redis, { now: () => 30 });
  const [first, second] = await Promise.all([store.readInbox('acme', 10), store.readInbox('acme', 10)]);
  assert.deepEqual(first.map(row => row.phone), ['77007654321', '77001234567']);
  assert.deepEqual(second.map(row => row.phone), first.map(row => row.phone));
});

test('expired archive membership is not authoritative and oversized media is rejected', async () => {
  const redis = new FakeRedis();
  const store = createChatStore(redis);
  await redis.sendCommand(['SADD', 'chatwoot:archive:acme', '77001234567']);
  assert.equal(await store.getState('acme', '77001234567'), 'all');
  await assert.rejects(
    store.storeMedia('acme', '77001234567', 'huge', 'A'.repeat(23 * 1024 * 1024), 'audio/ogg'),
    /OVERSIZED_MEDIA/
  );
});

test('receipts are monotonic and cannot recreate a deleted chat', async () => {
  const redis = new FakeRedis();
  const store = createChatStore(redis);
  await store.appendMessage('acme', '77001234567', { id: 'out1', text: 'hello', role: 'operator' }, { state: 'operator' });
  assert.equal(await store.updateMessageReceipt('acme', '77001234567', 'out1', 'read'), true);
  assert.equal(await store.updateMessageReceipt('acme', '77001234567', 'out1', 'sent'), true);
  assert.equal((await store.getHistory('acme', '77001234567'))[0].deliveryStatus, 'read');
  await store.applyAction('acme', '77001234567', 'delete');
  assert.equal(await store.updateMessageReceipt('acme', '77001234567', 'out1', 'read'), false);
  assert.equal(redis.data.has('chatwoot:receipts:acme:77001234567'), false);
});

test('idempotent operator append repairs metadata and respects delete tombstones', async () => {
  let now = 1_700_000_000_000;
  const redis = new FakeRedis();
  const store = createChatStore(redis, { now: () => now });
  const entry = { id: 'operator-1', text: 'sent once', role: 'operator', createdAt: now };
  assert.equal((await store.appendMessageOnce('acme', '77001234567', entry, { state: 'operator' })).inserted, true);
  redis.data.delete(store.keys.inbox('acme'));
  redis.expires.delete(store.keys.history('acme', '77001234567'));
  assert.equal((await store.appendMessageOnce('acme', '77001234567', entry, { state: 'operator' })).inserted, false);
  assert.equal(redis.data.get(store.keys.inbox('acme')).value.has('77001234567'), true);
  assert.equal(redis.expires.get(store.keys.history('acme', '77001234567')), STANDARD_TTL_SECONDS);

  now += 1000;
  await store.applyAction('acme', '77001234567', 'delete');
  assert.equal(redis.data.get(store.keys.deleted('acme', '77001234567'))?.value, String(now));
  assert.equal(redis.data.has(store.keys.messageIds('acme', '77001234567')), false);
  const stale = await store.appendMessageOnce('acme', '77001234567', entry, { state: 'operator' });
  assert.equal(stale.stale, true);
});
