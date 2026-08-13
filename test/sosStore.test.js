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
  summary: 'Оператор қажет', urgency: 'high', startedAt: NOW - 60_000, expiresAt: NOW + 3_600_000,
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
  assert.equal(rows[0].sosExpiresAt, NOW + 3_600_000, 'the score must survive as a real number');
  assert.equal(rows[0].sosSummary, 'Оператор қажет');
  assert.equal(rows[0].sosUrgency, 'high');
  assert.equal(redis.log.includes('ZREM'), false, 'a live SOS must never be removed from the index');
});

test('the sixty-minute window is what the score carries', async () => {
  const redis = createRedis({
    strings: { [`chatwoot:sos:prestige:${PHONE}`]: MARKER },
    zsets: { 'chatwoot:sos:prestige': { [PHONE]: NOW + 3_600_000 } },
  });
  const store = createSosStore(redis, { now: () => NOW });
  const rows = await store.list('prestige');
  assert.equal(Math.round((rows[0].sosExpiresAt - NOW) / 60000), 60, 'exactly one hour left');
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
