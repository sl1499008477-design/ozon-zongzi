import assert from "node:assert/strict";
import test from "node:test";
import { createAutoListingService as createProductionAutoListingService } from "../auto-listing-service.mjs";
import { createAutoListingRepository } from "../auto-listing-repository.mjs";
import { createAutoListingRfbsWarehouseVerifier } from "../auto-listing-rfbs-warehouse-verifier.mjs";
import { buildAutoListingSourceSnapshot } from "../auto-listing-source-snapshot.mjs";
import {
  normalizeAndHashAutoListingConfig,
  verifyAutoListingFrozenConfig,
} from "../auto-listing-contract.mjs";
import { deriveEffectiveAutoListingImageConfig } from "../auto-listing-item-image-config.mjs";

const actor = { id: "account-a", role: "user" };
const config = {
  targetStoreId: "store-a",
  targetWarehouseId: "warehouse-a",
  stock: 5,
  priceAdjustmentKopecks: "0",
};

function repositoryListingBaseTemplate(id) {
  const image = `https://source.example.test/${id}.jpg`;
  return {
    productDraft: { id: `draft-${id}`, version: 1, dataHash: "1".repeat(64) },
    pricingEvidence: {
      currency: "RUB", currencySource: "SOURCE", blackKopecks: "10000", greenKopecks: "8000",
      evidenceHash: "4c6f549e1668186515248caffeb08fe2f9ba91ca1dab9edbdd8d159aa2b11bf8",
    },
    richContentAttributeSupported: true,
    variants: [{
      sourceVariantId: id, sourceSku: `sku-${id}`,
      item: {
        offer_id: `offer-${id}`, name: `Product ${id}`, price: "100.00", currency_code: "RUB",
        description_category_id: 123, type_id: 456, primary_image: image, images: [image],
        weight: 100, weight_unit: "g", depth: 100, width: 100, height: 100, dimension_unit: "mm",
        attributes: [{ id: 85, complex_id: 0, values: [{ value: "No brand" }] }],
      },
    }],
    versions: { normalizerVersion: "v3", categoryRuleVersion: "v1", dictionaryVersion: "live" },
  };
}

const source = (id, price = { blackKopecks: "10000", greenKopecks: "8000" }) => ({
  id,
  accountId: "account-a",
  sourceVersion: "3",
  rawResponseRef: `raw-${id}`,
  categoryEvidence: {
    id: `evidence-${id}`, accountId: "account-a", sourceDescriptionCategoryId: 123,
    sourceTypeId: 456, taxonomyScope: "OZON:DEFAULT",
  },
  sharedCategory: {
    id: "shared-123-456", accountId: "account-a", version: 1,
    evidenceId: `evidence-${id}`, status: "ACTIVE", source: "SOURCE_DIRECT",
    sourceDescriptionCategoryId: 123, sourceTypeId: 456,
    currentDescriptionCategoryId: 123, currentTypeId: 456,
    taxonomyScope: "OZON:DEFAULT", taxonomyFingerprint: null,
  },
  collectItem: {
    id,
    accountId: "account-a",
    sku: `sku-${id}`,
    listingDraft: {
      sku: `sku-${id}`,
      offerId: `offer-${id}`,
      title: `Product ${id}`,
      categoryResolution: {
        status: "MATCHED",
        method: "taxonomy",
        target: { storeId: "store-a", descriptionCategoryId: "123", typeId: "456" },
        source: { path: ["root"] },
      },
      attributes: [], logistics: {}, productMeasurements: { reliable: true, length: 28, unit: "cm", source: "manufacturer" },
      currency: "RUB", images: [], variants: [{ sku: `sku-${id}`, offerId: `offer-${id}` }],
      ...price,
    },
  },
  productDraft: {
    id: `draft-${id}`, version: 3, dataHash: "1".repeat(64),
    normalizerVersion: "normalizer-v3", categoryRuleVersion: "category-v5", dictionaryVersion: "dictionary-live",
  },
});

const categoryAuthority = (id) => ({
  categoryEvidence: source(id).categoryEvidence,
  sharedCategory: source(id).sharedCategory,
});

const prepareListingBase = async ({ source: entry, pricingEvidence }) => ({
  productDraft: {
    id: entry.productDraft.id, version: entry.productDraft.version, dataHash: entry.productDraft.dataHash,
  },
  pricingEvidence: { ...pricingEvidence, evidenceHash: "2".repeat(64) },
  richContentAttributeSupported: true,
  variants: [{ sourceVariantId: entry.id, sourceSku: `sku-${entry.collectItemId || entry.id}`, item: { offer_id: entry.id } }],
  versions: {
    normalizerVersion: entry.productDraft.normalizerVersion,
    categoryRuleVersion: entry.productDraft.categoryRuleVersion,
    dictionaryVersion: entry.productDraft.dictionaryVersion,
  },
});

const forbiddenRfbsWarehouseVerifier = Object.freeze({
  async verifyRfbsWarehouse() {
    throw new Error("FBS flows must not invoke the RFBS verifier");
  },
});

const createAutoListingService = ({
  repository,
  rfbsWarehouseVerifier = forbiddenRfbsWarehouseVerifier,
  listingBasePreparer = prepareListingBase,
  ensureCategoryFresh = async () => ({ status: "CURRENT" }),
  selectPlanningContract,
}) => createProductionAutoListingService({
  repository,
  prepareListingBase: listingBasePreparer,
  rfbsWarehouseVerifier,
  ensureCategoryFresh,
  selectPlanningContract,
});

const frozenGraphConfig = () => {
  return normalizeAndHashAutoListingConfig(config);
};

const effectiveImageConfig = (frozen, captured) => deriveEffectiveAutoListingImageConfig({
  configSnapshot: frozen.config,
  configHash: frozen.configHash,
  sourceCapture: captured,
});

function fakeRepository({ sources = [source("collect-1")], existing = null } = {}) {
  const calls = [];
  const categoryLeaseController = new AbortController();
  let graph = existing;
  return {
    calls,
    categoryLeaseController,
    async loadCollectSources(input) { calls.push(["loadCollectSources", input]); return sources; },
    async acquireCategoryPreparationLease(input) {
      calls.push(["acquireCategoryPreparationLease", input]);
      return {
        leaseId: "category-lease-a",
        expiresAt: "2099-01-01T00:00:00.000Z",
        signal: categoryLeaseController.signal,
      };
    },
    async releaseCategoryPreparationLease(input) {
      calls.push(["releaseCategoryPreparationLease", input]);
      return { released: true };
    },
    async loadExcelImportContext(input) {
      calls.push(["loadExcelImportContext", input]);
      return {
        id: input.importFileId, accountId: input.accountId, status: "COLLECTING", statusVersion: 2,
        acceptedRows: sources.length, readyRows: sources.length, failedRows: 0,
        configSnapshot: normalizeAndHashAutoListingConfig(config).config,
        configHash: normalizeAndHashAutoListingConfig(config).configHash,
        idempotencyKey: `job-${input.importFileId}`, correlationId: `corr-${input.importFileId}`,
      };
    },
    async loadExcelImportSources(input) {
      calls.push(["loadExcelImportSources", input]);
      return {
        importFile: {
          id: input.importFileId, accountId: input.accountId, status: "COLLECTING", statusVersion: 2,
          acceptedRows: sources.length, readyRows: sources.length, failedRows: 0,
          configSnapshot: normalizeAndHashAutoListingConfig(config).config,
          configHash: normalizeAndHashAutoListingConfig(config).configHash,
          idempotencyKey: `job-${input.importFileId}`, correlationId: `corr-${input.importFileId}`,
        },
        sources: sources.map((entry, index) => ({ ...entry, id: `row-${index + 1}`, collectItemId: entry.id })),
      };
    },
    async loadTargetStore(input) { calls.push(["loadTargetStore", input]); return { id: "store-a", ownerAccountId: input.accountId, status: "active", clientId: "client-a", currencyCode: "RUB", currencySource: "OZON_SELLER_INFO", currencySyncedAt: "2026-08-13T00:00:00.000Z", credentialsSaved: true }; },
    async loadTargetWarehouse(input) { calls.push(["loadTargetWarehouse", input]); return { warehouse: { id: "warehouse-a", storeId: "store-a", accountId: input.accountId, warehouse_id: "1001", warehouse_type: "FBS", status: "active", is_active: true, is_archived: false }, products: [{ accountId: input.accountId, storeId: "store-a", warehouse_stocks: [{ warehouse_id: "1001", source: "fbs" }] }] }; },
    async loadPublishedStrategy(input) { calls.push(["loadPublishedStrategy", input]); return { strategyVersion: { strategyId: "strategy-a", strategyVersionId: "version-a" }, rules: [] }; },
    async loadPublishedUploadPolicies(input) {
      calls.push(["loadPublishedUploadPolicies", input]);
      return [{ id: "upload-policy-review-v1", accountId: input.accountId, version: 1, mode: "REVIEW",
        enabled: true, publishedBy: "admin-a", publishedAt: "2026-08-08T00:00:00.000Z" }];
    },
    async getJobByIdempotencyKey(input) { calls.push(["getJobByIdempotencyKey", input]); return null; },
    async createJobGraph(input) { calls.push(["createJobGraph", input]); if (graph) return { ...graph, duplicate: true }; graph = { ...input, id: "job-1", createdAt: "2026-08-04T00:00:00.000Z" }; return graph; },
    async getJob(input) { calls.push(["getJob", input]); return graph && input.accountId === "account-a" ? graph : null; },
    async listJobs(input) { calls.push(["listJobs", input]); return graph && input.accountId === "account-a" ? [graph] : []; },
  };
}

function rfbsWarehouseEvidence() {
  return {
    warehouse: {
      id: "warehouse-a", storeId: "store-a", accountId: "account-a", warehouse_id: "2001",
      warehouse_type: "RFBS", status: "active", is_active: true, is_archived: false,
    },
    products: [],
  };
}

