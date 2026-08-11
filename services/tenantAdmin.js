'use strict';

const crypto = require('crypto');
const tenantStore = require('./tenantStore');

// Platform transport keys remain generated here. The Alemi credential is the
// exception: Alemi issues it, so onboarding accepts a prepared write-only value
// and never invents or returns one.

const ALEMI_DEFAULT_API_URL = 'https://hub.alemi.kz';
const OPERATOR_FIELDS = ['instanceId', 'brand', 'whatsappPhone', 'domain', 'address', 'workHours', 'adminPhone', 'promptMode', 'systemPrompt', 'active', 'botEnabled', 'callsDisabled', 'alemiApiUrl', 'alemiInstance', 'alemiSecret'];

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

function normalizeAlemiApiUrl(value) {
  const raw = clean(value, 500) || ALEMI_DEFAULT_API_URL;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return '';
  }
}

// A hand-typed key becomes an HMAC key and an inbound ?token= at once, so a
// one-character value is not a short key, it is no key. The floor is 8 rather
// than the generator's 12: a hub-issued key may legitimately be shorter than
// what we offer, and refusing it would lock an operator out of a working setup.
const ALEMI_SECRET_MIN_LENGTH = 8;

function normalizeAlemiSecret(value, required = false) {
  if (value === undefined || value === null || String(value).trim() === '') {
    if (!required) return '';
    throw badRequest(['alemiSecret']);
  }
  if (typeof value !== 'string') throw badRequest(['alemiSecret']);
  const secret = value.trim();
  if (secret.length < ALEMI_SECRET_MIN_LENGTH) throw badRequest(['alemiSecret']);
  if (secret.length > 4096 || /[\u0000-\u001f\u007f]/.test(secret)) throw badRequest(['alemiSecret']);
  return secret;
}

// Distinct by construction rather than by discipline: 24 random bytes, prefixed
// so a token found in a log is identifiable at a glance.
function generateSecret(prefix) {
  return `${prefix}_${crypto.randomBytes(24).toString('hex')}`;
}

// Operators retype this key by hand, so 0/1/I/O/l are left out: a key that cannot
// be misread is worth more than four extra symbols. The three specials are the
// only ones that survive a URL query, an HTTP header and JSON at once — the key
// also travels as ?token= on the inbound webhook.
const ALEMI_SECRET_CLASSES = ['23456789', 'ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnopqrstuvwxyz', '-_.'];
const ALEMI_SECRET_POOL = ALEMI_SECRET_CLASSES.join('');
const ALEMI_SECRET_DEFAULT_LENGTH = 12;

// crypto.randomInt is used for both the picks and the shuffle: taking a raw byte
// modulo an alphabet length biases the low characters, and Math.random is not a
// credential source at all.
function pickCharacter(alphabet) {
  return alphabet[crypto.randomInt(alphabet.length)];
}

function generateAlemiSecret(length = ALEMI_SECRET_DEFAULT_LENGTH) {
  const requested = Number.isFinite(Number(length)) ? Math.trunc(Number(length)) : ALEMI_SECRET_DEFAULT_LENGTH;
  // Never shorter than one character per class, or the guarantee below is a lie.
  const size = Math.min(Math.max(requested, ALEMI_SECRET_CLASSES.length), 256);
  const characters = ALEMI_SECRET_CLASSES.map(pickCharacter);
  while (characters.length < size) characters.push(pickCharacter(ALEMI_SECRET_POOL));
  for (let index = characters.length - 1; index > 0; index -= 1) {
    const swap = crypto.randomInt(index + 1);
    const held = characters[index];
    characters[index] = characters[swap];
    characters[swap] = held;
  }
  return characters.join('');
}

// Equal-length buffers only: timingSafeEqual throws on a mismatch, and a length
// difference already means "not equal" without comparing anything.
function alemiSecretsMatch(left, right) {
  const first = Buffer.from(String(left ?? ''), 'utf8');
  const second = Buffer.from(String(right ?? ''), 'utf8');
  if (!first.length || first.length !== second.length) return false;
  return crypto.timingSafeEqual(first, second);
}

