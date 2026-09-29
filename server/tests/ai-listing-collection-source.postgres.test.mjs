import './support/dedicated-postgres-test-environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {readFile} from 'node:fs/promises';
import {createAiListingRepository} from '../ai-listing-repository.mjs';

test('collection source follows the owned original run and never a later collection or another account', async t => {
  assert.equal(typeof createAiListingRepository({pool:{}}).readCollectionSources, 'function');
  if (process.env.SONLI_POSTGRES_TESTS !== '1') return t.skip('requires isolated PostgreSQL');
  const client = new pg.Client({connectionString:process.env.DATABASE_URL});
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query(`
      CREATE TEMP TABLE ai_image_listing_tasks (id text,account_id text,body jsonb,created_at bigint) ON COMMIT DROP;
      CREATE TEMP TABLE collector_tasks (id text,account_id text,name text) ON COMMIT DROP;
      CREATE TEMP TABLE collector_task_runs (id text,account_id text,task_id text) ON COMMIT DROP;
      CREATE TEMP TABLE collector_task_items (account_id text,task_id text,collect_item_id text,created_at timestamptz) ON COMMIT DROP;
      CREATE TEMP TABLE ozon_web_collection_jobs (account_id text,status text,result jsonb,created_at timestamptz) ON COMMIT DROP;
      INSERT INTO collector_tasks VALUES ('one','a','汽车配件'),('two','a','家居商品'),('foreign','b','其他账号任务');
      INSERT INTO collector_task_runs VALUES ('run-one','a','one'),('run-two','a','two'),('run-foreign','b','foreign');
      INSERT INTO collector_task_items VALUES ('a','one','old-collect',to_timestamp(1)),('a','two','old-collect',to_timestamp(90)),('b','foreign','old-collect',to_timestamp(1));
      INSERT INTO ozon_web_collection_jobs VALUES ('a','COMPLETED','{"collectItemId":"web-item"}',to_timestamp(1)),('b','COMPLETED','{"collectItemId":"unknown-item"}',to_timestamp(1));
      INSERT INTO ai_image_listing_tasks VALUES
        ('auto-one','a','{"sourceType":"COLLECT_BOX","sourceId":"shared","collectorAuto":{"runId":"run-one"}}',10000),
        ('auto-two','a','{"sourceType":"COLLECT_BOX","sourceId":"shared","collectorAuto":{"runId":"run-two"}}',10000),
        ('legacy','a','{"sourceType":"COLLECT_BOX","sourceId":"old-collect"}',10000),
        ('excel','a','{"sourceType":"EXCEL"}',10000),
        ('web','a','{"sourceType":"COLLECT_BOX","sourceId":"web-item"}',10000),
        ('unknown','a','{"sourceType":"COLLECT_BOX","sourceId":"unknown-item"}',10000),
        ('spoof','a','{"sourceType":"COLLECT_BOX","collectorAuto":{"runId":"run-foreign"}}',10000),
        ('other','b','{"sourceType":"COLLECT_BOX","collectorAuto":{"runId":"run-foreign"}}',10000);
    `);
    await client.query(await readFile(new URL('../db/migrations/150_ai_listing_list_summary.sql',import.meta.url),'utf8'));
    const result = await createAiListingRepository({pool:client}).readCollectionSources({accountId:'a',
      taskIds:['auto-one','auto-two','legacy','excel','web','unknown','spoof','other']});
    assert.deepEqual(result.get('auto-one'), {type:'COLLECTOR_ASSISTANT',taskNames:['汽车配件']});
    assert.deepEqual(result.get('auto-two'), {type:'COLLECTOR_ASSISTANT',taskNames:['家居商品']});
    assert.deepEqual(result.get('legacy'), {type:'COLLECTOR_ASSISTANT',taskNames:['汽车配件']});
    assert.equal(result.get('excel').type, 'EXCEL');
    assert.equal(result.get('web').type, 'WEB_EXTENSION');
    assert.equal(result.get('unknown').type, 'COLLECT_BOX');
    assert.deepEqual(result.get('spoof').taskNames, []);
    assert.equal(result.has('other'), false);
  } finally {
    await client.query('ROLLBACK');
    await client.end();
  }
});
