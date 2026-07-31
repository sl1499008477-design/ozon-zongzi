const assert = require('node:assert/strict');
const test = require('node:test');
const {
  CONTRACT_VERSION,
  assertComplete,
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
