import { normalizeOzonImportItems } from "../ozon-import-normalizer.mjs";
import test from 'node:test';
import assert from 'node:assert/strict';
import {createAiListingSubmissionPorts} from '../ai-listing-submission.mjs';
const input=()=>({accountId:'account',taskId:'task',idempotencyKey:'stable',config:{targetStoreId:'store',targetWarehouseId:'warehouse',stock:5,priceMultiplier:'1',priceAdjustmentKopecks:0,brandMode:'PREFER_SOURCE'},source:{collectItemId:'deleted',sku:'a',sourceSnapshot:{currency:'RUB',price:'20',listingDraft:{variants:[{sku:'b',currency:'RUB',price:'20'}]}},items:['a','b'].map(sku=>({sku,images:['https://source.test/'+sku],categoryResolution:{status:'ACTIVE',currentDescriptionCategoryId:10,currentTypeId:20},listingItem:{offer_id:sku,price:'20',name:sku,weight:200,depth:100,width:110,height:120}}))},images:['a','b'].map(sku=>({sku,index:0,generatedUrl:'https://generated.test/'+sku}))});
function setup(handler,{normalizeItems=async items=>({items}),prepareMedia,quotaProvider}={}){let row;let now=100000;const calls=[];const c={release(){},async query(sql,v){if(sql.includes('pg_try_advisory_lock'))return {rows:[{locked:true}]};if(sql.startsWith('SELECT * FROM ai_image_listing_submissions'))return {rows:row?[structuredClone(row)]:[]};if(sql.startsWith('INSERT INTO ai_image_listing_submissions')){row={id:v[0],account_id:v[1],task_id:v[2],body:JSON.parse(v[4])};return {rows:[]};}if(sql.startsWith('UPDATE ai_image_listing_submissions')){row.body=JSON.parse(v[2]);return {rows:[]};}if(sql.includes('collect_ozon_category'))throw Error('deleted collection must not be consulted');return {rows:[]};}};const ports=createAiListingSubmissionPorts({pool:{connect:async()=>c,query:(...args)=>c.query(...args)},clock:()=>now,reserveCapacity:async()=>({allowed:true}),validateTarget:async()=>({store:{currencyCode:'RUB'},warehouse:{platformWarehouseId:'123'}}),readCredential:async()=>({clientId:'seller'}),normalizeItems,prepareMedia,callOzonSellerApi:async(_c,path,body)=>{calls.push({path,body:structuredClone(body)});if(path==='/v4/product/info/limit'&&quotaProvider)return quotaProvider();if(path==='/v4/product/info/limit')return {daily_create:{limit:1000,usage:0},total:{limit:1000,usage:0},operation_limits:{limit:100,limit_type:'RATE_LIMIT_PER_MINUTE'}};return handler(path,body);}});return {ports,calls,row:()=>row,advance:ms=>{now+=ms;}};}

test('a selected historical missing-product stock failure rechecks exact identity and leaves declined siblings unchanged',async()=>{
 const x=setup((path,body)=>{
  if(path==='/v3/product/info/list')return {items:body.offer_id.map(offer_id=>({offer_id,id:offer_id==='a'?11:22,statuses:{status:'price_sent',is_created:true,status_name:'Продается'}}))};
  if(path==='/v2/products/stocks')return {result:body.stocks.map(stock=>({...stock,updated:true,errors:[]}))};
  assert.fail(`unexpected product creation or content preparation: ${path}`);
 });
 const data=input(),accepted=await x.ports.submitListing({...data,deferImport:true});
 const body=x.row().body;body.attempts[0].status='DONE';body.status='FAILED';
 body.results=[{sku:'a',offerId:'a',productId:'11',importStatus:'SUCCEEDED',stockStatus:'FAILED',errors:['PRODUCT_IS_NOT_CREATED']},
  {sku:'b',offerId:'b',productId:'22',importStatus:'SUCCEEDED',stockStatus:'FAILED',publicationStatus:'REJECTED',errors:['DESCRIPTION_DECLINE']}];
 const sibling=structuredClone(body.results[1]),frozen=structuredClone(body.items);
 await x.ports.submitListing({...data,retryAttempt:1,retrySkus:['a'],deferImport:true});
 const result=await x.ports.readSubmission({accountId:data.accountId,submissionId:accepted.submissionId});
 assert.equal(result.items[0].stockStatus,'COMPLETED');assert.equal(result.items[0].publicationCheck.statusName,'Продается');
 assert.deepEqual(result.items[1],sibling);assert.deepEqual(x.row().body.items,frozen);
 assert.deepEqual(x.calls.filter(c=>c.path==='/v2/products/stocks').map(c=>c.body.stocks.map(s=>s.offer_id)),[['a']]);
});

test('stock recovery refuses a reused offer pointing to a different product',async()=>{
 const x=setup((path,body)=>{if(path==='/v3/product/info/list')return {items:body.offer_id.map(offer_id=>({offer_id,id:99,statuses:{status:'price_sent',is_created:true}}))};assert.fail(path);});
 const data=input(),accepted=await x.ports.submitListing({...data,deferImport:true});const body=x.row().body;
 body.attempts[0].status='DONE';body.status='FAILED';body.results.forEach(r=>Object.assign(r,{productId:'11',importStatus:'SUCCEEDED',stockStatus:'FAILED',errors:['PRODUCT_IS_NOT_CREATED']}));
 await x.ports.submitListing({...data,retryAttempt:1,retrySkus:['a'],deferImport:true});
 const result=await x.ports.readSubmission({accountId:data.accountId,submissionId:accepted.submissionId});
 assert.equal(result.items[0].stockStatus,'FAILED');assert.deepEqual(result.items[0].errors,['AI_LISTING_STOCK_IDENTITY_MISMATCH']);
 assert.equal(x.calls.some(c=>c.path==='/v2/products/stocks'),false);
});

test('unchanged pending stock becomes actionable after 30 minutes and completed stock is never repeated',async()=>{
 const x=setup((path,body)=>{
  if(path==='/v3/product/import')return {result:{task_id:1}};
  if(path==='/v1/product/import/info')return {result:{items:['a','b'].map((offer_id,i)=>({offer_id,product_id:i+1,status:'imported',errors:[]}))}};
  if(path==='/v3/product/info/list')return {items:body.offer_id.map(offer_id=>({offer_id,id:offer_id==='a'?1:2,statuses:{status:'price_sent',is_created:true}}))};
  if(path==='/v2/products/stocks')return {result:body.stocks.map(stock=>({...stock,updated:stock.offer_id==='a',errors:stock.offer_id==='b'?[{code:'PRODUCT_HAS_NOT_BEEN_TAGGED_YET'}]:[]}))};
  assert.fail(path);
 });
 const accepted=await x.ports.submitListing(input()),read=()=>x.ports.readSubmission({accountId:'account',submissionId:accepted.submissionId});
 assert.equal((await read()).status,'SUBMITTED');x.advance(30*60_000);
 const result=await read();assert.equal(result.status,'FAILED');assert.equal(result.items[0].stockStatus,'COMPLETED');
 assert.equal(result.items[1].publicationStatus,'WAITING_TIMEOUT');assert.match(result.items[1].failureReason,/30.*分钟/);
 assert.equal(x.calls.filter(c=>c.path==='/v2/products/stocks').flatMap(c=>c.body.stocks).filter(s=>s.offer_id==='a').length,1);
});

test('historical stock recovery awaiting creation is bounded by unchanged observations, not task age',async()=>{
 const x=setup((path,body)=>{if(path==='/v3/product/info/list')return {items:body.offer_id.map(offer_id=>({offer_id,id:11,statuses:{status:'imported',is_created:false,moderate_status:'pending'}}))};assert.fail(path);});
 const data=input(),accepted=await x.ports.submitListing({...data,deferImport:true});const body=x.row().body;
 body.attempts[0].status='DONE';body.createdAt=-86400000;
 body.results.forEach(r=>Object.assign(r,{productId:'11',importStatus:'SUCCEEDED',stockStatus:'FAILED',errors:['PRODUCT_IS_NOT_CREATED']}));
 await x.ports.submitListing({...data,retryAttempt:1,retrySkus:['a'],deferImport:true});
 const read=()=>x.ports.readSubmission({accountId:'account',submissionId:accepted.submissionId});
 assert.equal((await read()).items[0].stockStatus,'PENDING','historical task age cannot immediately expire a fresh observation');
 x.advance(29*60_000);assert.equal((await read()).items[0].stockStatus,'PENDING');
 x.advance(60000);assert.equal((await read()).items[0].publicationStatus,'WAITING_TIMEOUT');
 const since=x.row().body.results[0].waitingSince;
 await x.ports.submitListing({...data,retryAttempt:2,retrySkus:['a'],deferImport:true});
 assert.equal((await read()).items[0].publicationStatus,'WAITING_TIMEOUT','same pending platform state stays actionable after a query-only retry');
 assert.equal(x.row().body.results[0].waitingSince,since);assert.equal(x.calls.some(c=>c.path==='/v2/products/stocks'),false);
});