function rfbsValidation(overrides = {}) {
  return Object.freeze({
    schemaVersion: "AUTO_LISTING_RFBS_WAREHOUSE_EVIDENCE_V1",
    accountId: "account-a",
    storeId: "store-a",
    warehouseRecordId: "warehouse-a",
    platformWarehouseId: "2001",
    fulfillmentType: "RFBS",
    status: "ACTIVE",
    outcome: "PASSED",
    observedAt: "2026-08-11T00:00:00.000Z",
    expiresAt: "2026-08-11T00:10:00.000Z",
    evidenceHash: "a".repeat(64),
    correlationId: "corr-rfbs",
    actorAccountId: "account-a",
    ...overrides,
  });
}

test("service requires an exact closed RFBS verifier dependency", () => {
  const repository = fakeRepository();
  for (const rfbsWarehouseVerifier of [
    null,
    {},
    { async verifyRfbsWarehouse() {}, async writeWarehouse() {} },
  ]) {
    assert.throws(
      () => createProductionAutoListingService({ repository, prepareListingBase, rfbsWarehouseVerifier }),
      { name: "TypeError", message: "Auto listing RFBS warehouse verifier dependency is required" },
    );
  }
});

for (const [label, verifierFactory] of [
  ["transparent object Proxy", () => new Proxy({ async verifyRfbsWarehouse() {} }, {})],
  ["callable method Proxy", () => ({
    verifyRfbsWarehouse: new Proxy(async () => {}, {}),
  })],
  ["revoked object Proxy", () => {
    const value = Proxy.revocable({ async verifyRfbsWarehouse() {} }, {});
    value.revoke();
    return value.proxy;
  }],
]) {
  test(`service rejects ${label} before any dependency call`, () => {
    const repository = fakeRepository();
    let prepareCalls = 0;
    assert.throws(
      () => createProductionAutoListingService({
        repository,
        prepareListingBase: async () => { prepareCalls += 1; },
        rfbsWarehouseVerifier: verifierFactory(),
      }),
      { name: "TypeError", message: "Auto listing RFBS warehouse verifier dependency is required" },
    );
    assert.deepEqual(repository.calls, []);
    assert.equal(prepareCalls, 0);
  });
}

test("service captures one ordinary verifier method against late dependency mutation", async () => {
  const repository = fakeRepository();
  repository.loadTargetWarehouse = async (input) => {
    repository.calls.push(["loadTargetWarehouse", input]);
    return rfbsWarehouseEvidence();
  };
  let originalCalls = 0;
  let replacementCalls = 0;
  const dependency = {
    async verifyRfbsWarehouse() {
      originalCalls += 1;
      return rfbsValidation();
    },
  };
  const service = createProductionAutoListingService({
    repository, prepareListingBase, rfbsWarehouseVerifier: dependency,
  });
  dependency.verifyRfbsWarehouse = async () => {
    replacementCalls += 1;
    throw new Error("late replacement must not run");
  };
  dependency.writeWarehouse = async () => { replacementCalls += 1; };

  await service.createAutoListingJob({
    actor, collectItemIds: ["collect-1"], idempotencyKey: "late-mutation", correlationId: "corr-rfbs", config,
  });

  assert.deepEqual({ originalCalls, replacementCalls }, { originalCalls: 1, replacementCalls: 0 });
});

test("RFBS zero-product job verifies once immediately before graph persistence and hands off evidence", async () => {
  const repository = fakeRepository();
  repository.loadTargetWarehouse = async (input) => {
    repository.calls.push(["loadTargetWarehouse", input]);
    return rfbsWarehouseEvidence();
  };
  const evidence = rfbsValidation();
  let verifyCalls = 0;
  const rfbsWarehouseVerifier = Object.freeze({
    async verifyRfbsWarehouse(input) {
      verifyCalls += 1;
      repository.calls.push(["verifyRfbsWarehouse", input]);
      return evidence;
    },
  });

  const listingBasePreparer = async (input) => {
    repository.calls.push(["prepareListingBase", input]);
    return prepareListingBase(input);
  };
  const result = await createAutoListingService({
    repository, rfbsWarehouseVerifier, listingBasePreparer,
  }).createAutoListingJob({
    actor, collectItemIds: ["collect-1"], idempotencyKey: "key-rfbs", correlationId: "corr-rfbs", config,
  });

  assert.equal(result.jobId, "job-1");
  assert.equal(verifyCalls, 1);
  const verifyIndex = repository.calls.findIndex(([name]) => name === "verifyRfbsWarehouse");
  const graphIndex = repository.calls.findIndex(([name]) => name === "createJobGraph");
  assert.equal(verifyIndex, graphIndex - 1);
  assert.equal(repository.calls[verifyIndex - 1][0], "prepareListingBase");
  assert.ok(repository.calls.findIndex(([name]) => name === "acquireCategoryPreparationLease") < verifyIndex - 1);
  assert.deepEqual(repository.calls[verifyIndex][1], {
    accountId: "account-a",
    actorAccountId: "account-a",
    targetStoreId: "store-a",
    targetWarehouseId: "warehouse-a",
    correlationId: "corr-rfbs",
    signal: repository.categoryLeaseController.signal,
  });
  assert.equal(repository.calls[graphIndex][1].warehouseValidation, evidence);
  assert.equal(repository.calls[graphIndex][1].warehouseValidation.fulfillmentType, "RFBS");
});

test("FBS keeps its product-association rule and never invokes the RFBS verifier", async () => {
  let verifyCalls = 0;
  const rfbsWarehouseVerifier = Object.freeze({
    async verifyRfbsWarehouse() { verifyCalls += 1; return rfbsValidation(); },
  });
  const associated = fakeRepository();
  await createAutoListingService({ repository: associated, rfbsWarehouseVerifier }).createAutoListingJob({
    actor, collectItemIds: ["collect-1"], idempotencyKey: "key-fbs", correlationId: "corr-fbs", config,
  });
  assert.equal(verifyCalls, 0);
  assert.equal(associated.calls.find(([name]) => name === "createJobGraph")[1].warehouseValidation, null);

  const empty = fakeRepository();
  empty.loadTargetWarehouse = async (input) => {
    empty.calls.push(["loadTargetWarehouse", input]);
    return { ...rfbsWarehouseEvidence(), warehouse: { ...rfbsWarehouseEvidence().warehouse, warehouse_type: "FBS" } };
  };
  await assert.rejects(
    createAutoListingService({ repository: empty, rfbsWarehouseVerifier }).createAutoListingJob({
      actor, collectItemIds: ["collect-1"], idempotencyKey: "key-fbs-empty", correlationId: "corr-fbs", config,
    }),
    (error) => error?.code === "LISTING_WAREHOUSE_NOT_ELIGIBLE"
      && error?.body?.reason === "NO_ACTIVE_PRODUCT_ASSOCIATION",
  );
  assert.equal(verifyCalls, 0);
  assert.equal(empty.calls.some(([name]) => name === "createJobGraph"), false);
});

test("FBO and FBP jobs are rejected locally before verifier or graph persistence", async () => {
  for (const type of ["FBO", "FBP"]) {
    let verifyCalls = 0;
    const repository = fakeRepository();
    repository.loadTargetWarehouse = async (input) => {
      repository.calls.push(["loadTargetWarehouse", input]);
      return { ...rfbsWarehouseEvidence(), warehouse: { ...rfbsWarehouseEvidence().warehouse, warehouse_type: type } };
    };
    const rfbsWarehouseVerifier = Object.freeze({
      async verifyRfbsWarehouse() { verifyCalls += 1; return rfbsValidation(); },
    });
    await assert.rejects(
      createAutoListingService({ repository, rfbsWarehouseVerifier }).createAutoListingJob({
        actor, collectItemIds: ["collect-1"], idempotencyKey: `key-${type}`, correlationId: "corr-unsupported", config,
      }),
      (error) => error?.code === "LISTING_WAREHOUSE_NOT_ELIGIBLE"
        && error?.body?.reason === "UNSUPPORTED_FULFILLMENT_TYPE",
    );
    assert.equal(verifyCalls, 0);
    assert.equal(repository.calls.some(([name]) => name === "createJobGraph"), false);
  }
});

test("every stable RFBS verification failure leaves graph persistence unreachable", async () => {
  for (const code of [
    "RFBS_WAREHOUSE_NOT_FOUND",
    "RFBS_WAREHOUSE_DISABLED",
    "RFBS_WAREHOUSE_SCOPE_MISMATCH",
    "RFBS_WAREHOUSE_CHANGED",
    "RFBS_WAREHOUSE_EVIDENCE_EXPIRED",
    "RFBS_VALIDATION_REQUIRED",
    "AUTO_LISTING_RFBS_VALIDATION_FAILED",
  ]) {
    let graphWrites = 0;
    const repository = fakeRepository();
    repository.loadTargetWarehouse = async (input) => {
      repository.calls.push(["loadTargetWarehouse", input]);
      return rfbsWarehouseEvidence();
    };
    repository.createJobGraph = async () => {
      graphWrites += 1;
      throw new Error("graph persistence must remain unreachable");
    };
    const rfbsWarehouseVerifier = Object.freeze({
      async verifyRfbsWarehouse() {
        const failure = new Error("safe RFBS verification failure");
        failure.code = code;
        failure.retryable = code === "RFBS_VALIDATION_REQUIRED";
        throw failure;
      },
    });

    await assert.rejects(
      createAutoListingService({ repository, rfbsWarehouseVerifier }).createAutoListingJob({
        actor, collectItemIds: ["collect-1"], idempotencyKey: `failure-${code}`, correlationId: "corr-failure", config,
      }),
      (error) => error?.code === code && !/credential|api.?key|secret/iu.test(error.message),
    );
    assert.equal(graphWrites, 0);
  }
});

