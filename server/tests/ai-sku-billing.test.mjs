import test from 'node:test';import assert from 'node:assert/strict';import {moneyCents,successfulSkus} from '../ai-sku-billing.mjs';
test('money parsed exactly in cents and invalid amounts rejected',()=>{assert.equal(moneyCents('0.29'),29);assert.equal(moneyCents('2'),200);for(const x of ['-1','0.001','NaN','1e3',1])assert.throws(()=>moneyCents(x));});
test('only fully generated SKU qualifies',()=>{assert.deepEqual(successfulSkus([{sku:'a',generatedUrl:'https://x'},{sku:'a',generatedUrl:null},{sku:'b',generatedUrl:'https://y'}]),['b']);assert.deepEqual(successfulSkus([]),[]);});