test('a selected stock failure can recover while a sibling import stays uncertain without reimporting it',async()=>{
 const x=setup((path,body)=>{
  if(path==='/v3/product/info/list')return {items:body.offer_id.filter(id=>id==='a').map(offer_id=>({offer_id,id:11,statuses:{status:'price_sent',is_created:true}}))};
  if(path==='/v2/products/stocks')return {result:body.stocks.map(stock=>({...stock,updated:true,errors:[]}))};assert.fail(path);
 });
 const data=input(),accepted=await x.ports.submitListing({...data,deferImport:true});const body=x.row().body;
 body.attempts=[{id:'unknown',offerIds:['b'],status:'UNCERTAIN',preexistingOfferIds:[]}];body.status='UNCERTAIN';
 Object.assign(body.results[0],{productId:'11',importStatus:'SUCCEEDED',stockStatus:'FAILED',errors:['PRODUCT_IS_NOT_CREATED']});
 await x.ports.submitListing({...data,retryAttempt:1,retrySkus:['a'],deferImport:true});
 const result=await x.ports.readSubmission({accountId:'account',submissionId:accepted.submissionId});
 assert.equal(result.items[0].stockStatus,'COMPLETED');assert.equal(result.items[1].importStatus,'UNKNOWN');assert.equal(result.status,'UNCERTAIN');
 assert.equal(x.calls.some(c=>c.path==='/v3/product/import'),false);
});

test('picture recovery does not resend a gallery with a content moderation warning',async()=>{
 const x=setup((path,body)=>{if(path==='/v3/product/info/list')return {items:body.offer_id.map(offer_id=>({offer_id,id:1,statuses:{status:'offer_validated',is_created:false},errors:[{code:'all_image_failed',level:'ERROR_LEVEL_ERROR'},{code:'DESCRIPTION_DECLINE',level:'ERROR_LEVEL_WARNING'}]}))};assert.fail(path);});
 const data=input(),accepted=await x.ports.submitListing({...data,deferImport:true});const body=x.row().body;
 body.attempts[0].status='DONE';body.results.forEach(r=>Object.assign(r,{productId:'1',importStatus:'SUCCEEDED',stockStatus:'FAILED',publicationStatus:'IMAGE_FAILED',errors:['all_image_failed']}));
 await x.ports.submitListing({...data,retryAttempt:1,retrySkus:['a'],deferImport:true});
 const result=await x.ports.readSubmission({accountId:'account',submissionId:accepted.submissionId});
 assert.equal(result.items[0].publicationStatus,'REJECTED');assert.match(result.items[0].failureReason,/审核/);
 assert.equal(x.calls.some(c=>c.path==='/v2/product/pictures/import'),false);
});

for(const warningCode of ['some_image_failed','warning_all_image_failed'])test(`explicit pure ${warningCode} recovery preserves completed inventory while resending only its gallery`,async()=>{
 const x=setup((path,body)=>{
  if(path==='/v3/product/info/list')return {items:body.offer_id.map(offer_id=>({offer_id,id:1,statuses:{status:'price_sent',is_created:true},errors:[{code:warningCode,level:'ERROR_LEVEL_WARNING'}]}))};
  if(path==='/v2/product/pictures/import')return {task_id:99};assert.fail(path);
 });
 const data=input(),accepted=await x.ports.submitListing({...data,deferImport:true}),body=x.row().body;body.attempts[0].status='DONE';body.status='FAILED';
 Object.assign(body.results[0],{productId:'1',importStatus:'SUCCEEDED',stockStatus:'COMPLETED',publicationWarnings:[warningCode]});body.stocks[0].completed=true;
 Object.assign(body.results[1],{productId:'2',importStatus:'SUCCEEDED',stockStatus:'FAILED',publicationStatus:'REJECTED',errors:['DESCRIPTION_DECLINE']});
 await x.ports.submitListing({...data,retryAttempt:1,retrySkus:['a'],deferImport:true});
 const result=await x.ports.readSubmission({accountId:'account',submissionId:accepted.submissionId});
 assert.equal(result.items[0].stockStatus,'COMPLETED');assert.equal(result.items[0].imageRepair.status,'SENT');
 assert.deepEqual(x.calls.filter(c=>c.path==='/v2/product/pictures/import').map(c=>c.body.items.map(i=>i.offer_id)),[['a']]);
 assert.equal(x.calls.some(c=>c.path==='/v2/products/stocks'||c.path==='/v3/product/import'),false);
});

test('retry of completed stock with an uncertain picture update only queries the original picture request',async()=>{
 let pictures=0;const x=setup((path,body)=>{
  if(path==='/v3/product/info/list')return {items:body.offer_id.map(offer_id=>({offer_id,id:1,statuses:{status:'price_sent',is_created:true},errors:[{code:'some_image_failed',level:'ERROR_LEVEL_WARNING'}]}))};
  if(path==='/v2/product/pictures/import'){pictures++;throw new Error('response lost');}
  if(path==='/v2/product/pictures/info')return {items:[{product_id:1,photo:[],errors:[]}]};assert.fail(path);
 });
 const data=input(),accepted=await x.ports.submitListing({...data,deferImport:true}),body=x.row().body;body.attempts[0].status='DONE';body.status='FAILED';
 Object.assign(body.results[0],{productId:'1',importStatus:'SUCCEEDED',stockStatus:'COMPLETED',publicationWarnings:['some_image_failed']});body.stocks[0].completed=true;
 Object.assign(body.results[1],{productId:'2',importStatus:'SUCCEEDED',stockStatus:'FAILED',publicationStatus:'REJECTED',errors:['DESCRIPTION_DECLINE']});
 await x.ports.submitListing({...data,retryAttempt:1,retrySkus:['a'],deferImport:true});
 const read=()=>x.ports.readSubmission({accountId:'account',submissionId:accepted.submissionId});assert.equal((await read()).status,'UNCERTAIN');
 const repair=structuredClone(x.row().body.results[0].imageRepair);
 await x.ports.submitListing({...data,retryAttempt:2,retrySkus:['a'],deferImport:true});assert.equal((await read()).status,'UNCERTAIN');
 assert.equal(pictures,1);assert.deepEqual(x.row().body.results[0].imageRepair,repair);assert.equal(x.row().body.results[0].stockStatus,'COMPLETED');
});

test('selected recovery never writes an unselected pending SKU',async()=>{
 const x=setup((path,body)=>{if(path==='/v3/product/info/list')return {items:body.offer_id.map(offer_id=>({offer_id,id:11,statuses:{status:'price_sent',is_created:true}}))};
  if(path==='/v2/products/stocks')return {result:body.stocks.map(stock=>({...stock,updated:true,errors:[]}))};assert.fail(path);});
 const data=input(),accepted=await x.ports.submitListing({...data,deferImport:true});const body=x.row().body;body.attempts[0].status='DONE';
 body.results.forEach(r=>Object.assign(r,{productId:'11',importStatus:'SUCCEEDED',stockStatus:'PENDING'}));
 body.results[0].stockStatus='FAILED';body.results[0].errors=['PRODUCT_IS_NOT_CREATED'];const pending=structuredClone(body.results[1]);
 await x.ports.submitListing({...data,retryAttempt:1,retrySkus:['a'],deferImport:true});
 const result=await x.ports.readSubmission({accountId:'account',submissionId:accepted.submissionId});
 assert.equal(result.status,'FAILED');assert.deepEqual(result.items[1],pending);
 assert.deepEqual(x.calls.filter(c=>c.path==='/v2/products/stocks').flatMap(c=>c.body.stocks.map(row=>row.offer_id)),['a']);
});

