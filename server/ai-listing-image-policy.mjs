export const AI_LISTING_IMAGE_POLICY_VERSION = 'ozon-v1';
const dimensions = {minWidth:900,minHeight:1200,maxWidth:4320,maxHeight:7680};

export function aiListingImagePolicyCapability(enabled) {
  return {version:AI_LISTING_IMAGE_POLICY_VERSION,enabled,categoryStrategy:'ALL_CONFIRMED_CATEGORIES',...dimensions,
    grid:{maxImagesPerGroup:4,tileWidth:1200,tileHeight:1600,requestsByImageCount:[1,1,1,1,2,2,2,2,3,3,3,3]},
    message:'保守尺寸预设覆盖所有已确认类目；初始选图每 SKU 1–4 张请求 1 次、5–8 张 2 次、9–12 张 3 次。后加入图片会保留原分组并增加请求，以任务总计划为准；模型费用和耗时可能增加，SKU 计费仍为一次。启用前须验证通道实际输出。'};
}

// Extend only after the authoritative category check and before paid admission.
// Late Excel rows can add slots; existing groups and their spool identities stay frozen.
// No category-name guesses or incomplete desktop taxonomy are used for the conservative preset.
export function planAiListingImages({source,config,imagePlan,images=[]}) {
  const grid=config.generationMode==='GRID';
  const plan=imagePlan?structuredClone(imagePlan):{version:AI_LISTING_IMAGE_POLICY_VERSION,
    categoryStrategy:'ALL_CONFIRMED_CATEGORIES',...dimensions,items:[],requestCount:0};
  let changed=!imagePlan;
  for(const item of source.items){
    let planned=plan.items.find(value=>value.sku===item.sku);
    const covered=new Set(grid?planned?.groups.flatMap(group=>group.indices):Array.from({length:planned?.requestCount||0},(_,i)=>i));
    const added=item.images.map((_,index)=>index).filter(index=>!covered.has(index));
    if(planned&&!added.length)continue;
    if(images.some(image=>image.sku===item.sku&&added.includes(image.index)&&(image.generatedUrl||image.attempts||image.activeAttemptId||image.generationConfig)))
      throw Object.assign(new Error('新增图位已有请求记录但缺少冻结计划，尚未发送新图片请求；请核对原分组和付费结果后恢复，不能自动重新分组或重复付费。'),{code:'AI_LISTING_IMAGE_PLAN_INCOMPLETE'});
    const descriptionCategoryId=Number(item.listingItem.description_category_id),typeId=Number(item.listingItem.type_id);
    if(!Number.isSafeInteger(descriptionCategoryId)||descriptionCategoryId<1||!Number.isSafeInteger(typeId)||typeId<1)
      throw Object.assign(new Error('商品类目尚未确认'),{code:'AI_LISTING_CATEGORY_UNRESOLVED'});
    if(planned&&(planned.descriptionCategoryId!==descriptionCategoryId||planned.typeId!==typeId))
      throw Object.assign(new Error('新增图片的类目与冻结计划不一致，尚未发送新图片请求；请恢复已确认类目或为新类目新建任务，原图和已付费结果保留。'),{code:'AI_LISTING_IMAGE_PLAN_CATEGORY_CHANGED'});
    if(!planned){planned={sku:item.sku,descriptionCategoryId,typeId,groups:[],requestCount:0};plan.items.push(planned);}
    if(grid)for(let start=0;start<added.length;start+=4){
      const indices=added.slice(start,start+4);
      const columns=Math.ceil(Math.sqrt(indices.length)),rows=Math.ceil(indices.length/columns);
      planned.groups.push({id:`grid-${planned.groups.length}`,indices,isFirstGroup:indices[0]===0,layout:{columns,rows,tw:1200,th:1600,
        width:columns*1200+(columns+1)*32,height:rows*1600+(rows+1)*32}});
    }
    planned.requestCount=grid?planned.groups.length:item.images.length;changed=true;
  }
  if(!changed)return imagePlan;
  plan.requestCount=plan.items.reduce((sum,item)=>sum+item.requestCount,0);
  return plan;
}

export function assertAiListingImageDimensions({width,height},policy) {
  if(!policy)return;
  if(width<policy.minWidth||height<policy.minHeight||width>policy.maxWidth||height>policy.maxHeight)
    throw Object.assign(new Error(`通道实际图片为 ${width}×${height}，当前发布要求至少 ${policy.minWidth}×${policy.minHeight}、最多 ${policy.maxWidth}×${policy.maxHeight}；已保留付费结果且不会自动再生图。请核对通道高分辨率能力；如需新图，请使用已验证通道新建任务（将产生新的模型请求费用）。`),
      {code:'AI_LISTING_IMAGE_DIMENSIONS_UNSUPPORTED'});
}
