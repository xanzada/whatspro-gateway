'use strict';

const crypto = require('crypto');
const tenantStore = require('./tenantStore');

// Sixteen columns exist on the restaurants table and only eight of them are a
// decision anybody makes. The rest are URLs that are the same for every tenant
// and secrets that should never be typed by hand — a person choosing their own
// token is how two restaurants end up sharing one. This module owns that split:
// the panel collects the eight, and everything else is generated here.

const OPERATOR_FIELDS = ['instanceId', 'brand', 'whatsappPhone', 'domain', 'address', 'workHours', 'adminPhone', 'promptMode', 'systemPrompt', 'active', 'botEnabled', 'callsDisabled'];

function clean(value, max = 500) {
  return String(value ?? '').replace(/[\r\t]+/g, ' ').trim().slice(0, max);
}

function cleanMultiline(value, max = 20000) {
  return String(value ?? '').replace(/\r\n/g, '\n').trim().slice(0, max);
}

function normalizePhoneField(value) {
  const digits = String(value ?? '').replace(/\D/g, '');
  return digits ? `+${digits}` : '';
}

function isValidInstanceId(value) {
  return /^[a-zA-Z0-9_-]{2,64}$/.test(String(value || ''));
}

// Distinct by construction rather than by discipline: 24 random bytes, prefixed
// so a token found in a log is identifiable at a glance.
function generateSecret(prefix) {
  return `${prefix}_${crypto.randomBytes(24).toString('hex')}`;
}

async function findRow(instanceId) {
  return tenantStore.findRow(instanceId);
}

async function listRows() {
  return tenantStore.listTenantRecords();
}

// The panel never sends a secret and never sees one it did not just create, so
// this is the only place a token's value is decided.
function platformFields(publicBase) {
  const base = String(publicBase || process.env.WHATSPRO_PUBLIC_URL || '').replace(/\/+$/, '');
  return {
    whatspro_api_token: generateSecret('wp'),
    webhook_secret: generateSecret('hook'),
    kanban_secret: generateSecret('kanban'),
    crm_secret_token: generateSecret('crm'),
    whatspro_base_url: base,
    whatspro_send_url: base ? `${base}/api/send` : '',
    whatspro_presence_url: base ? `${base}/api/presence` : '',
    dev_phone: normalizePhoneField(process.env.WHATSPRO_DEVELOPER_PHONE || '')
  };
}

// Typing a name in Kazakh and an id in Latin is the same decision made twice, so
// the id is derived from the name unless somebody overrides it.
const TRANSLITERATION = {
  а: 'a', ә: 'a', б: 'b', в: 'v', г: 'g', ғ: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z',
  и: 'i', й: 'i', к: 'k', қ: 'q', л: 'l', м: 'm', н: 'n', ң: 'n', о: 'o', ө: 'o', п: 'p',
  р: 'r', с: 's', т: 't', у: 'u', ұ: 'u', ү: 'u', ф: 'f', х: 'h', һ: 'h', ц: 'c', ч: 'ch',
  ш: 'sh', щ: 'sch', ъ: '', ы: 'y', і: 'i', ь: '', э: 'e', ю: 'yu', я: 'ya'
};

function slugify(value) {
  return String(value ?? '')
    .toLowerCase()
    .split('')
    .map(character => (Object.prototype.hasOwnProperty.call(TRANSLITERATION, character) ? TRANSLITERATION[character] : character))
    .join('')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/, '');
}

function tenantDomainSuffix() {
  return clean(process.env.WHATSPRO_TENANT_DOMAIN_SUFFIX || '', 120).replace(/^\.+/, '');
}

// Filling these in server-side rather than only in the form means the same
// defaults apply whether a restaurant is added by a person on a phone or by a
// script, and neither can produce a half-configured row.
function applyDefaults(input = {}) {
  const brand = clean(input.brand, 120);
  const instanceId = clean(input.instanceId, 64) || slugify(brand);
  const suffix = tenantDomainSuffix();
  const domain = clean(input.domain, 200) || (instanceId && suffix ? `https://${instanceId}.${suffix}` : '');
  const whatsappPhone = normalizePhoneField(input.whatsappPhone);
  return {
    ...input,
    brand,
    instanceId,
    domain,
    workHours: clean(input.workHours, 120) || clean(process.env.WHATSPRO_DEFAULT_WORK_HOURS || '09:00 - 03:00', 120),
    // The owner is reachable on the restaurant's own number until somebody says
    // otherwise, which is true far more often than it is not.
    adminPhone: normalizePhoneField(input.adminPhone) || whatsappPhone
  };
}

