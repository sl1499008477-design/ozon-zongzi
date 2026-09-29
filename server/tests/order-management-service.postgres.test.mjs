import './support/dedicated-postgres-test-environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import pg from 'pg';
import {createOrderManagementService} from '../order-management-service.mjs';
import {createOrderManagementOzon} from '../order-management-ozon.mjs';
import {createOrderManagementRuntime} from '../order-management-runtime.mjs';

const rawPosting=(number,sku=11,extra={})=>({posting_number:number,order_number:number.split('-').slice(0,-1).join('-'),status:'delivered',in_process_at:'2026-09-10T10:00:00Z',products:[{sku,name:'订单商品',offer_id:'offer-'+sku,quantity:2,price:{amount:'20.10',currency:'CNY'}}],financial_data:{products:[{product_id:sku,commission:{amount:-4.02,currency:'CNY'},payout:36.18}]},...extra});

test('HTTP + independent PostgreSQL: historical orders, complete resumable sync, scope, search and immutable purchase cost snapshots',{skip:process.env.SONLI_POSTGRES_TESTS!=='1'},async()=>{
  const schema='order_management_'+randomUUID().replaceAll('-','');
  const admin=new pg.Pool({connectionString:process.env.DATABASE_URL});let pool,http,runtime;
  try{
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool=new pg.Pool({connectionString:process.env.DATABASE_URL,options:`-c search_path=${schema}`,max:10});
    await pool.query(await readFile(new URL('../db/migrations/001_formal_schema.sql',import.meta.url),'utf8'));
    await pool.query(`ALTER TABLE stores ADD COLUMN owner_account_id TEXT REFERENCES accounts(id);
      INSERT INTO accounts(id,username) VALUES('a','a'),('b','b');
      INSERT INTO stores(id,client_id,owner_account_id,status) VALUES('s','s','a','active'),('other','other','b','active');
      INSERT INTO products(id,store_id,product_id,sku,offer_id,name,image_url) VALUES
      ('p','s','1001','11','offer-11','旧商品','https://example.test/own.png'),
      ('p2','s','1002','22','offer-22','另一个商品',''),('foreign','other','1001','11','offer-11','其他店铺','https://example.test/foreign.png')`);
    await pool.query(`INSERT INTO orders(id,store_id,posting_number,status,in_process_at,raw) VALUES('legacy','s','legacy-1-1','delivered','2026-09-10T10:00:00Z',$1),('foreign','other','private-1-1','delivered','2026-09-10T10:00:00Z',$2)`,[rawPosting('legacy-1-1'),rawPosting('private-1-1')]);
    await pool.query(await readFile(new URL('../db/migrations/132_order_management.sql',import.meta.url),'utf8'));
    await pool.query(await readFile(new URL('../db/migrations/133_order_inspection.sql',import.meta.url),'utf8'));
    let now=Date.parse('2026-09-11T12:00:00Z'),fail=false,repeat=false,delay=null;const calls=[];
    const ozon=createOrderManagementOzon({callApi:async(c,path,body)=>{
      calls.push({path,body});if(delay)await delay;if(fail)throw Object.assign(Error('apiKey=fixture-secret'),{status:503,code:'ZONGZI_HTTP_503'});
      if(path==='/v4/posting/fbs/list'){
        if(body.cursor==='second')return {postings:[rawPosting('rfbs-1-1',11,{status:'awaiting_packaging',integration_type_flow:'non_integrated'})],has_next:repeat,cursor:repeat?'second':''};
        return {postings:[rawPosting('new-1-1')],has_next:true,cursor:'second'};
      }
      if(path==='/v3/posting/fbo/list')return {postings:[rawPosting('fbo-1-1',22,{status:'client_arbitration'})],has_next:false,cursor:''};
      throw Error('unexpected remote write '+path);
    }});
    const options={pool,ozon,clock:()=>now,readCredential:async(storeId,accountId)=>{assert.equal(storeId,'s');assert.equal(accountId,'a');return {clientId:'fixture',apiKey:'fixture-secret'}}};
    let service=createOrderManagementService(options);
    runtime=createOrderManagementRuntime({resolveService:async()=>service,authenticate:async req=>{if(req.headers.authorization!=='Bearer fixture')throw Object.assign(Error('请登录'),{status:401});return {id:'a',role:'user'}},readJson:async req=>{const parts=[];for await(const chunk of req)parts.push(chunk);return JSON.parse(Buffer.concat(parts).toString()||'{}')},sendJson:(res,status,data)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(data))}});
    http=createServer(async(req,res)=>{if(!await runtime.handleRoute(req,res,new URL(req.url,'http://localhost'))){res.writeHead(404);res.end()}});
    await new Promise(resolve=>http.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${http.address().port}`;
    const api=async(path,method='GET',body)=>{const res=await fetch(base+path,{method,headers:{authorization:'Bearer fixture','content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:res.status,body:await res.json()}};
    assert.equal((await fetch(base+'/ozon/order-management/overview?storeId=s')).status,401);
    for(const [url,method,body] of [
      ['/api/ozon/order-management/overview?storeId=other','GET'],
      ['/ozon/order-management/sync?storeId=other','POST',{}],
      ['/ozon/product-costs?storeId=other','GET'],
      ['/ozon/product-costs/1001?storeId=other','PUT',{unitCostCny:'5',autoApply:true}],
      ['/ozon/order-management/postings/private-1-1?storeId=other&scheme=FBS','GET'],
      ['/ozon/order-management/postings/private-1-1/costs?storeId=other&scheme=FBS','PUT',{items:[{sku:'11',unitCostCny:'5'}]}],
    ])assert.equal((await api(url,method,body)).status,403);
    assert.equal((await api('/ozon/order-management/overview')).status,400);
    let overview=(await api('/api/ozon/order-management/overview?storeId=s')).body;
    assert.equal(overview.total,1);assert.equal(overview.items[0].postingNumber,'legacy-1-1');assert.equal(overview.items[0].products[0].productId,'1001');
    assert.equal(overview.items[0].products[0].imageUrl,'https://example.test/own.png');assert.equal(overview.sync.status,'IDLE');
    let cost=await api('/api/ozon/product-costs/1001?storeId=s','PUT',{unitCostCny:'5.01',autoApply:true});
    assert.equal(cost.status,200);assert.equal(cost.body.unitCostCny,'5.01');
    assert.deepEqual((await api('/ozon/product-costs?storeId=s')).body.items.map(c=>[c.productId,c.unitCostCny,c.autoApply]),[['1001','5.01',true]]);
    let detail=(await api('/ozon/order-management/postings/legacy-1-1?storeId=s&scheme=FBS')).body.posting;
    assert.equal(detail.purchaseCostCny,'10.02');assert.equal(detail.grossProfitCny,'26.16');
    assert.equal(detail.products[0].costSource,'PRODUCT_AUTO');
    const sync=await api('/api/ozon/order-management/sync?storeId=s','POST',{});
    assert.equal(sync.body.sync.status,'QUEUED');assert.equal(calls.length,0,'HTTP only queues sync');
    await service.processNext();assert.equal((await service.syncStatus({accountId:'a',storeId:'s'})).sync.processed,1);
    service=createOrderManagementService(options); // A fresh runtime continues the persisted cursor.
    await service.processNext();await service.processNext();
    overview=(await api('/ozon/order-management/overview?storeId=s&page=1&pageSize=2')).body;
    assert.equal(overview.total,4);assert.equal(overview.items.length,2);assert.equal(overview.sync.status,'COMPLETED');assert.equal(overview.sync.pages,3);assert.equal(overview.sync.processed,3);
    assert.equal(calls[1].body.cursor,'second');assert.equal(overview.statusCounts.disputed,1);assert.equal(overview.statusCounts.awaiting_packaging,1);
    assert.equal((await api('/ozon/order-management/overview?storeId=s&status=disputed')).body.items[0].scheme,'FBO');
    assert.equal((await api('/ozon/order-management/overview?storeId=s&q=rfbs')).body.total,1);
    assert.equal((await api('/ozon/order-management/overview?storeId=s&q=offer-22')).body.total,1);
    assert.equal((await api('/ozon/order-management/overview?storeId=s&since=2026-09-01&to=2026-09-09')).body.total,0);
    assert.equal((await api('/ozon/order-management/overview?storeId=s&since=invalid')).status,400);
    assert.equal((await api('/ozon/order-management/postings/legacy-1-1?storeId=s&scheme=FBO')).status,404);
    // Product changes fill missing costs but cannot rewrite previous automatic snapshots.
    await api('/ozon/product-costs/1001?storeId=s','PUT',{unitCostCny:'9.99',autoApply:true});
    detail=(await api('/ozon/order-management/postings/new-1-1?storeId=s&scheme=FBS')).body.posting;
    assert.equal(detail.products[0].unitCostCny,'5.01');
    detail=(await api('/ozon/order-management/postings/new-1-1/costs?storeId=s&scheme=FBS','PUT',{items:[{sku:'11',unitCostCny:'6.00'}]})).body.posting;
    assert.equal(detail.products[0].costSource,'MANUAL');assert.equal(detail.grossProfitCny,'24.18');
    await api('/ozon/order-management/postings/rfbs-1-1/costs?storeId=s&scheme=rFBS','PUT',{items:[{sku:'11',unitCostCny:null}]});
    await api('/ozon/product-costs/1001?storeId=s','PUT',{unitCostCny:'12',autoApply:true});
    detail=(await api('/ozon/order-management/postings/rfbs-1-1?storeId=s&scheme=rFBS')).body.posting;
    assert.equal(detail.products[0].unitCostCny,null);assert.equal(detail.products[0].costSource,'MANUAL');
    for(const unitCostCny of [1.1,'-1','NaN','0.001'])assert.equal((await api('/ozon/product-costs/1001?storeId=s','PUT',{unitCostCny,autoApply:true})).status,400);
    assert.equal((await api('/ozon/product-costs/999?storeId=s','PUT',{unitCostCny:'5',autoApply:true})).status,404);
    assert.equal((await api('/ozon/order-management/postings/new-1-1/costs?storeId=s&scheme=FBS','PUT',{items:[{sku:'foreign',unitCostCny:'0'}]})).status,400);
    await api('/ozon/product-costs/1002?storeId=s','PUT',{unitCostCny:'1',autoApply:false});
    assert.equal((await api('/ozon/order-management/postings/fbo-1-1?storeId=s&scheme=FBO')).body.posting.purchaseCostCny,null);
    await api('/ozon/product-costs/1002?storeId=s','PUT',{unitCostCny:'1',autoApply:true});
    assert.equal((await api('/ozon/order-management/postings/fbo-1-1?storeId=s&scheme=FBO')).body.posting.purchaseCostCny,'2.00');
    // Synchronization is local-idempotent and cannot replace manual or automatic history.
    await api('/ozon/order-management/sync?storeId=s','POST',{});await service.processNext();await service.processNext();await service.processNext();
    assert.equal((await service.overview({accountId:'a',storeId:'s'})).total,4);
    assert.equal((await service.getPosting({accountId:'a',storeId:'s'},'new-1-1','FBS')).posting.products[0].unitCostCny,'6.00');
    // A database failure after an imported page must not advance its persisted cursor.
    await pool.query("CREATE FUNCTION reject_order_page() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.state->>'status'='RUNNING' AND NEW.state->>'pages'='1' THEN RAISE EXCEPTION 'fixture commit failure'; END IF; RETURN NEW; END $$");
    await pool.query('CREATE TRIGGER reject_order_page BEFORE UPDATE ON ozon_order_management_sync FOR EACH ROW EXECUTE FUNCTION reject_order_page()');
    await api('/ozon/order-management/sync?storeId=s','POST',{});await service.processNext();
    const rolledBack=(await service.syncStatus({accountId:'a',storeId:'s'})).sync;
    assert.equal(rolledBack.status,'FAILED');assert.equal(rolledBack.pages,0);assert.equal(rolledBack.processed,0);
    await pool.query('DROP TRIGGER reject_order_page ON ozon_order_management_sync');
    // Concurrent workers must never advance one page twice.
    await api('/ozon/order-management/sync?storeId=s','POST',{});
    let release;delay=new Promise(resolve=>{release=resolve});const one=service.processNext();
    await new Promise(resolve=>setTimeout(resolve,20));await service.processNext();release();await one;delay=null;
    assert.equal((await service.syncStatus({accountId:'a',storeId:'s'})).sync.pages,1);
    fail=true;await service.processNext();
    overview=(await service.overview({accountId:'a',storeId:'s'}));assert.equal(overview.total,4);assert.equal(overview.sync.status,'FAILED');assert.ok(overview.sync.lastError);assert.ok(!JSON.stringify(overview).includes('fixture-secret'));
    fail=false;repeat=true;await api('/ozon/order-management/sync?storeId=s','POST',{});await service.processNext();await service.processNext();
    assert.equal((await service.syncStatus({accountId:'a',storeId:'s'})).sync.status,'FAILED');
    repeat=false;await api('/ozon/order-management/sync?storeId=s','POST',{});await pool.query("UPDATE stores SET status='disabled' WHERE id='s'");const count=calls.length;await service.processNext();assert.equal(calls.length,count);
    await pool.query("UPDATE stores SET status='active' WHERE id='s'");
    // Home pending view merges both status groups before paging, including old stored rows.
    for(const [suffix,status,at] of [['pack','awaiting_approve','2026-09-10T12:00:00Z'],['ship','awaiting_deliver','2026-09-10T11:00:00Z'],['accept','acceptance_in_progress','2026-09-10T10:00:00Z'],['done','delivered','2026-09-10T13:00:00Z'],['old','awaiting_packaging','2026-07-01T00:00:00Z']]){
      const number=`home-pending-${suffix}`;
      await pool.query(`INSERT INTO orders(id,store_id,posting_number,status,in_process_at,raw) VALUES($1,'s',$1,$2,$3,$4)`,[number,status,at,rawPosting(number,11,{status,in_process_at:at})]);
    }
    const pendingPath='/ozon/order-management/overview?storeId=s&status=pending&q=home-pending&pageSize=2';
    const pendingFirst=await api(pendingPath+'&page=1'),pendingSecond=await api(pendingPath+'&page=2');
    assert.equal(pendingFirst.status,200);assert.equal(pendingFirst.body.total,3);assert.equal(pendingSecond.body.total,3);
    assert.deepEqual(pendingFirst.body.items.map(item=>item.postingNumber),['home-pending-pack','home-pending-ship']);
    assert.deepEqual(pendingSecond.body.items.map(item=>item.postingNumber),['home-pending-accept']);
    assert.equal(pendingFirst.body.statusCounts.pending,3);
    await pool.query("UPDATE accounts SET expires_at=NOW()-INTERVAL '1 day' WHERE id='a'");
    assert.equal((await api('/ozon/order-management/overview?storeId=s')).status,403);
    assert.equal((await pool.query("SELECT count(*) AS count FROM orders WHERE store_id='other'")).rows[0].count,'1');
  }finally{await runtime?.stop();if(http)await new Promise(resolve=>http.close(resolve));await pool?.end();await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();}
});
