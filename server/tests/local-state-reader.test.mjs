import './support/dedicated-postgres-test-environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';

test('bootstrap reads scoped settings and warehouses without loading catalogs or history',async()=>{
  const {readLocalStateForAccount}=await import('../local-state-reader.mjs');
  const calls=[];const pool={async query(sql,values){calls.push({sql,values});
    if(sql.includes('AS state'))return {rows:[{state:{accounts:[{id:'a'}],stores:[{id:'s',ownerAccountId:'a'}],currentStoreIdsByAccount:{a:'s'},caches:{}}}]};
    if(sql.includes('COUNT(*)'))return {rows:[{products:610,collect_box:4}]};
    return {rows:[]};}};
  const state=await readLocalStateForAccount({pool,accountId:'a',bootstrap:true});
  assert.deepEqual(state.caches.products,[]);assert.equal(state.summaryCounts.products,610);
  assert.ok(calls.every(c=>!/^\s*(INSERT|UPDATE|DELETE|CREATE|ALTER)/i.test(c.sql)));
  assert.ok(calls.every(c=>c.values.includes('a')));
  assert.equal(calls.some(c=>/SELECT p\.\* FROM products/.test(c.sql)),false);
  assert.equal(calls.some(c=>/SELECT\s+state\s*(?:,|FROM\b)/i.test(c.sql)),false);
  const {testExports}=await import('../index.mjs');
  const payload=testExports.localStatePayload(state,{account:state.accounts[0],token:'fixture-session'});
  assert.equal(payload.ok,true);
  assert.equal(payload.currentStoreId,'s');
  assert.equal(payload.summary.lastSyncAt,null);
});

test('warehouse choices use all owned store associations even when the page has no products',async()=>{
  const {readLocalStateForAccount}=await import('../local-state-reader.mjs');
  const {testExports}=await import('../index.mjs');
  const {autoListingWarehouseOptions}=await import('../../app/src/auto-listing-config.js');
  const pool={async query(sql){
    if(sql.includes('AS state'))return {rows:[{state:{accounts:[{id:'a'}],stores:[{id:'s1'},{id:'s2'}],
      currentStoreIdsByAccount:{a:'s2'},caches:{}}}]};
    if(sql.includes('COUNT(*)'))return {rows:[{products:0,collect_box:0}]};
    if(sql.includes('FROM warehouses w'))return {rows:[
      {id:'w1',store_id:'s1',warehouse_id:'101',name:'CEL-测试',warehouse_type:'FBS',is_active:true,has_active_product_association:true},
      {id:'w2',store_id:'s2',warehouse_id:'102',name:'林科大',warehouse_type:'RFBS',is_active:true,has_active_product_association:false},
      {id:'w3',store_id:'s1',warehouse_id:'103',name:'无关联仓库',warehouse_type:'FBS',is_active:true,has_active_product_association:false},
    ]};
    return {rows:[]};
  }};
  for(const bootstrap of [true,false]){
    const state=await readLocalStateForAccount({pool,accountId:'a',bootstrap});
    const payload=testExports.localStatePayload(state,{account:state.accounts[0]});
    assert.deepEqual(payload.caches.products,[], 'association evidence must not become the page catalog');
    assert.equal(payload.currentStoreId,'s2');
    const choose=targetStoreId=>autoListingWarehouseOptions({warehouses:payload.caches.warehouses,targetStoreId});
    assert.deepEqual(choose('s1').options.map(w=>w.value),['w1']);
    assert.deepEqual(choose('s2').options.map(w=>w.value),['w2']);
    assert.deepEqual(choose('other-account-store').options,[]);
    assert.equal(Object.hasOwn(payload,'listingWarehouseProducts'),false);
  }
});
