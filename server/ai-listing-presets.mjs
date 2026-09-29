import {randomUUID} from 'node:crypto';
import {createSalePricingProfiles} from './sale-pricing-profiles.mjs';
import {normalizeAiListingConfig} from './ai-listing-service.mjs';
const fail=(message,statusCode=400)=>Object.assign(new Error(message),{statusCode,code:'AI_LISTING_PRESET_INVALID'});
const present=row=>({id:row.id,name:row.name,...row.payload,
 ...(row.kind==='configs'&&row.payload.config?.salePricingId?{config:{...row.payload.config,
   salePricingUpdatedAt:row.pricing_updated_at?new Date(row.pricing_updated_at).toISOString():undefined,
   ...(row.real_pricing_id?{realPricingId:row.real_pricing_id,realPricingUpdatedAt:new Date(row.real_pricing_updated_at).toISOString()}:{})}}:{}),
 updatedAt:new Date(Math.max(...[row.updated_at,row.pricing_updated_at,row.real_pricing_updated_at].filter(Boolean).map(value=>new Date(value).getTime()))).toISOString()});
const presetQuery=`SELECT p.*,s.updated_at AS pricing_updated_at,r.id AS real_pricing_id,r.updated_at AS real_pricing_updated_at FROM ai_listing_presets p
 LEFT JOIN sale_pricing_profiles s ON p.kind='configs' AND s.account_id=p.account_id AND s.id=p.payload#>>'{config,salePricingId}'
 LEFT JOIN global_real_pricing_profiles r ON r.is_default AND s.rules->>'salePriceFormula' LIKE '%真实售价%'`;
export function createAiListingPresets(pool) {
 const checkKind=kind=>{if(!['prompts','configs'].includes(kind))throw fail('版本类型不存在',404);};
 const get=async(accountId,kind,id)=>{
  checkKind(kind);
  const row=(await pool.query(presetQuery+' WHERE p.account_id=$1 AND p.kind=$2 AND p.id=$3',[accountId,kind,id])).rows[0];
  if(!row)throw fail('版本已删除或不存在，请重新选择',404);
  return present(row);
 };
 return {
  get,
  async list(accountId,kind){checkKind(kind);return(await pool.query(presetQuery+' WHERE p.account_id=$1 AND p.kind=$2 ORDER BY p.updated_at DESC,p.id',[accountId,kind])).rows.map(present);},
  async save(accountId,kind,id,body={}){
   checkKind(kind);
   const name=typeof body.name==='string'?body.name.trim():'';
   if(!name||name.length>80)throw fail('请填写 1～80 字的版本名称');
   let payload;
   if(kind==='prompts'){
    if(typeof body.content!=='string'||!body.content.trim()||body.content.length>20000)throw fail('提示词须为 1～20000 字');
    payload={content:body.content};
   }else{
    const config=normalizeAiListingConfig(await createSalePricingProfiles(pool).resolveConfig(accountId,body.config));
    const allowed={ratio:['1:1','3:4','4:3','2:3','3:2','9:16','16:9'],language:['ru','en','zh'],resolution:['1K','2K','4K'],quality:['low','medium','high','auto']};
    if(Object.entries(config.image).some(([key,value])=>!allowed[key]?.includes(value))||!/^\d+(?:\.\d{1,6})?$/.test(config.priceMultiplier))throw fail('请检查图片和价格设置');
    const promptId=body.config?.promptId;
    await get(accountId,'prompts',promptId);
    delete config.prompt;delete config.salePricing;delete config.salePricingUpdatedAt;
    payload={config:{...config,promptId}};
   }
   try{
    const row=id?(await pool.query('UPDATE ai_listing_presets SET name=$4,payload=$5,updated_at=NOW() WHERE account_id=$1 AND kind=$2 AND id=$3 RETURNING *',[accountId,kind,id,name,payload])).rows[0]:(await pool.query('INSERT INTO ai_listing_presets(id,account_id,kind,name,payload) VALUES($1,$2,$3,$4,$5) RETURNING *',[randomUUID(),accountId,kind,name,payload])).rows[0];
    if(!row)throw fail('版本已删除或不存在',404);
    return present(row);
   }catch(error){if(error.code==='23505')throw fail('已有同名版本，请更换名称',409);throw error;}
  },
  async remove(accountId,kind,id){checkKind(kind);const result=await pool.query('DELETE FROM ai_listing_presets WHERE account_id=$1 AND kind=$2 AND id=$3 RETURNING id',[accountId,kind,id]);if(!result.rows.length)throw fail('版本已删除或不存在',404);return {deleted:true};}
 };
}
