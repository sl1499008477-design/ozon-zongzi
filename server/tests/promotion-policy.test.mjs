import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultPromotionSettings,normalizePromotionRule,normalizePromotionSettings,buildPromotionPlan,promotionItemApplied,promotionItemKey,nextPromotionRunAt} from '../promotion-policy.mjs';

const now=Date.parse('2026-09-10T12:00:00Z');
const snapshot=()=>({fetchedAt:new Date(now).toISOString(),actions:[{id:'a',title:'活动',type:'STOCK_DISCOUNT',startAt:'2026-09-01T00:00:00Z',endAt:'2026-10-01T00:00:00Z',freezeAt:'',autoAddDates:['2026-09-14T21:00:00Z'],candidates:[{productId:'p',maxPrice:'112.00',minQuantity:1}]}],products:[{productId:'p',currency:'CNY',name:'灯',categoryId:'c',basePrice:'200.00',currentPrice:'130.00',availableStock:8,archived:false,minPrice:null,minPriceEnabled:false}],memberships:[]});
const rule=patch=>normalizePromotionRule({name:'每天报名',enabled:true,actionIds:['a'],productIds:[],categoryIds:[],minStock:1,quantity:1,schedule:{mode:'DAILY',time:'21:00',timeZone:'Asia/Shanghai'},...patch},null,now);

test('报名降价比例可设置、清空和保留，不能超过降幅上限或使价格为零',()=>{
  assert.equal(rule().targetDiscountPercent,null);
  for(const targetDiscountPercent of [0,0.29,20.1,50,99.99])assert.equal(rule({targetDiscountPercent}).targetDiscountPercent,targetDiscountPercent);
  const saved=rule({targetDiscountPercent:30,maxDiscountPercent:50});
  assert.equal(normalizePromotionRule({name:'改名'},saved,now).targetDiscountPercent,30);
  assert.equal(normalizePromotionRule({targetDiscountPercent:null},saved,now).targetDiscountPercent,null);
  assert.equal(normalizePromotionRule({targetDiscountPercent:''},saved,now).targetDiscountPercent,null);
  for(const targetDiscountPercent of [-1,100,100.01,20.001,NaN,Infinity])assert.throws(()=>rule({targetDiscountPercent}),/报名降价比例/);
  assert.throws(()=>rule({targetDiscountPercent:50,maxDiscountPercent:40}),/不能超过最大降价幅度/);
  assert.equal(rule({targetDiscountPercent:50,maxDiscountPercent:50}).targetDiscountPercent,50);
});

test('填写报名降价比例按非活动基准价定价；未填沿用平台最高价',()=>{
  const data=snapshot(),plan=buildPromotionPlan(data,defaultPromotionSettings(),{source:'RULE',rule:rule({targetDiscountPercent:50,maxDiscountPercent:50})},now);
  assert.equal(plan.items[0].price,'100.00');assert.equal(plan.items[0].targetDiscountPercent,50);assert.equal(plan.items[0].discountPercent,'50.00');
  assert.equal(plan.items[0].basePrice,'200.00');assert.equal(plan.items[0].maxDiscountPercent,50);
  for(const targetDiscountPercent of [null,undefined,'']){
    const legacy=buildPromotionPlan(data,defaultPromotionSettings(),{source:'RULE',rule:rule({targetDiscountPercent})},now);
    assert.equal(legacy.items[0].price,'112.00');assert.equal(legacy.items[0].targetDiscountPercent,null);
  }
});

test('设定比例不满足平台活动价时明确跳过，不能擅自加大折扣',()=>{
  const data=snapshot();data.products[0].basePrice='100.00';data.actions[0].candidates[0].maxPrice='60.00';
  const plan=buildPromotionPlan(data,defaultPromotionSettings(),{source:'RULE',rule:rule({targetDiscountPercent:30,maxDiscountPercent:50})},now);
  assert.equal(plan.items.length,0);assert.equal(plan.skipped[0].price,'70.00');
  assert.equal(plan.skipped[0].targetDiscountPercent,30);assert.equal(plan.skipped[0].discountPercent,'30.00');
  assert.match(plan.skipped[0].reason,/70\.00.*60\.00/);
  assert.equal(data.actions[0].candidates[0].maxPrice,'60.00');
});

