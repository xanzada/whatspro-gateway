const test = require('node:test');
const assert = require('node:assert/strict');
const chatStore = require('../services/chatStore');

test('chatStore exposes the lid map helpers at module top level', () => {
  // 2026-08-21: the helpers were returned by the factory but missing from the
  // explicit module.exports list, so whatsappManager crashed mid-resolution
  // with "rememberLidPhone is not a function" and ghost chats kept forming.
  assert.equal(typeof chatStore.resolveLidPhone, 'function');
  assert.equal(typeof chatStore.rememberLidPhone, 'function');
});

test('the chatStore singleton exposes the same helpers', () => {
  assert.equal(typeof chatStore.chatStore.resolveLidPhone, 'function');
  assert.equal(typeof chatStore.chatStore.rememberLidPhone, 'function');
});
