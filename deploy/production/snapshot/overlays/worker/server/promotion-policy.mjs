const DAY=86400000;
const ZONES={'Asia/Shanghai':8,'Europe/Moscow':3};
const fail=message=>Object.assign(new Error(message),{status:400,code:'PROMOTION_INVALID'});
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const ids=value=>{
  if(!Array.isArray(value)||value.length>1000||value.some(x=>!['string','number'].includes(typeof x)||!String(x).trim()||String(x).length>240))throw fail('商品、类目和活动范围必须是有效编号列表，最多1000项');
  return [...new Set(value.map(x=>String(x).trim()))];
};
const minor=value=>{const [whole,fraction='']=String(value??'0').split('.');return BigInt(whole||'0')*100n+BigInt((fraction+'00').slice(0,2));};
const money=value=>`${value/100n}.${String(value%100n).padStart(2,'0')}`;
const knownMoney=value=>value!==null&&value!==undefined&&value!==''&&Number.isFinite(Number(value));
const asIso=value=>new Date(value).toISOString();

export function defaultPromotionSettings(){return {enabled:false,timeZone:'Asia/Shanghai',exitEnabled:false,exitMode:'ALL_AUTO',protectedActionIds:[],protectedProductIds:[]};}
export function normalizePromotionSettings(input,existing=defaultPromotionSettings()) {
  if(!object(input))throw fail('设置必须为对象');
  const {floors,protectPrices,...retained}=existing;
  const config={...defaultPromotionSettings(),...retained};
  // Retiring the conditional mode must not expand it into unconditional exits.
  if(config.exitMode==='BELOW_FLOOR')config.exitEnabled=false;
  config.exitMode='ALL_AUTO';
  for(const key of ['enabled','exitEnabled'])if(key in input){if(typeof input[key]!=='boolean')throw fail('开关值无效');config[key]=input[key];}
  if('timeZone' in input){if(!Object.hasOwn(ZONES,input.timeZone))throw fail('请选择北京时间或莫斯科时间');config.timeZone=input.timeZone;}
  if('exitMode' in input&&input.exitMode!=='ALL_AUTO')throw fail('按底价退出已移除，请刷新页面后设置自动退出');
  for(const key of ['protectedActionIds','protectedProductIds'])if(key in input)config[key]=ids(input[key]);
  return config;
}
export function normalizePromotionRule(input,existing=null,now=Date.now()) {
  if(!object(input))throw fail('报名规则必须为对象');
  const body={...existing,...input};
  if(typeof body.name!=='string'||!body.name.trim()||body.name.trim().length>80)throw fail('请填写80字以内的规则名称');
  if(typeof body.enabled!=='boolean')throw fail('规则开关无效');
  const participationScope=body.participationScope??'ALL';
  if(!['ALL','NONE'].includes(participationScope))throw fail('活动参与范围无效');
  const minStock=Number(body.minStock??1),quantity=body.quantity==null||body.quantity===''?null:Number(body.quantity);
  if(!Number.isSafeInteger(minStock)||minStock<1||minStock>10000000)throw fail('最低库存须为正整数');
  if(quantity!==null&&(!Number.isSafeInteger(quantity)||quantity<1||quantity>10000000))throw fail('参活件数须为正整数；0不表示不限，请修改');
  const maxDiscountPercent=body.maxDiscountPercent==null||body.maxDiscountPercent===''?null:Number(body.maxDiscountPercent);
  if(maxDiscountPercent!==null&&(maxDiscountPercent>100||!/^\d{1,3}(\.\d{1,2})?$/.test(String(maxDiscountPercent))))throw fail('最高折扣幅度须在0至100之间，最多两位小数');
  const s=body.schedule;if(!object(s)||!['ONCE','DAILY'].includes(s.mode)||!Object.hasOwn(ZONES,s.timeZone))throw fail('请选择有效日程和时区');
  let schedule;
  if(s.mode==='DAILY'){
    if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(s.time))throw fail('每日时间须为HH:mm');
    schedule={mode:'DAILY',time:s.time,timeZone:s.timeZone};
  }else{
    const at=Date.parse(s.at);if(!Number.isFinite(at)||(!existing&&at<=now))throw fail('单次执行时间须为将来时间');
    schedule={mode:'ONCE',at:asIso(at),timeZone:s.timeZone};
  }
  return {name:body.name.trim(),enabled:body.enabled,actionIds:ids(body.actionIds||[]),productIds:ids(body.productIds||[]),categoryIds:ids(body.categoryIds||[]),participationScope,minStock,maxDiscountPercent,quantity,schedule};
}
export function nextPromotionRunAt(schedule,after=Date.now()) {
  if(schedule.mode==='ONCE')return Date.parse(schedule.at)>after?asIso(schedule.at):null;
  const offset=ZONES[schedule.timeZone]*3600000,local=new Date(after+offset),[h,m]=schedule.time.split(':').map(Number);
  let at=Date.UTC(local.getUTCFullYear(),local.getUTCMonth(),local.getUTCDate(),h,m)-offset;
  if(at<=after)at+=DAY;
  return asIso(at);
}
export const promotionItemKey=item=>['SET_FLOOR','RENEW_FLOOR'].includes(item.operation)?`floor:${item.productId}`:`${item.actionId}:${item.productId}:${item.batchAt||''}`;
const actionUnavailable=(action,now)=>!action?'活动资料缺失':action.freezeAt?'活动冻结，平台限制修改名单':Date.parse(action.endAt)<=now?'活动已结束':'';

