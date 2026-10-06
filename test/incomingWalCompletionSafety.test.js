'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),syncFs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process');
const filename=require.resolve('../services/incomingWal');
const payload=id=>({instanceId:'incoming-safety',messageId:id,phone:'77000000006',body:'synthetic private fixture',timestamp:1});
async function fixture(t){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'incoming-completion-'));
 const previous={};for(const key of ['WHATSPRO_INBOUND_WAL_DIR','WHATSPRO_INBOUND_WAL_MAX_AGE_MS','WHATSPRO_INBOUND_WAL_TOMBSTONE_TTL_MS'])previous[key]=process.env[key];
 process.env.WHATSPRO_INBOUND_WAL_DIR=dir;process.env.WHATSPRO_INBOUND_WAL_MAX_AGE_MS='60000';process.env.WHATSPRO_INBOUND_WAL_TOMBSTONE_TTL_MS='60000';
 delete require.cache[filename];const wal=require(filename);
 t.after(async()=>{delete require.cache[filename];delete require.cache[require.resolve('../services/incomingWebhook')];for(const[key,value]of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}await fs.rm(dir,{recursive:true,force:true});});
 return{dir,wal};
}
const exists=p=>fs.access(p).then(()=>true,()=>false);
const stored=(wal,id)=>fs.readFile(wal.__test.walPath(id),'utf8').then(JSON.parse);
function failWrites(t,kind){
 const original=fs.writeFile;t.mock.method(fs,'writeFile',async function(file,...args){
  if(String(file).includes('.'+kind+'.'))throw Object.assign(new Error('synthetic file failure'),{code:'EIO'});
  return original.call(this,file,...args);
 });
}
function failSync(t,dir,kind){
 const original=fs.open;let directorySyncs=0;
 t.mock.method(fs,'open',async function(file,...args){
  const handle=await original.call(this,file,...args),originalSync=handle.sync.bind(handle);
  handle.sync=async()=>{
   const name=String(file),directory=name===dir;if(directory)directorySyncs++;
   const failed=(kind==='record-file'&&name.includes('.json.'))||(kind==='marker-file'&&name.includes('.done.'))||
    (kind==='record-dir'&&directory&&directorySyncs===1)||(kind==='marker-dir'&&directory&&directorySyncs===2)||
    (kind==='remove-dir'&&directory&&directorySyncs===3);
   if(failed)throw Object.assign(new Error('synthetic sync failure'),{code:'EIO'});
   return originalSync();
  };return handle;
 });
}
function cold(dir,value){
 const script="const fs=require('node:fs/promises'),wal=require(process.argv[1]),p=JSON.parse(process.argv[2]);(async()=>{const id=wal.recordId(p),before=await fs.readFile(wal.__test.walPath(id),'utf8').then(JSON.parse).catch(()=>null);await wal.listIncoming();const replay=await wal.enqueueIncoming(p);process.stdout.write(JSON.stringify({before:before?[before.pendingRedis,before.pendingOpenBot]:null,blocked:replay===null,reset:replay?.pendingRedis===true||replay?.pendingOpenBot===true,marker:await wal.__test.hasTombstone(id)}));})().catch(e=>{process.stderr.write(e.code||e.name);process.exitCode=1;});";
 const result=spawnSync(process.execPath,['-e',script,filename,JSON.stringify(value)],{encoding:'utf8',env:{...process.env,WHATSPRO_INBOUND_WAL_DIR:dir}});
 assert.equal(result.status,0,'cold process must recover safely');return JSON.parse(result.stdout);
}
test('actual complete checkpoint, file/directory sync and marker precede intent deletion',async t=>{
 const{wal,dir}=await fixture(t),record=await wal.enqueueIncoming(payload('order')),events=[];
 const originalWrite=fs.writeFile,originalOpen=fs.open,originalUnlink=fs.unlink;
 t.mock.method(fs,'writeFile',async function(file,value,...args){const kind=String(file).includes('.done.')?'marker':'record';events.push(kind+'-write');if(kind==='record'){const data=JSON.parse(value);assert.equal(data.pendingRedis,false);assert.equal(data.pendingOpenBot,false);assert.ok(data.completedAt>0);}return originalWrite.call(this,file,value,...args);});
 t.mock.method(fs,'open',async function(file,...args){const handle=await originalOpen.call(this,file,...args),original=handle.sync.bind(handle);handle.sync=async()=>{events.push(String(file)===dir?'dir-sync':String(file).includes('.done.')?'marker-sync':'record-sync');return original();};return handle;});
 t.mock.method(fs,'unlink',async function(file,...args){if(String(file)===wal.__test.walPath(record.id))events.push('intent-delete');return originalUnlink.call(this,file,...args);});
 record.pendingRedis=false;record.pendingOpenBot=false;assert.equal(await wal.updateIncoming(record),null);
 assert.deepEqual(events,['record-write','record-sync','dir-sync','marker-write','marker-sync','dir-sync','intent-delete','dir-sync']);
 assert.equal(await wal.enqueueIncoming(payload('order')),null);
});
test('actual marker write fault retains completed flags/time/payload and rejects observably',async t=>{
 const{wal}=await fixture(t),p=payload('marker-write'),record=await wal.enqueueIncoming(p);
 record.pendingRedis=false;record.pendingOpenBot=false;record.attempts=7;failWrites(t,'done');
 await assert.rejects(wal.updateIncoming(record),{code:'INCOMING_WAL_COMPLETION_MARKER_FAILED'});
 const disk=await stored(wal,record.id);assert.equal(disk.pendingRedis,false);assert.equal(disk.pendingOpenBot,false);assert.ok(disk.completedAt>0);assert.deepEqual(disk.payload,p);assert.equal(disk.attempts,7);
 const replay=await wal.enqueueIncoming(p);assert.equal(replay.pendingRedis,false);assert.equal(replay.pendingOpenBot,false);assert.equal(replay.completedAt,disk.completedAt);
});
test('actual cold process repairs failed marker without resetting either delivered leg',async t=>{
 const{wal,dir}=await fixture(t),p=payload('cold'),record=await wal.enqueueIncoming(p);
 record.pendingRedis=false;record.pendingOpenBot=false;failWrites(t,'done');
 await assert.rejects(wal.updateIncoming(record));
 const result=cold(dir,p);assert.deepEqual(result.before,[false,false]);assert.equal(result.blocked,true);assert.equal(result.reset,false);assert.equal(result.marker,true);
});
test('actual aged completed backlog cannot disappear when marker fails',async t=>{
 const{wal}=await fixture(t),record=await wal.enqueueIncoming(payload('aged-fault'));
 await fs.writeFile(wal.__test.walPath(record.id),JSON.stringify({...record,createdAt:Date.now()-30*86400000,pendingRedis:false,pendingOpenBot:false}));
 failWrites(t,'done');t.mock.method(console,'warn',()=>{});
 const rows=await wal.__test.readAllIncoming();assert.equal(rows.length,1);assert.equal(await exists(wal.__test.walPath(record.id)),true);
 const replay=await wal.enqueueIncoming(record.payload);assert.equal(replay.pendingRedis,false);assert.equal(replay.pendingOpenBot,false);
});
test('actual aged legacy completion first gains a fresh durable dedup marker',async t=>{
 const{wal}=await fixture(t),record=await wal.enqueueIncoming(payload('aged-success'));
 await fs.writeFile(wal.__test.walPath(record.id),JSON.stringify({...record,createdAt:Date.now()-30*86400000,pendingRedis:false,pendingOpenBot:false}));
 const started=Date.now();assert.equal((await wal.__test.readAllIncoming()).length,0);
 const marker=JSON.parse(await fs.readFile(wal.__test.tombstonePath(record.id),'utf8'));assert.ok(marker.doneAt>=started);assert.equal(await wal.enqueueIncoming(record.payload),null);
});
for(const kind of ['json','record-file','record-dir'])test('actual '+kind+' checkpoint fault retains original intent and exposes unresolved IO boundary',async t=>{
 const{wal,dir}=await fixture(t),record=await wal.enqueueIncoming(payload(kind));
 if(kind==='json')failWrites(t,'json');else failSync(t,dir,kind);
 record.pendingRedis=false;record.pendingOpenBot=false;
 await assert.rejects(wal.updateIncoming(record),{code:'INCOMING_WAL_RECORD_WRITE_FAILED'});
 assert.equal(await exists(wal.__test.walPath(record.id)),true);assert.equal(await exists(wal.__test.tombstonePath(record.id)),false);
});
for(const kind of ['marker-file','marker-dir'])test('actual '+kind+' sync fault retains completed intent until durable marker repair',async t=>{
 const{wal,dir}=await fixture(t),record=await wal.enqueueIncoming(payload(kind));failSync(t,dir,kind);
 record.pendingRedis=false;record.pendingOpenBot=false;
 await assert.rejects(wal.updateIncoming(record),{code:'INCOMING_WAL_COMPLETION_MARKER_FAILED'});
 const disk=await stored(wal,record.id);assert.equal(disk.pendingRedis,false);assert.equal(disk.pendingOpenBot,false);
 assert.equal(await exists(wal.__test.walPath(record.id)),true);
});
test('actual intent unlink fault retains completion and dedup marker',async t=>{
 const{wal}=await fixture(t),record=await wal.enqueueIncoming(payload('unlink')),original=fs.unlink;
 t.mock.method(fs,'unlink',async function(file,...args){if(String(file)===wal.__test.walPath(record.id))throw Object.assign(new Error('synthetic unlink failure'),{code:'EIO'});return original.call(this,file,...args);});
 record.pendingRedis=false;record.pendingOpenBot=false;await assert.rejects(wal.updateIncoming(record),{code:'INCOMING_WAL_REMOVE_FAILED'});
 assert.equal((await stored(wal,record.id)).pendingRedis,false);assert.equal(await wal.enqueueIncoming(record.payload),null);
});
test('actual deletion directory-sync fault leaves proven marker protecting replay',async t=>{
 const{wal,dir}=await fixture(t),record=await wal.enqueueIncoming(payload('remove-sync'));failSync(t,dir,'remove-dir');
 record.pendingRedis=false;record.pendingOpenBot=false;await assert.rejects(wal.updateIncoming(record),{code:'INCOMING_WAL_REMOVE_FAILED'});
 assert.equal(await wal.__test.hasTombstone(record.id),true);assert.equal(await wal.enqueueIncoming(record.payload),null);
});
test('actual partial delivery preserves flags/payload/attempts over replay',async t=>{
 const{wal}=await fixture(t),p=payload('partial'),record=await wal.enqueueIncoming(p);
 record.pendingRedis=false;record.attempts=4;await wal.updateIncoming(record);
 const replay=await wal.enqueueIncoming(p);assert.equal(replay.pendingRedis,false);assert.equal(replay.pendingOpenBot,true);assert.equal(replay.attempts,4);assert.deepEqual(replay.payload,p);
});
test('actual stale update cannot reset a completed leg',async t=>{
 const{wal}=await fixture(t),record=await wal.enqueueIncoming(payload('stale')),stale={...record};
 record.pendingRedis=false;await wal.updateIncoming(record);await wal.updateIncoming(stale);
 const disk=await stored(wal,record.id);assert.equal(disk.pendingRedis,false);assert.equal(disk.pendingOpenBot,true);
});
test('actual cached worker record after durable completion calls neither delivery leg',async t=>{
 const{wal}=await fixture(t),record=await wal.enqueueIncoming(payload('cached')),stale={...record};
 record.pendingRedis=false;record.pendingOpenBot=false;await wal.updateIncoming(record);
 delete require.cache[require.resolve('../services/incomingWebhook')];const incoming=require('../services/incomingWebhook');let saves=0,forwards=0;
 await incoming.processIncomingRecord(stale,{saveIncomingMessage:async()=>{saves++;return{saved:true};},shouldSkipOpenBot:async()=>false,forwardToOpenBot:async()=>{forwards++;return{delivered:true};}});
 assert.equal(saves,0);assert.equal(forwards,0);assert.equal(await wal.enqueueIncoming(record.payload),null);
});
test('actual drain preserves active lease and continues another record after completion fault',async t=>{
 const{wal}=await fixture(t),done=await wal.enqueueIncoming(payload('drain-fault'));
 await fs.writeFile(wal.__test.walPath(done.id),JSON.stringify({...done,createdAt:1,pendingRedis:false,pendingOpenBot:false}));
 const pending=await wal.enqueueIncoming({...payload('drain-next'),type:'protocol',body:''});failWrites(t,'done');
 delete require.cache[require.resolve('../services/incomingWebhook')];const incoming=require('../services/incomingWebhook');
 for(const name of ['warn','error','log'])t.mock.method(console,name,()=>{});
 await incoming.drainIncomingWal();
 // Protocol noise is intentionally skipped by both real legs; the second completion checkpoint proves drain continuation.
 const disk=await stored(wal,pending.id);assert.equal(disk.attempts,1);assert.equal(disk.pendingOpenBot,false);assert.equal(disk.pendingRedis,false);
});
test('actual completed marker retention begins at completion rather than old creation',async t=>{
 const{wal}=await fixture(t),record=await wal.enqueueIncoming(payload('retention'));
 record.createdAt=Date.now()-30*86400000;record.pendingRedis=false;record.pendingOpenBot=false;await wal.updateIncoming(record);
 assert.equal(await wal.enqueueIncoming(record.payload),null);
 const markerFile=wal.__test.tombstonePath(record.id),marker=JSON.parse(await fs.readFile(markerFile,'utf8'));
 await fs.writeFile(markerFile,JSON.stringify({...marker,doneAt:Date.now()-120000}));
 assert.ok(await wal.enqueueIncoming(record.payload),'replay is allowed only after the existing dedup retention expires');
});
test('actual concurrent enqueue/checkpoint writes serialize and preserve false legs',async t=>{
 const{wal}=await fixture(t),record=await wal.enqueueIncoming(payload('race')),original=fs.writeFile;
 let release,enteredResolve;const entered=new Promise(r=>enteredResolve=r),blocked=new Promise(r=>release=r);let held=false,checkpointReached=false;
 t.mock.method(fs,'mkdir',async()=>{});
 t.mock.method(fs,'writeFile',async function(file,value,...args){
  if(String(file).includes('.json.')&&JSON.parse(value).pendingRedis===false)checkpointReached=true;
  if(!held&&String(file).includes('.json.')&&JSON.parse(value).pendingRedis===true){held=true;enteredResolve();await blocked;}
  return original.call(this,file,value,...args);
 });
 const enqueue=wal.enqueueIncoming(record.payload);await entered;record.pendingRedis=false;
 const checkpoint=wal.updateIncoming(record);await new Promise(r=>setTimeout(r,20));const reachedBeforeRelease=checkpointReached;release();await Promise.all([enqueue,checkpoint]);
 assert.equal(reachedBeforeRelease,false,'the same-ID checkpoint must wait for the earlier enqueue');
 assert.equal((await stored(wal,record.id)).pendingRedis,false);
});
test('actual worker releases same-ID lease after completion-marker failure without repeating accepted legs',async t=>{
 const{wal}=await fixture(t),record=await wal.enqueueIncoming(payload('lease-finally'));
 delete require.cache[require.resolve('../services/incomingWebhook')];const incoming=require('../services/incomingWebhook');let saves=0,forwards=0;
 const deps={saveIncomingMessage:async()=>{saves++;return{saved:true};},shouldSkipOpenBot:async()=>false,forwardToOpenBot:async()=>{forwards++;return{delivered:true};}};
 const stale={...record};failWrites(t,'done');await assert.rejects(incoming.processIncomingRecord(record,deps),{code:'INCOMING_WAL_COMPLETION_MARKER_FAILED'});
 assert.equal(saves,1);assert.equal(forwards,1);t.mock.restoreAll();
 await incoming.processIncomingRecord(stale,deps);assert.equal(saves,1);assert.equal(forwards,1);
 assert.equal(await wal.enqueueIncoming(record.payload),null,'finally must release lease so the marker is repaired');
});
test('actual worker unreadable durable state blocks both legs and releases lease for repair',async t=>{
 const{wal}=await fixture(t),record=await wal.enqueueIncoming(payload('read-fault')),original=fs.readFile;
 delete require.cache[require.resolve('../services/incomingWebhook')];const incoming=require('../services/incomingWebhook');let saves=0,forwards=0;
 const deps={saveIncomingMessage:async()=>{saves++;return{saved:true};},shouldSkipOpenBot:async()=>false,forwardToOpenBot:async()=>{forwards++;return{delivered:true};}};
 t.mock.method(fs,'readFile',async function(file,...args){if(String(file)===wal.__test.walPath(record.id))throw Object.assign(new Error('synthetic unreadable checkpoint'),{code:'EIO'});return original.call(this,file,...args);});
 await assert.rejects(incoming.processIncomingRecord(record,deps),{code:'INCOMING_WAL_READ_FAILED'});assert.equal(saves,0);assert.equal(forwards,0);
 t.mock.restoreAll();await incoming.processIncomingRecord(record,deps);assert.equal(saves,1);assert.equal(forwards,1);
});
test('actual same-ID concurrent worker has one lease and one execution of each pending leg',async t=>{
 const{wal}=await fixture(t),record=await wal.enqueueIncoming(payload('worker-race'));
 delete require.cache[require.resolve('../services/incomingWebhook')];const incoming=require('../services/incomingWebhook');let saves=0,forwards=0,release,enteredResolve;
 const entered=new Promise(r=>enteredResolve=r),wait=new Promise(r=>release=r);
 const deps={saveIncomingMessage:async()=>{saves++;enteredResolve();await wait;return{saved:true};},shouldSkipOpenBot:async()=>false,forwardToOpenBot:async()=>{forwards++;return{delivered:true};}};
 const first=incoming.processIncomingRecord(record,deps);await entered;await incoming.processIncomingRecord({...record},deps);release();await first;
 assert.equal(saves,1);assert.equal(forwards,1);assert.equal(await wal.enqueueIncoming(record.payload),null);
});
test('actual unreadable tombstone fails closed instead of resetting completed delivery',async t=>{
 const{wal}=await fixture(t),record=await wal.enqueueIncoming(payload('corrupt-marker'));record.pendingRedis=false;record.pendingOpenBot=false;await wal.updateIncoming(record);
 await fs.writeFile(wal.__test.tombstonePath(record.id),'invalid fixture');
 await assert.rejects(wal.enqueueIncoming(record.payload),{code:'INCOMING_WAL_READ_FAILED'});
 assert.equal(await exists(wal.__test.walPath(record.id)),false);
});
test('actual private Redis chat history and cold worker preserve completed legs after marker failure',{
 skip:!process.env.INCOMING_COMPLETION_REDIS_SOCKET
},async t=>{
 const{wal,dir}=await fixture(t),{createClient}=require('redis'),{createChatStore}=require('../services/chatStore');
 const client=createClient({socket:{path:process.env.INCOMING_COMPLETION_REDIS_SOCKET,reconnectStrategy:false},disableOfflineQueue:true});client.on('error',()=>{});
 await client.connect();const store=createChatStore(client);
 const p={...payload('redis-cold'),instanceId:'incoming-private-'+require('node:crypto').randomUUID(),timestamp:Math.floor(Date.now()/1000)},record=await wal.enqueueIncoming(p);
 t.after(async()=>{const ownedKeys=await client.keys('*:'+p.instanceId+'*');if(ownedKeys.length)await client.del(ownedKeys);await client.quit();});
 delete require.cache[require.resolve('../services/incomingWebhook')];const incoming=require('../services/incomingWebhook');let forwards=0;
 const deps={saveIncomingMessage:value=>incoming.saveIncomingMessage(value,{store,redisOpen:true,isPhoneAllowed:async()=>true,publishEvent:async()=>{}}),shouldSkipOpenBot:async()=>false,forwardToOpenBot:async()=>{forwards++;return{delivered:true};}};
 failWrites(t,'done');await assert.rejects(incoming.processIncomingRecord(record,deps),{code:'INCOMING_WAL_COMPLETION_MARKER_FAILED'});
 assert.equal((await store.getHistory(p.instanceId,p.phone)).length,1);assert.equal(forwards,1);
 const incomingFilename=require.resolve('../services/incomingWebhook');
 const script="const fs=require('node:fs/promises'),wal=require(process.argv[1]),incoming=require(process.argv[2]),p=JSON.parse(process.argv[3]);(async()=>{const before=JSON.parse(await fs.readFile(wal.__test.walPath(wal.recordId(p)),'utf8'));let legs=0;await incoming.processIncomingRecord({...before,pendingRedis:true,pendingOpenBot:true},{saveIncomingMessage:async()=>{legs++;throw Error('must not resend');},shouldSkipOpenBot:async()=>false,forwardToOpenBot:async()=>{legs++;throw Error('must not resend');}});const replay=await wal.enqueueIncoming(p);process.stdout.write(JSON.stringify({legs,blocked:replay===null,flags:[before.pendingRedis,before.pendingOpenBot]}));})().catch(e=>{process.stderr.write(e.code||e.name);process.exitCode=1;});";
 const child=spawnSync(process.execPath,['-e',script,filename,incomingFilename,JSON.stringify(p)],{encoding:'utf8',env:{...process.env,WHATSPRO_INBOUND_WAL_DIR:dir}});
 assert.equal(child.status,0);assert.deepEqual(JSON.parse(child.stdout),{legs:0,blocked:true,flags:[false,false]});
 assert.equal((await store.getHistory(p.instanceId,p.phone)).length,1);assert.equal(forwards,1);
});
