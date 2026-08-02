import assert from "node:assert/strict";
import test from "node:test";
import { appendAuditEvent } from "../audit-event.mjs";
import { createCollectCategoryResolutionRuntime } from "../collect-category-resolution-runtime.mjs";
import { createJsonStateTransactionBoundary } from "../json-state-transaction.mjs";

const ACCOUNT_ID = "account-runtime";
const COLLECT_ITEM_ID = "collect-runtime";
const STORE_ID = "store-runtime";
const NOW = new Date("2026-08-03T12:00:00.000Z");

function categoryService() {
  return {
    async getCategorySnapshot() {
      return {
        items: [{
          description_category_id: 17_028_702,
          category_name: "家居",
          children: [{ type_id: 94_405, type_name: "杯子", children: [] }],
        }],
        taxonomyScope: "OZON:DEFAULT",
        taxonomyFingerprint: "taxonomy-runtime-v1",
        fetchedAt: NOW.toISOString(),
        stale: false,
      };
    },
    async validateTarget() {
      return {
        valid: true,
        reasonCode: "VALID",
        taxonomyFingerprint: "taxonomy-runtime-v1",
        validatedAt: NOW.toISOString(),
      };
    },
  };
}

function completeItem(overrides = {}) {
  return {
    id: COLLECT_ITEM_ID,
    accountId: ACCOUNT_ID,
    status: "COMPLETE",
    enrichment: { status: "COMPLETE" },
    listingDraft: {
      sourceCategory: { descriptionCategoryId: 17_033_604, typeIdCandidate: 94_405 },
    },
    ...structuredClone(overrides),
  };
}

test("JSON runtime ignores caller store scope and atomically queues with the backend current store", async () => {
  const item = completeItem();
  const state = {
    caches: { collectBox: [item] },
    stores: [{
      id: STORE_ID,
      ownerAccountId: ACCOUNT_ID,
      clientId: "client-runtime",
      apiKey: "secret-runtime",
    }],
    collectCategoryResolutions: [],
    auditEvents: [],
  };
  let saves = 0;
  const runtime = createCollectCategoryResolutionRuntime({
    loadState: async () => state,
    saveState: async () => { saves += 1; },
    stateTransaction: createJsonStateTransactionBoundary({ enabled: () => true }),
    persistenceMode: () => "json",
    categoryService: categoryService(),
    currentCredentialStoreForAccount: async (accountId) => {
      assert.equal(accountId, ACCOUNT_ID);
      return STORE_ID;
    },
    appendAudit: appendAuditEvent,
    now: () => new Date(NOW),
    randomUUID: () => "runtime-lease",
  });

  const queued = await runtime.scheduleForCollect({
    accountId: ACCOUNT_ID,
    collectItemId: COLLECT_ITEM_ID,
    credentialStoreId: "attacker-store",
  });

  assert.equal(queued.status, "QUEUED");
  assert.equal(queued.credentialStoreId, STORE_ID);
  assert.equal(state.collectCategoryResolutions.length, 1);
  assert.equal(state.auditEvents.length, 1);
  assert.equal(state.auditEvents[0].action, "COLLECT_CATEGORY_RESOLUTION_QUEUED");
  assert.equal(saves, 1);
  assert.equal("credentialStoreId" in item, false);
  assert.equal(JSON.stringify(item).includes(STORE_ID), false);
});

test("enrichment completion promotes one waiting record and repeated notifications stay idempotent", async () => {
  const item = completeItem({
    status: "PENDING_ENRICHMENT",
    enrichment: { status: "PENDING_ENRICHMENT" },
  });
  const state = {
    caches: { collectBox: [item] },
    stores: [{
      id: STORE_ID,
      ownerAccountId: ACCOUNT_ID,
      clientId: "client-runtime",
      apiKey: "secret-runtime",
    }],
    collectCategoryResolutions: [],
    auditEvents: [],
  };
  const runtime = createCollectCategoryResolutionRuntime({
    loadState: async () => state,
    saveState: async () => {},
    stateTransaction: createJsonStateTransactionBoundary({ enabled: () => true }),
    persistenceMode: () => "json",
    categoryService: categoryService(),
    currentCredentialStoreForAccount: async () => STORE_ID,
    appendAudit: appendAuditEvent,
    now: () => new Date(NOW),
    randomUUID: () => "runtime-lease",
  });

  assert.equal((await runtime.scheduleForCollect({
    accountId: ACCOUNT_ID,
    collectItemId: COLLECT_ITEM_ID,
  })).status, "WAITING_ENRICHMENT");
  item.status = "COMPLETE";
  item.enrichment = { status: "COMPLETE" };

  const first = await runtime.onEnrichmentComplete({
    accountId: ACCOUNT_ID,
    collectItemId: COLLECT_ITEM_ID,
    completedAt: NOW,
  });
  const replay = await runtime.onEnrichmentComplete({
    accountId: ACCOUNT_ID,
    collectItemId: COLLECT_ITEM_ID,
    completedAt: NOW,
  });

  assert.equal(first.status, "QUEUED");
  assert.equal(replay.id, first.id);
  assert.equal(state.collectCategoryResolutions.length, 1);
});

