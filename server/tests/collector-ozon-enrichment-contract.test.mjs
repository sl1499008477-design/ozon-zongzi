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
  assertOzonListingLogisticsReady,
  assertOzonListingReady,
  buildOzonEnrichmentSummary,
  mergeOzonEnrichmentResult,
  normalizeOzonCollectedSourceEvidence,
  preserveOzonSourceCategoryEvidence,
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

test("target category fields cannot satisfy source-category enrichment readiness", () => {
  const targetOnly = {
    descriptionCategoryId: 700,
    description_category_id: 700,
    categoryResolution: {
      target: { descriptionCategoryId: 700, typeId: 701 },
    },
    weight: 500,
    depth: 300,
    width: 200,
    height: 100,
  };

  assert.deepEqual(buildOzonEnrichmentSummary(targetOnly).missingFields, [
    "descriptionCategoryId",
  ]);
  assert.throws(
    () => assertOzonListingReady(targetOnly),
    (error) => error?.code === "COLLECT_ENRICHMENT_INCOMPLETE"
      && assert.deepEqual(error.missingFields, ["descriptionCategoryId"]) === undefined,
  );
});

test("idempotent listing replay checks current logistics without requiring source-category evidence again", () => {
  const logisticsOnly = { weight: 500, depth: 300, width: 200, height: 100 };
  assert.doesNotThrow(() => assertOzonListingLogisticsReady(logisticsOnly));
  assert.throws(
    () => assertOzonListingLogisticsReady({ ...logisticsOnly, width: 0 }),
    (error) => error?.code === "COLLECT_ENRICHMENT_INCOMPLETE"
      && assert.deepEqual(error.missingFields, ["widthMm"]) === undefined,
  );
});

test("Ozon ingress promotes legacy root category aliases into source evidence and removes target-shaped roots", async (t) => {
  for (const [name, payload] of [
    ["snake case", { description_category_id: 123, type_id: 456 }],
    ["camel case", { descriptionCategoryId: 123, typeId: 456 }],
  ]) {
    await t.test(name, () => {
      const normalized = normalizeOzonCollectedSourceEvidence({
        sku: "4862904234",
        ...payload,
      });

      assert.deepEqual(normalized.sourceCategory, {
        descriptionCategoryId: 123,
        typeIdCandidate: 456,
      });
      for (const field of [
        "description_category_id",
        "descriptionCategoryId",
        "type_id",
        "typeId",
      ]) assert.equal(Object.hasOwn(normalized, field), false, field);
    });
  }
});

test("Ozon ingress promotes Seller attribute 8229 into canonical source type evidence", () => {
  const normalized = normalizeOzonCollectedSourceEvidence({
    sku: "2916074139",
    variantData: {
      description_category_id: 17_033_980,
      attributes: [
        {
          key: "8229",
          value: "Светильник с датчиком движения",
          dictionary_value_id: 91_637,
        },
      ],
    },
  });

  assert.deepEqual(normalized.sourceCategory, {
    descriptionCategoryId: 17_033_980,
    typeName: "Светильник с датчиком движения",
    typeIdCandidate: 91_637,
    attributes: [
      {
        key: "8229",
        value: "Светильник с датчиком движения",
        dictionary_value_id: 91_637,
      },
    ],
  });
});

test("Ozon ingress repairs historical source category type evidence from attribute 8229", () => {
  const normalized = normalizeOzonCollectedSourceEvidence({
    sku: "2916074139",
    sourceCategory: {
      descriptionCategoryId: 17_033_980,
      attributes: [
        {
          key: "8229",
          value: "Настольный светильник",
          dictionary_value_id: 91_637,
        },
      ],
    },
  });

  assert.equal(normalized.sourceCategory.typeName, "Настольный светильник");
  assert.equal(normalized.sourceCategory.typeIdCandidate, 91_637);
});

test("Ozon ingress keeps only a canonical buyer category URL from the public product breadcrumb", () => {
  const valid = normalizeOzonCollectedSourceEvidence({
    buyerCategoryUrl: "https://www.ozon.ru/category/nabory-skladnoy-mebeli-11504/?at=tracking#fragment",
  });
  assert.equal(
    valid.buyerCategoryUrl,
    "https://www.ozon.ru/category/nabory-skladnoy-mebeli-11504/",
  );
  for (const buyerCategoryUrl of [
    "https://www.ozon.ru/category/17029005/",
    "https://attacker.test/category/nabory-skladnoy-mebeli-11504/",
    "https://www.ozon.ru/category/nabory-skladnoy-mebeli-11504/mqouo-101091944/",
  ]) {
    const normalized = normalizeOzonCollectedSourceEvidence({ buyerCategoryUrl });
    assert.equal(Object.hasOwn(normalized, "buyerCategoryUrl"), false, buyerCategoryUrl);
  }
});