test("RFBS verification failure uses only the read-only Ozon warehouse endpoint before zero graph writes", async () => {
  const repository = fakeRepository();
  repository.loadTargetWarehouse = async (input) => {
    repository.calls.push(["loadTargetWarehouse", input]);
    return rfbsWarehouseEvidence();
  };
  let graphWrites = 0;
  repository.createJobGraph = async () => {
    graphWrites += 1;
    throw new Error("graph persistence must remain unreachable");
  };
  const ozonCalls = [];
  const rfbsWarehouseVerifier = createAutoListingRfbsWarehouseVerifier({
    async loadTarget() { return rfbsWarehouseEvidence().warehouse; },
    async readCredential() {
      return { id: "store-a", accountId: "account-a", clientId: "client-a", apiKey: "test-only-key" };
    },
    async callOzonSellerApi(_credential, path, body) {
      ozonCalls.push({ path, body });
      return { result: [] };
    },
    now: () => new Date("2026-08-11T00:00:00.000Z"),
  });

  await assert.rejects(
    createAutoListingService({ repository, rfbsWarehouseVerifier }).createAutoListingJob({
      actor, collectItemIds: ["collect-1"], idempotencyKey: "failure-read-only", correlationId: "corr-read-only", config,
    }),
    { code: "RFBS_WAREHOUSE_NOT_FOUND" },
  );
  assert.deepEqual(ozonCalls, [{ path: "/v2/warehouse/list", body: {} }]);
  assert.equal(ozonCalls.filter(({ path }) => path !== "/v2/warehouse/list").length, 0);
  assert.equal(graphWrites, 0);
});

test("RFBS idempotent and conflicting replays return the original job before revalidation or binding changes", async () => {
  const repository = fakeRepository({ existing: { id: "job-original", status: "CREATED", sourceType: "COLLECT_BOX", items: [] } });
  repository.getJobByIdempotencyKey = async (input) => {
    repository.calls.push(["getJobByIdempotencyKey", input]);
    return { id: "job-original", status: "CREATED", sourceType: "COLLECT_BOX", warehouseValidationEvidenceId: "evidence-original", items: [] };
  };
  let verifyCalls = 0;
  const rfbsWarehouseVerifier = Object.freeze({
    async verifyRfbsWarehouse() { verifyCalls += 1; return rfbsValidation(); },
  });
  const service = createAutoListingService({ repository, rfbsWarehouseVerifier });

  const replay = await service.createAutoListingJob({
    actor, collectItemIds: ["collect-1"], idempotencyKey: "replay-rfbs", correlationId: "corr-rfbs", config,
  });
  const conflicting = await service.createAutoListingJob({
    actor, collectItemIds: ["different-source"], idempotencyKey: "replay-rfbs", correlationId: "different-correlation",
    config: { ...config, targetWarehouseId: "different-warehouse" },
  });

  assert.equal(replay.jobId, "job-original");
  assert.equal(conflicting.jobId, "job-original");
  assert.equal(verifyCalls, 0);
  assert.deepEqual(repository.calls.map(([name]) => name), ["getJobByIdempotencyKey", "getJobByIdempotencyKey"]);
});

test("creates an EXCEL_SKU job from ready import rows while preserving row and collect identities", async () => {
  const repository = fakeRepository({ sources: [source("collect-1"), source("collect-2")] });
  const result = await createAutoListingService({ repository }).createExcelAutoListingJob({
    actor, importFileId: "import-1",
  });
  assert.equal(result.sourceType, "EXCEL_SKU");
  const graph = repository.calls.find(([name]) => name === "createJobGraph")[1];
  assert.equal(graph.sourceType, "EXCEL_SKU");
  assert.deepEqual(graph.items.map(({ sourceRecordId, collectItemId }) => ({ sourceRecordId, collectItemId })), [
    { sourceRecordId: "row-1", collectItemId: "collect-1" },
    { sourceRecordId: "row-2", collectItemId: "collect-2" },
  ]);
  assert.equal(graph.idempotencyKey, "job-import-1");
  assert.equal(repository.calls.find(([name]) => name === "loadExcelImportSources")[1].accountId, "account-a");
});

test("Excel replay returns from its lightweight header even when category sources are no longer readable", async () => {
  const repository = fakeRepository();
  repository.getJobByIdempotencyKey = async (input) => {
    repository.calls.push(["getJobByIdempotencyKey", input]);
    return { id: "job-existing", sourceType: "EXCEL_SKU", status: "CREATED", items: [] };
  };
  repository.loadExcelImportSources = async () => {
    assert.fail("replay must not join current category authority");
  };
  repository.loadTargetStore = async () => {
    assert.fail("replay must return before target-store reads");
  };

  const replay = await createAutoListingService({ repository }).createExcelAutoListingJob({
    actor, importFileId: "import-replay",
  });

  assert.equal(replay.jobId, "job-existing");
  assert.deepEqual(repository.calls.map(([name]) => name), ["loadExcelImportContext", "getJobByIdempotencyKey"]);
});

test("refuses to create an Excel job until every accepted import row is terminal", async () => {
  const repository = fakeRepository();
  repository.loadExcelImportSources = async () => ({
    importFile: {
      id: "import-1", accountId: "account-a", status: "COLLECTING", statusVersion: 2,
      acceptedRows: 2, readyRows: 1, failedRows: 0,
      configSnapshot: normalizeAndHashAutoListingConfig(config).config,
      configHash: normalizeAndHashAutoListingConfig(config).configHash,
      idempotencyKey: "job-import-1", correlationId: "corr-import-1",
    },
    sources: [{ ...source("collect-1"), id: "row-1", collectItemId: "collect-1" }],
  });
  await assert.rejects(
    createAutoListingService({ repository }).createExcelAutoListingJob({ actor, importFileId: "import-1" }),
    { code: "AUTO_LISTING_IMPORT_NOT_FINALIZABLE" },
  );
  assert.equal(repository.calls.some(([name]) => name === "createJobGraph"), false);
});

test("rejects permission before invoking the repository", async () => {
  const repository = fakeRepository();
  const service = createAutoListingService({ repository });
  await assert.rejects(service.createAutoListingJob({ actor: {}, collectItemIds: ["collect-1"], idempotencyKey: "key-1", correlationId: "corr-1", config }), (error) => error?.code === "PERMISSION_FORBIDDEN");
  assert.deepEqual(repository.calls, []);
});

test("uses only actor scope, freezes server strategy and persists valid plus blocked siblings", async () => {
  const repository = fakeRepository({ sources: [source("collect-1"), source("collect-2", { blackKopecks: "10000", greenKopecks: "11000" })] });
  const result = await createAutoListingService({ repository }).createAutoListingJob({ actor, collectItemIds: ["collect-1", "collect-1", "collect-2"], idempotencyKey: "key-1", correlationId: "corr-1", config });
  assert.equal(result.jobId, "job-1");
  assert.deepEqual(result.items.map((item) => item.status), ["SOURCE_READY", "BLOCKED"]);
  assert.equal(result.items[1].failureCode, "PRICE_INPUT_INVALID");
  assert.equal(result.items[0].price.finalPriceKopecks, "14500");
  assert.equal(repository.calls.find(([name]) => name === "loadCollectSources")[1].accountId, "account-a");
  const graph = repository.calls.find(([name]) => name === "createJobGraph")[1];
  assert.equal(graph.items.length, 2);
  assert.equal(graph.items[0].strategyVersionId, "version-a");
  assert.equal(graph.uploadPolicyVersionId, "upload-policy-review-v1");
  assert.equal(graph.items[0].listingBaseTemplate.productDraft.id, "draft-collect-1");
  assert.equal(graph.items[0].listingBaseTemplate.richContentAttributeSupported, true);
  assert.equal(Object.hasOwn(graph.items[1], "listingBaseTemplate"), false);
  assert.deepEqual(verifyAutoListingFrozenConfig(graph.configSnapshot, graph.configHash), {
    config: graph.configSnapshot,
    configHash: graph.configHash,
  });
  assert.doesNotMatch(JSON.stringify(result), /raw-collect|credentialsSaved|textDensityByRole/);
});

test("assigns planning contracts per item on the server without adding authority to config", async () => {
  const repository = fakeRepository({ sources: [source("collect-1"), source("collect-2")] });
  await createAutoListingService({
    repository,
    selectPlanningContract: ({ accountId, sourceType, collectItemId }) => (
      accountId === "account-a" && sourceType === "COLLECT_BOX" && collectItemId === "collect-1"
        ? "FIXED_SKELETON_V1"
        : "LEGACY_FULL_PLAN_V3"
    ),
  }).createAutoListingJob({
    actor,
    collectItemIds: ["collect-1", "collect-2"],
    idempotencyKey: "planning-contract-key",
    correlationId: "corr-planning-contract",
    config,
  });
  const graph = repository.calls.find(([name]) => name === "createJobGraph")[1];
  assert.deepEqual(graph.items.map((item) => item.planningContract), [
    "FIXED_SKELETON_V1",
    "LEGACY_FULL_PLAN_V3",
  ]);
  assert.equal(Object.hasOwn(graph.configSnapshot, "planningContract"), false);
});