function postgresRepositoryDouble() {
  const records = new Map();
  const key = ({ accountId, collectItemId, taxonomyScope = "OZON:DEFAULT" }) => (
    `${accountId}:${collectItemId}:${taxonomyScope}`
  );
  return {
    records,
    async enqueue(input) {
      const recordKey = key(input);
      const existing = records.get(recordKey);
      const record = {
        id: existing?.id || "resolution-postgres",
        ...structuredClone(input),
        nextAttemptAt: input.nextAttemptAt.toISOString(),
        createdAt: existing?.createdAt || input.now.toISOString(),
        updatedAt: input.now.toISOString(),
      };
      records.set(recordKey, record);
      return structuredClone(record);
    },
    async readForItem(input) { return structuredClone(records.get(key(input)) || null); },
    async claimNext() { return null; },
    async completeMatched() { throw new Error("unused"); },
    async completeNeedsReview() { throw new Error("unused"); },
    async deferRetry() { throw new Error("unused"); },
    async invalidate() { throw new Error("unused"); },
    async saveManual() { throw new Error("unused"); },
    async requeueClaim() { throw new Error("unused"); },
    async validateMatched() { throw new Error("unused"); },
    async deferValidation() { throw new Error("unused"); },
  };
}

test("PostgreSQL runtime uses the same server-derived schedule contract without JSON persistence", async () => {
  const repository = postgresRepositoryDouble();
  const storeReads = [];
  const runtime = createCollectCategoryResolutionRuntime({
    loadState: async () => { throw new Error("PostgreSQL scheduling must not load JSON items"); },
    saveState: async () => { throw new Error("PostgreSQL scheduling must not save JSON state"); },
    stateTransaction: createJsonStateTransactionBoundary({ enabled: () => false }),
    persistenceMode: () => "postgres",
    categoryService: categoryService(),
    currentCredentialStoreForAccount: async () => STORE_ID,
    initializePostgresRepository: async () => repository,
    readCollectItem: async ({ accountId, collectItemId }) => completeItem({
      accountId,
      id: collectItemId,
    }),
    readCredentialStore: async ({ accountId, storeId }) => {
      storeReads.push({ accountId, storeId });
      return {
        id: storeId,
        ownerAccountId: accountId,
        clientId: "client-postgres",
        apiKey: "secret-postgres",
      };
    },
    now: () => new Date(NOW),
    randomUUID: () => "runtime-lease",
  });

  const queued = await runtime.scheduleForCollect({
    accountId: ACCOUNT_ID,
    collectItemId: COLLECT_ITEM_ID,
    credentialStoreId: "attacker-store",
  });

  assert.equal(queued.status, "QUEUED");
  assert.equal(queued.credentialStoreId, STORE_ID);
  assert.deepEqual(storeReads, [{ accountId: ACCOUNT_ID, storeId: STORE_ID }]);
  assert.equal(repository.records.size, 1);
  assert.equal((await runtime.readForItem({
    accountId: ACCOUNT_ID,
    collectItemId: COLLECT_ITEM_ID,
  })).id, "resolution-postgres");
});

