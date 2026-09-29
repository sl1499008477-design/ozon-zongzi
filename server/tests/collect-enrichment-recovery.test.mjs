import test from 'node:test';
import assert from 'node:assert/strict';
import {mergeSkuEnrichment,skuEnrichmentSummary} from '../collect-enrichment-recovery.mjs';
const evidence={sku:'white',sourceCategory:{descriptionCategoryId:12},logistics:{weightG:120,lengthMm:236,widthMm:225,heightMm:86}};
test('fills only matching SKU blanks and preserves manual edits',()=>{
 const draft={sku:'white',packageWeight:150,sourceCategory:{descriptionCategoryId:12},variants:[{sku:'white',packageWeight:140},{sku:'black'}]};
 const next=mergeSkuEnrichment(draft,evidence);
 assert.equal(next.packageWeight,150);assert.equal(next.variants[0].packageWeight,140);
 assert.equal(next.variants[0].logistics.lengthMm,236);assert.deepEqual(next.variants[1],{sku:'black'});
 assert.equal(skuEnrichmentSummary(next).status,'PENDING_ENRICHMENT');
 assert.equal(skuEnrichmentSummary(next).missingSkus[0],'black');
 assert.deepEqual(mergeSkuEnrichment(next,evidence),next);
});
test('child result never overwrites parent logistics; all SKUs must be complete',()=>{
 let next=mergeSkuEnrichment({sku:'white',variants:[{sku:'white'},{sku:'black'}]},evidence);
 next=mergeSkuEnrichment(next,{...evidence,sku:'black',logistics:{...evidence.logistics,weightG:99}});
 assert.equal(next.logistics.weightG,120);assert.equal(next.variants[1].logistics.weightG,99);
 assert.equal(skuEnrichmentSummary(next).status,'COMPLETE');
});
