import './support/dedicated-postgres-test-environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,access} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {createAiListingRuntime} from '../ai-listing-runtime.mjs';

const settings={productConcurrency:3,requestConcurrency:3,localConcurrency:1,billingConcurrency:1,adaptiveEnabled:false};
test('settings route authorizes before reading configuration or initializing backend',async()=>{
  for(const actor of [null,{id:'user',role:'user'}]){
    let response;const runtime=createAiListingRuntime({authenticate:async()=>actor,resolvePool:()=>assert.fail('unauthorized database access'),readJson:()=>assert.fail('unauthorized body read'),sendJson:(_res,status,body)=>response={status,body}});
    for(const method of ['GET','PUT']){assert.equal(await runtime.handleRoute({method},{},new URL('http://localhost/api/admin/ai-runtime-settings')),true);assert.equal(response.status,403);}
  }
});
test('settings persist with optimistic locking and independently acknowledged worker freshness',{skip:process.env.SONLI_POSTGRES_TESTS!=='1'},async()=>{
  assert.equal(await access(new URL('../ai-runtime-settings.mjs',import.meta.url)).then(()=>true,()=>false),true,'settings module exists');
  const {createAiRuntimeSettings}=await import('../ai-runtime-settings.mjs');
  const schema='runtime_settings_'+randomUUID().replaceAll('-','');const admin=new pg.Pool({connectionString:process.env.DATABASE_URL});let pool;
  try{
    await admin.query(`CREATE SCHEMA ${schema}`);pool=new pg.Pool({connectionString:process.env.DATABASE_URL,options:`-c search_path=${schema}`});
    await pool.query(await readFile(new URL('../db/migrations/136_ai_runtime_settings.sql',import.meta.url),'utf8'));
    let now=Date.now();const store=createAiRuntimeSettings({pool,env:{AI_LISTING_ADAPTIVE_CONCURRENCY:'0'},now:()=>now});
    const initial=await store.read();assert.deepEqual(initial.settings,settings);assert.equal(initial.revision,0);assert.equal(initial.source,'environment');assert.equal(initial.worker.activeProducts,null);
    for(const invalid of [{...settings,productConcurrency:0},{...settings,requestConcurrency:21},{...settings,localConcurrency:3},{...settings,billingConcurrency:1.2},{...settings,adaptiveEnabled:'false'}])await assert.rejects(store.save({id:'admin',role:'admin'},{revision:0,settings:invalid}),{statusCode:400});
    await assert.rejects(store.save({id:'user',role:'user'},{revision:0,settings}),{statusCode:403});
    const attempts=await Promise.allSettled([store.save({id:'admin',role:'admin'},{revision:0,settings:{...settings,productConcurrency:5}}),store.save({id:'admin2',role:'admin'},{revision:0,settings:{...settings,productConcurrency:2}})]);
    assert.equal(attempts.filter(r=>r.status==='fulfilled').length,1);assert.equal(attempts.find(r=>r.status==='rejected').reason.statusCode,409);
    const saved=await store.read();assert.equal(saved.revision,1);assert.equal(saved.source,'saved');assert.equal(saved.worker.appliedRevision,null);
    const restarted=createAiRuntimeSettings({pool,env:{AI_LISTING_CONCURRENCY:'19'}});assert.deepEqual((await restarted.read()).settings,saved.settings);
    await store.heartbeat({status:'running',appliedRevision:1,effectiveProductConcurrency:2,activeProducts:2,activeRequests:1,local:{active:1,pending:2,concurrency:1},resources:null,adaptiveEnabled:false});
    assert.equal((await store.read()).worker.online,true);assert.equal((await store.read()).worker.appliedRevision,1);
    now+=21_000;const stale=await store.read();assert.equal(stale.worker.online,false);assert.equal(stale.worker.activeProducts,null);assert.equal(stale.worker.resources,null);
    now-=21_000;await store.heartbeat({status:'stopped',appliedRevision:1});assert.equal((await store.read()).worker.online,false);
  }finally{await pool?.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
});

test('worker applies saved revisions on its five-second refresh even with adaptive control disabled',{skip:process.env.SONLI_POSTGRES_TESTS!=='1',timeout:20000},async()=>{
  const {createAiRuntimeSettings}=await import('../ai-runtime-settings.mjs');
  const schema='runtime_live_'+randomUUID().replaceAll('-','');const admin=new pg.Pool({connectionString:process.env.DATABASE_URL});let pool,runtime,started;
  const releases=[],claims=[];let active=0;
  const delay=ms=>new Promise(r=>setTimeout(r,ms));
  const waitUntil=async check=>{for(let i=0;i<140;i++){if(await check())return;await delay(50);}assert.fail('worker refresh timed out');};
  try{
    await admin.query(`CREATE SCHEMA ${schema}`);pool=new pg.Pool({connectionString:process.env.DATABASE_URL,options:`-c search_path=${schema}`});
    await pool.query(await readFile(new URL('../db/migrations/136_ai_runtime_settings.sql',import.meta.url),'utf8'));
    await pool.query('CREATE TABLE ai_user_channels(product_lease_until TIMESTAMPTZ,lease_until TIMESTAMPTZ)');
    await pool.query("INSERT INTO ai_user_channels VALUES(NOW()+INTERVAL '1 hour',NOW()+INTERVAL '1 hour')");
    const store=createAiRuntimeSettings({pool,env:{}});await store.save({id:'admin',role:'admin'},{revision:0,settings:{...settings,productConcurrency:1}});
    let sampleFailed=false;
    runtime=createAiListingRuntime({env:{AI_LISTING_ADAPTIVE_CONCURRENCY:'0'},resolvePool:async()=>pool,readResources:async()=>{
      if(sampleFailed)throw Error('sample unavailable');return {memoryLimitBytes:8000,memoryUsedBytes:3000,memoryScope:'host',cpuCores:4,cpuRatio:0.2,eventLoopDelayMs:3};
    },repository:{claimNext:async input=>{if(input.phase!=='generate')return null;claims.push(input.capacity);active++;await new Promise(r=>releases.push(r));active--;return null;}}});
    started=runtime.start({mode:'worker'});await waitUntil(()=>active===1);
    let value=await store.read();assert.equal(value.worker.appliedRevision,1);assert.equal(value.worker.activeProducts,1);assert.equal(value.worker.activeRequests,1);assert.equal(value.worker.resources.memoryScope,'host');
    await store.save({id:'admin',role:'admin'},{revision:1,settings:{...settings,productConcurrency:5,localConcurrency:2}});
    assert.equal((await store.read()).worker.appliedRevision,1,'save is not application');
    await waitUntil(()=>active===5);value=await store.read();assert.equal(value.worker.appliedRevision,2);assert.equal(value.worker.effectiveProductConcurrency,5);assert.equal(value.worker.local.concurrency,2);
    sampleFailed=true;await store.save({id:'admin',role:'admin'},{revision:2,settings:{...settings,productConcurrency:1}});
    await waitUntil(async()=>(await store.read()).worker.appliedRevision===3);assert.equal(active,5,'lowering never cancels active lanes');
    value=await store.read();assert.equal(value.worker.effectiveProductConcurrency,1);assert.equal(value.worker.resources,null);assert.equal(value.worker.local.concurrency,1);
    for(const release of releases.slice(1))release();await waitUntil(()=>active===1);await delay(1100);assert.equal(claims.length,5,'draining lanes cannot claim above the reduced ceiling');
    const stopping=runtime.stop();await delay(25);assert.equal(active,1);releases[0]();await stopping;await started;
    value=await store.read();assert.equal(value.worker.status,'stopped');assert.equal(value.worker.online,false);
  }finally{if(runtime){const stopping=runtime.stop();releases.forEach(r=>r());await stopping;await started;}await pool?.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
});

test('settings API preserves a synchronous pool resolver',async()=>{
  let response;const runtime=createAiListingRuntime({resolvePool:()=>({query:async()=>({rows:[]})}),authenticate:async()=>({role:'admin'}),sendJson:(_res,status,body)=>response={status,body}});
  await runtime.handleRoute({method:'GET'},{},new URL('http://localhost/api/admin/ai-runtime-settings'));assert.equal(response.status,200);assert.equal(response.body.revision,0);
});
test('worker cannot admit products before its first persisted settings read succeeds, and stop still drains',async()=>{
  let claims=0;
  const runtime=createAiListingRuntime({env:{AI_LISTING_ADAPTIVE_CONCURRENCY:'0'},resolvePool:async()=>({query:async()=>{throw Error('database unavailable');}}),repository:{claimNext:async input=>{if(input.phase==='generate')claims++;return null;}}});
  try{await runtime.start({mode:'worker'});assert.equal(claims,0);}finally{await runtime.stop();}
  const failed=createAiListingRuntime({resolvePool:async()=>{throw Error('pool unavailable');}});await failed.start({mode:'worker'});await assert.doesNotReject(failed.stop());
});