function operatorFields(rawInput = {}) {
  const input = applyDefaults(rawInput);
  const promptMode = clean(input.promptMode, 16).toLowerCase() === 'custom' ? 'custom' : 'shared';
  return {
    instance_id: clean(input.instanceId, 64),
    brand: clean(input.brand, 120),
    whatsapp_phone: normalizePhoneField(input.whatsappPhone),
    admin_phone: normalizePhoneField(input.adminPhone),
    domain: clean(input.domain, 200),
    address: clean(input.address, 300),
    work_hours: clean(input.workHours, 120),
    prompt_mode: promptMode,
    active: input.active === undefined ? true : Boolean(input.active),
    bot_enabled: input.botEnabled === undefined ? true : Boolean(input.botEnabled),
    calls_disabled: input.callsDisabled === undefined ? false : Boolean(input.callsDisabled)
  };
}

function validationErrors(fields) {
  const errors = [];
  if (!isValidInstanceId(fields.instance_id)) errors.push('instanceId');
  if (!fields.brand) errors.push('brand');
  const digits = fields.whatsapp_phone.replace(/\D/g, '');
  if (digits && (digits.length < 10 || digits.length > 15)) errors.push('whatsappPhone');
  return errors;
}

function badRequest(errors) {
  const error = new Error('TENANT_FIELDS_INVALID');
  error.statusCode = 400;
  error.fields = errors;
  return error;
}

// A restaurant either writes its own prompt or runs the shared one. Openbot only
// ever reads system_prompt, so "shared" is resolved to a real value at save time
// rather than at read time — the agent pipeline stays untouched, and editing the
// shared text later rewrites the rows that opted into it.
function resolvePrompt(fields, input, sharedPrompt, existing = null) {
  if (fields.prompt_mode === 'custom') {
    const custom = cleanMultiline(input.systemPrompt);
    if (custom) return custom;
    return cleanMultiline(existing?.system_prompt || '');
  }
  return cleanMultiline(sharedPrompt || existing?.system_prompt || '');
}

async function createTenant(input, options = {}) {
  const fields = operatorFields(input);
  const errors = validationErrors(fields);
  if (errors.length) throw badRequest(errors);
  if (await findRow(fields.instance_id)) {
    const error = new Error('TENANT_ALREADY_EXISTS');
    error.statusCode = 409;
    throw error;
  }

  const payload = {
    ...fields,
    ...platformFields(options.publicBase),
    system_prompt: resolvePrompt(fields, input, options.sharedPrompt)
  };
  await tenantStore.createRow(payload);
  return { instanceId: fields.instance_id, created: true };
}

async function updateTenant(instanceId, input, options = {}) {
  const existing = await findRow(instanceId);
  if (!existing) {
    const error = new Error('TENANT_NOT_FOUND');
    error.statusCode = 404;
    throw error;
  }
  const fields = operatorFields({
    ...input,
    instanceId,
    active: input.active === undefined ? existing.active : input.active,
    botEnabled: input.botEnabled === undefined ? existing.bot_enabled : input.botEnabled,
    callsDisabled: input.callsDisabled === undefined ? existing.calls_disabled : input.callsDisabled
  });
  const errors = validationErrors(fields);
  if (errors.length) throw badRequest(errors);

  const payload = {
    ...fields,
    system_prompt: resolvePrompt(fields, input, options.sharedPrompt, existing)
  };
  // Rows created before the panel existed have blank platform fields. Fill those
  // in on the way past instead of leaving a restaurant half-configured because
  // it predates the tooling.
  const platform = platformFields(options.publicBase);
  for (const key of Object.keys(platform)) {
    if (!String(existing[key] ?? '').trim() && platform[key]) payload[key] = platform[key];
  }

  await tenantStore.updateRow(instanceId, payload);
  return { instanceId, updated: true };
}

