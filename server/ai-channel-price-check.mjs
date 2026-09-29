import { loadAutoListingCredentialKey } from './auto-listing-ai-credential-config.mjs';
import { createAutoListingCredentialCipher } from './auto-listing-ai-credential-crypto.mjs';
export const priceDay = time => new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(time));
export function summarizePrice(logs, settings, model, now, previous) {
  if (!Array.isArray(logs) || settings.quota_display_type !== 'CUSTOM' || settings.custom_currency_symbol !== '￥'
    || settings.custom_currency_exchange_rate !== 1 || settings.quota_per_unit !== 500000) throw new Error('UNSUPPORTED_BILLING_FORMAT');
  const rows=logs.filter(x=>x.type===2&&x.model_name===model&&Number.isSafeInteger(x.quota)&&x.quota>=0&&Number.isFinite(x.created_at)).sort((a,b)=>b.created_at-a.created_at);
  const latest=rows[0];const today=rows.filter(x=>priceDay(x.created_at*1000)===priceDay(now));
  const distribution={};for(const row of rows)distribution[String(row.quota)]=(distribution[String(row.quota)]||0)+1;
  // Store integer quota units, not floating point currency amounts.
  return {status:today.length?'VERIFIED':'NO_RECENT_USAGE',checkedAt:new Date(now).toISOString(),model,currency:'CNY',quotaPerYuan:500000,
    latestQuota:latest?.quota??null,latestAt:latest?new Date(latest.created_at*1000).toISOString():null,
    earliestAt:rows.length?new Date(rows.at(-1).created_at*1000).toISOString():null,sampleCount:rows.length,todayCount:today.length,distribution,
    changed:Boolean(latest&&previous?.model===model&&((previous.latestQuota!=null&&previous.latestQuota!==latest.quota)||(previous.changed&&priceDay(previous.checkedAt)===priceDay(now)))),
    previousQuota:previous?.model===model?previous.latestQuota??null:null,
    scope:'RECENT_WINDOW',mixedPrices:Object.keys(distribution).length>1};
}
export function createChannelPriceChecker({pool,env=process.env,fetchFn=fetch,clock=Date.now}) {
  return {async runDue() {
    const dailyReady=Number(new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Shanghai',hour:'2-digit',hourCycle:'h23'}).format(new Date(clock())))>=9;
    const cutoff=new Date(clock()-60_000).toISOString();
    // Durable completion records survive restarts; a single query coalesces same-channel completions.
    const rows=(await pool.query(`SELECT c.id,c.account_id,c.base_url,c.image_model,c.credential,p.report AS previous_report,
      r.completed_at AS trigger_completed_at,r.created_at AS trigger_started_at
      FROM ai_user_channels c
      LEFT JOIN LATERAL (SELECT report FROM ai_channel_price_checks WHERE account_id=c.account_id AND channel_id=c.id ORDER BY day DESC LIMIT 1) p ON TRUE
      LEFT JOIN LATERAL (SELECT completed_at,created_at FROM ai_user_channel_requests WHERE account_id=c.account_id AND channel_id=c.id
        AND status='SUCCEEDED' AND task_id LIKE 'ai-listing-%' AND completed_at<=$1::timestamptz
        AND completed_at>COALESCE((p.report->>'processedThrough')::timestamptz,(p.report->>'checkedAt')::timestamptz-INTERVAL '1 minute',NOW()-INTERVAL '1 day')
        ORDER BY completed_at DESC LIMIT 1) r ON TRUE
      WHERE c.enabled=TRUE AND c.deleted_at IS NULL AND c.base_url='https://www.aiartmirror.com/v1'`,[cutoff])).rows;
    for(const row of rows) {
      const now=clock(),day=priceDay(now);
      const retryDue=row.previous_report?.nextRetryAt&&Date.parse(row.previous_report.nextRetryAt)<=now;
      const postGeneration=Boolean(row.trigger_completed_at||retryDue);
      if(!postGeneration&&!dailyReady)continue;
      const previous=row.previous_report;
      const claim=await pool.query(`INSERT INTO ai_channel_price_checks(account_id,channel_id,day,report)
        VALUES($1,$2,$3,$4::jsonb) ON CONFLICT(account_id,channel_id,day) DO UPDATE SET report=EXCLUDED.report,updated_at=NOW()
        WHERE (ai_channel_price_checks.report->>'status'='CHECKING' AND ai_channel_price_checks.updated_at<NOW()-INTERVAL '5 minutes')
          OR ($5 AND ai_channel_price_checks.report=$6::jsonb AND ai_channel_price_checks.report->>'status'<>'CHECKING') RETURNING day`,
        [row.account_id,row.id,day,JSON.stringify({...previous,status:'CHECKING',checkedAt:new Date(now).toISOString()}),postGeneration,JSON.stringify(previous||{})]);
      if(!claim.rows.length)continue;
      let report;
      try {

        const cipher=createAutoListingCredentialCipher({key:await loadAutoListingCredentialKey({env}),keyVersion:env.AUTO_LISTING_CREDENTIAL_KEY_VERSION});
        const key=cipher.decrypt({accountId:row.account_id,connectionId:row.id,connectionVersion:1},row.credential);
        const get=async(path,auth=false)=>{
          const response=await fetchFn('https://www.aiartmirror.com'+path,{headers:auth?{Authorization:'Bearer '+key}:{},redirect:'error',signal:AbortSignal.timeout(20000)});
          if(!response.ok)throw new Error('BILLING_QUERY_FAILED');
          const data=await response.json();if(data.success!==true)throw new Error('BILLING_QUERY_FAILED');return data.data;
        };
        const logs=await get('/api/log/token',true),settings=await get('/api/status');
        report=summarizePrice(logs,settings,row.image_model,now,previous);
      }catch(error){report={status:'FAILED',checkedAt:new Date(now).toISOString(),model:row.image_model,errorCode:error.message==='UNSUPPORTED_BILLING_FORMAT'?'UNSUPPORTED_BILLING_FORMAT':'BILLING_QUERY_FAILED'};}
      report.processedThrough=cutoff;
      report.reason=postGeneration?'GENERATION_COMPLETED':'DAILY';
      report.triggerStartedAt=row.trigger_started_at?new Date(row.trigger_started_at).toISOString():previous?.triggerStartedAt;
      if(postGeneration&&report.status!=='FAILED'&&(!report.latestAt||Date.parse(report.latestAt)<Date.parse(report.triggerStartedAt)-1000)) report.status='WAITING_LOGS';
      report.retryCount=row.trigger_completed_at?0:retryDue?(previous?.retryCount||0)+1:0;
      if(postGeneration&&['FAILED','WAITING_LOGS'].includes(report.status)&&report.retryCount<2)report.nextRetryAt=new Date(now+120_000).toISOString();
      await pool.query('UPDATE ai_channel_price_checks SET report=$4::jsonb,updated_at=NOW() WHERE account_id=$1 AND channel_id=$2 AND day=$3',[row.account_id,row.id,day,JSON.stringify(report)]);
    }
  }};
}
