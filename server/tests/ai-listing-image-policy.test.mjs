import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,rm,readdir,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import sharp from 'sharp';
import {createAiListingService} from '../ai-listing-service.mjs';
import {createAiListingRuntime,createAiListingGridPort,createAiListingImagePort,prepareAiListingImageForPublication} from '../ai-listing-runtime.mjs';
import {createAiListingResultStore} from '../ai-listing-image-cache.mjs';
import {prepareGrid,splitGrid} from '../ai-listing-grid.mjs';
import {memoryRepository} from './support/ai-listing-memory-repository.mjs';

const policy={version:'ozon-v1',minWidth:900,minHeight:1200,maxWidth:4320,maxHeight:7680};
const layout={columns:2,rows:2,tw:1200,th:1600,width:2496,height:3296};
const source=count=>({collectItemId:'collect',sku:'sku',name:'Source facts',items:[{sku:'sku',images:Array.from({length:count},(_,i)=>`https://source.test/${i}.png`),
  listingItem:{description_category_id:201,type_id:301,weight:100,depth:100,width:100,height:100}}]});
function fixture(overrides={}) {
  const repository=overrides.repository||memoryRepository(),requests=[];
  const ports={repository,imagePolicyVersion:'ozon-v1',loadSources:async()=>[source(12)],
    checkSource:async({source})=>({...source,items:source.items.map(item=>({...item,listingItem:{...item.listingItem,description_category_id:401,type_id:501}}))}),
    generateImageGroup:async input=>{requests.push(structuredClone(input));return {images:input.sources.map(({index})=>({sku:input.sku,index,generatedUrl:`https://generated.test/${index}.png`}))};},
    ...overrides};
  const service=createAiListingService(ports);
  const create=async(config={})=>(await service.createFromCollect({accountId:'account',collectItemIds:['collect'],idempotencyKey:'new',config:{targetStoreId:'store',targetWarehouseId:'warehouse',generationMode:'GRID',manualReview:true,...config}}))[0];
  return {repository,ports,requests,service,create};
}
const pixel=()=>sharp({create:{width:30,height:40,channels:3,background:'#aabbcc'}}).png().toBuffer();
const publication={baseUrl:'https://media.test/',prefix:'images'};

// Catches silently enabling new geometry, and a capability response hiding the paid-request multiplier.
test('image policy rollout defaults off and capability response publishes the exact planned request counts',async()=>{
  for(const [value,enabled] of [[undefined,false],['ozon-v1',true]]){
    const runtime=createAiListingRuntime({env:{AI_LISTING_IMAGE_POLICY:value},generateImageGroup:async()=>{},
      resolvePool:async()=>({query:async()=>({rows:[]})}),checkAccount:async()=>({id:'a',role:'admin',status:'active'}),
      authenticate:async()=>({id:'a',role:'admin',status:'active'}),sendJson:(res,status,body)=>Object.assign(res,{status,body})});
    const res={};await runtime.handleRoute({method:'GET'},res,new URL('http://localhost/api/ai-listing/capabilities'));
    assert.equal(res.status,200);assert.equal(res.body.imagePolicy?.enabled,enabled);
    assert.deepEqual(res.body.imagePolicy?.grid?.requestsByImageCount,[1,1,1,1,2,2,2,2,3,3,3,3]);
    assert.match(res.body.imagePolicy.message,/费用/);
  }
});