test("orders replay, store/currency, shared category, warehouse, then paid graph", async () => {
  const repository = fakeRepository();
  await createAutoListingService({ repository }).createAutoListingJob({
    actor, collectItemIds: ["collect-1"], idempotencyKey: "category-order", correlationId: "corr", config,
  });
  const calls = repository.calls.map(([name]) => name);
  assert.ok(calls.indexOf("getJobByIdempotencyKey") < calls.indexOf("loadTargetStore"));
  assert.ok(calls.indexOf("loadTargetStore") < calls.indexOf("loadCollectSources"));
  assert.ok(calls.indexOf("loadCollectSources") < calls.indexOf("acquireCategoryPreparationLease"));
  assert.ok(calls.indexOf("acquireCategoryPreparationLease") < calls.indexOf("loadTargetWarehouse"));
  assert.ok(calls.indexOf("loadTargetWarehouse") < calls.indexOf("createJobGraph"));
  assert.ok(calls.indexOf("createJobGraph") < calls.indexOf("releaseCategoryPreparationLease"));
  assert.equal(repository.calls.find(([name]) => name === "createJobGraph")[1].categoryPreparationLeaseId,
    "category-lease-a");
  assert.equal(repository.calls.find(([name]) => name === "createJobGraph")[1].categoryPreparationSignal,
    repository.categoryLeaseController.signal);
  assert.deepEqual(repository.calls.find(([name]) => name === "releaseCategoryPreparationLease")[1], {
    accountId: "account-a", leaseId: "category-lease-a", outcome: "COMMITTED", jobId: "job-1",
  });
});

test("an idempotency-race replay releases its own lease as REPLAYED and binds the winner job", async () => {
  const repository = fakeRepository({ existing: {
    id: "winner-job", accountId: "account-a", sourceType: "COLLECT_BOX",
    status: "CREATED", items: [],
  } });
  await createAutoListingService({ repository }).createAutoListingJob({
    actor, collectItemIds: ["collect-1"], idempotencyKey: "concurrent-replay",
    correlationId: "corr", config,
  });
  assert.deepEqual(repository.calls.find(([name]) => name === "releaseCategoryPreparationLease")[1], {
    accountId: "account-a", leaseId: "category-lease-a", outcome: "REPLAYED", jobId: "winner-job",
  });
});

test("a preparation failure releases the category lease before surfacing the error", async () => {
  const repository = fakeRepository();
  const failure = Object.assign(new Error("Ozon failed"), { code: "OZON_CATEGORY_UNAVAILABLE" });
  await assert.rejects(createAutoListingService({
    repository,
    listingBasePreparer: async () => { throw failure; },
  }).createAutoListingJob({
    actor, collectItemIds: ["collect-1"], idempotencyKey: "lease-failure", correlationId: "corr", config,
  }), (error) => error === failure);
  const release = repository.calls.find(([name]) => name === "releaseCategoryPreparationLease");
  assert.deepEqual(release?.[1], {
    accountId: "account-a", leaseId: "category-lease-a", outcome: "FAILED",
  });
  assert.equal(repository.calls.some(([name]) => name === "createJobGraph"), false);
});

test("lease expiry aborts every later port but keeps the session held until the in-flight port settles", async () => {
  const repository = fakeRepository();
  let settlePreparation;
  let preparationStarted;
  const started = new Promise((resolve) => { preparationStarted = resolve; });
  const preparing = new Promise((resolve) => { settlePreparation = resolve; });
  const run = createAutoListingService({
    repository,
    listingBasePreparer: async (input) => {
      assert.equal(input.signal, repository.categoryLeaseController.signal);
      preparationStarted();
      await preparing;
      return prepareListingBase(input);
    },
  }).createAutoListingJob({
    actor, collectItemIds: ["collect-1"], idempotencyKey: "lease-expiry", correlationId: "corr", config,
  });
  await started;
  repository.categoryLeaseController.abort(Object.assign(
    new Error("AUTO_LISTING_CATEGORY_LEASE_EXPIRED"),
    { code: "AUTO_LISTING_CATEGORY_LEASE_EXPIRED" },
  ));
  await Promise.resolve();
  assert.equal(repository.calls.some(([name]) => name === "releaseCategoryPreparationLease"), false);
  settlePreparation();
  await assert.rejects(run, { code: "AUTO_LISTING_CATEGORY_LEASE_EXPIRED" });
  assert.equal(repository.calls.some(([name]) => name === "createJobGraph"), false);
  assert.deepEqual(repository.calls.find(([name]) => name === "releaseCategoryPreparationLease")[1], {
    accountId: "account-a", leaseId: "category-lease-a", outcome: "TIMEOUT",
  });
});

test("a category transition after source read but before lease acquisition has zero external or paid side effects", async () => {
  const counters = { ozonCategory: 0, rfbs: 0, paidAi: 0, objectStorage: 0, graph: 0 };
  const repository = fakeRepository();
  repository.acquireCategoryPreparationLease = async (input) => {
    repository.calls.push(["acquireCategoryPreparationLease", input]);
    const conflict = new Error("AUTO_LISTING_SOURCE_VERSION_CONFLICT");
    conflict.code = "AUTO_LISTING_SOURCE_VERSION_CONFLICT";
    conflict.status = 409;
    throw conflict;
  };
  repository.createJobGraph = async () => {
    counters.paidAi += 1;
    counters.objectStorage += 1;
    counters.graph += 1;
    throw new Error("graph must remain unreachable");
  };
  const rfbsWarehouseVerifier = Object.freeze({
    async verifyRfbsWarehouse() { counters.rfbs += 1; return rfbsValidation(); },
  });
  const listingBasePreparer = async () => {
    counters.ozonCategory += 1;
    throw new Error("Ozon category must remain unreachable");
  };

  await assert.rejects(createAutoListingService({ repository, rfbsWarehouseVerifier, listingBasePreparer })
    .createAutoListingJob({
      actor, collectItemIds: ["collect-1"], idempotencyKey: "category-race", correlationId: "corr", config,
    }), { code: "AUTO_LISTING_SOURCE_VERSION_CONFLICT" });
  assert.deepEqual(counters, { ozonCategory: 0, rfbs: 0, paidAi: 0, objectStorage: 0, graph: 0 });
  assert.deepEqual(repository.calls.map(([name]) => name), [
    "getJobByIdempotencyKey", "loadTargetStore", "loadCollectSources", "acquireCategoryPreparationLease",
  ]);
});

test("Excel non-replay orders lightweight header, replay, store/currency, category sources, authorization, then warehouse", async () => {
  const repository = fakeRepository();
  await createAutoListingService({ repository }).createExcelAutoListingJob({ actor, importFileId: "import-order" });
  const calls = repository.calls.map(([name]) => name);
  for (const [before, after] of [
    ["loadExcelImportContext", "getJobByIdempotencyKey"],
    ["getJobByIdempotencyKey", "loadTargetStore"],
    ["loadTargetStore", "loadExcelImportSources"],
    ["loadExcelImportSources", "acquireCategoryPreparationLease"],
    ["acquireCategoryPreparationLease", "loadTargetWarehouse"],
  ]) assert.ok(calls.indexOf(before) < calls.indexOf(after), `${before} must precede ${after}`);
});

test("missing or unconfirmed shared category stops before warehouse, paid AI, object storage, graph, or Ozon", async () => {
  for (const category of [
    null,
    { ...source("collect-1").sharedCategory, status: "NEEDS_REVIEW" },
    { ...source("collect-1").sharedCategory, accountId: "account-b" },
    { ...source("collect-1").sharedCategory, currentTypeId: 0 },
    { ...source("collect-1").sharedCategory, taxonomyScope: "OZON:FOREIGN" },
    { ...source("collect-1").sharedCategory, taxonomyFingerprint: "not-a-hash" },
  ]) {
    const item = source("collect-1");
    item.sharedCategory = category;
    const repository = fakeRepository({ sources: [item] });
    await assert.rejects(createAutoListingService({ repository }).createAutoListingJob({
      actor, collectItemIds: ["collect-1"], idempotencyKey: `category-closed-${category?.status || "absent"}`,
      correlationId: "corr", config,
    }), { code: "AUTO_LISTING_SOURCE_CATEGORY_REQUIRED" });
    assert.equal(repository.calls.some(([name]) => ["loadTargetWarehouse", "loadPublishedStrategy", "createJobGraph"].includes(name)), false);
  }
});

test("keeps low-branch and missing-price source evidence isolated per sibling", async () => {
  const repository = fakeRepository({ sources: [
    source("collect-good"),
    source("collect-low", { blackKopecks: "7999", greenKopecks: "" }),
    source("collect-missing", { blackKopecks: "", greenKopecks: "" }),
  ] });
  const result = await createAutoListingService({ repository }).createAutoListingJob({
    actor, collectItemIds: ["collect-good", "collect-low", "collect-missing"], idempotencyKey: "low-and-missing", correlationId: "corr", config,
  });
  assert.deepEqual(result.items.map((item) => item.status), ["SOURCE_READY", "SOURCE_READY", "BLOCKED"]);
  assert.equal(result.items[1].price.branch, "BLACK_LT_80");
  assert.equal(result.items[2].failureCode, "PRICE_INPUT_MISSING");
  const graph = repository.calls.find(([name]) => name === "createJobGraph")[1];
  assert.equal(graph.items[1].snapshot.priceEvidence.greenKopecks, "");
  assert.equal(graph.items[2].snapshot.priceEvidence.blackKopecks, "");
});

test("requested specification images stop before persistence when trusted product dimensions are missing", async () => {
  const unavailable = source("collect-no-product-size");
  unavailable.collectItem.listingDraft.productMeasurements = {};
  unavailable.collectItem.listingDraft.logistics = { length: 999, width: 999, height: 999, unit: "cm", source: "package" };
  const repository = fakeRepository({ sources: [source("collect-product-size"), unavailable] });
  await assert.rejects(createAutoListingService({ repository }).createAutoListingJob({
    actor, collectItemIds: ["collect-product-size", "collect-no-product-size"], idempotencyKey: "mixed-sizes", correlationId: "corr", config,
  }), { code: "AUTO_LISTING_PRODUCT_DIMENSIONS_REQUIRED", status: 422 });
  assert.equal(repository.calls.some(([name]) => name === "createJobGraph"), false);
});

