import '../env.mjs';import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';import {readFile} from 'node:fs/promises';import {Pool} from 'pg';import {postgresConfig} from '../db/connection.mjs';import {authorizeDirectRfbsPhase} from '../listing-direct-rfbs.mjs';
test('migration123 freezes scoped RFBS evidence and supports direct worker authorization with existing event audit',{skip:process.env.SONLI_DIRECT_RFBS_POSTGRES_TESTS!=='1'},async()=>{
 assert.equal(process.env.SONLI_ENV_FILE,'/private/tmp/sonli-audit-test.env');
 const pool=new Pool(postgresConfig()),client=await pool.connect();const suffix=randomUUID();
 const account='rfbs-account-'+suffix,store='rfbs-store-'+suffix,warehouse='rfbs-warehouse-'+suffix,platform='1020005029861840';
 try{
  await client.query('BEGIN');await client.query("SET LOCAL lock_timeout='3s'");
  const migration=await readFile(new URL('../db/migrations/123_direct_listing_rfbs_evidence.sql',import.meta.url),'utf8');await client.query(migration);await client.query(migration);
  await client.query("INSERT INTO accounts(id,username,display_name,role,status) VALUES($1,$1,$1,'admin','active')",[account]);
  await client.query("INSERT INTO stores(id,label,company_name,client_id,status,owner_account_id) VALUES($1,$1,$1,$1,'active',$2)",[store,account]);
  await client.query("INSERT INTO warehouses(id,store_id,warehouse_id,warehouse_type,status) VALUES($1,$2,$3,'rfbs','active')",[warehouse,store,platform]);
  const receipt={accountId:account,storeId:store,warehouseRecordId:warehouse,platformWarehouseId:platform,fulfillmentType:'RFBS',outcome:'PASSED',evidenceHash:'a'.repeat(64),expiresAt:new Date(Date.now()+60000).toISOString()};
  const stocks=[{offer_id:'explicit-offer',warehouse_id:platform,stock:0}];
  const insert=async evidence=>{const id='rfbs-snapshot-'+randomUUID();await client.query(`INSERT INTO submission_snapshots(id,account_id,store_id,idempotency_key,snapshot_hash,item_count,items,stocks,direct_rfbs_evidence)
   VALUES($1,$2,$3,$1,$4,1,'[{"offer_id":"explicit-offer"}]'::jsonb,$5::jsonb,$6::jsonb)`,[id,account,store,'b'.repeat(64),JSON.stringify(stocks),JSON.stringify(evidence)]);return id;};
  for(const bad of [[],[{...receipt,accountId:'other'}],[{...receipt,storeId:'other'}],[{...receipt,warehouseRecordId:'other'}],[{...receipt,platformWarehouseId:'other'}],[{...receipt,expiresAt:new Date(0).toISOString()}],[receipt,receipt]]){
   await client.query('SAVEPOINT rejected');await assert.rejects(insert(bad),e=>e.code==='23514');await client.query('ROLLBACK TO SAVEPOINT rejected');
  }
  const disposable=await insert([receipt]);await client.query('DELETE FROM submission_snapshots WHERE id=$1',[disposable]);
  const snapshot=await insert([receipt]);
  await client.query('SAVEPOINT mutation');await assert.rejects(client.query("UPDATE submission_snapshots SET direct_rfbs_evidence='[]'::jsonb WHERE id=$1",[snapshot]),e=>e.code==='23514');await client.query('ROLLBACK TO SAVEPOINT mutation');
  const job='rfbs-job-'+suffix;await client.query("INSERT INTO submission_jobs(id,snapshot_id,account_id,store_id,type,status,item_count,correlation_id) VALUES($1,$2,$3,$4,'COLLECT_BOX_DRAFT','VALIDATING',1,$1)",[job,snapshot,account,store]);
  let verifications=0;const deps={pool:client,readCredential:async()=>({}),callOzonSellerApi:async()=>{throw Error('no external API in private fixture')},createVerifier:()=>({verifyRfbsWarehouse:async input=>{verifications++;assert.equal(input.accountId,account);assert.equal(input.targetStoreId,store);assert.equal(input.targetWarehouseId,warehouse);return receipt;}})};
  const work={id:job,account_id:account,store_id:store,snapshot_id:snapshot};
  assert.equal((await authorizeDirectRfbsPhase(work,'PRE_IMPORT',deps)).required,true);
  assert.equal(verifications,1);assert.equal((await client.query("SELECT COUNT(*)::int AS count FROM submission_events WHERE job_id=$1 AND event_type='submission.direct_rfbs_verified'",[job])).rows[0].count,1);
  await assert.rejects(authorizeDirectRfbsPhase({...work,snapshot_id:'other'},'PRE_IMPORT',deps),e=>e.code==='LISTING_RFBS_PHASE_SCOPE_INVALID');
  // Existing non-RFBS null snapshots remain unchanged by the migration.
  assert.ok((await client.query('SELECT direct_rfbs_evidence FROM submission_snapshots WHERE id=$1',[snapshot])).rows[0].direct_rfbs_evidence.length===1);
 }finally{await client.query('ROLLBACK');client.release();await pool.end();}
});
