import test from 'node:test';
import assert from 'node:assert/strict';
import {createAiListingService} from '../ai-listing-service.mjs';
import {createAiListingSubmissionPorts} from '../ai-listing-submission.mjs';
import {evaluateAiListingSkuPricing} from '../ai-listing-source-facts.mjs';
import {memoryRepository} from './support/ai-listing-memory-repository.mjs';

function setup({generationMode='SINGLE',blocked='source',uncertain=false}={}) {
  let journal,now=1000,recovered=false,picturesRepaired=false;
  const imports=[],stocks=[],pictures=[],generated=[];
  const client={release(){},async query(sql,values){
    if(sql.includes('pg_try_advisory_lock'))return {rows:[{locked:true}]};
    if(sql.startsWith('SELECT * FROM ai_image_listing_submissions'))return {rows:journal?[structuredClone(journal)]:[]};
    if(sql.startsWith('INSERT INTO ai_image_listing_submissions')){
      journal={id:values[0],account_id:values[1],task_id:values[2],body:JSON.parse(values[4])};return {rows:[]};
    }
    if(sql.startsWith('UPDATE ai_image_listing_submissions')){journal.body=JSON.parse(values[2]);return {rows:[]};}
    return {rows:[]};
  }};
  const ports=createAiListingSubmissionPorts({
    pool:{connect:async()=>client,query:(...args)=>client.query(...args)},clock:()=>now,
    reserveCapacity:async()=>({allowed:true}),
    validateTarget:async()=>({store:{currencyCode:'RUB'},warehouse:{platformWarehouseId:'123'}}),
    readCredential:async()=>({clientId:'seller'}),normalizeItems:async items=>({items}),
    callOzonSellerApi:async(_credential,path,body)=>{
      if(path==='/v4/product/info/limit')return {daily_create:{limit:1000,usage:0},total:{limit:1000,usage:0}};
      if(path==='/v3/product/import'){
        imports.push(body.items.map(item=>item.offer_id));
        if(uncertain&&imports.length===1)throw new Error('import reached Ozon but its response was lost');
        return {result:{task_id:imports.length}};
      }
      if(path==='/v1/product/import/info')return {result:{items:(body.task_id===99?['b']:imports[body.task_id-1])
        .map(offer_id=>({offer_id,product_id:offer_id==='a'?1:2,status:'imported',errors:[]}))}};
      if(path==='/v3/product/info/list')return {items:body.offer_id
        .filter(sku=>imports.some(group=>group.includes(sku))&&(!uncertain||recovered))
        .map(offer_id=>({offer_id,id:offer_id==='a'?1:2,
          statuses:blocked==='publication'&&offer_id==='b'&&!picturesRepaired
            ?{status:'offer_validated',status_failed:'pics_delivered',is_created:false,status_updated_at:'2026-09-16T08:57:45Z'}
            :{status:'price_sent',is_created:true},
          images360:[],color_image:[],errors:blocked==='publication'&&offer_id==='b'&&!picturesRepaired
            ?[{code:'all_image_failed',level:'ERROR_LEVEL_ERROR'}]:[]}))};
      if(path==='/v2/product/pictures/import'){
        pictures.push(structuredClone(body.items));picturesRepaired=true;return {task_id:99};
      }
      if(path==='/v2/product/pictures/info')return {items:[{product_id:2,photo:pictures.at(-1)[0].images,errors:[]}]};
      if(path==='/v2/products/stocks'){
        stocks.push(body.stocks.map(stock=>stock.offer_id));
        return {result:body.stocks.map(stock=>({...stock,updated:true,errors:[]}))};
      }
      assert.fail(`Unexpected Seller endpoint: ${path}`);
    },
  });
  const salePricing={currency:'RUB',pricingVersion:2,realPriceFormula:'黑标价',salePriceFormula:'真实售价',
    useBlackPriceWhenGreenMissing:blocked!=='skipped'};
  const variant={sku:'b',currency:'RUB',blackKopecks:'2000',greenKopecks:null};
  const source={collectItemId:'review',sku:'a',name:'Review recovery',
    sourceSnapshot:{currency:'RUB',blackKopecks:'2000',greenKopecks:'1900',listingDraft:{variants:[variant]}},
    items:['a','b'].map(sku=>({sku,images:Array.from({length:sku==='b'?2:1},(_,index)=>`https://source.test/${sku}/${index}`),
      categoryResolution:{status:'ACTIVE',currentDescriptionCategoryId:10,currentTypeId:20},
      listingItem:{offer_id:sku,name:sku,weight:200,depth:100,width:110,height:120,...(sku==='b'?{_sourceVariant:variant}:{})}}))};
  const repository=memoryRepository();
  const generate=async input=>{
    if(input.sku==='b'&&blocked==='source'&&!recovered)throw Object.assign(new Error('source failed'),{code:'AUTO_LISTING_SOURCE_DOWNLOAD_FAILED'});
    generated.push({sku:input.sku,index:input.index});
    return {generatedUrl:`https://generated.test/${input.sku}/${input.index}`};
  };
  const service=createAiListingService({repository,clock:()=>now,loadSources:async()=>[source],
    checkSource:async({source,config,protectedSkus})=>({...source,skuPricing:evaluateAiListingSkuPricing({source,config,protectedSkus,store:{currencyCode:'RUB'}})}),
    generateImage:generate,generateImageGroup:async input=>{
      await generate(input);return {images:input.sources.map(image=>({sku:input.sku,index:image.index,generatedUrl:`https://generated.test/${input.sku}/${image.index}`}))};
    },submitListing:ports.submitListing,readSubmission:ports.readSubmission});
  let task;
  return {service,repository,imports,stocks,pictures,generated,salePricing,journal:()=>journal,
    recover(){recovered=true;},
    async create(){[task]=await service.createFromCollect({accountId:'account',collectItemIds:['review'],idempotencyKey:'review',
      config:{targetStoreId:'store',targetWarehouseId:'warehouse',brandMode:'PREFER_SOURCE',manualReview:true,generationMode,salePricingId:'pricing',salePricing}});return task;},
    async seedHistoricalPartial(){
      // Preserve coverage of already-sent partial products without requiring the
      // new service to bypass its whole-product first-submission boundary.
      const row=repository.rows.get(task.id);
      const prior=await ports.submitListing({accountId:'account',taskId:task.id,idempotencyKey:row.submissionKey,
        config:row.config,source:{...row.source,items:row.source.items.filter(item=>item.sku==='a')},
        images:row.images.filter(image=>image.sku==='a'),beforeExternalWrite:async()=>{row.submissionExternalWriteStarted=true;}});
      Object.assign(row,{submissionId:prior.submissionId,submissionStarted:true,approved:true,
        status:uncertain?'SUBMISSION_UNCERTAIN':'SUBMITTED'});
    },
    async until(status){
      for(let round=0;round<12;round++){
        for(const phase of ['generate','media','finalize'])await service.processNext({phase});
        if(repository.rows.get(task.id).status===status)break;
        now+=60000;
      }
      return service.getTask({accountId:'account',taskId:task.id});
    },
  };
}

