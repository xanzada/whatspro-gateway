'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { __test: whatsappTest } = require('../services/whatsappManager');
const operatorLock = require('../services/operatorLock');

test('an outgoing WhatsApp message resolves the guest, never the linked account itself', async () => {
  assert.equal(typeof whatsappTest.getOutgoingPhoneFromMessage, 'function');
  const client = { info: { wid: { _serialized: '77769156184@s.whatsapp.net' } } };

  assert.equal(await whatsappTest.getOutgoingPhoneFromMessage(client, {
    fromMe: true,
    from: '77769156184@s.whatsapp.net',
    to: '77769156184@s.whatsapp.net',
    id: { remote: '77476884956@s.whatsapp.net', id: 'BOT-1' },
    _data: { from: '77769156184@s.whatsapp.net', to: '77476884956@s.whatsapp.net' }
  }), '77476884956');

  assert.equal(await whatsappTest.getOutgoingPhoneFromMessage(client, {
    fromMe: true,
    from: '77769156184@s.whatsapp.net',
    to: '77476884956@s.whatsapp.net',
    id: { remote: '77769156184@s.whatsapp.net', id: 'BOT-2' },
    _data: { from: '77769156184@s.whatsapp.net', to: '77476884956@s.whatsapp.net' }
  }), '77476884956', 'a self-addressed stanza must fall through to the real peer');
});

test('an outgoing LID is resolved before it can create an operator chat under the opaque id', async () => {
  const client = {
    info: { wid: { _serialized: '77769156184@s.whatsapp.net' } },
    getContactLidAndPhone: async lids => [{ lid: lids[0], pn: '77476884956@s.whatsapp.net' }]
  };
  assert.equal(await whatsappTest.getOutgoingPhoneFromMessage(client, {
    fromMe: true,
    id: { remote: '63037268607157@lid', id: 'HUMAN-1' },
    from: '77769156184@s.whatsapp.net',
    to: '63037268607157@lid'
  }), '77476884956');
});

test('operator handoff is a 40-second sliding lock', () => {
  assert.equal(operatorLock.OPERATOR_ACTIVE_SECONDS, 40);
  assert.equal(typeof operatorLock.__test?.operatorActiveCommand, 'function');
  assert.deepEqual(
    operatorLock.__test.operatorActiveCommand('prestige', '77476884956', 'operator_panel'),
    ['SET', 'operator_active:prestige:77476884956', 'operator_panel', 'EX', '40']
  );
});
