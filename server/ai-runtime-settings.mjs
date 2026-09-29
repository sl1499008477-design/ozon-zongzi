const fail=(message,statusCode)=>Object.assign(new Error(message),{statusCode});
const limit=(value,fallback)=>{const n=Number(value);return Number.isInteger(n)&&n>=1&&n<=20?n:fallback;};
export function defaultAiRuntimeSettings(env=process.env,platform=process.platform) {
  return {
    productConcurrency:limit(env.AI_LISTING_CONCURRENCY,3),
    requestConcurrency:limit(env.AI_LISTING_REQUEST_CONCURRENCY||env.AI_LISTING_CONCURRENCY,3),
    localConcurrency:Number(env.AI_LISTING_LOCAL_CONCURRENCY)===2?2:1,
    billingConcurrency:limit(env.AI_LISTING_BILLING_CONCURRENCY,1),
    adaptiveEnabled:env.AI_LISTING_ADAPTIVE_CONCURRENCY!=='0'&&(platform==='linux'||env.AI_LISTING_ADAPTIVE_CONCURRENCY==='1'),
  };
}
const emptyWorker=()=>({online:false,status:'unknown',seenAt:null,appliedRevision:null,
  effectiveProductConcurrency:null,activeProducts:null,activeRequests:null,local:null,resources:null,adaptiveEnabled:null});
function validate(input) {
  if(!Number.isInteger(input?.revision)||input.revision<0)throw fail('配置版本无效，请刷新后重试',400);
  const s=input.settings;
  if(!s||typeof s!=='object'||Array.isArray(s)||typeof s.adaptiveEnabled!=='boolean'
    ||!['productConcurrency','requestConcurrency','billingConcurrency'].every(k=>Number.isInteger(s[k])&&s[k]>=1&&s[k]<=20)
    ||![1,2].includes(s.localConcurrency)||Object.keys(s).length!==5)throw fail('商品、请求和计费并发须为 1–20 的整数，本地并发须为 1 或 2',400);
  return s;
}
export function createAiRuntimeSettings({pool,env=process.env,now=Date.now}={}) {
  const defaults=defaultAiRuntimeSettings(env);
  function present(row) {
    const worker=emptyWorker(),seenAt=row?.worker_seen_at||null,stored=row?.worker_status;
    if(stored&&seenAt){
      worker.seenAt=seenAt;worker.status=stored.status||'unknown';worker.appliedRevision=stored.appliedRevision??null;
      worker.online=stored.status==='running'&&now()-new Date(seenAt).getTime()<=20_000;
      if(worker.online)for(const key of ['effectiveProductConcurrency','activeProducts','activeRequests','local','resources','adaptiveEnabled'])worker[key]=stored[key]??null;
    }
    return {settings:row?.settings||{...defaults},revision:row?.revision||0,updatedAt:row?.updated_at||null,source:row?.settings?'saved':'environment',worker};
  }
  return {
    async read(){return present((await pool.query('SELECT * FROM ai_runtime_settings WHERE id=TRUE')).rows[0]);},
    async save(actor,input){
      if(actor?.role!=='admin')throw fail('仅管理员可修改 AI 并发设置',403);
      const settings=validate(input);
      const row=(await pool.query(`UPDATE ai_runtime_settings SET settings=$1::jsonb,revision=revision+1,updated_at=NOW(),updated_by=$2
        WHERE id=TRUE AND revision=$3 RETURNING *`,[JSON.stringify(settings),actor.id,input.revision])).rows[0];
      if(!row)throw fail('配置已由其他管理员更新，请刷新后重试',409);
      return present(row);
    },
    async heartbeat(status){await pool.query('UPDATE ai_runtime_settings SET worker_status=$1::jsonb,worker_seen_at=NOW() WHERE id=TRUE',[JSON.stringify(status)]);},
    async activeCounts(){
      const row=(await pool.query(`SELECT count(*) FILTER (WHERE product_lease_until>NOW())::int AS products,
        count(*) FILTER (WHERE lease_until>NOW())::int AS requests FROM ai_user_channels`)).rows[0];
      return {activeProducts:row.products,activeRequests:row.requests};
    },
  };
}
