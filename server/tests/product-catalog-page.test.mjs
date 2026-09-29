import test from 'node:test';
import assert from 'node:assert/strict';
import {productCatalogPage} from '../../shared/product-catalog.mjs';

test('catalog filters before paging, preserves status/stock totals, and bounds the final page',()=>{
 const rows=Array.from({length:62},(_,i)=>({id:String(i),sku:`sku-${i}`,name:`灯 ${i}`,status:i<60?'selling':'archived',stock:i%2?4:0}));
 const result=productCatalogPage(rows,{page:2,pageSize:5,status:'销售中',stock:'低库存'});
 assert.equal(result.total,30);assert.deepEqual(result.items.map(x=>x.id),['11','13','15','17','19']);
 assert.equal(result.statusOptions.find(x=>x.label==='销售中').count,60);assert.deepEqual(result.stockCounts,{'全部':60,'缺货':30,'低库存':30});
 assert.equal(productCatalogPage(rows,{page:10,pageSize:5,status:'销售中',q:'sku-51'}).page,1);
 assert.deepEqual(productCatalogPage(rows,{page:1,pageSize:5,status:'销售中',q:'sku-51'}).items.map(x=>x.sku),['sku-51']);
});

test('home stock attention filters known in-sale stock before pagination and retains zero',()=>{
 const rows=[{id:'zero',status:'selling',stock:0},{id:'low',status:'selling',stock:10},{id:'full',status:'selling',stock:11},{id:'unknown',status:'selling',stock:''},{id:'legacy',status:'selling',stocks:{stocks:[{present:3}]}},{id:'saved',status:'selling',stock_total:4,stocks:{present:99}},{id:'hidden',status:'hidden',stock:0}];
 const page=productCatalogPage(rows,{stock:'attention',page:2,pageSize:2});
 assert.equal(page.total,4);assert.deepEqual(page.items.map(x=>x.id),['legacy','saved']);
 assert.equal(page.stockCounts['缺货'],1);assert.equal(page.stockCounts['低库存'],3);
});
