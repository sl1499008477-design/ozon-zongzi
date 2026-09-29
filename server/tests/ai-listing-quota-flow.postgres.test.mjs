import './support/dedicated-postgres-test-environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import pg from 'pg';
import {createAiListingRepository} from '../ai-listing-repository.mjs';
import {createAiListingService} from '../ai-listing-service.mjs';
import {createAiListingSubmissionPorts} from '../ai-listing-submission.mjs';
import {createAiListingStoreRouting} from '../ai-listing-store-routing.mjs';

test('service and journal switch a wholly rejected synthetic group with stable images and identity, then complete stock',
 {skip:process.env.SONLI_POSTGRES_TESTS!=='1',timeout:15000},async()=>{
 const admin=new pg.Pool({connectionString:process.env.DATABASE_URL}),schema='quota_flow_'+randomUUID().replaceAll('-','');let pool;
 try{
  await admin.query(`CREATE SCHEMA ${schema}`);pool=new pg.Pool({connectionString:process.env.DATABASE_URL,options:`-c search_path=${schema}`,max:5});
  await pool.query("CREATE TABLE accounts(id text PRIMARY KEY); INSERT INTO accounts VALUES('owner'); CREATE TABLE account_ozon_routes(account_id text,route text)");
  for(const file of ['106_ai_image_listing.sql','107_ai_image_listing_submissions.sql','135_ai_product_scheduling.sql','141_ai_listing_task_controls.sql','150_ai_listing_list_summary.sql'])await pool.query(await readFile(new URL('../db/migrations/'+file,import.meta.url),'utf8'));
  let now=100000;const writes=[],prepared=[],remote=new Map(),repository=createAiListingRepository({pool});
  const config={targetStoreId:'primary',targetWarehouseId:'warehouse-primary',autoSwitchStores:true,fallbackStores:[{targetStoreId:'fallback',targetWarehouseId:'warehouse-fallback'}],stock:2,priceMultiplier:'1',priceAdjustmentKopecks:0,brandMode:'PREFER_SOURCE'};
  const source={sku:'sku-a',sourceSnapshot:{currency:'RUB',price:'20'},items:[{sku:'sku-a',images:['https://source.test/a'],categoryResolution:{status:'ACTIVE',currentDescriptionCategoryId:10,currentTypeId:20},listingItem:{offer_id:'offer-a',name:'Synthetic',price:'20',currency_code:'RUB',weight:200,depth:100,width:100,height:100}}]};
  const images=[{sku:'sku-a',index:0,sourceUrl:'https://source.test/a',generatedUrl:'https://paid.test/a',status:'COMPLETED',attempts:1}];
  const validateTarget=async({config:c})=>({store:{currencyCode:'RUB'},warehouse:{platformWarehouseId:c.targetStoreId==='primary'?'11':'22'}});
  const ports=createAiListingSubmissionPorts({pool,clock:()=>now,validateTarget,readCredential:async({targetStoreId})=>({clientId:targetStoreId}),normalizeItems:async items=>({items}),
   prepareMedia:async({items})=>{prepared.push(structuredClone(items));return items;},reserveCapacity:async()=>({allowed:true}),callOzonSellerApi:async(c,path,b)=>{
    if(path==='/v3/product/info/list')return {items:b.offer_id.map(x=>remote.get(c.clientId+':'+x)).filter(Boolean)};
    if(path==='/v3/product/import'){
     writes.push({store:c.clientId,body:structuredClone(b)});
     if(c.clientId==='primary')throw Object.assign(Error('quota rejected'),{status:400,body:{ozonCode:'item_limit_exceeded'}});
     b.items.forEach(x=>remote.set(c.clientId+':'+x.offer_id,{offer_id:x.offer_id,id:21,statuses:{is_created:true,status:'price_sent'}}));return {result:{task_id:8}};
    }
    if(path==='/v4/product/info/limit')return {daily_create:{limit:100,usage:100,reset_at:'1970-01-02T00:00:00Z'},total:{limit:1000,usage:5}};
    if(path==='/v1/product/import/info')return {result:{items:[{offer_id:'offer-a',product_id:21,status:'imported',errors:[]}]}};
    if(path==='/v2/products/stocks'){assert.equal(c.clientId,'fallback');assert.equal(b.stocks[0].warehouse_id,22);return {result:b.stocks.map(x=>({...x,updated:true,errors:[]}))};}
    assert.fail('Unexpected request '+path);
   }});
  await repository.create({id:'task',accountId:'owner',dedupeKey:'task',status:'READY_TO_SUBMIT',sourceType:'COLLECT_BOX',sourceId:'saved-source',sku:'sku-a',source,images,config,submissionKey:'stable',createdAt:now,updatedAt:now,nextRunAt:now});
  const makeService=()=>createAiListingService({repository,...ports,routeStores:createAiListingStoreRouting({pool,validateTarget}),clock:()=>now,generateImage:async()=>assert.fail('never regenerate')});
  let service=makeService(),id;
  for(let step=0;step<9;step++){
   await service.processNext();const saved=await repository.get({accountId:'owner',taskId:'task'});
   if(saved.submissionId){if(id)assert.equal(saved.submissionId,id);else id=saved.submissionId;}
   if(saved.status==='COMPLETED')break;
   now+=15000;service=makeService();
  }
  const saved=await repository.get({accountId:'owner',taskId:'task'});
  assert.equal(saved.status,'COMPLETED',saved.errorMessage);assert.equal(saved.submissionTarget.targetStoreId,'fallback');assert.deepEqual(saved.images,images);
  assert.deepEqual(writes.map(x=>x.store),['primary','fallback']);assert.deepEqual(writes[0].body.items[0].images,writes[1].body.items[0].images);assert.equal(prepared.length,2);
  const journal=(await pool.query('SELECT body FROM ai_image_listing_submissions WHERE id=$1',[id])).rows[0].body;
  assert.equal(journal.config.targetStoreId,'fallback');assert.equal(journal.results[0].stockStatus,'COMPLETED');
 }finally{await pool?.end();await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();}
});
