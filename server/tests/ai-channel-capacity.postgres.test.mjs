import './support/dedicated-postgres-test-environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import sharp from 'sharp';
import {createAiUserChannels} from '../ai-user-channels.mjs';
import {createAiRuntimeSettings} from '../ai-runtime-settings.mjs';
import {createAiListingRepository} from '../ai-listing-repository.mjs';
import {createAiListingService} from '../ai-listing-service.mjs';
import {createAiListingGridPort} from '../ai-listing-runtime.mjs';

const actor={id:'admin',role:'admin'};
const descriptor={available:true,sample:{version:'capacity-fixture',images:[{index:0,url:'/fixture.png'}]},prompt:{text:'fixture'},image:{},expected:{count:1,width:10,height:10}};
const imageResult={images:[{index:0,width:10,height:10}]};

test('ended uncertain requests protect their billing group without taking a live request slot', {skip:process.env.SONLI_POSTGRES_TESTS!=='1'},async t=>{
  const schema='channel_capacity_'+randomUUID().replaceAll('-','');
  const admin=new pg.Pool({connectionString:process.env.DATABASE_URL});let pool;
  try{
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool=new pg.Pool({connectionString:process.env.DATABASE_URL,options:`-c search_path=${schema}`,max:12});
    await pool.query(`CREATE TABLE accounts(id TEXT PRIMARY KEY,username TEXT,status TEXT,created_at TIMESTAMPTZ DEFAULT NOW());
      INSERT INTO accounts(id) VALUES('admin'),('a'),('b');
      CREATE TABLE ai_gateway_profiles(id TEXT PRIMARY KEY,account_id TEXT,display_name TEXT,base_url TEXT,api_key_env_name TEXT,text_protocol TEXT,image_protocol TEXT,text_model TEXT,image_model TEXT,config_version INTEGER,enabled BOOLEAN,created_by TEXT)`);
    for(const name of ['108_ai_user_channels.sql','109_unified_user_ai_channels.sql','110_user_channel_capability_checks.sql','111_ai_channel_health.sql','113_ai_channel_delete.sql','114_ai_channel_price_checks.sql'])await pool.query(await readFile(new URL('../db/migrations/'+name,import.meta.url),'utf8'));
    await pool.query('ALTER TABLE ai_user_channel_requests ADD COLUMN estimated_cost_cny NUMERIC(18,6)');
    for(const name of ['130_ai_channel_pricing.sql','134_ai_product_channels.sql'])await pool.query(await readFile(new URL('../db/migrations/'+name,import.meta.url),'utf8'));
    await pool.query(`INSERT INTO ai_gateway_profiles(id) VALUES('p1'),('p2'),('p3');
      INSERT INTO ai_user_channels(id,account_id,created_by,name,base_url,text_model,image_model,billing_account,credential,key_fingerprint,profile_id,image_protocol)
      VALUES('c1','a','admin','one','https://gateway.example/v1','','image','shared','{}','key1','p1','SUB2API_OPENAI_IMAGES'),
      ('c2','b','admin','two','https://gateway.example/v1','','image','shared','{}','key2','p2','SUB2API_OPENAI_IMAGES'),
      ('c3','b','admin','three','https://gateway.example/v1','','image','independent','{}','key3','p3','SUB2API_OPENAI_IMAGES')`);
    await pool.query("UPDATE ai_user_channels SET lease_token='legacy-live',lease_until=NOW()+INTERVAL '15 minutes' WHERE id='c1'");
    const legacy=(await pool.query("SELECT lease_until FROM ai_user_channels WHERE id='c1'")).rows[0];
    await pool.query(await readFile(new URL('../db/migrations/151_ai_channel_request_holds.sql',import.meta.url),'utf8'));
    await t.test('additive migration preserves an existing live or legacy quarantined lease',async()=>{
      const migrated=(await pool.query("SELECT lease_token,lease_until,request_hold_until FROM ai_user_channels WHERE id='c1'")).rows[0];
      assert.equal(migrated.lease_token,'legacy-live');assert.equal(migrated.lease_until.getTime(),legacy.lease_until.getTime());assert.equal(migrated.request_hold_until,null);
    });
    let settings={productConcurrency:3,requestConcurrency:1,billingConcurrency:1,localConcurrency:1,adaptiveEnabled:false};
    const makeService=(options={})=>createAiUserChannels({pool,getRuntimeSettings:()=>settings,cipher:{decrypt:()=> 'test-only'},gatewayFactory:()=>({listModels:async()=>({models:[{id:'image-new'}]})}),getTestSample:async()=>descriptor,generateTestGrid:async()=>imageResult,...options});
    const service=makeService();
    const request=(channelId,key,extra={})=>({accountId:channelId==='c1'?'a':'b',channelId,taskId:key,requestKey:key,...extra});
    const row=async id=>(await pool.query('SELECT * FROM ai_user_channels WHERE id=$1',[id])).rows[0];
    const reset=async()=>{
      await pool.query('DELETE FROM ai_user_channel_requests');
      await pool.query('UPDATE ai_user_channels SET enabled=TRUE,deleted_at=NULL,lease_token=NULL,lease_until=NULL,request_hold_until=NULL,product_task_id=NULL,product_token=NULL,product_lease_until=NULL,capability_check=NULL,connection_check=NULL,failure_count=0,needs_attention=FALSE,cooldown_until=NULL,last_error_code=NULL');
      settings={...settings,requestConcurrency:1,billingConcurrency:1};
    };
    await t.test('unknown failure releases live lease, preserves 15-minute hold, and independent billing proceeds',async()=>{
      await reset();
      await assert.rejects(service.run(request('c1','unknown'),async()=>{throw Object.assign(new Error('EOF'),{code:'AI_GATEWAY_UNEXPECTED_EOF',deliveryState:'POSSIBLY_SENT'});}),{deliveryState:'POSSIBLY_SENT'});
      const ended=await row('c1');assert.equal(ended.lease_until,null);assert.equal(ended.lease_token,null);
      assert.ok(Date.parse(ended.request_hold_until)>Date.now()+14*60_000);
      assert.equal((await service.workingStatus('a')).channels[0].state,'cooling');
      assert.equal((await createAiRuntimeSettings({pool}).activeCounts()).activeRequests,0);
      await service.run(request('c3','independent'),async()=>({}));
      for(const id of ['c1','c2'])await assert.rejects(service.run(request(id,'blocked-'+id,{healthProbe:true}),()=>assert.fail('protected billing was reused')),{code:'AI_GATEWAY_NO_CAPACITY',deliveryState:'NOT_SENT'});
      await assert.rejects(service.reserveProduct({accountId:'b',taskId:'same-billing',excludeChannelIds:['c3']}),{code:'AI_GATEWAY_NO_CAPACITY'});
      await assert.rejects(service.updateModels(actor,'c1',{imageModel:'image-new',billingAccount:'escape'}),{statusCode:409});
      await service.setEnabled(actor,'c1',false);
      await assert.rejects(service.run(request('c2','disabled-hold'),()=>assert.fail('disabled hold disappeared')),{code:'AI_GATEWAY_NO_CAPACITY'});
      await assert.rejects(service.remove(actor,'c1'),{statusCode:400});
      await pool.query("UPDATE ai_user_channels SET request_hold_until=NOW()-INTERVAL '1 second' WHERE id='c1'");
      await service.run(request('c2','after-hold'),async()=>({}));
    });
    await t.test('NOT_SENT releases immediately while existing health penalties remain',async()=>{
      await reset();
      await assert.rejects(service.run(request('c1','rejected'),async()=>{throw Object.assign(new Error('limited'),{code:'AI_GATEWAY_RATE_LIMITED',deliveryState:'NOT_SENT'});}),{deliveryState:'NOT_SENT'});
      const ended=await row('c1');assert.equal(ended.lease_until,null);assert.equal(ended.request_hold_until,null);assert.equal(ended.failure_count,1);assert.ok(Date.parse(ended.cooldown_until)>Date.now());
      await service.run(request('c2','same-billing-after-reject'),async()=>({}));
    });
    await t.test('concurrent ordinary calls and tests never exceed global admission',async()=>{
      await reset();settings={...settings,billingConcurrency:3};
      let entered,finish;const reached=new Promise(r=>entered=r),gate=new Promise(r=>finish=r);
      const first=service.run(request('c1','running'),async()=>{entered();await gate;return {};});await reached;
      try{
        const blocked=await Promise.allSettled(['c2','c3'].map(id=>service.run(request(id,'contender-'+id,{healthProbe:true}),()=>assert.fail('global cap exceeded'))));
        assert.equal(blocked.filter(r=>r.status==='rejected'&&r.reason.code==='AI_GATEWAY_NO_CAPACITY').length,2);
        assert.equal((await createAiRuntimeSettings({pool}).activeCounts()).activeRequests,1);
      }finally{finish();await first;}
    });
    await t.test('blocked oldest test does not prevent an independent billing test',async()=>{
      await reset();settings={...settings,requestConcurrency:2};
      await pool.query("UPDATE ai_user_channels SET request_hold_until=NOW()+INTERVAL '15 minutes' WHERE id='c1'");
      await service.queueCapability(actor,'c2',{id:'held-test',confirmed:true});
      await service.queueCapability(actor,'c3',{id:'free-test',confirmed:true});
      const selected=[];const worker=makeService({generateTestGrid:async input=>{selected.push(input.channelId);return imageResult;}});
      await worker.processNextCapability();assert.deepEqual(selected,['c3']);assert.equal((await row('c2')).capability_check.status,'QUEUED');
      assert.equal((await row('c3')).capability_check.status,'PENDING_REVIEW');
      const current=(await service.overview(actor)).channels.find(c=>c.id==='c2');
      assert.equal(current.active_test.waitReason,'result_unknown');assert.ok(Date.parse(current.active_test.retryAt)>Date.now());
      assert.equal(current.active_test.stage,'waiting_capacity');
      assert.ok(!JSON.stringify(current.active_test).includes('shared'));
    });
    await t.test('a model found missing after queueing fails unsent and lets the next test use the single slot',async()=>{
      await reset();let worker;const prepared=[],sent=[];
      worker=makeService({generateTestGrid:async input=>{
        prepared.push(input.channelId);await worker.run(input,async()=>{sent.push(input.channelId);return {};});return imageResult;
      }});
      await worker.queueCapability(actor,'c1',{id:'oldest-model-missing',confirmed:true});
      await worker.queueCapability(actor,'c3',{id:'next-model-available',confirmed:true});
      await pool.query(`UPDATE ai_user_channels SET connection_check='{"status":"MODEL_MISSING"}'::jsonb WHERE id='c1'`);
      await worker.processNextCapability();
      const missing=(await row('c1')).capability_check;
      assert.equal(missing.status,'FAILED');assert.equal(missing.stage,'completed');assert.equal(missing.deliveryState,'NOT_SENT');
      assert.equal(missing.errorCode,'AI_GATEWAY_MODEL_UNAVAILABLE');assert.match(missing.message,/所选模型不可用/);
      assert.deepEqual(prepared,['c3']);assert.deepEqual(sent,['c3']);assert.equal((await row('c3')).capability_check.status,'PENDING_REVIEW');
      assert.equal((await worker.overview(actor)).channels.find(c=>c.id==='c1').active_test,null);
      assert.equal(await worker.processNextCapability(),null);
      assert.equal((await worker.queueCapability(actor,'c1',{id:'oldest-model-missing',confirmed:true})).status,'FAILED');
      assert.deepEqual(sent,['c3']);assert.equal((await pool.query('SELECT count(*)::int n FROM ai_user_channel_requests')).rows[0].n,1);
    });
    await t.test('queue reasons distinguish lane, own occupancy, billing occupancy, and global capacity',async()=>{
      await reset();await service.queueCapability(actor,'c2',{id:'why-wait',confirmed:true});
      const progress=async()=>((await service.overview(actor)).channels.find(c=>c.id==='c2')).active_test;
      assert.equal((await progress()).waitReason,'test_queue');assert.equal((await progress()).id,'why-wait');
      await pool.query("UPDATE ai_user_channels SET lease_token='test',lease_until=NOW()+INTERVAL '2 minutes' WHERE id='c2'");
      assert.equal((await progress()).waitReason,'channel_busy');
      await pool.query("UPDATE ai_user_channels SET lease_token=NULL,lease_until=NULL WHERE id='c2'");
      await pool.query("UPDATE ai_user_channels SET lease_token='test',lease_until=NOW()+INTERVAL '2 minutes' WHERE id='c1'");
      assert.equal((await progress()).waitReason,'billing_busy');
      await pool.query("UPDATE ai_user_channels SET lease_token=NULL,lease_until=NULL WHERE id='c1'");
      await pool.query("UPDATE ai_user_channels SET lease_token='test',lease_until=NOW()+INTERVAL '2 minutes' WHERE id='c3'");
      assert.equal((await progress()).waitReason,'request_capacity');assert.equal((await progress()).retryAt,null);
      const savedView=await service.overview(actor,{runtimeSettings:{...settings,requestConcurrency:2}});
      assert.equal(savedView.channels.find(c=>c.id==='c2').active_test.waitReason,'test_queue','API uses saved limits supplied independently of worker settings');
      assert.equal(await service.processNextCapability(),null);assert.equal((await row('c2')).capability_check.status,'QUEUED');
    });
    await t.test('allocation race returns the same test to the queue without a paid record or infinite wait',async()=>{
      await reset();let sends=0;let preempt=true;let worker;
      worker=makeService({requestWaitMs:25,requestRetryMs:5,generateTestGrid:async input=>{
        if(preempt)await pool.query("UPDATE ai_user_channels SET lease_token='race',lease_until=NOW()+INTERVAL '2 minutes' WHERE id='c3'");
        await worker.run(input,async()=>{sends++;return {};});return imageResult;
      }});
      const initial=await worker.queueCapability(actor,'c2',{id:'allocation-race',confirmed:true});
      const raced=await worker.processNextCapability();assert.equal(raced.status,'QUEUED');assert.equal(raced.id,'allocation-race');assert.equal(raced.startedAt,initial.startedAt);assert.equal(sends,0);
      assert.equal((await pool.query('SELECT count(*)::int n FROM ai_user_channel_requests')).rows[0].n,0);
      preempt=false;await pool.query("UPDATE ai_user_channels SET lease_token=NULL,lease_until=NULL WHERE id='c3'");
      await worker.processNextCapability();await worker.processNextCapability();assert.equal(sends,1);
      assert.equal((await row('c2')).capability_check.status,'PENDING_REVIEW');
    });
    await t.test('unknown sent test is not requeued or replayed; upstream NOT_SENT records also stay final',async()=>{
      for(const [id,code,deliveryState] of [['unknown-test','AI_GATEWAY_UNEXPECTED_EOF','POSSIBLY_SENT'],['upstream-busy','AI_GATEWAY_NO_CAPACITY','NOT_SENT']]){
        await reset();let sends=0;let worker;
        worker=makeService({generateTestGrid:async input=>{await worker.run(input,async()=>{sends++;throw Object.assign(new Error('provider failure'),{code,deliveryState});});return imageResult;}});
        await worker.queueCapability(actor,'c2',{id,confirmed:true});
        assert.equal((await worker.processNextCapability()).status,'FAILED');
        await worker.processNextCapability();await worker.queueCapability(actor,'c2',{id,confirmed:true});assert.equal(sends,1);
        assert.equal((await pool.query('SELECT count(*)::int n FROM ai_user_channel_requests')).rows[0].n,1);
      }
    });
    await t.test('a timed-out product remains failed while an independent capability test generates and saves a real slice once',async()=>{
      await reset();
      for(const name of ['106_ai_image_listing.sql','135_ai_product_scheduling.sql','141_ai_listing_task_controls.sql'])await pool.query(await readFile(new URL('../db/migrations/'+name,import.meta.url),'utf8'));
      const source={collectItemId:'product-source',sku:'sku-one',items:[{sku:'sku-one',images:['https://source.invalid/product.png'],listingItem:{weight:200,depth:100,width:110,height:120,price:'10',currency_code:'CNY'}}]};
      const sample=await sharp({create:{width:30,height:40,channels:3,background:'#2684a8'}}).png().toBuffer();
      const stored=new Map();let productRequests=0,testRequests=0,worker;
      worker=makeService({
        getTestSample:async()=>({...descriptor,image:{ratio:'3:4',language:'ru',quality:'high'},expected:{count:1,width:768,height:1024}}),
        gatewayFactory:()=>({generateImage:async input=>{testRequests++;return {bytes:input.sourceImages[0].bytes,contentType:'image/png',requestId:'synthetic-test-result'};}}),
        generateTestGrid:(input,onProgress)=>createAiListingGridPort({downloadImage:async()=>({buffer:sample}),recognizeText:async images=>images.map(()=> 'fixture product'),
          runChannel:(input,generate)=>worker.run(input,generate),onProgress,publication:{prefix:'fixture',baseUrl:'https://media.invalid/'},putObject:async({key,buffer})=>stored.set(key,buffer)})(input),
      });
      const repository=createAiListingRepository({pool});
      const listing=createAiListingService({repository,loadSources:async()=>[source],reserveChannel:input=>worker.reserveProduct(input),
        generateImage:input=>worker.run(input,async()=>{productRequests++;throw Object.assign(new Error('synthetic upstream timeout'),{code:'GATEWAY_TIMEOUT',deliveryState:'POSSIBLY_SENT'});})});
      const [product]=await listing.createFromCollect({accountId:'a',collectItemIds:[source.collectItemId],idempotencyKey:'timed-product',config:{targetStoreId:'fixture-store',targetWarehouseId:'fixture-warehouse',generationMode:'SINGLE',manualReview:true}});
      assert.equal((await listing.processNext({phase:'generate',capacity:3})).status,'GENERATION_FAILED');
      assert.equal(productRequests,1);assert.equal((await row('c1')).lease_until,null);assert.ok(Date.parse((await row('c1')).request_hold_until)>Date.now());
      await worker.queueCapability(actor,'c2',{id:'same-billing-stays-queued',confirmed:true});
      await worker.queueCapability(actor,'c3',{id:'independent-grid',confirmed:true});
      const result=await worker.processNextCapability();assert.equal(result.status,'PENDING_REVIEW');assert.equal(result.id,'independent-grid');assert.equal(result.images.length,1);
      const saved=await sharp(stored.get(result.images[0].objectKey)).metadata();assert.equal(saved.width,768);assert.equal(saved.height,1024);
      assert.equal(await worker.processNextCapability(),null);assert.equal(await listing.processNext({phase:'generate',capacity:3}),null);
      assert.equal((await repository.get({accountId:'a',taskId:product.id})).status,'GENERATION_FAILED');assert.equal(productRequests,1);assert.equal(testRequests,1);
      assert.equal((await pool.query('SELECT count(*)::int n FROM ai_user_channel_requests WHERE task_id=$1',[product.id])).rows[0].n,1);
      assert.equal((await pool.query('SELECT count(*)::int n FROM ai_user_channel_requests')).rows[0].n,2);
    });
  }finally{await pool?.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
});
