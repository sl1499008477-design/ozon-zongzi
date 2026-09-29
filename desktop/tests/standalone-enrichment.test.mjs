import test from 'node:test';
import assert from 'node:assert/strict';
import { captureSellerProduct, projectSellerProduct } from '../dist-electron/services/seller-enrichment.core.js';
import { createEnrichmentWorker } from '../dist-electron/services/enrichment-worker.core.js';

const search = { variant_id: '900', skus: ['3556540370'], categories: [{id: 10, level: 1}, {id: 170, level: 2}], description_type_name: 'Воронка', description_type_dict_value: 231, variant_name: 'Воронка техническая' };
const item = { origin_variant_id: '900', weight: 150, depth: 120, width: 70, height: 80, attributes: [
 { attribute_id: 85, complex_id: 0, values: [{value:'Без бренда',dictionary_value_id: 1001}] },
 { attribute_id: 100, values: [{value:'Красный',dictionary_value_id: 1002},{dictionary_value_id: 1003}] },
 { attribute_id: 4497, values: [{value:'140'}] },
 { attribute_id: 777, complex_id: 1, values:[{value:'video'}] },
] };
const verification = { accountId:'account-a', sellerCompanyId:'12345' };
function cache() { const entries=new Map(); return {delete:key=>entries.delete(key), get:key=>entries.get(key), set:(key,value)=>entries.set(key,structuredClone(value)), entries}; }
function captureOptions(overrides={}) {
 const calls=[], saved=cache();
 return { sku:'3556540370', verification, cache:saved, signal:new AbortController().signal, calls,
 request:async (path,body)=>{calls.push({path,body});return path.endsWith('/search') ? {variants:[{...search,skus:['111']},search]} : {item};}, ...overrides };
}

test('exact SKU search selects the actual variant, keeps Russian dictionary values and both packaging sources', async()=>{
 const options=captureOptions(); const data=await captureSellerProduct(options);
 assert.equal(options.calls.length,2);assert.equal(options.calls[1].body.variant_id,'900');
 assert.equal(data.description_category_id,170); assert.equal(data.weight,150);
 assert.deepEqual(data.attributes.find(a=>a.key==='100').values,[{value:'Красный',dictionary_value_id:1002},{dictionary_value_id:1003}]);
 assert.equal(data.attributes.some(a=>a.key==='777'),false);
 assert.equal(data.attributes.find(a=>a.key==='8229').values[0].dictionary_value_id,231);
 assert.equal(data.packagingCandidates[0].weightG,150);assert.equal(data.packagingCandidates[1].weightG,140);
 await captureSellerProduct(options); assert.equal(options.calls.filter(c=>c.path.includes('create-bundle')).length,1);
});

test('a missing exact SKU cannot create a draft; a mismatched bundle cannot be accepted', async()=>{
 const absent=captureOptions({request:async()=>({variants:[{...search,skus:['111']}]})});
 await assert.rejects(captureSellerProduct(absent),{code:'ZONGZI_ENRICH_NOT_FOUND'});
 const wrong=captureOptions({request:async path=>path.endsWith('/search')?{variants:[search]}:{item:{...item,origin_variant_id:'901'}}});
 await assert.rejects(captureSellerProduct(wrong),{code:'ZONGZI_ENRICH_BUNDLE_UNCERTAIN'});
});

test('persist an uncertainty marker before a draft write, so a lost response cannot create another draft',async()=>{
 const saved=cache();let writes=0;
 const options=captureOptions({cache:saved,request:async path=>{
  if(path.endsWith('/search'))return {variants:[search]};
  writes++; assert.equal([...saved.entries.values()][0].state,'pending');throw new Error('offline');
 }});
 await assert.rejects(captureSellerProduct(options),{code:'ZONGZI_ENRICH_BUNDLE_UNCERTAIN'});
 await assert.rejects(captureSellerProduct(options),{code:'ZONGZI_ENRICH_BUNDLE_UNCERTAIN'});assert.equal(writes,1);
});

test('bundle cache is scoped to account and Seller company; missing source logistics stay null',async()=>{
 const options=captureOptions();await captureSellerProduct(options);
 await captureSellerProduct({...options,verification:{...verification,accountId:'account-b'}});
 await captureSellerProduct({...options,verification:{...verification,sellerCompanyId:'67890'}});
 assert.equal(options.calls.filter(c=>c.path.includes('create-bundle')).length,3);
 const data=projectSellerProduct(search,{origin_variant_id:'900',attributes:[]});assert.equal(data.weight,null);
});