function alemiSecretDuplicate() {
  const error = new Error('ALEMI_SECRET_DUPLICATE');
  error.statusCode = 409;
  error.fields = ['alemiSecret'];
  return error;
}

function storedAlemiSecret(row) {
  return String(row?.alemi_secret ?? row?.alemiSecret ?? '');
}

// Two restaurants sharing one Alemi key means either can act as the other at the
// hub, and the webhook cannot tell them apart. The value is never logged and the
// error never names the row that already holds it — that would turn a 409 into a
// way to read other tenants' keys one guess at a time.
async function assertAlemiSecretUnique(secret, ownInstanceId = '') {
  if (!secret) return;
  const owner = clean(ownInstanceId, 64);
  const rows = await listRows();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (owner && clean(row?.instance_id, 64) === owner) continue;
    if (alemiSecretsMatch(secret, storedAlemiSecret(row))) throw alemiSecretDuplicate();
  }
}

// The panel asks for a key rather than inventing one, so the value it offers is
// already known not to collide. Nothing is stored here: the key becomes real only
// when it is saved against a tenant, which checks uniqueness again.
async function suggestAlemiSecret(options = {}) {
  const attempts = Math.max(1, Math.trunc(Number(options.attempts) || 12));
  const length = Number(options.length) || ALEMI_SECRET_DEFAULT_LENGTH;
  const generate = typeof options.generate === 'function' ? options.generate : generateAlemiSecret;
  const rows = await listRows();
  const stored = (Array.isArray(rows) ? rows : []).map(storedAlemiSecret).filter(Boolean);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const secret = generate(length);
    if (!stored.some(existing => alemiSecretsMatch(secret, existing))) return secret;
  }
  const error = new Error('SECRET_GENERATE_FAILED');
  error.statusCode = 503;
  throw error;
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