test('selected stock recovery cannot send an unselected WAITING import attempt',async()=>{
 const x=setup((path,body)=>{if(path==='/v3/product/info/list')return {items:body.offer_id.map(offer_id=>({offer_id,id:11,statuses:{status:'price_sent',is_created:true}}))};
  if(path==='/v2/products/stocks')return {result:body.stocks.map(stock=>({...stock,updated:true,errors:[]}))};assert.fail(`unselected import: ${path}`);});
 const data=input(),accepted=await x.ports.submitListing({...data,deferImport:true});const body=x.row().body;
 body.attempts[0].offerIds=['b'];Object.assign(body.results[0],{productId:'11',importStatus:'SUCCEEDED',stockStatus:'FAILED',errors:['PRODUCT_IS_NOT_CREATED']});
 await x.ports.submitListing({...data,retryAttempt:1,retrySkus:['a'],deferImport:true});
 const result=await x.ports.readSubmission({accountId:'account',submissionId:accepted.submissionId});
 assert.equal(result.items[0].stockStatus,'COMPLETED');assert.equal(result.status,'FAILED');assert.equal(x.calls.some(c=>c.path==='/v3/product/import'),false);
});

test('a later all-SKU retry clears recovery scope and sends only previously unsent original imports',async()=>{
 const imports=[];const x=setup((path,body)=>{
  if(path==='/v3/product/info/list')return {items:body.offer_id.map(offer_id=>({offer_id,id:11,statuses:{status:'price_sent',is_created:true}}))};
  if(path==='/v2/products/stocks')return {result:body.stocks.map(stock=>({...stock,updated:true,errors:[]}))};
  if(path==='/v3/product/import'){imports.push(body.items.map(item=>item.offer_id));return {result:{task_id:22}};}
  if(path==='/v1/product/import/info')return {result:{items:[{offer_id:'b',product_id:11,status:'imported',errors:[]}]}};assert.fail(path);
 });
 const data=input(),accepted=await x.ports.submitListing({...data,deferImport:true});const body=x.row().body;
 body.attempts[0].offerIds=['b'];Object.assign(body.results[0],{productId:'11',importStatus:'SUCCEEDED',stockStatus:'FAILED',errors:['PRODUCT_IS_NOT_CREATED']});
 const read=()=>x.ports.readSubmission({accountId:'account',submissionId:accepted.submissionId});
 await x.ports.submitListing({...data,retryAttempt:1,retrySkus:['a'],deferImport:true});assert.equal((await read()).status,'FAILED');
 await x.ports.submitListing({...data,retryAttempt:2});const result=await read();assert.equal(result.status,'COMPLETED');
 assert.deepEqual(imports,[['b']]);assert.equal(x.row().body.recoverySkus,undefined);
 assert.equal(x.calls.filter(c=>c.path==='/v2/products/stocks').flatMap(c=>c.body.stocks).filter(s=>s.offer_id==='a').length,1);
});

test('a stock PRODUCT_IS_NOT_CREATED reply waits for creation instead of abandoning the item',async()=>{
 let written=0;const x=setup((path,body)=>{
  if(path==='/v3/product/import')return {result:{task_id:1}};
  if(path==='/v1/product/import/info')return {result:{items:['a','b'].map(offer_id=>({offer_id,product_id:11,status:'imported',errors:[]}))}};
  if(path==='/v3/product/info/list')return {items:body.offer_id.map(offer_id=>({offer_id,id:11,statuses:{status:'price_sent',is_created:true,moderate_status:'approved'}}))};
  if(path==='/v2/products/stocks')return {result:body.stocks.map(stock=>({...stock,updated:written++>0,errors:written===1?[{code:'PRODUCT_IS_NOT_CREATED'}]:[]}))};assert.fail(path);
 });
 const accepted=await x.ports.submitListing(input()),read=()=>x.ports.readSubmission({accountId:'account',submissionId:accepted.submissionId});
 const first=await read();assert.equal(first.status,'SUBMITTED');assert.equal(first.items[0].stockStatus,'PENDING');
 x.advance(60000);assert.equal((await read()).items[0].stockStatus,'COMPLETED');
 assert.equal(x.calls.filter(c=>c.path==='/v3/product/import').length,1);
});

test('an unchanged accepted import becomes query-only after 30 minutes without creating a second request',async()=>{
 let imports=0;const x=setup((path)=>{if(path==='/v3/product/import'){imports++;return {result:{task_id:1}};}if(path==='/v3/product/info/list')return {items:[]};
  if(path==='/v1/product/import/info')return {result:{items:['a','b'].map(offer_id=>({offer_id,status:'pending',errors:[]}))}};assert.fail(path);});
 const data=input(),accepted=await x.ports.submitListing(data),read=()=>x.ports.readSubmission({accountId:'account',submissionId:accepted.submissionId});
 assert.equal((await read()).status,'SUBMITTED');x.advance(30*60_000);const waiting=await read();assert.equal(waiting.status,'UNCERTAIN');
 assert.equal(waiting.items[0].importStatus,'UNKNOWN');await x.ports.submitListing({...data,retryAttempt:1});await read();assert.equal(imports,1);
});

for (const deferImport of [false, true]) test(`explicit retry appends only a newly recovered SKU to a completed journal, deferred=${deferImport}`, async () => {
 const imports=[];const prepared=[];
 const x=setup((path,body)=>{
  if(path==='/v3/product/import'){imports.push(body.items.map(item=>item.offer_id));return {result:{task_id:imports.length}};}
  if(path==='/v1/product/import/info')return {result:{items:imports[body.task_id-1].map(offer_id=>({offer_id,product_id:offer_id==='a'?1:2,status:'imported',errors:[]}))}};
  if(path==='/v3/product/info/list')return {items:body.offer_id.map(offer_id=>({offer_id,id:offer_id==='a'?1:2,statuses:{status:'price_sent'}}))};
  if(path==='/v2/products/stocks')return {result:body.stocks.map(stock=>({...stock,updated:true,errors:[]}))};
  assert.fail(path);
 },{prepareMedia:async({items})=>{prepared.push(items.map(item=>item.offer_id));return items;}});
 const data=input(),first={...data,source:{...data.source,items:data.source.items.slice(0,1)},images:data.images.slice(0,1)};
 const accepted=await x.ports.submitListing(first);
 const read=()=>x.ports.readSubmission({accountId:data.accountId,submissionId:accepted.submissionId});
 assert.equal((await read()).status,'COMPLETED');
 const oldItem=structuredClone(x.row().body.items[0]);
 const oldResult=structuredClone(x.row().body.results[0]);
 const oldStock=structuredClone(x.row().body.stocks[0]);
 // An already-published SKU is not prepared again, even if its current input is incomplete.
 data.images=data.images.filter(image=>image.sku==='b');
 data.source.items[0].listingItem.name='must not change published a';
 data.config.priceMultiplier='2';
 data.config.stock=99;
 const retry={...data,retryAttempt:1,deferImport};
 assert.equal((await x.ports.submitListing(retry)).submissionId,accepted.submissionId);
 assert.deepEqual(prepared,[['a'],['b']]);
 assert.equal(x.row().body.results.length,2);
 assert.deepEqual(x.row().body.items[0],oldItem);assert.deepEqual(x.row().body.results[0],oldResult);assert.deepEqual(x.row().body.stocks[0],oldStock);
 assert.equal(x.row().body.items[1].price,'40.00');
 assert.equal(x.row().body.stocks[1].stock,5,'new SKU retains the submission stock configuration');
 if(deferImport){assert.equal(imports.length,1);assert.equal(x.row().body.status,'PREPARED');}
 await x.ports.submitListing(retry);
 let result=await read();
 if(result.status==='SUBMITTED')result=await read();
 assert.equal(result.status,'COMPLETED');
 await x.ports.submitListing(retry);
 assert.deepEqual(imports,[['a'],['b']]);
 assert.deepEqual(prepared,[['a'],['b']]);
 assert.deepEqual(x.calls.filter(call=>call.path==='/v2/products/stocks').map(call=>call.body.stocks.map(stock=>stock.offer_id)),[['a'],['b']]);
});