// Catches planning before the authoritative category check, regrouping on resume, and whole-SKU paid requests.
test('new v1 task freezes resolved category and three bounded groups durably before the first paid request',async()=>{
  const env=fixture();const task=await env.create();
  const inspected=[];const service=createAiListingService({...env.ports,generateImageGroup:async input=>{
    const durable=env.repository.rows.get(task.id);inspected.push(structuredClone(input));
    assert.equal(durable.imagePlan.items[0].descriptionCategoryId,401);assert.equal(durable.imagePlan.items[0].typeId,501);
    assert.equal(durable.imagePlan.requestCount,3);
    return {images:input.sources.map(({index})=>({sku:input.sku,index,generatedUrl:`https://generated.test/${index}.png`}))};}});
  const done=await service.processNext();assert.equal(done.status,'AWAITING_REVIEW');
  assert.deepEqual(inspected.map(item=>item.sources.map(s=>s.index)),[[0,1,2,3],[4,5,6,7],[8,9,10,11]]);
  assert.equal(new Set(inspected.map(item=>item.requestKey)).size,3);
  assert.deepEqual(inspected.map(item=>item.gridGroup.layout),[layout,layout,layout]);
  assert.ok(inspected.every(item=>item.imagePolicy.minWidth===900&&item.imagePolicy.minHeight===1200));
  assert.equal(done.imagePlan.requestCount,3);
});

test('flag-off and legacy queued tasks retain one GRID request and receive no new publication policy',async()=>{
  const env=fixture({imagePolicyVersion:undefined});const task=await env.create();
  const restarted=createAiListingService({...env.ports,imagePolicyVersion:'ozon-v1'});
  const done=await restarted.processNext();assert.equal(done.status,'AWAITING_REVIEW');
  assert.equal(env.requests.length,1);assert.equal(env.requests[0].sources.length,12);
  assert.equal(env.requests[0].gridGroup,undefined);assert.equal(env.requests[0].imagePolicy,undefined);
  assert.equal(env.repository.rows.get(task.id).imagePlan,undefined);
});

test('missing confirmed category prevents plan admission, billing reservation and all image requests',async()=>{
  let funded=0;const env=fixture({checkSource:undefined,loadSources:async()=>{const s=source(4);delete s.items[0].listingItem.type_id;return [s];},billing:{reconcile:async({reserve})=>{if(reserve)funded++;return {funded:true};}}});
  await env.create();const done=await env.service.processNext();assert.equal(done.status,'GENERATION_FAILED');
  assert.match(done.errorMessage,/类目/);assert.equal(env.requests.length,0);assert.equal(funded,0);
});

test('known unsent retry belongs only to its frozen group and later groups start with clean channel state',async()=>{
  const requests=[];let failed=false;const env=fixture({generateImageGroup:async input=>{
    requests.push(structuredClone(input));if(input.sources[0].index===4&&!failed){failed=true;throw Object.assign(new Error('capacity'),{code:'AI_GATEWAY_RATE_LIMITED',channelId:'channel-a',deliveryState:'NOT_SENT'});}
    return {images:input.sources.map(({index})=>({sku:input.sku,index,generatedUrl:`https://generated.test/${index}.png`}))};}});
  const task=await env.create();const first=await env.service.processNext();assert.equal(first.images.filter(i=>i.generatedUrl).length,4);
  const frozen=structuredClone(env.repository.rows.get(task.id).imagePlan);
  const restarted=createAiListingService({...env.ports,imagePolicyVersion:undefined,checkSource:async({source})=>source});
  const done=await restarted.processNext();assert.equal(done.status,'AWAITING_REVIEW');
  assert.deepEqual(requests.map(r=>r.sources[0].index),[0,4,4,8]);
  assert.deepEqual(requests.map(r=>r.excludeChannelIds),[[],[],['channel-a'],[]]);
  assert.equal(new Set(requests.map(r=>r.requestKey)).size,4);
  assert.deepEqual(env.repository.rows.get(task.id).imagePlan,frozen);
});

test('unknown paid response pauses after its group without automatically invoking a later group or duplicating it',async()=>{
  const indices=[];const env=fixture({generateImageGroup:async input=>{indices.push(input.sources[0].index);if(input.sources[0].index===4)throw Object.assign(new Error('unknown'),{code:'AI_GATEWAY_STREAM_TIMEOUT',channelId:'channel-a',deliveryState:'POSSIBLY_SENT'});
    return {images:input.sources.map(({index})=>({sku:input.sku,index,generatedUrl:`https://generated.test/${index}.png`}))};}});
  await env.create();const done=await env.service.processNext();assert.equal(done.status,'GENERATION_FAILED');assert.equal(done.images.filter(i=>i.generatedUrl).length,4);
  assert.equal(await createAiListingService(env.ports).processNext(),null);assert.deepEqual(indices,[0,4]);assert.match(done.errorMessage,/未知/);
});

