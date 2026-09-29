import test from 'node:test';
import assert from 'node:assert/strict';
import {createAiListingService} from '../ai-listing-service.mjs';
import {createAiListingSubmissionPorts} from '../ai-listing-submission.mjs';
import {memoryRepository} from './support/ai-listing-memory-repository.mjs';

test('phased recovery submits only the recovered sibling after reconciling a historical uncertain partial import', async () => {
  let journal, now=1000, recovered=false,route='CN',routeReads=0;
  const imports=[],stocks=[];
  const client={release(){},async query(sql,values){
    if(sql.includes('pg_try_advisory_lock'))return {rows:[{locked:true}]};
    if(sql.startsWith('SELECT * FROM ai_image_listing_submissions'))return {rows:journal?[structuredClone(journal)]:[]};
    if(sql.startsWith('INSERT INTO ai_image_listing_submissions')){
      journal={id:values[0],account_id:values[1],task_id:values[2],body:JSON.parse(values[4])};
      return {rows:[]};
    }
    if(sql.startsWith('UPDATE ai_image_listing_submissions')){
      journal.body=JSON.parse(values[2]);return {rows:[]};
    }
    return {rows:[]};
  }};
  const ports=createAiListingSubmissionPorts({
    pool:{connect:async()=>client,query:(...args)=>client.query(...args)},clock:()=>now,
    reserveCapacity:async()=>({allowed:true}),
    validateTarget:async()=>({store:{currencyCode:'RUB'},warehouse:{platformWarehouseId:'123'}}),
    readCredential:async()=>({clientId:'seller',ozonRoute:route}),normalizeItems:async items=>({items}),
    callOzonSellerApi:async(_credential,path,body)=>{
      assert.equal(_credential.ozonRoute,'RU','only AI submission calls use the official API; the original CN config stays frozen');
      if(path==='/v4/product/info/limit')return {daily_create:{limit:1000,usage:0},total:{limit:1000,usage:0}};
      if(path==='/v3/product/info/list')return {items:body.offer_id
        .filter(sku=>recovered&&(sku==='a'||imports.some(items=>items.includes(sku))))
        .map(offer_id=>({offer_id,id:offer_id==='a'?1:2,statuses:{status:'price_sent'}}))};
      if(path==='/v3/product/import'){
        imports.push(body.items.map(item=>item.offer_id));
        if(imports.length===1)throw new Error('first import reached Ozon but response was lost');
        return {result:{task_id:imports.length}};
      }
      if(path==='/v1/product/import/info')return {result:{items:imports[body.task_id-1]
        .map(offer_id=>({offer_id,product_id:offer_id==='a'?1:2,status:'imported',errors:[]}))}};
      if(path==='/v2/products/stocks'){
        stocks.push(body.stocks.map(stock=>stock.offer_id));
        return {result:body.stocks.map(stock=>({...stock,updated:true,errors:[]}))};
      }
      assert.fail(`Unexpected Seller endpoint: ${path}`);
    },
  });
  const source={collectItemId:'mixed',sku:'a',name:'Mixed product',
    sourceSnapshot:{currency:'RUB',price:'20',listingDraft:{variants:[{sku:'b',currency:'RUB',price:'20'}]}},
    items:['a','b'].map(sku=>({sku,images:[`https://source.test/${sku}`],
      categoryResolution:{status:'ACTIVE',currentDescriptionCategoryId:10,currentTypeId:20},
      listingItem:{offer_id:sku,price:'20',name:sku,weight:200,depth:100,width:110,height:120}}))};
  const repository=memoryRepository();
  const service=createAiListingService({repository,clock:()=>now,readOzonRoute:async()=>{routeReads++;return route;},loadSources:async()=>[source],
    generateImage:async({sku})=>{
      if(sku==='b'&&!recovered)throw Object.assign(new Error('source failed'),{code:'AUTO_LISTING_SOURCE_DOWNLOAD_FAILED'});
      return {generatedUrl:`https://generated.test/${sku}`};
    },submitListing:ports.submitListing,readSubmission:ports.readSubmission});
  const [task]=await service.createFromCollect({accountId:'account',collectItemIds:['mixed'],idempotencyKey:'mixed',
    config:{targetStoreId:'store',targetWarehouseId:'warehouse',brandMode:'PREFER_SOURCE'}});
  assert.equal((await service.processNext({phase:'generate'})).status,'GENERATION_FAILED');
  // Model a partial import that predates the all-variant first-submission rule.
  // Use the real journal port so reconciliation and deduplication remain exercised.
  const historical=repository.rows.get(task.id);
  const prior=await ports.submitListing({accountId:'account',taskId:task.id,idempotencyKey:historical.submissionKey,
    config:historical.config,source:{...historical.source,items:historical.source.items.filter(item=>item.sku==='a')},
    images:historical.images.filter(image=>image.sku==='a'),beforeExternalWrite:async()=>{historical.submissionExternalWriteStarted=true;}});
  Object.assign(historical,{submissionId:prior.submissionId,status:'SUBMISSION_UNCERTAIN',submissionStarted:true});
  assert.deepEqual(imports,[['a']]);

  recovered=true;route='RU';
  await service.retryTask({accountId:'account',taskId:task.id});
  // Allow the workers to reconcile old work, prepare the recovered SKU, and finish it.
  for(let round=0;round<10;round++){
    for(const phase of ['generate','media','finalize'])await service.processNext({phase});
    if(repository.rows.get(task.id).status==='COMPLETED')break;
    now+=60000;
  }
  const result=await service.getTask({accountId:'account',taskId:task.id});
  assert.deepEqual(imports,[['a'],['b']],
    'B must reach Ozon after A is reconciled; task completion cannot silently omit B');
  assert.equal(result.status,'COMPLETED');assert.equal(routeReads,1);assert.equal(journal.body.config.ozonRoute,'CN');
  assert.deepEqual(journal.body.results.filter(item=>item.stockStatus==='COMPLETED').map(item=>item.sku).sort(),['a','b']);
  assert.deepEqual(stocks.flat().sort(),['a','b'],'each submitted SKU must be stocked once');
  assert.equal(result.skuProgress.filter(item=>item.status==='COMPLETED').length,journal.body.results.length);
});
