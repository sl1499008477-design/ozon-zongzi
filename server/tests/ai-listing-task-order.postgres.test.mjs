import './support/dedicated-postgres-test-environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {readFile} from 'node:fs/promises';
import {createAiListingRepository} from '../ai-listing-repository.mjs';

// Only a session-local table is written; rollback also removes every fixture.
const setupSql = `
CREATE TEMP TABLE ai_image_listing_tasks (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL, status TEXT NOT NULL,
  body JSONB NOT NULL, created_at BIGINT NOT NULL, queue_position BIGINT NOT NULL,
  lease_token TEXT, lease_expires_at BIGINT,version INTEGER DEFAULT 1,control_action TEXT,deleted_at BIGINT
) ON COMMIT DROP;
INSERT INTO pg_temp.ai_image_listing_tasks
  (id,account_id,status,created_at,queue_position,lease_token,lease_expires_at,body)
SELECT id,account_id,status,created_at,queue_position,
  CASE WHEN lease_seconds IS NULL THEN NULL ELSE 'worker-lease' END,
  (extract(epoch FROM now()) * 1000)::bigint + lease_seconds * 1000,
  jsonb_build_object('sourceType','SKU','sku',id,'updatedAt',created_at,
    'generationStage',stage,'config',jsonb_build_object('targetStoreId',store_id),
    'submissionTarget',CASE WHEN submitted_store IS NULL THEN NULL
      ELSE jsonb_build_object('targetStoreId',submitted_store) END,
    'images',jsonb_build_array(jsonb_build_object('sku',id,'index',0,
      'status',image_status,'generatedUrl',NULL)))
FROM (VALUES
  ('active-single','a','GENERATING',10,10,NULL,'GENERATING',600,'store',NULL),
  ('active-image','a','GENERATING',20,11,'image','GENERATING',600,'store',NULL),
  ('active-preparing','a','GENERATING',30,12,'preparing','GENERATING',600,'store',NULL),
  ('active-slicing','a','GENERATING',40,13,'slicing','GENERATING',600,'store',NULL),
  ('active-saving','a','GENERATING',50,14,'saving','GENERATING',600,'store',NULL),
  ('queued','a','QUEUED',900,1,NULL,'PENDING',NULL,'store',NULL),
  ('waiting-channel','a','GENERATING',800,2,'waiting_channel','GENERATING',600,'store',NULL),
  ('waiting-product','a','GENERATING',700,3,'waiting_product','PENDING',600,'store',NULL),
  ('retry-without-lease','a','GENERATING',600,4,'image','GENERATING',NULL,'store',NULL),
  ('expired-image','a','GENERATING',500,5,'image','GENERATING',-1,'store',NULL),
  ('collecting','a','COLLECTING',400,6,NULL,'PENDING',600,'store',NULL),
  ('legacy-waiting','a','GENERATING',300,7,NULL,'PENDING',600,'store',NULL),
  ('waiting-generation','a','GENERATING',200,8,'queued','GENERATING',600,'store',NULL),
  ('cancelled','a','CANCELLED',500,100,'image','GENERATING',600,'store',NULL),
  ('generation-failed','a','GENERATION_FAILED',500,99,'image','GENERATING',600,'store',NULL),
  ('awaiting-review','a','AWAITING_REVIEW',400,98,NULL,'COMPLETED',NULL,'store',NULL),
  ('submission-failed','a','SUBMISSION_FAILED',300,97,NULL,'COMPLETED',NULL,'store',NULL),
  ('ready-to-submit','a','READY_TO_SUBMIT',200,96,NULL,'COMPLETED',NULL,'store',NULL),
  ('submitted','a','SUBMITTED',100,95,NULL,'COMPLETED',NULL,'store',NULL),
  ('completed-new','a','COMPLETED',900,90,NULL,'COMPLETED',NULL,'store',NULL),
  ('completed-routed','a','COMPLETED',800,91,NULL,'COMPLETED',NULL,'other','store'),
  ('completed-old','a','COMPLETED',100,92,NULL,'COMPLETED',NULL,'store',NULL),
  ('completed-other-store','a','COMPLETED',1000,93,NULL,'COMPLETED',NULL,'other',NULL),
  ('merged','a','MERGED',2000,0,NULL,'PENDING',NULL,'store',NULL),
  ('other-account','b','GENERATING',3000,0,'image','GENERATING',600,'store',NULL)
) AS fixture(id,account_id,status,created_at,queue_position,stage,image_status,
  lease_seconds,store_id,submitted_store);
`;