// Exercises true image buffers so an interpolated 1200x1600 result cannot hide an undersized model response.
test('v1 crop uses actual returned pixels, allows native 900x1200 and rejects smaller crops without upscaling',async()=>{
  const original=await pixel();const full=await prepareGrid({sources:[original,original,original,original],facts:[],prompt:'same',language:'ru',layout});
  const meta=await sharp(full.bytes).metadata();assert.equal(meta.width,2496);assert.equal(meta.height,3296);
  const good=await splitGrid(full.bytes,layout,4,policy);assert.deepEqual(await sharp(good[0]).metadata().then(({width,height})=>({width,height})),{width:1200,height:1600});
  const native=await sharp(full.bytes).resize(1872,2472,{kernel:'nearest'}).png().toBuffer();
  const smaller=await splitGrid(native,layout,4,policy);assert.deepEqual(await sharp(smaller[0]).metadata().then(({width,height})=>({width,height})),{width:900,height:1200});
  const tooSmall=await sharp(full.bytes).resize(1248,1648,{kernel:'nearest'}).png().toBuffer();
  await assert.rejects(splitGrid(tooSmall,layout,4,policy),{code:'AI_LISTING_IMAGE_DIMENSIONS_UNSUPPORTED'});
});

test('publication validation only applies at the new boundary and does not alter legacy or supported SINGLE bytes',async()=>{
  const bytes=await pixel(),small={bytes,contentType:'image/png'};
  assert.equal((await prepareAiListingImageForPublication(small)).bytes,bytes);
  await assert.rejects(prepareAiListingImageForPublication(small,policy),{code:'AI_LISTING_IMAGE_DIMENSIONS_UNSUPPORTED'});
  const formal=await sharp({create:{width:1200,height:1600,channels:3,background:'#ddd'}}).jpeg().toBuffer();
  const output=await prepareAiListingImageForPublication({bytes:formal,contentType:'image/jpeg'},policy);assert.equal(output.bytes,formal);
});

