'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFile } = require('fs/promises');

// Four whatspro P1s found 2026-08-23 by a fresh audit. Each one either loses a customer
// message or shows the operator something false.

const { __test } = require('../services/incomingWebhook.js');
const { buildHistoryEntry } = __test;
const read = (relative) => readFile(new URL(relative, `file://${__filename}`), 'utf8');

// ---------------------------------------------------------------------------- C27
test('a media metadata write uses the absolute list index', async () => {
  const source = await read('../services/whatsappManager.js');
  const fn = source.slice(source.indexOf('async function updatePersistedMediaMetadata'));
  const body = fn.slice(0, fn.indexOf('\n}'));

  // LRANGE gives a window, LSET takes an absolute index. Writing back the window-relative
  // index destroyed an unrelated message 500 positions earlier as soon as a chat passed 500
  // rows: an older customer message gone, and the voice note appearing inside a previous day.
  assert.match(body, /LLEN/);
  assert.match(body, /const start = Math\.max\(0, length - window\)/);
  assert.match(body, /const absoluteIndex = start \+ index;/);
  assert.match(body, /'LSET', key, String\(absoluteIndex\)/);
  // The window-relative write must be gone.
  assert.doesNotMatch(body, /'LSET', key, String\(index\)/);
});

test('the row is re-verified before it is overwritten', async () => {
  const source = await read('../services/whatsappManager.js');
  const fn = source.slice(source.indexOf('async function updatePersistedMediaMetadata'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  // A trim between the read and the write shifts every index, so the target is re-read and
  // only overwritten while it is still the message we matched. Blind LSET is the defect.
  assert.match(body, /'LINDEX', key, String\(absoluteIndex\)/);
  assert.match(body, /if \(currentId !== messageId\) return false;/);
});

// ---------------------------------------------------------------------------- C28
test('a failed history read never deletes a chat from the inbox', async (t) => {
  const server = await read('../src/server.js');
  const start = server.indexOf("app.get('/api/chat/inbox/:instanceId',");
  const end = server.indexOf("app.get('/api/chat/events/:instanceId',", start);
  assert.ok(start >= 0 && end > start, 'the complete production inbox route is present');
  const registration = server.slice(start, end);
  // Execute the production callback unchanged. Only its Redis and presentation boundaries
  // are controlled; no copy of its read-failure predicate or cleanup decision is used here.
  const axes = [
    { name: 'canonical rejects, legacy is empty', canonical: null, legacy: [] },
    { name: 'canonical is empty, legacy rejects', canonical: [], legacy: null },
    { name: 'both history reads reject', canonical: null, legacy: null },
    { name: 'both reads succeed empty', canonical: [], legacy: [], prune: true },
    { name: 'canonical nonempty takes priority', canonical: ['canonical-row'], legacy: ['legacy-row'], selected: ['canonical-row'] },
    { name: 'legacy nonempty remains the fallback', canonical: [], legacy: ['legacy-row'], selected: ['legacy-row'] },
    { name: 'live SOS survives uncertain history', canonical: null, legacy: [], sos: true, selected: [] },
  ];
  for (const axis of axes) await t.test(axis.name, async () => {
    const instanceId = 'panel-truth-private-fixture';
    const phone = '77000000000';
    const keys = { history: 'fixture:canonical', legacy: 'fixture:legacy',
      inbox: 'fixture:inbox', archive: 'fixture:archive', viewed: 'fixture:viewed', marker: 'fixture:marker' };
    const state = { inbox: new Map([[phone, '1700000000000']]), archive: new Set([phone]),
      viewed: new Map([[phone, '1699999999000']]), marker: new Map([[keys.marker, 'original-archive-marker']]) };
    const snapshot = () => ({ inbox: [...state.inbox], archive: [...state.archive],
      viewed: [...state.viewed], marker: [...state.marker] });
    const before = snapshot();
    const commands = [];
    const selectedHistories = [];
    let callback;
    const context = {
      app: { get(path, ...handlers) {
        assert.equal(path, '/api/chat/inbox/:instanceId');
        assert.equal(callback, undefined, 'register exactly one route');
        callback = handlers.at(-1);
      } },
      resolveChatInstance() {}, requireChatUiOrApi() {},
      isValidInstanceId: (value) => value === instanceId,
      parseLimit: () => 100,
      getTestModePolicy: async () => ({ enabled: false }), allowsPhone: (_policy, value) => value === phone,
      readInboxEntries: async () => [{ phone, updatedAt: 1700000000000 }],
      cachedLegacyHistoryKeys: async () => [],
      sosStore: { list: async () => axis.sos ? [{ phone, sosCreatedAt: 1700000000000,
        sosExpiresAt: 1700003600000, sosUnread: true, sosCaseId: 'fixture-case', sosKind: 'operator' }] : [] },
      chatStore: { resolveLidPhone: async (_instance, value) => value, getState: async () => 'archive' },
      normalizePhone: (value) => value, isValidChatPhone: (value) => value === phone,
      chatHistoryKey: () => keys.history, openbotHistoryKey: () => keys.legacy,
      chatInboxKey: () => keys.inbox, chatArchiveKey: () => keys.archive,
      chatViewedKey: () => keys.viewed, chatArchiveMarkerKey: () => keys.marker,
      summarizeChat(item, rows) {
        selectedHistories.push(Array.from(rows));
        return { phone: item.phone, updatedAt: item.updatedAt, unread: true, closed: true };
      },
      redisClient: { isOpen: true, async sendCommand(args) {
        commands.push(Array.from(args));
        const [command, key, member] = args;
        if (command === 'SMEMBERS' && key === keys.archive) return [...state.archive];
        if (command === 'ZSCORE' && key === keys.viewed) return state.viewed.get(member) || null;
        if (command === 'LRANGE' && (key === keys.history || key === keys.legacy)) {
          assert.deepEqual(Array.from(args.slice(2)), ['-500', '-1']);
          const rows = key === keys.history ? axis.canonical : axis.legacy;
          if (rows === null) throw new Error('synthetic private Redis read failure');
          return rows.slice();
        }
        if (command === 'ZREM' && key === keys.inbox) return Number(state.inbox.delete(member));
        if (command === 'SREM' && key === keys.archive) return Number(state.archive.delete(member));
        if (command === 'ZREM' && key === keys.viewed) return Number(state.viewed.delete(member));
        if (command === 'DEL' && key === keys.marker) return Number(state.marker.delete(key));
        assert.fail(`unexpected Redis boundary command: ${command}`);
      } },
    };
    require('node:vm').runInNewContext(registration, context, { timeout: 1000, filename: 'production-inbox-route.js' });
    assert.equal(typeof callback, 'function');
    let reply;
    await callback({ params: { instanceId }, query: { limit: '100' } }, {
      status(code) { assert.fail(`unexpected HTTP status ${code}`); }, json(value) { reply = value; },
    });
    assert.equal(reply.success, true);
    assert.equal(reply.instanceId, instanceId);
    assert.equal(commands.filter(([command]) => command === 'LRANGE').length, 2);
    const cleanup = commands.filter(([command]) => ['ZREM', 'SREM', 'DEL'].includes(command));
    if (axis.prune) {
      assert.deepEqual(cleanup, [['ZREM', keys.inbox, phone], ['SREM', keys.archive, phone],
        ['ZREM', keys.viewed, phone], ['DEL', keys.marker]]);
      assert.deepEqual(snapshot(), { inbox: [], archive: [], viewed: [], marker: [] });
      assert.equal(reply.items.length, 0);
    } else {
      assert.deepEqual(cleanup, [], 'an uncertain or nonempty history must not remove metadata');
      assert.deepEqual(snapshot(), before, 'preserve every original metadata value');
      assert.equal(reply.items.length, axis.selected ? 1 : 0);
    }
    if (axis.selected) assert.deepEqual(selectedHistories, [axis.selected]);
    else assert.deepEqual(selectedHistories, []);
    if (axis.sos) {
      assert.equal(reply.items[0].sos, true);
      assert.equal(reply.items[0].sosUnread, true);
      assert.equal(reply.items[0].sosCaseId, 'fixture-case');
    }
  });
});

test('a genuinely empty chat is still swept', async () => {
  const server = await read('../src/server.js');
  // The sweep has a job - an index entry for a chat with no history is stale state. The fix
  // must narrow it to "read succeeded and there is nothing", not disable it.
  assert.match(server, /stalePhones\.push\(item\.phone\)/);
  assert.match(server, /ZREM', chatInboxKey\(instanceId\), phone/);
});

// ---------------------------------------------------------------------------- C29
test('the unread badge comes from the computed flag, not the column', async () => {
  const server = await read('../src/server.js');
  // summarizeChat derives unread from latestCustomerAt vs viewedAt; the route replaced it
  // with `state === 'new'`. incomingWebhook stops setting 'new' for operator and archive
  // chats on purpose, and its comment promises "the unread badge still comes from the unread
  // flag" - nothing implemented that, so a customer reply into a chat the operator had taken
  // over showed no badge at all. That is the busiest case in a live shift.
  assert.match(server, /unread: Boolean\(summary\.unread\)/);
  assert.doesNotMatch(server, /unread: state === 'new'/);
});

test('the promise in incomingWebhook is now kept', async () => {
  const webhook = await read('../services/incomingWebhook.js');
  // The comment that described the intended behaviour is still there, and now true.
  assert.match(webhook, /The unread badge still comes from the unread flag/);
  assert.match(webhook, /currentState === 'operator' \|\| currentState === 'archive' \? undefined : 'new'/);
});

// ---------------------------------------------------------------------------- C30
test('media the panel cannot render is still visible to the operator', () => {
  // Before: stored with an empty body and hasMedia:false, so the chat jumped to the top
  // marked new and the transcript rendered nothing - the operator saw only older messages
  // while the guest waited.
  const video = buildHistoryEntry(
    { hasMedia: true, type: 'video', messageId: 'V1' },
    'prestige',
    '77000000000',
    1787500000000
  );
  assert.ok(video.body, 'a video must not be an empty row');
  assert.match(video.body, /Видео/);
  assert.equal(video.text, video.body, 'both readers see the same text');
  assert.equal(video.unsupportedMedia, true);
  // The media itself is still not stored - that boundary is what hasSupportedMedia exists for.
  assert.equal(video.hasMedia, false);
  assert.equal(video.mediaData, '');

  for (const [type, expected] of [['sticker', /Стикер/], ['location', /Локация/], ['vcard', /Контакт/]]) {
    const entry = buildHistoryEntry({ hasMedia: true, type, messageId: type }, 'prestige', '77000000000', 1);
    assert.match(entry.body, expected, `${type} must be visible`);
  }
});

test('a caption still wins, and supported media is untouched', () => {
  // A guest who captions their video must see their own words, not a label.
  const captioned = buildHistoryEntry(
    { hasMedia: true, type: 'video', body: 'мынау менің тапсырысым', messageId: 'V2' },
    'prestige',
    '77000000000',
    1
  );
  assert.equal(captioned.body, 'мынау менің тапсырысым');
  assert.equal(captioned.unsupportedMedia, true);

  // An image is supported: it keeps hasMedia:true, its payload, and an empty body so the
  // panel renders the picture rather than a label.
  const image = buildHistoryEntry(
    { hasMedia: true, type: 'image', mediaType: 'image/jpeg', mediaData: 'BASE64', messageId: 'I1' },
    'prestige',
    '77000000000',
    1
  );
  assert.equal(image.hasMedia, true);
  assert.equal(image.mediaData, 'BASE64');
  assert.equal(image.body, '');
  assert.equal(image.unsupportedMedia, false);

  // A plain text message is completely unaffected.
  const text = buildHistoryEntry({ body: 'пицца бар ма?', messageId: 'T1' }, 'prestige', '77000000000', 1);
  assert.equal(text.body, 'пицца бар ма?');
  assert.equal(text.unsupportedMedia, false);
  assert.equal(text.hasMedia, false);
});

test('a system notification does not become a fake media row', () => {
  // e2e notifications and protocol messages carry hasMedia sometimes; labelling them would
  // put noise in front of the operator.
  for (const type of ['system', 'notification', 'e2e_notification', 'protocol']) {
    const entry = buildHistoryEntry({ hasMedia: true, type, messageId: type }, 'prestige', '77000000000', 1);
    assert.equal(entry.unsupportedMedia, false, `${type} must not be labelled`);
    assert.equal(entry.body, '');
  }
});

// Execute the current production inbox callback against controlled boundaries. No app
// startup, provider, customer transport or production Redis is used by these controls.
test('legacy visible retention: actual inbox admission uses original time and provenance', async (t) => {
  const vm = require('node:vm');
  const server = await read('../src/server.js');
  const begin = server.indexOf("app.get('/api/chat/inbox/:instanceId',");
  const end = server.indexOf("app.get('/api/chat/events/:instanceId',", begin);
  assert.ok(begin >= 0 && end > begin);
  const registration = server.slice(begin, end);
  const parserStart = server.indexOf('function parseHistoryEntry(');
  const parserEnd = server.indexOf('function getEntryCreatedAt(', parserStart);
  const rawStart = server.indexOf('function legacyHistoryLastAt(');
  const rawEnd = server.indexOf('function summarizeChat(', rawStart);
  const helpers = server.slice(parserStart, parserEnd) + (rawStart >= 0 ? server.slice(rawStart, rawEnd) : '');
  const T = 1_800_000_000_000, DAY = 86_400_000;
  const phone = n => String(77000000000 + n);
  const row = (value, field = 'createdAt') => JSON.stringify({ role: 'user', text: 'private fixture', [field]: value });
  const unknown = JSON.stringify({ role: 'user', text: 'private fixture without date' });
  const axes = [
    { name: 'expired milliseconds', history: [row(T - DAY - 1)], count: 0 },
    { name: 'exact one-day boundary', history: [row(T - DAY)], count: 0 },
    { name: 'one millisecond before boundary', history: [row(T - DAY + 1)], count: 1, last: T - DAY + 1 },
    { name: 'recent createdAt seconds', history: [row((T - 60_000) / 1000)], count: 1, last: T - 60_000 },
    { name: 'recent timestamp milliseconds', history: [row(T - 60_000, 'timestamp')], count: 1, last: T - 60_000 },
    { name: 'expired time-only seconds', history: [row((T - 2 * DAY) / 1000, 'time')], count: 0 },
    { name: 'recent time-only seconds', history: [row((T - 60_000) / 1000, 'time')], count: 1, last: T - 60_000 },
    { name: 'missing dates never become NOW', history: [unknown], count: 0 },
    { name: 'malformed date', history: [row('not-a-date')], count: 0 },
    { name: 'zero date', history: [row(0)], count: 0 },
    { name: 'negative date', history: [row(-1)], count: 0 },
    { name: 'unsafe integer date', history: [row(Number.MAX_SAFE_INTEGER + 1)], count: 0 },
    { name: 'future date', history: [row(T + 1)], count: 0 },
    { name: 'boolean date', history: [row(true)], count: 0 },
    { name: 'recent real event plus unknown suffix', history: [row(T - 60_000), unknown], count: 1, last: T - 60_000 },
    { name: 'old real event plus unknown and future suffix', history: [row(T - 2 * DAY), unknown, row(T + 1)], count: 0 },
    { name: 'out-of-order real events', history: [row(T - 60_000), row(T - 2 * DAY)], count: 1, last: T - 60_000 },
    { name: 'fresh canonical all with old display time', history: [row(T - 4 * DAY)], canonical: true, count: 1 },
    { name: 'fresh missing-index archive transition', history: [row(T - 4 * DAY)], state: 'archive', deadline: T + 72 * 3600_000, count: 1 },
    { name: 'fresh missing-index operator transition', history: [row(T - 4 * DAY)], state: 'operator', deadline: T + 3 * 3600_000, count: 1 },
    { name: 'fresh explicit restore transition', history: [row(T - 4 * DAY)], state: 'all', deadline: T + DAY, count: 1 },
    { name: 'atomic snapshot state outranks a separate stale state read', history: [row(T - 4 * DAY)], state: 'all', snapshotState: 'archive', deadline: T + DAY, count: 1 },
    { name: 'expired archive cannot become ALL', history: [row(T - 60_000)], state: 'archive', deadline: T, count: 0 },
    { name: 'expired operator cannot become ALL', history: [row(T - 60_000)], state: 'operator', deadline: T, count: 0 },
    { name: 'unproved stored origin', history: [row(T - 60_000)], deadline: null, count: 0 },
    { name: 'canonical read error retains storage and hides bare recovery', history: [row(T - 60_000)], canonicalError: true, count: 0 },
    { name: 'legacy read error retains storage', history: null, count: 0 },
    { name: 'independent live SOS preserves unknown history', history: [unknown], sos: true, count: 1 },
    { name: 'limit one skips expired before recent', pool: [[row(T - 2 * DAY)], [row(T - 60_000)]], limit: 1, count: 1, selected: phone(1) },
    { name: 'limit one skips unknown before recent', pool: [[unknown], [row(T - 60_000)]], limit: 1, count: 1, selected: phone(1) },
    { name: 'LID dedupe preserves canonical provenance', history: [row(T - 4 * DAY)], canonical: true, lid: true, count: 1 },
    { name: 'bounded legacy pool reports incomplete admission', pool: Array.from({ length: 10001 }, () => [unknown]), limit: 1, count: 0, incomplete: true },
  ];
  for (const axis of axes) await t.test(axis.name, async () => {
    const instanceId = 'legacy-retention-private-fixture';
    const pool = axis.pool || [axis.history];
    const commands = [], summaries = [];
    const original = JSON.stringify(pool);
    let callback, reply;
    const context = {
      Date: class extends Date { static now() { return T; } },
      app: { get(path, ...handlers) { assert.equal(path, '/api/chat/inbox/:instanceId'); callback = handlers.at(-1); } },
      resolveChatInstance() {}, requireChatUiOrApi() {},
      isValidInstanceId: value => value === instanceId,
      parseLimit: () => axis.limit || 100,
      getTestModePolicy: async () => ({ enabled: false }), allowsPhone: () => true,
      readInboxEntries: async () => axis.canonical ? [{ phone: phone(0), updatedAt: T - 1000 }] : [],
      cachedLegacyHistoryKeys: async () => pool.map((_rows, n) => ({ phone: axis.lid && n === 0 ? phone(n) + '@lid' : phone(n), updatedAt: 0 })),
      sosStore: { list: async () => axis.sos ? [{ phone: phone(0), sosCreatedAt: T - 1000, sosExpiresAt: T + 3599_000, sosCaseId: 'private-case' }] : [] },
      chatStore: {
        resolveLidPhone: async (_instance, value) => value.replace(/@lid$/, ''),
        getState: async () => axis.state || 'all',
        getRetentionSnapshot: async () => ({ state: axis.snapshotState || axis.state || 'all', deadline: Object.hasOwn(axis, 'deadline') ? axis.deadline : 0 }),
      },
      normalizePhone: value => value, isValidChatPhone: value => /^\d{11}$/.test(value),
      chatHistoryKey: (_instance, p) => 'canonical:' + p,
      openbotHistoryKey: (_instance, p) => 'legacy:' + p,
      chatInboxKey: () => 'inbox', chatArchiveKey: () => 'archive', chatViewedKey: () => 'viewed', chatArchiveMarkerKey: (_instance, p) => 'marker:' + p,
      summarizeChat(item, rows) {
        summaries.push(item.phone);
        const last = rows.length ? JSON.parse(rows.at(-1)) : {};
        return { phone: item.phone, updatedAt: item.updatedAt, lastAt: Number(last.createdAt || last.timestamp || T), unread: true };
      },
      redisClient: { isOpen: true, async sendCommand(args) {
        commands.push(Array.from(args));
        const [command, key] = args;
        if (command === 'SMEMBERS') return [];
        if (command === 'ZSCORE') return null;
        if (command === 'LRANGE') {
          const n = Number(key.slice(key.indexOf(':') + 1)) - 77000000000;
          if (key.startsWith('canonical:')) {
            if (axis.canonicalError) throw new Error('private canonical read failure');
            return axis.canonical ? pool[n].slice() : [];
          }
          if (pool[n] === null) throw new Error('private legacy read failure');
          return pool[n].slice();
        }
        assert.fail('unexpected write or boundary ' + command);
      } },
    };
    vm.runInNewContext(helpers + registration, context, { timeout: 1000, filename: 'actual-production-legacy-inbox-route.js' });
    const request = { params: { instanceId }, query: { limit: String(axis.limit || 100) } };
    const response = { status(code) { assert.fail('unexpected HTTP status ' + code); }, json(value) { reply = value; } };
    await callback(request, response);
    assert.equal(reply.items.length, axis.count);
    if (axis.selected) assert.equal(reply.items[0].phone, axis.selected);
    if (axis.last) assert.equal(reply.items[0].lastAt, axis.last, 'time-only/unknown suffix must not synthesize a fresh UI date');
    if (axis.incomplete) assert.equal(reply.recoveryIncomplete, true);
    if (axis.sos) assert.equal(reply.items[0].sos, true);
    if (axis.snapshotState) assert.equal(reply.items[0].state, axis.snapshotState);
    const before = JSON.stringify(reply.items);
    await callback(request, response);
    assert.equal(JSON.stringify(reply.items), before, 'duplicate poll changes no lifetime or admission');
    assert.equal(JSON.stringify(pool), original, 'durable original history is unmodified');
    assert.ok(commands.every(([command]) => ['SMEMBERS', 'ZSCORE', 'LRANGE'].includes(command)), 'recovery performs reads only');
  });
});

test('legacy visible retention: real private Redis preserves absolute presentation deadlines', async (t) => {
  const socket = process.env.AUDIT_REDIS_SOCKET;
  assert.ok(socket, 'only the admitted private Unix socket may be used');
  const { createClient } = require('redis');
  const { createChatStore } = require('../services/chatStore');
  const redis = createClient({ socket: { path: socket, reconnectStrategy: false } });
  redis.on('error', () => {});
  await redis.connect();
  try {
    const T = Math.floor(Date.now() / 1000) * 1000, DAY = 86_400_000, PHONE = '77000000000';
    for (const axis of [
      { name: 'expired all stamp with seven-day legacy TTL', state: 'all', origin: T - DAY - 1, visible: false },
      { name: 'expired archive stamp with seven-day legacy TTL', state: 'archive', origin: T - 3 * DAY - 1, visible: false },
      { name: 'expired operator preserves model history and cannot become ALL', state: 'operator', origin: T - 4 * 3600_000, visible: false },
      { name: 'old activity without stamp never repairs from long history TTL', origin: T - DAY - 1, visible: false },
      { name: 'unknown activity and stamp stay stored but hidden', origin: 0, visible: false },
      { name: 'live original all deadline repairs without extension', state: 'all', origin: T - 1000, visible: true },
      { name: 'live original archive transition outranks old history', state: 'archive', origin: T - 1000, visible: true },
      { name: 'malformed origin remains unproved', state: 'all', origin: T - 1000, malformed: true, visible: false },
      { name: 'newer transition racing prune remains reachable', state: 'all', origin: T - DAY - 1, renewed: true, visible: true },
    ]) await t.test(axis.name, async () => {
      const instance = 'u5-private-' + axis.name.replace(/[^a-z]/g, '-');
      let at = T, raced = false;
      const commands = [];
      let store;
      const boundary = { async sendCommand(args) {
        commands.push(Array.from(args));
        if (axis.renewed && !raced && args[0] === 'EVAL' && args[1].includes('presentationRetentionPolicy')) {
          raced = true;
          await redis.sendCommand(['SET', store.keys.state(instance, PHONE), 'archive', 'EX', '259200']);
          await redis.sendCommand(['SET', store.keys.retention(instance, PHONE), 'archive:' + T, 'EX', '259200']);
          await redis.sendCommand(['SET', store.keys.archiveMarker(instance, PHONE), String(T), 'EX', '259200']);
          await redis.sendCommand(['ZADD', store.keys.expiry(instance), String(T + 3 * DAY), PHONE]);
        }
        return redis.sendCommand(args);
      } };
      store = createChatStore(boundary, { now: () => at });
      const legacy = store.keys.legacyHistory(instance, PHONE);
      const body = JSON.stringify({ role: 'user', content: 'private durable memory', createdAt: T - 4 * DAY });
      await redis.sendCommand(['RPUSH', legacy, body]);
      await redis.sendCommand(['EXPIRE', legacy, '604800']);
      await redis.sendCommand(['ZADD', store.keys.inbox(instance), String(axis.origin), PHONE]);
      await redis.sendCommand(['ZADD', store.keys.expiry(instance), String(T - 1), PHONE]);
      if (axis.state) {
        await redis.sendCommand(['SET', store.keys.state(instance, PHONE), axis.state, 'EX', '604800']);
        await redis.sendCommand(['SET', store.keys.retention(instance, PHONE), axis.state + ':' + (axis.malformed ? 'unknown' : axis.origin), 'EX', '604800']);
      }
      if (axis.state === 'archive') await redis.sendCommand(['SET', store.keys.archiveMarker(instance, PHONE), String(axis.origin), 'EX', '604800']);
      const obligations = ['operator:case:' + instance, 'operator:active:' + instance, 'financial:plan:' + instance, 'delivery:journal:' + instance];
      for (const key of obligations) await redis.sendCommand(['SET', key, 'private immutable obligation', 'EX', '604800']);
      const legacyTTL = Number(await redis.sendCommand(['PTTL', legacy]));
      const first = await store.readInbox(instance, 10);
      assert.equal(first.length, axis.visible ? 1 : 0);
      const deadline = await redis.sendCommand(['ZSCORE', store.keys.expiry(instance), PHONE]);
      if (axis.visible) assert.equal(Number(deadline), (axis.renewed ? T + 3 * DAY : axis.origin + (axis.state === 'archive' ? 3 * DAY : DAY)));
      at += 5000;
      const again = await store.readInbox(instance, 10);
      assert.equal(again.length, axis.visible ? 1 : 0);
      assert.equal(await redis.sendCommand(['ZSCORE', store.keys.expiry(instance), PHONE]), deadline, 'poll may not move expiry from the original deadline');
      assert.deepEqual(await redis.sendCommand(['LRANGE', legacy, '0', '-1']), [body]);
      const afterTTL = Number(await redis.sendCommand(['PTTL', legacy]));
      assert.ok(afterTTL <= legacyTTL && afterTTL > legacyTTL - 10_000, 'model-history TTL is neither refreshed nor shortened by polling');
      for (const key of obligations) assert.equal(await redis.sendCommand(['GET', key]), 'private immutable obligation');
      assert.ok(!commands.some(args => (args[0] === 'EXPIRE' || args[0] === 'DEL') && args.slice(1).includes(legacy)));
      if (axis.visible) {
        at = Number(deadline);
        assert.equal((await store.readInbox(instance, 10)).length, 0, 'disappears at the admitted absolute deadline');
        assert.deepEqual(await redis.sendCommand(['LRANGE', legacy, '0', '-1']), [body]);
      }
      if (axis.state === 'operator') {
        const proof = typeof store.getRetentionSnapshot === 'function' ? await store.getRetentionSnapshot(instance, PHONE) : null;
        assert.ok(proof && proof.deadline > 0 && proof.deadline <= at, 'expired presentation proof survives short state expiry');
        await store.appendMessageOnce(instance, PHONE, { id: 'new-genuine-activity', text: 'private new event', createdAt: at }, { state: 'new' });
        assert.equal((await store.readInbox(instance, 10)).length, 1, 'a genuine new message supersedes expired presentation proof');
      }
    });
    await t.test('canonical-only invalid leaders do not starve a fresh third row at limit one', async () => {
      const instance = 'u5-canonical-crowding', store = createChatStore(redis, { now: () => T });
      for (let i = 0; i < 3; i++) {
        const phone = String(77000000100 + i), origin = i < 2 ? T + (2 - i) * 1000 : T - 1000;
        await redis.sendCommand(['RPUSH', store.keys.history(instance, phone), JSON.stringify({ text: 'canonical fixture', createdAt: origin })]);
        await redis.sendCommand(['SET', store.keys.state(instance, phone), 'new', 'EX', '86400']);
        await redis.sendCommand(['SET', store.keys.retention(instance, phone), 'new:' + origin, 'EX', '86400']);
        await redis.sendCommand(['ZADD', store.keys.inbox(instance), String(origin), phone]);
        await redis.sendCommand(['ZADD', store.keys.expiry(instance), String(origin + DAY), phone]);
        assert.equal(await redis.sendCommand(['EXISTS', store.keys.legacyHistory(instance, phone)]), 0);
      }
      assert.deepEqual((await store.readInbox(instance, 1)).map(item => item.phone), ['77000000102']);
    });
    await t.test('delayed prune uses absolute native expiry and preserves an earlier deadline', async () => {
      const instance = 'u5-absolute-native-expiry', begin = Date.now(), origin = begin - DAY + 200;
      let delayed = false;
      const boundary = { async sendCommand(args) {
        if (!delayed && args[0] === 'EVAL' && args[1].includes('presentationRetentionPolicy')) {
          delayed = true; await new Promise(resolve => setTimeout(resolve, 250));
        }
        return redis.sendCommand(args);
      } };
      const store = createChatStore(boundary, { now: () => begin });
      await redis.sendCommand(['SET', store.keys.state(instance, PHONE), 'all', 'EX', '604800']);
      await redis.sendCommand(['SET', store.keys.retention(instance, PHONE), 'all:' + origin, 'EX', '604800']);
      await redis.sendCommand(['ZADD', store.keys.inbox(instance), String(origin), PHONE]);
      await redis.sendCommand(['ZADD', store.keys.expiry(instance), String(begin - 1), PHONE]);
      await store.pruneExpired(instance);
      assert.equal(await redis.sendCommand(['GET', store.keys.state(instance, PHONE)]), null, 'late EVAL cannot extend a key beyond its absolute deadline');
      const other = 'u5-earlier-native-expiry', fresh = Date.now();
      await redis.sendCommand(['SET', store.keys.state(other, PHONE), 'all', 'PX', '1000']);
      await redis.sendCommand(['SET', store.keys.retention(other, PHONE), 'all:' + fresh, 'EX', '604800']);
      await redis.sendCommand(['ZADD', store.keys.inbox(other), String(fresh), PHONE]);
      await redis.sendCommand(['ZADD', store.keys.expiry(other), String(fresh - 1), PHONE]);
      const earlier = await redis.sendCommand(['PEXPIRETIME', store.keys.state(other, PHONE)]);
      await createChatStore(redis, { now: () => fresh }).pruneExpired(other);
      assert.equal(await redis.sendCommand(['PEXPIRETIME', store.keys.state(other, PHONE)]), earlier, 'poll never extends an earlier native expiry');
    });
  } finally { await redis.quit(); }
});

test('legacy visible retention: failed atomic prune preserves an unknown negative proof', async () => {
  assert.ok(process.env.AUDIT_REDIS_SOCKET);
  const { createClient } = require('redis');
  const { createChatStore } = require('../services/chatStore');
  const redis = createClient({ socket: { path: process.env.AUDIT_REDIS_SOCKET, reconnectStrategy: false } });
  redis.on('error', () => {});
  await redis.connect();
  try {
    const at = Date.now(), instance = 'u5-expiry-error-private', phone = '77000000999';
    const boundary = { async sendCommand(args) {
      if (args[0] === 'EVAL' && (args[1].includes('presentationRetentionPolicy') || args[1].includes('local maxTtl'))) throw new Error('private atomic prune failure');
      if (args[0] === 'TYPE' && args[1] === store.keys.legacyHistory(instance, phone)) throw new Error('private unknown legacy type');
      return redis.sendCommand(args);
    } };
    const store = createChatStore(boundary, { now: () => at });
    const history = JSON.stringify({ text: 'private retained model event', createdAt: at - 4 * 3600_000 });
    await redis.sendCommand(['RPUSH', store.keys.legacyHistory(instance, phone), history]);
    await redis.sendCommand(['EXPIRE', store.keys.legacyHistory(instance, phone), '604800']);
    await redis.sendCommand(['ZADD', store.keys.inbox(instance), String(at - 4 * 3600_000), phone]);
    await redis.sendCommand(['ZADD', store.keys.expiry(instance), String(at - 3600_000), phone]);
    await store.pruneExpired(instance);
    assert.equal(Number(await redis.sendCommand(['ZSCORE', store.keys.expiry(instance), phone])), at - 3600_000, 'uncertain reads cannot erase prior expiry');
    assert.deepEqual(await redis.sendCommand(['LRANGE', store.keys.legacyHistory(instance, phone), '0', '-1']), [history]);
    if (typeof store.getRetentionSnapshot === 'function') {
      const proof = await store.getRetentionSnapshot(instance, phone);
      assert.ok(proof.deadline > 0 && proof.deadline <= at, 'retained model memory cannot reopen expired operator as ALL');
    }
  } finally { await redis.quit(); }
});