test("PostgreSQL store adapter combines credential proof with current owned status and rejects inactive stores", async () => {
  const repository = postgresRepositoryDouble();
  let credentialReads = 0;
  const runtime = createCollectCategoryResolutionRuntime({
    loadState: async () => ({
      stores: [{
        id: STORE_ID,
        ownerAccountId: ACCOUNT_ID,
        status: "INACTIVE",
        clientId: "client-postgres",
      }],
    }),
    saveState: async () => { throw new Error("PostgreSQL scheduling must not save JSON state"); },
    stateTransaction: createJsonStateTransactionBoundary({ enabled: () => false }),
    persistenceMode: () => "postgres",
    categoryService: categoryService(),
    currentCredentialStoreForAccount: async () => STORE_ID,
    initializePostgresRepository: async () => repository,
    readCollectItem: async () => completeItem(),
    readPostgresStoreCredential: async (storeId, accountId) => {
      credentialReads += 1;
      return {
        id: storeId,
        ownerAccountId: accountId,
        clientId: "client-postgres",
        apiKey: "secret-postgres",
      };
    },
    now: () => new Date(NOW),
    randomUUID: () => "runtime-lease",
  });

  const waiting = await runtime.scheduleForCollect({
    accountId: ACCOUNT_ID,
    collectItemId: COLLECT_ITEM_ID,
  });

  assert.equal(waiting.status, "WAITING_STORE");
  assert.equal(waiting.credentialStoreId, null);
  assert.equal(credentialReads, 1);
});

test("PostgreSQL runtime binds the prepared audit to the repository transaction executor", async () => {
  const executor = { query: async () => ({ rows: [] }) };
  const pool = { marker: "pool" };
  const repository = postgresRepositoryDouble();
  const auditWrites = [];
  const originalEnqueue = repository.enqueue.bind(repository);
  let transactionAuditWriter;
  repository.enqueue = async (input) => {
    const saved = await originalEnqueue(input);
    await transactionAuditWriter({ executor, event: input.auditEvent });
    return saved;
  };
  const runtime = createCollectCategoryResolutionRuntime({
    loadState: async () => ({ stores: [] }),
    saveState: async () => {},
    stateTransaction: createJsonStateTransactionBoundary({ enabled: () => false }),
    persistenceMode: () => "postgres",
    categoryService: categoryService(),
    currentCredentialStoreForAccount: async () => STORE_ID,
    postgresPool: async () => pool,
    createPostgresRepository(options) {
      assert.equal(options.pool, pool);
      transactionAuditWriter = options.auditWriter;
      return repository;
    },
    persistPostgresAuditEvent: async (receivedExecutor, event) => {
      auditWrites.push({ receivedExecutor, event: structuredClone(event) });
    },
    readCollectItem: async () => completeItem(),
    readCredentialStore: async () => ({
      id: STORE_ID,
      ownerAccountId: ACCOUNT_ID,
      clientId: "client-postgres",
      apiKey: "secret-postgres",
    }),
    now: () => new Date(NOW),
    randomUUID: () => "runtime-lease",
  });

  await runtime.scheduleForCollect({
    accountId: ACCOUNT_ID,
    collectItemId: COLLECT_ITEM_ID,
  });

  assert.equal(auditWrites.length, 1);
  assert.equal(auditWrites[0].receivedExecutor, executor);
  assert.equal(auditWrites[0].event.action, "COLLECT_CATEGORY_RESOLUTION_QUEUED");
  assert.equal(auditWrites[0].event.accountId, ACCOUNT_ID);
  assert.equal(auditWrites[0].event.storeId, STORE_ID);
});

