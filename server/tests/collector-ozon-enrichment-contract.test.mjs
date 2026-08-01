import assert from "node:assert/strict";
import test from "node:test";
import {
  OZON_ENRICHMENT_CONTRACT_VERSION,
  assertCompleteOzonCollectPayload,
  missingOzonRequiredFields,
  normalizeOzonAgentResult,
  parseOzonBatchEnrichmentRequest,
  parseOzonEnrichmentRequest,
} from "../collector-ozon-enrichment-contract.mjs";
import {
  assertOzonListingReady,
  buildOzonEnrichmentSummary,
  mergeOzonEnrichmentResult,
  retryDelayMs,
} from "../collect-enrichment-policy.mjs";

const RETIRED_SCOPE_KEY_SPELLINGS = [
  "account-id",
  "created_by",
  "Client_Id",
  "store_id",
  "LOCAL-STORE-ID",
  "operating_store_id",
  "data-collection-store-id",
  "data_collection_store",
  "Data_Collection_Stores",
  "data_collection_store_ids",
  "current-data-collection-store-id",
  "CURRENT_DATA_COLLECTION_STORE_IDS_BY_ACCOUNT",
  "seller-company-id",
  "Seller_Company",
  "legacy-scope",
];

function completeVariantData(overrides = {}) {
  return {
    description_category_id: 123,
    attributes: [
      { key: "4497", value: "500" },
      { key: "9454", value: "300" },
      { key: "9455", value: "200" },
      { key: "9456", value: "100" },
    ],
    ...overrides,
  };
}

function completeResult(overrides = {}) {
  const base = normalizeOzonAgentResult({
    sku: "4862904234",
    source: "LOCAL_SELLER",
    capturedAt: "2026-08-01T00:00:00.000Z",
    variantData: completeVariantData(),
  });
  return {
    ...base,
    ...overrides,
    logistics: { ...base.logistics, ...overrides.logistics },
  };
}

test("enrichment fills blanks without overwriting user values", () => {
  const merged = mergeOzonEnrichmentResult({
    descriptionCategoryId: 700,
    logistics: { weightG: 888, lengthMm: 0, widthMm: 0, heightMm: 0 },
  }, completeResult({ descriptionCategoryId: 900 }));
  assert.equal(merged.descriptionCategoryId, 700);
  assert.equal(merged.logistics.weightG, 888);
  assert.deepEqual(merged.logistics, {
    weightG: 888,
    lengthMm: 300,
    widthMm: 200,
    heightMm: 100,
  });
});

test("empty top-level fields do not hide enriched logistics values", () => {
  const merged = mergeOzonEnrichmentResult({
    descriptionCategoryId: 0,
    weightG: 0,
    logistics: { weightG: 0, lengthMm: 0, widthMm: 0, heightMm: 0 },
  }, completeResult());

  assert.equal(merged.logistics.weightG, 500);
  assert.deepEqual(buildOzonEnrichmentSummary(merged).missingFields, []);
  assert.doesNotThrow(() => assertOzonListingReady(merged));
});

test("enrichment ignores non-numeric JSON values when checking and merging fields", () => {
  const invalid = {
    descriptionCategoryId: true,
    logistics: { weightG: [500], lengthMm: {}, widthMm: "  ", heightMm: true },
  };
  assert.deepEqual(buildOzonEnrichmentSummary(invalid).missingFields, [
    "descriptionCategoryId",
    "weightG",
    "lengthMm",
    "widthMm",
    "heightMm",
  ]);

  const merged = mergeOzonEnrichmentResult(invalid, completeResult());
  assert.equal(merged.descriptionCategoryId, 123);
  assert.deepEqual(merged.logistics, {
    weightG: 500,
    lengthMm: 300,
    widthMm: 200,
    heightMm: 100,
  });
});

test("enrichment policy retains retry state without allowing it to change completeness", () => {
  assert.deepEqual(buildOzonEnrichmentSummary({
    descriptionCategoryId: 123,
    logistics: { weightG: 500, lengthMm: 300, widthMm: 200, heightMm: 100 },
  }, {
    attemptCount: 2,
    nextAttemptAt: "2026-08-01T01:00:00.000Z",
    lastErrorCode: "OZON_RETRYABLE",
    status: "PENDING_ENRICHMENT",
    missingFields: ["weightG"],
  }), {
    status: "COMPLETE",
    missingFields: [],
    attemptCount: 2,
    nextAttemptAt: "2026-08-01T01:00:00.000Z",
    lastErrorCode: "OZON_RETRYABLE",
  });
});

