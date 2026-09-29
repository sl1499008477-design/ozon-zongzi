import assert from "node:assert/strict";
import test from "node:test";
import {
  createJsonAccountSharedOzonCategoryRepository,
  createPostgresAccountSharedOzonCategoryRepository,
} from "../account-shared-ozon-category-repository.mjs";
import { createAccountSharedOzonCategoryService } from "../account-shared-ozon-category-service.mjs";

const CAPTURED_AT = "2026-08-12T01:02:03.000Z";
const HASH = "ab".repeat(32);
const LONG_DESCRIPTION = `${"历史商品说明".repeat(120)}\n第二行`;

function evidence(suffix = "a", accountId = "account-a") {
  return {
    accountId, collectItemId: `collect-${suffix}`, sourceVersion: "draft:7",
    productDraftId: `draft-${suffix}`, productDraftVersion: 7,
    ozonProductId: 123456789, sourceSku: `SKU-${suffix}`, taxonomyScope: "OZON:DEFAULT",
    sourceDescriptionCategoryId: 17028702, sourceTypeId: 94405,
    normalizedPath: ["Home", "Cups"],
    attributeSummary: [{ key: "8229", value: "Cup", dictionaryValueId: 94405 }],
    provenance: {
      accountId, collectItemId: `collect-${suffix}`, sourceKind: "PRODUCT_DRAFT",
      sourceRecordId: `draft-${suffix}`, rawResponseRef: `raw-${suffix}`,
      rawResponseHash: HASH, capturedAt: CAPTURED_AT,
    },
    capturedAt: CAPTURED_AT, rawResponseRef: `raw-${suffix}`, rawResponseHash: HASH,
  };
}

function postgresRow(input, id = `evidence-${input.collectItemId}`) {
  return {
    id, account_id: input.accountId, collect_item_id: input.collectItemId,
    source_kind: "PRODUCT_DRAFT", source_record_id: input.productDraftId,
    source_version: input.sourceVersion, product_draft_id: input.productDraftId,
    enrichment_source: null, enrichment_sku: null, enrichment_contract_version: null,
    source_description_category_id: String(input.sourceDescriptionCategoryId),
    source_type_id: String(input.sourceTypeId), taxonomy_scope: input.taxonomyScope,
    captured_at: new Date(CAPTURED_AT), raw_response_hash: HASH,
    raw_response_ref: input.rawResponseRef, product_raw_response_ref: input.rawResponseRef,
    lookup_evidence_id: null, created_at: new Date(CAPTURED_AT),
    provenance: { ...input.provenance, categoryEvidence: structuredClone(input) },
  };
}

function jsonState(rows) {
  return {
    collectOzonCategorySourceEvidence: rows,
    collectOzonCategoryCurrentSources: rows.map((row) => ({
      accountId: row.accountId, collectItemId: row.collectItemId, evidenceId: row.id,
      sourceKind: "PRODUCT_DRAFT", sourceRecordId: row.productDraftId, sourceVersion: row.sourceVersion,
    })),
    accountOzonSharedCategories: [{
      id: "shared-a", accountId: "account-a", sourceDescriptionCategoryId: 17028702,
      sourceTypeId: 94405, taxonomyScope: "OZON:DEFAULT",
      currentDescriptionCategoryId: 17028654, currentTypeId: 971445831,
      status: "ACTIVE", source: "OZON_REFRESH", taxonomyFingerprint: HASH,
      version: 4, evidenceId: "evidence-a", validatedAt: CAPTURED_AT,
    }],
    accountOzonSharedCategoryEvents: [], collectOzonCategoryLookupEvidence: [],
    collectOzonCategoryManualConfirmationEvidence: [],
  };
}

const legacyShapes = [
  ["missing optional metadata", (row) => {
    delete row.normalizedPath;
    delete row.attributeSummary;
    delete row.provenance;
  }],
  ["older metadata containers", (row) => {
    row.normalizedPath = "Home / Cups";
    row.attributeSummary = { "8229": "Cup" };
    row.provenance = "migrated from sourceCategory";
  }],
  ["extra fields and long descriptions", (row) => {
    row.rawVendorSecret = "private-vendor-token";
    row.normalizedPath = ["Home", "Cups".repeat(60)];
    row.attributeSummary = [{ key: "description", value: LONG_DESCRIPTION,
      rawVendorSecret: "private-vendor-token" }];
    row.provenance.canonicalPath = "data.sourceCategory";
    row.provenance.rawVendorSecret = "private-vendor-token";
  }],
];

