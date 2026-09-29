import {calculateAutoListingPriceFromEvidence,calculateAutoListingActualPrice} from './auto-listing-pricing.mjs';
import {normalizeOzonImportCategory} from "./ozon-import-normalizer.mjs";
import {readAutoListingSourcePrice} from './auto-listing-source-snapshot.mjs';
import {createPostgresAccountSharedOzonCategoryRepository} from './account-shared-ozon-category-repository.mjs';
import {createAccountSharedOzonCategoryService} from './account-shared-ozon-category-service.mjs';

export function aiListingPriceFacts(source, group, config, store) {
  const original=source.sourceSnapshot||{};
  const selected=group.sku===(source.sku||source.items[0]?.sku);
  const variant=original.listingDraft?.variants?.find(v=>String(v.sku)===group.sku)||{};
  const record=selected?original:(group.listingItem._sourceVariant||variant);
  const fallback={...group.listingItem,...(selected?original.listingDraft:variant)};
  const evidence=readAutoListingSourcePrice({record,fallback,collectItem:selected?original:{},currencyContext:{
    targetStoreId:config.targetStoreId,sourceTargetStoreId:original.storeId,targetStoreCurrency:store.currencyCode,
  }});
  return {record,fallback,variant,evidence};
}

const minorAmount = value => {const n=BigInt(value);return `${n<0n?'-':''}${(n<0n?-n:n)/100n}.${String((n<0n?-n:n)%100n).padStart(2,'0')}`;};

// Both the pre-generation check and final submission use this exact calculation.
export function aiListingItemPrice(source, group, config, store) {
  try {
    const facts=aiListingPriceFacts(source,group,config,store);
    const {record,fallback,evidence}=facts;
    const [whole,fraction='']=config.priceMultiplier.split('.');
    const priceMultiplierMicros=String(BigInt(whole)*1_000_000n+BigInt(fraction.padEnd(6,'0')));
    const explicitBlack=[record,fallback].some(value=>['blackKopecks','black_kopecks','blackPriceKopecks','blackPrice','black_price','marketingPrice','marketing_price'].some(key=>value?.[key]!==undefined&&value[key]!==null&&value[key]!==''));
    // New captures explicitly distinguish an absent ordinary price from a card-only display price.
    // Historical captures without this field keep their existing price interpretation.
    if(!explicitBlack&&record.storefrontPrice?.ordinaryAmount===null)throw Object.assign(new Error('PRICE_INPUT_MISSING'),{code:'PRICE_INPUT_MISSING'});
    const calculate=explicitBlack?calculateAutoListingPriceFromEvidence:calculateAutoListingActualPrice;
    const input={...evidence,sourcePriceKopecks:evidence.blackKopecks,adjustmentKopecks:String(config.priceAdjustmentKopecks),priceMultiplierMicros};
    try {return {...facts,pricing:calculate(input)};}
    catch(error){
      if(error.code==='PRICE_FINAL_NOT_POSITIVE'){
        const base=calculate({...input,adjustmentKopecks:'0',priceMultiplierMicros:'1000000'});
        error.priceFailure={code:error.code,sku:group.sku,currency:evidence.currency,realPriceKopecks:base.realPriceKopecks,
          priceAdjustmentKopecks:config.priceAdjustmentKopecks,priceMultiplier:config.priceMultiplier};
        error.message=`SKU ${group.sku} 最终售价不大于 0：真实售价 ${minorAmount(base.realPriceKopecks)} ${evidence.currency}，售价加减 ${minorAmount(config.priceAdjustmentKopecks)}，倍率 ${config.priceMultiplier}。本商品已跳过上架，已有图片保留，其他商品继续处理。`;
        error.definitelyNotSubmitted=true;
      }
      throw error;
    }
  } catch(error) {
    if(error.code==='AUTO_LISTING_SOURCE_CURRENCY_MISMATCH')throw Object.assign(new Error('来源与目标店铺币种不同，缺少可靠汇率'),{code:'AI_LISTING_CURRENCY_CONVERSION_REQUIRED',definitelyNotSubmitted:true});
    const sourceMessages={PRICE_INPUT_MISSING:'价格资料不完整',PRICE_INPUT_INVALID:'价格数据或售价计算超出有效范围',PRICE_CURRENCY_UNSUPPORTED:'价格币种不受支持',
      AUTO_LISTING_SOURCE_INVALID:'价格数据无法读取',AUTO_LISTING_SOURCE_CURRENCY_UNSUPPORTED:'来源价格币种缺失或不受支持',AUTO_LISTING_TARGET_STORE_CURRENCY_UNSUPPORTED:'目标店铺价格币种不受支持'};
    if(sourceMessages[error.code])Object.assign(error,{message:`SKU ${group.sku} ${sourceMessages[error.code]}，请确认价格资料后重新创建任务。本商品已跳过上架，已有图片保留，其他商品继续处理。`,priceValidationFailure:true,definitelyNotSubmitted:true});
    throw error;
  }
}

