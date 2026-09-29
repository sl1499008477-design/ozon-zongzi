import './support/dedicated-postgres-test-environment.mjs';
import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {readFile,mkdtemp,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import sharp from 'sharp';
import {getPostgresPool,closePostgresPool} from '../db/connection.mjs';
import {runMigrations} from '../db/migrate.mjs';
import * as collector from '../collector-desktop-service.mjs';
import {createCollectorHttpHandler} from '../collector-routes.mjs';
import {addSelectedCollectorItemsToCollectBox} from '../collector-selection-service.mjs';
import {ingestCollectRequestV4} from '../collection-pipeline.mjs';
import {listCollectItemsV3,updateCollectItemDraftV4} from '../listing-pipeline.mjs';
import {buildAiListingSource} from '../ai-listing-runtime.mjs';
import {prepareAiListingItems} from '../ai-listing-submission.mjs';
import {normalizeOzonImportItems} from '../ozon-import-normalizer.mjs';
import {createOzonListingMedia} from '../ozon-listing-media.mjs';
import {listCollectorMedia,loadCollectorMediaForPublication} from '../collector-media-upload.mjs';
import {collectorMediaFixture} from './support/collector-media-fixture.mjs';
import {prepareCollectorMedia,prepareCollectorMediaFile,uploadCollectorMedia} from '../../desktop/dist-electron/services/collection/media-preparer.services.js';

const enabled=process.env.SONLI_POSTGRES_TESTS==='1'&&!!process.env.SONLI_MIGRATION_TEST_DATABASE_URL;
const options={skip:!enabled,timeout:120_000};let pool;
before(async()=>{if(enabled){assert.equal(new URL(process.env.DATABASE_URL).pathname,'/ozon_media_direct_test');pool=await getPostgresPool();await runMigrations(pool);}});
after(async()=>{if(enabled)await closePostgresPool();});
async function fixture(t){
  const suffix=randomUUID(),accountId='media-'+suffix,otherAccountId='other-'+suffix,runId='run-'+suffix,deviceId='device-'+suffix,taskId='task-'+suffix,leaseToken=randomUUID();
  await pool.query("INSERT INTO accounts(id,username,role,status) VALUES($1,$1,'user','active'),($2,$2,'user','active')",[accountId,otherAccountId]);
  await pool.query('INSERT INTO collector_devices(id,account_id,device_key) VALUES($1,$2,$1)',[deviceId,accountId]);
  await pool.query("INSERT INTO collector_tasks(id,account_id,task_type,status) VALUES($1,$2,'MARKET','RUNNING')",[taskId,accountId]);
  await pool.query(`INSERT INTO collector_task_runs(id,task_id,account_id,run_no,status,configuration_snapshot,claimed_by_device_id,lease_token_hash,lock_expires_at)
    VALUES($1,$2,$3,1,'RUNNING',$4,$5,$6,NOW()+INTERVAL '5 minutes')`,[runId,taskId,accountId,{configuration:{captureScope:'CURRENT'}},deviceId,createHash('sha256').update(leaseToken).digest('hex')]);
  await pool.query('UPDATE collector_tasks SET current_run_id=$2 WHERE id=$1',[taskId,runId]);
  t.after(async()=>{
    for(const table of ['product_restriction_events','collector_ozon_enrichment_jobs','collect_requests','collect_raw_payloads','collect_items'])await pool.query(`DELETE FROM ${table} WHERE account_id=ANY($1::text[])`,[[accountId,otherAccountId]]);
    await pool.query('UPDATE collector_tasks SET current_run_id=NULL WHERE account_id=$1',[accountId]);
    await pool.query('DELETE FROM collector_task_runs WHERE account_id=$1',[accountId]);await pool.query('DELETE FROM collector_tasks WHERE account_id=$1',[accountId]);
    await pool.query('DELETE FROM collector_devices WHERE id=$1',[deviceId]);await pool.query('DELETE FROM accounts WHERE id=ANY($1::text[])',[[accountId,otherAccountId]]);
  });
  return {accountId,otherAccountId,runId,deviceId,taskId,leaseToken};
}
const expectation=(bytes,extra={})=>({sourceSku:'9100199911',purpose:'color',index:0,sourceUrl:'https://media.example/color.png',size:bytes.length,contentType:'image/png',md5:createHash('md5').update(bytes).digest('base64'),...extra});
const upload=async(ticket,bytes)=>{const response=await fetch(ticket.url,{method:'PUT',headers:ticket.headers,body:bytes});assert.equal(response.status,200);};

async function retryRun(scope,configuration={retryFromRunId:scope.runId,captureScope:'CURRENT'}){
  const task=await collector.createCollectorTask({accountId:scope.accountId,name:'Media retry fixture',taskType:'MARKET',configuration});
  const created=await collector.queueCollectorTaskRun({accountId:scope.accountId,taskId:task.id});
  const claim=await collector.claimCollectorRun({accountId:scope.accountId,runId:created.run.id,device:{deviceId:scope.deviceId},leaseSeconds:120});
  return {...scope,taskId:task.id,runId:created.run.id,leaseToken:claim.leaseToken};
}

test('a new leased retry restores only its failed predecessor intents and preserves pinned versions through V4',options,async t=>{
  const scope=await fixture(t),f=await collectorMediaFixture(t),service=collector.createCollectorRunMediaUploads({storage:f.storage});
  const bytes=await sharp({create:{width:9,height:12,channels:3,background:'#abc'}}).png().toBuffer();
  const expected=expectation(bytes),ticket=await service.issue({...scope,...expected});await upload(ticket,bytes);
  const original=(await service.confirm({...scope,uploadId:ticket.uploadId})).mediaObject;
  const second=expectation(bytes,{purpose:'rich-image',sourceUrl:'https://media.example/rich.png'}),unknown=await service.issue({...scope,...second});await upload(unknown,bytes);
  const raw={sku:expected.sourceSku,name:'Тестовый товар',images:['https://media.example/main.jpg'],price:'100',currencyCode:'CNY',color_image:expected.sourceUrl,
    richContent:JSON.stringify({img:{src:second.sourceUrl}}),mediaObjects:[original],mediaIntents:[{...second,uploadId:unknown.uploadId}]};
  await assert.rejects(collector.upsertCollectorRunItem({...scope,item:{source:'ozon',sourceKey:raw.sku,sourceSku:raw.sku,status:'FAILED',rawPayload:{...raw,mediaIntents:[{...raw.mediaIntents[0],size:999}]}}}),{code:'COLLECTOR_MEDIA_REFERENCE_TAMPERED'});
  const failed=(await collector.upsertCollectorRunItem({...scope,item:{source:'ozon',sourceKey:raw.sku,sourceSku:raw.sku,status:'FAILED',errorCode:'COLLECTOR_MEDIA_WAITING',rawPayload:raw}})).item;
  assert.equal(failed.rawPayload.mediaIntents[0].uploadId,unknown.uploadId);
  await assert.rejects(retryRun(scope),{code:'COLLECTOR_RUN_ACTIVE'});
  await collector.completeCollectorRun(scope);
  const next=await retryRun(scope),resume={...expected,resumeUploadId:ticket.uploadId,previousItemId:failed.id};
  await assert.rejects(ingestCollectRequestV4({authenticatedAccount:{id:scope.accountId},input:{source:'ozon',sourceSku:raw.sku,requestId:randomUUID(),
    payload:{...raw,mediaRecovery:{runId:scope.runId,itemId:failed.id},collectorRunId:next.runId,collectorItemId:'unleased-recovery'}}}),
  {code:'COLLECTOR_MEDIA_REFERENCE_SCOPE'},'V4 consumption without a live lease cannot transfer predecessor references');
  await assert.rejects(service.issue({...next,...resume,previousItemId:'forged-item'}),{code:'COLLECTOR_MEDIA_RECOVERY_SCOPE'});
  await assert.rejects(service.issue({...next,...resume,sourceUrl:'https://media.example/forged.png'}),{code:'COLLECTOR_MEDIA_REFERENCE_TAMPERED'});
  const unrelated=await retryRun(scope,{captureScope:'CURRENT'});
  await assert.rejects(service.issue({...unrelated,...resume}),{code:'COLLECTOR_MEDIA_RECOVERY_SCOPE'});
  await assert.rejects(service.issue({...next,...resume,accountId:scope.otherAccountId}),{code:'COLLECTOR_RUN_NOT_FOUND'});
  const restored=await service.issue({...next,...resume});assert.equal(restored.confirmed,true);assert.deepEqual(restored.mediaObject,original);
  assert.equal((await service.issue({...next,...resume})).uploadId,ticket.uploadId);
  const competing=await retryRun(scope);await assert.rejects(service.issue({...competing,...resume}),{code:'COLLECTOR_MEDIA_RECOVERY_SCOPE'});
  await pool.query("UPDATE collector_media_uploads SET expires_at=NOW()-INTERVAL '1 second' WHERE id=$1",[unknown.uploadId]);
  const pending=await service.issue({...next,...second,resumeUploadId:unknown.uploadId,previousItemId:failed.id});assert.equal(pending.uploadId,unknown.uploadId);
  await pool.query("UPDATE collector_task_runs SET lock_expires_at=NOW()-INTERVAL '1 second' WHERE id=$1",[next.runId]);
  const claim=await collector.claimCollectorRun({accountId:next.accountId,runId:next.runId,device:{deviceId:next.deviceId},leaseSeconds:120});
  await assert.rejects(service.confirm({...next,uploadId:unknown.uploadId}),{code:'COLLECTOR_RUN_LEASE_MISMATCH'});next.leaseToken=claim.leaseToken;
  await assert.rejects(service.issue({...next,...second,resumeUploadId:unknown.uploadId}),{code:'COLLECTOR_MEDIA_CLAIM_MISMATCH'});
  await service.issue({...next,...resume});await service.issue({...next,...second,resumeUploadId:unknown.uploadId,previousItemId:failed.id});
  const recovered=(await service.confirm({...next,uploadId:unknown.uploadId})).mediaObject;
  assert.equal((await service.issue({...next,...second,resumeUploadId:unknown.uploadId})).confirmed,true,'same-claim intent recovery is idempotent');
  assert.equal(f.calls.filter(c=>c.method==='PUT').length,2,'recovery confirms existing bytes without another PUT');
  const saved=(await collector.upsertCollectorRunItem({...next,item:{source:'ozon',sourceKey:raw.sku,sourceSku:raw.sku,status:'QUALIFIED',rawPayload:{...raw,mediaObjects:[restored.mediaObject,recovered],mediaIntents:[]}}})).item;
  await collector.completeCollectorRun(next);
  const handoff=await addSelectedCollectorItemsToCollectBox({accountId:scope.accountId,runId:next.runId,itemIds:[saved.id]});assert.equal(handoff.errors.length,0,JSON.stringify(handoff.errors));
  const collect=(await listCollectItemsV3({accountId:scope.accountId,ids:[handoff.results[0].collectItemId]}))[0];
  assert.equal(collect.listingDraft.mediaObjects.length,2);assert.equal(collect.listingDraft.mediaObjects[0].versionId,original.versionId);
  const bound=(await pool.query('SELECT run_id,collector_item_id,collect_item_id FROM collector_media_uploads WHERE account_id=$1',[scope.accountId])).rows;
  assert.ok(bound.every(row=>row.run_id===next.runId&&row.collector_item_id===saved.id&&row.collect_item_id===collect.id));
});

test('actual failed retries preserve uploaded objects when a committed recovery response is lost',options,async t=>{
  const scope=await fixture(t),bytes=await sharp({create:{width:18,height:24,channels:3,background:'#bcd'}}).png().toBuffer();
  const sources=new Map([['source/color.png',bytes],['source/rich.png',bytes]]),f=await collectorMediaFixture(t,{sources});
  const media=collector.createCollectorRunMediaUploads({storage:f.storage});
  const profile=await mkdtemp(join(tmpdir(),'media-actual-retry-'));t.after(()=>rm(profile,{recursive:true,force:true}));
  const product={sku:'9100199911',name:'Тестовый товар',images:['https://media.example/main.jpg'],price:'100',currencyCode:'CNY',
    color_image:'https://media.example/source/color.png',richContent:JSON.stringify({img:{src:'https://media.example/source/rich.png'}})};
  const handler=createCollectorHttpHandler({authenticate:async()=>({id:scope.accountId}),service:{...collector,
    issueCollectorRunMediaUpload:input=>media.issue(input),confirmCollectorRunMediaUpload:input=>media.confirm(input)},
    sendJson:(res,status,payload)=>Object.assign(res,{status,payload})});
  const desktop=new URL('../../desktop/',import.meta.url);
  const script=`
    import assert from 'node:assert/strict';import {request as httpRequest} from 'node:http';
    import {dialog} from 'electron';
    import {operationStore} from ${JSON.stringify(new URL('dist-electron/store/index.js',desktop).href)};
    import {Collection} from ${JSON.stringify(new URL('dist-electron/services/collection/collection.services.js',desktop).href)};
    import {prepareCollectorMediaFile,uploadCollectorMedia,createCollectorMediaWorkQueue} from ${JSON.stringify(new URL('dist-electron/services/collection/media-preparer.services.js?fixture-real',desktop).href)};
    import {createCollectorFailedRetry,createCollectorRun,claimCollectorRun,completeCollectorRun,listCollectorOutcomeItems} from ${JSON.stringify(new URL('dist-electron/services/collector-backend.services.js',desktop).href)};
    const scope=JSON.parse(process.env.COLLECTOR_MEDIA_REVIEW_SCOPE),product=${JSON.stringify(product)},base=${JSON.stringify(f.base)};
    operationStore.set('desktop-device-id',scope.deviceId);dialog.showMessageBox=async()=>({response:0});
    const pending=new Map();let sequence=0,downloads=0,puts=0,activeRunId=scope.runId;
    process.on('message',message=>{const waiter=pending.get(message.id);if(!waiter)return;pending.delete(message.id);message.status>=400?waiter.reject(Object.assign(Error(message.payload.error),{code:message.payload.code,response:{status:message.status,data:message.payload}})):waiter.resolve({data:message.payload});});
    globalThis.__DESKTOP_AXIOS_HANDLER__=config=>new Promise((resolve,reject)=>{const id=++sequence;pending.set(id,{resolve,reject});process.send({id,request:{method:config.method,url:config.url,data:config.data,params:config.params}});});
    const request=(url,options,callback)=>httpRequest(new URL(url.pathname+url.search,base),{...options,lookup:undefined},callback);
    globalThis.__COLLECTOR_MEDIA_IO__={prepareFile:async(source,options)=>{downloads++;return prepareCollectorMediaFile(source,{...options,temporaryRoot:process.env.DESKTOP_TEST_USER_DATA,request,lookupHost:async()=>[{address:'8.8.8.8',family:4}]});},
      upload:async(ticket,file,options)=>{const checkpoint=(await listCollectorOutcomeItems(activeRunId,'FAILED'))[0];
        assert.ok(checkpoint?.rawPayload.mediaIntents.some(intent=>intent.uploadId===ticket.uploadId),'upload intent must be durable on the failed item before its first PUT');
        puts++;await uploadCollectorMedia({...ticket,url:ticket.url.replace('http:','https:')},file,{...options,request});
        if(puts===2){process.send({done:{crashedAfterPut:true,downloads,puts}},()=>process.exit(0));await new Promise(()=>{});}
      }};
    if(process.env.COLLECTOR_MEDIA_FIXTURE_PHASE==='normal'){
      const normal=new Collection({_id:scope.taskId,taskName:'正常检查点',targetCount:10},null,{runMediaWork:createCollectorMediaWorkQueue({concurrency:1}).run});
      normal.runId=scope.runId;normal.leaseToken=scope.leaseToken;normal.capabilities={mediaDirectUploadV1:true,exportDataFromRaw:true};normal.outputLog=()=>{};
      const payload={...product,sku:'9100199922',richContent:''};await normal.selectNewCandidates([{id:payload.sku}]);
      assert.equal(await normal.persistRunItem(payload),true);
      const rows=await listCollectorOutcomeItems(scope.runId,'QUALIFIED');assert.equal(rows.length,1);assert.equal(rows[0].errorCode,'');assert.equal(rows[0].errorMessage,'');
      assert.equal((await listCollectorOutcomeItems(scope.runId,'FAILED')).length,0);
      process.send({done:{normal:true,downloads,puts}},()=>process.exit(0));await new Promise(()=>{});
    }
    if(process.env.COLLECTOR_MEDIA_FIXTURE_PHASE==='initial'){
      const first=new Collection({_id:scope.taskId,taskName:'初次采集',targetCount:10},null,{runMediaWork:createCollectorMediaWorkQueue({concurrency:1}).run});
      first.runId=scope.runId;first.leaseToken=scope.leaseToken;first.capabilities={mediaDirectUploadV1:true,exportDataFromRaw:true};first.outputLog=()=>{};
      assert.equal((await first.selectNewCandidates([{id:product.sku}])).length,1);
      await first.persistRunItem(structuredClone(product));throw Error('fixture must exit between PUT and confirmation');
    }
    const old=(await listCollectorOutcomeItems(scope.runId,'FAILED'))[0];assert.equal(old.rawPayload.mediaObjects.length,1);
    assert.equal(old.rawPayload.mediaIntents.length,1);
    assert.equal(JSON.stringify(old.rawPayload).includes('q-signature'),false);
    const task=await createCollectorFailedRetry({taskId:scope.taskId,runId:scope.runId});assert.equal(task.retryFromRunId,scope.runId);
    const run=await createCollectorRun(task._id||task.id),claim=await claimCollectorRun(run.id);assert.equal(claim.run.configurationSnapshot.configuration.retryFromRunId,scope.runId);
    activeRunId=run.id;const faulty=process.env.COLLECTOR_MEDIA_FIXTURE_PHASE==='retry-fault';const retry=new Collection(task,null,{runMediaWork:createCollectorMediaWorkQueue({concurrency:1}).run});retry.runId=run.id;retry.leaseToken=claim.leaseToken;retry.capabilities={mediaDirectUploadV1:true,exportDataFromRaw:true};retry.outputLog=()=>{};
    retry.processData=async items=>{assert.deepEqual(items.map(item=>item.id),[product.sku]);assert.equal(await retry.persistRunItem(structuredClone(product)),!faulty);};
    await retry.retryFailedProducts();assert.equal(downloads,0);assert.equal(puts,0);
    const saved=(await listCollectorOutcomeItems(run.id,faulty?'FAILED':'QUALIFIED'))[0];assert.equal(saved.rawPayload.mediaObjects.length,faulty?1:2);assert.equal(saved.rawPayload.mediaIntents.length,faulty?1:0);
    assert.deepEqual(saved.rawPayload.mediaRecovery,{runId:scope.runId,itemId:old.id});await completeCollectorRun(run.id,claim.leaseToken);
    process.send({done:{taskId:task._id||task.id,runId:run.id,itemId:saved.id,downloads,puts,uploadIds:saved.rawPayload.mediaObjects.map(ref=>ref.uploadId)}});process.disconnect();
  `;
  async function runDesktop(phase,currentScope=scope){
    const child=spawn(process.execPath,['--loader',fileURLToPath(new URL('tests/fixtures/desktop-module-loader.mjs',desktop)),
    '--loader',fileURLToPath(new URL('tests/fixtures/collector-media-loader.mjs',desktop)),'--input-type=module','-e',script],
    {stdio:['ignore','pipe','pipe','ipc'],env:{...process.env,DESKTOP_TEST_USER_DATA:profile,DESKTOP_TEST_REAL_EXCEL:'1',COLLECTOR_MEDIA_FIXTURE_PHASE:phase,COLLECTOR_MEDIA_REVIEW_SCOPE:JSON.stringify(currentScope)}});
  t.after(()=>child.kill());
  let output='',done;child.stdout.on('data',chunk=>{output+=chunk;});child.stderr.on('data',chunk=>{output+=chunk;});
  child.on('message',async message=>{
    if(message.done){done=message.done;return;}
    const res={};try{const request=message.request,url=new URL(request.url,'http://fixture');for(const [key,value] of Object.entries(request.params||{}))url.searchParams.set(key,value);
      await handler({method:request.method.toUpperCase(),url:url.pathname+url.search,body:request.data||{}},res);
      if(phase==='retry-fault'&&request.data?.resumeUploadId&&request.data?.purpose==='rich-image'&&res.status<400){
        child.send({id:message.id,status:503,payload:{error:'test simulated response lost after committed takeover',code:'ETIMEDOUT'}});
      }else child.send({id:message.id,status:res.status,payload:res.payload});
    }catch(error){child.send({id:message.id,status:500,payload:{error:error.message,code:error.code}});}
  });
    const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});assert.equal(code,0,output);assert.ok(done);return done;
  }
  const normal=await runDesktop('normal');assert.deepEqual(normal,{normal:true,downloads:1,puts:1});
  const counters=await collector.getCollectorRunForAccount(scope.accountId,scope.runId);assert.equal(counters.qualifiedCount,1);assert.equal(counters.failedCount,0);
  const crashed=await runDesktop('initial');assert.deepEqual(crashed,{crashedAfterPut:true,downloads:2,puts:2});
  const old=(await collector.listCollectorRunItems({accountId:scope.accountId,runId:scope.runId,status:'FAILED'}))[0];
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM collector_sku_claims WHERE account_id=$1 AND run_id=$2',[scope.accountId,scope.runId])).rows[0].count,1,'an active media checkpoint must retain its SKU claim');
  const premature=await addSelectedCollectorItemsToCollectBox({accountId:scope.accountId,runId:scope.runId,itemIds:[old.id]});assert.equal(premature.results.length,0);assert.equal(premature.ok,false);
  const uncertain=(await pool.query('SELECT confirmed_object FROM collector_media_uploads WHERE id=$1',[old.rawPayload.mediaIntents[0].uploadId])).rows[0];assert.equal(uncertain.confirmed_object,null);
  await collector.completeCollectorRun(scope);
  const lost=await runDesktop('retry-fault');
  const transferred=(await pool.query('SELECT run_id,collector_item_id,confirmed_object FROM collector_media_uploads WHERE id=$1',[old.rawPayload.mediaIntents[0].uploadId])).rows[0];
  assert.equal(transferred.run_id,lost.runId);assert.ok(transferred.collector_item_id);assert.equal(transferred.confirmed_object,null);
  const done=await runDesktop('retry-again',{...scope,runId:lost.runId,taskId:lost.taskId});
  assert.equal(done.downloads,0);assert.equal(done.puts,0);assert.equal(f.calls.filter(c=>c.method==='PUT'&&!c.copy).length,3);
  assert.equal(f.calls.filter(c=>c.method==='GET'&&c.key.startsWith('source/')).length,3);
  const handoff=await addSelectedCollectorItemsToCollectBox({accountId:scope.accountId,runId:done.runId,itemIds:[done.itemId]});assert.equal(handoff.errors.length,0,JSON.stringify(handoff.errors));
  const collect=(await listCollectItemsV3({accountId:scope.accountId,ids:[handoff.results[0].collectItemId]}))[0];assert.deepEqual(collect.listingDraft.mediaObjects.map(ref=>ref.uploadId),done.uploadIds);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM collector_task_items WHERE run_id=$1 AND status='QUALIFIED'",[done.runId])).rows[0].count,1);
  console.log(JSON.stringify({actualFailedRetry:true,lostCommittedTakeoverResponse:true,downloads:crashed.downloads,puts:crashed.puts,extraDownloads:done.downloads,extraPuts:done.puts,v4References:collect.listingDraft.mediaObjects.length}));
});

