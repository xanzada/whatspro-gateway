'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createSosStore } = require('../services/sosStore');
const { parseScoredMembers } = require('../services/redisReply');

// This fake answers WITHSCORES the way node-redis actually does — as
// [member, score] tuples. The previous fake returned the flat RESP2 list, so the
// suite passed while every SOS was deleted on the first inbox poll in
// production. Keep this shape: it is what the running client sends back.
function createRedis(seed = {}) {
  const strings = new Map(Object.entries(seed.strings || {}));
  const zsets = new Map(Object.entries(seed.zsets || {}).map(([k, v]) => [k, new Map(Object.entries(v))]));
  const log = [];
  return {
    log,
    async sendCommand(args) {
      const [rawCommand, key] = args;
      const command = String(rawCommand).toUpperCase();
      log.push(command);
      if (command === 'GET') return strings.has(key) ? strings.get(key) : null;
      if (command === 'EXISTS') return strings.has(key) ? 1 : 0;
      if (command === 'ZREM') { const z = zsets.get(key); return z && z.delete(args[2]) ? 1 : 0; }
      if (command === 'ZREMRANGEBYSCORE') {
        const z = zsets.get(key);
        if (!z) return 0;
        const max = Number(args[3]);
        let removed = 0;
        for (const [member, score] of [...z]) if (Number(score) <= max) { z.delete(member); removed += 1; }
        return removed;
      }
      if (command === 'ZRANGEBYSCORE') {
        const z = zsets.get(key);
        if (!z) return [];
        const min = Number(args[2]);
        return [...z].filter(([, score]) => Number(score) >= min).map(([member, score]) => [member, Number(score)]);
      }
      if (command === 'EVAL') return 1;
      return null;
    }
  };
}

const NOW = 1_785_000_000_000;
const PHONE = '77015550101';
const MARKER = JSON.stringify({
  caseId: 'oc_1', signalId: 'sig_1', kind: 'human_request',
  summary: 'Оператор қажет', startedAt: NOW - 60_000, expiresAt: NOW + 3_600_000,
});

test('an active SOS survives a listing and reaches the operator', async () => {
  const redis = createRedis({
    strings: {
      [`chatwoot:sos:prestige:${PHONE}`]: MARKER,
      [`chatwoot:sos-unread:prestige:${PHONE}`]: 'sig_1',
    },
    zsets: { 'chatwoot:sos:prestige': { [PHONE]: NOW + 3_600_000 } },
  });
  const store = createSosStore(redis, { now: () => NOW });

  const rows = await store.list('prestige');
  assert.equal(rows.length, 1, 'the SOS must be listed, not swallowed');
  assert.equal(rows[0].phone, PHONE);
  assert.equal(rows[0].sos, true);
  assert.equal(rows[0].sosUnread, true, 'the light is on until the operator opens it');
  assert.equal(rows[0].sosExpiresAt, JSON.parse(MARKER).startedAt + 3_600_000, 'visible hour starts at the admitted signal origin');
  assert.equal(rows[0].sosSummary, 'Оператор қажет');
  assert.equal(redis.log.includes('ZREM'), false, 'a live SOS must never be removed from the index');
});

test('the same customer phone has isolated SOS state in two tenants', async () => {
  const alphaMarker = JSON.stringify({ ...JSON.parse(MARKER), summary: 'alpha only' });
  const betaMarker = JSON.stringify({ ...JSON.parse(MARKER), summary: 'beta only' });
  const redis = createRedis({
    strings: {
      [`chatwoot:sos:tenant-alpha:${PHONE}`]: alphaMarker,
      [`chatwoot:sos-unread:tenant-alpha:${PHONE}`]: 'alpha-signal',
      [`chatwoot:sos:tenant-beta:${PHONE}`]: betaMarker,
    },
    zsets: {
      'chatwoot:sos:tenant-alpha': { [PHONE]: NOW + 3_600_000 },
      'chatwoot:sos:tenant-beta': { [PHONE]: NOW + 3_600_000 },
    },
  });
  const store = createSosStore(redis, { now: () => NOW });

  const [alpha, beta] = await Promise.all([store.list('tenant-alpha'), store.list('tenant-beta')]);
  assert.equal(alpha[0].sosSummary, 'alpha only');
  assert.equal(alpha[0].sosUnread, true);
  assert.equal(beta[0].sosSummary, 'beta only');
  assert.equal(beta[0].sosUnread, false);
});

test('the sixty-minute window is what the score carries', async () => {
  const redis = createRedis({
    strings: { [`chatwoot:sos:prestige:${PHONE}`]: MARKER },
    zsets: { 'chatwoot:sos:prestige': { [PHONE]: NOW + 3_600_000 } },
  });
  const store = createSosStore(redis, { now: () => NOW });
  const rows = await store.list('prestige');
  assert.equal(Math.round((rows[0].sosExpiresAt - NOW) / 60000), 59, 'one minute elapsed since the admitted signal origin');
  assert.equal(rows[0].sosUnread, false, 'no unread key means the light is already acknowledged');
});

test('an expired SOS is dropped and the chat returns to its normal column', async () => {
  const redis = createRedis({
    strings: { [`chatwoot:sos:prestige:${PHONE}`]: MARKER },
    zsets: { 'chatwoot:sos:prestige': { [PHONE]: NOW - 1_000 } },
  });
  const store = createSosStore(redis, { now: () => NOW });
  assert.deepEqual(await store.list('prestige'), [], 'nothing is served once the hour is up');
});

