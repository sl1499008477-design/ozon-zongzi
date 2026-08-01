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

test("PostgreSQL mirror summary preserves the latest enrichment during a later user edit", () => {
  assert.equal(typeof listingPipeline.buildCollectItemMirrorSummary, "function");
  assert.deepEqual(listingPipeline.buildCollectItemMirrorSummary({
    title: "edited title",
    primaryImage: "https://example.invalid/product.jpg",
    source: "ozon",
    enrichment: {
      status: "NEEDS_ATTENTION",
      attemptCount: 4,
      lastErrorCode: "OZON_ENRICH_NOT_FOUND",
    },
  }), {
    name: "edited title",
    image: "https://example.invalid/product.jpg",
    source: "ozon",
    enrichment: {
      status: "NEEDS_ATTENTION",
      attemptCount: 4,
      lastErrorCode: "OZON_ENRICH_NOT_FOUND",
    },
  });
});

function completionFailureHarness(error) {
  const order = [];
  const job = claimedJob();
  let visibleItem = {
    id: job.collectItemId,
    accountId: job.accountId,
    status: "RETRYING",
    draftVersion: 1,
    listingDraft: { title: "visible draft", logistics: {} },
    enrichment: { status: "RETRYING", attemptCount: 1 },
  };
  const terminalFailure = async () => { throw error; };
  const service = createCollectorOzonEnrichmentService({
    repository: {
      ...repository(job, order),
      completeJobAndCache: terminalFailure,
    },
    now: () => new Date(NOW),
    collectItems: {
      async read() { return structuredClone(visibleItem); },
      async save(input) {
        visibleItem = {
          ...visibleItem,
          status: input.status,
          listingDraft: structuredClone(input.listingDraft),
          enrichment: structuredClone(input.enrichment),
          draftVersion: visibleItem.draftVersion + 1,
        };
        return structuredClone(visibleItem);
      },
      async complete() { throw error; },
      async fail() { throw new Error("unused"); },
      async retry() { throw new Error("unused"); },
    },
  });
  return { service, job, visibleItem: () => structuredClone(visibleItem) };
}

test("linked complete persistence failure leaves no visible COMPLETE item", async () => {
  const h = completionFailureHarness(Object.assign(new Error("disk unavailable"), {
    code: "OZON_ENRICHMENT_PERSISTENCE_FAILED",
    status: 500,
  }));

  await assert.rejects(h.service.completeClaim({
    session: { accountId: "account-a", collectorSessionId: "collector-a" },
    jobId: h.job.id,
    variantData: sellerVariantData(),
    captureContext: captureContext(),
  }), (error) => error?.code === "OZON_ENRICH_UPSTREAM_FAILED");

  assert.equal(h.visibleItem().status, "RETRYING");
  assert.deepEqual(h.visibleItem().listingDraft, { title: "visible draft", logistics: {} });
  assert.equal(h.job.status, "PROCESSING");
});

test("linked claim loss during final commit leaves no visible COMPLETE item", async () => {
  const h = completionFailureHarness(Object.assign(new Error("claim lost"), {
    code: "OZON_ENRICHMENT_JOB_OWNERSHIP",
    status: 409,
  }));

  await assert.rejects(h.service.completeClaim({
    session: { accountId: "account-a", collectorSessionId: "collector-a" },
    jobId: h.job.id,
    variantData: sellerVariantData(),
    captureContext: captureContext(),
  }), (error) => error?.code === "OZON_ENRICHMENT_JOB_OWNERSHIP");

  assert.equal(h.visibleItem().status, "RETRYING");
  assert.deepEqual(h.visibleItem().listingDraft, { title: "visible draft", logistics: {} });
  assert.equal(h.job.status, "PROCESSING");
});

