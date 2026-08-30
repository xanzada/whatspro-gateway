'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { __test } = require('../services/whatsappManager');

/**
 * Кебаб #1 went silent after the owner changed its WhatsApp number and scanned a fresh
 * QR (owner report, 2026-08-30). The first fix taught the guard that "no address book"
 * is not "stranger", and the tenant still stayed silent, because of TWO more defects in
 * how the gateway answers "is this guest saved?".
 *
 * 1. A modern WhatsApp account delivers inbound messages under an opaque `@lid` jid.
 *    msg.getContact() resolves from the MESSAGE's jid, while the address book is keyed by
 *    `<phone>@s.whatsapp.net`. So the lookup asked for an id the book can never hold and
 *    isMyContact came back false for every guest, saved or not.
 * 2. A lookup that timed out returned `{}`, and an absent addressBookKnown means "assume
 *    known" downstream. So a slow contact call was reported as "the book is loaded and
 *    this guest is not in it" - the precise pair of meanings the earlier fix separated.
 */

const LID_JID = '224043110273161@lid';
const PHONE = '77476884956';

function messageFrom(contact, { onGetContact } = {}) {
  return {
    from: LID_JID,
    _data: { notifyName: 'Аружан' },
    async getContact() {
      if (onGetContact) onGetContact();
      return contact;
    }
  };
}

// Shaped exactly like baileysClient._contactShape.
function contactShape({ jid, name = '', addressBookKnown }) {
  return {
    id: { _serialized: jid, user: String(jid).split('@')[0] },
    number: String(jid).split('@')[0],
    name,
    shortName: name,
    pushname: 'Аружан',
    isMyContact: Boolean(name),
    addressBookKnown,
    isWAContact: true
  };
}

test('a saved guest writing from a @lid is recognised through a phone lookup', async () => {
  // The book holds the phone jid, so the lid lookup finds nothing.
  const lidMiss = contactShape({ jid: LID_JID, name: '', addressBookKnown: true });
  const phoneHit = contactShape({ jid: `${PHONE}@s.whatsapp.net`, name: 'Досым', addressBookKnown: true });

  const info = await __test.getContactInfoFromMessage(
    messageFrom(lidMiss),
    { async getContactById(id) { assert.equal(id, `${PHONE}@c.us`); return phoneHit; } },
    PHONE
  );

  assert.equal(info.isMyContact, true, 'the saved contact is found under its real phone');
  assert.equal(info.name, 'Досым', 'the local address-book label wins over the push name');
  assert.equal(info.addressBookKnown, true);
});

test('a genuine stranger stays a stranger after both lookups', async () => {
  const miss = contactShape({ jid: LID_JID, name: '', addressBookKnown: true });
  const alsoMiss = contactShape({ jid: `${PHONE}@s.whatsapp.net`, name: '', addressBookKnown: true });

  const info = await __test.getContactInfoFromMessage(
    messageFrom(miss),
    { async getContactById() { return alsoMiss; } },
    PHONE
  );

  assert.equal(info.isMyContact, false);
  assert.equal(info.addressBookKnown, true, 'the book was readable, so the verdict is a fact');
});

test('a contact already confirmed by the message jid costs no second lookup', async () => {
  const hit = contactShape({ jid: `${PHONE}@s.whatsapp.net`, name: 'Досым', addressBookKnown: true });
  let phoneLookups = 0;

  const info = await __test.getContactInfoFromMessage(
    messageFrom(hit),
    { async getContactById() { phoneLookups += 1; return null; } },
    PHONE
  );

  assert.equal(info.isMyContact, true);
  assert.equal(phoneLookups, 0, 'a positive answer is a fact and is never re-checked');
});

test('an empty address book is reported as unknown, not as "stranger"', async () => {
  const fresh = contactShape({ jid: LID_JID, name: '', addressBookKnown: false });

  const info = await __test.getContactInfoFromMessage(
    messageFrom(fresh),
    { async getContactById() { return contactShape({ jid: `${PHONE}@s.whatsapp.net`, name: '', addressBookKnown: false }); } },
    PHONE
  );

  assert.equal(info.isMyContact, false);
  assert.equal(info.addressBookKnown, false, 'a fresh pairing must say "we cannot tell"');
});

test('a failed lookup admits it knows nothing about the address book', async () => {
  const info = await __test.getContactInfoFromMessage(
    { from: LID_JID, async getContact() { throw new Error('CONTACT_LOOKUP_TIMEOUT'); } },
    { async getContactById() { return null; } },
    PHONE
  );

  assert.equal(info.addressBookKnown, false, 'silence must never be read as a loaded book');
});

test('a transport with no getContact at all reports an unknown book', async () => {
  const info = await __test.getContactInfoFromMessage({ from: LID_JID }, null, PHONE);
  assert.equal(info.addressBookKnown, false);
});

test('the wwebjs transport, which always carries the real book, stays byte-identical', async () => {
  // whatsapp-web.js contacts have no addressBookKnown field at all.
  const wwebjs = {
    id: { _serialized: `${PHONE}@c.us`, user: PHONE },
    number: PHONE,
    name: '',
    shortName: '',
    pushname: 'Аружан',
    isMyContact: false,
    isWAContact: true
  };

  const info = await __test.getContactInfoFromMessage(
    messageFrom(wwebjs),
    { async getContactById() { return { ...wwebjs }; } },
    PHONE
  );

  assert.equal(info.addressBookKnown, true, 'an absent flag still means "assume known"');
  assert.equal(info.isMyContact, false, 'so a stranger is still blocked where the policy says so');
});

test('contactByPhone refuses to invent a lookup without digits', async () => {
  let called = 0;
  const client = { async getContactById() { called += 1; return {}; } };

  assert.equal(await __test.contactByPhone(client, ''), null);
  assert.equal(await __test.contactByPhone(client, LID_JID), null, 'a lid carries no phone digits to ask about');
  assert.equal(called, 0);
});
