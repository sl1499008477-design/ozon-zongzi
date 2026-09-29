import {normalizeOrderPosting,orderStatusGroup} from './order-management-money.mjs';

export const DEFAULT_INSPECTION_PREFIXES=Object.freeze(['02131','02478','02090','02782','02793','02809']);
const day=86400000,interval=5*60000;
const iso=value=>value==null?null:new Date(value).toISOString();
const error=(message,status=400,code='ORDER_INSPECTION_INVALID')=>Object.assign(new Error(message),{status,code});
const numberSql="COALESCE(NULLIF(o.management_data->>'orderNumber',''),o.raw->>'order_number','')";
const scopeId=scope=>{if(!scope?.accountId)throw error('请先登录',401);return scope.accountId;};
const matchedSql=`WITH matched AS (
  SELECT o.store_id,${numberSql} AS order_number,MAX(COALESCE(o.in_process_at,o.created_at,o.updated_at)) AS order_at
  FROM orders o JOIN stores s ON s.id=o.store_id AND s.owner_account_id=$1
  WHERE LEFT(${numberSql},5)=ANY($2::text[]) GROUP BY o.store_id,${numberSql}
), visible AS (
  SELECT m.*,s.label AS store_name,r.read_at FROM matched m JOIN stores s ON s.id=m.store_id
  LEFT JOIN order_inspection_reads r ON r.account_id=$1 AND r.store_id=m.store_id AND r.order_number=m.order_number
)`;

// Shared by the existing order overview; a single query annotates the current page.
export async function annotateOrderInspection(pool,accountId,storeId,postings){
  if(!postings.length)return postings;
  const {rows}=await pool.query(`SELECT
    COALESCE((SELECT prefixes FROM order_inspection_settings WHERE account_id=$1),$3::text[]) AS prefixes,
    COALESCE(jsonb_object_agg(order_number,read_at),'{}'::jsonb) AS reads
    FROM order_inspection_reads WHERE account_id=$1 AND store_id=$2 AND order_number=ANY($4::text[])`,
  [accountId,storeId,DEFAULT_INSPECTION_PREFIXES,postings.map(p=>p.orderNumber).filter(Boolean)]);
  const {prefixes,reads}=rows[0];
  return postings.map(p=>({...p,qualityInspection:p.orderNumber&&prefixes.includes(p.orderNumber.slice(0,5))
    ?{matched:true,prefix:p.orderNumber.slice(0,5),readAt:iso(reads[p.orderNumber])}:null}));
}

