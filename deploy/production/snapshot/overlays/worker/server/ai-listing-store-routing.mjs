import { aiListingPriceFacts, resolveAiListingSourceCategories } from "./ai-listing-source-facts.mjs";
import { readStoreCredentialV3 } from './listing-pipeline.mjs';

export function quotaAllows(quota, items, reserved = 0, ancestors = new Map()) {
  const count=items.length+reserved;
  for (const bucket of [quota.daily_create,quota.total]) {
    if (!Number.isFinite(bucket?.limit)||!Number.isFinite(bucket?.usage)) throw new Error('店铺额度数据不完整');
    if (bucket.limit-bucket.usage<count) return false;
  }
  if (quota.operation_limits?.limit_type === "RATE_LIMIT_PER_MINUTE" && (!Number.isFinite(quota.operation_limits.limit) || quota.operation_limits.limit < items.length)) return false;
  for(const bucket of quota.total.quota_by_category || []) {
    const matching=items.filter(item=>{
      const id=Number((item.listingItem || item).description_category_id);
      return id===Number(bucket.category_id)||(ancestors.get(id)||[]).includes(Number(bucket.category_id));
    }).length;
    if(matching && bucket.limit-bucket.usage<matching+reserved)return false;
  }
  return true;
}

export function createAiListingStoreRouting({pool,validateTarget,readCredential=readStoreCredentialV3,fetchFn=fetch}) {
  async function read(accountId,storeId,path) {
    const credential=await readCredential(storeId,accountId);
    if(!credential)throw new Error('店铺凭据不可用');
    const response=await fetchFn('https://api-seller.ozon.ru'+path,{method:'POST',headers:{'Client-Id':credential.clientId,'Api-Key':credential.apiKey,'Content-Type':'application/json'},body:'{}',signal:AbortSignal.timeout(20000)});
    if(!response.ok)throw new Error('店铺额度或类目查询失败');
    return response.json();
  }
  return async function route({task,commit}) {
    const client=await pool.connect();
    try{
      await client.query("SELECT pg_advisory_lock(hashtext($1))",['ai-store-route:'+task.accountId]);
      const pending=(await client.query("SELECT body FROM ai_image_listing_tasks WHERE account_id=$1 AND id<>$2 AND status IN ('SUBMITTING','SUBMITTED','SUBMISSION_UNCERTAIN')",[task.accountId,task.id])).rows;
      const primary={targetStoreId:task.config.targetStoreId,targetWarehouseId:task.config.targetWarehouseId};
      const notices=[];
      let items;
      try { items=(await resolveAiListingSourceCategories({accountId:task.accountId,source:task.source,pool:client})).items; }
      catch(error) { if(error.code==='AI_LISTING_CATEGORY_UNRESOLVED')return {selected:false,message:error.message};throw error; }
      for(const target of [primary,...task.config.fallbackStores]) {
        let available=false;let storeLabel=target.targetStoreId;
        try {
          const {store}=await validateTarget({accountId:task.accountId,config:{...task.config,...target}});
          for (const group of task.source.items) aiListingPriceFacts(task.source,group,{...task.config,...target},store);
          storeLabel=store.label||store.name||target.targetStoreId;
          const quota=await read(task.accountId,target.targetStoreId,'/v4/product/info/limit');
          const ancestors=new Map();
          if(quota.total?.quota_by_category?.length){
            const tree=await read(task.accountId,target.targetStoreId,'/v1/description-category/tree');
            const walk=(nodes,path=[])=>{for(const node of nodes||[]){const id=Number(node.description_category_id);const next=id?[...path,id]:path;if(id)ancestors.set(id,next);walk(node.children,next);}};
            walk(tree.result);
            if(items.some(item=>!ancestors.has(Number((item.listingItem || item).description_category_id))))throw new Error('商品类目额度范围待确认');
          }
          const reserved=pending.filter(r=>(r.body.submissionTarget?.targetStoreId||r.body.config.targetStoreId)===target.targetStoreId).reduce((sum,r)=>sum+(r.body.source?.items?.length||0),0);
          if(!quotaAllows(quota,items,reserved,ancestors)){notices.push(`${store.label||target.targetStoreId}：额度不足`);continue;}
          available=true;
        }catch(error){notices.push(`${target.targetStoreId}：${['店铺额度数据不完整','店铺额度或类目查询失败','商品类目额度范围待确认','店铺凭据不可用'].includes(error.message)?error.message:error.code==='AUTO_LISTING_SOURCE_CURRENCY_MISMATCH'?'币种不匹配，已跳过':error.code?.includes('CURRENCY')?'来源币种待确认':'店铺或仓库暂不可用'}`);}
        if(available){await commit({...target,storeLabel});return {selected:true};}
      }
      return {selected:false,message:'等待可用店铺；'+notices.join('；')};
    }finally{
      await client.query("SELECT pg_advisory_unlock(hashtext($1))",['ai-store-route:'+task.accountId]).catch(()=>{});client.release();
    }
  };
}
