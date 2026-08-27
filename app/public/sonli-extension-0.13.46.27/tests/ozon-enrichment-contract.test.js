const assert = require('node:assert/strict');
const test = require('node:test');
const {
  CONTRACT_VERSION,
  assertComplete,
  collectEvidenceFromSearchResult,
  missingFields,
  normalizeResult,
  normalizeVariantData,
  toCollectFields,
} = require('../lib/ozon-enrichment-contract.js');

const capturedAt = '2026-07-31T00:00:00.000Z';

function completeVariantData(overrides = {}) {
  return {
    description_category_id: 123,
    type_id: 456,
    attributes: [
      { key: '4497', value: '500' },
      { key: '9454', value: '300' },
      { key: '9455', value: '200' },
      { key: '9456', value: '100' },
    ],
    ...overrides,
  };
}

function serverResult(overrides = {}) {
  const variantData = completeVariantData();
  return {
    status: 'COMPLETE',
    contractVersion: 'collector.ozon.enrichment.v1',
    sku: '4862904234',
    descriptionCategoryId: 123,
    typeId: 456,
    logistics: {
      weightG: 500,
      lengthMm: 300,
      widthMm: 200,
      heightMm: 100,
    },
    variantData,
    source: 'BACKEND_FLEET',
    capturedAt,
    cache: {
      hit: false,
      expiresAt: '2026-07-31T06:00:00.000Z',
    },
    ...overrides,
  };
}

test('accepts the exact complete server v1 result and maps existing collection fields', () => {
  const input = serverResult();
  const normalized = normalizeResult(input);

  assert.equal(CONTRACT_VERSION, 'collector.ozon.enrichment.v1');
  assert.deepEqual(normalized, input);
  assert.deepEqual(toCollectFields(normalized), {
    description_category_id: 123,
    type_id: 456,
    weight: 500,
    depth: 300,
    width: 200,
    height: 100,
    weight_unit: 'g',
    dimension_unit: 'mm',
    variantData: input.variantData,
  });
});

test('projects only the requested SKU Seller evidence and strips portal-only fields', () => {
  const evidence = collectEvidenceFromSearchResult({
    sku: '4862904234',
    result: {
      items: [
        {
          _searchMeta: { skus: [{ sku: '4999999999' }] },
          description_category_id: 999,
          attributes: [{ key: '4497', value: '999' }],
        },
        {
          _searchMeta: { skus: [{ sku: '4862904234' }] },
          description_category_id: 123,
          type_id: 456,
          categories: [
            { id: 10, level: 1, title: 'Дом' },
            { id: 11, level: 2, name: 'Посуда' },
          ],
          attributes: [
            { key: '8229', value: 'Заварочный чайник', dictionary_value_id: 123456 },
            { key: '4497', value: '500' },
            { key: '9454', value: '300' },
            { key: '9455', value: '200' },
            { key: '9456', value: '100' },
          ],
          _bundleItem: {
            seller_company_id: 'must-not-cross-boundary',
            attributes: [{
              attribute_id: 7001,
              complex_id: 0,
              values: [{ value: 'Коробка', dictionary_value_id: 88001 }],
            }],
          },
          _bundleComplexAttrs: [{ complex_id: 7, secret: 'must-not-cross-boundary' }],
          access_token: 'must-not-cross-boundary',
        },
      ],
    },
  });

  assert.deepEqual(evidence, {
    description_category_id: 123,
    type_id: 456,
    weight: 500,
    depth: 300,
    width: 200,
    height: 100,
    weight_unit: 'g',
    dimension_unit: 'mm',
    variantData: {
      description_category_id: 123,
      type_id: 456,
      weight: 500,
      depth: 300,
      width: 200,
      height: 100,
      categories: [
        { id: 10, level: 1, title: 'Дом' },
        { id: 11, level: 2, name: 'Посуда' },
      ],
      attributes: [
        { key: '8229', value: 'Заварочный чайник', dictionary_value_id: 123456 },
        { key: '4497', value: '500' },
        { key: '9454', value: '300' },
        { key: '9455', value: '200' },
        { key: '9456', value: '100' },
        { key: '7001', value: 'Коробка', dictionary_value_id: 88001 },
      ],
    },
  });
  assert.doesNotMatch(JSON.stringify(evidence), /_bundleItem|seller_company_id|access_token|secret/);
});

test('keeps partial Seller evidence without inventing missing package values', () => {
  const evidence = collectEvidenceFromSearchResult({
    sku: '4862904234',
    result: {
      items: [{
        _searchMeta: { skus: [{ sku: '4862904234' }] },
        description_category_id: '321',
        type_id: '654',
        attributes: [{ key: '8229', value: 'Чайник' }],
      }],
    },
  });

  assert.deepEqual(evidence, {
    description_category_id: 321,
    type_id: 654,
    variantData: {
      description_category_id: 321,
      type_id: 654,
      attributes: [{ key: '8229', value: 'Чайник' }],
    },
  });
  for (const key of ['weight', 'depth', 'width', 'height', 'weight_unit', 'dimension_unit']) {
    assert.equal(Object.hasOwn(evidence, key), false, `partial evidence must omit ${key}`);
  }

  assert.deepEqual(collectEvidenceFromSearchResult({
    sku: '4862904234',
    result: { items: [{ _searchMeta: { skus: [{ sku: '4999999999' }] }, description_category_id: 1 }] },
  }), {});
});

