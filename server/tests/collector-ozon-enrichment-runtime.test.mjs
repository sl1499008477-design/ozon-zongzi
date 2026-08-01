import assert from "node:assert/strict";
import test from "node:test";
import { createCollectorOzonEnrichmentRuntime } from "../collector-ozon-enrichment-runtime.mjs";
import { createJsonStateTransactionBoundary } from "../json-state-transaction.mjs";

const NOW = new Date("2026-07-31T00:00:00.000Z");

function cacheResult(sku) {
  return {
    status: "COMPLETE",
    result: {
      status: "COMPLETE",
      contractVersion: "collector.ozon.enrichment.v1",
      sku,
      descriptionCategoryId: 123,
      logistics: { weightG: 500, lengthMm: 300, widthMm: 200, heightMm: 100 },
      variantData: { description_category_id: 123 },
      source: "BACKEND_FLEET",
      capturedAt: NOW.toISOString(),
      cache: { hit: false, expiresAt: new Date(NOW.getTime() + 21_600_000).toISOString() },
    },
    expiresAt: new Date(NOW.getTime() + 21_600_000).toISOString(),
  };
}

function versionedClone(state, version) {
  const value = structuredClone(state);
  Object.defineProperty(value, "__storageVersion", {
    value: version,
    enumerable: false,
    configurable: true,
    writable: true,
  });
  return value;
}

function cacheOnlyRepository() {
  return {
    async readCache({ key }) { return cacheResult(key.sku); },
    async tryAcquireCacheLease() { throw new Error("cache hit must not lease"); },
    async releaseCacheLease() { return false; },
    async createOrGetJob() { throw new Error("cache hit must not create"); },
    async claimNextJob() { return null; },
    async completeJobAndCache() { throw new Error("unused"); },
    async failJobAndCache() { throw new Error("unused"); },
    async readJob() { return null; },
  };
}

test("PostgreSQL-mode enrichment writes dedicated audit rows without rewriting legacy state", async () => {
  const persistedAudits = [];
  let loadCount = 0;
  let saveCount = 0;
  const loggerSignals = [];
  const repository = cacheOnlyRepository();
  const runtime = createCollectorOzonEnrichmentRuntime({
    loadState: async () => {
      loadCount += 1;
      return versionedClone({ auditEvents: [] }, 1);
    },
    saveState: async () => { saveCount += 1; },
    persistenceMode: () => "postgres",
    stateTransaction: createJsonStateTransactionBoundary({ enabled: () => false }),
    authenticate: async () => ({ collectorSessionId: "collector-runtime", accountId: "account-runtime" }),
    readJson: async () => ({}),
    sendJson() {},
    initializePostgresRepository: async () => repository,
    persistPostgresAuditEvent: async (event) => { persistedAudits.push(event); },
    now: () => new Date(NOW),
    logger: { error(...args) { loggerSignals.push(args); } },
  });

  const output = await runtime.service.enrichBatch({
    session: { collectorSessionId: "collector-runtime", accountId: "account-runtime" },
    requestId: "request-runtime-audit",
    skus: ["sku-runtime-1", "sku-runtime-2", "sku-runtime-3", "sku-runtime-4"],
  });

  assert.equal(output.every((item) => item.status === "COMPLETE"), true);
  const enrichmentAudits = persistedAudits.filter(
    (event) => event.source === "collector-ozon-enrichment",
  );
  assert.equal(enrichmentAudits.length, 4);
  assert.deepEqual(
    new Set(enrichmentAudits.map((event) => event.metadata.sku)),
    new Set(["sku-runtime-1", "sku-runtime-2", "sku-runtime-3", "sku-runtime-4"]),
  );
  assert.equal(loadCount, 0);
  assert.equal(saveCount, 0);
  assert.deepEqual(loggerSignals, []);
});