test("keeps numeric source price facts immutable while blocking only that sibling", async () => {
  const repository = fakeRepository({ sources: [
    source("collect-valid"),
    source("collect-numeric", { blackKopecks: 10_000, greenKopecks: 8_000 }),
  ] });
  const result = await createAutoListingService({ repository }).createAutoListingJob({
    actor, collectItemIds: ["collect-valid", "collect-numeric"], idempotencyKey: "numeric-price", correlationId: "corr", config,
  });
  assert.deepEqual(result.items.map((item) => item.status), ["SOURCE_READY", "BLOCKED"]);
  assert.equal(result.items[1].failureCode, "PRICE_INPUT_INVALID");
  const graph = repository.calls.find(([name]) => name === "createJobGraph")[1];
  assert.equal(graph.items[1].snapshot.priceEvidence.blackKopecks, 10_000);
  assert.equal(graph.items[1].snapshot.variants[0].priceEvidence.greenKopecks, 8_000);
});

test("isolates only non-category source-business failures with separate blocked evidence", async () => {
  const missingSku = source("collect-no-sku");
  missingSku.collectItem.listingDraft.variants = [{ sku: "" }];
  const foreignCurrency = source("collect-usd");
  foreignCurrency.collectItem.listingDraft.currency = "USD";
  foreignCurrency.collectItem.listingDraft.variants[0].currency = "USD";
  const repository = fakeRepository({ sources: [source("collect-good"), missingSku, foreignCurrency] });

  const result = await createAutoListingService({ repository }).createAutoListingJob({
    actor,
    collectItemIds: ["collect-good", "collect-no-sku", "collect-usd"],
    idempotencyKey: "source-fact-isolation",
    correlationId: "corr",
    config,
  });

  assert.deepEqual(result.items.map((item) => [item.status, item.failureCode || null]), [
    ["SOURCE_READY", null],
    ["BLOCKED", "AUTO_LISTING_SOURCE_SKU_REQUIRED"],
    ["BLOCKED", "AUTO_LISTING_SOURCE_CURRENCY_UNSUPPORTED"],
  ]);
  assert.doesNotMatch(JSON.stringify(result), /raw-collect|listingDraft|currency.*USD/);
  const graph = repository.calls.find(([name]) => name === "createJobGraph")[1];
  for (const item of graph.items.slice(1)) {
    assert.equal(Object.hasOwn(item, "snapshot"), false);
    assert.equal(Object.hasOwn(item, "strategyId"), false);
    assert.equal(Object.hasOwn(item, "price"), false);
    assert.equal(Object.hasOwn(item, "effectiveImageConfig"), false);
    assert.equal(item.blockedEvidence.failureCode, item.failureCode);
  }
});

test("keeps malformed source inputs as whole-request failures even when a source fact is missing", async () => {
  const malformed = source("collect-malformed");
  malformed.collectItem.listingDraft.categoryResolution.target.descriptionCategoryId = "";
  malformed.collectItem.listingDraft.attributes = [{ self: malformed.collectItem }];
  const malformedDraft = source("collect-malformed-draft");
  malformedDraft.collectItem.listingDraft.categoryResolution.target.descriptionCategoryId = "";
  Object.defineProperty(malformedDraft.productDraft, "__proto__", { value: { polluted: true }, enumerable: true });
  for (const invalidSource of [malformed, malformedDraft]) {
    const repository = fakeRepository({ sources: [source("collect-good"), invalidSource] });
    await assert.rejects(
      createAutoListingService({ repository }).createAutoListingJob({
        actor, collectItemIds: ["collect-good", invalidSource.id], idempotencyKey: `source-integrity-${invalidSource.id}`, correlationId: "corr", config,
      }),
      (error) => error?.code === "AUTO_LISTING_SOURCE_INVALID",
    );
    assert.equal(repository.calls.some(([name]) => name === "createJobGraph"), false);
  }
});

test("rejects missing or foreign formal warehouses before any graph insert", async () => {
  for (const evidence of [
    { warehouse: null, products: [] },
    { warehouse: { id: "warehouse-b", storeId: "store-b", accountId: "account-b", warehouse_id: "1002", warehouse_type: "FBS", status: "active", is_active: true }, products: [] },
  ]) {
    const repository = fakeRepository();
    repository.loadTargetWarehouse = async (input) => { repository.calls.push(["loadTargetWarehouse", input]); return evidence; };
    const service = createAutoListingService({ repository });
    await assert.rejects(service.createAutoListingJob({ actor, collectItemIds: ["collect-1"], idempotencyKey: "key-warehouse", correlationId: "corr", config }), (error) => error?.code === "AUTO_LISTING_WAREHOUSE_NOT_FOUND");
    assert.equal(repository.calls.some(([name]) => name === "createJobGraph"), false);
  }
});

test("same account category authority is reusable for a second target store", async () => {
  const wrong = source("collect-wrong");
  wrong.collectItem.listingDraft.categoryResolution.target.storeId = "store-other";
  const repository = fakeRepository({ sources: [source("collect-good"), wrong] });
  const result = await createAutoListingService({ repository }).createAutoListingJob({ actor, collectItemIds: ["collect-good", "collect-wrong"], idempotencyKey: "key-category", correlationId: "corr", config });
  assert.deepEqual(result.items.map((item) => item.status), ["SOURCE_READY", "SOURCE_READY"]);
});

test("returns an existing same-account job before resources are revalidated", async () => {
  const repository = fakeRepository({ existing: { id: "replayed", status: "CREATED", accountId: "account-a", sourceType: "COLLECT_BOX", items: [] } });
  repository.getJobByIdempotencyKey = async (input) => { repository.calls.push(["getJobByIdempotencyKey", input]); return { id: "replayed", status: "CREATED", sourceType: "COLLECT_BOX", items: [] }; };
  const result = await createAutoListingService({ repository }).createAutoListingJob({ actor, collectItemIds: ["collect-1"], idempotencyKey: "replay-key", correlationId: "corr", config: { ...config, targetStoreId: "later-disabled" } });
  assert.equal(result.jobId, "replayed");
  assert.deepEqual(repository.calls.map(([name]) => name), ["getJobByIdempotencyKey"]);
});

test("validates unique IDs after deduplication and strips nested price secrets", async () => {
  const repository = fakeRepository({ existing: {
    id: "safe-price", sourceType: "COLLECT_BOX", status: "CREATED", items: [{ id: "item", status: "SOURCE_READY", price: { currency: "RUB", branch: "BLACK_GTE_80", blackKopecks: "10000", finalPriceKopecks: "14500", modelCredentials: "secret", rawPayload: { token: "secret" } } }],
  } });
  const service = createAutoListingService({ repository });
  const job = await service.getAutoListingJob({ actor, jobId: "safe-price" });
  assert.deepEqual(job.items[0].price, { currency: "RUB", branch: "BLACK_GTE_80", blackKopecks: "10000", finalPriceKopecks: "14500" });
  await assert.doesNotReject(service.createAutoListingJob({ actor, collectItemIds: Array.from({ length: 101 }, () => "collect-1"), idempotencyKey: "dedup-key", correlationId: "corr", config }));
});

test("creates a native CNY job from exact target-store currency evidence", async () => {
  const cny = source("collect-cny");
  delete cny.collectItem.listingDraft.currency;
  const repository = fakeRepository({ sources: [cny] });
  repository.loadTargetStore = async (input) => {
    repository.calls.push(["loadTargetStore", input]);
    return { id: "store-a", ownerAccountId: input.accountId, status: "active", clientId: "client-a", currencyCode: "CNY",
      currencySource: "OZON_SELLER_INFO", currencySyncedAt: "2026-08-13T00:00:00.000Z", credentialsSaved: true };
  };
  const result = await createAutoListingService({ repository }).createAutoListingJob({
    actor, collectItemIds: ["collect-cny"], idempotencyKey: "cny-native", correlationId: "corr-cny", config,
  });
  assert.equal(result.items[0].status, "SOURCE_READY");
  assert.equal(result.items[0].price.currency, "CNY");
  const graph = repository.calls.find(([name]) => name === "createJobGraph")[1];
  assert.deepEqual(graph.items[0].snapshot.priceEvidence, {
    blackKopecks: "10000", greenKopecks: "8000", currency: "CNY", currencySource: "TARGET_STORE",
  });
});

test("reloads refreshed shared category sources before acquiring the preparation lease", async () => {
  const stale = source("collect-refresh");
  const refreshed = structuredClone(stale);
  refreshed.sharedCategory.version = 3;
  refreshed.sharedCategory.source = "OZON_REFRESH";
  refreshed.sharedCategory.currentDescriptionCategoryId = 17029005;
  refreshed.sharedCategory.taxonomyFingerprint = "a".repeat(64);
  const repository = fakeRepository({ sources: [stale] });
  let sourceReads = 0;
  repository.loadCollectSources = async (input) => {
    repository.calls.push(["loadCollectSources", input]);
    sourceReads += 1;
    return [sourceReads === 1 ? stale : refreshed];
  };
  const seen = [];
  const service = createAutoListingService({
    repository,
    ensureCategoryFresh: async (input) => {
      seen.push({ name: "freshness", version: input.sources[0].sharedCategory.version });
      return { status: "REFRESHED" };
    },
    listingBasePreparer: async ({ targetCategory }) => {
      seen.push({ name: "prepare", descriptionCategoryId: targetCategory.descriptionCategoryId });
      return repositoryListingBaseTemplate("collect-refresh");
    },
  });

  await service.createAutoListingJob({
    actor, collectItemIds: ["collect-refresh"], idempotencyKey: "refresh-before-lease",
    correlationId: "corr-refresh-before-lease", config,
  });

  assert.equal(sourceReads, 2);
  assert.deepEqual(seen, [
    { name: "freshness", version: 1 },
    { name: "prepare", descriptionCategoryId: "17029005" },
  ]);
  assert.deepEqual(repository.calls.filter(([name]) => name === "acquireCategoryPreparationLease")
    .map(([, input]) => input.items[0].sharedCategoryVersion), [3]);
  assert.equal(repository.calls.filter(([name]) => name === "createJobGraph").length, 1);
});

