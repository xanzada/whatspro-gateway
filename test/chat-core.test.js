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

test('message roles enforce client left and bot/operator outgoing semantics', () => {
  assert.equal(core.roleOf({ role: 'customer', direction: 'incoming' }), 'client');
  assert.equal(core.roleOf({ role: 'assistant' }), 'bot');
  assert.equal(core.roleOf({ source: 'operator_panel' }), 'operator');
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
});

test('HTML escaping and phone normalization are safe', () => {
  assert.equal(core.escapeHtml('<img>'), '&lt;img&gt;');
  assert.equal(core.normalizePhone('+7 (777) 123-45-67'), '77771234567');
});

test('timestamps accept both seconds and ISO values', () => {
  assert.match(core.formatTime(1_700_000_000, 'ru'), /^\d{2}:\d{2}$/);
  assert.match(core.formatTime('2024-01-01T12:34:00Z', 'ru'), /^\d{2}:\d{2}$/);
});
