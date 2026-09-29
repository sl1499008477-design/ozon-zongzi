import test from 'node:test';
import assert from 'node:assert/strict';
import {readCollectSummaryPage} from '../collect-read-summary.mjs';

function fixture(){
 const rows=[
  {id:'a',source:'ozon',sku:'a1',name:'Group',status:'COMPLETE',enrichment:{status:'COMPLETE'},variants:[{sku:'a1',image:'one',price:'1.23',currency:'RUB'},{sku:'a2',image:'two',price:'4.56',currency:'RUB'}]},
  {id:'b',source:'ozon',sku:'b',name:'Failed',status:'FAILED',variants:[]},
  {id:'c',source:'excel',sku:'c',name:'Pending',status:'COMPLETE',variants:[]},
 ];const queries=[];
 const webJobs=[];
 const pool={query:async(sql,params)=>{queries.push({sql,params});assert.equal(params[0],'owner');if(sql.includes('ozon_web_collection_jobs'))return {rows:webJobs};if(sql.includes('FROM collect_items c'))return {rows};if(sql.includes('ai_image_listing_tasks'))return {rows:[{sku:'a1'}]};if(sql.includes('collector_ozon_enrichment_jobs'))return {rows:[]};throw Error(sql);}};
 return {pool,rows,queries,webJobs,read:input=>readCollectSummaryPage({pool,accountId:'owner',readCategories:async({collectItemIds})=>collectItemIds.map(collectItemId=>({collectItemId,categoryResolution:{status:'ACTIVE',taxonomyScope:'OZON:DEFAULT',source:'SOURCE_DIRECT',currentDescriptionCategoryId:10,currentTypeId:20}})),...input})};
}

test('web collection jobs share product pagination and completion merges into the saved product',async()=>{
 const x=fixture();x.webJobs.push(
  {id:'wc_new',sku:'new',scope:'ALL',status:'PROCESSING',message:'采集变体中',createdAt:'2026-09-23T00:00:00Z',updatedAt:'2026-09-23T00:00:00Z'},
  {id:'wc_failed',sku:'failed',scope:'CURRENT',status:'FAILED',message:'需要重试',errorCode:'CAPTURE_FAILED'},
  {id:'wc_done',sku:'a1',scope:'ALL',status:'COMPLETED',result:{collectItemId:'a'}},
  {id:'wc_deleted',sku:'gone',scope:'ALL',status:'COMPLETED',result:{collectItemId:'deleted'}});
 const before=structuredClone(x.webJobs),page=await x.read({limit:1});
 assert.equal(page.total,5);assert.equal(page.items[0].id,'wc_new');assert.equal(page.items[0].selectable,false);
 assert.equal(page.items[0].webCollectionJob.status,'PROCESSING');assert.equal(page.hasActiveWebJobs,true);
 assert.equal(page.counts['待处理'],3);assert.equal(page.counts['失败'],2);
 assert.equal(x.queries.some(q=>q.sql.includes('collector_ozon_enrichment_jobs')),false,'task-only page must not read product enrichment');
 const failed=await x.read({status:'失败'});assert.deepEqual(failed.items.map(i=>i.id),['b','wc_failed']);
 assert.equal((await x.read({variant:'多变体'})).items.length,0,'unknown ALL scope is not a known multiple-variant product');
 assert.deepEqual(x.webJobs,before);
 x.webJobs[0]={...x.webJobs[0],status:'COMPLETED',result:{collectItemId:'new_item'}};
 x.rows.unshift({id:'new_item',sku:'new',name:'新采集商品',status:'COLLECTED',variants:[]});
 const completed=await x.read();assert.equal(completed.total,5);assert.equal(completed.hasActiveWebJobs,false);
 assert.equal(completed.items.some(i=>i.id==='wc_new'),false);assert.equal(completed.items.filter(i=>i.id==='new_item').length,1);
});

test('fully listed products are reachable in the listed tab without returning them to pending selection',async()=>{
 const x=fixture();x.rows[0].variants=[x.rows[0].variants[0]];
 const pending=await x.read();assert.equal(pending.total,2);assert.equal(pending.counts['已上架'],1);
 const listed=await x.read({status:'已上架'});assert.equal(listed.total,1);assert.equal(listed.items[0].id,'a');
 assert.equal(listed.items[0].status,'已上架');assert.equal(listed.items[0].selectable,false);
 assert.deepEqual(listed.items[0].variants.map(v=>v.sku),['a1']);
});

test('duplicate completion without a live collect row remains a non-selectable receipt instead of disappearing',async()=>{
 const x=fixture();x.webJobs.push({id:'wc_listed',sku:'a1',scope:'CURRENT',status:'COMPLETED',message:'商品已上架，跳过重复采集',result:{duplicate:true,collectItemId:'listed:a1'}});
 const page=await x.read({status:'已跳过'});assert.equal(page.total,1);assert.equal(page.items[0].selectable,false);
 assert.equal(page.items[0].webCollectionJob.status,'COMPLETED');assert.equal(page.items[0].webCollectionJob.alreadyListed,true);
 assert.equal(page.items[0].id,'wc_listed','keep the task receipt, never resurrect an editable product');
});

