import test from 'node:test';
import assert from 'node:assert/strict';
import {createAiListingService} from '../ai-listing-service.mjs';
import {createAiListingStoreRouting} from '../ai-listing-store-routing.mjs';
import {createAiListingRepository} from '../ai-listing-repository.mjs';
import {createSkuBilling} from '../ai-sku-billing.mjs';
import {createAiListingSubmissionPorts} from '../ai-listing-submission.mjs';
import {normalizeOzonImportItems} from '../ozon-import-normalizer.mjs';
import {memoryRepository} from './support/ai-listing-memory-repository.mjs';

const config={targetStoreId:'store',targetWarehouseId:'warehouse',manualReview:true};
const source=(id,skus,count=2)=>({collectItemId:id,sku:skus[0],name:id,sourceSnapshot:{source:'ozon'},items:skus.map(sku=>({sku,
  images:Array.from({length:count},(_,i)=>`https://source.invalid/${sku}/${i}.png`),
  listingItem:{offer_id:`原货号-${sku}`,name:`Original ${sku}`,description:'Original description',weight:100,depth:100,width:100,height:100,
    richContent:JSON.stringify({content:[{text:'Original rich'}]}),attributes:[{id:9024,values:[{value:`原货号-${sku}`}]},{id:4180,values:[{value:`Original ${sku}`}]},{id:11254,values:[{value:JSON.stringify({content:[{text:'Original rich'}]})}]}]},
}))});
function fixture(extra={}) {
  const repository=extra.repository||memoryRepository(),generated=[],submitted=[];let now=1000;
  const sources=extra.sources||[source('large',['a','b'])];
  const service=createAiListingService({repository,clock:()=>now,loadSources:async()=>structuredClone(sources),
    generateImage:async input=>{generated.push(input.sku);return {generatedUrl:`https://saved.invalid/${input.sku}/${input.index}`};},
    generateImageGroup:async input=>{generated.push(input.sku);return {images:input.sources.map(({index})=>({sku:input.sku,index,generatedUrl:`https://saved.invalid/${input.sku}/${index}`}))};},
    submitListing:async input=>{await input.beforeExternalWrite?.();submitted.push(input);return {submissionId:'submitted'};},
    readSubmission:async()=>({status:'COMPLETED'}),...extra});
  const create=async(overrides={})=>service.createFromCollect({accountId:'account',collectItemIds:sources.map(s=>s.collectItemId),idempotencyKey:'create',config:{...config,...overrides}});
  return {repository,service,generated,submitted,create,advance:ms=>now+=ms,time:()=>now};
}

for(const mode of ['GRID','SINGLE'])test(`${mode}: finishes runnable siblings under one channel before selecting the next product`,async()=>{
 let held=0,releases=0,reservations=0;
 const f=fixture({sources:[source('large',['a','b','c']),source('small',['d'],1)],reserveChannel:async()=>{held++;reservations++;return {channelId:'channel',productToken:'token',release:async()=>{held--;releases++;}};}});
 const [large,small]=await f.create({generationMode:mode,manualReview:false});
 const first=await f.service.processNext();assert.equal(first.id,large.id);assert.equal(first.status,'SUBMITTED');
 assert.deepEqual(first.images.filter(i=>i.generatedUrl).map(i=>i.sku),['a','a','b','b','c','c']);assert.equal(held,0);assert.equal(releases,1);assert.equal(reservations,1);
 assert.equal((await f.service.processNext()).id,small.id);
 assert.deepEqual(f.submitted.map(x=>x.source.items.map(i=>i.sku)),[['a','b','c'],['d']]);
});

for(const code of ['DAILY_LIMIT','GROUP_EXCEEDS_DAILY_LIMIT'])test(`${code}: no wallet, channel or AI call before whole-product quota admission`,async()=>{
 const calls=[];const f=fixture({billing:{reconcile:async()=>{calls.push('wallet');return {funded:true};}},reserveChannel:async()=>{calls.push('channel');},
 routeStores:async()=>({selected:false,quotaWait:{code,message:'额度不足',storeId:'store',required:2,remaining:0,...(code==='DAILY_LIMIT'?{retryAt:86400000}:{})}})});
 const [task]=await f.create();calls.length=0;const result=await f.service.processNext();
 assert.deepEqual(calls,[]);assert.deepEqual(f.generated,[]);assert.equal(result.quotaWait.code,code);assert.equal((await f.service.getTask({accountId:'account',taskId:task.id})).quotaWait.code,code);
 assert.equal(result.status,code==='DAILY_LIMIT'?'GENERATING':'GENERATION_FAILED');
});