test('GRID spool keys isolate frozen groups while retaining byte-compatible legacy checkpoints',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'image-policy-'));try{
    const store=createAiListingResultStore({directory,minFreeBytes:0}),bytes=await pixel();
    const base={accountId:'a',taskId:'t',sku:'s',requestKey:'paid-1',prompt:'same',image:{language:'ru'},sources:[{index:0,sourceUrl:'https://source.test/0'}]};
    const first={...base,imagePolicy:policy,gridGroup:{id:'grid-0',indices:[0],layout}},second={...base,imagePolicy:policy,gridGroup:{id:'grid-1',indices:[4],layout}};
    const output={bytes,contentType:'image/png',requestId:'paid-result'};
    for(const input of [base,first,second]){await store.reserve(input,'GRID');await store.save(input,'GRID',output);}
    const legacy=createHash('sha256').update(JSON.stringify(['a','t','s','GRID',null])).digest('hex');
    assert.ok((await readdir(directory)).includes(`${legacy}.json`));
    assert.equal(JSON.parse(await readFile(join(directory,`${legacy}.json`),'utf8')).requestKey,'paid-1');
    await store.acknowledge({...first,generationMode:'GRID'});
    assert.equal(await store.load(first,'GRID'),null);assert.deepEqual((await store.load(second,'GRID')).bytes,bytes);assert.deepEqual((await store.load(base,'GRID')).bytes,bytes);
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('partial group upload and restart preserve successes, frozen plan and paid response without another model call',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'image-policy-'));try{
    const original=await pixel(),requests=[],writes=[];let blocked=true;
    const makeStore=()=>createAiListingResultStore({directory,minFreeBytes:0});let resultStore=makeStore();
    const generate=input=>createAiListingGridPort({resultStore,publication,downloadImage:async()=>({buffer:original}),recognizeText:async()=>[],
      runChannel:async(_input,generate)=>generate({profile:{imageModel:'fixture'},gateway:{generateImage:async request=>{requests.push(request.requestKey);return {bytes:request.sourceImages[0].bytes,contentType:'image/png',requestId:`paid-${requests.length}`,usage:{output_tokens:1}};}}}),
      putObject:async object=>{writes.push(object.key);if(blocked&&input.gridGroup.id==='grid-1'&&object.contentType!=='image/webp')throw Object.assign(new Error('unavailable'),{code:'AccessDenied'});}})(input);
    const env=fixture({generateImageGroup:generate,acknowledgeGeneratedResult:input=>resultStore.acknowledge(input)});const task=await env.create();
    const first=await env.service.processNext();assert.equal(first.status,'UPLOAD_FAILED');assert.equal(requests.length,3);
    assert.equal(first.images.filter(i=>i.generatedUrl).length,8);const kept=first.images.filter(i=>i.generatedUrl).map(i=>i.generatedUrl),plan=structuredClone(env.repository.rows.get(task.id).imagePlan);
    blocked=false;resultStore=makeStore();const service=createAiListingService({...env.ports,imagePolicyVersion:undefined});await service.retryTask({accountId:'account',taskId:task.id});
    const done=await service.processNext();assert.equal(done.status,'AWAITING_REVIEW');assert.equal(requests.length,3);assert.ok(kept.every(url=>done.images.some(i=>i.generatedUrl===url)));
    assert.deepEqual(env.repository.rows.get(task.id).imagePlan,plan);assert.deepEqual(await readdir(directory),[]);
    assert.equal(new Set(requests).size,3);
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('undersized provider output remains recoverable and stops before extra paid attempts or uploads',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'image-policy-'));try{
    const original=await pixel(),resultStore=createAiListingResultStore({directory,minFreeBytes:0});let models=0,writes=0;
    const port=createAiListingGridPort({resultStore,publication,downloadImage:async()=>({buffer:original}),recognizeText:async()=>[],putObject:async()=>{writes++;},
      runChannel:async(_input,generate)=>generate({profile:{imageModel:'fixture'},gateway:{generateImage:async request=>{models++;return {bytes:await sharp(request.sourceImages[0].bytes).resize({width:1248,height:1648,fit:'fill',kernel:'nearest'}).png().toBuffer(),contentType:'image/png',requestId:'undersized-paid'};}}})});
    const env=fixture({generateImageGroup:port});const task=await env.create();const first=await env.service.processNext();assert.equal(first.status,'GENERATION_FAILED');assert.equal(models,1);assert.equal(writes,0);assert.match(first.errorMessage,/900.*1200/);
    await env.service.retryTask({accountId:'account',taskId:task.id});await createAiListingService(env.ports).processNext();assert.equal(models,1);assert.equal(writes,0);
    assert.equal((await readdir(directory)).filter(name=>name.endsWith('.bin')).length,1);
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('pausing after a paid group checkpoints its four successes and resumes only the two remaining groups',async()=>{
  let task,env;const calls=[];
  env=fixture({generateImageGroup:async input=>{
    calls.push(input.sources[0].index);if(calls.length===1)await env.service.pauseTask({accountId:'account',taskId:task.id});
    return {images:input.sources.map(({index})=>({sku:input.sku,index,generatedUrl:`https://generated.test/${index}.png`}))};}});
  task=await env.create();const paused=await env.service.processNext();assert.equal(paused.status,'PAUSED');assert.equal(paused.images.filter(i=>i.generatedUrl).length,4);
  await env.service.resumeTask({accountId:'account',taskId:task.id});const done=await createAiListingService(env.ports).processNext();
  assert.equal(done.status,'AWAITING_REVIEW');assert.deepEqual(calls,[0,4,8]);
});

test('new SINGLE keeps the requested settings and preserves an undersized paid result on publication failure',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'image-policy-single-'));try{
    const bytes=await pixel(),store=createAiListingResultStore({directory,minFreeBytes:0});let requests=0,writes=0;const sizes=[];
    const port=createAiListingImagePort({publication,resultStore:store,downloadImage:async()=>({buffer:bytes,contentType:'image/png'}),
      loadProfile:async()=>({imageModel:'gpt-image-2'}),gateway:{generateImage:async input=>{requests++;sizes.push(input.size);return {bytes,contentType:'image/png',requestId:'single-paid'};}},putObject:async()=>{writes++;}});
    const env=fixture({loadSources:async()=>[source(1)],generateImage:port});const task=await env.create({generationMode:'SINGLE',image:{ratio:'3:4',resolution:'2K',language:'ru',quality:'high'}});
    const first=await env.service.processNext();assert.equal(first.status,'GENERATION_FAILED');assert.match(first.errorMessage,/30×40.*900×1200/);
    await env.service.retryTask({accountId:'account',taskId:task.id});await createAiListingService(env.ports).processNext();
    assert.equal(requests,1);assert.equal(writes,0);assert.deepEqual(sizes,['1536x2048']);
    assert.equal((await readdir(directory)).filter(name=>name.endsWith('.bin')).length,1);
  }finally{await rm(directory,{recursive:true,force:true});}
});