for(const stage of ['WAITING','IMPORTING','ACCEPTED','UNCERTAIN'])test(`recovered SKUs wait while the existing journal is ${stage}`,async()=>{
 let preparations=0;const x=setup(()=>assert.fail('deferred work must not call Seller'),{prepareMedia:async({items})=>{preparations++;return items;}});
 const data=input(),first={...data,deferImport:true,source:{...data.source,items:data.source.items.slice(0,1)},images:data.images.slice(0,1)};
 await x.ports.submitListing(first);x.row().body.attempts[0].status=stage;
 await x.ports.submitListing({...data,deferImport:true,retryAttempt:1});
 assert.deepEqual(x.row().body.results.map(result=>result.sku),['a']);
 assert.equal(x.row().body.retryAttempt,0);assert.equal(preparations,1);
 assert.equal(x.calls.length,0);
});

test('a recovered SKU can be appended while an omitted failed SKU keeps its failure journal',async()=>{
 const imports=[];let corrected=false;
 const x=setup((path,body)=>{
  if(path==='/v3/product/import'){imports.push(body.items.map(item=>item.offer_id));return {result:{task_id:imports.length}};}
  if(path==='/v1/product/import/info')return {result:{items:imports[body.task_id-1].map(offer_id=>({offer_id,...(offer_id==='a'&&!corrected?{}:{product_id:offer_id==='a'?1:2}),status:offer_id==='a'&&!corrected?'failed':'imported',errors:offer_id==='a'&&!corrected?[{code:'ATTRIBUTE_INVALID',level:'error'}]:[]}))}};
  if(path==='/v3/product/info/list')return {items:body.offer_id.map(offer_id=>({offer_id,id:offer_id==='a'?1:2,statuses:{status:'price_sent'}}))};
  if(path==='/v2/products/stocks')return {result:body.stocks.map(stock=>({...stock,updated:true,errors:[]}))};
  assert.fail(path);
 });
 const data=input(),selected=sku=>({...data,source:{...data.source,items:data.source.items.filter(group=>group.sku===sku)},images:data.images.filter(image=>image.sku===sku)});
 const accepted=await x.ports.submitListing(selected('a')),read=()=>x.ports.readSubmission({accountId:data.accountId,submissionId:accepted.submissionId});
 assert.equal((await read()).status,'FAILED');
 const failed=structuredClone(x.row().body.results[0]);
 await x.ports.submitListing({...selected('b'),retryAttempt:1});
 let result=await read();assert.equal(result.status,'FAILED');
 assert.deepEqual(result.items.find(item=>item.sku==='a'),failed);
 assert.equal(result.items.find(item=>item.sku==='b').stockStatus,'COMPLETED');
 corrected=true;await x.ports.submitListing({...selected('a'),retryAttempt:2});
 result=await read();assert.equal(result.status,'COMPLETED');
 assert.deepEqual(imports,[['a'],['b'],['a']]);
});

for(const change of ['offer','sku'])test(`explicit retry cannot change the existing ${change} identity`,async()=>{
 const x=setup((path,body)=>{
  if(path==='/v3/product/import')return {result:{task_id:1}};
  if(path==='/v1/product/import/info')return {result:{items:[{offer_id:'a',product_id:1,status:'imported',errors:[]}]}};
  if(path==='/v3/product/info/list')return {items:body.offer_id.map(offer_id=>({offer_id,id:1,statuses:{status:'price_sent'}}))};
  if(path==='/v2/products/stocks')return {result:body.stocks.map(stock=>({...stock,updated:true,errors:[]}))};
  assert.fail(path);
 });
 const data=input();data.source.items=data.source.items.slice(0,1);data.images=data.images.slice(0,1);
 const accepted=await x.ports.submitListing(data);
 await x.ports.readSubmission({accountId:data.accountId,submissionId:accepted.submissionId});
 const before=structuredClone(x.row().body);
 if(change==='offer')data.source.items[0].listingItem.offer_id='changed-offer';else data.source.items[0].sku='changed-sku';
 await assert.rejects(x.ports.submitListing({...data,deferImport:true,retryAttempt:1}),{code:'AI_LISTING_SUBMISSION_IDENTITY_MISMATCH'});
 assert.deepEqual(x.row().body,before);
 assert.equal(x.calls.filter(call=>call.path==='/v3/product/import').length,1);
});

test('appending a recovered SKU does not retry an omitted SKU stock failure',async()=>{
 const imports=[];
 const x=setup((path,body)=>{
  if(path==='/v3/product/import'){imports.push(body.items.map(item=>item.offer_id));return {result:{task_id:imports.length}};}
  if(path==='/v1/product/import/info')return {result:{items:imports[body.task_id-1].map(offer_id=>({offer_id,product_id:offer_id==='a'?1:2,status:'imported',errors:[]}))}};
  if(path==='/v3/product/info/list')return {items:body.offer_id.map(offer_id=>({offer_id,id:offer_id==='a'?1:2,statuses:{status:'price_sent'}}))};
  if(path==='/v2/products/stocks')return {result:body.stocks.map(stock=>({...stock,updated:stock.offer_id!=='a',errors:stock.offer_id==='a'?[{code:'WAREHOUSE_INVALID'}]:[]}))};
  assert.fail(path);
 });
 const data=input(),selected=sku=>({...data,source:{...data.source,items:data.source.items.filter(group=>group.sku===sku)},images:data.images.filter(image=>image.sku===sku)});
 const accepted=await x.ports.submitListing(selected('a')),read=()=>x.ports.readSubmission({accountId:data.accountId,submissionId:accepted.submissionId});
 assert.equal((await read()).status,'FAILED');
 const failed=structuredClone(x.row().body.results[0]);
 await x.ports.submitListing({...selected('b'),retryAttempt:1});await read();
 assert.deepEqual(x.row().body.results[0],failed);
 assert.deepEqual(x.calls.filter(call=>call.path==='/v2/products/stocks').map(call=>call.body.stocks.map(stock=>stock.offer_id)),[['a'],['b']]);
});

test('pause during media preparation propagates the saved control and makes no import',async()=>{
 const stop=Object.assign(new Error('paused'),{code:'AI_LISTING_TASK_CONTROL_REQUESTED'});let checks=0;
 const x=setup(()=>{throw Error('external write not expected');},{prepareMedia:async({checkControl,items})=>{await checkControl();return items;}});
 await assert.rejects(x.ports.submitListing({...input(),checkControl:async()=>{if(++checks>=2)throw stop;}}),e=>e===stop);
 assert.equal(x.row(),undefined);assert.equal(x.calls.length,0);
});
test('last pre-write pause leaves a resumable WAITING journal, never an uncertain import',async()=>{
 const stop=Object.assign(new Error('paused'),{code:'AI_LISTING_TASK_CONTROL_REQUESTED'});
 const x=setup(path=>path==='/v3/product/import'?{result:{task_id:1}}:{items:[]});
 await assert.rejects(x.ports.submitListing({...input(),beforeExternalWrite:async()=>{throw stop;}}),e=>e===stop);
 assert.equal(x.row().body.attempts[0].status,'WAITING');assert.equal(x.calls.filter(c=>c.path==='/v3/product/import').length,0);
 await x.ports.submitListing(input());assert.equal(x.calls.filter(c=>c.path==='/v3/product/import').length,1);
});
test('recovery stock write observes lease fence and preserves pending stock for next owner',async()=>{
 const x=setup((path,body)=>path==='/v3/product/import'?{result:{task_id:1}}:path==='/v1/product/import/info'
  ?{result:{items:['a','b'].map(offer_id=>({offer_id,product_id:1,status:'imported',errors:[]}))}}
  :{items:body.offer_id.map(offer_id=>({offer_id,id:1,statuses:{status:'price_sent'}}))});
 const submitted=await x.ports.submitListing(input());
 await assert.rejects(x.ports.readSubmission({accountId:'account',submissionId:submitted.submissionId,
  beforeExternalWrite:async()=>{throw Object.assign(new Error('lease lost'),{code:'AI_LISTING_LEASE_LOST'});}}),{code:'AI_LISTING_LEASE_LOST'});
 assert.equal(x.calls.filter(c=>c.path==='/v2/products/stocks').length,0);
 assert.equal(x.row().body.results[0].stockStatus,'PENDING');assert.equal(x.row().body.stockRequest,undefined);
});

test('a missing prepared media file prevents an incomplete import and leaves generated sources intact',async()=>{
 const data=input(),before=structuredClone(data);
 const x=setup(path=>path==='/v3/product/import'?{result:{task_id:1}}:{items:[]},{prepareMedia:async()=>{throw Object.assign(new Error('a 第 3 张图片读取失败'),{code:'AI_LISTING_MEDIA_PREPARATION_FAILED'});}});
 await assert.rejects(x.ports.submitListing(data),error=>error.code==='AI_LISTING_MEDIA_PREPARATION_FAILED'&&error.definitelyNotSubmitted===true);
 assert.equal(x.calls.filter(call=>call.path==='/v3/product/import').length,0);
 assert.equal(x.row(),undefined);assert.deepEqual(data,before);
});

