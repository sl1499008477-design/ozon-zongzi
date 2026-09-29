import './support/dedicated-postgres-test-environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {createAiListingRepository} from '../ai-listing-repository.mjs';
import {readProductCatalogPage} from '../local-state-reader.mjs';

const enabled=process.env.SONLI_POSTGRES_TESTS==='1';
const now=Date.parse('2026-09-27T16:15:00.000Z');
async function fixture(t) {
  const module=await import('../dashboard-service.mjs').catch(error=>{
    if(error.code==='ERR_MODULE_NOT_FOUND')return {};
    throw error;
  });
  assert.equal(typeof module.createDashboardService,'function','dashboard service must exist');
  const schema='dashboard_'+randomUUID().replaceAll('-','');
  const admin=new pg.Pool({connectionString:process.env.DATABASE_URL});
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,options:`-c search_path=${schema}`,max:10});
  t.after(async()=>{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});
  for(const name of ['001_formal_schema.sql','106_ai_image_listing.sql','129_promotion_management.sql','132_order_management.sql','133_order_inspection.sql','135_ai_product_scheduling.sql','141_ai_listing_task_controls.sql','150_ai_listing_list_summary.sql'])
    await pool.query(await readFile(new URL('../db/migrations/'+name,import.meta.url),'utf8'));
  await pool.query(`ALTER TABLE stores ADD COLUMN owner_account_id TEXT REFERENCES accounts(id);
    CREATE TABLE ai_user_wallets(account_id text PRIMARY KEY REFERENCES accounts(id),balance_cents bigint NOT NULL DEFAULT 0,reserved_cents bigint NOT NULL DEFAULT 0);
    INSERT INTO accounts(id,username,role) VALUES('a','a','admin'),('b','b','user'),('empty','empty','user');
    INSERT INTO stores(id,client_id,owner_account_id,label) VALUES('a1','a1','a','店铺一'),('a2','a2','a','店铺二'),('b1','b1','b','他人店铺');
    INSERT INTO ai_user_wallets VALUES('a',9007199254740993,123),('b',888888,0);
    INSERT INTO ozon_promotion_stores(account_id,store_id,config) VALUES('a','a1','{}'),('a','a2','{}'),('b','b1','{}');
    INSERT INTO ozon_promotion_runs(id,account_id,store_id,source,status,body,created_at,updated_at)
      VALUES('r1','a','a1','RULE','UNCERTAIN','{}',1,1),('r2','a','a2','RULE','UNCERTAIN','{}',1,1),('r3','b','b1','RULE','UNCERTAIN','{}',1,1);`);
  const dailyCalls=[];
  const readDailyListings=async input=>{dailyCalls.push(input);const stores=(await input.pool.query('SELECT id,label FROM stores WHERE owner_account_id=$1 ORDER BY id',[input.accountId])).rows;return {count:3,date:'2026-09-28',timeZone:'Asia/Shanghai',byStore:stores.map(s=>({storeId:s.id,storeName:s.label,count:s.id==='a1'?1:2})),complete:false,note:'历史记录不完整'};};
  const make=(options={})=>module.createDashboardService({pool,clock:()=>now,readDailyListings,...options});
  const order=async(id,storeId,status,at,orderNumber=id,managementStatus=null)=>pool.query(
    'INSERT INTO orders(id,store_id,posting_number,status,in_process_at,raw,management_data) VALUES($1,$2,$1,$3,$4,$5,$6)',
    [id,storeId,status,at,{order_number:orderNumber},managementStatus?{status:managementStatus,orderNumber}:null]);
  const product=async(id,storeId,status,stock,raw={})=>pool.query(
    'INSERT INTO products(id,store_id,product_id,status,stock_total,raw,synced_at) VALUES($1,$2,$1,$3,$4,$5,$6)',[id,storeId,status,stock,raw,'2026-09-27T09:00:00Z']);
  const task=async(id,status,body={},options={})=>pool.query(
    `INSERT INTO ai_image_listing_tasks(id,account_id,dedupe_key,status,body,next_run_at,created_at,deleted_at,lease_token,lease_expires_at)
      VALUES($1,$2,$1,$3,$4,0,1,$5,$6,$7)`,[id,options.accountId||'a',status,{images:[],...body},options.deletedAt??null,options.live?'lease':null,options.live?Math.max(now,Date.now())+60000:null]);
  return {pool,make,order,product,task,dailyCalls};
}

