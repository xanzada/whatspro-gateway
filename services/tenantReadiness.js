'use strict';

// Adding a restaurant means creating one platform tenant record. Validate it
// today, so a missed column shows up later as a bot that greets but cannot take
// an order, or — worse, at fifty tenants — as one restaurant's inbound messages
// landing in another's chat. This turns the row into a checklist that can be
// read before the first customer writes in.

const REQUIRED = 'required';
const RECOMMENDED = 'recommended';

function text(record, keys) {
  for (const key of keys) {
    const value = record?.[key];
    if (value !== undefined && value !== null && String(value).trim()) return String(value).trim();
  }
  return '';
}

function digits(value) {
  return String(value || '').replace(/\D/g, '');
}

function isAbsoluteHttpUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function isSecureAlemiUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}

// The public site column is written as alemi.kz, https://alemi.kz or with a path
// depending on who filled it in. Accept all three operator-friendly forms and
// only reject what is not a hostname at all; direct API transport is validated
// separately through alemi_api_url.
function isUsableDomain(value) {
  const raw = String(value || '').trim();
  if (!raw) return false;
  const host = (raw.includes('://') ? raw.split('://')[1] : raw).split('/')[0].split('?')[0];
  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i.test(host);
}

// Every field the running system actually reads, with the reason it is read.
// The `why` text is what an operator sees when the check is red, so it names the
// symptom rather than the code path.
const FIELDS = [
  {
    id: 'instance_id',
    level: REQUIRED,
    columns: ['instance_id', 'instance', 'restaurant_instance', 'restaurantInstance'],
    why: 'Барлық Redis кілттері, чат және сигналдар осы instance бойынша бөлінеді. Бос болса — ресторан жүйеде жоқ.',
    valid: value => /^[A-Za-z0-9_-]{2,64}$/.test(value)
  },
  {
    id: 'whatsapp_phone',
    level: REQUIRED,
    columns: ['whatsapp_phone', 'whatsappPhone', 'whatspro_phone', 'whatsproPhone', 'bot_phone', 'botPhone', 'receiver_phone', 'receiverPhone', 'instance_phone', 'instancePhone', 'phone'],
    why: 'Кіріс хабар осы нөмір арқылы ресторанға бағытталады. Бос болса — бот кімге жауап беретінін білмейді.',
    valid: value => digits(value).length >= 10 && digits(value).length <= 15
  },
  {
    id: 'domain',
    level: REQUIRED,
    columns: ['domain', 'site_url', 'siteUrl', 'website'],
    why: 'Ресторанның ашық беті мен клиент сілтемелері осы доменді қолданады. Тікелей API байланысы бөлек Alemi API өрістерімен тексеріледі.',
    valid: isUsableDomain
  },
  {
    id: 'alemi_api_url',
    level: REQUIRED,
    columns: ['alemi_api_url', 'alemiApiUrl'],
    why: 'Alemi мәзірі мен тапсырыс сигналдары осы HTTPS API арқылы оқылады. Бос немесе қате болса — бот сайтпен синхрондалмайды.',
    valid: isSecureAlemiUrl
  },
  {
    id: 'alemi_instance',
    level: REQUIRED,
    columns: ['alemi_instance', 'alemiInstance'],
    why: 'Alemi-дегі ресторан сәйкестендіргіші. Бос болса — сигнал қай ресторанға тиесілі екені анықталмайды.',
    valid: value => /^[A-Za-z0-9_-]{2,128}$/.test(value)
  },
  {
    id: 'alemi_secret',
    level: REQUIRED,
    columns: ['alemi_secret', 'alemiSecret'],
    why: 'Alemi берген API кілті. WhatsPro оны жасамайды; дайын кілт енгізілмесе — тікелей API байланысы іске қосылмайды.',
    valid: value => String(value).trim().length > 0
  },
  {
    id: 'whatspro_base_url',
    level: REQUIRED,
    columns: ['whatspro_base_url', 'whatsproBaseUrl', 'WHATSPRO_BASE_URL'],
    why: 'Бот жауабы осы мекенжай арқылы жіберіледі. Бос болса — агент жауап жазады, бірақ клиент оны көрмейді.',
    valid: isAbsoluteHttpUrl
  },
  {
    id: 'whatspro_api_token',
    level: REQUIRED,
    columns: ['whatspro_api_token', 'whatsproApiToken', 'api_token', 'apiToken'],
    why: 'Екі жаққа да керек: бот хабар жіберу үшін және осы ресторанның өз чатын ашу үшін. Токен тек осы instance-ты ашады.',
    valid: value => String(value).length >= 24
  },
  {
    id: 'system_prompt',
    level: REQUIRED,
    columns: ['system_prompt', 'systemPrompt', 'bot_prompt', 'botPrompt', 'ai_prompt', 'aiPrompt', 'restaurant_prompt', 'restaurantPrompt', 'prompt'],
    why: 'Агенттің мінезі, ережелері және осы ресторан туралы фактілер. Бос болса — бот жалпы жауап береді.',
    valid: value => String(value).length >= 200
  },
  {
    id: 'webhook_secret',
    level: REQUIRED,
    columns: ['webhook_secret', 'instance_secret', 'tenant_secret'],
    why: 'Сайттан келетін сигналдарды растайды. Бос болса — сайт сигналдары қабылданбайды.',
    valid: value => String(value).length >= 16
  },
  {
    id: 'kanban_secret',
    level: RECOMMENDED,
    columns: ['kanban_secret', 'crm_webhook_secret', 'crm_secret_token', 'crmSecretToken', 'secret_token', 'secret_key'],
    why: 'Kanban/CRM арнасының кілті. Бос болса — тапсырыс тақтасының оқиғалары өтпейді.',
    valid: value => String(value).length >= 16
  },
  {
    id: 'brand',
    level: RECOMMENDED,
    columns: ['brand', 'chat_title', 'brand_name', 'restaurant_name', 'name', 'title'],
    why: 'Оператор чатының тақырыбы және агент айтатын атау.',
    valid: value => String(value).length >= 2
  },
  {
    id: 'work_hours',
    level: RECOMMENDED,
    columns: ['work_hours', 'workHours'],
    why: 'Клиент "қашан ашықсыңдар" деп сұрағанда агент осыдан жауап береді.',
    valid: value => String(value).length >= 3
  },
  {
    id: 'address',
    level: RECOMMENDED,
    columns: ['address'],
    why: 'Өзін-өзі алып кету және мекенжай сұрақтары үшін.',
    valid: value => String(value).length >= 5
  },
  {
    id: 'dev_phone',
    level: RECOMMENDED,
    columns: ['dev_phone', 'developer_phone', 'developer', 'devPhone'],
    why: 'Техникалық ақау болғанда ескерту осы нөмірге кетеді.',
    valid: value => digits(value).length >= 10
  }
];

