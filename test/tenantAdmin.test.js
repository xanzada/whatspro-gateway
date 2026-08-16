'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const tenantAdmin = require('../services/tenantAdmin');
const { slugify, __test: admin } = tenantAdmin;

function withEnv(values, run) {
  const previous = {};
  for (const [key, value] of Object.entries(values)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('a Kazakh name becomes a usable latin instance id', () => {
  assert.equal(slugify('Crazy суши'), 'crazy-sushi');
  assert.equal(slugify('Қуырдақ Ханы'), 'quyrdaq-hany');
  assert.equal(slugify('Дөнер №1'), 'doner-1');
  assert.equal(slugify('  Prestige  '), 'prestige');
  assert.equal(slugify('Ә'), 'a');
  assert.equal(slugify('!!!'), '', 'a name with nothing to transliterate yields nothing, not a stray dash');
});

test('an id derived from a name is always a legal instance id', () => {
  for (const name of ['Crazy суши', 'Дөнер №1', 'Тамақ - үй', 'ЖАҢА ЖЕЛІ', 'a'.repeat(120)]) {
    const slug = slugify(name);
    assert.match(slug, /^[a-z0-9][a-z0-9-]{0,63}$/, `${name} -> ${slug}`);
  }
});

test('the platform fills in what nobody should have to type', () => {
  withEnv({ WHATSPRO_TENANT_DOMAIN_SUFFIX: 'alemi.kz', WHATSPRO_DEFAULT_WORK_HOURS: '10:00 - 22:00' }, () => {
    const filled = admin.applyDefaults({ brand: 'Crazy суши', whatsappPhone: '+7 701 555 01 01' });
    assert.equal(filled.instanceId, 'crazy-sushi');
    assert.equal(filled.domain, 'https://crazy-sushi.alemi.kz');
    assert.equal(filled.alemiApiUrl, 'https://hub.alemi.kz');
    assert.equal(filled.alemiInstance, 'crazy-sushi');
    assert.equal(filled.workHours, '10:00 - 22:00');
    assert.equal(filled.adminPhone, '+77015550101', 'the owner is on the restaurant number until told otherwise');
  });
});

test('anything typed by hand wins over the derived value', () => {
  withEnv({ WHATSPRO_TENANT_DOMAIN_SUFFIX: 'alemi.kz' }, () => {
    const filled = admin.applyDefaults({
      brand: 'Crazy суши',
      instanceId: 'prestige',
      domain: 'https://prestige.kz',
      workHours: '24/7',
      adminPhone: '77769156184',
      whatsappPhone: '77015550101'
    });
    assert.equal(filled.instanceId, 'prestige');
    assert.equal(filled.domain, 'https://prestige.kz');
    assert.equal(filled.workHours, '24/7');
    assert.equal(filled.adminPhone, '+77769156184');
  });
});

test('with no domain suffix configured the domain is left for a person to fill', () => {
  withEnv({ WHATSPRO_TENANT_DOMAIN_SUFFIX: undefined }, () => {
    assert.equal(admin.applyDefaults({ brand: 'Crazy суши' }).domain, '', 'better empty than pointing at a host that does not exist');
  });
});

test('required fields are named back so the form can highlight them', () => {
  const fields = admin.operatorFields({ brand: '', whatsappPhone: '123' });
  assert.equal(fields.bot_enabled, true, 'new tenants answer through the bot by default');
  const errors = admin.validationErrors(fields);
  assert.deepEqual(errors.sort(), ['alemiInstance', 'brand', 'instanceId', 'whatsappPhone']);
  assert.deepEqual(admin.validationErrors(admin.operatorFields({
    brand: 'Prestige', whatsappPhone: '77015550101', instanceId: 'prestige', domain: 'prestige.kz'
  })), []);
  assert.deepEqual(admin.validationErrors(admin.operatorFields({
    brand: 'QR арқылы қосылатын ресторан', whatsappPhone: '', instanceId: 'qr-restaurant', domain: ''
  })), [], 'phone and domain are optional because WhatsApp is attached by QR and a custom host is not required');
});

test('an update that names one field leaves every other field alone', () => {
  const existing = {
    instance_id: 'prestige',
    brand: 'Crazy суши',
    whatsapp_phone: '+77769156184',
    admin_phone: '+77769156184',
    domain: 'https://prestige.alemi.kz',
    address: 'Абай 10',
    work_hours: '09:00 - 03:00',
    prompt_mode: 'custom',
    alemi_api_url: 'https://hub.alemi.kz',
    alemi_instance: 'storefront_test_fe6d775',
    active: true,
    bot_enabled: true,
    calls_disabled: true
  };

  // hub.alemi.kz links a restaurant by moving this one value and nothing else.
  const fields = admin.operatorFields(admin.mergeExisting('prestige', { alemiInstance: 'prestige' }, existing));
  assert.deepEqual(admin.validationErrors(fields), [], 'a one-field update must not fail validation on fields it never sent');
  assert.equal(fields.alemi_instance, 'prestige');
  assert.equal(fields.brand, 'Crazy суши');
  assert.equal(fields.whatsapp_phone, '+77769156184');
  assert.equal(fields.domain, 'https://prestige.alemi.kz');
  assert.equal(fields.address, 'Абай 10');
  assert.equal(fields.work_hours, '09:00 - 03:00');
  assert.equal(fields.prompt_mode, 'custom');
  assert.equal(fields.calls_disabled, true);
});

test('an explicitly empty value still clears the field', () => {
  const existing = { instance_id: 'prestige', brand: 'Crazy суши', address: 'Абай 10', whatsapp_phone: '', alemi_api_url: 'https://hub.alemi.kz', alemi_instance: 'prestige' };
  const fields = admin.operatorFields(admin.mergeExisting('prestige', { address: '' }, existing));
  assert.equal(fields.address, '', 'omitting a field means keep; sending an empty one means clear');
  assert.equal(fields.brand, 'Crazy суши');
});

test('create requires an externally issued Alemi key instead of inventing one', async () => {
  await assert.rejects(() => tenantAdmin.createTenant({
    instanceId: 'prestige', brand: 'Prestige', alemiApiUrl: 'https://hub.alemi.kz', alemiInstance: 'prestige'
  }), error => {
    assert.equal(error.statusCode, 400);
    assert.deepEqual(error.fields, ['alemiSecret']);
    return true;
  });
});

test('every generated secret is unique and long enough to be one', () => {
  const seen = new Set();
  for (let index = 0; index < 500; index += 1) {
    const secret = admin.generateSecret('wp');
    assert.match(secret, /^wp_[0-9a-f]{48}$/);
    assert.equal(seen.has(secret), false, 'two restaurants must never be handed the same token');
    seen.add(secret);
  }
});

test('a restaurant gets its own set of secrets, never a copy of anyone else\'s', () => {
  const first = admin.platformFields('https://whatspro.alemi.kz');
  const second = admin.platformFields('https://whatspro.alemi.kz');
  for (const key of ['whatspro_api_token', 'webhook_secret', 'kanban_secret', 'crm_secret_token']) {
    assert.notEqual(first[key], second[key], `${key} must differ between two restaurants`);
  }
  assert.equal(first.whatspro_send_url, 'https://whatspro.alemi.kz/api/send');
  assert.equal(first.whatspro_presence_url, 'https://whatspro.alemi.kz/api/presence');
});

test('cloning copies business settings but derives an isolated host, session and secrets', async t => {
  const tenantStore = require('../services/tenantStore');
  const originalFind = tenantStore.findRow;
  const originalCreate = tenantStore.createRow;
  const previousSuffix = process.env.WHATSPRO_TENANT_DOMAIN_SUFFIX;
  let stored;
  tenantStore.findRow = async instanceId => instanceId === 'source'
    ? {
        instance_id: 'source',
        brand: 'Source',
        whatsapp_phone: '+77015550101',
        domain: 'https://source.alemi.kz',
        address: 'Abay 1',
        work_hours: '09:00 - 23:00',
        prompt_mode: 'custom',
        system_prompt: 'SOURCE PROMPT',
        whatspro_api_token: 'source-api-secret',
        webhook_secret: 'source-webhook-secret',
        alemi_secret: 'source-alemi-secret'
      }
    : null;
  tenantStore.createRow = async row => { stored = row; return row; };
  process.env.WHATSPRO_TENANT_DOMAIN_SUFFIX = 'alemi.kz';
  t.after(() => {
    tenantStore.findRow = originalFind;
    tenantStore.createRow = originalCreate;
    if (previousSuffix === undefined) delete process.env.WHATSPRO_TENANT_DOMAIN_SUFFIX;
    else process.env.WHATSPRO_TENANT_DOMAIN_SUFFIX = previousSuffix;
  });

  await tenantAdmin.cloneTenant('source', {
    instanceId: 'source-copy',
    brand: 'Source copy',
    whatsappPhone: '',
    domain: '',
    systemPrompt: 'SOURCE PROMPT',
    alemiSecret: 'clone-alemi-secret'
  }, { publicBase: 'https://whatspro.alemi.kz', sharedPrompt: 'SHARED' });

  assert.equal(stored.instance_id, 'source-copy');
  assert.equal(stored.whatsapp_phone, '', 'a WhatsApp number/session is never shared by a clone');
  assert.equal(stored.domain, 'https://source-copy.alemi.kz');
  assert.equal(stored.address, 'Abay 1');
  assert.equal(stored.alemi_api_url, 'https://hub.alemi.kz');
  assert.equal(stored.alemi_instance, 'source-copy');
  assert.equal(stored.alemi_secret, 'clone-alemi-secret', 'a clone requires a newly supplied Alemi credential');
  assert.notEqual(stored.alemi_secret, 'source-alemi-secret');
  assert.notEqual(stored.whatspro_api_token, 'source-api-secret');
  assert.notEqual(stored.webhook_secret, 'source-webhook-secret');

  await assert.rejects(() => tenantAdmin.cloneTenant('source', {
    instanceId: 'source-copy-2', brand: 'Source copy 2'
  }, { publicBase: 'https://whatspro.alemi.kz', sharedPrompt: 'SHARED' }), error => {
    assert.equal(error.statusCode, 400);
    assert.deepEqual(error.fields, ['alemiSecret']);
    return true;
  });
});

test('shared mode takes the shared text and custom mode keeps its own', () => {
  const shared = 'ORTAQ PROMPT';
  const custom = 'MENIN PROMPTYM';
  assert.equal(admin.resolvePrompt({ prompt_mode: 'shared' }, {}, shared), shared);
  assert.equal(admin.resolvePrompt({ prompt_mode: 'custom' }, { systemPrompt: custom }, shared), custom);
  // Switching to custom without writing anything yet must not wipe the text
  // that is already there.
  assert.equal(admin.resolvePrompt({ prompt_mode: 'custom' }, {}, shared, { system_prompt: 'EXISTING' }), 'EXISTING');
});

test('a presentable tenant carries no secret, only whether one exists', () => {
  const view = tenantAdmin.presentableTenant({
    instance_id: 'prestige',
    brand: 'Crazy суши',
    whatsapp_phone: '+77769156184',
    domain: 'https://prestige.alemi.kz/',
    work_hours: '09:00 - 03:00',
    prompt_mode: 'custom',
    system_prompt: 'PROMPT',
    alemi_api_url: 'https://hub.alemi.kz',
    alemi_instance: 'prestige',
    alemi_secret: 'alemi_supersecret',
    whatspro_api_token: 'wp_supersecret',
    webhook_secret: 'hook_supersecret',
    kanban_secret: ''
  });
  const serialized = JSON.stringify(view);
  assert.equal(serialized.includes('wp_supersecret'), false);
  assert.equal(serialized.includes('hook_supersecret'), false);
  assert.equal(serialized.includes('alemi_supersecret'), false);
  assert.equal(view.alemiApiUrl, 'https://hub.alemi.kz');
  assert.equal(view.alemiInstance, 'prestige');
  assert.deepEqual(view.secrets, { apiToken: true, webhookSecret: true, kanbanSecret: false, alemiSecret: true });
  assert.equal(view.alemiLinked, true);
  assert.equal(view.active, true, 'a row from before the column existed is not silently paused');
  assert.equal(view.botEnabled, true, 'a row from before bot control existed remains enabled');
  assert.equal(view.promptMode, 'custom');
});

test('a tenant that was never linked to the hub is not dressed up as linked', () => {
  // maki in production: no alemi_instance, no alemi_secret. The old fallback
  // echoed instance_id back and the panel showed it as a hub instance.
  const view = tenantAdmin.presentableTenant({ instance_id: 'maki', brand: 'Maki' });
  assert.equal(view.alemiInstance, '');
  assert.equal(view.alemiLinked, false);
  assert.equal(view.secrets.alemiSecret, false);
  // One half alone is still not a link.
  assert.equal(tenantAdmin.presentableTenant({ instance_id: 'maki', alemi_instance: 'maki' }).alemiLinked, false);
  assert.equal(tenantAdmin.presentableTenant({ instance_id: 'maki', alemi_secret: 'only-a-key' }).alemiLinked, false);
});

test('Alemi secret can be set or rotated but is never echoed', async t => {
  const tenantStore = require('../services/tenantStore');
  const originalFind = tenantStore.findRow;
  const originalUpdate = tenantStore.updateRow;
  let patch;
  tenantStore.findRow = async instanceId => instanceId === 'prestige' ? { instance_id: instanceId } : null;
  tenantStore.updateRow = async (_instanceId, value) => { patch = value; return value; };
  t.after(() => {
    tenantStore.findRow = originalFind;
    tenantStore.updateRow = originalUpdate;
  });

  const result = await tenantAdmin.setAlemiSecret('prestige', 'externally-issued-secret');
  assert.deepEqual(result, { instanceId: 'prestige', alemiSecretSet: true });
  assert.deepEqual(patch, { alemi_secret: 'externally-issued-secret' });
  assert.equal(JSON.stringify(result).includes('externally-issued-secret'), false);
  await assert.rejects(() => tenantAdmin.setAlemiSecret('prestige', ''), error => {
    assert.equal(error.statusCode, 400);
    assert.deepEqual(error.fields, ['alemiSecret']);
    return true;
  });
});

test('the bot is told where this gateway lives now, not where it lived when the row was written', () => {
  // A row created before the platform moved hosts still carries the old URLs. The
  // panel keeps working while every outbound message 404s, so the answer the bot
  // reads is recomputed instead of remembered.
  const stale = {
    instance_id: 'prestige',
    whatspro_base_url: 'https://legacy-gateway.example.invalid',
    whatspro_send_url: 'https://legacy-gateway.example.invalid/api/send',
    whatspro_presence_url: 'https://legacy-gateway.example.invalid/api/presence',
    alemi_secret: 'alemi_supersecret'
  };

  withEnv({ WHATSPRO_PUBLIC_URL: 'https://whatspro.alemi.kz/' }, () => {
    const listed = tenantAdmin.runtimeListTenant(stale);
    assert.equal(listed.whatspro_base_url, 'https://whatspro.alemi.kz', 'a trailing slash must not survive into the URLs');
    assert.equal(listed.whatspro_send_url, 'https://whatspro.alemi.kz/api/send');
    assert.equal(listed.whatspro_presence_url, 'https://whatspro.alemi.kz/api/presence');
    assert.equal(listed.alemi_secret, undefined, 'the list still carries no Alemi key');
    assert.equal(listed.alemi_secret_set, true);
    assert.equal(tenantAdmin.withCurrentTransport(stale).whatspro_send_url, 'https://whatspro.alemi.kz/api/send');
  });

  withEnv({ WHATSPRO_PUBLIC_URL: undefined }, () => {
    assert.equal(
      tenantAdmin.withCurrentTransport(stale).whatspro_send_url,
      'https://legacy-gateway.example.invalid/api/send',
      'with no public URL configured the stored value is better than an empty one'
    );
  });
});

test('the broad runtime list exposes only Alemi key presence', () => {
  const listed = tenantAdmin.runtimeListTenant({
    instance_id: 'prestige', alemi_instance: 'prestige', alemi_secret: 'do-not-list-me'
  });
  assert.equal(listed.alemi_secret, undefined);
  assert.equal(listed.alemiSecret, undefined);
  assert.equal(listed.alemi_secret_set, true);
  assert.equal(JSON.stringify(listed).includes('do-not-list-me'), false);
});

test('bot pause is stored independently from WhatsApp active state', () => {
  const fields = admin.operatorFields({
    instanceId: 'prestige',
    brand: 'Prestige',
    active: true,
    botEnabled: false
  });
  assert.equal(fields.active, true);
  assert.equal(fields.bot_enabled, false);
  const view = tenantAdmin.presentableTenant({ ...fields, instance_id: 'prestige' });
  assert.equal(view.active, true);
  assert.equal(view.botEnabled, false);
});

test('Excel import preserves existing keys and generates isolated keys for new tenants', async t => {
  const tenantStore = require('../services/tenantStore');
  const originalFind = tenantStore.findRow;
  const originalCreate = tenantStore.createRow;
  const originalUpdate = tenantStore.updateRow;
  const records = new Map([
    ['existing', {
      instance_id: 'existing',
      brand: 'Old name',
      whatspro_api_token: 'wp_keep_me',
      webhook_secret: 'hook_keep_me',
      kanban_secret: 'kanban_keep_me',
      crm_secret_token: 'crm_keep_me'
    }]
  ]);
  tenantStore.findRow = async instanceId => records.get(instanceId) || null;
  tenantStore.createRow = async row => {
    records.set(row.instance_id, { ...row });
    return row;
  };
  tenantStore.updateRow = async (instanceId, patch) => {
    const stored = { ...records.get(instanceId), ...patch };
    records.set(instanceId, stored);
    return stored;
  };
  t.after(() => {
    tenantStore.findRow = originalFind;
    tenantStore.createRow = originalCreate;
    tenantStore.updateRow = originalUpdate;
  });

  const result = await tenantAdmin.importTenants([
    {
      instance_id: 'existing',
      brand: 'Updated name',
      whatsapp_phone: '+77010000001',
      active: true,
      bot_enabled: false
    },
    {
      instance_id: 'new-point',
      brand: 'New point',
      whatsapp_phone: '+77010000002',
      alemi_secret: 'new-point-alemi-secret',
      active: true,
      bot_enabled: true
    }
  ], { publicBase: 'https://whatspro.alemi.kz', sharedPrompt: 'Shared prompt' });

  assert.deepEqual(
    { imported: result.imported, created: result.created, updated: result.updated },
    { imported: 2, created: 1, updated: 1 }
  );
  assert.equal(records.get('existing').brand, 'Updated name');
  assert.equal(records.get('existing').whatspro_api_token, 'wp_keep_me');
  assert.equal(records.get('existing').webhook_secret, 'hook_keep_me');
  assert.match(records.get('new-point').whatspro_api_token, /^wp_[0-9a-f]{48}$/);
  assert.match(records.get('new-point').webhook_secret, /^hook_[0-9a-f]{48}$/);
  assert.notEqual(records.get('new-point').whatspro_api_token, records.get('existing').whatspro_api_token);
});

// Reopening "Edit" refills every field from the stored record. A key that is held
// but never handed back reads as a key that was lost, and the operator retypes a
// credential that was already correct.
test('reopening a restaurant hands back the Alemi key that is stored', async () => {
  const tenantStore = require('../services/tenantStore');
  const original = tenantStore.findRow;
  tenantStore.findRow = async instanceId => (instanceId === 'prestige'
    ? { instance_id: 'prestige', alemi_secret: '  Kz7-Prestige  ' }
    : { instance_id: instanceId });
  try {
    const revealed = await tenantAdmin.revealAlemiSecret('prestige');
    assert.equal(revealed.secret, 'Kz7-Prestige', 'the value is returned as stored, without the padding');
    assert.equal(revealed.alemiSecretSet, true);
    const empty = await tenantAdmin.revealAlemiSecret('qaclient');
    assert.equal(empty.secret, '');
    assert.equal(empty.alemiSecretSet, false, 'a restaurant with no key must not look like one that has it');
  } finally {
    tenantStore.findRow = original;
  }
});

test('asking for the key of a restaurant that does not exist is a 404, not an empty key', async () => {
  const tenantStore = require('../services/tenantStore');
  const original = tenantStore.findRow;
  tenantStore.findRow = async () => null;
  try {
    await assert.rejects(() => tenantAdmin.revealAlemiSecret('nobody'), error => {
      assert.equal(error.message, 'TENANT_NOT_FOUND');
      assert.equal(error.statusCode, 404);
      return true;
    });
  } finally {
    tenantStore.findRow = original;
  }
});

// The whole reason the key looked lost: a save that never mentions it must leave
// it exactly where it was.
test('saving a restaurant without touching the key leaves the stored key alone', async () => {
  const tenantStore = require('../services/tenantStore');
  const originalFind = tenantStore.findRow;
  const originalUpdate = tenantStore.updateRow;
  const stored = {
    instance_id: 'prestige',
    brand: 'Crazy суши',
    whatsapp_phone: '+77015550101',
    admin_phone: '+77015550101',
    address: 'Абая 1',
    alemi_secret: 'Kz7-Prestige',
    whatspro_api_token: 'wp_kept'
  };
  let written = null;
  tenantStore.findRow = async () => ({ ...stored });
  tenantStore.updateRow = async (instanceId, patch) => { written = patch; return patch; };
  try {
    await tenantAdmin.updateTenant('prestige', { address: 'Абая 2' });
    assert.ok(written, 'the save reached the store');
    assert.equal(written.address, 'Абая 2');
    assert.equal('alemi_secret' in written, false, 'a save that never mentions the key must not write the column at all');
  } finally {
    tenantStore.findRow = originalFind;
    tenantStore.updateRow = originalUpdate;
  }
});
