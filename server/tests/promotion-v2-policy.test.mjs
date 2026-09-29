import test from 'node:test';
import assert from 'node:assert/strict';
import {buildPromotionPlan,defaultPromotionSettings,promotionItemApplied} from '../promotion-policy.mjs';

const now=Date.parse('2026-10-14T12:00:00Z');
const rule={actionIds:[],productIds:[],categoryIds:[],minStock:1,quantity:3,targetDiscountPercent:30,maxDiscountPercent:null,participationScope:'ALL'};
const snapshot=()=>({priceSemantics:'CEILING',actions:[{id:'a',type:'ELASTIC_BOOSTING',isVoucher:false,endAt:'2026-12-31T00:00:00Z',candidates:[{productId:'p',maxPrice:'75.00',currency:'CNY',minQuantity:1}]}],products:[{productId:'p',currency:'CNY',basePrice:'100.00',currentPrice:'90.00',availableStock:10,archived:false}],memberships:[]});
const plan=data=>buildPromotionPlan(data,defaultPromotionSettings(),{source:'RULE',rule},now);

test('new promotion plans preserve ceiling semantics and only voucher quantities',()=>{
  const data=snapshot();data.actions.push({...data.actions[0],id:'voucher',type:'DISCOUNT',isVoucher:true});
  const result=plan(data);
  assert.deepEqual(result.items.map(item=>[item.actionId,item.priceSemantics,item.quantity,item.price]),[['a','CEILING',null,'70.00'],['voucher','CEILING',3,'70.00']]);
  assert.ok(result.items.every(item=>item.actionType&&typeof item.isVoucher==='boolean'));
});

test('new candidate currency cannot be borrowed from the catalog for a different or unknown currency',()=>{
  for(const priceSemantics of ['FIXED','CEILING'])for(const value of ['RUB',null]){
    const data=snapshot();data.priceSemantics=priceSemantics;data.actions[0].candidates[0].currency=value;
    const result=plan(data);assert.equal(result.items.length,0);assert.match(result.skipped[0].reason,/币种/);
  }
});

test('voucher quantity is required without applying dynamic campaign stock minimums',()=>{
  const data=snapshot();data.actions[0].candidates[0].minQuantity=999;
  assert.equal(plan(data).items.length,1);
  data.actions[0].isVoucher=true;
  assert.match(plan(data).skipped[0].reason,/库存|件数/);
  data.actions[0].candidates[0].minQuantity=1;
  const result=buildPromotionPlan(data,defaultPromotionSettings(),{source:'RULE',rule:{...rule,quantity:null}},now);
  assert.equal(result.items.length,0);assert.match(result.skipped[0].reason,/促销码.*件数/);
});

test('new ceiling reconciliation confirms amount and currency together',()=>{
  const data=snapshot(),item={operation:'JOIN',actionId:'a',productId:'p',batchAt:'',price:'70.00',currency:'CNY',quantity:null,priceSemantics:'CEILING'};
  for(const semantics of ['FIXED','CEILING']){
  item.priceSemantics=semantics;
  data.memberships=[{...item,currency:'RUB'}];assert.equal(promotionItemApplied(item,data,now),false);
  data.memberships[0].currency=null;assert.equal(promotionItemApplied(item,data,now),false);
  data.memberships[0].currency='CNY';assert.equal(promotionItemApplied(item,data,now),true);
  }
});

test('dynamic ceiling cannot stand in for the future seller price under a discount guard',()=>{
  const data=snapshot();Object.assign(data.actions[0].candidates[0],{currentSellerPrice:'95.00',sellerPriceCurrency:'CNY'});
  const result=buildPromotionPlan(data,defaultPromotionSettings(),{source:'RULE',rule:{...rule,maxDiscountPercent:40}},now);
  assert.equal(result.items.length,0);assert.match(result.skipped[0].reason,/无法确认.*实际卖家价.*最大降幅/);
  assert.equal(result.skipped[0].maxDiscountPercent,40);
  data.actions[0].isVoucher=true;
  assert.equal(buildPromotionPlan(data,defaultPromotionSettings(),{source:'RULE',rule:{...rule,maxDiscountPercent:40}},now).items.length,1);
});

function exitSnapshot(){const data=snapshot();data.memberships=[{actionId:'a',productId:'p',batchAt:'',mode:'AUTO',price:'70.00',currency:'CNY',maxPrice:'75.00',maxPriceCurrency:'CNY'}];return data;}
const exitPlan=data=>buildPromotionPlan(data,defaultPromotionSettings(),{source:'EXIT'},now);

test('dynamic exit restores non-activity base and records the explicit card price change',()=>{
  const result=exitPlan(exitSnapshot());assert.equal(result.items.length,1);
  assert.deepEqual([result.items[0].price,result.items[0].previousPrice,result.items[0].exitByPrice,result.items[0].priceSemantics],['100.00','70.00',true,'CEILING']);
  assert.match(result.items[0].reason,/恢复.*非活动基准价/);
});

test('dynamic exit skips insufficient base price, unknown currencies and unsupported types',()=>{
  for(const change of [d=>d.products[0].basePrice='75.00',d=>d.products[0].basePrice='74.99',d=>d.products[0].basePrice=null,d=>d.memberships[0].maxPrice=null,d=>d.memberships[0].maxPriceCurrency='RUB',d=>d.memberships[0].currency='RUB',d=>d.actions[0].type='UNRECOGNIZED',d=>d.actions[0].isVoucher=null]){
    const data=exitSnapshot();change(data);const result=exitPlan(data);
    assert.equal(result.items.length,0);assert.equal(result.skipped.length,1);assert.ok(result.skipped[0].reason);
  }
});

test('voucher current exits and future cancellation do not adjust card prices',()=>{
  const data=exitSnapshot();data.actions[0].isVoucher=true;
  assert.equal(exitPlan(data).items[0].exitByPrice,false);
  data.actions[0].isVoucher=false;data.memberships[0].batchAt='2026-11-01T00:00:00Z';
  delete data.products[0].basePrice;delete data.memberships[0].maxPrice;
  const result=exitPlan(data);assert.equal(result.items[0].operation,'CANCEL_FUTURE');assert.equal(result.items[0].exitByPrice,false);
});
