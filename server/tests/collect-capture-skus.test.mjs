import test from 'node:test';
import assert from 'node:assert/strict';
import {collectCaptureSkus} from '../collect-enrichment-recovery.mjs';
test('first capture includes anchor and every sibling exactly once',()=>{
 assert.deepEqual(collectCaptureSkus({sku:'3025087772',listingDraft:{variants:[{sku:'3025087772'},{sku:'2271159898'}]}}),['3025087772','2271159898']);
 assert.deepEqual(collectCaptureSkus({sku:'1',raw:{variantData:{variants:[{sku:'2'},{sku:'2'}]}}}),['1','2']);
});