test("PostgreSQL restart query filters actionable states before applying its batch limit", async () => {
  const taxonomyScope = "OZON:RU";
  const repository = postgresRepositoryDouble();
  await repository.enqueue({
    accountId: ACCOUNT_ID,
    collectItemId: COLLECT_ITEM_ID,
    taxonomyScope,
    sourceTypeId: 94_405,
    status: "WAITING_ENRICHMENT",
    credentialStoreId: null,
    taxonomyFingerprint: null,
    nextAttemptAt: new Date(NOW),
    now: new Date(NOW),
  });
  const queries = [];
  const pool = {
    async query(sql, params) {
      queries.push({ sql, params: structuredClone(params) });
      return { rows: [{
        id: COLLECT_ITEM_ID,
        account_id: ACCOUNT_ID,
        taxonomy_scope: taxonomyScope,
      }] };
    },
  };
  const runtime = createCollectCategoryResolutionRuntime({
    loadState: async () => { throw new Error("explicit account reconciliation must not scan JSON accounts"); },
    saveState: async () => { throw new Error("PostgreSQL reconciliation must not save JSON state"); },
    stateTransaction: createJsonStateTransactionBoundary({ enabled: () => false }),
    persistenceMode: () => "postgres",
    categoryService: categoryService(),
    currentCredentialStoreForAccount: async () => STORE_ID,
    initializePostgresRepository: async () => repository,
    postgresPool: async () => pool,
    readCollectItem: async () => completeItem(),
    readCredentialStore: async () => ({
      id: STORE_ID,
      ownerAccountId: ACCOUNT_ID,
      clientId: "client-postgres",
      apiKey: "secret-postgres",
      updatedAt: NOW.toISOString(),
    }),
    now: () => new Date(NOW),
    randomUUID: () => "runtime-lease",
  });

  const result = await runtime.resolveDue({ accountId: ACCOUNT_ID, limit: 1 });

  assert.equal(result.scheduled, 1);
  assert.equal(queries.length, 1);
  assert.match(queries[0].sql, /summary->'enrichment'->>'status'/);
  assert.match(queries[0].sql, /resolution\.status='WAITING_STORE'/);
  assert.match(queries[0].sql, /resolution\.status='MATCHED'/);
  assert.match(queries[0].sql, /LIMIT \$2/);
  assert.doesNotMatch(queries[0].sql, /resolution\.taxonomy_scope=\$3/);
  assert.deepEqual(queries[0].params.slice(0, 3), [ACCOUNT_ID, 1, "OZON:DEFAULT"]);
  const resolution = await runtime.readForItem({
    accountId: ACCOUNT_ID,
    collectItemId: COLLECT_ITEM_ID,
    taxonomyScope,
  });
  assert.equal(resolution.status, "QUEUED");
  assert.equal(repository.records.size, 1);
});

test("restart reconciliation is bounded and a concurrent drain cannot overlap", async () => {
  const state = {
    caches: {
      collectBox: ["one", "two", "three"].map((suffix) => completeItem({
        id: `${COLLECT_ITEM_ID}-${suffix}`,
      })),
    },
    stores: [{
      id: STORE_ID,
      ownerAccountId: ACCOUNT_ID,
      clientId: "client-runtime",
      apiKey: "secret-runtime",
    }],
    collectCategoryResolutions: [],
    auditEvents: [],
  };
  let releaseStoreLookup;
  let storeLookupEntered;
  const entered = new Promise((resolve) => { storeLookupEntered = resolve; });
  const gate = new Promise((resolve) => { releaseStoreLookup = resolve; });
  let gated = true;
  const listRequests = [];
  const runtime = createCollectCategoryResolutionRuntime({
    loadState: async () => state,
    saveState: async () => {},
    stateTransaction: createJsonStateTransactionBoundary({ enabled: () => true }),
    persistenceMode: () => "json",
    categoryService: categoryService(),
    currentCredentialStoreForAccount: async () => {
      if (gated) {
        storeLookupEntered();
        await gate;
        gated = false;
      }
      return STORE_ID;
    },
    listCollectItems: async (input) => {
      listRequests.push(structuredClone(input));
      const candidates = state.caches.collectBox.filter((item) => {
        const resolution = state.collectCategoryResolutions.find((record) => (
          record.accountId === item.accountId && record.collectItemId === item.id
        ));
        return !resolution || ["WAITING_ENRICHMENT", "WAITING_STORE"].includes(resolution.status);
      });
      return candidates.slice(0, input.limit ?? candidates.length);
    },
    appendAudit: appendAuditEvent,
    now: () => new Date(NOW),
    randomUUID: () => "runtime-lease",
  });

  const firstDrain = runtime.resolveDue({ limit: 2 });
  await storeLookupEntered;
  const overlapping = await runtime.resolveDue({ limit: 2 });
  assert.equal(overlapping.skipped, true);
  releaseStoreLookup();
  const first = await firstDrain;

  assert.equal(first.scheduled, 2);
  assert.equal(first.processed, 0);
  assert.equal(state.collectCategoryResolutions.length, 2);
  assert.deepEqual(listRequests[0], { accountId: ACCOUNT_ID, limit: 2 });

  const second = await runtime.resolveDue({ limit: 2 });
  assert.ok(second.scheduled + second.processed <= 2);
  assert.equal(state.collectCategoryResolutions.length, 3);
});

