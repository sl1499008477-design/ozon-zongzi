import './support/dedicated-postgres-test-environment.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';

test('HTTP progress projects persisted 43-SKU jobs, isolates accounts and retains actionable completed drafts',
  {skip:process.env.SONLI_POSTGRES_TESTS!=='1'}, async t => {
  assert.ok(process.env.SONLI_MIGRATION_TEST_DATABASE_URL);
  const target=new URL(process.env.DATABASE_URL);
  const isolated=process.env.SONLI_TEST_NETWORK_ISOLATED==='1'&&target.hostname==='ozon-pipeline-repair-qa-db'&&target.pathname==='/ozon_pipeline_fixture';
  assert.ok(isolated||/^(localhost|127\.0\.0\.1)$/.test(target.hostname),'requires explicitly isolated test database');
  process.env.LISTING_PIPELINE_V3='1';
  const dataDir=await mkdtemp(path.join(tmpdir(),'collect-progress-postgres-'));
  process.env.QH_LOCAL_DATA_DIR=dataDir;
  const {getPostgresPool,closePostgresPool}=await import('../db/connection.mjs');
  const {runMigrations}=await import('../db/migrate.mjs');
  const {mirrorCollectItemV3,listCollectItemsV3}=await import('../listing-pipeline.mjs');
  const {createHttpHandler,createServerAccountSharedOzonCategoryComposition}=await import('../index.mjs');
  const {collectEnrichmentNeedsPolling}=await import('../../app/src/collect-enrichment-view.js');
  const pool=await getPostgresPool();
  const suffix=randomUUID();
  const a='progress-a-'+suffix,b='progress-b-'+suffix,id='collect-'+suffix;
  const token='test-session-'+suffix;
  const category={descriptionCategoryId:17000001,typeIdCandidate:97000001};
  const variants=Array.from({length:43},(_,i)=>({sku:String(9000000000+i),name:'saved source',
    images:['https://example.invalid/'+i+'.jpg'],price:'100.00',sourceCategory:category,
    logistics:{weightG:500,lengthMm:300,widthMm:200,heightMm:100}}));
  const item={id,sku:variants[0].sku,source:'ozon',name:'历史中文资料仍可读取',
    status:'COMPLETE',enrichment:{status:'COMPLETE',missingFields:[]},sourceCategory:category,
    listingDraft:{title:'saved manual title',sourceCategory:category,variants,packageWeight:500,
      packageLength:300,packageWidth:200,packageHeight:100}};
  let server,guard=false;const queries=[];
  const query=pool.query.bind(pool);
  pool.query=(sql,...args)=>{
    if(guard){
      const text=typeof sql==='string'?sql:sql.text;
      assert.match(text.trim(),/^SELECT\b/i);
      assert.doesNotMatch(text,/\b(?:local_state|products|warehouses|store_credentials)\b/i);
      queries.push({sql:text,params:args[0]});
    }
    return query(sql,...args);
  };
  try {
    await runMigrations(pool);
    await pool.query("INSERT INTO accounts(id,username,role) VALUES($1,$1,'user'),($2,$2,'user')",[a,b]);
    await pool.query("INSERT INTO sessions(token,account_id,expires_at) VALUES($1,$2,'2099-01-01')",[token,a]);
    for(const [record,accountId] of [[item,a],[{...item,id:id+'-other'},b],
      [{...item,id:id+'-unrequested'},a],[{...item,id:id+'-deleted'},a]]){
      await mirrorCollectItemV3(record,{accountId,client:pool});
    }
    await pool.query('UPDATE collect_items SET deleted_at=NOW() WHERE id=$1',[id+'-deleted']);
    await pool.query(`INSERT INTO collector_ozon_enrichment_jobs
      (id,account_id,collect_item_id,request_id,sku,status,refresh_bundle,deadline_at,claim_expires_at,result_json,completed_at)
      SELECT $2||'-job-'||n,$1,$2,$2||'-request',sku,
        CASE WHEN n<=24 THEN 'SUCCESS' WHEN n<=27 THEN 'PROCESSING' ELSE 'PENDING' END,
        '{}'::jsonb,'9999-01-01'::timestamptz,
        CASE WHEN n>24 AND n<=27 THEN '2099-01-01'::timestamptz END,
        CASE WHEN n<=24 THEN jsonb_build_object('sku',sku,'saved',true) END,
        CASE WHEN n<=24 THEN NOW() END
      FROM unnest($3::text[]) WITH ORDINALITY AS requested(sku,n)`,[a,id,variants.map(v=>v.sku)]);
    const composition=createServerAccountSharedOzonCategoryComposition();
    await composition.accountSharedOzonCategoryRuntime.recordCollectionResult({
      accountId:a,collectItemId:id,item,postgresExecutor:pool});
    // A completed historical SKU is hidden by the same projection as full refresh.
    await pool.query(`INSERT INTO ai_image_listing_tasks(id,account_id,dedupe_key,status,body,next_run_at,created_at)
      VALUES($1,$2,$1,'COMPLETED',$3,0,0)`,[id+'-listed',a,JSON.stringify({source:{items:[{sku:variants[0].sku}]}})]);
    await pool.query(`CREATE TABLE IF NOT EXISTS local_state(id text PRIMARY KEY,state jsonb NOT NULL,version integer NOT NULL DEFAULT 1)`);
    await pool.query("INSERT INTO local_state(id,state) VALUES('local-state',$1)",[
      JSON.stringify({stores:[],currentStoreIdsByAccount:{},jobs:{},reports:[],caches:{}})]);
    const handler=createHttpHandler({composition});
    server=createServer((req,res)=>{handler(req,res).catch(error=>{
      res.writeHead(error.status||500,{'Content-Type':'application/json'});
      res.end(JSON.stringify({code:error.code||'TEST_HTTP_ERROR'}));
    });});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const base='http://127.0.0.1:'+server.address().port;
    const request=async(url,authenticated=true)=>{
      const response=await fetch(base+url,{headers:authenticated?{Authorization:'Bearer '+token}:{}});
      return {status:response.status,body:await response.json()};
    };
    const full=await request('/local/state');
    assert.equal(full.status,200,JSON.stringify(full.body));
    const baseline=full.body.caches.collectBox.find(v=>v.id===id);
    const savedSuccesses=(await pool.query("SELECT id,result_json,completed_at,updated_at FROM collector_ozon_enrichment_jobs WHERE account_id=$1 AND status='SUCCESS' ORDER BY id",[a])).rows;
    const url='/ozon/collect-box/progress?'+new URLSearchParams([
      ['ids',id],['ids',id+'-other'],['ids',id+'-deleted'],['ids','missing'],['accountId',b]]);
    queries.length=0;guard=true;
    const started=performance.now();
    const first=await request(url);
    const elapsed=performance.now()-started;
    guard=false;
    assert.equal(first.status,200,JSON.stringify(first.body));
    assert.deepEqual(first.body.data,[baseline]);
    const projected=first.body.data[0];
    assert.equal(projected.enrichment.completedSkus,24);
    assert.equal(projected.enrichment.totalSkus,43);
    assert.equal(projected.enrichment.hasActiveJobs,true);
    assert.equal(projected.enrichment.executionState,'PROCESSING');
    assert.equal(projected.categoryResolution.status,'ACTIVE');
    assert.equal(projected.listingDraft.variants.length,42);
    assert.equal(projected.listingDraft.title,'saved manual title');
    assert.equal(collectEnrichmentNeedsPolling(projected.enrichment),true);
    assert.equal(queries.filter(v=>/FROM collector_ozon_enrichment_jobs/.test(v.sql)).length,1);
    assert.ok(queries.length<=8,queries.map(v=>v.sql).join('\n'));
    assert.ok(queries.find(v=>/FROM collect_items c/.test(v.sql)).params[1].includes(id));
    t.diagnostic('43 SKU progress: '+queries.length+' batch SELECTs; '+elapsed.toFixed(1)+' ms HTTP; '+Buffer.byteLength(JSON.stringify(first.body))+' response bytes; no global state or product catalog reads');
    const unauthenticated=await request(url,false);
    assert.equal(unauthenticated.status,401);
    for(const invalid of ['/ozon/collect-box/progress','/ozon/collect-box/progress?ids=',
      '/ozon/collect-box/progress?'+Array.from({length:101},(_,i)=>'ids='+i).join('&')]){
      const result=await request(invalid);
      assert.equal(result.status,400);assert.equal(result.body.code,'COLLECT_IDS_INVALID');
    }
    const complete={...item,listingDraft:{...item.listingDraft,title:'new saved manual title',packageWeight:777}};
    await mirrorCollectItemV3(complete,{accountId:a,client:pool});
    await composition.accountSharedOzonCategoryRuntime.recordCollectionResult({
      accountId:a,collectItemId:id,item:complete,postgresExecutor:pool});
    await pool.query(`UPDATE collector_ozon_enrichment_jobs SET status='SUCCESS',
      result_json=jsonb_build_object('sku',sku,'saved',true),error_json=NULL,completed_at=NOW()
      WHERE account_id=$1 AND collect_item_id=$2 AND status<>'SUCCESS'`,[a,id]);
    guard=true;
    const completed=await request(url);
    guard=false;
    assert.equal(completed.status,200,JSON.stringify(completed.body));
    const ready=completed.body.data[0];
    assert.equal(ready.enrichment.completedSkus,43);
    assert.equal(ready.enrichment.status,'COMPLETE');
    assert.equal(collectEnrichmentNeedsPolling(ready.enrichment),false);
    assert.equal(ready.draftVersion,2);
    assert.equal(ready.listingDraft.title,'new saved manual title');
    assert.equal(ready.listingDraft.packageWeight,777);
    assert.equal(ready.categoryResolution.status,'ACTIVE');
    assert.equal(ready.listingDraft.variants.length,42);
    assert.deepEqual(ready.listingDraft.variants[0].images,variants[1].images);
    assert.deepEqual((await pool.query("SELECT id,result_json,completed_at,updated_at FROM collector_ozon_enrichment_jobs WHERE account_id=$1 AND id=ANY($2::text[]) ORDER BY id",[a,savedSuccesses.map(v=>v.id)])).rows,savedSuccesses);
    assert.deepEqual((await request('/local/state')).body.caches.collectBox.find(v=>v.id===id),ready);
    // Legacy optional JSON nulls must not turn a read into a blocking validation.
    await pool.query(`INSERT INTO ai_image_listing_tasks(id,account_id,dedupe_key,status,body,next_run_at,created_at)
      VALUES($1,$2,$1,'COMPLETED','{"source":{"items":null},"submissionResults":null}',0,0)`,[id+'-legacy-null',a]);
    const legacy=await request(url);
    assert.equal(legacy.status,200,JSON.stringify(legacy.body));
    assert.deepEqual(legacy.body.data,[ready]);
  } finally {
    guard=false;
    if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
    pool.query=query;
    await closePostgresPool();
    await rm(dataDir,{recursive:true,force:true});
  }
});