const positive=value=>Number.isSafeInteger(Number(value))&&Number(value)>0?Number(value):null;
function frozenCategory(group, source) {
  const saved=group.categoryResolution||source.categoryResolution;
  if(saved) return saved.status==='ACTIVE'?{
    description_category_id:positive(saved.currentDescriptionCategoryId),type_id:positive(saved.currentTypeId),
  }:null;
  const item=group.listingItem||{};
  return {description_category_id:positive(item.description_category_id),type_id:positive(item.type_id)};
}

// The collect pointer is only a legacy recovery candidate. New tasks are fully
// independent of it, and explicit invalidation cannot silently reuse old IDs.
export async function resolveAiListingSourceCategories({accountId,source,pool,getCategoryTree}) {
  let officialTree;
  const readOfficialTree=()=>officialTree??=(Promise.resolve().then(getCategoryTree));
  const saved=source.items.map(group=>group.categoryResolution||source.categoryResolution);
  const identities=saved.filter(row=>positive(row?.sourceDescriptionCategoryId)&&positive(row?.sourceTypeId)&&row?.taxonomyScope)
    .map(row=>({sourceDescriptionCategoryId:row.sourceDescriptionCategoryId,sourceTypeId:row.sourceTypeId,taxonomyScope:row.taxonomyScope}));
  const repository=createPostgresAccountSharedOzonCategoryRepository({pool});
  const current=identities.length?await repository.readSharedForSourceCategories({accountId,categories:identities}):[];
  const latest=source.items.map((group,index)=>current.find(row=>
    Number(row.sourceDescriptionCategoryId)===Number(saved[index]?.sourceDescriptionCategoryId)
    &&Number(row.sourceTypeId)===Number(saved[index]?.sourceTypeId)&&row.taxonomyScope===saved[index]?.taxonomyScope));
  const frozen=source.items.map((group,index)=>frozenCategory(latest[index]?{...group,categoryResolution:latest[index]}:group,source));
  let shared;
  if(frozen.some((value,index)=>!latest[index]&&(!value?.description_category_id||!value?.type_id))&&source.collectItemId){
    const categories=createAccountSharedOzonCategoryService({repository});
    shared=(await categories.readForItems({accountId,collectItemIds:[source.collectItemId]}))[0]?.categoryResolution;
  }
  return {...source,items:await Promise.all(source.items.map(async (group,index)=>{
    let resolved=frozen[index];
    if(!latest[index]&&(!resolved?.description_category_id||!resolved?.type_id)&&shared?.status==='ACTIVE')resolved={description_category_id:positive(shared.currentDescriptionCategoryId),type_id:positive(shared.currentTypeId)};
    if(!resolved?.description_category_id||!resolved?.type_id)throw Object.assign(new Error(`SKU ${group.sku} 类目尚未确认，请根据保留来源重新确认类目`),{code:'AI_LISTING_CATEGORY_UNRESOLVED',definitelyNotSubmitted:true,statusCode:422});
    if(getCategoryTree){
      try { const official=await normalizeOzonImportCategory({...group.listingItem,...resolved},{categoryMatchPolicy:"TARGET_STORE_EXACT",getCategoryTree:readOfficialTree});
        resolved={description_category_id:official.descriptionCategoryId,type_id:official.typeId};
      } catch(caught) { if(caught.categoryResolution)throw Object.assign(new Error("官方类目已失效，请根据保留来源重新确认映射"),{code:"AI_LISTING_CATEGORY_UNRESOLVED",statusCode:422,definitelyNotSubmitted:true});throw caught; }
    }
    return {...group,...(latest[index]?{categoryResolution:latest[index]}:{}),listingItem:{...group.listingItem,...resolved}};
  }))};
}
