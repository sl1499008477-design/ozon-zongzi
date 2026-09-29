import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMessagePosting, triggerForPosting, applyMessageEvent, messageEligibility,
  subscriptionEligible, createMessageOzon } from '../message-ozon.mjs';

const now = Date.parse('2026-09-10T12:00:00Z');
const base = { postingNumber:'100-2-1',orderNumber:'100-2',scheme:'FBS',status:'delivering',substatus:'posting_in_pickup_point',events:{PICKUP:'2026-09-09T10:00:00Z'},canCreateChat:true };
test('真实到店/签收事件和发货时间分开，重复和乱序回调不回退状态', () => {
  const p = normalizeMessagePosting({posting_number:'100-2-1',order_number:'100-2',status:'delivered',fact_delivery_date:'2026-09-01T00:00:00Z',in_process_at:'2026-08-01T00:00:00Z'},'FBS');
  assert.equal(p.events.REVIEW,undefined); assert.equal(p.events.PICKUP,undefined);
  const e={new_state:'posting_received',changed_state_date:'2026-09-10T09:00:00Z'};
  const signed=applyMessageEvent(base,e);
  assert.equal(signed.events.REVIEW,e.changed_state_date);assert.equal(triggerForPosting(signed),'REVIEW');
  assert.deepEqual(applyMessageEvent(signed,e),signed);
  const late=applyMessageEvent(signed,{new_state:'posting_in_pickup_point',changed_state_date:'2026-09-09T10:00:00Z'});
  assert.equal(late.substatus,'posting_received');assert.equal(late.events.PICKUP,'2026-09-09T10:00:00Z');
  assert.equal(triggerForPosting({...base,substatus:'posting_conditionally_delivered'}),null);
  assert.equal(triggerForPosting({...base,substatus:'posting_on_way_to_pickup_point'}),'SHIPPED');
  assert.equal(triggerForPosting({...base,status:'awaiting_deliver',substatus:'posting_transferring_to_delivery'}),'SHIPPING_READY');
});
test('仅 Premium Plus/Pro 开通API发送，FBO只能回复48小时内买家消息', () => {
  assert.equal(subscriptionEligible({is_premium:true,type:'PREMIUM'}),false);
  assert.equal(subscriptionEligible({type:'PREMIUM_PLUS'}),true);
  assert.equal(subscriptionEligible({type:'PREMIUM_PRO'}),true);
  assert.equal(messageEligibility({...base,scheme:'FBO'},'PICKUP',now).allowed,false);
  assert.equal(messageEligibility({...base,scheme:'FBO',chatId:'chat',lastBuyerAt:'2026-09-09T12:00:01Z'},'PICKUP',now).allowed,true);
  assert.equal(messageEligibility({...base,scheme:'FBO',chatId:'chat',lastBuyerAt:'2026-09-08T12:00:00Z'},'PICKUP',now).allowed,false);
});
test('到店/签收时间缺失及状态变化阻止发送，签收后自动邀请严格小于72小时', () => {
  assert.equal(messageEligibility(base,'PICKUP',now).allowed,true);
  assert.equal(messageEligibility({...base,events:{}},'PICKUP',now).allowed,false);
  assert.equal(messageEligibility({...base,status:'cancelled'},'PICKUP',now).allowed,false);
  assert.equal(messageEligibility({...base,canCreateChat:false},'PICKUP',now).allowed,false);
  assert.equal(messageEligibility({...base,chatId:'known',canCreateChat:false},'PICKUP',now).allowed,true);
  const signed={...base,status:'delivered',substatus:'posting_delivered',events:{REVIEW:'2026-09-07T12:00:01Z'}};
  assert.equal(messageEligibility(signed,'REVIEW',now).allowed,true);
  assert.equal(messageEligibility({...signed,events:{REVIEW:'2026-09-07T12:00:00Z'},lastBuyerAt:'2026-09-10T11:00:00Z'},'REVIEW',now).allowed,false);
});
test('同时缺状态时间和会话时分别说明，已准备会话不会消除缺失时间',()=>{
  const missing=messageEligibility({...base,events:{},canCreateChat:false},'PICKUP',now);
  assert.equal(missing.reasons.length,2);
  assert.ok(missing.reasons.some(reason=>reason.includes('真实状态时间')));
  assert.ok(missing.reasons.some(reason=>reason.includes('买家会话')));
  const prepared=messageEligibility({...base,events:{},chatId:'prepared',canCreateChat:false},'PICKUP',now);
  assert.equal(prepared.reasons.length,1);assert.equal(prepared.allowed,false);
});
test('动作标记不是唯一建聊依据，近期处理或真实签收窗口可交由API确认',()=>{
  const fresh={...base,canCreateChat:false,inProcessAt:'2026-09-10T11:52:00Z'};
  assert.equal(messageEligibility(fresh,'PICKUP',now).allowed,true);
  assert.equal(messageEligibility({...fresh,inProcessAt:'2026-09-07T12:00:00Z'},'PICKUP',now).allowed,false);
  assert.equal(messageEligibility({...fresh,inProcessAt:'2026-09-10T12:00:01Z'},'PICKUP',now).allowed,false);
  assert.equal(messageEligibility({...fresh,scheme:'FBO'},'PICKUP',now).allowed,false);
  const signed={...base,canCreateChat:false,status:'delivered',substatus:'posting_received',events:{REVIEW:'2026-09-10T11:00:00Z'}};
  assert.equal(messageEligibility(signed,'REVIEW',now).allowed,true);
  const normalized=normalizeMessagePosting({posting_number:'100-2-1',in_process_at:fresh.inProcessAt},'FBS');
  assert.equal(normalized.inProcessAt,fresh.inProcessAt);assert.deepEqual(normalized.events,{});
});
test('使用当前分页版本和包裹号读取，聊天历史只映射真实订单上下文',async()=>{
  const calls=[];
  const ozon=createMessageOzon({callApi:async(_store,path,body)=>{calls.push({path,body});
    if(path.includes('/list')&&path.includes('/posting/'))return {postings:[{posting_number:'100-2-1',order_number:'100-2'}],cursor:'next',has_next:true};
    if(path.endsWith('/get'))return {result:{posting_number:body.posting_number,order_number:'100-2',status:'delivering'}};
    if(path==='/v3/chat/history')return {messages:[{message_id:'9000000000000000001',context:{order_number:'100-2'},user:{type:'Customer'},created_at:'2026-09-10T11:00:00Z',data:['hello']}],has_next:false};
    throw Error(path);
  }});
  assert.equal((await ozon.listPostings({},'FBS',{since:'2026-06-01T00:00:00Z',to:'2026-09-10T00:00:00Z'})).hasNext,true);
  await ozon.listPostings({},'FBO',{since:'2026-06-01T00:00:00Z',to:'2026-09-10T00:00:00Z'});
  await ozon.getPosting({},base); const history=await ozon.history({},'c');
  assert.equal(calls[0].path,'/v4/posting/fbs/list');assert.equal(calls[1].path,'/v3/posting/fbo/list');
  assert.equal(calls[2].body.posting_number,'100-2-1');assert.equal(calls[3].body.direction,'Backward');
  assert.deepEqual(history.orderNumbers,['100-2']);assert.equal(history.lastBuyerAt,'2026-09-10T11:00:00Z');
});
test('聊天历史回溯到所需窗口，分页没有覆盖时不宣称完整',async()=>{
  let calls=0;
  const ozon=createMessageOzon({callApi:async(_store,_path,body)=>{calls++;
    if(!body.from_message_id)return {messages:[{message_id:'9000000000000000002',created_at:'2026-09-10T11:00:00Z',user:{type:'Seller'},data:['x']}],has_next:true};
    assert.equal(body.from_message_id,'9000000000000000002');
    return {messages:[{message_id:'9000000000000000001',created_at:'2026-09-09T12:00:00Z',user:{type:'Customer'},context:{order_number:'100-2'},data:['question']}],has_next:false};
  }});
  const result=await ozon.history({},'chat',{since:Date.parse('2026-09-08T12:00:00Z')});
  assert.equal(calls,2);assert.equal(result.lastBuyerAt,'2026-09-09T12:00:00Z');assert.equal(result.complete,true);
  const partial=await ozon.history({},'chat',{since:Date.parse('2026-09-08T12:00:00Z'),maxPages:1});assert.equal(partial.complete,false);
});
test('消息接口保留大整数消息编号，翻页不因 JavaScript 数值精度丢失消息',async(t)=>{
  const original=globalThis.fetch;const bodies=[];
  t.after(()=>{globalThis.fetch=original;});
  globalThis.fetch=async(_url,options)=>{const body=JSON.parse(options.body);bodies.push(body);
    return new Response(bodies.length===1?' {"messages":[{"message_id":9000000000000000003,"created_at":"2026-09-10T11:00:00Z","data":["x"],"user":{"type":"Seller"}}],"has_next":true}'
      : '{"messages":[],"has_next":false}',{status:200,headers:{'Content-Type':'application/json'}});
  };
  const result=await createMessageOzon().history({clientId:'fixture',apiKey:'fixture'},'chat',{since:0});
  assert.equal(bodies[1]?.from_message_id,'9000000000000000003');assert.equal(result.messages[0].message_id,'9000000000000000003');
});
