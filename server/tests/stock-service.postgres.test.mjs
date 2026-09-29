import './support/dedicated-postgres-test-environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import pg from 'pg';
import {createStockService} from '../stock-service.mjs';
import {createStockRuntime} from '../stock-runtime.mjs';

test('库存修改 HTTP 与数据库流程：权限、重复提交、冲突、限流、部分失败、超时核对及重启恢复',{skip:process.env.SONLI_POSTGRES_TESTS!=='1'},async()=>{
  const schema='stock_'+randomUUID().replaceAll('-',''),admin=new pg.Pool({connectionString:process.env.DATABASE_URL});let pool,http;
  try{
    await admin.query(`CREATE SCHEMA ${schema}`);pool=new pg.Pool({connectionString:process.env.DATABASE_URL,options:`-c search_path=${schema}`,max:10});
    await pool.query(`CREATE TABLE accounts(id TEXT PRIMARY KEY,status TEXT,expires_at TIMESTAMPTZ);CREATE TABLE stores(id TEXT PRIMARY KEY,owner_account_id TEXT,status TEXT);
      INSERT INTO accounts VALUES('a','active',NULL),('b','active',NULL);INSERT INTO stores VALUES('s','a','active'),('other','b','active');
      CREATE TABLE products(store_id TEXT,product_id TEXT,offer_id TEXT,sku TEXT,name TEXT,is_archived BOOLEAN);
      INSERT INTO products VALUES('s','11','offer','sku','商品',FALSE),('other','12','other-offer','other-sku','他店商品',FALSE)`);
    for(const file of ['118_ozon_write_rate_reservations.sql','131_stock_management.sql'])await pool.query(await readFile(new URL('../db/migrations/'+file,import.meta.url),'utf8'));
    let now=Date.now(),writes=0,mode='ok',readFailure=false,route='CN';const selectedRoutes=[];
    const rows=[{warehouseId:'22',name:'仓库一',currentStock:8,reserved:2,present:10,writable:true},{warehouseId:'23',name:'仓库二',currentStock:3,reserved:0,present:3,writable:true},{warehouseId:'24',currentStock:2,writable:false}];
    const ozon={read:async(c)=>{selectedRoutes.push(c.ozonRoute);if(readFailure)throw Object.assign(Error('读取超时'),{status:504,code:'ZONGZI_TIMEOUT'});return structuredClone(rows);},write:async(c,p,items)=>{
      writes++;selectedRoutes.push(c.ozonRoute);assert.equal(p.offerId,'offer');
      if(mode==='timeout'){readFailure=true;throw Object.assign(Error('请求超时'),{status:504,code:'ZONGZI_TIMEOUT'});}
      return items.map((item,index)=>{if(mode==='partial'&&index===1)return {status:'FAILED',message:'仓库限制'};rows.find(x=>x.warehouseId===item.warehouseId).currentStock=item.targetStock;return {status:'SUCCEEDED',proof:'ACKNOWLEDGED',message:'平台已确认修改'};});
    }};
    const options={pool,ozon,readCredential:async()=>({clientId:'fixture',apiKey:'fixture',ozonRoute:route}),clock:()=>now};
    let service=createStockService(options);const scope={accountId:'a',storeId:'s'};
    const runtime=createStockRuntime({resolveService:async()=>service,authenticate:async req=>{if(req.headers.authorization!=='Bearer fixture')throw Object.assign(Error('请登录'),{status:401});return {id:'a',role:'user'};},readJson:async req=>{const chunks=[];for await(const c of req)chunks.push(c);return JSON.parse(Buffer.concat(chunks).toString());},sendJson:(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(data));}});
    http=createServer(async(req,res)=>{if(!await runtime.handleRoute(req,res,new URL(req.url,'http://localhost'))){res.writeHead(404);res.end();}});await new Promise(resolve=>http.listen(0,'127.0.0.1',resolve));
    const base=`http://127.0.0.1:${http.address().port}`,headers={Authorization:'Bearer fixture','Content-Type':'application/json'};
    assert.equal((await fetch(base+'/ozon/stocks/product?storeId=s&productId=11')).status,401);
    assert.equal((await fetch(base+'/api/ozon/stocks/product?storeId=other&productId=12',{headers})).status,403);
    assert.equal((await fetch(base+'/api/ozon/stocks/product?storeId=s&productId=12',{headers})).status,404);
    assert.equal((await service.product(scope,'11')).warehouses[0].reserved,2);assert.equal(writes,0);
    const input=(target,warehouseId='22')=>({id:randomUUID(),productId:'11',items:[{warehouseId,expectedStock:rows.find(x=>x.warehouseId===warehouseId).currentStock,targetStock:target}]});
    await assert.rejects(service.submit(scope,input(0,'24')),e=>e.status===409);
    await assert.rejects(service.submit(scope,input(-1)),e=>e.status===400);
    let body=input(5),response=await fetch(base+'/api/ozon/stocks/changes?storeId=s',{method:'POST',headers,body:JSON.stringify(body)});
    assert.equal(response.status,200);let job=await response.json();assert.equal(job.status,'QUEUED');
    const duplicate=await service.submit(scope,body);assert.equal(duplicate.id,job.id);
    await assert.rejects(service.submit(scope,{...body,items:[{...body.items[0],targetStock:4}]}),e=>e.status===409);
    await Promise.all([service.processNext(),service.processNext()]);assert.equal(writes,1);
    assert.equal((await service.changes(scope,'11')).records.find(x=>x.id===job.id).status,'COMPLETED');
    await service.submit(scope,body);await service.processNext();assert.equal(writes,1);
    // A second distinct intent waits for the shared product/warehouse 30-second limit.
    job=await service.submit(scope,input(4));await service.processNext();assert.equal(writes,1);
    now+=31000;await service.processNext();assert.equal(writes,2);
    // Orders or another ERP changing the available stock while queued must cancel this stale intent.
    now+=31000;job=await service.submit(scope,input(2));rows[0].currentStock=3;await service.processNext();assert.equal(writes,2);assert.equal((await service.changes(scope,'11')).records.find(x=>x.id===job.id).status,'FAILED');
    // Partial rejection leaves the successful warehouse intact.
    mode='partial';job=await service.submit(scope,{id:randomUUID(),productId:'11',items:[{warehouseId:'22',expectedStock:3,targetStock:2},{warehouseId:'23',expectedStock:3,targetStock:1}]});
    await service.processNext();assert.equal((await service.changes(scope,'11')).records.find(x=>x.id===job.id).status,'PARTIAL');assert.equal(rows[0].currentStock,2);assert.equal(rows[1].currentStock,3);
    // Lost write response and read outage: durable unknown, never blindly write again.
    mode='timeout';now+=31000;job=await service.submit(scope,input(1));await service.processNext();const sent=writes;
    assert.equal((await service.changes(scope,'11')).records.find(x=>x.id===job.id).status,'UNCERTAIN');
    route='RU';selectedRoutes.length=0;service=createStockService(options);now+=61000;await service.processNext();assert.equal(writes,sent);
    assert.ok(selectedRoutes.length);assert.ok(selectedRoutes.every(route=>route==='CN'),'重启核对必须保留首次执行线路');
    readFailure=false;rows[0].currentStock=1;job=await service.reconcile(scope,job.id);assert.equal(job.status,'COMPLETED');assert.equal(job.items[0].proof,'READBACK');assert.equal(writes,sent);
    await assert.rejects(service.reconcile({accountId:'b',storeId:'other'},job.id),e=>e.status===404);
    // A process death immediately after journaling SENDING recovers by querying, without transmission.
    mode='ok';now+=31000;job=await service.submit(scope,input(0));
    const stored=(await pool.query('SELECT body FROM ozon_stock_changes WHERE id=$1',[job.id])).rows[0].body;stored.items[0].status='SENDING';
    await pool.query("UPDATE ozon_stock_changes SET status='RUNNING',body=$2 WHERE id=$1",[job.id,stored]);
    await service.processNext();assert.equal(writes,sent);assert.equal((await service.changes(scope,'11')).records.find(x=>x.id===job.id).status,'UNCERTAIN');
    await service.close(scope,job.id);assert.equal((await service.changes(scope,'11')).records.find(x=>x.id===job.id).status,'CLOSED');
    // Concurrent retries must not occupy every pooled connection with waiting locks.
    const narrowPool=new pg.Pool({connectionString:process.env.DATABASE_URL,options:`-c search_path=${schema} -c statement_timeout=400`,max:2});
    try{
      const narrowService=createStockService({...options,pool:narrowPool}),sameIntent=input(0);
      const concurrent=await Promise.allSettled(Array.from({length:8},()=>narrowService.submit(scope,sameIntent)));
      assert.equal(concurrent.filter(r=>r.status==='fulfilled').length,8,'等待同一商品锁不能占满连接池');
      await narrowService.processNext();
    }finally{await narrowPool.end();}
    // Store deactivation between submit and execution prevents the write.
    job=await service.submit(scope,input(2));const beforeDisabled=writes;await pool.query("UPDATE stores SET status='disabled' WHERE id='s'");await service.processNext();assert.equal(writes,beforeDisabled);
    assert.equal((await pool.query('SELECT status FROM ozon_stock_changes WHERE id=$1',[job.id])).rows[0].status,'FAILED');
  }finally{if(http)await new Promise(resolve=>http.close(resolve));await pool?.end();await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();}
});


