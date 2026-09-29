import assert from "node:assert/strict";
import test from "node:test";
import { createPostgresCollectorOzonEnrichmentRepository } from "../collector-ozon-enrichment-repository.mjs";
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
    async advanceSellerContext() { throw new Error("unused"); },
    async claimNextJob() { return null; },
    async hasClaimableJob() { return false; },
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
    async expireUnlinkedJob() { return null; },
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
      lastErrorCode: "ZONGZI_ENRICH_NOT_FOUND",
    },
  }), {
    name: "edited title",
    image: "https://example.invalid/product.jpg",
    source: "ozon",
    enrichment: {
      status: "NEEDS_ATTENTION",
      attemptCount: 4,
      lastErrorCode: "ZONGZI_ENRICH_NOT_FOUND",
    },
  });
});

test("first complete collection draft reads physicals from normalized logistics without an existing draft", () => {
  assert.equal(typeof listingPipeline.buildCollectItemDraftV4, "function");
  const draft = listingPipeline.buildCollectItemDraftV4({
    sku: "sku-first-complete",
    title: "First complete item",
    sourceCategory: { descriptionCategoryId: 17_000_001 },
    logistics: { weightG: 500, lengthMm: 300, widthMm: 200, heightMm: 100 },
  });

  assert.equal(draft.packageWeight, 500);
  assert.equal(draft.packageLength, 300);
  assert.equal(draft.packageWidth, 200);
  assert.equal(draft.packageHeight, 100);
  assert.deepEqual(draft.sourceCategory, { descriptionCategoryId: 17_000_001 });
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
    code: "ZONGZI_ENRICHMENT_PERSISTENCE_FAILED",
    status: 500,
  }));

  await assert.rejects(h.service.completeClaim({
    session: { accountId: "account-a", collectorSessionId: "collector-a" },
    jobId: h.job.id,
    variantData: sellerVariantData(),
    captureContext: captureContext(),
  }), (error) => error?.code === "ZONGZI_ENRICH_UPSTREAM_FAILED");

  assert.equal(h.visibleItem().status, "RETRYING");
  assert.deepEqual(h.visibleItem().listingDraft, { title: "visible draft", logistics: {} });
  assert.equal(h.job.status, "PROCESSING");
});

test("linked claim loss during final commit leaves no visible COMPLETE item", async () => {
  const h = completionFailureHarness(Object.assign(new Error("claim lost"), {
    code: "ZONGZI_ENRICHMENT_JOB_OWNERSHIP",
    status: 409,
  }));

  await assert.rejects(h.service.completeClaim({
    session: { accountId: "account-a", collectorSessionId: "collector-a" },
    jobId: h.job.id,
    variantData: sellerVariantData(),
    captureContext: captureContext(),
  }), (error) => error?.code === "ZONGZI_ENRICHMENT_JOB_OWNERSHIP");

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
        code: "ZONGZI_ENRICHMENT_JOB_OWNERSHIP",
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
        assert.equal(input.completion.now, undefined);
        await jobRepository.completeJobAndCache({ ...input.completion, now: new Date(clock) });
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
  }), (error) => error?.code === "ZONGZI_ENRICHMENT_JOB_OWNERSHIP");

  assert.equal(visibleItem.status, "RETRYING");
  assert.equal(job.status, "PROCESSING");
});

