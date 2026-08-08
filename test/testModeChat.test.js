'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const testMode = require('../services/testModePolicy');
const incomingWebhook = require('../services/incomingWebhook');
const { __test: webhookTest } = incomingWebhook;
const { __test: whatsappTest } = require('../services/whatsappManager');
const tenantStore = require('../services/tenantStore');

async function confirmRejected(_client, call) {
  await call.reject();
  return true;
}

test('strict test mode allows only the tenant developer phone', async () => {
  const dependencies = {
    env: { TEST_MODE_ENABLED: 'true' },
    findRow: async () => ({ instance_id: 'prestige', dev_phone: '+7 776 915 61 84' })
  };

  const policy = await testMode.getTestModePolicy('prestige', dependencies);
  assert.deepEqual(policy, { enabled: true, devPhone: '77769156184' });
  assert.equal(testMode.allowsPhone(policy, '+7 776 915 61 84'), true);
  assert.equal(testMode.allowsPhone(policy, '+7 702 275 42 35'), false);
  assert.deepEqual(
    testMode.filterAllowedPhones(policy, [{ phone: '77769156184' }, { phone: '77022754235' }]),
    [{ phone: '77769156184' }]
  );
});

test('test mode stays fail-closed when the developer phone is missing', async () => {
  const policy = await testMode.getTestModePolicy('prestige', {
    env: { TEST_MODE_ENABLED: 'true' },
    findRow: async () => ({ instance_id: 'prestige', dev_phone: '' })
  });

  assert.deepEqual(policy, { enabled: true, devPhone: '' });
  assert.equal(testMode.allowsPhone(policy, '77769156184'), false);
});

test('incoming storage is skipped before a foreign test-mode phone can create a chat', async () => {
  let appends = 0;
  const result = await webhookTest.saveIncomingMessage({
    instanceId: 'prestige', phone: '77022754235', messageId: 'foreign-1', body: 'hello'
  }, {
    redisOpen: true,
    isPhoneAllowed: async () => false,
    store: { appendMessageOnce: async () => { appends += 1; return { inserted: true }; } },
    publishEvent: async () => {}
  });

  assert.deepEqual(result, { skipped: true, reason: 'test_mode_blocked', instanceId: 'prestige', phone: '77022754235' });
  assert.equal(appends, 0);
});

test('a foreign test-mode phone is never forwarded to OpenBot', async () => {
  const previousEnabled = process.env.TEST_MODE_ENABLED;
  const previousFindRow = tenantStore.findRow;
  let forwards = 0;
  process.env.TEST_MODE_ENABLED = 'true';
  tenantStore.findRow = async () => ({ instance_id: 'prestige', dev_phone: '77769156184' });
  try {
    const record = {
      id: 'volatile:test-mode-forward',
      payload: { instanceId: 'prestige', phone: '77022754235', body: 'hello' },
      pendingRedis: false,
      pendingOpenBot: true,
      attempts: 0
    };
    await incomingWebhook.processIncomingRecord(record, {
      forwardToOpenBot: async () => { forwards += 1; return { delivered: true }; }
    });
    assert.equal(record.pendingOpenBot, false);
    assert.equal(forwards, 0);
  } finally {
    tenantStore.findRow = previousFindRow;
    if (previousEnabled === undefined) delete process.env.TEST_MODE_ENABLED;
    else process.env.TEST_MODE_ENABLED = previousEnabled;
  }
});

test('call handling rejects everyone, replies only to the allowed phone via bot delivery', async () => {
  const calls = [];
  const call = { from: '77769156184@c.us', reject: async () => { calls.push('reject'); } };
  const client = { sendMessage: async () => { throw new Error('direct client.sendMessage must not be used'); } };
  const delivered = [];

  const allowed = await whatsappTest.handleIncomingCall('prestige', client, call, {
    tenantAdmin: { findRow: async () => ({ calls_disabled: true }) },
    rejectCall: confirmRejected,
    isPhoneAllowed: async () => true,
    deliverText: async (...args) => { delivered.push(args); return { success: true }; }
  });
  assert.deepEqual(allowed, { rejected: true, replied: true, phone: '77769156184' });
  assert.deepEqual(calls, ['reject']);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0][1], 'prestige');
  assert.equal(delivered[0][2], '77769156184');
  assert.match(delivered[0][3], /мәтінмен немесе аудиохабарламамен/i);

  const blockedCall = { from: '77022754235@c.us', reject: async () => { calls.push('reject-blocked'); } };
  const blocked = await whatsappTest.handleIncomingCall('prestige', client, blockedCall, {
    tenantAdmin: { findRow: async () => ({ calls_disabled: true }) },
    rejectCall: confirmRejected,
    isPhoneAllowed: async () => false,
    deliverText: async () => { throw new Error('blocked caller must not receive a message'); }
  });
  assert.deepEqual(blocked, { rejected: true, replied: false, phone: '77022754235', reason: 'test_mode_blocked' });
  assert.deepEqual(calls, ['reject', 'reject-blocked']);
});

