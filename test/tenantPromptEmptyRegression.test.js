const test=require('node:test');const assert=require('node:assert/strict');
const {__test:admin}=require('../services/tenantAdmin');
test('9416 custom explicit empty clears while omitted preserves',()=>{
 const old={prompt_mode:'custom',system_prompt:'OLD'};
 assert.equal(admin.resolvePrompt({prompt_mode:'custom'},{systemPrompt:''},'SHARED',old),'');
 assert.equal(admin.resolvePrompt({prompt_mode:'custom'},{},'SHARED',old),'OLD');
});
test('9416 custom to known empty shared does not retain custom instructions',()=>{
 assert.equal(admin.resolvePrompt({prompt_mode:'shared'},{promptMode:'shared'},'',{prompt_mode:'custom',system_prompt:'OLD'}),'');
});
test('9416 unavailable shared data preserves same-mode previous shared value',()=>{
 assert.equal(admin.resolvePrompt({prompt_mode:'shared'},{},undefined,{prompt_mode:'shared',system_prompt:'PREVIOUS'}),'PREVIOUS');
});


const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadActual(relative, dependencies) {
  const module = { exports: {} };
  const filename = path.join(__dirname, '..', relative);
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, process: { env: {} }, Date, Buffer, URL,
    console: { warn() {}, error() {} },
    require(name) { return Object.hasOwn(dependencies, name) ? dependencies[name] : require(name); }
  }, { timeout: 1000, filename });
  return module.exports;
}

// Only Redis I/O and the snapshot adapter are fake. Actual tenantStore,
// tenantAdmin and registered route functions perform normalization and writes.
// The same synthetic backing state can be read by a fresh module instance.
function createPromptFixture() {
  const hashes = new Map();
  const snapshots = new Map();
  const hash = key => {
    if (!hashes.has(key)) hashes.set(key, new Map());
    return hashes.get(key);
  };
  const redis = {
    isOpen: true, isReady: true,
    async hGet(key, field) { return hash(key).get(field) ?? null; },
    async hGetAll(key) { return Object.fromEntries(hash(key)); },
    async hSet(key, field, value) { hash(key).set(field, value); return 1; },
    async hDel(key, field) { return Number(hash(key).delete(field)); },
    async sendCommand(args) {
      assert.equal(args[0], 'HSETNX');
      if (hash(args[1]).has(args[2])) return 0;
      hash(args[1]).set(args[2], args[3]); return 1;
    }
  };
  const snapshot = {
    async findSnapshot(id) { return snapshots.get(id) || null; },
    async listSnapshot() { return [...snapshots.values()]; },
    async upsertSnapshot(row) { snapshots.set(row.instance_id, { ...row }); },
    async replaceSnapshot(rows) { snapshots.clear(); rows.forEach(row => snapshots.set(row.instance_id, { ...row })); },
    async deleteSnapshot(id) { snapshots.delete(id); },
    async snapshotSummary() { return { tenants: snapshots.size, ready: true }; }
  };
  const fresh = () => {
    const store = loadActual('services/tenantStore.js', { '../config/redis': { redisClient: redis }, './tenantSnapshot': snapshot });
    const service = loadActual('services/tenantAdmin.js', { './tenantStore': store });
    return { store, service };
  };
  return { ...fresh(), fresh, redis };
}

async function seed(fixture, mode = 'custom', text = 'Previous instructions', id = 'alpha') {
  await fixture.store.createRow({ instance_id: id, brand: 'Synthetic ' + id, prompt_mode: mode,
    system_prompt: text, alemi_instance: id, alemi_api_url: 'https://synthetic.example.invalid' });
}

