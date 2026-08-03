import assert from "node:assert/strict";
import test from "node:test";
import { createAutoListingService } from "../auto-listing-service.mjs";
import { createAutoListingRepository } from "../auto-listing-repository.mjs";
import { buildAutoListingSourceSnapshot } from "../auto-listing-source-snapshot.mjs";

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
      attributes: [], logistics: {}, productMeasurements: { reliable: true },
      currency: "RUB", images: [], variants: [{ sku: `sku-${id}`, offerId: `offer-${id}` }],
      ...price,
    },
  },
  productDraft: { id: `draft-${id}`, version: 3 },
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
  assert.equal(repository.calls.find(([name]) => name === "createJobGraph")[1].items.length, 2);
  assert.doesNotMatch(JSON.stringify(result), /raw-collect|credentialsSaved|textDensityByRole/);
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
      if (/SELECT strategy_key/.test(sql)) return { rows: [{ strategy_key: "strategy-a" }] };
      if (/FROM ai_content_strategy_rules/.test(sql)) return { rows: [] };
      if (/SELECT 1 FROM collect_items/.test(sql)) return { rows: [{}] };
      if (/FROM warehouses w JOIN stores/.test(sql)) return { rows: [{ id: "warehouse-a", store_id: "store-a", warehouse_id: "", owner_account_id: "account-a", warehouse_type: "FBS", status: "active", is_active: true, is_archived: false }] };
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
  const graphInput = {
    accountId: "account-a", actorAccountId: "account-a", sourceType: "COLLECT_BOX", idempotencyKey: "warehouse-empty", correlationId: "corr",
    configSnapshot: { targetStoreId: "store-a", targetWarehouseId: "warehouse-a", priceAdjustmentKopecks: "0" }, configHash: "config", strategyVersionId: "version-a", items: [item],
  };
  await assert.rejects(
    repository.createJobGraph({ ...graphInput, idempotencyKey: "raw-mismatch", items: [{ ...item, rawResponseRef: "another-raw" }] }),
    (error) => error?.code === "AUTO_LISTING_REPOSITORY_INVALID",
  );
  await assert.rejects(repository.createJobGraph({
    ...graphInput,
  }), (error) => error?.code === "LISTING_WAREHOUSE_NOT_ELIGIBLE" && error?.body?.reason === "WAREHOUSE_ID_MISSING");
});
