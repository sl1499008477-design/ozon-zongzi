import '../server/env.mjs';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {getPostgresPool,closePostgresPool} from '../server/db/connection.mjs';

// One-off audited repair. The evidence file must come from a successful,
// read-only lookup of the frozen source pair in the current official Ozon tree.
const args=process.argv.slice(2),apply=args.includes('--apply');
const input=args.find(arg=>!arg.startsWith('--'));
if(!input)throw new Error('提供官方类目核对 JSON 路径；默认事务回滚验证，--apply 才保存');
const evidence=JSON.parse(await readFile(input,'utf8'));
if(!Array.isArray(evidence)||!evidence.length)throw new Error('类目证据为空');
const pool=await getPostgresPool(),client=await pool.connect();
const backupDir=fileURLToPath(new URL('../../sonli-audit-backups/2026-09-10-full-project-repair/',import.meta.url));
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
try{
  await client.query('BEGIN');const backups=[],changes=[];
  for(const proof of evidence){
    const verifiedAt=Date.parse(proof.verifiedAt);
    if(!proof.accountId||!proof.taskId||!Number.isSafeInteger(proof.version)||!proof.attributeCount
      ||proof.treeMatch?.categoryId!==proof.categoryId||proof.treeMatch?.typeId!==proof.typeId
      ||!Number.isSafeInteger(proof.categoryId)||!Number.isSafeInteger(proof.typeId)
      ||proof.categoryId<=0||proof.typeId<=0||!Number.isFinite(verifiedAt)
      ||verifiedAt>Date.now()||Date.now()-verifiedAt>86_400_000)throw new Error('需要当天官方类目匹配证据');
    const row=(await client.query("SELECT * FROM ai_image_listing_tasks WHERE account_id=$1 AND id=$2 AND version=$3 AND status='AWAITING_REVIEW' FOR UPDATE",[proof.accountId,proof.taskId,proof.version])).rows[0];
    if(!row)throw new Error('任务状态或版本已变化，请重新核对');
    const source=row.body.source,stored=source.sourceSnapshot?.sourceCategory;
    if(Number(stored?.descriptionCategoryId)!==proof.categoryId||Number(stored?.typeIdCandidate)!==proof.typeId
      ||source.items.length!==1||source.items[0].sku!==proof.sourceSku)throw new Error('冻结 SKU 或来源类目证据不一致');
    const body=structuredClone(row.body),item=body.source.items[0].listingItem;
    if(item.description_category_id&&Number(item.description_category_id)!==proof.categoryId||item.type_id&&Number(item.type_id)!==proof.typeId)throw new Error('已有类目不允许被覆盖');
    item.description_category_id=proof.categoryId;item.type_id=proof.typeId;
    body.source.categoryRecovery={source:'OZON_OFFICIAL_TREE_VERIFIED',verifiedAt:proof.verifiedAt,descriptionCategoryId:proof.categoryId,typeId:proof.typeId};
    body.updatedAt=Date.now();backups.push(row);
    changes.push({taskId:row.id,sourceSku:proof.sourceSku,descriptionCategoryId:proof.categoryId,typeId:proof.typeId,
      previousVersion:row.version,status:row.status,imagesUnchanged:digest(body.images)===digest(row.body.images)});
    await client.query('UPDATE ai_image_listing_tasks SET body=$4::jsonb,version=version+1 WHERE account_id=$1 AND id=$2 AND version=$3',[row.account_id,row.id,row.version,JSON.stringify(body)]);
  }
  await mkdir(backupDir,{recursive:true,mode:0o700});
  const backup=join(backupDir,`frozen-categories-${apply?'apply':'dry-run'}-${Date.now()}.json`);
  await writeFile(backup,JSON.stringify(backups,null,2),{mode:0o600});
  await client.query(apply?'COMMIT':'ROLLBACK');console.log(JSON.stringify({applied:apply,backup,changes},null,2));
}catch(error){await client.query('ROLLBACK');throw error;}
finally{client.release();await closePostgresPool();}