test("rejects a legacy default currency without exact Ozon seller-info authority", async () => {
  const repository = fakeRepository();
  repository.loadTargetStore = async (input) => ({
    id: "store-a", ownerAccountId: input.accountId, status: "active", clientId: "client-a",
    currencyCode: "RUB", credentialsSaved: true,
  });
  await assert.rejects(createAutoListingService({ repository }).createAutoListingJob({
    actor, collectItemIds: ["collect-1"], idempotencyKey: "unverified-store-currency",
    correlationId: "corr-unverified", config,
  }), { code: "AUTO_LISTING_TARGET_STORE_CURRENCY_UNVERIFIED", status: 409 });
  assert.equal(repository.calls.some(([name]) => name === "loadTargetWarehouse"), false);
  assert.equal(repository.calls.some(([name]) => name === "createJobGraph"), false);
});

test("blocks an explicit source currency that conflicts with the target store", async () => {
  const repository = fakeRepository();
  repository.loadTargetStore = async (input) => {
    repository.calls.push(["loadTargetStore", input]);
    return { id: "store-a", ownerAccountId: input.accountId, status: "active", clientId: "client-a", currencyCode: "CNY", currencySource: "OZON_SELLER_INFO", currencySyncedAt: "2026-08-13T00:00:00.000Z", credentialsSaved: true };
  };
  const result = await createAutoListingService({ repository }).createAutoListingJob({
    actor, collectItemIds: ["collect-1"], idempotencyKey: "currency-mismatch", correlationId: "corr-cny", config,
  });
  assert.deepEqual(result.items.map((item) => [item.status, item.failureCode]), [
    ["BLOCKED", "AUTO_LISTING_SOURCE_CURRENCY_MISMATCH"],
  ]);
  assert.equal(repository.calls.some(([name]) => name === "createJobGraph"), true);
});

test("rejects an unsupported target-store currency before warehouse or job work", async () => {
  const repository = fakeRepository();
  repository.loadTargetStore = async (input) => {
    repository.calls.push(["loadTargetStore", input]);
    return { id: "store-a", ownerAccountId: input.accountId, status: "active", clientId: "client-a", currencyCode: "USD", currencySource: "OZON_SELLER_INFO", currencySyncedAt: "2026-08-13T00:00:00.000Z", credentialsSaved: true };
  };
  await assert.rejects(createAutoListingService({ repository }).createAutoListingJob({
    actor, collectItemIds: ["collect-1"], idempotencyKey: "unsupported-target-currency", correlationId: "corr-usd", config,
  }), { code: "AUTO_LISTING_TARGET_STORE_CURRENCY_UNSUPPORTED", status: 422 });
  assert.equal(repository.calls.some(([name]) => name === "loadTargetWarehouse"), false);
  assert.equal(repository.calls.some(([name]) => name === "createJobGraph"), false);
});

test("passes actor account scope to every repository boundary", async () => {
  const repository = fakeRepository();
  const service = createAutoListingService({ repository });
  await service.createAutoListingJob({ actor, collectItemIds: ["collect-1"], idempotencyKey: "scope-key", correlationId: "corr", config });
  await service.getAutoListingJob({ actor, jobId: "job-1" });
  await service.listAutoListingJobs({ actor, limit: 1 });
  for (const [name, input] of repository.calls) {
    if (["getJobByIdempotencyKey", "loadTargetStore", "loadTargetWarehouse", "loadCollectSources", "loadPublishedStrategy", "createJobGraph", "getJob", "listJobs"].includes(name)) {
      assert.equal(input.accountId, "account-a", `${name} scope`);
    }
  }
});

test("rejects invalid target-store, FBO, inactive association, and missing strategy as whole-request failures", async () => {
  const cases = [
    (repository) => { repository.loadTargetStore = async (input) => ({ id: "store-a", ownerAccountId: "account-b", status: "active", clientId: "client", credentialsSaved: true }); },
    (repository) => { repository.loadTargetWarehouse = async (input) => ({ warehouse: { id: "warehouse-a", storeId: "store-a", accountId: "account-a", warehouse_id: "1001", warehouse_type: "FBO", status: "active", is_active: true }, products: [] }); },
    (repository) => { repository.loadTargetWarehouse = async (input) => ({ warehouse: { id: "warehouse-a", storeId: "store-a", accountId: "account-a", warehouse_id: "1001", warehouse_type: "FBS", status: "active", is_active: true }, products: [] }); },
    (repository) => { repository.loadPublishedStrategy = async (input) => null; },
  ];
  for (const configure of cases) {
    const repository = fakeRepository();
    configure(repository);
    await assert.rejects(
      createAutoListingService({ repository }).createAutoListingJob({ actor, collectItemIds: ["collect-1"], idempotencyKey: `failure-${Math.random()}`, correlationId: "corr", config }),
    );
    assert.equal(repository.calls.some(([name]) => name === "createJobGraph"), false);
  }
});

test("uses the frozen shared category ID and never display labels for strategy matching", async () => {
  const item = source("collect-ancestor");
  item.collectItem.listingDraft.categoryResolution.target.ancestorCategoryIds = ["ancestor-id"];
  item.collectItem.listingDraft.categoryResolution.source.path = ["Display only"];
  const repository = fakeRepository({ sources: [item] });
  repository.loadPublishedStrategy = async (input) => ({
    strategyVersion: { strategyId: "strategy-a", strategyVersionId: "version-a" },
    rules: [{ ruleId: "exact", ruleOrder: 1, matchType: "EXACT_CATEGORY", categoryId: "123", style: "PARAMETER_FIRST", textDensityByRole: {} }],
  });
  const result = await createAutoListingService({ repository }).createAutoListingJob({ actor, collectItemIds: ["collect-ancestor"], idempotencyKey: "ancestor-key", correlationId: "corr", config });
  const persisted = repository.calls.find(([name]) => name === "createJobGraph")[1].items[0];
  assert.equal(persisted.matchedBy, "EXACT_CATEGORY");
  assert.equal(persisted.style, "PARAMETER_FIRST");
  assert.equal(Object.hasOwn(result.items[0], "matchedBy"), false);
  assert.equal(Object.hasOwn(result.items[0], "style"), false);
  assert.equal(Object.hasOwn(result.items[0], "strategyId"), false);
  assert.equal(Object.hasOwn(result.items[0], "strategyVersionId"), false);
});

test("ordinary job DTOs omit internal strategy selection metadata", async () => {
  const repository = fakeRepository({ existing: {
    id: "job-internal-strategy", items: [{
      id: "item-a", status: "SOURCE_READY", strategyId: "strategy-a",
      strategyVersionId: "version-a", style: "PARAMETER_FIRST", matchedBy: "CATEGORY",
    }],
  } });
  const result = await createAutoListingService({ repository }).getAutoListingJob({ actor, jobId: "job-internal-strategy" });
  assert.deepEqual(Object.keys(result.items[0]).filter((key) => /strategy|style|matched/i.test(key)), []);
});

test("job DTO exposes only the closed durable workflow progress projection", async () => {
  const repository = fakeRepository({ existing: {
    id: "job-progress", items: [{
      id: "item-progress", status: "PLANNING",
      workflowProgress: {
        phase: "PLAN_CONTENT", state: "RUNNING", attemptCount: 1,
        updatedAt: new Date("2026-08-14T01:02:03.000Z"), nextRetryAt: null,
      },
    }],
  } });
  const result = await createAutoListingService({ repository }).getAutoListingJob({ actor, jobId: "job-progress" });
  assert.deepEqual(result.items[0].workflowProgress, {
    phase: "PLAN_CONTENT", state: "RUNNING", attemptCount: 1,
    updatedAt: "2026-08-14T01:02:03.000Z", nextRetryAt: null,
  });
  assert.doesNotMatch(JSON.stringify(result), /lease|prompt|raw|lastError/iu);
});

test("bounds list requests and keeps cross-account same-key replays independent", async () => {
  const repository = fakeRepository();
  const service = createAutoListingService({ repository });
  await assert.rejects(service.listAutoListingJobs({ actor, limit: 0 }), (error) => error?.code === "AUTO_LISTING_REQUEST_INVALID");
  await assert.rejects(service.listAutoListingJobs({ actor, limit: 101 }), (error) => error?.code === "AUTO_LISTING_REQUEST_INVALID");
  await service.createAutoListingJob({ actor, collectItemIds: ["collect-1"], idempotencyKey: "same-key", correlationId: "corr", config });
  const otherSource = structuredClone(source("collect-1"));
  otherSource.accountId = "account-b";
  otherSource.collectItem.accountId = "account-b";
  otherSource.categoryEvidence.accountId = "account-b";
  otherSource.sharedCategory.accountId = "account-b";
  const otherRepository = fakeRepository({ sources: [otherSource] });
  const other = createAutoListingService({ repository: otherRepository });
  await other.createAutoListingJob({ actor: { id: "account-b", role: "user" }, collectItemIds: ["collect-1"], idempotencyKey: "same-key", correlationId: "corr", config: { ...config, targetStoreId: "store-a", targetWarehouseId: "warehouse-a" } });
  assert.equal(otherRepository.calls.find(([name]) => name === "getJobByIdempotencyKey")[1].accountId, "account-b");
});

