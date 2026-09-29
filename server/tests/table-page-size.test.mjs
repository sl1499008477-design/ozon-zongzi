import test from 'node:test';
import assert from 'node:assert/strict';
import {createOzonWebCollectionService} from '../ozon-web-collection.mjs';
import {createSkuBilling} from '../ai-sku-billing.mjs';

// Assert the actual database boundary, so rendering fewer rows cannot mask an over-fetch.
for (const size of [5,10,20,50]) {
 test(`collection jobs request exactly page 2 of size ${size} within the account`,async()=>{
  const calls=[];
  const pool={query:async(sql,values)=>{calls.push({sql,values});return {rows:sql.includes('COUNT(*)')?[{total:125}]:[]};}};
  const service=createOzonWebCollectionService({getPool:async()=>pool});
  const result=await service.list({accountId:'owner',page:2,pageSize:size});
  assert.equal(result.pageSize,size);
  assert.deepEqual(calls.find(x=>x.sql.includes('SELECT *')).values,['owner',size,size]);
 });
 test(`billing records request exactly page 2 of size ${size} and ignore a foreign account for ordinary users`,async()=>{
  const calls=[];
  const pool={query:async(sql,values)=>{calls.push({sql,values});return {rows:sql.includes('COUNT(*)')?[{total:125}]:[]};}};
  const result=await createSkuBilling({pool}).records({id:'owner',role:'user'},{page:2,pageSize:size,accountId:'foreign'});
  assert.equal(result.pageSize,size);
  assert.deepEqual(calls.at(-1).values,['owner',size,size]);
 });
}