test('admission expiry rechecks after saving output and restart reuses that output',async()=>{
 let reads=0,f;f=fixture({sources:[source('large',['a'],2)],routeStores:async({commit})=>{reads++;if(reads===2)return {selected:false,quotaWait:{code:'DAILY_LIMIT',message:'额度不足',retryAt:86400000}};await commit({targetStoreId:'store',targetWarehouseId:'warehouse'},{storeId:'store',required:1,checkedAt:f.time(),day:0});return {selected:true};},
 generateImage:async input=>{f.advance(60001);return {generatedUrl:`https://saved.invalid/${input.index}`};}});
 await f.create();const wait=await f.service.processNext();assert.equal(reads,2);assert.equal(wait.images.filter(i=>i.generatedUrl).length,1);assert.equal(wait.quotaWait.code,'DAILY_LIMIT');
 f.advance(86400000);const done=await f.service.processNext();assert.equal(done.status,'AWAITING_REVIEW');assert.equal(reads,3);assert.equal(done.images[0].generatedUrl,'https://saved.invalid/0');
});

for(const channelCount of [1,2])test(`${channelCount} cooled channels can retry after exclusion exhaustion with a finite three-request budget`,async()=>{
  let requests=0;const channels=Array.from({length:channelCount},(_,i)=>`c${i}`),cooling=new Map();let f;
  f=fixture({sources:[source('large',['a'],1)],reserveChannel:async({excludeChannelIds})=>{
    const channelId=channels.find(id=>!excludeChannelIds.includes(id)&&(cooling.get(id)||0)<=f.time());
    if(!channelId)throw Object.assign(Error('busy'),{code:'AI_GATEWAY_NO_CAPACITY'});
    return {channelId,productToken:'token',release:async()=>{}};
  },generateImage:async input=>{requests++;cooling.set(input.channelId,f.time()+60000);throw Object.assign(Error('429'),{code:'AI_GATEWAY_RATE_LIMITED',channelId:input.channelId,deliveryState:'NOT_SENT'});}});
  await f.create();for(let i=0;i<16;i++){await f.service.processNext();f.advance(30000);}
  const saved=[...f.repository.rows.values()][0];assert.equal(requests,3);assert.equal(saved.status,'GENERATION_FAILED');assert.equal(saved.images[0].channelAttempts.length,3);
});

test('unknown paid outcomes are never cleared by exclusion cycling',async()=>{
  let requests=0;const f=fixture({sources:[source('large',['a'],1)],reserveChannel:async()=>({channelId:'c',productToken:'token',release:async()=>{}}),
    generateImage:async()=>{requests++;throw Object.assign(Error('timeout'),{channelId:'c',deliveryState:'POSSIBLY_SENT'});}});
  await f.create();await f.service.processNext();for(let i=0;i<5;i++){f.advance(120000);await f.service.processNext();}
  assert.equal(requests,1);assert.equal([...f.repository.rows.values()][0].status,'GENERATION_FAILED');
});

test('a retained legacy 429 exclusion can use the recovered channel after its cooldown',async()=>{
  let requests=0;const f=fixture({sources:[source('large',['a'],1)],reserveChannel:async({excludeChannelIds})=>{
    if(excludeChannelIds.length||f.time()<61000)throw Object.assign(Error('cooling'),{code:'AI_GATEWAY_NO_CAPACITY'});
    return {channelId:'only',productToken:'token',release:async()=>{}};
  },generateImage:async()=>{requests++;return {generatedUrl:'https://saved.invalid/recovered'};}});
  const [task]=await f.create();const row=f.repository.rows.get(task.id);row.status='GENERATING';
  Object.assign(row.images[0],{status:'GENERATION_FAILED',attempts:1,retryAt:1000,excludeChannelIds:['only'],channelAttempts:[{channelId:'only',code:'AI_GATEWAY_RATE_LIMITED'}]});
  await f.service.processNext();f.advance(30000);await f.service.processNext();assert.equal(requests,0);
  f.advance(30000);assert.equal((await f.service.processNext()).status,'AWAITING_REVIEW');assert.equal(requests,1);
});

test('an unclassified legacy channel exclusion cannot authorize replay of a paid outcome',async()=>{
  const f=fixture({sources:[source('large',['a'],1)],reserveChannel:async()=>{throw Object.assign(Error('unavailable'),{code:'AI_GATEWAY_NO_CAPACITY'});}});
  const [task]=await f.create();const row=f.repository.rows.get(task.id);row.status='GENERATING';
  Object.assign(row.images[0],{status:'GENERATION_FAILED',attempts:1,retryAt:1000,excludeChannelIds:['only'],channelAttempts:[{channelId:'only',code:'UNKNOWN_OLD_FAILURE'}]});
  await f.service.processNext();assert.deepEqual(f.repository.rows.get(task.id).images[0].excludeChannelIds,['only']);assert.equal(f.generated.length,0);
});

test('request-capacity waiting also preserves exclusions with unclassified paid outcomes',async()=>{
  const f=fixture({sources:[source('large',['a'],1)],reserveChannel:async()=>({channelId:'alternative',productToken:'token',release:async()=>{}}),
    generateImage:async()=>{throw Object.assign(Error('busy'),{code:'AI_GATEWAY_NO_CAPACITY'});}});
  const [task]=await f.create();const row=f.repository.rows.get(task.id);row.status='GENERATING';
  Object.assign(row.images[0],{status:'GENERATION_FAILED',attempts:1,retryAt:1000,excludeChannelIds:['unknown'],channelAttempts:[{channelId:'unknown',code:'UNKNOWN_OLD_FAILURE'}]});
  await f.service.processNext();assert.deepEqual(f.repository.rows.get(task.id).images[0].excludeChannelIds,['unknown']);
});

