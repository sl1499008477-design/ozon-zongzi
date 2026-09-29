import '../env.mjs';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {Pool} from 'pg';
import {postgresConfig} from '../db/connection.mjs';
import {submissionStockRequestHashV3} from '../listing-pipeline.mjs';
import {resolveSubmissionStockResponseV3,readResolvedStockResponseV3,reprepareResolvedStockWriteV3} from '../listing-stock-response.mjs';

const enabled=process.env.SONLI_STOCK_JOURNAL_POSTGRES_TESTS==='1';
test('migrations119/121 preserve frozen stock identity and recover only explicit retryable receipts',{skip:!enabled,timeout:15000},async()=>{
 assert.equal(process.env.SONLI_ENV_FILE,'/private/tmp/sonli-audit-test.env','explicit private database environment required');
 const pool=new Pool(postgresConfig());const client=await pool.connect();
 const suffix=randomUUID();const account='stock-account-'+suffix,store='stock-store-'+suffix,snapshot='stock-snapshot-'+suffix,job='stock-job-'+suffix;
 const stocks=Array.from({length:102},(_,i)=>({offer_id:'offer-'+i,warehouse_id:1020005029861840,stock:0}));
 const stockItems=stocks.map((s,i)=>({submissionItemId:'stock-item-'+suffix+'-'+i,offerId:s.offer_id,warehouseId:String(s.warehouse_id),quantity:s.stock}));
 try {
  await client.query('BEGIN');
  await client.query("SET LOCAL lock_timeout='3s'");
  await client.query("INSERT INTO accounts(id,username,display_name,role,status) VALUES($1,$1,$1,'admin','active')",[account]);
  await client.query("INSERT INTO stores(id,label,company_name,client_id,status,owner_account_id) VALUES($1,$1,$1,$1,'active',$2)",[store,account]);
  await client.query(`INSERT INTO submission_snapshots(id,account_id,store_id,idempotency_key,snapshot_hash,item_count,items,stocks)
    VALUES($1,$2,$3,$1,$4,102,$5::jsonb,$6::jsonb)`,[snapshot,account,store,'a'.repeat(64),JSON.stringify(stocks.map(s=>({offer_id:s.offer_id}))),JSON.stringify(stocks)]);
  await client.query(`INSERT INTO submission_jobs(id,snapshot_id,account_id,store_id,status,ozon_task_id,item_count,correlation_id)
    VALUES($1,$2,$3,$4,'CHECKING','123',102,$1)`,[job,snapshot,account,store]);
  for(let i=0;i<stocks.length;i++)await client.query(`INSERT INTO submission_items(id,job_id,snapshot_id,variant_key,offer_id,status,product_id)
    VALUES($1,$2,$3,$4,$4,$5,$6)`,[stockItems[i].submissionItemId,job,snapshot,stocks[i].offer_id,i===101?'FAILED':'SUCCEEDED',i===101?'':String(1000+i)]);
  const insert=async(items,scope={})=>{
    const id='stock-intent-'+randomUUID();
    await client.query(`INSERT INTO submission_stock_write_intents(id,account_id,submission_job_id,submission_snapshot_id,store_id,import_ozon_task_id,request_hash,correlation_id,actor_id,stock_items,item_count,status)
      VALUES($1,$2,$3,$4,$5,'123',$6,$3,'fixture-worker',$7::jsonb,$8,'PREPARED')`,
      [id,scope.account||account,job,scope.snapshot||snapshot,store,submissionStockRequestHashV3(items),JSON.stringify(items),items.length]);
    return id;
  };
  // Simulate upgrading a genuinely sent old whole-snapshot journal.
  const previous=await readFile(new URL('../db/migrations/071_submission_stock_write_ledger.sql',import.meta.url),'utf8');
  await client.query(previous.slice(previous.indexOf('CREATE OR REPLACE FUNCTION validate_submission_stock_write_intent()'),previous.indexOf('CREATE TRIGGER submission_stock_write_intent_guard')));
  const legacy=await insert(stockItems);
  await client.query("UPDATE submission_stock_write_intents SET status='IN_FLIGHT',in_flight_at=NOW() WHERE id=$1",[legacy]);
  const migration=await readFile(new URL('../db/migrations/119_submission_stock_successful_subsets.sql',import.meta.url),'utf8');
  await client.query(migration);
  await client.query(migration);
  await client.query("UPDATE submission_stock_write_intents SET status='AMBIGUOUS',ambiguous_at=NOW(),failure_code='ZONGZI_STOCK_WRITE_AMBIGUOUS' WHERE id=$1",[legacy]);
  assert.equal((await client.query('SELECT status FROM submission_stock_write_intents WHERE id=$1',[legacy])).rows[0].status,'AMBIGUOUS');
  const batch=await insert(stockItems.slice(0,100));
  const single=await insert([stockItems[100]]);
  assert.equal((await client.query('SELECT COUNT(*)::int AS count FROM submission_stock_write_intents WHERE account_id=$1',[account])).rows[0].count,3);
  await client.query("UPDATE submission_stock_write_intents SET status='IN_FLIGHT',in_flight_at=NOW() WHERE id=$1",[batch]);
  await client.query("UPDATE submission_stock_write_intents SET status='DONE',done_at=NOW() WHERE id=$1",[batch]);
  for(const [label,items,scope] of [
    ['failed SKU',[stockItems[101]]],['wrong SKU',[{...stockItems[100],offerId:'not-in-snapshot'}]],
    ['wrong warehouse',[{...stockItems[100],warehouseId:'other-warehouse'}]],['wrong quantity',[{...stockItems[100],quantity:6}]],
    ['oversized batch',stockItems.slice(0,101)],['wrong account',[stockItems[100]],{account:'not-owner'}],
    ['wrong snapshot',[stockItems[100]],{snapshot:'not-snapshot'}],
  ]){
    await client.query('SAVEPOINT rejection');
    await assert.rejects(insert(items,scope),error=>['23514','23503'].includes(error.code),label);
    await client.query('ROLLBACK TO SAVEPOINT rejection');
  }
  await client.query('SAVEPOINT changed_success');
  await client.query("UPDATE submission_items SET status='FAILED',product_id='' WHERE id=$1",[stockItems[100].submissionItemId]);
  await assert.rejects(client.query("UPDATE submission_stock_write_intents SET status='IN_FLIGHT',in_flight_at=NOW() WHERE id=$1",[single]),error=>error.code==='23514');
  await client.query('ROLLBACK TO SAVEPOINT changed_success');
  const replay=await client.query('SELECT status FROM submission_stock_write_intents WHERE id=$1',[batch]);
  assert.equal(replay.rows[0].status,'DONE');
  const responseMigration=await readFile(new URL('../db/migrations/121_submission_stock_explicit_response_retry.sql',import.meta.url),'utf8');
  await client.query(responseMigration);await client.query(responseMigration);
  const commandFor=items=>({accountId:account,jobId:job,snapshotId:snapshot,storeId:store,importOzonTaskId:'123',recoveryAttemptId:null,
    requestHash:submissionStockRequestHashV3(items),correlationId:job,actorId:'fixture-worker',stocks:items});
  const outcome=(item,status,errors=[])=>({offerId:item.offerId,warehouseId:item.warehouseId,status,errors,updated:status==='SUCCEEDED'?true:status==='UNKNOWN'?null:false});
  const command=commandFor([stockItems[100]]);
  await client.query("UPDATE submission_stock_write_intents SET status='IN_FLIGHT',in_flight_at=NOW() WHERE id=$1",[single]);
  const retrySummary={stockResults:[outcome(stockItems[100],'RETRYABLE',['TOO_MANY_REQUESTS'])]};
  await resolveSubmissionStockResponseV3(command,retrySummary,{client});
  assert.deepEqual(await readResolvedStockResponseV3(command,{client}),retrySummary.stockResults);
  await client.query('SAVEPOINT retry_identity_changed');
  await client.query("UPDATE submission_items SET status='FAILED',product_id='' WHERE id=$1",[stockItems[100].submissionItemId]);
  await assert.rejects(reprepareResolvedStockWriteV3(command,{client}),error=>error.code==='23514');
  await client.query('ROLLBACK TO SAVEPOINT retry_identity_changed');
  // Mutable job state cannot forge the receipt used to authorize a retry.
  await client.query("UPDATE submission_jobs SET result_summary='{}'::jsonb WHERE id=$1",[job]);
  await reprepareResolvedStockWriteV3(command,{client});
  assert.equal((await client.query('SELECT status FROM submission_stock_write_intents WHERE id=$1',[single])).rows[0].status,'PREPARED');
  await client.query("UPDATE submission_stock_write_intents SET status='IN_FLIGHT',in_flight_at=NOW() WHERE id=$1",[single]);
  await resolveSubmissionStockResponseV3(command,{stockResults:[outcome(stockItems[100],'SUCCEEDED')]},{client});
  const receipts=(await client.query("SELECT payload FROM submission_stock_write_events WHERE stock_write_intent_id=$1 AND to_status='RESOLVED' ORDER BY id",[single])).rows;
  assert.deepEqual(receipts.map(r=>r.payload.stockResults[0].status),['RETRYABLE','SUCCEEDED']);
  await client.query('SAVEPOINT replay_success');
  await assert.rejects(reprepareResolvedStockWriteV3(command,{client}),error=>error.code==='23514');
  await client.query('ROLLBACK TO SAVEPOINT replay_success');
  // A mixed response reuses frozen successful import rows, but cannot reopen its successful/unknown members.
  const mixedItems=stockItems.slice(98,100);const mixed=await insert(mixedItems);const mixedCommand=commandFor(mixedItems);
  await client.query("UPDATE submission_stock_write_intents SET status='IN_FLIGHT',in_flight_at=NOW() WHERE id=$1",[mixed]);
  for (const results of [
    [outcome(mixedItems[0],'RETRYABLE',['UNKNOWN_ERROR']),outcome(mixedItems[1],'RETRYABLE',['TOO_MANY_REQUESTS'])],
    [outcome(mixedItems[0],'RETRYABLE',['TOO_MANY_REQUESTS'])],
    [outcome(mixedItems[0],'RETRYABLE',['TOO_MANY_REQUESTS']),outcome(mixedItems[0],'RETRYABLE',['TOO_MANY_REQUESTS'])],
    [{...outcome(mixedItems[0],'RETRYABLE',['TOO_MANY_REQUESTS']),updated:true},outcome(mixedItems[1],'UNKNOWN')],
  ]) {
    await client.query('SAVEPOINT invalid_receipt');
    await assert.rejects(resolveSubmissionStockResponseV3(mixedCommand,{stockResults:results},{client}),error=>error.code==='23514');
    await client.query('ROLLBACK TO SAVEPOINT invalid_receipt');
  }
  await resolveSubmissionStockResponseV3(mixedCommand,{stockResults:[outcome(mixedItems[0],'SUCCEEDED'),outcome(mixedItems[1],'RETRYABLE',['PRODUCT_HAS_NOT_BEEN_TAGGED_YET'])]},{client});
  await client.query('SAVEPOINT mixed_reset');
  await client.query("UPDATE submission_jobs SET result_summary=$2::jsonb WHERE id=$1",[job,JSON.stringify({stockResults:mixedItems.map(i=>outcome(i,'RETRYABLE',['TOO_MANY_REQUESTS']))})]);
  await assert.rejects(reprepareResolvedStockWriteV3(mixedCommand,{client}),error=>error.code==='23514');
  await client.query('ROLLBACK TO SAVEPOINT mixed_reset');
  const subset=await insert([mixedItems[1]]);
  await client.query("UPDATE submission_stock_write_intents SET status='IN_FLIGHT',in_flight_at=NOW() WHERE id=$1",[subset]);
  await resolveSubmissionStockResponseV3(commandFor([mixedItems[1]]),{stockResults:[outcome(mixedItems[1],'UNKNOWN')]},{client});
  await client.query('SAVEPOINT unknown_reset');
  await assert.rejects(reprepareResolvedStockWriteV3(commandFor([mixedItems[1]]),{client}),error=>error.code==='23514');
  await client.query('ROLLBACK TO SAVEPOINT unknown_reset');
  for(const scope of [{accountId:'other-account'},{stocks:[{...mixedItems[1],quantity:6}]},{stocks:[{...mixedItems[1],warehouseId:'other'}]}]){
    await assert.rejects(readResolvedStockResponseV3({...commandFor([mixedItems[1]]),...scope},{client}),error=>error.code==='LISTING_STOCK_WRITE_IDENTITY_CONFLICT');
  }
  await client.query('SAVEPOINT event_rewrite');
  await assert.rejects(client.query("UPDATE submission_stock_write_events SET payload='{}'::jsonb WHERE stock_write_intent_id=$1",[single]),error=>error.code==='23514');
  await client.query('ROLLBACK TO SAVEPOINT event_rewrite');
 } finally {await client.query('ROLLBACK');client.release();await pool.end();}
});
