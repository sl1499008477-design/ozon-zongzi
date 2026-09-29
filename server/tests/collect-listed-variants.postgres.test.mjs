import './support/dedicated-postgres-test-environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {getPostgresPool,closePostgresPool} from '../db/connection.mjs';
import {runMigrations} from '../db/migrate.mjs';
import {ingestCollectRequestV4} from '../collection-pipeline.mjs';
import {listCollectItemsV3,softDeleteCollectItemsForAccountV4} from '../listing-pipeline.mjs';
import {findCollectedSku,withoutListedSkus} from '../collection-sku-rules.mjs';
import {loadAiListingCollectSources} from '../ai-listing-runtime.mjs';

test('a listed anchor does not swallow new variants; saved groups dedupe and deleted unlisted variants can return',
 {skip:process.env.SONLI_POSTGRES_TESTS!=='1'},async()=>{
 const pool=await getPostgresPool();
 const a='collect-group-'+randomUUID(),b=a+'-other';
 const listed='2102714113',fresh='2102713933';
 const variants=[listed,fresh].map(sku=>({sku,name:'Светильник',price:'100.00',priceCurrency:'CNY',images:['https://example.test/'+sku+'.jpg']}));
 const input={source:'ozon',sourceSku:listed,sourceUrl:'https://www.ozon.ru/product/'+listed+'/',requestId:randomUUID(),capturedAt:new Date().toISOString(),payload:{...variants[0],variantData:{variants}}};
 const task={status:'COMPLETED',source:{items:[{sku:listed}]}};
 try{
  await runMigrations(pool);
  await pool.query("INSERT INTO accounts(id,username,role) VALUES($1,$1,'user'),($2,$2,'user')",[a,b]);
  await pool.query("INSERT INTO ai_image_listing_tasks(id,account_id,dedupe_key,status,body,next_run_at,created_at) VALUES($1,$2,$1,'COMPLETED',$3,0,0)",[a+'-task',a,JSON.stringify(task)]);
  assert.equal((await findCollectedSku(pool,a,listed)).collectionState,'LISTED');
  const first=await ingestCollectRequestV4({authenticatedAccount:{id:a},input});
  assert.equal(first.duplicate,false,'the unlisted sibling must persist even when the anchor is already listed');
  assert.ok(first.requestId);
  const saved=await listCollectItemsV3({accountId:a});
  assert.equal(saved.length,1);
  assert.equal(saved[0].listingDraft.variants.length,2);
  assert.deepEqual(withoutListedSkus(saved,[task])[0].listingDraft.variants.map(v=>v.sku),[fresh]);
  const sources=await loadAiListingCollectSources({pool,accountId:a,collectItemIds:[first.collectItemId],config:{targetStoreId:'test-store'},
   buildListingItems:record=>record.listingDraft.variants.map(v=>({scraped_sku:v.sku}))});
  assert.deepEqual(sources[0].items.map(i=>i.sku),[fresh],'default AI handoff uses only unlisted variants');
  const replay=await ingestCollectRequestV4({authenticatedAccount:{id:a},input:{...input,requestId:randomUUID()}});
  assert.equal(replay.duplicate,true);
  assert.equal((await listCollectItemsV3({accountId:a})).length,1);
  assert.equal(await findCollectedSku(pool,b,listed,[listed,fresh]),null,'other accounts cannot cause duplicate skips');
  assert.equal(await softDeleteCollectItemsForAccountV4(a,[first.collectItemId]),1);
  assert.equal((await listCollectItemsV3({accountId:a})).length,0);
  const recollected=await ingestCollectRequestV4({authenticatedAccount:{id:a},input});
  assert.equal(recollected.duplicate,false,'deletion releases unfinished variants, including the original request ID');
  assert.deepEqual(withoutListedSkus(await listCollectItemsV3({accountId:a}),[task])[0].listingDraft.variants.map(v=>v.sku),[fresh]);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM ai_image_listing_tasks WHERE account_id=$1',[a])).rows[0].n,1);
 }finally{
  for(const table of ['product_restriction_events','collector_ozon_enrichment_jobs','collect_requests','collect_raw_payloads','collect_items','accounts']){
   await pool.query('DELETE FROM '+table+' WHERE '+(table==='accounts'?'id':'account_id')+'=ANY($1::text[])',[[a,b]]);
  }
  await closePostgresPool();
 }
});