test('listed SKU filtering precedes stable pagination and keeps remaining group fields without raw data',async()=>{
 const x=fixture(),page=await x.read({limit:1,offset:0});
 assert.equal(page.total,3);assert.deepEqual(page.items[0].variants.map(v=>v.sku),['a2']);assert.equal(page.items[0].variantCount,1);
 assert.equal(page.items[0].variants[0].price,'4.56');assert.equal(page.items[0].categoryResolution.status,'ACTIVE');
 assert.equal(page.items[0].listingDraft,undefined);assert.equal(page.items[0].raw,undefined);
 assert.deepEqual(page.counts,{'全部':3,'待处理':2,'已上架':0,'已跳过':0,'失败':1});assert.deepEqual(page.sources,['excel','ozon']);
 const next=await x.read({limit:1,offset:1});assert.deepEqual(next.items.map(item=>item.id),['b']);
});

test('filters apply to all visible rows, variant count uses unlisted SKUs and limit is capped',async()=>{
 const x=fixture();assert.equal((await x.read({variant:'多变体'})).total,0);
 assert.deepEqual((await x.read({source:'ozon',status:'失败',variant:'单 SKU'})).items.map(item=>item.id),['b']);
 x.rows.splice(0,x.rows.length,...Array.from({length:130},(_,i)=>({id:String(i),sku:String(i),status:'COLLECTED',variants:[]})));
 assert.equal((await x.read({limit:10000})).items.length,100);assert.equal((await x.read({offset:200})).total,130);
});

test('historical COLLECTED groups join pending counts and pages while failure and category evidence is preserved',async()=>{
 const x=fixture();for(const row of x.rows)row.status='COLLECTED';
 x.rows[0].enrichment={status:'NEEDS_ATTENTION',missingFields:['weightG']};
 x.rows[1].enrichment={status:'COLLECTION_FAILED',lastErrorCode:'ZONGZI_SKU_SCRAPE_EMPTY'};
 x.rows[2].enrichment={status:'COMPLETE',missingFields:[]};
 const before=structuredClone(x.rows);
 const readCategories=async({collectItemIds})=>collectItemIds.map(collectItemId=>({collectItemId,categoryResolution:{status:'NEEDS_REVIEW',taxonomyScope:'OZON:DEFAULT'}}));
 const page=await x.read({readCategories});
 assert.deepEqual(page.counts,{'全部':3,'待处理':2,'已上架':0,'已跳过':0,'失败':1});
 assert.deepEqual(page.items.map(item=>[item.id,item.status]),[['a','待处理'],['b','失败'],['c','待处理']]);
 assert.deepEqual(page.items.map(item=>item.enrichment),before.map(item=>item.enrichment));
 assert(page.items.every(item=>item.categoryResolution.status==='NEEDS_REVIEW'));
 const pending=await x.read({status:'待处理',limit:1,offset:1,readCategories});
 assert.equal(pending.total,2);assert.deepEqual(pending.items.map(item=>item.id),['c']);
 assert.deepEqual(pending.counts,page.counts);
 assert.deepEqual((await x.read({status:'失败',readCategories})).items.map(item=>item.id),['b']);
 assert.deepEqual(x.rows,before,'public projections must not rewrite persisted business or enrichment status');
});

test('summary reads require account scope before database access',async()=>{
 await assert.rejects(readCollectSummaryPage({pool:{query:()=>assert.fail('scope missing')},accountId:''}),{code:'COLLECT_ACCOUNT_REQUIRED'});
});

test('only current page receives enrichment and category projection while legacy waiting status is retained',async()=>{
 const seen=[];const x=fixture();x.rows[0].enrichment={status:'PENDING_ENRICHMENT'};
 const pool={query:async(sql,params)=>sql.includes('collector_ozon_enrichment_jobs')?{rows:[{collect_item_id:'a',sku:'a2',status:'FAILED',attempt_count:2,error_json:{code:'ZONGZI_ENRICH_UPSTREAM_FAILED',message:'扩展执行超时，未收到补全结果'}}]}:x.pool.query(sql,params)};
 const result=await readCollectSummaryPage({pool,accountId:'owner',limit:1,readCategories:async scope=>{seen.push(scope.collectItemIds);return [];}});
 assert.deepEqual(seen,[['a']]);assert.equal(result.items[0].enrichment.executionState,'WAITING_FOR_EXTENSION');assert.equal(result.items[0].enrichment.hasActiveJobs,true);assert.deepEqual(result.items[0].enrichment.failures,[]);
});
