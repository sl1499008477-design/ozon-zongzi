import test from 'node:test';
import assert from 'node:assert/strict';
import {createOzonCategoryService} from '../ozon-category-service.mjs';
const input={accountId:'account',store:{id:'store',ownerAccountId:'account'},descriptionCategoryId:10,typeId:20,attributeId:85,value:'Нет бренда',language:'DEFAULT'};
test('explicit brand text uses one official search and keeps only exact real dictionary IDs',async()=>{
 const calls=[];const category=createOzonCategoryService({callOzonSellerApi:async(_store,path,body)=>{calls.push({path,body});return {result:[{id:1,value:'Нет бренда'},{id:2,value:'Нет бренда плюс'},{id:3,value:' НЕТ БРЕНДА '}]};}});
 const values=await category.searchCategoryAttributeValuesExact(input);assert.deepEqual(values.items.map(x=>x.id),[1,3]);assert.equal(calls.length,1);assert.equal(calls[0].path,'/v1/description-category/attribute/values/search');assert.equal(calls[0].body.value,'Нет бренда');assert.equal(calls[0].body.limit,100);assert.equal('language' in calls[0].body,false);await category.searchCategoryAttributeValuesExact(input);assert.equal(calls.length,1);
});
test('editing complete dictionary still paginates independently of targeted text search cache',async()=>{
 const paths=[];const category=createOzonCategoryService({callOzonSellerApi:async(_store,path,body)=>{paths.push(path);if(path.endsWith('/search'))return {result:[{id:1,value:'Нет бренда'}]};return body.last_value_id?{result:[{id:2,value:'Other'}],has_next:false}:{result:[{id:1,value:'Нет бренда'}],has_next:true};}});
 await category.searchCategoryAttributeValuesExact(input);const values=await category.getCategoryAttributeValues(input);assert.deepEqual(values.items.map(x=>x.id),[1,2]);assert.equal(paths.length,3);
});
