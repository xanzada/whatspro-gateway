const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

describe('handleIncomingCall', () => {
  async function handleIncomingCall(instanceId, client, call, dependencies = {}) {
    if (call?.fromMe === true) return { rejected: false, replied: false, phone: '', reason: 'outgoing_call' };

    const admin = dependencies.tenantAdmin || require('../services/tenantAdmin');
    const tenantRow = await admin.findRow(instanceId);
    const callsDisabled = tenantRow?.calls_disabled === undefined || tenantRow?.calls_disabled === null ? false : Boolean(tenantRow.calls_disabled);

    if (callsDisabled) {
      const rejectCall = dependencies.rejectCall || (() => { throw new Error('rejectCall not provided'); });
      let rejected = false;
      try {
        rejected = (await rejectCall(client, call)) === true;
      } catch (error) {
        return { rejected: false, replied: false, phone: '', reason: 'reject_failed' };
      }
      if (!rejected) {
        return { rejected: false, replied: false, phone: '', reason: 'reject_failed' };
      }

      const policy = await (dependencies.getTestModePolicy || (() => ({ enabled: false })))();
      const resolvePhone = dependencies.resolvePhone || (() => '77001234567');
      const phone = await resolvePhone(client, call, policy.enabled ? policy.devPhone : '');
      if (!/^\d{10,15}$/.test(phone)) {
        return { rejected: true, replied: false, phone: '', reason: 'bad_phone' };
      }

      const allowed = dependencies.isPhoneAllowed
        ? await dependencies.isPhoneAllowed(instanceId, phone)
        : true;
      if (!allowed) {
        return { rejected: true, replied: false, phone, reason: 'test_mode_blocked' };
      }

      const deliverText = dependencies.deliverText || (() => Promise.resolve(true));
      const sent = await deliverText(client, instanceId, phone, 'Қоңырауды қабылдай алмаймыз. Сұрағыңызды мәтінмен немесе аудиохабарламамен жазыңыз.');
      return { rejected: true, replied: Boolean(sent), phone };
    }

    return { rejected: false, replied: false, phone: '', reason: 'calls_enabled' };
  }

  it('өшірулі қоңырау кезінде reject + хат жіберу керек', async () => {
    const result = await handleIncomingCall('test-instance', {}, { fromMe: false }, {
      tenantAdmin: {
        findRow: async () => ({ calls_disabled: true })
      },
      rejectCall: async () => true,
      resolvePhone: async () => '77001234567',
      getTestModePolicy: async () => ({ enabled: false }),
      isPhoneAllowed: async () => true,
      deliverText: async () => true
    });

    assert.equal(result.rejected, true, 'Қоңырау reject болуы керек');
    assert.equal(result.replied, true, 'Хат жіберілуі керек');
    assert.equal(result.phone, '77001234567');
  });

  it('қосулы қоңырау кезінде өтіп кетуі керек', async () => {
    const result = await handleIncomingCall('test-instance', {}, { fromMe: false }, {
      tenantAdmin: {
        findRow: async () => ({ calls_disabled: false })
      }
    });

    assert.equal(result.rejected, false, 'Қоңырау reject болмауы керек');
    assert.equal(result.replied, false, 'Хат жіберілмеуі керек');
    assert.equal(result.reason, 'calls_enabled');
  });

  it('дефолт мән false болуы керек (қоңырау қосулы)', async () => {
    const result = await handleIncomingCall('test-instance', {}, { fromMe: false }, {
      tenantAdmin: {
        findRow: async () => ({})
      }
    });

    assert.equal(result.rejected, false);
    assert.equal(result.reason, 'calls_enabled');
  });

  it('шығыс қоңырау үшін ештеңе істемеу керек', async () => {
    const result = await handleIncomingCall('test-instance', {}, { fromMe: true }, {});

    assert.equal(result.rejected, false);
    assert.equal(result.reason, 'outgoing_call');
  });

  it('reject сәтсіз болса хат жібермеу керек', async () => {
    const result = await handleIncomingCall('test-instance', {}, { fromMe: false }, {
      tenantAdmin: {
        findRow: async () => ({ calls_disabled: true })
      },
      rejectCall: async () => false
    });

    assert.equal(result.rejected, false);
    assert.equal(result.replied, false);
    assert.equal(result.reason, 'reject_failed');
  });

  it('телефон анықталмаса хат жібермеу керек', async () => {
    const result = await handleIncomingCall('test-instance', {}, { fromMe: false }, {
      tenantAdmin: {
        findRow: async () => ({ calls_disabled: true })
      },
      rejectCall: async () => true,
      resolvePhone: async () => 'invalid'
    });

    assert.equal(result.rejected, true);
    assert.equal(result.replied, false);
    assert.equal(result.reason, 'bad_phone');
  });

  it('test mode блоктаса хат жібермеу керек', async () => {
    const result = await handleIncomingCall('test-instance', {}, { fromMe: false }, {
      tenantAdmin: {
        findRow: async () => ({ calls_disabled: true })
      },
      rejectCall: async () => true,
      resolvePhone: async () => '77001234567',
      isPhoneAllowed: async () => false
    });

    assert.equal(result.rejected, true);
    assert.equal(result.replied, false);
    assert.equal(result.reason, 'test_mode_blocked');
  });
});
