import './support/dedicated-postgres-test-environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import pg from 'pg';

test('migration backfill and receipt triggers cover old-worker writes on both sides of installation',
  {skip:process.env.SONLI_POSTGRES_TESTS!=='1',timeout:15000},async()=>{
  const connectionString=process.env.DATABASE_URL;
  const schema=`daily_listing_concurrent_${randomUUID().replaceAll('-','')}`;
  const admin=new pg.Client({connectionString});await admin.connect();
  const clients=[];let migration,aiWriter,manualWriter,aiWrite,manualWrite;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    const connect=async()=>{
      const client=new pg.Client({connectionString,options:`-c search_path=${schema}`});
      await client.connect();clients.push(client);return client;
    };
    migration=await connect();aiWriter=await connect();manualWriter=await connect();
    await migration.query(`CREATE TABLE accounts(id text PRIMARY KEY);INSERT INTO accounts VALUES('owner');
      CREATE TABLE stores(id text PRIMARY KEY,owner_account_id text,label text);INSERT INTO stores VALUES('store','owner','店铺');
      CREATE TABLE ai_image_listing_tasks(id text PRIMARY KEY,account_id text,body jsonb);
      CREATE TABLE ai_image_listing_submissions(id text PRIMARY KEY,account_id text,task_id text,body jsonb);
      CREATE TABLE submission_jobs(id text PRIMARY KEY,account_id text,store_id text,snapshot_id text);
      CREATE TABLE submission_snapshots(id text PRIMARY KEY,stocks jsonb);
      CREATE TABLE submission_items(id text PRIMARY KEY,job_id text,offer_id text,product_id text);
      CREATE TABLE submission_category_recovery_item_results(account_id text,submission_job_id text,recovery_attempt_id text,submission_item_id text,product_id text,status text);
      CREATE TABLE submission_stock_write_intents(id text PRIMARY KEY,account_id text,submission_job_id text,store_id text,recovery_attempt_id text,stock_items jsonb);
      CREATE TABLE submission_stock_write_events(id bigserial PRIMARY KEY,account_id text,stock_write_intent_id text,submission_job_id text,to_status text,payload jsonb,created_at timestamptz DEFAULT STATEMENT_TIMESTAMP());`);
    const aiBody=productId=>({config:{targetStoreId:'store'},results:[{productId,offerId:`offer-${productId}`,importStatus:'SUCCEEDED',stockStatus:'COMPLETED'}]});
    await aiWriter.query("INSERT INTO ai_image_listing_submissions VALUES('before','owner','before',$1)",[aiBody('100')]);
    for(const [job,productId] of [['before','200'],['during','201']]){
      await manualWriter.query('INSERT INTO submission_snapshots VALUES($1,$2)',[job,JSON.stringify([{offer_id:job,warehouse_id:'1',stock:0}])]);
      await manualWriter.query("INSERT INTO submission_jobs VALUES($1,'owner','store',$1)",[job]);
      await manualWriter.query('INSERT INTO submission_items VALUES($1,$1,$1,$2)',[job,productId]);
      await manualWriter.query("INSERT INTO submission_stock_write_intents VALUES($1,'owner',$1,'store',NULL,$2)",[job,JSON.stringify([{submissionItemId:job,offerId:job,warehouseId:'1',quantity:0}])]);
    }
    const writeManual=job=>manualWriter.query("INSERT INTO submission_stock_write_events(account_id,stock_write_intent_id,submission_job_id,to_status,payload) VALUES('owner',$1,$1,'DONE','{}')",[job]);
    await writeManual('before');

    const sql=await readFile(new URL('../db/migrations/153_daily_listing_success.sql',import.meta.url),'utf8');
    const triggerInstallation=sql.indexOf('CREATE FUNCTION record_ai_listing_success()');
    assert.ok(triggerInstallation>0);
    await migration.query('BEGIN');
    await migration.query(sql.slice(0,triggerInstallation));
    // Deterministically pause after both historical reads, before either new
    // trigger is installed. These are existing worker SQL contracts.
    let aiSettled=false,manualSettled=false;
    aiWrite=aiWriter.query("INSERT INTO ai_image_listing_submissions VALUES('during','owner','during',$1)",[aiBody('101')]).finally(()=>{aiSettled=true;});
    manualWrite=writeManual('during').finally(()=>{manualSettled=true;});
    const deadline=Date.now()+2000;let aiBlocked=false,manualBlocked=false;
    while(Date.now()<deadline){
      const waits=(await admin.query('SELECT pid,wait_event_type FROM pg_stat_activity WHERE pid=ANY($1::int[])',[[aiWriter.processID,manualWriter.processID]])).rows;
      aiBlocked=waits.some(row=>row.pid===aiWriter.processID&&row.wait_event_type==='Lock');
      manualBlocked=waits.some(row=>row.pid===manualWriter.processID&&row.wait_event_type==='Lock');
      if((aiSettled||aiBlocked)&&(manualSettled||manualBlocked))break;
      await delay(10);
    }
    await migration.query(sql.slice(triggerInstallation));
    await migration.query('COMMIT');
    await Promise.all([aiWrite,manualWrite]);
    const rows=(await migration.query('SELECT product_id,succeeded_at FROM listing_successes ORDER BY product_id')).rows;
    assert.deepEqual(rows.map(row=>row.product_id),['100','101','200','201'],'a concurrent successful receipt must not fall between backfill and trigger installation');
    assert.equal(rows.find(row=>row.product_id==='100').succeeded_at,null,'old AI evidence remains undated');
    assert.ok(rows.filter(row=>row.product_id!=='100').every(row=>row.succeeded_at instanceof Date));
    assert.equal(aiBlocked,true);assert.equal(manualBlocked,true);
    assert.equal((await migration.query('SHOW lock_timeout')).rows[0].lock_timeout,'0','migration settings end at COMMIT');
    assert.equal((await migration.query('SHOW statement_timeout')).rows[0].statement_timeout,'0');
  } finally {
    await migration?.query('ROLLBACK').catch(()=>{});
    await Promise.allSettled([aiWrite,manualWrite].filter(Boolean));
    await Promise.allSettled(clients.map(client=>client.end()));
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();
  }
});
