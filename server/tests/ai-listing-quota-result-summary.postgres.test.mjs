import './support/dedicated-postgres-test-environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import pg from 'pg';
import {createAiListingRepository} from '../ai-listing-repository.mjs';

const enabled=process.env.SONLI_POSTGRES_TESTS==='1';
async function fixture(t){
  const admin=new pg.Pool({connectionString:process.env.DATABASE_URL});
  const schema='quota_result_'+randomUUID().replaceAll('-','');
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,options:`-c search_path=${schema}`,max:4});
  t.after(async()=>{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});
  await pool.query("CREATE TABLE accounts(id text PRIMARY KEY);INSERT INTO accounts VALUES('owner'),('other');CREATE TABLE account_ozon_routes(account_id text PRIMARY KEY,route text)");
  for(const name of ['106_ai_image_listing.sql','135_ai_product_scheduling.sql','141_ai_listing_task_controls.sql','150_ai_listing_list_summary.sql'])
    await pool.query(await readFile(new URL('../db/migrations/'+name,import.meta.url),'utf8'));
  return {pool,repository:createAiListingRepository({pool})};
}
async function applySummaryMigration(pool){
  await pool.query(await readFile(new URL('../db/migrations/154_ai_listing_quota_result_summary.sql',import.meta.url),'utf8'));
}

test('quota result summary counts created source SKUs and backfills only active projections without changing task data',
 {skip:!enabled},async t=>{
  const {pool,repository}=await fixture(t);
  const body={sku:'a',name:'historical variants',sourceType:'COLLECT_BOX',updatedAt:1000,
    config:{targetStoreId:'store',salePricingId:'price'},submissionStage:'prepared',
    source:{items:['a','a','b','c','d','skip'].map(sku=>({sku})),skuPricing:[{sku:'skip',status:'SKIPPED'}]},
    images:[{sku:'a',generatedUrl:'https://saved.test/a.jpg',status:'COMPLETED'}],
    submissionWait:{code:'DAILY_LIMIT',message:'remaining variants wait',retryAt:999999},
    submissionResults:[{sku:'a',importStatus:'SUCCEEDED',stockStatus:'PENDING'},
      {sku:'a',importStatus:'SUCCEEDED'},{sku:'b',isCreated:true},{sku:'c',productId:'456'},
      {sku:'d',stockStatus:'COMPLETED'},{sku:'skip',productId:987},{sku:'foreign',productId:'999'}]};
  const states=['QUEUED','COLLECTING','GENERATING','AWAITING_REVIEW','READY_TO_SUBMIT','SUBMITTING','SUBMITTED',
    'PAUSED','CANCELLED','COMPLETED','GENERATION_FAILED','SUBMISSION_FAILED','SUBMISSION_UNCERTAIN'];
  for(const status of states)await pool.query(`INSERT INTO ai_image_listing_tasks(id,account_id,dedupe_key,status,body,next_run_at,created_at,version)
    VALUES($1,'owner',$1,$1,$2,900000,1000,7)`,[status,body]);
  await pool.query(`INSERT INTO ai_image_listing_tasks(id,account_id,dedupe_key,status,body,next_run_at,created_at,deleted_at)
    VALUES('deleted','owner','deleted','GENERATING',$1,900000,1000,2000)`,[body]);
  const before=(await pool.query('SELECT id,to_jsonb(task) AS row FROM ai_image_listing_tasks task ORDER BY id')).rows;
  await applySummaryMigration(pool);
  const page=await repository.listPage({accountId:'owner',group:'active',limit:100});
  const active=page.tasks.find(row=>row.id==='SUBMITTED');
  assert.equal(active.createdSkuCount,3,'creation does not wait for stock completion or double-count duplicate / foreign SKUs');
  assert.equal(active.totalSkuCount,4,'pricing-skipped and repeated source SKUs are excluded');
  assert.deepEqual(active.submissionWait,body.submissionWait);
  const after=(await pool.query('SELECT id,to_jsonb(task) AS row FROM ai_image_listing_tasks task ORDER BY id')).rows;
  for(let index=0;index<before.length;index++){
    const old=before[index],current=after[index];
    const {list_summary:oldSummary,...oldTask}=old.row,{list_summary:newSummary,...newTask}=current.row;
    assert.deepEqual(newTask,oldTask,`${old.id}: no body, status, lease, version or schedule changes`);
    if(states.slice(0,7).includes(old.id)){
      assert.equal(newSummary.createdSkuCount,3);assert.equal(newSummary.totalSkuCount,4);
      const {submissionWait,createdSkuCount,totalSkuCount,...retained}=newSummary;
      assert.deepEqual(retained,oldSummary,'every existing projection field remains stable');
    }else assert.deepEqual(newSummary,oldSummary,`${old.id}: no history / paused / deleted backfill`);
  }
  const changed={...body,submissionWait:{code:'RESULT_UNKNOWN'},submissionResults:[{sku:'d',productId:'0'},{sku:'c',productId:'-2'},{sku:'b',productId:'bad'},{sku:'a',productId:123}]};
  await pool.query("UPDATE ai_image_listing_tasks SET body=$1 WHERE id='SUBMITTED'",[changed]);
  const refreshed=(await repository.listPage({accountId:'owner',group:'active',limit:100})).tasks.find(row=>row.id==='SUBMITTED');
  assert.equal(refreshed.createdSkuCount,1);assert.equal(refreshed.totalSkuCount,4);
  assert.deepEqual(refreshed.submissionWait,{code:'RESULT_UNKNOWN'});
 });

