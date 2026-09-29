import './support/dedicated-postgres-test-environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {AsyncLocalStorage} from 'node:async_hooks';
import pg from 'pg';
import sharp from 'sharp';
import {createAiListingRepository} from '../ai-listing-repository.mjs';
import {createAiListingService} from '../ai-listing-service.mjs';
import {createAiUserChannels} from '../ai-user-channels.mjs';
import {createSkuBilling} from '../ai-sku-billing.mjs';
import {createImageWorkQueue} from '../ai-image-work-queue.mjs';
import {createAiListingImagePort,createAiListingGridPort} from '../ai-listing-runtime.mjs';

function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}
async function bounded(promise,label,ms=15000){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(`Journey timeout: ${label}`)),ms);})]);}finally{clearTimeout(timer);}}
const enabled=process.env.SONLI_POSTGRES_TESTS==='1';
if(enabled){const url=new URL(process.env.DATABASE_URL);const isolated=process.env.SONLI_TEST_NETWORK_ISOLATED==='1'&&url.hostname==='ozon-pipeline-repair-qa-db'&&url.pathname==='/ozon_pipeline_fixture';assert.ok(isolated||(url.hostname==='127.0.0.1'&&((url.port==='59835'&&url.pathname==='/ozon_ai_product_fixture')||(url.port==='55439'&&url.pathname==='/qa_ai_recovery'))),'requires explicitly isolated product fixture database');}

