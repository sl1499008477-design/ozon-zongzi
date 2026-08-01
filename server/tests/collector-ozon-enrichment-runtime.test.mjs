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
    async advanceSellerContext() { throw new Error("unused"); },
    async claimNextJob() { return null; },
    async deferClaim() { throw new Error("unused"); },
    async completeJobAndCache() { throw new Error("unused"); },
    async failJobAndCache() { throw new Error("unused"); },
    async readJob() { return null; },
  };
}

const FENCED_SELLER_CONTEXT = Object.freeze({
  sellerCompanyId: "2681910",
  revision: 4,
  observedAt: "2026-08-01T08:00:00.000Z",
});

const SWITCHED_SELLER_CONTEXT = Object.freeze({
  sellerCompanyId: "7311458",
  revision: 5,
  observedAt: "2026-08-01T08:00:02.000Z",
});

function linkedSellerFenceRuntime(suffix) {
  const completedAt = new Date("2026-08-01T08:00:03.000Z");
  let persisted = {
    caches: {
      collectBox: [{
        id: `collect-runtime-fence-${suffix}`,
        accountId: "account-runtime",
        sku: `sku-runtime-fence-${suffix}`,
        status: "PENDING_ENRICHMENT",
        draftVersion: 3,
        listingDraft: {
          logistics: { weightG: 777, lengthMm: "", widthMm: "", heightMm: "" },
          categoryResolution: {
            status: "MATCHED",
            method: "MANUAL",
            target: {
              storeId: "store-runtime",
              descriptionCategoryId: 88_000_001,
              typeId: 99_000_001,
            },
          },
        },
        enrichment: { status: "PENDING_ENRICHMENT" },
      }],
    },
    collectorSessions: [{
      id: "collector-runtime",
      accountId: "account-runtime",
      expiresAt: "2026-08-02T00:00:00.000Z",
      revokedAt: null,
      sellerContext: structuredClone(FENCED_SELLER_CONTEXT),
      sellerContextUpdatedAt: FENCED_SELLER_CONTEXT.observedAt,
    }],
    collectorOzonEnrichmentJobs: [{
      id: `job-runtime-fence-${suffix}`,
      accountId: "account-runtime",
      collectItemId: `collect-runtime-fence-${suffix}`,
      requestId: `request-runtime-fence-${suffix}`,
      sku: `sku-runtime-fence-${suffix}`,
      status: "PROCESSING",
      preferredSessionId: null,
      claimedSessionId: "collector-runtime",
      claimExpiresAt: "2026-08-01T08:01:00.000Z",
      claimFence: `claim-runtime-fence-${suffix}`,
      refreshBundle: {},
      attemptCount: 2,
      nextAttemptAt: "2026-08-01T08:00:00.000Z",
      lastError: null,
      captureContext: structuredClone(FENCED_SELLER_CONTEXT),
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
  return {
    runtime,
    state: () => persisted,
    complete: () => runtime.service.completeClaim({
      session: { collectorSessionId: "collector-runtime", accountId: "account-runtime" },
      jobId: `job-runtime-fence-${suffix}`,
      claimFence: `claim-runtime-fence-${suffix}`,
      captureContext: structuredClone(FENCED_SELLER_CONTEXT),
      variantData: {
        description_category_id: 17_000_001,
        type_id: 97_000_001,
        weight: 500,
        depth: 300,
        width: 200,
        height: 100,
        attributes: [],
      },
    }),
    observeSwitch: () => runtime.service.observeSellerContext({
      session: { collectorSessionId: "collector-runtime", accountId: "account-runtime" },
      captureContext: structuredClone(SWITCHED_SELLER_CONTEXT),
    }),
  };
}

test("JSON runtime exposes Seller context observation through the serialized repository adapter", async () => {
  let persisted = {
    collectorSessions: [{
      id: "collector-runtime",
      accountId: "account-runtime",
      expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
      revokedAt: null,
    }],
  };
  const runtime = createCollectorOzonEnrichmentRuntime({
    loadState: async () => structuredClone(persisted),
    saveState: async (state) => { persisted = structuredClone(state); },
    persistenceMode: () => "json",
    stateTransaction: createJsonStateTransactionBoundary({ enabled: () => true }),
    authenticate: async () => ({
      collectorSessionId: "collector-runtime",
      accountId: "account-runtime",
    }),
    readJson: async () => ({}),
    sendJson() {},
    now: () => new Date(NOW),
  });
  const captureContext = {
    sellerCompanyId: "2681910",
    revision: 4,
    observedAt: NOW.toISOString(),
  };

  await runtime.service.observeSellerContext({
    session: { collectorSessionId: "collector-runtime", accountId: "account-runtime" },
    captureContext,
  });

  assert.deepEqual(persisted.collectorSessions[0].sellerContext, captureContext);
  assert.equal(persisted.collectorSessions[0].sellerContextUpdatedAt, NOW.toISOString());
});

test("JSON linked item commit is atomic with the Seller-context watermark ordering", async () => {
  const switchedFirst = linkedSellerFenceRuntime("switched-first");
  const itemBeforeSwitch = structuredClone(switchedFirst.state().caches.collectBox[0]);
  await switchedFirst.observeSwitch();
  await assert.rejects(
    switchedFirst.complete(),
    (error) => error?.code === "SELLER_CONTEXT_CHANGED" && error?.status === 409,
  );
  assert.deepEqual(switchedFirst.state().caches.collectBox[0], itemBeforeSwitch);
  assert.equal(switchedFirst.state().collectorOzonEnrichmentJobs[0].status, "PROCESSING");
  assert.deepEqual(switchedFirst.state().collectorOzonEnrichmentCache || [], []);

  const committedFirst = linkedSellerFenceRuntime("committed-first");
  await committedFirst.complete();
  await committedFirst.observeSwitch();
  assert.equal(committedFirst.state().caches.collectBox[0].status, "COMPLETE");
  assert.equal(committedFirst.state().caches.collectBox[0].draftVersion, 4);
  assert.equal(committedFirst.state().collectorOzonEnrichmentJobs[0].status, "SUCCESS");
  assert.equal(committedFirst.state().collectorOzonEnrichmentCache[0].status, "COMPLETE");
  assert.deepEqual(
    committedFirst.state().collectorSessions[0].sellerContext,
    SWITCHED_SELLER_CONTEXT,
  );
});

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
          descriptionCategoryId: 88_000_001,
          typeId: 99_000_001,
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
      attributes: [{ key: "8229", value: "Seller type", dictionary_value_id: 97_000_002 }],
      categories: [
        { level: 2, title: "Leaf" },
        { level: 1, title: "Root" },
      ],
    },
    captureContext: {
      sellerCompanyId: "2681910",
      revision: 4,
      observedAt: "2026-08-01T08:00:00.000Z",
    },
  });

  const item = persisted.caches.collectBox[0];
  assert.equal(item.listingDraft.descriptionCategoryId, 88_000_001);
  assert.equal(item.listingDraft.typeId, 99_000_001);
  assert.equal(item.listingDraft.logistics.weightG, 777);
  assert.equal(item.listingDraft.logistics.lengthMm, 300);
  assert.deepEqual(item.listingDraft.sourceCategory, {
    descriptionCategoryId: 17_000_001,
    typeName: "Seller type",
    typeIdCandidate: 97_000_002,
    path: ["Root", "Leaf"],
    attributes: [{ key: "8229", value: "Seller type", dictionary_value_id: 97_000_002 }],
  });
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

