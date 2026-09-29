import {randomUUID} from 'node:crypto';
import {normalizeAiListingConfig} from './ai-listing-service.mjs';
const fail=(message,statusCode=400)=>Object.assign(new Error(message),{statusCode,code:'AI_LISTING_PRESET_INVALID'});
const present=row=>({id:row.id,name:row.name,...row.payload,updatedAt:row.updated_at});
export function createAiListingPresets(pool) {
 const checkKind=kind=>{if(!['prompts','configs'].includes(kind))throw fail('版本类型不存在',404);};
 const get=async(accountId,kind,id)=>{
  checkKind(kind);
  const row=(await pool.query('SELECT * FROM ai_listing_presets WHERE account_id=$1 AND kind=$2 AND id=$3',[accountId,kind,id])).rows[0];
  if(!row)throw fail('版本已删除或不存在，请重新选择',404);
  return present(row);
 };
 return {
  get,
  async list(accountId,kind){checkKind(kind);return(await pool.query('SELECT * FROM ai_listing_presets WHERE account_id=$1 AND kind=$2 ORDER BY updated_at DESC,id',[accountId,kind])).rows.map(present);},
  async save(accountId,kind,id,body={}){
   checkKind(kind);
   const name=typeof body.name==='string'?body.name.trim():'';
   if(!name||name.length>80)throw fail('请填写 1～80 字的版本名称');
   let payload;
   if(kind==='prompts'){
    if(typeof body.content!=='string'||!body.content.trim()||body.content.length>20000)throw fail('提示词须为 1～20000 字');
    payload={content:body.content};
   }else{
    const config=normalizeAiListingConfig(body.config);
    const allowed={ratio:['1:1','3:4','4:3','2:3','3:2','9:16','16:9'],language:['ru','en','zh'],resolution:['1K','2K','4K'],quality:['low','medium','high','auto']};
    if(Object.entries(config.image).some(([key,value])=>!allowed[key]?.includes(value))||!/^\d+(?:\.\d{1,6})?$/.test(config.priceMultiplier))throw fail('请检查图片和价格设置');
    const promptId=body.config?.promptId;
    await get(accountId,'prompts',promptId);
    delete config.prompt;
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
