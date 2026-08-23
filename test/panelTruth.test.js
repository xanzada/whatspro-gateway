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
test('a failed history read never deletes a chat from the inbox', async () => {
  const server = await read('../src/server.js');
  // The reads must be distinguishable from "no history": .catch(() => []) made one transient
  // Redis error look like a dead chat, and the sweep then ZREM'd the inbox entry, the viewed
  // marker, the archive membership and the archive marker. The conversation vanished from the
  // panel while its messages sat in Redis.
  assert.match(server, /chatHistoryKey\(instanceId, item\.phone\), '-500', '-1'\]\)\.catch\(\(\) => null\)/);
  assert.match(server, /openbotHistoryKey\(instanceId, item\.phone\), '-500', '-1'\]\)\.catch\(\(\) => null\)/);
  assert.match(server, /const readFailed = gatewayRows === null && openbotRows === null;/);
  assert.match(server, /if \(!readFailed\) stalePhones\.push\(item\.phone\);/);
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
