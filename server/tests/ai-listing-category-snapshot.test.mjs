import test from 'node:test';
import assert from 'node:assert/strict';
import {applyAiListingSourceCategorySnapshot} from '../ai-listing-source-facts.mjs';

test('accepted collection category snapshots are projected without reading current mappings',()=>{
  const source={items:[
    {sku:'one',categoryResolution:{status:'ACTIVE',currentDescriptionCategoryId:30,currentTypeId:40},listingItem:{description_category_id:10,type_id:20,name:'Lamp'}},
    {sku:'two',listingItem:{description_category_id:50,type_id:60}},
  ]};
  const original=structuredClone(source);
  const result=applyAiListingSourceCategorySnapshot(source);
  assert.deepEqual(result.items.map(row=>[row.listingItem.description_category_id,row.listingItem.type_id]),[[30,40],[50,60]]);
  assert.equal(result.items[0].listingItem.name,'Lamp');assert.deepEqual(source,original);
});

test('accepted Seller item IDs are not replaced by an older source-direct category snapshot',()=>{
  const source={items:[{sku:'4157480005',
    categoryResolution:{source:'SOURCE_DIRECT',status:'ACTIVE',validatedAt:null,currentDescriptionCategoryId:86539915,currentTypeId:91884},
    listingItem:{description_category_id:86539914,type_id:91884}}]};
  assert.deepEqual(applyAiListingSourceCategorySnapshot(source),source);
});

test('legacy accepted source IDs remain usable without a new validation receipt',()=>{
  const source={items:[{sku:'legacy',listingItem:{description_category_id:10,type_id:20}}]};
  const result=applyAiListingSourceCategorySnapshot(source);
  assert.deepEqual(result,source);
});
