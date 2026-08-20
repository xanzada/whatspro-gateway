'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../public/chat-core');

test('chat lifecycle states are exclusive and prefer archive', () => {
  assert.equal(core.chatState({ unread: true, hasOperator: true }), 'new');
  assert.equal(core.chatState({ viewed: true }), 'all');
  assert.equal(core.chatState({ hasOperator: true }), 'operator');
  assert.equal(core.chatState({ state: 'operator', archived: true }), 'archive');
});

test('a stale inbox refresh cannot move an opened chat back to New', () => {
  const serverRows = [
    { phone: '77769156184', state: 'new', unread: true },
    { phone: '77022754235', state: 'new', unread: true }
  ];

  assert.deepEqual(core.applyPendingViews(serverRows, ['+7 776 915 61 84']), [
    { phone: '77769156184', state: 'all', unread: false, viewed: true },
    { phone: '77022754235', state: 'new', unread: true }
  ]);
});

test('message roles enforce client left and bot/operator outgoing semantics', () => {
  assert.equal(core.roleOf({ role: 'customer', direction: 'incoming' }), 'client');
  assert.equal(core.roleOf({ role: 'assistant' }), 'bot');
  assert.equal(core.roleOf({ source: 'operator_panel' }), 'operator');
});

test('a PDF receipt renders as its own document part and never as audio or image', () => {
  const receipt = { id: 'm9', text: 'чек', type: 'document', hasMedia: true, mediaType: 'application/pdf' };
  assert.equal(core.isDocument(receipt), true);
  assert.equal(core.isAudio(receipt), false);
  assert.equal(core.isImage(receipt), false);
  assert.deepEqual(core.messageParts(receipt), [
    { kind: 'text', text: 'чек' },
    { kind: 'document', id: 'm9' }
  ]);
  assert.deepEqual(core.messageParts({
    id: 'm9-file', text: 'transfer-receipt-13_835558413111043668.pdf',
    type: 'document', hasMedia: true, mediaType: 'application/pdf'
  }), [{ kind: 'document', id: 'm9-file' }]);

  assert.equal(core.isDocument({ id: 'm10', hasMedia: true, mediaType: 'image/jpeg' }), false);
  assert.equal(core.isDocument({ id: 'm11', hasMedia: true, mediaType: 'audio/ogg' }), false);
  assert.equal(core.isDocument({ hasMedia: true, mediaType: 'application/pdf' }), false, 'an id is required to build a media URL');
});

test('text and audio are split into independent render parts', () => {
  assert.deepEqual(core.messageParts({ id: 'm1', text: 'caption', type: 'ptt', hasMedia: true, mediaType: 'audio/ogg; codecs=opus' }), [
    { kind: 'text', text: 'caption' },
    { kind: 'audio', id: 'm1' }
  ]);
  assert.deepEqual(core.messageParts({ id: 'link', text: 'https://example.com', type: 'audio', hasMedia: false, mediaType: 'audio/ogg' }), [
    { kind: 'text', text: 'https://example.com' }
  ]);
  assert.deepEqual(core.messageParts({ id: 'preview', hasMedia: true, type: 'ptt', mediaType: 'text/html' }), []);
  assert.equal(core.isAudio({ hasMedia: true, mediaType: 'audio/ogg' }), true);
  assert.equal(core.isAudio({ hasMedia: false, mediaType: 'audio/ogg' }), false);
  assert.equal(core.isAudio({ hasMedia: true, mediaType: 'video/mp4', audioMessage: true }), false);
  assert.equal(core.isAudio({ role: 'system', hasMedia: true, mediaType: 'audio/ogg' }), false);
  assert.equal(core.isAudio({ type: 'notification_template', hasMedia: true, mediaType: 'audio/ogg' }), false);
  assert.equal(core.isImage({ id: 'photo1', type: 'image', hasMedia: true, mediaType: 'image/jpeg' }), true);
  assert.deepEqual(core.messageParts({ id: 'photo1', type: 'image', hasMedia: true, mediaType: 'image/jpeg' }), [{ kind: 'image', id: 'photo1' }]);
});