function workbookInput(row = {}) {
  return {
    instanceId: row.instance_id,
    brand: row.brand,
    whatsappPhone: row.whatsapp_phone,
    adminPhone: row.admin_phone,
    domain: row.domain,
    address: row.address,
    workHours: row.work_hours,
    promptMode: row.prompt_mode,
    systemPrompt: row.system_prompt,
    active: row.active,
    botEnabled: row.bot_enabled,
    callsDisabled: row.calls_disabled
  };
}

// Excel is intentionally a business-data interchange format, not a secret
// backup. New rows pass through createTenant so every platform key is generated
// independently; existing rows pass through updateTenant so their keys remain
// untouched. Validate the complete file before the first write.
async function importTenants(rows, options = {}) {
  if (!Array.isArray(rows) || !rows.length) {
    const error = new Error('EMPTY_BACKUP');
    error.statusCode = 400;
    throw error;
  }

  const prepared = [];
  const seen = new Set();
  for (const row of rows) {
    const input = workbookInput(row);
    const fields = operatorFields(input);
    const errors = validationErrors(fields);
    if (errors.length) throw badRequest(errors);
    if (seen.has(fields.instance_id)) {
      const error = new Error(`DUPLICATE_INSTANCE_ID:${fields.instance_id}`);
      error.statusCode = 400;
      throw error;
    }
    seen.add(fields.instance_id);
    prepared.push({ input, fields, existing: await findRow(fields.instance_id) });
  }

  const createdInstances = [];
  const updatedInstances = [];
  for (const item of prepared) {
    if (item.existing) {
      await updateTenant(item.fields.instance_id, item.input, options);
      updatedInstances.push(item.fields.instance_id);
    } else {
      await createTenant(item.input, options);
      createdInstances.push(item.fields.instance_id);
    }
  }
  return {
    imported: prepared.length,
    created: createdInstances.length,
    updated: updatedInstances.length,
    createdInstances,
    updatedInstances
  };
}

async function setActive(instanceId, active) {
  const existing = await findRow(instanceId);
  if (!existing) {
    const error = new Error('TENANT_NOT_FOUND');
    error.statusCode = 404;
    throw error;
  }
  await tenantStore.updateRow(instanceId, { active: Boolean(active) });
  return { instanceId, active: Boolean(active) };
}

async function setBotEnabled(instanceId, enabled) {
  const existing = await findRow(instanceId);
  if (!existing) {
    const error = new Error('TENANT_NOT_FOUND');
    error.statusCode = 404;
    throw error;
  }
  await tenantStore.updateRow(instanceId, { bot_enabled: Boolean(enabled) });
  return { instanceId, botEnabled: Boolean(enabled) };
}

async function setCallsDisabled(instanceId, disabled) {
  const existing = await findRow(instanceId);
  if (!existing) {
    const error = new Error('TENANT_NOT_FOUND');
    error.statusCode = 404;
    throw error;
  }
  await tenantStore.updateRow(instanceId, { calls_disabled: Boolean(disabled) });
  return { instanceId, callsDisabled: Boolean(disabled) };
}

async function deleteTenant(instanceId) {
  const existing = await findRow(instanceId);
  if (!existing) {
    const error = new Error('TENANT_NOT_FOUND');
    error.statusCode = 404;
    throw error;
  }
  await tenantStore.deleteRow(instanceId);
  return { instanceId, deleted: true };
}