test('generated-result acknowledgement follows durable image saves and cleanup failure cannot undo success',async()=>{
  const acks=[];let f;
  f=fixture({sources:[source('large',['a'],2)],acknowledgeGeneratedResult:async input=>{
    const stored=await f.repository.get({accountId:input.accountId,taskId:input.taskId});assert.ok(stored.images[input.index].generatedUrl);
    acks.push(input.index);throw Error('cleanup unavailable');
  }});await f.create();assert.equal((await f.service.processNext()).status,'AWAITING_REVIEW');assert.deepEqual(acks,[0,1]);
});

test('a pause after a paid image still acknowledges the durable result cache',async()=>{
  let f,task;const acks=[];
  f=fixture({sources:[source('large',['a'],1)],generateImage:async()=>{await f.service.pauseTask({accountId:'account',taskId:task.id});return {generatedUrl:'https://saved.invalid/paid'};},
    acknowledgeGeneratedResult:async input=>{assert.ok(f.repository.rows.get(input.taskId).images[0].generatedUrl);acks.push(input.sku);}});
  [task]=await f.create();assert.equal((await f.service.processNext()).status,'PAUSED');assert.deepEqual(acks,['a']);
});

test('preparation rechecks quota across pause and resume while retaining the selected target',async()=>{
  let routed=0;const f=fixture({sources:[source('large',['a'],1)],routeStores:async({commit})=>{routed++;await commit({targetStoreId:'fallback',targetWarehouseId:'warehouse-2'});return {selected:true};},
    submitListing:async input=>{assert.equal(input.config.targetStoreId,'fallback');return {submissionId:'prepared'};}});
  const [task]=await f.create({manualReview:false,autoSwitchStores:true,fallbackStores:[{targetStoreId:'fallback',targetWarehouseId:'warehouse-2'}]});
  await f.service.processNext({phase:'generate'});await f.service.processNext({phase:'media'});
  const row=f.repository.rows.get(task.id);row.submissionStage='preparing_media';row.submissionId=null;
  await f.service.pauseTask({accountId:'account',taskId:task.id});await f.service.resumeTask({accountId:'account',taskId:task.id});
  await f.service.processNext({phase:'media'});assert.equal(routed,3);
});

test('display-only progress uses small lease/version updates and does not trigger billing',async()=>{
  const repository=memoryRepository();let fullWrites=0,stageWrites=0,reservations=0,settlements=0;
  const save=repository.save.bind(repository);repository.save=async input=>{fullWrites++;return save(input);};
  repository.saveProgress=async input=>{stageWrites++;const row=repository.rows.get(input.taskId);assert.equal(input.expectedVersion,row.version);
    assert.equal(input.leaseToken,row.leaseToken);Object.assign(row,input.patch);row.version++;return {version:row.version,controlAction:row.controlAction};};
  const f=fixture({repository,sources:[source('large',['a'],1)],billing:{reconcile:async input=>{input.reserve?reservations++:settlements++;return {funded:true};}},
    reserveChannel:async()=>({channelId:'c',productToken:'token',release:async()=>{}}),generateImageGroup:async input=>{
      for(const stage of ['preparing','image','slicing','saving'])await input.onProgress(stage);
      return {images:[{sku:'a',index:0,generatedUrl:'https://saved.invalid/a'}]};}});
  await f.create({generationMode:'GRID'});await f.service.processNext();
  assert.equal(stageWrites,4);assert.ok(fullWrites<=3);assert.equal(reservations,1);assert.ok(settlements<=2);
});

test('repository stage update never serializes or returns the frozen source and rejects arbitrary patch fields',async()=>{
  let call;const repository=createAiListingRepository({pool:{query:async(sql,params)=>{call={sql,params};return {rows:[{version:8,control_action:null}]};}}});
  const result=await repository.saveProgress({accountId:'a',taskId:'t',expectedVersion:7,leaseToken:'lease',now:1000,patch:{generationStage:'saving',updatedAt:1000}});
  assert.equal(result.version,8);assert.equal(call.params.some(x=>typeof x==='string'&&x.includes('sourceSnapshot')),false);
  assert.match(call.sql,/version\s*=\s*\$3/);assert.match(call.sql,/lease_token\s*=\s*\$4/);assert.doesNotMatch(call.sql,/RETURNING \*/);
  await assert.rejects(repository.saveProgress({accountId:'a',taskId:'t',patch:{source:{items:[]}}}));
});

