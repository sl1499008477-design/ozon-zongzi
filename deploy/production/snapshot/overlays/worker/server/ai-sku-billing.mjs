import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
const fail=(message,statusCode=400)=>Object.assign(new Error(message),{statusCode,code:'AI_LISTING_BILLING_INVALID'});
const effectiveCost='CASE WHEN r.billing_cost_overridden THEN r.billing_cost_cny ELSE r.estimated_cost_cny END';
export function moneyCents(value){
 if(typeof value!=='string'||!/^\d{1,7}(\.\d{1,2})?$/.test(value))throw fail('请输入最多两位小数的人民币金额');
 const [whole,decimal='']=value.split('.');return Number(whole)*100+Number(decimal.padEnd(2,'0'));
}
export function successfulSkus(images){const groups=new Map();for(const image of images||[]){const a=groups.get(image.sku)||[];a.push(image);groups.set(image.sku,a)}return [...groups].filter(([,a])=>a.length&&a.every(x=>Boolean(x.generatedUrl))).map(([sku])=>sku);}
export function createSkuBilling({pool}){
 async function transaction(accountId,fn){const c=await pool.connect();try{await c.query('BEGIN');await c.query("SELECT pg_advisory_xact_lock(hashtext($1))",['ai-wallet:'+accountId]);const r=await fn(c);await c.query('COMMIT');return r;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release()}}
 async function reconcile({accountId,taskId,reserve=false}){return transaction(accountId,async c=>{
  const row=(await c.query('SELECT t.body,t.status,t.billable,a.role FROM ai_image_listing_tasks t JOIN accounts a ON a.id=t.account_id WHERE t.id=$1 AND t.account_id=$2',[taskId,accountId])).rows[0];
  if(!row||!row.billable||row.role==='admin')return {funded:true};
  await c.query('INSERT INTO ai_user_wallets(account_id) VALUES($1) ON CONFLICT DO NOTHING',[accountId]);
  let wallet=(await c.query('SELECT * FROM ai_user_wallets WHERE account_id=$1 FOR UPDATE',[accountId])).rows[0];
  let quote=(await c.query('SELECT * FROM ai_task_billing WHERE task_id=$1 AND account_id=$2',[taskId,accountId])).rows[0];
  const images=row.body.images||[];if(!images.length)return {funded:true};
  if(!quote){if(!reserve)return {funded:true};if(wallet.sku_price_cents==null)return {funded:false,message:'等待管理员设置 SKU 生图价格'};
    quote=(await c.query('INSERT INTO ai_task_billing(task_id,account_id,unit_cents) VALUES($1,$2,$3) RETURNING *',[taskId,accountId,wallet.sku_price_cents])).rows[0];}
  const price=Number(quote.unit_cents);let held=Number(quote.reserved_cents),balance=Number(wallet.balance_cents),totalHeld=Number(wallet.reserved_cents);
  for(const sku of successfulSkus(images)){
    const charged=await c.query("INSERT INTO ai_wallet_entries(id,account_id,task_id,sku,kind,amount_cents) VALUES($1,$2,$3,$4,'SKU_CHARGE',$5) ON CONFLICT(task_id,sku,kind) DO NOTHING RETURNING id",[randomUUID(),accountId,taskId,sku,-price]);
    if(charged.rows.length){if(held<price)throw fail('费用预留状态异常',409);held-=price;totalHeld-=price;balance-=price;}
  }
  const unfinished=new Set(images.filter(i=>!i.generatedUrl).map(i=>i.sku)).size;
  const terminal=['CANCELLED','GENERATION_FAILED','UPLOAD_FAILED','COLLECTION_FAILED','COMPLETED','AWAITING_REVIEW','READY_TO_SUBMIT','SUBMISSION_FAILED','SUBMISSION_UNCERTAIN','SUBMITTING','SUBMITTED'].includes(row.status);
  let funded=true,message;
  if(terminal||!unfinished){totalHeld-=held;held=0;}
  else if(reserve){const needed=unfinished*price-held;if(needed>balance-totalHeld){funded=false;message='余额不足，请充值后继续生图';}else{held+=needed;totalHeld+=needed;}}
  await c.query('UPDATE ai_user_wallets SET balance_cents=$2,reserved_cents=$3 WHERE account_id=$1',[accountId,balance,totalHeld]);
  await c.query('UPDATE ai_task_billing SET reserved_cents=$3 WHERE task_id=$1 AND account_id=$2',[taskId,accountId,held]);
  return {funded,message};
 });}
 return {reconcile,
 async recover(){const rows=(await pool.query('SELECT task_id,account_id FROM ai_task_billing WHERE reserved_cents>0')).rows;for(const row of rows)await reconcile({accountId:row.account_id,taskId:row.task_id});},
 async snapshot(actor){const admin=actor.role==='admin';const wallets=(await pool.query(`SELECT a.id AS account_id,a.username,COALESCE(w.balance_cents,0)::text AS balance_cents,COALESCE(w.reserved_cents,0)::text AS reserved_cents,w.sku_price_cents FROM accounts a LEFT JOIN ai_user_wallets w ON w.account_id=a.id WHERE ${admin?"a.role<>'admin'":"a.id=$1"}` ,admin?[]:[actor.id])).rows;
 const entries=(await pool.query(`SELECT e.*,a.username,t.body->>'name' AS product FROM ai_wallet_entries e JOIN accounts a ON a.id=e.account_id LEFT JOIN ai_image_listing_tasks t ON t.id=e.task_id AND t.account_id=e.account_id ${admin?'':'WHERE e.account_id=$1'} ORDER BY e.created_at DESC,e.id LIMIT 100`,admin?[]:[actor.id])).rows;
 const products=(await pool.query(`SELECT e.account_id,e.task_id,t.body->>'name' AS product,COUNT(*)::int AS successful_skus,SUM(-e.amount_cents)::text AS charged_cents FROM ai_wallet_entries e JOIN ai_image_listing_tasks t ON t.id=e.task_id AND t.account_id=e.account_id WHERE e.kind='SKU_CHARGE' AND e.voided_at IS NULL ${admin?'':'AND e.account_id=$1'} GROUP BY e.account_id,e.task_id,t.body->>'name' ORDER BY MAX(e.created_at) DESC`,admin?[]:[actor.id])).rows;
 const result={wallets,entries,products};
 if(admin)result.costs=(await pool.query(`SELECT r.account_id,r.task_id,t.body->>'name' AS product,a.username,COUNT(*)::int AS requests,COUNT(*) FILTER(WHERE (${effectiveCost}) IS NULL)::int AS unpriced,SUM(${effectiveCost})::text AS estimated_cny FROM ai_user_channel_requests r JOIN ai_image_listing_tasks t ON t.id=r.task_id AND t.account_id=r.account_id JOIN accounts a ON a.id=r.account_id WHERE r.billing_cost_deleted_at IS NULL GROUP BY r.account_id,r.task_id,t.body->>'name',a.username ORDER BY MAX(r.created_at) DESC`)).rows;
 if(admin)result.costTotal=(await pool.query(`SELECT SUM(${effectiveCost})::text AS estimated_cny,COUNT(*) FILTER(WHERE (${effectiveCost}) IS NULL)::int AS unpriced FROM ai_user_channel_requests r JOIN ai_image_listing_tasks t ON t.id=r.task_id AND t.account_id=r.account_id WHERE r.billing_cost_deleted_at IS NULL`)).rows[0];
 if(admin)result.history=(await pool.query('SELECT c.id,c.account_id,c.actor_id,c.action,c.reason,c.before,c.after,c.created_at,a.username,actor.username AS actor_username FROM ai_billing_changes c LEFT JOIN accounts a ON a.id=c.account_id LEFT JOIN accounts actor ON actor.id=c.actor_id ORDER BY c.created_at DESC,c.id LIMIT 100')).rows;
 return result;},
 async records(actor,input={}){
  const type=input.type||'wallet';
  if(!['wallet','cost'].includes(type))throw fail('记录类型无效');
  if(type==='cost'&&actor.role!=='admin')throw fail('仅管理员可查看成本',403);
  const page=Number(input.page||1);if(!Number.isInteger(page)||page<1||page>1000000)throw fail('页码无效');
  const accountId=actor.role==='admin'?input.accountId:actor.id,alias=type==='wallet'?'e':'r',values=[],where=[];
  if(accountId){values.push(accountId);where.push(`${alias}.account_id=$${values.length}`);}
  if(input.taskId){values.push(input.taskId);where.push(`${alias}.task_id=$${values.length}`);}
  where.push(`${alias}.${type==='wallet'?'voided_at':'billing_cost_deleted_at'} IS ${input.deleted==='true'||input.deleted===true?'NOT ':''}NULL`);
  const from=type==='wallet'?'ai_wallet_entries e LEFT JOIN ai_image_listing_tasks t ON t.id=e.task_id AND t.account_id=e.account_id':'ai_user_channel_requests r JOIN ai_image_listing_tasks t ON t.id=r.task_id AND t.account_id=r.account_id';
  const source=`FROM ${from} JOIN accounts a ON a.id=${alias}.account_id WHERE ${where.join(' AND ')}`;
  const total=(await pool.query(`SELECT COUNT(*)::int AS total ${source}`,values)).rows[0].total;
  const fields=type==='wallet'?'e.*':`r.id,r.account_id,r.task_id,r.status,r.created_at,r.completed_at,r.estimated_cost_cny,r.billing_cost_overridden,r.billing_cost_deleted_at,r.billing_revision,(${effectiveCost})::text AS effective_cost_cny`;
  const items=(await pool.query(`SELECT ${fields},a.username,t.body->>'name' AS product ${source} ORDER BY ${alias}.created_at DESC,${alias}.id LIMIT 20 OFFSET $${values.length+1}`,[...values,(page-1)*20])).rows;
  return {items,total,page,pageSize:20};
 },
 async configure(actor,input){
  if(actor.role!=='admin')throw fail('仅管理员可管理定价和账目',403);
  if(!input||typeof input!=='object'||Array.isArray(input))throw fail('操作无效');
  const {accountId,action}=input;
  const actions=['price','clear_price','topup','balance','edit_entry','delete_entry','restore_entry','edit_cost','delete_cost','restore_cost'];
  if(!actions.includes(action))throw fail('操作无效');
  if(typeof accountId!=='string'||!accountId)throw fail('请选择用户');
  const reason=typeof input.reason==='string'?input.reason.trim():'';
  if(reason.length>500||(!['price','topup'].includes(action)&&!reason))throw fail('请填写本次修改、删除或恢复的原因（最多 500 字）');
  const intent=input.idempotencyKey??(action==='price'?randomUUID():null);
  if(typeof intent!=='string'||!intent.trim()||intent.length>100)throw fail('操作标识无效，请重新打开操作窗口');
  // Persist only the public correction fields, not arbitrary request properties.
  const payload={accountId,action,reason};
  for(const key of ['amount','expectedPriceCents','expectedBalanceCents','entryId','requestId','revision'])if(Object.hasOwn(input,key))payload[key]=input[key];
  return transaction(accountId,async c=>{
   await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',['ai-billing-intent:'+intent]);
   const previous=(await c.query('SELECT actor_id,payload FROM ai_billing_changes WHERE id=$1',[intent])).rows[0];
   if(previous){if(previous.actor_id!==actor.id||!isDeepStrictEqual(previous.payload,payload))throw fail('该操作已提交，新的修改请重新打开操作窗口',409);return {ok:true};}
   const cost=action.endsWith('_cost');
   const account=(await c.query('SELECT role FROM accounts WHERE id=$1',[accountId])).rows[0];
   if(!account||(!cost&&account.role==='admin'))throw fail('请选择普通用户');
   let before,after;
   if(cost){
    const row=(await c.query('SELECT r.id,r.status,r.estimated_cost_cny,r.billing_cost_cny,r.billing_cost_overridden,r.billing_cost_deleted_at,r.billing_revision FROM ai_user_channel_requests r JOIN ai_image_listing_tasks t ON t.id=r.task_id AND t.account_id=r.account_id WHERE r.id=$1 AND r.account_id=$2 FOR UPDATE OF r',[input.requestId,accountId])).rows[0];
    if(!row)throw fail('成本记录不存在或不属于该用户',404);
    if(row.status==='STARTED')throw fail('这笔请求仍在执行，请完成后再修改成本',409);
    if(!Number.isInteger(input.revision)||row.billing_revision!==input.revision)throw fail('成本记录已变化，请刷新后重试',409);
    if(action==='restore_cost'?!row.billing_cost_deleted_at:Boolean(row.billing_cost_deleted_at))throw fail('记录状态已变化，请刷新后重试',409);
    before=row;
    if(action==='edit_cost'){
     if(input.amount!==null&&(typeof input.amount!=='string'||!/^\d{1,7}(\.\d{1,6})?$/.test(input.amount)))throw fail('请输入最多六位小数的人民币成本，未知成本请设为待核价');
     after=(await c.query('UPDATE ai_user_channel_requests SET billing_cost_overridden=TRUE,billing_cost_cny=$3,billing_revision=billing_revision+1 WHERE id=$1 AND account_id=$2 RETURNING id,status,estimated_cost_cny,billing_cost_cny,billing_cost_overridden,billing_cost_deleted_at,billing_revision',[input.requestId,accountId,input.amount])).rows[0];
    }else{
     after=(await c.query(`UPDATE ai_user_channel_requests SET billing_cost_deleted_at=${action==='delete_cost'?'NOW()':'NULL'},billing_revision=billing_revision+1 WHERE id=$1 AND account_id=$2 RETURNING id,status,estimated_cost_cny,billing_cost_cny,billing_cost_overridden,billing_cost_deleted_at,billing_revision`,[input.requestId,accountId])).rows[0];
    }
   }else{
    await c.query('INSERT INTO ai_user_wallets(account_id) VALUES($1) ON CONFLICT DO NOTHING',[accountId]);
    const wallet=(await c.query('SELECT * FROM ai_user_wallets WHERE account_id=$1 FOR UPDATE',[accountId])).rows[0];
    const changeBalance=async delta=>{
     if(Number(wallet.balance_cents)+delta<Number(wallet.reserved_cents))throw fail('调整后的余额不足以覆盖已预留费用，请先处理正在生图的任务或补足余额',409);
     await c.query('UPDATE ai_user_wallets SET balance_cents=balance_cents+$2 WHERE account_id=$1',[accountId,delta]);
    };
    if(action==='price'||action==='clear_price'){
     if((action==='clear_price'||Object.hasOwn(input,'expectedPriceCents'))&&input.expectedPriceCents!==(wallet.sku_price_cents==null?null:String(wallet.sku_price_cents)))throw fail('单价已变化，请刷新后重试',409);
     const cents=action==='clear_price'?null:moneyCents(input.amount);
     before={sku_price_cents:wallet.sku_price_cents};after={sku_price_cents:cents==null?null:String(cents)};
     await c.query('UPDATE ai_user_wallets SET sku_price_cents=$2 WHERE account_id=$1',[accountId,cents]);
    }else if(action==='topup'){
     const cents=moneyCents(input.amount);if(cents<=0)throw fail('充值金额必须大于零');
     const id='topup:'+intent;
     const old=(await c.query('SELECT account_id,COALESCE(original_amount_cents,amount_cents) AS amount_cents FROM ai_wallet_entries WHERE id=$1',[id])).rows[0];
     if(old){if(old.account_id!==accountId||Number(old.amount_cents)!==cents)throw fail('重复操作的金额或用户不一致',409);return {ok:true};}
     await c.query("INSERT INTO ai_wallet_entries(id,account_id,kind,amount_cents,actor_id) VALUES($1,$2,'TOPUP',$3,$4)",[id,accountId,cents,actor.id]);
     await changeBalance(cents);before={balance_cents:wallet.balance_cents};after={entry_id:id,balance_cents:String(Number(wallet.balance_cents)+cents),amount_cents:String(cents)};
    }else if(action==='balance'){
     if(input.expectedBalanceCents!==String(wallet.balance_cents))throw fail('余额已变化，请刷新后重试',409);
     const cents=moneyCents(input.amount),delta=cents-Number(wallet.balance_cents),id='balance:'+intent;
     await changeBalance(delta);
     await c.query("INSERT INTO ai_wallet_entries(id,account_id,kind,amount_cents,actor_id) VALUES($1,$2,'BALANCE_ADJUSTMENT',$3,$4)",[id,accountId,delta,actor.id]);
     before={balance_cents:wallet.balance_cents,reserved_cents:wallet.reserved_cents};after={entry_id:id,balance_cents:String(cents),amount_cents:String(delta)};
    }else{
     const row=(await c.query('SELECT id,kind,amount_cents,original_amount_cents,revision,voided_at FROM ai_wallet_entries WHERE id=$1 AND account_id=$2 FOR UPDATE',[input.entryId,accountId])).rows[0];
     if(!row)throw fail('收支记录不存在或不属于该用户',404);
     if(!Number.isInteger(input.revision)||row.revision!==input.revision)throw fail('收支记录已变化，请刷新后重试',409);
     if(action==='restore_entry'?!row.voided_at:Boolean(row.voided_at))throw fail('记录状态已变化，请刷新后重试',409);
     before=row;
     let amount=Number(row.amount_cents);
     if(action==='edit_entry'){
      const signed=row.kind==='BALANCE_ADJUSTMENT'&&typeof input.amount==='string'&&input.amount.startsWith('-');
      amount=moneyCents(signed?input.amount.slice(1):input.amount)*(signed||row.kind==='SKU_CHARGE'?-1:1);
      if(row.kind==='TOPUP'&&amount<=0)throw fail('充值金额必须大于零，撤销充值请使用删除');
     }
     const delta=(action==='delete_entry'?0:amount)-(row.voided_at?0:Number(row.amount_cents));
     await changeBalance(delta);
     after=(await c.query(`UPDATE ai_wallet_entries SET original_amount_cents=COALESCE(original_amount_cents,amount_cents),amount_cents=$3,voided_at=${action==='delete_entry'?'NOW()':'NULL'},revision=revision+1 WHERE id=$1 AND account_id=$2 RETURNING id,kind,amount_cents,original_amount_cents,revision,voided_at`,[input.entryId,accountId,amount])).rows[0];
    }
   }
   await c.query('INSERT INTO ai_billing_changes(id,account_id,actor_id,action,reason,payload,before,after) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb)',[intent,accountId,actor.id,action,reason,JSON.stringify(payload),JSON.stringify(before),JSON.stringify(after)]);
   return {ok:true};
  });
 }
 };
}