// Where a restaurant's replies are sent is a property of this gateway, not of the
// restaurant, so it must never be answered from a row written months ago. Moving
// the platform to a new host once left every stored URL pointing at the old one —
// the tenants kept working in the panel while every outbound message 404'd. The
// stored columns remain the fallback for a deployment that sets no public URL.
function withCurrentTransport(row, publicBase) {
  const base = String(publicBase || process.env.WHATSPRO_PUBLIC_URL || '').replace(/\/+$/, '');
  if (!base) return { ...(row || {}) };
  return {
    ...(row || {}),
    whatspro_base_url: base,
    whatspro_send_url: `${base}/api/send`,
    whatspro_presence_url: `${base}/api/presence`
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
  const alemiApiUrl = normalizeAlemiApiUrl(input.alemiApiUrl);
  return {
    ...input,
    brand,
    instanceId,
    domain,
    alemiApiUrl,
    alemiInstance: clean(input.alemiInstance, 128) || instanceId,
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
    alemi_api_url: clean(input.alemiApiUrl, 500),
    alemi_instance: clean(input.alemiInstance, 128),
    prompt_mode: promptMode,
    active: input.active === undefined ? true : Boolean(input.active),
    bot_enabled: input.botEnabled === undefined ? true : Boolean(input.botEnabled),
    calls_disabled: input.callsDisabled === undefined ? true : Boolean(input.callsDisabled)
  };
}

function validationErrors(fields) {
  const errors = [];
  if (!isValidInstanceId(fields.instance_id)) errors.push('instanceId');
  if (!fields.brand) errors.push('brand');
  if (!fields.alemi_api_url) errors.push('alemiApiUrl');
  if (!/^[A-Za-z0-9_-]{2,128}$/.test(fields.alemi_instance)) errors.push('alemiInstance');
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
  const alemiSecret = normalizeAlemiSecret(input.alemiSecret, true);
  const errors = validationErrors(fields);
  if (errors.length) throw badRequest(errors);
  if (await findRow(fields.instance_id)) {
    const error = new Error('TENANT_ALREADY_EXISTS');
    error.statusCode = 409;
    throw error;
  }
  await assertAlemiSecretUnique(alemiSecret, fields.instance_id);

  const payload = {
    ...fields,
    ...platformFields(options.publicBase),
    alemi_secret: alemiSecret,
    system_prompt: resolvePrompt(fields, input, options.sharedPrompt)
  };
  await tenantStore.createRow(payload);
  return { instanceId: fields.instance_id, created: true };
}

// An update names the fields it changes and nothing else. Every operator field
// is carried over from the stored row when the caller omits it, so a caller that
// only wants to move one value — hub.alemi.kz linking a restaurant, a script
// aligning an instance id — cannot blank a brand or a phone number by omission.
// An explicit empty string still clears a field; only `undefined` means "keep".
function mergeExisting(instanceId, input = {}, existing = {}) {
  const keep = (value, stored) => (value === undefined ? stored : value);
  return {
    ...input,
    instanceId,
    brand: keep(input.brand, existing.brand),
    whatsappPhone: keep(input.whatsappPhone, existing.whatsapp_phone),
    adminPhone: keep(input.adminPhone, existing.admin_phone),
    domain: keep(input.domain, existing.domain),
    address: keep(input.address, existing.address),
    workHours: keep(input.workHours, existing.work_hours),
    promptMode: keep(input.promptMode, existing.prompt_mode),
    alemiApiUrl: keep(input.alemiApiUrl, existing.alemi_api_url),
    alemiInstance: keep(input.alemiInstance, existing.alemi_instance),
    active: keep(input.active, existing.active),
    botEnabled: keep(input.botEnabled, existing.bot_enabled),
    callsDisabled: keep(input.callsDisabled, existing.calls_disabled)
  };
}

async function updateTenant(instanceId, input, options = {}) {
  const existing = await findRow(instanceId);
  if (!existing) {
    const error = new Error('TENANT_NOT_FOUND');
    error.statusCode = 404;
    throw error;
  }
  const fields = operatorFields(mergeExisting(instanceId, input, existing));
  const errors = validationErrors(fields);
  if (errors.length) throw badRequest(errors);

  const payload = {
    ...fields,
    system_prompt: resolvePrompt(fields, input, options.sharedPrompt, existing)
  };
  const alemiSecret = normalizeAlemiSecret(input.alemiSecret);
  if (alemiSecret) {
    // The row's own stored key is not a collision with itself, so saving a form
    // that carries the same key back is still allowed.
    await assertAlemiSecretUnique(alemiSecret, instanceId);
    payload.alemi_secret = alemiSecret;
  }
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
    alemiApiUrl: row.alemi_api_url,
    alemiInstance: row.alemi_instance,
    // Import accepts a prepared key as write-only input, but exports never add
    // this column, so a backup cannot become a credential dump.
    alemiSecret: row.alemi_secret ?? row.alemiSecret,
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
    alemiApiUrl: input.alemiApiUrl,
    alemiInstance: input.alemiInstance,
    active: input.active === undefined ? false : input.active
  });
  const errors = validationErrors(fields);
  if (errors.length) throw badRequest(errors);
  if (await findRow(fields.instance_id)) {
    const error = new Error('TENANT_ALREADY_EXISTS');
    error.statusCode = 409;
    throw error;
  }

  const cloneSecret = normalizeAlemiSecret(input.alemiSecret, true);
  await assertAlemiSecretUnique(cloneSecret, fields.instance_id);

  const payload = {
    ...fields,
    ...platformFields(options.publicBase),
    alemi_secret: cloneSecret,
    system_prompt: fields.prompt_mode === 'custom'
      ? cleanMultiline(input.systemPrompt || source.system_prompt)
      : cleanMultiline(options.sharedPrompt || source.system_prompt)
  };
  await tenantStore.createRow(payload);
  return { instanceId: fields.instance_id, clonedFrom: sourceInstanceId, created: true };
}