test('dashboard isolates admin accounts, keeps account counts on store changes, and aggregates historical records with small projections',{skip:!enabled},async t=>{
  const h=await fixture(t);
  for(const [id,store,status,at,number,managed] of [
    ['o1','a1','awaiting_packaging','2026-08-29T16:00:00Z','02131-one'],
    ['o2','a1','delivered','2026-09-27T17:00:00Z','02131-one','awaiting_deliver'],
    ['old','a1','awaiting_deliver','2026-08-29T15:59:59Z','ordinary'],
    ['future','a1','awaiting_deliver','2026-09-28T16:00:00Z','ordinary'],
    ['delivered','a1','delivered','2026-09-01T00:00:00Z','ordinary'],
    ['other-store','a2','awaiting_approve','2026-09-01T00:00:00Z','02478-two'],
    ['foreign','b1','awaiting_deliver','2026-09-01T00:00:00Z','02131-foreign']
  ])await h.order(id,store,status,at,number,managed);
  await h.pool.query(`INSERT INTO ozon_order_management_sync(account_id,store_id,state) VALUES('a','a1','{"completedAt":"2026-09-27T12:00:00Z"}')`);
  for(const [id,store,status,stock,raw] of [
    ['zero','a1','selling',0],['low','a1','selling',10],['plenty','a1','selling',11],['unknown','a1','selling',null],
    ['hidden','a1','hidden',0],['archived','a1','selling',0,{archived:true}],['legacy','a1','',null,{statuses:{status_name:'Продается'},stocks:{stocks:[{present:3},{present:2}]}}],
    ['invalid','a1','selling',null,{stock:''}],['foreign-product','b1','selling',0],
    ['historical-stock','a1','selling',null,{stock:0,stocks:{stocks:[{present:5}]}}],
    ['historical-visibility','a1','',0,{visibilityFilter:'visible'}]
  ])await h.product(id,store,status,stock,raw);
  await h.task('review','AWAITING_REVIEW');await h.task('failed','SUBMISSION_FAILED');await h.task('error','GENERATION_FAILED');await h.task('uncertain','SUBMISSION_UNCERTAIN');
  await h.task('collect','COLLECTING',{sourceType:'COLLECT_BOX'});await h.task('waiting','GENERATING',{generationStage:'waiting_product'});
  await h.task('seller-wait','COLLECTING',{sourceType:'EXCEL',collectionStage:'waiting_seller'});
  await h.task('generating','GENERATING',{generationStage:'image'},{live:true});await h.task('queued','GENERATING',{generationStage:'waiting_channel'},{live:true});
  await h.task('no-lease','GENERATING',{generationStage:'image'});await h.task('collecting','COLLECTING',{sourceType:'EXCEL'});
  await h.task('submit','SUBMITTING');await h.task('submitted','SUBMITTED');await h.task('ready','READY_TO_SUBMIT');
  await h.task('deleted','SUBMISSION_FAILED',{}, {deletedAt:1});await h.task('foreign-task','AWAITING_REVIEW',{}, {accountId:'b'});
  await h.task('gone','SUBMISSION_FAILED',{permanentlyDeletedAt:1});await h.task('merged','MERGED');await h.task('completed','COMPLETED');
  const first=await h.make().getSummary({accountId:'a',storeId:'a1'});
  assert.deepEqual(first.errors,{});assert.equal(first.asOf,new Date(now).toISOString());
  assert.equal(first.inspection.unreadCount,2);assert.equal(first.orders.pendingCount,2);
  assert.equal(first.orders.since,'2026-08-29T16:00:00.000Z');assert.equal(first.orders.to,'2026-09-28T15:59:59.999Z');
  assert.equal(first.orders.lastSyncAt,'2026-09-27T12:00:00Z');
  assert.deepEqual(first.products,{outOfStock:3,lowStock:2,attentionCount:5,lastSyncAt:'2026-09-27T09:00:00.000Z'});
  for(const [stock,total] of [['全部',8],['缺货',3],['低库存',2],['attention',5]]) {
    const catalog=await readProductCatalogPage({pool:h.pool,accountId:'a',storeId:'a1',options:{page:1,pageSize:50,status:'销售中',stock,q:''}});
    assert.equal(catalog.total,total,`${stock} opens the matching store-wide product set`);
    assert.equal(catalog.stockCounts['缺货'],first.products.outOfStock);
    assert.equal(catalog.stockCounts['低库存'],first.products.lowStock);
    if(stock==='缺货')assert.ok(['historical-stock','historical-visibility'].every(id=>catalog.items.some(item=>item.id===id)));
  }
  assert.deepEqual(first.ai,{review:1,failed:3,waitingForEnrichment:3,generating:1,submitting:3,attentionCount:7});
  assert.deepEqual(first.wallet,{availableCents:'9007199254740870',reservedCents:'123',currency:'CNY'});
  assert.equal(first.promotions.uncertainCount,1);
  const second=await h.make().getSummary({accountId:'a',storeId:'a2'});
  for(const section of ['dailyListings','inspection','ai','wallet'])assert.deepEqual(second[section],first[section],`${section} is account-wide`);
  assert.equal(second.orders.pendingCount,1);assert.equal(second.products.attentionCount,0);
  assert.equal(h.dailyCalls[0].accountId,'a');assert.equal(h.dailyCalls[0].storeId,undefined);
  await assert.rejects(h.make().getSummary({accountId:'a',storeId:'b1'}),error=>error.status===403);
});