test('complete prepared media is frozen once and a received import is not prepared or submitted twice',async()=>{
 let prepared=0;
 const x=setup(path=>path==='/v3/product/import'?{result:{task_id:1}}:path==='/v1/product/import/info'?{result:{items:[]}}:{items:[]},{prepareMedia:async({accountId,taskId,items})=>{
  assert.equal(accountId,'account');assert.equal(taskId,'task');prepared++;
  return items.map(item=>({...item,images:['https://files.test/'+item.offer_id+'.jpg']}));
 }});
 const data=input();await x.ports.submitListing(data);await x.ports.submitListing(data);
 const imports=x.calls.filter(call=>call.path==='/v3/product/import');
 assert.equal(prepared,1);assert.equal(imports.length,1);
 assert.deepEqual(imports[0].body.items.map(item=>item.images),[['https://files.test/a.jpg'],['https://files.test/b.jpg']]);
 assert.deepEqual(x.row().body.items,imports[0].body.items);
});
test('frozen category survives deleted source; partial success stocks only successful item and explicit retry imports only failed SKU',async()=>{let attempts=0;const x=setup((path,body)=>{if(path==='/v3/product/import'){attempts++;return {result:{task_id:attempts}};}if(path==='/v1/product/import/info')return {result:{items:attempts===1?[{offer_id:'a',product_id:1,status:'imported',errors:[]},{offer_id:'b',status:'failed',errors:[{code:'ATTRIBUTE_INVALID',level:'error'}]}]:[{offer_id:'b',product_id:2,status:'imported',errors:[]}]}};if(path==='/v3/product/info/list')return {items:body.offer_id.map((offer_id,i)=>({offer_id,id:i+1,statuses:{status:'price_sent'}}))};if(path==='/v2/products/stocks')return {result:body.stocks.map(s=>({...s,updated:true,errors:[]}))};throw Error(path);});const data=input();const accepted=await x.ports.submitListing(data);let result=await x.ports.readSubmission({accountId:data.accountId,submissionId:accepted.submissionId});assert.equal(result.status,'FAILED');assert.equal(result.items.find(i=>i.sku==='a').stockStatus,'COMPLETED');assert.deepEqual(x.calls.filter(c=>c.path==='/v2/products/stocks').map(c=>c.body.stocks.map(s=>s.offer_id)),[['a']]);await x.ports.submitListing({...data,retryAttempt:1});assert.equal((await x.ports.readSubmission({accountId:data.accountId,submissionId:accepted.submissionId})).status,'COMPLETED');assert.deepEqual(x.calls.filter(c=>c.path==='/v3/product/import').map(c=>c.body.items.map(i=>i.offer_id)),[['a','b'],['b']]);await x.ports.submitListing({...data,retryAttempt:1});assert.equal(attempts,2);});
test('429 waits and retries same frozen items; timeout reconciles but does not re-import missing offers',async()=>{let imports=0;const x=setup(path=>{if(path==='/v3/product/import'){imports++;throw Object.assign(Error('rejected'),{status:429,code:'ZONGZI_HTTP_429'});}if(path==='/v3/product/info/list')return {items:[]};throw Error(path);});const data=input();const accepted=await x.ports.submitListing(data);assert.equal(imports,1);assert.equal((await x.ports.readSubmission({accountId:data.accountId,submissionId:accepted.submissionId})).status,'SUBMITTED');assert.equal(imports,1);x.advance(60000);await x.ports.readSubmission({accountId:data.accountId,submissionId:accepted.submissionId});assert.equal(imports,2);
let ambiguousCalls=0;const y=setup(path=>{if(path==='/v3/product/import'){ambiguousCalls++;throw Error('socket timeout');}if(path==='/v3/product/info/list')return {items:[]};throw Error(path);});const uncertain=await y.ports.submitListing(data);await y.ports.submitListing({...data,retryAttempt:1});const r=await y.ports.readSubmission({accountId:data.accountId,submissionId:uncertain.submissionId});assert.equal(r.status,'UNCERTAIN');assert.equal(ambiguousCalls,1);});
test('price not ready waits; ready SKUs sent together and per-item stock error preserves completed pair',async()=>{let ready=false;const x=setup((path,body)=>{if(path==='/v3/product/import')return {result:{task_id:1}};if(path==='/v1/product/import/info')return {result:{items:['a','b'].map((offer_id,i)=>({offer_id,product_id:i+1,status:'imported',errors:[]}))}};if(path==='/v3/product/info/list')return {items:body.offer_id.map(offer_id=>({offer_id,id:1,statuses:{status:ready?'price_sent':'imported'}}))};if(path==='/v2/products/stocks')return {result:body.stocks.map(s=>({...s,updated:s.offer_id==='a',errors:s.offer_id==='a'?[]:[{code:'TOO_MANY_REQUESTS'}]}))};});const data=input(),accepted=await x.ports.submitListing(data);assert.equal((await x.ports.readSubmission({accountId:data.accountId,submissionId:accepted.submissionId})).status,'SUBMITTED');assert.equal(x.calls.filter(c=>c.path==='/v2/products/stocks').length,0);ready=true;x.advance(60000);const r=await x.ports.readSubmission({accountId:data.accountId,submissionId:accepted.submissionId});assert.equal(r.status,'SUBMITTED');assert.equal(r.items[0].stockStatus,'COMPLETED');assert.equal(r.items[1].stockStatus,'PENDING');assert.equal(x.calls.filter(c=>c.path==='/v2/products/stocks')[0].body.stocks.length,2);});

test('moderation rejection ends waiting, retains import fact and only corrected SKU is explicitly reimported',async()=>{
 let attempts=0;let repaired=false;
 const declined={status:'variant_wait',status_failed:'declined',moderate_status:'declined',is_created:false,status_updated_at:'2026-09-09T20:28:30.586124Z'};
 const x=setup((path,body)=>{
  if(path==='/v3/product/import'){attempts++;return {result:{task_id:attempts}};}
  if(path==='/v1/product/import/info')return {result:{items:(attempts===1?['a','b']:['b']).map((offer_id,i)=>({offer_id,product_id:i+1,status:'imported',errors:[]}))}};
  if(path==='/v3/product/info/list')return {items:body.offer_id.map(offer_id=>({offer_id,id:2,statuses:offer_id==='b'&&!repaired?declined:{status:'price_sent'},errors:offer_id==='b'&&!repaired?[{code:'DESCRIPTION_DECLINE',field:'description',attribute_id:11254,level:'ERROR_LEVEL_ERROR'}]:[]}))};
  if(path==='/v2/products/stocks')return {result:body.stocks.map(s=>({...s,updated:true,errors:[]}))};
 });
 const data=input(),accepted=await x.ports.submitListing(data);const read=()=>x.ports.readSubmission({accountId:data.accountId,submissionId:accepted.submissionId});
 const result=await read();assert.equal(result.status,'FAILED');const rejected=result.items.find(i=>i.sku==='b');assert.equal(rejected.importStatus,'SUCCEEDED');assert.equal(rejected.publicationStatus,'REJECTED');assert.match(rejected.failureReason,/富内容.*11254/);assert.equal(result.items[0].stockStatus,'COMPLETED');
 x.advance(60000);await read();assert.equal(attempts,1);assert.equal(x.calls.filter(c=>c.path==='/v2/products/stocks').length,1);
 data.source.items[1].listingItem.description='user corrected content';await x.ports.submitListing({...data,retryAttempt:1});
 assert.equal((await read()).status,'SUBMITTED','unchanged old declined timestamp is not the new update outcome');repaired=true;x.advance(60000);assert.equal((await read()).status,'COMPLETED');
 assert.deepEqual(x.calls.filter(c=>c.path==='/v3/product/import').map(c=>c.body.items.map(i=>i.offer_id)),[['a','b'],['b']]);assert.equal(x.row().body.attempts[0].ozonTaskId,'1');
});
test('ordinary moderation pending with warning is still temporary and sends no stock',async()=>{
 const x=setup((path,body)=>path==='/v3/product/import'?{result:{task_id:1}}:path==='/v1/product/import/info'?{result:{items:['a','b'].map(offer_id=>({offer_id,product_id:1,status:'imported',errors:[]}))}}:{items:body.offer_id.map(offer_id=>({offer_id,id:1,statuses:{status:'variant_wait',moderate_status:'pending',is_created:false},errors:[{code:'DESCRIPTION_DECLINE',level:'ERROR_LEVEL_WARNING'}]}))});
 const data=input(),accepted=await x.ports.submitListing(data),result=await x.ports.readSubmission({accountId:data.accountId,submissionId:accepted.submissionId});assert.equal(result.status,'SUBMITTED');assert.equal(x.calls.filter(c=>c.path==='/v2/products/stocks').length,0);
});