test('real lease boundaries, checked bytes, replay pinning and claim changes cannot replace a confirmed intent',options,async t=>{
  const scope=await fixture(t),f=await collectorMediaFixture(t),service=collector.createCollectorRunMediaUploads({storage:f.storage});
  const bytes=await sharp({create:{width:8,height:8,channels:3,background:'#fff'}}).png().toBuffer(),expected=expectation(bytes);
  await assert.rejects(service.issue({...scope,...expected,accountId:scope.otherAccountId}),{code:'COLLECTOR_RUN_NOT_FOUND'});
  await assert.rejects(service.issue({...scope,...expected,leaseToken:'old-lease'}),{code:'COLLECTOR_RUN_LEASE_MISMATCH'});
  const ticket=await service.issue({...scope,...expected});assert.equal((await service.issue({...scope,...expected})).uploadId,ticket.uploadId);
  await assert.rejects(service.confirm({...scope,uploadId:ticket.uploadId}),{code:'COLLECTOR_MEDIA_NOT_UPLOADED'});
  await upload(ticket,bytes);const first=(await service.confirm({...scope,uploadId:ticket.uploadId})).mediaObject;
  assert.equal(first.validation,'sharp-full-decode-v1');assert.equal(first.validationBytes,bytes.length);
  await upload(ticket,bytes);assert.notEqual((await f.storage.headCollectorObject({key:ticket.key})).versionId,first.versionId);
  assert.deepEqual((await service.confirm({...scope,uploadId:ticket.uploadId})).mediaObject,first);
  const tampered={sku:expected.sourceSku,color_image:expected.sourceUrl,mediaObjects:[{...first,sourceUrl:'https://media.example/changed.png'}]};
  await assert.rejects(collector.upsertCollectorRunItem({...scope,item:{source:'ozon',sourceKey:expected.sourceSku,sourceSku:expected.sourceSku,status:'QUALIFIED',rawPayload:tampered}}),{code:'COLLECTOR_MEDIA_REFERENCE_TAMPERED'});
  await assert.rejects(collector.upsertCollectorRunItem({...scope,item:{source:'ozon',sourceKey:'different',sourceSku:'different',status:'QUALIFIED',rawPayload:{...tampered,sku:'different',mediaObjects:[first]}}}),{code:'COLLECTOR_MEDIA_REFERENCE_TAMPERED'});
  const savedItem={source:'ozon',sourceKey:expected.sourceSku,sourceSku:expected.sourceSku,status:'QUALIFIED',rawPayload:{sku:expected.sourceSku,color_image:expected.sourceUrl,mediaObjects:[first]}};
  const originalItem=await collector.upsertCollectorRunItem({...scope,item:savedItem});
  const bogus=await service.issue({...scope,...expected,purpose:'rich-image',sourceUrl:'https://media.example/bogus.png'});
  f.save(bogus.key,Buffer.from('not the signed body'),'image/png');
  await assert.rejects(service.confirm({...scope,uploadId:bogus.uploadId}),{code:'COLLECTOR_MEDIA_CHECKSUM_MISMATCH'});
  const html=Buffer.from('<html>not an image</html>'),badFormat=await service.issue({...scope,...expectation(html,{index:1})});
  await upload(badFormat,html);await assert.rejects(service.confirm({...scope,uploadId:badFormat.uploadId}),{code:'COLLECTOR_MEDIA_FORMAT_INVALID'});
  await pool.query("UPDATE collector_task_runs SET lock_expires_at=NOW()-INTERVAL '1 second' WHERE id=$1",[scope.runId]);
  await assert.rejects(service.confirm({...scope,uploadId:ticket.uploadId}),{code:'COLLECTOR_RUN_LEASE_EXPIRED'});
  const newer=await collector.claimCollectorRun({accountId:scope.accountId,runId:scope.runId,device:{deviceId:scope.deviceId},leaseSeconds:120});
  await assert.rejects(service.confirm({...scope,leaseToken:newer.leaseToken,uploadId:ticket.uploadId}),{code:'COLLECTOR_MEDIA_CLAIM_MISMATCH'});
  const resumed=await collector.upsertCollectorRunItem({...scope,leaseToken:newer.leaseToken,item:{...savedItem,status:'QUALIFIED'}});
  assert.equal(resumed.item.id,originalItem.item.id,'a new authorized claim may reuse the immutable reference already saved on this exact item');
  assert.deepEqual((await pool.query('SELECT confirmed_object FROM collector_media_uploads WHERE id=$1',[ticket.uploadId])).rows[0].confirmed_object.versionId,first.versionId);
});

