'use strict';

const tenantStore = require('./tenantStore');
const { normalizePhone, normalizePhoneFromCandidates } = require('./phoneUtils');

function enabledFrom(env = process.env) {
  const value = env.WHATSPRO_TEST_MODE_ENABLED ?? env.TEST_MODE_ENABLED ?? 'false';
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

/**
 * One field, several numbers.
 *
 * Test mode used to answer exactly one phone, so the moment a QA number was
 * put in `dev_phone` the owner's own number stopped getting replies -- and
 * whoever noticed usually fixed it by turning test mode off entirely, which
 * opens the bot to every stranger who writes to it. A `dev_phone` may now hold
 * several numbers and every one of them is honoured.
 *
 * The list is not split on a separator: this field is typed by hand, and
 * "+7 776 915 61 84" contains the very spaces a split would tear it apart on.
 * Phone-shaped runs are matched out of the whole string instead, so commas,
 * semicolons, newlines and plain spaces all work, and a junk entry between two
 * good ones costs nothing.
 */
const PHONE_RUN_RE = /\d+@lid|(?:\+?7|8)[\s().-]*\d{3}[\s().-]*\d{3}[\s().-]*\d{2}[\s().-]*\d{2}|\d{10,15}/gi;

function splitPhoneList(value) {
  const matches = String(value ?? '').match(PHONE_RUN_RE) || [];
  return matches.map(part => normalizePhone(part)).filter(Boolean);
}

function rowDeveloperPhones(row, env = process.env) {
  const sources = [
    row?.dev_phone,
    row?.developer_phone,
    row?.developer,
    row?.devPhone,
    // Extra QA numbers live in their own field on purpose. OpenBot's
    // `platformConfig` normalises `dev_phone` down to a single number for its
    // developer alerts, so a list stuffed in there would come out empty on that
    // side; `test_phones` is the field OpenBot's own inbound guard already reads.
    row?.test_phones,
    row?.testPhones,
    env.WHATSPRO_TEST_MODE_ALLOWED_PHONE,
    env.TEST_MODE_ALLOWED_PHONE,
    env.TEST_MODE_ALLOWED_PHONES,
    env.WHATSPRO_DEVELOPER_PHONE,
    env.OPENBOT_DEVELOPER_PHONE
  ];

  const phones = [];
  for (const source of sources) {
    for (const phone of splitPhoneList(source)) {
      if (!phones.includes(phone)) phones.push(phone);
    }
  }

  return phones;
}

// Kept for callers that only need one number to show in a UI or a log line.
function rowDeveloperPhone(row, env = process.env) {
  return rowDeveloperPhones(row, env)[0] || '';
}

async function getTestModePolicy(instanceId, dependencies = {}) {
  const env = dependencies.env || process.env;
  const enabled = enabledFrom(env);
  if (!enabled) return { enabled: false, devPhone: '', devPhones: [] };

  const findRow = dependencies.findRow || tenantStore.findRow;
  const row = await findRow(instanceId).catch(() => null);
  const devPhones = rowDeveloperPhones(row, env);
  return { enabled: true, devPhone: devPhones[0] || '', devPhones };
}

function allowsPhone(policy, phone) {
  if (!policy?.enabled) return true;
  const normalized = normalizePhoneFromCandidates([phone]);
  if (!normalized) return false;
  // A policy built before this field existed still carries only `devPhone`.
  const allowed = Array.isArray(policy.devPhones) && policy.devPhones.length
    ? policy.devPhones
    : [policy.devPhone].filter(Boolean);
  return allowed.includes(normalized);
}

async function isPhoneAllowed(instanceId, phone, dependencies = {}) {
  return allowsPhone(await getTestModePolicy(instanceId, dependencies), phone);
}

function filterAllowedPhones(policy, items) {
  return (Array.isArray(items) ? items : []).filter(item => allowsPhone(policy, item?.phone));
}

module.exports = {
  allowsPhone,
  filterAllowedPhones,
  getTestModePolicy,
  isPhoneAllowed,
  __test: { enabledFrom, rowDeveloperPhone, rowDeveloperPhones, splitPhoneList }
};
