import test from 'node:test';
import assert from 'node:assert/strict';
import {createAiListingStoreRouting,quotaItems} from '../ai-listing-store-routing.mjs';
const items=['a','b'].map(sku=>({sku,listingItem:{currency_code:'RUB',price:'20'}}));
const task=()=>({accountId:'account',id:'task',config:{targetStoreId:'a',targetWarehouseId:'wa',autoSwitchStores:true,fallbackStores:[{targetStoreId:'b',targetWarehouseId:'wb'}]},source:{items}});

test('target validation never queries or reserves quota before import, and keeps the primary target',async()=>{
 let validates=0;const route=createAiListingStoreRouting({pool:{connect:async()=>assert.fail('no quota lock')},validateTarget:async({config})=>{validates++;assert.equal(config.targetStoreId,'a');return {store:{currencyCode:'RUB'}};},readCredential:async()=>assert.fail('no quota read'),fetchFn:async()=>assert.fail('no quota request')});
 let destination,reservation;const r=await route({task:task(),commit:async(target,quota)=>{destination=target;reservation=quota;}});
 assert.equal(r.selected,true);assert.equal(validates,1);assert.equal(destination.targetStoreId,'a');assert.equal(reservation,undefined);
});

test('a recorded destination stays bound even when other stores are configured',async()=>{
 const t=task();t.submissionTarget={targetStoreId:'b',targetWarehouseId:'wb'};t.submissionId='journal';
 const route=createAiListingStoreRouting({pool:{},validateTarget:async({config})=>{assert.equal(config.targetStoreId,'b');return {store:{currencyCode:'RUB'}};}});
 await route({task:t,commit:async target=>assert.equal(target.targetStoreId,'b')});
});

test('target read failure stays distinct from quota exhaustion and never picks an unrelated fallback',async()=>{
 const seen=[];const route=createAiListingStoreRouting({pool:{},clock:()=>1000,validateTarget:async({config})=>{seen.push(config.targetStoreId);throw Error('warehouse unavailable');}});
 const r=await route({task:task(),commit:async()=>assert.fail('unverified target')});
 assert.equal(r.selected,false);assert.equal(r.quotaWait,undefined);assert.equal(r.submissionWait.code,'TARGET_UNAVAILABLE');assert.deepEqual(seen,['a']);
});

test('a failed commit cannot silently move a prepared product to another store',async()=>{
 let commits=0;const route=createAiListingStoreRouting({pool:{},validateTarget:async()=>({store:{currencyCode:'RUB'}})});
 await assert.rejects(route({task:task(),commit:async()=>{commits++;throw Error('lease lost');}}),/lease lost/);assert.equal(commits,1);
});

test('only uncreated and eligible variants count as remaining quota items',()=>{
 const t=task();t.source={items:[{sku:'created'},{sku:'waiting'},{sku:'skipped'}],skuPricing:[{sku:'skipped',status:'SKIPPED'}]};t.submissionResults=[{sku:'created',importStatus:'SUCCEEDED'}];
 assert.deepEqual(quotaItems(t).map(x=>x.sku),['waiting']);
});