for (const [shape, makeLegacy] of legacyShapes) {
  for (const backend of ["JSON", "PostgreSQL"]) {
    test(`${backend} batch reads tolerate ${shape} and preserve category identity`, async () => {
      const valid = { id: "evidence-a", ...evidence("a") };
      const legacy = { id: "evidence-b", ...evidence("b") };
      const rows = [postgresRow(evidence("a"), valid.id), postgresRow(evidence("b"), legacy.id)];
      makeLegacy(legacy);
      makeLegacy(rows[1].provenance.categoryEvidence);
      const state = jsonState([valid, legacy]);
      const before = structuredClone(state);
      const repository = backend === "JSON"
        ? createJsonAccountSharedOzonCategoryRepository({ state, persist: async () => {
          assert.fail("an initialized evidence read must not persist or migrate data");
        } })
        : createPostgresAccountSharedOzonCategoryRepository({ pool: { async query(sql, params) {
          assert.match(sql, /current_source.account_id=\$1/u);
          assert.deepEqual(params, ["account-a", ["collect-a", "collect-b"]]);
          return { rows };
        } } });

      const result = await repository.readCurrentEvidence({
        accountId: "account-a", collectItemIds: ["collect-a", "collect-b"],
      });

      assert.deepEqual(result.map((row) => [row.id, row.accountId, row.collectItemId,
        row.sourceDescriptionCategoryId, row.sourceTypeId, row.sourceVersion, row.productDraftVersion]), [
        ["evidence-a", "account-a", "collect-a", 17028702, 94405, "draft:7", 7],
        ["evidence-b", "account-a", "collect-b", 17028702, 94405, "draft:7", 7],
      ]);
      if (shape === "extra fields and long descriptions") {
        assert.deepEqual(result[1].attributeSummary, [{ key: "description", value: LONG_DESCRIPTION }]);
        assert.equal(result[1].normalizedPath[1], "Cups".repeat(60));
      } else {
        assert.deepEqual(result[1].normalizedPath, []);
        assert.deepEqual(result[1].attributeSummary, []);
      }
      assert.equal(result[1].provenance.accountId, "account-a");
      assert.equal(result[1].provenance.collectItemId, "collect-b");
      assert.ok(Object.isFrozen(result[1].provenance));
      assert.ok(Object.isFrozen(result[1].attributeSummary));
      assert.ok(Object.isFrozen(result));
      assert.doesNotMatch(JSON.stringify(result), /private-vendor-token|canonicalPath/u);
      assert.deepEqual(state, before);
      assert.equal(Object.isFrozen(legacy.provenance), typeof legacy.provenance !== "object");
    });
  }
}

test("JSON service resolves a mixed historical batch without validating unrelated accounts or rewriting state", async () => {
  const current = { id: "evidence-a", ...evidence("a") };
  const legacy = { id: "evidence-b", ...evidence("b") };
  delete legacy.provenance;
  delete legacy.attributeSummary;
  delete legacy.normalizedPath;
  const unrelated = { id: "foreign", ...evidence("c", "account-b"),
    sourceTypeId: 0, sourceVersion: null, attributeSummary: null };
  const state = jsonState([current, legacy, unrelated]);
  const before = structuredClone(state);
  const repository = createJsonAccountSharedOzonCategoryRepository({ state, persist: async () => {
    assert.fail("reading existing data must not write it");
  } });
  const service = createAccountSharedOzonCategoryService({ repository });

  const result = await service.readForItems({
    accountId: "account-a", collectItemIds: ["collect-a", "collect-b", "collect-c"],
  });

  assert.deepEqual(result.map(({ collectItemId, categoryResolution }) => [collectItemId,
    categoryResolution.currentDescriptionCategoryId, categoryResolution.currentTypeId,
    categoryResolution.version]), [
    ["collect-a", 17028654, 971445831, 4], ["collect-b", 17028654, 971445831, 4],
  ]);
  assert.deepEqual(state, before);
});

test("PostgreSQL columns override conflicting embedded identities and observation metadata", async () => {
  const row = postgresRow(evidence());
  row.provenance.categoryEvidence = evidence("foreign", "account-foreign");
  Object.assign(row.provenance.categoryEvidence, {
    sourceVersion: "draft:999", productDraftVersion: 999,
    sourceDescriptionCategoryId: 999999, sourceTypeId: 888888,
  });
  const repository = createPostgresAccountSharedOzonCategoryRepository({
    pool: { query: async () => ({ rows: [row] }) },
  });
  const [result] = await repository.readCurrentEvidence({ accountId: "account-a", collectItemIds: ["collect-a"] });
  assert.deepEqual([result.accountId, result.collectItemId, result.productDraftId,
    result.productDraftVersion, result.sourceVersion, result.sourceDescriptionCategoryId,
    result.sourceTypeId, result.rawResponseRef], [
    "account-a", "collect-a", "draft-a", 7, "draft:7", 17028702, 94405, "raw-a",
  ]);
  assert.deepEqual(result.provenance, {
    accountId: "account-a", collectItemId: "collect-a", sourceKind: "PRODUCT_DRAFT",
    sourceRecordId: "draft-a", rawResponseRef: "raw-a", rawResponseHash: HASH, capturedAt: CAPTURED_AT,
  });
});

