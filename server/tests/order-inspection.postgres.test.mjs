import './support/dedicated-postgres-test-environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import pg from 'pg';
import {createOrderManagementService} from '../order-management-service.mjs';
import {createOrderManagementOzon} from '../order-management-ozon.mjs';

const defaults=['02131','02478','02090','02782','02793','02809'];
const day=86400000;
const enabled=process.env.SONLI_POSTGRES_TESTS==='1';
async function harness({stores=[['a1','a','2026-09-09'],['a2','a','2026-09-08'],['empty','a','2026-09-10'],['b1','b','2026-09-09']]}={}) {
  const module=await import('../order-inspection-service.mjs').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return {};throw e;});
  assert.equal(typeof module.createOrderInspectionService,'function','the account-wide inspection service must be implemented');
  const {createOrderInspectionRuntime}=await import('../order-inspection-runtime.mjs');
  const schema='inspection_'+randomUUID().replaceAll('-','');
  const admin=new pg.Pool({connectionString:process.env.DATABASE_URL});
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,options:`-c search_path=${schema}`,max:10});
  let runtime,http;
  try {
    await pool.query(await readFile(new URL('../db/migrations/001_formal_schema.sql',import.meta.url),'utf8'));
    await pool.query(`ALTER TABLE stores ADD COLUMN owner_account_id TEXT REFERENCES accounts(id);
      INSERT INTO accounts(id,username) VALUES('a','a'),('b','b')`);
    for(const [id,owner,boundAt] of stores)await pool.query('INSERT INTO stores(id,client_id,owner_account_id,label,status,saved_at) VALUES($1,$1,$2,$1,\'active\',$3)',[id,owner,boundAt]);
    await pool.query(await readFile(new URL('../db/migrations/132_order_management.sql',import.meta.url),'utf8'));
    await pool.query(await readFile(new URL('../db/migrations/133_order_inspection.sql',import.meta.url),'utf8'));
    let now=Date.parse('2026-09-12T08:00:00.000Z');const calls=[],failStores=new Set(),incoming=new Map(),failFbo=new Set();
    const ozon=createOrderManagementOzon({callApi:async(credential,path,body)=>{
      assert.ok(['/v4/posting/fbs/list','/v3/posting/fbo/list'].includes(path),'only read-only order endpoints are permitted');
      calls.push({storeId:credential.storeId,path,body});
      if(failStores.has(credential.storeId)||(path==='/v3/posting/fbo/list'&&failFbo.has(credential.storeId)))throw Object.assign(Error('private-upstream-detail'),{status:503});
      return {postings:path==='/v4/posting/fbs/list'?(incoming.get(credential.storeId)||[]):[],has_next:false,cursor:''};
    }});
    const orders=createOrderManagementService({pool,ozon,clock:()=>now,readCredential:async(storeId,accountId)=>{
      assert.equal((await pool.query('SELECT owner_account_id FROM stores WHERE id=$1',[storeId])).rows[0]?.owner_account_id,accountId);
      return {storeId};
    }});
    let inspection=module.createOrderInspectionService({pool,orderService:orders,clock:()=>now});
    runtime=createOrderInspectionRuntime({resolveService:async()=>inspection,authenticate:async req=>{
      const id=req.headers.authorization?.replace(/^Bearer /,'');
      const account=(await pool.query("SELECT id,role FROM accounts WHERE id=$1 AND status='active' AND (expires_at IS NULL OR expires_at>NOW())",[id])).rows[0];
      if(!account)throw Object.assign(Error('请登录'),{status:401});return account;
    },readJson:async req=>{const chunks=[];for await(const chunk of req)chunks.push(chunk);return JSON.parse(Buffer.concat(chunks).toString()||'{}');},sendJson:(res,status,body)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(body));}});
    http=createServer(async(req,res)=>{if(!await runtime.handleRoute(req,res,new URL(req.url,'http://localhost'))){res.writeHead(404);res.end();}});
    await new Promise(resolve=>http.listen(0,'127.0.0.1',resolve));
    const base=`http://127.0.0.1:${http.address().port}/api/ozon/order-inspection`;
    return {pool,orders,calls,failStores,incoming,failFbo,makeInspector:(ports,database=pool)=>module.createOrderInspectionService({pool:database,orderService:ports,clock:()=>now}),get inspection(){return inspection;},get now(){return now;},advance:ms=>{now+=ms;},
      restart:()=>{inspection=module.createOrderInspectionService({pool,orderService:orders,clock:()=>now});},
      api:async(path,method='GET',body,account='a')=>{const response=await fetch(base+path,{method,headers:{authorization:'Bearer '+account,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:response.status,body:await response.json()};},
      insert:async(storeId,orderNumber,{postingNumber=orderNumber+'-1',at='2026-09-10T00:00:00Z',status='delivered',management=false}={})=>{
        const raw={posting_number:postingNumber,order_number:orderNumber,order_id:999,status,products:[{sku:11,name:'Товар',quantity:1}],in_process_at:at};
        const body={orderNumber,postingNumber,status,statusGroup:status==='cancelled'?'cancelled':'delivered',scheme:'FBS',products:[{sku:'11',name:'Товар',quantity:1,imageUrl:null}]};
        await pool.query('INSERT INTO orders(id,store_id,posting_number,order_id,status,shipment_type,in_process_at,raw,management_data) VALUES($1,$2,$3,\'999\',$4,\'FBS\',$5,$6,$7)',[randomUUID(),storeId,postingNumber,status,at,raw,management?body:null]);
      },
      close:async()=>{await runtime.stop();await new Promise(resolve=>http.close(resolve));await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();},
    };
  } catch(error){await runtime?.stop();if(http)await new Promise(resolve=>http.close(resolve));await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();throw error;}
}

