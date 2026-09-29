import {randomUUID} from 'node:crypto';
import {normalizeRealPricingRules,normalizeListingPricingRules,salePriceUsesRealPrice} from '../shared/sale-pricing.mjs';
const fail=(message,status=400)=>Object.assign(new Error(message),{status,statusCode:status,code:'SALE_PRICING_PROFILE_INVALID'});
const present=row=>({id:row.id,name:row.name,currency:row.rules.currency,salePriceFormula:row.rules.salePriceFormula,useBlackPriceWhenGreenMissing:row.rules.useBlackPriceWhenGreenMissing===true,updatedAt:new Date(row.updated_at).toISOString()});
const presentReal=row=>({id:row.id,name:row.name,...row.rules,isDefault:row.is_default,updatedAt:new Date(row.updated_at).toISOString()});
const revision="GREATEST(date_trunc('milliseconds',clock_timestamp()),updated_at+interval '1 millisecond')";
function profileName(raw){const name=typeof raw.name==='string'?raw.name.trim():'';if(!name||name.length>80)throw fail('请填写 1～80 字的配置名称');return name;}
const duplicate=error=>{if(error.code==='23505')throw fail('已有同名配置，请更换名称',409);throw error;};
export function createSalePricingProfiles(pool){
  const get=async(accountId,id)=>{
    const row=(await pool.query('SELECT * FROM sale_pricing_profiles WHERE account_id=$1 AND id=$2',[accountId,id])).rows[0];
    if(!row)throw fail('上架售价配置已删除或不存在，请重新选择',404);return present(row);
  };
  const defaultReal=async()=>{
    const row=(await pool.query('SELECT * FROM global_real_pricing_profiles WHERE is_default')).rows[0];
    if(!row)throw fail('管理员尚未设置默认竞品真实售价计算配置',409);
    return presentReal(row);
  };
  const realTransaction=async operation=>{
    const client=await pool.connect();
    try{
      await client.query('BEGIN');
      await client.query('LOCK TABLE global_real_pricing_profiles IN SHARE ROW EXCLUSIVE MODE');
      const result=await operation(client);await client.query('COMMIT');return result;
    }catch(error){await client.query('ROLLBACK');duplicate(error);}finally{client.release();}
  };
  const resolveConfig=async(accountId,raw={})=>{
    const {salePricing:untrusted,salePricingUpdatedAt,realPricingId,realPricingUpdatedAt,...config}=raw;
    if(!config.salePricingId)return config; // Historical numeric callers keep their original behavior.
    const profile=await get(accountId,config.salePricingId);
    if(salePricingUpdatedAt&&salePricingUpdatedAt!==profile.updatedAt)throw fail('上架售价配置已更新，请刷新并重新选择后再提交',409);
    let real={};
    if(salePriceUsesRealPrice(profile.salePriceFormula)){
      const selected=await defaultReal();
      if(realPricingUpdatedAt&&(realPricingId!==selected.id||realPricingUpdatedAt!==selected.updatedAt))throw fail('默认竞品真实售价计算配置已更新，请刷新后再提交',409);
      if(selected.currency!==profile.currency)throw fail('默认竞品真实售价计算配置与上架售价币种不同，请修改配置；系统不会自动换汇',422);
      real={realPricingId:selected.id,realPricingName:selected.name,realPricingUpdatedAt:selected.updatedAt,realPricingCurrency:selected.currency,realPriceFormula:selected.realPriceFormula};
    }
    return {...config,salePricing:{...profile,pricingVersion:2,...real}};
  };
  return {
    get,resolveConfig,defaultReal,
    async list(accountId){return(await pool.query('SELECT * FROM sale_pricing_profiles WHERE account_id=$1 ORDER BY updated_at DESC,id',[accountId])).rows.map(present);},
    async save(accountId,id,raw={}){
      const name=profileName(raw),rules=normalizeListingPricingRules(raw);
      try{
        const row=id?(await pool.query(`UPDATE sale_pricing_profiles SET name=$3,rules=$4,updated_at=${revision}
          WHERE account_id=$1 AND id=$2 AND ($5::timestamptz IS NULL OR updated_at=$5) RETURNING *`,[accountId,id,name,rules,raw.updatedAt||null])).rows[0]
          :(await pool.query('INSERT INTO sale_pricing_profiles(id,account_id,name,rules) VALUES($1,$2,$3,$4) RETURNING *',[randomUUID(),accountId,name,rules])).rows[0];
        if(!row)throw fail('配置已变更或删除，请刷新后重试',409);return present(row);
      }catch(error){duplicate(error);}
    },
    async remove(accountId,id){
      const result=await pool.query('DELETE FROM sale_pricing_profiles WHERE account_id=$1 AND id=$2 RETURNING id',[accountId,id]);
      if(!result.rows.length)throw fail('售价配置已删除或不存在',404);return {deleted:true};
    },
    async listReal(){
      return (await pool.query('SELECT * FROM global_real_pricing_profiles ORDER BY is_default DESC,updated_at DESC,id')).rows.map(presentReal);
    },
    async saveReal(id,raw={}){
      const name=profileName(raw),rules=normalizeRealPricingRules(raw);
      return realTransaction(async client=>{
        const row=id?(await client.query(`UPDATE global_real_pricing_profiles SET name=$2,rules=$3,updated_at=${revision}
          WHERE id=$1 AND ($4::timestamptz IS NULL OR updated_at=$4) RETURNING *`,[id,name,rules,raw.updatedAt||null])).rows[0]
          :(await client.query('INSERT INTO global_real_pricing_profiles(id,name,rules) VALUES($1,$2,$3) RETURNING *',[randomUUID(),name,rules])).rows[0];
        if(!row)throw fail('竞品真实售价计算配置已变更或删除，请刷新后重试',409);return presentReal(row);
      });
    },
    async setDefaultReal(id){
      return realTransaction(async client=>{
        const row=(await client.query('SELECT * FROM global_real_pricing_profiles WHERE id=$1',[id])).rows[0];
        if(!row)throw fail('竞品真实售价计算配置已删除或不存在',404);
        if(row.is_default)return presentReal(row);
        await client.query(`UPDATE global_real_pricing_profiles SET is_default=FALSE,updated_at=${revision} WHERE is_default`);
        return presentReal((await client.query(`UPDATE global_real_pricing_profiles SET is_default=TRUE,updated_at=${revision} WHERE id=$1 RETURNING *`,[id])).rows[0]);
      });
    },
    async removeReal(id){
      return realTransaction(async client=>{
        const row=(await client.query('SELECT is_default FROM global_real_pricing_profiles WHERE id=$1',[id])).rows[0];
        if(!row)throw fail('竞品真实售价计算配置已删除或不存在',404);
        if(row.is_default)throw fail('默认竞品真实售价计算配置不能删除，请先将另一条设为默认',409);
        await client.query('DELETE FROM global_real_pricing_profiles WHERE id=$1',[id]);return {deleted:true};
      });
    },
    async freezeCollectorConfiguration(accountId,configuration){
      if(!configuration?.aiListingConfigSnapshot?.config)return configuration;
      return {...configuration,aiListingConfigSnapshot:{...configuration.aiListingConfigSnapshot,
        config:await resolveConfig(accountId,configuration.aiListingConfigSnapshot.config)}};
    },
  };
}
