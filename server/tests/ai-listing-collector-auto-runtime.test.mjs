import test from 'node:test';
import assert from 'node:assert/strict';
import {createAiListingRuntime} from '../ai-listing-runtime.mjs';

const config={targetStoreId:'frozen-store',targetWarehouseId:'frozen-warehouse',manualReview:true,prompt:'frozen prompt',stock:7};
const snapshot=()=>({id:'run',status:'COMPLETED',configurationSnapshot:{configuration:{autoSendToAiListing:true,
  autoStartAiGeneration:true,aiListingConfigSnapshot:{config}}}});
function fixture({run=snapshot(),existing,validateTarget}={}) {
  const validations=[],loads=[],rows=[];let body={runId:'run',collectItemIds:['collect']};
  const owners=new Map(existing?[['101',existing]]:[]);
  const runtime=createAiListingRuntime({
    authenticate:async()=>({id:'account',role:'admin',status:'active'}),
    readJson:async()=>body,sendJson:(res,status,body)=>Object.assign(res,{status,body}),
    resolvePool:async()=>({query:async()=>{throw Error('unexpected database read');}}),
    checkAccount:async()=>({id:'account',role:'admin',status:'active'}),
    loadCollectorRun:async input=>{loads.push(input);return input.runId==='run'?run:null;},
    loadCollectorGroups:async input=>{assert.equal(input.accountId,'account');if(input.collectItemIds[0]!=='collect')throw Object.assign(Error('wrong run source'),{status:404});return [{groupId:'g',collectItemId:'collect',source:'ozon',skus:['101']}];},
    repository:{readCollectorAutomaticOwners:async()=>owners,createCollectorAutomatic:async({prepare})=>{
      const tasks=await prepare(owners.size?[]:['101']);rows.push(...tasks);for(const task of tasks)owners.set('101',task);
      return {owners,createdTaskIds:tasks.map(task=>task.id)};
    }},
    loadSources:async()=>[{collectItemId:'collect',sku:'101',sourceSnapshot:{source:'ozon'},items:[{sku:'101',images:['https://source.example/101.png'],listingItem:{weight:100,depth:100,width:100,height:100}}]}],
    validateTarget:validateTarget||(async({config})=>{validations.push(config);if(config.targetStoreId!=='frozen-store')throw Object.assign(Error('invalid current target'),{statusCode:403});}),
    generateImage:async()=>assert.fail('creating tasks never generates an image'),
  });
  return {runtime,rows,validations,loads,async request(input=body){body=input;const res={};await runtime.handleRoute({method:'POST'},res,new URL('http://localhost/ai-listing/tasks/from-collector-run'));return res;}};
}

test('dedicated automatic route uses authenticated run scope and its frozen configuration',async()=>{
  const f=fixture(),res=await f.request();
  assert.equal(res.status,201);assert.equal(res.body.tasks.length,1);
  assert.equal(f.rows[0].config.prompt,'frozen prompt');assert.equal(f.rows[0].config.stock,7);
  assert.deepEqual(f.loads,[{accountId:'account',runId:'run'}]);
  assert.deepEqual(res.body.results[0].createdTaskIds,[res.body.tasks[0].id]);
});

test('only temporary RFBS failure before task creation carries the safe retry marker',async()=>{
  for(const [code,retryable,marked] of [['RFBS_VALIDATION_REQUIRED',true,true],['RFBS_VALIDATION_REQUIRED',false,false],['AI_LISTING_CHANNEL_UNAVAILABLE',true,false]]){
    const f=fixture({validateTarget:async()=>{throw Object.assign(new Error('validation failed'),{code,retryable});}});
    await assert.rejects(f.runtime.createCollectorTasks({accountId:'account',runId:'run',collectItemIds:['collect']}),error=>{
      assert.equal(error.definitelyNotCreated===true,marked);assert.equal(error.code,code);return true;});
    assert.equal(f.rows.length,0);
  }
});

test('automatic route cannot accept caller account/config flags or sources outside the owned run',async()=>{
  for(const extra of [{accountId:'other'},{config},{auto:true},{idempotencyKey:'fake'}]){
    const f=fixture();assert.equal((await f.request({runId:'run',collectItemIds:['collect'],...extra})).status,400);assert.equal(f.rows.length,0);
  }
  const f=fixture();assert.equal((await f.request({runId:'other-account-run',collectItemIds:['collect']})).status,404);
  assert.equal((await f.request({runId:'run',collectItemIds:['unlinked']})).status,404);assert.equal(f.rows.length,0);
});

test('unfinished, non-automatic or unconfirmed runs cannot create paid work',async()=>{
  for(const change of [run=>run.status='RUNNING',run=>run.configurationSnapshot.configuration.autoStartAiGeneration=false,
    run=>run.configurationSnapshot.configuration.autoSendToAiListing=false,
    run=>run.configurationSnapshot.configuration.aiListingConfigSnapshot.config={...config,manualReview:false}]){
    const run=snapshot();change(run);const f=fixture({run});assert.equal((await f.request()).status,409);assert.equal(f.rows.length,0);
  }
});

test('all-reused tasks remain accessible with an unavailable current target and never restart failure state',async()=>{
  const run=snapshot();run.configurationSnapshot.configuration.aiListingConfigSnapshot={config:{...config,targetStoreId:'deleted-store'}};
  const task={id:'old',accountId:'account',sourceType:'COLLECT_BOX',sourceId:'old-root',status:'GENERATION_FAILED',config,
    sku:'101',images:[{sku:'101',index:0,generatedUrl:'https://generated.example/kept.png'}],createdAt:1,updatedAt:2};
  const f=fixture({run,existing:task}),res=await f.request();
  assert.equal(res.status,201);assert.deepEqual(f.validations,[]);assert.equal(f.rows.length,0);
  assert.deepEqual(res.body.results[0].reusedTaskIds,['old']);assert.equal(res.body.tasks[0].status,'GENERATION_FAILED');
});


test('explicit manual resend accepts saved results from failed or cancelled runs and reuses existing paid work',async()=>{
  for(const status of ['FAILED','CANCELLED','QUEUED','RUNNING']){
    const run=snapshot();run.status=status;const f=fixture({run});
    assert.equal((await f.request()).status,409);
    const first=await f.request({runId:'run',collectItemIds:['collect'],manual:true});
    assert.equal(first.status,201);assert.equal(f.rows.length,1);
    const second=await f.request({runId:'run',collectItemIds:['collect'],manual:true});
    assert.equal(second.status,201);assert.equal(f.rows.length,1);
    assert.deepEqual(second.body.results[0].reusedTaskIds,[first.body.tasks[0].id]);
  }
  const invalid=fixture();assert.equal((await invalid.request({runId:'run',collectItemIds:['collect'],manual:'true'})).status,400);
});