test('HTTP settings, all-store historical detection, split-order identity and durable ACK stay account scoped',{skip:!enabled},async()=>{
  const h=await harness();try {
    for(const prefix of defaults)await h.insert('a1',prefix+'00000-0001',{at:prefix==='02131'?'2019-01-01':'2026-09-10',management:prefix==='02478'});
    await h.insert('a1','0213100000-0001',{postingNumber:'0213100000-0001-2',status:'cancelled',at:'2019-01-01'});
    await h.insert('a2','0213100000-0001');await h.insert('a1','9999900000-0001');await h.insert('b1','0213100000-0001');
    await h.insert('a1','',{postingNumber:'02131-not-an-order'});
    assert.equal((await h.api('/summary','GET',undefined,'unauthorized')).status,401);
    assert.deepEqual((await h.api('/settings')).body,{prefixes:defaults,updatedAt:null});
    let overview=(await h.api('/overview')).body;
    assert.equal(overview.total,7);assert.equal(overview.unreadCount,7);assert.equal(overview.pageSize,20);
    assert.deepEqual(overview.stores.map(s=>s.storeId).sort(),['a1','a2','empty']);
    const split=overview.items.find(r=>r.storeId==='a1'&&r.orderNumber==='0213100000-0001');
    assert.equal(split.postings.length,2);assert.ok(split.postings.some(p=>p.status==='cancelled'));
    assert.equal(split.matchedPrefix,'02131');assert.equal(split.postings[0].products[0].sku,'11');
    assert.equal((await h.api('/overview?storeId=a2')).body.total,1);
    assert.equal((await h.api('/overview?storeId=b1')).status,403);
    assert.equal((await h.api('/overview?q=99999')).body.total,0);
    assert.equal(h.calls.length,0,'GET routes never fetch Ozon or queue jobs');
    for(const prefixes of [[2131],['0213'],['021310'],['02a31']])assert.equal((await h.api('/settings','PUT',{prefixes})).status,400);
    await h.api('/settings','PUT',{prefixes:[],accountId:'b'});
    assert.deepEqual((await h.api('/settings')).body.prefixes,[]);assert.equal((await h.api('/summary')).body.total,0);
    assert.deepEqual((await h.api('/settings','GET',undefined,'b')).body.prefixes,defaults);
    await h.api('/settings','PUT',{prefixes:['99999','99999']});assert.equal((await h.api('/summary')).body.total,1);
    await h.api('/settings','PUT',{prefixes:defaults});
    const oldPage=(await h.api('/overview')).body;
    const read=await h.api('/read','POST',{items:[{storeId:'a1',orderNumber:'0213100000-0001'}]});
    assert.equal(read.body.unreadCount,6);assert.equal(read.body.total,7);
    const readAt=(await h.api('/overview?readStatus=read')).body.items[0].readAt;assert.ok(readAt);
    await h.insert('a2','0247800000-new');
    await h.api('/read','POST',{items:[{storeId:'a1',orderNumber:'0213100000-0001'}]});
    assert.equal((await h.api('/summary')).body.unreadCount,7,'ACK of an old displayed row cannot swallow a later order');
    assert.equal(oldPage.unreadCount,7,'a prior GET response has no acknowledgement side effects');
    assert.equal((await h.api('/read','POST',{items:[{storeId:'a2',orderNumber:'0213100000-0001'},{storeId:'b1',orderNumber:'0213100000-0001'}]})).status,403);
    h.restart();assert.equal((await h.api('/overview?readStatus=read')).body.items[0].readAt,readAt);
    await h.api('/settings','PUT',{prefixes:['99999']});await h.api('/settings','PUT',{prefixes:defaults});
    assert.equal((await h.api('/overview?readStatus=read')).body.total,1,'rule edits preserve prior reads');
    const ordinary=await h.orders.overview({accountId:'a',storeId:'a1'},{since:'2018-01-01'});
    assert.deepEqual(ordinary.items.find(p=>p.postingNumber==='0213100000-0001-1').qualityInspection,{matched:true,prefix:'02131',readAt});
    assert.equal(ordinary.items.find(p=>p.postingNumber==='9999900000-0001-1').qualityInspection,null);
  }finally{await h.close();}
});