function workerOptions(overrides={}) {
 let identity={accountId:'account-a',parentToken:'test-parent'}, calls=[], notices=[];
 const job={id:'job-1',sku:'3556540370',requestId:'request-1',claimFence:'test-fence'};
 const defaults={getIdentity:()=>identity, openSession:async()=>async(path,data)=>{
  calls.push({path,data});
  if(path.endsWith('/available'))return {available:true};
  if(path.endsWith('/next'))return {job};return {ok:true};
 }, verifySeller:async()=>verification, capture:async()=>projectSellerProduct(search,item), notify:s=>notices.push(s), heartbeatMs:10_000};
 return {worker:createEnrichmentWorker({...defaults,...overrides}), calls, notices, setIdentity:v=>identity=v};
}

test('takes over an existing pending job and posts the same claim fence without an extension',async()=>{
 const f=workerOptions();await f.worker.runOnce();
 assert.deepEqual(f.calls.map(c=>c.path.split('/').at(-1)),['available','next','result']);
 const posted=f.calls.at(-1).data;
 assert.equal(posted.claimFence,'test-fence'); assert.deepEqual(posted.captureContext,f.calls[1].data.captureContext);
 assert.equal(posted.variantData.weight,150);assert.equal(f.worker.getStatus().completed,1);
});

test('missing Seller login never claims a job and surfaces an actionable status',async()=>{
 const f=workerOptions({verifySeller:async()=>{throw Object.assign(new Error('Seller 未登录'),{code:'SELLER_LOGIN_REQUIRED'});}});
 await f.worker.runOnce(); assert.equal(f.calls.length,1);assert.equal(f.worker.getStatus().phase,'needs_login');
});

test('account switch discards old product data and never posts it with new credentials',async()=>{
 let complete;
 const f=workerOptions({capture:()=>new Promise(r=>complete=r)});
 const running=f.worker.runOnce();await new Promise(r=>setImmediate(r));
 f.setIdentity({accountId:'account-b',parentToken:'new-parent'});complete(projectSellerProduct(search,item));await running;
 assert.equal(f.calls.some(c=>/\/(result|fail)$/.test(c.path)),false);
});

test('renews a slow capture and prevents overlapping processing',async()=>{
 let complete, captures=0;
 const f=workerOptions({heartbeatMs:5,capture:()=>{captures++;return new Promise(r=>complete=r);}});
 const running=f.worker.runOnce();await new Promise(r=>setTimeout(r,22));
 const also=f.worker.runOnce();complete(projectSellerProduct(search,item));await Promise.all([running,also]);
 assert.equal(captures,1);assert.ok(f.calls.some(c=>c.path.endsWith('/progress')));
});

test('a lost result receipt does not mark a possibly completed job failed',async()=>{
 const calls=[];const f=workerOptions({openSession:async()=>async(path)=>{
  calls.push(path);if(path.endsWith('/available'))return {available:true};
  if(path.endsWith('/next'))return {job:{id:'job',sku:'3556540370',claimFence:'fence'}};
  if(path.endsWith('/result'))throw new Error('response lost');return {ok:true};
 }});
 await f.worker.runOnce();assert.equal(calls.some(path=>path.endsWith('/fail')),false);
 assert.equal(f.worker.getStatus().phase,'error');
});


test('known preflight and HTTP rejection failures can recover without a permanent uncertain marker',async()=>{
 for (const reason of [{requestSent:false},{requestSent:true,confirmedRejected:true}]) {
  let denied=true,writes=0;const options=captureOptions({request:async path=>{
   if(path.endsWith('/search'))return {variants:[search]};
   if(denied)throw Object.assign(new Error('login required'),{code:'SELLER_CONTEXT_REQUIRED',...reason});
   writes++;return {item};
  }});
  await assert.rejects(captureSellerProduct(options),{code:'SELLER_CONTEXT_REQUIRED'});denied=false;
  assert.equal((await captureSellerProduct(options)).weight,150);assert.equal(writes,1);
 }
});

test('explicit values, legacy root IDs and singular barcode match the existing enrichment contract',()=>{
 const data=projectSellerProduct({...search,attributes:[{key:'100',values:[]},{key:'101',collection:['Красный'],dictionary_value_id:42},{key:'102',values:[{value:'Синий',dictionaryValueId:43}]}]}, {...item,barcode:'1234567890123',attributes:[...item.attributes,{attribute_id:102,values:[{value:'Другой',dictionary_value_id:44}]}]});
 assert.deepEqual(data.attributes.find(a=>a.key==='100').values,[]);
 assert.equal(data.attributes.find(a=>a.key==='101').values[0].dictionary_value_id,42);
 assert.equal(data.attributes.find(a=>a.key==='102').values[0].dictionary_value_id,43);
 assert.equal(data.attributes.find(a=>a.key==='7822').values[0].value,'1234567890123');
});


