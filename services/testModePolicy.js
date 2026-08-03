'use strict';

const tenantStore = require('./tenantStore');
const { normalizePhoneFromCandidates } = require('./phoneUtils');

function enabledFrom(env = process.env) {
  const value = env.WHATSPRO_TEST_MODE_ENABLED ?? env.TEST_MODE_ENABLED ?? 'false';
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function rowDeveloperPhone(row, env = process.env) {
  return normalizePhoneFromCandidates([
    row?.dev_phone,
    row?.developer_phone,
    row?.developer,
    row?.devPhone,
    env.WHATSPRO_TEST_MODE_ALLOWED_PHONE,
    env.TEST_MODE_ALLOWED_PHONE,
    env.WHATSPRO_DEVELOPER_PHONE,
    env.OPENBOT_DEVELOPER_PHONE
  ]);
}

async function getTestModePolicy(instanceId, dependencies = {}) {
  const env = dependencies.env || process.env;
  const enabled = enabledFrom(env);
  if (!enabled) return { enabled: false, devPhone: '' };

  const findRow = dependencies.findRow || tenantStore.findRow;
  const row = await findRow(instanceId).catch(() => null);
  return { enabled: true, devPhone: rowDeveloperPhone(row, env) };
}

function allowsPhone(policy, phone) {
  if (!policy?.enabled) return true;
  const normalized = normalizePhoneFromCandidates([phone]);
  return Boolean(policy.devPhone && normalized && normalized === policy.devPhone);
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
  __test: { enabledFrom, rowDeveloperPhone }
};