test('persistent per-store binding checkpoint splits long history and never consumes an unrelated manual job',{skip:!enabled},async()=>{
  const h=await harness({stores:[['a1','a','2023-01-10']]});try {
    const initialNow=h.now,boundAt='2023-01-10T00:00:00.000Z',since='2022-12-26T00:00:00.000Z';
    const manual={since:'2026-09-01T00:00:00.000Z',to:'2026-09-02T00:00:00.000Z'};
    await h.orders.requestSync({accountId:'a',storeId:'a1'},manual);
    await h.api('/sync','POST',{});await h.inspection.processNext();
    assert.equal((await h.orders.syncStatus({accountId:'a',storeId:'a1'})).sync.since,manual.since);
    let coverage=(await h.api('/overview')).body.stores[0];assert.equal(coverage.to,null);assert.equal(coverage.since,since);
    await h.orders.processNext();await h.orders.processNext();h.advance(2500);await h.inspection.processNext();
    const first=(await h.orders.syncStatus({accountId:'a',storeId:'a1'})).sync;
    assert.equal(first.since,since);assert.ok(Date.parse(first.to)-Date.parse(first.since)<=365*day);
    h.restart();await h.pool.query("UPDATE stores SET updated_at=NOW(),label='refreshed' WHERE id='a1'");
    for(let n=0;n<12;n++){
      await h.orders.processNext();await h.orders.processNext();h.advance(2500);await h.inspection.processNext();
      coverage=(await h.api('/overview')).body.stores[0];if(coverage.status==='COMPLETED')break;
    }
    assert.equal(coverage.boundAt,boundAt);assert.equal(coverage.since,since);assert.equal(coverage.to,new Date(initialNow).toISOString());
    assert.equal(coverage.status,'COMPLETED');assert.equal(coverage.lastError,null);
    const windows=h.calls.filter(c=>c.path==='/v4/posting/fbs/list'&&c.body.filter.since!==manual.since).map(c=>c.body.filter);
    assert.ok(windows.length>=3);assert.equal(windows[0].since,since);
    for(let n=0;n<windows.length;n++){assert.ok(Date.parse(windows[n].to)-Date.parse(windows[n].since)<=365*day);if(n)assert.equal(windows[n].since,windows[n-1].to);}
    const before=h.calls.length;h.advance(299000);await h.inspection.processNext();assert.equal(h.calls.length,before);
    h.advance(2000);await h.inspection.processNext();
    assert.equal((await h.orders.syncStatus({accountId:'a',storeId:'a1'})).sync.status,'QUEUED');
    assert.equal((await h.api('/overview')).body.stores[0].since,since);
  }finally{await h.close();}
});

