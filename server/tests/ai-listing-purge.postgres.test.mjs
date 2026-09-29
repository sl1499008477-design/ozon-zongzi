import './support/dedicated-postgres-test-environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import pg from 'pg';
import {createSkuBilling} from '../ai-sku-billing.mjs';
import {createAiListingRepository} from '../ai-listing-repository.mjs';
import {createAiListingService} from '../ai-listing-service.mjs';
import {createAiListingPurge,AI_LISTING_PURGE_AFTER_MS} from '../ai-listing-purge.mjs';
import {updateCollectItemDraftWithClientV4} from '../listing-pipeline.mjs';
import {findCollectedSku} from '../collection-sku-rules.mjs';
import {purgeCollectedItems} from '../collection-purge.mjs';
import {persistPostgresStateAtomically} from '../postgres-state-transaction.mjs';
const enabled=process.env.SONLI_POSTGRES_TESTS==='1';
const generated=n=>`listing-media/v1/ai-image-listing/${String(n).repeat(64)}.jpg`;
const base='https://www.ozonzongzi.com/';

test('PostgreSQL permanent purge: boundary, CAS, recovery, source/media sharing and bill/SKU receipts',{skip:!enabled,timeout:60000},async t=>{
 assert.match(new URL(process.env.DATABASE_URL).pathname,/(qa|fixture|test)/i,'dedicated clone only');
 const admin=new pg.Pool({connectionString:process.env.DATABASE_URL}),schema='purge_'+randomUUID().replaceAll('-','');let pool;
 try{
  await admin.query(`CREATE SCHEMA ${schema}`);
  pool=new pg.Pool({connectionString:process.env.DATABASE_URL,options:`-c search_path=${schema}`,max:5});
  await pool.query("CREATE TABLE accounts(id TEXT PRIMARY KEY,role TEXT DEFAULT 'user'); INSERT INTO accounts(id) VALUES('a'),('b')");
  for(const name of ['106_ai_image_listing.sql','135_ai_product_scheduling.sql','141_ai_listing_task_controls.sql','150_ai_listing_list_summary.sql','107_ai_image_listing_submissions.sql','140_collector_ai_sku_owners.sql','145_ai_listing_purge_indexes.sql','146_ai_listing_source_reference_indexes.sql'])await pool.query(await readFile(new URL('../db/migrations/'+name,import.meta.url),'utf8'));
  await pool.query("CREATE TABLE account_ozon_routes(account_id TEXT PRIMARY KEY REFERENCES accounts(id),route TEXT,revision INTEGER DEFAULT 1,updated_at TIMESTAMPTZ DEFAULT NOW());ALTER TABLE ai_image_listing_tasks ADD COLUMN billable BOOLEAN DEFAULT TRUE");
  for(const name of ['collect_items','product_drafts','product_draft_revisions','product_draft_variants','collect_raw_payloads','collector_media_uploads','submission_snapshots','products','collector_task_items','collector_ozon_enrichment_jobs','collector_ozon_enrichment_task_controls','collector_ozon_enrichment_cache','collect_requests','local_state','ai_wallet_entries','ai_user_channel_requests','ai_task_billing','ai_user_wallets'])await pool.query(`CREATE TABLE ${name} (LIKE public.${name} INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING INDEXES)`);
  await pool.query(`ALTER TABLE product_drafts ADD FOREIGN KEY(collect_item_id) REFERENCES collect_items(id) ON DELETE CASCADE`);
  await pool.query('ALTER TABLE ai_wallet_entries ADD FOREIGN KEY(task_id) REFERENCES ai_image_listing_tasks(id)');
  let now=AI_LISTING_PURGE_AFTER_MS+1000,calls=[],failKey=null;
  const repository=createAiListingRepository({pool}),service=createAiListingService({repository,clock:()=>now});
  const storage={deleteObjectVersions:async({key})=>{calls.push(key);if(key===failKey)throw new Error('synthetic COS failure');return {deletedVersions:1};}};
  const worker=()=>createAiListingPurge({pool,storage,publication:{baseUrl:base,prefix:'listing-media/v1'},clock:()=>now,maxObjects:10000});
  async function seed(id,{deletedAt=1000,sourceId=null,images=[],status='CANCELLED',accountId='a',extra={}}={}){
   const source=sourceId?{collectItemId:sourceId,items:[{sku:id,images:[],listingItem:{}}]}:null;
   const task={id,accountId,dedupeKey:id,status,createdAt:1,nextRunAt:0,sourceType:'COLLECT_BOX',sourceId,sku:id,name:id,images,source,config:{prompt:'private prompt'},stoppedFrom:'GENERATING',updatedAt:1,...extra};
   await repository.create(task);await pool.query('UPDATE ai_image_listing_tasks SET deleted_at=$2,work_phase=\'idle\' WHERE id=$1',[id,deletedAt]);
   if(sourceId)await pool.query('INSERT INTO collect_items(id,account_id,source_sku,source,summary) VALUES($1,$2,$3,\'ozon\',\'{}\') ON CONFLICT DO NOTHING',[sourceId,accountId,id]);
   return {accountId,taskId:id,expectedVersion:1};
  }
  await t.test('accepted cleanup leaves deleted pagination immediately, remains durable and scoped, and failures return for retry',async()=>{
   const ids=['bg-normal-1','bg-normal-2','bg-normal-3','bg-pending','bg-running','bg-failed','bg-done','bg-foreign'];
   for(const id of ids)await seed(id,{deletedAt:now,accountId:id==='bg-foreign'?'b':'a',extra:{mediaJournalVersion:1,
    ...(id==='bg-done'?{permanentlyDeletedAt:now}:{}),
    ...(!id.startsWith('bg-normal')?{purge:{state:id==='bg-running'?'RUNNING':id==='bg-failed'?'FAILED':id==='bg-done'?'COMPLETED':'PENDING',requestedAt:now,errorMessage:'COS temporarily unavailable'}}:{})}});
   try{
    const page=await repository.listPage({accountId:'a',group:'deleted',limit:2});
    assert.equal(page.total,4);assert.equal(page.counts.deleted,4);assert.equal(page.counts.purging,2);assert.equal(page.tasks.length,2);
    const next=await repository.listPage({accountId:'a',group:'deleted',limit:2,offset:2});
    const rows=[...page.tasks,...next.tasks];assert.deepEqual(rows.map(row=>row.id).sort(),['bg-failed','bg-normal-1','bg-normal-2','bg-normal-3']);
    assert.equal(rows.find(row=>row.id==='bg-failed').purge.errorMessage,'COS temporarily unavailable');
    const accepted=await repository.get({accountId:'a',taskId:'bg-pending'});assert.equal(accepted.purge.state,'PENDING');
    await assert.rejects(service.resumeTask({accountId:'a',taskId:accepted.id,expectedVersion:accepted.version}),{statusCode:409});
    const other=await repository.listPage({accountId:'b',group:'deleted'});assert.equal(other.total,0);assert.equal(other.counts.purging,1);
    await pool.query(`UPDATE ai_image_listing_tasks SET body=jsonb_set(body,'{purge,state}','"FAILED"'),version=version+1 WHERE id='bg-pending'`);
    const failed=await repository.listPage({accountId:'a',group:'deleted'});assert.equal(failed.total,5);assert.equal(failed.counts.purging,1);
    const retry=failed.tasks.find(row=>row.id==='bg-pending');assert.equal(retry.taskActions.permanentDelete,true);
    await service.permanentlyDeleteTask({accountId:'a',taskId:retry.id,expectedVersion:retry.version});
    assert.equal((await repository.listPage({accountId:'a',group:'deleted'})).total,4);
   }finally{await pool.query('DELETE FROM ai_image_listing_tasks WHERE id=ANY($1::text[])',[ids]);}
  });
  await t.test('historical zero-reservation cleanup preserves unbilled evidence without charging and retains live Ozon media',async()=>{
   const billing=createSkuBilling({pool});
   await pool.query("INSERT INTO ai_user_wallets(account_id,balance_cents,reserved_cents,sku_price_cents) VALUES('a',100,0,20)");
   for(const [n,stoppedFrom,successCount,chargedCount] of [[61,'GENERATING',2,1],[62,'SUBMISSION_FAILED',1,0],[63,'GENERATION_FAILED',2,2],[64,'UPLOAD_FAILED',1,1]]){
    calls=[];const id='history-'+n,key=i=>'listing-media/v1/ai-image-listing/'+createHash('sha256').update(id+'-'+i).digest('hex')+'.jpg',skus=Array.from({length:successCount},(_,i)=>id+'-'+i);
    const images=skus.map((sku,i)=>({sku,index:0,status:'COMPLETED',generatedUrl:base+key(i)}));
    const results=stoppedFrom==='GENERATING'?[]:[{sku:skus[0],offerId:'offer-'+id,productId:123,importStatus:'SUCCEEDED',stockStatus:n===62?'FAILED':'COMPLETED'}];
    const input=await seed(id,{deletedAt:now,images,extra:{mediaJournalVersion:1,stoppedFrom,submissionId:results.length?'journal-'+id:null,submissionStarted:!!results.length,submissionResults:results}});
    await pool.query('INSERT INTO ai_task_billing(task_id,account_id,unit_cents,reserved_cents) VALUES($1,$2,20,0)',[id,'a']);
    for(const sku of skus.slice(0,chargedCount))await pool.query("INSERT INTO ai_wallet_entries(id,account_id,task_id,sku,kind,amount_cents) VALUES($1,'a',$2,$3,'SKU_CHARGE',-20)",[sku,id,sku]);
    if(results.length)await pool.query("INSERT INTO ai_image_listing_submissions(id,account_id,task_id,idempotency_key,body) VALUES($1,'a',$2,$1,$3)",['journal-'+id,id,JSON.stringify({status:n===62?'FAILED':'COMPLETED',attempts:[{status:'DONE'}],results,items:[{offer_id:'offer-'+id,images:[base+key(0)]}]})]);
    const before=(await pool.query("SELECT * FROM ai_wallet_entries WHERE task_id=$1 ORDER BY sku",[id])).rows;
    const accepted=await service.permanentlyDeleteTask(input);assert.equal(accepted.purge.state,'PENDING');
    const job=()=>createAiListingPurge({pool,storage,publication:{baseUrl:base},reconcileBilling:input=>billing.reconcile(input),clock:()=>now,maxObjects:10000});
    assert.equal((await job().sweep()).state,'COMPLETED');
    const saved=await repository.get(input);assert.ok(saved.permanentlyDeletedAt);
    assert.deepEqual((await pool.query("SELECT * FROM ai_wallet_entries WHERE task_id=$1 ORDER BY sku",[id])).rows,before,'cleanup never invents a second or unreserved charge');
    assert.equal((await pool.query("SELECT balance_cents::int n FROM ai_user_wallets WHERE account_id='a'")).rows[0].n,100);
    if(successCount>chargedCount){assert.deepEqual(saved.purge.billingReview[0].skus,skus.slice(chargedCount));assert.equal(saved.purge.billingReview[0].unitCents,20);}
    else assert.deepEqual(saved.purge.billingReview,[]);
    if(results.length){assert.equal(calls.includes(key(0)),false);assert.equal(saved.submissionResults[0].importStatus,'SUCCEEDED');}
    else assert.ok(calls.includes(key(0)));
    assert.equal(await job().sweep(),null,'restart cannot repeat completed cleanup or billing');
   }
   const unknown=await seed('history-unknown',{deletedAt:now,extra:{stoppedFrom:'SUBMISSION_UNCERTAIN',submissionId:'unknown',submissionStarted:true}});
   await service.permanentlyDeleteTask(unknown);await worker().sweep();assert.ok((await repository.get(unknown)).permanentlyDeletedAt);
   await pool.query("DELETE FROM ai_image_listing_tasks WHERE id='history-unknown'");
  });
  await t.test('restore before 15 days cancels due cleanup; redeletion restarts clock and owner/version checks fence the intent',async()=>{
   const input=await seed('boundary',{deletedAt:1001});
   assert.equal(await worker().sweep(),null);assert.equal(calls.length,0);
   await assert.rejects(service.permanentlyDeleteTask({...input,accountId:'b'}),{statusCode:404});
   const restored=await service.resumeTask(input);assert.equal(restored.deletedAt,null);
   const deleted=await service.deleteTask({...input,expectedVersion:restored.version});assert.equal(deleted.deletedAt,now);
   await assert.rejects(service.permanentlyDeleteTask(input),{statusCode:409});
   const accepted=await service.permanentlyDeleteTask({...input,expectedVersion:deleted.version});assert.equal(accepted.purge.state,'PENDING');
   await assert.rejects(service.resumeTask({...input,expectedVersion:accepted.version}),{statusCode:409});
   assert.equal(await repository.restoreDeleted({task:{...(await repository.get(input)),status:'PAUSED',deletedAt:null},expectedVersion:accepted.version,now}),null);
   await worker().sweep();await assert.rejects(service.getTask({...input,includeDeleted:true}),{statusCode:404});
  });
  await t.test('concurrent restore and purge intent have one winner; admission rejects a source already being purged',async()=>{
   const input=await seed('race',{deletedAt:now,sourceId:'source-race'});
   const results=await Promise.allSettled([service.permanentlyDeleteTask(input),service.resumeTask(input)]);
   assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.find(r=>r.status==='rejected').reason.statusCode,409);
   const row=await repository.get(input);
   if(row.purge){
    await assert.rejects(repository.create({id:'racing-new',accountId:'a',dedupeKey:'racing-new',status:'QUEUED',sourceId:'source-race',source:null,images:[],createdAt:now,nextRunAt:now}),{code:'AI_LISTING_TASK_CONFLICT'});
    await worker().sweep();
   }else{assert.equal(row.deletedAt,null);assert.equal(row.status,'PAUSED');}
  });
  await t.test('exact fifteen day boundary runs, persists partial failure and resumes after worker restart',async()=>{
   const input=await seed('restart',{images:[{generatedUrl:base+generated(1)},{generatedUrl:base+generated(2)}]});
   failKey=generated(2);await assert.rejects(worker().sweep(),/synthetic COS failure/);
   let saved=await repository.get(input);assert.equal(saved.purge.state,'FAILED');assert.ok(saved.purge.objects.find(o=>o.key===generated(1)&&o.state==='DELETED'));
   assert.equal((await repository.listPage({accountId:'a',group:'deleted'})).tasks.find(row=>row.id==='restart').purge.state,'FAILED');
   const first=calls.filter(key=>key===generated(1)).length;failKey=null;
   await service.permanentlyDeleteTask({...input,expectedVersion:saved.version});await worker().sweep();
   saved=await repository.get(input);assert.ok(saved.permanentlyDeletedAt);assert.equal(calls.filter(key=>key===generated(1)).length,first);
   assert.equal(saved.source,undefined);assert.equal(saved.images,undefined);assert.equal(saved.config,undefined);
   assert.equal((await repository.listPage({accountId:'a',group:'deleted'})).tasks.some(row=>row.id==='restart'),false);
   await assert.rejects(service.resumeTask({...input,expectedVersion:saved.version}),{statusCode:404});
  });
  await t.test('shared cross-account rich content and partial successful submission media survive; source and billing/SKU receipt survive correctly',async()=>{
   calls=[];const input=await seed('shared',{sourceId:'collect-shared',images:[{generatedUrl:base+generated(3)},{generatedUrl:base+generated(4)},{generatedUrl:base+generated(5)}],extra:{stoppedFrom:'SUBMISSION_FAILED',submissionId:'submission-shared',submissionResults:[{sku:'shared',offerId:'offer',importStatus:'SUCCEEDED'}]}});
   await seed('other',{accountId:'b',deletedAt:null,status:'PAUSED',extra:{source:{items:[{listingItem:{richContent:JSON.stringify({html:`<img src="${base+generated(3)}" />`})}}]}}});
   await pool.query(`INSERT INTO ai_image_listing_submissions(id,account_id,task_id,idempotency_key,body) VALUES('submission-shared','a','shared','submission-shared',$1)`,[JSON.stringify({results:[{sku:'shared',offerId:'offer',importStatus:'SUCCEEDED'}],attempts:[{status:'DONE'}],items:[{offer_id:'offer',images:[base+generated(4)]},{offer_id:'failed',images:[base+generated(5)]}]})]);
   await pool.query("INSERT INTO ai_wallet_entries(id,account_id,task_id,sku,kind,amount_cents) VALUES('bill','a','shared','shared','SKU_CHARGE',-123)");
   await worker().sweep();
   assert.equal(calls.includes(generated(3)),false);assert.equal(calls.includes(generated(4)),false);assert.equal(calls.includes(generated(5)),true);
   assert.equal((await pool.query("SELECT count(*)::int n FROM collect_items WHERE id='collect-shared'")).rows[0].n,0);
   assert.equal((await pool.query("SELECT b.amount_cents::int FROM ai_wallet_entries b JOIN ai_image_listing_tasks t ON t.id=b.task_id AND t.account_id=b.account_id WHERE b.id='bill'")).rows[0].amount_cents,-123);
   assert.equal((await findCollectedSku(pool,'a','shared')).collectionState,'LISTED');
   assert.equal((await repository.get(input)).purge.retainedObjects,2);
   const submission=(await pool.query("SELECT body FROM ai_image_listing_submissions WHERE id='submission-shared'")).rows[0].body;assert.equal(submission.items.length,1);assert.equal(submission.items[0].offer_id,'offer');
  });
  await t.test('a shared collected product and unselected sibling SKUs are retained',async()=>{
   const input=await seed('source-owner',{sourceId:'source-shared'});
   await seed('source-other',{deletedAt:null,status:'PAUSED',extra:{source:{collectItemId:'source-shared',items:[{sku:'source-other'}]}}});
   await worker().sweep();assert.equal((await repository.get(input)).purge.retainedSources,1);
   assert.equal((await pool.query("SELECT count(*)::int n FROM collect_items WHERE id='source-shared'")).rows[0].n,1);
   const sibling=await seed('sibling',{sourceId:'source-sibling'});
   await pool.query("INSERT INTO product_drafts(id,collect_item_id,data_hash,data) VALUES('draft','source-sibling','fixture',$1)",[JSON.stringify({variants:[{sku:'sibling'},{sku:'unrelated'}]})]);
   await pool.query("UPDATE collect_items SET current_draft_id='draft' WHERE id='source-sibling'");
   await worker().sweep();assert.equal((await repository.get(sibling)).purge.retainedSources,1);
  });
  await t.test('pre-PUT media journal survives a stale worker checkpoint and is deleted even without image results',async()=>{
   calls=[];const input=await seed('journal',{deletedAt:null,status:'GENERATING',extra:{mediaJournalVersion:1}});
   const stale=await repository.get(input);
   await repository.recordMediaKey({accountId:'a',taskId:'journal',key:generated(8)});
   const saved=await repository.save({task:stale,expectedVersion:stale.version,now});assert.deepEqual(saved.mediaKeys,[generated(8)]);
   await repository.recordMediaKey({accountId:'a',taskId:'journal',key:generated('b')});
   const deleted=await repository.requestControl({task:{...saved,status:'CANCELLED',deletedAt:now},action:'delete',expectedVersion:saved.version,now});
   assert.deepEqual(deleted.mediaKeys,[generated(8),generated('b')]);
   await service.permanentlyDeleteTask({...input,expectedVersion:deleted.version});await worker().sweep();
   assert.ok(calls.includes(generated(8)));assert.ok((await repository.get(input)).permanentlyDeletedAt);
  });
  await t.test('historical missing inventory leaves a review receipt without blocking permanent deletion',async()=>{
   const input=await seed('legacy-orphan',{sourceId:'legacy-source',images:[{status:'UPLOAD_FAILED',attempts:1,generatedUrl:null,lastError:{code:'AI_LISTING_STORAGE_FAILED'}}]});
   await worker().sweep();const row=await repository.get(input);
   assert.ok(row.permanentlyDeletedAt);assert.equal(row.purge.mediaReview[0].taskId,input.taskId);
   assert.equal((await pool.query("SELECT count(*)::int n FROM collect_items WHERE id='legacy-source'")).rows[0].n,0);
  });
  await t.test('unknown submissions allow manual and fifteen-day purge while retaining journal, media and ownership',async()=>{
   for(const manual of [true,false]){
    const id='unknown-'+manual,key=generated(manual?'1':'2');calls=[];
    const input=await seed(id,{deletedAt:manual?now:1000,images:[{generatedUrl:base+key}],extra:{mediaJournalVersion:1,stoppedFrom:'SUBMISSION_UNCERTAIN',submissionId:id,submissionStarted:true}});
    const journal={status:'UNCERTAIN',attempts:[{status:'UNCERTAIN',offerIds:['offer-'+id]}],items:[{offer_id:'offer-'+id,images:[base+key]}],results:[{sku:id,offerId:'offer-'+id,importStatus:'UNKNOWN'}]};
    await pool.query("INSERT INTO ai_image_listing_submissions(id,account_id,task_id,idempotency_key,body) VALUES($1,'a',$1,$1,$2)",[id,JSON.stringify(journal)]);
    await pool.query("INSERT INTO collector_ai_sku_owners(account_id,source_sku,task_id) VALUES('a',$1,$1)",[id]);
    if(manual)await service.permanentlyDeleteTask(input);
    assert.equal((await worker().sweep()).state,'COMPLETED');
    assert.equal(calls.includes(key),false);assert.equal((await pool.query('SELECT count(*)::int n FROM collector_ai_sku_owners WHERE task_id=$1',[id])).rows[0].n,1);const row=await repository.get(input);
    assert.ok(row.permanentlyDeletedAt);assert.deepEqual(row.purge.retainedSubmissionTaskIds,[id]);
    assert.deepEqual((await pool.query('SELECT body FROM ai_image_listing_submissions WHERE id=$1',[id])).rows[0].body,journal);
    assert.equal((await repository.listPage({accountId:'a',group:'deleted'})).tasks.some(t=>t.id===id),false);
    await assert.rejects(service.resumeTask({...input,expectedVersion:row.version}),{statusCode:404});
   }
  });
  await t.test('failed channel attempts prove no publication return while a saved paid result recovers historical keys',async()=>{
   const failed=await seed('legacy-before-upload',{images:[{status:'GENERATING',attempts:1,requestKey:'request-before',activeAttemptId:'attempt',generatedUrl:null}]});
   await pool.query("INSERT INTO ai_user_channel_requests(id,account_id,channel_id,task_id,request_key,status) VALUES('request-before','a','channel','legacy-before-upload','request-before:attempt','FAILED')");
   await worker().sweep();assert.ok((await repository.get(failed)).permanentlyDeletedAt);
   const recovered=await seed('legacy-spool',{images:[{status:'GENERATING',attempts:1,requestKey:'request-spool',generatedUrl:null}]});
   const recovery=createAiListingPurge({pool,storage,publication:{baseUrl:base,prefix:'listing-media/v1'},clock:()=>now,
    recoverLegacyMediaKeys:async({task,images})=>{assert.equal(task.id,'legacy-spool');assert.equal(images.length,1);return [generated(9)];}});
   await recovery.sweep();assert.ok(calls.includes(generated(9)));assert.ok((await repository.get(recovered)).permanentlyDeletedAt);
  });
  await t.test('verified historical inventory is not a purge intent and still waits for manual request or fifteen days',async()=>{
   const input=await seed('audited',{deletedAt:now,images:[{status:'GENERATING',attempts:1,generatedUrl:null}],extra:{legacyMediaInventoryVerifiedAt:now,mediaKeys:[generated('a')]}});
   assert.equal(await worker().sweep(),null);assert.equal((await repository.get(input)).purge,undefined);
   await service.permanentlyDeleteTask(input);await worker().sweep();assert.ok((await repository.get(input)).permanentlyDeletedAt);assert.ok(calls.includes(generated('a')));
  });
  await t.test('escaped nested rich-content references remain usable across accounts',async()=>{
   calls=[];await seed('escaped-owner',{images:[{generatedUrl:base+generated('c')}]});
   const rich=JSON.stringify({src:base+generated('c')}).replaceAll('/','\\/');
   await seed('escaped-reader',{accountId:'b',deletedAt:null,status:'PAUSED',extra:{source:{items:[{listingItem:{richContent:rich}}]}}});
   await worker().sweep();assert.equal(calls.includes(generated('c')),false);
  });
  await t.test('a retry-reset PENDING historical image still requires its prior successful request inventory',async()=>{
   const input=await seed('reset-legacy',{images:[{status:'PENDING',attempts:0,activeAttemptId:null,requestKey:'reset-request',generatedUrl:null}]});
   await pool.query("INSERT INTO ai_user_channel_requests(id,account_id,channel_id,task_id,request_key,status) VALUES('reset-old','a','channel','reset-legacy','reset-request:old','SUCCEEDED')");
   await worker().sweep();assert.ok((await repository.get(input)).permanentlyDeletedAt);assert.equal((await repository.get(input)).purge.mediaReview[0].taskId,input.taskId);
  });
  await t.test('source row is frozen before COS deletion so concurrent real draft writer cannot add sibling media',async()=>{
   const input=await seed('freeze',{sourceId:'source-freeze',images:[{generatedUrl:base+generated(6)}]});
   let checked=false;
   const freezingWorker=createAiListingPurge({pool,publication:{baseUrl:base,prefix:'listing-media/v1'},clock:()=>now,maxObjects:10000,
    storage:{deleteObjectVersions:async()=>{
     const client=await pool.connect();try{
      await client.query('BEGIN');
      assert.ok((await client.query("SELECT deleted_at FROM collect_items WHERE id='source-freeze'")).rows[0].deleted_at);
      const edited=await updateCollectItemDraftWithClientV4(client,{accountId:'a',collectItemId:'source-freeze',patch:{listingDraft:{variants:[{sku:'freeze'},{sku:'unrelated',images:[base+generated(6)]}]}}});
      assert.equal(edited,null);await client.query('COMMIT');checked=true;
     }finally{client.release();}
     return {deletedVersions:1};
    }}});
   await freezingWorker.sweep();assert.equal(checked,true);assert.ok((await repository.get(input)).permanentlyDeletedAt);
  });
  await t.test('proven merged aliases are scrubbed with canonical task and do not retain its source or media',async()=>{
   calls=[];const input=await seed('canonical',{sourceId:'source-merged',images:[{generatedUrl:base+generated(7)}],extra:{importBatchId:'batch'}});
   await seed('alias',{status:'MERGED',deletedAt:null,extra:{importBatchId:'batch',mergedTaskId:'canonical',source:{collectItemId:'source-merged',items:[{sku:'canonical'}]},images:[{generatedUrl:base+generated(7)}]}});
   await worker().sweep();assert.ok(calls.includes(generated(7)));assert.equal((await repository.get(input)).purge.retainedSources,0);
   const alias=await repository.get({accountId:'a',taskId:'alias'});assert.ok(alias.permanentlyDeletedAt);assert.equal(alias.source,undefined);assert.equal(alias.images,undefined);assert.equal(alias.config,undefined);
   await assert.rejects(service.getTask({accountId:'a',taskId:'alias',includeDeleted:true}),{statusCode:404});
  });
  await t.test('completed cleanup releases unlisted automatic SKU owners and allows a fresh collection handoff',async()=>{
   const input=await seed('old-auto',{extra:{sourceType:'EXCEL',sourceId:'fresh-sku',submissionResults:[{sku:'already-imported',offerId:'old-offer',importStatus:'SUCCEEDED'}]}});
   await pool.query("INSERT INTO collector_ai_sku_owners(account_id,source_sku,task_id) VALUES('a','fresh-sku','old-auto'),('a','already-imported','old-auto')");
   await worker().sweep();
   const owners=await repository.readCollectorAutomaticOwners({accountId:'a',skus:['fresh-sku','already-imported']});
   assert.equal(owners.has('fresh-sku'),false);assert.equal(owners.get('already-imported').id,'old-auto');
   assert.equal((await findCollectedSku(pool,'a','already-imported')).collectionState,'LISTED');
   const fresh=createAiListingService({repository,clock:()=>now,loadSources:async()=>[{collectItemId:'new-collect',sourceSnapshot:{source:'ozon'},items:[{sku:'fresh-sku',images:['https://external.invalid/image.jpg'],listingItem:{weight:100,depth:100,width:100,height:100}}]}]});
   const handoff=await fresh.createFromCollectorRun({accountId:'a',runId:'new-run',groups:[{groupId:'g',collectItemId:'new-collect',skus:['fresh-sku']}],config:{targetStoreId:'store',targetWarehouseId:'warehouse'}});
   assert.equal(handoff.tasks.length,1);assert.notEqual(handoff.tasks[0].id,input.taskId);assert.equal(handoff.tasks[0].status,'QUEUED');
  });
  await t.test('failed historical retries cannot starve new manual and fifteen-day cleanup',async()=>{
   const oldIds=[];
   for(let i=0;i<21;i++){
    const id='fair-failed-'+i;oldIds.push(id);
    await seed(id,{deletedAt:0,extra:{mediaJournalVersion:1,purge:{state:'FAILED',requestedAt:1,nextAttemptAt:i+1}}});
   }
   const automatic=await seed('fair-automatic',{extra:{mediaJournalVersion:1}});
   const manual=await seed('fair-manual',{deletedAt:now,extra:{mediaJournalVersion:1}});
   await service.permanentlyDeleteTask(manual);
   assert.equal((await worker().sweep()).taskId,manual.taskId);
   assert.equal((await worker().sweep()).taskId,automatic.taskId);
   assert.equal((await worker().sweep()).taskId,oldIds[0]);
   await pool.query('DELETE FROM ai_image_listing_tasks WHERE id=ANY($1::text[])',[oldIds]);
  });
  await t.test('active cleanup is visible before billing or historical media lookup begins',async()=>{
   const input=await seed('visible-running',{extra:{mediaJournalVersion:1}});
   await service.permanentlyDeleteTask(input);
   const active=createAiListingPurge({pool,storage,clock:()=>now,reconcileBilling:async()=>{
    assert.equal((await repository.get(input)).purge.state,'RUNNING');
   }});
   await active.sweep();assert.ok((await repository.get(input)).permanentlyDeletedAt);
  });
  await t.test('source cleanup preserves unrelated mirror data, invalidates stale hydrated snapshots and removes only matching account entries',async()=>{
   const mirror={currentAccountId:'a',caches:{collectBox:[{id:'keep',sku:'keep'},{id:'mirror-remove',sku:'mirror-sku',accountId:'b'}],other:{keep:true}}};
   await pool.query('INSERT INTO local_state(id,state,version) VALUES($1,$2,7)',['local-state',mirror]);
   const before=(await pool.query("SELECT version,updated_at FROM local_state WHERE id='local-state'")).rows[0];
   const purge=async id=>{
    const client=await pool.connect();try{await client.query('BEGIN');await purgeCollectedItems(client,'a',[id]);await client.query('COMMIT');}catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
   };
   await pool.query("INSERT INTO collect_items(id,account_id,source_sku,source,summary) VALUES('mirror-absent','a','absent','ozon','{}')");
   await purge('mirror-absent');
   const unchanged=(await pool.query("SELECT state,version FROM local_state WHERE id='local-state'")).rows[0];
   assert.deepEqual(unchanged.state,mirror);assert.equal(Number(unchanged.version),Number(before.version)+1);
   const stale={...mirror,caches:{collectBox:[{id:'mirror-absent',sku:'absent'}]},__storageVersion:before.version};
   const client=await pool.connect();try{
    await assert.rejects(persistPostgresStateAtomically({client,table:'local_state',state:stale,protectedState:stale,
     mirror:async()=>assert.fail('a stale hydrated snapshot must not repopulate formal product tables')}),{code:'LOCAL_STATE_VERSION_CONFLICT'});
   }finally{client.release();}
   mirror.caches.collectBox.push({id:'mirror-remove',sku:'mirror-sku'},{id:'variant-entry',sku:'variant-sku',accountId:'a'});
   await pool.query("UPDATE local_state SET state=$1 WHERE id='local-state'",[mirror]);
   await pool.query("INSERT INTO collect_items(id,account_id,source_sku,source,summary) VALUES('mirror-remove','a','mirror-sku','ozon','{}')");
   await pool.query("INSERT INTO product_drafts(id,collect_item_id,data_hash,data) VALUES('mirror-draft','mirror-remove','fixture',$1)",[JSON.stringify({variants:[{sku:'variant-sku'}],images:['large unrelated image metadata']})]);
   await pool.query("UPDATE collect_items SET current_draft_id='mirror-draft' WHERE id='mirror-remove'");
   await purge('mirror-remove');
   const after=(await pool.query("SELECT state,version FROM local_state WHERE id='local-state'")).rows[0];
   assert.deepEqual(after.state,{...mirror,caches:{...mirror.caches,collectBox:mirror.caches.collectBox.slice(0,2)}});
   assert.equal(Number(after.version),9);
  });
  await t.test('recovered historical ownership survives a failure before source freeze and is not reconstructed twice',async()=>{
   const input=await seed('inventory-checkpoint',{images:[{status:'UPLOAD_FAILED',attempts:1,requestKey:'checkpoint',generatedUrl:null}]});
   let recovered=0,failBilling=true;
   const cleaning=createAiListingPurge({pool,storage,publication:{baseUrl:base},clock:()=>now,
    recoverLegacyMediaKeys:async()=>{recovered++;return [generated('d')];},
    reconcileBilling:async()=>{if(failBilling)throw new Error('billing temporarily unavailable');}});
   await assert.rejects(cleaning.sweep(),/billing temporarily unavailable/);
   const failed=await repository.get(input);assert.equal(failed.purge.state,'FAILED');
   assert.equal(failed.purge.legacyInventoryChecked,true);assert.deepEqual(failed.purge.recoveredMediaKeys,[generated('d')]);
   failBilling=false;await service.permanentlyDeleteTask({...input,expectedVersion:failed.version});
   await cleaning.sweep();assert.equal(recovered,1);assert.ok(calls.includes(generated('d')));
   assert.ok((await repository.get(input)).permanentlyDeletedAt);
  });
  await t.test('restoring an automatic candidate after discovery skips it and still cleans the next due task',async()=>{
   const stale=await seed('stale-auto',{extra:{mediaJournalVersion:1}});
   const next=await seed('stale-next',{extra:{mediaJournalVersion:1}});let restored=false;
   const racing={connect:async()=>{const c=await pool.connect();return {release:()=>c.release(),query:async(...args)=>{
    const result=await c.query(...args);
    if(!restored&&result.rows.some(row=>row.id===stale.taskId)){restored=true;await service.resumeTask(stale);}
    return result;
   }}}};
   assert.equal((await createAiListingPurge({pool:racing,storage,clock:()=>now}).sweep()).taskId,next.taskId);
   const kept=await repository.get(stale);assert.equal(kept.deletedAt,null);assert.equal(kept.purge,undefined);
  });
  await t.test('a long queue loads one large task and coalesces inventory checkpoints without weakening completion',async()=>{
   const ids=[];
   for(let i=0;i<25;i++){
    const id='bounded-'+String(i).padStart(2,'0');ids.push(id);
    const input=await seed(id,{deletedAt:now,extra:{mediaJournalVersion:1,largeSnapshot:'x'.repeat(100_000)}});
    await service.permanentlyDeleteTask(input);
   }
   // Observe real PostgreSQL results and committed writes, not SQL spelling.
   await pool.query('CREATE TABLE purge_write_audit(id text, complete boolean)');
   await pool.query(`CREATE FUNCTION audit_purge_write() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN INSERT INTO purge_write_audit VALUES(NEW.id,NEW.body->>'permanentlyDeletedAt' IS NOT NULL);RETURN NEW;END $$`);
   await pool.query('CREATE TRIGGER purge_write_audit AFTER UPDATE ON ai_image_listing_tasks FOR EACH ROW EXECUTE FUNCTION audit_purge_write()');
   let bytes=0;
   const measured={connect:async()=>{const c=await pool.connect();return {release:()=>c.release(),query:async(...args)=>{
    const result=await c.query(...args);bytes+=Buffer.byteLength(JSON.stringify(result.rows));return result;
   }}}};
   try{
    const result=await createAiListingPurge({pool:measured,storage,clock:()=>now}).sweep();
    assert.equal(result.taskId,ids[0]);assert.equal(result.state,'COMPLETED');
    assert.equal((await repository.get({accountId:'a',taskId:ids[1]})).purge.state,'PENDING');
    const writes=(await pool.query('SELECT count(*)::int n FROM purge_write_audit WHERE id=$1 AND NOT complete',[ids[0]])).rows[0].n;
    assert.ok(bytes<150_000,`one queued task must not fetch the full batch: ${bytes} bytes`);
    assert.ok(writes<=2,`no-media cleanup needs at most active and frozen-source checkpoints, got ${writes}`);
   }finally{
    await pool.query('DROP TRIGGER purge_write_audit ON ai_image_listing_tasks');
    await pool.query('DELETE FROM ai_image_listing_tasks WHERE id=ANY($1::text[])',[ids]);
   }
  });
  await t.test('existing deleted rows from the production clone can be read without mutation or stricter source validation',async()=>{
   const rows=(await admin.query('SELECT id,body FROM public.ai_image_listing_tasks WHERE deleted_at IS NOT NULL LIMIT 5')).rows;
   for(const row of rows){const input=await seed('historic-'+row.id,{extra:{...row.body,id:'historic-'+row.id,accountId:'a',sourceId:null,source:null,images:[],submissionId:null,submissionStarted:false,submissionExternalWriteStarted:false,stoppedFrom:'GENERATING'}});await service.permanentlyDeleteTask(input);await worker().sweep();assert.ok((await repository.get(input)).permanentlyDeletedAt);}
  });
  await t.test('an existing running manifest without a reference checkpoint scans its remaining keys once',async()=>{
   const oldDeleted=generated('e'),shared=generated('f'),unused=`listing-media/v1/prepared/${'1'.repeat(64)}.mp4`;
   const input=await seed('old-running-manifest',{deletedAt:now,extra:{mediaJournalVersion:1,purge:{state:'RUNNING',requestedAt:now,
    legacyInventoryChecked:true,sources:{remove:[],retained:[]},deletedObjects:1,deletedVersions:1,
    objects:[{key:oldDeleted,state:'DELETED'},{key:shared,state:'PENDING'},{key:unused,state:'PENDING'}]}}});
   await seed('old-running-reader',{accountId:'b',deletedAt:null,status:'PAUSED',images:[{generatedUrl:base+shared}]});
   const removed=[];
   const result=await createAiListingPurge({pool,clock:()=>now,storage:{deleteObjectVersions:async({key})=>{removed.push(key);return {deletedVersions:1};}}}).sweep();
   assert.equal(result.taskId,input.taskId);assert.equal(result.state,'COMPLETED');assert.deepEqual(removed,[unused]);
   const saved=await repository.get(input);assert.equal(saved.purge.deletedObjects,2);assert.equal(saved.purge.retainedObjects,1);
  });
  await t.test('one full reference scan protects later batches and a restarted worker checkpoints each batch instead of each object',async()=>{
   const keys=Array.from({length:45},(_,index)=>`listing-media/v1/ai-image-listing/${index.toString(16).padStart(64,'0')}.jpg`);
   const input=await seed('batch-reference-check',{deletedAt:now,extra:{mediaJournalVersion:1,mediaKeys:keys,
    stoppedFrom:'SUBMISSION_FAILED',submissionId:'batch-live'}});
   await seed('batch-shared-reader',{accountId:'b',deletedAt:null,status:'PAUSED',images:[{generatedUrl:base+keys[43]}]});
   await pool.query(`INSERT INTO ai_image_listing_submissions(id,account_id,task_id,idempotency_key,body)
    VALUES('batch-live','a','batch-reference-check','batch-live',$1)`,[JSON.stringify({attempts:[{status:'DONE'}],
     results:[{sku:'live-sibling',offerId:'live',importStatus:'SUCCEEDED'}],items:[{offer_id:'live',images:[base+keys[44]]}]})]);
   await pool.query("INSERT INTO collect_items(id,account_id,source_sku,source,summary) VALUES('batch-new-reference','b','late-sku','ozon','{}')");
   await service.permanentlyDeleteTask(input);
   await pool.query('CREATE TABLE purge_batch_writes(id text)');
   await pool.query(`CREATE FUNCTION audit_purge_batch() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN INSERT INTO purge_batch_writes VALUES(NEW.id);RETURN NEW;END $$`);
   await pool.query('CREATE TRIGGER audit_purge_batch AFTER UPDATE ON ai_image_listing_tasks FOR EACH ROW EXECUTE FUNCTION audit_purge_batch()');
   let scans=0,failOnce=true;const removed=[];
   const measured={connect:async()=>{const client=await pool.connect();return {release:()=>client.release(),query:async(...args)=>{
    const result=await client.query(...args);if(String(args[0]).includes('WITH refs AS'))scans++;return result;
   }}}};
   const makeWorker=()=>createAiListingPurge({pool:measured,publication:{baseUrl:base},clock:()=>now,maxObjects:20,
    storage:{deleteObjectVersions:async({key})=>{if(failOnce&&key===keys[22]){failOnce=false;throw Error('mid-batch failure');}
     removed.push(key);return {deletedVersions:1};}}});
   try{
    assert.equal((await makeWorker().sweep()).state,'RUNNING');
    let saved=await repository.get(input);
    assert.equal(saved.purge.objects.filter(object=>object.state==='DELETED').length,20);
    assert.deepEqual(saved.purge.objects.filter(object=>object.state==='RETAINED').map(object=>object.key),keys.slice(43));
    assert.equal(saved.purge.referencesCheckedAt,now);assert.equal(scans,1);
    const writes=(await pool.query("SELECT count(*)::int n FROM purge_batch_writes WHERE id='batch-reference-check'")).rows[0].n;
    assert.ok(writes<=5,`twenty deletions should share one checkpoint, got ${writes} writes`);
    const writer=await pool.connect();try{
     await writer.query('BEGIN');
     await assert.rejects(updateCollectItemDraftWithClientV4(writer,{accountId:'b',collectItemId:'batch-new-reference',
      patch:{listingDraft:{variants:[{sku:'late-sku'}],richContent:JSON.stringify({src:base+keys[42]})}}}),{code:'COLLECT_MEDIA_PURGING'});
     await writer.query('ROLLBACK');
    }finally{writer.release();}
    await assert.rejects(makeWorker().sweep(),/mid-batch failure/);
    saved=await repository.get(input);
    assert.equal(saved.purge.state,'FAILED');assert.equal(saved.purge.deletedObjects,22);
    assert.equal(saved.purge.objects.filter(object=>object.state==='DELETED').length,22);
    assert.equal(saved.purge.referencesCheckedAt,now);assert.equal(scans,1);
    await service.permanentlyDeleteTask({...input,expectedVersion:saved.version});
    assert.equal((await makeWorker().sweep()).state,'RUNNING');
    assert.equal((await makeWorker().sweep()).state,'COMPLETED');
    assert.equal(scans,1);assert.deepEqual(removed,keys.slice(0,43));
    saved=await repository.get(input);assert.equal(saved.purge.deletedObjects,43);assert.equal(saved.purge.retainedObjects,2);
   }finally{await pool.query('DROP TRIGGER audit_purge_batch ON ai_image_listing_tasks');}
  });
  await t.test('reference scan retains every source and exact escaped key while ignoring unrelated rich-content references within its query budget',async()=>{
   const digest=value=>createHash('sha256').update(value).digest('hex');
   const keys=Array.from({length:47},(_,i)=>`listing-media/v1/${i%2?'prepared':'ai-image-listing'}/${digest('scan-key-'+i)}.${i%3?'jpg':'webp'}`);
   keys[15]=`staging/collector/${'a'.repeat(24)}/12345678-1234-1234-1234-123456789012`;
   keys[16]=`staging/collector/${'b'.repeat(24)}/12345678-1234-1234-1234-123456789012`;
   keys[19]=`listing-media/v1/prepared/${digest('scan-video')}.mov`;
   const input=await seed('scan-owner',{deletedAt:now,extra:{mediaJournalVersion:1,mediaKeys:keys,
    stoppedFrom:'SUBMISSION_FAILED',submissionId:'scan-own-submission'}});
   const escaped=JSON.stringify({html:`<img src="${base+keys[13]}"/>`}).replaceAll('/','\\/');
   await seed('scan-reader',{accountId:'b',status:'PAUSED',deletedAt:null,extra:{source:{refs:[keys[0],escaped,keys[15]+'extra',keys[17],keys[18],keys[19],
    keys[12].replace('.webp','Xwebp'),keys[14].slice(keys[14].lastIndexOf('/')+1)]}}});
   await pool.query("INSERT INTO collect_items(id,account_id,source_sku,source,summary) VALUES('scan-source','b','scan-source','ozon',$1)",[JSON.stringify({ref:keys[1]})]);
   await pool.query("INSERT INTO product_drafts(id,collect_item_id,data_hash,data) VALUES('scan-draft','scan-source','scan',$1)",[JSON.stringify({ref:keys[2]})]);
   await pool.query("INSERT INTO product_draft_variants(id,draft_id,variant_key,data_hash,data) VALUES('scan-variant','scan-draft','scan','scan',$1)",[JSON.stringify({ref:keys[3]})]);
   await pool.query("INSERT INTO product_draft_revisions(id,draft_id,version,data_hash,data) VALUES('scan-revision','scan-draft',1,'scan',$1)",[JSON.stringify({ref:keys[4]})]);
   await pool.query("INSERT INTO collect_raw_payloads(id,collect_item_id,account_id,payload_hash,payload) VALUES('scan-raw','scan-source','b','scan',$1)",[JSON.stringify({ref:keys[5]})]);
   await pool.query("INSERT INTO ai_image_listing_submissions(id,account_id,task_id,idempotency_key,body) VALUES('scan-submission','b','scan-reader','scan',$1)",[JSON.stringify({ref:keys[6]})]);
   await pool.query("INSERT INTO submission_snapshots(id,account_id,store_id,idempotency_key,snapshot_hash,items) VALUES('scan-snapshot','b','scan','scan','scan',$1)",[JSON.stringify([{images:[base+keys[7]]}])]);
   await pool.query("INSERT INTO products(id,image_url,raw) VALUES('scan-product',$1,$2)",[base+keys[8],JSON.stringify({ref:keys[9]})]);
   await pool.query(`INSERT INTO collector_media_uploads(id,account_id,run_id,device_id,lease_hash,identity_hash,source_sku,purpose,media_index,
    source_url,object_key,expected_size,expected_type,expected_md5,expires_at,confirmed_object)
    VALUES('scan-upload','b','scan','scan','scan','scan','scan','image',0,'https://external.invalid/image',$2,1,'image/jpeg','scan',NOW(),$1)`,[JSON.stringify({ref:keys[10]}),keys[16]]);
   await pool.query("INSERT INTO ai_image_listing_submissions(id,account_id,task_id,idempotency_key,body) VALUES('scan-own-submission','a','scan-owner','scan-own',$1)",
    [JSON.stringify({attempts:[{status:'DONE'}],results:[{offerId:'live',sku:'scan-live',importStatus:'SUCCEEDED'}],items:[{offer_id:'live',images:[base+keys[11]]}]})]);
   const unrelated=Array.from({length:3000},(_,i)=>base+`listing-media/v1/prepared/${digest('unrelated-'+i)}.jpg`);
   await pool.query(`INSERT INTO collect_raw_payloads(id,collect_item_id,account_id,payload_hash,payload)
    SELECT 'scan-large-'||i,'scan-source','b','large-'||i,$1::jsonb FROM generate_series(1,20) i`,[JSON.stringify({padding:'x'.repeat(1_000_000),images:unrelated})]);
   await service.permanentlyDeleteTask(input);
   const removed=[],bounded=new pg.Pool({connectionString:process.env.DATABASE_URL,options:`-c search_path=${schema} -c statement_timeout=1500`,max:1});
   try{
    const result=await createAiListingPurge({pool:bounded,clock:()=>now,maxObjects:100,
     storage:{deleteObjectVersions:async({key})=>{removed.push(key);return {deletedVersions:1};}}}).sweep();
    assert.equal(result.taskId,input.taskId);assert.equal(result.state,'COMPLETED');
    const retained=[0,1,2,3,4,5,6,7,8,9,10,11,13,15,17,18,19];
    assert.deepEqual(removed.sort(),keys.filter((_,i)=>!retained.includes(i)).sort());
    assert.equal((await repository.get(input)).purge.retainedObjects,17);
   }finally{
    await bounded.end();
    await pool.query("DELETE FROM collect_raw_payloads WHERE id LIKE 'scan-large-%'");
   }
  });
 }finally{await pool?.end();await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();}
});