function fieldColumns(id) {
  return FIELDS.find(field => field.id === id).columns;
}

function checkFields(record) {
  return FIELDS.map(field => {
    const value = text(record, field.columns);
    if (!value) {
      return { id: field.id, level: field.level, ok: false, code: 'MISSING', column: field.columns[0], why: field.why };
    }
    if (!field.valid(value)) {
      return { id: field.id, level: field.level, ok: false, code: 'INVALID', column: field.columns[0], why: field.why };
    }
    return { id: field.id, level: field.level, ok: true, code: 'OK', column: field.columns[0], why: field.why };
  });
}

// Collisions only exist between rows, so they cannot be seen while validating one
// restaurant at a time — and they are the failures that actually cross tenants.
// A shared phone routes a customer into somebody else's chat; a shared token
// hands one restaurant the key to another's; and a shared Alemi instance makes
// signals ambiguous even when the WhatsPro instances themselves are unique.
function collisionsAcross(records) {
  const byInstance = new Map();
  const byPhone = new Map();
  const byToken = new Map();
  const byAlemiInstance = new Map();
  for (const record of Array.isArray(records) ? records : []) {
    const instance = text(record, fieldColumns('instance_id'));
    if (!instance) continue;
    const phone = digits(text(record, fieldColumns('whatsapp_phone')));
    const token = text(record, fieldColumns('whatspro_api_token'));
    const alemiInstance = text(record, fieldColumns('alemi_instance'));
    if (!byInstance.has(instance)) byInstance.set(instance, []);
    byInstance.get(instance).push(record);
    if (phone) {
      if (!byPhone.has(phone)) byPhone.set(phone, []);
      byPhone.get(phone).push(instance);
    }
    if (token) {
      if (!byToken.has(token)) byToken.set(token, []);
      byToken.get(token).push(instance);
    }
    if (alemiInstance) {
      if (!byAlemiInstance.has(alemiInstance)) byAlemiInstance.set(alemiInstance, []);
      byAlemiInstance.get(alemiInstance).push(instance);
    }
  }

  const collisions = [];
  for (const [instance, rows] of byInstance) {
    if (rows.length > 1) {
      collisions.push({
        kind: 'duplicate_instance_id',
        instances: [instance],
        detail: `instance_id "${instance}" кестеде ${rows.length} рет кездеседі. Қай жол оқылатыны кепілдендірілмейді.`
      });
    }
  }
  for (const [phone, instances] of byPhone) {
    const unique = [...new Set(instances)];
    if (unique.length > 1) {
      collisions.push({
        kind: 'shared_whatsapp_phone',
        instances: unique,
        detail: `${phone} нөмірі ${unique.join(', ')} рестораныдарында бірдей. Кіріс хабар қате ресторанға түседі.`
      });
    }
  }
  for (const [, instances] of byToken) {
    const unique = [...new Set(instances)];
    if (unique.length > 1) {
      collisions.push({
        kind: 'shared_api_token',
        instances: unique,
        detail: `${unique.join(', ')} бір API токенді бөлісіп тұр. Бірі екіншісінің чатын аша алады.`
      });
    }
  }
  for (const [alemiInstance, instances] of byAlemiInstance) {
    const unique = [...new Set(instances)];
    if (unique.length > 1) {
      collisions.push({
        kind: 'shared_alemi_instance',
        instances: unique,
        detail: `Alemi instance "${alemiInstance}" ${unique.join(', ')} рестораныдарында бірдей. Сайт сигналы қате ресторанға түсуі мүмкін.`
      });
    }
  }
  return collisions;
}