test('unchanged prior rejection still waits after 90 seconds; only a new declined timestamp fails',async()=>{
 let attempts=0;let timestamp='2026-09-09T20:28:30Z';const x=setup((path,body)=>{
  if(path==='/v3/product/import')return {result:{task_id:++attempts}};
  if(path==='/v1/product/import/info')return {result:{items:['a','b'].map(offer_id=>({offer_id,product_id:1,status:'imported',errors:[]}))}};
  return {items:body.offer_id.map(offer_id=>({offer_id,id:1,statuses:{status:'variant_wait',is_created:false,moderate_status:'declined',status_updated_at:timestamp},errors:[{code:'DESCRIPTION_DECLINE',attribute_id:11254}]}))};
 });
 const data=input(),accepted=await x.ports.submitListing(data),read=()=>x.ports.readSubmission({accountId:data.accountId,submissionId:accepted.submissionId});assert.equal((await read()).status,'FAILED');
 await x.ports.submitListing({...data,retryAttempt:1});assert.equal((await read()).status,'SUBMITTED');x.advance(90000);const waiting=await read();assert.equal(waiting.status,'SUBMITTED');assert.match(waiting.items[0].statusMessage,/资料修正已提交.*等待 Ozon 更新审核结果/);assert.equal(attempts,2);
 timestamp='2026-09-10T00:28:30Z';x.advance(60000);assert.equal((await read()).status,'FAILED');assert.equal(attempts,2);
});

test('image read timeouts remain visible after successful product import and stock write',async()=>{
 const warnings=[{code:'primary_image_load_failed',level:'ERROR_LEVEL_WARNING'}, {code:'pics_reading_timeout',level:'ERROR_LEVEL_WARNING'}, {code:'some_image_failed',level:'ERROR_LEVEL_WARNING'}];
 const x=setup((path,body)=>{
  if(path==='/v3/product/import')return {result:{task_id:1}};
  if(path==='/v1/product/import/info')return {result:{items:['a','b'].map(offer_id=>({offer_id,product_id:1,status:'imported',errors:[]}))}};
  if(path==='/v3/product/info/list')return {items:body.offer_id.map(offer_id=>({offer_id,id:1,statuses:{status:'price_sent'},errors:offer_id==='a'?warnings:[]}))};
  if(path==='/v2/products/stocks')return {result:body.stocks.map(s=>({...s,updated:true,errors:[]}))};
 });
 const data=input(),accepted=await x.ports.submitListing(data);
 const result=await x.ports.readSubmission({accountId:data.accountId,submissionId:accepted.submissionId});
 assert.equal(result.status,'COMPLETED');
 assert.deepEqual(result.items[0].publicationWarnings,['primary_image_load_failed','pics_reading_timeout','some_image_failed']);
 assert.match(result.items[0].warningMessage,/图片.*超时/);
 assert.equal(result.items[0].stockStatus,'COMPLETED');
 assert.equal(result.items[1].warningMessage,undefined);
 const reads=x.calls.length;
 const cached=await x.ports.readSubmission({accountId:data.accountId,submissionId:accepted.submissionId});
 assert.deepEqual(cached.items[0].publicationWarnings,result.items[0].publicationWarnings);
 assert.equal(x.calls.length,reads,'viewing a completed submission does not repeat external writes or reads');
});

test('successful publication retains separate attribute warning details even when their codes are identical', async () => {
 const warnings = [
  {code:'warning_attribute_values_out_of_range',level:'ERROR_LEVEL_WARNING',attribute_id:10175,field:'attributes',texts:{attribute_name:'Глубина',description:'Значение вне диапазона',hint:'Проверьте размер'}},
  {code:'warning_attribute_values_out_of_range',level:'ERROR_LEVEL_WARNING',attribute_id:10176,message:'Проверьте ширину'},
 ];
 const x=setup((path,body)=>{
  if(path==='/v3/product/import')return {result:{task_id:1}};
  if(path==='/v1/product/import/info')return {result:{items:['a','b'].map(offer_id=>({offer_id,product_id:1,status:'imported',errors:[]}))}};
  if(path==='/v3/product/info/list')return {items:body.offer_id.map(offer_id=>({offer_id,id:1,statuses:{status:'price_sent'},errors:offer_id==='a'?warnings:[]}))};
  if(path==='/v2/products/stocks')return {result:body.stocks.map(s=>({...s,updated:true,errors:[]}))};
 });
 const data=input(),accepted=await x.ports.submitListing(data);
 const result=await x.ports.readSubmission({accountId:data.accountId,submissionId:accepted.submissionId});
 assert.equal(result.status,'COMPLETED');
 assert.deepEqual(result.items[0].publicationWarnings,['warning_attribute_values_out_of_range']);
 assert.deepEqual(result.items[0].publicationWarningDetails,warnings);
 assert.equal(result.items[1].publicationWarningDetails,undefined);
 assert.deepEqual(x.row().body.results[0].publicationWarningDetails,warnings);
 const calls=x.calls.length;
 const reread=await x.ports.readSubmission({accountId:data.accountId,submissionId:accepted.submissionId});
 assert.deepEqual(reread.items[0].publicationWarningDetails,warnings);
 assert.equal(x.calls.length,calls,'completed reads keep existing details without external calls');
});

test('explicit picture delivery failure ends waiting and retry repairs only that product with its full saved gallery',async()=>{
 let repaired=false;let uploads=0;
 const failedStatus={status:'offer_validated',status_failed:'pics_delivered',moderate_status:'',is_created:false,status_updated_at:'2026-09-16T08:57:45Z'};
 const x=setup((path,body)=>{
  if(path==='/v3/product/import')return {result:{task_id:1}};
  if(path==='/v1/product/import/info'&&body.task_id===99)return {result:{items:[{offer_id:'b',product_id:2,status:'imported',errors:[]}]}};
  if(path==='/v1/product/import/info')return {result:{items:['a','b'].map((offer_id,i)=>({offer_id,product_id:i+1,status:'imported',errors:[]}))}};
  if(path==='/v3/product/info/list')return {items:body.offer_id.map((offer_id)=>({offer_id,id:offer_id==='a'?1:2,
   statuses:offer_id==='b'&&!repaired?failedStatus:{status:'price_sent',is_created:true},
   images360:[],color_image:[],errors:offer_id==='b'&&!repaired?[{code:'pics_reading_timeout',level:'ERROR_LEVEL_WARNING'},{code:'all_image_failed',level:'ERROR_LEVEL_ERROR'}]:[]}))};
  if(path==='/v2/product/pictures/import'){uploads++;return {task_id:99};}
  if(path==='/v2/product/pictures/info')return {items:[{product_id:2,photo:x.calls.find(c=>c.path==='/v2/product/pictures/import').body.items[0].images,errors:repaired?[]:[{url:'https://old.test/image',message:'old timeout'}]}]};
  if(path==='/v2/products/stocks')return {result:body.stocks.map(stock=>({...stock,updated:true,errors:[]}))};
  assert.fail(path);
 });
 const data=input();data.source.items[1].images.push('https://source.test/b2');data.images.push({sku:'b',index:1,generatedUrl:'https://generated.test/b2'});
 data.source.items[1].listingItem.color_image='https://source.test/swatch.jpg';
 const accepted=await x.ports.submitListing(data),read=()=>x.ports.readSubmission({accountId:data.accountId,submissionId:accepted.submissionId});
 const failed=await read();assert.equal(failed.status,'FAILED');assert.equal(failed.submissionStage,'image_failed');
 assert.equal(failed.items[1].publicationStatus,'IMAGE_FAILED');assert.match(failed.items[1].failureReason,/图片接收失败/);
 assert.equal(failed.items[0].stockStatus,'COMPLETED');assert.equal(failed.items[1].importStatus,'SUCCEEDED');
 const frozen=structuredClone(x.row().body.items),successful=structuredClone(failed.items[0]);
 await x.ports.submitListing({...data,retryAttempt:1,deferImport:true});assert.equal(uploads,0,'media preparation cannot send the repair');
 let fence=0;const waiting=await x.ports.readSubmission({accountId:data.accountId,submissionId:accepted.submissionId,beforeExternalWrite:()=>{fence++;}});
 assert.equal(fence,1);assert.equal(waiting.status,'SUBMITTED');assert.equal(waiting.submissionStage,'repairing_images');assert.equal(uploads,1);
 assert.deepEqual(waiting.items[0],successful);assert.deepEqual(x.row().body.items,frozen);
 const request=x.calls.find(c=>c.path==='/v2/product/pictures/import').body;
 assert.equal(request.items.length,1);assert.equal(request.items[0].offer_id,'b');
 const original=url=>{const u=new URL(url);u.searchParams.delete('_ozon_image_retry');return u.href;};
 assert.deepEqual(request.items[0].images.map(original),frozen[1].images);assert.equal(original(request.items[0].color_image),frozen[1].color_image);
 await x.ports.submitListing({...data,retryAttempt:1});x.advance(60000);assert.equal((await read()).status,'SUBMITTED');assert.equal(uploads,1,'old failed status must not trigger another repair');
 repaired=true;x.advance(60000);assert.equal((await read()).status,'COMPLETED');
 assert.equal(x.calls.filter(c=>c.path==='/v3/product/import').length,1,'never reimport the product');
 assert.deepEqual(x.calls.filter(c=>c.path==='/v2/products/stocks').map(c=>c.body.stocks.map(s=>s.offer_id)),[['a'],['b']]);
 assert.deepEqual(x.row().body.items,frozen);assert.equal(uploads,1);
});