// Exercise the real channel request ledger and the existing SKU completion rule at their boundaries.
test('three native groups record three distinct actual requests but make the SKU billable only after all twelve images',async()=>{
  const {createAiUserChannels}=await import('../ai-user-channels.mjs');
  const {successfulSkus}=await import('../ai-sku-billing.mjs');
  const original=await pixel(),ledger=new Map(),eligibility=[],prompts=[];
  const channel={id:'channel',account_id:'account',base_url:'https://gateway.test/v1',image_model:'fixture',text_model:'',image_protocol:'SUB2API_OPENAI_IMAGES',credential:{},pricing:{mode:'REQUEST',currency:'USD',requestPrice:'0.25'}};
  const query=async(sql,values=[])=>{
    if(sql.includes('WITH chosen AS'))return {rows:[channel]};
    if(sql.startsWith('INSERT INTO ai_user_channel_requests')){ledger.set(values[0],{accountId:values[1],taskId:values[3],requestKey:values[4],status:'STARTED'});}
    else if(sql.startsWith("UPDATE ai_user_channel_requests SET status='SUCCEEDED'"))Object.assign(ledger.get(values[0]),{status:'SUCCEEDED',requestId:values[2],usage:JSON.parse(values[3]),cost:values[4],currency:values[5]});
    return {rows:[]};
  };
  const channels=createAiUserChannels({pool:{query,connect:async()=>({query,release(){}})},cipher:{decrypt:()=> 'fixture-only'},gatewayFactory:()=>({generateImage:async request=>{prompts.push(request.prompt);return {bytes:request.sourceImages[0].bytes,contentType:'image/png',requestId:`gateway-${ledger.size}`,usage:{inputTokens:1,outputTokens:2}};}})});
  let env;const port=createAiListingGridPort({publication,downloadImage:async()=>({buffer:original}),recognizeText:async()=>[],putObject:async()=>{},runChannel:(input,generate)=>channels.run(input,generate)});
  env=fixture({generateImageGroup:async input=>{eligibility.push(successfulSkus(env.repository.rows.values().next().value.images));return port(input);}});
  await env.create();const done=await env.service.processNext();assert.equal(done.status,'AWAITING_REVIEW');
  assert.deepEqual(eligibility,[[],[],[]]);assert.deepEqual(successfulSkus(done.images),['sku']);
  assert.deepEqual(prompts.map(prompt=>prompt.includes('Source 1 is the hero')),[true,false,false]);
  assert.equal(ledger.size,3);assert.equal(new Set([...ledger.values()].map(row=>row.requestKey)).size,3);
  assert.deepEqual([...ledger.values()].map(({status,requestId,cost,currency,usage})=>({status,requestId,cost,currency,usage})),[
    {status:'SUCCEEDED',requestId:'gateway-1',cost:'0.25',currency:'USD',usage:{inputTokens:1,outputTokens:2}},
    {status:'SUCCEEDED',requestId:'gateway-2',cost:'0.25',currency:'USD',usage:{inputTokens:1,outputTokens:2}},
    {status:'SUCCEEDED',requestId:'gateway-3',cost:'0.25',currency:'USD',usage:{inputTokens:1,outputTokens:2}},
  ]);
});