test('task pages put active image work first, waiting work in FIFO order, and retain history order',
  {skip:process.env.SONLI_POSTGRES_TESTS!=='1'},async t=>{
    const client=new pg.Client({connectionString:process.env.DATABASE_URL});
    await client.connect();
    try {
      await client.query('BEGIN');
      await client.query(setupSql);
      await client.query(await readFile(new URL('../db/migrations/150_ai_listing_list_summary.sql',import.meta.url),'utf8'));
      const repository=createAiListingRepository({pool:client});
      const expected=[
        'active-single','active-image','active-preparing','active-slicing','active-saving',
        'queued','waiting-channel','waiting-product','retry-without-lease','expired-image',
        'collecting','legacy-waiting','waiting-generation','cancelled','generation-failed',
        'awaiting-review','submission-failed','ready-to-submit','submitted',
      ];
      await t.test('stage and live lease distinguish actual work from channel waits and stale retries',async()=>{
        const page=await repository.listPage({accountId:'a',limit:100});
        assert.equal(page.total,expected.length);
        assert.deepEqual(page.tasks.map(task=>task.id),expected);
      });
      await t.test('priority is applied before pagination and has a stable boundary',async()=>{
        const ids=[];
        for(let offset=0;offset<expected.length;offset+=3){
          const page=await repository.listPage({accountId:'a',limit:3,offset});
          assert.equal(page.total,expected.length);
          ids.push(...page.tasks.map(task=>task.id));
        }
        assert.deepEqual(ids,expected);
        assert.deepEqual((await repository.listPage({accountId:'a',limit:3})).tasks.map(task=>task.id),expected.slice(0,3));
      });
      await t.test('groups filter before pagination, count the full account, and retain price errors',async()=>{
        const failed=await repository.listPage({accountId:'a',group:'failed',limit:1});
        assert.deepEqual(failed.tasks.map(task=>task.id),['submission-failed']);assert.equal(failed.total,1);
        assert.deepEqual(failed.counts,{all:19,active:16,paused:0,failed:1,errors:1,cancelled:1,deleted:0,purging:0});
        const active=await repository.listPage({accountId:'a',group:'active',limit:2,offset:14});
        assert.equal(active.total,16);assert.deepEqual(active.tasks.map(task=>task.id),['ready-to-submit','submitted']);
        await client.query(`UPDATE ai_image_listing_tasks SET body=body||'{"priceFailure":{"code":"PRICE_FINAL_NOT_POSITIVE"}}'::jsonb WHERE id='submission-failed'`);
        assert.equal((await repository.listPage({accountId:'a',group:'failed'})).total,0);
        const errors=await repository.listPage({accountId:'a',group:'errors'});assert.equal(errors.total,2);
        assert.equal((await repository.listPage({accountId:'b',group:'errors'})).total,0);
      });
      await t.test('completed view keeps newest first and scopes by actual submission store and account',async()=>{
        const page=await repository.listPage({accountId:'a',view:'completed',storeId:'store'});
        assert.equal(page.total,3);
        assert.deepEqual(page.tasks.map(task=>task.id),['completed-new','completed-routed','completed-old']);
        assert.deepEqual((await repository.listPage({accountId:'b',view:'completed',storeId:'store'})).tasks,[]);
      });
    } finally {
      await client.query('ROLLBACK');
      await client.end();
    }
  });