test("rejects client authority fields and validates a bounded request", async () => {
  const repository = fakeRepository();
  const service = createAutoListingService({ repository });
  for (const request of [
    { actor, collectItemIds: [], idempotencyKey: "key", correlationId: "corr", config },
    { actor, collectItemIds: ["collect-1"], idempotencyKey: "", correlationId: "corr", config },
    { actor, collectItemIds: ["collect-1"], idempotencyKey: "key", correlationId: "corr", accountId: "account-b", config },
    { actor, collectItemIds: ["collect-1"], idempotencyKey: "key", correlationId: "corr", config: { ...config, strategyVersionId: "foreign" } },
  ]) {
    await assert.rejects(service.createAutoListingJob(request), (error) => /^AUTO_LISTING_(REQUEST_INVALID|CONFIG_FORBIDDEN_FIELD)$/.test(error?.code));
  }
});

test("reads and lists only within actor account and sanitizes persistence rows", async () => {
  const repository = fakeRepository({ existing: {
    id: "job-safe", accountId: "account-a", sourceType: "COLLECT_BOX", targetStoreId: "store-a", targetWarehouseId: "warehouse-a",
    sourceSnapshot: { secret: "no" }, rawResponseRef: "no", credentials: "no", rules: [{ body: "no" }],
    items: [{ id: "item-safe", status: "SOURCE_READY", sourceHash: "hash-safe", rawResponseRef: "no" }],
  } });
  const service = createAutoListingService({ repository });
  const one = await service.getAutoListingJob({ actor, jobId: "job-safe" });
  const all = await service.listAutoListingJobs({ actor, limit: 10 });
  assert.equal(one.jobId, "job-safe");
  assert.deepEqual(all.map(({ jobId }) => jobId), ["job-safe"]);
  assert.doesNotMatch(JSON.stringify(one), /secret|rawResponseRef|credentials|rules/);
  await assert.rejects(service.getAutoListingJob({ actor: { id: "account-b", role: "user" }, jobId: "job-safe" }), (error) => error?.code === "AUTO_LISTING_JOB_NOT_FOUND");
});

test("job DTO exposes only server-authorized item actions and hides recovery evidence", async () => {
  const repository = fakeRepository({ existing: {
    id: "job-actions", accountId: "account-a", sourceType: "COLLECT_BOX", status: "GENERATING",
    items: [
      { id: "ready", status: "READY_FOR_REVIEW", statusVersion: 5, activeContentPlanId: "plan-a" },
      { id: "retry", status: "RETRYABLE_ERROR", statusVersion: 3, recoveryPoint: "GENERATION" },
      { id: "upload", status: "UPLOADING", statusVersion: 7, activeContentPlanId: "plan-b" },
      { id: "blocked", status: "BLOCKED", statusVersion: 2, activeContentPlanId: "plan-c" },
    ],
  } });
  const result = await createAutoListingService({ repository }).getAutoListingJob({ actor, jobId: "job-actions" });
  assert.deepEqual(result.items.map(({ itemId, actions }) => ({ itemId, actions })), [
    { itemId: "ready", actions: { review: true, approve: true, retry: false, regenerate: true, cancel: true } },
    { itemId: "retry", actions: { review: false, approve: false, retry: true, regenerate: false, cancel: true } },
    { itemId: "upload", actions: { review: false, approve: false, retry: false, regenerate: false, cancel: false } },
    { itemId: "blocked", actions: { review: false, approve: false, retry: false, regenerate: false, cancel: false } },
  ]);
  assert.doesNotMatch(JSON.stringify(result), /recoveryPoint|activeContentPlanId|plan-[abc]/u);
});

test("never exposes nested objects through job and item scalar DTO slots", async () => {
  const secret = { rawPayload: { token: "secret" } };
  const repository = fakeRepository({ existing: {
    id: secret, sourceType: secret, status: secret, correlationId: secret, createdAt: secret,
    items: [{ id: secret, status: secret, targetStoreId: secret, targetWarehouseId: secret,
      sourceRecordId: secret, sourceVersion: secret, sourceHash: secret, strategyId: secret,
      strategyVersionId: secret, style: secret, matchedBy: secret, failureCode: secret }],
  } });
  const result = await createAutoListingService({ repository }).getAutoListingJob({ actor, jobId: "safe" });
  assert.doesNotMatch(JSON.stringify(result), /secret|rawPayload|token/);
  assert.equal(result.jobId, null);
  assert.equal(result.items[0].targetStoreId, null);
  assert.equal("failureCode" in result.items[0], false);
});

test("repository rejects an empty platform warehouse ID before the shared eligibility policy", async () => {
  const captured = buildAutoListingSourceSnapshot({
    accountId: "account-a", sourceType: "COLLECT_BOX", sourceRecordId: "collect-warehouse", sourceVersion: "1",
    targetStoreId: "store-a", targetStoreCurrency: "RUB",
    rawResponseRef: "raw-warehouse", rawResponseHash: "raw-hash",
    collectItem: source("collect-warehouse").collectItem,
    productDraft: { id: "draft-collect-warehouse", version: 1 },
    ...categoryAuthority("collect-warehouse"),
  });
  const client = {
    async query(sql, params = []) {
      if (/^(BEGIN|ROLLBACK)$/.test(sql)) return { rows: [] };
      if (/SELECT id FROM auto_listing_jobs/.test(sql)) return { rows: [] };
      if (/auto-listing-category-graph-lock-keys/u.test(sql)) return { rows: params[1].map((id, index) => ({ shared_category_id: id, lock_key: String(index + 1) })) };
      if (/pg_try_advisory_xact_lock_shared/u.test(sql)) return { rows: [{ locked: true }] };
      if (/auto-listing-category-graph-lease-active/u.test(sql)) return { rows: [{ id: "category-lease-a" }] };
      if (/FROM stores s/.test(sql)) return { rows: [{ id: "store-a", owner_account_id: "account-a", label: "Store A", company_name: "Store A", client_id: "client-a", currency_code: "RUB", currency_source: "OZON_SELLER_INFO", currency_synced_at: "2026-08-13T00:00:00.000Z", status: "active" }] };
      if (/FROM store_credentials/.test(sql)) return { rows: [{ store_id: "store-a" }] };
      if (/SELECT strategy_key/.test(sql)) return { rows: [{ strategy_key: "strategy-a" }] };
      if (/FROM ai_content_strategy_rules/.test(sql)) return { rows: [] };
      if (/SELECT 1 FROM collect_items/.test(sql)) return { rows: [{}] };
      if (/FROM warehouses w/.test(sql)) return { rows: [{ id: "warehouse-a", store_id: "store-a", warehouse_id: "", warehouse_type: "FBS", status: "active", is_active: true, is_archived: false }] };
      if (/FROM product_stocks ps/.test(sql)) return { rows: [] };
      throw new Error(`unexpected query: ${sql}`);
    },
    release() {},
  };
  const repository = createAutoListingRepository({ pool: { connect: async () => client, query: async () => ({ rows: [] }) } });
  const item = {
    sourceType: "COLLECT_BOX", sourceRecordId: "collect-warehouse", sourceVersion: "1",
    planningContract: "LEGACY_FULL_PLAN_V3",
    snapshot: captured.snapshot, snapshotHash: captured.snapshotHash, rawResponseRef: captured.rawResponseRef,
    targetStoreId: "store-a", targetWarehouseId: "warehouse-a", sourceOrder: 0, status: "SOURCE_READY",
    strategyId: "strategy-a", strategyVersionId: "version-a", ruleId: null, style: "BALANCED_DEFAULT", matchedBy: "DEFAULT",
    price: { currency: "RUB", branch: "BLACK_GTE_80", blackKopecks: "10000", greenKopecks: "8000", realPriceKopecks: "14500", adjustmentKopecks: "0", finalPriceKopecks: "14500" },
    listingBaseTemplate: repositoryListingBaseTemplate("collect-warehouse"),
  };
  const frozen = frozenGraphConfig();
  const graphInput = {
    accountId: "account-a", actorAccountId: "account-a", sourceType: "COLLECT_BOX", idempotencyKey: "warehouse-empty", correlationId: "corr",
    categoryPreparationLeaseId: "category-lease-a",
    configSnapshot: frozen.config, configHash: frozen.configHash, strategyVersionId: "version-a",
    uploadPolicyVersionId: "upload-policy-review-v1",
    items: [{ ...item, effectiveImageConfig: effectiveImageConfig(frozen, captured) }],
  };
  await assert.rejects(
    repository.createJobGraph({ ...graphInput, idempotencyKey: "raw-mismatch", items: [{ ...graphInput.items[0], rawResponseRef: "another-raw" }] }),
    (error) => error?.code === "AUTO_LISTING_REPOSITORY_INVALID",
  );
  await assert.rejects(repository.createJobGraph({
    ...graphInput,
  }), (error) => error?.code === "LISTING_WAREHOUSE_NOT_ELIGIBLE" && error?.body?.reason === "WAREHOUSE_ID_MISSING");
});