function summarize(checks, extras = []) {
  const all = [...checks, ...extras];
  const blocking = all.filter(check => !check.ok && check.level === REQUIRED);
  const warnings = all.filter(check => !check.ok && check.level === RECOMMENDED);
  return {
    ready: blocking.length === 0,
    blocking: blocking.map(check => check.id),
    warnings: warnings.map(check => check.id),
    passed: all.filter(check => check.ok).length,
    total: all.length
  };
}

// A row can be perfect and the restaurant still dead, because the WhatsApp
// session lives in the WhatsPro runtime rather than in tenant metadata. Fold that in as a check of
// the same shape so one list answers "can this restaurant take an order".
function sessionCheck(instanceId, sessions = []) {
  const known = sessions.find(entry => String(entry?.instanceId || entry?.id || entry) === instanceId);
  if (!known) {
    return {
      id: 'whatsapp_session',
      level: REQUIRED,
      ok: false,
      code: 'NOT_REGISTERED',
      column: '-',
      why: 'WhatsPro-да бұл instance үшін сессия жоқ. QR-кодты сканерлеу керек.'
    };
  }
  const status = String(known.status || known.state || '').toLowerCase();
  const connected = ['connected', 'ready', 'authenticated', 'open'].includes(status);
  return {
    id: 'whatsapp_session',
    level: REQUIRED,
    ok: connected,
    code: connected ? 'OK' : `STATUS_${status || 'UNKNOWN'}`.toUpperCase(),
    column: '-',
    why: 'WhatsApp сессиясы қосулы болмаса, бот хабар да алмайды, жібере де алмайды.'
  };
}