test('accepts additive source category evidence and persists only its safe projection', () => {
  const sourceCategory = {
    descriptionCategoryId: 123,
    typeName: 'Заварочный чайник',
    typeIdCandidate: 456,
    path: ['家用电器', 'Заварочный чайник'],
  };
  const normalized = normalizeResult(serverResult({ sourceCategory }));

  assert.deepEqual(normalized.sourceCategory, sourceCategory);
  assert.deepEqual(toCollectFields(normalized).sourceCategory, sourceCategory);
});

test('normalizes locally captured variant data through the same complete result contract', () => {
  const variantData = completeVariantData();
  const normalized = normalizeVariantData({
    sku: '4862904234',
    variantData,
    source: 'LOCAL_SELLER',
    capturedAt,
  });

  assert.deepEqual(normalized, {
    status: 'COMPLETE',
    contractVersion: 'collector.ozon.enrichment.v1',
    sku: '4862904234',
    descriptionCategoryId: 123,
    typeId: 456,
    logistics: {
      weightG: 500,
      lengthMm: 300,
      widthMm: 200,
      heightMm: 100,
    },
    variantData,
    source: 'LOCAL_SELLER',
    capturedAt,
  });
  assert.deepEqual(toCollectFields(normalized), {
    description_category_id: 123,
    type_id: 456,
    weight: 500,
    depth: 300,
    width: 200,
    height: 100,
    weight_unit: 'g',
    dimension_unit: 'mm',
    variantData,
  });
});

test('local normalization uses documented kilogram and top-level bundle fallbacks', () => {
  const variantData = {
    description_category_id: '321',
    weight: '999',
    depth: '301',
    width: '201',
    height: '101',
    attributes: [
      { key: '4383', value: '0.75' },
      { key: '9454', value: '300' },
    ],
  };
  const normalized = normalizeVariantData({
    sku: '4862904234',
    variantData,
    source: 'LOCAL_SELLER',
    capturedAt,
  });

  assert.deepEqual(normalized.logistics, {
    weightG: 750,
    lengthMm: 300,
    widthMm: 201,
    heightMm: 101,
  });
  assert.equal(Object.hasOwn(normalized, 'typeId'), false);
  assert.equal(Object.hasOwn(toCollectFields(normalized), 'type_id'), false);
});

test('fails closed on version mismatch, incomplete fields, and invalid server shape', () => {
  assert.throws(
    () => normalizeResult(serverResult({ contractVersion: 'collector.ozon.enrichment.v2' })),
    (error) => error?.status === 422 && error?.code === 'OZON_ENRICH_CONTRACT_MISMATCH',
  );
  assert.throws(
    () => normalizeResult(serverResult({
      logistics: { weightG: 500, lengthMm: 300, widthMm: 0, heightMm: 100 },
    })),
    (error) => error?.status === 422
      && error?.code === 'OZON_ENRICH_INCOMPLETE'
      && assert.deepEqual(error.missingFields, ['widthMm']) === undefined,
  );
  assert.throws(
    () => normalizeResult({ ok: true, data: serverResult() }),
    (error) => error?.status === 422 && error?.code === 'OZON_ENRICH_CONTRACT_MISMATCH',
  );
  assert.throws(
    () => normalizeVariantData({
      sku: '4862904234',
      variantData: completeVariantData({ description_category_id: 0 }),
      source: 'LOCAL_SELLER',
      capturedAt,
    }),
    (error) => error?.status === 422
      && error?.code === 'OZON_ENRICH_INCOMPLETE'
      && assert.deepEqual(error.missingFields, ['descriptionCategoryId']) === undefined,
  );
});

test('exact server v1 results reject coercible non-native strings and numbers', () => {
  const invalidFields = [
    ['numeric sku', { sku: 4862904234 }],
    ['numeric source', { source: 123 }],
    ['numeric capturedAt', { capturedAt: 123 }],
    ['numeric cache expiry', { cache: { hit: false, expiresAt: 123 } }],
    ['string description category', { descriptionCategoryId: '123' }],
    ['string type', { typeId: '456' }],
    ['string weight', {
      logistics: { weightG: '500', lengthMm: 300, widthMm: 200, heightMm: 100 },
    }],
    ['string length', {
      logistics: { weightG: 500, lengthMm: '300', widthMm: 200, heightMm: 100 },
    }],
    ['string width', {
      logistics: { weightG: 500, lengthMm: 300, widthMm: '200', heightMm: 100 },
    }],
    ['string height', {
      logistics: { weightG: 500, lengthMm: 300, widthMm: 200, heightMm: '100' },
    }],
  ];

  for (const [label, overrides] of invalidFields) {
    assert.throws(
      () => normalizeResult(serverResult(overrides)),
      (error) => error?.status === 422 && error?.code === 'OZON_ENRICH_CONTRACT_MISMATCH',
      label,
    );
  }
});

test('reports stable ordered missing fields and assertComplete rejects partial results', () => {
  const partial = {
    descriptionCategoryId: 0,
    logistics: {
      weightG: Number.NaN,
      lengthMm: 300,
      widthMm: -1,
      heightMm: 0,
    },
  };
  assert.deepEqual(missingFields(partial), [
    'descriptionCategoryId',
    'weightG',
    'widthMm',
    'heightMm',
  ]);
  assert.throws(
    () => assertComplete(partial),
    (error) => error?.status === 422
      && error?.code === 'OZON_ENRICH_INCOMPLETE'
      && error?.retryable === true,
  );
});
