import './support/dedicated-postgres-test-environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import pg from 'pg';
import {readDailyListingSummary} from '../daily-listing-summary.mjs';
import {createAiListingSubmissionPorts} from '../ai-listing-submission.mjs';
import {resolveSubmissionStockResponseV3} from '../listing-stock-response.mjs';
import {submissionStockRequestHashV3} from '../listing-pipeline.mjs';

test('first SKU success survives task deletion, retries, recovery and Beijing day boundaries',{skip:process.env.SONLI_POSTGRES_TESTS!=='1'},async t=>{
  const client=new pg.Client({connectionString:process.env.DATABASE_URL});await client.connect();
  t.after(async()=>{await client.query('ROLLBACK');await client.end();});
  await client.query('BEGIN');
  const schema=`daily_listing_${randomUUID().replaceAll('-','')}`;
  await client.query(`CREATE SCHEMA ${schema}`);
  await client.query(`SET LOCAL search_path=${schema}`);
  await client.query(`CREATE TABLE accounts(id text PRIMARY KEY);INSERT INTO accounts VALUES('owner'),('other');
    CREATE TABLE stores(id text PRIMARY KEY,owner_account_id text,label text);
    INSERT INTO stores VALUES('a','owner','主店'),('b','owner','第二店'),('foreign','other','其他账号');
    CREATE TABLE ai_image_listing_tasks(id text PRIMARY KEY,account_id text,body jsonb);
    CREATE TABLE ai_image_listing_submissions(id text PRIMARY KEY,account_id text,task_id text,body jsonb,updated_at timestamptz DEFAULT NOW());
    CREATE TABLE submission_jobs(id text PRIMARY KEY,account_id text,store_id text,snapshot_id text);
    CREATE TABLE submission_snapshots(id text PRIMARY KEY,stocks jsonb);
    CREATE TABLE submission_items(id text PRIMARY KEY,job_id text,offer_id text,product_id text);
    CREATE TABLE submission_category_recovery_item_results(account_id text,submission_job_id text,recovery_attempt_id text,submission_item_id text,product_id text,status text);
    CREATE TABLE submission_stock_write_intents(id text PRIMARY KEY,account_id text,submission_job_id text,store_id text,recovery_attempt_id text,stock_items jsonb);
    CREATE TABLE submission_stock_write_events(id bigserial PRIMARY KEY,account_id text,stock_write_intent_id text,submission_job_id text,to_status text,payload jsonb,created_at timestamptz DEFAULT STATEMENT_TIMESTAMP());`);
  const result=(productId,offerId='offer',stockStatus='COMPLETED')=>({sku:'same-source-sku',productId,offerId,importStatus:'SUCCEEDED',stockStatus});
  const ai=async(id,storeId,results,accountId='owner')=>client.query('INSERT INTO ai_image_listing_submissions(id,account_id,task_id,body) VALUES($1,$2,$1,$3)',[id,accountId,{config:{targetStoreId:storeId},results}]);
  await ai('historical-ai','a',[result('100')]);
  await client.query("INSERT INTO ai_image_listing_tasks VALUES('purged','owner',$1)",[{submissionTarget:{targetStoreId:'a'},submissionResults:[result('101')]}]);
  const manual=async({id,productId='200',storeId='a',warehouses=['1'],recovery=false})=>{
    const stocks=warehouses.map(warehouse_id=>({offer_id:id,warehouse_id,stock:0}));
    await client.query('INSERT INTO submission_snapshots VALUES($1,$2)',[id,JSON.stringify(stocks)]);
    await client.query("INSERT INTO submission_jobs VALUES($1,'owner',$2,$1)",[id,storeId]);
    await client.query('INSERT INTO submission_items VALUES($1,$1,$1,$2)',[id,recovery?'':productId]);
    if(recovery)await client.query("INSERT INTO submission_category_recovery_item_results VALUES('owner',$1,'recovery',$1,$2,'SUCCEEDED')",[id,productId]);
    await client.query("INSERT INTO submission_stock_write_intents VALUES($1,'owner',$1,$2,$3,$4)",[id,storeId,recovery?'recovery':null,JSON.stringify(stocks.map(stock=>({submissionItemId:id,offerId:id,warehouseId:stock.warehouse_id,quantity:0})))]);
  };
  const event=async(id,{at='2026-09-27T08:00:00Z',status='RESOLVED',receipts=[{offerId:id,warehouseId:'1',status:'SUCCEEDED',updated:true}]}={})=>client.query(
    "INSERT INTO submission_stock_write_events(account_id,stock_write_intent_id,submission_job_id,to_status,payload,created_at) VALUES('owner',$1,$1,$2,$3,$4)",[id,status,{stockResults:receipts},at]);
  await manual({id:'historical-manual'});await event('historical-manual',{at:'2026-09-26T16:00:00Z'});
  await event('historical-manual',{at:'2026-09-27T11:00:00Z'});
  await manual({id:'unknown-ai-also-manual',productId:'100'});await event('unknown-ai-also-manual');
  await manual({id:'previous-day',productId:'201'});await event('previous-day',{at:'2026-09-26T15:59:59.999Z',status:'DONE'});
  await client.query(await readFile(new URL('../db/migrations/153_daily_listing_success.sql',import.meta.url),'utf8'));
  await client.query("UPDATE listing_success_tracking SET started_at='2026-09-27T10:00:00Z'");
  const read=now=>readDailyListingSummary({pool:client,accountId:'owner',now:Date.parse(now)});
  assert.equal((await read('2026-09-27T12:00:00Z')).count,1,'reliable manual time backfills; old AI time stays unknown');
  assert.equal((await read('2026-09-27T12:00:00Z')).complete,false);
  assert.equal((await client.query('SELECT succeeded_at FROM listing_successes WHERE product_id IN ($1,$2) ORDER BY product_id',['100','101'])).rows.every(row=>row.succeeded_at===null),true);
  assert.equal((await client.query("SELECT succeeded_at FROM listing_successes WHERE product_id='200'")).rows[0].succeeded_at.toISOString(),'2026-09-26T16:00:00.000Z','reliable history uses the first successful receipt');
  await ai('historical-target-retry','a',[result('100')]);
  assert.equal((await client.query("SELECT succeeded_at FROM listing_successes WHERE product_id='100'")).rows[0].succeeded_at,null,'a dated manual receipt cannot prove it predates unknown historical AI success');
  await manual({id:'next-day',productId:'202'});await event('next-day',{at:'2026-09-27T16:00:00Z'});
  await manual({id:'recovery',productId:'203',recovery:true});await event('recovery');
  await manual({id:'partial',productId:'204',warehouses:['1','2']});await event('partial');
  for(const status of ['FAILED','UNKNOWN','RETRYABLE'])await event('partial',{receipts:[{offerId:'partial',warehouseId:'2',status,updated:false}]});
  assert.equal((await read('2026-09-27T12:00:00Z')).count,2,'partial warehouse writes are not complete SKU success');
  await event('partial',{at:'2026-09-27T09:00:00Z',receipts:[{offerId:'partial',warehouseId:'2',status:'SUCCEEDED',updated:true}]});
  assert.equal((await read('2026-09-27T12:00:00Z')).count,3);
  await event('historical-manual',{at:'2026-09-28T08:00:00Z'});
  assert.equal((await read('2026-09-28T12:00:00Z')).count,1,'later retry cannot move first success to a new day');
  assert.equal((await read('2026-09-28T12:00:00Z')).complete,true);
  await manual({id:'overnight-warehouses',productId:'205',warehouses:['1','2']});
  await event('overnight-warehouses',{at:'2026-09-27T15:00:00Z'});
  await event('overnight-warehouses',{at:'2026-09-27T16:10:00Z',receipts:[{offerId:'overnight-warehouses',warehouseId:'2',status:'SUCCEEDED',updated:true}]});
  assert.equal((await read('2026-09-27T12:00:00Z')).count,3);
  assert.equal((await read('2026-09-28T12:00:00Z')).count,2,'a SKU belongs to the day when its last required warehouse succeeds');
  await ai('pending','a',[result('300','offer-pending','PENDING'),result('301','offer-unknown','UNKNOWN'),
    {...result('303','failed-import'),importStatus:'FAILED'}]);
  const before=await client.query('SELECT COUNT(*)::int count FROM listing_successes');
  await client.query("UPDATE ai_image_listing_submissions SET body=jsonb_set(body,'{results,0,stockStatus}','\"COMPLETED\"') WHERE id='pending'");
  const first=(await client.query("SELECT succeeded_at FROM listing_successes WHERE product_id='300'")).rows[0].succeeded_at;
  assert.ok(first instanceof Date);
  assert.equal((await client.query("SELECT COUNT(*)::int count FROM listing_successes WHERE product_id IN ('301','303')")).rows[0].count,0,'unconfirmed stock or failed import is not a listing success');
  await ai('same-target-retry','a',[result('300')]);
  await ai('second-store','b',[result('300')]);
  await ai('different-target-same-source','a',[result('302')]);
  await ai('foreign','foreign',[result('300')],'other');
  assert.equal((await client.query('SELECT COUNT(*)::int count FROM listing_successes')).rows[0].count,before.rows[0].count+4);
  await client.query("UPDATE ai_image_listing_submissions SET body=body-'config' WHERE id='pending'");
  await client.query('DELETE FROM ai_image_listing_submissions;DELETE FROM ai_image_listing_tasks;DELETE FROM submission_stock_write_events');
  assert.equal((await client.query("SELECT succeeded_at FROM listing_successes WHERE account_id='owner' AND store_id='a' AND product_id='300'")).rows[0].succeeded_at.getTime(),first.getTime());
  const current=await readDailyListingSummary({pool:client,accountId:'owner',now:first});
  assert.ok(!current.byStore.some(store=>store.storeId==='foreign'));
  assert.ok(current.byStore.some(store=>store.storeId==='b'&&store.count===1));

  // Exercise the existing AI submission finalization path against PostgreSQL;
  // only the remote Ozon transport is a fixture, never a real stock request.
  await client.query('INSERT INTO ai_image_listing_submissions(id,account_id,task_id,body) VALUES($1,$2,$1,$3)',['pipeline','owner',{
    config:{targetStoreId:'a',targetWarehouseId:'warehouse',stock:0},status:'STOCKING',
    results:[result('400','pipeline-offer','PENDING')],
    stocks:[{offer_id:'pipeline-offer',warehouse_id:1,stock:0,completed:false}],
    attempts:[{status:'DONE',offerIds:['pipeline-offer']}],
  }]);
  const remoteCalls=[];
  const ports=createAiListingSubmissionPorts({pool:{connect:async()=>({query:client.query.bind(client),release(){}})},
    validateTarget:async()=>({}),readCredential:async()=>({clientId:'fixture'}),reserveCapacity:async()=>({allowed:true}),
    callOzonSellerApi:async(_credential,path,body)=>{
      remoteCalls.push(path);
      if(path==='/v3/product/info/list')return {items:[{offer_id:'pipeline-offer',id:400,statuses:{status:'price_sent',is_created:true}}]};
      if(path==='/v2/products/stocks')return {result:body.stocks.map(stock=>({...stock,updated:true,errors:[]}))};
      assert.fail(`unexpected fixture operation ${path}`);
    }});
  const finalized=await ports.readSubmission({accountId:'owner',submissionId:'pipeline'});
  assert.equal(finalized.status,'COMPLETED');
  assert.deepEqual(remoteCalls,['/v3/product/info/list','/v2/products/stocks','/v3/product/info/list']);
  assert.ok((await client.query("SELECT succeeded_at FROM listing_successes WHERE product_id='400'")).rows[0].succeeded_at);

  // Use the production manual receipt API and its existing audit trigger. The
  // new success trigger must see a receipt inserted by another AFTER trigger.
  await manual({id:'nested-receipt',productId:'500'});
  await client.query(`ALTER TABLE submission_jobs ADD COLUMN status text DEFAULT 'CHECKING',
    ADD COLUMN ozon_task_id text DEFAULT '555',ADD COLUMN result_summary jsonb;
    ALTER TABLE submission_stock_write_intents ADD COLUMN status text DEFAULT 'IN_FLIGHT',
      ADD COLUMN submission_snapshot_id text,ADD COLUMN import_ozon_task_id text DEFAULT '555',
      ADD COLUMN request_hash text,ADD COLUMN correlation_id text,ADD COLUMN actor_id text,
      ADD COLUMN done_at timestamptz,ADD COLUMN failure_code text DEFAULT '';
    ALTER TABLE submission_stock_write_events ADD COLUMN submission_snapshot_id text,
      ADD COLUMN from_status text,ADD COLUMN event_type text,ADD COLUMN actor_id text;`);
  const command={accountId:'owner',jobId:'nested-receipt',snapshotId:'nested-receipt',storeId:'a',
    importOzonTaskId:'555',recoveryAttemptId:null,correlationId:'nested-receipt',actorId:'fixture-worker',
    stocks:[{submissionItemId:'nested-receipt',offerId:'nested-receipt',warehouseId:'1',quantity:0}]};
  command.requestHash=submissionStockRequestHashV3(command.stocks);
  await client.query("UPDATE submission_stock_write_intents SET submission_snapshot_id=$1,request_hash=$2,correlation_id=$1,actor_id=$3 WHERE id=$1",[command.jobId,command.requestHash,command.actorId]);
  const receiptMigration=await readFile(new URL('../db/migrations/121_submission_stock_explicit_response_retry.sql',import.meta.url),'utf8');
  await client.query(receiptMigration.slice(receiptMigration.indexOf('CREATE OR REPLACE FUNCTION audit_submission_stock_write_intent()')));
  await client.query(`CREATE TRIGGER production_manual_audit AFTER UPDATE OF status ON submission_stock_write_intents
    FOR EACH ROW EXECUTE FUNCTION audit_submission_stock_write_intent()`);
  const resolved=await resolveSubmissionStockResponseV3(command,{stockResults:[{
    offerId:'nested-receipt',warehouseId:'1',status:'SUCCEEDED',updated:true,errors:[],
  }]},{client});
  assert.equal(resolved.status,'RESOLVED');
  assert.ok((await client.query("SELECT succeeded_at FROM listing_successes WHERE product_id='500'")).rows[0].succeeded_at);
});