test("repository rejects malformed frozen configuration before connecting", async () => {
  const captured = buildAutoListingSourceSnapshot({
    accountId: "account-a", sourceType: "COLLECT_BOX", sourceRecordId: "collect-config", sourceVersion: "1",
    targetStoreId: "store-a", targetStoreCurrency: "RUB",
    rawResponseRef: "raw-config", rawResponseHash: "raw-hash", collectItem: source("collect-config").collectItem,
    ...categoryAuthority("collect-config"),
  });
  const frozen = frozenGraphConfig();
  const item = {
    sourceType: "COLLECT_BOX", sourceRecordId: "collect-config", sourceVersion: "1", snapshot: captured.snapshot,
    snapshotHash: captured.snapshotHash, rawResponseRef: captured.rawResponseRef, targetStoreId: "store-a", targetWarehouseId: "warehouse-a",
    sourceOrder: 0, status: "SOURCE_READY", strategyId: "strategy-a", strategyVersionId: "version-a", ruleId: null,
    style: "BALANCED_DEFAULT", matchedBy: "DEFAULT", effectiveImageConfig: effectiveImageConfig(frozen, captured),
    price: { currency: "RUB", branch: "BLACK_GTE_80", blackKopecks: "10000", greenKopecks: "8000", realPriceKopecks: "14500", adjustmentKopecks: "0", finalPriceKopecks: "14500" },
  };
  const graph = {
    accountId: "account-a", actorAccountId: "account-a", sourceType: "COLLECT_BOX", idempotencyKey: "config-check", correlationId: "corr",
    categoryPreparationLeaseId: "category-lease-a",
    configSnapshot: frozen.config, configHash: frozen.configHash, strategyVersionId: "version-a", items: [item],
  };
  let connections = 0;
  const repository = createAutoListingRepository({ pool: {
    connect: async () => { connections += 1; throw new Error("must not connect"); },
    query: async () => ({ rows: [] }),
  } });
  const malformed = [
    { configSnapshot: { targetStoreId: "store-a" }, configHash: frozen.configHash },
    { configSnapshot: frozen.config, configHash: undefined },
    { configSnapshot: frozen.config, configHash: "" },
    { configSnapshot: frozen.config, configHash: "f".repeat(63) },
    { configSnapshot: frozen.config, configHash: "z".repeat(64) },
    { configSnapshot: { ...frozen.config, unknown: "no" }, configHash: frozen.configHash },
    { configSnapshot: { ...frozen.config, modelCredentials: "secret" }, configHash: frozen.configHash },
    { configSnapshot: { ...frozen.config, stock: 0 }, configHash: frozen.configHash },
    { configSnapshot: { ...frozen.config, priceAdjustmentKopecks: "1.5" }, configHash: frozen.configHash },
    { configSnapshot: { ...frozen.config, image: { ...frozen.config.image, roles: { ...frozen.config.image.roles, main: 2 } } }, configHash: frozen.configHash },
    { configSnapshot: { ...frozen.config, image: { ...frozen.config.image, total: 7 } }, configHash: frozen.configHash },
    { configSnapshot: frozen.config, configHash: "forged" },
  ];
  for (const invalid of malformed) {
    await assert.rejects(repository.createJobGraph({ ...graph, idempotencyKey: `invalid-${Math.random()}`, ...invalid }), (error) => error?.code === "AUTO_LISTING_REPOSITORY_INVALID");
  }
  assert.equal(connections, 0);
});

test("repository persists only a canonical recomputed price with a non-default strategy rule", async () => {
  const collectItem = source("collect-rule").collectItem;
  collectItem.productStyle = "MODERN";
  const captured = buildAutoListingSourceSnapshot({
    accountId: "account-a", sourceType: "COLLECT_BOX", sourceRecordId: "collect-rule", sourceVersion: "1",
    targetStoreId: "store-a", targetStoreCurrency: "RUB",
    rawResponseRef: "raw-rule", rawResponseHash: "raw-hash", collectItem,
    productDraft: { id: "draft-collect-rule", version: 1 },
    ...categoryAuthority("collect-rule"),
  });
  const item = {
    sourceType: "COLLECT_BOX", sourceRecordId: "collect-rule", sourceVersion: "1", snapshot: captured.snapshot,
    planningContract: "LEGACY_FULL_PLAN_V3",
    snapshotHash: captured.snapshotHash, rawResponseRef: "raw-rule", targetStoreId: "store-a", targetWarehouseId: "warehouse-a",
    sourceOrder: 0, status: "SOURCE_READY", strategyId: "strategy-a", strategyVersionId: "version-a", ruleId: "rule-modern",
    style: "VISUAL_FIRST", matchedBy: "PRODUCT_STYLE",
    price: { currency: "RUB", branch: "BLACK_GTE_80", blackKopecks: "10000", greenKopecks: "8000", realPriceKopecks: "14500", adjustmentKopecks: "0", finalPriceKopecks: "14500" },
    listingBaseTemplate: repositoryListingBaseTemplate("collect-rule"),
  };
  const frozen = frozenGraphConfig();
  const graphInput = {
    accountId: "account-a", actorAccountId: "account-a", sourceType: "COLLECT_BOX", idempotencyKey: "rule-key", correlationId: "corr",
    categoryPreparationLeaseId: "category-lease-a",
    configSnapshot: frozen.config, configHash: frozen.configHash, strategyVersionId: "version-a",
    uploadPolicyVersionId: "upload-policy-review-v1",
    items: [{ ...item, effectiveImageConfig: effectiveImageConfig(frozen, captured) }],
  };
  const calls = [];
  const client = {
    async query(sql, params) {
      calls.push([sql, params]);
      if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql) || /INSERT INTO auto_listing_(jobs|job_items|events|listing_bases)/.test(sql)) return { rows: [] };
      if (/SELECT id FROM auto_listing_jobs/.test(sql)) return { rows: [] };
      if (/auto-listing-category-graph-lock-keys/u.test(sql)) return { rows: params[1].map((id, index) => ({ shared_category_id: id, lock_key: String(index + 1) })) };
      if (/pg_try_advisory_xact_lock_shared/u.test(sql)) return { rows: [{ locked: true }] };
      if (/auto-listing-category-graph-lease-active/u.test(sql)) return { rows: [{ id: "category-lease-a" }] };
      if (/FROM stores s/.test(sql)) return { rows: [{ id: "store-a", owner_account_id: "account-a", label: "Store A", company_name: "Store A", client_id: "client-a", currency_code: "RUB", currency_source: "OZON_SELLER_INFO", currency_synced_at: "2026-08-13T00:00:00.000Z", status: "active" }] };
      if (/FROM store_credentials/.test(sql)) return { rows: [{ store_id: "store-a" }] };
      if (/SELECT strategy_key/.test(sql)) return { rows: [{ strategy_key: "strategy-a" }] };
      if (/FROM auto_listing_upload_policy_versions/.test(sql)) return { rows: [{ id: "upload-policy-review-v1" }] };
      if (/FROM ai_gateway_profiles/.test(sql)) return { rows: [{ id: "profile-a", config_version: 3 }] };
      if (/FROM ai_content_strategy_rules/.test(sql)) return { rows: [{ id: "rule-modern", rule_order: 1, rule_kind: "PRODUCT_STYLE", category_id: null, ancestor_category_id: null, product_style: "MODERN", rule: { style: "VISUAL_FIRST", textDensityByRole: {} } }] };
      if (/FROM collect_ozon_category_current_sources current_category/.test(sql)) return { rows: [{ id: "shared-123-456" }] };
      if (/FROM collect_items c/.test(sql)) return { rows: [{
        draft_id: "draft-collect-rule", draft_version: 1, draft_data_hash: "1".repeat(64),
      }] };
      if (/FROM warehouses w/.test(sql)) return { rows: [{ id: "warehouse-a", store_id: "store-a", warehouse_id: "1001", warehouse_type: "FBS", status: "active", is_active: true, is_archived: false }] };
      if (/FROM product_stocks ps/.test(sql)) return { rows: [{ product_id: "product-a", product_store_id: "store-a", product_status: "active", product_is_archived: false, product_raw_is_archived: false, warehouse_id: "warehouse-a", source: "fbs" }] };
      if (/INSERT INTO auto_listing_source_snapshots/.test(sql)) return { rows: [{
        id: "snapshot-a", snapshot: captured.snapshot, snapshot_hash: captured.snapshotHash, raw_response_ref: captured.rawResponseRef,
      }] };
      if (/FROM auto_listing_jobs WHERE id/.test(sql)) return { rows: [{ id: "auto_listing_job-id", account_id: "account-a", source_type: "COLLECT_BOX", status: "CREATED", strategy_version_id: "version-a", correlation_id: "corr", created_at: null, updated_at: null }] };
      if (/JOIN auto_listing_source_snapshots/.test(sql)) return { rows: [] };
      if (/FROM auto_listing_events/.test(sql)) return { rows: [] };
      throw new Error(`unexpected query: ${sql}`);
    },
    release() {},
  };
  const repository = createAutoListingRepository({ pool: { connect: async () => client, query: async () => ({ rows: [] }) }, idFactory: (prefix) => `${prefix}-id` });
  await assert.doesNotReject(repository.createJobGraph(graphInput));
  for (const invalidPrice of [
    { ...item.price, rawPayload: "secret" },
    { ...item.price, branch: "UNKNOWN" },
    { ...item.price, finalPriceKopecks: "1" },
  ]) {
    await assert.rejects(
      repository.createJobGraph({ ...graphInput, idempotencyKey: `invalid-${Math.random()}`, items: [{ ...graphInput.items[0], price: invalidPrice }] }),
      (error) => error?.code === "AUTO_LISTING_REPOSITORY_INVALID",
    );
  }
  assert.equal(calls.some(([sql, params]) => /INSERT INTO auto_listing_events/.test(sql) && JSON.stringify(params).includes("rawPayload")), false);
});

test("repository loads only published upload-policy evidence within the actor account", async () => {
  const calls = [];
  const repository = createAutoListingRepository({ pool: {
    async connect() { assert.fail("policy read must not open a transaction"); },
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows: [{
        id: "policy-review-v1", account_id: "account-a", version: "1", mode: "REVIEW", enabled: true,
        published_by: "admin-a", published_at: new Date("2026-08-08T00:00:00.000Z"),
      }] };
    },
  } });
  assert.deepEqual(await repository.loadPublishedUploadPolicies({ accountId: "account-a" }), [{
    id: "policy-review-v1", accountId: "account-a", version: 1, mode: "REVIEW", enabled: true,
    publishedBy: "admin-a", publishedAt: "2026-08-08T00:00:00.000Z",
  }]);
  assert.deepEqual(calls[0].params, ["account-a"]);
  assert.match(calls[0].sql, /WHERE account_id=\$1 AND enabled IS TRUE/iu);
  assert.match(calls[0].sql, /published_by IS NOT NULL AND published_at IS NOT NULL/iu);
  assert.doesNotMatch(calls[0].sql, /api.?key|credential|secret/iu);
});
