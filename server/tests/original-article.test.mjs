import test from 'node:test';
import assert from 'node:assert/strict';
import {assertOzonRussianProductText} from '../ozon-product-language.mjs';
import {normalizeOzonAgentResult} from '../collector-ozon-enrichment-contract.mjs';
import {mergeSkuEnrichment} from '../collect-enrichment-recovery.mjs';
import {skuEnrichmentSummary} from '../collect-enrichment-recovery.mjs';
import {buildCollectBoxListingItems} from '../collect-box-listing-items.mjs';
import {normalizeOzonImportItems} from '../ozon-import-normalizer.mjs';
const article='花瓣吸顶灯三色52CMX';
const grouping='浴室高柜_707742WE_YOUNIC';
test('9024 identifiers allow Chinese without disabling prose checks or mutating input',()=>{
 for(const attr of [{key:'9024',values:[{value:article}]},{id:9024,value:article},{attribute_id:9024,collection:[article]}]){
  const input={attributes:[attr]};const before=structuredClone(input);
  assert.doesNotThrow(()=>assertOzonRussianProductText(input));assert.deepEqual(input,before);
  assert.throws(()=>assertOzonRussianProductText({attributes:[attr,{id:4180,values:[{value:'中文标题'}]}]}),/含中文/);
 }
});
test('10289 grouping identifiers allow Chinese in every collected value shape without weakening prose checks',()=>{
 for(const attr of [{key:'10289',values:[{value:grouping}]},{id:10289,value:grouping},{attribute_id:10289,collection:[grouping]}]){
  const input={attributes:[attr]};const before=structuredClone(input);
  assert.doesNotThrow(()=>assertOzonRussianProductText(input));assert.deepEqual(input,before);
  for(const invalid of [
   {title:'中文标题',attributes:[attr]},
   {description:'中文描述',attributes:[attr]},
   {attributes:[attr,{id:4180,values:[{value:'中文属性'}]}]},
  ]) assert.throws(()=>assertOzonRussianProductText(invalid),error=>error.code==='ZONGZI_PRODUCT_RUSSIAN_REQUIRED');
 }
});
test('nested Chinese prose reports its child SKU and does not mutate 10289 identifiers',()=>{
 const input={sku:'parent-sku',variants:[{sku:'child-sku',attributes:[
  {id:10289,values:[{value:grouping}]},
  {id:4180,values:[{value:'中文标题'}]},
 ]}]};
 const before=structuredClone(input);
 assert.throws(()=>assertOzonRussianProductText(input),error=>
  error.code==='ZONGZI_PRODUCT_RUSSIAN_REQUIRED' && /SKU child-sku：/.test(error.message));
 assert.deepEqual(input,before);
});
test('10289 survives enrichment for its own variant and category filtering retains only supported grouping identifiers',async()=>{
 const inputBySku=new Map([
  ['5519974959',{description_category_id:76222737,type_id:1,weight:500,depth:300,width:200,height:100,
   attributes:[{key:'10289',values:[{value:grouping}]},{key:'9024',values:[{value:'707742WE'}]}]}],
  ['5519974960',{description_category_id:76222737,type_id:1,weight:510,depth:310,width:210,height:110,
   attributes:[{key:'10289',values:[{value:'浴室高柜_707743WE_YOUNIC'}]},{key:'9024',values:[{value:'707743WE'}]}]}],
 ]);
 const before=structuredClone([...inputBySku]);
 let draft={sku:'5519974959',variants:[{sku:'5519974959'},{sku:'5519974960'}]};
 for(const [sku,variantData] of inputBySku) draft=mergeSkuEnrichment(draft,normalizeOzonAgentResult({sku,variantData}));
 assert.equal(skuEnrichmentSummary(draft).status,'COMPLETE');
 assert.deepEqual(draft.variants.map(item=>item.sourceCategory.attributes.find(attr=>attr.key==='10289').values[0].value),
  [grouping,'浴室高柜_707743WE_YOUNIC']);
 assert.deepEqual(draft.variants.map(item=>item.sourceCategory.attributes.find(attr=>attr.key==='9024').values[0].value),['707742WE','707743WE']);
 assert.deepEqual([...inputBySku],before);

 const base={offer_id:'707742WE',name:'Шкаф для ванной',scraped_model_name:'707742WE',description_category_id:76222737,type_id:1,
  price:'100',weight:500,depth:300,width:200,height:100,images:['https://example.test/1.jpg'],attributes:[{id:10289,values:[{value:grouping}]}]};
 const supported=await normalizeOzonImportItems([base],{strictTypeMatch:true,getCategoryAttributes:async()=>[{id:10289}],getCategoryAttributeValues:async()=>[]});
 assert.equal(supported.items[0].attributes.find(attr=>attr.id===10289).values[0].value,grouping);
 const exactGrouping=` ${grouping} `;
 const dictionaryShaped={...base,attributes:[{id:10289,values:[{dictionary_value_id:77,value:exactGrouping}]}]};
 const dictionaryOutput=await normalizeOzonImportItems([dictionaryShaped],{strictTypeMatch:true,
  getCategoryAttributes:async()=>[{id:10289,dictionary_id:0}],getCategoryAttributeValues:async()=>[]});
 assert.deepEqual(dictionaryOutput.items[0].attributes.find(attr=>attr.id===10289).values,
  [{dictionary_value_id:77,value:exactGrouping}]);
 const unsupported=await normalizeOzonImportItems([base],{strictTypeMatch:true,getCategoryAttributes:async()=>[{id:9024}],getCategoryAttributeValues:async()=>[]});
 assert.equal((unsupported.items[0].attributes||[]).some(attr=>attr.id===10289),false);
});
test('Seller enrichment to final import preserves each original article and Chinese characters',async()=>{
 const target={status:'MATCHED',method:'MANUAL',target:{storeId:'target',descriptionCategoryId:123,typeId:456}};
 let draft={sku:'1579935507',title:'Светильник',modelName:'1579935507',categoryResolution:target,variants:[
  {sku:'1579935507',name:'Светильник',offerId:'jz-old-01',article:'old',price:'100',images:['https://example.test/1.jpg']},
  {sku:'1579935529',name:'Светильник',offerId:'jz-old-02',price:'100',images:['https://example.test/2.jpg']},
 ]};
 for(const [sku,value] of [['1579935507',article],['1579935529','52WUJIX007']]){
  const result=normalizeOzonAgentResult({sku,variantData:{description_category_id:123,type_id:456,weight:500,depth:300,width:200,height:100,attributes:[{key:'9024',values:[{value}]}]}});
  draft=mergeSkuEnrichment(draft,result);
 }
 const rows=buildCollectBoxListingItems({sku:'1579935507',article:'wrong-root',listingDraft:draft},'target');
 assert.deepEqual(rows.map(x=>x.offer_id),[article,'52WUJIX007']);
 const output=await normalizeOzonImportItems(rows,{strictTypeMatch:true,getCategoryAttributes:async()=>[9024,9048].map(id=>({id})),getCategoryAttributeValues:async()=>[]});
 assert.deepEqual(output.items.map(x=>x.offer_id),[article,'52WUJIX007']);
 assert.equal(output.items[0].attributes.find(a=>a.id===9024).values[0].value,article);
});
test('article fallback preserves exact text and never borrows the anchor article for siblings',()=>{
 const rows=buildCollectBoxListingItems({sku:'1',article,listingDraft:{variants:[{sku:'1',article:' 原货号 甲 '},{sku:'2',article:'乙-02'},{sku:'3'}]}});
 assert.equal(rows[0].offer_id,' 原货号 甲 ');assert.equal(rows[1].offer_id,'乙-02');assert.notEqual(rows[2].offer_id,article);
 assert.equal(buildCollectBoxListingItems({sku:'1',article})[0].offer_id,article);
});
test('final normalization does not trim or truncate article identifiers',async()=>{
 const value=' 原货号 甲 ';
 const output=await normalizeOzonImportItems([{offer_id:value,name:'Светильник',scraped_model_name:'model',description_category_id:123,type_id:456,
  price:'100',weight:500,depth:300,width:200,height:100,images:['https://example.test/1.jpg'],attributes:[{id:9024,values:[{value}]}]}],
  {getCategoryAttributes:async()=>[{id:9024}],getCategoryAttributeValues:async()=>[]});
 assert.equal(output.items[0].offer_id,value);
 assert.equal(output.items[0].attributes.find(a=>a.id===9024).values[0].value,value);
});
