import './support/dedicated-postgres-test-environment.mjs';
import test from 'node:test';import assert from 'node:assert/strict';import{readFile}from'node:fs/promises';import{randomUUID}from'node:crypto';import pg from'pg';
import{createAiListingRepository}from'../ai-listing-repository.mjs';
import{createAiListingService}from'../ai-listing-service.mjs';

test('existing PostgreSQL partial/unknown records move to deleted and restore idle without losing images or submission journals',
 {skip:process.env.SONLI_POSTGRES_TESTS!=='1',timeout:30000},async()=>{
 const admin=new pg.Pool({connectionString:process.env.DATABASE_URL}),schema='error_delete_'+randomUUID().replaceAll('-','');let pool;
 try{
  await admin.query(`CREATE SCHEMA ${schema}`);pool=new pg.Pool({connectionString:process.env.DATABASE_URL,options:`-c search_path=${schema}`,max:3});
  await pool.query("CREATE TABLE accounts(id text PRIMARY KEY);INSERT INTO accounts VALUES('owner'),('other')");
  for(const name of ['106_ai_image_listing.sql','135_ai_product_scheduling.sql','141_ai_listing_task_controls.sql','150_ai_listing_list_summary.sql','154_ai_listing_quota_result_summary.sql'])await pool.query(await readFile(new URL('../db/migrations/'+name,import.meta.url),'utf8'));
  await pool.query('CREATE TABLE ai_image_listing_submissions(id text PRIMARY KEY,account_id text,task_id text,body jsonb)');
  const repository=createAiListingRepository({pool});let effects=0;
  const dependencies={repository,clock:()=>10000,generateImage:async()=>{effects++;assert.fail('no generation');},submitListing:async()=>{effects++;assert.fail('no submission');},readSubmission:async()=>{effects++;assert.fail('no automatic reconciliation from deleted/restored error');}};
  let service=createAiListingService(dependencies);const saved=[];
  for(const [index,status] of ['GENERATION_FAILED','UPLOAD_FAILED','SUBMISSION_UNCERTAIN'].entries()){
   const id='historical-'+index,sku='sku-'+index;
   const body={sourceType:'COLLECT_BOX',sourceId:'source-'+index,source:{items:[{sku}]},sku,images:[{sku,index:0,status:'COMPLETED',generatedUrl:'https://saved.test/'+sku}],config:{targetStoreId:'original-store'},createdAt:1,updatedAt:1,submissionStarted:true,submissionExternalWriteStarted:true,submissionId:'journal-'+index,submissionResults:[{sku,offerId:'saved-offer-'+index,importStatus:index===2?'UNKNOWN':'SUCCEEDED',stockStatus:index===2?'PENDING':'COMPLETED'}]};
   const journal={status:index===2?'UNCERTAIN':'COMPLETED',results:body.submissionResults};
   await pool.query("INSERT INTO ai_image_listing_tasks(id,account_id,dedupe_key,status,body,next_run_at,created_at,work_phase) VALUES($1,'owner',$1,$2,$3,1,1,'idle')",[id,status,body]);
   await pool.query("INSERT INTO ai_image_listing_submissions VALUES($1,'owner',$2,$3)",['journal-'+index,id,journal]);saved.push({id,status,body,journal});
  }
  const page=await repository.listPage({accountId:'owner',group:'errors'});assert.equal(page.total,3);assert.ok(page.tasks.every(t=>t.taskActions.delete));
  const preview=await service.previewTaskAction({accountId:'owner',group:'errors',action:'delete'});assert.equal(preview.items.length,3);
  assert.equal((await service.batchTaskAction({accountId:'other',action:'delete',items:preview.items})).applied,0);
  assert.equal((await service.batchTaskAction({accountId:'owner',action:'delete',items:preview.items})).applied,3);
  assert.equal((await repository.listPage({accountId:'owner',group:'errors'})).total,0);
  const deleted=await repository.listPage({accountId:'owner',group:'deleted'});assert.equal(deleted.total,3);assert.ok(deleted.tasks.every(t=>t.taskActions.resume&&t.taskActions.permanentDelete));
  service=createAiListingService(dependencies);assert.equal(await service.processNext(),null);
  for(const original of saved){
   const task=await repository.get({accountId:'owner',taskId:original.id});assert.equal(task.workPhase,'idle');assert.equal(task.deletedAt,10000);
   for(const key of ['source','images','submissionId','submissionResults'])assert.deepEqual(task[key],original.body[key]);
   assert.deepEqual((await pool.query('SELECT body FROM ai_image_listing_submissions WHERE id=$1',[original.body.submissionId])).rows[0].body,original.journal);
  }
  const restore=await service.previewTaskAction({accountId:'owner',group:'deleted',action:'resume'});
  assert.equal((await service.batchTaskAction({accountId:'owner',action:'resume',items:restore.items})).applied,3);
  assert.equal((await repository.listPage({accountId:'owner',group:'errors'})).total,3);
  assert.equal((await repository.listPage({accountId:'owner',group:'deleted'})).total,0);
  for(const original of saved){const task=await repository.get({accountId:'owner',taskId:original.id});assert.equal(task.status,original.status);assert.equal(task.workPhase,'idle');assert.deepEqual(task.submissionResults,original.body.submissionResults);}
  assert.equal(await createAiListingService(dependencies).processNext(),null);assert.equal(effects,0);
 }finally{await pool?.end();await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();}
});
