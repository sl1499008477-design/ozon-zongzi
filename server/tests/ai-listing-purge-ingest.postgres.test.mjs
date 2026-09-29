import './support/dedicated-postgres-test-environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {getPostgresPool,closePostgresPool} from '../db/connection.mjs';
import {runMigrations} from '../db/migrate.mjs';
import {ingestCollectRequestV4} from '../collection-pipeline.mjs';
import {updateCollectItemDraftWithClientV4} from '../listing-pipeline.mjs';
import {purgeCollectedItems} from '../collection-purge.mjs';
import {createAiListingRepository} from '../ai-listing-repository.mjs';
import {createAiListingService} from '../ai-listing-service.mjs';
import {createAiListingPurge} from '../ai-listing-purge.mjs';

const enabled=process.env.SONLI_POSTGRES_TESTS==='1';
test('real ingestion cannot revive a frozen source or introduce cross-account references while cleanup is in flight', {skip:!enabled,timeout:60000},async(t)=>{
 assert.match(new URL(process.env.DATABASE_URL).pathname,/(qa|fixture|test)/i);
 const pool=await getPostgresPool();await runMigrations(pool);
 const a='purge-ingest-'+randomUUID(),b='purge-reader-'+randomUUID(),taskId='purge-task-'+randomUUID();
 const taskIds=[taskId];let failure;const started=Date.now();
 const checkpoint=label=>t.diagnostic(`${label}: ${Date.now()-started}ms`);
 const key=`listing-media/v1/ai-image-listing/${'d'.repeat(64)}.jpg`,url='https://www.ozonzongzi.com/'+key;
 const variant=sku=>({sku,title:'Светильник '+sku,name:'Светильник '+sku,images:[`https://cdn1.ozone.ru/s3/multimedia-test/${sku}-1.jpg`],blackPrice:'35.05',greenPrice:'33.00',currencyCode:'CNY'});
 const upload=(accountId,sku,skus,requestId)=>ingestCollectRequestV4({authenticatedAccount:{id:accountId},input:{source:'ozon',sourceSku:sku,sourceUrl:`https://www.ozon.ru/product/${sku}/`,requestId,payload:{...variant(sku),description:'Светильник для комнаты.',priceCurrency:'CNY',variantData:{variants:skus.map(variant)}}}});
 try{
  for(const id of [a,b])await pool.query("INSERT INTO accounts(id,username,role) VALUES($1,$1,'user')",[id]);
  const original=await upload(a,'99101',['99101'],'initial');
  const reader=await upload(b,'99201',['99201'],'reader');
  checkpoint('Sources ingested');
  const repository=createAiListingRepository({pool}),service=createAiListingService({repository});
  await repository.create({id:taskId,accountId:a,dedupeKey:taskId,status:'CANCELLED',sourceType:'COLLECT_BOX',sourceId:original.collectItemId,
   source:{collectItemId:original.collectItemId,items:[{sku:'99101'}]},sku:'99101',name:'Purge ingestion fixture',config:{},mediaJournalVersion:1,
   images:[{sku:'99101',index:0,generatedUrl:url}],stoppedFrom:'GENERATING',createdAt:Date.now(),updatedAt:Date.now(),nextRunAt:0});
  await pool.query('UPDATE ai_image_listing_tasks SET deleted_at=$2 WHERE id=$1',[taskId,Date.now()]);
  await service.permanentlyDeleteTask({accountId:a,taskId,expectedVersion:1});
  let storageCalls=0;
  const worker=createAiListingPurge({pool,publication:{baseUrl:'https://www.ozonzongzi.com/',prefix:'listing-media/v1'},storage:{deleteObjectVersions:async({key:deletedKey})=>{
   assert.equal(deletedKey,key);storageCalls++;
   await assert.rejects(upload(a,'99101',['99101','99102'],'during-purge'),{code:'COLLECT_MEDIA_PURGING'});
   const client=await pool.connect();try{
    await client.query('BEGIN');
    await assert.rejects(updateCollectItemDraftWithClientV4(client,{accountId:b,collectItemId:reader.collectItemId,
     patch:{listingDraft:{variants:[variant('99201')],richContent:JSON.stringify({src:url}).replaceAll('/','\\/')}}}),{code:'COLLECT_MEDIA_PURGING'});
    await client.query('ROLLBACK');
   }finally{client.release();}
   return {deletedVersions:1};
  }}});
  const result=await worker.sweep();checkpoint('First purge finished');assert.equal(result.taskId,taskId);assert.equal(result.state,'COMPLETED');assert.equal(storageCalls,1);
  assert.equal((await pool.query('SELECT count(*)::int n FROM collect_items WHERE id=$1',[original.collectItemId])).rows[0].n,0);
  checkpoint('First source removed');
  const recollected=await upload(a,'99101',['99101','99102'],'after-purge');assert.ok(recollected.collectItemId);
  const draft=(await pool.query('SELECT data FROM product_drafts WHERE collect_item_id=$1',[recollected.collectItemId])).rows[0].data;
  assert.deepEqual(draft.variants.map(row=>row.sku).sort(),['99101','99102']);
  // A writer already in progress before manifest publication must commit first,
  // then the reference scan must retain its media instead of deleting it.
  const nextSource=await upload(a,'99301',['99301'],'second-source'),nextId='purge-task-'+randomUUID();taskIds.push(nextId);
  const sharedKey=`listing-media/v1/ai-image-listing/${'e'.repeat(64)}.jpg`,sharedUrl='https://www.ozonzongzi.com/'+sharedKey;
  await repository.create({id:nextId,accountId:a,dedupeKey:nextId,status:'CANCELLED',sourceType:'COLLECT_BOX',sourceId:nextSource.collectItemId,
   source:{collectItemId:nextSource.collectItemId,items:[{sku:'99301'}]},sku:'99301',name:'In-flight reference fixture',config:{},mediaJournalVersion:1,
   images:[{sku:'99301',index:0,generatedUrl:sharedUrl}],stoppedFrom:'GENERATING',createdAt:Date.now(),updatedAt:Date.now(),nextRunAt:0});
  await pool.query('UPDATE ai_image_listing_tasks SET deleted_at=$2 WHERE id=$1',[nextId,Date.now()]);
  await service.permanentlyDeleteTask({accountId:a,taskId:nextId,expectedVersion:1});
  const writer=await pool.connect();let work;
  try{
   await writer.query('BEGIN');
   await updateCollectItemDraftWithClientV4(writer,{accountId:b,collectItemId:reader.collectItemId,
    patch:{listingDraft:{variants:[variant('99201')],richContent:JSON.stringify({src:sharedUrl}).replaceAll('/','\\/')}}});
   let atManifest;
   const manifestReached=new Promise(resolve=>{atManifest=resolve;});
   const observedPool={query:(...args)=>pool.query(...args),connect:async()=>{
    const client=await pool.connect();return {release:()=>client.release(),query:(...args)=>{
     if(String(args[0]).includes("pg_advisory_xact_lock(hashtextextended('ai-listing-media-reference-admission'"))atManifest();
     return client.query(...args);
    }};
   }};
   const retainingWorker=createAiListingPurge({pool:observedPool,publication:{baseUrl:'https://www.ozonzongzi.com/',prefix:'listing-media/v1'},storage:{deleteObjectVersions:async()=>assert.fail('The in-flight committed reference must retain media')}});
   work=retainingWorker.sweep();work.catch(()=>{});
   let timer;try{
    await Promise.race([manifestReached,work.then(()=>assert.fail('Purge ended before reaching the manifest fence')),
     new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Purge did not reach manifest admission while writer held its transaction')),15000);})]);
   }finally{clearTimeout(timer);}
   checkpoint('Purge reached manifest admission');
   const frozen=(await pool.query("SELECT body#>'{purge,sources}' AS sources FROM ai_image_listing_tasks WHERE id=$1",[nextId])).rows[0].sources;
   assert.deepEqual(frozen.remove,[nextSource.collectItemId]);
   await writer.query('COMMIT');
   assert.equal((await work).state,'COMPLETED');assert.equal((await repository.get({accountId:a,taskId:nextId})).purge.retainedObjects,1);
  }finally{await writer.query('ROLLBACK');writer.release();await work?.catch(()=>{});}

 }catch(error){failure=error;throw error;}finally{
  checkpoint('Fixture cleanup');
  const client=await pool.connect();try{
   await client.query('BEGIN');
   for(const accountId of [a,b]){
    const ids=(await client.query('SELECT id FROM collect_items WHERE account_id=$1',[accountId])).rows.map(row=>row.id);
    if(ids.length)await purgeCollectedItems(client,accountId,ids);
   }
   await client.query('DELETE FROM ai_image_listing_tasks WHERE id=ANY($1::text[]) AND account_id=$2',[taskIds,a]);
   await client.query('DELETE FROM collect_requests WHERE account_id=ANY($1::text[])',[[a,b]]);
   await client.query('DELETE FROM product_restriction_events WHERE account_id=ANY($1::text[])',[[a,b]]);
   await client.query('DELETE FROM accounts WHERE id=ANY($1::text[])',[[a,b]]);
   await client.query('COMMIT');
  }catch(error){await client.query('ROLLBACK');if(failure)t.diagnostic(`Fixture cleanup also failed: ${error.message}`);else throw error;}finally{client.release();await closePostgresPool();}
 }
});