test('deleted automatic owner is an explicit blocked receipt and stays deduplicated',async()=>{
  const f=fixture({sources:[source('large',['a'],1)]});const [task]=await f.create();await f.service.deleteTask({accountId:'account',taskId:task.id});
  const deleted=structuredClone(f.repository.rows.get(task.id));
  f.repository.readCollectorAutomaticOwners=async()=>new Map([['a',deleted]]);
  f.repository.createCollectorAutomatic=async({prepare})=>{assert.deepEqual(await prepare([]),[]);return {owners:new Map([['a',deleted]]),createdTaskIds:[]};};
  const receipt=await f.service.createFromCollectorRun({accountId:'account',runId:'run',config,groups:[{collectItemId:'large',skus:['a']}]});
  assert.deepEqual(receipt.results[0].reusedTaskIds,[]);assert.deepEqual(receipt.results[0].unprocessedSkus,['a']);assert.deepEqual(receipt.tasks,[]);
  assert.equal(receipt.errors[0].code,'AI_LISTING_DELETED_TASK_BLOCKED');assert.equal(receipt.errors[0].retryable,false);assert.equal(f.repository.rows.size,1);
});

function failedTask(f,task) {
  const row=f.repository.rows.get(task.id);row.status='SUBMISSION_FAILED';row.submissionStarted=true;row.submissionId='existing';
  row.images.forEach(i=>Object.assign(i,{status:'COMPLETED',generatedUrl:`https://saved.invalid/${i.sku}/${i.index}`}));
  row.submissionResults=[{sku:'a',offerId:'原货号-a',importStatus:'SUCCEEDED',stockStatus:'COMPLETED'},
    {sku:'b',offerId:'原货号-b',importStatus:'SUCCEEDED',publicationStatus:'REJECTED',stockStatus:'FAILED'}];
  return row;
}
test('explicit revision changes only failed SKU text and preserves images, successful source, article and submission identity',async()=>{
  const f=fixture();const [task]=await f.create({manualReview:false});const row=failedTask(f,task),before=structuredClone(row);
  const rich={content:[{text:'Исправленное описание'}]};
  await f.service.reviseAndRetryTask({accountId:'account',taskId:task.id,expectedVersion:row.version,revisions:[{sku:'b',name:'Исправленное название',description:'Новое описание',richContent:rich}]});
  const saved=f.repository.rows.get(task.id);assert.deepEqual(saved.source.items[0],before.source.items[0]);assert.deepEqual(saved.images,before.images);
  assert.equal(saved.source.items[1].listingItem.offer_id,'原货号-b');assert.equal(saved.source.items[1].listingItem.attributes.find(a=>a.id===9024).values[0].value,'原货号-b');
  assert.equal(saved.submissionKey,before.submissionKey);assert.equal(saved.submissionId,'existing');assert.equal(saved.submissionRetryAttempt,1);
  await f.service.processNext();const item=f.submitted[0].source.items[1].listingItem;
  assert.equal(item.name,'Исправленное название');assert.equal(item.attributes.find(a=>a.id===4180).values[0].value,item.name);
  assert.deepEqual(JSON.parse(item.richContent),rich);assert.deepEqual(JSON.parse(item.attributes.find(a=>a.id===11254).values[0].value),rich);
  assert.equal(item.description,'Новое описание');assert.equal(f.generated.length,0);
});

test('revision rejects successes, identities, stale versions and uncertain SKU results atomically',async()=>{
  const f=fixture();const [task]=await f.create();const row=failedTask(f,task),before=structuredClone(row);
  for(const input of [{revisions:[{sku:'a',name:'Changed'}]},{revisions:[{sku:'b',offer_id:'new',name:'Changed'}]},{expectedVersion:99,revisions:[{sku:'b',name:'Changed'}]}]){
    await assert.rejects(f.service.reviseAndRetryTask({accountId:'account',taskId:task.id,expectedVersion:row.version,...input}));assert.deepEqual(f.repository.rows.get(task.id),before);
  }
  row.submissionResults[1].importStatus='UNCERTAIN';
  await assert.rejects(f.service.reviseAndRetryTask({accountId:'account',taskId:task.id,expectedVersion:row.version,revisions:[{sku:'b',name:'Changed'}]}));
});

