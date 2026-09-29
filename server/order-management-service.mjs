import {pinOzonCredential} from './account-ozon-route.mjs';
import {annotateOrderInspection} from './order-inspection-service.mjs';
import {randomUUID,createHash} from 'node:crypto';
import {readStoreCredentialV3} from './listing-pipeline.mjs';
import {createOrderManagementOzon} from './order-management-ozon.mjs';
import {normalizeOrderPosting,orderPostingView,orderStatusGroup,ORDER_STATUS_GROUPS} from './order-management-money.mjs';
import {createProductCostsService,normalizeUnitCostCny} from './product-costs.mjs';

const error=(message,status=400,code='ORDER_MANAGEMENT_INVALID')=>Object.assign(new Error(message),{status,code});
const args=scope=>[scope.accountId,scope.storeId];
const iso=at=>new Date(at).toISOString();
const idle=()=>({status:'IDLE',since:null,to:null,scheme:null,pages:0,processed:0,startedAt:null,updatedAt:null,completedAt:null,lastError:null});
const publicSync=state=>Object.fromEntries(Object.keys(idle()).map(key=>[key,state?.[key]??idle()[key]]));
const knownStatuses=Object.values(ORDER_STATUS_GROUPS).flat();
const schemeFamily=scheme=>scheme==='FBO'?'FBO':'FBS';
function checkScheme(scheme){if(!['FBS','rFBS','FBO'].includes(scheme))throw error('scheme 必须为 FBS、rFBS 或 FBO');}
function period(input,now,{sync=false}={}){
  function read(value,end){
    if(value==null||value==='')return null;
    if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value))throw error('日期须为 YYYY-MM-DD 或含时区的 ISO 时间');
    const at=Date.parse(value.length===10?value+(end?'T23:59:59.999Z':'T00:00:00.000Z'):value);
    if(!Number.isFinite(at)||value.length===10&&iso(at).slice(0,10)!==value)throw error('日期无效');
    return at;
  }
  const to=read(input?.to,true)??now,since=read(input?.since,false)??to-30*86400000;
  if(since>to)throw error('开始日期不能晚于结束日期');
  if(sync&&to-since>365*86400000)throw error('每次同步的日期范围不能超过一年，请分段同步');
  return {since:iso(since),to:iso(to)};
}
function integer(value,fallback,max){
  if(value==null||value==='')return fallback;
  if(!/^\d+$/.test(String(value))||!Number.isSafeInteger(Number(value))||Number(value)<1||Number(value)>max)throw error('分页参数无效');
  return Number(value);
}
function safeError(e){
  if(/^ORDER_MANAGEMENT_/.test(e?.code||''))return e.message;
  const status=Number(e?.status);
  return Number.isInteger(status)&&status>=400&&status<=599?`Ozon 订单读取失败（HTTP ${status}），请检查店铺权限后重新同步`:'订单同步未完成，请稍后重新同步';
}