function actualPromptRoute(fixture, sharedState, method = 'patch', kind = 'clone') {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src/server.js'), 'utf8');
  const helperStart = source.indexOf('async function readSharedPrompt()');
  const helperEnd = source.indexOf('// Direct service failures', helperStart);
  const routeStart = source.indexOf(method === 'patch'
    ? "app.patch('/api/wa/tenants/:instanceId',"
    : (kind === 'create' ? "app.post('/api/wa/tenants'," : "app.post('/api/wa/tenants/:instanceId/clone',"));
  const routeEnd = source.indexOf(method === 'patch'
    ? "app.post('/api/wa/tenants/:instanceId/clone',"
    : (kind === 'create' ? "app.patch('/api/wa/tenants/:instanceId'," : "app.post('/api/wa/tenants/:instanceId/rotate',"), routeStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart && routeStart >= 0 && routeEnd > routeStart);
  let route;
  const redisClient = { isOpen: sharedState.open !== false,
    async get(key) { assert.equal(key, 'SYNTHETIC_SHARED_KEY'); if (sharedState.failure) throw sharedState.failure; return sharedState.value; } };
  const context = { redisClient, SHARED_PROMPT_KEY: 'SYNTHETIC_SHARED_KEY', tenantAdmin: fixture.service,
    publicApiBase: () => '', isValidInstanceId: id => /^[a-z0-9-]{2,64}$/.test(id),
    requireUiOrApi: 'UNCHANGED_AUTH', requirePlatformAdmin: 'UNCHANGED_AUTH', saveInstance: async () => {},
    console: { error() {} },
    app: { [method](url, auth, handler) { assert.equal(auth, 'UNCHANGED_AUTH'); route = handler; } } };
  vm.runInNewContext(source.slice(helperStart, helperEnd) + '\n' + source.slice(routeStart, routeEnd), context, { timeout: 1000 });
  return async body => {
    const response = { code: 200, body: null, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
    await route({ params: { instanceId: 'alpha' }, body }, response);
    return response;
  };
}

for (const missing of [undefined, null]) {
  test('9416 unavailable shared source rejects custom-to-shared before changing any record: ' + String(missing), async () => {
    const fixture = createPromptFixture(); await seed(fixture);
    await assert.rejects(() => fixture.service.updateTenant('alpha', { promptMode: 'shared' }, { sharedPrompt: missing }),
      error => error.message === 'SHARED_PROMPT_UNAVAILABLE' && error.statusCode === 503);
    assert.equal((await fixture.store.findRow('alpha')).prompt_mode, 'custom');
    assert.equal((await fixture.store.findRow('alpha')).system_prompt, 'Previous instructions');
  });
}

test('9416 actual API patch clears custom text and fresh runtime projection stays empty', async () => {
  const fixture = createPromptFixture(); await seed(fixture);
  const response = await actualPromptRoute(fixture, { value: 'Shared instructions' })({ systemPrompt: '' });
  assert.equal(response.code, 200);
  const fresh = fixture.fresh();
  const stored = await fresh.store.findRow('alpha');
  assert.equal(stored.prompt_mode, 'custom'); assert.equal(stored.system_prompt, '');
  assert.equal(fresh.service.runtimeTenant(stored).system_prompt, '');
  assert.equal(fresh.service.presentableTenant(stored).systemPrompt, '');
});

test('9416 actual API patch distinguishes omitted custom text from explicit empty', async () => {
  const fixture = createPromptFixture(); await seed(fixture);
  const response = await actualPromptRoute(fixture, { open: false })({ address: 'Unrelated change' });
  assert.equal(response.code, 200);
  const stored = await fixture.store.findRow('alpha');
  assert.equal(stored.system_prompt, 'Previous instructions'); assert.equal(stored.address, 'Unrelated change');
});

test('9416 actual API switch to authoritative empty shared never leaks old custom text', async () => {
  const fixture = createPromptFixture(); await seed(fixture);
  const response = await actualPromptRoute(fixture, { value: '' })({ promptMode: 'shared' });
  assert.equal(response.code, 200);
  const fresh = fixture.fresh(); const stored = await fresh.store.findRow('alpha');
  assert.equal(stored.prompt_mode, 'shared'); assert.equal(stored.system_prompt, '');
  assert.equal(fresh.service.runtimeTenant(stored).system_prompt, '');
});

test('9416 actual API disconnected shared source rejects mode switch with no partial write', async () => {
  const fixture = createPromptFixture(); await seed(fixture);
  const response = await actualPromptRoute(fixture, { open: false })({ promptMode: 'shared', address: 'Must not be written' });
  assert.equal(response.code, 503); assert.equal(response.body.error, 'TENANT_WRITE_FAILED');
  const stored = await fixture.store.findRow('alpha');
  assert.equal(stored.prompt_mode, 'custom'); assert.equal(stored.system_prompt, 'Previous instructions');
  assert.equal(stored.address, undefined);
});

// A successful Redis GET null proves known absence. Startup does not seed the
// shared key, so this is the normal default-empty state, not a read failure.
test('9416 actual API ready absent shared key clears old custom when switching mode', async () => {
  const fixture = createPromptFixture(); await seed(fixture);
  const response = await actualPromptRoute(fixture, { value: null })({ promptMode: 'shared' });
  assert.equal(response.code, 200);
  const stored = await fixture.fresh().store.findRow('alpha');
  assert.equal(stored.prompt_mode, 'shared'); assert.equal(stored.system_prompt, '');
});

test('9416 shared same-mode edit keeps prior prompt while source is unavailable', async () => {
  const fixture = createPromptFixture(); await seed(fixture, 'shared');
  const response = await actualPromptRoute(fixture, { open: false })({ address: 'Unrelated change' });
  assert.equal(response.code, 200);
  const stored = await fixture.store.findRow('alpha');
  assert.equal(stored.prompt_mode, 'shared'); assert.equal(stored.system_prompt, 'Previous instructions');
});

test('9416 Redis read error is observable and cannot partially clear a prompt', async () => {
  const fixture = createPromptFixture(); await seed(fixture);
  const response = await actualPromptRoute(fixture, { failure: new Error('SYNTHETIC_STORE_FAILURE') })({ promptMode: 'shared' });
  assert.equal(response.code, 502); assert.equal(response.body.error, 'TENANT_WRITE_FAILED');
  assert.equal((await fixture.store.findRow('alpha')).system_prompt, 'Previous instructions');
});

for (const mode of ['custom', 'shared']) {
  test('9416 actual clone uses authoritative empty ' + mode + ' text', async () => {
    const fixture = createPromptFixture(); await seed(fixture);
    const response = await actualPromptRoute(fixture, { value: '' }, 'post')({ instanceId: 'clone-alpha', brand: 'Synthetic clone',
      promptMode: mode, systemPrompt: '', alemiSecret: 'synthetic-clone-only' });
    assert.equal(response.code, 201);
    const stored = await fixture.store.findRow('clone-alpha');
    assert.equal(stored.prompt_mode, mode); assert.equal(stored.system_prompt, '');
    assert.equal((await fixture.store.findRow('alpha')).system_prompt, 'Previous instructions');
  });
}

test('9416 clone omitted custom prompt retains source text without altering source', async () => {
  const fixture = createPromptFixture(); await seed(fixture);
  await fixture.service.cloneTenant('alpha', { instanceId: 'clone-alpha', brand: 'Synthetic clone', alemiSecret: 'synthetic-clone-only' }, {});
  const stored = await fixture.store.findRow('clone-alpha');
  assert.equal(stored.prompt_mode, 'custom'); assert.equal(stored.system_prompt, 'Previous instructions');
});

test('9416 clone custom-to-shared rejects unavailable global source without creating a row', async () => {
  const fixture = createPromptFixture(); await seed(fixture);
  await assert.rejects(() => fixture.service.cloneTenant('alpha', { instanceId: 'clone-alpha', brand: 'Synthetic clone',
    promptMode: 'shared', alemiSecret: 'synthetic-clone-only' }, {}), error => error.message === 'SHARED_PROMPT_UNAVAILABLE');
  assert.equal(await fixture.store.findRow('clone-alpha'), null);
});

test('9416 shared source clone can retain same-mode text if global source is unavailable', async () => {
  const fixture = createPromptFixture(); await seed(fixture, 'shared');
  await fixture.service.cloneTenant('alpha', { instanceId: 'clone-alpha', brand: 'Synthetic clone', alemiSecret: 'synthetic-clone-only' }, {});
  assert.equal((await fixture.store.findRow('clone-alpha')).system_prompt, 'Previous instructions');
});

test('9416 fresh shared create must distinguish known empty from missing source', async () => {
  const fixture = createPromptFixture();
  const input = { instanceId: 'new-alpha', brand: 'Synthetic new', promptMode: 'shared', alemiSecret: 'synthetic-create-only' };
  await assert.rejects(() => fixture.service.createTenant(input), error => error.message === 'SHARED_PROMPT_UNAVAILABLE');
  assert.equal(await fixture.store.findRow('new-alpha'), null);
  await fixture.service.createTenant(input, { sharedPrompt: '' });
  assert.equal((await fixture.store.findRow('new-alpha')).system_prompt, '');
});

test('9416 applying empty shared updates shared rows and leaves custom rows unchanged through actual store', async () => {
  const fixture = createPromptFixture(); await seed(fixture, 'shared'); await seed(fixture, 'custom', 'Beta custom', 'beta');
  const result = await fixture.service.applySharedPrompt('');
  assert.equal(result.applied, 1);
  assert.equal((await fixture.store.findRow('alpha')).system_prompt, '');
  assert.equal((await fixture.store.findRow('beta')).system_prompt, 'Beta custom');
});

for (const malformed of [null, false, 0, { text: 'Not a string' }]) {
  test('9416 malformed custom prompt is rejected instead of coerced or silently retained: ' + JSON.stringify(malformed), async () => {
    const fixture = createPromptFixture(); await seed(fixture);
    await assert.rejects(() => fixture.service.updateTenant('alpha', { systemPrompt: malformed }),
      error => error.statusCode === 400 && error.fields.includes('systemPrompt'));
    assert.equal((await fixture.store.findRow('alpha')).system_prompt, 'Previous instructions');
  });
}

test('9416 explicit whitespace-only custom prompt clears after normal text normalization', async () => {
  const fixture = createPromptFixture(); await seed(fixture);
  await fixture.service.updateTenant('alpha', { systemPrompt: ' \r\n\t ' });
  assert.equal((await fixture.store.findRow('alpha')).system_prompt, '');
});


test('9416 clone explicit default mode is shared rather than inherited custom', async () => {
  const fixture = createPromptFixture(); await seed(fixture);
  await fixture.service.cloneTenant('alpha', { instanceId: 'clone-alpha', brand: 'Synthetic clone',
    promptMode: '', systemPrompt: '', alemiSecret: 'synthetic-clone-only' }, { sharedPrompt: '' });
  const stored = await fixture.store.findRow('clone-alpha');
  assert.equal(stored.prompt_mode, 'shared'); assert.equal(stored.system_prompt, '');
});


for (const value of [null, '']) {
  test('9416 actual new shared create accepts known absent or explicitly empty global prompt: ' + String(value), async () => {
    const fixture = createPromptFixture();
    const response = await actualPromptRoute(fixture, { value }, 'post', 'create')({ instanceId: 'new-alpha', brand: 'Synthetic new',
      promptMode: 'shared', alemiSecret: 'synthetic-create-only' });
    assert.equal(response.code, 201);
    const stored = await fixture.fresh().store.findRow('new-alpha');
    assert.equal(stored.prompt_mode, 'shared'); assert.equal(stored.system_prompt, '');
  });
}


test('9416 actual clone switching custom to shared accepts a ready absent global key without altering source', async () => {
  const fixture = createPromptFixture(); await seed(fixture);
  const response = await actualPromptRoute(fixture, { value: null }, 'post')({ instanceId: 'clone-alpha', brand: 'Synthetic clone',
    promptMode: 'shared', alemiSecret: 'synthetic-clone-only' });
  assert.equal(response.code, 201);
  const stored = await fixture.fresh().store.findRow('clone-alpha');
  assert.equal(stored.prompt_mode, 'shared'); assert.equal(stored.system_prompt, '');
  const source = await fixture.store.findRow('alpha');
  assert.equal(source.prompt_mode, 'custom'); assert.equal(source.system_prompt, 'Previous instructions');
});

for (const sharedState of [{ open: false }, { failure: new Error('SYNTHETIC_SHARED_READ_FAILURE') }]) {
  test('9416 actual new shared create fails before writes on unavailable connection or GET error: ' + (sharedState.failure ? 'read error' : 'disconnected'), async () => {
    const fixture = createPromptFixture();
    const response = await actualPromptRoute(fixture, sharedState, 'post', 'create')({ instanceId: 'new-alpha', brand: 'Synthetic new',
      promptMode: 'shared', alemiSecret: 'synthetic-create-only' });
    assert.equal(response.code, sharedState.failure ? 502 : 503);
    assert.equal(response.body.error, 'TENANT_WRITE_FAILED');
    assert.equal(await fixture.store.findRow('new-alpha'), null);
  });
}


for (const sharedState of [{ open: false }, { failure: new Error('SYNTHETIC_CLONE_READ_FAILURE') }]) {
  test('9416 actual shared clone rejects unavailable connection or GET error before creating a row: ' + (sharedState.failure ? 'read error' : 'disconnected'), async () => {
    const fixture = createPromptFixture(); await seed(fixture);
    const response = await actualPromptRoute(fixture, sharedState, 'post')({ instanceId: 'clone-alpha', brand: 'Synthetic clone',
      promptMode: 'shared', alemiSecret: 'synthetic-clone-only' });
    assert.equal(response.code, sharedState.failure ? 502 : 503);
    assert.equal(response.body.error, 'TENANT_WRITE_FAILED');
    assert.equal(await fixture.store.findRow('clone-alpha'), null);
    const source = await fixture.store.findRow('alpha');
    assert.equal(source.prompt_mode, 'custom'); assert.equal(source.system_prompt, 'Previous instructions');
  });
}
