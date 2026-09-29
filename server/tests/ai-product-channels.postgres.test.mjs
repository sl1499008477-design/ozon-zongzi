import './support/dedicated-postgres-test-environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {createAiUserChannels} from '../ai-user-channels.mjs';

const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
test('product ownership and request leases remain independently fenced', {skip:process.env.SONLI_POSTGRES_TESTS!=='1'},async t=>{
  const schema='product_channels_'+randomUUID().replaceAll('-','');
  const admin=new pg.Pool({connectionString:process.env.DATABASE_URL});let pool;
  const held=[];
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool=new pg.Pool({connectionString:process.env.DATABASE_URL,options:`-c search_path=${schema}`,max:12});
    await pool.query(`CREATE TABLE accounts(id TEXT PRIMARY KEY); INSERT INTO accounts VALUES('admin'),('a'),('b');
      CREATE TABLE ai_gateway_profiles(id TEXT PRIMARY KEY,account_id TEXT,display_name TEXT,base_url TEXT,api_key_env_name TEXT,text_protocol TEXT,image_protocol TEXT,text_model TEXT,image_model TEXT,config_version INTEGER,enabled BOOLEAN,created_by TEXT)`);
    for(const name of ['108_ai_user_channels.sql','109_unified_user_ai_channels.sql','110_user_channel_capability_checks.sql','111_ai_channel_health.sql','113_ai_channel_delete.sql','114_ai_channel_price_checks.sql']) await pool.query(await readFile(new URL('../db/migrations/'+name,import.meta.url),'utf8'));
    await pool.query('ALTER TABLE ai_user_channel_requests ADD COLUMN estimated_cost_cny NUMERIC(18,6)');
    await pool.query(await readFile(new URL('../db/migrations/130_ai_channel_pricing.sql',import.meta.url),'utf8'));
    await pool.query(await readFile(new URL('../db/migrations/134_ai_product_channels.sql',import.meta.url),'utf8'));
    await pool.query(await readFile(new URL('../db/migrations/151_ai_channel_request_holds.sql',import.meta.url),'utf8'));
    await pool.query(`INSERT INTO ai_gateway_profiles(id) SELECT 'p'||i FROM generate_series(1,12)i;
      INSERT INTO ai_user_channels(id,account_id,created_by,name,base_url,text_model,image_model,billing_account,credential,key_fingerprint,profile_id,image_protocol)
      SELECT 'c'||i,CASE WHEN i<=8 THEN 'a' ELSE 'b' END,'admin','C'||i,'https://gateway.example/v1','','image','shared','{}','key'||i,'p'||i,'SUB2API_OPENAI_IMAGES' FROM generate_series(1,12)i`);
    const service=createAiUserChannels({pool,env:{AI_LISTING_CONCURRENCY:'5'},cipher:{decrypt:()=> 'test-only'},gatewayFactory:()=>({listModels:async()=>({models:[{id:'image'},{id:'image-new'}]})}),requestRetryMs:5,requestWaitMs:1000});
    const reserve=async(input)=>{const h=await service.reserveProduct(input);held.push(h);return h;};
    const run=(h,key,generate=async({profile})=>({profileId:profile.id}))=>service.run({accountId:'a',taskId:h.taskId||'one',channelId:h.channelId,productToken:h.productToken,requestKey:key},generate);
    await t.test('ten competing products across accounts admit only five globally',async()=>{
      const results=await Promise.allSettled(Array.from({length:10},(_,i)=>reserve({accountId:i<6?'a':'b',taskId:'cap'+i,capacity:5})));
      assert.equal(results.filter(r=>r.status==='fulfilled').length,5);
      assert.equal(new Set(held.map(h=>h.channelId)).size,5);
      assert.equal((await service.workingStatus('a')).counts.working+(await service.workingStatus('b')).counts.working,5);
      await Promise.all(held.map(h=>h.release()));
    });
    await t.test('ordinary jobs and administrator tests share the global request limit across billing accounts',async()=>{
      const limited=createAiUserChannels({pool,env:{AI_LISTING_REQUEST_CONCURRENCY:'1',AI_LISTING_BILLING_CONCURRENCY:'5'},cipher:{decrypt:()=> 'fixture-only'},gatewayFactory:()=>({})});
      let enter,finish;const reached=new Promise(r=>enter=r),gate=new Promise(r=>finish=r);
      const first=limited.run({accountId:'a',taskId:'global-one',channelId:'c1',requestKey:'global-one'},async()=>{enter();await gate;return {};});
      await reached;
      try {
        await assert.rejects(limited.run({accountId:'b',taskId:'channel-test:global-two',channelId:'c9',healthProbe:true,requestKey:'global-two'},()=>assert.fail('exceeded global request cap')),{code:'AI_GATEWAY_NO_CAPACITY'});
        assert.equal((await pool.query('SELECT count(*)::int n FROM ai_user_channels WHERE lease_until>NOW()')).rows[0].n,1);
      } finally {finish();await first;}
      await limited.run({accountId:'b',taskId:'global-two',channelId:'c9',requestKey:'global-two'},async()=>({}));
    });
    await t.test('saved product limits raise and lower new admission without releasing existing owners',async()=>{
      let settings={productConcurrency:1,requestConcurrency:3,billingConcurrency:3};
      const dynamic=createAiUserChannels({pool,getRuntimeSettings:()=>settings});
      const first=await dynamic.reserveProduct({accountId:'a',taskId:'dynamic-one'});held.push(first);
      await assert.rejects(dynamic.reserveProduct({accountId:'a',taskId:'dynamic-two'}),{code:'AI_GATEWAY_NO_CAPACITY'});
      settings={...settings,productConcurrency:3};
      const second=await dynamic.reserveProduct({accountId:'a',taskId:'dynamic-two'});held.push(second);
      settings={...settings,productConcurrency:1};
      await first.release();
      await assert.rejects(dynamic.reserveProduct({accountId:'a',taskId:'dynamic-three'}),{code:'AI_GATEWAY_NO_CAPACITY'});
      assert.equal((await pool.query('SELECT product_token FROM ai_user_channels WHERE id=$1',[second.channelId])).rows[0].product_token,second.productToken);
      await second.release();const third=await dynamic.reserveProduct({accountId:'a',taskId:'dynamic-three'});held.push(third);await third.release();
    });
    for(const field of ['requestConcurrency','billingConcurrency'])await t.test(`waiting paid calls reread ${field}; lowering drains active calls before admitting another`,async()=>{
      let settings={productConcurrency:3,requestConcurrency:3,billingConcurrency:3,[field]:1};
      const dynamic=createAiUserChannels({pool,getRuntimeSettings:()=>settings,cipher:{decrypt:()=> 'fixture-only'},gatewayFactory:()=>({}),requestRetryMs:5,requestWaitMs:2000});
      const owners=[];for(let i=0;i<3;i++){const h=await dynamic.reserveProduct({accountId:'a',taskId:field+i});owners.push(h);held.push(h);}
      const releases=[],entered=[],running=[];
      const waitUntil=async check=>{for(let i=0;i<100&&!check();i++)await delay(5);assert.ok(check(),'bounded live admission');};
      const launch=i=>{const h=owners[i];const promise=dynamic.run({accountId:'a',taskId:field+i,channelId:h.channelId,productToken:h.productToken,requestKey:field+i},async()=>{entered.push(i);await new Promise(r=>releases[i]=r);return {};});running.push(promise);return promise;};
      try{
        launch(0);await waitUntil(()=>entered.length===1);launch(1);await delay(25);assert.deepEqual(entered,[0]);
        settings={...settings,[field]:2};await waitUntil(()=>entered.length===2);
        settings={...settings,[field]:1};launch(2);await delay(25);assert.deepEqual(entered,[0,1]);
        releases[0]();await running[0];await delay(25);assert.deepEqual(entered,[0,1]);
        releases[1]();await running[1];await waitUntil(()=>entered.length===3);releases[2]();await running[2];
      }finally{settings={...settings,[field]:3};for(let i=0;i<10;i++){releases.forEach(r=>r?.());await delay(5);}await Promise.allSettled(running);await Promise.all(owners.map(h=>h.release()));}
    });
    await t.test('same task race grants only one owner; two calls retain the channel',async()=>{
      const results=await Promise.allSettled([reserve({accountId:'a',taskId:'one'}),reserve({accountId:'a',taskId:'one'})]);
      assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
      const h=results.find(r=>r.status==='fulfilled').value;
      assert.equal((await run(h,'first')).generationConfig.channelId,h.channelId);
      assert.equal((await run(h,'second')).generationConfig.channelId,h.channelId);
      await assert.rejects(service.run({accountId:'b',taskId:'one',channelId:h.channelId,productToken:h.productToken,requestKey:'foreign'},()=>assert.fail('foreign gateway call')),{code:'AI_LISTING_PRODUCT_LEASE_LOST'});
      await assert.rejects(service.run({accountId:'a',taskId:'test',channelId:h.channelId,requestKey:'probe',healthProbe:true},()=>assert.fail('unbound steal')),{code:'AI_GATEWAY_NO_CAPACITY'});
      await h.release();
    });
    await t.test('idle bindings do not consume billing slots; waiting request keeps its binding and cancellation is free',async()=>{
      const a=await reserve({accountId:'a',taskId:'one'}),b=await reserve({accountId:'a',taskId:'two'});b.taskId='two';
      let finish,entered;const reached=new Promise(r=>entered=r),gate=new Promise(r=>finish=r);
      const first=run(a,'billing-first',async()=>{entered();await gate;return {};});await reached;
      const before=(await pool.query('SELECT count(*)::int n FROM ai_user_channel_requests')).rows[0].n;
      let callbacks=0;
      await assert.rejects(service.run({accountId:'a',taskId:'two',channelId:b.channelId,productToken:b.productToken,requestKey:'cancel',beforeRequest:()=>{if(++callbacks===2)throw Object.assign(new Error('cancel'),{code:'TASK_CANCELLED'});}},()=>assert.fail('cancelled gateway call')),{code:'TASK_CANCELLED'});
      assert.equal((await pool.query('SELECT count(*)::int n FROM ai_user_channel_requests')).rows[0].n,before);
      assert.equal((await pool.query('SELECT failure_count FROM ai_user_channels WHERE id=$1',[b.channelId])).rows[0].failure_count,0);
      let done=false;const second=run(b,'billing-second').then(r=>{done=true;return r;});await delay(20);assert.equal(done,false);
      finish();await first;await second;
      await a.release();await b.release();
    });
    await t.test('cancellation immediately before generate leaves no paid log and preserves health',async()=>{
      const h=await reserve({accountId:'a',taskId:'one'});let checks=0;
      await pool.query('UPDATE ai_user_channels SET failure_count=1 WHERE id=$1',[h.channelId]);
      await assert.rejects(service.run({accountId:'a',taskId:'one',channelId:h.channelId,productToken:h.productToken,requestKey:'cancel-final',beforeRequest:()=>{if(++checks===2)throw Object.assign(new Error('cancel'),{code:'TASK_CANCELLED'});}},()=>assert.fail('cancelled gateway call')),{code:'TASK_CANCELLED'});
      assert.equal((await pool.query("SELECT count(*)::int n FROM ai_user_channel_requests WHERE request_key='cancel-final'")).rows[0].n,0);
      assert.equal((await pool.query('SELECT failure_count FROM ai_user_channels WHERE id=$1',[h.channelId])).rows[0].failure_count,1);
      await h.release();
    });
    await t.test('task cancellation during request-log persistence fences the final external call',async()=>{
      const h=await reserve({accountId:'a',taskId:'one'});let cancelled=false;
      const fenced=createAiUserChannels({pool:{connect:()=>pool.connect(),query:async(sql,args)=>{const result=await pool.query(sql,args);if(sql.startsWith('INSERT INTO ai_user_channel_requests'))cancelled=true;return result;}},cipher:{decrypt:()=> 'test-only'},gatewayFactory:()=>({})});
      await assert.rejects(fenced.run({accountId:'a',taskId:'one',channelId:h.channelId,productToken:h.productToken,requestKey:'cancel-persist',beforeRequest:()=>{if(cancelled)throw Object.assign(new Error('cancel'),{code:'TASK_CANCELLED'});}},()=>assert.fail('request sent after cancellation')),{code:'TASK_CANCELLED'});
      assert.equal((await pool.query("SELECT count(*)::int n FROM ai_user_channel_requests WHERE request_key='cancel-persist'")).rows[0].n,0);
      await h.release();
    });
    await t.test('lease cancellation signal stays intact at the final pre-send fence',async()=>{
      const h=await reserve({accountId:'a',taskId:'one'}),cancelled=Symbol('lost task lease');let checks=0;
      await assert.rejects(service.run({accountId:'a',taskId:'one',channelId:h.channelId,productToken:h.productToken,requestKey:'symbol-cancel',beforeRequest:()=>{if(++checks===2)throw cancelled;}},()=>assert.fail('cancelled send')),error=>error===cancelled);
      assert.equal((await pool.query("SELECT count(*)::int n FROM ai_user_channel_requests WHERE request_key='symbol-cancel'")).rows[0].n,0);
      await h.release();
    });
    await t.test('expired token and stale release cannot use or clear replacement ownership',async()=>{
      const h=await reserve({accountId:'a',taskId:'one'});
      await pool.query("UPDATE ai_user_channels SET product_lease_until=NOW()-INTERVAL '1 second' WHERE id=$1",[h.channelId]);
      await assert.rejects(run(h,'expired'),{code:'AI_LISTING_PRODUCT_LEASE_LOST'});
      const replacement=await reserve({accountId:'a',taskId:'one',excludeChannelIds:Array.from({length:8},(_,i)=>'c'+(i+1)).filter(id=>id!==h.channelId)});assert.equal(replacement.channelId,h.channelId);await h.release();await h.release();
      assert.equal((await run(replacement,'replacement')).generationConfig.channelId,replacement.channelId);await replacement.release();
    });
    await t.test('bound model edits reject; disabling prevents the next request',async()=>{
      const h=await reserve({accountId:'a',taskId:'one'}),actor={id:'admin',role:'admin'};
      await assert.rejects(service.updateModels(actor,h.channelId,{imageModel:'image-new',billingAccount:'shared'}),{statusCode:409});
      await service.updateModels(actor,h.channelId,{imageModel:'image',billingAccount:'shared',pricing:{mode:'REQUEST',currency:'CNY',requestPrice:'0.2'}});
      await service.setEnabled(actor,h.channelId,false);await assert.rejects(run(h,'disabled'),{code:'AI_GATEWAY_NO_CAPACITY'});
      await h.release();await service.setEnabled(actor,h.channelId,true);
    });
    await t.test('service capacity cannot exceed the configured limit and zero admits no product',async()=>{
      const limited=createAiUserChannels({pool,env:{AI_LISTING_CONCURRENCY:'2'}});
      await assert.rejects(limited.reserveProduct({accountId:'a',taskId:'zero',capacity:0}),{code:'AI_GATEWAY_NO_CAPACITY'});
      const results=await Promise.allSettled(Array.from({length:4},(_,i)=>limited.reserveProduct({accountId:'a',taskId:'limited'+i,capacity:20})));
      const owners=results.filter(r=>r.status==='fulfilled').map(r=>r.value);held.push(...owners);
      assert.equal(owners.length,2);await Promise.all(owners.map(h=>h.release()));
    });
    await t.test('unavailable model catalogs cannot receive a new product',async()=>{
      await pool.query(`UPDATE ai_user_channels SET connection_check='{"status":"UNAVAILABLE"}' WHERE id='c1'`);
      await assert.rejects(reserve({accountId:'a',taskId:'unhealthy',excludeChannelIds:['c2','c3','c4','c5','c6','c7','c8']}),{code:'AI_GATEWAY_NO_CAPACITY'});
      await pool.query("UPDATE ai_user_channels SET connection_check=NULL WHERE id='c1'");
    });
    await t.test('heartbeat extends a live binding but cannot resurrect an expired binding',async()=>{
      const timed=createAiUserChannels({pool,env:{AI_LISTING_CONCURRENCY:'5'},productLeaseMs:150,productHeartbeatMs:10});
      const h=await timed.reserveProduct({accountId:'a',taskId:'heartbeat'});held.push(h);
      await delay(220);
      let row=(await pool.query('SELECT product_token,product_lease_until FROM ai_user_channels WHERE id=$1',[h.channelId])).rows[0];
      assert.equal(row.product_token,h.productToken);assert.ok(row.product_lease_until.getTime()>Date.now());
      await pool.query("UPDATE ai_user_channels SET product_lease_until=NOW()-INTERVAL '1 second' WHERE id=$1",[h.channelId]);
      await delay(30);row=(await pool.query('SELECT product_lease_until FROM ai_user_channels WHERE id=$1',[h.channelId])).rows[0];assert.ok(row.product_lease_until.getTime()<Date.now());
      await h.release();
    });
    await t.test('active paid request keeps its billing identity after product release',async()=>{
      const h=await reserve({accountId:'a',taskId:'one'}),actor={id:'admin',role:'admin'};
      let finish,entered;const reached=new Promise(r=>entered=r),gate=new Promise(r=>finish=r);
      const running=run(h,'draining',async()=>{entered();await gate;return {};});await reached;await h.release();
      try {
        await assert.rejects(service.updateModels(actor,h.channelId,{imageModel:'image-new',billingAccount:'other'}),{statusCode:409});
        await service.updateModels(actor,h.channelId,{imageModel:'image',billingAccount:'shared',pricing:{mode:'REQUEST',currency:'CNY',requestPrice:'0.3'}});
        await assert.rejects(service.run({accountId:'a',taskId:'other',requestKey:'old-billing-capacity',excludeChannelIds:[h.channelId]},()=>assert.fail('old billing group over-allocated')),{code:'AI_GATEWAY_NO_CAPACITY'});
      }finally{finish();await running;}
    });
    await t.test('identity edit rechecks request occupancy after catalog validation under allocation lock',async()=>{
      let finish,entered,running;const reached=new Promise(r=>entered=r),gate=new Promise(r=>finish=r);
      const editing=createAiUserChannels({pool,cipher:{decrypt:()=> 'test-only'},gatewayFactory:()=>({listModels:async()=>{
        running=service.run({accountId:'a',channelId:'c2',taskId:'race',requestKey:'identity-race'},async()=>{entered();await gate;return {};});await reached;
        return {models:[{id:'image-new'}]};
      }})});
      try {await assert.rejects(editing.updateModels({id:'admin',role:'admin'},'c2',{imageModel:'image-new',billingAccount:'other'}),{statusCode:409});}
      finally {finish();await running;}
      assert.equal((await pool.query("SELECT billing_account FROM ai_user_channels WHERE id='c2'")).rows[0].billing_account,'shared');
    });
    await t.test('read-only gateway delivery evidence remains intact in the caller error contract',async()=>{
      for(const deliveryState of ['NOT_SENT','POSSIBLY_SENT']) {
        const h=await reserve({accountId:'a',taskId:'one'});
        const original=Object.assign(new Error('provider outcome'),{code:'RETRYABLE_GATEWAY'});
        Object.defineProperty(original,'deliveryState',{value:deliveryState,writable:false,configurable:false,enumerable:true});
        try {await assert.rejects(run(h,'readonly-'+deliveryState,async()=>{throw original;}),error=>{
          assert.equal(error,original);assert.equal(error.deliveryState,deliveryState);assert.equal(Object.getOwnPropertyDescriptor(error,'deliveryState').writable,false);return true;
        });}finally{await h.release();await pool.query('UPDATE ai_user_channels SET lease_token=NULL,lease_until=NULL,request_hold_until=NULL,cooldown_until=NULL WHERE id=$1',[h.channelId]);}
      }
    });
    await t.test('unknown transport outcomes retain a conservative request quarantine',async()=>{
      const h=await reserve({accountId:'a',taskId:'one'});
      await assert.rejects(run(h,'unknown',async()=>{throw Object.assign(new Error('connection dropped'),{code:'RETRYABLE_GATEWAY'});}),{code:'RETRYABLE_GATEWAY',deliveryState:'POSSIBLY_SENT',channelId:h.channelId});
      await h.release();
      const row=(await pool.query('SELECT lease_until,request_hold_until FROM ai_user_channels WHERE id=$1',[h.channelId])).rows[0];assert.equal(row.lease_until,null);assert.ok(Date.parse(row.request_hold_until)>Date.now());
      await pool.query('UPDATE ai_user_channels SET lease_token=NULL,lease_until=NULL,request_hold_until=NULL,cooldown_until=NULL WHERE id=$1',[h.channelId]);
    });
    await t.test('uncertain requests retain a separate protection hold after product release',async()=>{
      const h=await reserve({accountId:'a',taskId:'one'});
      await assert.rejects(run(h,'uncertain',async()=>{throw Object.assign(new Error('EOF'),{code:'AI_GATEWAY_UNEXPECTED_EOF',deliveryState:'POSSIBLY_SENT'});}));
      await h.release();
      const row=(await pool.query('SELECT lease_until,lease_token,request_hold_until FROM ai_user_channels WHERE id=$1',[h.channelId])).rows[0];assert.equal(row.lease_until,null);assert.ok(Date.parse(row.request_hold_until)>Date.now());assert.equal(row.lease_token,null);
      await assert.rejects(service.updateModels({id:'admin',role:'admin'},h.channelId,{imageModel:'image-new',billingAccount:'other'}),{statusCode:409});
      assert.equal((await pool.query('SELECT billing_account FROM ai_user_channels WHERE id=$1',[h.channelId])).rows[0].billing_account,'shared');
      await assert.rejects(service.run({accountId:'a',channelId:h.channelId,taskId:'test',requestKey:'cannot-reuse',healthProbe:true},()=>assert.fail('quarantined call')),{code:'AI_GATEWAY_NO_CAPACITY'});
    });
  }finally{await Promise.all(held.map(h=>h.release().catch(()=>{})));await pool?.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
});
