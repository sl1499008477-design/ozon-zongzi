import { createHash } from 'node:crypto';
import { callOzonSellerApi } from './ozon-client.mjs';

const HOUR = 3600000;
const readyStates = new Set(['posting_transferring_to_delivery','posting_in_carriage','posting_not_in_carriage']);
const shippingStates = new Set(['posting_on_way_to_city','posting_transferred_to_courier_service','posting_in_courier_service','posting_on_way_to_pickup_point']);
const deliveredStates = new Set(['posting_delivered','posting_received']);
const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : undefined;
const scalar = value => typeof value === 'string' ? value : typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : '';
const invalidResponse = () => Object.assign(new Error('Ozon 返回的数据格式不完整，尚未发送消息'), {code:'MESSAGE_ZONGZI_RESPONSE_INVALID'});

export function subscriptionEligible(subscription) {
  return ['PREMIUM_PLUS','PREMIUM_PRO'].includes(subscription?.type);
}

// Shared by the database candidate filter and the final sending state check.
export function postingStateFilter(trigger) {
  switch(trigger) {
    case 'REVIEW':return {status:'delivered',substatuses:['',...deliveredStates]};
    case 'PICKUP':return {status:'delivering',substatuses:['posting_in_pickup_point']};
    case 'SHIPPING_READY':return {status:'awaiting_deliver',substatuses:['',...readyStates]};
    case 'SHIPPED':return {status:'delivering',substatuses:['',...shippingStates]};
    default:return null;
  }
}

export function triggerForPosting(posting) {
  for(const trigger of ['REVIEW','PICKUP','SHIPPING_READY','SHIPPED']) {
    const filter=postingStateFilter(trigger);
    if(posting.status===filter.status && filter.substatuses.includes(posting.substatus || ''))return trigger;
  }
  return null;
}

export function normalizeMessagePosting(raw, scheme) {
  if (!raw || !scalar(raw.posting_number)) throw invalidResponse();
  const events = {};
  // These fields describe handoff to delivery, never buyer receipt.
  const handoff = iso(raw.delivering_date) || iso(raw.fact_delivery_date);
  if (handoff) events.SHIPPED = handoff;
  return {
    postingNumber:scalar(raw.posting_number),orderNumber:scalar(raw.order_number),
    scheme:scheme === 'FBO' ? 'FBO' : /non_integrated|3pl_tracking|aggregator/i.test(raw.tpl_integration_type || '') ? 'rFBS' : 'FBS',
    status:scalar(raw.status),substatus:scalar(raw.substatus),
    products:(Array.isArray(raw.products) ? raw.products : []).map(p => ({name:scalar(p.name),quantity:p.quantity,sku:scalar(p.sku)})),
    trackingNumber:scalar(raw.tracking_number),canCreateChat:Array.isArray(raw.available_actions) && raw.available_actions.includes('can_create_chat'),
    inProcessAt:iso(raw.in_process_at),
    events,
  };
}

export function applyMessageEvent(posting, event) {
  const at = iso(event.changed_state_date);
  if (!at || !scalar(event.new_state)) throw Object.assign(new Error('Ozon 状态事件缺少有效时间或状态'), {status:400,code:'MESSAGE_EVENT_INVALID'});
  const state = event.new_state;
  const status = deliveredStates.has(state) ? 'delivered' : readyStates.has(state) ? 'awaiting_deliver'
    : shippingStates.has(state) || ['posting_in_pickup_point','posting_conditionally_delivered','posting_returned_to_warehouse'].includes(state) ? 'delivering'
      : ['posting_canceled','posting_cancelled'].includes(state) ? 'cancelled' : state;
  const next = {...posting,events:{...posting.events}};
  const trigger = triggerForPosting({status,substatus:state});
  // Retries and out-of-order events must not restart a delay or regress state.
  if (trigger && (!next.events[trigger] || Date.parse(at) < Date.parse(next.events[trigger]))) next.events[trigger] = at;
  if (!posting.stateEventAt || Date.parse(at) > Date.parse(posting.stateEventAt)) {
    Object.assign(next,{status,substatus:state,stateEventAt:at});
  }
  return next;
}

export function canAttemptMessageChat(posting,now = Date.now()) {
  if(posting.scheme==='FBO')return false;
  // A live Premium Pro order had no action flag but chat/start returned 200.
  // Processing time only selects candidates; it is not a payment/receipt date
  // or proof of permission. The latest chat/start response remains authoritative.
  return posting.canCreateChat || [posting.inProcessAt,posting.events?.REVIEW].some(value=>{
    const at=Date.parse(value);return Number.isFinite(at) && at<=now && now-at<72*HOUR;
  });
}

