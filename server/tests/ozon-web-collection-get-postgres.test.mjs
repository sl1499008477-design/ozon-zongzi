import './support/dedicated-postgres-test-environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { createOzonWebCollectionService } from '../ozon-web-collection.mjs';

test('durable collection job lookup returns only the owning account after service restart', {
  skip: process.env.DATABASE_URL ? false : 'requires an explicitly configured dedicated PostgreSQL test database',
}, async () => {
  const schema = `web_get_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: process.env.DATABASE_URL });
  let pool;
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({ connectionString: process.env.DATABASE_URL, options: `-c search_path=${schema}`, max: 2 });
    await pool.query('CREATE TABLE accounts(id text PRIMARY KEY); CREATE TABLE collector_sessions(id text PRIMARY KEY, account_id text NOT NULL REFERENCES accounts(id));');
    await pool.query(await readFile(new URL('../db/migrations/138_ozon_web_collection_jobs.sql', import.meta.url), 'utf8'));
    await pool.query('INSERT INTO accounts(id) VALUES ($1),($2)', ['account-one', 'account-two']);
    const service = createOzonWebCollectionService({ getPool: async () => pool,
      ingestCollection: async () => assert.fail('lookup must not ingest product data'),
    });
    const own = await service.create({ accountId: 'account-one', sku: '1602438352', scope: 'CURRENT', requestId: 'excel-one' });
    const other = await service.create({ accountId: 'account-two', sku: '1602438352', scope: 'CURRENT', requestId: 'excel-one' });
    assert.notEqual(own.id, other.id);
    const restarted = createOzonWebCollectionService({ getPool: async () => pool });
    assert.deepEqual(await restarted.get({ accountId: 'account-one', id: own.id }), own);
    assert.deepEqual(await restarted.get({ accountId: 'account-two', id: other.id }), other);
    for (const request of [
      { accountId: 'account-one', id: other.id }, { accountId: 'account-two', id: own.id },
      { accountId: 'account-one', id: 'missing-job' },
    ]) await assert.rejects(restarted.get(request), { status: 404, code: 'WEB_COLLECTION_NOT_FOUND' });
    assert.equal((await restarted.list({ accountId: 'account-one' })).total, 1);
  } finally {
    await pool?.end();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  }
});

test('collection pages honor every Web page size with no overlap and preserve ownership',{
 skip:!process.env.DATABASE_URL,
},async t=>{
 const schema=`web_pages_${randomUUID().replaceAll('-','')}`,admin=new Pool({connectionString:process.env.DATABASE_URL});
 await admin.query(`CREATE SCHEMA ${schema}`);
 const pool=new Pool({connectionString:process.env.DATABASE_URL,options:`-c search_path=${schema}`});
 t.after(async()=>{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});
 await pool.query('CREATE TABLE accounts(id text PRIMARY KEY);CREATE TABLE collector_sessions(id text PRIMARY KEY,account_id text REFERENCES accounts(id));');
 await pool.query(await readFile(new URL('../db/migrations/138_ozon_web_collection_jobs.sql',import.meta.url),'utf8'));
 await pool.query("INSERT INTO accounts VALUES('a'),('b')");
 const service=createOzonWebCollectionService({getPool:async()=>pool});
 for(let i=0;i<63;i++)await service.create({accountId:'a',sku:String(10000000+i),scope:'CURRENT',requestId:'r'+i});
 await service.create({accountId:'b',sku:'10000000',scope:'CURRENT',requestId:'other'});
 for(const pageSize of [5,10,20,50]){
  const first=await service.list({accountId:'a',page:1,pageSize}),second=await service.list({accountId:'a',page:2,pageSize});
  assert.equal(first.items.length,pageSize);assert.equal(first.total,63);assert.equal(second.items.length,Math.min(pageSize,63-pageSize));
  assert.equal(new Set([...first.items,...second.items].map(item=>item.id)).size,first.items.length+second.items.length);
 }
 assert.equal((await service.list({accountId:'b',pageSize:5})).total,1);
});