// Three ids must name the same restaurant: the hub's "ID инстанса", our
// alemi_instance and our own instance_id. Nothing compared ours to each other,
// and the bot resolves an inbound call by matching EITHER field — so a wrong
// alemi_instance routes nothing wrong locally and stays invisible until the hub
// answers 401. Recommended, never required: a divergence can be deliberate, and
// blocking a save on it would strand a row an operator is halfway through.
function alemiInstanceMatchCheck(record) {
  const instanceId = text(record, fieldColumns('instance_id'));
  const alemiInstance = text(record, fieldColumns('alemi_instance'));
  // An empty alemi_instance is already reported by its own required check;
  // repeating it here as a mismatch would only double the noise.
  const ok = !instanceId || !alemiInstance || alemiInstance === instanceId;
  return {
    id: 'alemi_instance_match',
    level: RECOMMENDED,
    ok,
    code: ok ? 'OK' : 'MISMATCH',
    column: fieldColumns('alemi_instance')[0],
    why: 'alemi_instance мәні hub.alemi.kz-тегі ресторанның "ID инстанса" өрісіне тең болуы керек және ол WhatsPro instance_id-мен сәйкес келмей тұр. Сәйкессіздік hub 401 қайтарғанша көрінбейді.'
  };
}

function isActive(record) {
  const value = record?.active;
  // A row written before the column existed has no value, and an existing
  // restaurant must not read as paused because of that.
  if (value === undefined || value === null || value === '') return true;
  if (typeof value === 'string') return !['0', 'false', 'no'].includes(value.trim().toLowerCase());
  return Boolean(value);
}

function isBotEnabled(record) {
  const value = record?.bot_enabled;
  if (value === undefined || value === null || value === '') return true;
  if (typeof value === 'string') return !['0', 'false', 'no'].includes(value.trim().toLowerCase());
  return Boolean(value);
}

function isCallsDisabled(record) {
  const value = record?.calls_disabled;
  // Defaults to disabled, matching handleIncomingCall. These two used to
  // disagree, so a row with no value showed the panel toggle as "calls on"
  // while the gateway was rejecting every call it received.
  if (value === undefined || value === null || value === '') return true;
  if (typeof value === 'string') return !['0', 'false', 'no'].includes(value.trim().toLowerCase());
  return Boolean(value);
}

function evaluateTenant(record, options = {}) {
  const instanceId = text(record, fieldColumns('instance_id'));
  const active = isActive(record);
  const checks = checkFields(record);
  const extras = [alemiInstanceMatchCheck(record)];
  // A paused restaurant has no session on purpose. Reporting that as a fault
  // would make every deliberately closed branch look broken.
  if (options.sessions && active) extras.push(sessionCheck(instanceId, options.sessions));
  return {
    instanceId,
    brand: text(record, fieldColumns('brand')) || instanceId,
    active,
    botEnabled: isBotEnabled(record),
    callsDisabled: isCallsDisabled(record),
    promptMode: text(record, ['prompt_mode']).toLowerCase() === 'custom' ? 'custom' : 'shared',
    checks: [...checks, ...extras],
    summary: summarize(checks, extras)
  };
}

function evaluateAll(records, options = {}) {
  const rows = (Array.isArray(records) ? records : []).filter(record => text(record, fieldColumns('instance_id')));
  const tenants = rows.map(record => evaluateTenant(record, options));
  const collisions = collisionsAcross(rows);
  const collided = new Set(collisions.flatMap(entry => entry.instances));
  return {
    total: tenants.length,
    ready: tenants.filter(tenant => tenant.summary.ready && !collided.has(tenant.instanceId)).length,
    collisions,
    tenants: tenants.map(tenant => ({
      ...tenant,
      summary: { ...tenant.summary, ready: tenant.summary.ready && !collided.has(tenant.instanceId) }
    }))
  };
}

module.exports = {
  FIELDS,
  evaluateTenant,
  evaluateAll,
  collisionsAcross,
  __test: { isUsableDomain, isAbsoluteHttpUrl }
};
