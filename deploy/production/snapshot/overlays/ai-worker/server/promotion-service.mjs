import {randomUUID} from 'node:crypto';
import {readStoreCredentialV3} from './listing-pipeline.mjs';
import {createPromotionOzon} from './promotion-ozon.mjs';
import {defaultPromotionSettings,normalizePromotionSettings,normalizePromotionRule,buildPromotionPlan,promotionItemApplied,promotionItemKey,nextPromotionRunAt} from './promotion-policy.mjs';

const error=(message,status=400,code='PROMOTION_INVALID')=>Object.assign(new Error(message),{status,code});
const params=({accountId,storeId})=>[accountId,storeId];
const iso=value=>value==null?null:new Date(Number(value)).toISOString();
const emptySnapshot=()=>({actions:[],products:[],memberships:[]});
const safeError=e=>/^PROMOTION_/.test(e?.code||'')?e.message:`Ozon 请求未完成（${e?.code||e?.status||'连接异常'}），请检查店铺权限或稍后同步`;
const ruleView=row=>{const {minPrice,currency,...body}=row.body;return {...body,id:row.id,version:row.version,nextRunAt:iso(row.next_run_at),lastRunAt:iso(row.last_run_at)};};
const signature=item=>JSON.stringify([promotionItemKey(item),item.operation,item.price||'',item.quantity??null,item.currency||'']);
function runView(row) {
  const {items=[],skipped=[],ruleId,automatic=false}=row.body;
  const count=status=>items.filter(x=>x.status===status).length;
  return {id:row.id,source:row.source,status:row.status,ruleId,automatic,createdAt:iso(row.created_at),updatedAt:iso(row.updated_at),retryAt:iso(row.body.retryAt),items,skipped,
    summary:{total:items.length,planned:count('PLANNED'),succeeded:count('SUCCEEDED'),failed:count('FAILED'),uncertain:count('UNCERTAIN')+count('SUBMITTED'),cancelled:count('CANCELLED'),skipped:skipped.length}};
}
function completedStatus(items) {
  if(items.some(x=>x.status==='PLANNED'))return 'QUEUED';
  if(items.some(x=>['UNCERTAIN','SUBMITTED'].includes(x.status)))return 'UNCERTAIN';
  if(items.every(x=>x.status==='SUCCEEDED'))return 'COMPLETED';
  if(items.some(x=>x.status==='SUCCEEDED'))return 'PARTIAL';
  return items.some(x=>x.status==='FAILED')?'FAILED':'CANCELLED';
}

