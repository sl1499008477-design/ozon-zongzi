import './support/dedicated-postgres-test-environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import pg from 'pg';
import {createAiListingRepository} from '../ai-listing-repository.mjs';

test('list summaries backfill large existing tasks and serve counts/pages/sources without permission to read body',
 {skip:process.env.SONLI_POSTGRES_TESTS!=='1'},async t=>{
  const client=new pg.Client({connectionString:process.env.DATABASE_URL});await client.connect();
  const id=randomUUID().replaceAll('-',''),schema='list_summary_'+id,reader='list_reader_'+id;
  t.after(async()=>{await client.query('ROLLBACK');await client.end();});
  await client.query('BEGIN');await client.query(`CREATE SCHEMA ${schema};SET LOCAL search_path=${schema}`);
  await client.query("CREATE TABLE accounts(id text PRIMARY KEY);INSERT INTO accounts VALUES('owner'),('other')");
  for(const name of ['106_ai_image_listing.sql','135_ai_product_scheduling.sql','141_ai_listing_task_controls.sql'])
    await client.query(await readFile(new URL('../db/migrations/'+name,import.meta.url),'utf8'));
  const frozen={sku:'main',name:'historical product',updatedAt:2000,sourceType:'COLLECT_BOX',sourceId:'collected',
    source:{sourceSnapshot:{collectorRunId:'run',source:'ozon',raw:randomBytes(512*1024).toString('hex')}},
    images:[{sku:'main',generatedUrl:'https://saved.test/one.jpg',status:'COMPLETED'},{sku:'second',status:'GENERATING'}],
    config:{targetStoreId:'store',salePricingId:'pricing'},submissionId:'submission',
    submissionResults:[{sku:'main',stockStatus:'COMPLETED',publicationWarnings:['warning_all_image_failed']},
      {sku:'second',stockStatus:'FAILED'}, {sku:'third',importStatus:'FAILED',stockStatus:'PENDING'},
      {sku:'fourth',stockStatus:'PENDING'}, {sku:'fifth',publicationCheck:{isCreated:false}},
      {sku:'sixth',publicationCheck:{isArchived:true}}, {sku:'seventh',publicationStatus:'warning_all_image_failed'}]};
  const insert=async(taskId,{accountId='owner',status='SUBMISSION_FAILED',body=frozen,deletedAt=null}={})=>client.query(
    'INSERT INTO ai_image_listing_tasks(id,account_id,dedupe_key,status,body,next_run_at,created_at,deleted_at) VALUES($1,$2,$1,$3,$4,0,1000,$5)',
    [taskId,accountId,status,body,deletedAt]);
  await insert('old');await insert('deleted',{deletedAt:3000});await insert('purging',{deletedAt:3000,body:{...frozen,purge:{state:'RUNNING',requestedAt:3000,privatePlan:['large-plan']}}});
  await insert('foreign',{accountId:'other'});await insert('gone',{body:{...frozen,permanentlyDeletedAt:3000}});
  await insert('bad-price',{body:{...frozen,submissionId:null,submissionResults:[],priceFailure:{code:'PRICE_FINAL_NOT_POSITIVE'}}});
  // Deliberately start with tasks written by the previous release.
  await client.query(await readFile(new URL('../db/migrations/150_ai_listing_list_summary.sql',import.meta.url),'utf8'));
  await client.query(`CREATE TABLE collector_tasks(id text,account_id text,name text);
    CREATE TABLE collector_task_runs(id text,account_id text,task_id text);
    CREATE TABLE collector_task_items(account_id text,task_id text,collect_item_id text,created_at timestamptz);
    CREATE TABLE ozon_web_collection_jobs(account_id text,status text,result jsonb,created_at timestamptz);
    INSERT INTO collector_tasks VALUES('desktop','owner','浴室用品');
    INSERT INTO collector_task_runs VALUES('run','owner','desktop');
    CREATE ROLE ${reader};GRANT USAGE ON SCHEMA ${schema} TO ${reader};
    GRANT SELECT ON collector_tasks,collector_task_runs,collector_task_items,ozon_web_collection_jobs TO ${reader}`);
  const columns=(await client.query("SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name='ai_image_listing_tasks' AND column_name<>'body'",[schema])).rows.map(r=>r.column_name).join(',');
  await client.query(`GRANT SELECT(${columns}) ON ai_image_listing_tasks TO ${reader};SET LOCAL ROLE ${reader}`);
  const repository=createAiListingRepository({pool:client});
  const page=await repository.listPage({accountId:'owner',group:'failed'});
  assert.deepEqual(page.tasks.map(row=>row.id),['old']);
  assert.deepEqual(page.counts,{all:2,active:0,paused:0,failed:1,errors:1,cancelled:0,deleted:1,purging:1});
  assert.deepEqual(page.tasks[0].progress,{total:2,completed:1});assert.equal(page.tasks[0].completedSkuCount,1);
  assert.equal(page.tasks[0].failedSubmissionSkuCount,2);assert.equal(page.tasks[0].pendingSubmissionSkuCount,1);
  assert.equal(page.tasks[0].publicationWarningSkuCount,3);assert.ok(!('_list' in page.tasks[0]));
  assert.deepEqual((await repository.listPage({accountId:'owner',group:'deleted'})).tasks.map(row=>row.id),['deleted']);
  assert.deepEqual((await repository.listPage({accountId:'owner',view:'completed',storeId:'store'})).tasks.map(row=>row.id),['old']);
  assert.deepEqual((await repository.readCollectionSources({accountId:'owner',taskIds:['old','foreign']})).get('old'),{type:'COLLECTOR_ASSISTANT',taskNames:['浴室用品']});
  assert.equal((await repository.readCollectionSources({accountId:'owner',taskIds:['foreign']})).size,0);
  await client.query('RESET ROLE');
  assert.deepEqual((await client.query("SELECT body FROM ai_image_listing_tasks WHERE id='old'")).rows[0].body,frozen,'backfill never rewrites source data');
  const direct={...frozen,images:frozen.images.map(image=>({...image,generatedUrl:'https://saved.test/done.jpg'})),purge:{state:'FAILED',errorMessage:'storage unavailable'}};
  await client.query("UPDATE ai_image_listing_tasks SET body=$1,status='CANCELLED',deleted_at=4000,version=version+1 WHERE id='old'",[direct]);
  await client.query(`SET LOCAL ROLE ${reader}`);
  const updated=(await repository.listPage({accountId:'owner',group:'deleted'})).tasks.find(row=>row.id==='old');
  assert.deepEqual(updated.progress,{total:2,completed:2});assert.equal(updated.version,2);
  assert.equal(updated.status,'CANCELLED');assert.equal(updated.deletedAt,4000);assert.equal(updated.purge.state,'FAILED');
  await client.query('RESET ROLE');
  await insert('new',{status:'GENERATING'});
  await client.query(`SET LOCAL ROLE ${reader}`);
  assert.equal((await repository.listPage({accountId:'owner',group:'active'})).tasks[0].id,'new');
 });