// Alemi issues this key. WhatsPro only accepts a prepared replacement and never
// generates, echoes or logs it; the boolean response is enough for the panel.
async function setAlemiSecret(instanceId, value) {
  const existing = await findRow(instanceId);
  if (!existing) {
    const error = new Error('TENANT_NOT_FOUND');
    error.statusCode = 404;
    throw error;
  }
  const secret = normalizeAlemiSecret(value, true);
  await assertAlemiSecretUnique(secret, instanceId);
  await tenantStore.updateRow(instanceId, { alemi_secret: secret });
  return { instanceId, alemiSecretSet: true };
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
    alemiApiUrl: normalizeAlemiApiUrl(row.alemi_api_url),
    // Only the stored value: falling back to instance_id made a tenant that was
    // never linked to the hub look identical to a linked one in the panel.
    alemiInstance: clean(row.alemi_instance, 128),
    promptMode: clean(row.prompt_mode, 16).toLowerCase() === 'custom' ? 'custom' : 'shared',
    systemPrompt: cleanMultiline(row.system_prompt),
    active: row.active === undefined || row.active === null ? true : Boolean(row.active),
    botEnabled: row.bot_enabled === undefined || row.bot_enabled === null ? true : Boolean(row.bot_enabled),
    callsDisabled: row.calls_disabled === undefined || row.calls_disabled === null ? true : Boolean(row.calls_disabled),
    createdAt: clean(row.created_at || row.CreatedAt, 64),
    updatedAt: clean(row.updated_at || row.UpdatedAt, 64),
    secrets: {
      apiToken: Boolean(String(row.whatspro_api_token || '').trim()),
      webhookSecret: Boolean(String(row.webhook_secret || '').trim()),
      kanbanSecret: Boolean(String(row.kanban_secret || '').trim()),
      alemiSecret: Boolean(String(row.alemi_secret || '').trim())
    },
    // Hub integration only works when both halves are stored, so the panel is
    // told outright instead of inferring it from the instance name.
    alemiLinked: Boolean(clean(row.alemi_instance, 128)) && Boolean(String(row.alemi_secret || '').trim())
  };
}

// The runtime payload stays whole on purpose: OpenBot reads dozens of functional
// columns out of it and an allow-list here would silently break a restaurant the
// day somebody on the bot side starts reading one more field. So only credentials
// the bot provably never consumes are removed. Kept deliberately, each verified
// against Openbot-fastfood/src: whatspro_api_token (transport/whatspro.client.ts
// signs every send with it), webhook_secret (services/tenantAuth.service.ts
// authorizes the site webhook with it), crm_secret_token (services/
// kanbanSync.service.ts sends it to the CRM webhook) and alemi_secret (the HMAC
// key). kanban_secret is retired on the bot side — its one read is a diagnostic
// note that never changes the outcome — and crm_webhook_secret is read nowhere at
// all, so shipping either is disclosure without a purpose.
const RUNTIME_REDACTED_COLUMNS = [
  'kanban_secret',
  'kanbanSecret',
  'crm_webhook_secret',
  'crmWebhookSecret'
];

function runtimeTenant(row, publicBase) {
  const safe = withCurrentTransport(row, publicBase);
  for (const column of RUNTIME_REDACTED_COLUMNS) delete safe[column];
  return safe;
}

// OpenBot can discover tenants from the broad runtime list, but credentials are
// fetched only from the master-scoped per-instance endpoint. This keeps a list
// response or accidental list dump from containing every Alemi key at once.
function runtimeListTenant(row) {
  const safe = runtimeTenant(row);
  const present = Boolean(String(safe.alemi_secret || safe.alemiSecret || '').trim());
  delete safe.alemi_secret;
  delete safe.alemiSecret;
  safe.alemi_secret_set = present;
  return safe;
}

module.exports = {
  OPERATOR_FIELDS,
  applySharedPrompt,
  cloneTenant,
  createTenant,
  deleteTenant,
  findRow,
  generateAlemiSecret,
  importTenants,
  listRows,
  presentableTenant,
  runtimeListTenant,
  runtimeTenant,
  rotateSecrets,
  setAlemiSecret,
  setActive,
  setBotEnabled,
  setCallsDisabled,
  suggestAlemiSecret,
  updateTenant,
  slugify,
  withCurrentTransport,
  __test: { generateSecret, generateAlemiSecret, suggestAlemiSecret, alemiSecretsMatch, assertAlemiSecretUnique, ALEMI_SECRET_CLASSES, operatorFields, validationErrors, resolvePrompt, platformFields, applyDefaults, workbookInput, normalizeAlemiApiUrl, normalizeAlemiSecret, mergeExisting }
};