export function messageEligibility(posting, trigger, now = Date.now()) {
  const reasons=[];
  if (triggerForPosting(posting) !== trigger) return {allowed:false,reason:'订单状态已变化，不符合此模板的触发条件',reasons:['订单状态已变化，不符合此模板的触发条件']};
  const eventAt = Date.parse(posting.events?.[trigger]);
  if (!Number.isFinite(eventAt)) reasons.push('缺少真实状态时间；到店和签收需接入 Ozon 状态推送');
  if (eventAt > now) reasons.push('状态事件时间尚未到达');
  if (trigger === 'REVIEW' && now - eventAt >= 72 * HOUR) reasons.push('已超过签收后 72 小时，停止自动评价邀请');
  const waitingForChat=!posting.chatId && posting.chatPreparation?.status==='CREATING';
  if (!posting.chatId && ['CREATING','UNCERTAIN'].includes(posting.chatPreparation?.status)) reasons.push(posting.chatPreparation.reason || '创建聊天结果待核对，暂不重复创建');
  if (posting.scheme === 'FBO') {
    const buyerAt = Date.parse(posting.lastBuyerAt);
    if (!posting.chatId || !Number.isFinite(buyerAt) || buyerAt > now || now - buyerAt >= 48 * HOUR) reasons.push('FBO 只能回复最近 48 小时内买家发起的会话');
  } else if (!posting.chatId && !canAttemptMessageChat(posting,now)) {
    reasons.push('没有可用买家会话，且未发现可尝试建聊的时间窗口');
  }
  return {allowed:reasons.length===0,reason:reasons[0] || '',reasons,waitingForChat};
}

export function messageFingerprint(message) {
  return createHash('sha256').update(JSON.stringify([scalar(message.message_id),message.created_at,message.user?.type,message.data])).digest('hex');
}

export function createMessageOzon({callApi = callOzonSellerApi} = {}) {
  const call = (store,path,body = {}) => callApi(store,path,body,30000,{maxResponseBytes:8 * 1024 * 1024,preserveMessageIds:true});
  return {
    async subscription(store) { const result = await call(store,'/v1/seller/info'); return result?.subscription || {}; },
    async listPostings(store,scheme,{since,to,cursor = ''}) {
      const result = await call(store,scheme === 'FBO' ? '/v3/posting/fbo/list' : '/v4/posting/fbs/list',{
        cursor,filter:{since,to},limit:100,sort_dir:'DESC',translit:false,with:{analytics_data:false,financial_data:false},
      });
      if (!Array.isArray(result?.postings) || (result.has_next && (!result.cursor || result.cursor === cursor))) throw invalidResponse();
      return {postings:result.postings.map(p => normalizeMessagePosting(p,scheme)),cursor:result.cursor || '',hasNext:result.has_next === true};
    },
    async getPosting(store,posting) {
      const result = await call(store,posting.scheme === 'FBO' ? '/v2/posting/fbo/get' : '/v3/posting/fbs/get',{
        posting_number:posting.postingNumber,with:{analytics_data:false,financial_data:false},
      });
      const fresh = normalizeMessagePosting(result?.result,posting.scheme);
      if (fresh.postingNumber !== posting.postingNumber) throw invalidResponse();
      return fresh;
    },
    async chats(store,cursor = '') {
      const result = await call(store,'/v3/chat/list',{filter:{chat_status:'OPENED',unread_only:false},limit:100,cursor});
      if (!Array.isArray(result?.chats) || (result.has_next && (!result.cursor || result.cursor === cursor))) throw invalidResponse();
      return {chats:result.chats.map(c=>c.chat).filter(c=>c?.chat_type === 'Buyer_Seller' && c.chat_status === 'OPENED'),cursor:result.cursor || '',hasNext:result.has_next === true};
    },
    async history(store,chatId,{since=Date.now()-48*HOUR,maxPages=5} = {}) {
      const messages=[];const seen=new Set();let cursor='',complete=false,hasNext=false;
      for(let page=0;page<maxPages;page++) {
        const result=await call(store,'/v3/chat/history',{chat_id:chatId,direction:'Backward',limit:1000,...(cursor?{from_message_id:cursor}:{})});
        if(!Array.isArray(result?.messages))throw invalidResponse();
        for(const message of result.messages) {
          const key=messageFingerprint(message);if(!seen.has(key)){seen.add(key);messages.push(message);}
        }
        hasNext=result.has_next===true;
        const dated=result.messages.filter(m=>iso(m.created_at)).sort((a,b)=>Date.parse(a.created_at)-Date.parse(b.created_at));
        if(!hasNext || dated.length && Date.parse(dated[0].created_at)<=since) {complete=true;break;}
        const next=scalar(dated[0]?.message_id);
        if(!next||next===cursor)break;
        cursor=next;
      }
      const orderNumbers = [...new Set(messages.map(m => scalar(m.context?.order_number)).filter(Boolean))];
      const lastBuyerAt = messages.filter(m=>m.user?.type === 'Customer' && iso(m.created_at)).map(m=>m.created_at).sort((a,b)=>Date.parse(b)-Date.parse(a))[0] || '';
      return {messages,orderNumbers,lastBuyerAt,hasNext,complete};
    },
    async startChat(store,postingNumber) {
      const result = await call(store,'/v1/chat/start',{posting_number:postingNumber});
      if (!result?.result?.chat_id) throw invalidResponse();
      return result.result.chat_id;
    },
    async send(store,chatId,text) {
      const result = await call(store,'/v1/chat/send/message',{chat_id:chatId,text});
      if (result?.result !== 'success') throw invalidResponse();
      return result;
    },
  };
}
