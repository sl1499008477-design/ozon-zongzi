import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCollectListingWarehouses } from '../collect-listing-warehouse-validation.mjs';
const warehouse = {id:'w1',accountId:'a1',storeId:'s1',warehouse_id:'123',warehouse_type:'rfbs',status:'created'};
const input = {warehouses:[warehouse],products:[],accountId:'a1',targetStoreId:'s1',stocks:[{warehouse_id:'123'},{warehouse_id:'123'}]};
test('RFBS validation runs once per warehouse and accepts scoped live evidence',async()=>{
 let calls=0;
 await validateCollectListingWarehouses({...input,verifyRfbsWarehouse:async args=>{calls++;assert.equal(args.targetWarehouseId,'w1');return {accountId:'a1',storeId:'s1',warehouseRecordId:'w1',platformWarehouseId:'123',fulfillmentType:'RFBS',outcome:'PASSED',expiresAt:new Date(Date.now()+60000).toISOString()};}});
 assert.equal(calls,1);
});
test('verification failure blocks submission',async()=>{
 await assert.rejects(validateCollectListingWarehouses({...input,verifyRfbsWarehouse:async()=>{throw new Error('verification failed');}}),/verification failed/);
});
test('another store cannot be selected',async()=>{
 await assert.rejects(validateCollectListingWarehouses({...input,targetStoreId:'s2',verifyRfbsWarehouse:async()=>{throw new Error('must not verify');}}),/请选择/);
});
