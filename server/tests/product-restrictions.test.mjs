import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateRestrictions,normalizeRestriction} from '../product-restrictions.mjs';
const rule={id:'r',name:'禁止类型',enabled:true,action:'BLOCK',categoryId:10,typeId:20,keywords:[],storeId:'',warehouseId:'',attributeId:null,attributeValue:'',sourceUrl:'https://global-help.ozon.com/zh/policies',reason:'官方规则'};
test('exact pair blocks; unrelated type does not; disabled ignored',()=>{
 assert.equal(evaluateRestrictions([rule],[{categoryId:10,typeId:20}],{}).decision,'BLOCK');
 assert.equal(evaluateRestrictions([rule],[{categoryId:10,typeId:21}],{}).decision,'ALLOW');
 assert.equal(evaluateRestrictions([{...rule,enabled:false}],[{categoryId:10,typeId:20}],{}).decision,'ALLOW');
});
test('missing category and conditional attribute produce review, not a fabricated pass',()=>{
 assert.equal(evaluateRestrictions([rule],[{}],{}).decision,'REVIEW');
 assert.equal(evaluateRestrictions([{...rule,attributeId:7,attributeValue:'ртуть'}],[{categoryId:10,typeId:20}],{}).decision,'REVIEW');
});
test('warehouse limitation is scoped; unknown target is review; keywords never hard block',()=>{
 const r={...rule,warehouseId:'w1'};const items=[{categoryId:10,typeId:20}];
 assert.equal(evaluateRestrictions([r],items,{warehouseId:'w2'}).decision,'ALLOW');
 assert.equal(evaluateRestrictions([r],items,{}).decision,'REVIEW');
 assert.equal(evaluateRestrictions([{...rule,categoryId:null,typeId:null,keywords:['электронная сигарета'],action:'REVIEW'}],[{name:'электронная сигарета',categoryId:1,typeId:2}],{}).decision,'REVIEW');
 assert.throws(()=>normalizeRestriction({...rule,categoryId:null,typeId:null,keywords:['knife']}));
});
test('every SKU is checked and block has precedence over review',()=>{
 assert.equal(evaluateRestrictions([rule],[{sku:'a'},{sku:'b',categoryId:10,typeId:20}],{}).decision,'BLOCK');
});
test('short Cyrillic keyword does not match an unrelated word',()=>{
 const r={...rule,categoryId:null,typeId:null,action:'REVIEW',keywords:['БАД']};
 assert.equal(evaluateRestrictions([r],[{categoryId:1,typeId:1,name:'Ракетка для бадминтона'}]).decision,'ALLOW');
 assert.equal(evaluateRestrictions([r],[{categoryId:1,typeId:1,name:'БАД для сна'}]).decision,'REVIEW');
});
test('multiple category/type pairs match either pair without cross pairing',()=>{
 const multi=normalizeRestriction({...rule,categories:[{categoryId:10,typeId:20,label:'A'},{categoryId:11,typeId:21,label:'B'}]});
 assert.equal(evaluateRestrictions([multi],[{categoryId:11,typeId:21}]).decision,'BLOCK');
 assert.equal(evaluateRestrictions([multi],[{categoryId:10,typeId:21}]).decision,'ALLOW');
 assert.equal(evaluateRestrictions([multi],[{categoryId:10,typeId:20}]).decision,'BLOCK');
 assert.throws(()=>normalizeRestriction({...rule,categories:[]}));
 assert.throws(()=>normalizeRestriction({...rule,categories:[{}]}));
 assert.equal(normalizeRestriction(rule).categories.length,1);
});