for(const revisionMode of ['text','model'])test(`${revisionMode} revision reaches the real normalizer and failed-only Ozon retry while ordinary retry retains the original snapshot`,async()=>{
  const original=source('large',['a','b'],1);original.sourceSnapshot={source:'ozon',currency:'RUB',price:'20'};
  for(const group of original.items){Object.assign(group.listingItem,{name:'Старое название',description:'Старое описание',price:'20',currency_code:'RUB',description_category_id:10,type_id:20});
    group.listingItem.scraped_model_name='separate-model';
    group.listingItem.attributes.find(a=>a.id===4180).values[0].value='Старое название';
    group.listingItem.richContent=JSON.stringify({version:0.3,content:[{widgetName:'raTextBlock',text:{content:['Старый текст']}}]});}
  let submissionRow;const imports=[];const products=new Map();
  const query=async(sql,args=[])=>{
    if(sql.includes('pg_try_advisory_lock'))return {rows:[{locked:true}]};
    if(sql.startsWith('SELECT * FROM ai_image_listing_submissions'))return {rows:submissionRow?[structuredClone(submissionRow)]:[]};
    if(sql.startsWith('INSERT INTO ai_image_listing_submissions'))submissionRow={id:args[0],account_id:args[1],task_id:args[2],body:JSON.parse(args[4])};
    if(sql.startsWith('UPDATE ai_image_listing_submissions'))submissionRow.body=JSON.parse(args[2]);
    return {rows:[]};
  };
  const ports=createAiListingSubmissionPorts({pool:{query,connect:async()=>({query,release(){}})},reserveCapacity:async()=>({allowed:true}),
    clock:()=>f.time(),readCredential:async()=>({clientId:'fixture'}),validateTarget:async()=>({store:{currencyCode:'RUB'},warehouse:{platformWarehouseId:'123'}}),
    normalizeItems:items=>normalizeOzonImportItems(items,{strictTypeMatch:true,getCategoryTree:async()=>[{description_category_id:10,children:[{type_id:20,type_name:'Product'}]}],
      getCategoryAttributes:async()=>[4180,4191,9024,9048,11254].map(id=>({id}))}),
    callOzonSellerApi:async(_credential,path,body)=>{
      if(path==='/v4/product/info/limit')return {daily_create:{limit:1000,usage:0}};
      if(path==='/v3/product/import'){imports.push(structuredClone(body.items));for(const item of body.items)products.set(item.offer_id,item);return {result:{task_id:imports.length}};}
      if(path==='/v1/product/import/info')return {result:{items:imports[body.task_id-1].map(item=>({offer_id:item.offer_id,product_id:item.offer_id==='原货号-a'?1:2,status:'imported',errors:[]}))}};
      if(path==='/v3/product/info/list')return {items:body.offer_id.flatMap(offerId=>{
        const item=products.get(offerId);if(!item)return [];
        const rejected=offerId==='原货号-b'&&(revisionMode==='model'?item.attributes.find(a=>a.id===9048)?.values[0].value!=='existing-group-model':item.name!=='Исправленное название');
        return [{offer_id:offerId,id:offerId==='原货号-a'?1:2,statuses:rejected?{status:'variant_wait',status_failed:'declined',moderate_status:'declined',is_created:false,status_updated_at:`2026-09-16T00:00:0${imports.length}Z`}:{status:'price_sent',is_created:true},
          errors:rejected?[{code:'DESCRIPTION_DECLINE',attribute_id:4180,level:'ERROR_LEVEL_ERROR'}]:[]}];
      })};
      if(path==='/v2/products/stocks')return {result:body.stocks.map(s=>({...s,updated:true,errors:[]}))};
      assert.fail(path);
    }});
  const f=fixture({sources:[original],submitListing:ports.submitListing,readSubmission:ports.readSubmission});
  const [task]=await f.create({manualReview:false,brandMode:'PREFER_SOURCE'});await f.service.processNext();await f.service.processNext();f.advance(15000);await f.service.processNext();
  assert.equal((await f.service.getTask({accountId:'account',taskId:task.id})).status,'SUBMISSION_FAILED');
  original.items[1].listingItem.name='草稿已修改但普通重试不读取';
  await f.service.retryTask({accountId:'account',taskId:task.id});await f.service.processNext();f.advance(15000);await f.service.processNext();
  assert.equal(imports[1][0].name,'Старое название');
  const failed=await f.service.getTask({accountId:'account',taskId:task.id});assert.deepEqual(failed.submissionRevisions.map(r=>r.sku),['b']);
  if(revisionMode==='model')assert.equal(failed.submissionRevisions[0].modelName,'separate-model');
  const richContent={version:0.3,content:[{widgetName:'raTextBlock',text:{content:['Исправленный текст']}}]};
  const revision=revisionMode==='model'?{modelName:'existing-group-model'}:{name:'Исправленное название',description:'Исправленное описание',richContent};
  await f.service.reviseAndRetryTask({accountId:'account',taskId:task.id,expectedVersion:failed.version,revisions:[{sku:'b',...revision}]});
  await f.service.processNext();f.advance(15000);assert.equal((await f.service.processNext()).status,'COMPLETED');
  assert.deepEqual(imports.map(items=>items.map(i=>i.offer_id)),[['原货号-a','原货号-b'],['原货号-b'],['原货号-b']]);
  const revised=imports[2][0],attr=id=>revised.attributes.find(a=>a.id===id)?.values[0].value;
  if(revisionMode==='model'){
    const baseline=structuredClone(imports[1][0]);baseline.attributes.find(a=>a.id===9048).values=[{value:'existing-group-model'}];
    const ordered=item=>({...item,attributes:[...item.attributes].sort((a,b)=>a.id-b.id)});
    assert.deepEqual(ordered(revised),ordered(baseline));assert.equal(attr(9048),'existing-group-model');
  }else {assert.equal(revised.name,'Исправленное название');assert.equal(attr(4180),revised.name);assert.equal(attr(9024),'原货号-b');assert.match(attr(4191),/Исправленное описание/);assert.deepEqual(JSON.parse(attr(11254)),richContent);}
  assert.equal(f.generated.length,2);
});