test('批量库存 HTTP：范围校验、实时预览、逐商品失败、幂等与账号隔离',{skip:process.env.SONLI_POSTGRES_TESTS!=='1'},async()=>{
 const schema='batch_'+randomUUID().replaceAll('-',''),admin=new pg.Pool({connectionString:process.env.DATABASE_URL});let pool,http;
 try{
  await admin.query(`CREATE SCHEMA ${schema}`);pool=new pg.Pool({connectionString:process.env.DATABASE_URL,options:`-c search_path=${schema}`});
  await pool.query(`CREATE TABLE accounts(id TEXT PRIMARY KEY,status TEXT,expires_at TIMESTAMPTZ);CREATE TABLE stores(id TEXT PRIMARY KEY,owner_account_id TEXT,status TEXT);
    INSERT INTO accounts VALUES('a','active',NULL),('b','active',NULL);INSERT INTO stores VALUES('s','a','active'),('other','b','active');
    CREATE TABLE products(store_id TEXT,product_id TEXT,offer_id TEXT,sku TEXT,name TEXT,is_archived BOOLEAN);
    INSERT INTO products VALUES('s','11','one','one','商品一',FALSE),('s','12','two','two','商品二',FALSE),('s','13','archived','archived','已归档',TRUE),('other','14','foreign','foreign','他店',FALSE)`);
  for(const file of ['118_ozon_write_rate_reservations.sql','131_stock_management.sql'])await pool.query(await readFile(new URL('../db/migrations/'+file,import.meta.url),'utf8'));
  const stocks={'11':8,'12':4},writes=[];let reads=0;
  const warehouse=p=>[{warehouseId:'22',name:'主仓',currentStock:stocks[p.productId],writable:true}];
  const service=createStockService({pool,readCredential:async()=>({clientId:'batch-fixture'}),ozon:{read:async(c,p)=>warehouse(p),readMany:async(c,products)=>{reads++;return products.map(product=>({product,warehouses:warehouse(product)}));},write:async(c,p,items)=>{writes.push(p.productId);stocks[p.productId]=items[0].targetStock;return [{status:'SUCCEEDED',proof:'ACKNOWLEDGED'}];}}});
  const runtime=createStockRuntime({resolveService:async()=>service,authenticate:async()=>({id:'a'}),readJson:async req=>{const chunks=[];for await(const c of req)chunks.push(c);return JSON.parse(Buffer.concat(chunks));},sendJson:(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(data));}});
  http=createServer(async(req,res)=>{if(!await runtime.handleRoute(req,res,new URL(req.url,'http://localhost'))){res.writeHead(404);res.end();}});await new Promise(resolve=>http.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${http.address().port}/api/ozon/stocks`,scope={accountId:'a',storeId:'s'};
  const post=(path,body)=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  assert.equal((await post('/batch-preview?storeId=s',{productIds:['11','14']})).status,404);
  assert.equal((await post('/batch-preview?storeId=other',{productIds:['14']})).status,403);
  assert.equal((await post('/batch-preview?storeId=s',{productIds:Array.from({length:101},(_,i)=>String(i+1))})).status,400);
  const preview=await (await post('/batch-preview?storeId=s',{productIds:['11','12','13']})).json();
  assert.equal(preview.items.length,3);assert.equal(preview.items.find(i=>i.product.productId==='13').reason,'已归档商品不能修改');assert.equal(writes.length,0);
  const requests=['11','12'].map(productId=>({id:randomUUID(),productId,items:[{warehouseId:'22',expectedStock:stocks[productId],targetStock:2}]}));
  stocks['12']=3; // Platform changes one SKU after the user saw the preview.
  const beforeReads=reads,response=await post('/batch?storeId=s',{requests}),result=await response.json();
  assert.equal(response.status,200);assert.equal(reads,beforeReads+1);assert.equal(result.results[0].record.status,'QUEUED');assert.equal(result.results[1].code,'STOCK_CHANGED');
  await service.processNext();assert.deepEqual(writes,['11']);assert.equal(stocks['11'],2);assert.equal(stocks['12'],3);
  const repeated=await (await post('/batch?storeId=s',{requests})).json();assert.equal(repeated.results[0].record.id,requests[0].id);await service.processNext();assert.deepEqual(writes,['11']);
  const recordResponse=await fetch(base+`/batch-status?storeId=s&ids=${requests[0].id}`);assert.equal(recordResponse.status,200);assert.equal((await recordResponse.json()).records[0].status,'COMPLETED');
  assert.equal((await service.batchStatus({accountId:'b',storeId:'other'},[requests[0].id])).records.length,0);
 }finally{if(http)await new Promise(resolve=>http.close(resolve));await pool?.end();await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();}
});