for(const mode of ['timeout','restart','fence','unchanged','changed','rate-limit','identity','healthy-identity','identity-recovery','missing-recovery','job-failed','picture-error'])test(`image repair ${mode} preserves request evidence and does not repeat product import`,async()=>{
 let healthy=false,uploads=0,statusAt='2026-09-16T08:57:45Z',wrongIdentity=mode.includes('identity'),missing=false;
 const x=setup((path,body)=>{
  if(path==='/v3/product/import')return {result:{task_id:1}};
  if(path==='/v1/product/import/info'&&body.task_id===99)return {result:{items:[{offer_id:'a',product_id:10,status:mode==='job-failed'?'failed':'imported',errors:mode==='job-failed'?[{code:'IMAGE_DOWNLOAD_FAILED',level:'ERROR_LEVEL_ERROR'}]:[]}]}};
  if(path==='/v1/product/import/info')return {result:{items:[{offer_id:'a',product_id:10,status:'imported',errors:[]}]}};
  if(path==='/v3/product/info/list'&&missing)return {items:[]};
  if(path==='/v3/product/info/list')return {items:[{offer_id:'a',id:wrongIdentity?11:10,images360:['https://remote.test/spin.jpg'],color_image:['https://remote.test/color.jpg'],
   statuses:healthy?{status:'price_sent',is_created:true}:{status:'offer_validated',status_failed:'pics_delivered',is_created:false,status_updated_at:statusAt},
   errors:healthy?[]:[{code:'all_image_failed',level:'ERROR_LEVEL_ERROR'}]}]};
  if(path==='/v2/product/pictures/import'){
   uploads++;assert.equal(body.items[0].images360,undefined);assert.equal(new URL(body.items[0].color_image).pathname,'/color.jpg');
   if(mode==='timeout'||mode==='restart')throw Error('lost response');
   if(mode==='rate-limit'&&uploads===1)throw Object.assign(Error('rate limited'),{status:429,code:'ZONGZI_HTTP_429'});
   return {task_id:99};
  }
  if(path==='/v2/product/pictures/info'){const sent=x.calls.find(c=>c.path==='/v2/product/pictures/import').body.items[0];return {items:[{product_id:10,photo:sent.images,errors:healthy?[]:[{url:mode==='picture-error'?sent.images[0]:'https://old.test/image',message:'timeout'}]}]};}
  if(path==='/v2/products/stocks')return {result:body.stocks.map(stock=>({...stock,updated:true,errors:[]}))};
  assert.fail(path);
 });
 const data=input();data.source.items=data.source.items.slice(0,1);data.images=data.images.slice(0,1);
 const accepted=await x.ports.submitListing(data),request={accountId:data.accountId,submissionId:accepted.submissionId},read=()=>x.ports.readSubmission(request);
 assert.equal((await read()).status,'FAILED');await x.ports.submitListing({...data,retryAttempt:1,deferImport:true});
 if(mode==='missing-recovery')missing=true;
 if(mode==='healthy-identity')healthy=true;
 if(mode==='fence'){
  const lost=Object.assign(Error('lease lost'),{code:'AI_LISTING_LEASE_LOST'});
  await assert.rejects(x.ports.readSubmission({...request,beforeExternalWrite:()=>{throw lost;}}),error=>error===lost);
  assert.equal(uploads,0);assert.equal(x.row().body.results[0].imageRepair.status,'WAITING');
 }
 let result=await read();
 if(wrongIdentity||missing){
  assert.equal(uploads,0);assert.equal(result.status,'FAILED');assert.match(result.items[0].failureReason,/核对原商品/);assert.equal(x.calls.filter(c=>c.path==='/v2/products/stocks').length,0);
  if(!mode.endsWith('recovery'))return;
  wrongIdentity=false;missing=false;await x.ports.submitListing({...data,retryAttempt:2,deferImport:true});result=await read();assert.equal(result.status,'SUBMITTED');
 }
 assert.equal(uploads,1);
 if(mode==='timeout'||mode==='restart'){
  if(mode==='restart')x.row().body.results[0].imageRepair.status='SENDING';
  await x.ports.submitListing({...data,retryAttempt:2});result=await read();
  assert.equal(result.status,'UNCERTAIN');assert.equal(uploads,1);
 }else if(mode==='unchanged'){
  x.advance(20*60_000);result=await read();assert.equal(result.status,'UNCERTAIN');assert.equal(uploads,1);
  await x.ports.submitListing({...data,retryAttempt:2});assert.equal(uploads,1,'elapsed time alone cannot permit another write');
 }else if(mode==='changed'){
  statusAt='2026-09-16T09:30:00Z';x.advance(60000);result=await read();assert.equal(result.status,'SUBMITTED','an unrelated timestamp is not a new image outcome');assert.equal(uploads,1);
 }else if(mode==='job-failed'||mode==='picture-error'){
  result=await read();assert.equal(result.status,'FAILED');assert.equal(uploads,1);return;
 }else if(mode==='rate-limit'){
  await read();assert.equal(uploads,1);x.advance(60000);await read();assert.equal(uploads,2);
 }
 healthy=true;x.advance(60000);assert.equal((await read()).status,'COMPLETED');
 assert.equal(x.calls.filter(c=>c.path==='/v3/product/import').length,1);
 assert.equal(uploads,mode==='rate-limit'?2:1);
});


test('retry refreshes warnings only for failed SKU and never repeats a successful import',async()=>{
 let attempts=0;
 const x=setup((path,body)=>{
  if(path==='/v3/product/import')return {result:{task_id:++attempts}};
  if(path==='/v1/product/import/info')return {result:{items:attempts===1?
    [{offer_id:'a',product_id:1,status:'imported',errors:[]},{offer_id:'b',status:'failed',errors:[{code:'ATTRIBUTE_INVALID',level:'error'}]}]:
    [{offer_id:'b',product_id:2,status:'imported',errors:[]}]}};
  if(path==='/v3/product/info/list')return {items:body.offer_id.map(offer_id=>({offer_id,id:1,statuses:{status:'price_sent'}}))};
  if(path==='/v2/products/stocks')return {result:body.stocks.map(stock=>({...stock,updated:true,errors:[]}))};
  assert.fail(path);
 },{normalizeItems:items=>normalizeOzonImportItems(items,{strictTypeMatch:true,getCategoryAttributes:async()=>[{id:777,name:'Optional value',dictionary_id:700}],getCategoryAttributeValues:async()=>[]})});
 const data=input();for(const group of data.source.items)group.listingItem.attributes=[{id:777,values:[{value:'unmapped-'+group.sku}]}];
 const accepted=await x.ports.submitListing(data);
 const first=await x.ports.readSubmission({accountId:data.accountId,submissionId:accepted.submissionId});
 const originalWarning=first.items.find(item=>item.sku==='a').normalizationWarnings;
 assert.equal(originalWarning.length,1);
 data.source.items[0].listingItem.attributes=[{id:777,values:[{value:'must-not-reprepare-success'}]}];
 data.source.items[1].listingItem.attributes=[];
 await x.ports.submitListing({...data,retryAttempt:1});
 const result=await x.ports.readSubmission({accountId:data.accountId,submissionId:accepted.submissionId});
 assert.equal(result.status,'COMPLETED');
 assert.deepEqual(result.items.find(item=>item.sku==='a').normalizationWarnings,originalWarning);
 assert.deepEqual(result.items.find(item=>item.sku==='b').normalizationWarnings,[]);
 assert.deepEqual(x.calls.filter(call=>call.path==='/v3/product/import').map(call=>call.body.items.map(item=>item.offer_id)),[['a','b'],['b']]);
});