test('Seller enrichment refresh keeps the automatic group model and newly edited manual model',async()=>{
  for(const manual of [false,true]){
    const saved=source('single',['b'],1);saved.items[0].listingItem.scraped_model_name='b';saved.enrichmentJobs=[{sku:'b',status:'PENDING'}];
    const f=fixture({sources:[saved]});const [task]=await f.create();
    const waiting=f.repository.rows.get(task.id);waiting.collectorAuto={runId:'run',groupId:'family',skus:['b'],modelName:'existing-group-model'};
    saved.enrichmentJobs=[{sku:'b',status:'SUCCESS'}];
    if(manual)saved.items[0].listingItem.scraped_model_name='Ручная отдельная модель';
    await f.service.processNext();
    assert.equal(f.repository.rows.get(task.id).source.items[0].listingItem.scraped_model_name,manual?'Ручная отдельная модель':'existing-group-model');
  }
});

test('model revision rejects successful or unresolved SKU identities, stale versions and empty model values without mutation',async()=>{
  const f=fixture();const [task]=await f.create();const row=failedTask(f,task),before=structuredClone(row);
  for(const input of [{revisions:[{sku:'a',modelName:'model'}]},{revisions:[{sku:'b',modelName:''}]},
    {revisions:[{sku:'b',modelName:'  '}]},{revisions:[{sku:'b',modelName:123}]},{expectedVersion:99,revisions:[{sku:'b',modelName:'model'}]}]){
    await assert.rejects(f.service.reviseAndRetryTask({accountId:'account',taskId:task.id,expectedVersion:row.version,...input}));
    assert.deepEqual(f.repository.rows.get(task.id),before);
  }
  row.submissionResults[1].publicationStatus='WAITING_TIMEOUT';
  const unresolved=structuredClone(row);
  await assert.rejects(f.service.reviseAndRetryTask({accountId:'account',taskId:task.id,expectedVersion:row.version,revisions:[{sku:'b',modelName:'model'}]}));
  assert.deepEqual(f.repository.rows.get(task.id),unresolved);
});

for(const action of ['pause','cancel'])test(`${action} during media preparation retains saved media and makes no external write`,async()=>{
  let f,task,writes=0;
  f=fixture({sources:[source('large',['a'],1)],submitListing:async input=>{
    await f.service[`${action}Task`]({accountId:'account',taskId:task.id});await input.checkControl();await input.beforeExternalWrite();writes++;return {submissionId:'impossible'};
  }});[task]=await f.create({manualReview:false});await f.service.processNext({phase:'generate'});
  const result=await f.service.processNext({phase:'media'});assert.equal(result.status,action==='pause'?'PAUSED':'CANCELLED');assert.equal(writes,0);assert.ok(result.images.every(i=>i.generatedUrl));
});

test('prepared task can pause before sending and an in-flight completed receipt wins over a later local pause',async()=>{
  let task,f;
  const items=[{sku:'a',offerId:'original-offer',productId:'123',importStatus:'SUCCEEDED',stockStatus:'COMPLETED',errors:[]}];
  f=fixture({sources:[source('large',['a'],1)],submitListing:async()=>({submissionId:'prepared'}),readSubmission:async input=>{
    await input.beforeExternalWrite();
    const pending=await f.service.pauseTask({accountId:'account',taskId:task.id});assert.equal(pending.controlAction,'pause');
    await assert.rejects(f.service.cancelTask({accountId:'account',taskId:task.id}),{statusCode:409});
    return {status:'COMPLETED',items};
  }});[task]=await f.create({manualReview:false});await f.service.processNext({phase:'generate'});await f.service.processNext({phase:'media'});
  const prepared=await f.service.getTask({accountId:'account',taskId:task.id});assert.equal(prepared.taskActions.pause,true);
  await f.service.pauseTask({accountId:'account',taskId:task.id});await f.service.resumeTask({accountId:'account',taskId:task.id});
  const result=await f.service.processNext({phase:'finalize'});
  assert.equal(result.status,'COMPLETED');assert.equal(result.controlAction,null);assert.deepEqual(result.submissionResults,items);
  assert.equal(result.submissionId,'prepared');assert.equal(f.repository.rows.get(task.id).leaseToken,null);
  assert.equal(await f.service.processNext({phase:'finalize'}),null);
});

for(const outcome of ['FAILED','UNCERTAIN','SUBMITTED'])test(`in-flight ${outcome} receipt remains durable when local polling is paused`,async()=>{
 let task,f,reads=0,submissions=0;
 const items=[{sku:'a',offerId:'original-offer',productId:'123',importStatus:'SUCCEEDED',stockStatus:outcome==='FAILED'?'FAILED':'PENDING',errors:outcome==='FAILED'?['STOCK_FAILED']:[]}];
 f=fixture({sources:[source('large',['a'],1)],submitListing:async()=>{submissions++;return {submissionId:'prepared'};},readSubmission:async input=>{
  assert.equal(input.submissionId,'prepared');reads++;
  if(reads>1)return {status:'COMPLETED',items:items.map(row=>({...row,stockStatus:'COMPLETED',errors:[]}))};
  await input.beforeExternalWrite();await f.service.pauseTask({accountId:'account',taskId:task.id});
  await assert.rejects(input.beforeExternalWrite(),{code:'AI_LISTING_TASK_CONTROL_REQUESTED'});
  return {status:outcome,items};
 }});[task]=await f.create({manualReview:false});await f.service.processNext({phase:'generate'});await f.service.processNext({phase:'media'});
 const result=await f.service.processNext({phase:'finalize'});
 assert.equal(result.status,{FAILED:'SUBMISSION_FAILED',UNCERTAIN:'SUBMISSION_UNCERTAIN',SUBMITTED:'PAUSED'}[outcome]);
 assert.equal(result.controlAction,null);assert.deepEqual(result.submissionResults,items);assert.equal(result.submissionId,'prepared');
 assert.equal(f.repository.rows.get(task.id).leaseToken,null);assert.equal(await f.service.processNext({phase:'finalize'}),null);
 if(outcome==='SUBMITTED'){
  assert.equal(result.taskActions.resume,true);await f.service.resumeTask({accountId:'account',taskId:task.id});
  assert.equal((await f.service.processNext({phase:'finalize'})).status,'COMPLETED');assert.equal(reads,2);assert.equal(submissions,1);
 }else assert.equal(result.taskActions.retry,true);
});

