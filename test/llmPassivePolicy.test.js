'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createLlmProviderHealth } = require('../services/llmProviderHealth');
class MemoryRedis {
  constructor() { this.isOpen = true; this.data = new Map(); this.reads = 0; this.writes = 0; }
  async get(k) { this.reads++; return this.data.get(k) || null; }
  async set(k,v) { this.writes++; this.data.set(k,v); return 'OK'; }
}
const disabled = e => e?.statusCode === 403 && e?.message === 'ACTIVE_LLM_KEY_CHECKS_DISABLED';
function syntheticWorkspace() {
  return Object.fromEntries(['text','media','stt','ocr'].map(pool=>[pool,
    ['openai','gemini','groq','cloudflare'].map((type,i)=>({id:`llm_${pool}_${type}_12345678901234567890`,name:`synthetic-${i}`,type,
      baseUrl:'https://provider.invalid/v1',model:'synthetic-model',key:'synthetic-no-real-key'}))]));
}
for (const pool of ['text','media','stt','ocr']) {
  for (const type of ['openai','gemini','groq','cloudflare']) {
    test(`passive LLM policy: checkOne never validates ${pool}/${type}`,async()=>{
      const redis=new MemoryRedis(); let fetches=0;
      const health=createLlmProviderHealth({redis,fetchImpl:async()=>{fetches++;return {ok:true,status:200,json:async()=>({object:'list',data:[]})};}});
      const workspace=syntheticWorkspace(); const entry=workspace[pool].find(x=>x.type===type);
      await assert.rejects(()=>health.checkOne(workspace,pool,entry.id),disabled);
      assert.equal(fetches,0); assert.equal(redis.reads,0); assert.equal(redis.writes,0);
    });
  }
  test(`passive LLM policy: checkAll ${pool} refuses before provider secrets are read`,async()=>{
    const redis=new MemoryRedis();let fetches=0,keyReads=0;
    const workspace=syntheticWorkspace();
    for(const e of workspace[pool])Object.defineProperty(e,'key',{get(){keyReads++;throw new Error('SYNTHETIC_KEY_ACCESS_FORBIDDEN');}});
    const health=createLlmProviderHealth({redis,fetchImpl:async()=>{fetches++;throw new Error('SYNTHETIC_NETWORK_FORBIDDEN');}});
    await assert.rejects(()=>health.checkAll(workspace,pool),disabled);
    assert.equal(keyReads,0);assert.equal(fetches,0);assert.equal(redis.reads,0);assert.equal(redis.writes,0);
  });
}
test('passive LLM policy: checkAll/checkDue never enumerate workspace or schedule a probe',async()=>{
  const redis=new MemoryRedis();let fetches=0,workspaceReads=0;
  const workspace=new Proxy({}, {get(){workspaceReads++;throw new Error('SYNTHETIC_WORKSPACE_ACCESS_FORBIDDEN');}});
  const health=createLlmProviderHealth({redis,fetchImpl:async()=>{fetches++;throw new Error('SYNTHETIC_NETWORK_FORBIDDEN');}});
  await assert.rejects(()=>health.checkAll(workspace),disabled);
  await assert.rejects(()=>health.checkDue(workspace),disabled);
  assert.equal(workspaceReads,0);assert.equal(fetches,0);assert.equal(redis.reads,0);assert.equal(redis.writes,0);
});
test('passive LLM policy: start remains an inert scheduler',()=>{
  let scheduled=0;const original=global.setInterval;
  global.setInterval=()=>{scheduled++;throw new Error('SYNTHETIC_TIMER_FORBIDDEN');};
  try {const h=createLlmProviderHealth({redis:new MemoryRedis(),fetchImpl:()=>{throw new Error('SYNTHETIC_NETWORK_FORBIDDEN');}});h.start(()=>syntheticWorkspace());h.stop();assert.equal(scheduled,0);}
  finally {global.setInterval=original;}
});
test('passive LLM policy: actual OpenBot outcomes still update health and runtime ordering without HTTP',async()=>{
  const redis=new MemoryRedis();let fetches=0;const workspace=syntheticWorkspace();
  const h=createLlmProviderHealth({redis,fetchImpl:async()=>{fetches++;throw new Error('SYNTHETIC_NETWORK_FORBIDDEN');}});
  await h.recordOutcome(workspace,{pool:'text',entryId:workspace.text[1].id,ok:true,latencyMs:17,observedAt:new Date().toISOString(),promptTokens:9,completionTokens:3,totalTokens:12,cost:0,isPaid:false});
  const report=await h.getHealth(workspace);assert.equal(report.text[1].status,'healthy');assert.equal(report.text[1].source,'runtime');assert.equal(report.text[1].totalTokens,12);
  const runtime=await h.getRuntimeWorkspace(workspace);assert.equal(runtime.text[0].id,workspace.text[1].id);
  assert.deepEqual(workspace.text.map(x=>x.type),['openai','gemini','groq','cloudflare']);assert.equal(fetches,0);
  const publicData=JSON.stringify(report);assert.equal(publicData.includes('synthetic-no-real-key'),false);
});
for (const body of [{},{pool:'text'},{pool:'media',entryId:'llm_synthetic_12345678901234567890'}]) {
  test(`passive LLM policy: exact authenticated check handler refuses locally ${JSON.stringify(body)}`,async()=>{
    const source=fs.readFileSync(path.join(__dirname,'..','src','server.js'),'utf8');
    const begin=source.indexOf("app.post('/api/wa/llm-workspace/check',");
    const end=source.indexOf("app.post('/api/wa/llm-workspace/outcomes',",begin);
    assert.ok(begin>=0&&end>begin);let route=null,workspaceReads=0,activeCalls=0;
    vm.runInNewContext(source.slice(begin,end),{
      app:{post(url,auth,fn){assert.equal(url,'/api/wa/llm-workspace/check');assert.equal(auth,'AUTH_UNCHANGED');route=fn;}},
      requirePlatformAdmin:'AUTH_UNCHANGED',
      llmWorkspace:{async getWorkspace(){workspaceReads++;return syntheticWorkspace();}},
      llmProviderHealth:{async checkAll(){activeCalls++;return {};},async checkOne(){activeCalls++;return {};}},
      adminError(res){return res.status(500).json({error:'SYNTHETIC_ROUTE_ERROR'});}
    },{timeout:1000});
    const response={code:200,body:null,status(n){this.code=n;return this;},json(v){this.body=v;return this;}};
    await route({body},response);
    assert.equal(response.code,403);assert.deepEqual(JSON.parse(JSON.stringify(response.body)),{success:false,error:'ACTIVE_LLM_KEY_CHECKS_DISABLED'});
    assert.equal(workspaceReads,0);assert.equal(activeCalls,0);
  });
}
test('passive LLM policy: UI has no single, pool or all validation action or request',()=>{
  const panel=fs.readFileSync(path.join(__dirname,'..','public','tenants.js'),'utf8');
  assert.doesNotMatch(panel,/data-action=["']ak-check(?:-pool|-all)?["']/);
  assert.doesNotMatch(panel,/name === ['"]ak-check(?:-pool|-all)?['"]/);
  assert.doesNotMatch(panel,/api\(['"]POST['"],\s*['"]\/api\/wa\/llm-workspace\/check['"]/);
  assert.match(panel,/api\('PUT', '\/api\/wa\/llm-workspace'/);
  assert.match(panel,/api\('GET', '\/api\/wa\/llm-workspace\/health'/);
});

// Error-boundary controls use the actual four route callbacks and actual error
// helper; runtime failures and credentials below are synthetic test inputs only.
function executeLlmFailureRoute(method, url, error) {
  const source=fs.readFileSync(path.join(__dirname,'..','src','server.js'),'utf8');
  const helperStart=source.indexOf('function adminError(res, error) {');
  const helperEnd=source.indexOf('// The form derives',helperStart);
  const start=source.indexOf(`app.${method}('${url}',`);
  const next=source.indexOf('\napp.',start+1);
  assert.ok(helperStart>=0&&helperEnd>helperStart&&start>=0&&next>start);
  let route=null, logs=[];
  const fail=async()=>{throw error;};
  const sandbox={
    app:{[method](registered,auth,fn){assert.equal(registered,url);assert.equal(auth,'AUTH_UNCHANGED');route=fn;}},
    requirePlatformAdmin:'AUTH_UNCHANGED', readSession:()=>null,
    llmWorkspace:{getWorkspace:fail,saveWorkspace:fail},
    llmProviderHealth:{getRuntimeWorkspace:fail,getHealth:fail,recordOutcome:fail},
    validateOutcomePayload:body=>body,
    console:{error:(...args)=>logs.push(args)}
  };
  vm.runInNewContext(source.slice(helperStart,helperEnd)+'\n'+source.slice(start,next),sandbox,{timeout:1000});
  const response={code:200,body:null,status(n){this.code=n;return this;},json(v){this.body=v;return this;}};
  return Promise.resolve(route({body:{},params:{}},response)).then(()=>({response,logs}));
}
const llmFailureRoutes=[
  ['get','/api/wa/llm-workspace'],['put','/api/wa/llm-workspace'],
  ['get','/api/wa/llm-workspace/health'],['post','/api/wa/llm-workspace/outcomes']
];
for(const [method,url] of llmFailureRoutes){
  for(const statusCode of [undefined,400,503]){
    test(`passive LLM error privacy: ${method} ${url} rejects unknown ${statusCode??'default'} error text and fields`,async()=>{
      const sentinel='SYNTHETIC_PROVIDER_KEY_MUST_NOT_APPEAR';
      const error=Object.assign(new Error(sentinel),{statusCode,fields:[sentinel,{key:sentinel}]});
      const {response,logs}=await executeLlmFailureRoute(method,url,error);
      assert.equal(response.code,statusCode??502);
      assert.equal(response.body.error,'LLM_WORKSPACE_REQUEST_FAILED');
      assert.equal(JSON.stringify(response.body).includes(sentinel),false);
      assert.equal(JSON.stringify(logs).includes(sentinel),false);
      assert.deepEqual(JSON.parse(JSON.stringify(logs)),[['[LLM:WORKSPACE]',{code:'LLM_WORKSPACE_REQUEST_FAILED',status:statusCode??502}]]);
      assert.equal(Object.hasOwn(response.body,'fields'),false);
    });
  }
}
for(const [method,url,code,status,fields] of [
  ['put','/api/wa/llm-workspace','LLM_WORKSPACE_ENTRY_INCOMPLETE',400,['text','model']],
  ['post','/api/wa/llm-workspace/outcomes','INVALID_OUTCOME_FIELDS',400,['entryId','pool']],
  ['post','/api/wa/llm-workspace/outcomes','UNKNOWN_LLM_ENTRY',404,undefined],
  ['get','/api/wa/llm-workspace/health','PLATFORM_STORE_UNAVAILABLE',503,undefined]
]){
  test(`passive LLM error privacy: retains typed ${code} status and safe identifiers`,async()=>{
    const {response,logs}=await executeLlmFailureRoute(method,url,Object.assign(new Error(code),{statusCode:status,fields}));
    assert.equal(response.code,status);assert.equal(response.body.error,code);
    if(fields)assert.deepEqual(JSON.parse(JSON.stringify(response.body.fields)),fields);
    assert.deepEqual(logs,[]);
  });
}
test('passive LLM error privacy: recognized code cannot export arbitrary fields or objects',async()=>{
  const {response,logs}=await executeLlmFailureRoute('put','/api/wa/llm-workspace',Object.assign(new Error('LLM_WORKSPACE_ENTRY_INCOMPLETE'),
    {statusCode:400,fields:['text','SYNTHETIC_PROVIDER_KEY_MUST_NOT_APPEAR',{key:'SYNTHETIC_PRIVATE'},'model']}));
  assert.deepEqual(JSON.parse(JSON.stringify(response.body)),{error:'LLM_WORKSPACE_ENTRY_INCOMPLETE',fields:['text','model']});
  assert.deepEqual(logs,[]);
});

// Shared admin errors: actual tenant route callback, synthetic failures only.
async function executeCommonTenantRoute(error, body = {}) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  const helperStart = source.indexOf('function adminError(res, error) {');
  const helperEnd = source.indexOf('// The form derives', helperStart);
  const start = source.indexOf("app.patch('/api/wa/tenants/:instanceId',");
  const next = source.indexOf('\napp.', start + 1);
  assert.ok(helperStart >= 0 && helperEnd > helperStart && start >= 0 && next > start);
  let route, updateCalls = 0;
  const logs = [];
  const sandbox = {
    app: { patch(url, auth, callback) {
      assert.equal(url, '/api/wa/tenants/:instanceId');
      assert.equal(auth, 'AUTH_UNCHANGED'); route = callback;
    } },
    requireUiOrApi: 'AUTH_UNCHANGED', isValidInstanceId: id => id === 'synthetic-private-tenant',
    tenantAdmin: { async updateTenant(id, data) {
      assert.equal(id, 'synthetic-private-tenant'); assert.equal(data, body); updateCalls++;
      if (error) throw error;
      return { saved: true };
    } },
    publicApiBase: () => 'https://synthetic.invalid', readSharedPrompt: async () => '',
    console: { error: (...args) => logs.push(args) }
  };
  vm.runInNewContext(source.slice(helperStart, helperEnd) + '\n' + source.slice(start, next), sandbox, { timeout: 1000 });
  const response = { code: 200, body: null, status(n) { this.code = n; return this; }, json(v) { this.body = v; return this; } };
  await route({ params: { instanceId: 'synthetic-private-tenant' }, body }, response);
  return { response, logs, updateCalls };
}
for (const supplied of [undefined, 500, 503, 599, 600, 'invalid']) {
  test(`common admin error privacy: unknown ${supplied ?? 'default'} tenant failure has constant public body and log`, async () => {
    const sentinel = 'SYNTHETIC_UPSTREAM_SECRET_MUST_NOT_APPEAR';
    const failure = Object.assign(new Error(sentinel), { statusCode: supplied, fields: [sentinel, { secret: sentinel }] });
    const { response, logs, updateCalls } = await executeCommonTenantRoute(failure);
    const expectedStatus = Number.isInteger(supplied) && supplied >= 500 && supplied < 600 ? supplied : 502;
    assert.equal(response.code, expectedStatus); assert.equal(updateCalls, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(response.body)), { error: 'TENANT_WRITE_FAILED' });
    assert.deepEqual(JSON.parse(JSON.stringify(logs)), [['[TENANT:ADMIN]', { code: 'TENANT_WRITE_FAILED', status: expectedStatus }]]);
    assert.equal(JSON.stringify(response.body).includes(sentinel), false);
    assert.equal(JSON.stringify(logs).includes(sentinel), false);
  });
}
for (const [statusCode, code, fields] of [
  [400, 'TENANT_FIELDS_INVALID', ['brand', 'whatsappPhone']],
  [409, 'ALEMI_SECRET_DUPLICATE', ['alemiSecret']],
  [404, 'TENANT_NOT_FOUND', undefined],
]) {
  test(`common admin error privacy: tenant typed ${statusCode} validation compatibility remains`, async () => {
    const { response, logs, updateCalls } = await executeCommonTenantRoute(Object.assign(new Error(code), { statusCode, fields }));
    assert.equal(response.code, statusCode); assert.equal(response.body.error, code); assert.equal(updateCalls, 1);
    if (fields) assert.deepEqual(JSON.parse(JSON.stringify(response.body.fields)), fields);
    assert.deepEqual(logs, []);
  });
}
test('common admin error privacy: successful tenant callback retains response and no error log', async () => {
  const { response, logs, updateCalls } = await executeCommonTenantRoute(null, { brand: 'Synthetic' });
  assert.equal(updateCalls, 1); assert.equal(response.code, 200);
  assert.deepEqual(JSON.parse(JSON.stringify(response.body)), { success: true, saved: true });
  assert.deepEqual(logs, []);
});

// Eleven direct public projections: source route callbacks, synthetic failures.
async function executeDirectPublicFailure(method, url, failure, configuredHealth = false) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  const helperStart = source.indexOf('function adminError(res, error) {');
  const helperEnd = source.indexOf('// The form derives', helperStart);
  const start = source.indexOf(`app.${method}('${url}',`);
  const next = source.indexOf('\napp.', start + 1);
  assert.ok(start >= 0 && next > start);
  let route; const logs = [];
  const fail = async () => { throw failure; };
  const sandbox = {
    app: { [method](registered, ...callbacks) { assert.equal(registered, url); route = callbacks.at(-1); } },
    requirePlatformAdmin: 'AUTH_PLATFORM_UNCHANGED', requireUiOrApi: 'AUTH_UI_UNCHANGED', requireMasterApi: 'AUTH_MASTER_UNCHANGED',
    isValidInstanceId: () => true, tenantStore: { listTenantRecords: fail, getStorageSummary: fail, findRow: fail },
    tenantMemoryStore: { listMemories: fail, addMemory: fail },
    tenantAdmin: { findRow: fail }, readConnectToken: () => ({ instanceId: 'synthetic-private-tenant' }), allowConnectPoll: async () => true,
    getRedisState: () => ({ ready: true }), incomingWalSummary: fail,
    getOpenBotWebhookUrl: () => configuredHealth ? 'https://synthetic.invalid/webhook' : '',
    axios: { get: fail }, URL, listInstances: async () => [],
    apiSendWalSummary: async () => ({ pending: 0, uncertain: 0, accepted: 0, corrupt: 0 }),
    console: { error: (...args) => logs.push(args) }
  };
  vm.runInNewContext(source.slice(helperStart, helperEnd) + '\n' + source.slice(start, next), sandbox, { timeout: 1000 });
  const response = { code: 200, body: null, status(n) { this.code = n; return this; }, json(v) { this.body = v; return this; } };
  await route({ params: { instanceId: 'synthetic-private-tenant', token: 'synthetic-public-token' }, body: {} }, response);
  return { response, logs };
}
const directFailureRoutes = [
  ['get', '/api/wa/tenants', 'PLATFORM_STORE_UNAVAILABLE'],
  ['get', '/api/wa/tenants/:instanceId', 'PLATFORM_STORE_UNAVAILABLE'],
  ['get', '/api/wa/platform-storage', 'PLATFORM_STORE_UNAVAILABLE'],
  ['get', '/api/wa/runtime-configs', 'PLATFORM_STORE_UNAVAILABLE'],
  ['get', '/api/wa/runtime-configs/:instanceId', 'PLATFORM_STORE_UNAVAILABLE'],
  ['get', '/api/wa/runtime-configs/:instanceId/memories', 'PLATFORM_STORE_UNAVAILABLE'],
  ['post', '/api/wa/runtime-configs/:instanceId/memories', 'PLATFORM_STORE_UNAVAILABLE'],
  ['get', '/api/wa/connect/:token/status', 'CONNECT_STATUS_UNAVAILABLE']
];
for (const [method, url, fallback] of directFailureRoutes) {
  test(`direct public error privacy: ${method} ${url} has constant unavailable body and safe log`, async () => {
    const sentinel = 'SYNTHETIC_DIRECT_UPSTREAM_SECRET';
    const failure = Object.assign(new Error(sentinel), { fields: [sentinel, { token: sentinel }] });
    const { response, logs } = await executeDirectPublicFailure(method, url, failure);
    assert.equal(response.code, 503);
    assert.deepEqual(JSON.parse(JSON.stringify(response.body)), { error: fallback });
    assert.equal(JSON.stringify(logs).includes(sentinel), false);
    assert.deepEqual(JSON.parse(JSON.stringify(logs)), [['[PLATFORM:REQUEST]', { code: fallback, status: 503 }]]);
  });
}
test('direct public error privacy: detailed health preserves shapes and sanitizes all three upstream errors', async () => {
  const { response, logs } = await executeDirectPublicFailure('get', '/health/detailed', new Error('SYNTHETIC_DIRECT_UPSTREAM_SECRET'), true);
  assert.equal(response.code, 200); assert.equal(response.body.ok, true); assert.equal(response.body.mode, 'degraded');
  assert.deepEqual(JSON.parse(JSON.stringify(response.body.checks.tenantStorage)), { backend: 'unavailable', tenants: 0, initialized: false, error: 'PLATFORM_STORE_UNAVAILABLE' });
  assert.deepEqual(JSON.parse(JSON.stringify(response.body.checks.inboundWal)), { pending: -1, error: 'INCOMING_WAL_UNAVAILABLE' });
  assert.equal(response.body.checks.openbot.status, 'OPENBOT_HEALTH_UNAVAILABLE');
  assert.equal(response.body.checks.openbot.ok, false); assert.equal(response.body.checks.openbot.target, 'synthetic.invalid');
  assert.equal(JSON.stringify(response.body).includes('SYNTHETIC_DIRECT_UPSTREAM_SECRET'), false);
  assert.deepEqual(logs, []);
});
for (const [method, url, code, statusCode] of [
  ['get', '/api/wa/runtime-configs/:instanceId/memories', 'BAD_INSTANCE_ID', 400],
  ['post', '/api/wa/runtime-configs/:instanceId/memories', 'MEMORY_FIELDS_INVALID', 400],
  ['get', '/api/wa/runtime-configs/:instanceId/memories', 'TENANT_NOT_FOUND', 404]
]) {
  test(`direct public error privacy: retains real typed ${code} workflow code`, async () => {
    const { response, logs } = await executeDirectPublicFailure(method, url, Object.assign(new Error(code), { statusCode }));
    assert.equal(response.code, statusCode); assert.equal(response.body.error, code); assert.deepEqual(logs, []);
  });
}
for (const statusCode of [400, 503]) {
  test(`direct public error privacy: supplied ${statusCode} cannot export arbitrary text or fields`, async () => {
    const sentinel = 'SYNTHETIC_DIRECT_UPSTREAM_SECRET';
    const { response, logs } = await executeDirectPublicFailure('post', '/api/wa/runtime-configs/:instanceId/memories', Object.assign(new Error(sentinel), { statusCode, fields: [sentinel] }));
    assert.equal(response.code, statusCode);
    assert.deepEqual(JSON.parse(JSON.stringify(response.body)), { error: 'PLATFORM_STORE_UNAVAILABLE' });
    assert.equal(JSON.stringify(logs).includes(sentinel), false);
  });
}

for (const url of ['/api/wa/tenants', '/api/wa/tenants/:instanceId', '/api/wa/platform-storage']) {
  test(`direct public error privacy: fixed503 ${url} retains original status for arbitrary upstream400`, async () => {
    const { response, logs } = await executeDirectPublicFailure('get', url, Object.assign(new Error('SYNTHETIC_DIRECT_UPSTREAM_SECRET'), { statusCode: 400 }));
    assert.equal(response.code, 503);
    assert.deepEqual(JSON.parse(JSON.stringify(response.body)), { error: 'PLATFORM_STORE_UNAVAILABLE' });
    assert.deepEqual(JSON.parse(JSON.stringify(logs)), [['[PLATFORM:REQUEST]', { code: 'PLATFORM_STORE_UNAVAILABLE', status: 503 }]]);
  });
}
