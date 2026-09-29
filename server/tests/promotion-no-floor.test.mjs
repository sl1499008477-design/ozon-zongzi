import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultPromotionSettings,normalizePromotionSettings,normalizePromotionRule,buildPromotionPlan,promotionItemApplied} from '../promotion-policy.mjs';

const now=Date.parse('2026-09-15T00:00:00Z');
const rule={name:'弹性活动',enabled:true,actionIds:['a'],productIds:[],categoryIds:[],participationScope:'ALL',minStock:1,maxDiscountPercent:null,quantity:null,schedule:{mode:'DAILY',time:'21:00',timeZone:'Asia/Shanghai'}};
const snapshot=()=>({actions:[{id:'a',type:'ELASTIC_BOOSTING',endAt:'2026-10-01T00:00:00Z',candidates:[{productId:'p',maxPrice:'733.25'}]}],products:[{productId:'p',currency:'CNY',availableStock:5,basePrice:'1000.00',archived:false}],memberships:[]});

test('报名无需两种底价，历史底价和币种也不改变活动价格',()=>{
  for(const config of [defaultPromotionSettings(),{...defaultPromotionSettings(),floors:{p:{price:'9999.00',currency:'RUB'}}}]){
    for(const saved of [rule,{...rule,minPrice:'99999.00',currency:'USD'}]){
      const plan=buildPromotionPlan(snapshot(),config,{source:'RULE',rule:saved},now);
      assert.equal(plan.skipped.length,0);
      assert.deepEqual(plan.items.map(x=>({operation:x.operation,price:x.price,currency:x.currency,quantity:x.quantity})),[{operation:'JOIN',price:'733.25',currency:'CNY',quantity:null}]);
    }
  }
});

test('保存旧规则会移除底价字段，无效的历史底价不再阻止改名',()=>{
  const result=normalizePromotionRule({name:'新名称'},{...rule,minPrice:'-100',currency:'unknown'},now);
  assert.equal(result.name,'新名称');
  assert.equal('minPrice' in result,false);assert.equal('currency' in result,false);
  assert.deepEqual(result.schedule,rule.schedule);
});

test('无底价报名仍检查折扣、价格、库存、币种与重复报名',()=>{
  for(const change of [d=>{d.products[0].currency='';},d=>{d.products[0].availableStock=0;},d=>{d.products[0].archived=true;},d=>{d.actions[0].candidates[0].maxPrice='0';},d=>{d.actions[0].candidates[0].maxPrice=null;},d=>{d.memberships=[{actionId:'a',productId:'p',batchAt:'',mode:'MANUAL'}];}]){
    const data=snapshot();change(data);assert.equal(buildPromotionPlan(data,defaultPromotionSettings(),{source:'RULE',rule},now).items.length,0);
  }
  assert.equal(buildPromotionPlan(snapshot(),defaultPromotionSettings(),{source:'RULE',rule:{...rule,maxDiscountPercent:20}},now).items.length,0);
  assert.equal(buildPromotionPlan(snapshot(),defaultPromotionSettings(),{source:'RULE',rule:{...rule,maxDiscountPercent:30}},now).items.length,1);
});

test('历史按底价退出不会变成全部退出，旧平台底价不再生成写入计划',()=>{
  const data=snapshot();data.memberships=[{actionId:'a',productId:'p',batchAt:'',mode:'AUTO',price:'100.00',currency:'CNY'}];
  const legacy={...defaultPromotionSettings(),enabled:true,exitEnabled:true,exitMode:'BELOW_FLOOR',protectPrices:true,floors:{p:{price:'800.00',currency:'CNY'}}};
  assert.equal(buildPromotionPlan(data,legacy,{source:'EXIT'},now).items.length,0);
  assert.equal(buildPromotionPlan(data,legacy,{source:'FLOORS'},now).items.length,0);
  const editable=normalizePromotionSettings({},legacy);
  assert.equal(editable.enabled,true);assert.equal(editable.exitEnabled,false);assert.equal(editable.exitMode,'ALL_AUTO');
  assert.equal('floors' in editable,false);assert.equal('protectPrices' in editable,false);
  assert.equal(buildPromotionPlan(data,normalizePromotionSettings({exitEnabled:true},editable),{source:'EXIT'},now).items.length,1);
});

test('历史已经提交的平台底价操作仍可以只读确认',()=>{
  const data=snapshot();Object.assign(data.products[0],{minPrice:'500.00',minPriceEnabled:true,minPriceExpiresAt:new Date(now+30*86400000).toISOString()});
  assert.equal(promotionItemApplied({operation:'SET_FLOOR',productId:'p',currency:'CNY',price:'500.00'},data,now),true);
  assert.equal(promotionItemApplied({operation:'SET_FLOOR',productId:'p',currency:'CNY',price:'600.00'},data,now),false);
});