test('ten product journey: five channel owners, real image pipeline and exact SKU ledger', {skip:!enabled,timeout:60000},async t=>{
 const started=performance.now(),schema='product_journey_'+randomUUID().replaceAll('-','');
 const admin=new pg.Pool({connectionString:process.env.DATABASE_URL});let pool;
 const controls=new Map(),workers=[],objects=new Map(),sources=new Map(),requestInputs=new Map(),prepared=new Map(),requests=[],reservations=[],releases=[],preparations=[],submissions=[],turns=[];
 const local=createImageWorkQueue({concurrency:1}),context=new AsyncLocalStorage();
 let localActive=0,localPeak=0,remoteActive=0,remotePeak=0,now=1000,unknownTask=null,unknownFailed=false;
 try{
  await admin.query(`CREATE SCHEMA ${schema}`);
  pool=new pg.Pool({connectionString:process.env.DATABASE_URL,options:`-c search_path=${schema}`,max:20});
  await pool.query(`CREATE TABLE accounts(id TEXT PRIMARY KEY,role TEXT,username TEXT);
   INSERT INTO accounts VALUES('admin','admin','fixture admin'),('owner','member','fixture owner');
   CREATE TABLE ai_gateway_profiles(id TEXT PRIMARY KEY,account_id TEXT,display_name TEXT,base_url TEXT,api_key_env_name TEXT,text_protocol TEXT,image_protocol TEXT,text_model TEXT,image_model TEXT,config_version INTEGER,enabled BOOLEAN,created_by TEXT)`);
  for(const name of ['106_ai_image_listing.sql','108_ai_user_channels.sql','109_unified_user_ai_channels.sql','110_user_channel_capability_checks.sql','111_ai_channel_health.sql','113_ai_channel_delete.sql','114_ai_channel_price_checks.sql','115_ai_sku_billing.sql','130_ai_channel_pricing.sql','134_ai_product_channels.sql','135_ai_product_scheduling.sql','137_ai_billing_management.sql','141_ai_listing_task_controls.sql','151_ai_channel_request_holds.sql'])await pool.query(await readFile(new URL('../db/migrations/'+name,import.meta.url),'utf8'));
  await pool.query(`INSERT INTO ai_gateway_profiles(id) SELECT 'profile-'||i FROM generate_series(1,5)i;
   INSERT INTO ai_user_channels(id,account_id,created_by,name,base_url,text_model,image_model,billing_account,credential,key_fingerprint,profile_id,image_protocol)
   SELECT 'channel-'||i,'owner','admin','Channel '||i,'https://gateway.invalid/v1','','fixture-image','shared-fixture','{}','fingerprint-'||i,'profile-'||i,'SUB2API_OPENAI_IMAGES' FROM generate_series(1,5)i`);
  const repository=createAiListingRepository({pool}),billing=createSkuBilling({pool});
  await billing.configure({id:'admin',role:'admin'},{accountId:'owner',action:'price',amount:'1.23'});
  await billing.configure({id:'admin',role:'admin'},{accountId:'owner',action:'topup',amount:'100.00',idempotencyKey:schema});
  const originals=await Promise.all(['#306fa8','#c58c32'].map(background=>sharp({create:{width:60,height:80,channels:3,background}}).png().toBuffer()));
  const channels=createAiUserChannels({pool,env:{AI_LISTING_CONCURRENCY:'5',AI_LISTING_REQUEST_CONCURRENCY:'5',AI_LISTING_BILLING_CONCURRENCY:'5'},cipher:{decrypt:()=> 'synthetic-key'},requestRetryMs:5,requestWaitMs:10000,
   gatewayFactory:()=>({generateImage:async request=>{
    assert.notEqual(context.getStore(),'local','remote AI must not occupy its local image-work slot');
    const control=controls.get(request.correlationId);assert.ok(control,'unexpected external gateway task');
    const call={taskId:request.correlationId,sku:requestInputs.get(request.requestKey)?.sku,channelId:request.profile.id,requestKey:request.requestKey};assert.ok(call.sku);requests.push(call);
    remoteActive++;remotePeak=Math.max(remotePeak,remoteActive);control.entered.resolve();
    try{
     await control.gate.promise;
     const count=requests.filter(row=>row.taskId===request.correlationId).length;
     if(request.correlationId===unknownTask&&!unknownFailed&&count===3){unknownFailed=true;throw Object.assign(new Error('synthetic transport closed after send'),{code:'AI_GATEWAY_UNEXPECTED_EOF'});}
     // Identity gateway returns a valid prepared GRID unchanged, or a real source PNG for SINGLE.
     return {bytes:Buffer.from(request.sourceImages[0].bytes),contentType:'image/png',requestId:'mock-'+requests.length};
    }finally{remoteActive--;}
   }})});
  const runLocalWork=work=>local.run(()=>context.run('local',async()=>{localActive++;localPeak=Math.max(localPeak,localActive);try{return await work();}finally{localActive--;}}));
  const ports={publication:{baseUrl:'https://media.invalid/',prefix:'fixture'},runLocalWork,
   downloadImage:async url=>{assert.notEqual(context.getStore(),'local');return {buffer:originals[Number(new URL(url).searchParams.get('image'))],contentType:'image/png'};},
   putObject:async({key,buffer,contentType})=>{assert.notEqual(context.getStore(),'local');const metadata=await sharp(buffer).metadata();assert.ok(metadata.width>0&&metadata.height>0);objects.set(key,{buffer:Buffer.from(buffer),contentType,width:metadata.width,height:metadata.height});},
   runChannel:(input,generate)=>{requestInputs.set(input.requestKey,input);return channels.run(input,generate);}};
  const service=createAiListingService({repository,billing,clock:()=>now,
   loadSources:async({collectItemIds})=>collectItemIds.map(id=>structuredClone(sources.get(id))),
   reserveChannel:async input=>{const handle=await channels.reserveProduct(input);reservations.push({taskId:input.taskId,channelId:handle.channelId});return {...handle,release:async()=>{await handle.release();releases.push({taskId:input.taskId,channelId:handle.channelId});}};},
   generateImage:createAiListingImagePort(ports),
   generateImageGroup:createAiListingGridPort({...ports,recognizeText:async images=>{assert.equal(context.getStore(),'local');return images.map(()=> 'fixture product facts');}}),
   submitListing:async input=>{
    assert.equal((await pool.query('SELECT count(*)::int n FROM ai_user_channels WHERE product_task_id=$1',[input.taskId])).rows[0].n,0,'product must release before submission');
    assert.ok(input.images.every(image=>image.generatedUrl),'submission may only use fully persisted images');
    assert.deepEqual(input.source.items.map(item=>item.listingItem.price),sources.get(input.source.collectItemId).items.map(item=>item.listingItem.price));
    const submissionId='submission-'+input.taskId;
    if(input.deferImport){preparations.push(input);prepared.set(submissionId,{input,sent:false});}
    else{await input.beforeExternalWrite();submissions.push(input);}
    return {submissionId};
   },readSubmission:async input=>{
    const row=prepared.get(input.submissionId);assert.ok(row,'finalization must recover a prepared complete product');
    if(!row.sent){await input.beforeExternalWrite();row.sent=true;submissions.push(row.input);return {status:'PENDING'};}
    return {status:'COMPLETED'};
   }});
  const makeTask=async(name,variants,mode,held=true)=>{
   const source={collectItemId:'collect-'+name,sku:'sku-'+name+'-0',name:'Fixture '+name,
    items:Array.from({length:variants},(_,variant)=>({sku:`sku-${name}-${variant}`,images:[0,1].map(image=>`https://source.invalid/${name}/${variant}?image=${image}`),
     listingItem:{weight:200+variant,depth:100,width:110,height:120,price:String(10+variant),currency_code:'CNY'}}))};sources.set(source.collectItemId,source);
   const [task]=await service.createFromCollect({accountId:'owner',collectItemIds:[source.collectItemId],idempotencyKey:'create-'+name,
    config:{targetStoreId:'fixture-store',targetWarehouseId:'fixture-warehouse',generationMode:mode,manualReview:false}});
   const control={gate:deferred(),entered:deferred()};if(!held)control.gate.resolve();controls.set(task.id,control);return task;
  };
  const tasks=[];for(let i=0;i<10;i++)tasks.push(await makeTask(String(i+1),i%2===0?2:1,i%2===0?'GRID':'SINGLE'));
  await t.test('first five products hold all channels; third completion admits sixth on the freed channel',async()=>{
   for(let lane=0;lane<5;lane++)workers.push((async()=>{for(let iteration=0;iteration<20;iteration++){
    const result=await service.processNext({phase:'generate',capacity:5});if(!result)return;
    const images=result.images.filter(image=>image.generatedUrl),previous=turns.filter(turn=>turn.taskId===result.id).length;
    assert.equal(images.length,(previous+1)*2,'each turn must durably finish exactly one whole SKU');
    assert.equal(result.status,images.length===result.images.length?'READY_TO_SUBMIT':'GENERATING');
    assert.equal(new Set(images.map(image=>image.sku)).size,previous+1,'no partial SKU may yield');
    turns.push({taskId:result.id,completedSkus:previous+1});
   }assert.fail('worker exceeded bounded task count');})());
   await bounded(Promise.all(tasks.slice(0,5).map(task=>controls.get(task.id).entered.promise)),'first five products reaching remote calls');
   const first=(await pool.query('SELECT id,product_task_id FROM ai_user_channels WHERE product_token IS NOT NULL ORDER BY id')).rows;
   assert.equal(first.length,5);assert.deepEqual(first.map(row=>row.product_task_id).sort(),tasks.slice(0,5).map(row=>row.id).sort());
   assert.equal(requests.length,5);assert.equal(local.snapshot().active,0,'all five remote waits leave local queue free');
   assert.equal((await pool.query("SELECT count(*)::int n FROM ai_image_listing_tasks WHERE work_phase='generate' AND lease_token IS NULL")).rows[0].n,5);
   const freed=first.find(row=>row.product_task_id===tasks[2].id).id;
   controls.get(tasks[2].id).gate.resolve();
   await bounded(controls.get(tasks[5].id).entered.promise,'sixth product acquiring third product channel');
   const sixth=(await pool.query('SELECT id FROM ai_user_channels WHERE product_task_id=$1',[tasks[5].id])).rows[0];assert.equal(sixth.id,freed);
   assert.ok(releases.some(row=>row.taskId===tasks[2].id));assert.equal(reservations.length,6);
   const yielded=await repository.get({accountId:'owner',taskId:tasks[2].id});assert.equal(yielded.status,'GENERATING');
   assert.equal(yielded.images.filter(image=>image.generatedUrl).length,2);assert.equal(yielded.images.filter(image=>!image.generatedUrl).length,2);
   assert.ok(tasks.slice(6).every(task=>!reservations.some(row=>row.taskId===task.id)),'seventh cannot jump sixth');
   for(const control of controls.values())control.gate.resolve();await bounded(Promise.all(workers),'ten products completing real local image work',30000);
  });
  await t.test('all SKU turns complete with per-SKU channel affinity, unique charges and persisted image bytes',async()=>{
   assert.equal(turns.length,15);assert.equal(reservations.length,15);assert.equal(releases.length,15);assert.equal(requests.length,20);assert.equal(objects.size,30);
   for(const task of tasks){const stored=await repository.get({accountId:'owner',taskId:task.id});
    assert.equal(stored.status,'READY_TO_SUBMIT');assert.ok(stored.images.every(image=>image.generatedUrl));
    assert.equal(turns.filter(turn=>turn.taskId===task.id).length,stored.source.items.length);
    assert.equal(reservations.filter(row=>row.taskId===task.id).length,stored.source.items.length);
    for(const {sku} of stored.source.items){
     const assigned=[...new Set(stored.images.filter(image=>image.sku===sku).map(image=>image.generationConfig.channelId))];
     assert.equal(assigned.length,1,'a complete SKU retains one product channel');
     assert.deepEqual([...new Set(requests.filter(row=>row.taskId===task.id&&row.sku===sku).map(row=>row.channelId))],assigned);
    }
    for(const image of stored.images){const object=objects.get(image.objectKey);assert.ok(object);assert.equal(new URL(image.generatedUrl).pathname.slice(1),image.objectKey);assert.ok(object.buffer.length>0);if(stored.config.generationMode==='GRID')assert.equal(object.width/object.height,3/4);}
   }
   const wallet=(await pool.query("SELECT * FROM ai_user_wallets WHERE account_id='owner'")).rows[0];assert.equal(Number(wallet.balance_cents),10000-15*123);assert.equal(Number(wallet.reserved_cents),0);
   const charges=(await pool.query("SELECT task_id,sku,amount_cents FROM ai_wallet_entries WHERE kind='SKU_CHARGE'")).rows;
   assert.equal(charges.length,15);assert.equal(new Set(charges.map(row=>row.task_id+':'+row.sku)).size,15);assert.ok(charges.every(row=>Number(row.amount_cents)===-123));
   await billing.recover();for(const task of tasks)await billing.reconcile({accountId:'owner',taskId:task.id});
   assert.equal((await pool.query("SELECT count(*)::int n FROM ai_wallet_entries WHERE kind='SKU_CHARGE'")).rows[0].n,15);
   assert.equal(localPeak,1);assert.equal(remotePeak,5);assert.equal(pool.waitingCount,0);
  });
  await t.test('finalization only submits released, complete products then polls without regenerating',async()=>{
   for(let i=0;i<10;i++){
    const result=await service.processNext({phase:'media'});assert.equal(result.status,'READY_TO_SUBMIT');assert.equal(result.submissionStage,'prepared');
   }
   assert.equal(preparations.length,10);assert.equal(submissions.length,0,'media preparation cannot send the import');
   for(let i=0;i<10;i++)assert.equal((await service.processNext({phase:'finalize'})).status,'SUBMITTED');
   now+=15000;for(let i=0;i<10;i++)assert.equal((await service.processNext({phase:'finalize'})).status,'COMPLETED');
   assert.equal(submissions.length,10);assert.equal(requests.length,20);assert.equal(await service.processNext({phase:'generate'}),null);
  });
  await t.test('unknown send pauses, releases unused SKU funds and retry retains successful images; cancellation charges no incomplete SKU',async()=>{
   const uncertain=await makeTask('unknown',2,'SINGLE',false);unknownTask=uncertain.id;
   assert.equal((await service.processNext({phase:'generate',capacity:5})).status,'GENERATING');
   assert.equal(requests.filter(row=>row.taskId===uncertain.id).length,2,'first turn finishes the first SKU before yielding');
   assert.equal((await service.processNext({phase:'generate',capacity:5})).status,'GENERATION_FAILED');
   const before=await repository.get({accountId:'owner',taskId:uncertain.id});const completed=before.images.filter(image=>image.generatedUrl);assert.equal(completed.length,2);
   assert.equal((await pool.query("SELECT reserved_cents FROM ai_user_wallets WHERE account_id='owner'")).rows[0].reserved_cents,'0');
   const count=requests.length;assert.equal(await service.processNext({phase:'generate'}),null);assert.equal(requests.length,count);
   const quarantined=reservations.filter(row=>row.taskId===uncertain.id).at(-1).channelId;
   assert.ok((await pool.query('SELECT request_hold_until>NOW() AS held FROM ai_user_channels WHERE id=$1',[quarantined])).rows[0].held);
   await service.retryTask({accountId:'owner',taskId:uncertain.id});assert.equal((await service.processNext({phase:'generate',capacity:5})).status,'READY_TO_SUBMIT');
   const after=await repository.get({accountId:'owner',taskId:uncertain.id});assert.deepEqual(after.images.slice(0,2).map(image=>image.generatedUrl),completed.map(image=>image.generatedUrl));
   assert.equal(requests.filter(row=>row.taskId===uncertain.id).length,5);
   const cancel=await makeTask('cancel',1,'SINGLE');const running=service.processNext({phase:'generate',capacity:5});workers.push(running);
   await bounded(controls.get(cancel.id).entered.promise,'cancellable task reaching remote call');await service.cancelTask({accountId:'owner',taskId:cancel.id});
   assert.equal((await pool.query('SELECT count(*)::int n FROM ai_user_channels WHERE product_task_id=$1',[cancel.id])).rows[0].n,1,'in-flight cancellation holds its product until response unwinds');
   controls.get(cancel.id).gate.resolve();assert.equal((await bounded(running,'cancelled request completion')).status,'CANCELLED');
   assert.equal((await repository.get({accountId:'owner',taskId:cancel.id})).images.filter(image=>image.generatedUrl).length,1,'the already-paid result must be saved before cancellation');
   assert.equal((await pool.query("SELECT count(*)::int n FROM ai_wallet_entries WHERE kind='SKU_CHARGE' AND task_id=$1",[cancel.id])).rows[0].n,0);
   const wallet=(await pool.query("SELECT balance_cents,reserved_cents FROM ai_user_wallets WHERE account_id='owner'")).rows[0];assert.equal(Number(wallet.balance_cents),10000-17*123);assert.equal(Number(wallet.reserved_cents),0);
  });
  t.diagnostic(JSON.stringify({syntheticJourneyMs:Math.round(performance.now()-started),initialProducts:10,initialSkus:15,completedSkuTurns:turns.length,initialImages:30,initialGatewayRequests:20,allGatewayRequests:requests.length,persistedObjects:objects.size,localPeak,remotePeak,finalBalanceCents:10000-17*123,reservedCents:0}));
 }finally{
  for(const control of controls.values())control.gate.resolve();await bounded(Promise.allSettled(workers),'worker cleanup',15000);
  await pool?.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();
 }
});
