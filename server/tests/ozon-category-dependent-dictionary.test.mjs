import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeOzonImportItems } from '../ozon-import-normalizer.mjs';

const coated = { dictionary_value_id: 61971, value: 'Нержавеющая сталь с покрытием' };
const steel = { dictionary_value_id: 61969, value: 'Нержавеющая сталь' };
const item = (sku, values) => ({ offer_id: sku, scraped_sku: sku, name: 'Полка', price: '100', currency_code: 'CNY',
  images: ['https://example.test/shelf.jpg'], description_category_id: 80731485, type_id: 115946601,
  weight: 1000, depth: 370, width: 170, height: 100, attributes: [{ id: 6656, values }] });
const material = { id: 6656, name: 'Материал корпуса', dictionary_id: 1503, category_dependent: true, is_required: false };
const fixture = ({ values = [{ id: 61969, value: steel.value }], firstPage = values, search = [{ id: 61971, value: coated.value }], required = false } = {}) => {
  const calls = [];
  return { calls, context: { strictTypeMatch: true,
    getCategoryAttributes: async () => [{ ...material, is_required: required }],
    getCategoryAttributeValues: async (categoryId, typeId, attributeId, options = {}) => {
      assert.deepEqual([categoryId, typeId, attributeId], [80731485, 115946601, 6656]);
      calls.push({ kind: options.language === 'ZH_HANS' ? 'localized' : options.matchCandidates ? 'targetIds' : 'initial', options });
      if (options.language === 'ZH_HANS') return [];
      if (options.matchCandidates) return values.filter(value => options.matchCandidates.some(candidate => candidate.id === value.id));
      return firstPage;
    },
    searchCategoryAttributeValuesExact: async () => { calls.push({ kind: 'search' }); return search; },
  } };
};

test('six shelf variants omit invalid target material 61971 despite exact search returning it and share dictionary reads', async () => {
  const source = [item('BSC005E', [coated]), item('BSC024E', [coated]), item('BSC003', [steel]),
    item('BSC005', [coated]), item('BSC024', [coated]), item('BSC003H', [steel])];
  const before = structuredClone(source), f = fixture();
  const result = await normalizeOzonImportItems(source, f.context);
  assert.equal(result.items.length, 6);
  for (const row of result.items) {
    const values = row.attributes?.find(attribute => attribute.id === 6656)?.values;
    if (['BSC003', 'BSC003H'].includes(row.offer_id)) assert.deepEqual(values, [steel]);
    else assert.equal(values, undefined, row.offer_id);
  }
  assert.equal(result.itemWarnings.length, 4);
  for (const row of result.itemWarnings) assert.match(row.warnings.join(' '), /6656.*Нержавеющая сталь с покрытием.*目标类目.*未上传/);
  assert.equal(f.calls.filter(call => call.kind === 'initial').length, 1);
  assert.equal(f.calls.filter(call => call.kind === 'targetIds').length, 1);
  assert.equal(f.calls.filter(call => call.kind === 'search').length, 1);
  assert.deepEqual(source, before);
});

test('text-only search results must also belong to the target dictionary before upload', async () => {
  const f = fixture();
  const result = await normalizeOzonImportItems([item('text-only', [{ value: coated.value }])], f.context);
  assert.equal(result.items[0].attributes?.some(attribute => attribute.id === 6656) || false, false);
  assert.match(result.warnings.join(' '), /6656.*目标类目.*未上传/);
});

test('an obsolete ID may map to an exact valid target value without guessing a different material', async () => {
  const f = fixture({ values: [{ id: 61969, value: steel.value }, { id: 99991, value: coated.value }] });
  const result = await normalizeOzonImportItems([item('same-material', [coated])], f.context);
  assert.deepEqual(result.items[0].attributes.find(attribute => attribute.id === 6656).values,
    [{ dictionary_value_id: 99991, value: coated.value }]);
  assert.equal(result.warnings.length, 0);
});

test('a valid ID outside the first dictionary page is confirmed by targeted pagination and retained', async () => {
  const f = fixture({ firstPage: [], values: [{ id: 61969, value: steel.value }] });
  const result = await normalizeOzonImportItems([item('later-id', [{ dictionary_value_id: 61969 }])], f.context);
  assert.deepEqual(result.items[0].attributes.find(attribute => attribute.id === 6656).values, [{ dictionary_value_id: 61969 }]);
  assert.equal(f.calls.filter(call => call.kind === 'targetIds').length, 1);
  assert.equal(result.warnings.length, 0);
});