test('only the first frozen v1 group gets hero instructions while old and single-group prompts stay byte-compatible',async()=>{
  const original=await pixel(),input={sources:[original],facts:['verified fact'],prompt:'saved prompt unchanged',language:'ru'};
  const legacy=await prepareGrid(input),explicitFirst=await prepareGrid({...input,isFirstGroup:true}),later=await prepareGrid({...input,isFirstGroup:false});
  assert.equal(explicitFirst.prompt,legacy.prompt);assert.deepEqual(explicitFirst.bytes,legacy.bytes);
  assert.equal(later.prompt,legacy.prompt.replace('Source 1 is the hero and may summarize up to 3 supported points from this same SKU. ',''));
  const env=fixture();const task=await env.create();await env.service.processNext();
  assert.deepEqual(env.requests.map(input=>input.gridGroup.isFirstGroup),[true,false,false]);
  const frozen=structuredClone(env.repository.rows.get(task.id).imagePlan);
  assert.deepEqual((await createAiListingService(env.ports).getTask({accountId:'account',taskId:task.id})).imagePlan.items,frozen.items);
});

// Real Excel service entry points reproduce a late sibling after the first plan
// was already saved; only collection, account funding and paid I/O are doubles.
async function lateExcelFixture({sameSkuImages=false,stopped=false,waitFor='funds',resolvedB=true}={}) {
  const repository=memoryRepository(),requests=[],fundingPlans=[],paid=[],bytes=await pixel();
  let now=1_000_000,retryReady=false,admitted=false,resolvedA=401;
  const item=(sku,count)=>({sku,images:Array.from({length:count},(_,index)=>`https://source.test/${sku}/${index}.png`),
    listingItem:{description_category_id:401,type_id:501,weight:100,depth:100,width:100,height:100}});
  const load=sku=>({collectItemId:'shared-product',sku,items:sku==='A'?[item('A',sameSkuImages?3:4)]
    :sameSkuImages?[item('A',8),item('B',1)]:[item('B',8)]});
  const grid=createAiListingGridPort({publication,downloadImage:async()=>({buffer:bytes}),recognizeText:async()=>[],putObject:async()=>{},
    runChannel:async(input,generate)=>generate({profile:{imageModel:'fixture'},gateway:{generateImage:async request=>{
      paid.push({sku:input.sku,key:input.requestKey,size:request.size});return {bytes:request.sourceImages[0].bytes,contentType:'image/png',requestId:`paid-${paid.length}`};}}})});
  const ports={repository,imagePolicyVersion:'ozon-v1',clock:()=>now,
    collectSku:async({sku})=>{if(sku==='B'&&!retryReady)throw new Error('fixture collection failure');return load(sku);},
    checkSource:async({source})=>({...source,items:source.items.map(value=>value.sku==='B'
      ?{...value,listingItem:{...value.listingItem,description_category_id:601,type_id:resolvedB?701:0}}
      :{...value,listingItem:{...value.listingItem,description_category_id:resolvedA}})}),
    billing:{reconcile:async({reserve,taskId})=>{if(reserve)fundingPlans.push(structuredClone(repository.rows.get(taskId).imagePlan));
      return reserve?{funded:waitFor!=='funds'||admitted,message:'WAITING_FUNDS'}:{};}},
    ...(waitFor==='channel'?{reserveChannel:async()=>{if(!admitted)throw Object.assign(Error('no channel'),{code:'AI_GATEWAY_NO_CAPACITY'});return {channelId:'fixture',productToken:'fixture',release:async()=>{}};}}:{}),
    generateImageGroup:async input=>{requests.push({sku:input.sku,indices:input.sources.map(source=>source.index),group:structuredClone(input.gridGroup),
      durablePlan:structuredClone(repository.rows.get(input.taskId).imagePlan)});return grid(input);}};
  const service=createAiListingService(ports);
  const [a,b]=await service.createFromSkus({accountId:'account',skus:['A','B'],idempotencyKey:'late-sibling',
    config:{targetStoreId:'store',targetWarehouseId:'warehouse',generationMode:'GRID',manualReview:true}});
  if(stopped)await service.pauseTask({accountId:'account',taskId:b.id});
  await service.processNext({phase:'prepare'});if(!stopped)await service.processNext({phase:'prepare'});
  const waiting=await service.processNext({phase:'generate'});
  assert.equal(waiting.status,'GENERATING');assert.equal(paid.length,0);
  const frozen=structuredClone(repository.rows.get(a.id).imagePlan),originalImages=structuredClone(repository.rows.get(a.id).images);
  retryReady=true;
  await service[stopped?'resumeTask':'retryTask']({accountId:'account',taskId:b.id});
  await service.processNext({phase:'prepare'});
  const merged=repository.rows.get(a.id);assert.equal(merged.source.items.length,2);assert.equal(repository.rows.get(b.id).status,'MERGED');
  assert.deepEqual(merged.imagePlan,frozen,'merging cannot rewrite frozen groups before authoritative admission');
  return {repository,ports,service,a,b,requests,paid,fundingPlans,frozen,originalImages,
    admit(){admitted=true;now+=30_001;},setResolvedB(value){resolvedB=value;},setResolvedA(value){resolvedA=value;}};
}