test("PostgreSQL success transaction samples the terminal clock after connection, row-lock, and mirror waits", async (t) => {
  assert.equal(typeof listingPipeline.completeCollectItemEnrichmentWithClientV4, "function");
  const waitSteps = ["pool acquire", "collect item FOR UPDATE", "draft mirror"];
  for (const delayedStep of waitSteps) {
    await t.test(delayedStep, async () => {
      const startedAt = new Date("2026-08-01T08:00:01.000Z");
      const claimExpiresAt = new Date("2026-08-01T08:00:02.000Z");
      let clock = startedAt.getTime();
      let visibleItem = { status: "RETRYING", draftVersion: 3 };
      let stagedItem = null;
      let cacheWrites = 0;
      const processingJob = {
        id: "job-delayed-terminal",
        account_id: "account-a",
        collect_item_id: "collect-delayed-terminal",
        request_id: "request-delayed-terminal",
        sku: "sku-delayed-terminal",
        status: "PROCESSING",
        refresh_bundle: {},
        attempt_count: 2,
        next_attempt_at: "2026-08-01T08:00:00.000Z",
        claimed_session_id: "collector-a",
        claim_expires_at: claimExpiresAt.toISOString(),
        deadline_at: "9999-12-31T23:59:59.999Z",
        created_at: "2026-08-01T08:00:00.000Z",
        updated_at: startedAt.toISOString(),
      };
      const client = {
        async query(sql, params = []) {
          const normalized = String(sql).replace(/\s+/g, " ").trim();
          if (normalized.startsWith("SELECT c.*,d.data")) {
            if (delayedStep === "collect item FOR UPDATE") clock = claimExpiresAt.getTime();
            return { rows: [{
              id: "collect-delayed-terminal",
              account_id: "account-a",
              source_sku: "sku-delayed-terminal",
              source_url: "https://example.invalid/product",
              source: "ozon",
              identity_key: "identity-delayed-terminal",
              status: "RETRYING",
              summary: { enrichment: { status: "RETRYING", attemptCount: 2 } },
              draft_data: { title: "keep", logistics: {} },
              draft_version: 3,
              raw_payload: { normalized: { sku: "sku-delayed-terminal", source: "ozon" } },
            }], rowCount: 1 };
          }
          if (normalized === "SELECT 1 FROM accounts WHERE id=$1") {
            if (delayedStep === "draft mirror") clock = claimExpiresAt.getTime();
            return { rows: [{ exists: 1 }], rowCount: 1 };
          }
          if (normalized.startsWith("SELECT id, payload_hash FROM collect_raw_payloads")) {
            return { rows: [{ id: "raw-delayed-terminal", payload_hash: "old" }], rowCount: 1 };
          }
          if (normalized.startsWith("INSERT INTO collect_items")) {
            return { rows: [{ id: "collect-delayed-terminal" }], rowCount: 1 };
          }
          if (normalized.startsWith("SELECT version, data_hash, data FROM product_drafts")) {
            return { rows: [{ version: 3, data_hash: "old", data: {} }], rowCount: 1 };
          }
          if (
            normalized.startsWith("UPDATE product_drafts SET")
            || normalized.startsWith("INSERT INTO product_draft_revisions")
            || normalized.startsWith("DELETE FROM product_draft_variants")
            || normalized.startsWith("UPDATE collect_items SET current_draft_id")
          ) {
            return { rows: [], rowCount: 1 };
          }
          if (normalized.startsWith("UPDATE collect_items SET status=")) {
            stagedItem = { status: "COMPLETE", draftVersion: 4 };
            return { rows: [{
              id: "collect-delayed-terminal",
              account_id: "account-a",
              status: "COMPLETE",
              summary: JSON.parse(params[3]),
            }], rowCount: 1 };
          }
          if (normalized.startsWith("UPDATE collector_ozon_enrichment_jobs")) {
            assert.equal(params[3].getTime(), claimExpiresAt.getTime());
            return { rows: [], rowCount: 0 };
          }
          if (normalized.startsWith("SELECT pg_advisory_xact_lock")) {
            return { rows: [{ pg_advisory_xact_lock: null }], rowCount: 1 };
          }
          if (normalized.startsWith("SELECT id,seller_context_json FROM collector_sessions")) {
            return { rows: [{ id: "collector-a", seller_context_json: null }], rowCount: 1 };
          }
          if (normalized.startsWith("SELECT id FROM collector_sessions")) {
            return { rows: [{ id: "collector-a" }], rowCount: 1 };
          }
          if (normalized.startsWith("SELECT * FROM collector_ozon_enrichment_jobs")) {
            return { rows: [processingJob], rowCount: 1 };
          }
          if (normalized.startsWith("INSERT INTO collector_ozon_enrichment_cache")) {
            cacheWrites += 1;
          }
          throw new Error(`unexpected query: ${normalized}`);
        },
      };
      const terminalRepository = createPostgresCollectorOzonEnrichmentRepository({
        pool: client,
        transactionOwner: "caller",
      });
      const completion = {
        accountId: "account-a",
        collectorSessionId: "collector-a",
        jobId: processingJob.id,
        key: {
          accountId: "account-a",
          source: "ozon",
          sku: "sku-delayed-terminal",
          contractVersion: "collector.ozon.enrichment.v1",
        },
        result: { status: "COMPLETE", sku: "sku-delayed-terminal" },
        responseHash: "delayed-terminal-hash",
        capturedAt: startedAt,
        expiresAt: new Date("2026-08-01T14:00:01.000Z"),
      };

      await assert.rejects((async () => {
        try {
          if (delayedStep === "pool acquire") clock = claimExpiresAt.getTime();
          const saved = await listingPipeline.completeCollectItemEnrichmentWithClientV4(client, {
            collectItemId: "collect-delayed-terminal",
            accountId: "account-a",
            expectedVersion: 3,
            listingDraft: { title: "keep", logistics: { weightG: 500 } },
            status: "COMPLETE",
            enrichment: { status: "COMPLETE", attemptCount: 2 },
            completeJobAndCache: async (transactionClient) => {
              assert.equal(transactionClient, client);
              return terminalRepository.completeJobAndCache({
                ...completion,
                now: new Date(clock),
              });
            },
          });
          visibleItem = saved;
        } catch (error) {
          stagedItem = null;
          throw error;
        }
      })(), (error) => error?.code === "ZONGZI_ENRICHMENT_JOB_OWNERSHIP");

      assert.deepEqual(visibleItem, { status: "RETRYING", draftVersion: 3 });
      assert.equal(stagedItem, null);
      assert.equal(processingJob.status, "PROCESSING");
      assert.equal(cacheWrites, 0);
    });
  }
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
      lastErrorCode: "ZONGZI_ENRICH_NOT_FOUND",
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

test("PostgreSQL retryable defer locks the item and lets COMPLETE evidence close the job without an item downgrade", async () => {
  assert.equal(typeof listingPipeline.deferCollectItemEnrichmentWithClientV4, "function");
  const order = [];
  const client = {
    async query(sql, params = []) {
      const normalized = String(sql).replace(/\s+/g, " ").trim();
      if (normalized.startsWith("SELECT c.id")) {
        order.push("lock-item");
        assert.deepEqual(params, ["collect-defer-complete-pg", "account-a"]);
        return { rows: [{
          id: "collect-defer-complete-pg",
          account_id: "account-a",
          status: "COMPLETE",
          summary: { enrichment: { status: "COMPLETE", missingFields: [] } },
          draft_data: {
            sourceCategory: { descriptionCategoryId: 17_000_001 },
            logistics: { weightG: 500, lengthMm: 300, widthMm: 200, heightMm: 100 },
          },
          draft_version: 4,
        }], rowCount: 1 };
      }
      if (normalized.startsWith("UPDATE collect_items")) {
        throw new Error("COMPLETE collect item must not be downgraded");
      }
      throw new Error(`unexpected query: ${normalized}`);
    },
  };

  const result = await listingPipeline.deferCollectItemEnrichmentWithClientV4(client, {
    collectItemId: "collect-defer-complete-pg",
    accountId: "account-a",
    status: "RETRYING",
    error: { code: "ZONGZI_ENRICH_UPSTREAM_FAILED" },
    deferJob: async (receivedClient) => {
      assert.equal(receivedClient, client);
      order.push("defer-job");
      return {
        id: "job-defer-complete-pg",
        sku: "sku-defer-complete-pg",
        status: "PENDING",
        attemptCount: 3,
        nextAttemptAt: "2026-08-01T11:02:00.000Z",
      };
    },
    completeLinkedJobs: async (receivedClient, deferredJob) => {
      assert.equal(receivedClient, client);
      assert.equal(deferredJob.status, "PENDING");
      order.push("close-job");
      return { ...deferredJob, status: "SUCCESS" };
    },
  });

  assert.deepEqual(order, ["lock-item", "defer-job", "close-job"]);
  assert.equal(result.item.status, "COMPLETE");
  assert.equal(result.item.enrichment.status, "COMPLETE");
  assert.equal(result.job.status, "SUCCESS");
});

test("PostgreSQL manual retry leaves a COMPLETE item and its terminal job history unchanged", async () => {
  assert.equal(typeof listingPipeline.retryCollectItemEnrichmentWithClientV4, "function");
  const order = [];
  const client = {
    async query(sql, params = []) {
      const normalized = String(sql).replace(/\s+/g, " ").trim();
      if (normalized.startsWith("SELECT c.id")) {
        order.push("lock-item");
        assert.deepEqual(params, ["collect-retry-complete-pg", "account-a"]);
        return { rows: [{
          id: "collect-retry-complete-pg",
          account_id: "account-a",
          status: "COMPLETE",
          summary: { enrichment: { status: "COMPLETE", missingFields: [] } },
          draft_data: {
            sourceCategory: { descriptionCategoryId: 17_000_001 },
            logistics: { weightG: 500, lengthMm: 300, widthMm: 200, heightMm: 100 },
          },
          draft_version: 4,
        }], rowCount: 1 };
      }
      if (normalized.startsWith("SELECT * FROM collector_ozon_enrichment_jobs")) {
        order.push("read-terminal-job");
        assert.match(normalized, /status='SUCCESS'/);
        return { rows: [{
          id: "job-retry-complete-pg",
          account_id: "account-a",
          collect_item_id: "collect-retry-complete-pg",
          request_id: "request-retry-complete-pg",
          sku: "sku-retry-complete-pg",
          status: "SUCCESS",
          attempt_count: 2,
          result_json: { status: "COMPLETE", source: "COLLECTED_PUBLIC_EVIDENCE" },
          created_at: "2026-08-01T08:00:00.000Z",
          updated_at: "2026-08-01T08:05:00.000Z",
          completed_at: "2026-08-01T08:05:00.000Z",
        }], rowCount: 1 };
      }
      if (normalized.startsWith("UPDATE ")) throw new Error("terminal retry must not update rows");
      throw new Error(`unexpected query: ${normalized}`);
    },
  };

  const result = await listingPipeline.retryCollectItemEnrichmentWithClientV4(client, {
    collectItemId: "collect-retry-complete-pg",
    accountId: "account-a",
    now: new Date("2026-08-01T08:10:00.000Z"),
  });

  assert.deepEqual(order, ["lock-item", "read-terminal-job"]);
  assert.equal(result.item.status, "COMPLETE");
  assert.equal(result.item.enrichment.status, "COMPLETE");
  assert.equal(result.job.status, "SUCCESS");
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
  }), (error) => error?.code === "ZONGZI_ENRICH_UPSTREAM_FAILED");

  assert.equal(saveAttempts, 4);
  assert.equal(order.includes("complete"), false);
  assert.equal(job.status, "PROCESSING");
});

