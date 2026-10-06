'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),Module=require('node:module');
const axios=require('axios'),filename=require.resolve('../services/incomingWebhook'),walFilename=require.resolve('../services/incomingWal');
const phone='77000000007',body='SYNTHETIC_WORKER_PRIVATE_BODY',token='SYNTHETIC_WORKER_TOKEN';
const error=(code='ECONNRESET')=>Object.assign(new Error(body+' Bearer '+token+' '+phone),{code});
const p=id=>({instanceId:'pipeline-privacy',messageId:id||token+phone,normalizedPhone:phone,body:'private fixture',timestamp:1});
let logs,dir,incoming,wal,previous,previousWebhook;
const tick=()=>new Promise(r=>setImmediate(r));
async function waitFor(predicate){const deadline=Date.now()+3000;while(!predicate()&&Date.now()<deadline)await new Promise(r=>setTimeout(r,5));assert.equal(predicate(),true,'actual async callback must execute');await tick();await tick();}
function absent(){const text=logs.join('\n');for(const value of [phone,body,token,'Bearer'])assert.equal(text.includes(value),false,'incoming pipeline diagnostic contains private fixture data');}
function safeLastError(value){for(const v of [phone,body,token,'Bearer'])assert.equal(String(value).includes(v),false,'persisted error must contain only finite safe codes');}
test.beforeEach(async t=>{
 dir=await fs.mkdtemp(path.join(os.tmpdir(),'incoming-worker-privacy-'));previous=process.env.WHATSPRO_INBOUND_WAL_DIR;process.env.WHATSPRO_INBOUND_WAL_DIR=dir;
 delete require.cache[walFilename];delete require.cache[filename];wal=require(walFilename);
 const original=Module._load;Module._load=function(request,parent,isMain){if(parent?.filename===filename&&request==='./testModePolicy')return{isPhoneAllowed:async()=>true};if(parent?.filename===filename&&request==='./tenantStore')return{findRow:async()=>({bot_enabled:true})};return original.call(this,request,parent,isMain);};
 try{incoming=require(filename);}finally{Module._load=original;}
 // Dynamic tenant lookup is also constrained to a local dependency seam.
 t.mock.method(require('../services/tenantStore'),'findRow',async()=>({bot_enabled:true}));
 previousWebhook=process.env.OPENBOT_WEBHOOK_URL;process.env.OPENBOT_WEBHOOK_URL='https://fixture.invalid/webhook';logs=[];
 for(const name of ['warn','error','log'])t.mock.method(console,name,(...args)=>logs.push(args.map(String).join(' ')));
 t.mock.method(axios,'post',async()=>({status:200}));
});
test.afterEach(async()=>{delete require.cache[walFilename];delete require.cache[filename];if(previous===undefined)delete process.env.WHATSPRO_INBOUND_WAL_DIR;else process.env.WHATSPRO_INBOUND_WAL_DIR=previous;if(previousWebhook===undefined)delete process.env.OPENBOT_WEBHOOK_URL;else process.env.OPENBOT_WEBHOOK_URL=previousWebhook;await fs.rm(dir,{recursive:true,force:true});});
for(const failure of ['redis','openbot',null])test('actual worker '+(failure||'success')+' retains retry flags and safe diagnostics/error fields',async t=>{
 const record={id:'volatile:'+token+phone,payload:p(),pendingRedis:true,pendingOpenBot:true,attempts:0};
 t.mock.method(axios,'post',async()=>{if(failure==='openbot')throw error();return{status:200};});
 let saves=0;
 await incoming.processIncomingRecord(record,{saveIncomingMessage:async value=>{saves++;assert.equal(value.normalizedPhone,phone);if(failure==='redis')throw error('ETIMEDOUT');return{saved:true};},shouldSkipOpenBot:async()=>false});
 assert.equal(saves,1);assert.equal(record.pendingRedis,failure==='redis');assert.equal(record.pendingOpenBot,failure==='openbot');assert.equal(record.attempts,1);assert.ok(record.nextAttemptAt>Date.now());absent();safeLastError(record.lastError);
});
test('actual worker persists only finite reason codes from arbitrary dependency reasons',async()=>{
 const record=await wal.enqueueIncoming(p('reason'));
 await incoming.processIncomingRecord(record,{saveIncomingMessage:async()=>({reason:body+token+phone}),shouldSkipOpenBot:async()=>false,forwardToOpenBot:async()=>({reason:body+token+phone})});
 const disk=JSON.parse(await fs.readFile(wal.__test.walPath(record.id),'utf8'));assert.equal(disk.pendingRedis,true);assert.equal(disk.pendingOpenBot,true);assert.equal(disk.attempts,1);safeLastError(disk.lastError);absent();
});
test('actual replay sanitizes legacy persisted error while preserving payload',async()=>{
 const record=await wal.enqueueIncoming(p('legacy'));
 await fs.writeFile(wal.__test.walPath(record.id),JSON.stringify({...record,lastError:body+phone+token}));
 const replay=await wal.enqueueIncoming(record.payload);assert.deepEqual(replay.payload,record.payload);safeLastError(replay.lastError);
 safeLastError(JSON.parse(await fs.readFile(wal.__test.walPath(record.id),'utf8')).lastError);
});
test('actual aged warning never discloses legacy error/attempt identity',async()=>{
 const record=await wal.enqueueIncoming(p('aged'));
 await fs.writeFile(wal.__test.walPath(record.id),JSON.stringify({...record,createdAt:1,lastError:body+phone+token,attempts:phone+token}));
 const rows=await wal.__test.readAllIncoming();assert.equal(rows.length,1);assert.equal(rows[0].pendingOpenBot,true);assert.ok(logs.length>0);absent();
});
test('actual enqueue IO fallback preserves volatile processing but uses safe diagnostics',async t=>{
 t.mock.method(fs,'writeFile',async()=>{throw error();});
 const result=await incoming.forwardIncomingWhatsAppMessage(p('enqueue'));
 assert.equal(result.durable,false);await waitFor(()=>logs.some(line=>line.includes('enqueue')||line.includes('ENQUEUE_FAILED')));absent();
});
test('actual background partial checkpoint error is caught with safe metadata',async t=>{
 const original=fs.writeFile;let writes=0;
 t.mock.method(fs,'writeFile',async function(file,...args){if(String(file).includes('.json.')&&++writes===2)throw error();return original.call(this,file,...args);});
 const result=await incoming.forwardIncomingWhatsAppMessage(p('background'));assert.equal(result.durable,true);
 await waitFor(()=>logs.some(line=>/BACKGROUND_DELIVERY_FAILED|background delivery failed/.test(line)));assert.ok(writes>=2);absent();
});
for(const stage of ['initial','periodic'])test('actual '+stage+' drain callback uses finite safe error metadata',async t=>{
 let reads=0;t.mock.method(fs,'readdir',async()=>{reads++;throw error();});
 t.mock.timers.enable({apis:['setInterval']});const timer=incoming.startIncomingWalWorker();t.after(()=>clearInterval(timer));
 await waitFor(()=>reads>=1);if(stage==='periodic'){logs.length=0;t.mock.timers.tick(5000);await waitFor(()=>reads>=2);}absent();
});
test('actual partial accepted enqueue failure blocks volatile fallback and transport',async t=>{
 const record=await wal.enqueueIncoming(p('partial-fail-closed'));record.pendingRedis=false;await wal.updateIncoming(record);
 let transports=0;t.mock.method(axios,'post',async()=>{transports++;return{status:200};});
 t.mock.method(fs,'writeFile',async()=>{throw error('EIO');});
 await assert.rejects(incoming.forwardIncomingWhatsAppMessage(record.payload),{code:'INCOMING_WAL_RECORD_WRITE_FAILED'});
 assert.equal(transports,0);absent();
});
