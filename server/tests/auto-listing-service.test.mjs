import assert from "node:assert/strict";
import test from "node:test";
import { createAutoListingService } from "../auto-listing-service.mjs";
import { createAutoListingRepository } from "../auto-listing-repository.mjs";
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

const source = (id, price = { blackKopecks: "10000", greenKopecks: "8000" }) => ({
  id,
  accountId: "account-a",
  sourceVersion: "3",
  rawResponseRef: `raw-${id}`,
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
  productDraft: { id: `draft-${id}`, version: 3 },
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
  let graph = existing;
  return {
    calls,
    async loadCollectSources(input) { calls.push(["loadCollectSources", input]); return sources; },
    async loadTargetStore(input) { calls.push(["loadTargetStore", input]); return { id: "store-a", ownerAccountId: input.accountId, status: "active", clientId: "client-a", credentialsSaved: true }; },
    async loadTargetWarehouse(input) { calls.push(["loadTargetWarehouse", input]); return { warehouse: { id: "warehouse-a", storeId: "store-a", accountId: input.accountId, warehouse_id: "1001", warehouse_type: "FBS", status: "active", is_active: true, is_archived: false }, products: [{ accountId: input.accountId, storeId: "store-a", warehouse_stocks: [{ warehouse_id: "1001", source: "fbs" }] }] }; },
    async loadPublishedStrategy(input) { calls.push(["loadPublishedStrategy", input]); return { strategyVersion: { strategyId: "strategy-a", strategyVersionId: "version-a" }, rules: [] }; },
    async getJobByIdempotencyKey(input) { calls.push(["getJobByIdempotencyKey", input]); return null; },
    async createJobGraph(input) { calls.push(["createJobGraph", input]); if (graph) return { ...graph, duplicate: true }; graph = { ...input, id: "job-1", createdAt: "2026-08-04T00:00:00.000Z" }; return graph; },
    async getJob(input) { calls.push(["getJob", input]); return graph && input.accountId === "account-a" ? graph : null; },
    async listJobs(input) { calls.push(["listJobs", input]); return graph && input.accountId === "account-a" ? [graph] : []; },
  };
}

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
  assert.equal(result.items[0].strategyVersionId, "version-a");
  assert.equal(result.items[0].price.finalPriceKopecks, "14500");
  assert.equal(repository.calls.find(([name]) => name === "loadCollectSources")[1].accountId, "account-a");
  const graph = repository.calls.find(([name]) => name === "createJobGraph")[1];
  assert.equal(graph.items.length, 2);
  assert.deepEqual(verifyAutoListingFrozenConfig(graph.configSnapshot, graph.configHash), {
    config: graph.configSnapshot,
    configHash: graph.configHash,
  });
  assert.doesNotMatch(JSON.stringify(result), /raw-collect|credentialsSaved|textDensityByRole/);
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

test("derives specification images per verified source snapshot without package dimensions", async () => {
  const unavailable = source("collect-no-product-size");
  unavailable.collectItem.listingDraft.productMeasurements = {};
  unavailable.collectItem.listingDraft.logistics = { length: 999, width: 999, height: 999, unit: "cm", source: "package" };
  const repository = fakeRepository({ sources: [source("collect-product-size"), unavailable] });
  await createAutoListingService({ repository }).createAutoListingJob({
    actor, collectItemIds: ["collect-product-size", "collect-no-product-size"], idempotencyKey: "mixed-sizes", correlationId: "corr", config,
  });
  const graph = repository.calls.find(([name]) => name === "createJobGraph")[1];
  assert.deepEqual(graph.items.map((item) => item.effectiveImageConfig.roles.specification), [1, 0]);
  assert.deepEqual(graph.items[1].effectiveImageConfig.reasonCodes, ["PRODUCT_DIMENSIONS_UNAVAILABLE"]);
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

test("isolates only closed source-business failures with separate blocked evidence", async () => {
  const missingCategory = source("collect-no-category");
  missingCategory.collectItem.listingDraft.categoryResolution.target.descriptionCategoryId = "";
  const missingSku = source("collect-no-sku");
  missingSku.collectItem.listingDraft.variants = [{ sku: "" }];
  const foreignCurrency = source("collect-usd");
  foreignCurrency.collectItem.listingDraft.currency = "USD";
  foreignCurrency.collectItem.listingDraft.variants[0].currency = "USD";
  const repository = fakeRepository({ sources: [source("collect-good"), missingCategory, missingSku, foreignCurrency] });

  const result = await createAutoListingService({ repository }).createAutoListingJob({
    actor,
    collectItemIds: ["collect-good", "collect-no-category", "collect-no-sku", "collect-usd"],
    idempotencyKey: "source-fact-isolation",
    correlationId: "corr",
    config,
  });

  assert.deepEqual(result.items.map((item) => [item.status, item.failureCode || null]), [
    ["SOURCE_READY", null],
    ["BLOCKED", "AUTO_LISTING_SOURCE_CATEGORY_REQUIRED"],
    ["BLOCKED", "AUTO_LISTING_SOURCE_SKU_REQUIRED"],
    ["BLOCKED", "AUTO_LISTING_SOURCE_CURRENCY_NOT_RUB"],
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

test("blocks store-mismatched category siblings without selecting their strategy or price", async () => {
  const wrong = source("collect-wrong");
  wrong.collectItem.listingDraft.categoryResolution.target.storeId = "store-other";
  const repository = fakeRepository({ sources: [source("collect-good"), wrong] });
  const result = await createAutoListingService({ repository }).createAutoListingJob({ actor, collectItemIds: ["collect-good", "collect-wrong"], idempotencyKey: "key-category", correlationId: "corr", config });
  assert.deepEqual(result.items.map((item) => item.status), ["SOURCE_READY", "BLOCKED"]);
  assert.equal(result.items[1].failureCode, "AUTO_LISTING_CATEGORY_TARGET_STORE_MISMATCH");
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

test("uses reliable ancestor IDs but never display category labels for strategy matching", async () => {
  const item = source("collect-ancestor");
  item.collectItem.listingDraft.categoryResolution.target.ancestorCategoryIds = ["ancestor-id"];
  item.collectItem.listingDraft.categoryResolution.source.path = ["Display only"];
  const repository = fakeRepository({ sources: [item] });
  repository.loadPublishedStrategy = async (input) => ({
    strategyVersion: { strategyId: "strategy-a", strategyVersionId: "version-a" },
    rules: [{ ruleId: "ancestor", ruleOrder: 1, matchType: "ANCESTOR_CATEGORY", categoryId: "ancestor-id", style: "PARAMETER_FIRST", textDensityByRole: {} }],
  });
  const result = await createAutoListingService({ repository }).createAutoListingJob({ actor, collectItemIds: ["collect-ancestor"], idempotencyKey: "ancestor-key", correlationId: "corr", config });
  assert.equal(result.items[0].matchedBy, "ANCESTOR_CATEGORY");
  assert.equal(result.items[0].style, "PARAMETER_FIRST");
});

test("bounds list requests and keeps cross-account same-key replays independent", async () => {
  const repository = fakeRepository();
  const service = createAutoListingService({ repository });
  await assert.rejects(service.listAutoListingJobs({ actor, limit: 0 }), (error) => error?.code === "AUTO_LISTING_REQUEST_INVALID");
  await assert.rejects(service.listAutoListingJobs({ actor, limit: 101 }), (error) => error?.code === "AUTO_LISTING_REQUEST_INVALID");
  await service.createAutoListingJob({ actor, collectItemIds: ["collect-1"], idempotencyKey: "same-key", correlationId: "corr", config });
  const otherRepository = fakeRepository({ sources: [{ ...source("collect-1"), accountId: "account-b", collectItem: { ...source("collect-1").collectItem, accountId: "account-b" } }] });
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
    rawResponseRef: "raw-warehouse", rawResponseHash: "raw-hash",
    collectItem: source("collect-warehouse").collectItem,
  });
  const client = {
    async query(sql) {
      if (/^(BEGIN|ROLLBACK)$/.test(sql)) return { rows: [] };
      if (/SELECT id FROM auto_listing_jobs/.test(sql)) return { rows: [] };
      if (/FROM stores s/.test(sql)) return { rows: [{ id: "store-a", owner_account_id: "account-a", label: "Store A", company_name: "Store A", client_id: "client-a", currency_code: "RUB", status: "active" }] };
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
    snapshot: captured.snapshot, snapshotHash: captured.snapshotHash, rawResponseRef: captured.rawResponseRef,
    targetStoreId: "store-a", targetWarehouseId: "warehouse-a", sourceOrder: 0, status: "SOURCE_READY",
    strategyId: "strategy-a", strategyVersionId: "version-a", ruleId: null, style: "BALANCED_DEFAULT", matchedBy: "DEFAULT",
    price: { currency: "RUB", branch: "BLACK_GTE_80", blackKopecks: "10000", greenKopecks: "8000", realPriceKopecks: "14500", adjustmentKopecks: "0", finalPriceKopecks: "14500" },
  };
  const frozen = frozenGraphConfig();
  const graphInput = {
    accountId: "account-a", actorAccountId: "account-a", sourceType: "COLLECT_BOX", idempotencyKey: "warehouse-empty", correlationId: "corr",
    configSnapshot: frozen.config, configHash: frozen.configHash, strategyVersionId: "version-a", items: [{ ...item, effectiveImageConfig: effectiveImageConfig(frozen, captured) }],
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
    rawResponseRef: "raw-config", rawResponseHash: "raw-hash", collectItem: source("collect-config").collectItem,
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
    rawResponseRef: "raw-rule", rawResponseHash: "raw-hash", collectItem,
  });
  const item = {
    sourceType: "COLLECT_BOX", sourceRecordId: "collect-rule", sourceVersion: "1", snapshot: captured.snapshot,
    snapshotHash: captured.snapshotHash, rawResponseRef: "raw-rule", targetStoreId: "store-a", targetWarehouseId: "warehouse-a",
    sourceOrder: 0, status: "SOURCE_READY", strategyId: "strategy-a", strategyVersionId: "version-a", ruleId: "rule-modern",
    style: "VISUAL_FIRST", matchedBy: "PRODUCT_STYLE",
    price: { currency: "RUB", branch: "BLACK_GTE_80", blackKopecks: "10000", greenKopecks: "8000", realPriceKopecks: "14500", adjustmentKopecks: "0", finalPriceKopecks: "14500" },
  };
  const frozen = frozenGraphConfig();
  const graphInput = {
    accountId: "account-a", actorAccountId: "account-a", sourceType: "COLLECT_BOX", idempotencyKey: "rule-key", correlationId: "corr",
    configSnapshot: frozen.config, configHash: frozen.configHash, strategyVersionId: "version-a", items: [{ ...item, effectiveImageConfig: effectiveImageConfig(frozen, captured) }],
  };
  const calls = [];
  const client = {
    async query(sql, params) {
      calls.push([sql, params]);
      if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql) || /INSERT INTO auto_listing_(jobs|job_items|events)/.test(sql)) return { rows: [] };
      if (/SELECT id FROM auto_listing_jobs/.test(sql)) return { rows: [] };
      if (/FROM stores s/.test(sql)) return { rows: [{ id: "store-a", owner_account_id: "account-a", label: "Store A", company_name: "Store A", client_id: "client-a", currency_code: "RUB", status: "active" }] };
      if (/FROM store_credentials/.test(sql)) return { rows: [{ store_id: "store-a" }] };
      if (/SELECT strategy_key/.test(sql)) return { rows: [{ strategy_key: "strategy-a" }] };
      if (/FROM ai_content_strategy_rules/.test(sql)) return { rows: [{ id: "rule-modern", rule_order: 1, rule_kind: "PRODUCT_STYLE", category_id: null, ancestor_category_id: null, product_style: "MODERN", rule: { style: "VISUAL_FIRST", textDensityByRole: {} } }] };
      if (/SELECT 1 FROM collect_items/.test(sql)) return { rows: [{}] };
      if (/FROM warehouses w/.test(sql)) return { rows: [{ id: "warehouse-a", store_id: "store-a", warehouse_id: "1001", warehouse_type: "FBS", status: "active", is_active: true, is_archived: false }] };
      if (/FROM product_stocks ps/.test(sql)) return { rows: [{ product_id: "product-a", product_store_id: "store-a", product_status: "active", product_is_archived: false, product_raw_is_archived: false, warehouse_id: "warehouse-a", source: "fbs" }] };
      if (/INSERT INTO auto_listing_source_snapshots/.test(sql)) return { rows: [{ id: "snapshot-a", snapshot_hash: captured.snapshotHash }] };
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