// Cloning copies the settings a second branch shares and nothing that must stay
// unique. New secrets, and the phone and instance are left for the operator —
// copying either is exactly the collision the readiness check exists to catch.
async function cloneTenant(sourceInstanceId, input, options = {}) {
  const source = await findRow(sourceInstanceId);
  if (!source) {
    const error = new Error('TENANT_NOT_FOUND');
    error.statusCode = 404;
    throw error;
  }
  const fields = operatorFields({
    instanceId: input.instanceId,
    brand: input.brand || `${source.brand} (көшірме)`,
    whatsappPhone: input.whatsappPhone,
    adminPhone: input.adminPhone || source.admin_phone,
    // A clone must never inherit the source host. Leaving it blank lets the
    // normal tenant defaults derive a fresh domain from the new instance id.
    domain: input.domain,
    address: input.address || source.address,
    workHours: input.workHours || source.work_hours,
    promptMode: input.promptMode || source.prompt_mode,
    active: input.active === undefined ? false : input.active
  });
  const errors = validationErrors(fields);
  if (errors.length) throw badRequest(errors);
  if (await findRow(fields.instance_id)) {
    const error = new Error('TENANT_ALREADY_EXISTS');
    error.statusCode = 409;
    throw error;
  }

  const payload = {
    ...fields,
    ...platformFields(options.publicBase),
    system_prompt: fields.prompt_mode === 'custom'
      ? cleanMultiline(input.systemPrompt || source.system_prompt)
      : cleanMultiline(options.sharedPrompt || source.system_prompt)
  };
  await tenantStore.createRow(payload);
  return { instanceId: fields.instance_id, clonedFrom: sourceInstanceId, created: true };
}

async function rotateSecrets(instanceId, options = {}) {
  const existing = await findRow(instanceId);
  if (!existing) {
    const error = new Error('TENANT_NOT_FOUND');
    error.statusCode = 404;
    throw error;
  }
  const platform = platformFields(options.publicBase);
  await tenantStore.updateRow(instanceId, {
    whatspro_api_token: platform.whatspro_api_token,
    webhook_secret: platform.webhook_secret,
    kanban_secret: platform.kanban_secret,
    crm_secret_token: platform.crm_secret_token
  });
  return { instanceId, rotated: true };
}

// Applying the shared prompt writes it into every row that asked for it. A row
// on prompt_mode=custom is never touched, so a restaurant that wrote its own
// text cannot lose it to somebody editing the default.
async function applySharedPrompt(sharedPrompt) {
  const text = cleanMultiline(sharedPrompt);
  const rows = await listRows();
  const targets = rows.filter(row => {
    const instance = clean(row.instance_id, 64);
    return instance && clean(row.prompt_mode, 16).toLowerCase() !== 'custom';
  });
  if (!targets.length) return { applied: 0, instances: [] };

  await Promise.all(targets.map(row => tenantStore.updateRow(row.instance_id, { system_prompt: text })));
  return { applied: targets.length, instances: targets.map(row => clean(row.instance_id, 64)) };
}

// The panel needs to show a restaurant's own settings without ever handing back a
// secret. Everything generated is reported as present/absent only.
function presentableTenant(row) {
  return {
    instanceId: clean(row.instance_id, 64),
    brand: clean(row.brand, 120),
    whatsappPhone: clean(row.whatsapp_phone, 32),
    adminPhone: clean(row.admin_phone, 32),
    domain: clean(row.domain, 200),
    address: clean(row.address, 300),
    workHours: clean(row.work_hours, 120),
    promptMode: clean(row.prompt_mode, 16).toLowerCase() === 'custom' ? 'custom' : 'shared',
    systemPrompt: cleanMultiline(row.system_prompt),
    active: row.active === undefined || row.active === null ? true : Boolean(row.active),
    botEnabled: row.bot_enabled === undefined || row.bot_enabled === null ? true : Boolean(row.bot_enabled),
    callsDisabled: row.calls_disabled === undefined || row.calls_disabled === null ? false : Boolean(row.calls_disabled),
    createdAt: clean(row.created_at || row.CreatedAt, 64),
    updatedAt: clean(row.updated_at || row.UpdatedAt, 64),
    secrets: {
      apiToken: Boolean(String(row.whatspro_api_token || '').trim()),
      webhookSecret: Boolean(String(row.webhook_secret || '').trim()),
      kanbanSecret: Boolean(String(row.kanban_secret || '').trim())
    }
  };
}

module.exports = {
  OPERATOR_FIELDS,
  applySharedPrompt,
  cloneTenant,
  createTenant,
  deleteTenant,
  findRow,
  importTenants,
  listRows,
  presentableTenant,
  rotateSecrets,
  setActive,
  setBotEnabled,
  setCallsDisabled,
  updateTenant,
  slugify,
  __test: { generateSecret, operatorFields, validationErrors, resolvePrompt, platformFields, applyDefaults, workbookInput }
};
