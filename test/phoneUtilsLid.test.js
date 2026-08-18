'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isValidChatPhone,
  normalizePhone,
  normalizePhoneFromCandidates,
  toWhatsAppChatId
} = require('../services/phoneUtils');

test('WhatsApp privacy LIDs remain valid tenant-scoped chat identifiers', () => {
  const lid = '63037268607157@lid';
  assert.equal(normalizePhone(lid), lid);
  assert.equal(normalizePhoneFromCandidates(['status@broadcast', lid]), lid);
  assert.equal(toWhatsAppChatId(lid), lid);
  assert.equal(isValidChatPhone(lid), true);
});

test('ordinary Kazakhstan phone normalization and unsafe JID rejection stay unchanged', () => {
  assert.equal(normalizePhone('8 (776) 915-61-84'), '77769156184');
  assert.equal(normalizePhone('+7 776 915 61 84'), '77769156184');
  assert.equal(normalizePhone('120363000000000@g.us'), '');
  assert.equal(normalizePhone('status@broadcast'), '');
  assert.equal(isValidChatPhone('77769156184'), true);
  assert.equal(isValidChatPhone('short@lid'), false);
});
