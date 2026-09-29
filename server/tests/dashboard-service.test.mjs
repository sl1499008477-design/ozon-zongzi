import test from 'node:test';
import assert from 'node:assert/strict';
import {createDashboardService} from '../dashboard-service.mjs';

const at=Date.parse('2026-09-27T16:00:00.000Z');
function harness({productRows=[],failSection,storeExists=true}={}) {
  const calls=[];
  const pool={query:async(sql,args)=>{
    calls.push({sql,args});
    if(sql.startsWith('SELECT id FROM stores'))return {rows:storeExists?[{id:args[1]}]:[],rowCount:storeExists?1:0};
    if(sql.includes('FROM ai_image_listing_tasks')) {
      if(failSection==='ai')throw Error('private diagnostic');
      return {rows:[{review:2,failed:3,waiting:1,generating:4,submitting:5}]};
    }
    if(sql.includes('FROM ai_user_wallets'))return {rows:[{available_cents:'9007199254740870',reserved_cents:'123'}]};
    if(sql.includes('FROM ozon_promotion_runs'))return {rows:[{uncertain_count:2}]};
    if(sql.includes('FROM products p'))return {rows:productRows};
    if(sql.includes('WITH matched'))return {rows:[{unread_count:4}]};
    if(sql.includes('FROM orders o'))return {rows:[{pending_count:6,last_sync_at:null}]};
    throw Error('unhandled database query');
  }};
  const readDailyListings=async input=>({count:7,date:'2026-09-28',timeZone:'Asia/Shanghai',byStore:[],complete:true,note:null});
  return {calls,service:createDashboardService({pool,clock:()=>at,readDailyListings})};
}

test('stock summary distinguishes unknown historical values from explicit zero and uses existing selling classification',async()=>{
  const h=harness({productRows:[
    {status:'selling',stock_total:0,raw:{},synced_at:'2026-09-20T00:00:00Z'},
    {status:'selling',stock_total:10,raw:{}},
    {status:'selling',stock_total:11,raw:{}},
    {status:'selling',stock_total:null,raw:{stock:'   '}},
    {status:'selling',stock_total:null,raw:{}},
    {status:'selling',stock_total:null,raw:{stocks:{stocks:[{present:2},{}]}}},
    {status:'',stock_total:null,raw:{statuses:{status_name:'Продается'},stocks:{stocks:[{present:1},{present:1}]}}},
    {status:'hidden',stock_total:0,raw:{},synced_at:'2026-09-21T00:00:00Z'},
    {status:'selling',stock_total:0,raw:{archived:true}},
  ]});
  const summary=await h.service.getSummary({accountId:'owner',storeId:'store'});
  assert.deepEqual(summary.errors,{});
  assert.deepEqual(summary.products,{outOfStock:1,lowStock:2,attentionCount:3,lastSyncAt:'2026-09-21T00:00:00.000Z'});
});

test('a failed section stays null while other real values survive and each query remains account scoped',async()=>{
  const h=harness({failSection:'ai'});
  const summary=await h.service.getSummary({accountId:'owner',storeId:'store'});
  assert.equal(summary.ai.attentionCount,null);assert.equal(summary.dailyListings.count,7);
  assert.equal(summary.wallet.availableCents,'9007199254740870');assert.equal(summary.orders.pendingCount,6);
  assert.equal(summary.orders.since,'2026-08-29T16:00:00.000Z');assert.equal(summary.orders.to,'2026-09-28T15:59:59.999Z');
  assert.deepEqual(Object.keys(summary.errors),['ai']);assert.doesNotMatch(JSON.stringify(summary),/private diagnostic/);
  assert.ok(h.calls.every(call=>call.args[0]==='owner'));
  assert.ok(h.calls.every(call=>!/\b(INSERT|UPDATE|DELETE)\b/.test(call.sql)));
});

test('a foreign store stops the request before any business summary is read',async()=>{
  const h=harness({storeExists:false});
  await assert.rejects(h.service.getSummary({accountId:'admin',storeId:'foreign'}),error=>error.status===403);
  assert.equal(h.calls.length,1);
});

test('no selected store preserves account totals and makes store-specific metrics unavailable',async()=>{
  const h=harness(),summary=await h.service.getSummary({accountId:'owner'});
  assert.equal(summary.storeId,null);assert.equal(summary.ai.attentionCount,6);
  assert.equal(summary.inspection.unreadCount,4);assert.equal(summary.wallet.reservedCents,'123');
  assert.equal(summary.orders.pendingCount,null);assert.equal(summary.products.attentionCount,null);assert.equal(summary.promotions.uncertainCount,null);
  assert.deepEqual(Object.keys(summary.errors).sort(),['orders','products','promotions']);
  assert.equal(h.calls.length,3,'only account-level database reads run without a selected store');
});