test('receipt state maps WhatsApp ACK progression monotonically', () => {
  assert.equal(core.receiptState({ ack: 1 }), 'sent');
  assert.equal(core.receiptState({ ack: 2 }), 'delivered');
  assert.equal(core.receiptState({ ack: 3 }), 'read');
  assert.equal(core.receiptState({ status: 'delivered' }), 'delivered');
  assert.equal(core.receiptState({ status: 'played' }), 'read');
  // A rejected message is not a quieter kind of "sent".
  assert.equal(core.receiptState({ status: 'failed' }), 'failed');
  assert.equal(core.receiptState({ ack: -1 }), 'failed');
});

test('HTML escaping and phone normalization are safe', () => {
  assert.equal(core.escapeHtml('<img>'), '&lt;img&gt;');
  assert.equal(core.normalizePhone('+7 (777) 123-45-67'), '77771234567');
});

test('timestamps accept both seconds and ISO values', () => {
  assert.match(core.formatTime(1_700_000_000, 'ru'), /^\d{2}:\d{2}$/);
  assert.match(core.formatTime('2024-01-01T12:34:00Z', 'ru'), /^\d{2}:\d{2}$/);
});


test('new and all merge into one column; sos still wins', () => {
  // The operator panel used to bounce a card from "Оператор" back to "Жаңа" on
  // every client reply. Columns are merged now: fresh chats live in "Бәрі",
  // while chatState is untouched so the unread badge keeps working inside it.
  assert.equal(core.chatColumn({ state: 'new', unread: true }), 'all');
  assert.equal(core.chatColumn({ state: 'all' }), 'all');
  assert.equal(core.chatColumn({ state: 'operator' }), 'operator');
  assert.equal(core.chatColumn({ state: 'new', sos: true, sosExpiresAt: Date.now() + 60000 }), 'sos');
  assert.equal(core.chatState({ state: 'new', unread: true }), 'new', 'chatState unchanged: unread badge source');
});

test('a resolved SOS chat leaves the sos column and stays with the operator', () => {
  const core = require('../public/chat-core.js');
  const future = Date.now() + 60 * 1000;
  // While the marker is active the chat is pinned to the SOS column.
  assert.equal(core.chatColumn({ sos: true, sosExpiresAt: future, state: 'operator' }), 'sos');
  // Operator replied -> marker cleared server-side -> the chat lives in the
  // operator column only (never duplicated into the merged all column).
  assert.equal(core.chatColumn({ sos: false, sosExpiresAt: 0, state: 'operator' }), 'operator');
  // Natural marker expiry falls back to the stored state the same way.
  assert.equal(core.chatColumn({ sos: true, sosExpiresAt: Date.now() - 1000, state: 'operator' }), 'operator');
  // ...and an operator chat with a client reply still stays put (sticky state).
  assert.equal(core.chatColumn({ sos: false, state: 'operator', unread: true }), 'operator');
});

test('sos window semantics: expiry lands untouched chats in the merged column, handled ones in operator', () => {
  const core = require('../public/chat-core.js');
  const past = Date.now() - 1000;
  const future = Date.now() + 60000;
  // During the window the chat is pinned to SOS, whatever the stored state is.
  assert.equal(core.chatColumn({ sos: true, sosExpiresAt: future, state: 'new', unread: true }), 'sos');
  assert.equal(core.chatColumn({ sos: true, sosExpiresAt: future, state: 'all' }), 'sos');
  // Window expired, operator never wrote -> falls to the merged Бәрі column.
  assert.equal(core.chatColumn({ sos: true, sosExpiresAt: past, state: 'new', unread: true }), 'all');
  assert.equal(core.chatColumn({ sos: true, sosExpiresAt: past, state: 'all' }), 'all');
  // Window expired, operator had replied -> Оператор column.
  assert.equal(core.chatColumn({ sos: true, sosExpiresAt: past, state: 'operator' }), 'operator');
  // Closed while sos was active (marker cleared by the close action) -> Архив.
  assert.equal(core.chatColumn({ sos: false, sosExpiresAt: 0, state: 'archive' }), 'archive');
  // Archived chat must never bounce back to Бәрі on a client reply (sticky).
  assert.equal(core.chatColumn({ sos: false, state: 'archive', unread: true }), 'archive');
});