test('retry of a recollected item creates a task for its missing child instead of returning not found', async()=>{
 const row={id:'new-item',account_id:'account-a',status:'PENDING_ENRICHMENT',summary:{enrichment:{status:'PENDING_ENRICHMENT'}},draft_version:1,draft_data:{sku:'parent',sourceCategory:{descriptionCategoryId:123},logistics:{weightG:100,lengthMm:10,widthMm:10,heightMm:10},variants:[{sku:'child'}]}};
 let job=null;
 const client={async query(sql,args){
  const q=sql.replace(/\s+/g,' ').trim();
  if(q.startsWith('SELECT c.id'))return {rows:[row]};
  if(q.startsWith('SELECT pg_advisory'))return {rows:[]};
  if(q.startsWith('SELECT * FROM collector_ozon_enrichment_jobs'))return {rows:job?[job]:[]};
  if(q.startsWith('INSERT INTO collector_ozon_enrichment_jobs')){
   assert.equal(args[2],'new-item');assert.equal(args[4],'child');
   job={id:args[0],account_id:args[1],collect_item_id:args[2],request_id:args[3],sku:args[4],status:'PENDING',attempt_count:0,created_at:NOW,updated_at:NOW};return {rows:[job]};
  }
  if(q.startsWith('UPDATE collector_ozon_enrichment_jobs'))return {rows:[job]};
  if(q.startsWith('UPDATE collect_items'))return {rows:[{...row,summary:JSON.parse(args[2])}]};
  throw new Error(q);
 }};
 const result=await listingPipeline.retryCollectItemEnrichmentWithClientV4(client,{accountId:'account-a',collectItemId:'new-item',now:NOW});
 assert.equal(result.job.sku,'child');assert.equal(result.item.enrichment.status,'RETRYING');
});
