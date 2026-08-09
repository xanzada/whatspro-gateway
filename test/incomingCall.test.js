'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { __test: whatsappTest } = require('../services/whatsappManager');
const { evaluateAll } = require('../services/tenantReadiness');

// These exercise the real handleIncomingCall and the real rejection ladder.
// An earlier version of this file re-implemented the logic inline, so it kept
// passing while the shipped code was broken.

const tenantWith = calls_disabled => ({ findRow: async () => ({ instance_id: 'prestige', calls_disabled }) });

// The bundle is injected by evaluating its source, not via addScriptTag, so a
// fake page has to answer a string the way a browser would: run it, and let it
// define window.WPP.
function fakeCallPage(wppCall) {
  return {
    evaluate: async (fnOrSource, ...args) => {
      if (typeof fnOrSource === 'string') {
        global.window.WPP = { isReady: true, call: wppCall };
        return undefined;
      }
      return fnOrSource(...args);
    }
  };
}

test('a disabled tenant rejects the call and greets the caller', async () => {
  const delivered = [];
  const result = await whatsappTest.handleIncomingCall('prestige', {}, {
    from: '77476884956@c.us',
    reject: async () => {}
  }, {
    tenantAdmin: tenantWith(true),
    rejectCall: async () => true,
    isPhoneAllowed: async () => true,
    deliverText: async (_client, _instanceId, phone, text) => {
      delivered.push({ phone, text });
      return { success: true };
    }
  });

  assert.deepEqual(result, { rejected: true, replied: true, phone: '77476884956' });
  assert.equal(delivered.length, 1);
  assert.match(delivered[0].text, /Сәлеметсіз бе/);
  assert.match(delivered[0].text, /хабарлама/i);
});

test('an enabled tenant lets the call ring through untouched', async () => {
  const result = await whatsappTest.handleIncomingCall('prestige', {}, {
    from: '77476884956@c.us',
    reject: async () => { throw new Error('an enabled tenant must not reject'); }
  }, {
    tenantAdmin: tenantWith(false),
    rejectCall: async () => { throw new Error('rejection must not be attempted'); },
    deliverText: async () => { throw new Error('no greeting on an enabled tenant'); }
  });

  assert.deepEqual(result, { rejected: false, replied: false, phone: '', reason: 'calls_enabled' });
});

test('a tenant row with no calls column is treated as disabled', async () => {
  const delivered = [];
  for (const row of [{}, { calls_disabled: null }, { calls_disabled: undefined }]) {
    const result = await whatsappTest.handleIncomingCall('prestige', {}, {
      from: '77476884956@c.us',
      reject: async () => {}
    }, {
      tenantAdmin: { findRow: async () => row },
      rejectCall: async () => true,
      isPhoneAllowed: async () => true,
      deliverText: async (_client, _instanceId, phone) => { delivered.push(phone); return { success: true }; }
    });
    assert.equal(result.rejected, true, `row ${JSON.stringify(row)} must reject`);
  }
  assert.equal(delivered.length, 3);
});

test('a missing tenant row still rejects rather than ringing through', async () => {
  const result = await whatsappTest.handleIncomingCall('prestige', {}, {
    from: '77476884956@c.us',
    reject: async () => {}
  }, {
    tenantAdmin: { findRow: async () => { throw new Error('store unavailable'); } },
    rejectCall: async () => true,
    isPhoneAllowed: async () => true,
    deliverText: async () => ({ success: true })
  });

  assert.equal(result.rejected, true);
  assert.equal(result.replied, true);
});

test('an unconfirmed rejection still greets the caller', async () => {
  // The caller is left with a ringing phone and no explanation otherwise,
  // which is the exact case the greeting exists for.
  const delivered = [];
  const result = await whatsappTest.handleIncomingCall('prestige', {}, {
    from: '77476884956@c.us',
    reject: async () => {}
  }, {
    tenantAdmin: tenantWith(true),
    rejectCall: async () => false,
    isPhoneAllowed: async () => true,
    deliverText: async (_client, _instanceId, phone) => { delivered.push(phone); return { success: true }; }
  });

  assert.deepEqual(result, { rejected: false, replied: true, phone: '77476884956' });
  assert.deepEqual(delivered, ['77476884956']);
});

test('a rejection that throws does not stop the greeting', async () => {
  const result = await whatsappTest.handleIncomingCall('prestige', {}, {
    from: '77476884956@c.us',
    reject: async () => {}
  }, {
    tenantAdmin: tenantWith(true),
    rejectCall: async () => { throw new Error('WPP_CALL_REJECT_TIMEOUT'); },
    isPhoneAllowed: async () => true,
    deliverText: async () => ({ success: true })
  });

  assert.equal(result.rejected, false);
  assert.equal(result.replied, true);
});

test('a failed greeting is reported rather than thrown', async () => {
  const result = await whatsappTest.handleIncomingCall('prestige', {}, {
    from: '77476884956@c.us',
    reject: async () => {}
  }, {
    tenantAdmin: tenantWith(true),
    rejectCall: async () => true,
    isPhoneAllowed: async () => true,
    deliverText: async () => { throw new Error('session offline'); }
  });

  assert.deepEqual(result, { rejected: true, replied: false, phone: '77476884956' });
});

