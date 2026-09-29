import assert from "node:assert/strict";
import test from "node:test";
import { createCollectorOzonEnrichmentRuntime as createRuntime } from "../collector-ozon-enrichment-runtime.mjs";
// Runtime transaction tests isolate the external official category read boundary.
const createCollectorOzonEnrichmentRuntime = options => createRuntime({checkAdmission:async({item})=>item,...options});
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
    async hasClaimableJob() { return false; },
    async deferClaim() { throw new Error("unused"); },
    async completeJobAndCache() { throw new Error("unused"); },
    async failJobAndCache() { throw new Error("unused"); },
    async readJob() { return null; },
  };
}

test("JSON runtime starts with the availability port and keeps preflight read-only", async () => {
  const persisted = {
    collectorSessions: [{
      id: "collector-runtime",
      accountId: "account-runtime",
      expiresAt: "2026-07-31T00:01:00.000Z",
      revokedAt: null,
    }],
    collectorOzonEnrichmentJobs: [{
      id: "job-runtime-available",
      accountId: "account-runtime",
      requestId: "request-runtime-available",
      sku: "sku-runtime-available",
      status: "PENDING",
      preferredSessionId: null,
      nextAttemptAt: "2026-07-31T00:00:00.000Z",
      deadlineAt: "2026-07-31T00:01:00.000Z",
      createdAt: "2026-07-31T00:00:00.000Z",
    }],
  };
  const before = structuredClone(persisted);
  let saveCount = 0;
  const runtime = createCollectorOzonEnrichmentRuntime({
    loadState: async () => persisted,
    saveState: async () => { saveCount += 1; },
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

  assert.equal(await runtime.service.hasAvailableJob({
    session: { collectorSessionId: "collector-runtime", accountId: "account-runtime" },
  }), true);
  assert.deepEqual(persisted, before);
  assert.equal(saveCount, 0);
});

test("PostgreSQL runtime forwards the exact read-only availability contract", async () => {
  const inputs = [];
  const underlying = cacheOnlyRepository();
  underlying.hasClaimableJob = async (input) => {
    inputs.push(structuredClone(input));
    return 1;
  };
  const runtime = createCollectorOzonEnrichmentRuntime({
    loadState: async () => ({}),
    saveState: async () => { throw new Error("availability must not save JSON state"); },
    persistenceMode: () => "postgres",
    stateTransaction: createJsonStateTransactionBoundary({ enabled: () => false }),
    authenticate: async () => ({
      collectorSessionId: "collector-runtime",
      accountId: "account-runtime",
    }),
    readJson: async () => ({}),
    sendJson() {},
    initializePostgresRepository: async () => underlying,
    persistPostgresAuditEvent: async () => { throw new Error("availability must not audit"); },
    now: () => new Date(NOW),
  });

  assert.equal(await runtime.service.hasAvailableJob({
    session: { collectorSessionId: "collector-runtime", accountId: "account-runtime" },
  }), true);
  assert.deepEqual(inputs, [{
    accountId: "account-runtime",
    collectorSessionId: "collector-runtime",
    now: new Date(NOW),
  }]);
});

test("default PostgreSQL availability initializes without loading any full product state", async () => {
  const queries = [];
  const runtime = createCollectorOzonEnrichmentRuntime({
    loadState: async () => { throw new Error("full catalog must not be hydrated for queue availability"); },
    saveState: async () => { throw new Error("no JSON state writes"); },
    persistenceMode: () => "postgres",
    stateTransaction: createJsonStateTransactionBoundary({ enabled: () => false }),
    postgresPool: { async query(sql, values) { queries.push({ sql, values }); return { rows: [{ available: true }] }; } },
    authenticate: async () => ({ collectorSessionId: "collector-runtime", accountId: "account-runtime" }),
    readJson: async () => ({}), sendJson() {}, now: () => new Date(NOW),
  });
  for (let i = 0; i < 2; i++) assert.equal(await runtime.service.hasAvailableJob({
    session: { collectorSessionId: "collector-runtime", accountId: "account-runtime" },
  }), true);
  assert.equal(queries.length, 2);
  assert.ok(queries.every(({ sql, values }) => /SELECT EXISTS/.test(sql)
    && !/local_state|products|collect_raw_payloads/.test(sql)
    && values[0] === "account-runtime"));
});

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

for (const height of [100, null]) {
test(`JSON runtime atomically persists ${height === null ? 'partial' : 'complete'} Seller evidence and restores its cache`, async () => {
  const expectedStatus = height === null ? 'NEEDS_ATTENTION' : 'COMPLETE';
  const completedAt = new Date("2026-08-01T08:00:01.000Z");
  const categoryCalls = [];
  const loggerSignals = [];
  let persisted = {
    caches: {
      collectBox: [{
        id: "collect-runtime-merge",
        accountId: "account-runtime",
        sku: "sku-runtime-merge",
        status: "PENDING_ENRICHMENT",
        draftVersion: 3,
        listingDraft: {
          sku: "sku-runtime-merge",
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
  const runtimeOptions = {
    loadState: async () => structuredClone(persisted),
    saveState: async (state) => { persisted = structuredClone(state); },
    persistenceMode: () => "json",
    stateTransaction: createJsonStateTransactionBoundary({ enabled: () => true }),
    authenticate: async () => ({ collectorSessionId: "collector-runtime", accountId: "account-runtime" }),
    authenticateAccount: async () => ({ id: "account-runtime" }),
    readJson: async () => ({}),
    sendJson() {},
    now: () => new Date(completedAt),
    categoryEvidencePort: {
      async recordCollectionResult(input) {
        assert.equal(input.state.caches.collectBox[0].status, expectedStatus);
        categoryCalls.push({
          accountId: input.accountId,
          collectItemId: input.collectItemId,
          sourceVersion: input.sourceVersion,
          productDraftVersion: input.productDraftVersion,
        });
      },
    },
    logger: { error: (...values) => loggerSignals.push(values) },
  };
  const runtime = createCollectorOzonEnrichmentRuntime(runtimeOptions);

  await runtime.service.completeClaim({
    session: { collectorSessionId: "collector-runtime", accountId: "account-runtime" },
    jobId: "job-runtime-merge",
    variantData: {
      description_category_id: 17_000_001,
      type_id: 97_000_001,
      weight: 500,
      depth: 300,
      width: 200,
      height,
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
    status: expectedStatus,
    missingFields: height === null ? ["heightMm"] : [],
    ...(height === null ? {missingSkus:["sku-runtime-merge"]} : {}),
    attemptCount: 2,
    nextAttemptAt: "",
    lastErrorCode: height === null ? "ZONGZI_ENRICH_INCOMPLETE" : "",
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
  assert.deepEqual(categoryCalls, [{
    accountId: "account-runtime",
    collectItemId: "collect-runtime-merge",
    sourceVersion: "draft:4",
    productDraftVersion: 4,
  }]);
  assert.equal(loggerSignals.length, 0);
  const restarted=createCollectorOzonEnrichmentRuntime(runtimeOptions);
  const cached=await restarted.service.enrichOne({session:{collectorSessionId:'collector-runtime',accountId:'account-runtime'},requestId:'after-restart',sku:'sku-runtime-merge'});
  assert.equal(cached.status,height === null ? 'PARTIAL' : 'COMPLETE');
  assert.equal(cached.cache.hit,true);
  if(height === null) {
    assert.equal(item.listingDraft.logistics.heightMm,'');
    assert.deepEqual(cached.missingFields,['heightMm']);
  }
  assert.equal(persisted.collectorOzonEnrichmentJobs.length,1);
});
}

for (const takeover of ["none", "session", "fence"]) {
test(`JSON late success preserves atomic ownership after lease expiry: ${takeover}`, async () => {
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
      sellerContext: structuredClone(FENCED_SELLER_CONTEXT),
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
      captureContext: structuredClone(FENCED_SELLER_CONTEXT),
      claimFence: "claim-runtime-complete-expired",
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
      if (loadCount === 3) {
        clock = claimExpiresAt.getTime() + 1;
        if (takeover === "session") persisted.collectorOzonEnrichmentJobs[0].claimedSessionId = "collector-next";
        if (takeover === "fence") persisted.collectorOzonEnrichmentJobs[0].claimFence = "claim-next";
      }
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

  const completion = runtime.service.completeClaim({
    session: { collectorSessionId: "collector-runtime", accountId: "account-runtime" },
    jobId: "job-runtime-complete-expired",
    claimFence: "claim-runtime-complete-expired",
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
  if (takeover === "none") {
    const result = await completion;
    assert.equal(result.descriptionCategoryId, 17_000_001);
    assert.equal(persisted.collectorOzonEnrichmentJobs[0].status, "SUCCESS");
    assert.equal(persisted.collectorOzonEnrichmentJobs[0].attemptCount, 2);
    assert.equal(persisted.collectorOzonEnrichmentJobs[0].claimFence, "claim-runtime-complete-expired");
    assert.equal(persisted.caches.collectBox[0].status, "COMPLETE");
    assert.equal(persisted.caches.collectBox[0].draftVersion, 4);
    assert.deepEqual(persisted.caches.collectBox[0].listingDraft.logistics, { weightG: 500, lengthMm: 300, widthMm: 200, heightMm: 100 });
    assert.equal(persisted.collectorOzonEnrichmentCache[0].status, "COMPLETE");
    return;
  }
  await assert.rejects(completion, error => error.code === (takeover === "session" ? "ZONGZI_ENRICHMENT_JOB_OWNERSHIP" : "SELLER_CONTEXT_CHANGED"));

  assert.equal(persisted.collectorOzonEnrichmentJobs[0].status, "PROCESSING");
  assert.equal(persisted.caches.collectBox[0].status, "RETRYING");
  assert.equal(persisted.caches.collectBox[0].draftVersion, 3);
  assert.equal(persisted.collectorOzonEnrichmentCache, undefined);
});
}

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
          lastErrorCode: "ZONGZI_ENRICH_NOT_FOUND",
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
      lastError: { code: "ZONGZI_ENRICH_NOT_FOUND", status: 404 },
      captureContext: { sellerCompanyId: "2681910", revision: 3, observedAt: "2026-08-01T08:00:00.000Z" },
      deadlineAt: "9999-12-31T23:59:59.999Z",
      result: null,
      error: { code: "ZONGZI_ENRICH_NOT_FOUND", status: 404 },
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
      error: { code: "ZONGZI_ENRICHMENT_DUPLICATE_SUPERSEDED", status: 409 },
      lastError: { code: "ZONGZI_ENRICHMENT_DUPLICATE_SUPERSEDED", status: 409 },
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
    code: "ZONGZI_ENRICH_NOT_FOUND",
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
    code: "ZONGZI_ENRICH_NOT_FOUND",
  }), (error) => error?.code === "ZONGZI_ENRICH_UPSTREAM_FAILED");

  assert.equal(persisted.collectorOzonEnrichmentJobs[0].status, "PROCESSING");
  assert.equal(persisted.collectorOzonEnrichmentJobs[0].attemptCount, 3);
  assert.equal(persisted.caches.collectBox[0].status, "RETRYING");
  assert.equal(persisted.caches.collectBox[0].enrichment.attemptCount, 3);
  assert.equal(persisted.collectorOzonEnrichmentCache, undefined);
});

for (const takeover of ["none", "session", "fence"]) {
test(`JSON late actual failure preserves atomic ownership after lease expiry: ${takeover}`, async () => {
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
      sellerContext: structuredClone(FENCED_SELLER_CONTEXT),
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
      captureContext: structuredClone(FENCED_SELLER_CONTEXT),
      claimFence: "claim-runtime-failure-expired",
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
      if (loadCount === 2) {
        persisted.collectorOzonEnrichmentJobs[0].claimExpiresAt = new Date(failedAt.getTime() - 1).toISOString();
        if (takeover === "session") persisted.collectorOzonEnrichmentJobs[0].claimedSessionId = "collector-next";
        if (takeover === "fence") persisted.collectorOzonEnrichmentJobs[0].claimFence = "claim-next";
      }
      return structuredClone(persisted);
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

  const failure = runtime.service.failClaim({
    session: { collectorSessionId: "collector-runtime", accountId: "account-runtime" },
    jobId: "job-runtime-failure-expired",
    code: "ZONGZI_ENRICH_NOT_FOUND",
    message: "Seller /api/v1/search: product 2102713588 not found",
    claimFence: "claim-runtime-failure-expired",
    captureContext: structuredClone(FENCED_SELLER_CONTEXT),
  });
  if (takeover === "none") {
    assert.deepEqual(await failure, { id: "job-runtime-failure-expired", status: "FAILED" });
    const job = persisted.collectorOzonEnrichmentJobs[0];
    assert.equal(job.status, "FAILED");
    assert.equal(job.attemptCount, 4);
    assert.equal(job.claimFence, "claim-runtime-failure-expired");
    assert.equal(job.error.message, "Seller /api/v1/search: product 2102713588 not found");
    assert.equal(persisted.caches.collectBox[0].status, "NEEDS_ATTENTION");
    assert.equal(persisted.caches.collectBox[0].enrichment.attemptCount, 4);
    assert.deepEqual(persisted.caches.collectBox[0].listingDraft, { title: "keep" });
    assert.equal(persisted.collectorOzonEnrichmentCache[0].status, "ERROR");
    assert.deepEqual(persisted.collectorOzonEnrichmentCache[0].error, job.error);
    return;
  }
  await assert.rejects(failure, error => error.code === (takeover === "session" ? "ZONGZI_ENRICHMENT_JOB_OWNERSHIP" : "SELLER_CONTEXT_CHANGED"));

  assert.equal(persisted.collectorOzonEnrichmentJobs[0].status, "PROCESSING");
  assert.equal(persisted.collectorOzonEnrichmentJobs[0].attemptCount, 3);
  assert.equal(persisted.caches.collectBox[0].status, "RETRYING");
  assert.equal(persisted.caches.collectBox[0].enrichment.attemptCount, 3);
  assert.equal(persisted.collectorOzonEnrichmentCache, undefined);
});
}

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
    code: "ZONGZI_ENRICH_UPSTREAM_FAILED",
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

const AUDIT_DIAGNOSTIC = Object.freeze({
  stage: "seller.search", upstreamCode: "NETWORK_ERROR", upstreamStatus: 503,
  requestSent: false, extensionVersion: "1.0.6",
});

for (const attemptCount of [0, 4]) {
  test(`JSON runtime audit persists the sanitized original cause through linked retry/exhaustion: ${attemptCount}`, async () => {
    const suffix = `audit-detail-${attemptCount}`;
    const h = linkedSellerFenceRuntime(suffix);
    h.state().collectorOzonEnrichmentJobs[0].attemptCount = attemptCount;
    await h.runtime.service.failClaim({
      session: { accountId: "account-runtime", collectorSessionId: "collector-runtime" },
      jobId: `job-runtime-fence-${suffix}`, claimFence: `claim-runtime-fence-${suffix}`,
      captureContext: FENCED_SELLER_CONTEXT, code: "NETWORK_ERROR",
      message: "Seller /api/v1/search: net::ERR_CONNECTION_RESET; token=audit-private-secret",
      diagnostic: AUDIT_DIAGNOSTIC,
    });
    const state = h.state();
    const job = state.collectorOzonEnrichmentJobs[0];
    assert.equal(job.attemptCount, attemptCount + 1);
    assert.equal(job.status, attemptCount === 4 ? "FAILED" : "PENDING");
    const stored = job.error || job.lastError;
    assert.equal(stored.message, "Seller /api/v1/search: net::ERR_CONNECTION_RESET; [REDACTED]");
    const audit = state.auditEvents.find(event => event.action === "COLLECTOR.OZON.ENRICHMENT.FAIL");
    assert.equal(audit.metadata.message, stored.message);
    assert.deepEqual(audit.metadata.diagnostic, AUDIT_DIAGNOSTIC);
    assert.equal(audit.metadata.code, attemptCount === 4 ? "ZONGZI_ENRICH_RETRY_EXHAUSTED" : "ZONGZI_ENRICH_UPSTREAM_FAILED");
    assert.equal(audit.accountId, "account-runtime");
    assert.equal(audit.metadata.sku, job.sku);
    assert.equal(audit.metadata.jobId, job.id);
    assert.equal(JSON.stringify(state).includes("audit-private-secret"), false);
  });
}

test("PostgreSQL runtime audit serialization preserves the safe message and five diagnostic fields", async () => {
  const { createJsonCollectorOzonEnrichmentRepository } = await import("../collector-ozon-enrichment-repository.mjs");
  const { insertPostgresAuditEvent } = await import("../audit-event.mjs");
  const state = structuredClone(linkedSellerFenceRuntime("pg-audit-detail").state());
  state.collectorOzonEnrichmentJobs[0].collectItemId = null;
  const repository = createJsonCollectorOzonEnrichmentRepository({ state });
  const rows = [];
  const runtime = createCollectorOzonEnrichmentRuntime({
    loadState: async () => { throw new Error("PostgreSQL audit must not read legacy JSON state"); },
    saveState: async () => { throw new Error("PostgreSQL audit must not rewrite legacy JSON state"); },
    persistenceMode: () => "postgres",
    stateTransaction: createJsonStateTransactionBoundary({ enabled: () => false }),
    authenticate: async () => ({ accountId: "account-runtime", collectorSessionId: "collector-runtime" }),
    readJson: async () => ({}), sendJson() {},
    initializePostgresRepository: async () => repository,
    persistPostgresAuditEvent: event => insertPostgresAuditEvent({
      async query(sql, params) {
        assert.match(sql, /INSERT INTO audit_events/);
        rows.push({ accountId: params[1], metadata: JSON.parse(params[12]) });
        return { rows: [], rowCount: 1 };
      },
    }, event),
    now: () => new Date("2026-08-01T08:00:03.000Z"),
  });
  await runtime.service.failClaim({
    session: { accountId: "account-runtime", collectorSessionId: "collector-runtime" },
    jobId: "job-runtime-fence-pg-audit-detail", claimFence: "claim-runtime-fence-pg-audit-detail",
    captureContext: FENCED_SELLER_CONTEXT, code: "NETWORK_ERROR",
    message: "Seller /api/v1/search: net::ERR_CONNECTION_RESET; password=pg-audit-private",
    diagnostic: AUDIT_DIAGNOSTIC,
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].accountId, "account-runtime");
  assert.equal(rows[0].metadata.message, "Seller /api/v1/search: net::ERR_CONNECTION_RESET; [REDACTED]");
  assert.deepEqual(rows[0].metadata.diagnostic, AUDIT_DIAGNOSTIC);
  assert.equal(JSON.stringify(rows).includes("pg-audit-private"), false);
});