test('invalid required target dictionary values keep the existing submission error and preview warning behavior', async () => {
  const f = fixture({ required: true });
  await assert.rejects(normalizeOzonImportItems([item('required', [coated])], f.context), { code: 'ZONGZI_CATEGORY_DATA_INVALID', status: 422 });
  const preview = await normalizeOzonImportItems([item('required-preview', [coated])], { ...f.context, allowUnresolvedRequiredDictionaryValues: true });
  assert.equal(preview.items.length, 1);
  assert.equal(preview.items[0].attributes?.some(attribute => attribute.id === 6656) || false, false);
  assert.match(preview.warnings.join(' '), /必填字典属性.*Материал корпуса/);
});

test('target dictionary authorization failures cannot be hidden by a supplied ID', async () => {
  const denied = Object.assign(new Error('denied'), { code: 'ZONGZI_CATEGORY_STORE_FORBIDDEN', status: 403 });
  const f = fixture();
  await assert.rejects(normalizeOzonImportItems([item('denied', [steel])], {
    ...f.context, getCategoryAttributeValues: async () => { throw denied; },
  }), error => error === denied);
});

test('a temporary target dictionary outage preserves supplied optional IDs with an explicit unverified warning', async () => {
  for (const stage of ['initial', 'targetIds']) {
    const f = fixture({ firstPage: [] });
    const originalRead = f.context.getCategoryAttributeValues;
    let failures = 0;
    f.context.getCategoryAttributeValues = async (...args) => {
      const targeted = !!args[3]?.matchCandidates;
      if ((stage === 'targetIds') === targeted) {
        failures++;
        throw Object.assign(new Error('unavailable'), { code: 'ZONGZI_CATEGORY_VALUES_UNAVAILABLE', status: 502 });
      }
      return originalRead(...args);
    };
    const result = await normalizeOzonImportItems([item('outage-a', [steel]), item('outage-b', [steel])], f.context);
    for (const row of result.items) assert.deepEqual(row.attributes?.find(attribute => attribute.id === 6656)?.values, [steel]);
    assert.equal(failures, 1, 'a failed read is also shared across this batch, not repeated for each SKU');
    assert.equal(result.itemWarnings.length, 2);
    for (const row of result.itemWarnings) assert.match(row.warnings.join(' '), /6656.*暂不可用.*保留.*未能核对目标类目/);
  }
});

test('trusted collected dictionary IDs do not depend on a new target dictionary lookup',async()=>{
  const f=fixture({required:true});
  const result=await normalizeOzonImportItems([item('collected-id',[coated])],{
    ...f.context,trustSuppliedDictionaryIds:true,
    getCategoryAttributeValues:async()=>{throw new Error('must not recheck a collected dictionary ID');},
    searchCategoryAttributeValuesExact:async()=>{throw new Error('must not search a collected dictionary ID');},
  });
  assert.deepEqual(result.items[0].attributes.find(a=>a.id===6656).values,[coated]);assert.equal(result.warnings.length,0);
});

test('trusting collected IDs still converts text-only values and a newly selected no-brand value',async()=>{
  const f=fixture();const source=item('mixed',[coated,{value:steel.value}]);source.attributes.push({id:85,values:[{value:'Нет бренда'}]});
  const result=await normalizeOzonImportItems([source],{...f.context,trustSuppliedDictionaryIds:true,
    getCategoryAttributes:async()=>[material,{id:85,dictionary_id:85,is_required:true}],
    getCategoryAttributeValues:async(category,type,attribute,options)=>attribute===85?[{id:777,value:'Нет бренда'}]:f.context.getCategoryAttributeValues(category,type,attribute,options),
  });
  assert.deepEqual(result.items[0].attributes.find(a=>a.id===6656).values,[coated,steel]);
  assert.deepEqual(result.items[0].attributes.find(a=>a.id===85).values,[{value:'Нет бренда',dictionary_value_id:777}]);
  assert.equal(f.calls.some(call=>call.kind==='targetIds'||call.kind==='search'),false);
});