test('报名金额向上取整到分，实际降幅不超过设定；显式0%与极小金额保持正价',()=>{
  const data=snapshot();data.products[0].basePrice='19.99';data.actions[0].candidates[0].maxPrice='16.00';
  let plan=buildPromotionPlan(data,defaultPromotionSettings(),{source:'RULE',rule:rule({targetDiscountPercent:20,maxDiscountPercent:20})},now);
  assert.equal(plan.items[0].price,'16.00');assert.equal(plan.items[0].discountPercent,'19.96');
  data.actions[0].candidates[0].maxPrice='20.00';
  plan=buildPromotionPlan(data,defaultPromotionSettings(),{source:'RULE',rule:rule({targetDiscountPercent:0})},now);
  assert.equal(plan.items[0].price,'19.99');assert.equal(plan.items[0].discountPercent,'0.00');
  data.products[0].basePrice='0.01';data.actions[0].candidates[0].maxPrice='0.01';
  plan=buildPromotionPlan(data,defaultPromotionSettings(),{source:'RULE',rule:rule({targetDiscountPercent:99.99})},now);
  assert.equal(plan.items[0].price,'0.01');
});

test('设定报名比例必须有基准价和平台允许价，未填写比例保留原兼容行为',()=>{
  const data=snapshot();data.products[0].basePrice=null;
  let plan=buildPromotionPlan(data,defaultPromotionSettings(),{source:'RULE',rule:rule({targetDiscountPercent:50})},now);
  assert.equal(plan.items.length,0);assert.equal(plan.skipped[0].price,null);assert.match(plan.skipped[0].reason,/非活动.*未确认/);
  assert.equal(buildPromotionPlan(data,defaultPromotionSettings(),{source:'RULE',rule:rule()},now).items[0].price,'112.00');
  data.products[0].basePrice='200.00';data.actions[0].candidates[0].maxPrice=null;
  plan=buildPromotionPlan(data,defaultPromotionSettings(),{source:'RULE',rule:rule({targetDiscountPercent:50})},now);
  assert.equal(plan.items.length,0);assert.match(plan.skipped[0].reason,/平台允许的活动价未确认/);
});

test('preview freezes non-activity reference price and actual decrease independently of the rule ceiling',()=>{
 const data=snapshot(),plan=buildPromotionPlan(data,defaultPromotionSettings(),{source:'RULE',rule:rule({maxDiscountPercent:50})},now);
 assert.equal(plan.items[0].price,'112.00');assert.equal(plan.items[0].basePrice,'200.00');
 assert.equal(plan.items[0].discountPercent,'44.00');assert.equal(plan.items[0].maxDiscountPercent,50);
 data.products[0].basePrice='999.00';assert.equal(plan.items[0].basePrice,'200.00','historical preview must not depend on the next product snapshot');
 const missing=snapshot();missing.products[0].basePrice=null;
 const unknown=buildPromotionPlan(missing,defaultPromotionSettings(),{source:'RULE',rule:rule()},now);
 assert.equal(unknown.items[0].basePrice,null);assert.equal(unknown.items[0].discountPercent,null);
});

test('规则边界：默认关闭；日程、库存和开关有效',()=>{
  assert.equal(defaultPromotionSettings().enabled,false);
  assert.throws(()=>normalizePromotionRule({...rule(),minStock:-1},null,now));
  assert.throws(()=>normalizePromotionRule({...rule(),schedule:{mode:'DAILY',time:'25:00',timeZone:'Asia/Shanghai'}},null,now));
  assert.throws(()=>normalizePromotionSettings({enabled:'yes'},defaultPromotionSettings()));
  assert.throws(()=>normalizePromotionSettings({timeZone:'toString'},defaultPromotionSettings()));
  assert.throws(()=>normalizePromotionSettings({exitMode:'BELOW_FLOOR'},defaultPromotionSettings()),/已移除/);
});