for (const sourceKind of ["OZON_READ_LOOKUP", "MANUAL_CONFIRMATION"]) {
  test(`PostgreSQL reads ${sourceKind} without the modern categoryEvidence envelope`, async () => {
    const row = postgresRow(evidence());
    Object.assign(row, { source_kind: sourceKind, source_record_id: "saved-observation",
      source_version: "saved-observation:v1", product_draft_id: null, provenance: {
        sourceKind, sourceRecordId: "saved-observation", canonicalPath: "historical.shape",
      } });
    const repository = createPostgresAccountSharedOzonCategoryRepository({
      pool: { query: async () => ({ rows: [row] }) },
    });
    const [result] = await repository.readCurrentEvidence({ accountId: "account-a", collectItemIds: ["collect-a"] });
    assert.deepEqual([result.sourceDescriptionCategoryId, result.sourceTypeId, result.sourceVersion,
      result.productDraftId, result.productDraftVersion, result.provenance.sourceKind],
    [17028702, 94405, "saved-observation:v1", null, null, sourceKind]);
  });
}

test("JSON legacy pointer backfill and new evidence writes tolerate missing optional provenance", async () => {
  const legacy = { id: "evidence-a", ...evidence("a") };
  delete legacy.provenance;
  delete legacy.normalizedPath;
  delete legacy.attributeSummary;
  const state = jsonState([legacy]);
  delete state.collectOzonCategoryCurrentSources;
  const repository = createJsonAccountSharedOzonCategoryRepository({ state });
  const [read] = await repository.readCurrentEvidence({ accountId: "account-a", collectItemIds: ["collect-a"] });
  assert.equal(read.id, "evidence-a");
  assert.equal(read.provenance.sourceRecordId, "draft-a");
  const written = await repository.recordSourceEvidence(evidence("b"));
  assert.equal(written.evidence.collectItemId, "collect-b");
  assert.equal(state.collectOzonCategorySourceEvidence.length, 2);
  assert.deepEqual(state.collectOzonCategorySourceEvidence[0], legacy);
});

test("stored category IDs are never invented from optional provenance", async () => {
  for (const invalidId of [0, null, "not-an-id", true, [94405]]) {
    const row = postgresRow(evidence());
    row.source_type_id = invalidId;
    const postgres = createPostgresAccountSharedOzonCategoryRepository({
      pool: { query: async () => ({ rows: [row] }) },
    });
    const json = createJsonAccountSharedOzonCategoryRepository({
      state: jsonState([{ id: "evidence-a", ...evidence(), sourceTypeId: invalidId }]),
    });
    for (const repository of [json, postgres]) {
      await assert.rejects(repository.readCurrentEvidence({ accountId: "account-a", collectItemIds: ["collect-a"] }),
        { code: "ZONGZI_CATEGORY_PERSISTENCE_FAILED" });
    }
  }
});

test("new evidence and manual confirmations keep their strict public trust boundaries", async () => {
  const state = jsonState([]);
  const repositories = [createJsonAccountSharedOzonCategoryRepository({ state, persist: async () => {
    assert.fail("invalid evidence must not persist");
  } }), createPostgresAccountSharedOzonCategoryRepository({ pool: { query: async () => {
    assert.fail("invalid evidence must not reach SQL");
  } } })];
  const forged = evidence();
  forged.provenance.accountId = "account-other";
  const inputs = legacyShapes.map(([, mutate]) => {
    const input = evidence();
    mutate(input);
    return input;
  });
  inputs.push(forged, { ...evidence(), sourceTypeId: 0 });
  for (const repository of repositories) {
    for (const input of inputs) {
      await assert.rejects(repository.recordSourceEvidence(input),
        { code: "ACCOUNT_SHARED_ZONGZI_CATEGORY_CONTRACT_INVALID" });
    }
    await assert.rejects(repository.confirmManualCategory({
      accountId: "account-a", collectItemId: "collect-a", expectedSourceVersion: "draft:7",
      currentDescriptionCategoryId: 17028702, currentTypeId: 94405,
      taxonomyFingerprint: HASH, validatedAt: CAPTURED_AT, actorId: "account-other",
      correlationId: "manual-1", idempotencyKey: "manual-1", requestHash: HASH,
    }), { code: "ACCOUNT_SHARED_ZONGZI_CATEGORY_CONTRACT_INVALID" });
  }
  assert.equal(state.collectOzonCategorySourceEvidence.length, 0);
});