export function createOrderInspectionService({pool,orderService,clock=Date.now}={}){
  async function settings(scope){
    const row=(await pool.query('SELECT prefixes,updated_at FROM order_inspection_settings WHERE account_id=$1',[scopeId(scope)])).rows[0];
    return {prefixes:row?.prefixes||[...DEFAULT_INSPECTION_PREFIXES],updatedAt:iso(row?.updated_at)};
  }
  async function saveSettings(scope,input){
    if(!Array.isArray(input?.prefixes)||input.prefixes.length>200||input.prefixes.some(p=>typeof p!=='string'||!/^\d{5}$/.test(p)))throw error('编号须为5位数字字符串，最多200项');
    await pool.query(`INSERT INTO order_inspection_settings(account_id,prefixes,updated_at) VALUES($1,$2,$3)
      ON CONFLICT(account_id) DO UPDATE SET prefixes=EXCLUDED.prefixes,updated_at=EXCLUDED.updated_at`,[scopeId(scope),[...new Set(input.prefixes)],iso(clock())]);
    return settings(scope);
  }
  async function storeRows(accountId,db=pool){
    return (await db.query(`SELECT s.id,s.label,s.status,s.saved_at,c.state FROM stores s
      LEFT JOIN order_inspection_sync c ON c.account_id=$1 AND c.store_id=s.id
      WHERE s.owner_account_id=$1 ORDER BY s.id`,[accountId])).rows;
  }
  function coverage(row){
    const state=row.state||{},boundAt=state.boundAt||iso(row.saved_at);
    const unavailable=row.status==='disabled'?'店铺已停用':!boundAt?'缺少首次绑定时间，无法确定同步范围':null;
    return {storeId:row.id,storeName:row.label||row.id,boundAt,
      since:state.since||(boundAt?iso(Date.parse(boundAt)-15*day):null),to:state.coveredTo||null,
      targetTo:state.targetTo||null,lastSyncedAt:state.lastSyncedAt||null,
      status:unavailable?'FAILED':state.status||'IDLE',lastError:unavailable||state.lastError||null};
  }
  async function postingGroups(accountId,rows){
    if(!rows.length)return new Map();
    const keys=rows.map(r=>({store_id:r.store_id,order_number:r.order_number}));
    const result=await pool.query(`SELECT o.*,${numberSql} AS inspection_order_number FROM orders o
      JOIN stores s ON s.id=o.store_id AND s.owner_account_id=$1
      JOIN jsonb_to_recordset($2::jsonb) k(store_id text,order_number text)
        ON k.store_id=o.store_id AND k.order_number=${numberSql} ORDER BY o.posting_number`,[accountId,JSON.stringify(keys)]);
    const groups=new Map();
    for(const row of result.rows){
      const base=row.management_data||normalizeOrderPosting({...row.raw,posting_number:row.posting_number,status:row.status},row.shipment_type||'FBS');
      const key=JSON.stringify([row.store_id,row.inspection_order_number]);
      const posting={postingNumber:base.postingNumber,scheme:base.scheme,status:base.status,statusGroup:base.statusGroup||orderStatusGroup(base.status),
        products:(base.products||[]).map(p=>({sku:String(p.sku||''),name:p.name||'',imageUrl:p.imageUrl||null,quantity:p.quantity??null}))};
      if(!groups.has(key))groups.set(key,[]);groups.get(key).push(posting);
    }
    return groups;
  }
  async function queryOrders(scope,input={},limitOverride){
    const accountId=scopeId(scope),config=await settings(scope);
    const page=Number(input.page||1),pageSize=limitOverride||Number(input.pageSize||20),readStatus=input.readStatus||'all';
    if(!Number.isSafeInteger(page)||page<1||!Number.isSafeInteger(pageSize)||pageSize<1||pageSize>100||!['all','read','unread'].includes(readStatus))throw error('分页或已读筛选无效');
    const q=String(input.q||'').trim(),storeId=String(input.storeId||'');if(q.length>240)throw error('搜索内容过长');
    if(storeId&&!(await pool.query('SELECT id FROM stores WHERE id=$2 AND owner_account_id=$1',[accountId,storeId])).rowCount)throw error('店铺不属于当前账号',403,'ORDER_INSPECTION_STORE_FORBIDDEN');
    const pattern='%'+q.replace(/[\\%_]/g,'\\$&')+'%';
    const filter=`($3='%%' OR v.order_number ILIKE $3 OR v.store_name ILIKE $3 OR EXISTS(
      SELECT 1 FROM orders o WHERE o.store_id=v.store_id AND ${numberSql}=v.order_number AND o.posting_number ILIKE $3))
      AND ($4='' OR v.store_id=$4) AND ($5='all' OR ($5='read' AND v.read_at IS NOT NULL) OR ($5='unread' AND v.read_at IS NULL))`;
    const args=[accountId,config.prefixes,pattern,storeId,readStatus];
    const [selected,counts]=await Promise.all([
      pool.query(`${matchedSql} SELECT v.* FROM visible v WHERE ${filter}
        ORDER BY v.order_at DESC NULLS LAST,v.store_id,v.order_number LIMIT $6 OFFSET $7`,[...args,pageSize,(page-1)*pageSize]),
      pool.query(`${matchedSql} SELECT (COUNT(*) FILTER(WHERE ${filter}))::integer AS total,
        (COUNT(*) FILTER(WHERE v.read_at IS NULL))::integer AS unread_count FROM visible v`,args),
    ]);
    const groups=await postingGroups(accountId,selected.rows);
    return {items:selected.rows.map(r=>({storeId:r.store_id,storeName:r.store_name||r.store_id,orderNumber:r.order_number,
      matchedPrefix:r.order_number.slice(0,5),orderAt:iso(r.order_at),readAt:iso(r.read_at),postings:groups.get(JSON.stringify([r.store_id,r.order_number]))||[]})),
      total:counts.rows[0].total,unreadCount:counts.rows[0].unread_count,page,pageSize};
  }
  async function overview(scope,input={}){
    const [result,stores]=await Promise.all([queryOrders(scope,input),storeRows(scopeId(scope))]);
    return {...result,stores:stores.map(coverage)};
  }
  async function summary(scope){
    const result=await queryOrders(scope,{},5);
    return {unreadCount:result.unreadCount,total:result.total,latest:result.items,checkedAt:iso(clock())};
  }
  async function markRead(scope,input){
    if(!Array.isArray(input?.items)||!input.items.length||input.items.length>100||input.items.some(r=>typeof r?.storeId!=='string'||!r.storeId||r.storeId.length>240||typeof r?.orderNumber!=='string'||!r.orderNumber||r.orderNumber.length>240))throw error('请传入实际展示的店铺及订单编号，最多100项');
    const accountId=scopeId(scope),items=[...new Map(input.items.map(r=>[JSON.stringify([r.storeId,r.orderNumber]),{store_id:r.storeId,order_number:r.orderNumber}])).values()];
    const db=await pool.connect();
    try{
      await db.query('BEGIN');
      const ids=[...new Set(items.map(r=>r.store_id))];
      if((await db.query('SELECT id FROM stores WHERE owner_account_id=$1 AND id=ANY($2::text[])',[accountId,ids])).rowCount!==ids.length)throw error('店铺不属于当前账号',403,'ORDER_INSPECTION_STORE_FORBIDDEN');
      const valid=(await db.query(`SELECT DISTINCT k.store_id,k.order_number FROM jsonb_to_recordset($2::jsonb) k(store_id text,order_number text)
        JOIN orders o ON o.store_id=k.store_id AND ${numberSql}=k.order_number
        JOIN stores s ON s.id=o.store_id AND s.owner_account_id=$1`,[accountId,JSON.stringify(items)])).rows;
      if(valid.length!==items.length)throw error('订单不存在',404,'ORDER_INSPECTION_NOT_FOUND');
      await db.query(`INSERT INTO order_inspection_reads(account_id,store_id,order_number,read_at)
        SELECT $1,k.store_id,k.order_number,$3 FROM jsonb_to_recordset($2::jsonb) k(store_id text,order_number text)
        JOIN stores s ON s.id=k.store_id AND s.owner_account_id=$1 ON CONFLICT DO NOTHING`,[accountId,JSON.stringify(items),iso(clock())]);
      await db.query('COMMIT');
    }catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}
    return summary(scope);
  }
  function initialState(store){
    const boundAt=iso(store.saved_at),since=iso(Date.parse(boundAt)-15*day);
    return {boundAt,since,initialTo:iso(clock()),targetTo:iso(clock()),coveredTo:null,activeRange:null,status:'QUEUED',lastSyncedAt:null,lastError:null};
  }
  async function requestSync(scope){
    const accountId=scopeId(scope),stores=await storeRows(accountId);
    const seeds=stores.filter(s=>s.status!=='disabled'&&s.saved_at).map(s=>({store_id:s.id,state:initialState(s)}));
    if(seeds.length)await pool.query(`INSERT INTO order_inspection_sync(account_id,store_id,state,next_run_at)
      SELECT $1,x.store_id,x.state,$3 FROM jsonb_to_recordset($2::jsonb) x(store_id text,state jsonb)
      JOIN stores s ON s.id=x.store_id AND s.owner_account_id=$1
      ON CONFLICT(account_id,store_id) DO UPDATE SET next_run_at=EXCLUDED.next_run_at,
        state=CASE WHEN order_inspection_sync.state->>'status'='COMPLETED'
          THEN jsonb_set(order_inspection_sync.state,'{status}','"QUEUED"') ELSE order_inspection_sync.state END`,[accountId,JSON.stringify(seeds),iso(clock())]);
    return {stores:(await storeRows(accountId)).map(coverage)};
  }
  async function processNext(){
    const candidate=(await pool.query(`SELECT s.id,s.owner_account_id FROM stores s JOIN accounts a ON a.id=s.owner_account_id
      LEFT JOIN order_inspection_sync c ON c.account_id=a.id AND c.store_id=s.id
      WHERE a.status='active' AND (a.expires_at IS NULL OR a.expires_at>NOW()) AND s.status<>'disabled' AND s.saved_at IS NOT NULL
        AND (c.store_id IS NULL OR c.next_run_at<=$1)
      ORDER BY c.next_run_at NULLS FIRST,s.id LIMIT 1`,[iso(clock())])).rows[0];
    if(!candidate)return false;
    const scope={accountId:candidate.owner_account_id,storeId:candidate.id},db=await pool.connect();
    const lock=`order-inspection:${scope.accountId}:${scope.storeId}`;let held=false,state;
    const save=async delay=>db.query('UPDATE order_inspection_sync SET state=$3,next_run_at=$4 WHERE account_id=$1 AND store_id=$2',[scope.accountId,scope.storeId,state,iso(clock()+delay)]);
    try{
      held=(await db.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS held',[lock])).rows[0].held;if(!held)return false;
      const store=(await db.query(`SELECT s.* FROM stores s JOIN accounts a ON a.id=s.owner_account_id WHERE s.id=$2 AND s.owner_account_id=$1
        AND s.status<>'disabled' AND a.status='active' AND (a.expires_at IS NULL OR a.expires_at>NOW())`,[scope.accountId,scope.storeId])).rows[0];
      if(!store)return false;
      await db.query('INSERT INTO order_inspection_sync(account_id,store_id,state,next_run_at) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[scope.accountId,scope.storeId,initialState(store),iso(clock())]);
      const checkpoint=(await db.query('SELECT state,next_run_at FROM order_inspection_sync WHERE account_id=$1 AND store_id=$2',[scope.accountId,scope.storeId])).rows[0];
      if(Date.parse(checkpoint.next_run_at)>clock())return false;
      state=checkpoint.state;
      const observed=(await orderService.syncStatus(scope)).sync;
      const same=state.activeRange&&observed.since===state.activeRange.since&&observed.to===state.activeRange.to;
      if(same&&observed.status==='COMPLETED'){
        state.coveredTo=state.activeRange.to;state.activeRange=null;state.lastSyncedAt=observed.completedAt||iso(clock());state.lastError=null;
        if(Date.parse(state.coveredTo)>=Date.parse(state.targetTo)){state.status='COMPLETED';await save(interval);return true;}
      }else if(same&&observed.status==='FAILED'&&state.status!=='FAILED'){
        state.status='FAILED';state.lastError=observed.lastError||'订单同步失败，请重试';await save(interval);return true;
      }else if(['QUEUED','RUNNING'].includes(observed.status)){
        state.status=observed.status;await save(2000);return true;
      }
      if(!state.activeRange){
        if(state.coveredTo&&Date.parse(state.coveredTo)>=Date.parse(state.targetTo))state.targetTo=iso(clock());
        const incremental=state.coveredTo&&Date.parse(state.coveredTo)>=Date.parse(state.initialTo);
        const since=incremental?iso(Math.max(Date.parse(state.since),Date.parse(state.coveredTo)-15*day)):(state.coveredTo||state.since);
        state.activeRange={since,to:iso(Math.min(Date.parse(since)+365*day,Date.parse(state.targetTo)))};
      }
      // Save intent first: after a crash, the same range is resumed. A busy manual
      // job is only observed, never overwritten or counted as our coverage.
      await save(2000);
      const queued=(await orderService.requestSync(scope,state.activeRange)).sync;
      state.status=queued.status==='RUNNING'?'RUNNING':'QUEUED';state.lastError=null;await save(2000);return true;
    }catch(e){
      if(state){state.status='FAILED';state.lastError='订单同步暂不可用，请重试';await save(interval);}return true;
    }finally{try{if(held)await db.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[lock]);}finally{db.release();}}
  }
  return {settings,saveSettings,overview,summary,markRead,requestSync,processNext};
}
