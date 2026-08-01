import assert from "node:assert/strict";
import test from "node:test";
import { createCollectorOzonEnrichmentService } from "../collector-ozon-enrichment-service.mjs";
import * as listingPipeline from "../listing-pipeline.mjs";

const NOW = new Date("2026-08-01T08:00:01.000Z");

function claimedJob() {
  return {
    id: "job-concurrent-merge",
    accountId: "account-a",
    collectItemId: "collect-concurrent-merge",
    requestId: "request-concurrent-merge",
    sku: "sku-concurrent-merge",
    status: "PROCESSING",
    claimedSessionId: "collector-a",
    claimExpiresAt: "2026-08-01T08:01:00.000Z",
    deadlineAt: "9999-12-31T23:59:59.999Z",
    attemptCount: 1,
    createdAt: "2026-08-01T08:00:00.000Z",
  };
}

function sellerVariantData() {
  return {
    description_category_id: 17_000_001,
    type_id: 97_000_001,
    weight: 500,
    depth: 300,
    width: 200,
    height: 100,
    attributes: [],
  };
}

function captureContext() {
  return {
    sellerCompanyId: "2681910",
    revision: 4,
    observedAt: "2026-08-01T08:00:00.000Z",
  };
}

function repository(job, order) {
  return {
    async readCache() { return null; },
    async tryAcquireCacheLease() { return null; },
    async releaseCacheLease() { return false; },
    async createOrGetJob() { return job; },
    async claimNextJob() { return null; },
    async deferClaim() { throw new Error("unused"); },
    async completeJobAndCache(input) {
      order.push("complete");
      job.status = "SUCCESS";
      return { ...job, result: structuredClone(input.result) };
    },
    async failJobAndCache() { throw new Error("unused"); },
    async readJob({ accountId, jobId }) {
      return accountId === job.accountId && jobId === job.id ? structuredClone(job) : null;
    },
  };
}

test("persisted collection summary wins over stale raw enrichment", () => {
  assert.equal(typeof listingPipeline.resolveCollectItemEnrichmentSummary, "function");
  assert.deepEqual(listingPipeline.resolveCollectItemEnrichmentSummary(
    { enrichment: { status: "COMPLETE", capturedAt: NOW.toISOString() } },
    { status: "PENDING_ENRICHMENT" },
  ), {
    status: "COMPLETE",
    capturedAt: NOW.toISOString(),
  });
  assert.deepEqual(listingPipeline.resolveCollectItemEnrichmentSummary(
    {},
    { status: "PENDING_ENRICHMENT" },
  ), { status: "PENDING_ENRICHMENT" });
});

test("completion reloads and fill-blank merges through three expected-version conflicts", async () => {
  const order = [];
  const job = claimedJob();
  let item = {
    id: job.collectItemId,
    accountId: job.accountId,
    draftVersion: 1,
    listingDraft: {
      title: "original",
      descriptionCategoryId: "",
      logistics: { weightG: "", lengthMm: "", widthMm: "", heightMm: "" },
    },
  };
  let saveAttempts = 0;
  const service = createCollectorOzonEnrichmentService({
    repository: repository(job, order),
    now: () => new Date(NOW),
    collectItems: {
      async read() { return structuredClone(item); },
      async save(input) {
        saveAttempts += 1;
        order.push(`save-${saveAttempts}`);
        if (saveAttempts === 1) {
          item.draftVersion = 2;
          item.listingDraft.logistics.weightG = 777;
        } else if (saveAttempts === 2) {
          item.draftVersion = 3;
          item.listingDraft.title = "user-edited";
        } else if (saveAttempts === 3) {
          item.draftVersion = 4;
          item.listingDraft.logistics.widthMm = 999;
        } else {
          assert.equal(input.expectedVersion, 4);
          item = {
            ...item,
            draftVersion: 5,
            listingDraft: structuredClone(input.listingDraft),
            status: input.status,
            enrichment: structuredClone(input.enrichment),
          };
          return structuredClone(item);
        }
        throw Object.assign(new Error("concurrent draft update"), {
          code: "DRAFT_VERSION_CONFLICT",
          status: 409,
        });
      },
      async retry() { throw new Error("unused"); },
    },
  });

  await service.completeClaim({
    session: { accountId: "account-a", collectorSessionId: "collector-a" },
    jobId: job.id,
    variantData: sellerVariantData(),
    captureContext: captureContext(),
  });

  assert.equal(saveAttempts, 4);
  assert.deepEqual(order, ["save-1", "save-2", "save-3", "save-4", "complete"]);
  assert.equal(item.listingDraft.title, "user-edited");
  assert.equal(item.listingDraft.logistics.weightG, 777);
  assert.equal(item.listingDraft.logistics.lengthMm, 300);
  assert.equal(item.listingDraft.logistics.widthMm, 999);
  assert.equal(item.listingDraft.logistics.heightMm, 100);
});

test("a fourth expected-version conflict leaves the job recoverable and never caches success", async () => {
  const order = [];
  const job = claimedJob();
  let version = 1;
  let saveAttempts = 0;
  const service = createCollectorOzonEnrichmentService({
    repository: repository(job, order),
    now: () => new Date(NOW),
    collectItems: {
      async read() {
        return {
          id: job.collectItemId,
          accountId: job.accountId,
          draftVersion: version,
          listingDraft: { logistics: {} },
        };
      },
      async save() {
        saveAttempts += 1;
        version += 1;
        throw Object.assign(new Error("concurrent draft update"), {
          code: "DRAFT_VERSION_CONFLICT",
          status: 409,
        });
      },
      async retry() { throw new Error("unused"); },
    },
  });

  await assert.rejects(service.completeClaim({
    session: { accountId: "account-a", collectorSessionId: "collector-a" },
    jobId: job.id,
    variantData: sellerVariantData(),
    captureContext: captureContext(),
  }), (error) => error?.code === "OZON_ENRICH_UPSTREAM_FAILED");

  assert.equal(saveAttempts, 4);
  assert.equal(order.includes("complete"), false);
  assert.equal(job.status, "PROCESSING");
});