test("JSON reconciliation does not let earlier queued items starve a later missing record", async () => {
  const items = ["one", "two", "three"].map((suffix) => completeItem({
    id: `${COLLECT_ITEM_ID}-starvation-${suffix}`,
  }));
  const state = {
    caches: { collectBox: items },
    stores: [{
      id: STORE_ID,
      ownerAccountId: ACCOUNT_ID,
      clientId: "client-runtime",
      apiKey: "secret-runtime",
    }],
    collectCategoryResolutions: items.slice(0, 2).map((item, index) => ({
      id: `existing-${index}`,
      accountId: ACCOUNT_ID,
      collectItemId: item.id,
      taxonomyScope: "OZON:DEFAULT",
      sourceTypeId: 94_405,
      status: "QUEUED",
      nextAttemptAt: NOW.toISOString(),
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    })),
    auditEvents: [],
  };
  const runtime = createCollectCategoryResolutionRuntime({
    loadState: async () => state,
    saveState: async () => {},
    stateTransaction: createJsonStateTransactionBoundary({ enabled: () => true }),
    persistenceMode: () => "json",
    categoryService: categoryService(),
    currentCredentialStoreForAccount: async () => STORE_ID,
    appendAudit: appendAuditEvent,
    now: () => new Date(NOW),
    randomUUID: () => "runtime-lease",
  });

  const result = await runtime.resolveDue({ accountId: ACCOUNT_ID, limit: 1 });

  assert.equal(result.scheduled, 1);
  assert.equal(result.processed, 0);
  assert.equal(state.collectCategoryResolutions.length, 3);
  assert.equal(state.collectCategoryResolutions.some((record) => (
    record.collectItemId === items[2].id
  )), true);
});

test("incomplete waiting rows do not consume the bounded reconciliation batch", async () => {
  const blockers = Array.from({ length: 17 }, (_, index) => completeItem({
    id: `${COLLECT_ITEM_ID}-incomplete-${String(index).padStart(2, "0")}`,
    status: "PENDING_ENRICHMENT",
    enrichment: { status: "PENDING_ENRICHMENT" },
  }));
  const recoverable = completeItem({ id: `${COLLECT_ITEM_ID}-recoverable` });
  const state = {
    caches: { collectBox: [...blockers, recoverable] },
    stores: [{
      id: STORE_ID,
      ownerAccountId: ACCOUNT_ID,
      clientId: "client-runtime",
      apiKey: "secret-runtime",
    }],
    collectCategoryResolutions: blockers.map((item, index) => ({
      id: `waiting-${index}`,
      accountId: ACCOUNT_ID,
      collectItemId: item.id,
      taxonomyScope: "OZON:DEFAULT",
      sourceTypeId: 94_405,
      status: "WAITING_ENRICHMENT",
      nextAttemptAt: NOW.toISOString(),
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    })),
    auditEvents: [],
  };
  const runtime = createCollectCategoryResolutionRuntime({
    loadState: async () => state,
    saveState: async () => {},
    stateTransaction: createJsonStateTransactionBoundary({ enabled: () => true }),
    persistenceMode: () => "json",
    categoryService: categoryService(),
    currentCredentialStoreForAccount: async () => STORE_ID,
    appendAudit: appendAuditEvent,
    now: () => new Date(NOW),
    randomUUID: () => "runtime-lease",
  });

  const result = await runtime.resolveDue({ accountId: ACCOUNT_ID, limit: 1 });

  assert.equal(result.scheduled, 1);
  assert.equal(result.processed, 0);
  assert.equal(state.collectCategoryResolutions.length, blockers.length + 1);
  assert.equal(state.collectCategoryResolutions.at(-1).collectItemId, recoverable.id);
  assert.equal(state.collectCategoryResolutions.at(-1).status, "QUEUED");
});