test('dashboard has honest empty-store and partial-failure states without external writes',{skip:!enabled},async t=>{
  const h=await fixture(t);
  const reads={query:(sql,args)=>{assert.match(sql.trim(),/^(SELECT|WITH)\b/);return h.pool.query(sql,args);}};
  const empty=await h.make({pool:reads}).getSummary({accountId:'empty'});
  assert.equal(empty.storeId,null);assert.equal(empty.inspection.unreadCount,0);assert.equal(empty.ai.attentionCount,0);
  assert.deepEqual(empty.wallet,{availableCents:'0',reservedCents:'0',currency:'CNY'});
  assert.equal(empty.orders.pendingCount,null);assert.equal(empty.products.attentionCount,null);assert.equal(empty.promotions.uncertainCount,null);
  for(const section of ['orders','products','promotions'])assert.match(empty.errors[section],/店铺/);
  const broken={query:(sql,args)=>{
    if(sql.includes('ai_image_listing_tasks'))throw Error('private diagnostic');
    return reads.query(sql,args);
  }};
  const partial=await h.make({pool:broken,readDailyListings:async()=>{throw Error('private ledger failure');}}).getSummary({accountId:'a',storeId:'a1'});
  assert.equal(partial.ai.attentionCount,null);assert.equal(partial.dailyListings.count,null);
  assert.equal(partial.orders.pendingCount,0);assert.equal(partial.wallet.availableCents,'9007199254740870');
  assert.deepEqual(Object.keys(partial.errors).sort(),['ai','dailyListings']);assert.doesNotMatch(JSON.stringify(partial),/private/);
});

test('home AI stages match dashboard counts before pagination while ordinary group totals and batch candidates stay unchanged',{skip:!enabled},async t=>{
  const h=await fixture(t),repository=createAiListingRepository({pool:h.pool});
  await h.task('review-one','AWAITING_REVIEW');await h.task('review-two','AWAITING_REVIEW');
  await h.task('submit-failure','SUBMISSION_FAILED');await h.task('generation-failure','GENERATION_FAILED');await h.task('unknown-result','SUBMISSION_UNCERTAIN');
  await h.task('seller-wait','COLLECTING',{sourceType:'EXCEL',collectionStage:'waiting_seller'});
  await h.task('collect-wait','GENERATING',{generationStage:'waiting_product'});
  await h.task('image-running','GENERATING',{generationStage:'image'},{live:true});
  await h.task('waiting-channel','GENERATING',{generationStage:'waiting_channel'},{live:true});
  for(const status of ['READY_TO_SUBMIT','SUBMITTING','SUBMITTED'])await h.task(status,status);
  await h.task('paused','PAUSED');await h.task('deleted','SUBMISSION_FAILED',{}, {deletedAt:1});
  await h.task('foreign','AWAITING_REVIEW',{}, {accountId:'b'});
  const summary=(await h.make().getSummary({accountId:'a'})).ai;
  const original=await repository.listPage({accountId:'a'});
  const candidates=await repository.listActionCandidates({accountId:'a',group:'active'});
  for(const [stage,key] of [['review','review'],['failed','failed'],['enrichment','waitingForEnrichment'],['generating','generating'],['submitting','submitting'],['attention','attentionCount']]) {
    const group=['failed','attention'].includes(stage)?'all':'active';
    const page=await repository.listPage({accountId:'a',group,stage,limit:1});
    assert.equal(page.total,summary[key],`${stage} total matches the home card`);assert.equal(page.tasks.length,1);
    assert.deepEqual(page.counts,original.counts,'stage does not rewrite existing group tab counts');
    const after=await repository.listPage({accountId:'a',group,stage,limit:1,offset:page.total});assert.equal(after.tasks.length,0);
  }
  assert.equal((await repository.listPage({accountId:'a',group:'active',stage:'failed'})).total,0);
  const enriched=await repository.listPage({accountId:'a',group:'active',stage:'enrichment'});
  assert.equal(enriched.tasks.find(task=>task.id==='seller-wait').collectionStage,'waiting_seller');
  assert.deepEqual(await repository.listActionCandidates({accountId:'a',group:'active'}),candidates);
  await assert.rejects(repository.listPage({accountId:'a',stage:'invalid-stage'}));
});