test('billing attempts each completed SKU charge only once across progress and recovery',async()=>{
  let images=[{sku:'a'},{sku:'b'},{sku:'c'}],quote;const wallet={sku_price_cents:20,balance_cents:100,reserved_cents:0},charged=new Set();let inserts=0;
  const query=async(sql,args=[])=>{
    if(sql.startsWith('SELECT t.body'))return {rows:[{body:{images},status:'GENERATING',billable:true,role:'user'}]};
    if(sql.startsWith('SELECT * FROM ai_user_wallets'))return {rows:[{...wallet}]};
    if(sql.startsWith('SELECT * FROM ai_task_billing'))return {rows:quote?[{...quote}]:[]};
    if(sql.startsWith('SELECT sku FROM ai_wallet_entries'))return {rows:[...charged].map(sku=>({sku}))};
    if(sql.startsWith('INSERT INTO ai_task_billing')){quote={unit_cents:20,reserved_cents:0};return {rows:[{...quote}]};}
    if(sql.startsWith('INSERT INTO ai_wallet_entries')){inserts++;if(charged.has(args[3]))return {rows:[]};charged.add(args[3]);return {rows:[{id:args[0]}]};}
    if(sql.startsWith('UPDATE ai_user_wallets'))Object.assign(wallet,{balance_cents:args[1],reserved_cents:args[2]});
    if(sql.startsWith('UPDATE ai_task_billing'))quote.reserved_cents=args[2];
    return {rows:[]};
  };
  const billing=createSkuBilling({pool:{connect:async()=>({query,release(){}})}});
  await billing.reconcile({accountId:'a',taskId:'t',reserve:true});
  for(const image of images){image.generatedUrl='https://saved.invalid/image';await billing.reconcile({accountId:'a',taskId:'t'});await billing.reconcile({accountId:'a',taskId:'t'});}
  assert.equal(inserts,3);assert.equal(charged.size,3);assert.equal(wallet.balance_cents,40);assert.equal(wallet.reserved_cents,0);
});

test('batch control keeps applied and uncertain item receipts when a later write response is lost',async()=>{
  const f=fixture({sources:[source('one',['a'],1),source('two',['b'],1),source('three',['c'],1)]});const tasks=await f.create();
  const request=f.repository.requestControl.bind(f.repository);let index=0;
  f.repository.requestControl=async input=>{const saved=await request(input);if(++index===2)throw Object.assign(Error('internal secret must stay private'),{code:'CONNECTION_LOST'});return saved;};
  const result=await f.service.batchTaskAction({accountId:'account',action:'pause',items:tasks.map(t=>({taskId:t.id,expectedVersion:t.version}))});
  assert.equal(result.applied,2);assert.equal(result.errors.length,1);assert.equal(result.errors[0].taskId,tasks[1].id);assert.equal(result.errors[0].code,'CONNECTION_LOST');
  assert.match(result.errors[0].message,/未确认/);assert.doesNotMatch(result.errors[0].message,/secret/);
  assert.ok([...f.repository.rows.values()].every(row=>row.status==='PAUSED'));assert.equal(index,3);
});

for(const [code,message] of [
  ['AI_LISTING_RESULT_SPOOL_FULL','生成结果暂存已满或磁盘空间不足'],
  ['AI_LISTING_RESULT_CHECKPOINT_INVALID','已生成结果暂存不完整'],
  ['AI_LISTING_RESULT_INPUT_CHANGED','原图片配置与已生成暂存结果不一致'],
])test(`${code} exposes the actionable saved-result recovery reason`,async()=>{
  const f=fixture({sources:[source('large',['a'],1)],generateImage:async()=>{throw Object.assign(Error('private path'),{code,stage:'upload',deliveryState:'NOT_SENT'});}});
  await f.create();const result=await f.service.processNext();assert.equal(result.status,'UPLOAD_FAILED');assert.ok(result.errorMessage.startsWith(message));assert.doesNotMatch(result.errorMessage,/private path/);
});