test("JSON success transaction rechecks the claim after loadState crosses its expiry", async () => {
  const startedAt = new Date("2026-08-01T08:00:01.000Z");
  const claimExpiresAt = new Date("2026-08-01T08:00:02.000Z");
  let clock = startedAt.getTime();
  let loadCount = 0;
  let persisted = {
    caches: {
      collectBox: [{
        id: "collect-runtime-complete-expired",
        accountId: "account-runtime",
        sku: "sku-runtime-complete-expired",
        status: "RETRYING",
        draftVersion: 3,
        listingDraft: { title: "keep", logistics: {} },
        enrichment: { status: "RETRYING", attemptCount: 2 },
      }],
    },
    collectorSessions: [{
      id: "collector-runtime",
      accountId: "account-runtime",
      expiresAt: "2026-08-02T00:00:00.000Z",
      revokedAt: null,
    }],
    collectorOzonEnrichmentJobs: [{
      id: "job-runtime-complete-expired",
      accountId: "account-runtime",
      collectItemId: "collect-runtime-complete-expired",
      requestId: "request-runtime-complete-expired",
      sku: "sku-runtime-complete-expired",
      status: "PROCESSING",
      preferredSessionId: null,
      claimedSessionId: "collector-runtime",
      claimExpiresAt: claimExpiresAt.toISOString(),
      refreshBundle: {},
      attemptCount: 2,
      nextAttemptAt: startedAt.toISOString(),
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
    loadState: async () => {
      loadCount += 1;
      if (loadCount === 3) clock = claimExpiresAt.getTime();
      return structuredClone(persisted);
    },
    saveState: async (state) => { persisted = structuredClone(state); },
    persistenceMode: () => "json",
    stateTransaction: createJsonStateTransactionBoundary({ enabled: () => true }),
    authenticate: async () => ({ collectorSessionId: "collector-runtime", accountId: "account-runtime" }),
    authenticateAccount: async () => ({ id: "account-runtime" }),
    readJson: async () => ({}),
    sendJson() {},
    now: () => new Date(clock),
  });

  await assert.rejects(runtime.service.completeClaim({
    session: { collectorSessionId: "collector-runtime", accountId: "account-runtime" },
    jobId: "job-runtime-complete-expired",
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
  }), (error) => error?.code === "OZON_ENRICHMENT_JOB_OWNERSHIP");

  assert.equal(persisted.collectorOzonEnrichmentJobs[0].status, "PROCESSING");
  assert.equal(persisted.caches.collectBox[0].status, "RETRYING");
  assert.equal(persisted.caches.collectBox[0].draftVersion, 3);
  assert.equal(persisted.collectorOzonEnrichmentCache, undefined);
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

test("JSON manual retry is a stable no-op while a PROCESSING lease is still valid", async () => {
  const retriedAt = new Date("2026-08-01T08:10:00.000Z");
  const liveClaimExpiresAt = "2026-08-01T08:11:00.000Z";
  let persisted = {
    caches: {
      collectBox: [{
        id: "collect-runtime-live-retry",
        accountId: "account-runtime",
        sku: "sku-runtime-live-retry",
        status: "RETRYING",
        draftVersion: 5,
        listingDraft: { title: "keep" },
        enrichment: { status: "RETRYING", missingFields: ["heightMm"], attemptCount: 2 },
      }],
    },
    collectorOzonEnrichmentJobs: [{
      id: "job-runtime-live-retry",
      accountId: "account-runtime",
      collectItemId: "collect-runtime-live-retry",
      requestId: "request-runtime-live-retry",
      sku: "sku-runtime-live-retry",
      status: "PROCESSING",
      preferredSessionId: null,
      claimedSessionId: "collector-live",
      claimExpiresAt: liveClaimExpiresAt,
      refreshBundle: {},
      attemptCount: 2,
      nextAttemptAt: "2026-08-01T08:09:00.000Z",
      lastError: null,
      captureContext: { sellerCompanyId: "2681910", revision: 7, observedAt: "2026-08-01T08:09:00.000Z" },
      deadlineAt: "9999-12-31T23:59:59.999Z",
      result: null,
      error: null,
      createdAt: "2026-08-01T08:00:00.000Z",
      updatedAt: "2026-08-01T08:09:00.000Z",
      completedAt: null,
    }],
    auditEvents: [],
  };
  const before = structuredClone(persisted);
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
    collectItemId: "collect-runtime-live-retry",
  });
  const second = await runtime.service.retryCollectItem({
    accountId: "account-runtime",
    collectItemId: "collect-runtime-live-retry",
  });

  assert.equal(first.job.status, "PROCESSING");
  assert.equal(second.job.status, "PROCESSING");
  assert.equal(first.job.id, second.job.id);
  assert.deepEqual(persisted.collectorOzonEnrichmentJobs, before.collectorOzonEnrichmentJobs);
  assert.deepEqual(persisted.caches.collectBox, before.caches.collectBox);
});

test("JSON manual retry cannot revive stale failed history after the item is COMPLETE", async () => {
  const retriedAt = new Date("2026-08-01T08:10:00.000Z");
  let persisted = {
    caches: {
      collectBox: [{
        id: "collect-runtime-terminal-retry",
        accountId: "account-runtime",
        sku: "sku-runtime-terminal-retry",
        status: "COMPLETE",
        draftVersion: 4,
        listingDraft: {
          sourceCategory: { descriptionCategoryId: 17_000_001 },
          logistics: { weightG: 500, lengthMm: 300, widthMm: 200, heightMm: 100 },
        },
        enrichment: { status: "COMPLETE", missingFields: [] },
      }],
    },
    collectorOzonEnrichmentJobs: [{
      id: "job-runtime-terminal-success",
      accountId: "account-runtime",
      collectItemId: "collect-runtime-terminal-retry",
      requestId: "request-runtime-terminal-success",
      sku: "sku-runtime-terminal-retry",
      status: "SUCCESS",
      attemptCount: 2,
      nextAttemptAt: "",
      result: { status: "COMPLETE", source: "COLLECTED_PUBLIC_EVIDENCE" },
      error: null,
      lastError: null,
      createdAt: "2026-08-01T08:00:00.000Z",
      updatedAt: "2026-08-01T08:05:00.000Z",
      completedAt: "2026-08-01T08:05:00.000Z",
    }, {
      id: "job-runtime-terminal-superseded",
      accountId: "account-runtime",
      collectItemId: "collect-runtime-terminal-retry",
      requestId: "request-runtime-terminal-superseded",
      sku: "sku-runtime-terminal-retry",
      status: "FAILED",
      attemptCount: 1,
      nextAttemptAt: "",
      result: null,
      error: { code: "OZON_ENRICHMENT_DUPLICATE_SUPERSEDED", status: 409 },
      lastError: { code: "OZON_ENRICHMENT_DUPLICATE_SUPERSEDED", status: 409 },
      createdAt: "2026-08-01T08:01:00.000Z",
      updatedAt: "2026-08-01T08:06:00.000Z",
      completedAt: "2026-08-01T08:06:00.000Z",
    }],
    auditEvents: [],
  };
  const beforeItems = structuredClone(persisted.caches.collectBox);
  const beforeJobs = structuredClone(persisted.collectorOzonEnrichmentJobs);
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

  const result = await runtime.service.retryCollectItem({
    accountId: "account-runtime",
    collectItemId: "collect-runtime-terminal-retry",
  });

  assert.equal(result.enrichment.status, "COMPLETE");
  assert.equal(result.job.id, "job-runtime-terminal-success");
  assert.equal(result.job.status, "SUCCESS");
  assert.deepEqual(persisted.caches.collectBox, beforeItems);
  assert.deepEqual(persisted.collectorOzonEnrichmentJobs, beforeJobs);
});

test("JSON NOT_FOUND failure and manual retry keep item attemptCount equal to the job truth", async () => {
  const failedAt = new Date("2026-08-01T09:00:00.000Z");
  let persisted = {
    caches: {
      collectBox: [{
        id: "collect-runtime-attempt",
        accountId: "account-runtime",
        sku: "sku-runtime-attempt",
        status: "RETRYING",
        draftVersion: 2,
        listingDraft: { title: "keep" },
        enrichment: { status: "RETRYING", attemptCount: 3 },
      }],
    },
    collectorSessions: [{
      id: "collector-runtime",
      accountId: "account-runtime",
      expiresAt: "2026-08-02T00:00:00.000Z",
      revokedAt: null,
    }],
    collectorOzonEnrichmentJobs: [{
      id: "job-runtime-attempt",
      accountId: "account-runtime",
      collectItemId: "collect-runtime-attempt",
      requestId: "request-runtime-attempt",
      sku: "sku-runtime-attempt",
      status: "PROCESSING",
      preferredSessionId: null,
      claimedSessionId: "collector-runtime",
      claimExpiresAt: "2026-08-01T09:01:00.000Z",
      refreshBundle: {},
      attemptCount: 3,
      nextAttemptAt: "2026-08-01T08:59:00.000Z",
      lastError: null,
      captureContext: null,
      deadlineAt: "9999-12-31T23:59:59.999Z",
      result: null,
      error: null,
      createdAt: "2026-08-01T08:00:00.000Z",
      updatedAt: "2026-08-01T08:59:00.000Z",
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
    now: () => new Date(failedAt),
  });

  await runtime.service.failClaim({
    session: { collectorSessionId: "collector-runtime", accountId: "account-runtime" },
    jobId: "job-runtime-attempt",
    code: "OZON_ENRICH_NOT_FOUND",
  });
  assert.equal(persisted.collectorOzonEnrichmentJobs[0].attemptCount, 4);
  assert.equal(persisted.caches.collectBox[0].enrichment.attemptCount, 4);

  const retried = await runtime.service.retryCollectItem({
    accountId: "account-runtime",
    collectItemId: "collect-runtime-attempt",
  });
  assert.equal(retried.job.attemptCount, 4);
  assert.equal(retried.enrichment.attemptCount, 4);
  assert.equal(persisted.collectorOzonEnrichmentJobs[0].attemptCount, 4);
  assert.equal(persisted.caches.collectBox[0].enrichment.attemptCount, 4);
});

test("JSON permanent failure rolls back job and cache when the item state cannot be saved", async () => {
  const failedAt = new Date("2026-08-01T10:00:00.000Z");
  let persisted = {
    caches: {
      collectBox: [{
        id: "collect-runtime-failure-atomic",
        accountId: "account-runtime",
        sku: "sku-runtime-failure-atomic",
        status: "RETRYING",
        draftVersion: 2,
        listingDraft: { title: "keep" },
        enrichment: { status: "RETRYING", attemptCount: 3 },
      }],
    },
    collectorSessions: [{
      id: "collector-runtime",
      accountId: "account-runtime",
      expiresAt: "2026-08-02T00:00:00.000Z",
      revokedAt: null,
    }],
    collectorOzonEnrichmentJobs: [{
      id: "job-runtime-failure-atomic",
      accountId: "account-runtime",
      collectItemId: "collect-runtime-failure-atomic",
      requestId: "request-runtime-failure-atomic",
      sku: "sku-runtime-failure-atomic",
      status: "PROCESSING",
      preferredSessionId: null,
      claimedSessionId: "collector-runtime",
      claimExpiresAt: "2026-08-01T10:01:00.000Z",
      refreshBundle: {},
      attemptCount: 3,
      nextAttemptAt: "2026-08-01T09:59:00.000Z",
      lastError: null,
      captureContext: null,
      deadlineAt: "9999-12-31T23:59:59.999Z",
      result: null,
      error: null,
      createdAt: "2026-08-01T09:00:00.000Z",
      updatedAt: "2026-08-01T09:59:00.000Z",
      completedAt: null,
    }],
    auditEvents: [],
  };
  const runtime = createCollectorOzonEnrichmentRuntime({
    loadState: async () => structuredClone(persisted),
    saveState: async (state) => {
      const jobFailed = state.collectorOzonEnrichmentJobs?.[0]?.status === "FAILED";
      const itemFailed = state.caches?.collectBox?.[0]?.status === "NEEDS_ATTENTION";
      if (jobFailed && itemFailed) {
        throw Object.assign(new Error("item persistence unavailable"), {
          code: "LOCAL_STATE_VERSION_CONFLICT",
          status: 409,
        });
      }
      persisted = structuredClone(state);
    },
    persistenceMode: () => "json",
    stateTransaction: createJsonStateTransactionBoundary({ enabled: () => true }),
    authenticate: async () => ({ collectorSessionId: "collector-runtime", accountId: "account-runtime" }),
    authenticateAccount: async () => ({ id: "account-runtime" }),
    readJson: async () => ({}),
    sendJson() {},
    now: () => new Date(failedAt),
  });

  await assert.rejects(runtime.service.failClaim({
    session: { collectorSessionId: "collector-runtime", accountId: "account-runtime" },
    jobId: "job-runtime-failure-atomic",
    code: "OZON_ENRICH_NOT_FOUND",
  }), (error) => error?.code === "OZON_ENRICH_UPSTREAM_FAILED");

  assert.equal(persisted.collectorOzonEnrichmentJobs[0].status, "PROCESSING");
  assert.equal(persisted.collectorOzonEnrichmentJobs[0].attemptCount, 3);
  assert.equal(persisted.caches.collectBox[0].status, "RETRYING");
  assert.equal(persisted.caches.collectBox[0].enrichment.attemptCount, 3);
  assert.equal(persisted.collectorOzonEnrichmentCache, undefined);
});

test("JSON permanent failure leaves the linked item unchanged when the claim expires at terminal commit", async () => {
  const failedAt = new Date("2026-08-01T10:00:00.000Z");
  let loadCount = 0;
  let persisted = {
    caches: {
      collectBox: [{
        id: "collect-runtime-failure-expired",
        accountId: "account-runtime",
        sku: "sku-runtime-failure-expired",
        status: "RETRYING",
        draftVersion: 2,
        listingDraft: { title: "keep" },
        enrichment: { status: "RETRYING", attemptCount: 3 },
      }],
    },
    collectorSessions: [{
      id: "collector-runtime",
      accountId: "account-runtime",
      expiresAt: "2026-08-02T00:00:00.000Z",
      revokedAt: null,
    }],
    collectorOzonEnrichmentJobs: [{
      id: "job-runtime-failure-expired",
      accountId: "account-runtime",
      collectItemId: "collect-runtime-failure-expired",
      requestId: "request-runtime-failure-expired",
      sku: "sku-runtime-failure-expired",
      status: "PROCESSING",
      preferredSessionId: null,
      claimedSessionId: "collector-runtime",
      claimExpiresAt: "2026-08-01T10:01:00.000Z",
      refreshBundle: {},
      attemptCount: 3,
      nextAttemptAt: "2026-08-01T09:59:00.000Z",
      lastError: null,
      captureContext: null,
      deadlineAt: "9999-12-31T23:59:59.999Z",
      result: null,
      error: null,
      createdAt: "2026-08-01T09:00:00.000Z",
      updatedAt: "2026-08-01T09:59:00.000Z",
      completedAt: null,
    }],
    auditEvents: [],
  };
  const runtime = createCollectorOzonEnrichmentRuntime({
    loadState: async () => {
      loadCount += 1;
      const state = structuredClone(persisted);
      if (loadCount === 2) {
        state.collectorOzonEnrichmentJobs[0].claimExpiresAt = failedAt.toISOString();
      }
      return state;
    },
    saveState: async (state) => { persisted = structuredClone(state); },
    persistenceMode: () => "json",
    stateTransaction: createJsonStateTransactionBoundary({ enabled: () => true }),
    authenticate: async () => ({ collectorSessionId: "collector-runtime", accountId: "account-runtime" }),
    authenticateAccount: async () => ({ id: "account-runtime" }),
    readJson: async () => ({}),
    sendJson() {},
    now: () => new Date(failedAt),
  });

  await assert.rejects(runtime.service.failClaim({
    session: { collectorSessionId: "collector-runtime", accountId: "account-runtime" },
    jobId: "job-runtime-failure-expired",
    code: "OZON_ENRICH_NOT_FOUND",
  }), (error) => error?.code === "OZON_ENRICHMENT_JOB_OWNERSHIP");

  assert.equal(persisted.collectorOzonEnrichmentJobs[0].status, "PROCESSING");
  assert.equal(persisted.collectorOzonEnrichmentJobs[0].attemptCount, 3);
  assert.equal(persisted.caches.collectBox[0].status, "RETRYING");
  assert.equal(persisted.caches.collectBox[0].enrichment.attemptCount, 3);
  assert.equal(persisted.collectorOzonEnrichmentCache, undefined);
});

test("JSON retryable defer cannot overwrite a collect item that already became COMPLETE", async () => {
  const failedAt = new Date("2026-08-01T11:00:00.000Z");
  let saveCount = 0;
  let persisted = {
    caches: {
      collectBox: [{
        id: "collect-runtime-complete-wins",
        accountId: "account-runtime",
        sku: "sku-runtime-complete-wins",
        status: "COMPLETE",
        draftVersion: 4,
        listingDraft: {
          sourceCategory: { descriptionCategoryId: 17_000_001 },
          logistics: { weightG: 500, lengthMm: 300, widthMm: 200, heightMm: 100 },
        },
        enrichment: {
          status: "COMPLETE",
          missingFields: [],
          capturedAt: "2026-08-01T10:59:59.000Z",
        },
      }],
    },
    collectorSessions: [{
      id: "collector-runtime",
      accountId: "account-runtime",
      expiresAt: "2026-08-02T00:00:00.000Z",
      revokedAt: null,
    }],
    collectorOzonEnrichmentJobs: [{
      id: "job-runtime-complete-wins",
      accountId: "account-runtime",
      collectItemId: "collect-runtime-complete-wins",
      requestId: "request-runtime-complete-wins",
      sku: "sku-runtime-complete-wins",
      status: "PROCESSING",
      preferredSessionId: null,
      claimedSessionId: "collector-runtime",
      claimExpiresAt: "2026-08-01T11:01:00.000Z",
      refreshBundle: {},
      attemptCount: 2,
      nextAttemptAt: "2026-08-01T10:59:00.000Z",
      lastError: null,
      captureContext: null,
      deadlineAt: "9999-12-31T23:59:59.999Z",
      result: null,
      error: null,
      createdAt: "2026-08-01T10:00:00.000Z",
      updatedAt: "2026-08-01T10:59:00.000Z",
      completedAt: null,
    }],
    auditEvents: [],
  };
  const runtime = createCollectorOzonEnrichmentRuntime({
    loadState: async () => structuredClone(persisted),
    saveState: async (state) => {
      saveCount += 1;
      persisted = structuredClone(state);
    },
    persistenceMode: () => "json",
    stateTransaction: createJsonStateTransactionBoundary({ enabled: () => true }),
    authenticate: async () => ({ collectorSessionId: "collector-runtime", accountId: "account-runtime" }),
    authenticateAccount: async () => ({ id: "account-runtime" }),
    readJson: async () => ({}),
    sendJson() {},
    now: () => new Date(failedAt),
  });

  const result = await runtime.service.failClaim({
    session: { collectorSessionId: "collector-runtime", accountId: "account-runtime" },
    jobId: "job-runtime-complete-wins",
    code: "OZON_ENRICH_UPSTREAM_FAILED",
  });

  assert.deepEqual(result, { id: "job-runtime-complete-wins", status: "SUCCESS" });
  assert.equal(persisted.caches.collectBox[0].status, "COMPLETE");
  assert.equal(persisted.caches.collectBox[0].enrichment.status, "COMPLETE");
  assert.equal(persisted.collectorOzonEnrichmentJobs[0].status, "SUCCESS");
  assert.deepEqual(persisted.collectorOzonEnrichmentJobs[0].result, {
    status: "COMPLETE",
    source: "COLLECTED_PUBLIC_EVIDENCE",
  });
  assert.equal(persisted.collectorOzonEnrichmentJobs[0].claimedSessionId, null);
  assert.equal(saveCount, 2, "one atomic state save plus the serialized audit save");
});