for(const generationMode of ['SINGLE','GRID'])for(const blocked of ['source','skipped'])
  test(`${generationMode} recovered ${blocked} SKU requires a new approval before only B is appended`,async()=>{
    const env=setup({generationMode,blocked}),task=await env.create(),scope={accountId:'account',taskId:task.id};
    if(blocked==='source'){
      assert.equal((await env.until('GENERATION_FAILED')).status,'GENERATION_FAILED');
      await env.seedHistoricalPartial();
    }else{
      assert.equal((await env.until('AWAITING_REVIEW')).status,'AWAITING_REVIEW');
      await env.service.approveTask(scope);
    }
    assert.equal((await env.until(blocked==='skipped'?'COMPLETED':'GENERATION_FAILED')).status,blocked==='skipped'?'COMPLETED':'GENERATION_FAILED');
    assert.deepEqual(env.imports,[['a']]);
    const originalA=structuredClone(env.journal().body.results[0]);
    env.recover();
    await env.service.retryTask({...scope,...(blocked==='skipped'?{refreshSalePricing:true}:{})},
      {beforeRetry:async()=>({salePricing:{...env.salePricing,useBlackPriceWhenGreenMissing:true}})});
    const awaiting=await env.until('AWAITING_REVIEW');
    assert.equal(awaiting.status,'AWAITING_REVIEW','newly recovered images require approval');
    assert.equal(awaiting.taskActions.approve,true,'historical submission identity must not block reviewing new images');
    assert.deepEqual(env.imports,[['a']],'B cannot be sent before its new images are approved');
    await assert.rejects(env.service.approveTask({...scope,accountId:'other-account'}),{statusCode:404});
    await assert.rejects(env.service.approveTask({...scope,expectedVersion:awaiting.version-1}),{statusCode:409});
    await env.service.approveTask({...scope,expectedVersion:awaiting.version});
    assert.equal((await env.until('COMPLETED')).status,'COMPLETED');
    assert.deepEqual(env.imports,[['a'],['b']]);
    assert.deepEqual(env.stocks.flat().sort(),['a','b']);
    assert.deepEqual(env.journal().body.results[0],originalA,'A retains its original successful result');
    assert.equal(env.generated.filter(image=>image.sku==='a').length,1);
  });

