// Offline acceptance against the saved 2026-09-25 error audit. No API, database or task writes.
// node scripts/replay-ai-listing-pricing-recovery.mjs --audit-dir /path/to/audit [--output /path/to/result.json]
import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {aiListingItemPrice,aiListingPriceFacts,evaluateAiListingSkuPricing} from '../server/ai-listing-source-facts.mjs';

const args=process.argv.slice(2);
const option=name=>{const index=args.indexOf(name);return index>=0?args[index+1]:undefined;};
const auditDir=resolve(option('--audit-dir')||fileURLToPath(new URL('../outputs/qa/2026-09-25-ai-errors-audit',import.meta.url)));
const output=resolve(option('--output')||fileURLToPath(new URL('../outputs/qa/2026-09-25-ai-recovery-fix/pricing-replay-after.json',import.meta.url)));
const hashes={},read=async name=>{const bytes=await readFile(resolve(auditDir,name));hashes[name]=createHash('sha256').update(bytes).digest('hex');return JSON.parse(bytes);};
const [before,diagnostics,details]=await Promise.all([read('pricing-replay.json'),read('production-diagnostics.json'),read('task-details.json')]);
assert.equal(before.tasks.length,33,'expected the complete 33-task baseline');
assert.equal(before.tasks.reduce((count,task)=>count+task.items.length,0),453,'expected all 453 SKU occurrences');
const rawTasks=new Map(diagnostics.tasks.map(task=>[task.id,task]));
const detailTasks=new Map(details.map(entry=>[entry.id,entry.task]));
const mismatches=[],tasks=[];
const check=(condition,context)=>{if(!condition)mismatches.push(context);};
const totals={tasks:before.tasks.length,skuOccurrences:0,uniqueSkus:0,currencies:{},off:{calculated:0,skipped:0,unexpectedErrors:0},on:{calculated:0,skipped:0,unexpectedErrors:0,blackPriceFallbacks:0},unchangedGreenPriceResults:0,verifiedBlackTimesTwo:0};
const uniqueSkus=new Set();
const calculate=(source,group,config,store)=>{
  try{return {status:'CALCULATED',pricing:aiListingItemPrice(source,group,config,store).pricing};}
  catch(error){return {status:error.code==='SALE_PRICING_SKU_SKIPPED'?'SKIPPED':'ERROR',code:error.code,skipReason:error.skipReason,sku:error.sku,message:error.message};}
};
for(const priorTask of before.tasks){
  const source=rawTasks.get(priorTask.id)?.body?.sourcePrices,config=detailTasks.get(priorTask.id)?.config;
  assert.ok(source?.items?.length,`missing frozen source ${priorTask.id}`);
  assert.ok(config?.salePricing,`missing frozen pricing ${priorTask.id}`);
  assert.equal(config.salePricing.useBlackPriceWhenGreenMissing,undefined,'audit must retain its original absent-field policy');
  assert.equal(source.items.length,priorTask.items.length,'saved price projection must cover every baseline SKU');
  const frozen=structuredClone(config.salePricing),store={currencyCode:frozen.currency};
  const admissionOff=new Map(evaluateAiListingSkuPricing({source,config:{...config,salePricing:{...frozen,useBlackPriceWhenGreenMissing:false}},store}).map(row=>[row.sku,row]));
  const admissionOn=new Map(evaluateAiListingSkuPricing({source,config:{...config,salePricing:{...frozen,useBlackPriceWhenGreenMissing:true}},store}).map(row=>[row.sku,row]));
  const admissionLegacy=new Map(evaluateAiListingSkuPricing({source,config,store}).map(row=>[row.sku,row]));
  const task={id:priorTask.id,anchorSku:priorTask.anchorSku,collectItemId:priorTask.collectItemId,frozenPricing:frozen,items:[]};
  for(const prior of priorTask.items){
    const group=source.items.find(item=>item.sku===prior.sku);
    assert.ok(group,`missing SKU ${prior.sku}`);
    const evidence=aiListingPriceFacts(source,group,config,store).evidence;
    const key={taskId:priorTask.id,sku:prior.sku};
    check(JSON.stringify(evidence)===JSON.stringify(prior.evidence),{...key,check:'frozen_evidence_matches_original',expected:prior.evidence,actual:evidence});
    const original=calculate(source,group,config,store);
    const off=calculate(source,group,{...config,salePricing:{...frozen,useBlackPriceWhenGreenMissing:false}},store);
    const on=calculate(source,group,{...config,salePricing:{...frozen,useBlackPriceWhenGreenMissing:true}},store);
    totals.skuOccurrences++;uniqueSkus.add(prior.sku);totals.currencies[evidence.currency]=(totals.currencies[evidence.currency]||0)+1;
    for(const [name,value] of [['off',off],['on',on]]){
      totals[name][value.status==='CALCULATED'?'calculated':value.status==='SKIPPED'?'skipped':'unexpectedErrors']++;
      if(value.status==='CALCULATED')check(value.pricing.currency===evidence.currency,{...key,check:`${name}_currency_preserved`,expected:evidence.currency,actual:value.pricing.currency});
    }
    const missingGreen=evidence.greenKopecks==null||evidence.greenKopecks==='';
    check(admissionOff.get(prior.sku)?.status===(missingGreen?'SKIPPED':'READY'),{...key,check:'off_admission_matches_price_result',actual:admissionOff.get(prior.sku)});
    check(admissionOn.get(prior.sku)?.status==='READY',{...key,check:'on_admission_ready',actual:admissionOn.get(prior.sku)});
    check(JSON.stringify(admissionOff.get(prior.sku))===JSON.stringify(admissionLegacy.get(prior.sku)),{...key,check:'legacy_admission_defaults_off',actual:admissionLegacy.get(prior.sku)});
    if(prior.result){
      check(original.status==='CALCULATED'&&original.pricing.finalPriceKopecks===prior.result.finalPriceKopecks&&original.pricing.realPriceKopecks===prior.result.realPriceKopecks,{...key,check:'legacy_unchanged',expected:prior.result,actual:original});
      const unchanged=!missingGreen&&[off,on].every(value=>value.status==='CALCULATED'&&value.pricing.finalPriceKopecks===prior.result.finalPriceKopecks&&value.pricing.realPriceKopecks===prior.result.realPriceKopecks);
      check(unchanged,{...key,check:'existing_green_prices_unchanged',expected:prior.result,off,on});if(unchanged)totals.unchangedGreenPriceResults++;
    }else{
      check(original.code===prior.errorCode&&missingGreen,{...key,check:'legacy_missing_green_reproduced',expected:prior.errorCode,actual:original});
      check(off.status==='SKIPPED'&&off.code==='SALE_PRICING_SKU_SKIPPED'&&off.skipReason==='GREEN_PRICE_MISSING'&&off.sku===prior.sku,{...key,check:'off_only_skips_missing_green',actual:off});
      const expectedFinal=String(BigInt(evidence.blackKopecks)*2n);
      const exact=on.status==='CALCULATED'&&on.pricing.realPriceKopecks===evidence.blackKopecks&&on.pricing.finalPriceKopecks===expectedFinal&&on.pricing.usedBlackPriceFallback===true&&on.pricing.priceBasis==='BLACK_PRICE_FALLBACK';
      check(exact,{...key,check:'fallback_is_own_black_times_two',expectedReal:evidence.blackKopecks,expectedFinal,actual:on});if(exact)totals.verifiedBlackTimesTwo++;
    }
    if(on.pricing?.usedBlackPriceFallback===true)totals.on.blackPriceFallbacks++;
    task.items.push({sku:prior.sku,currency:evidence.currency,evidence,original,off,on,admissionOff:admissionOff.get(prior.sku),admissionOn:admissionOn.get(prior.sku)});
  }
  tasks.push(task);
}
totals.uniqueSkus=uniqueSkus.size;
for(const [checkName,actual,expected] of [
  ['off_calculated',totals.off.calculated,341],['off_skipped',totals.off.skipped,112],['off_unexpected_errors',totals.off.unexpectedErrors,0],
  ['on_calculated',totals.on.calculated,453],['on_skipped',totals.on.skipped,0],['on_unexpected_errors',totals.on.unexpectedErrors,0],
  ['on_fallbacks',totals.on.blackPriceFallbacks,112],['unchanged_green_prices',totals.unchangedGreenPriceResults,341],['black_times_two',totals.verifiedBlackTimesTwo,112],
])check(actual===expected,{check:checkName,actual,expected});
const result={kind:'OFFLINE_AI_LISTING_PRICING_RECOVERY_ACCEPTANCE',capturedAt:new Date().toISOString(),passed:!mismatches.length,
  sourceAudit:{directory:auditDir,hashes},scope:'All 33 missing-green tasks / 453 frozen SKU price projections. No live API, database, image generation or product submission.',
  currencyContext:'Use frozen pricing currency as the saved target-store currency; verify every source and calculated result retains the same currency.',totals,mismatches,tasks};
await mkdir(dirname(output),{recursive:true});await writeFile(output,JSON.stringify(result,null,2),{mode:0o600});
console.log(JSON.stringify({passed:result.passed,output,totals,mismatches:mismatches.length},null,2));
if(mismatches.length)process.exitCode=1;