test("JSON restart reconciliation carries a non-default waiting scope through scheduling", async () => {
  const taxonomyScope = "OZON:RU";
  const item = completeItem({ id: `${COLLECT_ITEM_ID}-ru-restart` });
  const state = {
    caches: { collectBox: [item] },
    stores: [{
      id: STORE_ID,
      ownerAccountId: ACCOUNT_ID,
      clientId: "client-runtime",
      apiKey: "secret-runtime",
    }],
    collectCategoryResolutions: [{
      id: "ru-restart-resolution",
      accountId: ACCOUNT_ID,
      collectItemId: item.id,
      taxonomyScope,
      sourceTypeId: 94_405,
      status: "WAITING_ENRICHMENT",
      nextAttemptAt: NOW.toISOString(),
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    }],
    auditEvents: [],
  };
  const runtime = createCollectCategoryResolutionRuntime({
    loadState: async () => state,
    saveState: async () => {},
    stateTransaction: createJsonStateTransactionBoundary({ enabled: () => true }),
    persistenceMode: () => "json",
    categoryService: categoryService(),
    currentCredentialStoreForAccount: async () => STORE_ID,
    appendAudit: appendAuditEvent,
    now: () => new Date(NOW),
    randomUUID: () => "runtime-lease",
  });

  const result = await runtime.resolveDue({ accountId: ACCOUNT_ID, limit: 2 });

  const nonDefault = await runtime.readForItem({
    accountId: ACCOUNT_ID,
    collectItemId: item.id,
    taxonomyScope,
  });
  assert.equal(result.scheduled, 2);
  assert.equal(nonDefault.status, "QUEUED");
  assert.equal(nonDefault.taxonomyScope, taxonomyScope);
  assert.equal(state.collectCategoryResolutions.length, 2);
});

test("store wake pages every waiting row and validates a later matched row", async () => {
  const waitingItems = Array.from({ length: 17 }, (_, index) => completeItem({
    id: `${COLLECT_ITEM_ID}-store-wait-${String(index).padStart(2, "0")}`,
  }));
  const matchedItem = completeItem({ id: `${COLLECT_ITEM_ID}-store-wait-99-matched` });
  const unrelatedItems = Array.from({ length: 20 }, (_, index) => completeItem({
    id: `${COLLECT_ITEM_ID}-unrelated-${String(index).padStart(2, "0")}`,
  }));
  const state = {
    caches: { collectBox: [...unrelatedItems, ...waitingItems, matchedItem] },
    stores: [{
      id: STORE_ID,
      ownerAccountId: ACCOUNT_ID,
      clientId: "client-runtime",
      apiKey: "secret-runtime",
    }],
    collectCategoryResolutions: [
      ...unrelatedItems.map((item, index) => ({
        id: `unrelated-resolution-${index}`,
        accountId: ACCOUNT_ID,
        collectItemId: item.id,
        taxonomyScope: "OZON:DEFAULT",
        sourceTypeId: 94_405,
        status: "QUEUED",
        nextAttemptAt: NOW.toISOString(),
        createdAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
      })),
      ...waitingItems.map((item, index) => ({
        id: `store-waiting-${index}`,
        accountId: ACCOUNT_ID,
        collectItemId: item.id,
        taxonomyScope: "OZON:DEFAULT",
        sourceTypeId: 94_405,
        status: "WAITING_STORE",
        nextAttemptAt: NOW.toISOString(),
        createdAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
      })),
      {
        id: "matched-resolution",
        accountId: ACCOUNT_ID,
        collectItemId: matchedItem.id,
        taxonomyScope: "OZON:DEFAULT",
        sourceTypeId: 94_405,
        targetDescriptionCategoryId: 17_028_702,
        targetTypeId: 94_405,
        method: "EXACT_TYPE_ID",
        status: "MATCHED",
        taxonomyFingerprint: "taxonomy-runtime-v1",
        credentialStoreId: "old-store",
        displayPath: {},
        attemptCount: 0,
        nextAttemptAt: NOW.toISOString(),
        matchedAt: NOW.toISOString(),
        validatedAt: NOW.toISOString(),
        createdAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
      },
    ],
    auditEvents: [],
  };
  const continuations = [];
  const timers = {
    setTimeout(callback) {
      continuations.push(callback);
      return { unref() {} };
    },
    clearTimeout() {},
    setInterval() { return { unref() {} }; },
    clearInterval() {},
  };
  const runtime = createCollectCategoryResolutionRuntime({
    loadState: async () => state,
    saveState: async () => {},
    stateTransaction: createJsonStateTransactionBoundary({ enabled: () => true }),
    persistenceMode: () => "json",
    categoryService: categoryService(),
    currentCredentialStoreForAccount: async () => STORE_ID,
    appendAudit: appendAuditEvent,
    timers,
    now: () => new Date(NOW),
    randomUUID: () => "runtime-lease",
  });

  await runtime.onOperatingStoreAvailable({ accountId: ACCOUNT_ID, storeId: STORE_ID });
  assert.equal(state.collectCategoryResolutions.find((record) => (
    record.id === "store-waiting-0"
  )).status, "WAITING_STORE");
  while (continuations.length) await continuations.shift()();

  const waitingRecords = state.collectCategoryResolutions.filter((record) => (
    record.id.startsWith("store-waiting-")
  ));
  const matched = state.collectCategoryResolutions.find((record) => record.id === "matched-resolution");
  assert.equal(waitingRecords.length, 17);
  assert.equal(waitingRecords.every((record) => record.status === "QUEUED"), true);
  assert.equal(matched.status, "MATCHED");
  assert.equal(matched.credentialStoreId, STORE_ID);
  assert.equal(continuations.length, 0);
});