test('failed store resumes its exact window after restart and success in another store stays visible',{skip:!enabled},async()=>{
  const h=await harness({stores:[['a1','a','2026-09-09'],['a2','a','2026-09-09']]});try {
    h.failStores.add('a1');await h.api('/sync','POST',{});
    for(let n=0;n<8;n++){await h.inspection.processNext();await h.orders.processNext();h.advance(2500);}
    let rows=(await h.api('/overview')).body.stores;
    assert.equal(rows.find(s=>s.storeId==='a1').status,'FAILED');assert.equal(rows.find(s=>s.storeId==='a1').to,null);
    assert.equal(rows.find(s=>s.storeId==='a2').status,'COMPLETED');assert.doesNotMatch(JSON.stringify(rows),/private-upstream-detail/);
    const failedRange=(await h.orders.syncStatus({accountId:'a',storeId:'a1'})).sync;
    h.failStores.clear();h.restart();await h.api('/sync','POST',{});
    for(let n=0;n<8;n++){await h.inspection.processNext();await h.orders.processNext();h.advance(2500);}
    rows=(await h.api('/overview')).body.stores;assert.ok(rows.every(s=>s.status==='COMPLETED'));
    const retry=h.calls.filter(c=>c.storeId==='a1'&&c.path==='/v4/posting/fbs/list');assert.equal(retry[1].body.filter.since,failedRange.since);assert.equal(retry[1].body.filter.to,failedRange.to);
  }finally{await h.close();}
});


test('serialized coordinators feed actual read-only sync pages into HTTP alerts and retain partial-page coverage on failure',{skip:!enabled},async()=>{
  const h=await harness({stores:[['a1','a','2026-09-09']]});try {
    h.incoming.set('a1',[1,2].map(n=>({posting_number:'0213100000-new-'+n,order_number:'0213100000-new',order_id:123,
      status:n===1?'awaiting_packaging':'cancelled',in_process_at:'2026-09-12T07:00:00Z',products:[{sku:11,name:'Actual sync shape',quantity:1,price:'10',currency_code:'RUB'}]})));
    let release,entered;const gate=new Promise(resolve=>{entered=resolve;}),blocked=new Promise(resolve=>{release=resolve;});let requested=0;
    const first=h.makeInspector({syncStatus:h.orders.syncStatus,requestSync:async(...args)=>{requested++;entered();await blocked;return h.orders.requestSync(...args);}});
    const active=first.processNext();await gate;
    assert.equal(await h.inspection.processNext(),false,'another coordinator cannot enqueue the same store concurrently');
    release();await active;assert.equal(requested,1);
    h.failFbo.add('a1');await h.orders.processNext();await h.orders.processNext();h.advance(2500);await h.inspection.processNext();
    let overview=(await h.api('/overview')).body;
    assert.equal(overview.total,1);assert.equal(overview.items[0].postings.length,2);assert.equal(overview.unreadCount,1);
    assert.equal(overview.stores[0].status,'FAILED');assert.equal(overview.stores[0].to,null,'a persisted FBS page does not imply FBO or the whole date range is complete');
    h.failFbo.clear();await h.api('/sync','POST',{});await h.inspection.processNext();await h.orders.processNext();await h.orders.processNext();h.advance(2500);await h.inspection.processNext();
    overview=(await h.api('/overview')).body;assert.equal(overview.total,1);assert.equal(overview.stores[0].status,'COMPLETED');
    assert.ok(overview.stores[0].to);assert.equal(h.calls.filter(c=>c.path==='/v4/posting/fbs/list').length,2);
  }finally{await h.close();}
});


test('a stale coordinator candidate cannot bypass the next scheduled run after another instance completes it',{skip:!enabled},async()=>{
  const h=await harness({stores:[['a1','a','2026-09-09']]});try {
    let release,entered,first=true;const reached=new Promise(resolve=>{entered=resolve;}),blocked=new Promise(resolve=>{release=resolve;});
    const delayedPool={connect:()=>h.pool.connect(),query:async(...args)=>{const result=await h.pool.query(...args);if(first){first=false;entered();await blocked;}return result;}};
    const stale=h.makeInspector(h.orders,delayedPool).processNext();await reached;
    await h.inspection.processNext();await h.orders.processNext();await h.orders.processNext();h.advance(2500);await h.inspection.processNext();
    assert.equal((await h.orders.syncStatus({accountId:'a',storeId:'a1'})).sync.status,'COMPLETED');
    release();assert.equal(await stale,false);
    assert.equal((await h.orders.syncStatus({accountId:'a',storeId:'a1'})).sync.status,'COMPLETED','a stale snapshot must not immediately enqueue another range');
  }finally{await h.close();}
});
