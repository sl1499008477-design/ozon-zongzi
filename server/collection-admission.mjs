import { createHash } from 'node:crypto';
import { getPostgresPool } from './db/connection.mjs';
import { readStoreCredentialV3 } from './listing-pipeline.mjs';
import { createOzonCategoryService } from './ozon-category-service.mjs';
import { createProductRestrictions, evaluateRestrictions, restrictionError } from './product-restrictions.mjs';
import { normalizeOzonCollectedSourceEvidence } from './collect-enrichment-policy.mjs';
import { skuEnrichmentSummary } from './collect-enrichment-recovery.mjs';
import { enabledLeafCandidates, taxonomyFingerprint } from './ozon-taxonomy-category-policy.mjs';
import { normalizeOzonImportCategory } from './ozon-import-normalizer.mjs';

const categoryService = createOzonCategoryService();
const failure = (code, message, retryable = false) => Object.assign(new Error(message), {
  code, status: retryable ? 503 : 422, statusCode: retryable ? 503 : 422, retryable, collectionAdmissionFailure:true,
});

function facts(item) {
  const normalized = normalizeOzonCollectedSourceEvidence(item);
  const draft = normalized.listingDraft || normalized;
  const variants = draft.variants || normalized.variantData?.variants || [];
  const positive=value=>Number.isSafeInteger(Number(value))&&Number(value)>0?Number(value):null;
  const targets=[],rows=[];
  for(const value of [draft,...variants]) {
    const source=value.sourceCategory || draft.sourceCategory || normalized.sourceCategory || {};
    const resolution=value.categoryResolution || draft.categoryResolution || normalized.categoryResolution || {};
    const saved=positive(resolution.currentDescriptionCategoryId)&&positive(resolution.currentTypeId)
      ? {descriptionCategoryId:resolution.currentDescriptionCategoryId,typeId:resolution.currentTypeId}
      : resolution.status==='MATCHED' ? resolution.target || {} : {};
    const row={sku:String(value.sku||value.scraped_sku||normalized.sku||''),
      name:String(value.name||value.title||value.nameLabel||normalized.name||normalized.title||normalized.nameLabel||''),
      categoryId:positive(saved.descriptionCategoryId||value.description_category_id||value.descriptionCategoryId||source.descriptionCategoryId),
      typeId:positive(saved.typeId||value.type_id||value.typeId||source.typeId||source.typeIdCandidate),
      attributes:value.attributes||source.attributes||[]};
    targets.push(row);rows.push(row);
    const categoryId=positive(source.descriptionCategoryId),typeId=positive(source.typeId||source.typeIdCandidate);
    if(categoryId&&typeId&&(categoryId!==row.categoryId||typeId!==row.typeId))rows.push({...row,categoryId,typeId,attributes:source.attributes||row.attributes});
  }
  return {normalized,values:[draft,...variants],draft:{...draft,variants}, rows,targets,
    hash:createHash('sha256').update(JSON.stringify(rows)).digest('hex')};
}

function applyTargets(item, targets) {
  const current=facts(item),result=current.normalized;
  const draft=result.listingDraft||result;
  const variants=draft.variants||result.variantData?.variants||[];
  for(const [index,value] of [draft,...variants].entries()){
    const resolution=targets[index];
    if(!resolution?.target)continue;
    value.sourceCategory=structuredClone(current.values[index]?.sourceCategory||current.draft.sourceCategory||{});
    Object.assign(value,{descriptionCategoryId:resolution.target.descriptionCategoryId,typeId:resolution.target.typeId,
      categoryResolution:structuredClone(resolution)});
  }
  return result;
}