test('call handling resolves WhatsApp privacy LIDs before applying the test-mode allowlist', async () => {
  whatsappTest.clearJidMap();
  const delivered = [];
  const client = {
    getContactLidAndPhone: async ids => {
      assert.deepEqual(ids, ['123456789012345@lid']);
      return [{ lid: '123456789012345@lid', pn: '77476884956@c.us' }];
    },
    getContactById: async () => null
  };
  const result = await whatsappTest.handleIncomingCall('prestige', client, {
    from: '123456789012345@lid',
    reject: async () => {}
  }, {
    tenantAdmin: { findRow: async () => ({ calls_disabled: true }) },
    rejectCall: confirmRejected,
    isPhoneAllowed: async (_instanceId, phone) => phone === '77476884956',
    deliverText: async (_client, _instanceId, phone, text) => {
      delivered.push({ phone, text });
      return { success: true };
    }
  });

  assert.deepEqual(result, { rejected: true, replied: true, phone: '77476884956' });
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].phone, '77476884956');
});

test('call handling verifies an unresolved LID against the tenant developer phone mapping', async () => {
  whatsappTest.clearJidMap();
  const rawLid = '123456789012345@lid';
  const lookups = [];
  const client = {
    getContactLidAndPhone: async ids => {
      lookups.push(ids);
      if (ids[0] === rawLid) return [{ lid: rawLid, pn: '' }];
      if (ids[0] === '77476884956@c.us') return [{ lid: rawLid, pn: '77476884956@c.us' }];
      return [];
    },
    getContactById: async () => null
  };
  const delivered = [];
  const result = await whatsappTest.handleIncomingCall('prestige', client, {
    from: rawLid,
    reject: async () => {}
  }, {
    tenantAdmin: { findRow: async () => ({ calls_disabled: true }) },
    rejectCall: confirmRejected,
    getTestModePolicy: async () => ({ enabled: true, devPhone: '77476884956' }),
    deliverText: async (_client, _instanceId, phone) => {
      delivered.push(phone);
      return { success: true };
    }
  });

  assert.deepEqual(result, { rejected: true, replied: true, phone: '77476884956' });
  assert.deepEqual(lookups, [[rawLid], ['77476884956@c.us']]);
  assert.deepEqual(delivered, ['77476884956']);
});

test('call handling resolves the structured Wid payload emitted by whatsapp-web.js', async () => {
  whatsappTest.clearJidMap();
  const rawLid = '123456789012345@lid';
  const lookups = [];
  const client = {
    getContactLidAndPhone: async ids => {
      lookups.push(ids);
      return [{ lid: rawLid, pn: '77476884956@c.us' }];
    },
    getContactById: async () => null
  };
  const delivered = [];
  const result = await whatsappTest.handleIncomingCall('prestige', client, {
    from: { user: '123456789012345', server: 'lid', _serialized: rawLid },
    participants: {
      [rawLid]: { jid: { user: '123456789012345', server: 'lid', _serialized: rawLid } }
    },
    reject: async () => {}
  }, {
    tenantAdmin: { findRow: async () => ({ calls_disabled: true }) },
    rejectCall: confirmRejected,
    getTestModePolicy: async () => ({ enabled: true, devPhone: '77476884956' }),
    deliverText: async (_client, _instanceId, phone) => {
      delivered.push(phone);
      return { success: true };
    }
  });

  assert.deepEqual(result, { rejected: true, replied: true, phone: '77476884956' });
  assert.deepEqual(lookups, [[rawLid]]);
  assert.deepEqual(delivered, ['77476884956']);
});

test('call handling discovers a caller JID nested inside the live call payload', async () => {
  whatsappTest.clearJidMap();
  const rawLid = '123456789012345@lid';
  const lookups = [];
  const delivered = [];
  const client = {
    getContactLidAndPhone: async ids => {
      lookups.push(ids);
      return [{ lid: rawLid, pn: '77476884956@c.us' }];
    },
    getContactById: async () => null
  };

  const result = await whatsappTest.handleIncomingCall('prestige', client, {
    from: { _serialized: { value: rawLid } },
    participants: { active: { contact: { wid: { _serialized: rawLid } } } },
    reject: async () => {}
  }, {
    tenantAdmin: { findRow: async () => ({ calls_disabled: true }) },
    rejectCall: confirmRejected,
    getTestModePolicy: async () => ({ enabled: true, devPhone: '77476884956' }),
    deliverText: async (_client, _instanceId, phone) => {
      delivered.push(phone);
      return { success: true };
    }
  });

  assert.deepEqual(result, { rejected: true, replied: true, phone: '77476884956' });
  assert.deepEqual(lookups, [[rawLid]]);
  assert.deepEqual(delivered, ['77476884956']);
});