test('a failed channel attempt saves its finite retry while other runnable siblings acquire a valid channel and finish',async()=>{
 let reservations=0,releases=0;const calls=[];
 const f=fixture({sources:[source('large',['a','b'],1)],reserveChannel:async()=>({channelId:'c'+(++reservations),productToken:'token',release:async()=>releases++}),
 generateImage:async input=>{calls.push(input.sku);assert.ok(input.channelId);if(input.sku==='a')throw Object.assign(new Error('failure'),{channelId:input.channelId,code:'RETRYABLE_GATEWAY',deliveryState:'NOT_SENT'});return {generatedUrl:'https://saved.invalid/b'};}});
 await f.create();const result=await f.service.processNext();assert.deepEqual(calls,['a','b']);assert.equal(reservations,2);assert.equal(releases,2);assert.equal(result.images.find(i=>i.sku==='b').status,'COMPLETED');
});

test('an unknown paid result releases and reacquires a channel for a healthy sibling without replaying the unknown request',async()=>{
 let reservations=0,releases=0;const calls=[];
 const f=fixture({sources:[source('large',['a','b'],1)],reserveChannel:async()=>({channelId:'c'+(++reservations),productToken:'token',release:async()=>releases++}),
 generateImage:async input=>{calls.push(input.sku);assert.equal(input.channelId,'c'+calls.length);if(input.sku==='a')throw Object.assign(new Error('unknown'),{deliveryState:'POSSIBLY_SENT',code:'RETRYABLE_GATEWAY'});return {generatedUrl:'https://saved.invalid/b'};}});
 await f.create();const result=await f.service.processNext();assert.deepEqual(calls,['a','b']);assert.equal(reservations,2);assert.equal(releases,2);assert.equal(result.skuProgress.find(i=>i.sku==='a').status,'RESULT_UNKNOWN');
});

test('crossing Beijing 08:00 during a paid response saves output then rechecks before the next image',async()=>{
 let f,reads=0,paid=0;f=fixture({sources:[source('large',['a'],2)],routeStores:async({commit})=>{
  if(++reads===2)return {selected:false,quotaWait:{code:'DAILY_LIMIT',message:'额度仍未恢复',retryAt:172800000}};
  await commit({targetStoreId:'store',targetWarehouseId:'warehouse'});return {selected:true};
 },generateImage:async input=>{paid++;f.advance(2);return {generatedUrl:'https://saved.invalid/'+input.index};}});
 f.advance(86398999);await f.create();const result=await f.service.processNext();
 assert.equal(reads,2);assert.equal(paid,1);assert.equal(result.images[0].status,'COMPLETED');assert.equal(result.images[1].status,'PENDING');assert.equal(result.quotaWait.retryAt,172800000);
 assert.equal(await f.service.processNext(),null);
});

for(const action of ['pause','cancel','delete','lease-loss'])test(`${action} wins quota admission without starting paid work or retaining an admission`,async()=>{
 let f,task;const sideEffects=[];f=fixture({sources:[source('large',['a'],1)],billing:{reconcile:async()=>{sideEffects.push('wallet');return {funded:true};}},reserveChannel:async()=>{sideEffects.push('channel');},routeStores:async({commit})=>{
  if(action==='lease-loss')f.repository.rows.get(task.id).leaseToken='other-owner';
  else await f.service[`${action}Task`]({accountId:'account',taskId:task.id});
  await commit({targetStoreId:'store',targetWarehouseId:'warehouse'},{storeId:'store',required:1});return {selected:true};
 }});[task]=await f.create();sideEffects.length=0;const result=await f.service.processNext();
 assert.deepEqual(f.generated,[]);assert.equal(sideEffects.includes('channel'),false);
 if(action==='lease-loss')assert.equal(f.repository.rows.get(task.id).quotaReservation,undefined);
 else assert.equal(result.status,action==='pause'?'PAUSED':'CANCELLED');
});

test('stock-only service retry reaches the existing submission without a new creation-quota reservation or paid generation',async()=>{
 let validated=0;
 const route=createAiListingStoreRouting({pool:{connect:async()=>assert.fail('stock-only work does not reserve creation capacity')},
  validateTarget:async({config})=>{validated++;assert.equal(config.targetStoreId,'store');return {store:{currencyCode:'RUB'}};},readCredential:async()=>assert.fail('no quota query')});
 const f=fixture({sources:[source('large',['a'],1)],routeStores:route});const [task]=await f.create({manualReview:false});
 Object.assign(f.repository.rows.get(task.id),{status:'SUBMISSION_FAILED',submissionStarted:true,submissionTarget:{targetStoreId:'store',targetWarehouseId:'warehouse'},submissionResults:[{sku:'a',importStatus:'SUCCEEDED',stockStatus:'FAILED'}]});
 Object.assign(f.repository.rows.get(task.id).images[0],{status:'COMPLETED',generatedUrl:'https://saved.invalid/existing'});
 await f.service.retryTask({accountId:'account',taskId:task.id});const result=await f.service.processNext();
 assert.equal(result.status,'SUBMITTED');assert.equal(validated,1);assert.equal(f.generated.length,0);assert.equal(f.submitted.length,1);assert.equal(f.submitted[0].images[0].generatedUrl,'https://saved.invalid/existing');assert.equal(f.repository.rows.get(task.id).quotaReservation,undefined);
});