// This is the external collection boundary. Only a result read back from the
// account's saved desktop row may bypass it; a client's PASSED field never does.
export async function admitCollectedItem({accountId,item,requireComplete=false,trustedAdmission=null}, {
  pool, state, categories=categoryService, readCredential=readStoreCredentialV3,
  checkRestrictions, now=()=>new Date(),
}={}) {
  if (!accountId) throw failure('COLLECT_ACCOUNT_REQUIRED','请先登录');
  const cleanItem = {...item};
  delete cleanItem.collectionAdmission;
  if(cleanItem.listingDraft){cleanItem.listingDraft={...cleanItem.listingDraft};delete cleanItem.listingDraft.collectionAdmission;}
  const current = facts(cleanItem);
  const summary=skuEnrichmentSummary(current.draft);
  if(requireComplete&&summary.status!=='COMPLETE')throw failure('COLLECT_ENRICHMENT_INCOMPLETE','商品资料尚未补全，不能标记采集成功');
  if(summary.status==='COMPLETE' && trustedAdmission?.status==='PASSED' && trustedAdmission.factsHash===current.hash)
    return {...cleanItem,collectionAdmission:trustedAdmission};
  if(!state)pool ||= await getPostgresPool();
  if (!state && item.collectorItemId && item.collectorRunId) {
    const row = (await pool.query(`SELECT raw_payload FROM collector_task_items
      WHERE account_id=$1 AND id=$2 AND run_id=$3 AND status='QUALIFIED'`,
    [accountId,item.collectorItemId,item.collectorRunId])).rows[0];
    const saved=row?.raw_payload,receipt=saved?.collectionAdmission;
    if (summary.status==='COMPLETE' && receipt?.sourceFactsHash===current.hash && receipt.targets)
      return {...applyTargets(cleanItem,receipt.targets),collectionAdmission:receipt};
    if (summary.status==='COMPLETE' && row && facts(row.raw_payload).hash === current.hash) {
      return {...cleanItem,...(row.raw_payload.collectionAdmission
        ? {collectionAdmission:row.raw_payload.collectionAdmission} : {})};
    }
  }
  const selectedId=state?.currentStoreIdsByAccount?.[accountId]
    || (state?.currentAccountId===accountId ? state.currentStoreId : '');
  const selected = state ? (state.stores||[]).find(store=>store.id===selectedId
    && (store.ownerAccountId||store.accountId)===accountId && store.status!=='disabled')
    : (await pool.query(`SELECT id FROM stores
    WHERE owner_account_id=$1 AND is_current AND status<>'disabled' LIMIT 1`,[accountId])).rows[0];
  // JSON mode has never had the PostgreSQL platform-rule administration table.
  const readRestrictions = value => (checkRestrictions || (input=>state
    ? evaluateRestrictions([],input.items,{storeId:selected?.id}) : createProductRestrictions(pool).check(input)))({
    accountId,source:value,items:facts(value).rows,stage:'collect',config:{targetStoreId:selected?.id},
  });
  const assertAllowed=restrictions=>{
    if(restrictions.decision==='BLOCK')throw Object.assign(restrictionError(restrictions),{collectionAdmissionFailure:true,retryable:false});
  };
  if(summary.status!=='COMPLETE'){
    assertAllowed(await readRestrictions(cleanItem));
    return {...cleanItem,status:summary.status,enrichment:summary};
  }
  const credential = state ? selected : selected && await readCredential(selected.id,accountId,pool);
  if (!credential?.clientId || !credential?.apiKey) throw failure('COLLECTION_CATEGORY_CREDENTIAL_REQUIRED','请在当前账号选择店铺并配置有效的 Seller API 凭据，再完成采集');
  const scope = {accountId,store:{...credential,ownerAccountId:accountId},language:'DEFAULT'};
  let mapped,targets,fingerprint;
  try {
    const tree = (await categories.getCategoryTree(scope)).items;
    const enabled = new Set(enabledLeafCandidates(tree).map(row=>`${row.descriptionCategoryId}:${row.typeId}`));
    targets=[];
    for(const [index,value] of current.values.entries()){
      const row=current.targets[index];
      const official=await normalizeOzonImportCategory({...value,
        sourceCategory:value.sourceCategory||current.draft.sourceCategory,
        ...(row.typeId?{type_id:row.typeId}:{}),...(row.categoryId?{description_category_id:row.categoryId}:{})},
      {categoryMatchPolicy:'TARGET_STORE_EXACT',targetStoreId:selected.id,getCategoryTree:async()=>tree,now:()=>new Date(now()).toISOString()});
      if((row.typeId&&official.typeId!==row.typeId)||!enabled.has(`${official.descriptionCategoryId}:${official.typeId}`))
        throw failure('COLLECTION_CATEGORY_INVALID','Ozon 类目或商品类型不存在或已停用，请修正采集资料');
      targets.push(official.categoryResolution);
    }
    mapped=applyTargets(cleanItem,targets);
    fingerprint=taxonomyFingerprint(tree);
  } catch (error) {
    if (error.code === 'COLLECTION_CATEGORY_INVALID') throw error;
    if(error.categoryResolution)throw failure('COLLECTION_CATEGORY_INVALID','无法将来源类型匹配到有效 Ozon 类目，请修正采集资料');
    const retryable = error.diagnostic?.retryable === true;
    throw failure('COLLECTION_CATEGORY_UNAVAILABLE',retryable
      ? '等待 Ozon 类目服务恢复，请稍后重试采集保存'
      : '无法校验 Ozon 类目，请检查当前店铺 Seller API 凭据和权限后重试',retryable);
  }
  const restrictions=await readRestrictions(mapped);assertAllowed(restrictions);
  return {...mapped,status:'COMPLETE',enrichment:summary,collectionAdmission:{status:'PASSED',checkedAt:new Date(now()).toISOString(),
    factsHash:facts(mapped).hash,sourceFactsHash:current.hash,targets,taxonomyFingerprint:fingerprint,restrictions}};
}
