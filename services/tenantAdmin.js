'use strict';

const axios = require('axios');
const crypto = require('crypto');
const { invalidateTenant } = require('./nocodbConfig');

// Sixteen columns exist on the restaurants table and only eight of them are a
// decision anybody makes. The rest are URLs that are the same for every tenant
// and secrets that should never be typed by hand — a person choosing their own
// token is how two restaurants end up sharing one. This module owns that split:
// the panel collects the eight, and everything else is generated here.

const OPERATOR_FIELDS = ['instanceId', 'brand', 'whatsappPhone', 'domain', 'address', 'workHours', 'adminPhone', 'promptMode', 'systemPrompt', 'active'];

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

function baseUrl() {
  return String(process.env.NOCODB_URL || '').replace(/\/+$/, '');
}

function tableId() {
  return clean(process.env.NOCODB_RESTAURANTS_TABLE_ID || process.env.NOCODB_TABLE_ID, 64);
}

function recordsUrl() {
  const base = baseUrl();
  const table = tableId();
  if (!base || !table || !process.env.NOCODB_TOKEN) {
    const error = new Error('NOCODB_NOT_CONFIGURED');
    error.statusCode = 503;
    throw error;
  }
  return `${base}/api/v2/tables/${table}/records`;
}

function headers() {
  return { 'xc-token': process.env.NOCODB_TOKEN || '' };
}

function timeout() {
  return Number(process.env.NOCODB_TIMEOUT_MS || 8000);
}

async function findRow(instanceId) {
  const response = await axios.get(recordsUrl(), {
    headers: headers(),
    params: { where: `(instance_id,eq,${instanceId})`, limit: 1 },
    timeout: timeout()
  });
  const list = Array.isArray(response.data?.list) ? response.data.list : [];
  return list[0] || null;
}

async function listRows() {
  const response = await axios.get(recordsUrl(), { headers: headers(), params: { limit: 1000 }, timeout: timeout() });
  return Array.isArray(response.data?.list) ? response.data.list : [];
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
    active: input.active === undefined ? true : Boolean(input.active)
  };
}

// A restaurant is now created before anybody has scanned a QR code, so the
// WhatsApp number is not always known at that moment. A caller can opt into a
// missing phone; a phone that is present is validated exactly as before, and
// every other rule is untouched.
function validationErrors(fields, options = {}) {
  const errors = [];
  if (!isValidInstanceId(fields.instance_id)) errors.push('instanceId');
  if (!fields.brand) errors.push('brand');
  const digits = fields.whatsapp_phone.replace(/\D/g, '');
  if (digits.length) {
    if (digits.length < 10 || digits.length > 15) errors.push('whatsappPhone');
  } else if (!options.allowMissingPhone) {
    errors.push('whatsappPhone');
  }
  if (!fields.domain) errors.push('domain');
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
  // The new dashboard has one prompt box and no mode selector, so a prompt the
  // operator actually typed is honoured when no shared text was supplied rather
  // than being dropped on the floor. Shared text still wins when it exists, so
  // applySharedPrompt keeps behaving exactly as it did.
  return cleanMultiline(sharedPrompt || input?.systemPrompt || existing?.system_prompt || '');
}

async function createTenant(input, options = {}) {
  const fields = operatorFields(input);
  const errors = validationErrors(fields, { allowMissingPhone: options.allowMissingPhone === true });
  if (errors.length) throw badRequest(errors);
  if (await findRow(fields.instance_id)) {
    const error = new Error('TENANT_ALREADY_EXISTS');
    error.statusCode = 409;
    throw error;
  }

  const payload = {
    ...fields,
    // A caller that has to be able to undo a half-finished create needs to know
    // the secrets before the row is written, so it may pass them in. Nothing
    // else does, and those callers get freshly generated ones as before.
    ...(options.platform || platformFields(options.publicBase)),
    system_prompt: resolvePrompt(fields, input, options.sharedPrompt)
  };
  await axios.post(recordsUrl(), payload, { headers: headers(), timeout: timeout() });
  invalidateTenant(fields.instance_id);
  return { instanceId: fields.instance_id, created: true };
}

async function updateTenant(instanceId, input, options = {}) {
  const existing = await findRow(instanceId);
  if (!existing) {
    const error = new Error('TENANT_NOT_FOUND');
    error.statusCode = 404;
    throw error;
  }
  const fields = operatorFields({ ...input, instanceId });
  const errors = validationErrors(fields);
  if (errors.length) throw badRequest(errors);

  const payload = {
    Id: existing.Id,
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

  await axios.patch(recordsUrl(), [payload], { headers: headers(), timeout: timeout() });
  invalidateTenant(instanceId);
  return { instanceId, updated: true };
}

async function setActive(instanceId, active) {
  const existing = await findRow(instanceId);
  if (!existing) {
    const error = new Error('TENANT_NOT_FOUND');
    error.statusCode = 404;
    throw error;
  }
  await axios.patch(recordsUrl(), [{ Id: existing.Id, active: Boolean(active) }], { headers: headers(), timeout: timeout() });
  invalidateTenant(instanceId);
  return { instanceId, active: Boolean(active) };
}

async function deleteTenant(instanceId) {
  const existing = await findRow(instanceId);
  if (!existing) {
    const error = new Error('TENANT_NOT_FOUND');
    error.statusCode = 404;
    throw error;
  }
  await axios.delete(recordsUrl(), { headers: headers(), data: [{ Id: existing.Id }], timeout: timeout() });
  invalidateTenant(instanceId);
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
    domain: input.domain || source.domain,
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
  await axios.post(recordsUrl(), payload, { headers: headers(), timeout: timeout() });
  invalidateTenant(fields.instance_id);
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
  await axios.patch(recordsUrl(), [{
    Id: existing.Id,
    whatspro_api_token: platform.whatspro_api_token,
    webhook_secret: platform.webhook_secret,
    kanban_secret: platform.kanban_secret,
    crm_secret_token: platform.crm_secret_token
  }], { headers: headers(), timeout: timeout() });
  invalidateTenant(instanceId);
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

  await axios.patch(recordsUrl(), targets.map(row => ({ Id: row.Id, system_prompt: text })), { headers: headers(), timeout: timeout() });
  for (const row of targets) invalidateTenant(row.instance_id);
  return { applied: targets.length, instances: targets.map(row => clean(row.instance_id, 64)) };
}

// The panel needs to show a restaurant's own settings without ever handing back a
// secret. Everything generated is reported as present/absent only.
function presentableTenant(row) {
  if (!row) return null;
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
  listRows,
  platformFields,
  presentableTenant,
  rotateSecrets,
  setActive,
  updateTenant,
  slugify,
  __test: { generateSecret, operatorFields, validationErrors, resolvePrompt, platformFields, applyDefaults }
};