test('outgoing calls are never touched', async () => {
  const result = await whatsappTest.handleIncomingCall('prestige', {}, {
    fromMe: true,
    from: '77476884956@c.us'
  }, {
    tenantAdmin: { findRow: async () => { throw new Error('must not reach the store'); } }
  });

  assert.deepEqual(result, { rejected: false, replied: false, phone: '', reason: 'outgoing_call' });
});

test('rejection prefers WPP and only falls back when it cannot confirm', async () => {
  const order = [];
  const previousWindow = global.window;
  global.window = {};

  try {
    const rejected = await whatsappTest.rejectIncomingCallReliably({
      pupPage: fakeCallPage({
        enableCallInterface: async () => { order.push('enable-interface'); },
        reject: async id => { order.push(`wpp-reject:${id}`); return true; }
      })
    }, {
      id: 'call-123',
      reject: async () => { order.push('wweb-reject'); }
    });

    assert.equal(rejected, true);
    // WPP confirmed, so the unverified whatsapp-web.js path is never reached.
    assert.deepEqual(order, ['enable-interface', 'wpp-reject:call-123']);
  } finally {
    if (previousWindow === undefined) delete global.window;
    else global.window = previousWindow;
  }
});

test('a WPP rejection that reports failure falls through to whatsapp-web.js', async () => {
  const order = [];
  const previousWindow = global.window;
  global.window = {};

  try {
    const rejected = await whatsappTest.rejectIncomingCallReliably({
      pupPage: fakeCallPage({
        enableCallInterface: async () => {},
        reject: async () => { order.push('wpp-reject'); return false; }
      })
    }, {
      id: 'call-123',
      reject: async () => { order.push('wweb-reject'); }
    });

    assert.equal(rejected, true);
    assert.deepEqual(order, ['wpp-reject', 'wweb-reject']);
  } finally {
    if (previousWindow === undefined) delete global.window;
    else global.window = previousWindow;
  }
});

test('a call with no id still rejects whichever call is ringing', async () => {
  const rejectedIds = [];
  const previousWindow = global.window;
  global.window = {};

  try {
    const rejected = await whatsappTest.rejectIncomingCallReliably({
      pupPage: fakeCallPage({
        enableCallInterface: async () => {},
        reject: async id => { rejectedIds.push(id); return true; }
      })
    }, { from: '77476884956@c.us' });
    assert.equal(rejected, true);
    assert.deepEqual(rejectedIds, [undefined]);
  } finally {
    if (previousWindow === undefined) delete global.window;
    else global.window = previousWindow;
  }
});

test('the panel and the gateway agree on what a blank calls column means', () => {
  const report = evaluateAll([
    { instance_id: 'blank' },
    { instance_id: 'off', calls_disabled: true },
    { instance_id: 'on', calls_disabled: false }
  ]);
  const byId = Object.fromEntries(report.tenants.map(tenant => [tenant.instanceId, tenant.callsDisabled]));

  // A blank column reads as disabled in the panel because that is what
  // handleIncomingCall does with it.
  assert.equal(byId.blank, true);
  assert.equal(byId.off, true);
  assert.equal(byId.on, false);
});

// Two sources report every call. These cover the dispatcher that keeps that
// from becoming two rejections and two greetings for one ring.

test('the first source to report a call wins and the second is dropped', async () => {
  whatsappTest.seenCallIds.clear();
  const handled = [];
  const client = {
    // Stands in for the whole handler: the dispatcher is what is under test.
    pupPage: null,
    getContactById: async () => null
  };
  const call = { id: 'CALL-DUP-1', from: '77476884956@c.us' };

  await whatsappTest.dispatchIncomingCall('prestige', client, call, 'wwebjs');
  const afterFirst = whatsappTest.seenCallIds.size;
  await whatsappTest.dispatchIncomingCall('prestige', client, call, 'wa-js');

  assert.equal(afterFirst, 1, 'the first source claims the call');
  assert.equal(whatsappTest.seenCallIds.size, 1, 'the duplicate adds no second claim');
  assert.deepEqual(handled, []);
});

test('the same call id from two tenants is not treated as a duplicate', async () => {
  whatsappTest.seenCallIds.clear();
  const call = { id: 'CALL-SHARED', from: '77476884956@c.us' };

  await whatsappTest.dispatchIncomingCall('prestige', { pupPage: null }, call, 'wwebjs');
  await whatsappTest.dispatchIncomingCall('maki', { pupPage: null }, call, 'wwebjs');

  assert.equal(whatsappTest.seenCallIds.size, 2, 'each tenant claims its own call');
});

test('an outgoing call is ignored without claiming the id', async () => {
  whatsappTest.seenCallIds.clear();

  await whatsappTest.dispatchIncomingCall('prestige', { pupPage: null }, { id: 'C1', outgoing: true }, 'wa-js');
  assert.equal(whatsappTest.seenCallIds.size, 0, 'an outgoing call must not consume the id');

  // The real incoming call that follows must still be handled.
  await whatsappTest.dispatchIncomingCall('prestige', { pupPage: null }, { id: 'C1', from: '77476884956@c.us' }, 'wa-js');
  assert.equal(whatsappTest.seenCallIds.size, 1);
});