test("enrichment retry delays and listing readiness use the stable field order", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 99].map(retryDelayMs), [30_000, 30_000, 120_000, 600_000, 1_800_000, 3_600_000, 3_600_000]);
  assert.throws(
    () => assertOzonListingReady({
      descriptionCategoryId: 123,
      logistics: { weightG: 500, lengthMm: 0, widthMm: 0, heightMm: 100 },
    }),
    (error) => error?.status === 422
      && error?.code === "COLLECT_ENRICHMENT_INCOMPLETE"
      && assert.deepEqual(error.missingFields, ["lengthMm", "widthMm"]) === undefined,
  );
});

test("normalizes reference and fallback Ozon enrichment fields", async (t) => {
  const cases = [
    {
      name: "reference attributes",
      variantData: completeVariantData({ type_id: 456 }),
      expected: {
        descriptionCategoryId: 123,
        typeId: 456,
        logistics: { weightG: 500, lengthMm: 300, widthMm: 200, heightMm: 100 },
      },
    },
    {
      name: "kilogram attribute fallback",
      variantData: completeVariantData({
        attributes: [
          { key: "4383", value: "0.75" },
          { key: "9454", value: "300" },
          { key: "9455", value: "200" },
          { key: "9456", value: "100" },
        ],
      }),
      expected: {
        descriptionCategoryId: 123,
        logistics: { weightG: 750, lengthMm: 300, widthMm: 200, heightMm: 100 },
      },
    },
    {
      name: "top-level bundle values",
      variantData: {
        description_category_id: "123",
        weight: "500",
        depth: "300",
        width: "200",
        height: "100",
      },
      expected: {
        descriptionCategoryId: 123,
        logistics: { weightG: 500, lengthMm: 300, widthMm: 200, heightMm: 100 },
      },
    },
  ];

  for (const { name, variantData, expected } of cases) {
    await t.test(name, () => {
      const normalized = normalizeOzonAgentResult({
        sku: "4862904234",
        source: "BACKEND_FLEET",
        capturedAt: "2026-07-31T00:00:00.000Z",
        variantData,
      });
      assert.equal(normalized.status, "COMPLETE");
      assert.equal(normalized.contractVersion, OZON_ENRICHMENT_CONTRACT_VERSION);
      assert.equal(normalized.sku, "4862904234");
      assert.equal(normalized.source, "BACKEND_FLEET");
      assert.equal(normalized.capturedAt, "2026-07-31T00:00:00.000Z");
      assert.deepEqual(normalized.logistics, expected.logistics);
      assert.equal(normalized.descriptionCategoryId, expected.descriptionCategoryId);
      assert.equal(normalized.typeId, expected.typeId);
    });
  }
});

test("normalization omits optional typeId", () => {
  const normalized = normalizeOzonAgentResult({
    sku: "4862904234",
    source: "LOCAL_SELLER",
    capturedAt: "2026-07-31T00:00:00.000Z",
    variantData: completeVariantData({ type_id: 0 }),
  });
  assert.equal(Object.hasOwn(normalized, "typeId"), false);
});

test("normalization exposes additive source category evidence", () => {
  const normalized = normalizeOzonAgentResult({
    sku: "4862904234",
    source: "LOCAL_SELLER",
    capturedAt: "2026-08-01T00:00:00.000Z",
    variantData: completeVariantData({
      description_category_id: 17039736,
      categories: [
        { id: 17000000, level: 2, title: "家用电器" },
        { id: 17039736, level: 3, name: "Заварочный чайник" },
      ],
      attributes: [
        { key: "8229", value: "Заварочный чайник", dictionary_value_id: 123456 },
        { key: "4497", value: "500" },
        { key: "9454", value: "300" },
        { key: "9455", value: "200" },
        { key: "9456", value: "100" },
      ],
    }),
  });

  assert.deepEqual(normalized.sourceCategory, {
    descriptionCategoryId: 17039736,
    typeName: "Заварочный чайник",
    typeIdCandidate: 123456,
    path: ["家用电器", "Заварочный чайник"],
  });
});

test("normalization rejects zero, negative, and non-finite required values", async (t) => {
  const cases = [
    ["zero category", completeVariantData({ description_category_id: 0 }), ["descriptionCategoryId"]],
    ["negative weight", completeVariantData({ attributes: [
      { key: "4497", value: "-1" },
      { key: "9454", value: "300" },
      { key: "9455", value: "200" },
      { key: "9456", value: "100" },
    ] }), ["weightG"]],
    ["NaN height", completeVariantData({ attributes: [
      { key: "4497", value: "500" },
      { key: "9454", value: "300" },
      { key: "9455", value: "200" },
      { key: "9456", value: "not-a-number" },
    ] }), ["heightMm"]],
  ];
  for (const [name, variantData, missingFields] of cases) {
    await t.test(name, () => {
      assert.throws(
        () => normalizeOzonAgentResult({ sku: "4862904234", variantData }),
        (error) => error?.status === 422
          && error?.code === "OZON_ENRICH_INCOMPLETE"
          && assert.deepEqual(error.missingFields, missingFields) === undefined,
      );
    });
  }
});