test("JSON-mode concurrent enrichment audits remain serialized with repository state writes", async () => {
  const skus = ["sku-json-1", "sku-json-2", "sku-json-3", "sku-json-4"];
  let persisted = {
    auditEvents: [],
    collectorOzonEnrichmentCache: skus.map((sku) => ({
      accountId: "account-runtime",
      source: "ozon",
      sku,
      contractVersion: "collector.ozon.enrichment.v1",
      ...cacheResult(sku),
    })),
  };
  const stateTransaction = createJsonStateTransactionBoundary({ enabled: () => true });
  const runtime = createCollectorOzonEnrichmentRuntime({
    loadState: async () => structuredClone(persisted),
    saveState: async (state) => { persisted = structuredClone(state); },
    persistenceMode: () => "json",
    stateTransaction,
    authenticate: async () => ({ collectorSessionId: "collector-runtime", accountId: "account-runtime" }),
    readJson: async () => ({}),
    sendJson() {},
    now: () => new Date(NOW),
  });

  const output = await runtime.service.enrichBatch({
    session: { collectorSessionId: "collector-runtime", accountId: "account-runtime" },
    requestId: "request-json-audit",
    skus,
  });

  assert.equal(output.every((item) => item.status === "COMPLETE"), true);
  assert.equal(
    persisted.auditEvents.filter((event) => event.source === "collector-ozon-enrichment").length,
    4,
  );
});

test("PostgreSQL audit write failure emits only a safe logger signal", async () => {
  let auditAttempts = 0;
  const loggerSignals = [];
  const runtime = createCollectorOzonEnrichmentRuntime({
    loadState: async () => versionedClone({ auditEvents: [] }, 1),
    saveState: async () => { throw new Error("legacy state must not be saved"); },
    persistenceMode: () => "postgres",
    stateTransaction: createJsonStateTransactionBoundary({ enabled: () => false }),
    authenticate: async () => ({ collectorSessionId: "collector-runtime", accountId: "account-runtime" }),
    readJson: async () => ({}),
    sendJson() {},
    initializePostgresRepository: async () => cacheOnlyRepository(),
    persistPostgresAuditEvent: async () => {
      auditAttempts += 1;
      throw new Error("database relation and credential detail");
    },
    now: () => new Date(NOW),
    logger: { error(...args) { loggerSignals.push(args); } },
  });

  const result = await runtime.service.enrichOne({
    session: { collectorSessionId: "collector-runtime", accountId: "account-runtime" },
    requestId: "request-exhausted-audit",
    sku: "sku-exhausted-audit",
  });

  assert.equal(result.cache.hit, true);
  assert.equal(auditAttempts, 1);
  assert.equal(loggerSignals.length, 1);
  assert.equal(JSON.stringify(loggerSignals).includes("credential detail"), false);
});

test("JSON runtime enqueues a collect-linked job into the caller-owned transaction state", async () => {
  const state = {
    caches: {
      collectBox: [{ id: "collect-runtime-linked", accountId: "account-runtime" }],
    },
    collectorOzonEnrichmentJobs: [],
  };
  const runtime = createCollectorOzonEnrichmentRuntime({
    loadState: async () => state,
    saveState: async () => { throw new Error("outer transaction owns the only save"); },
    persistenceMode: () => "json",
    stateTransaction: createJsonStateTransactionBoundary({ enabled: () => true }),
    authenticate: async () => ({ collectorSessionId: "collector-runtime", accountId: "account-runtime" }),
    readJson: async () => ({}),
    sendJson() {},
    now: () => new Date(NOW),
  });

  const first = await runtime.enqueueForCollect({
    state,
    accountId: "account-runtime",
    collectItemId: "collect-runtime-linked",
    requestId: "request-runtime-linked",
    sku: "sku-runtime-linked",
    refreshBundle: {},
    now: NOW,
  });
  const replay = await runtime.enqueueForCollect({
    state,
    accountId: "account-runtime",
    collectItemId: "collect-runtime-linked",
    requestId: "request-runtime-linked",
    sku: "sku-runtime-linked",
    refreshBundle: {},
    now: NOW,
  });

  assert.equal(first.id, replay.id);
  assert.equal(state.collectorOzonEnrichmentJobs.length, 1);
  assert.equal(state.collectorOzonEnrichmentJobs[0].accountId, "account-runtime");
  assert.equal(state.collectorOzonEnrichmentJobs[0].collectItemId, "collect-runtime-linked");
});