export function buildPromotionPlan(snapshot,config,{source,rule},now=Date.now(),{blockedKeys=new Set(),blockedJoinProductIds=new Set()}={}) {
  const products=new Map(snapshot.products.map(p=>[p.productId,p])),actions=new Map(snapshot.actions.map(a=>[a.id,a]));
  const items=[],skipped=[];
  const add=(item,reason)=>{
    const p=products.get(item.productId),a=actions.get(item.actionId);
    const view={...item,name:p?.name||item.productId,offerId:p?.offerId||'',actionTitle:a?.title||'',status:'PLANNED'};
    const why=reason||(blockedKeys.has(promotionItemKey(item))?'上次操作尚未核对或正在处理':'');
    if(why)skipped.push({...view,status:'SKIPPED',reason:why});else items.push(view);
  };
  if(source==='EXIT')for(const m of snapshot.memberships){
    if(m.mode!=='AUTO')continue;
    const item={...m,operation:m.batchAt?'CANCEL_FUTURE':'EXIT',reason:'平台自动报名，按退出规则清理'};
    let reason=actionUnavailable(actions.get(m.actionId),now);
    if(config.protectedActionIds.includes(m.actionId)||config.protectedProductIds.includes(m.productId))reason='已加入退出例外';
    if(m.batchAt&&Date.parse(m.batchAt)<=now)reason='未来批次已经开始生效，等待平台处理后检查当前活动';
    if(config.exitMode==='BELOW_FLOOR')reason='按底价退出已移除，请重新设置自动退出';
    add(item,reason);
  }
  else if(source==='RULE'&&rule){
    const participating=new Set(snapshot.memberships.filter(m=>!m.batchAt).map(m=>`${m.actionId}:${m.productId}`));
    const enrolledProducts=new Set(snapshot.memberships.map(m=>m.productId));
    for(const a of snapshot.actions){
      if(rule.actionIds.length&&!rule.actionIds.includes(a.id))continue;
      const usesQuantity=a.type==='STOCK_DISCOUNT',quantity=usesQuantity?rule.quantity:null;
      for(const candidate of a.candidates||[]){
        const p=products.get(candidate.productId);
        if(rule.productIds.length&&!rule.productIds.includes(candidate.productId))continue;
        if(rule.categoryIds.length&&!rule.categoryIds.includes(p?.categoryId))continue;
        const item={operation:'JOIN',actionId:a.id,productId:candidate.productId,batchAt:'',currency:p?.currency,quantity,price:candidate.maxPrice,reason:'符合报名规则，使用平台最高允许活动价'};
        let reason=actionUnavailable(a,now);
        if(!p)reason='商品资料缺失';
        else if(p.archived)reason='商品已归档';
        else if(!p.currency)reason='商品币种未确认';
        else if(p.availableStock===null||!Number.isFinite(p.availableStock))reason='实际可售库存未确认';
        else if(usesQuantity&&!(quantity>0))reason='库存折扣须设置正整数参活件数，请编辑规则';
        else if(p.availableStock<Math.max(rule.minStock,usesQuantity?candidate.minQuantity||0:0,quantity||0))reason='实际库存不足';
        else if(usesQuantity&&quantity<(candidate.minQuantity||0))reason='参活件数低于平台要求';
        else if(rule.participationScope==='NONE'&&enrolledProducts.has(p.productId))reason='商品已参加活动或已有未来报名';
        else if(rule.participationScope==='NONE'&&blockedJoinProductIds.has(p.productId))reason='该商品的其他活动报名尚在处理或等待核对';
        else if(participating.has(`${a.id}:${p.productId}`))reason='商品已经参加当前活动';
        else {
          if(!knownMoney(candidate.maxPrice)||minor(candidate.maxPrice)<=0n)reason='平台允许的活动价未确认';
          else {
            const price=minor(candidate.maxPrice);item.price=money(price);
            if(rule.maxDiscountPercent!=null){
              if(!knownMoney(p.basePrice)||minor(p.basePrice)<=0n)reason='非活动价格未确认，无法核对折扣';
              else if((minor(p.basePrice)-price)*10000n>minor(p.basePrice)*minor(rule.maxDiscountPercent))reason='折扣幅度超过规则上限（以非活动价为基准）';
            }
          }
        }
        add(item,reason);
      }
    }
  }
  return {items,skipped};
}

export function promotionItemApplied(item,snapshot,now=Date.now()) {
  const m=snapshot.memberships.find(m=>m.actionId===item.actionId&&m.productId===item.productId&&(m.batchAt||'')===(item.batchAt||''));
  if(item.operation==='CANCEL_FUTURE'&&Date.parse(item.batchAt)<=now&&snapshot.memberships.some(x=>x.actionId===item.actionId&&x.productId===item.productId&&!x.batchAt))return false;
  if(['EXIT','CANCEL_FUTURE'].includes(item.operation))return !m;
  if(item.operation==='JOIN')return !!m&&knownMoney(m.price)&&minor(m.price)===minor(item.price)&&(item.quantity==null||Number(m.quantity)===Number(item.quantity));
  const p=snapshot.products.find(p=>p.productId===item.productId);
  return !!p&&p.currency===item.currency&&knownMoney(p.minPrice)&&minor(p.minPrice)===minor(item.price)&&p.minPriceEnabled===true&&Date.parse(p.minPriceExpiresAt)>now+7*DAY;
}
