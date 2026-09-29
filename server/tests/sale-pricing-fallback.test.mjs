import test from 'node:test';
import assert from 'node:assert/strict';
import {calculateSalePrice,normalizeListingPricingRules,calculateRealPrice} from '../../shared/sale-pricing.mjs';
import {aiListingItemPrice} from '../ai-listing-source-facts.mjs';
import {createSalePricingProfiles} from '../sale-pricing-profiles.mjs';
import * as sourceFacts from '../ai-listing-source-facts.mjs';

const rules={currency:'CNY',pricingVersion:2,realPriceFormula:'(黑标价 - 绿标价) * 2.25 + 黑标价',salePriceFormula:'(真实售价 + 0) * 2'};
const input={currency:'CNY',blackKopecks:'10000',greenKopecks:null};
test('new listing configurations persist an explicit off-by-default boolean policy',()=>{
 assert.equal(normalizeListingPricingRules(rules).useBlackPriceWhenGreenMissing,false);
 assert.equal(normalizeListingPricingRules({...rules,useBlackPriceWhenGreenMissing:true}).useBlackPriceWhenGreenMissing,true);
 assert.throws(()=>normalizeListingPricingRules({...rules,useBlackPriceWhenGreenMissing:'false'}),{code:'SALE_PRICING_FALLBACK_INVALID'});
});
test('fallback substitutes only the real-price result and preserves outer arithmetic and exact rounding',()=>{
 const value=calculateSalePrice({...rules,useBlackPriceWhenGreenMissing:true},input);
 assert.equal(value.realPriceKopecks,'10000');assert.equal(value.finalPriceKopecks,'20000');
 assert.equal(value.usedBlackPriceFallback,true);assert.equal(value.priceBasis,'BLACK_PRICE_FALLBACK');
 assert.equal(calculateSalePrice({...rules,useBlackPriceWhenGreenMissing:true,salePriceFormula:'(真实售价 + 0.15) * 1.2'},input).finalPriceKopecks,'12018');
});
test('missing green with the policy off skips only this SKU rather than computing zero',()=>{
 assert.throws(()=>calculateSalePrice({...rules,useBlackPriceWhenGreenMissing:false},input),{
  code:'SALE_PRICING_SKU_SKIPPED',skipReason:'GREEN_PRICE_MISSING',
 });
 assert.throws(()=>calculateSalePrice({...rules,useBlackPriceWhenGreenMissing:true},{...input,blackKopecks:null}),{
  code:'SALE_PRICING_SKU_SKIPPED',skipReason:'BLACK_PRICE_MISSING',
 });
 assert.throws(()=>calculateSalePrice({...rules,useBlackPriceWhenGreenMissing:true},{...input,blackKopecks:'0'}),{code:'PRICE_INPUT_INVALID'});
});
test('new missing-green policy also gates independent formulas while actual prices and old snapshots remain compatible',()=>{
 for(const useBlackPriceWhenGreenMissing of [false,true]){
  const configured={...rules,useBlackPriceWhenGreenMissing};
  assert.equal(calculateSalePrice(configured,{...input,greenKopecks:'9000'}).finalPriceKopecks,'24500');
  for(const salePriceFormula of ['黑标价 * 2','IF(黑标价 > 0, 黑标价 * 2, 真实售价)']){
   if(useBlackPriceWhenGreenMissing)assert.equal(calculateSalePrice({...configured,salePriceFormula},input).finalPriceKopecks,'20000');
   else assert.throws(()=>calculateSalePrice({...configured,salePriceFormula},input),{code:'SALE_PRICING_SKU_SKIPPED',skipReason:'GREEN_PRICE_MISSING'});
  }
  assert.equal(calculateSalePrice(configured,{currency:'CNY',sourcePriceKopecks:'10000'}).finalPriceKopecks,'20000');
 }
 assert.throws(()=>calculateSalePrice(rules,input),{code:'SALE_PRICING_INPUT_MISSING'});
 assert.equal(calculateSalePrice({...rules,realPriceFormula:'黑标价 / 2'},input).finalPriceKopecks,'10000');
 assert.throws(()=>calculateRealPrice({...rules,useBlackPriceWhenGreenMissing:true},input),{code:'SALE_PRICING_INPUT_MISSING'});
 assert.throws(()=>calculateSalePrice({...rules,useBlackPriceWhenGreenMissing:true,realPricingCurrency:'RUB'},input),{code:'SALE_PRICING_CURRENCY_MISMATCH'});
});
test('AI pricing uses each variant own black price and exposes scoped skip diagnostics',()=>{
 const source={sku:'main',sourceSnapshot:{currency:'CNY',blackKopecks:'10000',greenKopecks:'9000',listingDraft:{variants:[{sku:'variant',currency:'CNY',blackKopecks:'20000',greenKopecks:null}]}},items:[]};
 const main={sku:'main',listingItem:{}},variant={sku:'variant',listingItem:{}};source.items=[main,variant];
 const config={targetStoreId:'store',priceMultiplier:'1',priceAdjustmentKopecks:0,salePricing:{...rules,useBlackPriceWhenGreenMissing:true}};
 assert.equal(aiListingItemPrice(source,main,config,{currencyCode:'CNY'}).pricing.finalPriceKopecks,'24500');
 assert.equal(aiListingItemPrice(source,variant,config,{currencyCode:'CNY'}).pricing.finalPriceKopecks,'40000');
 assert.throws(()=>aiListingItemPrice(source,variant,{...config,salePricing:{...rules,useBlackPriceWhenGreenMissing:false}},{currencyCode:'CNY'}),error=>{
  assert.equal(error.code,'SALE_PRICING_SKU_SKIPPED');assert.equal(error.sku,'variant');
  assert.equal(error.details.sku,'variant');assert.equal(error.skipReason,'GREEN_PRICE_MISSING');
  assert.equal(error.priceValidationFailure,true);assert.equal(error.definitelyNotSubmitted,true);return true;
 });
});
test('saved profile presentation and frozen config retain the authoritative fallback setting',async()=>{
 const profileRow={id:'saved',account_id:'account',name:'缺绿用黑',rules:{...rules,useBlackPriceWhenGreenMissing:true},updated_at:'2026-09-25T00:00:00.000Z'};
 const profiles=createSalePricingProfiles({query:async sql=>({rows:sql.includes('global_real_pricing_profiles')?[{id:'real',name:'real',rules:{currency:'CNY',realPriceFormula:rules.realPriceFormula},is_default:true,updated_at:profileRow.updated_at}]:[profileRow]})});
 assert.equal((await profiles.get('account','saved')).useBlackPriceWhenGreenMissing,true);
 assert.equal((await profiles.list('account'))[0].useBlackPriceWhenGreenMissing,true);
 const frozen=await profiles.resolveConfig('account',{salePricingId:'saved',salePricing:{useBlackPriceWhenGreenMissing:false}});
 assert.equal(frozen.salePricing.useBlackPriceWhenGreenMissing,true);
 const collector=await profiles.freezeCollectorConfiguration('account',{aiListingConfigSnapshot:{config:{salePricingId:'saved'}}});
 assert.equal(collector.aiListingConfigSnapshot.config.salePricing.useBlackPriceWhenGreenMissing,true);
 delete profileRow.rules.useBlackPriceWhenGreenMissing;
 assert.equal((await profiles.get('account','saved')).useBlackPriceWhenGreenMissing,false);
 assert.equal(frozen.salePricing.useBlackPriceWhenGreenMissing,true);
});
test('AI fallback cannot treat an empty price evidence value as a known actual price',()=>{
 const group={sku:'missing',listingItem:{}};
 const source={sku:'missing',sourceSnapshot:{currency:'CNY'},items:[group]};
 const config={targetStoreId:'store',priceMultiplier:'1',priceAdjustmentKopecks:0,salePricing:{...rules,useBlackPriceWhenGreenMissing:true}};
 assert.throws(()=>aiListingItemPrice(source,group,config,{currencyCode:'CNY'}),{code:'SALE_PRICING_SKU_SKIPPED',skipReason:'BLACK_PRICE_MISSING',sku:'missing'});
});