test('Excel failed sibling after funding wait gets its resolved plan durably before any paid request',async()=>{
  const env=await lateExcelFixture();env.admit();
  const first=await env.service.processNext({phase:'generate'});
  const plan=env.repository.rows.get(env.a.id).imagePlan;
  assert.equal(plan.requestCount,3);assert.deepEqual(plan.items[0],env.frozen.items[0]);
  assert.deepEqual(plan.items.map(({sku,descriptionCategoryId,typeId})=>({sku,descriptionCategoryId,typeId})),[
    {sku:'A',descriptionCategoryId:401,typeId:501},{sku:'B',descriptionCategoryId:601,typeId:701}]);
  assert.equal(env.fundingPlans.at(-1).requestCount,3);assert.equal(first.images.filter(image=>image.generatedUrl).length,12);
  const restarted=createAiListingService({...env.ports,imagePolicyVersion:undefined});
  assert.equal(await restarted.processNext({phase:'generate'}),null);
  const done=await restarted.getTask({accountId:'account',taskId:env.a.id});
  assert.equal(done.status,'AWAITING_REVIEW');assert.equal(done.images.filter(image=>image.generatedUrl).length,12);
  assert.deepEqual(env.requests.map(({sku,indices})=>({sku,indices})),[{sku:'A',indices:[0,1,2,3]},{sku:'B',indices:[0,1,2,3]},{sku:'B',indices:[4,5,6,7]}]);
  assert.ok(env.requests.every(request=>request.durablePlan.requestCount===3));
  assert.deepEqual(env.paid.map(({sku,size})=>({sku,size})),[{sku:'A',size:'2496x3296'},{sku:'B',size:'2496x3296'},{sku:'B',size:'2496x3296'}]);
  assert.equal(new Set(env.paid.map(request=>request.key)).size,3);
  assert.deepEqual(env.repository.rows.get(env.a.id).images.filter(image=>image.sku==='A').map(image=>image.requestKey),env.originalImages.map(image=>image.requestKey));
});

