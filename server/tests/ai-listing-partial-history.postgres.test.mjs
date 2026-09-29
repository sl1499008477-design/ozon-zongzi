import './support/dedicated-postgres-test-environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {createAiListingRepository} from '../ai-listing-repository.mjs';

test('PostgreSQL history includes successfully stocked siblings while retaining failed work and tenant boundaries', {
  skip:process.env.SONLI_POSTGRES_TESTS!=='1', timeout:30000,
},async()=>{
  const schema='partial_history_'+randomUUID().replaceAll('-','');
  const admin=new pg.Pool({connectionString:process.env.DATABASE_URL});let pool;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool=new pg.Pool({connectionString:process.env.DATABASE_URL,options:`-c search_path=${schema}`});
    await pool.query("CREATE TABLE accounts(id TEXT PRIMARY KEY);INSERT INTO accounts VALUES('owner'),('other')");
    for(const migration of ['106_ai_image_listing.sql','135_ai_product_scheduling.sql','141_ai_listing_task_controls.sql','150_ai_listing_list_summary.sql']) {
      await pool.query(await readFile(new URL('../db/migrations/'+migration,import.meta.url),'utf8'));
    }
    const partial={
      name:'one listed sibling and one unfinished sibling',updatedAt:1000,
      config:{targetStoreId:'original-store'},submissionTarget:{targetStoreId:'actual-store'},
      images:[
        {sku:'listed',index:0,status:'COMPLETED',generatedUrl:'https://fixture.invalid/listed.png'},
        {sku:'unfinished',index:0,status:'GENERATION_FAILED',generatedUrl:null},
      ],
      submissionResults:[{sku:'listed',status:'COMPLETED',stockStatus:'COMPLETED'}],
    };
    const insert=async(id,{accountId='owner',status='GENERATION_FAILED',body=partial,deletedAt=null}={})=>{
      await pool.query(`INSERT INTO ai_image_listing_tasks
        (id,account_id,dedupe_key,status,body,next_run_at,created_at,deleted_at)
        VALUES($1,$2,$1,$3,$4::jsonb,0,1000,$5)`,[id,accountId,status,JSON.stringify(body),deletedAt]);
    };
    await insert('partial');
    await insert('legacy-config-target',{body:{...partial,submissionTarget:undefined,config:{targetStoreId:'legacy-store'}}});
    await insert('other-account',{accountId:'other'});
    await insert('other-store',{body:{...partial,submissionTarget:{targetStoreId:'other-store'}}});
    await insert('soft-deleted',{deletedAt:2000});
    await insert('permanently-deleted',{body:{...partial,permanentlyDeletedAt:2000}});
    await insert('only-failed',{body:{...partial,submissionResults:[]}});
    await insert('stock-pending',{body:{...partial,submissionResults:[{sku:'listed',status:'COMPLETED',stockStatus:'PENDING'}]}});
    await insert('ordinary-completed',{status:'COMPLETED',body:{...partial,submissionResults:undefined}});
    const repository=createAiListingRepository({pool});
    const history=(accountId,storeId)=>repository.listPage({accountId,storeId,view:'completed'});
    const ids=result=>result.tasks.map(task=>task.id).sort();
    const errors=await repository.listPage({accountId:'owner',group:'errors'});
    assert.ok(ids(errors).includes('partial'),'unfinished siblings remain visible in the errors group');
    assert.ok(!ids(errors).includes('ordinary-completed'));
    const actual=await history('owner','actual-store');
    assert.deepEqual(ids(actual),['ordinary-completed','partial'],
      'only actual completed stock or a legacy completed task appears in history');
    assert.equal(actual.total,2);
    assert.equal(actual.tasks.find(task=>task.id==='partial').status,'GENERATION_FAILED',
      'history must not erase the remaining failed sibling state');
    assert.equal(actual.tasks.find(task=>task.id==='partial').completedSkuCount,1,
      'the list summary exposes successful siblings for the partial listing badge');
    assert.equal(errors.tasks.find(task=>task.id==='partial').completedSkuCount,1);
    assert.deepEqual(ids(await history('owner','original-store')),[],
      'the actual submission target takes precedence over the original configured target');
    assert.deepEqual(ids(await history('owner','legacy-store')),['legacy-config-target']);
    assert.deepEqual(ids(await history('owner','other-store')),['other-store']);
    assert.deepEqual(ids(await history('other','actual-store')),['other-account']);
    assert.deepEqual(ids(await history('unrelated-account','actual-store')),[]);
    assert.deepEqual(ids(await history('owner','unknown-store')),[]);
    assert.deepEqual(ids(await history('owner','')),[]);
  } finally {
    await pool?.end();await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();
  }
});