test('name moderation rejection identifies attribute 4180 and retry retains offer and generated pictures',async()=>{
 let attempt=0;
 const x=setup((path,body)=>{
  if(path==='/v3/product/import')return {result:{task_id:++attempt}};
  if(path==='/v1/product/import/info')return {result:{items:body.task_id?[{offer_id:'a',product_id:123,status:'imported',errors:[]}]:[]}};
  if(path==='/v3/product/info/list')return {items:body.offer_id.map(offer_id=>({offer_id,id:123,
    statuses:attempt<2?{status:'variant_wait',is_created:false,moderate_status:'declined',status_failed:'declined',status_updated_at:'2026-09-12T06:33:57Z'}:{status:'price_sent',is_created:true},
    errors:attempt<2?[{code:'DESCRIPTION_DECLINE',field:'description',attribute_id:4180,level:'ERROR_LEVEL_ERROR'}]:[]}))};
  if(path==='/v2/products/stocks')return {result:body.stocks.map(stock=>({...stock,updated:true,errors:[]}))};
  assert.fail(path);
 });
 const data=input();data.source.items=data.source.items.slice(0,1);data.images=data.images.slice(0,1);
 const accepted=await x.ports.submitListing(data);
 const rejected=await x.ports.readSubmission({accountId:data.accountId,submissionId:accepted.submissionId});
 assert.equal(rejected.status,'FAILED');assert.match(rejected.items[0].failureReason,/商品名称.*4180/);
 assert.equal(rejected.items[0].importStatus,'SUCCEEDED');
 data.source.items[0].listingItem.name='Светильник настенный';
 const retried=await x.ports.submitListing({...data,retryAttempt:1});
 assert.equal(retried.submissionId,accepted.submissionId);
 assert.equal((await x.ports.readSubmission({accountId:data.accountId,submissionId:accepted.submissionId})).status,'COMPLETED');
 const imports=x.calls.filter(c=>c.path==='/v3/product/import');
 assert.equal(imports.length,2);assert.equal(imports[1].body.items[0].offer_id,'a');
 assert.deepEqual(imports[1].body.items[0].images,imports[0].body.items[0].images);
 await x.ports.submitListing({...data,retryAttempt:1});
 assert.equal(x.calls.filter(c=>c.path==='/v3/product/import').length,2);
});


test('explicit retry replaces a legacy failed country with China and keeps successful offers intact', async () => {
 const country={id:4389,complex_id:0,values:[{dictionary_value_id:90295,value:'Россия'}]};
 const data=input();for(const group of data.source.items)group.listingItem.attributes=[structuredClone(country)];
 const sourceBefore=structuredClone(data);let attempt=0;
 const x=setup((path,body)=>{
  if(path==='/v3/product/import')return {result:{task_id:++attempt}};
  if(path==='/v1/product/import/info')return {result:{items:(attempt===1?['a','b']:['b']).map(offer_id=>({
   offer_id,product_id:offer_id==='a'?1:2,status:'imported',
   errors:attempt===1&&offer_id==='b'?[{code:'BR_warning_wrong_country',attribute_id:4389,level:'error'}]:[],
  }))}};
  if(path==='/v3/product/info/list')return {items:body.offer_id.map(offer_id=>({offer_id,id:offer_id==='a'?1:2,statuses:{status:'price_sent'}}))};
  if(path==='/v2/products/stocks')return {result:body.stocks.map(stock=>({...stock,updated:true,errors:[]}))};
  assert.fail(path);
 },{normalizeItems:items=>normalizeOzonImportItems(items,{strictTypeMatch:true,
  getCategoryAttributes:async()=>[{id:4389,dictionary_id:1935,is_required:false}],
 })});
 const accepted=await x.ports.submitListing(data);
 const read=()=>x.ports.readSubmission({accountId:data.accountId,submissionId:accepted.submissionId});
 assert.equal((await read()).status,'FAILED');
 x.row().body.items.find(item=>item.offer_id==='b').attributes=[structuredClone(country)];
 const successfulBefore=structuredClone(x.row().body.items.find(item=>item.offer_id==='a'));
 const resultsBefore=structuredClone(x.row().body.results.find(item=>item.offerId==='a'));
 await x.ports.submitListing({...data,retryAttempt:1});
 const imports=x.calls.filter(call=>call.path==='/v3/product/import');
 assert.equal(imports.length,2);assert.deepEqual(imports[1].body.items.map(item=>item.offer_id),['b']);
 assert.deepEqual(imports[1].body.items[0].attributes.find(a=>a.id===4389).values,[{dictionary_value_id:90296,value:'Китай'}]);
 assert.deepEqual(x.row().body.items.find(item=>item.offer_id==='a'),successfulBefore);
 assert.deepEqual(x.row().body.results.find(item=>item.offerId==='a'),resultsBefore);
 assert.deepEqual(data,sourceBefore);
});

for(const [label,quota] of [['daily exhausted',{daily_create:{limit:2,usage:2}}],['total exhausted',{daily_create:{limit:2,usage:0},total:{limit:2,usage:2}}],['group over daily limit',{daily_create:{limit:1,usage:0}}],['unavailable',{}]])test(`normal submission does not preflight ${label} quota`,async()=>{
 const x=setup(path=>{if(path==='/v3/product/info/list')return {items:[]};if(path==='/v3/product/import')return {result:{task_id:1}};assert.fail(path);},{quotaProvider:()=>quota});
 await x.ports.submitListing(input());
 assert.equal(x.row().body.quotaWait,undefined);assert.equal(x.calls.filter(row=>row.path==='/v3/product/import').length,1);
 assert.equal(x.calls.filter(row=>row.path==='/v4/product/info/limit').length,0);
});

test('daily rejection uses the platform reset time and preserves one journal when it recovers',async()=>{
 let available=false,checks=0,imports=0;
 const x=setup((path,body)=>{
  if(path==='/v3/product/import'){imports++;if(!available)throw Object.assign(new Error('quota'),{status:400,body:{ozonCode:'item_limit_exceeded'}});return {result:{task_id:1}};}
  if(path==='/v1/product/import/info')return {result:{items:['a','b'].map(offer_id=>({offer_id,product_id:offer_id==='a'?1:2,status:'imported',errors:[]}))}};
  if(path==='/v3/product/info/list')return {items:imports>1?body.offer_id.map(offer_id=>({offer_id,id:offer_id==='a'?1:2,statuses:{status:'price_sent'}})):[]};
  if(path==='/v2/products/stocks')return {result:body.stocks.map(stock=>({...stock,updated:true,errors:[]}))};
  assert.fail(path);
 },{quotaProvider:()=>{checks++;return {daily_create:{limit:2,usage:available?0:2,reset_at:'1970-01-02T00:00:00Z'}};}});
 x.advance(86399000-100000);
 const result=await x.ports.submitListing(input()),read=()=>x.ports.readSubmission({accountId:'account',submissionId:result.submissionId});
 assert.equal((await read()).quotaWait.retryAt,86400000);assert.equal(checks,1);assert.equal(imports,1);
 available=true;x.advance(999);await read();assert.equal(checks,1);assert.equal(imports,1);
 x.advance(1);await read();await read();assert.equal(imports,2);assert.equal(checks,2);
 assert.equal(x.row().body.attempts.length,1);
});