test('the list deadline includes a full pool and safely releases a late acquired client',
 {skip:process.env.SONLI_POSTGRES_TESTS!=='1',timeout:13000},async t=>{
  const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,max:1});
  let held=await pool.connect(),watchdog;
  t.after(async()=>{clearTimeout(watchdog);held?.release();await pool.end();});
  const repository=createAiListingRepository({pool}),started=Date.now();
  const outcome=await Promise.race([
    repository.listPage({accountId:'not-present',includeCollectionSources:true}).then(
      ()=>({state:'resolved'}),error=>({state:'rejected',code:error.code})),
    new Promise(resolve=>{watchdog=setTimeout(()=>resolve({state:'still-waiting-for-pool'}),9500);}),
  ]);
  clearTimeout(watchdog);
  assert.deepEqual(outcome,{state:'rejected',code:'57014'});
  assert.ok(Date.now()-started<9500,'connection acquisition shares the eight-second read budget');
  held.release();held=null;
  assert.equal((await pool.query('SELECT 42 AS available')).rows[0].available,42);
  assert.equal(pool.waitingCount,0);assert.equal(pool.idleCount,1);
 });

test('a paginated list and its sources share one database time budget and cancelled SQL releases its connection',
 {skip:process.env.SONLI_POSTGRES_TESTS!=='1',timeout:16000},async t=>{
  const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,max:1});t.after(()=>pool.end());
  const query=pool.query.bind(pool);let countStarted=false,pageStarted=false,sourceStarted=false,released=0,injectSlowQueries=true;
  const connect=async()=>{
    const client=await pool.connect(),raw=client.query.bind(client);
    return {release(){released++;client.release();},async query(sql,values){
      if(injectSlowQueries&&sql.includes('COUNT(*) FILTER')){countStarted=true;await raw("SELECT pg_sleep(4) /* list deadline first query */");}
      if(injectSlowQueries&&sql.includes('AS summary')){pageStarted=true;await raw("SELECT pg_sleep(6) /* list deadline second query */");}
      if(sql.includes('WITH sources'))sourceStarted=true;
      return raw(sql,values);
    }};
  };
  // Before the bounded path exists, the query adapter reproduces the same two
  // slow real PostgreSQL statements and completes after ten seconds.
  const direct=async(sql,values)=>{const client=await connect();try{return await client.query(sql,values);}finally{client.release();}};
  const repository=createAiListingRepository({pool:{connect,query:direct}}),started=Date.now();
  await assert.rejects(repository.listPage({accountId:'not-present',includeCollectionSources:true}),{code:'57014'});
  assert.ok(Date.now()-started<10500,'the second query only gets the remaining budget, not eight new seconds');
  assert.equal(countStarted,true);assert.equal(pageStarted,true);assert.equal(sourceStarted,false);assert.equal(released,1);
  assert.equal((await query('SELECT 1 AS available')).rows[0].available,1);
  assert.equal((await query("SELECT count(*)::int n FROM pg_stat_activity WHERE pid<>pg_backend_pid() AND state='active' AND query LIKE '%pg_sleep%' AND query LIKE '%list deadline%'")).rows[0].n,0);
  assert.equal((await query('SHOW statement_timeout')).rows[0].statement_timeout,'0');
  injectSlowQueries=false;
  await query(`CREATE TEMP TABLE ai_image_listing_tasks AS SELECT * FROM public.ai_image_listing_tasks WITH NO DATA;
    INSERT INTO ai_image_listing_tasks(id,account_id,status,body,version,created_at,queue_position,list_summary)
      VALUES('owned','owner','QUEUED','{}',1,1000,1,'{"sourceType":"EXCEL","_list":{"collectionSource":{}}}');`);
  const recovered=await repository.listPage({accountId:'owner',includeCollectionSources:true});
  assert.equal(recovered.tasks[0].id,'owned');
  assert.deepEqual(recovered.tasks[0].collectionSource,{type:'EXCEL',taskNames:[]});
  assert.equal(sourceStarted,true);assert.equal(released,2);
  assert.equal((await query('SHOW statement_timeout')).rows[0].statement_timeout,'0');
 });