test("JSON runtime merges a linked Seller result and audits only allowlisted evidence", async () => {
  const completedAt = new Date("2026-08-01T08:00:01.000Z");
  let persisted = {
    caches: {
      collectBox: [{
        id: "collect-runtime-merge",
        accountId: "account-runtime",
        sku: "sku-runtime-merge",
        status: "PENDING_ENRICHMENT",
        draftVersion: 3,
        listingDraft: {
          descriptionCategoryId: "",
          logistics: { weightG: 777, lengthMm: "", widthMm: "", heightMm: "" },
        },
        enrichment: { status: "PENDING_ENRICHMENT" },
      }],
    },
    collectorSessions: [{
      id: "collector-runtime",
      accountId: "account-runtime",
      expiresAt: "2026-08-02T00:00:00.000Z",
      revokedAt: null,
    }],
    collectorOzonEnrichmentJobs: [{
      id: "job-runtime-merge",
      accountId: "account-runtime",
      collectItemId: "collect-runtime-merge",
      requestId: "request-runtime-merge",
      sku: "sku-runtime-merge",
      status: "PROCESSING",
      preferredSessionId: null,
      claimedSessionId: "collector-runtime",
      claimExpiresAt: "2026-08-01T08:01:00.000Z",
      refreshBundle: {},
      attemptCount: 2,
      nextAttemptAt: "2026-08-01T08:00:00.000Z",
      lastError: null,
      captureContext: null,
      deadlineAt: "9999-12-31T23:59:59.999Z",
      result: null,
      error: null,
      createdAt: "2026-08-01T08:00:00.000Z",
      updatedAt: "2026-08-01T08:00:00.000Z",
      completedAt: null,
    }],
    auditEvents: [],
  };
  const runtime = createCollectorOzonEnrichmentRuntime({
    loadState: async () => structuredClone(persisted),
    saveState: async (state) => { persisted = structuredClone(state); },
    persistenceMode: () => "json",
    stateTransaction: createJsonStateTransactionBoundary({ enabled: () => true }),
    authenticate: async () => ({ collectorSessionId: "collector-runtime", accountId: "account-runtime" }),
    authenticateAccount: async () => ({ id: "account-runtime" }),
    readJson: async () => ({}),
    sendJson() {},
    now: () => new Date(completedAt),
  });

  await runtime.service.completeClaim({
    session: { collectorSessionId: "collector-runtime", accountId: "account-runtime" },
    jobId: "job-runtime-merge",
    variantData: {
      description_category_id: 17_000_001,
      type_id: 97_000_001,
      weight: 500,
      depth: 300,
      width: 200,
      height: 100,
      attributes: [],
    },
    captureContext: {
      sellerCompanyId: "2681910",
      revision: 4,
      observedAt: "2026-08-01T08:00:00.000Z",
    },
  });

  const item = persisted.caches.collectBox[0];
  assert.equal(item.listingDraft.logistics.weightG, 777);
  assert.equal(item.listingDraft.logistics.lengthMm, 300);
  assert.equal(item.draftVersion, 4);
  assert.deepEqual(item.enrichment, {
    status: "COMPLETE",
    missingFields: [],
    attemptCount: 2,
    nextAttemptAt: "",
    lastErrorCode: "",
    capturedAt: completedAt.toISOString(),
  });
  assert.equal(persisted.collectorOzonEnrichmentJobs[0].status, "SUCCESS");
  const audit = persisted.auditEvents.find(
    (event) => event.action === "COLLECTOR.OZON.ENRICHMENT.COMPLETE",
  );
  assert.equal(audit.metadata.sellerCompanyId, "2681910");
  assert.equal(audit.metadata.revision, 4);
  assert.equal(audit.metadata.observedAt, "2026-08-01T08:00:00.000Z");
  assert.equal(JSON.stringify(audit).includes("cookie"), false);
});

