import './support/dedicated-postgres-test-environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {createServer} from 'node:http';
import {createAiListingRuntime} from '../ai-listing-runtime.mjs';
import {createSkuBilling} from '../ai-sku-billing.mjs';

const enabled=process.env.SONLI_POSTGRES_TESTS==='1';
const actor={id:'admin',role:'admin'};
async function fixture(t){
 const schema='billing_management_'+randomUUID().replaceAll('-','');
 const admin=new pg.Pool({connectionString:process.env.DATABASE_URL});
 await admin.query(`CREATE SCHEMA ${schema}`);
 const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,options:`-c search_path=${schema}`,max:5});
 t.after(async()=>{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});
 await pool.query(`CREATE TABLE accounts(id TEXT PRIMARY KEY,role TEXT,username TEXT);
 INSERT INTO accounts VALUES('admin','admin','管理员'),('u','user','tbc123'),('v','user','另一个用户');
 CREATE TABLE ai_user_channel_requests(id TEXT PRIMARY KEY,account_id TEXT,task_id TEXT,status TEXT,created_at TIMESTAMPTZ DEFAULT NOW(),completed_at TIMESTAMPTZ);`);
 for(const name of ['106_ai_image_listing.sql','115_ai_sku_billing.sql'])await pool.query(await readFile(new URL('../db/migrations/'+name,import.meta.url),'utf8'));
 const billing=createSkuBilling({pool});
 // Existing v1.0.2 data must survive the additive migration, not only newly created records.
 await pool.query(`INSERT INTO ai_user_wallets VALUES('u',1000,0,20),('v',300,0,50);
 INSERT INTO ai_wallet_entries(id,account_id,kind,amount_cents,actor_id) VALUES('topup:old','u','TOPUP',1000,'admin'),('topup:other','v','TOPUP',300,'admin');
 INSERT INTO ai_image_listing_tasks(id,account_id,dedupe_key,status,body,next_run_at,created_at) VALUES('task','u','task','GENERATING','{"name":"测试商品","images":[{"sku":"sku-a","generatedUrl":null},{"sku":"sku-b","generatedUrl":null}]}',0,0);
 INSERT INTO ai_user_channel_requests(id,account_id,task_id,status,estimated_cost_cny,completed_at) VALUES('request','u','task','SUCCEEDED',0.4,NOW()),('unknown','u','task','FAILED',NULL,NOW()),('inflight','u','task','STARTED',0.2,NULL);`);
 try{await pool.query(await readFile(new URL('../db/migrations/137_ai_billing_management.sql',import.meta.url),'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
 const wallet=async()=> (await pool.query("SELECT * FROM ai_user_wallets WHERE account_id='u'")).rows[0];
 const edit=(action,extra={})=>billing.configure(actor,{accountId:'u',action,reason:'更正测试记录',idempotencyKey:randomUUID(),...extra});
 return {billing,pool,wallet,edit};
}

test('管理员更正旧充值、删除和恢复时同步余额；重试不重复入账且保留历史', {skip:!enabled},async t=>{
 const {billing,pool,wallet,edit}=await fixture(t);
 const input={entryId:'topup:old',revision:0,amount:'12.34',idempotencyKey:'edit-old'};
 await edit('edit_entry',input);await edit('edit_entry',input);
 assert.equal((await wallet()).balance_cents,'1234');
 await assert.rejects(edit('edit_entry',{...input,amount:'12.35'}),{statusCode:409});
 await assert.rejects(edit('edit_entry',{...input,idempotencyKey:'stale'}),{statusCode:409});
 await edit('delete_entry',{entryId:'topup:old',revision:1,idempotencyKey:'delete-old'});
 await edit('delete_entry',{entryId:'topup:old',revision:1,idempotencyKey:'delete-old'});
 assert.equal((await wallet()).balance_cents,'0');
 const deleted=await billing.records(actor,{type:'wallet',deleted:'true'});
 assert.equal(deleted.total,1);assert.equal(deleted.items[0].amount_cents,'1234');
 await edit('restore_entry',{entryId:'topup:old',revision:2});
 assert.equal((await wallet()).balance_cents,'1234');
 // The original topup retry retains its original intent after an administrator edited it.
 await billing.configure(actor,{accountId:'u',action:'topup',amount:'10',idempotencyKey:'old'});
 assert.equal((await wallet()).balance_cents,'1234');
 assert.equal((await pool.query('SELECT count(*)::int n FROM ai_billing_changes')).rows[0].n,3);
 const history=(await billing.snapshot(actor)).history;
 assert.equal(history.length,3);assert.ok(history.every(x=>x.actor_id==='admin'&&x.reason));
});

test('预留保护、精确余额调整和单价清除不改任务冻结价格', {skip:!enabled},async t=>{
 const {billing,pool,wallet,edit}=await fixture(t);
 await billing.reconcile({accountId:'u',taskId:'task',reserve:true});
 assert.equal((await wallet()).reserved_cents,'40');
 await assert.rejects(edit('balance',{amount:'0',expectedBalanceCents:'1000'}),{statusCode:409});
 await assert.rejects(edit('delete_entry',{entryId:'topup:old',revision:0}),{statusCode:409});
 await edit('balance',{amount:'0.40',expectedBalanceCents:'1000',idempotencyKey:'set-balance'});
 await edit('balance',{amount:'0.40',expectedBalanceCents:'1000',idempotencyKey:'set-balance'});
 assert.equal((await wallet()).balance_cents,'40');
 assert.equal((await pool.query('SELECT SUM(amount_cents)::text n FROM ai_wallet_entries WHERE account_id=$1 AND voided_at IS NULL',['u'])).rows[0].n,'40');
 await edit('clear_price',{expectedPriceCents:'20'});assert.equal((await wallet()).sku_price_cents,null);
 await edit('price',{amount:'0.30',expectedPriceCents:null});
 assert.equal((await pool.query("SELECT unit_cents FROM ai_task_billing WHERE task_id='task'")).rows[0].unit_cents,'20');
 await assert.rejects(edit('price',{amount:'0.40',expectedPriceCents:'20'}),{statusCode:409});
});

test('删除成功 SKU 的收费会退款，恢复或后台再次对账均不会重复扣费', {skip:!enabled},async t=>{
 const {billing,pool,wallet,edit}=await fixture(t);
 await billing.reconcile({accountId:'u',taskId:'task',reserve:true});
 await pool.query(`UPDATE ai_image_listing_tasks SET status='AWAITING_REVIEW',body='{"name":"测试商品","images":[{"sku":"sku-a","generatedUrl":"https://fixture.invalid/a"},{"sku":"sku-b","generatedUrl":"https://fixture.invalid/b"}]}' WHERE id='task'`);
 await billing.reconcile({accountId:'u',taskId:'task'});
 const entry=(await billing.snapshot(actor)).entries.find(x=>x.sku==='sku-a');
 await edit('edit_entry',{entryId:entry.id,revision:0,amount:'0.10'});
 assert.equal((await wallet()).balance_cents,'970');
 await edit('delete_entry',{entryId:entry.id,revision:1});
 await billing.reconcile({accountId:'u',taskId:'task'});
 assert.equal((await wallet()).balance_cents,'980');
 const product=(await billing.snapshot(actor)).products[0];
 assert.equal(product.charged_cents,'20');assert.equal(product.successful_skus,1);
 await edit('restore_entry',{entryId:entry.id,revision:2});
 await billing.reconcile({accountId:'u',taskId:'task'});
 assert.equal((await wallet()).balance_cents,'970');
 assert.equal((await pool.query("SELECT count(*)::int n FROM ai_wallet_entries WHERE kind='SKU_CHARGE'")).rows[0].n,2);
});

test('成本更正精确到六位、删除可恢复且保留平台原值，不影响余额或在途请求', {skip:!enabled},async t=>{
 const {billing,pool,wallet,edit}=await fixture(t);
 await edit('edit_cost',{requestId:'request',revision:0,amount:'0.123456'});
 assert.equal((await billing.records(actor,{type:'cost',accountId:'u',taskId:'task'})).items.find(x=>x.id==='request').effective_cost_cny,'0.123456');
 assert.equal((await pool.query("SELECT estimated_cost_cny FROM ai_user_channel_requests WHERE id='request'")).rows[0].estimated_cost_cny,'0.400000');
 assert.equal((await wallet()).balance_cents,'1000');
 await edit('delete_cost',{requestId:'request',revision:1});
 assert.equal((await billing.snapshot(actor)).costTotal.estimated_cny,'0.200000');
 await edit('restore_cost',{requestId:'request',revision:2});
 await edit('edit_cost',{requestId:'unknown',revision:0,amount:'1.000001'});
 const total=(await billing.snapshot(actor)).costTotal;assert.equal(total.estimated_cny,'1.323457');assert.equal(total.unpriced,0);
 await assert.rejects(edit('delete_cost',{requestId:'inflight',revision:0}),{statusCode:409});
 await assert.rejects(edit('edit_cost',{requestId:'request',revision:3,amount:'0.0000001'}),{statusCode:400});
});

test('更正入口阻止越权、错误账号与并发旧值覆盖；账单分页保留账号隔离', {skip:!enabled},async t=>{
 const {billing,pool,wallet,edit}=await fixture(t);
 await assert.rejects(billing.configure({id:'u',role:'user'},{accountId:'u',action:'balance',amount:'100',reason:'bad',idempotencyKey:'bad'}),{statusCode:403});
 await assert.rejects(edit('delete_entry',{entryId:'topup:other',revision:0}),{statusCode:404});
 await assert.rejects(edit('balance',{amount:'1',expectedBalanceCents:'1000',reason:''}),{statusCode:400});
 const results=await Promise.allSettled([edit('balance',{amount:'8',expectedBalanceCents:'1000'}),edit('balance',{amount:'7',expectedBalanceCents:'1000'})]);
 assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
 assert.ok(['700','800'].includes((await wallet()).balance_cents));
 const own=await billing.records({id:'u',role:'user'},{type:'wallet',accountId:'v'});
 assert.ok(own.items.every(x=>x.account_id==='u'));
 await assert.rejects(billing.records({id:'u',role:'user'},{type:'cost'}),{statusCode:403});
 assert.equal(Object.hasOwn(await billing.snapshot({id:'u',role:'user'}),'history'),false);
 await pool.query("INSERT INTO ai_wallet_entries(id,account_id,kind,amount_cents) SELECT 'old-'||n,'u','TOPUP',0 FROM generate_series(1,25)n");
 const page=await billing.records(actor,{type:'wallet',accountId:'u',page:'2'});assert.equal(page.page,2);assert.equal(page.total,27);assert.equal(page.items.length,7);
});


test('真实 HTTP 接口显示具体余额错误，并在服务端拒绝普通用户修改及成本访问', {skip:!enabled},async t=>{
 const {billing,pool,wallet}=await fixture(t);
 const runtime=createAiListingRuntime({repository:{},resolvePool:async()=>pool,env:{},
  authenticate:async req=>({id:req.headers['x-fixture-role']==='user'?'u':'admin',role:req.headers['x-fixture-role']==='user'?'user':'admin'}),
  readJson:async req=>{let body='';for await(const chunk of req)body+=chunk;return JSON.parse(body||'{}');},
  sendJson:(res,status,body)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(body));}});
 const server=createServer(async(req,res)=>{if(!await runtime.handleRoute(req,res,new URL(req.url,'http://fixture.invalid'))){res.writeHead(404);res.end();}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const base=`http://127.0.0.1:${server.address().port}/api/ai-listing/billing`;
 const request=async(path='',body,role='admin')=>{
  const res=await fetch(base+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json','x-fixture-role':role},...(body?{body:JSON.stringify(body)}:{})});
  return {status:res.status,body:await res.json()};
 };
 assert.equal((await request()).body.wallets.find(w=>w.account_id==='u').balance_cents,'1000');
 await billing.reconcile({accountId:'u',taskId:'task',reserve:true});
 const attempt={accountId:'u',action:'balance',amount:'0.00',expectedBalanceCents:'1000',reason:'HTTP fixture',idempotencyKey:'http'};
 const rejected=await request('',attempt);assert.equal(rejected.status,409);assert.match(rejected.body.message,/预留/);
 assert.equal((await request('',attempt,'user')).status,403);
 assert.equal((await request('/records?type=cost',null,'user')).status,403);
 const own=await request('/records?type=wallet&accountId=v',null,'user');assert.equal(own.status,200);assert.deepEqual(own.body.items.map(x=>x.account_id),['u']);
 const success=await request('',{...attempt,amount:'9.00'});assert.equal(success.status,200);assert.equal((await wallet()).balance_cents,'900');
 assert.equal((await request('/records?type=wallet&accountId=u')).body.total,2);
});

test('billing page size keeps account scope and nonoverlapping record pages',{skip:!enabled},async t=>{
 const {billing,pool}=await fixture(t);
 await pool.query("INSERT INTO ai_wallet_entries(id,account_id,kind,amount_cents,actor_id) SELECT 'page-'||g,'u','TOPUP',1,'admin' FROM generate_series(1,62) g");
 for(const pageSize of [5,10,20,50]){
  const first=await billing.records({id:'u',role:'user'},{page:1,pageSize,accountId:'v'}),second=await billing.records({id:'u',role:'user'},{page:2,pageSize});
  assert.equal(first.total,63);assert.equal(first.items.length,pageSize);assert.equal(second.items.length,Math.min(pageSize,63-pageSize));
  assert.ok([...first.items,...second.items].every(row=>row.account_id==='u'));
  assert.equal(new Set([...first.items,...second.items].map(row=>row.id)).size,first.items.length+second.items.length);
 }
});
