import test from 'node:test';
import assert from 'node:assert/strict';
import {mergeOzonEnrichmentResult,assertOzonListingLogisticsReady} from '../collect-enrichment-policy.mjs';
import {skuEnrichmentSummary} from '../collect-enrichment-recovery.mjs';
const candidates=[{weightG:105,lengthMm:140,widthMm:60,heightMm:50},{weightG:125,lengthMm:143,widthMm:63,heightMm:54}];
const result={sku:'3025087772',descriptionCategoryId:17033973,logistics:candidates[0],variantData:{packagingCandidates:candidates},sourceCategory:{descriptionCategoryId:17033973,attributes:[{key:'4191',value:'Описание'},{key:'4497',value:'105'}]}};
test('conflicting capture saves category and attributes and both candidates, automatically selecting the approved first candidate',()=>{
 const draft=mergeOzonEnrichmentResult({sku:result.sku},result);
 assert.deepEqual(draft.packagingCandidates,candidates);
 assert.equal(draft.sourceCategory.descriptionCategoryId,17033973);
 assert.ok(draft.sourceCategory.attributes.some(a=>a.key==='4191'));
 assert.deepEqual(draft.logistics,candidates[0]);
 assert.doesNotThrow(()=>assertOzonListingLogisticsReady(draft));
 const summary=skuEnrichmentSummary(draft);
 assert.equal(summary.status,'COMPLETE');
 assert.equal((summary.packagingConflicts || []).length,0);
 assert.ok(!summary.missingFields.includes('descriptionCategoryId'));
});
test('manually supplied logistics are preserved and resolve the warning',()=>{
 const draft=mergeOzonEnrichmentResult({sku:result.sku,logistics:candidates[1]},result);
 assert.deepEqual(draft.logistics,candidates[1]);
 assert.equal(skuEnrichmentSummary(draft).status,'COMPLETE');
});