test("JSON store wake preserves and processes a non-default taxonomy scope", async () => {
  const taxonomyScope = "OZON:RU";
  const item = completeItem({ id: `${COLLECT_ITEM_ID}-ru-waiting` });
  const state = {
    caches: { collectBox: [item] },
    stores: [{
      id: STORE_ID,
      ownerAccountId: ACCOUNT_ID,
      clientId: "client-runtime",
      apiKey: "secret-runtime",
    }],
    collectCategoryResolutions: [{
      id: "ru-waiting-resolution",
      accountId: ACCOUNT_ID,
      collectItemId: item.id,
      taxonomyScope,
      sourceTypeId: 94_405,
      status: "WAITING_STORE",
      nextAttemptAt: NOW.toISOString(),
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    }],
    auditEvents: [],
  };
  const continuations = [];
  const runtime = createCollectCategoryResolutionRuntime({
    loadState: async () => state,
    saveState: async () => {},
    stateTransaction: createJsonStateTransactionBoundary({ enabled: () => true }),
    persistenceMode: () => "json",
    categoryService: categoryService(),
    currentCredentialStoreForAccount: async () => STORE_ID,
    appendAudit: appendAuditEvent,
    timers: {
      setTimeout(callback) { continuations.push(callback); return { unref() {} }; },
      clearTimeout() {},
      setInterval() { return { unref() {} }; },
      clearInterval() {},
    },
    now: () => new Date(NOW),
    randomUUID: () => "runtime-lease",
  });

  await runtime.onOperatingStoreAvailable({ accountId: ACCOUNT_ID, storeId: STORE_ID });
  while (continuations.length) await continuations.shift()();

  const resolution = await runtime.readForItem({
    accountId: ACCOUNT_ID,
    collectItemId: item.id,
    taxonomyScope,
  });
  assert.equal(resolution.status, "QUEUED");
  assert.equal(resolution.taxonomyScope, taxonomyScope);
  assert.equal(state.collectCategoryResolutions.length, 1);
});

test("PostgreSQL store wake selects and preserves a non-default taxonomy scope", async () => {
  const taxonomyScope = "OZON:RU";
  const item = completeItem({ id: `${COLLECT_ITEM_ID}-pg-ru-waiting` });
  const repository = postgresRepositoryDouble();
  await repository.enqueue({
    accountId: ACCOUNT_ID,
    collectItemId: item.id,
    taxonomyScope,
    sourceTypeId: 94_405,
    status: "WAITING_STORE",
    credentialStoreId: null,
    taxonomyFingerprint: null,
    nextAttemptAt: new Date(NOW),
    now: new Date(NOW),
  });
  const queries = [];
  const continuations = [];
  const runtime = createCollectCategoryResolutionRuntime({
    loadState: async () => { throw new Error("PostgreSQL store wake must not read JSON items"); },
    saveState: async () => { throw new Error("PostgreSQL store wake must not save JSON state"); },
    stateTransaction: createJsonStateTransactionBoundary({ enabled: () => false }),
    persistenceMode: () => "postgres",
    categoryService: categoryService(),
    currentCredentialStoreForAccount: async () => STORE_ID,
    initializePostgresRepository: async () => repository,
    postgresPool: async () => ({
      async query(sql, params) {
        queries.push({ sql, params: structuredClone(params) });
        return { rows: [{
          id: item.id,
          account_id: ACCOUNT_ID,
          taxonomy_scope: taxonomyScope,
        }] };
      },
    }),
    readCollectItem: async () => item,
    readCredentialStore: async () => ({
      id: STORE_ID,
      ownerAccountId: ACCOUNT_ID,
      clientId: "client-postgres",
      apiKey: "secret-postgres",
    }),
    timers: {
      setTimeout(callback) { continuations.push(callback); return { unref() {} }; },
      clearTimeout() {},
      setInterval() { return { unref() {} }; },
      clearInterval() {},
    },
    now: () => new Date(NOW),
    randomUUID: () => "runtime-lease",
  });

  await runtime.onOperatingStoreAvailable({ accountId: ACCOUNT_ID, storeId: STORE_ID });
  while (continuations.length) await continuations.shift()();

  const resolution = await runtime.readForItem({
    accountId: ACCOUNT_ID,
    collectItemId: item.id,
    taxonomyScope,
  });
  assert.equal(resolution.status, "QUEUED");
  assert.equal(resolution.taxonomyScope, taxonomyScope);
  assert.equal(queries.length, 1);
  assert.doesNotMatch(queries[0].sql, /resolution\.taxonomy_scope=\$2/);
});