test('desktop native stream and real ffprobe → signed SDK fixture → completed-run V4 → immutable media copies',{
  ...options,skip:!enabled||!process.env.COLLECTOR_MEDIA_TEST_VIDEO||!process.env.COLLECTOR_MEDIA_FFPROBE_PATH},async t=>{
  const scope=await fixture(t),bytes=await sharp({create:{width:16,height:24,channels:3,background:'#0088ff'}}).png().toBuffer();
  const video=await readFile(process.env.COLLECTOR_MEDIA_TEST_VIDEO),sources=new Map();
  const cover=await readFile(process.env.COLLECTOR_MEDIA_TEST_COVER_VIDEO||process.env.COLLECTOR_MEDIA_TEST_VIDEO);
  for(const key of ['color.png','poster.png','rich.png','rich-poster.png','hero.png'])sources.set('source/'+key,bytes);
  for(const key of ['main.mp4','rich.mp4'])sources.set('source/'+key,video);
  sources.set('source/cover.mp4',cover);
  const f=await collectorMediaFixture(t,{sources}),service=collector.createCollectorRunMediaUploads({storage:f.storage});
  const permissions=[];
  async function route(path,body){let response;
    const handler=createCollectorHttpHandler({authenticate:async(_req,permission)=>(permissions.push(permission),{id:scope.accountId}),
      service:{...collector,issueCollectorRunMediaUpload:input=>service.issue(input),confirmCollectorRunMediaUpload:input=>service.confirm(input)},
      sendJson:(_res,status,payload)=>{response={status,payload};}});
    await handler({method:'POST',url:path,body},{});
    if(response.status>=400)throw Object.assign(Error(response.payload.error),{code:response.payload.code,status:response.status});return response.payload;
  }
  const url=key=>'https://media.example/source/'+key;
  const product={sku:'9100199911',name:'Испытательный товар',price:'100',sellPrice:'100',currencyCode:'CNY',images:[url('hero.png')],
    description:'Описание товара',color_image:url('color.png'),videos:[{url:url('main.mp4'),coverUrl:url('poster.png')},{url:'https://youtu.be/hosted'}],videoCoverUrl:url('cover.mp4'),
    richContent:JSON.stringify({version:0.3,content:[{widgetName:'raShowcase',type:'billboard',blocks:[{img:{src:url('rich.png')}}]},{widgetName:'raVideo',video:{src:url('rich.mp4'),poster:url('rich-poster.png')}}]}),
    descriptionCategoryId:123,typeId:456,logistics:{weightG:102,lengthMm:100,widthMm:100,heightMm:50},sourceCategory:{descriptionCategoryId:123,typeId:456,attributes:[]}};
  const original=structuredClone(product),temporaryRoot=await mkdtemp(join(tmpdir(),'collector-media-e2e-'));t.after(()=>rm(temporaryRoot,{recursive:true,force:true}));
  f.losePutResponse();
  const ports={capabilities:{mediaDirectUploadV1:true},runId:scope.runId,leaseToken:scope.leaseToken,
    issue:(_run,_lease,input)=>route(`/collector/runs/${scope.runId}/media-uploads`,{...scope,...input}),
    confirm:(_run,_lease,uploadId)=>route(`/collector/runs/${scope.runId}/media-uploads/${uploadId}/confirm`,scope),
    prepareFile:(source,options)=>prepareCollectorMediaFile(source,{...options,temporaryRoot,request:f.request,lookupHost:async()=>[{address:'8.8.8.8',family:4}]}),
    upload:(ticket,file,options)=>uploadCollectorMedia({...ticket,url:ticket.url.replace('http:','https:')},file,{...options,request:f.request})};
  const prepared=await prepareCollectorMedia(product,ports);
  assert.equal(prepared.mediaPreparation.status,'ready',JSON.stringify(prepared.mediaPreparation));assert.equal(prepared.mediaObjects.length,7);
  assert.deepEqual(listCollectorMedia(prepared),listCollectorMedia(original));assert.deepEqual(await readdir(temporaryRoot),[]);
  const originalPuts=f.calls.filter(call=>call.method==='PUT'&&!call.copy).length;assert.equal(originalPuts,7,'lost PUT response is confirmed, never replayed');
  assert.deepEqual(await prepareCollectorMedia(prepared,ports),prepared);assert.equal(f.calls.filter(call=>call.method==='PUT'&&!call.copy).length,7);
  const savedResult=await route(`/collector/runs/${scope.runId}/items`,{...scope,items:[{source:'ozon',sourceKey:product.sku,sourceSku:product.sku,status:'QUALIFIED',rawPayload:prepared,exportDataFromRaw:true}]});
  const itemId=savedResult.results[0].item.id;
  await collector.completeCollectorRun(scope);
  await assert.rejects(service.confirm({...scope,uploadId:prepared.mediaObjects[0].uploadId}),{code:'COLLECTOR_RUN_NOT_RUNNING'});
  const handoff=await addSelectedCollectorItemsToCollectBox({accountId:scope.accountId,runId:scope.runId,itemIds:[itemId]});
  assert.equal(handoff.errors.length,0,JSON.stringify(handoff.errors));assert.equal(handoff.results.length,1);
  const collectItemId=handoff.results[0].collectItemId;
  let saved=(await listCollectItemsV3({accountId:scope.accountId,ids:[collectItemId]}))[0];
  assert.equal(saved.mediaObjects.length,7);assert.equal(saved.listingDraft.mediaObjects.length,7);
  for(const ref of saved.mediaObjects)assert.ok(ref.versionId&&ref.crc64&&ref.validation);
  for(const key of ['color_image','videos','richContent','videoCoverUrl'])assert.deepEqual(saved[key],original[key]);
  const sameHandoff=await addSelectedCollectorItemsToCollectBox({accountId:scope.accountId,runId:scope.runId,itemIds:[itemId]});assert.equal(sameHandoff.errors.length,0);
  await assert.rejects(ingestCollectRequestV4({authenticatedAccount:{id:scope.otherAccountId},input:{source:'ozon',sourceSku:product.sku,requestId:randomUUID(),
    payload:{...original,mediaObjects:saved.mediaObjects,collectorRunId:scope.runId,collectorItemId:itemId}}}),{code:'COLLECTOR_MEDIA_REFERENCE_SCOPE'});
  await assert.rejects(loadCollectorMediaForPublication({accountId:scope.otherAccountId,collectItemId,refs:saved.mediaObjects},pool),{code:'COLLECTOR_MEDIA_REFERENCE_SCOPE'});
  const draft=structuredClone(saved.listingDraft);draft.categoryResolution={status:'MATCHED',method:'MANUAL',target:{storeId:'target',descriptionCategoryId:123,typeId:456}};
  await updateCollectItemDraftV4({collectItemId,accountId:scope.accountId,expectedVersion:saved.draftVersion,patch:{listingDraft:draft}});
  saved=(await listCollectItemsV3({accountId:scope.accountId,ids:[collectItemId]}))[0];
  const source=buildAiListingSource(saved,'target'),schema=[4191,11254,21841,21837,21845].map(id=>({id,is_required:false}));
  const generatedKey='listing-media/v1/ai-image-listing/'+'1'.repeat(64)+'.jpg',generatedUrl='https://assets.test/'+generatedKey;
  const items=await prepareAiListingItems({accountId:scope.accountId,source,images:[{sku:product.sku,index:0,generatedUrl}],config:{targetStoreId:'target',priceAdjustmentKopecks:0,priceMultiplier:'1',brandMode:'PREFER_SOURCE'}},{currencyCode:'CNY'},
    {normalizeItems:items=>normalizeOzonImportItems(items,{strictTypeMatch:true,getCategoryAttributes:async()=>schema,getCategoryAttributeValues:async()=>[]})});
  let downloads=0;
  const media=createOzonListingMedia({publication:{baseUrl:'https://assets.test/',prefix:'listing-media/v1'},downloadBaseUrl:'https://assets.test/',
    statObject:key=>key===generatedKey?{size:1}:f.storage.statObject(key),copyVerifiedObject:f.storage.copyVerifiedObject,
    downloadImage:async()=>{downloads++;throw Error('source downloader forbidden');},downloadVideo:async()=>{downloads++;throw Error('source downloader forbidden');}});
  // Replay/late writes become new staging versions; publication remains bound to
  // the confirmed version even when a privileged writer changed the latest one.
  const videoRef=saved.mediaObjects.find(ref=>ref.purpose==='video');f.save(videoRef.key,Buffer.from('wrong latest'),'video/mp4');
  const published=await media({accountId:scope.accountId,taskId:'media-task',source,items});
  assert.equal(downloads,0);assert.match(published[0].color_image,/^https:\/\/assets.test\/listing-media\/v1\/prepared\//);
  const videoValues=published[0].complex_attributes.flatMap(group=>group.attributes).find(attr=>attr.id===21841).values;
  assert.equal(videoValues[1].value,'https://youtu.be/hosted');assert.equal(videoValues.length,2);
  const formal=f.find(new URL(videoValues[0].value).pathname.slice(1));assert.deepEqual(formal.bytes,video);
  const copyCount=f.calls.filter(call=>call.copy).length;assert.equal(copyCount,6,'ordinary video poster is preserved as provenance; existing Ozon contract has no poster slot');
  assert.deepEqual(await media({accountId:scope.accountId,taskId:'media-task',source,items}),published);assert.equal(f.calls.filter(call=>call.copy).length,copyCount);
  assert.ok(permissions.every(permission=>permission==='collector.upload'));
  const persisted=(await pool.query('SELECT confirmed_object,collect_item_id FROM collector_media_uploads WHERE account_id=$1',[scope.accountId])).rows;
  assert.ok(persisted.every(row=>row.collect_item_id===collectItemId));
  console.log(JSON.stringify({directUploads:originalPuts,publicationCopies:copyCount,sourceDownloadsDuringPrepare:downloads,validationBytes:persisted.reduce((sum,row)=>sum+row.confirmed_object.validationBytes,0)}));
});

test('sibling append binds new media to the actual canonical draft and retains earlier verified media',options,async t=>{
  const scope=await fixture(t),f=await collectorMediaFixture(t),service=collector.createCollectorRunMediaUploads({storage:f.storage});
  const bytes=await sharp({create:{width:8,height:8,channels:3,background:'#ff0088'}}).png().toBuffer();
  const product=sku=>({sku,name:'Тестовый товар '+sku,images:['https://media.example/'+sku+'.jpg'],price:'100',currencyCode:'CNY',color_image:'https://media.example/'+sku+'.png'});
  const a=product('9100991001'),b=product('9100991002');let collectItemId;
  for(const payload of [a,{...b,variantData:{variants:[b,a]}}]){
    const ticket=await service.issue({...scope,...expectation(bytes,{sourceSku:payload.sku,sourceUrl:payload.color_image})});
    await upload(ticket,bytes);payload.mediaObjects=[(await service.confirm({...scope,uploadId:ticket.uploadId})).mediaObject];
    const saved=await collector.upsertCollectorRunItem({...scope,item:{source:'ozon',sourceKey:payload.sku,sourceSku:payload.sku,status:'QUALIFIED',rawPayload:payload}});
    const handoff=await addSelectedCollectorItemsToCollectBox({accountId:scope.accountId,runId:scope.runId,itemIds:[saved.item.id]});
    assert.equal(handoff.errors.length,0,JSON.stringify(handoff.errors));
    if(collectItemId)assert.equal(handoff.results[0].collectItemId,collectItemId);else collectItemId=handoff.results[0].collectItemId;
  }
  const saved=(await listCollectItemsV3({accountId:scope.accountId,ids:[collectItemId]}))[0];
  assert.deepEqual(saved.mediaObjects.map(ref=>ref.sourceSku).sort(),[a.sku,b.sku]);
  assert.deepEqual(saved.listingDraft.mediaObjects,saved.mediaObjects);
  assert.equal((await loadCollectorMediaForPublication({accountId:scope.accountId,collectItemId,refs:saved.mediaObjects},pool)).length,2);
  const bindings=(await pool.query('SELECT collect_item_id FROM collector_media_uploads WHERE account_id=$1',[scope.accountId])).rows;
  assert.ok(bindings.every(row=>row.collect_item_id===collectItemId));
});

test('shared references retain eight variant manifests through checkpoints, retry takeover, V4 and pinned publication',{
  ...options,skip:!enabled||!process.env.COLLECTOR_MEDIA_TEST_VIDEO||!process.env.COLLECTOR_MEDIA_FFPROBE_PATH},async t=>{
  const scope=await fixture(t),f=await collectorMediaFixture(t),service=collector.createCollectorRunMediaUploads({storage:f.storage});
  const image=await sharp({create:{width:12,height:16,channels:3,background:'#246'}}).png().toBuffer();
  const video=await readFile(process.env.COLLECTOR_MEDIA_TEST_VIDEO),url=key=>'https://media.example/shared/'+key;
  const richContent=JSON.stringify({content:[...Array.from({length:46},(_,index)=>({img:{src:url(index+'.png')}})),{video:{src:url('rich.mp4')}}]});
  const variants=Array.from({length:8},(_,index)=>({sku:String(9100199800+index),name:'Общий товар '+index,price:'100',currencyCode:'CNY',
    images:[url('main.jpg')],videos:[{url:url('ordinary.mp4')}],richContent}));
  const product={...variants[0],variantData:{variants}},sources=listCollectorMedia(product);
  assert.equal(sources.length,384);assert.equal(new Set(sources.map(source=>source.sourceSku)).size,8);
  const unique=sources.filter(source=>source.sourceSku===product.sku),tickets=new Map();
  for(const source of unique){
    const bytes=source.purpose==='rich-image'?image:video;
    const ticket=await service.issue({...scope,...expectation(bytes,{...source,contentType:source.purpose==='rich-image'?'image/png':'video/mp4'})});
    tickets.set(source.purpose+'|'+source.sourceUrl,ticket);
  }
  const intents=sources.map(source=>({...tickets.get(source.purpose+'|'+source.sourceUrl).intent,...source}));
  const save=(claim,payload,status='FAILED')=>collector.upsertCollectorRunItem({...claim,item:{source:'ozon',sourceKey:product.sku,sourceSku:product.sku,
    status,retry:status==='QUALIFIED',errorCode:status==='FAILED'?'COLLECTOR_MEDIA_WAITING':'',rawPayload:payload}});
  const first=(await save(scope,{...product,mediaObjects:[],mediaIntents:intents})).item;
  assert.equal(first.rawPayload.mediaIntents.length,384);
  const objects=new Map();
  for(const [index,source] of unique.entries()){
    const ticket=tickets.get(source.purpose+'|'+source.sourceUrl),bytes=source.purpose==='rich-image'?image:video;
    if(index===47){f.losePutResponse();await assert.rejects(upload(ticket,bytes));}
    else await upload(ticket,bytes);
    if(index<24)objects.set(ticket.uploadId,(await service.confirm({...scope,uploadId:ticket.uploadId})).mediaObject);
  }
  const confirmed=intents.filter(ref=>objects.has(ref.uploadId)).map(ref=>({...objects.get(ref.uploadId),sourceSku:ref.sourceSku,index:ref.index}));
  const pending=intents.filter(ref=>!objects.has(ref.uploadId));
  const checkpoint={...product,mediaObjects:confirmed,mediaIntents:pending};
  assert.equal(confirmed.length,192);assert.equal(pending.length,192);
  assert.equal((await save(scope,checkpoint)).item.id,first.id);
  await collector.completeCollectorRun(scope);
  const next=await retryRun(scope),recovery={runId:scope.runId,itemId:first.id};
  const alias=confirmed.find(ref=>ref.sourceSku===variants[7].sku);
  const aliasRequest={sourceSku:alias.sourceSku,purpose:alias.purpose,index:alias.index,sourceUrl:alias.sourceUrl,resumeUploadId:alias.uploadId,previousItemId:first.id};
  // The first committed takeover response is lost; restoring the alias again
  // must return the same object and leave the canonical upload identity alone.
  await service.issue({...next,...aliasRequest});
  const restored=await service.issue({...next,...aliasRequest});assert.deepEqual(restored.mediaObject,alias);
  assert.equal(restored.intent.sourceSku,variants[7].sku);
  const pendingAlias=pending.find(ref=>ref.sourceSku===variants[7].sku);
  const pendingRequest={...pendingAlias,resumeUploadId:pendingAlias.uploadId,previousItemId:first.id};
  await service.issue({...next,...pendingRequest});
  assert.deepEqual((await service.issue({...next,...pendingRequest})).intent,pendingAlias);
  const transferred=(await save(next,{...checkpoint,mediaRecovery:recovery})).item;
  assert.equal(transferred.rawPayload.mediaObjects.length,192);assert.equal(transferred.rawPayload.mediaIntents.length,192);
  for(const ticket of tickets.values())objects.set(ticket.uploadId,(await service.confirm({...next,uploadId:ticket.uploadId})).mediaObject);
  const all=sources.map(source=>({...objects.get(tickets.get(source.purpose+'|'+source.sourceUrl).uploadId),...source}));
  const saved=(await save(next,{...product,mediaObjects:all,mediaIntents:[],mediaRecovery:recovery},'QUALIFIED')).item;
  assert.equal(saved.rawPayload.mediaObjects.length,384);
  assert.equal(f.calls.filter(call=>call.method==='PUT'&&!call.copy).length,48);
  const uploadRows=(await pool.query('SELECT * FROM collector_media_uploads WHERE account_id=$1',[scope.accountId])).rows;
  assert.equal(uploadRows.length,48);assert.ok(uploadRows.every(row=>row.source_sku===product.sku&&row.run_id===next.runId&&row.collector_item_id===saved.id));
  await collector.completeCollectorRun(next);
  const handoff=await addSelectedCollectorItemsToCollectBox({accountId:scope.accountId,runId:next.runId,itemIds:[saved.id]});
  assert.equal(handoff.errors.length,0,JSON.stringify(handoff.errors));const collectItemId=handoff.results[0].collectItemId;
  const collect=(await listCollectItemsV3({accountId:scope.accountId,ids:[collectItemId]}))[0];
  assert.deepEqual(collect.listingDraft.mediaObjects,all);
  const replay=await ingestCollectRequestV4({authenticatedAccount:{id:scope.accountId},input:{source:'ozon',sourceSku:product.sku,requestId:randomUUID(),
    payload:{...product,mediaObjects:all,collectorRunId:next.runId,collectorItemId:saved.id}}});
  assert.equal(replay.collectItemId,collectItemId);
  const merged=(await listCollectItemsV3({accountId:scope.accountId,ids:[collectItemId]}))[0];
  assert.deepEqual(merged.mediaObjects,all,'repeated V4 merge retains every logical alias');
  const verified=await loadCollectorMediaForPublication({accountId:scope.accountId,collectItemId,refs:merged.mediaObjects},pool);
  assert.deepEqual(verified,all);
  for(const row of uploadRows)f.save(row.object_key,Buffer.from('unconfirmed latest version'),row.expected_type);
  const source={collectItemId,sourceSnapshot:{mediaObjects:merged.mediaObjects},items:variants.map(row=>({sku:row.sku,listingItem:{offer_id:row.sku}}))};
  const items=variants.map(row=>({offer_id:row.sku,attributes:[{id:21841,values:[{value:row.videos[0].url}]},{id:11254,values:[{value:row.richContent}]}]}));
  const media=createOzonListingMedia({publication:{baseUrl:'https://assets.test/',prefix:'listing-media/v1'},downloadBaseUrl:'https://assets.test/',
    statObject:f.storage.statObject,copyVerifiedObject:f.storage.copyVerifiedObject,
    downloadImage:async()=>{throw Error('shared references must not redownload images');},downloadVideo:async()=>{throw Error('shared references must not redownload videos');}});
  const published=await media({accountId:scope.accountId,taskId:'shared-media-task',source,items});
  assert.equal(published.length,8);assert.equal(f.calls.filter(call=>call.copy).length,48);
  const firstPublished=published[0].attributes.map(attribute=>attribute.values);
  for(const row of published)assert.deepEqual(row.attributes.map(attribute=>attribute.values),firstPublished);
  for(const call of f.calls.filter(call=>call.copy)){
    const original=new URL('https://'+call.copy),object=f.find(decodeURIComponent(original.pathname).slice(1),original.searchParams.get('versionId'));
    assert.deepEqual(f.find(call.key).bytes,object.bytes);assert.notEqual(object.bytes.toString(),'unconfirmed latest version');
  }
  assert.deepEqual(await media({accountId:scope.accountId,taskId:'shared-media-task',source,items}),published);
  assert.equal(f.calls.filter(call=>call.copy).length,48);
  console.log(JSON.stringify({sharedVariants:8,logicalSlots:384,uploadRows:48,actualPuts:48,publicationCopies:48,pinnedRetry:true}));
});

test('shared references reject duplicate slots, mixed states, foreign ownership and source tampering, while alias-only evidence recovers',options,async t=>{
  const scope=await fixture(t),f=await collectorMediaFixture(t),service=collector.createCollectorRunMediaUploads({storage:f.storage});
  const bytes=await sharp({create:{width:8,height:8,channels:3,background:'#eee'}}).png().toBuffer();
  const expected=expectation(bytes,{purpose:'rich-image'}),ticket=await service.issue({...scope,...expected});
  await upload(ticket,bytes);const canonical=(await service.confirm({...scope,uploadId:ticket.uploadId})).mediaObject;
  const richContent=JSON.stringify({content:[{img:{src:expected.sourceUrl}},{img:{src:expected.sourceUrl}}]});
  const product={sku:expected.sourceSku,name:'Общий товар',price:'100',currencyCode:'CNY',images:['https://media.example/main.jpg'],richContent,
    variants:[{sku:'9100199922',richContent}]};
  const refs=[canonical,{...canonical,index:1},{...canonical,sourceSku:'9100199922'},{...canonical,sourceSku:'9100199922',index:1}];
  const save=(claim,payload,sourceKey=product.sku)=>collector.upsertCollectorRunItem({...claim,item:{source:'ozon',sourceKey,sourceSku:product.sku,
    status:'FAILED',errorCode:'COLLECTOR_MEDIA_WAITING',rawPayload:payload}});
  await assert.rejects(save(scope,{...product,mediaObjects:[refs[0],refs[0]]}),{code:'COLLECTOR_MEDIA_REFERENCE_INVALID'});
  await assert.rejects(save(scope,{...product,mediaObjects:[refs[0]],mediaIntents:[{...ticket.intent,sourceSku:refs[2].sourceSku}]}),{code:'COLLECTOR_MEDIA_REFERENCE_INVALID'});
  for(const changed of [{sourceUrl:'https://media.example/forged.png'},{index:99},{sourceSku:'foreign-sku'},{purpose:'color'}])
    await assert.rejects(save(scope,{...product,color_image:expected.sourceUrl,mediaObjects:[{...refs[2],...changed}]}),{code:'COLLECTOR_MEDIA_REFERENCE_TAMPERED'});
  await assert.rejects(save(scope,{...product,variants:[{sku:refs[2].sourceSku,richContent:JSON.stringify({img:{src:'https://media.example/forged.png'}})}],
    mediaObjects:[canonical,{...refs[2],sourceUrl:'https://media.example/forged.png'}]}),{code:'COLLECTOR_MEDIA_REFERENCE_TAMPERED'});
  await assert.rejects(save(scope,{...product,variants:[{sku:refs[2].sourceSku,color_image:expected.sourceUrl}],
    mediaObjects:[canonical,{...refs[2],purpose:'color'}]}),{code:'COLLECTOR_MEDIA_REFERENCE_TAMPERED'});
  await assert.rejects(save(scope,{...product,mediaObjects:[],mediaIntents:[{...ticket.intent,sourceSku:refs[2].sourceSku,size:999}]}),{code:'COLLECTOR_MEDIA_REFERENCE_TAMPERED'});
  const unconfirmed=await service.issue({...scope,...expected,index:1});
  await assert.rejects(save(scope,{...product,mediaObjects:[canonical,{...canonical,uploadId:unconfirmed.uploadId}]}),{code:'COLLECTOR_MEDIA_REFERENCE_INVALID'});
  await assert.rejects(save(scope,{...product,mediaObjects:[{...refs[2],uploadId:unconfirmed.uploadId}]}),{code:'COLLECTOR_MEDIA_REFERENCE_SCOPE'});
  await assert.rejects(collector.upsertCollectorRunItem({...scope,item:{source:'ozon',sourceKey:refs[2].sourceSku,sourceSku:refs[2].sourceSku,status:'FAILED',
    rawPayload:{...product,sku:refs[2].sourceSku,variants:[],mediaObjects:[refs[2]]}}}),{code:'COLLECTOR_MEDIA_REFERENCE_TAMPERED'},
  'first binding must include the canonical source in this item manifest');
  const stored=(await save(scope,{...product,mediaObjects:refs})).item;
  assert.deepEqual(stored.rawPayload.mediaObjects,refs);
  await assert.rejects(save(scope,{...product,mediaObjects:refs},'separate-item'),{code:'COLLECTOR_MEDIA_REFERENCE_SCOPE'});
  const unrelated=await retryRun(scope,{captureScope:'CURRENT'});
  await assert.rejects(save(unrelated,{...product,mediaObjects:refs}),{code:'COLLECTOR_MEDIA_REFERENCE_SCOPE'});
  const aliasInput={sourceSku:refs[2].sourceSku,purpose:refs[2].purpose,index:refs[2].index,sourceUrl:refs[2].sourceUrl,resumeUploadId:ticket.uploadId};
  assert.deepEqual((await service.issue({...scope,...aliasInput})).mediaObject,refs[2]);
  await assert.rejects(service.issue({...scope,...aliasInput,sourceSku:'foreign-sku'}),{code:'COLLECTOR_MEDIA_REFERENCE_TAMPERED'});
  // The persisted evidence can contain only aliases after a partial checkpoint;
  // it still proves the same item owns the one immutable uploaded object.
  await save(scope,{...product,mediaObjects:refs.slice(2)});await collector.completeCollectorRun(scope);
  const next=await retryRun(scope),recovery={runId:scope.runId,itemId:stored.id};
  const resumed=await service.issue({...next,...aliasInput,previousItemId:stored.id});assert.deepEqual(resumed.mediaObject,refs[2]);
  const recovered=(await save(next,{...product,mediaObjects:refs.slice(2),mediaRecovery:recovery})).item;
  const qualified=(await collector.upsertCollectorRunItem({...next,item:{source:'ozon',sourceKey:product.sku,sourceSku:product.sku,status:'QUALIFIED',retry:true,rawPayload:recovered.rawPayload}})).item;
  const handoff=await addSelectedCollectorItemsToCollectBox({accountId:scope.accountId,runId:next.runId,itemIds:[qualified.id]});
  assert.equal(handoff.errors.length,0,JSON.stringify(handoff.errors));const collectItemId=handoff.results[0].collectItemId;
  assert.deepEqual(await loadCollectorMediaForPublication({accountId:scope.accountId,collectItemId,refs:refs.slice(2)},pool),refs.slice(2));
  for(const changed of [{sourceUrl:'https://media.example/forged.png'},{index:99},{sourceSku:'foreign-sku'},{purpose:'color'}])
    await assert.rejects(loadCollectorMediaForPublication({accountId:scope.accountId,collectItemId,refs:[{...refs[2],...changed}]},pool),{code:'COLLECTOR_MEDIA_REFERENCE_SCOPE'});
  await assert.rejects(loadCollectorMediaForPublication({accountId:scope.otherAccountId,collectItemId,refs:refs.slice(2)},pool),{code:'COLLECTOR_MEDIA_REFERENCE_SCOPE'});
  await assert.rejects(ingestCollectRequestV4({authenticatedAccount:{id:scope.otherAccountId},input:{source:'ozon',sourceSku:product.sku,requestId:randomUUID(),
    payload:{...product,mediaObjects:refs.slice(2),collectorRunId:next.runId,collectorItemId:qualified.id}}}),{code:'COLLECTOR_MEDIA_REFERENCE_SCOPE'});
  assert.equal(f.calls.filter(call=>call.method==='PUT'&&!call.copy).length,1);
});

test('metadata checkpoint before the first download retains the SKU claim until media actually fails',options,async t=>{
  const scope=await fixture(t),sku='9100199555';
  assert.equal((await collector.claimCollectorRunSkus({...scope,skus:[sku]})).items[0].state,'CLAIMED');
  const checkpoint={source:'ozon',sourceKey:sku,sourceSku:sku,status:'FAILED',errorCode:'COLLECTOR_MEDIA_WAITING',
    rawPayload:{sku,name:'Собранные сведения',mediaObjects:[],mediaIntents:[],mediaPreparation:{status:'preparing',pending:2}}};
  await collector.upsertCollectorRunItem({...scope,item:checkpoint});
  const competing=await retryRun(scope,{captureScope:'CURRENT'});
  const reserved=(await collector.claimCollectorRunSkus({...competing,skus:[sku]})).items[0];
  assert.equal(reserved.state,'COLLECTING');assert.equal(reserved.runId,scope.runId);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM collector_media_uploads WHERE account_id=$1',[scope.accountId])).rows[0].count,0);
  await collector.upsertCollectorRunItem({...scope,item:{...checkpoint,rawPayload:{...checkpoint.rawPayload,mediaPreparation:{status:'waiting',pending:2}}}});
  assert.equal((await collector.claimCollectorRunSkus({...competing,skus:[sku]})).items[0].state,'CLAIMED');
});

test('sibling V4 append retains both logical rich-image slots sharing an earlier upload',options,async t=>{
  const scope=await fixture(t),f=await collectorMediaFixture(t),service=collector.createCollectorRunMediaUploads({storage:f.storage});
  const bytes=await sharp({create:{width:8,height:8,channels:3,background:'#147'}}).png().toBuffer();
  const product=(sku,count)=>({sku,name:'Общий товар '+sku,price:'100',currencyCode:'CNY',images:['https://media.example/main.jpg'],
    richContent:JSON.stringify({content:Array.from({length:count},()=>({img:{src:'https://media.example/'+sku+'.png'}}))})});
  const a=product('9100199701',2),b=product('9100199702',1);let collectItemId;const expected=[];
  for(const payload of [a,{...b,variantData:{variants:[b,a]}}]){
    const sources=listCollectorMedia(payload).filter(source=>source.sourceSku===payload.sku);
    const ticket=await service.issue({...scope,...expectation(bytes,sources[0])});await upload(ticket,bytes);
    const canonical=(await service.confirm({...scope,uploadId:ticket.uploadId})).mediaObject;
    payload.mediaObjects=sources.map(source=>({...canonical,...source}));expected.push(...payload.mediaObjects);
    const saved=(await collector.upsertCollectorRunItem({...scope,item:{source:'ozon',sourceKey:payload.sku,sourceSku:payload.sku,status:'QUALIFIED',rawPayload:payload}})).item;
    const handoff=await addSelectedCollectorItemsToCollectBox({accountId:scope.accountId,runId:scope.runId,itemIds:[saved.id]});
    assert.equal(handoff.errors.length,0,JSON.stringify(handoff.errors));
    if(collectItemId)assert.equal(handoff.results[0].collectItemId,collectItemId);else collectItemId=handoff.results[0].collectItemId;
  }
  const collect=(await listCollectItemsV3({accountId:scope.accountId,ids:[collectItemId]}))[0];
  assert.equal(collect.mediaObjects.length,3);assert.deepEqual(collect.mediaObjects,expected);assert.deepEqual(collect.listingDraft.mediaObjects,expected);
  assert.deepEqual(await loadCollectorMediaForPublication({accountId:scope.accountId,collectItemId,refs:collect.mediaObjects},pool),expected);
  assert.equal(f.calls.filter(call=>call.method==='PUT'&&!call.copy).length,2);
});

test('publication preserves each variant unique image and video alongside its shared media aliases',{
  ...options,skip:!enabled||!process.env.COLLECTOR_MEDIA_TEST_VIDEO||!process.env.COLLECTOR_MEDIA_FFPROBE_PATH},async t=>{
  const scope=await fixture(t),f=await collectorMediaFixture(t),service=collector.createCollectorRunMediaUploads({storage:f.storage});
  const image=await sharp({create:{width:8,height:8,channels:3,background:'#678'}}).png().toBuffer(),video=await readFile(process.env.COLLECTOR_MEDIA_TEST_VIDEO);
  const url=name=>'https://media.example/mixed/'+name;
  const variants=['9100199601','9100199602'].map(sku=>({sku,name:'Товар '+sku,price:'100',currencyCode:'CNY',images:[url('main.jpg')],
    videos:[{url:url('shared.mp4')},{url:url(sku+'.mp4')}],
    richContent:JSON.stringify({content:[{img:{src:url('shared.png')}},{img:{src:url(sku+'.png')}}]})}));
  const product={...variants[0],variantData:{variants}},objects=new Map();
  for(const source of listCollectorMedia(product)){
    const key=source.purpose+'|'+source.sourceUrl;if(objects.has(key))continue;
    const bytes=source.purpose==='video'?video:image;
    const ticket=await service.issue({...scope,...expectation(bytes,{...source,contentType:source.purpose==='video'?'video/mp4':'image/png'})});
    await upload(ticket,bytes);objects.set(key,(await service.confirm({...scope,uploadId:ticket.uploadId})).mediaObject);
  }
  const refs=listCollectorMedia(product).map(source=>({...objects.get(source.purpose+'|'+source.sourceUrl),...source}));
  assert.equal(refs.length,8);assert.equal(objects.size,6);
  const saved=(await collector.upsertCollectorRunItem({...scope,item:{source:'ozon',sourceKey:product.sku,sourceSku:product.sku,status:'QUALIFIED',rawPayload:{...product,mediaObjects:refs}}})).item;
  const handoff=await addSelectedCollectorItemsToCollectBox({accountId:scope.accountId,runId:scope.runId,itemIds:[saved.id]});
  assert.equal(handoff.errors.length,0,JSON.stringify(handoff.errors));const collectItemId=handoff.results[0].collectItemId;
  assert.deepEqual(await loadCollectorMediaForPublication({accountId:scope.accountId,collectItemId,refs},pool),refs);
  const source={collectItemId,sourceSnapshot:{mediaObjects:refs},items:variants.map(row=>({sku:row.sku,listingItem:{offer_id:row.sku}}))};
  const items=variants.map(row=>({offer_id:row.sku,attributes:[{id:21841,values:row.videos.map(entry=>({value:entry.url}))},{id:11254,values:[{value:row.richContent}]}]}));
  const media=createOzonListingMedia({publication:{baseUrl:'https://assets.test/',prefix:'listing-media/v1'},downloadBaseUrl:'https://assets.test/',
    statObject:f.storage.statObject,copyVerifiedObject:f.storage.copyVerifiedObject,
    downloadImage:async()=>{throw Error('unexpected image redownload');},downloadVideo:async()=>{throw Error('unexpected video redownload');}});
  const published=await media({accountId:scope.accountId,taskId:'mixed-media-task',source,items});
  const videos=published.map(row=>row.attributes[0].values.map(entry=>entry.value));
  const images=published.map(row=>JSON.parse(row.attributes[1].values[0].value).content.map(entry=>entry.img.src));
  assert.equal(videos[0][0],videos[1][0]);assert.notEqual(videos[0][1],videos[1][1]);
  assert.equal(images[0][0],images[1][0]);assert.notEqual(images[0][1],images[1][1]);
  assert.equal(f.calls.filter(call=>call.method==='PUT'&&!call.copy).length,6);assert.equal(f.calls.filter(call=>call.copy).length,6);
  assert.deepEqual(listCollectorMedia({...product,mediaObjects:refs}),listCollectorMedia(product));
});
