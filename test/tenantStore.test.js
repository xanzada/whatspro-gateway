'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { redisClient } = require('../config/redis');
const tenantMemoryStore = require('../services/tenantMemoryStore');
const tenantStore = require('../services/tenantStore');

function installMemoryRedis(t) {
  const hashes = new Map();
  const lists = new Map();
  const strings = new Map();
  const originals = {};
  for (const name of ['hGet', 'hGetAll', 'hSet', 'hLen', 'hDel', 'sendCommand', 'set', 'exists', 'lRange', 'lPush', 'lTrim']) originals[name] = redisClient[name];
  Object.defineProperty(redisClient, 'isOpen', { configurable: true, value: true });
  const hash = key => {
    if (!hashes.has(key)) hashes.set(key, new Map());
    return hashes.get(key);
  };
  redisClient.hGet = async (key, field) => hash(key).get(field) || null;
  redisClient.hGetAll = async key => Object.fromEntries(hash(key));
  redisClient.hSet = async (key, field, value) => {
    if (field && typeof field === 'object') {
      for (const [name, stored] of Object.entries(field)) hash(key).set(name, stored);
      return Object.keys(field).length;
    }
    hash(key).set(field, value);
    return 1;
  };
  redisClient.hLen = async key => hash(key).size;
  redisClient.hDel = async (key, field) => hash(key).delete(field) ? 1 : 0;
  redisClient.sendCommand = async args => {
    if (args[0] !== 'HSETNX') throw new Error(`UNSUPPORTED:${args[0]}`);
    if (hash(args[1]).has(args[2])) return 0;
    hash(args[1]).set(args[2], args[3]);
    return 1;
  };
  redisClient.set = async (key, value) => { strings.set(key, value); return 'OK'; };
  redisClient.exists = async key => strings.has(key) ? 1 : 0;
  redisClient.lRange = async (key, start, stop) => (lists.get(key) || []).slice(start, stop + 1);
  redisClient.lPush = async (key, value) => {
    const list = lists.get(key) || [];
    list.unshift(value);
    lists.set(key, list);
    return list.length;
  };
  redisClient.lTrim = async (key, start, stop) => {
    lists.set(key, (lists.get(key) || []).slice(start, stop + 1));
    return 'OK';
  };
  t.after(() => {
    for (const [name, fn] of Object.entries(originals)) redisClient[name] = fn;
    delete redisClient.isOpen;
  });
}

test('platform tenant storage keeps tenant secrets isolated through updates', async t => {
  installMemoryRedis(t);
  await tenantStore.createRow({ instance_id: 'alpha', brand: 'Alpha', whatspro_api_token: 'alpha-secret-token-value' });
  await tenantStore.createRow({ instance_id: 'beta', brand: 'Beta', whatspro_api_token: 'beta-secret-token-value' });
  await tenantStore.updateRow('alpha', { brand: 'Alpha Prime' });

  assert.equal(await tenantStore.getTenantApiToken('alpha'), 'alpha-secret-token-value');
  assert.equal(await tenantStore.getTenantApiToken('beta'), 'beta-secret-token-value');
  assert.equal((await tenantStore.findRow('alpha')).brand, 'Alpha Prime');
  assert.equal((await tenantStore.listTenantRecords()).length, 2);
});

test('chat branding exposes no tenant secret', () => {
  const config = tenantStore.sanitizeTenantConfig({
    instance_id: 'alpha',
    brand: 'Alpha',
    whatspro_api_token: 'must-not-leak',
    webhook_secret: 'must-not-leak'
  }, 'alpha');
  assert.equal(config.branding.name, 'Alpha');
  assert.equal(JSON.stringify(config).includes('must-not-leak'), false);
});

test('tenant memories stay isolated and reject unknown tenant ids', async t => {
  installMemoryRedis(t);
  await tenantStore.createRow({ instance_id: 'alpha', brand: 'Alpha' });
  await tenantStore.createRow({ instance_id: 'beta', brand: 'Beta' });

  await tenantMemoryStore.addMemory('alpha', {
    question: 'Alpha question',
    ideal_answer: 'Alpha answer',
    category: 'menu'
  });
  await tenantMemoryStore.addMemory('beta', {
    question: 'Beta question',
    ideal_answer: 'Beta answer',
    category: 'delivery'
  });

  const alpha = await tenantMemoryStore.listMemories('alpha');
  const beta = await tenantMemoryStore.listMemories('beta');
  assert.deepEqual(alpha.map(item => item.question), ['Alpha question']);
  assert.deepEqual(beta.map(item => item.question), ['Beta question']);
  assert.equal(alpha[0].instance_id, 'alpha');
  assert.equal(beta[0].instance_id, 'beta');
  await assert.rejects(
    tenantMemoryStore.addMemory('missing', { question: 'Q', ideal_answer: 'A' }),
    error => error.message === 'TENANT_NOT_FOUND' && error.statusCode === 404
  );
});