test('call handling canonicalizes a multi-device LID before phone mapping', async () => {
  whatsappTest.clearJidMap();
  const canonicalLid = '123456789012345@lid';
  const deviceLid = '123456789012345:17@lid';
  const lookups = [];
  const client = {
    getContactLidAndPhone: async ids => {
      lookups.push(ids);
      return [{ lid: canonicalLid, pn: '77476884956@c.us' }];
    },
    getContactById: async () => null
  };

  const result = await whatsappTest.handleIncomingCall('prestige', client, {
    from: deviceLid,
    reject: async () => {}
  }, {
    tenantAdmin: { findRow: async () => ({ calls_disabled: true }) },
    rejectCall: confirmRejected,
    getTestModePolicy: async () => ({ enabled: true, devPhone: '77476884956' }),
    deliverText: async () => ({ success: true })
  });

  assert.deepEqual(result, { rejected: true, replied: true, phone: '77476884956' });
  assert.deepEqual(lookups, [[canonicalLid]]);
});

test('call reply is sent only after reliable rejection is confirmed', async () => {
  const delivered = [];
  const sequence = [];
  let releaseRejection;
  const rejectionGate = new Promise(resolve => { releaseRejection = resolve; });
  const handling = whatsappTest.handleIncomingCall('prestige', {}, {
    from: '77476884956@c.us',
    reject: async () => { throw new Error('legacy reject must not be used'); }
  }, {
    tenantAdmin: { findRow: async () => ({ calls_disabled: true }) },
    rejectCall: async () => {
      sequence.push('reject-start');
      await rejectionGate;
      sequence.push('reject-done');
      return true;
    },
    isPhoneAllowed: async () => true,
    deliverText: async (_client, _instanceId, phone) => {
      sequence.push('reply');
      delivered.push(phone);
      return { success: true };
    }
  });

  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(sequence, ['reject-start']);
  assert.deepEqual(delivered, []);
  releaseRejection();
  const result = await handling;

  assert.deepEqual(result, { rejected: true, replied: true, phone: '77476884956' });
  assert.deepEqual(sequence, ['reject-start', 'reject-done', 'reply']);
  assert.deepEqual(delivered, ['77476884956']);
});

test('call reply stays silent when reliable rejection cannot be confirmed', async () => {
  const delivered = [];
  const result = await whatsappTest.handleIncomingCall('prestige', {}, {
    from: '77476884956@c.us',
    reject: async () => {}
  }, {
    tenantAdmin: { findRow: async () => ({ calls_disabled: true }) },
    rejectCall: async () => false,
    isPhoneAllowed: async () => true,
    deliverText: async () => {
      delivered.push('unexpected');
      return { success: true };
    }
  });

  assert.deepEqual(result, { rejected: false, replied: false, phone: '', reason: 'reject_failed' });
  assert.deepEqual(delivered, []);
});

test('reliable rejection serializes a structured caller JID for the whatsapp-web.js bridge', async () => {
  const previousWindow = global.window;
  const rejected = [];
  global.window = {
    WWebJS: {
      rejectCall: async (peerJid, id) => { rejected.push([peerJid, id]); }
    }
  };

  try {
    const result = await whatsappTest.rejectIncomingCallReliably({
      pupPage: {
        evaluate: async (fn, ...args) => fn(...args),
        addScriptTag: async () => { throw new Error('WPP fallback must not load'); }
      }
    }, {
      id: 'call-native-123',
      from: { user: '123456789012345', server: 'lid', _serialized: '123456789012345@lid' },
      reject: async () => { throw new Error('structured legacy reject must not run'); }
    });

    assert.equal(result, true);
    assert.deepEqual(rejected, [['123456789012345@lid', 'call-native-123']]);
  } finally {
    if (previousWindow === undefined) delete global.window;
    else global.window = previousWindow;
  }
});

test('numeric call ids never override the caller LID phone mapping', async () => {
  whatsappTest.clearJidMap();
  const rawLid = '123456789012345@lid';
  const rejected = await whatsappTest.rejectIncomingCallReliably({
    pupPage: { evaluate: async () => true }
  }, {
    id: '73362499446',
    from: rawLid,
    reject: async () => {}
  });
  assert.equal(rejected, true);

  const resolved = await whatsappTest.resolveCallPhone({
    getContactLidAndPhone: async ids => {
      assert.deepEqual(ids, [rawLid]);
      return [{ lid: rawLid, pn: '77476884956@c.us' }];
    },
    getContactById: async () => null
  }, { id: '73362499446', from: rawLid }, '77476884956');

  assert.equal(resolved, '77476884956');
});

test('reliable rejection injects the current call API and confirms its result', async () => {
  const previousWindow = global.window;
  const rejectedIds = [];
  global.window = {};
  const page = {
    evaluate: async (fn, ...args) => fn(...args),
    addScriptTag: async ({ path }) => {
      assert.equal(path, require.resolve('@wppconnect/wa-js'));
      global.window.WPP = {
        isReady: true,
        call: {
          reject: async id => {
            rejectedIds.push(id);
            return true;
          }
        }
      };
    }
  };

  try {
    const rejected = await whatsappTest.rejectIncomingCallReliably({ pupPage: page }, { id: 'call-123' });
    assert.equal(rejected, true);
    assert.deepEqual(rejectedIds, ['call-123']);
  } finally {
    if (previousWindow === undefined) delete global.window;
    else global.window = previousWindow;
  }
});