test('recovered B waits for approval before reconciling uncertain A and appending B',async()=>{
  const env=setup({uncertain:true}),task=await env.create(),scope={accountId:'account',taskId:task.id};
  assert.equal((await env.until('GENERATION_FAILED')).status,'GENERATION_FAILED');await env.seedHistoricalPartial();
  assert.equal((await env.until('SUBMISSION_UNCERTAIN')).status,'SUBMISSION_UNCERTAIN');
  env.recover();await env.service.retryTask(scope);
  const awaiting=await env.until('AWAITING_REVIEW');
  assert.equal(awaiting.status,'AWAITING_REVIEW');
  assert.equal(awaiting.taskActions.approve,true);
  assert.equal(awaiting.taskActions.cancel,false,'old uncertain submission keeps its control fence');
  assert.deepEqual(env.imports,[['a']]);
  await env.service.approveTask(scope);
  assert.equal((await env.until('COMPLETED')).status,'COMPLETED');
  assert.deepEqual(env.imports,[['a'],['b']]);
  assert.deepEqual(env.stocks.flat().sort(),['a','b']);
});

test('retrying Ozon image delivery preserves approval and reuses the entire saved B gallery',async()=>{
  const env=setup({blocked:'publication'}),task=await env.create(),scope={accountId:'account',taskId:task.id};
  await env.until('AWAITING_REVIEW');await env.service.approveTask(scope);
  const failed=await env.until('SUBMISSION_FAILED');
  assert.equal(failed.status,'SUBMISSION_FAILED');assert.equal(failed.submissionStage,'image_failed');
  const generated=structuredClone(env.generated);
  const retry=await env.service.retryTask(scope);
  assert.equal(retry.status,'READY_TO_SUBMIT');assert.equal(env.repository.rows.get(task.id).approved,true);
  assert.equal((await env.until('COMPLETED')).status,'COMPLETED');
  assert.deepEqual(env.generated,generated,'delivery retry cannot generate images again');
  assert.deepEqual(env.imports,[['a','b']],'repair cannot reimport a product');
  assert.equal(env.pictures.length,1);assert.equal(env.pictures[0][0].offer_id,'b');
  assert.deepEqual(env.pictures[0][0].images.map(value=>{const url=new URL(value);url.searchParams.delete('_ozon_image_retry');return url.href;}),
    ['https://generated.test/b/0','https://generated.test/b/1']);
  assert.deepEqual(env.stocks.flat().sort(),['a','b']);
});