test('两位小数折扣按十进制校验，边界值不受浮点乘法误差影响',()=>{
  for(const value of [20.1,8.03,0.29,0,100])assert.equal(rule({maxDiscountPercent:value}).maxDiscountPercent,value);
  for(const value of [-1,100.01,20.001,NaN,Infinity])assert.throws(()=>rule({maxDiscountPercent:value}));
  const data=snapshot();data.actions[0].candidates[0].maxPrice='159.80';
  assert.equal(buildPromotionPlan(data,defaultPromotionSettings(),{source:'RULE',rule:rule({maxDiscountPercent:20.1})},now).items.length,1);
  data.actions[0].candidates[0].maxPrice='159.79';
  assert.equal(buildPromotionPlan(data,defaultPromotionSettings(),{source:'RULE',rule:rule({maxDiscountPercent:20.1})},now).items.length,0);
});

test('报名复核商品范围、实际库存、活动冻结以及已有参加状态',()=>{
  const config=defaultPromotionSettings();
  for(const change of [d=>d.products[0].availableStock=null,d=>d.products[0].availableStock=0,d=>d.products[0].archived=true,d=>d.actions[0].freezeAt='2026-09-20T00:00:00Z',d=>d.actions[0].endAt='2026-09-09T00:00:00Z']){
    const d=snapshot();change(d);assert.equal(buildPromotionPlan(d,config,{source:'RULE',rule:rule()},now).items.length,0);
  }
  assert.equal(buildPromotionPlan(snapshot(),config,{source:'RULE',rule:rule({productIds:['other']})},now).items.length,0);
  assert.equal(buildPromotionPlan(snapshot(),config,{source:'RULE',rule:rule({categoryIds:['other']})},now).items.length,0);
  assert.equal(buildPromotionPlan(snapshot(),config,{source:'RULE',rule:rule({quantity:10})},now).items.length,0);
  const d=snapshot();d.memberships.push({actionId:'a',productId:'p',batchAt:'',mode:'MANUAL',price:'115.00'});
  assert.equal(buildPromotionPlan(d,config,{source:'RULE',rule:rule()},now).items.length,0);
});

test('活动参与范围默认兼容旧规则，保存后保留且拒绝未知范围',()=>{
  assert.equal(rule().participationScope,'ALL');
  const saved=rule({participationScope:'NONE'});
  assert.equal(saved.participationScope,'NONE');
  assert.equal(normalizePromotionRule({name:'改名'},saved,now).participationScope,'NONE');
  assert.throws(()=>rule({participationScope:'NEVER'}),/参与范围/);
});

test('参活件数可不设置；明确设置时须为正整数，零值没有不限含义',()=>{
  assert.equal(rule({quantity:null}).quantity,null);
  assert.equal(rule({quantity:undefined}).quantity,null);
  assert.equal(rule({quantity:3}).quantity,3);
  for(const quantity of [0,-1,1.5,'invalid'])assert.throws(()=>rule({quantity}),/参活件数/);
});

test('混合活动仅为库存折扣应用件数，其他活动忽略数量字段但仍检查实际库存',()=>{
  const data=snapshot();data.actions.push({...data.actions[0],id:'elastic',type:'ELASTIC_BOOSTING',candidates:[{productId:'p',maxPrice:'112.00',minQuantity:999}]});
  let plan=buildPromotionPlan(data,defaultPromotionSettings(),{source:'RULE',rule:rule({actionIds:[],quantity:3})},now);
  assert.deepEqual(plan.items.map(x=>[x.actionId,x.quantity]),[['a',3],['elastic',null]]);
  plan=buildPromotionPlan(data,defaultPromotionSettings(),{source:'RULE',rule:rule({actionIds:['elastic'],quantity:1000})},now);
  assert.equal(plan.items.length,1,'非库存折扣不受不适用的件数限制');
  data.products[0].availableStock=0;
  assert.equal(buildPromotionPlan(data,defaultPromotionSettings(),{source:'RULE',rule:rule({actionIds:['elastic'],quantity:null})},now).items.length,0,'仍须满足真实库存门槛');
});

