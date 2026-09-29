import './support/dedicated-postgres-test-environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import pg from 'pg';
import {createAiListingRepository} from '../ai-listing-repository.mjs';
import {createAiListingService} from '../ai-listing-service.mjs';
import {loadAiListingCollectSources} from '../ai-listing-runtime.mjs';
import {testExports} from '../index.mjs';

test('collector automatic ownership is atomic across real concurrent PostgreSQL sessions',
  {skip:process.env.SONLI_POSTGRES_TESTS!=='1'},async t=>{
    const admin=new pg.Pool({connectionString:process.env.DATABASE_URL});
    const schema=`collector_ai_${randomUUID().replaceAll('-','')}`;
    let pool;
    try {
      await admin.query(`CREATE SCHEMA ${schema}`);
      pool=new pg.Pool({connectionString:process.env.DATABASE_URL,options:`-c search_path=${schema}`,max:5});
      await pool.query(`CREATE TABLE accounts(id TEXT PRIMARY KEY);
        CREATE TABLE collect_items(id TEXT PRIMARY KEY,account_id TEXT NOT NULL,source TEXT,fixture JSONB);
        CREATE TABLE collector_ozon_enrichment_jobs(id TEXT,account_id TEXT,collect_item_id TEXT,sku TEXT,status TEXT,created_at TIMESTAMPTZ);
        CREATE TABLE collect_ozon_category_current_sources(account_id TEXT,collect_item_id TEXT,source_evidence_id TEXT,source_kind TEXT,source_record_id TEXT,source_version INTEGER);
        CREATE TABLE collect_ozon_category_source_evidence(id TEXT,account_id TEXT,collect_item_id TEXT,source_kind TEXT,source_record_id TEXT,source_version INTEGER);
        CREATE TABLE submission_snapshots(id TEXT,account_id TEXT);
        CREATE TABLE submission_jobs(id TEXT,account_id TEXT,snapshot_id TEXT,collect_item_id TEXT);
        CREATE TABLE submission_items(job_id TEXT,snapshot_id TEXT,sku TEXT,status TEXT,source TEXT);
        CREATE SEQUENCE ai_listing_queue_position_seq;
        CREATE TABLE ai_image_listing_tasks(id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES accounts(id),dedupe_key TEXT NOT NULL,
          status TEXT NOT NULL,body JSONB NOT NULL,version INTEGER NOT NULL DEFAULT 1,next_run_at BIGINT NOT NULL,created_at BIGINT NOT NULL,
          lease_token TEXT,lease_expires_at BIGINT,work_phase TEXT NOT NULL,queue_position BIGINT DEFAULT nextval('ai_listing_queue_position_seq'),control_action TEXT,deleted_at BIGINT,UNIQUE(account_id,dedupe_key));
        INSERT INTO accounts VALUES('a'),('b');`);
      await pool.query(await readFile(new URL('../db/migrations/140_collector_ai_sku_owners.sql',import.meta.url),'utf8'));
      const repository=createAiListingRepository({pool});
      const config={targetStoreId:'store',targetWarehouseId:'warehouse',manualReview:true};
      const sources=new Map();
      const add=(id,skus,source='ozon')=>sources.set(id,{collectItemId:id,sku:skus[0],sourceSnapshot:{source},items:skus.map(sku=>({
        sku,images:[`https://source.example/${sku}.png`],listingItem:{weight:100,depth:100,width:100,height:100},
      }))});
      const service=createAiListingService({repository,loadSources:async({collectItemIds})=>collectItemIds.map(id=>structuredClone(sources.get(id)))});
      const request=(accountId,runId,id,skus)=>service.createFromCollectorRun({accountId,runId,config,
        groups:[{groupId:`group-${id}`,collectItemId:id,skus}]});
      await t.test('overlapping runs create one owner per SKU and preserve it after a root/group change',async()=>{
        add('one',['101','102']);add('two',['102','103']);
        const [one,two]=await Promise.all([request('a','r1','one',['101','102']),request('a','r2','two',['102','103'])]);
        const owners=(await pool.query('SELECT source_sku,task_id FROM collector_ai_sku_owners ORDER BY source_sku')).rows;
        assert.deepEqual(owners.map(row=>row.source_sku),['101','102','103']);
        assert.equal(new Set(owners.map(row=>row.task_id)).size,2);
        assert.equal((await pool.query("SELECT count(*)::int AS n FROM ai_image_listing_tasks WHERE account_id='a'")).rows[0].n,2);
        const all=[...one.tasks,...two.tasks];
        assert.equal(new Set(all.filter(task=>task.images.some(image=>image.sku==='102')).map(task=>task.id)).size,1);
        sources.clear();
        const replay=await request('a','new-run','merged-root',['101','102','103']);
        assert.deepEqual(replay.results[0].createdTaskIds,[]);assert.equal(replay.tasks.length,2);
      });
      await t.test('historical Ozon tasks including Seller waits protect a SKU even under another source ID',async()=>{
        add('old-root',['201']);
        const [old]=await service.createFromCollect({accountId:'a',collectItemIds:['old-root'],config,idempotencyKey:'historical'});
        await pool.query("UPDATE ai_image_listing_tasks SET status='GENERATION_FAILED',body=jsonb_set(body,'{images,0,generatedUrl}','\"https://generated.example/kept.png\"') WHERE id=$1",[old.id]);
        add('wait-root',['202']);sources.get('wait-root').enrichmentJobs=[{sku:'202',status:'PENDING'}];
        const [wait]=await service.createFromCollect({accountId:'a',collectItemIds:['wait-root'],config,idempotencyKey:'wait'});
        sources.clear();
        const reused=await request('a','r3','different-root',['201','202']);
        assert.deepEqual(new Set(reused.results[0].reusedTaskIds),new Set([old.id,wait.id]));
        assert.equal(reused.tasks.find(task=>task.id===old.id).status,'GENERATION_FAILED');
        assert.equal(reused.tasks.find(task=>task.id===old.id).images[0].generatedUrl,'https://generated.example/kept.png');
        assert.equal(reused.tasks.find(task=>task.id===wait.id).status,'COLLECTING');
      });
      await t.test('a concurrent family handoff uses the owner committed after its initial source read',async()=>{
        add('model-first',['711']);add('model-later',['712']);
        for(const id of ['model-first','model-later'])sources.get(id).items[0].listingItem.scraped_model_name=sources.get(id).sku;
        let laterRead,firstSaved;
        const laterStarted=new Promise(resolve=>{laterRead=resolve;});
        const firstCommitted=new Promise(resolve=>{firstSaved=resolve;});
        const modelService=createAiListingService({repository,loadSources:async({collectItemIds})=>{
          if(collectItemIds[0]==='model-first')await laterStarted;
          else {laterRead();await firstCommitted;}
          return collectItemIds.map(id=>structuredClone(sources.get(id)));
        }});
        const handoff=(id,skus)=>modelService.createFromCollectorRun({accountId:'a',runId:id,config,
          groups:[{groupId:'same-model-family',collectItemId:id,skus}]});
        const firstRequest=handoff('model-first',['711']).finally(()=>firstSaved());
        const [first,later]=await Promise.all([firstRequest,handoff('model-later',['711','712'])]);
        assert.deepEqual(later.results[0].reusedTaskIds,[first.tasks[0].id]);
        const created=await repository.get({accountId:'a',taskId:later.results[0].createdTaskIds[0]});
        assert.equal(created.source.items[0].listingItem.scraped_model_name,'711');
        assert.equal(created.collectorAuto.modelName,'711');
        assert.deepEqual(created.source.items[0].images,['https://source.example/712.png']);
      });
      await t.test('platform/account boundaries and explicit manual generation remain independent',async()=>{
        add('china',['301'],'1688');await service.createFromCollect({accountId:'a',collectItemIds:['china'],config,idempotencyKey:'china'});
        add('ozon',['301']);const own=await request('a','ra','ozon',['301']);const other=await request('b','rb','ozon',['301']);
        assert.equal(own.results[0].createdTaskIds.length,1);assert.equal(other.results[0].createdTaskIds.length,1);
        assert.notEqual(own.tasks[0].id,other.tasks[0].id);
        const [manual]=await service.createFromCollect({accountId:'a',collectItemIds:['ozon'],config,idempotencyKey:'explicit-regenerate'});
        assert.notEqual(manual.id,own.tasks[0].id);
      });
      await t.test('deleted saved owners and historical tasks block automatic handoff without false reuse or duplicate work',async()=>{
        for(const ownerKind of ['automatic','historical'])for(const status of ['QUEUED','GENERATION_FAILED','AWAITING_REVIEW']){
          const id=`deleted-${ownerKind}-${status}`,sku=`sku-${id}`;add(id,[sku]);
          const task=ownerKind==='automatic'?(await request('a',id,id,[sku])).tasks[0]
            :(await service.createFromCollect({accountId:'a',collectItemIds:[id],config,idempotencyKey:id}))[0];
          await pool.query('UPDATE ai_image_listing_tasks SET status=$2 WHERE id=$1',[task.id,status]);
          await service.deleteTask({accountId:'a',taskId:task.id});sources.delete(id);
          const before=(await pool.query("SELECT count(*)::int n FROM ai_image_listing_tasks WHERE account_id='a'")).rows[0].n;
          for(const run of [id,id+'-next']){
            const receipt=await request('a',run,id,[sku]);assert.deepEqual(receipt.tasks,[]);assert.deepEqual(receipt.results[0].reusedTaskIds,[]);
            assert.deepEqual(receipt.results[0].createdTaskIds,[]);assert.deepEqual(receipt.results[0].unprocessedSkus,[sku]);
            assert.equal(receipt.errors[0].code,'AI_LISTING_DELETED_TASK_BLOCKED');assert.equal(receipt.errors[0].retryable,false);
          }
          assert.equal((await pool.query("SELECT count(*)::int n FROM ai_image_listing_tasks WHERE account_id='a'")).rows[0].n,before);
          assert.equal((await pool.query("SELECT task_id FROM collector_ai_sku_owners WHERE account_id='a' AND source_sku=$1",[sku])).rows[0].task_id,task.id);
          await assert.rejects(service.getTask({accountId:'a',taskId:task.id}),{statusCode:404});
        }
      });
      await t.test('a protected historical import row follows its later merge to the same-batch canonical task',async()=>{
        const previous=(await repository.readCollectorAutomaticOwners({accountId:'a',skus:['201']})).get('201');
        const canonical=await repository.create({...previous,id:'canonical-import',dedupeKey:'canonical-import',importBatchId:'original-batch',status:'GENERATING'});
        await pool.query(`UPDATE ai_image_listing_tasks SET status='MERGED',body=body||$2::jsonb WHERE id=$1`,
          [previous.id,JSON.stringify({importBatchId:'original-batch',mergedTaskId:canonical.id})]);
        const result=await request('a','merged-run','new-root',['201']);
        assert.deepEqual(result.results[0].reusedTaskIds,[canonical.id]);
        assert.equal((await pool.query("SELECT task_id FROM collector_ai_sku_owners WHERE account_id='a' AND source_sku='201'")).rows[0].task_id,canonical.id);
      });
      await t.test('the real collect loader excludes direct success per account/platform and splits persisted 101/200 SKU products',async()=>{
        const realService=createAiListingService({repository,loadSources:input=>loadAiListingCollectSources({...input,pool,
          readCollectItems:async({accountId,ids})=>(await pool.query('SELECT fixture FROM collect_items WHERE account_id=$1 AND id=ANY($2::text[])',[accountId,ids])).rows.map(row=>row.fixture),
          buildListingItems:testExports.buildCollectBoxListingItems})});
        async function capture(id,skus) {
          const variants=skus.map(sku=>({sku,name:`Товар ${sku}`,images:[`https://source.example/${sku}.png`],price:'15.00',priceCurrency:'CNY',
            packageWeight:100,packageLength:100,packageWidth:100,packageHeight:100}));
          const record={id,source:'ozon',sku:skus[0],images:variants[0].images,variantData:{variants},listingDraft:{sku:skus[0],currencyCode:'CNY',variants}};
          await pool.query("INSERT INTO collect_items(id,account_id,source,fixture) VALUES($1,'a','ozon',$2)",[id,record]);
        }
        const create=(runId,id,skus)=>realService.createFromCollectorRun({accountId:'a',runId,config,groups:[{groupId:id,collectItemId:id,skus}]});
        await capture('real-product',['801','802','803']);
        await pool.query(`INSERT INTO submission_snapshots VALUES('direct-a','a'),('direct-b','b'),('china-a','a');
          INSERT INTO submission_jobs VALUES('direct-a','a','direct-a','real-product'),('direct-b','b','direct-b',NULL),('china-a','a','china-a',NULL);
          INSERT INTO submission_items VALUES('direct-a','direct-a','802','SUCCEEDED','ozon'),('direct-b','direct-b','803','SUCCEEDED','ozon'),('china-a','china-a','803','SUCCEEDED','1688');`);
        const first=await create('real-first','real-product',['801']);
        const next=await create('real-next','real-product',['801','802','803']);
        assert.deepEqual(next.results[0].reusedTaskIds,[first.tasks[0].id]);
        assert.deepEqual(next.tasks.find(task=>next.results[0].createdTaskIds.includes(task.id)).images.map(image=>image.sku),['803']);
        assert.deepEqual(next.errors.map(error=>error.skus),[['802']]);
        for(const count of [101,200]){
          const skus=Array.from({length:count},(_,index)=>String(count*1000+index)),id=`large-${count}`;
          await capture(id,skus);const result=await create(id,id,skus);
          assert.deepEqual(result.errors,[]);assert.deepEqual(result.tasks.map(task=>task.images.length),count===101?[100,1]:[100,100]);
          assert.deepEqual(new Set(result.tasks.flatMap(task=>task.images.map(image=>image.sku))),new Set(skus));
        }
        await capture('old-draft-a',['901','903']);await capture('old-draft-b',['902']);
        await pool.query("UPDATE collect_items SET fixture=jsonb_set(fixture,'{listingDraft,variants,0,name}',$2::jsonb) WHERE id=$1",
          ['old-draft-b',JSON.stringify('Ручное название варианта B')]);
        const groups=[{groupId:'historical-group',collectItemId:'old-draft-a',skus:['901','902','903'],sources:[
          {collectItemId:'old-draft-a',skus:['901','903']},{collectItemId:'old-draft-b',skus:['902']},
        ]}];
        const separate=await realService.createFromCollectorRun({accountId:'a',runId:'separate-drafts',config,groups});
        assert.equal(separate.results.length,1);assert.equal(separate.tasks.length,2);assert.deepEqual(separate.errors,[]);
        const taskB=await repository.get({accountId:'a',taskId:separate.tasks.find(task=>task.collectItemId==='old-draft-b').id});
        assert.equal(taskB.source.items[0].listingItem.name,'Ручное название варианта B');
        assert.equal(taskB.source.items[0].listingItem.scraped_model_name,'901');
        assert.equal(taskB.collectorAuto.groupId,'historical-group');assert.equal(taskB.sourceId,'old-draft-b');
        const reuse=await realService.createFromCollectorRun({accountId:'a',runId:'separate-replay',config,groups});
        assert.deepEqual(reuse.results[0].createdTaskIds,[]);assert.equal(reuse.results[0].reusedTaskIds.length,2);
      });
      await t.test('an insertion failure rolls back earlier task and SKU ownership writes',async()=>{
        const before=(await pool.query('SELECT count(*)::int AS n FROM ai_image_listing_tasks')).rows[0].n;
        const task={accountId:'a',id:'atomic-first',dedupeKey:'atomic-first',status:'QUEUED',source:{items:[]},images:[],createdAt:1,nextRunAt:1,collectorAuto:{skus:['401']}};
        await assert.rejects(repository.createCollectorAutomatic({accountId:'a',skus:['401','402'],prepare:async()=>[task,{...task,id:'atomic-invalid',dedupeKey:null,collectorAuto:{skus:['402']}}]}));
        assert.equal((await pool.query('SELECT count(*)::int AS n FROM ai_image_listing_tasks')).rows[0].n,before);
        assert.equal((await pool.query("SELECT count(*)::int AS n FROM collector_ai_sku_owners WHERE source_sku IN ('401','402')")).rows[0].n,0);
      });
    } finally {
      await pool?.end();await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();
    }
  });
