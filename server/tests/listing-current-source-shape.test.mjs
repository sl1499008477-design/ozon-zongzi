import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../index.mjs',import.meta.url),'utf8');const start=source.indexOf('function listingVariantSourceSnapshot(');const snippet=source.slice(start,source.indexOf('\nfunction listingSourceAttribute(',start));const resolve=new Function(snippet+';return listingVariantSourceSnapshot;')();
test('current per-SKU collected sourceCategory attributes are preserved without borrowing anchor evidence',()=>{
 const variants=[{sku:'4624804325',logistics:{weightG:2001,lengthMm:1230,widthMm:40,heightMm:40},sourceCategory:{descriptionCategoryId:17032981,typeIdCandidate:91670,attributes:[{key:'9454',value:'1230'},{key:'10096',value:'白色'}]}},{sku:'4624803840',logistics:{weightG:2001,lengthMm:1450,widthMm:60,heightMm:60},sourceCategory:{descriptionCategoryId:17032981,typeIdCandidate:91670,attributes:[{key:'9454',value:'1450'},{key:'10096',value:'черный'}]}}];
 const before=structuredClone(variants);const anchor={variantData:{attributes:[{key:'9454',value:'1450'}]}};
 for(const variant of variants){const result=resolve(variant,anchor,variant.sku,'4624803840');assert.equal(result.sku,variant.sku);assert.deepEqual(result.attributes,variant.sourceCategory.attributes);assert.deepEqual(result.logistics,variant.logistics);}
 assert.deepEqual(variants,before);
 assert.deepEqual(resolve({sku:'4624804325',sourceCategory:{attributes:[]}},anchor,'4624804325','4624803840'),{});
});
test('an explicit existing source snapshot retains precedence over the current projection',()=>{const original={sku:'one',attributes:[{key:'1',value:'original'}]};assert.equal(resolve({sourceVariant:original,sourceCategory:{attributes:[{key:'1',value:'projected'}]}}),original);});