test('acknowledging clears the light but keeps the case listed', async () => {
  const redis = createRedis({
    strings: {
      [`chatwoot:sos:prestige:${PHONE}`]: MARKER,
      [`chatwoot:sos-unread:prestige:${PHONE}`]: 'sig_1',
    },
    zsets: { 'chatwoot:sos:prestige': { [PHONE]: NOW + 3_600_000 } },
  });
  const store = createSosStore(redis, { now: () => NOW });
  assert.equal(await store.acknowledge('prestige', PHONE), true);
});

test('a SCAN batch is walked key by key, not stringified whole', async () => {
  const { scanKeys } = require('../services/redisReply');
  const batched = {
    async *scanIterator() {
      yield ['chatwoot:expiry:alpha', 'chatwoot:expiry:beta'];
      yield ['chatwoot:expiry:gamma'];
    }
  };
  const seen = [];
  for await (const key of scanKeys(batched, 'chatwoot:expiry:*')) seen.push(key);
  assert.deepEqual(seen, ['chatwoot:expiry:alpha', 'chatwoot:expiry:beta', 'chatwoot:expiry:gamma']);

  const flat = { async *scanIterator() { yield 'chatwoot:expiry:solo'; } };
  const single = [];
  for await (const key of scanKeys(flat, 'chatwoot:expiry:*')) single.push(key);
  assert.deepEqual(single, ['chatwoot:expiry:solo'], 'a client that yields single keys still works');
});

test('every WITHSCORES shape a client may return is read the same way', () => {
  const expected = [{ member: '77015550101', score: 1785000000000 }];
  assert.deepEqual(parseScoredMembers([['77015550101', 1785000000000]]), expected, 'node-redis tuples');
  assert.deepEqual(parseScoredMembers([{ value: '77015550101', score: 1785000000000 }]), expected, 'value/score objects');
  assert.deepEqual(parseScoredMembers(['77015550101', '1785000000000']), expected, 'flat RESP2 list');
  assert.deepEqual(parseScoredMembers([]), []);
  assert.deepEqual(parseScoredMembers(null), []);
});


test('SOS retention policy: visibility ends at one hour and preserves the durable marker/index', async () => {
  const started = NOW - 3600_000;
  const marker = JSON.stringify({ caseId: 'retained-case', startedAt: started, expiresAt: started + 86400_000 });
  const redis = createRedis({ strings: { ['chatwoot:sos:prestige:' + PHONE]: marker },
    zsets: { 'chatwoot:sos:prestige': { [PHONE]: started + 86400_000 } } });
  let time = NOW - 1;
  const store = createSosStore(redis, { now: () => time });
  const visible = await store.list('prestige');
  assert.equal(visible.length, 1);
  assert.equal(visible[0].sosExpiresAt, NOW);
  time = NOW;
  assert.deepEqual(await store.list('prestige'), []);
  assert.equal(await store.snapshot('prestige', PHONE), marker);
  assert.equal(redis.log.includes('ZREM'), false, 'display expiry is not canonical-case resolution');
});

test('SOS retention policy: seconds and milliseconds share the same admitted signal origin', async () => {
  for (const value of [NOW - 60_000, String((NOW - 60_000) / 1000)]) {
    const redis = createRedis({ strings: { ['chatwoot:sos:prestige:' + PHONE]: JSON.stringify({ startedAt: value }) },
      zsets: { 'chatwoot:sos:prestige': { [PHONE]: NOW + 86400_000 } } });
    const rows = await createSosStore(redis, { now: () => NOW }).list('prestige');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].sosCreatedAt, NOW - 60_000);
    assert.equal(rows[0].sosExpiresAt, NOW - 60_000 + 3600_000);
  }
});

test('SOS retention policy: unknown, malformed and future origins are preserved without invented visibility', async () => {
  for (const value of [undefined, null, '', 'unknown', -1, NOW + 1, NOW + 0.5]) {
    const marker = JSON.stringify({ caseId: 'unknown-preserved', startedAt: value });
    const redis = createRedis({ strings: { ['chatwoot:sos:prestige:' + PHONE]: marker },
      zsets: { 'chatwoot:sos:prestige': { [PHONE]: NOW + 86400_000 } } });
    const store = createSosStore(redis, { now: () => NOW });
    assert.deepEqual(await store.list('prestige'), [], 'unproven origin does not get a fabricated new hour');
    assert.equal(await store.snapshot('prestige', PHONE), marker);
    assert.equal(redis.log.includes('ZREM'), false);
  }
});

test('SOS retention policy: a fresh replacement remains visible after the older signal hour', async () => {
  const redis = createRedis({ strings: { ['chatwoot:sos:prestige:' + PHONE]: JSON.stringify({
    startedAt: NOW - 10_000, caseId: 'newer', signalId: 'newer-signal' }) },
    zsets: { 'chatwoot:sos:prestige': { [PHONE]: NOW + 86400_000 } } });
  const rows = await createSosStore(redis, { now: () => NOW }).list('prestige');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sosCaseId, 'newer');
  assert.equal(rows[0].sosExpiresAt, NOW - 10_000 + 3600_000);
});

test('SOS retention policy: exhausted retrieval bound is explicit rather than an empty visible list', async () => {
  let pages = 0;
  const redis = {async sendCommand(args) {
    if (args[0] === 'ZRANGEBYSCORE') {pages++; return Array.from({length: 100}, (_, i) => [String(77000000000 + i), NOW + 86400000]);}
    if (args[0] === 'GET') return JSON.stringify({caseId: 'oc_unknown', signalId: 'unknown'});
    if (args[0] === 'EXISTS') return 1;
    return 0;
  }};
  const ss = createSosStore(redis, {now: () => NOW});
  await assert.rejects(ss.list('prestige', 1), /SOS_VISIBLE_SCAN_INCOMPLETE/);
  assert.equal(pages, 100);
});
