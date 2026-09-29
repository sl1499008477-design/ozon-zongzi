// Only an explicit platform item limit error authorizes quota recovery. Local
// transport codes, generic RESOURCE_EXHAUSTED and HTTP 429 are not quota proof.
export function isOzonItemQuotaError(value) {
  if(Array.isArray(value?.errors)){
    const failures=value.errors.filter(e=>!['warning','ERROR_LEVEL_WARNING'].includes(e?.level));
    return failures.length>0&&failures.every(e=>String(e?.code||'').toLowerCase()==='item_limit_exceeded');
  }
  const codes=[value?.code,value?.ozonCode,value?.body?.ozonCode,...(Array.isArray(value?.errors)?value.errors.map(e=>e?.code):[])];
  return codes.some(code=>String(code||'').toLowerCase()==='item_limit_exceeded')
    || /(?:^|[^a-z0-9_])item_limit_exceeded(?:$|[^a-z0-9_])/i.test(String(value?.body?.ozonMessage||''));
}
export function importRetryDelay(error) {
  return Math.max(1000,...[error?.retryAfterMs,error?.itemRetryAfterMs].filter(v=>Number.isFinite(v)&&v>=0),
    Number.isFinite(error?.retryAfterMs)||Number.isFinite(error?.itemRetryAfterMs)?0:60000);
}
function remaining(bucket) {
  return Number.isFinite(bucket?.limit)&&bucket.limit>=0&&Number.isFinite(bucket?.usage)&&bucket.usage>=0?Math.max(0,bucket.limit-bucket.usage):null;
}
function resetAt(bucket,now,fallback) {
  const raw=bucket?.reset_at??bucket?.resetAt;
  const time=typeof raw==='number'?(raw<1e12?raw*1000:raw):Date.parse(raw||'');
  return Number.isFinite(time)&&time>now?time:now+fallback;
}
export function submissionQuotaWait(quota,{storeId,creates,updates=0,now,evidence=false}) {
  const wait=(code,message,bucket,required,delay=300000)=>({code,message,storeId,required,remaining:remaining(bucket),retryAt:resetAt(bucket,now,delay)});
  if(!quota)return evidence?wait('QUOTA_UNKNOWN','Ozon 已拒绝本次商品额度请求，具体额度暂时无法确认，稍后重查',null,creates+updates):null;
  const daily=remaining(quota.daily_create),update=remaining(quota.daily_update),total=remaining(quota.total);
  const extra=quota.total?.quota_by_category;
  const ambiguousTotal=extra&&(Array.isArray(extra)?extra.length>0:Object.keys(extra).length>0);
  if(creates>0&&total!==null&&quota.total.limit>0&&!ambiguousTotal&&total<creates)return wait('TOTAL_LIMIT','店铺商品总容量不足，等待释放容量后继续',quota.total,creates);
  if(creates>0&&daily!==null&&daily<creates)return wait('DAILY_LIMIT','店铺每日新增额度不足，等待额度恢复后继续',quota.daily_create,creates);
  if(updates>0&&update!==null&&update<updates)return wait('DAILY_UPDATE_LIMIT','店铺每日更新额度不足，等待额度恢复后继续',quota.daily_update,updates);
  if(evidence&&((creates>0&&daily===null)||(updates>0&&update===null)))return wait('QUOTA_UNKNOWN','Ozon 已拒绝本次商品额度请求，返回的额度信息不完整，稍后重查',null,creates+updates);
  return null;
}
export function storeSwitchEligible(body) {
  return Boolean(body.quotaWait&&['DAILY_LIMIT','TOTAL_LIMIT'].includes(body.quotaWait.code)
    &&!body.results.some(r=>r.importStatus==='SUCCEEDED'||r.productId||r.importStatus==='UNKNOWN'||r.importStatus==='FAILED'&&!r.quotaRecovery)
    &&!body.attempts.some(a=>['IMPORTING','ACCEPTED','UNCERTAIN'].includes(a.status)||a.preexistingOfferIds?.length)
    &&body.results.every(r=>r.importStatus==='PENDING'||r.importStatus==='FAILED'&&r.quotaRecovery===true));
}
