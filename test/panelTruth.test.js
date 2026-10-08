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