test('旧零值与未填件数跳过库存折扣，其他活动可继续；不自动替换报名量',()=>{
  const data=snapshot();data.actions.push({...data.actions[0],id:'elastic',type:'ELASTIC_BOOSTING'});
  for(const quantity of [0,null,undefined]){
    const plan=buildPromotionPlan(data,defaultPromotionSettings(),{source:'RULE',rule:{...rule({actionIds:[]}),quantity}},now);
    assert.deepEqual(plan.items.map(x=>[x.actionId,x.quantity]),[['elastic',null]]);
    assert.match(plan.skipped[0].reason,/库存折扣.*正整数.*参活件数/);
  }
  data.actions[0].candidates[0].minQuantity=3;
  assert.match(buildPromotionPlan(data,defaultPromotionSettings(),{source:'RULE',rule:rule({quantity:2})},now).skipped[0].reason,/低于平台要求/);
  assert.equal(buildPromotionPlan(data,defaultPromotionSettings(),{source:'RULE',rule:rule({quantity:3})},now).items[0].quantity,3);
});

test('没有提交件数的报名按活动身份与价格核对，已明确提交的件数仍须一致',()=>{
  const data=snapshot(),item={operation:'JOIN',actionId:'a',productId:'p',batchAt:'',price:'112.00',quantity:null};
  data.memberships=[{actionId:'a',productId:'p',batchAt:'',price:'112.00',quantity:99}];
  assert.equal(promotionItemApplied(item,data,now),true);
  assert.equal(promotionItemApplied({...item,quantity:3},data,now),false);
  assert.equal(promotionItemApplied({...item,price:'113.00'},data,now),false);
});

test('未参与范围排除所有活动的当前与未来报名，不受来源和所选活动限制',()=>{
  for(const actionId of ['a','other'])for(const mode of ['AUTO','MANUAL','UNKNOWN'])for(const batchAt of ['',new Date(now+86400000).toISOString()]){
    const data=snapshot();data.memberships=[{actionId,productId:'p',mode,batchAt}];
    const plan=buildPromotionPlan(data,defaultPromotionSettings(),{source:'RULE',rule:rule({participationScope:'NONE'})},now);
    assert.equal(plan.items.length,0,`${actionId}/${mode}/${batchAt}`);
    assert.match(plan.skipped[0].reason,/已参加活动或已有未来报名/);
    if(actionId==='other')assert.equal(buildPromotionPlan(data,defaultPromotionSettings(),{source:'RULE',rule:rule()},now).items.length,1,'全部范围仍可跨活动报名');
  }
});

test('未参与范围每次读取动态商品与报名，不按历史参与或上架天数筛选',()=>{
  const data=snapshot(),saved=rule({participationScope:'NONE'}),config=defaultPromotionSettings();
  data.products.push({...data.products[0],productId:'new'});data.actions[0].candidates.push({...data.actions[0].candidates[0],productId:'new'});
  let plan=buildPromotionPlan(data,config,{source:'RULE',rule:saved},now);
  assert.deepEqual(plan.items.map(x=>x.productId),['p','new']);
  data.memberships=[{actionId:'other',productId:'new',mode:'AUTO',batchAt:''}];
  assert.deepEqual(buildPromotionPlan(data,config,{source:'RULE',rule:saved},now).items.map(x=>x.productId),['p']);
  data.memberships=[];
  plan=buildPromotionPlan(data,config,{source:'RULE',rule:{...saved,productIds:['new']}},now);
  assert.deepEqual(plan.items.map(x=>x.productId),['new'],'退出过的商品可再入选，指定商品范围仍取交集');
});

test('未参与范围等待其他活动报名的不明结果，不能将查询暂未显示视为从未报名',()=>{
  const options={blockedJoinProductIds:new Set(['p'])};
  const plan=buildPromotionPlan(snapshot(),defaultPromotionSettings(),{source:'RULE',rule:rule({participationScope:'NONE'})},now,options);
  assert.equal(plan.items.length,0);assert.match(plan.skipped[0].reason,/报名.*核对|报名.*处理/);
  assert.equal(buildPromotionPlan(snapshot(),defaultPromotionSettings(),{source:'RULE',rule:rule()},now,options).items.length,1);
});