test("completeness gate uses stable missing-field keys and only applies to Ozon", () => {
  const incomplete = {
    descriptionCategoryId: 123,
    logistics: { weightG: 0, lengthMm: 300, widthMm: -1, heightMm: Number.NaN },
  };
  assert.deepEqual(missingOzonRequiredFields(incomplete), ["weightG", "widthMm", "heightMm"]);
  assert.doesNotThrow(() => assertCompleteOzonCollectPayload("wildberries", incomplete));
  assert.throws(
    () => assertCompleteOzonCollectPayload("OZON", incomplete),
    (error) => error?.status === 422
      && error?.code === "OZON_COLLECT_INCOMPLETE"
      && assert.deepEqual(error.missingFields, ["weightG", "widthMm", "heightMm"]) === undefined,
  );
});

test("Ozon completeness gate recognizes fields merged into a collection payload", () => {
  assert.doesNotThrow(() => assertCompleteOzonCollectPayload("ozon", {
    descriptionCategoryId: 123,
    weight: 500,
    depth: 300,
    width: 200,
    height: 100,
  }));
});

test("Ozon completeness gate accepts the extension collection field contract", () => {
  assert.doesNotThrow(() => assertCompleteOzonCollectPayload("ozon", {
    description_category_id: 123,
    weight: 500,
    depth: 300,
    width: 200,
    height: 100,
    weight_unit: "g",
    dimension_unit: "mm",
  }));
});

test("Ozon completeness gate does not accept retired logistics aliases", () => {
  const payload = {
    descriptionCategoryId: 123,
    packageWeight: 500,
    length: 300,
    packageLength: 300,
    packageWidth: 200,
    packageHeight: 100,
  };
  assert.deepEqual(
    missingOzonRequiredFields(payload),
    ["weightG", "lengthMm", "widthMm", "heightMm"],
  );
  assert.throws(
    () => assertCompleteOzonCollectPayload("ozon", payload),
    (error) => error?.status === 422
      && error?.code === "OZON_COLLECT_INCOMPLETE"
      && assert.deepEqual(
        error.missingFields,
        ["weightG", "lengthMm", "widthMm", "heightMm"],
      ) === undefined,
  );
});

test("single enrichment requests accept only requestId and sku", () => {
  assert.deepEqual(
    parseOzonEnrichmentRequest({ requestId: " request-1 ", sku: " 4862904234 " }),
    { requestId: "request-1", sku: "4862904234" },
  );
  for (const body of [
    {},
    { requestId: "request-1" },
    { sku: "4862904234" },
    { requestId: "request-1", sku: "4862904234", forceRefresh: true },
  ]) {
    assert.throws(
      () => parseOzonEnrichmentRequest(body),
      (error) => error?.status === 400 && /^OZON_ENRICH_/.test(error?.code || ""),
    );
  }
});

test("batch enrichment requests preserve first-seen SKUs and cap unique values at twenty", () => {
  assert.deepEqual(
    parseOzonBatchEnrichmentRequest({ requestId: "batch-1", skus: ["4862904234", "4862904235", "4862904234"] }),
    { requestId: "batch-1", skus: ["4862904234", "4862904235"] },
  );
  const twentySkus = Array.from({ length: 20 }, (_, index) => String(index + 1));
  assert.deepEqual(
    parseOzonBatchEnrichmentRequest({
      requestId: "batch-20",
      skus: [twentySkus[0], ...twentySkus, twentySkus[19]],
    }),
    { requestId: "batch-20", skus: twentySkus },
  );
  assert.throws(
    () => parseOzonBatchEnrichmentRequest({
      requestId: "batch-2",
      skus: Array.from({ length: 21 }, (_, index) => String(index + 1)),
    }),
    (error) => error?.status === 400 && error?.code === "OZON_ENRICH_BATCH_LIMIT",
  );
  assert.throws(
    () => parseOzonBatchEnrichmentRequest({ skus: ["4862904234"] }),
    (error) => error?.status === 400 && /^OZON_ENRICH_/.test(error?.code || ""),
  );
});

test("enrichment request parsers reject every retired collector scope-field spelling", async (t) => {
  for (const key of RETIRED_SCOPE_KEY_SPELLINGS) {
    await t.test(key, () => {
      const forbidden = { nested: [{ [key]: "attacker-controlled" }] };
      assert.throws(
        () => parseOzonEnrichmentRequest({ requestId: "request-1", sku: "4862904234", ...forbidden }),
        (error) => error?.status === 400 && error?.code === "COLLECTOR_SCOPE_FIELD_FORBIDDEN",
      );
      assert.throws(
        () => parseOzonBatchEnrichmentRequest({ requestId: "batch-1", skus: ["4862904234"], ...forbidden }),
        (error) => error?.status === 400 && error?.code === "COLLECTOR_SCOPE_FIELD_FORBIDDEN",
      );
    });
  }
});