test('text-only bundle cannot downgrade known IDs and stale root IDs cannot override explicit values',()=>{
 const data=projectSellerProduct({...search,attributes:[{key:'101',values:[{value:'Новое'}],dictionary_value_id:99},{key:'102',dictionary_value_id:43}]}, {...item,attributes:[{attribute_id:102,values:[{value:'Старое'}]}]});
 assert.deepEqual(data.attributes.find(a=>a.key==='101').values,[{value:'Новое'}]);
 assert.deepEqual(data.attributes.find(a=>a.key==='102').values,[{dictionary_value_id:43}]);
});


test('Seller complex video and explicit MP4 cover stay grouped with per-value dictionary IDs', async () => {
 const mediaItem = { ...item, attributes: [
  { attribute_id: 10096, complex_id: 0, values: [{ value: 'Красный', dictionary_value_id: 61576 }] },
  { attribute_id: 21841, complex_id: 100001, values: [{ value: 'https://cdn.example.test/sku/video.mp4' }] },
  { attribute_id: 21837, complex_id: 100001, values: [{ value: 'Видео товара' }] },
  { attribute_id: 21845, complex_id: 100002, values: [{ value: 'https://cdn.example.test/sku/cover.mp4' }] },
  { attribute_id: 300, complex_id: 77, values: [{ value: 'Красный', dictionary_value_id: 901 }, { dictionary_value_id: 902 }] },
 ] };
 const options = captureOptions({ request: async path => path.endsWith('/search') ? { variants: [search] } : { item: mediaItem } });
 const projected = await captureSellerProduct(options);
 assert.deepEqual(projected.complex_attributes, [
  { attributes: [
   { id: 21841, complex_id: 100001, values: [{ value: 'https://cdn.example.test/sku/video.mp4' }] },
   { id: 21837, complex_id: 100001, values: [{ value: 'Видео товара' }] },
  ] },
  { attributes: [{ id: 21845, complex_id: 100002, values: [{ value: 'https://cdn.example.test/sku/cover.mp4' }] }] },
  { attributes: [{ id: 300, complex_id: 77, values: [{ value: 'Красный', dictionary_value_id: 901 }, { dictionary_value_id: 902 }] }] },
 ]);
 assert.equal(projected.attributes.some(attr => ['21841', '21837', '21845', '300'].includes(attr.key)), false);
 assert.deepEqual((await captureSellerProduct(options)).complex_attributes, projected.complex_attributes);
 const posterOnly = projectSellerProduct({ ...search, main_image: 'https://cdn.example.test/sku/poster.jpg' }, { attributes: [] });
 assert.equal((posterOnly.complex_attributes || []).flatMap(group => group.attributes).some(attr => attr.id === 21845), false);
});

test('Seller repeated complex groups retain their instance boundaries through the bundle cache', async () => {
 const groupedItem = { ...item, attributes: [], complex_attributes: [
  { attributes: [{ id: 300, complex_id: 77, values: [{ value: 'Первый', dictionary_value_id: 901 }] }] },
  { attributes: [{ id: 300, complex_id: 77, values: [{ value: 'Второй', dictionary_value_id: 902 }] }] },
 ] };
 const options = captureOptions({ request: async path => path.endsWith('/search') ? { variants: [search] } : { item: groupedItem } });
 assert.deepEqual((await captureSellerProduct(options)).complex_attributes, groupedItem.complex_attributes);
 assert.deepEqual((await captureSellerProduct(options)).complex_attributes, groupedItem.complex_attributes);
});


test('partial search complex evidence cannot discard another attribute from the same Seller bundle group', () => {
 const projected = projectSellerProduct({ ...search, attributes: [
  { key: '21837', complex_id: 100001, values: [{ value: 'Имя из поиска', dictionary_value_id: 901 }] },
 ] }, { ...item, attributes: [
  { attribute_id: 21837, complex_id: 100001, values: [{ value: 'Старое имя' }] },
  { attribute_id: 21841, complex_id: 100001, values: [{ value: 'https://cdn.example.test/sku/video.mp4' }] },
 ] });
 assert.deepEqual(projected.complex_attributes, [{ attributes: [
  { id: 21837, complex_id: 100001, values: [{ value: 'Имя из поиска', dictionary_value_id: 901 }] },
  { id: 21841, complex_id: 100001, values: [{ value: 'https://cdn.example.test/sku/video.mp4' }] },
 ] }]);
 assert.equal(projected.attributes.some(attr => ['21837', '21841'].includes(attr.key)), false);
});
