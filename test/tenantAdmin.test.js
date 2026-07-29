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
  withEnv({ WHATSPRO_TENANT_DOMAIN_SUFFIX: 'bekaba.com', WHATSPRO_DEFAULT_WORK_HOURS: '10:00 - 22:00' }, () => {
    const filled = admin.applyDefaults({ brand: 'Crazy суши', whatsappPhone: '+7 701 555 01 01' });
    assert.equal(filled.instanceId, 'crazy-sushi');
    assert.equal(filled.domain, 'https://crazy-sushi.bekaba.com');
    assert.equal(filled.workHours, '10:00 - 22:00');
    assert.equal(filled.adminPhone, '+77015550101', 'the owner is on the restaurant number until told otherwise');
  });
});

test('anything typed by hand wins over the derived value', () => {
  withEnv({ WHATSPRO_TENANT_DOMAIN_SUFFIX: 'bekaba.com' }, () => {
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
  assert.deepEqual(errors.sort(), ['brand', 'instanceId', 'whatsappPhone']);
  assert.deepEqual(admin.validationErrors(admin.operatorFields({
    brand: 'Prestige', whatsappPhone: '77015550101', instanceId: 'prestige', domain: 'prestige.kz'
  })), []);
  assert.deepEqual(admin.validationErrors(admin.operatorFields({
    brand: 'QR арқылы қосылатын ресторан', whatsappPhone: '', instanceId: 'qr-restaurant', domain: ''
  })), [], 'phone and domain are optional because WhatsApp is attached by QR and a custom host is not required');
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
  const first = admin.platformFields('https://whatspro.bekaba.com');
  const second = admin.platformFields('https://whatspro.bekaba.com');
  for (const key of ['whatspro_api_token', 'webhook_secret', 'kanban_secret', 'crm_secret_token']) {
    assert.notEqual(first[key], second[key], `${key} must differ between two restaurants`);
  }
  assert.equal(first.whatspro_send_url, 'https://whatspro.bekaba.com/api/send');
  assert.equal(first.whatspro_presence_url, 'https://whatspro.bekaba.com/api/presence');
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
        domain: 'https://source.bekaba.com',
        address: 'Abay 1',
        work_hours: '09:00 - 23:00',
        prompt_mode: 'custom',
        system_prompt: 'SOURCE PROMPT',
        whatspro_api_token: 'source-api-secret',
        webhook_secret: 'source-webhook-secret'
      }
    : null;
  tenantStore.createRow = async row => { stored = row; return row; };
  process.env.WHATSPRO_TENANT_DOMAIN_SUFFIX = 'bekaba.com';
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
    systemPrompt: 'SOURCE PROMPT'
  }, { publicBase: 'https://whatspro.bekaba.com', sharedPrompt: 'SHARED' });

  assert.equal(stored.instance_id, 'source-copy');
  assert.equal(stored.whatsapp_phone, '', 'a WhatsApp number/session is never shared by a clone');
  assert.equal(stored.domain, 'https://source-copy.bekaba.com');
  assert.equal(stored.address, 'Abay 1');
  assert.notEqual(stored.whatspro_api_token, 'source-api-secret');
  assert.notEqual(stored.webhook_secret, 'source-webhook-secret');
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
    domain: 'https://prestige.bekaba.com/',
    work_hours: '09:00 - 03:00',
    prompt_mode: 'custom',
    system_prompt: 'PROMPT',
    whatspro_api_token: 'wp_supersecret',
    webhook_secret: 'hook_supersecret',
    kanban_secret: ''
  });
  const serialized = JSON.stringify(view);
  assert.equal(serialized.includes('wp_supersecret'), false);
  assert.equal(serialized.includes('hook_supersecret'), false);
  assert.deepEqual(view.secrets, { apiToken: true, webhookSecret: true, kanbanSecret: false });
  assert.equal(view.active, true, 'a row from before the column existed is not silently paused');
  assert.equal(view.botEnabled, true, 'a row from before bot control existed remains enabled');
  assert.equal(view.promptMode, 'custom');
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