test('AI admission treats absent historical policy as off without changing legacy pure calculation',()=>{
 assert.equal(typeof sourceFacts.evaluateAiListingSkuPricing,'function');
 const group={sku:'legacy',listingItem:{}},source={sku:'legacy',sourceSnapshot:{currency:'CNY',blackKopecks:'10000'},items:[group]};
 const config={targetStoreId:'store',priceMultiplier:'1',priceAdjustmentKopecks:0,salePricing:{...rules,salePriceFormula:'黑标价 * 2'}};
 const before=structuredClone({source,config});
 assert.equal(aiListingItemPrice(source,group,config,{currencyCode:'CNY'}).pricing.finalPriceKopecks,'20000');
 const rows=sourceFacts.evaluateAiListingSkuPricing({source,config,store:{currencyCode:'CNY'}});
 assert.equal(rows[0].status,'SKIPPED');assert.equal(rows[0].code,'SALE_PRICING_SKU_SKIPPED');assert.match(rows[0].reason,/缺少绿标价/);
 assert.deepEqual({source,config},before);
});

test('AI admission isolates nonpositive final prices and retains protected SKU pricing',()=>{
 assert.equal(typeof sourceFacts.evaluateAiListingSkuPricing,'function');
 const groups=[{sku:'negative',listingItem:{}},{sku:'good',listingItem:{_sourceVariant:{currency:'CNY',blackKopecks:'2000',greenKopecks:'1800'}}},{sku:'protected',listingItem:{}}];
 const saved={sku:'protected',status:'READY',priceBasis:'BLACK_PRICE_FALLBACK',usedBlackPriceFallback:true};
 const source={sku:'negative',sourceSnapshot:{currency:'CNY',blackKopecks:'500',greenKopecks:'450'},items:groups,skuPricing:[saved]};
 const config={targetStoreId:'store',priceMultiplier:'1',priceAdjustmentKopecks:0,salePricing:{...rules,realPriceFormula:'黑标价',salePriceFormula:'真实售价 - 10',useBlackPriceWhenGreenMissing:false}};
 const rows=sourceFacts.evaluateAiListingSkuPricing({source,config,store:{currencyCode:'CNY'},protectedSkus:['protected']});
 assert.equal(rows[0].status,'SKIPPED');assert.equal(rows[0].code,'PRICE_FINAL_NOT_POSITIVE');assert.match(rows[0].reason,/negative/);
 assert.equal(rows[1].status,'READY');assert.equal(rows[1].usedBlackPriceFallback,false);
 assert.deepEqual(rows[2],saved);
 const historic=sourceFacts.evaluateAiListingSkuPricing({source:{...source,skuPricing:[]},config,store:{currencyCode:'CNY'},protectedSkus:['protected']});
 assert.deepEqual(historic[2],{sku:'protected',status:'READY'});
});

test('AI admission preserves explicit fallback metadata and real actual-price inputs',()=>{
 assert.equal(typeof sourceFacts.evaluateAiListingSkuPricing,'function');
 const group={sku:'fallback',listingItem:{}},source={sku:'fallback',sourceSnapshot:{currency:'CNY',blackKopecks:'10000'},items:[group]};
 const config={targetStoreId:'store',priceMultiplier:'1',priceAdjustmentKopecks:0,salePricing:{...rules,useBlackPriceWhenGreenMissing:true}};
 assert.deepEqual(sourceFacts.evaluateAiListingSkuPricing({source,config,store:{currencyCode:'CNY'}}),[{sku:'fallback',status:'READY',priceBasis:'BLACK_PRICE_FALLBACK',usedBlackPriceFallback:true}]);
 const actual=sourceFacts.evaluateAiListingSkuPricing({source:{...source,sourceSnapshot:{currency:'CNY',price:'100'}},config:{...config,salePricing:rules},store:{currencyCode:'CNY'}});
 assert.equal(actual[0].status,'READY');assert.equal(actual[0].usedBlackPriceFallback,false);
});
