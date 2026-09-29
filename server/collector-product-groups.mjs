import { randomUUID } from 'node:crypto';
import { withoutCollectorScope } from './collector-scope-sanitizer.mjs';

function error(message, code='COLLECTOR_GROUP_INVALID', status=422) {
 return Object.assign(new Error(message), {code,status});
}
export function productGroupSkus(values) {
 if (!Array.isArray(values) || !values.length || values.length>2000) throw error('整组商品编号必须为 1–2000 个；超出时请联系管理员，不能截断采集');
 const skus=[...new Set(values.map(v=>String(v??'').trim()))];
 if(skus.some(s=>!/^\d{1,30}$/.test(s))) throw error('整组商品编号必须是 Ozon 数字 SKU');
 return skus;
}
// Callers authenticate and lock their run first; all member writes share this short account lock.
export const lockProductGroups=(client,accountId)=>client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`collector-skus:ozon:${accountId}`]);
export async function collectorGroupHistory(client,accountId,skus) {
 const {rows}=await client.query(`SELECT m.source_sku AS sku,g.id AS "groupId",i.id AS "collectorItemId",
  i.collect_item_id AS "collectItemId",i.run_id AS "runId",i.task_id AS "taskId",
  (i.status='QUALIFIED' AND i.dedup_released_at IS NULL AND m.detail IS NOT NULL AND g.expected_skus ? m.source_sku) AS complete
  FROM collector_product_members m JOIN collector_product_groups g ON g.id=m.group_id AND g.account_id=m.account_id
  LEFT JOIN collector_task_items i ON i.id=g.completed_item_id AND i.account_id=g.account_id
  WHERE m.account_id=$1 AND m.source_sku=ANY($2::text[])`,[accountId,skus]);
 return new Map(rows.map(row=>[row.sku,{...row,state:'COLLECTED',complete:row.complete===true}]));
}
async function activeOwner(client,group) {
 if(!group.owner_run_id)return false;
 return (await client.query(`SELECT 1 FROM collector_task_runs r JOIN collector_devices d ON d.id=r.claimed_by_device_id AND d.account_id=r.account_id
  WHERE r.id=$1 AND r.account_id=$2 AND r.status='RUNNING' AND r.cancel_requested_at IS NULL
   AND r.lock_expires_at>clock_timestamp() AND d.status='ACTIVE'`,[group.owner_run_id,group.account_id])).rowCount>0;
}
async function groupOwned(client,{accountId,runId,groupId,anchorSku}) {
 const {rows}=await client.query('SELECT * FROM collector_product_groups WHERE id=$1 AND account_id=$2',[groupId,accountId]);
 const group=rows[0];
 if(!group || group.merged_into || group.owner_run_id!==runId || group.owner_entry_sku!==String(anchorSku))
  throw error('这组商品已由其他任务处理，请刷新任务状态','COLLECTOR_GROUP_NOT_OWNED',409);
 return group;
}
export async function claimProductGroup(client,{accountId,runId,anchorSku,skus}) {
 let requested=productGroupSkus(skus);anchorSku=String(anchorSku||'');
 if(!requested.includes(anchorSku))throw error('整组商品缺少当前命中的 SKU');
 await lockProductGroups(client,accountId);
 const groups=(await client.query(`SELECT DISTINCT g.* FROM collector_product_groups g
  JOIN collector_product_members m ON m.group_id=g.id AND m.account_id=g.account_id
  WHERE m.account_id=$1 AND m.source_sku=ANY($2::text[]) ORDER BY g.created_at,g.id`,[accountId,requested])).rows;
 if(groups.length) {
  const known=(await client.query('SELECT source_sku FROM collector_product_members WHERE account_id=$1 AND group_id=ANY($2::text[])',[accountId,groups.map(g=>g.id)])).rows;
  requested=productGroupSkus([...requested,...known.map(m=>m.source_sku)]);
 }
 for(const group of groups) {
  if(await activeOwner(client,group)) {
   if(group.owner_run_id!==runId || group.owner_entry_sku!==anchorSku)
    return {groupId:group.id,status:'COLLECTING',skus:requested,cachedVariants:[]};
  }
 }
 // Legacy CURRENT tasks may already be reading a sibling. ALL entry claims are provisional,
 // so the first whole-group owner can supersede them without the A-owns-A/B-owns-B deadlock.
 const currentOwner=(await client.query(`SELECT c.run_id FROM collector_sku_claims c
  JOIN collector_task_runs r ON r.id=c.run_id AND r.account_id=c.account_id
  JOIN collector_devices d ON d.id=r.claimed_by_device_id AND d.account_id=r.account_id
  WHERE c.account_id=$1 AND c.source='ozon' AND c.source_sku=ANY($2::text[]) AND c.run_id<>$3
   AND r.status='RUNNING' AND r.cancel_requested_at IS NULL AND r.lock_expires_at>clock_timestamp() AND d.status='ACTIVE'
   AND COALESCE(r.configuration_snapshot#>>'{configuration,captureScope}','CURRENT')<>'ALL' LIMIT 1`,[accountId,requested,runId])).rows[0];
 if(currentOwner)return {groupId:groups[0]?.id||'',status:'COLLECTING',skus:requested,cachedVariants:[]};
 let group=groups[0];
 if(!group)group=(await client.query(`INSERT INTO collector_product_groups(id,account_id) VALUES($1,$2) RETURNING *`,['colgroup_'+randomUUID(),accountId])).rows[0];
 const otherIds=groups.slice(1).map(g=>g.id);
 if(otherIds.length) {
  await client.query('UPDATE collector_product_members SET group_id=$3 WHERE account_id=$1 AND group_id=ANY($2::text[])',[accountId,otherIds,group.id]);
  await client.query("UPDATE collector_product_groups SET merged_into=$3,owner_run_id=NULL,owner_entry_sku='',updated_at=NOW() WHERE account_id=$1 AND id=ANY($2::text[])",[accountId,otherIds,group.id]);
 }
 const previousSkus=new Set(group.expected_skus||[]);
 const complete=group.completed_item_id && (await client.query("SELECT 1 FROM collector_task_items WHERE id=$1 AND account_id=$2 AND status='QUALIFIED' AND dedup_released_at IS NULL",[group.completed_item_id,accountId])).rowCount>0;
 await client.query(`INSERT INTO collector_product_members(account_id,source_sku,group_id)
  SELECT $1,sku,$3 FROM unnest($2::text[])sku ON CONFLICT(account_id,source_sku) DO NOTHING`,[accountId,requested,group.id]);
 const variants=(await client.query(`SELECT detail FROM collector_product_members WHERE account_id=$1 AND group_id=$2 AND source_sku=ANY($3::text[]) AND detail IS NOT NULL ORDER BY source_sku`,[accountId,group.id,requested])).rows.map(r=>r.detail);
 if(complete && !otherIds.length && requested.every(s=>previousSkus.has(s)))return {groupId:group.id,status:'COLLECTED',skus:requested,cachedVariants:[]};
 await client.query(`UPDATE collector_product_groups SET owner_run_id=$3,owner_entry_sku=$4,expected_skus=$5::jsonb,completed_item_id=NULL,updated_at=NOW() WHERE id=$1 AND account_id=$2`,[group.id,accountId,runId,anchorSku,JSON.stringify(requested)]);
 await client.query(`INSERT INTO collector_sku_claims(account_id,source,source_sku,run_id)
  SELECT $1,'ozon',sku,$3 FROM unnest($2::text[])sku ON CONFLICT(account_id,source,source_sku) DO UPDATE SET run_id=EXCLUDED.run_id`,[accountId,requested,runId]);
 return {groupId:group.id,status:'CLAIMED',skus:requested,cachedVariants:variants};
}
export async function saveProductGroupVariant(client,input) {
 await lockProductGroups(client,input.accountId);
 const group=await groupOwned(client,input);
 const variant=withoutCollectorScope(input.variant||{}),sku=String(variant.sku||variant.id||'');
 if(!group.expected_skus.includes(sku))throw error('返回的 SKU 不属于本次领取的商品组');
 if(!Array.isArray(variant.images)||!variant.images.length)throw error(`SKU ${sku} 未返回商品图片，不能标记为采集完成`,'COLLECTOR_GROUP_VARIANT_INCOMPLETE');
 await client.query(`UPDATE collector_product_members SET detail=$4::jsonb,captured_at=NOW()
  WHERE account_id=$1 AND group_id=$2 AND source_sku=$3`,[input.accountId,group.id,sku,JSON.stringify({...variant,sku})]);
 return {groupId:group.id,sku,saved:true};
}
export async function releaseProductGroup(client,input) {
 await lockProductGroups(client,input.accountId);const group=await groupOwned(client,input);
 await client.query("UPDATE collector_product_groups SET owner_run_id=NULL,owner_entry_sku='',updated_at=NOW() WHERE id=$1 AND account_id=$2",[group.id,input.accountId]);
 await client.query(`DELETE FROM collector_sku_claims c USING collector_product_members m
  WHERE c.account_id=$1 AND c.run_id=$2 AND c.source='ozon' AND m.account_id=c.account_id AND m.source_sku=c.source_sku AND m.group_id=$3`,[input.accountId,input.runId,group.id]);
 return {released:true};
}
export async function assertProductGroupComplete(client,input,payload) {
 await lockProductGroups(client,input.accountId);const group=await groupOwned(client,input);
 const actual=productGroupSkus((payload.variantData?.variants||[]).map(v=>v.sku||v.id));
 const cached=(await client.query('SELECT source_sku FROM collector_product_members WHERE account_id=$1 AND group_id=$2 AND detail IS NOT NULL',[input.accountId,group.id])).rows.map(r=>r.source_sku);
 const expected=group.expected_skus;
 if(expected.length!==actual.length || expected.some(s=>!actual.includes(s)||!cached.includes(s)))
  throw error(`整组资料尚未完整：需要 ${expected.length} 个 SKU，缺少 ${expected.filter(s=>!cached.includes(s)||!actual.includes(s)).join('、')||'与领取结果一致的变体'}`,'COLLECTOR_GROUP_INCOMPLETE',409);
 return group;
}
export async function completeProductGroup(client,{accountId,runId,groupId,itemId}) {
 await client.query("UPDATE collector_product_groups SET completed_item_id=$3,owner_run_id=NULL,owner_entry_sku='',updated_at=NOW() WHERE id=$1 AND account_id=$2",[groupId,accountId,itemId]);
 await client.query(`DELETE FROM collector_sku_claims c USING collector_product_members m
  WHERE c.account_id=$1 AND c.run_id=$2 AND c.source='ozon' AND m.account_id=c.account_id AND m.source_sku=c.source_sku AND m.group_id=$3`,[accountId,runId,groupId]);
}