test("JSON runtime manual retry preserves identity, clears stable errors, and hides other accounts", async () => {
  const retriedAt = new Date("2026-08-01T08:10:00.000Z");
  let persisted = {
    caches: {
      collectBox: [{
        id: "collect-runtime-retry",
        accountId: "account-runtime",
        sku: "sku-runtime-retry",
        status: "NEEDS_ATTENTION",
        draftVersion: 2,
        listingDraft: { title: "keep" },
        enrichment: {
          status: "NEEDS_ATTENTION",
          missingFields: ["weightG"],
          attemptCount: 3,
          nextAttemptAt: "",
          lastErrorCode: "OZON_ENRICH_NOT_FOUND",
        },
      }],
    },
    collectorOzonEnrichmentJobs: [{
      id: "job-runtime-retry",
      accountId: "account-runtime",
      collectItemId: "collect-runtime-retry",
      requestId: "request-runtime-retry",
      sku: "sku-runtime-retry",
      status: "FAILED",
      preferredSessionId: null,
      claimedSessionId: "collector-old",
      claimExpiresAt: "2026-08-01T08:01:00.000Z",
      refreshBundle: {},
      attemptCount: 3,
      nextAttemptAt: "",
      lastError: { code: "OZON_ENRICH_NOT_FOUND", status: 404 },
      captureContext: { sellerCompanyId: "2681910", revision: 3, observedAt: "2026-08-01T08:00:00.000Z" },
      deadlineAt: "9999-12-31T23:59:59.999Z",
      result: null,
      error: { code: "OZON_ENRICH_NOT_FOUND", status: 404 },
      createdAt: "2026-08-01T08:00:00.000Z",
      updatedAt: "2026-08-01T08:00:01.000Z",
      completedAt: "2026-08-01T08:00:01.000Z",
    }],
    auditEvents: [],
  };
  const runtime = createCollectorOzonEnrichmentRuntime({
    loadState: async () => structuredClone(persisted),
    saveState: async (state) => { persisted = structuredClone(state); },
    persistenceMode: () => "json",
    stateTransaction: createJsonStateTransactionBoundary({ enabled: () => true }),
    authenticate: async () => ({ collectorSessionId: "collector-runtime", accountId: "account-runtime" }),
    authenticateAccount: async () => ({ id: "account-runtime" }),
    readJson: async () => ({}),
    sendJson() {},
    now: () => new Date(retriedAt),
  });

  const first = await runtime.service.retryCollectItem({
    accountId: "account-runtime",
    collectItemId: "collect-runtime-retry",
  });
  const second = await runtime.service.retryCollectItem({
    accountId: "account-runtime",
    collectItemId: "collect-runtime-retry",
  });

  assert.equal(second.job.id, first.job.id);
  assert.equal(second.job.requestId, first.job.requestId);
  assert.equal(second.job.sku, first.job.sku);
  assert.equal(second.job.status, "PENDING");
  assert.equal(second.job.nextAttemptAt, retriedAt.toISOString());
  assert.equal(persisted.collectorOzonEnrichmentJobs[0].lastError, null);
  assert.equal(persisted.collectorOzonEnrichmentJobs[0].error, null);
  assert.equal(
    persisted.collectorOzonEnrichmentJobs[0].captureContext.sellerCompanyId,
    "2681910",
  );
  assert.equal(persisted.caches.collectBox[0].listingDraft.title, "keep");
  assert.equal(persisted.caches.collectBox[0].enrichment.lastErrorCode, "");
  assert.equal(Object.hasOwn(second, "item"), false);
  assert.equal(Object.hasOwn(second.job, "captureContext"), false);
  await assert.rejects(runtime.service.retryCollectItem({
    accountId: "account-other",
    collectItemId: "collect-runtime-retry",
  }), (error) => error?.status === 404 && error?.code === "COLLECT_ITEM_NOT_FOUND");
});
