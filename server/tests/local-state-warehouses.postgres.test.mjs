import './support/dedicated-postgres-test-environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {Client} from 'pg';
import {readLocalStateForAccount} from '../local-state-reader.mjs';
import {testExports} from '../index.mjs';
import {autoListingWarehouseOptions} from '../../app/src/auto-listing-config.js';

test('PostgreSQL warehouse choices do not depend on the loaded catalog or header store', {
  skip: !process.env.SONLI_MIGRATION_TEST_DATABASE_URL,
}, async t=>{
  const client=new Client({connectionString:process.env.SONLI_MIGRATION_TEST_DATABASE_URL});
  await client.connect();
  t.after(()=>client.end());
  // Connection-local tables shadow production names; no persistent data is written.
  await client.query(`CREATE TEMP TABLE accounts(id text,raw jsonb,role text,status text,expires_at timestamptz);
    CREATE TEMP TABLE stores(id text,owner_account_id text);
    CREATE TEMP TABLE files(raw jsonb,created_by text);
    CREATE TEMP TABLE local_state(id text,state jsonb);
    CREATE TEMP TABLE products(id text,store_id text,status text,visibility text,is_archived boolean,raw jsonb,updated_at timestamptz);
    CREATE TEMP TABLE collect_items(account_id text,deleted_at timestamptz);
    CREATE TEMP TABLE warehouses(id text,store_id text,warehouse_id text,name text,warehouse_type text,
      status text,is_active boolean,is_archived boolean,synced_at timestamptz,updated_at timestamptz,raw jsonb);
    CREATE TEMP TABLE product_stocks(product_id text,warehouse_id text,store_id text,source text);
    INSERT INTO accounts VALUES('a','{}','admin','active',NULL),('b','{}','user','active',NULL);
    INSERT INTO stores VALUES('a1','a'),('a2','a'),('b1','b');
    INSERT INTO products VALUES
      ('active','a1','ACTIVE','ALL',false,'{}',NOW()),
      ('archived','a1','ARCHIVED','ARCHIVED',true,'{}',NOW()),
      ('raw-archived','a1','ACTIVE','ALL',false,'{"is_archived":true}',NOW()),
      ('foreign','b1','ACTIVE','ALL',false,'{}',NOW());
    INSERT INTO warehouses VALUES
      ('cel','a1','101','CEL-测试','FBS','active',true,false,NOW(),NOW(),'{}'),
      ('rfbs','a2','102','林科大','RFBS','active',true,false,NOW(),NOW(),'{}'),
      ('archive-only','a1','103','归档商品仓库','FBS','active',true,false,NOW(),NOW(),'{}'),
      ('disabled','a1','104','停用仓库','FBS','disabled',false,false,NOW(),NOW(),'{}'),
      ('foreign-only','a1','105','错误跨店关联','FBS','active',true,false,NOW(),NOW(),'{}'),
      ('raw-archive-only','a1','106','历史归档商品','FBS','active',true,false,NOW(),NOW(),'{}'),
      ('other','b1','101','其他账号仓库','FBS','active',true,false,NOW(),NOW(),'{}');
    INSERT INTO product_stocks VALUES
      ('active','cel','a1','fbs'),('archived','archive-only','a1','fbs'),
      ('active','disabled','a1','fbs'),('foreign','foreign-only','a1','fbs'),
      ('raw-archived','raw-archive-only','a1','fbs'),('foreign','other','b1','fbs');`);
  await client.query('INSERT INTO local_state VALUES($1,$2::jsonb)', ['local-state', JSON.stringify({
    stores:[{id:'a1',ownerAccountId:'a'},{id:'a2',ownerAccountId:'a'},{id:'b1',ownerAccountId:'b'}],
    currentStoreIdsByAccount:{a:'a2',b:'b1'},currentStoreId:'a2',caches:{},jobs:{},reports:[],
  })]);
  const read=async(accountId,bootstrap,storeId=null)=>{
    const state=await readLocalStateForAccount({pool:client,accountId,bootstrap,storeId});
    // The current-store mapping normally changes via the store switch route.
    if(storeId)state.currentStoreIdsByAccount[accountId]=storeId;
    return testExports.localStatePayload(state,{account:state.accounts[0]});
  };
  const choices=(payload,targetStoreId)=>autoListingWarehouseOptions({warehouses:payload.caches.warehouses,targetStoreId}).options.map(w=>w.value);
  for(const bootstrap of [true,false]){
    const payload=await read('a',bootstrap);
    assert.equal(payload.currentStoreId,'a2');
    assert.deepEqual(payload.caches.products,[]);
    assert.deepEqual(choices(payload,'a1'),['cel']);
    assert.deepEqual(choices(payload,'a2'),['rfbs']);
    assert.deepEqual(choices(payload,'b1'),[]);
    assert.equal(payload.caches.warehouses.some(w=>w.storeId==='b1'),false);
  }
  const full=await read('a',false,'a1');
  assert.equal(full.caches.products.length,3);
  assert.ok(full.caches.products.every(p=>p.storeId==='a1'));
  assert.deepEqual(choices(full,'a1'),['cel']);
  const other=await read('b',true);
  assert.deepEqual(choices(other,'b1'),['other']);
  assert.deepEqual(choices(other,'a1'),[]);
  await assert.rejects(read('a',false,'b1'),e=>e.status===404);
});
