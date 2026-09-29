import {productStatusMeta,productKnownStockValue} from '../shared/product-catalog.mjs';
import {hydratedProductRow} from './formal-persistence.mjs';
import {DEFAULT_INSPECTION_PREFIXES} from './order-inspection-service.mjs';
import {ORDER_STATUS_GROUPS} from './order-management-money.mjs';
import {readDailyListingSummary} from './daily-listing-summary.mjs';
import {aiListingStageSql} from './ai-listing-stages.mjs';

const day=86400000,beijingOffset=8*3600000;
const unavailable={dailyListings:'今日上架统计暂不可用',inspection:'质检单统计暂不可用',orders:'订单统计暂不可用',products:'库存统计暂不可用',ai:'上架任务统计暂不可用',wallet:'账户余额暂不可用',promotions:'活动统计暂不可用'};
const iso=value=>value==null?null:new Date(value).toISOString();

export function createDashboardService({pool,clock=Date.now,readDailyListings=readDailyListingSummary}={}) {
  async function inspection(accountId) {
    const number="COALESCE(NULLIF(o.management_data->>'orderNumber',''),o.raw->>'order_number','')";
    const row=(await pool.query(`WITH matched AS (
      SELECT DISTINCT o.store_id,${number} AS order_number
      FROM orders o JOIN stores s ON s.id=o.store_id AND s.owner_account_id=$1
      WHERE LEFT(${number},5)=ANY(COALESCE((SELECT prefixes FROM order_inspection_settings WHERE account_id=$1),$2::text[]))
    ) SELECT COUNT(*)::int AS unread_count FROM matched m
      LEFT JOIN order_inspection_reads r ON r.account_id=$1 AND r.store_id=m.store_id AND r.order_number=m.order_number
      WHERE r.read_at IS NULL`,[accountId,DEFAULT_INSPECTION_PREFIXES])).rows[0];
    return {unreadCount:row.unread_count};
  }
  async function orders(accountId,storeId,dates) {
    const pending=[...ORDER_STATUS_GROUPS.awaiting_packaging,...ORDER_STATUS_GROUPS.awaiting_deliver];
    const row=(await pool.query(`SELECT COUNT(*)::int AS pending_count,
      (SELECT state->>'completedAt' FROM ozon_order_management_sync WHERE account_id=$1 AND store_id=$2) AS last_sync_at
      FROM orders o JOIN stores s ON s.id=o.store_id AND s.owner_account_id=$1
      WHERE o.store_id=$2 AND COALESCE(o.in_process_at,o.created_at)>=$3::timestamptz
        AND COALESCE(o.in_process_at,o.created_at)<=$4::timestamptz
        AND COALESCE(o.management_data->>'status',o.status)=ANY($5::text[])`,[accountId,storeId,dates.since,dates.to,pending])).rows[0];
    return {pendingCount:row.pending_count,...dates,lastSyncAt:row.last_sync_at};
  }
  async function products(accountId,storeId) {
    const {rows}=await pool.query(`SELECT p.status,p.visibility,p.is_archived,p.stock_total,p.synced_at,
      jsonb_build_object('status',p.raw->'status','statuses',p.raw->'statuses','state',p.raw->'state',
        'visibility',p.raw->'visibility','visibilityFilter',p.raw->'visibilityFilter','_visibility',p.raw->'_visibility',
        'product_visibility',p.raw->'product_visibility','productVisibility',p.raw->'productVisibility',
        'archived',p.raw->'archived','stock',p.raw->'stock','stocks',p.raw->'stocks') AS raw
      FROM products p JOIN stores s ON s.id=p.store_id AND s.owner_account_id=$1 WHERE p.store_id=$2`,[accountId,storeId]);
    let outOfStock=0,lowStock=0,lastSyncAt=null;
    for(const row of rows) {
      if(row.synced_at&&(!lastSyncAt||new Date(row.synced_at)>new Date(lastSyncAt)))lastSyncAt=iso(row.synced_at);
      const item=hydratedProductRow(row);
      if(productStatusMeta(item).label!=='销售中')continue;
      const stock=productKnownStockValue(item);
      if(stock===null)continue;
      if(stock<=0)outOfStock++;
      else if(stock<=10)lowStock++;
    }
    return {outOfStock,lowStock,attentionCount:outOfStock+lowStock,lastSyncAt};
  }
  async function ai(accountId,now) {
    const row=(await pool.query(`SELECT
      COUNT(*) FILTER(WHERE ${aiListingStageSql('review')})::int AS review,
      COUNT(*) FILTER(WHERE ${aiListingStageSql('failed')})::int AS failed,
      COUNT(*) FILTER(WHERE ${aiListingStageSql('enrichment')})::int AS waiting,
      COUNT(*) FILTER(WHERE ${aiListingStageSql('generating','$2')})::int AS generating,
      COUNT(*) FILTER(WHERE ${aiListingStageSql('submitting')})::int AS submitting
      FROM ai_image_listing_tasks WHERE account_id=$1 AND deleted_at IS NULL
        AND list_summary#>>'{_list,permanentlyDeletedAt}' IS NULL AND status NOT IN ('MERGED','COMPLETED')`,[accountId,now])).rows[0];
    return {review:row.review,failed:row.failed,waitingForEnrichment:row.waiting,generating:row.generating,submitting:row.submitting,attentionCount:row.review+row.failed+row.waiting};
  }
  async function wallet(accountId) {
    const row=(await pool.query(`SELECT (balance_cents-reserved_cents)::text AS available_cents,reserved_cents::text
      FROM ai_user_wallets WHERE account_id=$1`,[accountId])).rows[0];
    return {availableCents:row?.available_cents??'0',reservedCents:row?.reserved_cents??'0',currency:'CNY'};
  }
  async function promotions(accountId,storeId) {
    const row=(await pool.query(`SELECT COUNT(*)::int AS uncertain_count FROM ozon_promotion_runs r
      JOIN stores s ON s.id=r.store_id AND s.owner_account_id=$1
      WHERE r.account_id=$1 AND r.store_id=$2 AND r.status='UNCERTAIN'`,[accountId,storeId])).rows[0];
    return {uncertainCount:row.uncertain_count};
  }
  async function getSummary({accountId,storeId=null}) {
    if(!accountId)throw Object.assign(Error('请先登录'),{status:401,code:'DASHBOARD_UNAUTHENTICATED'});
    storeId=storeId||null;
    if(storeId) {
      if(typeof storeId!=='string'||storeId.length>240)throw Object.assign(Error('请选择当前账号的店铺'),{status:400,code:'DASHBOARD_STORE_INVALID'});
      const owned=await pool.query('SELECT id FROM stores WHERE owner_account_id=$1 AND id=$2',[accountId,storeId]);
      if(!owned.rowCount)throw Object.assign(Error('店铺不属于当前账号'),{status:403,code:'DASHBOARD_STORE_FORBIDDEN'});
    }
    const now=Number(clock()),date=new Date(now+beijingOffset).toISOString().slice(0,10);
    const start=Date.parse(`${date}T00:00:00+08:00`),dates={since:iso(start-29*day),to:iso(start+day-1)};
    const result={asOf:iso(now),storeId,
      dailyListings:{count:null,date,timeZone:'Asia/Shanghai',byStore:[],complete:false,note:unavailable.dailyListings},
      inspection:{unreadCount:null},orders:{pendingCount:null,...dates,lastSyncAt:null},
      products:{outOfStock:null,lowStock:null,attentionCount:null,lastSyncAt:null},
      ai:{review:null,failed:null,waitingForEnrichment:null,generating:null,submitting:null,attentionCount:null},
      wallet:{availableCents:null,reservedCents:null,currency:'CNY'},promotions:{uncertainCount:null},errors:{}};
    const sections={dailyListings:()=>readDailyListings({pool,accountId,now}),inspection:()=>inspection(accountId),ai:()=>ai(accountId,now),wallet:()=>wallet(accountId)};
    if(storeId)Object.assign(sections,{orders:()=>orders(accountId,storeId,dates),products:()=>products(accountId,storeId),promotions:()=>promotions(accountId,storeId)});
    else for(const section of ['orders','products','promotions'])result.errors[section]='请先选择店铺';
    const entries=Object.entries(sections),outcomes=await Promise.allSettled(entries.map(([,read])=>Promise.resolve().then(read)));
    for(let index=0;index<entries.length;index++) {
      const [section]=entries[index],outcome=outcomes[index];
      if(outcome.status==='fulfilled')result[section]=outcome.value;
      else result.errors[section]=unavailable[section];
    }
    return result;
  }
  return {getSummary};
}
