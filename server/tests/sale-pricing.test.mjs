import test from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULT_REAL_PRICE_FORMULA,normalizeSalePricingRules,calculateSalePrice} from '../../shared/sale-pricing.mjs';
import {calculateAutoListingPriceFromEvidence} from '../auto-listing-pricing.mjs';
const rules=(salePriceFormula='真实售价',currency='CNY')=>({currency,realPriceFormula:DEFAULT_REAL_PRICE_FORMULA,salePriceFormula});

test('default template matches existing backend pricing including 80 boundary and absent green price',()=>{
 for(const black of ['1','1000','7999','8000','10692','10000000'])for(const green of [null,String(BigInt(black)*9n/10n||1n)]){
  const input={currency:'CNY',blackKopecks:black,greenKopecks:green};
  assert.equal(calculateSalePrice(rules(),input).finalPriceKopecks,calculateAutoListingPriceFromEvidence(input).finalPriceKopecks);
 }
});
test('representative SKU 2102714113 keeps 118.94 real price and 544.70 listing price',()=>{
 const value=calculateSalePrice(rules('(真实售价 - 10) × 5'),{currency:'CNY',blackKopecks:'10692',greenKopecks:'10158'});
 assert.equal(value.realPriceKopecks,'11894');assert.equal(value.finalPriceKopecks,'54470');
});
test('editable formulas, lazy IF, negative adjustments and stage rounding use exact decimals',()=>{
 const value=calculateSalePrice({...rules(),realPriceFormula:'黑标价 / 3',salePriceFormula:'IF(真实售价 >= 33, (真实售价 + 0.1 + 0.2) * 3, 1 / 0)'},{currency:'CNY',blackKopecks:'10000',greenKopecks:null});
 assert.equal(value.realPriceKopecks,'3333');assert.equal(value.finalPriceKopecks,'10089');
 assert.equal(calculateSalePrice({...rules(),realPriceFormula:'黑标价',salePriceFormula:'0.105'}, {currency:'CNY',blackKopecks:'10000'}).finalPriceKopecks,'11');
});
test('actual source price is not reverse-calculated again',()=>{
 assert.equal(calculateSalePrice(rules('(真实售价 + 2) * 3'),{currency:'CNY',sourcePriceKopecks:'1000'}).finalPriceKopecks,'3600');
});
test('unused green prices cannot block a low-price branch, actual source or direct-black formula',()=>{
 for(const greenKopecks of ['0','6000','invalid']){
  assert.equal(calculateSalePrice(rules(),{currency:'CNY',blackKopecks:'5000',greenKopecks}).finalPriceKopecks,'4666');
  assert.equal(calculateSalePrice(rules(),{currency:'CNY',sourcePriceKopecks:'10000',greenKopecks}).finalPriceKopecks,'10000');
  assert.equal(calculateSalePrice({...rules(),realPriceFormula:'黑标价'},{currency:'CNY',blackKopecks:'10000',greenKopecks}).finalPriceKopecks,'10000');
 }
 assert.throws(()=>calculateSalePrice(rules(),{currency:'CNY',blackKopecks:'10000',greenKopecks:'11000'}),{code:'PRICE_INPUT_INVALID'});
});
test('missing green is never zero unless expression explicitly chooses another branch',()=>{
 assert.throws(()=>calculateSalePrice({...rules(),realPriceFormula:'(黑标价 - 绿标价) * 2.25 + 黑标价'},{currency:'CNY',blackKopecks:'10000',greenKopecks:null}),{code:'SALE_PRICING_INPUT_MISSING'});
 assert.equal(calculateSalePrice(rules(),{currency:'CNY',blackKopecks:'10000',greenKopecks:null}).finalPriceKopecks,'10000');
});
test('currency mismatch, division by zero, oversized and nonpositive price are explicit errors',()=>{
 assert.throws(()=>calculateSalePrice(rules(),{currency:'RUB',blackKopecks:'10000'}),{code:'SALE_PRICING_CURRENCY_MISMATCH'});
 assert.throws(()=>calculateSalePrice(rules('真实售价 / 0'),{currency:'CNY',sourcePriceKopecks:'10000'}),{code:'SALE_PRICING_DIVISION_BY_ZERO'});
 assert.throws(()=>calculateSalePrice(rules('真实售价 - 100'),{currency:'CNY',sourcePriceKopecks:'10000'}),{code:'PRICE_FINAL_NOT_POSITIVE'});
 assert.throws(()=>calculateSalePrice(rules('真实售价 * 999999999999'),{currency:'CNY',sourcePriceKopecks:'999999999999'}),{code:'PRICE_INPUT_INVALID'});
});
test('formula input accepts only arithmetic grammar and known variables; never JavaScript',()=>{
 for(const formula of ['process.exit()','黑标价.constructor','eval(1)','IF(1, 2)','真实售价','黑标价; alert(1)','黑标价 +',''.padEnd(513,'1')]){
  assert.throws(()=>normalizeSalePricingRules({...rules(),realPriceFormula:formula}),{code:'SALE_PRICING_FORMULA_INVALID'},formula);
 }
 assert.deepEqual(normalizeSalePricingRules(rules('（真实售价＋2）÷ 3')).salePriceFormula,'(真实售价+2)/ 3');
});