test("restart reconciliation revalidates a matched record after the operating store changes", async () => {
  const item = completeItem({ id: `${COLLECT_ITEM_ID}-matched-restart` });
  const state = {
    caches: { collectBox: [item] },
    stores: [{
      id: STORE_ID,
      ownerAccountId: ACCOUNT_ID,
      clientId: "client-runtime",
      apiKey: "secret-runtime",
      updatedAt: "2026-08-03T11:59:00.000Z",
    }],
    collectCategoryResolutions: [{
      id: "matched-restart-resolution",
      accountId: ACCOUNT_ID,
      collectItemId: item.id,
      taxonomyScope: "OZON:DEFAULT",
      sourceTypeId: 94_405,
      targetDescriptionCategoryId: 17_028_702,
      targetTypeId: 94_405,
      method: "EXACT_TYPE_ID",
      status: "MATCHED",
      taxonomyFingerprint: "taxonomy-runtime-v1",
      credentialStoreId: "previous-store",
      displayPath: {},
      attemptCount: 0,
      nextAttemptAt: NOW.toISOString(),
      matchedAt: NOW.toISOString(),
      validatedAt: "2026-08-03T11:58:00.000Z",
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    }],
    auditEvents: [],
  };
  const runtime = createCollectCategoryResolutionRuntime({
    loadState: async () => state,
    saveState: async () => {},
    stateTransaction: createJsonStateTransactionBoundary({ enabled: () => true }),
    persistenceMode: () => "json",
    categoryService: categoryService(),
    currentCredentialStoreForAccount: async () => STORE_ID,
    appendAudit: appendAuditEvent,
    now: () => new Date(NOW),
    randomUUID: () => "runtime-lease",
  });

  const result = await runtime.resolveDue({ accountId: ACCOUNT_ID, limit: 1 });

  const matched = state.collectCategoryResolutions[0];
  assert.equal(result.processed, 1);
  assert.equal(matched.status, "MATCHED");
  assert.equal(matched.credentialStoreId, STORE_ID);
});

test("worker timer is stoppable and timer callback failures stay process-safe", async () => {
  const callbacks = {};
  const cleared = [];
  const logged = [];
  const timers = {
    setTimeout(callback) { callbacks.initial = callback; return { kind: "initial", unref() {} }; },
    setInterval(callback) { callbacks.interval = callback; return { kind: "interval", unref() {} }; },
    clearTimeout(timer) { cleared.push(timer.kind); },
    clearInterval(timer) { cleared.push(timer.kind); },
  };
  const runtime = createCollectCategoryResolutionRuntime({
    loadState: async () => { throw Object.assign(new Error("raw database detail"), { code: "STATE_DOWN" }); },
    saveState: async () => {},
    stateTransaction: createJsonStateTransactionBoundary({ enabled: () => true }),
    persistenceMode: () => "json",
    categoryService: categoryService(),
    currentCredentialStoreForAccount: async () => "",
    appendAudit: appendAuditEvent,
    logger: { error: (...values) => logged.push(values) },
    timers,
    now: () => new Date(NOW),
    randomUUID: () => "runtime-lease",
  });

  const stop = runtime.start({ initialDelayMs: 1, intervalMs: 5 });
  await callbacks.initial();
  await callbacks.interval();
  stop();
  runtime.stop();

  assert.deepEqual(cleared, ["initial", "interval"]);
  assert.equal(logged.length >= 1, true);
  assert.equal(JSON.stringify(logged).includes("raw database detail"), false);
});
