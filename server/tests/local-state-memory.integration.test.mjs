import './support/dedicated-postgres-test-environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {randomBytes, randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';

// Own disposable database only: never connects to the application's database.
test('concurrent account state reads preserve data without exhausting a 192 MiB database', {
  skip: process.env.SONLI_MEMORY_TESTS !== '1',
}, async (t) => {
  const {Client} = await import('pg');
  const {readLocalStateForAccount} = await import('../local-state-reader.mjs');
  const name = 'ozon-state-memory-test-' + randomUUID().slice(0, 8);
  const docker = (...args) => execFileSync('docker', args, {encoding:'utf8'}).trim();
  docker('run','-d','--name',name,'--memory','768m','--memory-swap','768m',
    '-e','POSTGRES_HOST_AUTH_METHOD=trust','-p','127.0.0.1::5432',
    'postgres:16-alpine','-c','shared_buffers=32MB','-c','max_connections=40');
  t.after(() => docker('rm','-f','-v',name));
  const port=JSON.parse(docker('inspect',name))[0].NetworkSettings.Ports['5432/tcp'][0].HostPort;
  const config={host:'127.0.0.1',port:Number(port),user:'postgres',database:'postgres'};
  // Waiting for a test container to start does not impose a business task deadline.
  for (;;) {
    try {docker('exec',name,'pg_isready','-h','127.0.0.1','-U','postgres');break;} catch {await delay(100);}
  }
  const setup=new Client(config);await setup.connect();
  await setup.query(`CREATE TABLE accounts(id text,raw jsonb,role text,status text,expires_at timestamptz);
    CREATE TABLE stores(id text,owner_account_id text);
    CREATE TABLE files(raw jsonb,created_by text);
    CREATE TABLE local_state(id text,state jsonb);
    CREATE TABLE products(id text,store_id text,status text,visibility text,is_archived boolean,raw jsonb);
    CREATE TABLE product_stocks(product_id text,warehouse_id text,store_id text,source text);
    CREATE TABLE collect_items(account_id text,deleted_at timestamptz);
    CREATE TABLE warehouses(id text,store_id text,warehouse_id text,name text,warehouse_type text,
      status text,is_active boolean,is_archived boolean,synced_at timestamptz,updated_at timestamptz,raw jsonb);
    INSERT INTO accounts VALUES('a','{"nickname":"A"}','admin','active',NULL),('b','{"nickname":"B"}','user','active',NULL);
    INSERT INTO stores VALUES('store-a','a'),('store-b','b');
    INSERT INTO files VALUES('{"id":"file-a"}','a'),('{"id":"file-b"}','b');
    INSERT INTO products(id,store_id) VALUES('pa','store-a'),('pb','store-b');
    INSERT INTO collect_items VALUES('a',NULL),('a',NOW()),('b',NULL);`);
  const state={stores:[{id:'store-a',ownerAccountId:'a'},{id:'store-b',ownerAccountId:'b'}],
    currentStoreId:'store-a',currentStoreIdsByAccount:{a:'store-a',b:'store-b'},
    jobs:{a:{accountId:'a',status:'RUNNING'},b:{accountId:'b',status:'SUCCESS'}},reports:[],
    caches:{products:Array.from({length:1501},(_,i)=>({id:String(i),
      raw:randomBytes(1500).toString('base64')+'x'.repeat(4100)})),
      favorites:[{accountId:'a',id:'fav-a'},{accountId:'b',id:'fav-b'}],
      productTemplates:[{accountId:'a',id:'template-a'},{accountId:'b',id:'template-b'}],announcements:[]}};
  await setup.query('INSERT INTO local_state VALUES($1,$2::jsonb)',['local-state',JSON.stringify(state)]);
  const size=(await setup.query("SELECT pg_column_size(state #> '{}') AS bytes FROM local_state")).rows[0].bytes;
  assert(size>9_000_000, 'fixture must include the existing catalog-sized compatibility state');
  await setup.end();
  docker('update','--memory','192m','--memory-swap','192m',name);
  const clients=Array.from({length:3},()=>{const c=new Client(config);c.on('error',()=>{});return c;});
  try {
    await Promise.all(clients.map(c=>c.connect()));
    const results=await Promise.allSettled(clients.map((pool,i)=>readLocalStateForAccount({pool,accountId:i===1?'b':'a',bootstrap:true})));
    for (const [i,result] of results.entries()) {
      assert.equal(result.status,'fulfilled',result.reason?.message);
      const account=i===1?'b':'a';const value=result.value;
      assert.deepEqual(value.stores.map(s=>s.id),['store-'+account]);
      assert.equal(value.currentStoreId,'store-'+account);
      assert.deepEqual(value.caches.favorites,[{id:'fav-'+account,accountId:account}]);
      assert.deepEqual(value.caches.productTemplates,[{id:'template-'+account,accountId:account}]);
      assert.deepEqual(value.caches.files,[{id:'file-'+account}]);
      assert.deepEqual(Object.keys(value.jobs),[account]);
      assert.deepEqual(value.summaryCounts,{products:1,collectBox:1});
      assert.deepEqual(value.caches.products,[]);
    }
    t.diagnostic(JSON.stringify({fixtureBytes:size,concurrency:3,memoryLimitMiB:192}));
  } finally {
    await Promise.allSettled(clients.map(c=>c.end()));
  }
});