test('Excel paused sibling after channel wait appends same-SKU slots without filling or renaming its frozen group',async()=>{
  const env=await lateExcelFixture({sameSkuImages:true,stopped:true,waitFor:'channel'});env.admit();
  await env.service.processNext({phase:'generate'});
  const plan=env.repository.rows.get(env.a.id).imagePlan;
  assert.equal(plan.requestCount,4);assert.deepEqual(plan.items[0].groups[0],env.frozen.items[0].groups[0]);
  assert.deepEqual(plan.items[0].groups.map(({id,indices,isFirstGroup})=>({id,indices,isFirstGroup})),[
    {id:'grid-0',indices:[0,1,2],isFirstGroup:true},{id:'grid-1',indices:[3,4,5,6],isFirstGroup:false},{id:'grid-2',indices:[7],isFirstGroup:false}]);
  assert.equal(env.fundingPlans.at(-1).requestCount,4);
  const paidA=env.repository.rows.get(env.a.id).images.filter(image=>image.sku==='A').map(image=>structuredClone(image));
  const restarted=createAiListingService(env.ports);assert.equal(await restarted.processNext({phase:'generate'}),null);
  const done=await restarted.getTask({accountId:'account',taskId:env.a.id});
  assert.equal(done.status,'AWAITING_REVIEW');assert.equal(env.paid.length,4);
  assert.deepEqual(env.repository.rows.get(env.a.id).images.filter(image=>image.sku==='A'),paidA);
  assert.deepEqual(env.requests.map(({sku,indices})=>({sku,indices})),[
    {sku:'A',indices:[0,1,2]},{sku:'A',indices:[3,4,5,6]},{sku:'A',indices:[7]},{sku:'B',indices:[0]}]);
  assert.ok(env.requests.every(request=>request.group&&request.durablePlan.requestCount===4));
});

test('late Excel SKU without a confirmed category stops before funding or the first image request',async()=>{
  const env=await lateExcelFixture({resolvedB:false}),before=env.fundingPlans.length;env.admit();
  const done=await env.service.processNext({phase:'generate'});
  assert.equal(done.status,'GENERATION_FAILED');assert.match(done.errorMessage,/类目/);
  assert.equal(env.paid.length,0);assert.equal(env.fundingPlans.length,before);assert.deepEqual(env.repository.rows.get(env.a.id).imagePlan,env.frozen);
});

test('late same-SKU slots with a changed category wait before payment and leave the original frozen group intact',async()=>{
  const env=await lateExcelFixture({sameSkuImages:true}),before=env.fundingPlans.length;env.admit();env.setResolvedA(801);
  const done=await env.service.processNext({phase:'generate'});
  assert.equal(done.status,'GENERATION_FAILED');assert.match(done.errorMessage,/类目.*冻结计划不一致/);
  assert.equal(env.paid.length,0);assert.equal(env.fundingPlans.length,before);assert.deepEqual(env.repository.rows.get(env.a.id).imagePlan,env.frozen);
});

test('a stored unplanned paid response cannot be silently assigned a new group, even after explicit retry',async()=>{
  const env=await lateExcelFixture(),before=env.fundingPlans.length;env.admit();
  // A record produced by the reviewed candidate may already have an unplanned
  // legacy B request. Its returned result/config is evidence to retain, not replan.
  const stored=env.repository.rows.get(env.a.id),image=stored.images.find(image=>image.sku==='B');
  const paidConfig={generationMode:'GRID',layout:{width:2432,height:3200},requestId:'earlier-paid-response'};
  Object.assign(image,{attempts:1,activeAttemptId:'earlier-paid-attempt',generationConfig:paidConfig});
  const failed=await env.service.processNext({phase:'generate'});
  assert.equal(failed.status,'GENERATION_FAILED');assert.match(failed.errorMessage,/已有请求记录.*缺少冻结计划/);
  await env.service.retryTask({accountId:'account',taskId:env.a.id});
  const retried=await createAiListingService(env.ports).processNext({phase:'generate'});
  assert.equal(retried.status,'GENERATION_FAILED');assert.equal(env.paid.length,0);assert.equal(env.fundingPlans.length,before);
  assert.deepEqual(env.repository.rows.get(env.a.id).imagePlan,env.frozen);
  assert.deepEqual(env.repository.rows.get(env.a.id).images.find(image=>image.sku==='B').generationConfig,paidConfig);
});