test('split listing formula does not evaluate unused real price rules',()=>{
 const independent={currency:'CNY',pricingVersion:2,realPriceFormula:'黑标价 / 0',salePriceFormula:'黑标价 * 0.97'};
 const value=calculateSalePrice(independent,{currency:'CNY',blackKopecks:'10692'});
 assert.equal(value.finalPriceKopecks,'10371');assert.equal(value.realPriceKopecks,null);
 // Even a real-price reference in an unused IF branch is lazy.
 assert.equal(calculateSalePrice({...independent,salePriceFormula:'IF(黑标价 > 100, 黑标价, 真实售价)'},{currency:'CNY',blackKopecks:'10692'}).finalPriceKopecks,'10692');
});
test('split real price is independent from listing rules and uses exact rounding',async()=>{
 const pricing=await import('../../shared/sale-pricing.mjs');
 assert.equal(typeof pricing.calculateRealPrice,'function');
 const real=pricing.calculateRealPrice({currency:'CNY',realPriceFormula:'黑标价 / 3'},{currency:'CNY',blackKopecks:'10000'});
 assert.equal(real.realPriceKopecks,'3333');
 assert.equal(pricing.calculateRealPrice({currency:'CNY',realPriceFormula:'黑标价 / 0'},{currency:'CNY',sourcePriceKopecks:'12345'}).realPriceKopecks,'12345');
 assert.throws(()=>pricing.normalizeRealPricingRules({currency:'CNY',realPriceFormula:'真实售价 * 2'}),{code:'SALE_PRICING_FORMULA_INVALID'});
 assert.deepEqual(pricing.normalizeListingPricingRules({currency:'CNY',salePriceFormula:'真实售价 * 2',realPriceFormula:'1'}),{currency:'CNY',salePriceFormula:'真实售价 * 2',useBlackPriceWhenGreenMissing:false});
});

test('renamed competitor price formula edits preserve stored variables and existing task prices',async()=>{
 const pricing=await import('../../shared/sale-pricing.mjs');
 const input={currency:'CNY',blackKopecks:'10692',greenKopecks:'10158'};
 const edited='(竞品真实售价计算 - 10) * 5';
 const normalized=pricing.normalizeListingPricingRules({currency:'CNY',salePriceFormula:edited});
 assert.equal(normalized.salePriceFormula,'(真实售价 - 10) * 5');
 assert.equal(pricing.salePriceUsesRealPrice(edited),true);
 assert.equal(pricing.displaySalePriceFormula(normalized.salePriceFormula),edited);
 assert.equal(pricing.displaySalePriceFormula(edited),edited);
 for(const formula of [edited,normalized.salePriceFormula]){
  assert.equal(calculateSalePrice(rules(formula),input).finalPriceKopecks,'54470');
 }
 assert.throws(()=>pricing.normalizeRealPricingRules({currency:'CNY',realPriceFormula:'竞品真实售价计算 * 2'}),{code:'SALE_PRICING_FORMULA_INVALID'});
});