test('仅退出明确AUTO；当前和未来分开，MANUAL未知与例外均保留',()=>{
  const d=snapshot(),c=defaultPromotionSettings();
  d.memberships=[{actionId:'a',productId:'p',batchAt:'',mode:'AUTO',price:'100.00',currency:'CNY'},{actionId:'a',productId:'p',batchAt:'2026-09-14T21:00:00Z',mode:'AUTO',price:'90.00',currency:'CNY'},{actionId:'a',productId:'manual',batchAt:'',mode:'MANUAL',price:'50.00'},{actionId:'a',productId:'unknown',batchAt:'',mode:'UNKNOWN',price:'20.00'}];
  let p=buildPromotionPlan(d,c,{source:'EXIT'},now);
  assert.deepEqual(p.items.map(x=>x.operation),['EXIT','CANCEL_FUTURE']);
  assert.equal(new Set(p.items.map(promotionItemKey)).size,2);
  c.protectedProductIds=['p'];assert.equal(buildPromotionPlan(d,c,{source:'EXIT'},now).items.length,0);
  c.protectedProductIds=[];c.exitMode='BELOW_FLOOR';c.floors={p:{price:'95.00',currency:'CNY'}};
  assert.equal(buildPromotionPlan(d,c,{source:'EXIT'},now).items.length,0);
  c.exitMode='ALL_AUTO';
  assert.equal(buildPromotionPlan(d,c,{source:'EXIT'},now,{blockedKeys:new Set(p.items.map(promotionItemKey))}).items.length,0);
});

test('平台批次开始处理后不再提交过期的未来取消，保留明确原因',()=>{
  const d=snapshot();d.memberships=[{actionId:'a',productId:'p',batchAt:new Date(now-1000).toISOString(),mode:'AUTO',price:'90.00'}];
  const p=buildPromotionPlan(d,defaultPromotionSettings(),{source:'EXIT'},now);
  assert.equal(p.items.length,0);assert.match(p.skipped[0].reason,/生效|处理/);
});

test('写入核对以真实状态为准，缺失或错误价格不冒充成功',()=>{
  const d=snapshot(),item={operation:'JOIN',actionId:'a',productId:'p',batchAt:'',price:'112.00',quantity:0};
  assert.equal(promotionItemApplied(item,d,now),false);
  d.memberships=[{actionId:'a',productId:'p',batchAt:'',price:'112.00',quantity:0}];
  assert.equal(promotionItemApplied(item,d,now),true);
  assert.equal(promotionItemApplied({...item,operation:'EXIT'},d,now),false);
  d.memberships=[];assert.equal(promotionItemApplied({...item,operation:'EXIT'},d,now),true);
  d.memberships=[{actionId:'a',productId:'p',batchAt:'',price:'90.00',quantity:0,mode:'AUTO'}];
  assert.equal(promotionItemApplied({...item,operation:'CANCEL_FUTURE',batchAt:new Date(now-1000).toISOString()},d,now),false,'未来批次转为当前活动不能误报取消成功');
  Object.assign(d.products[0],{minPrice:'100.00',minPriceEnabled:true,minPriceExpiresAt:new Date(now+30*86400000).toISOString()});
  assert.equal(promotionItemApplied({operation:'SET_FLOOR',productId:'p',price:'100.00',currency:'CNY'},d,now),true);
});

test('日程按指定时区计算，错过的任务由持久next_run_at领取，不重复同一日',()=>{
  assert.equal(nextPromotionRunAt(rule().schedule,now),'2026-09-10T13:00:00.000Z');
  assert.equal(nextPromotionRunAt(rule().schedule,Date.parse('2026-09-10T13:00:00Z')),'2026-09-11T13:00:00.000Z');
  assert.equal(nextPromotionRunAt({...rule().schedule,timeZone:'Europe/Moscow'},now),'2026-09-10T18:00:00.000Z');
  assert.equal(nextPromotionRunAt({mode:'ONCE',at:'2026-09-10T11:00:00Z'},now),null);
});
