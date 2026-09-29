import { aiListingPriceFacts } from "./ai-listing-source-facts.mjs";
import { readStoreCredentialV3 } from './listing-pipeline.mjs';
import { callOzonSellerApi } from './ozon-client.mjs';

export async function readOzonProductQuota(credential,{call=callOzonSellerApi,timeout=20000}={}) {
  try {
    return await call(credential,'/v4/product/info/limit',{},timeout);
  } catch(error) {
    // A local network failure may also carry status 502; only a confirmed
    // upstream HTTP 502 allows this read-only request to use the other route.
    if(credential?.ozonRoute!=='CN'||error?.status!==502||error?.code!=='ZONGZI_HTTP_502')throw error;
    return call({...credential,ozonRoute:'RU'},'/v4/product/info/limit',{},timeout);
  }
}

export async function readAiListingStoreQuota({accountId, storeId, readCredential=readStoreCredentialV3, call=callOzonSellerApi}) {
  if (!accountId) throw Object.assign(new Error('请先登录'), {statusCode:403});
  const credential = await readCredential(storeId, accountId);
  if (!credential) throw Object.assign(new Error('店铺不存在或凭据不可用'), {statusCode:404});
  let quota;
  try {
    quota = await readOzonProductQuota(credential,{call,timeout:15000});
  } catch {
    throw Object.assign(new Error('店铺额度暂时无法读取，请稍后刷新'), {statusCode:502});
  }
  try { return {storeId, remaining:dailySkuRemaining(quota)}; }
  catch { throw Object.assign(new Error('Ozon 返回的店铺额度不完整，请稍后刷新'), {statusCode:502}); }
}

function dailySkuRemaining(quota) {
  const bucket=quota?.daily_create;
  if (!Number.isFinite(bucket?.limit) || !Number.isFinite(bucket?.usage)) throw new Error('店铺额度数据不完整');
  return Math.max(0,bucket.limit-bucket.usage);
}

// Only uncreated SKUs consume a new-product reservation. Legacy unresolved imports
// remain conservative until an explicit per-SKU success is available.
export function quotaItems(task) {
  const excluded=new Set((task.source?.skuPricing||[]).filter(row=>row.status==='SKIPPED').map(row=>row.sku));
  for(const row of task.submissionResults||[])if(row.importStatus==='SUCCEEDED'||row.stockStatus==='COMPLETED'||row.isCreated===true)excluded.add(row.sku);
  return task.status==='COMPLETED'?[]:(task.source?.items||[]).filter(item=>!excluded.has(item.sku));
}
export function quotaWaitFor(quota, required, {reserved=0,storeId,now=Date.now()}={}) {
  if(required===0)return null;
  const wait=(code,message,delay,remaining)=>({code,message,...(delay==null?{}:{retryAt:now+delay}),...(storeId?{storeId}:{}),required,...(remaining==null?{}:{remaining})});
  let remaining;try {remaining=dailySkuRemaining(quota);}catch{return wait('QUOTA_UNAVAILABLE','店铺额度暂时无法确认，请稍后检查',60000);}
  if(required>quota.daily_create.limit)return wait('GROUP_EXCEEDS_DAILY_LIMIT','本商品 SKU 数超过店铺每日新增上限，请拆分或调整目标店铺',null,remaining);
  const total=quota.total;
  // Zero/missing total has historically not blocked. Additional category quotas
  // make the general total ambiguous, so only an unqualified positive cap blocks.
  const extra=total?.quota_by_category;
  const extraBuckets=Array.isArray(extra)?extra:extra==null?[]:[extra];
  const extraUncertain=extraBuckets.some(row=>!Number.isFinite(row?.limit)||!Number.isFinite(row?.usage)||row.limit<0||row.limit>row.usage);
  const totalRemaining=Number.isFinite(total?.limit)&&total.limit>0&&Number.isFinite(total?.usage)&&!extraUncertain?Math.max(0,total.limit-total.usage):null;
  if(totalRemaining!==null&&required>totalRemaining)return wait('TOTAL_LIMIT','店铺商品总容量不足，请释放容量或调整目标店铺',300000,totalRemaining);
  // Leave five minutes after the Beijing 08:00 reset before checking again.
  if(required>remaining){
    const todayRecheck=now-now%86400000+300000;
    const retryAt=todayRecheck>now?todayRecheck:todayRecheck+86400000;
    return wait('DAILY_LIMIT','店铺今日新增额度不足，等待北京时间 08:05 后检查额度',retryAt-now,remaining);
  }
  if(required+reserved>remaining||totalRemaining!==null&&required+reserved>totalRemaining)return wait('RESERVED_CAPACITY','店铺可用额度已由其他商品预留，等待额度释放后检查',15000,Math.max(0,Math.min(remaining,totalRemaining??Infinity)-reserved));
  return null;
}
export function quotaAllows(quota, items, reserved = 0) {
  dailySkuRemaining(quota); // Retain the public invalid-response contract.
  return !quotaWaitFor(quota,items.length,{reserved});
}

// Store selection here validates the configured destination only. Actual Ozon
// quota and fallback decisions belong to the durable import result journal.
export function createAiListingStoreRouting({pool,validateTarget,clock=Date.now}) {
  return async function route({task,commit}) {
    const target=task.submissionTarget||{targetStoreId:task.config.targetStoreId,targetWarehouseId:task.config.targetWarehouseId};
    let store;
    try {
      ({store}=await validateTarget({accountId:task.accountId,config:{...task.config,...target},client:pool}));
      for(const group of quotaItems(task))aiListingPriceFacts(task.source,group,{...task.config,...target},store);
    } catch(error) {
      if(error.priceValidationFailure||error.code==='PRICE_FINAL_NOT_POSITIVE'||error.code==='AI_LISTING_CURRENCY_CONVERSION_REQUIRED')throw error;
      const submissionWait={code:'TARGET_UNAVAILABLE',message:'店铺或仓库暂时无法确认，请检查目标设置后重试',retryAt:Number(clock())+60000,storeId:target.targetStoreId};
      return {selected:false,message:submissionWait.message,submissionWait};
    }
    await commit({...target,storeLabel:store.label||store.name||target.targetStoreId});
    return {selected:true};
  };
}