export function createOrderManagementService({pool,ozon=createOrderManagementOzon(),readCredential=readStoreCredentialV3,clock=Date.now}={}){
  async function assertStore(scope,db=pool){
    if(!scope.accountId||!scope.storeId||String(scope.storeId).length>240)throw error('请选择当前账号的店铺');
    const row=(await db.query(`SELECT s.id FROM stores s JOIN accounts a ON a.id=s.owner_account_id
      WHERE s.id=$2 AND s.owner_account_id=$1 AND s.status<>'disabled' AND a.status='active'
      AND (a.expires_at IS NULL OR a.expires_at>NOW())`,args(scope))).rows[0];
    if(!row)throw error('店铺不属于当前账号或账号不可用',403,'ORDER_MANAGEMENT_STORE_FORBIDDEN');
  }
  const productCosts=createProductCostsService({pool,assertStore});
  async function transaction(work){
    const db=await pool.connect();try{await db.query('BEGIN');const result=await work(db);await db.query('COMMIT');return result;}
    catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}
  }
  function basePosting(row){
    return row.management_data||normalizeOrderPosting({...row.raw,posting_number:row.posting_number,status:row.status,
      in_process_at:row.in_process_at?.toISOString?.()||row.raw?.in_process_at,
      created_at:row.created_at?.toISOString?.()||row.raw?.created_at},row.shipment_type||'FBS');
  }
  async function hydrate(scope,postings,db=pool){
    const items=postings.flatMap(p=>p.products),skus=[...new Set(items.map(p=>p.sku).filter(Boolean))],offers=[...new Set(items.map(p=>p.offerId).filter(Boolean))];
    if(!items.length)return postings;
    const {rows}=await db.query(`SELECT p.product_id,p.sku,p.offer_id,p.image_url FROM products p JOIN stores s ON s.id=p.store_id
      WHERE s.owner_account_id=$1 AND p.store_id=$2 AND (p.sku=ANY($3::text[]) OR p.offer_id=ANY($4::text[]))`,[...args(scope),skus,offers]);
    const bySku=new Map(),byOffer=new Map();
    for(const row of rows)for(const [map,key] of [[bySku,row.sku],[byOffer,row.offer_id]]){
      if(key)map.set(key,map.has(key)?null:row);
    }
    return postings.map(posting=>({...posting,products:posting.products.map(p=>{
      const found=bySku.has(p.sku)?bySku.get(p.sku):byOffer.get(p.offerId);
      return {...p,productId:p.productId||found?.product_id||null,imageUrl:found?.image_url||p.imageUrl||null};
    })}));
  }
  async function syncRow(scope,db=pool){return (await db.query('SELECT state FROM ozon_order_management_sync WHERE account_id=$1 AND store_id=$2',args(scope))).rows[0]?.state||idle();}
  async function syncStatus(scope){await assertStore(scope);return {sync:publicSync(await syncRow(scope))};}
  async function overview(scope,input={}){
    await assertStore(scope);
    const dates=period(input,clock()),page=integer(input.page,1,1000000),pageSize=integer(input.pageSize,50,100);
    const q=String(input.q||'').trim();if(q.length>240)throw error('搜索内容过长');
    const status=input.status||'all';if(!['all','other','pending',...Object.keys(ORDER_STATUS_GROUPS)].includes(status))throw error('订单筛选状态无效');
    const pattern='%'+q.replace(/[\\%_]/g,'\\$&')+'%';
    const cte=`WITH filtered AS (SELECT o.*,COALESCE(o.management_data->>'status',o.status) AS effective_status
      FROM orders o JOIN stores s ON s.id=o.store_id AND s.owner_account_id=$1
      WHERE o.store_id=$2 AND COALESCE(o.in_process_at,o.created_at)>=$3::timestamptz
        AND COALESCE(o.in_process_at,o.created_at)<=$4::timestamptz
        AND ($5='%%' OR o.posting_number ILIKE $5 OR o.order_id ILIKE $5
          OR COALESCE(o.management_data->>'orderNumber',o.raw->>'order_number','') ILIKE $5
          OR EXISTS(SELECT 1 FROM jsonb_array_elements(CASE
            WHEN jsonb_typeof(COALESCE(o.management_data->'products',o.raw->'products'))='array'
            THEN COALESCE(o.management_data->'products',o.raw->'products') ELSE '[]'::jsonb END) p
            WHERE p->>'name' ILIKE $5 OR p->>'sku' ILIKE $5 OR COALESCE(p->>'offerId',p->>'offer_id') ILIKE $5)))`;
    const queryArgs=[...args(scope),dates.since,dates.to,pattern];
    const selection=status==='all'?'$6::text[] IS NOT NULL':status==='other'?'NOT (effective_status=ANY($6::text[]))':'effective_status=ANY($6::text[])';
    const selectedStatuses=status==='other'?knownStatuses:status==='pending'?[...ORDER_STATUS_GROUPS.awaiting_packaging,...ORDER_STATUS_GROUPS.awaiting_deliver]:ORDER_STATUS_GROUPS[status]||[];
    const [selected,counts,state]=await Promise.all([
      pool.query(`${cte} SELECT * FROM filtered WHERE ${selection} ORDER BY COALESCE(in_process_at,created_at) DESC,posting_number DESC
        LIMIT $7 OFFSET $8`,[...queryArgs,selectedStatuses,pageSize,(page-1)*pageSize]),
      pool.query(`${cte} SELECT effective_status,COUNT(*)::integer AS count FROM filtered GROUP BY effective_status`,queryArgs),syncRow(scope),
    ]);
    const statusCounts=Object.fromEntries(['all',...Object.keys(ORDER_STATUS_GROUPS),'other'].map(key=>[key,0]));
    for(const row of counts.rows){statusCounts.all+=row.count;statusCounts[orderStatusGroup(row.effective_status)]+=row.count;}
    statusCounts.pending=statusCounts.awaiting_packaging+statusCounts.awaiting_deliver;
    const bases=await hydrate(scope,selected.rows.map(basePosting));
    const items=await annotateOrderInspection(pool,scope.accountId,scope.storeId,bases.map((base,index)=>orderPostingView(base,selected.rows[index].purchase_costs)));
    return {items,total:statusCounts[status],page,pageSize,statusCounts,sync:publicSync(state)};
  }
  async function postingRow(scope,postingNumber,scheme,db=pool,lock=false){
    checkScheme(scheme);
    const row=(await db.query(`SELECT o.* FROM orders o JOIN stores s ON s.id=o.store_id AND s.owner_account_id=$1
      WHERE o.store_id=$2 AND o.posting_number=$3 ${lock?'FOR UPDATE OF o':''}`,[...args(scope),postingNumber])).rows[0];
    if(!row||schemeFamily(basePosting(row).scheme)!==schemeFamily(scheme))throw error('订单不属于当前店铺或配送方式',404,'ORDER_MANAGEMENT_NOT_FOUND');
    return row;
  }
  async function getPosting(scope,postingNumber,scheme){
    await assertStore(scope);const row=await postingRow(scope,postingNumber,scheme);
    const [base]=await hydrate(scope,[basePosting(row)]);return {posting:orderPostingView(base,row.purchase_costs)};
  }
  async function saveCosts(scope,postingNumber,scheme,input){
    await assertStore(scope);checkScheme(scheme);
    if(!Array.isArray(input?.items)||!input.items.length||input.items.length>1000)throw error('请传入需要保存采购成本的订单商品');
    const items=input.items.map(item=>({sku:String(item?.sku??''),unitCostCny:normalizeUnitCostCny(item?.unitCostCny)}));
    if(new Set(items.map(item=>item.sku)).size!==items.length)throw error('同一商品不能重复填写采购成本');
    await transaction(async db=>{
      const row=await postingRow(scope,postingNumber,scheme,db,true),base=basePosting(row),skus=new Set(base.products.map(p=>p.sku));
      if(items.some(item=>!item.sku||!skus.has(item.sku)))throw error('采购成本商品不属于此订单');
      const patch=Object.fromEntries(items.map(item=>[item.sku,{unitCostCny:item.unitCostCny,costSource:'MANUAL'}]));
      await db.query('UPDATE orders SET purchase_costs=purchase_costs || $3::jsonb WHERE id=$1 AND store_id=$2',[row.id,scope.storeId,patch]);
    });return getPosting(scope,postingNumber,scheme);
  }
  async function requestSync(scope,input={}){
    await assertStore(scope);const dates=period(input,clock(),{sync:true});
    return transaction(async db=>{
      await db.query(`INSERT INTO ozon_order_management_sync(account_id,store_id,state) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,[...args(scope),idle()]);
      const current=(await db.query('SELECT state FROM ozon_order_management_sync WHERE account_id=$1 AND store_id=$2 FOR UPDATE',args(scope))).rows[0].state;
      if(['QUEUED','RUNNING'].includes(current.status))return {sync:publicSync(current)};
      const state={...idle(),...dates,status:'QUEUED',scheme:'FBS',cursor:'',seenCursors:[],updatedAt:iso(clock())};
      pinOzonCredential(await readCredential(scope.storeId,scope.accountId,db),state);
      await db.query('UPDATE ozon_order_management_sync SET state=$3,next_run_at=$4 WHERE account_id=$1 AND store_id=$2',[...args(scope),state,iso(clock())]);
      return {sync:publicSync(state)};
    });
  }
  async function processNext(){
    const candidate=(await pool.query(`SELECT account_id,store_id FROM ozon_order_management_sync
      WHERE next_run_at<=$1 ORDER BY next_run_at,account_id,store_id LIMIT 1`,[iso(clock())])).rows[0];
    if(!candidate)return false;
    const scope={accountId:candidate.account_id,storeId:candidate.store_id},db=await pool.connect();
    const lockKey=`ozon-order-management:${scope.accountId}:${scope.storeId}`;let held=false,state;
    try{
      held=(await db.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS held',[lockKey])).rows[0].held;
      if(!held)return false;
      state=await syncRow(scope,db);if(!['QUEUED','RUNNING'].includes(state.status))return false;
      try{
        await assertStore(scope,db);
        state={...state,status:'RUNNING',startedAt:state.startedAt||iso(clock()),updatedAt:iso(clock()),lastError:null};
        const credential=pinOzonCredential(await readCredential(scope.storeId,scope.accountId),state);
        await db.query('UPDATE ozon_order_management_sync SET state=$3 WHERE account_id=$1 AND store_id=$2',[...args(scope),state]);
        if(!credential)throw error('店铺 API 凭证不可用',409,'ORDER_MANAGEMENT_CREDENTIALS_REQUIRED');
        const page=await ozon.listPostings(credential,state.scheme,{since:state.since,to:state.to,cursor:state.cursor});
        const nextHash=page.cursor?createHash('sha256').update(page.cursor).digest('hex'):'';
        if(page.hasNext&&(!nextHash||state.seenCursors.includes(nextHash)))throw error('Ozon 返回重复分页游标，请重新同步',502,'ORDER_MANAGEMENT_CURSOR_REPEATED');
        await db.query('BEGIN');
        try{
          // Recheck ownership after the network wait before persisting any page.
          await assertStore(scope,db);
          const postings=await hydrate(scope,page.postings,db);
          if(postings.length){
            const {rows}=await db.query(`INSERT INTO orders AS existing(id,store_id,posting_number,order_id,status,shipment_type,in_process_at,created_at,management_data)
              SELECT x->>'id',$2,x->'body'->>'postingNumber',COALESCE(x->'body'->>'orderId',''),x->'body'->>'status',x->'body'->>'scheme',
                (x->'body'->>'inProcessAt')::timestamptz,(x->'body'->>'createdAt')::timestamptz,x->'body'
              FROM jsonb_array_elements($3::jsonb) x
              WHERE EXISTS(SELECT 1 FROM stores s WHERE s.id=$2 AND s.owner_account_id=$1)
              ON CONFLICT(store_id,posting_number) WHERE posting_number<>'' DO UPDATE SET
                status=EXCLUDED.status,shipment_type=EXCLUDED.shipment_type,
                order_id=COALESCE(NULLIF(EXCLUDED.order_id,''),existing.order_id),
                in_process_at=COALESCE(EXCLUDED.in_process_at,existing.in_process_at),updated_at=NOW(),management_data=EXCLUDED.management_data
              RETURNING id`,[...args(scope),JSON.stringify(postings.map(body=>({id:randomUUID(),body})))]);
            await productCosts.applyMissingCosts(scope,{db,orderIds:rows.map(row=>row.id)});
          }
          const completed=!page.hasNext&&state.scheme==='FBO';
          const nextState={...state,pages:state.pages+1,processed:state.processed+postings.length,updatedAt:iso(clock()),
            status:completed?'COMPLETED':'RUNNING',completedAt:completed?iso(clock()):null,
            cursor:page.hasNext?page.cursor:'',seenCursors:page.hasNext?[...state.seenCursors,nextHash]:[],
            scheme:!page.hasNext&&state.scheme==='FBS'?'FBO':state.scheme};
          await db.query('UPDATE ozon_order_management_sync SET state=$3,next_run_at=$4 WHERE account_id=$1 AND store_id=$2',[...args(scope),nextState,completed?null:iso(clock())]);
          await db.query('COMMIT');state=nextState;
        }catch(e){await db.query('ROLLBACK');throw e;}
      }catch(e){
        state={...state,status:'FAILED',updatedAt:iso(clock()),lastError:safeError(e)};
        await db.query('UPDATE ozon_order_management_sync SET state=$3,next_run_at=NULL WHERE account_id=$1 AND store_id=$2',[...args(scope),state]);
      }
      return true;
    }finally{try{if(held)await db.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[lockKey]);}finally{db.release();}}
  }
  return {overview,syncStatus,requestSync,getPosting,saveCosts,processNext,productCosts:productCosts.list,saveProductCost:productCosts.save};
}
