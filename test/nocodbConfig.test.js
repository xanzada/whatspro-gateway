const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');

const { sanitizeTenantConfig, getTenantChatConfig, __test } = require('../services/nocodbConfig');

test('tenant chat branding uses the NocoDB brand column for its instance', () => {
  const config = sanitizeTenantConfig({
    instance: 'prestige',
    brand: 'Prestige Family Restaurant',
    restaurant_name: 'Legacy restaurant name'
  }, 'prestige');

  assert.equal(config.instance, 'prestige');
  assert.equal(config.branding.name, 'Prestige Family Restaurant');

  const mismatched = sanitizeTenantConfig({ instance: 'another-tenant', brand: 'Wrong Brand' }, 'prestige');
  assert.equal(mismatched.found, false);
  assert.equal(mismatched.branding.name, 'prestige');
});

test('tenant config coalesces concurrent lookups and bounds its cache', async () => {
  const originalGet = axios.get;
  const originalEnv = {
    url: process.env.NOCODB_URL,
    table: process.env.NOCODB_RESTAURANTS_TABLE_ID,
    token: process.env.NOCODB_TOKEN
  };
  process.env.NOCODB_URL = 'https://nocodb.test';
  process.env.NOCODB_RESTAURANTS_TABLE_ID = 'restaurants';
  process.env.NOCODB_TOKEN = 'test-token';
  __test.reset();
  let calls = 0;
  axios.get = async (_url, options) => {
    calls += 1;
    const instance = String(options.params.where).split(',eq,')[1].replace(/\)$/, '');
    await new Promise(resolve => setImmediate(resolve));
    return { data: { list: [{ instance, brand: `Brand ${instance}` }] } };
  };

  try {
    const [first, second] = await Promise.all([
      getTenantChatConfig('same-tenant'),
      getTenantChatConfig('same-tenant')
    ]);
    assert.equal(calls, 1);
    assert.equal(first.branding.name, 'Brand same-tenant');
    assert.equal(second.branding.name, first.branding.name);

    calls = 0;
    __test.reset();
    const burst = await Promise.all(Array.from({ length: 5 }, (_, index) => getTenantChatConfig(`burst-${index}`)));
    assert.equal(calls, 5);
    assert.ok(burst.every(item => item.found));

    for (let index = 0; index < 520; index += 1) {
      await getTenantChatConfig(`tenant-${index}`);
    }
    assert.ok(__test.stats().cacheSize <= 500);
  } finally {
    axios.get = originalGet;
    if (originalEnv.url === undefined) delete process.env.NOCODB_URL; else process.env.NOCODB_URL = originalEnv.url;
    if (originalEnv.table === undefined) delete process.env.NOCODB_RESTAURANTS_TABLE_ID; else process.env.NOCODB_RESTAURANTS_TABLE_ID = originalEnv.table;
    if (originalEnv.token === undefined) delete process.env.NOCODB_TOKEN; else process.env.NOCODB_TOKEN = originalEnv.token;
    __test.reset();
  }
});

test('tenant config does not cache transport failures', async () => {
  const originalGet = axios.get;
  const originalEnv = {
    url: process.env.NOCODB_URL,
    table: process.env.NOCODB_RESTAURANTS_TABLE_ID,
    token: process.env.NOCODB_TOKEN
  };
  process.env.NOCODB_URL = 'https://nocodb.test';
  process.env.NOCODB_RESTAURANTS_TABLE_ID = 'restaurants';
  process.env.NOCODB_TOKEN = 'test-token';
  __test.reset();
  axios.get = async () => { throw new Error('network unavailable'); };

  try {
    const result = await getTenantChatConfig('offline-tenant');
    assert.equal(result.found, false);
    assert.equal(__test.stats().cacheSize, 0);
  } finally {
    axios.get = originalGet;
    if (originalEnv.url === undefined) delete process.env.NOCODB_URL; else process.env.NOCODB_URL = originalEnv.url;
    if (originalEnv.table === undefined) delete process.env.NOCODB_RESTAURANTS_TABLE_ID; else process.env.NOCODB_RESTAURANTS_TABLE_ID = originalEnv.table;
    if (originalEnv.token === undefined) delete process.env.NOCODB_TOKEN; else process.env.NOCODB_TOKEN = originalEnv.token;
    __test.reset();
  }
});

test('tenant config opens its circuit on NocoDB rate limiting', async () => {
  const originalGet = axios.get;
  const originalEnv = {
    url: process.env.NOCODB_URL,
    table: process.env.NOCODB_RESTAURANTS_TABLE_ID,
    token: process.env.NOCODB_TOKEN
  };
  process.env.NOCODB_URL = 'https://nocodb.test';
  process.env.NOCODB_RESTAURANTS_TABLE_ID = 'restaurants';
  process.env.NOCODB_TOKEN = 'test-token';
  __test.reset();
  let calls = 0;
  axios.get = async () => {
    calls += 1;
    const error = new Error('rate limited');
    error.response = { status: 429, headers: { 'retry-after': '2' } };
    throw error;
  };

  try {
    await getTenantChatConfig('limited-one');
    await getTenantChatConfig('limited-two');
    assert.equal(calls, 1);
    assert.equal(__test.stats().cacheSize, 0);
    assert.ok(__test.stats().circuitOpenUntil > Date.now());
  } finally {
    axios.get = originalGet;
    if (originalEnv.url === undefined) delete process.env.NOCODB_URL; else process.env.NOCODB_URL = originalEnv.url;
    if (originalEnv.table === undefined) delete process.env.NOCODB_RESTAURANTS_TABLE_ID; else process.env.NOCODB_RESTAURANTS_TABLE_ID = originalEnv.table;
    if (originalEnv.token === undefined) delete process.env.NOCODB_TOKEN; else process.env.NOCODB_TOKEN = originalEnv.token;
    __test.reset();
  }
});
