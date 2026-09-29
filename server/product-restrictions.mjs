import {randomUUID} from 'node:crypto';
import {getPostgresPool} from './db/connection.mjs';
const invalid=message=>Object.assign(new Error(message),{statusCode:400,code:'PRODUCT_RESTRICTION_INVALID'});
const keywordMatch=(name,word)=>{const hay=text(name).toLocaleLowerCase(),needle=text(word).toLocaleLowerCase();if(/[\u3400-\u9fff]/u.test(needle))return hay.includes(needle);return hay.split(/[^\p{L}\p{N}]+/u).join(" ").includes(needle.split(/[^\p{L}\p{N}]+/u).join(" ")) && (" "+hay.split(/[^\p{L}\p{N}]+/u).join(" ")+" ").includes(" "+needle.split(/[^\p{L}\p{N}]+/u).join(" ")+" ");};
const positive=v=>Number.isSafeInteger(Number(v))&&Number(v)>0?Number(v):null;
const text=v=>String(v??'').trim();
export const restrictionCategories=r=>Array.isArray(r.categories)?r.categories:(r.categoryId||r.typeId?[{categoryId:r.categoryId,typeId:r.typeId,label:r.categoryLabel}]:[]);
export function normalizeRestriction(body){
 const name=text(body.name),reason=text(body.reason),sourceUrl=text(body.sourceUrl);
 if(!name||name.length>120||!reason||reason.length>1000)throw invalid('请填写规则名称与原因');
 if(sourceUrl&&!/^https:\/\//.test(sourceUrl))throw invalid('依据链接须为 HTTPS 地址');
 const categoryId=positive(body.categoryId),typeId=positive(body.typeId),attributeId=positive(body.attributeId);
 if(body.categories!==undefined&&(!Array.isArray(body.categories)||body.categories.length>200))throw invalid('最多选择 200 个类目类型');
 const categories=[];
 for(const c of restrictionCategories(body)){
  if(!c||typeof c!=='object')throw invalid('类目格式无效');
  const categoryId=positive(c.categoryId),typeId=positive(c.typeId);
  if(!categoryId&&!typeId||c.categoryId&&!categoryId||c.typeId&&!typeId)throw invalid('类目或类型 ID 无效');
  if(!categories.some(x=>x.categoryId===categoryId&&x.typeId===typeId))categories.push({categoryId,typeId,label:text(c.label).slice(0,500)});
 }
 const keywords=(Array.isArray(body.keywords)?body.keywords:[]).map(text).filter(Boolean);
 if(keywords.length>30||keywords.some(x=>x.length>100))throw invalid('关键词过多或过长');
 if(!['BLOCK','REVIEW'].includes(body.action))throw invalid('请选择拦截方式');
 if(!categories.length&&!keywords.length)throw invalid('请选择类目/类型或填写疑似关键词');
 if(body.action==='BLOCK'&&(!categories.length||keywords.length))throw invalid('确定禁售必须匹配类目或类型，关键词仅用于待核实');
 if(attributeId&&!text(body.attributeValue))throw invalid('请填写属性匹配值');
 return {name,reason,sourceUrl,origin:body.origin==='official'?'official':'custom',verifiedAt:text(body.verifiedAt).slice(0,10),enabled:body.enabled!==false,action:body.action,categories,categoryId:categories.length===1?categories[0].categoryId:null,typeId:categories.length===1?categories[0].typeId:null,categoryLabel:categories.map(c=>c.label).filter(Boolean).join("；"),keywords,storeId:text(body.storeId).slice(0,100),warehouseId:text(body.warehouseId).slice(0,100),attributeId,attributeValue:text(body.attributeValue).slice(0,200)};
}
export function evaluateRestrictions(rules,items,context={}){
 const matches=[];
 for(const item of items){
  if(!item.categoryId||!item.typeId)matches.push({sku:item.sku||'',decision:'REVIEW',name:'类目信息待核实',reason:'缺少类目或商品类型，暂不自动上架'});
  for(const r of rules.filter(r=>r.enabled)){
   if(r.storeId&&context.storeId&&r.storeId!==context.storeId||r.warehouseId&&context.warehouseId&&r.warehouseId!==context.warehouseId)continue;
   const categories=restrictionCategories(r);
   if(categories.length&&!categories.some(c=>(!c.categoryId||item.categoryId===c.categoryId)&&(!c.typeId||item.typeId===c.typeId)))continue;
   if(r.keywords?.length&&!r.keywords.some(k=>keywordMatch(item.name,k)))continue;
   let decision=r.action;
   if(r.storeId&&!context.storeId||r.warehouseId&&!context.warehouseId)decision='REVIEW';
   if(r.attributeId){
    const attr=(item.attributes||[]).find(a=>Number(a.id||a.key)===r.attributeId);
    if(!attr)decision='REVIEW';
    else {const values=[attr.value,...(attr.values||[]).map(v=>v.value)].map(text);if(!values.includes(r.attributeValue))continue;}
   }
   matches.push({sku:item.sku||'',ruleId:r.id,name:r.name,reason:r.reason,sourceUrl:r.sourceUrl,decision});
  }
 }
 return {decision:matches.some(m=>m.decision==='BLOCK')?'BLOCK':matches.length?'REVIEW':'ALLOW',matches};
}
export function restrictionItems(source){
 const snap=source.sourceSnapshot||source;
 const evidence=snap.sourceCategory||snap.listingDraft?.sourceCategory||{};
 const groups=source.items?.length?source.items:[{sku:snap.sku,listingItem:snap.listingDraft||snap},...(snap.listingDraft?.variants||[]).map(v=>({sku:v.sku,listingItem:v}))];
 return groups.map(g=>{const item=g.listingItem||g;const sc=item.sourceCategory||evidence;return {sku:text(g.sku||item.scraped_sku),name:text(item.name||item.title||source.name||snap.name),categoryId:positive(item.description_category_id||sc.descriptionCategoryId),typeId:positive(item.type_id||sc.typeId||sc.typeIdCandidate),attributes:item.attributes||snap.attributes||[]};});
}
export function createProductRestrictions(pool){
 const admin=actor=>{if(actor?.role!=='admin')throw Object.assign(new Error('仅管理员可管理禁售规则'),{statusCode:403});};
 const list=async()=> (await pool.query('SELECT id,payload,updated_at FROM platform_product_restrictions ORDER BY updated_at DESC,id')).rows.map(r=>({id:r.id,...r.payload,updatedAt:r.updated_at}));
 return {
  async overview(actor){admin(actor);return {items:await list(),events:(await pool.query('SELECT id,account_id,stage,sku,decision,matches,created_at FROM product_restriction_events ORDER BY created_at DESC LIMIT 100')).rows};},
  async save(actor,id,body){admin(actor);const payload=normalizeRestriction(body);if(id){const r=await pool.query('UPDATE platform_product_restrictions SET payload=$2,updated_by=$3,updated_at=NOW() WHERE id=$1 RETURNING id',[id,payload,actor.id]);if(!r.rowCount)throw invalid('规则不存在');}else {id=randomUUID();await pool.query('INSERT INTO platform_product_restrictions(id,payload,updated_by) VALUES($1,$2,$3)',[id,payload,actor.id]);}return {id,...payload};},
  async check({accountId,source,items,config={},stage='generate',record=true}){
   const result=evaluateRestrictions(await list(),items||restrictionItems(source),{storeId:config.targetStoreId,warehouseId:config.targetWarehouseId});
   if(record&&result.decision!=='ALLOW')await pool.query('INSERT INTO product_restriction_events(account_id,stage,sku,decision,matches) VALUES($1,$2,$3,$4,$5)',[accountId,stage,text(source?.sku||items?.[0]?.sku),result.decision,JSON.stringify(result.matches)]);
   return result;
  },
  async assertAllowed(input){const result=await this.check(input);if(result.decision==='ALLOW'||input.stage==='collect'&&result.decision==='REVIEW')return result;throw restrictionError(result);}
 };
}
export function restrictionError(result){return Object.assign(new Error((result.decision==='BLOCK'?'平台禁售：':'销售限制待核实：')+result.matches.map(m=>`${m.sku?m.sku+'：':''}${m.name}（${m.reason}）`).join('；')),{code:'PRODUCT_RESTRICTION_'+result.decision,statusCode:422,status:422,definitelyNotSubmitted:true});}
export async function checkCollectedRestrictions(accountId,item){return createProductRestrictions(await getPostgresPool()).assertAllowed({accountId,source:item,stage:'collect'});}
