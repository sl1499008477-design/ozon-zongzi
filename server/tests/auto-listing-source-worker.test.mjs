import assert from "node:assert/strict";
import test from "node:test";

import { createAutoListingSourceWorker } from "../auto-listing-source-worker.mjs";

function message(overrides = {}) {
  return {
    id: "source-1", accountId: "account-a", importFileId: "import-1", rowId: "row-1",
    sku: "7003", state: "PROCESSING", stateVersion: 1, attempts: 1,
    leaseToken: "lease-a", leaseGeneration: 1, ...overrides,
  };
}

function harness({ result = { scraped: true, item: { id: "collect-7003" } }, collectError } = {}) {
  const calls = { claim: 0, collect: [], complete: [], fail: [] };
  let next = message();
  const worker = createAutoListingSourceWorker({
    workerId: "worker-a",
    repository: {
      async claimNext(input) { calls.claim += 1; const value = next; next = null; return value; },
      async completeCollection(input) { calls.complete.push(input); return { completed: true, duplicate: false }; },
      async failCollection(input) { calls.fail.push(input); return { state: "PENDING", attempts: 1 }; },
    },
    async collectSku(input) {
      calls.collect.push(structuredClone(input));
      if (collectError) throw collectError;
      return result;
    },
  });
  return { worker, calls };
}

test("collects a claimed SKU only in its account and completes with the persisted item id", async () => {
  const { worker, calls } = harness();
  const result = await worker.processAccount({ accountId: "account-a", limit: 5 });
  assert.deepEqual(result, { claimed: 1, completed: 1, retried: 0, dead: 0 });
  assert.deepEqual(calls.collect, [{ account: { id: "account-a", role: "user" }, sku: "7003" }]);
  assert.equal(calls.complete[0].collectItemId, "collect-7003");
  assert.equal(calls.fail.length, 0);
});

test("keeps valid Unicode SKU text instead of treating it as an internal identifier", async () => {
  const calls = { complete: [] };
  let claimed = false;
  const worker = createAutoListingSourceWorker({
    workerId: "worker-a",
    repository: {
      async claimNext() {
        if (claimed) return null;
        claimed = true;
        return message({ sku: "товар 7003" });
      },
      async completeCollection(input) { calls.complete.push(input); return { completed: true }; },
      async failCollection() { assert.fail("valid SKU must not fail"); },
    },
    async collectSku({ sku }) { return { scraped: true, item: { id: sku } }; },
  });
  await worker.processAccount({ accountId: "account-a", limit: 1 });
  assert.equal(calls.complete[0].collectItemId, "товар 7003");
});

test("an empty scrape is retried and never promotes its fallback collect row", async () => {
  const { worker, calls } = harness({ result: { scraped: false, code: "OZON_SKU_SCRAPE_EMPTY", item: { id: "fallback" } } });
  const result = await worker.processAccount({ accountId: "account-a", limit: 1 });
  assert.deepEqual(result, { claimed: 1, completed: 0, retried: 1, dead: 0 });
  assert.equal(calls.complete.length, 0);
  assert.deepEqual(calls.fail[0], {
    accountId: "account-a", outboxId: "source-1", rowId: "row-1", leaseToken: "lease-a",
    errorCode: "OZON_SKU_SCRAPE_EMPTY", retryable: true,
  });
});

test("collector failures become one stable retry request without leaking upstream text", async () => {
  const { worker, calls } = harness({ collectError: new Error("cookie=secret") });
  await worker.processAccount({ accountId: "account-a", limit: 1 });
  assert.equal(calls.fail[0].errorCode, "OZON_SKU_COLLECTION_FAILED");
  assert.equal(JSON.stringify(calls.fail[0]).includes("secret"), false);
});

test("malformed persisted results fail closed instead of completing the row", async () => {
  for (const result of [{ scraped: true, item: {} }, { scraped: true, item: { id: "../foreign" } }, null]) {
    const { worker, calls } = harness({ result });
    await worker.processAccount({ accountId: "account-a", limit: 1 });
    assert.equal(calls.complete.length, 0);
    assert.equal(calls.fail[0].errorCode, "AUTO_LISTING_SOURCE_RESULT_INVALID");
    assert.equal(calls.fail[0].retryable, false);
  }
});
