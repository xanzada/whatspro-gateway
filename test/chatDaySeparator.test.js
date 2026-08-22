'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const core = require('../public/chat-core.js');
const chatJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'chat.js'), 'utf8');
const chatHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'chat.html'), 'utf8');

// The panel showed only a clock on every bubble, so scrolling back through a
// week of a guest's history gave no way to tell Monday from Friday - an operator
// reading a complaint could not see whether it was today's order or last
// Tuesday's (operator request, 2026-08-22). WhatsApp's own rule is followed: a
// day separator above the first message of each day, the clock left on the
// bubble, and the full moment in a tooltip.

const NOW = new Date(2026, 7, 22, 14, 30); // 22 Aug 2026, a Saturday
const at = (...args) => new Date(...args).getTime();

test('today and yesterday are named, not dated', () => {
  assert.equal(core.formatDayLabel(at(2026, 7, 22, 9, 5), 'kk', NOW), 'Бүгін');
  assert.equal(core.formatDayLabel(at(2026, 7, 22, 9, 5), 'ru', NOW), 'Сегодня');
  assert.equal(core.formatDayLabel(at(2026, 7, 21, 20, 10), 'kk', NOW), 'Кеше');
  assert.equal(core.formatDayLabel(at(2026, 7, 21, 20, 10), 'ru', NOW), 'Вчера');
});

test('an older day in this year shows day and month, without the year', () => {
  const kk = core.formatDayLabel(at(2026, 7, 17, 11, 0), 'kk', NOW);
  const ru = core.formatDayLabel(at(2026, 7, 17, 11, 0), 'ru', NOW);
  assert.match(kk, /17/);
  assert.match(ru, /17/);
  assert.doesNotMatch(kk, /2026/, 'the current year is noise');
  assert.doesNotMatch(ru, /2026/, 'the current year is noise');
});

test('a day in another year carries the year', () => {
  const kk = core.formatDayLabel(at(2025, 11, 31, 23, 59), 'kk', NOW);
  const ru = core.formatDayLabel(at(2025, 11, 31, 23, 59), 'ru', NOW);
  assert.match(kk, /2025/);
  assert.match(ru, /2025/);
});

test('a separator opens each new calendar day and never repeats inside one', () => {
  // First message of a chat always opens a day.
  assert.equal(core.startsNewDay(at(2026, 7, 22, 9, 0), null), true);
  // Crossing midnight opens a new one.
  assert.equal(core.startsNewDay(at(2026, 7, 22, 0, 5), at(2026, 7, 21, 23, 55)), true);
  // Two messages on the same day do not.
  assert.equal(core.startsNewDay(at(2026, 7, 22, 9, 0), at(2026, 7, 22, 8, 0)), false);
  // A year boundary is a day boundary too.
  assert.equal(core.startsNewDay(at(2026, 0, 1, 0, 1), at(2025, 11, 31, 23, 59)), true);
  // Junk never invents a separator.
  assert.equal(core.startsNewDay('', at(2026, 7, 22, 8, 0)), false);
  assert.equal(core.startsNewDay(null, null), false);
});

test('the bubble clock is unchanged - the date is a separator, not bubble clutter', () => {
  // The pre-existing contract (test/chat-core.test.js) must still hold.
  assert.match(core.formatTime(1_700_000_000, 'ru'), /^\d{2}:\d{2}$/);
  assert.match(core.formatTime('2024-01-01T12:34:00Z', 'ru'), /^\d{2}:\d{2}$/);
  assert.match(core.formatTime(at(2026, 7, 22, 9, 5), 'kk'), /^09:05$/);
  assert.equal(core.formatTime('', 'kk'), '');
});

test('the tooltip carries the full moment, so a clock is never ambiguous', () => {
  const full = core.formatDateTime(at(2026, 7, 17, 11, 0), 'kk');
  assert.match(full, /17/);
  assert.match(full, /2026/);
  assert.match(full, /11:00/);
  assert.equal(core.formatDateTime('', 'kk'), '');
});

test('the contact list shows a clock for today and a day for anything older', () => {
  assert.equal(core.formatListStamp(at(2026, 7, 22, 9, 5), 'kk', NOW), '09:05');
  assert.equal(core.formatListStamp(at(2026, 7, 21, 20, 10), 'kk', NOW), 'Кеше');
  assert.match(core.formatListStamp(at(2026, 7, 17, 11, 0), 'kk', NOW), /17/);
  assert.equal(core.formatListStamp('', 'kk', NOW), '');
});

test('seconds, milliseconds and ISO stamps are all understood', () => {
  // WhatsApp sends seconds; the store writes milliseconds; some rows carry ISO.
  const seconds = Math.floor(at(2026, 7, 22, 9, 5) / 1000);
  assert.equal(core.formatTime(seconds, 'kk'), '09:05');
  assert.equal(core.formatDayLabel(seconds, 'kk', NOW), 'Бүгін');
  assert.equal(core.formatDayLabel(new Date(2026, 7, 22, 9, 5).toISOString(), 'kk', NOW), 'Бүгін');
});

test('the renderer actually emits the separator and the tooltip', () => {
  assert.match(chatJs, /core\.startsNewDay\(stamp, previousStamp\)/, 'the day boundary must be computed per message');
  assert.match(chatJs, /class="day-separator"/, 'and rendered');
  assert.match(chatJs, /core\.formatDayLabel\(stamp, state\.lang\)/);
  assert.match(chatJs, /<time title="' \+ core\.escapeHtml\(fullStamp\)/, 'the clock needs its full-date tooltip');
  assert.match(chatJs, /core\.formatListStamp\(chat\.lastAt \|\| chat\.updatedAt, state\.lang\)/, 'the contact list too');
  assert.ok(chatHtml.includes('.day-separator'), 'the separator needs its style or it renders as bare text');
});

test('the separator is escaped like every other rendered string', () => {
  // Defence in depth: the label is generated, but it goes through the same
  // escaping path as guest-supplied text.
  assert.match(chatJs, /core\.escapeHtml\(core\.formatDayLabel\(/);
  assert.match(chatJs, /core\.escapeHtml\(core\.formatListStamp\(/);
});
