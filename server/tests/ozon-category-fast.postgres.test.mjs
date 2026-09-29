import './support/dedicated-postgres-test-environment.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';

test('PostgreSQL category GETs use narrow authenticated context even with 30 concurrent dictionaries',
  {skip:process.env.SONLI_POSTGRES_TESTS!=='1'},async t=>{
  assert.ok(process.env.SONLI_MIGRATION_TEST_DATABASE_URL);
  assert.match(new URL(process.env.DATABASE_URL).hostname,/^(localhost|127\.0\.0\.1)$/);
  const dataDir=await mkdtemp(path.join(tmpdir(),'ozon-category-fast-'));
  process.env.QH_LOCAL_DATA_DIR=dataDir;
  process.env.LISTING_PIPELINE_V3='1';
  process.env.APP_ENCRYPTION_KEY='isolated-category-test-encryption-key';
  const {getPostgresPool,closePostgresPool}=await import('../db/connection.mjs');
  const {runMigrations}=await import('../db/migrate.mjs');
  const {readStoreCredentialV3}=await import('../listing-pipeline.mjs');
  const {authenticateCollectionRequest}=await import('../collection-pipeline.mjs');
  const {encryptSecret}=await import('../crypto-secrets.mjs');
  const {createHttpHandler}=await import('../index.mjs');
  const {createOzonCategoryService}=await import('../ozon-category-service.mjs');
  const {createOzonCategoryRouteHandler}=await import('../ozon-category-routes.mjs');
  const {requireAuth,activeStore,storeIdForAccountRequest}=await import('../account-context.mjs');
  const pool=await getPostgresPool(),suffix=randomUUID();
  const a='cat-a-'+suffix,b='cat-b-'+suffix,empty='cat-empty-'+suffix;
  const current='cat-current-'+suffix,newer='cat-newer-'+suffix,foreign='cat-foreign-'+suffix;
  const token='cat-session-'+suffix,otherToken=token+'-b',emptyToken=token+'-empty';
  const tree=[{description_category_id:10,category_name:'Освещение',children:[{type_id:20,type_name:'Светильник',children:[]}]}];
  const attributes=[{id:30,name:'Цвет',dictionary_id:40,is_required:true}];
  const dictionary=[{id:501,value:'Белый',info:'',picture:''},{id:502,value:'Чёрный',info:'',picture:''}];
  const calls=[],queries=[],blocked=[];
  const makeService=(onTree=null)=>createOzonCategoryService({now:()=>Date.parse('2026-09-13T00:00:00Z'),
    callOzonSellerApi:async(store,endpoint,body)=>{
      assert.equal(store.ownerAccountId,store.id===foreign?b:a);
      assert.ok(store.apiKey==='fixture-secret-'+store.id,'the credential must belong to the authenticated store');
      assert.equal(store.clientId,'fixture-client-'+store.id);
      calls.push({storeId:store.id,endpoint,body});
      if(endpoint==='/v1/description-category/tree'){
        if(onTree)await onTree();
        return {result:tree};
      }
      if(endpoint==='/v1/description-category/attribute')return {result:attributes};
      assert.equal(endpoint,'/v1/description-category/attribute/values');
      return {result:dictionary,has_next:false};
    }});
  let guard=false,server,handler;
  const hooked=new WeakSet();
  const hook=client=>{
    if(hooked.has(client))return;
    hooked.add(client);
    const query=client.query.bind(client);
    client.query=(sql,...args)=>{
      const text=typeof sql==='string'?sql:sql.text;
      if(guard){
        if(/\b(?:local_state|products|collect_items|collect_raw_payloads)\b/i.test(text)){
          blocked.push(text);
          throw Object.assign(new Error('FORBIDDEN_GLOBAL_STATE_READ'),{code:'FORBIDDEN_GLOBAL_STATE_READ'});
        }
        assert.match(text.trim(),/^SELECT\b/i,'category reads must not mutate state');
        assert.doesNotMatch(text,/SELECT\s+(?:\w+\.)?\*/i,'do not read full store/raw rows');
        queries.push(text);
      }
      return query(sql,...args);
    };
  };
  try {
    await runMigrations(pool);
    await pool.query("INSERT INTO accounts(id,username,role) VALUES($1,$1,'user'),($2,$2,'user'),($3,$3,'user')",[a,b,empty]);
    for(const [session,account] of [[token,a],[otherToken,b],[emptyToken,empty]])
      await pool.query("INSERT INTO sessions(token,account_id,expires_at) VALUES($1,$2,'2099-01-01')",[session,account]);
    for(const [id,account,isCurrent,savedAt] of [[current,a,true,'2026-09-01'],[newer,a,false,'2026-09-12'],[foreign,b,true,'2026-09-13']]){
      await pool.query(`INSERT INTO stores(id,owner_account_id,client_id,status,is_current,saved_at,raw)
        VALUES($1,$2,$3,'active',$4,$5,jsonb_build_object('unneededPayload',repeat('x',1000000)))`,
        [id,account,'fixture-client-'+id,isCurrent,savedAt]);
      const key=encryptSecret('fixture-secret-'+id);
      await pool.query(`INSERT INTO store_credentials(store_id,client_id,encrypted_api_key,iv,auth_tag)
        VALUES($1,$2,$3,$4,$5)`,[id,'fixture-client-'+id,key.ciphertext,key.iv,key.authTag]);
    }
    // Warm the existing schema readiness checks before asserting read-only traffic.
    await authenticateCollectionRequest({headers:{authorization:'Bearer '+token}});
    await readStoreCredentialV3(current,a);
    pool.on('connect',hook);
    const client=await pool.connect();hook(client);client.release();
    const categoryService=makeService();
    handler=createHttpHandler({categoryService});
    server=createServer((req,res)=>handler(req,res).catch(error=>{
      res.writeHead(error.status||500,{'Content-Type':'application/json'});
      res.end(JSON.stringify({ok:false,message:error.message,code:error.code||'LOCAL_ERROR'}));
    }));
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const base='http://127.0.0.1:'+server.address().port;
    const request=async(url,{session=token,headers={}}={})=>{
      const response=await fetch(base+url,{headers:{...(session?{Authorization:'Bearer '+session}:{}),...headers}});
      return {status:response.status,body:await response.json()};
    };
    guard=true;
    await t.test('tree, attributes and Russian dictionaries match the JSON-context response and keep cache hits',async()=>{
      const jsonService=makeService();
      const sourceStore={id:current,ownerAccountId:a,clientId:'fixture-client-'+current,apiKey:'fixture-secret-'+current};
      const state={accounts:[{id:a,status:'active'}],sessions:{[token]:{accountId:a}},stores:[sourceStore],currentStoreIdsByAccount:{[a]:current}};
      for(const url of ['/ozon/categories/tree?language=RU','/ozon/description-category/20/attributes',
        '/ozon/description-category/20/attributes/30/values?limit=77']){
        const result=await request(url);
        assert.equal(result.status,200,JSON.stringify(result.body));
        let legacy;
        const jsonHandler=createOzonCategoryRouteHandler({categoryService:jsonService,requireAuth,activeStore,storeIdForAccountRequest,
          sendJson(_res,status,body){legacy={status,body};},sendError(){assert.fail('unexpected category error');}});
        await jsonHandler({req:{method:'GET',headers:{authorization:'Bearer '+token}},res:{},state,url:new URL(url,base)});
        assert.deepEqual(result,legacy);
        const count=calls.length;
        assert.deepEqual(await request(url),{...result,body:{...result.body,meta:{...result.body.meta,source:'OZON_CACHE'}}});
        assert.equal(calls.length,count,'the existing category service cache is reused');
        assert.doesNotMatch(JSON.stringify(result),/fixture-secret|encrypted_api_key|unneededPayload/);
      }
      assert.deepEqual(calls.at(-1).body,{description_category_id:10,type_id:20,attribute_id:30,language:'DEFAULT',limit:77});
    });
    await t.test('explicit query wins over header, header-only works, and current selection falls back by saved_at',async()=>{
      for(const [url,headers,expected] of [
        ['/ozon/categories/tree?storeId='+newer,{'x-ozon-store-id':foreign},newer],
        ['/ozon/categories/tree?language=EN',{'x-ozon-store-id':current},current],
      ]){
        const result=await request(url,{headers});
        assert.equal(result.status,200);assert.equal(calls.at(-1).storeId,expected);
      }
      guard=false;
      await pool.query('UPDATE stores SET is_current=FALSE WHERE owner_account_id=$1',[a]);
      guard=true;
      const result=await request('/ozon/categories/tree?language=ZH_HANS');
      assert.equal(result.status,200);assert.equal(calls.at(-1).storeId,newer);
      guard=false;
      await pool.query('UPDATE stores SET is_current=TRUE WHERE id=$1',[current]);
      guard=true;
    });
    await t.test('foreign store IDs and forged account scope are rejected before upstream access; empty account has 404',async()=>{
      const count=calls.length;
      for(const url of ['/ozon/categories/tree','/ozon/description-category/20/attributes','/ozon/description-category/20/attributes/30/values']){
        assert.equal((await request(url+'?storeId='+foreign+'&accountId='+b)).status,403);
        assert.equal((await request(url,{headers:{'x-ozon-store-id':foreign}})).status,403);
        assert.equal((await request(url,{session:''})).status,401);
        assert.equal((await request(url,{session:emptyToken})).status,404);
      }
      assert.equal(calls.length,count);
      assert.equal((await request('/ozon/categories/tree',{session:otherToken})).status,200);
      assert.equal(calls.at(-1).storeId,foreign);
    });
    await t.test('30 concurrent dictionary requests never load local_state, products or collect data',async()=>{
      queries.length=0;
      const before=calls.length,started=performance.now();
      const results=await Promise.all(Array.from({length:30},(_,i)=>request('/ozon/description-category/20/attributes/'+(100+i)+'/values')));
      const elapsed=performance.now()-started;
      for(const result of results){assert.equal(result.status,200,JSON.stringify(result.body));assert.deepEqual(result.body.items,dictionary);}
      assert.deepEqual(blocked,[]);
      assert.equal(queries.length,180,'each dictionary keeps two auth, store-selection and scoped-credential checks');
      assert.equal(calls.length-before,30,'one cached-tree lookup plus one value page per distinct attribute');
      t.diagnostic('30 concurrent dictionaries: '+queries.length+' small SELECTs, '+elapsed.toFixed(1)+' ms; zero global state/catalog reads');
    });
    for(const [kind,url] of [['auth','/ozon/description-category/20/attributes'],['owner','/ozon/description-category/20/attributes/30/values']]){
      await t.test('permission change during category lookup blocks the second phase: '+kind,async()=>{
        handler=createHttpHandler({categoryService:makeService(async()=>{
          guard=false;
          if(kind==='auth')await pool.query('UPDATE sessions SET revoked_at=NOW() WHERE token=$1',[token]);
          else await pool.query('UPDATE stores SET owner_account_id=$2, is_current=FALSE WHERE id=$1',[current,b]);
          guard=true;
        })});
        const before=calls.length,result=await request(url+'?storeId='+current);
        assert.equal(result.status,kind==='auth'?401:403);
        assert.equal(calls.length-before,1,'no attribute/value request after revoked permission');
        guard=false;
        await pool.query('UPDATE sessions SET revoked_at=NULL WHERE token=$1',[token]);
        await pool.query('UPDATE stores SET owner_account_id=$2, is_current=TRUE WHERE id=$1',[current,a]);
        guard=true;
      });
    }
    assert.deepEqual(blocked,[]);
  } finally {
    guard=false;
    if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
    pool.removeListener('connect',hook);
    await closePostgresPool();
    await rm(dataDir,{recursive:true,force:true});
  }
});