test("linked completion rechecks the clock after a slow merge crosses claim expiry", async () => {
  const order = [];
  const job = claimedJob();
  let clock = NOW.getTime();
  job.claimExpiresAt = new Date(clock + 1_000).toISOString();
  let visibleItem = {
    id: job.collectItemId,
    accountId: job.accountId,
    status: "RETRYING",
    draftVersion: 1,
    listingDraft: { title: "keep", logistics: {} },
    enrichment: { status: "RETRYING", attemptCount: 1 },
  };
  const jobRepository = repository(job, order);
  jobRepository.completeJobAndCache = async (input) => {
    if (input.now.getTime() >= new Date(job.claimExpiresAt).getTime()) {
      throw Object.assign(new Error("claim expired during merge"), {
        code: "OZON_ENRICHMENT_JOB_OWNERSHIP",
        status: 409,
      });
    }
    job.status = "SUCCESS";
    return structuredClone(job);
  };
  const service = createCollectorOzonEnrichmentService({
    repository: jobRepository,
    now: () => new Date(clock),
    collectItems: {
      async read() {
        clock = new Date(job.claimExpiresAt).getTime();
        return structuredClone(visibleItem);
      },
      async save() { throw new Error("unused"); },
      async complete(input) {
        await jobRepository.completeJobAndCache(input.completion);
        visibleItem = {
          ...visibleItem,
          status: input.status,
          listingDraft: structuredClone(input.listingDraft),
          enrichment: structuredClone(input.enrichment),
        };
        return structuredClone(visibleItem);
      },
      async fail() { throw new Error("unused"); },
      async retry() { throw new Error("unused"); },
    },
  });

  await assert.rejects(service.completeClaim({
    session: { accountId: "account-a", collectorSessionId: "collector-a" },
    jobId: job.id,
    variantData: sellerVariantData(),
    captureContext: captureContext(),
  }), (error) => error?.code === "OZON_ENRICHMENT_JOB_OWNERSHIP");

  assert.equal(visibleItem.status, "RETRYING");
  assert.equal(job.status, "PROCESSING");
});

test("PostgreSQL permanent failure helper commits job truth and item summary on one scoped client", async () => {
  assert.equal(typeof listingPipeline.failCollectItemEnrichmentWithClientV4, "function");
  const calls = [];
  const client = {
    async query(sql, params = []) {
      const normalized = String(sql).replace(/\s+/g, " ").trim();
      calls.push({ sql: normalized, params });
      if (normalized.startsWith("SELECT c.id")) {
        return { rows: [{
          id: "collect-failure-pg",
          account_id: "account-a",
          status: "RETRYING",
          summary: { enrichment: { status: "RETRYING", attemptCount: 3 } },
          draft_data: { title: "keep" },
          draft_version: 2,
        }], rowCount: 1 };
      }
      if (normalized.startsWith("UPDATE collect_items")) {
        return { rows: [{
          id: "collect-failure-pg",
          account_id: "account-a",
          status: "NEEDS_ATTENTION",
          summary: JSON.parse(params[2]),
        }], rowCount: 1 };
      }
      throw new Error(`unexpected query: ${normalized}`);
    },
  };
  const result = await listingPipeline.failCollectItemEnrichmentWithClientV4(client, {
    collectItemId: "collect-failure-pg",
    accountId: "account-a",
    status: "NEEDS_ATTENTION",
    enrichment: {
      status: "NEEDS_ATTENTION",
      missingFields: [],
      attemptCount: 3,
      nextAttemptAt: "",
      lastErrorCode: "OZON_ENRICH_NOT_FOUND",
    },
    failJobAndCache: async (receivedClient) => {
      assert.equal(receivedClient, client);
      return { id: "job-failure-pg", accountId: "account-a", attemptCount: 4, status: "FAILED" };
    },
  });

  assert.equal(result.job.attemptCount, 4);
  assert.equal(result.item.enrichment.attemptCount, 4);
  assert.equal(result.item.status, "NEEDS_ATTENTION");
  assert.deepEqual(calls[0].params, ["collect-failure-pg", "account-a"]);
  assert.deepEqual(calls[1].params.slice(0, 2), ["collect-failure-pg", "account-a"]);
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
  const jobRepository = repository(job, order);
  const service = createCollectorOzonEnrichmentService({
    repository: jobRepository,
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
      async complete(input) {
        const saved = await this.save(input);
        await jobRepository.completeJobAndCache(input.completion);
        return saved;
      },
      async fail() { throw new Error("unused"); },
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
  const jobRepository = repository(job, order);
  const service = createCollectorOzonEnrichmentService({
    repository: jobRepository,
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
      async complete(input) {
        const saved = await this.save(input);
        await jobRepository.completeJobAndCache(input.completion);
        return saved;
      },
      async fail() { throw new Error("unused"); },
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
