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
  assert.deepEqual(core.messageParts({ id: 'm1', text: 'caption', type: 'ptt' }), [
    { kind: 'text', text: 'caption' },
    { kind: 'audio', id: 'm1' }
  ]);
  assert.equal(core.messageParts({ mediaData: 'base64', type: 'audio' }).length, 0);
});

test('receipt state maps WhatsApp read ACKs to read', () => {
  assert.equal(core.receiptState({ ack: 2 }), 'sent');
  assert.equal(core.receiptState({ ack: 3 }), 'read');
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
