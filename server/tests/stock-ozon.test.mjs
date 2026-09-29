import test from 'node:test';
import assert from 'node:assert/strict';
import {createStockOzon} from '../stock-ozon.mjs';

test('库存读取分页并分开保留可售、在库、预留；仅平台卖家仓库可改',async()=>{
 const calls=[];
 const port=createStockOzon({call:async(c,path,body)=>{
  calls.push({path,body});
  if(path==='/v2/warehouse/list')return {warehouses:[{warehouse_id:22,name:'主仓',status:'created',is_rfbs:true},{warehouse_id:23,name:'停用仓',status:'disabled'}],has_next:false};
  return body.cursor?{products:[{offer_id:'offer',product_id:11,warehouse_id:23,free_stock:0,present:0,reserved:0}],has_next:false}:{products:[{offer_id:'offer',product_id:11,warehouse_id:22,free_stock:8,present:10,reserved:2}],has_next:true,cursor:'next'};
 }});
 const rows=await port.read({}, {productId:'11',offerId:'offer'});
 assert.deepEqual(rows.map(r=>[r.warehouseId,r.currentStock,r.present,r.reserved,r.writable]),[['22',8,10,2,true],['23',0,0,0,false]]);
 assert.equal(calls.filter(c=>c.path.includes('stocks-by')).length,2);assert.equal(calls[0].body.limit,200);
});
test('写入只使用货号和目标可售量；逐仓库确认，缺失或矛盾的响应不能算成功',async()=>{
 const items=[{warehouseId:'22',targetStock:8},{warehouseId:'23',targetStock:0},{warehouseId:'24',targetStock:1}];
 const port=createStockOzon({call:async(c,path,body)=>{
  assert.equal(path,'/v2/products/stocks');assert.deepEqual(body.stocks[0],{offer_id:'offer',warehouse_id:22,stock:8});
  return {result:[{offer_id:'offer',warehouse_id:22,updated:true,errors:[]},{offer_id:'offer',warehouse_id:23,updated:false,errors:[{code:'TOO_MANY_REQUESTS',message:'rate limit'}]}]};
 }});
 const result=await port.write({}, {offerId:'offer',productId:'11'},items);
 assert.deepEqual(result.map(r=>r.status),['SUCCEEDED','FAILED','UNCERTAIN']);
});
test('分页不完整不能把未读到的库存当作零',async()=>{
 const port=createStockOzon({call:async(c,path)=>path==='/v2/warehouse/list'?{warehouses:[],has_next:false}:{products:[],has_next:true}});
 await assert.rejects(port.read({}, {offerId:'offer',productId:'11'}),{code:'STOCK_RESPONSE_INVALID'});
});
test('updated true 带错误、缺少商品身份或畸形错误字段均不能确认成功',async()=>{
  for(const response of [
    {offer_id:'offer',warehouse_id:22,updated:true,errors:[{code:'ERROR',message:'rejected'}]},
    {warehouse_id:22,updated:true,errors:[]},
    {offer_id:'offer',warehouse_id:22,updated:true,errors:{code:'ERROR'}},
  ]){
    const port=createStockOzon({call:async()=>({result:[response]})});
    assert.equal((await port.write({}, {productId:'11',offerId:'offer'},[{warehouseId:'22',targetStock:1}]))[0].status,'UNCERTAIN');
  }
});

test('批量读取只请求一组仓库和库存，按商品身份分配结果',async()=>{
 const calls=[];const port=createStockOzon({call:async(c,path,body)=>{
  calls.push({path,body});return path==='/v2/warehouse/list'?{warehouses:[{warehouse_id:22,name:'主仓',status:'created'}],has_next:false}:{products:[{product_id:11,offer_id:'one',warehouse_id:22,free_stock:8},{product_id:12,offer_id:'two',warehouse_id:22,free_stock:4}],has_next:false};
 }});
 const result=await port.readMany({},[{productId:'11',offerId:'one'},{productId:'12',offerId:'two'}]);
 assert.deepEqual(calls[1].body.offer_id,['one','two']);assert.equal(calls.length,2);
 assert.deepEqual(result.map(r=>[r.product.productId,r.warehouses[0].currentStock]),[['11',8],['12',4]]);
});
test('批量库存响应缺少商品身份时不能串用到多个商品',async()=>{
 const port=createStockOzon({call:async(c,path)=>path==='/v2/warehouse/list'?{warehouses:[{warehouse_id:22,status:'created'}],has_next:false}:{products:[{warehouse_id:22,free_stock:8}],has_next:false}});
 await assert.rejects(port.readMany({},[{productId:'11',offerId:'one'},{productId:'12',offerId:'two'}]),{code:'STOCK_RESPONSE_INVALID'});
});