test('legacy unsubmitted generation quota waits can be claimed before their obsolete quota deadline without waking protected tasks',
 {skip:!enabled},async t=>{
  const {pool,repository}=await fixture(t);const now=10000;
  const base={accountId:'owner',status:'GENERATING',createdAt:1,nextRunAt:now+86400000,
    generationStage:'waiting_quota',quotaWait:{code:'DAILY_LIMIT',retryAt:now+86400000},
    source:{items:[{sku:'a'}]},images:[{sku:'a',status:'PENDING'}],config:{targetStoreId:'store'}};
  const cases=[
    ['submitted-id',{submissionId:'journal'}],['write-started',{submissionExternalWriteStarted:true}],
    ['other-wait',{generationStage:'waiting_channel'}],['paused',{status:'PAUSED'}],['cancelled',{status:'CANCELLED'}],
    ['failed',{status:'GENERATION_FAILED'}],['unknown',{status:'SUBMISSION_UNCERTAIN'}],
    ['control-pause',{}],['control-cancel',{}],['control-delete',{}],['deleted',{}],['leased',{}],
    ['recover',{}],['foreign-recover',{accountId:'other'}],
  ];
  for(const [id,patch] of cases)await repository.create({...base,...patch,id,dedupeKey:id});
  for(const action of ['pause','cancel','delete'])await pool.query('UPDATE ai_image_listing_tasks SET control_action=$2 WHERE id=$1',['control-'+action,action]);
  await pool.query("UPDATE ai_image_listing_tasks SET deleted_at=1 WHERE id='deleted'");
  await pool.query("UPDATE ai_image_listing_tasks SET lease_token='existing',lease_expires_at=$1 WHERE id='leased'",[now+60000]);
  const before=(await pool.query("SELECT body,next_run_at,version FROM ai_image_listing_tasks WHERE id='recover'")).rows[0];
  const claimed=await repository.claimNext({now,leaseMs:5000,leaseToken:'recovered',phase:'generate'});
  assert.equal(claimed?.id,'recover','old quota timestamp must not block image work after quota admission is removed');
  assert.equal(claimed.accountId,'owner');assert.equal(claimed.status,'GENERATING');
  const after=(await pool.query("SELECT body,next_run_at,version,lease_token FROM ai_image_listing_tasks WHERE id='recover'")).rows[0];
  assert.deepEqual(after.body,before.body,'claim leaves clearing stale wait to the leased service');
  assert.equal(after.next_run_at,before.next_run_at);assert.equal(after.version,before.version+1);assert.equal(after.lease_token,'recovered');
  const other=await repository.claimNext({now,leaseMs:5000,leaseToken:'other-recovered',phase:'generate'});
  assert.equal(other?.id,'foreign-recover');assert.equal(other.accountId,'other');
  assert.equal(await repository.claimNext({now,leaseMs:5000,leaseToken:'none',phase:'generate'}),null);
  const protectedRows=(await pool.query("SELECT id,lease_token FROM ai_image_listing_tasks WHERE id NOT IN ('recover','foreign-recover') ORDER BY id")).rows;
  for(const row of protectedRows)assert.equal(row.lease_token,row.id==='leased'?'existing':null,row.id);
 });
