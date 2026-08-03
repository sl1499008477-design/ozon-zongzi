import assert from "node:assert/strict";
import test from "node:test";
import { createAutoListingService } from "../auto-listing-service.mjs";

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