export function createPromotionService({pool,ozon=createPromotionOzon(),readCredential=readStoreCredentialV3,clock=Date.now}={}) {
  async function assertStore(scope) {
    if(!scope.accountId||!scope.storeId||String(scope.storeId).length>240)throw error('请选择当前账号的店铺');
    const {rows}=await pool.query(`SELECT s.id FROM stores s JOIN accounts a ON a.id=s.owner_account_id
      WHERE s.id=$1 AND s.owner_account_id=$2 AND s.status<>'disabled' AND a.status='active'
      AND (a.expires_at IS NULL OR a.expires_at>NOW())`,[scope.storeId,scope.accountId]);
    if(!rows[0])throw error('店铺不属于当前账号或账号不可用',403,'PROMOTION_STORE_FORBIDDEN');
  }
  async function transaction(work) {
    const db=await pool.connect();try{await db.query('BEGIN');const value=await work(db);await db.query('COMMIT');return value;}
    catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}
  }
  async function lock(scope,work,{background=false}={}) {
    const db=await pool.connect(),key=`ozon-promotion:${scope.accountId}:${scope.storeId}`;let held=false;
    try{
      held=(await db.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS held',[key])).rows[0].held;
      if(!held){if(background)return false;throw error('本店正在同步或执行活动任务，请稍后重试',409,'PROMOTION_BUSY');}
      return await work();
    }finally{try{if(held)await db.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[key]);}finally{db.release();}}
  }
  async function storeRow(scope) {
    await pool.query('INSERT INTO ozon_promotion_stores(account_id,store_id,config) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[...params(scope),defaultPromotionSettings()]);
    return (await pool.query('SELECT * FROM ozon_promotion_stores WHERE account_id=$1 AND store_id=$2',params(scope))).rows[0];
  }
  async function statePatch(scope,patch) {await pool.query('UPDATE ozon_promotion_stores SET state=state || $3::jsonb WHERE account_id=$1 AND store_id=$2',[...params(scope),patch]);}
  async function credential(scope) {const c=await readCredential(scope.storeId,scope.accountId);if(!c)throw error('店铺 API 凭证不可用',409,'PROMOTION_CREDENTIALS_REQUIRED');return c;}
  async function rules(scope) {return (await pool.query('SELECT * FROM ozon_promotion_rules WHERE account_id=$1 AND store_id=$2 ORDER BY created_at,id',params(scope))).rows.map(ruleView);}
  async function getRule(scope,id) {
    const row=(await pool.query('SELECT * FROM ozon_promotion_rules WHERE account_id=$1 AND store_id=$2 AND id=$3',[...params(scope),id])).rows[0];
    if(!row)throw error('报名规则不存在',404,'PROMOTION_NOT_FOUND');return ruleView(row);
  }
  async function getRun(scope,id) {
    const row=(await pool.query('SELECT * FROM ozon_promotion_runs WHERE account_id=$1 AND store_id=$2 AND id=$3',[...params(scope),id])).rows[0];
    if(!row)throw error('执行记录不存在',404,'PROMOTION_NOT_FOUND');return row;
  }
  async function records(scope){return (await pool.query(`SELECT * FROM ozon_promotion_runs WHERE account_id=$1 AND store_id=$2
    AND (status IN ('QUEUED','RUNNING','UNCERTAIN') OR id IN (SELECT id FROM ozon_promotion_runs
      WHERE account_id=$1 AND store_id=$2 ORDER BY created_at DESC,id DESC LIMIT 100))
    ORDER BY created_at DESC,id DESC`,params(scope))).rows.map(runView);}
  async function overview(scope) {
    await assertStore(scope);const row=await storeRow(scope),snapshot=row.snapshot||emptySnapshot();
    const missingImages=snapshot.products.filter(p=>!p.imageUrl).map(p=>p.productId);
    const [ruleList,recordList,localImages]=await Promise.all([rules(scope),records(scope),missingImages.length
      ?pool.query(`SELECT p.product_id,p.image_url FROM products p JOIN stores s ON s.id=p.store_id
        WHERE s.owner_account_id=$1 AND p.store_id=$2 AND p.product_id=ANY($3::text[])`,[...params(scope),missingImages])
      :{rows:[]}]);
    const images=new Map(localImages.rows.map(p=>[p.product_id,p.image_url]));
    return {settings:normalizePromotionSettings({},row.config),state:{...row.state,nextSyncAt:row.config.enabled&&Number(row.next_sync_at)>0?iso(row.next_sync_at):null},...snapshot,
      products:snapshot.products.map(p=>({...p,imageUrl:p.imageUrl||images.get(p.productId)||null})),rules:ruleList,records:recordList};
  }
  async function refreshLocked(scope) {
    await statePatch(scope,{syncing:true,lastError:''});
    try{
      const snapshot=await ozon.snapshot(await credential(scope));const at=clock(),currencies=[...new Set(snapshot.products.map(x=>x.currency).filter(Boolean))];
      await pool.query(`UPDATE ozon_promotion_stores SET snapshot=$3,state=state || $4::jsonb,sync_requested=FALSE,next_sync_at=$5 WHERE account_id=$1 AND store_id=$2`,
        [...params(scope),snapshot,{syncing:false,lastSyncAt:iso(at),lastError:'',currency:currencies.length===1?currencies[0]:''},at+300000]);
      return snapshot;
    }catch(e){
      await pool.query(`UPDATE ozon_promotion_stores SET state=state || $3::jsonb,next_sync_at=$4,sync_requested=FALSE WHERE account_id=$1 AND store_id=$2`,[...params(scope),{syncing:false,lastError:safeError(e)},clock()+60000]);
      throw e;
    }
  }
  async function syncStore(scope){await assertStore(scope);await storeRow(scope);return lock(scope,()=>refreshLocked(scope));}
  async function requestSync(scope){await assertStore(scope);await storeRow(scope);await pool.query('UPDATE ozon_promotion_stores SET sync_requested=TRUE WHERE account_id=$1 AND store_id=$2',params(scope));return overview(scope);}
  async function saveSettings(scope,input) {
    await assertStore(scope);await storeRow(scope);
    await transaction(async db=>{
      const row=(await db.query('SELECT config FROM ozon_promotion_stores WHERE account_id=$1 AND store_id=$2 FOR UPDATE',params(scope))).rows[0];
      const config=normalizePromotionSettings(input,row.config);
      await db.query('UPDATE ozon_promotion_stores SET config=$3,sync_requested=TRUE WHERE account_id=$1 AND store_id=$2',[...params(scope),config]);
    });return overview(scope);
  }
  async function saveRule(scope,input,id='') {
    await assertStore(scope);await storeRow(scope);
    await transaction(async db=>{
      const existing=id?(await db.query('SELECT * FROM ozon_promotion_rules WHERE account_id=$1 AND store_id=$2 AND id=$3 FOR UPDATE',[...params(scope),id])).rows[0]:null;
      if(id&&!existing)throw error('报名规则不存在',404,'PROMOTION_NOT_FOUND');
      if(existing&&input.version!=null&&input.version!==existing.version)throw error('规则已更新，请刷新后编辑',409,'PROMOTION_CONFLICT');
      const body=normalizePromotionRule(input,existing?.body,clock());
      const keepSchedule=existing&&body.enabled&&existing.body.enabled&&JSON.stringify(body.schedule)===JSON.stringify(existing.body.schedule);
      const next=keepSchedule?existing.next_run_at:body.enabled?Date.parse(nextPromotionRunAt(body.schedule,clock())||''):null;
      if(body.enabled&&!keepSchedule&&!Number.isFinite(next))throw error('单次执行时间已经过去，请设置将来时间');
      if(existing)await db.query('UPDATE ozon_promotion_rules SET body=$4,version=version+1,next_run_at=$5 WHERE account_id=$1 AND store_id=$2 AND id=$3',[...params(scope),id,body,next]);
      else await db.query('INSERT INTO ozon_promotion_rules(id,account_id,store_id,body,next_run_at,created_at) VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),...params(scope),body,next,clock()]);
    });return overview(scope);
  }
  async function deleteRule(scope,id){await assertStore(scope);await pool.query('DELETE FROM ozon_promotion_rules WHERE account_id=$1 AND store_id=$2 AND id=$3',[...params(scope),id]);return overview(scope);}
  async function operationBlocks(scope,exceptId='',automatic=false) {
    const {rows}=await pool.query(`SELECT item FROM ozon_promotion_runs r CROSS JOIN LATERAL jsonb_array_elements(r.body->'items') item
      WHERE r.account_id=$1 AND r.store_id=$2 AND r.id<>$3 AND (
        (r.status IN ('QUEUED','RUNNING') AND item->>'status' IN ('PLANNED','SUBMITTED','UNCERTAIN'))
        OR item->>'status' IN ('SUBMITTED','UNCERTAIN')
        OR ($4 AND item->>'status'='FAILED' AND r.updated_at>$5))`,[...params(scope),exceptId,automatic,clock()-1800000]);
    return {blockedKeys:new Set(rows.map(x=>promotionItemKey(x.item))),blockedJoinProductIds:new Set(rows.filter(x=>x.item.operation==='JOIN'&&x.item.status!=='FAILED').map(x=>x.item.productId))};
  }
  async function plan(scope,snapshot,source,ruleId,{exceptId='',automatic=false}={}) {
    if(!['RULE','EXIT','FLOORS'].includes(source))throw error('预览类型无效');
    const row=await storeRow(scope),rule=source==='RULE'?await getRule(scope,ruleId):null;
    const result=buildPromotionPlan(snapshot,row.config,{source,rule},clock(),await operationBlocks(scope,exceptId,automatic));
    return {...result,ruleId:rule?.id,ruleVersion:rule?.version,participationScope:rule?.participationScope||'ALL',automatic};
  }
  async function insertRun(scope,source,body,status='PREVIEW',db=pool,slot=null) {
    const id=randomUUID(),at=clock();
    const row=(await db.query(`INSERT INTO ozon_promotion_runs(id,account_id,store_id,source,status,body,created_at,updated_at,schedule_rule_id,schedule_slot)
      VALUES($1,$2,$3,$4,$5,$6,$7,$7,$8,$9) ON CONFLICT DO NOTHING RETURNING *`,[id,...params(scope),source,status,body,at,slot?body.ruleId:null,slot])).rows[0];
    return row;
  }
  async function preview(scope,input) {
    await assertStore(scope);await storeRow(scope);
    if(!input||!['RULE','EXIT'].includes(input.source))throw error('请选择报名或退出预览；底价保护功能已移除');
    return lock(scope,async()=>{const snapshot=await refreshLocked(scope),body=await plan(scope,snapshot,input.source,input.ruleId);return runView(await insertRun(scope,input.source,body));});
  }
  async function execute(scope,id) {
    await assertStore(scope);
    await transaction(async db=>{
      const row=(await db.query('SELECT * FROM ozon_promotion_runs WHERE account_id=$1 AND store_id=$2 AND id=$3 FOR UPDATE',[...params(scope),id])).rows[0];
      if(!row)throw error('执行记录不存在',404,'PROMOTION_NOT_FOUND');
      if(row.status!=='PREVIEW')return;
      if(row.source==='FLOORS')throw error('底价保护功能已移除，历史预览不能再执行');
      if(!row.body.items.length)throw error('本次预览没有可执行商品');
      await db.query("UPDATE ozon_promotion_runs SET status='QUEUED',updated_at=$2 WHERE id=$1",[id,clock()]);
    });return runView(await getRun(scope,id));
  }
  async function saveRun(row,status=row.status) {
    row.status=status;row.updated_at=clock();
    await pool.query('UPDATE ozon_promotion_runs SET status=$4,body=$5,updated_at=$6 WHERE account_id=$1 AND store_id=$2 AND id=$3',[row.account_id,row.store_id,row.id,status,row.body,clock()]);
  }
  function verifyItems(row,snapshot) {
    for(const item of row.body.items)if(['SUBMITTED','UNCERTAIN'].includes(item.status)){
      if(promotionItemApplied(item,snapshot,clock())){item.status='SUCCEEDED';item.error='';}
      else {item.status='UNCERTAIN';item.error='尚未查询确认目标状态，系统不会重复提交该商品';}
    }
  }
  async function reconcile(scope,id) {
    await assertStore(scope);
    return lock(scope,async()=>{
      const row=await getRun(scope,id);if(!row.body.items.some(x=>['SUBMITTED','UNCERTAIN'].includes(x.status)))return runView(row);
      const snapshot=await refreshLocked(scope);verifyItems(row,snapshot);
      if(row.body.items.some(x=>x.status==='PLANNED')){await saveRun(row);return runView(row);}
      await saveRun(row,completedStatus(row.body.items));return runView(row);
    });
  }
  async function dispatch(c,items) {
    const first=items[0],productIds=items.map(x=>x.productId);
    if(first.operation==='JOIN')return ozon.activate(c,{actionId:first.actionId,products:items.map(x=>({productId:x.productId,price:x.price,quantity:x.quantity}))});
    if(first.operation==='EXIT')return ozon.deactivate(c,{actionId:first.actionId,productIds});
    if(first.operation==='CANCEL_FUTURE')return ozon.cancelFuture(c,{actionId:first.actionId,batchAt:first.batchAt,productIds});
    throw error('活动操作已移除，请重新生成预览');
  }
  async function processRun(scope,id) {
    const row=await getRun(scope,id);if(!['QUEUED','RUNNING'].includes(row.status))return false;
    await assertStore(scope);await saveRun(row,'RUNNING');
    try{
      const snapshot=await refreshLocked(scope);verifyItems(row,snapshot);
      let prepared;
      try{prepared=await plan(scope,snapshot,row.source,row.body.ruleId,{exceptId:row.id,automatic:row.body.automatic});}
      catch(e){if(e.code==='PROMOTION_NOT_FOUND')prepared={items:[],skipped:[]};else throw e;}
      const allowed=new Set(prepared.items.map(signature)),ruleChanged=row.source==='RULE'&&row.body.ruleVersion!==prepared.ruleVersion;
      const skipped=new Map(prepared.skipped.map(x=>[promotionItemKey(x),x.reason]));
      for(const item of row.body.items)if(item.status==='PLANNED'&&(ruleChanged||!allowed.has(signature(item)))){item.status='CANCELLED';item.error=ruleChanged?'规则已修改或删除，请重新预览':skipped.get(promotionItemKey(item))||'条件或价格已变化，请重新预览';}
      const groups=new Map();for(const item of row.body.items)if(item.status==='PLANNED'){
        const key=JSON.stringify([item.operation,item.actionId,item.batchAt,item.currency]);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(item);
      }
      const c=await credential(scope);
      for(const group of groups.values())for(let index=0;index<group.length;index+=100){
        const batch=group.slice(index,index+100);await assertStore(scope);
        const first=batch[0],freshTargets=await ozon.refreshTargets(c,{operation:first.operation,actionId:first.actionId,batchAt:first.batchAt,productIds:batch.map(x=>x.productId),includeAllMemberships:prepared.participationScope==='NONE'});
        const current=await storeRow(scope);let latestRule=null;
        if(row.source==='RULE'){try{latestRule=await getRule(scope,row.body.ruleId);}catch{}}
        const stopped=row.source==='FLOORS'||row.body.automatic&&(!current.config.enabled||(row.source==='EXIT'&&!current.config.exitEnabled)||(row.source==='RULE'&&!latestRule?.enabled));
        // A successful/unknown submission may not yet appear in Ozon's reads.
        const submittedProducts=new Set(row.body.items.filter(x=>x.operation==='JOIN'&&['SUBMITTED','UNCERTAIN','SUCCEEDED'].includes(x.status)).map(x=>x.productId));
        const currentPlan=buildPromotionPlan(freshTargets,current.config,{source:row.source,rule:latestRule},clock(),{blockedJoinProductIds:submittedProducts});
        const currentAllowed=new Set(currentPlan.items.map(signature));
        const currentSkipped=new Map(currentPlan.skipped.map(x=>[promotionItemKey(x),x.reason]));
        for(const item of batch)if(stopped||!currentAllowed.has(signature(item))||(row.source==='RULE'&&latestRule?.version!==row.body.ruleVersion)){
          item.status='CANCELLED';item.error=stopped?'自动执行已关闭':currentSkipped.get(promotionItemKey(item))||'平台状态、价格、库存或规则已变化，已停止旧计划';
        }
        const pending=batch.filter(x=>x.status==='PLANNED');if(!pending.length)continue;
        for(const item of pending){item.status='SUBMITTED';item.submittedAt=iso(clock());}
        await saveRun(row);
        try{
          const result=await dispatch(c,pending),accepted=new Set(result.acceptedIds.map(String)),rejected=new Map(result.rejected.map(x=>[String(x.productId),x.reason]));
          for(const item of pending){
            if(rejected.has(item.productId)){item.status='FAILED';item.error=String(rejected.get(item.productId)||'平台拒绝').slice(0,800);}
            else if(!accepted.has(item.productId)){item.status='UNCERTAIN';item.error='平台没有返回该商品的明确处理结果';}
          }
        }catch(e){
          const rejected=Number(e.status)>=400&&Number(e.status)<500;
          for(const item of pending){item.status=rejected?'FAILED':'UNCERTAIN';item.error=safeError(e);}
        }
        await saveRun(row);
      }
      if(row.body.items.some(x=>['SUBMITTED','UNCERTAIN'].includes(x.status))){const fresh=await refreshLocked(scope);verifyItems(row,fresh);}
    }catch(e){
      for(const item of row.body.items){
        if(item.status==='SUBMITTED'){item.status='UNCERTAIN';item.error='平台操作后读取失败，需核对结果，不会自动重发';}
        else if(item.status==='PLANNED')item.error=`尚未提交，将重试读取：${safeError(e)}`;
      }
      if(row.body.items.some(x=>x.status==='PLANNED')){
        row.body.retryAttempts=(row.body.retryAttempts||0)+1;
        row.body.retryAt=clock()+Math.min(300000,60000*2**Math.min(row.body.retryAttempts-1,3));
      }
    }
    if(!row.body.items.some(x=>x.status==='PLANNED')){delete row.body.retryAt;delete row.body.retryAttempts;}
    await saveRun(row,completedStatus(row.body.items));
    if(row.status!=='QUEUED'&&row.body.automatic&&row.source==='RULE')await pool.query(`UPDATE ozon_promotion_rules SET body=jsonb_set(body,'{enabled}','false')
      WHERE account_id=$1 AND store_id=$2 AND id=$3 AND version=$4 AND body->'schedule'->>'mode'='ONCE'`,[...params(scope),row.body.ruleId,row.body.ruleVersion]);
    await statePatch(scope,{lastRunAt:iso(clock())});return true;
  }
  async function processNext() {
    const {rows}=await pool.query(`SELECT r.account_id,r.store_id,r.id FROM ozon_promotion_runs r JOIN stores s ON s.id=r.store_id AND s.owner_account_id=r.account_id
      JOIN accounts a ON a.id=r.account_id WHERE r.status IN ('QUEUED','RUNNING') AND s.status<>'disabled' AND a.status='active'
      AND (a.expires_at IS NULL OR a.expires_at>NOW()) AND COALESCE((r.body->>'retryAt')::bigint,0)<=$1 ORDER BY r.created_at,r.id LIMIT 5`,[clock()]);
    for(const row of rows){const scope={accountId:row.account_id,storeId:row.store_id};if(await lock(scope,()=>processRun(scope,row.id),{background:true}))return true;}return false;
  }
  async function pollNext() {
    const {rows}=await pool.query(`SELECT p.account_id,p.store_id FROM ozon_promotion_stores p JOIN stores s ON s.id=p.store_id AND s.owner_account_id=p.account_id
      JOIN accounts a ON a.id=p.account_id WHERE s.status<>'disabled' AND a.status='active' AND (a.expires_at IS NULL OR a.expires_at>NOW())
      AND (p.sync_requested OR (p.config->>'enabled'='true' AND (p.next_sync_at<=$1 OR (COALESCE(p.state->>'lastError','')='' AND EXISTS(SELECT 1 FROM ozon_promotion_rules r
        WHERE r.account_id=p.account_id AND r.store_id=p.store_id AND r.body->>'enabled'='true' AND r.next_run_at<=$1)))))
      ORDER BY p.next_sync_at,p.store_id LIMIT 5`,[clock()]);
    for(const selected of rows){const scope={accountId:selected.account_id,storeId:selected.store_id};
      const worked=await lock(scope,async()=>{
        await assertStore(scope);const snapshot=await refreshLocked(scope),row=await storeRow(scope);if(!row.config.enabled)return true;
        if(row.config.exitEnabled&&row.config.exitMode!=='BELOW_FLOOR'){
          const body=await plan(scope,snapshot,'EXIT',null,{automatic:true});if(body.items.length)await insertRun(scope,'EXIT',body,'QUEUED');
        }
        const due=(await pool.query(`SELECT * FROM ozon_promotion_rules WHERE account_id=$1 AND store_id=$2 AND body->>'enabled'='true' AND next_run_at<=$3 ORDER BY next_run_at,id`,[...params(scope),clock()])).rows;
        for(const rule of due){
          const body=await plan(scope,snapshot,'RULE',rule.id,{automatic:true});
          await transaction(async db=>{
            const next=nextPromotionRunAt(rule.body.schedule,clock());
            const changed=await db.query(`UPDATE ozon_promotion_rules SET next_run_at=$5,last_run_at=$6,
              body=CASE WHEN $8 THEN jsonb_set(body,'{enabled}','false') ELSE body END
              WHERE account_id=$1 AND store_id=$2 AND id=$3 AND version=$4 AND next_run_at=$7`,
              [...params(scope),rule.id,rule.version,next?Date.parse(next):null,clock(),rule.next_run_at,!body.items.length&&rule.body.schedule.mode==='ONCE']);
            if(changed.rowCount)await insertRun(scope,'RULE',body,body.items.length?'QUEUED':'COMPLETED',db,rule.next_run_at);
          });
        }
        return true;
      },{background:true});if(worked)return true;
    }return false;
  }
  return {overview,requestSync,syncStore,saveSettings,saveRule,deleteRule,preview,execute,reconcile,pollNext,processNext};
}