test("source-category merge replaces invalid IDs and deterministically extends partial evidence arrays", () => {
  const merged = mergeOzonEnrichmentResult({
    descriptionCategoryId: 700,
    sourceCategory: {
      descriptionCategoryId: 0,
      path: ["Root"],
      attributes: [{ key: "85", value: "Existing brand" }],
    },
    logistics: { weightG: 500, lengthMm: 300, widthMm: 200, heightMm: 100 },
  }, completeResult({
    sourceCategory: {
      descriptionCategoryId: 123,
      path: ["Root", "Leaf"],
      attributes: [
        { key: "85", value: "Incoming brand must not overwrite" },
        { key: "8229", value: "Source type" },
      ],
    },
  }));

  assert.equal(merged.descriptionCategoryId, 700, "the target category remains user-owned");
  assert.equal(merged.sourceCategory.descriptionCategoryId, 123);
  assert.deepEqual(merged.sourceCategory.path, ["Root", "Leaf"]);
  assert.deepEqual(merged.sourceCategory.attributes, [
    { key: "85", value: "Existing brand" },
    { key: "8229", value: "Source type" },
  ]);
  assert.deepEqual(buildOzonEnrichmentSummary(merged).missingFields, []);
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
  assert.equal(merged.descriptionCategoryId, true);
  assert.equal(merged.sourceCategory.descriptionCategoryId, 123);
  assert.deepEqual(merged.logistics, {
    weightG: 500,
    lengthMm: 300,
    widthMm: 200,
    heightMm: 100,
  });
});

test("enrichment policy retains retry state without allowing it to change completeness", () => {
  assert.deepEqual(buildOzonEnrichmentSummary({
    sourceCategory: { descriptionCategoryId: 123 },
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
      sourceCategory: { descriptionCategoryId: 123 },
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
    attributes: [
      { key: "8229", value: "Заварочный чайник", dictionary_value_id: 123456 },
      { key: "4497", value: "500" },
      { key: "9454", value: "300" },
      { key: "9455", value: "200" },
      { key: "9456", value: "100" },
    ],
  });
});

test("normalization falls back to top-level Seller type evidence", () => {
  const normalized = normalizeOzonAgentResult({
    sku: "4862904234",
    source: "LOCAL_SELLER",
    capturedAt: "2026-08-01T00:00:00.000Z",
    variantData: completeVariantData({
      type_id: 7654321,
    }),
  });
  assert.equal(normalized.sourceCategory.typeIdCandidate, 7654321);
});

test("user draft replacement preserves authoritative Seller source evidence", () => {
  const current = {
    sourceCategory: {
      descriptionCategoryId: 17039736,
      typeName: "Seller source",
      typeIdCandidate: 123456,
      attributes: [{ key: "8229", value: "Seller source" }],
    },
    categoryResolution: {
      status: "MATCHED",
      source: { descriptionCategoryId: 0 },
      target: { descriptionCategoryId: 880001, typeId: 990001 },
    },
  };
  const next = preserveOzonSourceCategoryEvidence(current, {
    descriptionCategoryId: 880001,
    typeId: 990001,
    categoryResolution: {
      status: "MATCHED",
      source: {},
      target: { descriptionCategoryId: 880002, typeId: 990002 },
    },
  });
  assert.deepEqual(next.sourceCategory, current.sourceCategory);
  assert.deepEqual(next.categoryResolution.source, current.sourceCategory);
  assert.deepEqual(next.categoryResolution.target, {
    descriptionCategoryId: 880002,
    typeId: 990002,
  });
  assert.equal(next.descriptionCategoryId, 880001);
  assert.equal(next.typeId, 990001);
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
    sourceCategory: { descriptionCategoryId: 123 },
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
    sourceCategory: { descriptionCategoryId: 123 },
    weight: 500,
    depth: 300,
    width: 200,
    height: 100,
  }));
});

test("collection ingress promotes the extension source category before the strict completeness gate", () => {
  const rawPayload = {
    description_category_id: 123,
    weight: 500,
    depth: 300,
    width: 200,
    height: 100,
    weight_unit: "g",
    dimension_unit: "mm",
  };
  assert.throws(
    () => assertCompleteOzonCollectPayload("ozon", rawPayload),
    (error) => error?.code === "OZON_COLLECT_INCOMPLETE"
      && assert.deepEqual(error.missingFields, ["descriptionCategoryId"]) === undefined,
  );
  assert.doesNotThrow(() => assertCompleteOzonCollectPayload(
    "ozon",
    normalizeOzonCollectedSourceEvidence(rawPayload),
  ));
});

test("Ozon completeness gate accepts canonical listing package fields", () => {
  const payload = {
    sourceCategory: { descriptionCategoryId: 123 },
    packageWeight: 500,
    length: 300,
    packageLength: 300,
    packageWidth: 200,
    packageHeight: 100,
  };
  assert.deepEqual(missingOzonRequiredFields(payload), []);
  assert.doesNotThrow(() => assertCompleteOzonCollectPayload("ozon", payload));
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
