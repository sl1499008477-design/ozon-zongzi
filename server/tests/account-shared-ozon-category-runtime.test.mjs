import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { createJsonAccountScopedCollectionHandler } from "../account-scoped-collection-routes.mjs";
import { createJsonStateTransactionBoundary } from "../json-state-transaction.mjs";
import { createAccountSharedOzonCategoryRuntime } from "../account-shared-ozon-category-runtime.mjs";

const NOW = "2026-08-12T04:00:00.000Z";

function collectedItem() {
  return {
    id: "collect-a",
    accountId: "account-a",
    source: "ozon",
    sourceSku: "offer-a",
    draftVersion: 1,
    listingDraft: {
      sourceCategory: {
        descriptionCategoryId: 17028702,
        typeIdCandidate: 94405,
        path: ["家居", "杯子"],
        attributes: [{ key: "8229", value: "杯子", dictionaryValueId: 94405 }],
      },
    },
  };
}

function createRuntimeHarness(overrides = {}) {
  const state = {
    caches: { collectBox: [collectedItem()] },
    collectOzonCategorySourceEvidence: [],
    accountOzonSharedCategories: [],
    accountOzonSharedCategoryEvents: [],
    accountOzonCategoryConfirmations: [],
    auditEvents: [],
  };
  let saves = 0;
  const runtime = createAccountSharedOzonCategoryRuntime({
    loadState: async () => state,
    saveState: async () => { saves += 1; },
    stateTransaction: createJsonStateTransactionBoundary({ enabled: () => true }),
    persistenceMode: () => "json",
    now: () => new Date(NOW),
    randomUUID: (() => { let id = 0; return () => `runtime-id-${++id}`; })(),
    ...overrides,
  });
  return { runtime, state, saves: () => saves };
}

function resolvedLookup(hashSeed = "entry-lookup") {
  const lookupHash = crypto.createHash("sha256").update(hashSeed).digest("hex");
  const identityHash = crypto.createHash("sha256").update("offer:offer-entry").digest("hex");
  return Object.freeze({
    status: "RESOLVED", ozonProductId: 10001, sourceSku: "offer-entry",
    lookupContractVersion: "account-shared-ozon-category-lookup.v1",
    requestedOzonProductId: null, requestedSourceSku: "offer-entry",
    matchedOzonProductId: 10001, matchedSourceSku: "offer-entry",
    sourceDescriptionCategoryId: 17028702, sourceTypeId: 94405,
    normalizedPath: Object.freeze(["家居", "杯子"]), attributeSummary: Object.freeze([]),
    rawResponseRef: `ozon-read:offer:${identityHash}:${lookupHash}`,
    rawResponseHash: lookupHash,
    capturedAt: NOW,
  });
}

function createCollectionEntryHarness({ failSave = false, lookupResult = resolvedLookup() } = {}) {
  const state = { caches: { collectBox: [] }, collectRequests: [] };
  const response = {};
  const transaction = createJsonStateTransactionBoundary({ enabled: () => true });
  let nextId = 0;
  const runtime = createAccountSharedOzonCategoryRuntime({
    loadState: async () => state,
    saveState: async (working) => {
      const saved = structuredClone(working);
      for (const key of Object.keys(state)) delete state[key];
      Object.assign(state, saved);
    },
    stateTransaction: transaction,
    persistenceMode: () => "json",
    sourceLookup: { async lookup() { return lookupResult; } },
    now: () => new Date(NOW),
    randomUUID: () => `entry-id-${++nextId}`,
  });
  const handler = createJsonAccountScopedCollectionHandler({
    authenticate: async () => ({ id: "account-entry" }),
    readJson: async () => ({
      sourceSku: "offer-entry", requestId: "request-entry", capturedAt: NOW,
      payload: { sku: "offer-entry", name: "Entry lookup", draftVersion: 1 },
    }),
    normalizeItem: (item) => ({ ...item, draftVersion: 1 }),
    loadState: async () => structuredClone(state),
    saveState: async (working) => {
      if (failSave) throw new Error("controlled entry save failure");
      const saved = structuredClone(working);
      for (const key of Object.keys(state)) delete state[key];
      Object.assign(state, saved);
    },
    stateTransaction: transaction,
    enqueueForCollect: async () => {},
    completeLinkedJobsFromCollectEvidence: async () => {},
    sendJson: (_res, status, body) => Object.assign(response, { status, body }),
    sendError: (_res, status, message, code) => Object.assign(response, {
      status, body: { ok: false, message, code },
    }),
    countAccountItems: (working, account) => working.caches.collectBox
      .filter((item) => item.accountId === account.id),
    categoryEvidencePort: runtime,
    now: () => new Date(NOW),
  });
  return {
    state, response, runtime,
    invoke: () => handler(
      { method: "POST" }, {}, new URL("http://local/sources/ozon/collect"), state,
    ),
  };
}

test("unresolved collection can be manually confirmed with immutable provenance and reused", async () => {
  const { state, response, runtime, invoke } = createCollectionEntryHarness({
    lookupResult: Object.freeze({ status: "UNRESOLVED" }),
  });

  await invoke();

  assert.equal(response.status, 200);
  assert.equal((state.collectOzonCategorySourceEvidence ?? []).length, 0);
  assert.equal((state.accountOzonSharedCategories ?? []).length, 0);
  assert.equal(state.collectOzonCategoryCurrentSources.length, 1);
  const pointerBefore = structuredClone(state.collectOzonCategoryCurrentSources[0]);

  const request = {
    actor: { id: "account-entry", role: "admin" },
    collectItemId: state.caches.collectBox[0].id,
    expectedSourceVersion: pointerBefore.sourceVersion,
    descriptionCategoryId: 17028788,
    typeId: 95555,
    taxonomyScope: "OZON:DEFAULT",
    idempotencyKey: "unresolved-manual-confirmation",
    correlationId: "unresolved-manual-correlation",
  };
  const routeResponse = {};
  const handler = runtime.createHttpHandler({
    authenticate: async () => request.actor,
    readJson: async () => Object.fromEntries(Object.entries(request)
      .filter(([key]) => key !== "actor")),
    sendJson: (_res, status, body) => Object.assign(routeResponse, { status, body }),
  });
  assert.equal(await handler({ method: "POST" }, {},
    new URL("http://local/ozon/category-confirmations")), true);
  assert.equal(routeResponse.status, 200);
  const confirmed = routeResponse.body.data;
  const replay = await runtime.confirmManualCategory(request);

  assert.deepEqual(replay, confirmed);
  assert.equal(confirmed.categoryResolution.source, "MANUAL");
  assert.equal(confirmed.categoryResolution.version, 1);
  assert.equal(state.collectOzonCategorySourceEvidence.length, 1);
  const manual = state.collectOzonCategorySourceEvidence[0];
  assert.equal(manual.provenance.sourceKind, "MANUAL_CONFIRMATION");
  assert.equal(manual.provenance.triggerProductDraftId, pointerBefore.sourceRecordId);
  assert.equal(manual.provenance.triggerProductDraftVersion, 1);
  assert.equal(manual.provenance.actorId, "account-entry");
  assert.equal(manual.provenance.correlationId, request.correlationId);
  assert.equal(manual.provenance.idempotencyKey, request.idempotencyKey);
  assert.equal(state.collectOzonCategoryCurrentSources[0].evidenceId, manual.id);
  assert.equal(state.collectOzonCategoryCurrentSources[0].sourceKind, "MANUAL_CONFIRMATION");
  assert.equal(state.accountOzonCategoryConfirmations[0].sourceEvidenceId, manual.id);
  assert.equal(state.accountOzonCategoryConfirmations.length, 1);
  assert.equal(state.accountOzonSharedCategoryEvents.length, 1);

  const secondItem = collectedItem();
  secondItem.id = "collect-second-store";
  secondItem.accountId = "account-entry";
  secondItem.sourceSku = "offer-second-store";
  secondItem.draftVersion = 1;
  secondItem.listingDraft.sourceCategory.descriptionCategoryId = 17028788;
  secondItem.listingDraft.sourceCategory.typeIdCandidate = 95555;
  state.caches.collectBox.push(secondItem);
  const reused = await runtime.recordCollectionResult({
    state, accountId: "account-entry", collectItemId: secondItem.id, item: secondItem,
    productDraftId: "draft-second-store", productDraftVersion: 1,
    sourceVersion: "draft:1", rawResponseRef: "raw-second-store",
    rawResponseHash: crypto.createHash("sha256").update("raw-second-store").digest("hex"),
    capturedAt: NOW,
  });
  assert.equal(reused.categoryResolution.source, "MANUAL",
    "the same account reuses the selection without store-specific matching");
  assert.equal(state.accountOzonSharedCategories.find((row) =>
    row.sourceDescriptionCategoryId === 17028788 && row.sourceTypeId === 95555).evidenceId, manual.id);
});

test("JSON collection entry persists a private canonical draft pointer before first exact lookup", async () => {
  const { state, response, runtime, invoke } = createCollectionEntryHarness();

  await invoke();

  assert.equal(response.status, 200);
  assert.equal(Object.hasOwn(state.caches.collectBox[0], "currentDraftId"), false,
    "private draft identity does not change the collection item/public shape");
  assert.equal(Object.hasOwn(state.caches.collectBox[0], "productDraftId"), false);
  assert.equal(/currentDraftId|productDraftId/.test(JSON.stringify(response.body)), false);
  assert.equal(state.accountOzonSharedCategories[0].status, "ACTIVE",
    "the exact lookup resolves immediately inside the collection transaction");
  assert.equal(state.collectOzonCategoryCurrentSources.length, 1);
  const refreshed = await runtime.readForItems({
    accountId: "account-entry", collectItemIds: [state.caches.collectBox[0].id],
  });
  assert.equal(refreshed.length, 1);
  assert.equal(refreshed[0].categoryResolution.status, "ACTIVE");

  const confirmed = await runtime.confirmManualCategory({
    actor: { id: "account-entry", role: "admin" },
    collectItemId: state.caches.collectBox[0].id,
    expectedSourceVersion: "draft:1",
    descriptionCategoryId: 17028788,
    typeId: 95555,
    taxonomyScope: "OZON:DEFAULT",
    idempotencyKey: "entry-manual-confirmation",
    correlationId: "entry-manual-correlation",
  });
  assert.equal(confirmed.categoryResolution.source, "MANUAL");
});

test("JSON collection entry rolls back private pointer and lookup evidence when its single save fails", async () => {
  const { state, response, invoke } = createCollectionEntryHarness({ failSave: true });
  const before = structuredClone(state);

  await invoke();

  assert.equal(response.status, 500);
  assert.deepEqual(state, before);
  assert.equal(Object.hasOwn(state, "collectOzonCategoryCurrentSources"), false);
  assert.equal(Object.hasOwn(state, "collectOzonCategorySourceEvidence"), false);
});

test("JSON caller-owned lookup replay and stale draft cannot replace a newer private pointer", async () => {
  const state = {
    caches: { collectBox: [{ ...collectedItem(), listingDraft: {}, draftVersion: 1 }] },
  };
  let lookupNumber = 0;
  const lookupSeeds = ["lookup-1", "lookup-1", "lookup-2", "lookup-stale"];
  const runtime = createAccountSharedOzonCategoryRuntime({
    loadState: async () => state,
    saveState: async () => {},
    stateTransaction: createJsonStateTransactionBoundary({ enabled: () => true }),
    persistenceMode: () => "json",
    sourceLookup: { async lookup() {
      const result = resolvedLookup(lookupSeeds[lookupNumber]);
      lookupNumber += 1;
      return result;
    } },
    now: () => new Date(NOW),
    randomUUID: (() => { let id = 0; return () => `stale-id-${++id}`; })(),
  });
  const input = {
    state, accountId: "account-a", collectItemId: "collect-a", item: state.caches.collectBox[0],
    productDraftId: "draft:collect-a", productDraftVersion: 1, sourceVersion: "draft:1",
    rawResponseRef: "raw-a", rawResponseHash: crypto.createHash("sha256").update("raw-a").digest("hex"),
    capturedAt: NOW,
  };
  const first = await runtime.recordCollectionResult(input);
  assert.equal(first.categoryResolution.status, "ACTIVE");
  const firstPointer = structuredClone(state.collectOzonCategoryCurrentSources[0]);

  await runtime.recordCollectionResult(input);
  assert.deepEqual(state.collectOzonCategoryCurrentSources[0], firstPointer,
    "same-draft replay does not downgrade a lookup pointer to PRODUCT_DRAFT");

  state.caches.collectBox[0].draftVersion = 2;
  const current = await runtime.recordCollectionResult({
    ...input, item: state.caches.collectBox[0], productDraftVersion: 2, sourceVersion: "draft:2",
    rawResponseHash: crypto.createHash("sha256").update("raw-b").digest("hex"),
  });
  assert.equal(current.categoryResolution.status, "ACTIVE");
  const currentPointer = structuredClone(state.collectOzonCategoryCurrentSources[0]);
  assert.notDeepEqual(currentPointer, firstPointer);

  await runtime.recordCollectionResult(input);
  assert.deepEqual(state.collectOzonCategoryCurrentSources[0], currentPointer,
    "an old draft completion cannot overwrite the newer lookup pointer");
});

test("missing source IDs use only an ephemeral account-owned credential for exact read lookup", async () => {
  const lookupContexts = [];
  const sourceLookup = {
    async lookup(context) {
      lookupContexts.push(context);
      const lookupHash = crypto.createHash("sha256").update("lookup").digest("hex");
      const identityHash = crypto.createHash("sha256").update("offer:offer-a").digest("hex");
      return Object.freeze({
        status: "RESOLVED", ozonProductId: 10001, sourceSku: "offer-a",
        lookupContractVersion: "account-shared-ozon-category-lookup.v1",
        requestedOzonProductId: null, requestedSourceSku: "offer-a",
        matchedOzonProductId: 10001, matchedSourceSku: "offer-a",
        sourceDescriptionCategoryId: 17028702, sourceTypeId: 94405,
        normalizedPath: Object.freeze(["家居", "杯子"]), attributeSummary: Object.freeze([]),
        rawResponseRef: `ozon-read:offer:${identityHash}:${lookupHash}`,
        rawResponseHash: lookupHash,
        capturedAt: NOW,
      });
    },
  };
  const { runtime, state } = createRuntimeHarness({ sourceLookup });
  state.currentStoreIdsByAccount = { "account-a": "credential-store-a" };
  state.stores = [{
    id: "credential-store-a", ownerAccountId: "account-a", clientId: "client-a", apiKey: "secret-a",
  }, { id: "foreign-store", ownerAccountId: "account-b", clientId: "client-b", apiKey: "secret-b" }];
  const item = collectedItem();
  delete item.listingDraft.sourceCategory.descriptionCategoryId;
  delete item.listingDraft.sourceCategory.typeIdCandidate;
  await runtime.recordCollectionResult({
    state, accountId: "account-a", collectItemId: "collect-a", item,
    productDraftId: "draft-a", productDraftVersion: 1, sourceVersion: "draft:1",
    rawResponseRef: "raw-a", rawResponseHash: crypto.createHash("sha256").update("raw-a").digest("hex"),
    capturedAt: NOW,
  });
  assert.equal(lookupContexts.length, 1);
  assert.equal(lookupContexts[0].store.id, "credential-store-a");
  assert.equal(JSON.stringify(state.collectOzonCategorySourceEvidence).includes("credential-store-a"), false);
  assert.equal(JSON.stringify(state.accountOzonSharedCategories).includes("secret-a"), false);
});

test("PostgreSQL missing source IDs load credential-only state and keep account-scoped store selection", async () => {
  const loadOptions = [];
  const lookupContexts = [];
  const credentialState = {
    currentStoreIdsByAccount: {
      "account-a": "credential-store-a",
      "account-b": "credential-store-b",
    },
    stores: [
      { id: "credential-store-a", ownerAccountId: "account-a", clientId: "client-a", apiKey: "secret-a" },
      { id: "credential-store-b", ownerAccountId: "account-b", clientId: "client-b", apiKey: "secret-b" },
    ],
  };
  const runtime = createAccountSharedOzonCategoryRuntime({
    loadState: async (options) => {
      loadOptions.push(options);
      return credentialState;
    },
    saveState: async () => {},
    stateTransaction: createJsonStateTransactionBoundary({ enabled: () => false }),
    persistenceMode: () => "postgres",
    sourceLookup: {
      async lookup(context) {
        lookupContexts.push(context);
        return resolvedLookup("postgres-credential-only");
      },
    },
    initializePostgresRepository: () => ({
      recordSourceEvidence: async () => ({ shared: null }),
      readCurrentEvidence: async () => [],
      readSharedForEvidence: async () => [],
    }),
    now: () => new Date(NOW),
    randomUUID: () => "postgres-credential-only",
  });
  const item = collectedItem();
  item.sourceSku = "offer-entry";
  delete item.listingDraft.sourceCategory.descriptionCategoryId;
  delete item.listingDraft.sourceCategory.typeIdCandidate;

  await runtime.recordCollectionResult({
    accountId: "account-a",
    collectItemId: "collect-a",
    item,
    productDraftId: "draft-a",
    productDraftVersion: 1,
    sourceVersion: "draft:1",
    rawResponseRef: "raw-a",
    rawResponseHash: crypto.createHash("sha256").update("raw-a").digest("hex"),
    capturedAt: NOW,
  });

  assert.deepEqual(loadOptions, [{ hydrateCatalog: false }]);
  assert.equal(lookupContexts.length, 1);
  assert.equal(lookupContexts[0].accountId, "account-a");
  assert.equal(lookupContexts[0].store.id, "credential-store-a");
  assert.equal(lookupContexts[0].store.ownerAccountId, "account-a");
});

test("numeric public Ozon product id is not duplicated as a seller offer id", async () => {
  const lookupContexts = [];
  const sourceLookup = {
    async lookup(context) {
      lookupContexts.push(context);
      return resolvedLookup("numeric-product-id");
    },
  };
  const { runtime, state } = createRuntimeHarness({ sourceLookup });
  const item = collectedItem();
  item.ozonProductId = 10001;
  item.sku = "10001";
  item.sourceSku = "10001";
  delete item.listingDraft.sourceCategory.descriptionCategoryId;
  delete item.listingDraft.sourceCategory.typeIdCandidate;

  await runtime.recordCollectionResult({
    state,
    accountId: "account-a",
    collectItemId: "collect-a",
    item,
    productDraftId: "draft-a",
    productDraftVersion: 1,
    sourceVersion: "draft:1",
    rawResponseRef: "raw-a",
    rawResponseHash: crypto.createHash("sha256").update("raw-a").digest("hex"),
    capturedAt: NOW,
  });

  assert.equal(lookupContexts.length, 1);
  assert.equal(lookupContexts[0].ozonProductId, 10001);
  assert.equal(lookupContexts[0].sourceSku, null);
});

test("JSON collection result and immutable source evidence commit through one save", async () => {
  const { runtime, state, saves } = createRuntimeHarness();
  await runtime.recordCollectionResult({
    state,
    accountId: "account-a",
    collectItemId: "collect-a",
    item: collectedItem(),
    productDraftId: "draft-a",
    productDraftVersion: 1,
    sourceVersion: "draft:1",
    rawResponseRef: "raw-a",
    rawResponseHash: crypto.createHash("sha256").update("raw-a").digest("hex"),
    capturedAt: NOW,
  });
  assert.equal(saves(), 0, "caller-owned collection transaction performs the single save");
  assert.equal(state.collectOzonCategorySourceEvidence.length, 1);
  assert.equal(state.accountOzonSharedCategories.length, 1);
});

test("category evidence summary normalizes multiline product attributes without changing category IDs", async () => {
  const { runtime, state } = createRuntimeHarness();
  const item = collectedItem();
  item.listingDraft.sourceCategory.attributes.push({
    key: "4384",
    value: "第一行\n\n第二行",
  });

  const result = await runtime.recordCollectionResult({
    state,
    accountId: "account-a",
    collectItemId: "collect-a",
    item,
    productDraftId: "draft-a",
    productDraftVersion: 1,
    sourceVersion: "draft:1",
    rawResponseRef: "raw-a",
    rawResponseHash: crypto.createHash("sha256").update("raw-a").digest("hex"),
    capturedAt: NOW,
  });

  assert.equal(result.categoryResolution.status, "ACTIVE");
  assert.equal(result.categoryResolution.currentDescriptionCategoryId, 17028702);
  assert.equal(result.categoryResolution.currentTypeId, 94405);
  assert.deepEqual(
    state.collectOzonCategorySourceEvidence[0].attributeSummary.find(
      (attribute) => attribute.key === "4384",
    ),
    { key: "4384", value: "第一行 第二行" },
  );
});

test("standalone JSON evidence persistence failure does not partially mutate category state", async () => {
  const { state } = createRuntimeHarness();
  const before = structuredClone(state);
  const runtime = createAccountSharedOzonCategoryRuntime({
    loadState: async () => state,
    saveState: async () => { throw new Error("controlled source save failure"); },
    stateTransaction: createJsonStateTransactionBoundary({ enabled: () => true }),
    persistenceMode: () => "json", now: () => new Date(NOW), randomUUID: () => "failed-source-id",
  });
  await assert.rejects(runtime.recordCollectionResult({
    accountId: "account-a", collectItemId: "collect-a", item: collectedItem(),
    productDraftId: "draft-a", productDraftVersion: 1, sourceVersion: "draft:1",
    rawResponseRef: "raw-a", rawResponseHash: crypto.createHash("sha256").update("raw-a").digest("hex"),
    capturedAt: NOW,
  }));
  assert.deepEqual(state, before);
});

test("administrator confirmation is closed, account/version scoped, idempotent, and audited", async () => {
  const { runtime, state } = createRuntimeHarness();
  await runtime.recordCollectionResult({
    state,
    accountId: "account-a",
    collectItemId: "collect-a",
    item: collectedItem(),
    productDraftId: "draft-a",
    productDraftVersion: 1,
    sourceVersion: "draft:1",
    rawResponseRef: "raw-a",
    rawResponseHash: crypto.createHash("sha256").update("raw-a").digest("hex"),
    capturedAt: NOW,
  });
  const request = {
    actor: { id: "account-a", role: "admin" },
    collectItemId: "collect-a",
    expectedSourceVersion: "draft:1",
    descriptionCategoryId: 17028702,
    typeId: 94405,
    taxonomyScope: "OZON:DEFAULT",
    idempotencyKey: "category-confirmation-id",
    correlationId: "correlation-id",
  };
  const first = await runtime.confirmManualCategory(request);
  const replay = await runtime.confirmManualCategory(request);
  assert.deepEqual(replay, first);
  assert.equal(state.accountOzonCategoryConfirmations.length, 1);
  assert.equal(state.accountOzonSharedCategoryEvents.length, 2);
  assert.equal(state.collectOzonCategorySourceEvidence.length, 2,
    "manual authority appends a distinct immutable confirmation observation");
  assert.equal(state.collectOzonCategorySourceEvidence.at(-1).provenance.sourceKind,
    "MANUAL_CONFIRMATION");
  assert.equal(state.accountOzonSharedCategories[0].evidenceId,
    state.collectOzonCategorySourceEvidence[1].id);
  assert.deepEqual(state.accountOzonCategoryConfirmations[0].actor, {
    id: "account-a", role: "admin",
  });
  assert.equal(state.accountOzonCategoryConfirmations[0].confirmedAt, NOW);

  const corrected = await runtime.confirmManualCategory({
    ...request,
    descriptionCategoryId: 17028788,
    typeId: 95555,
    idempotencyKey: "category-confirmation-correction",
    correlationId: "correlation-correction",
  });
  assert.equal(corrected.categoryResolution.currentDescriptionCategoryId, 17028788);
  assert.equal(corrected.categoryResolution.version, 1);
  assert.equal(state.collectOzonCategorySourceEvidence.length, 3);

  for (const invalid of [
    { ...request, actor: { id: "account-a", role: "user" } },
    { ...request, actor: { id: "account-b", role: "admin" } },
    { ...request, expectedSourceVersion: "draft:stale", idempotencyKey: "stale" },
    { ...request, descriptionCategoryId: 17028703 },
    { ...request, extra: true, idempotencyKey: "extra" },
  ]) {
    const before = JSON.stringify(state);
    await assert.rejects(runtime.confirmManualCategory(invalid));
    assert.equal(JSON.stringify(state), before);
  }
});

test("JSON confirmation persistence failure leaves category state unchanged", async () => {
  const { runtime: recorder, state } = createRuntimeHarness();
  await recorder.recordCollectionResult({
    state, accountId: "account-a", collectItemId: "collect-a", item: collectedItem(),
    productDraftId: "draft-a", productDraftVersion: 1, sourceVersion: "draft:1",
    rawResponseRef: "raw-a", rawResponseHash: crypto.createHash("sha256").update("raw-a").digest("hex"),
    capturedAt: NOW,
  });
  const before = structuredClone(state);
  const runtime = createAccountSharedOzonCategoryRuntime({
    loadState: async () => state,
    saveState: async () => { throw new Error("controlled save failure"); },
    stateTransaction: createJsonStateTransactionBoundary({ enabled: () => true }),
    persistenceMode: () => "json", now: () => new Date(NOW), randomUUID: () => "failed-id",
  });
  await assert.rejects(runtime.confirmManualCategory({
    actor: { id: "account-a", role: "admin" }, collectItemId: "collect-a",
    expectedSourceVersion: "draft:1", descriptionCategoryId: 17028702, typeId: 94405,
    taxonomyScope: "OZON:DEFAULT", idempotencyKey: "failed-confirmation",
    correlationId: "failed-correlation",
  }));
  assert.deepEqual(state, before);
});

test("manual HTTP endpoint authenticates first and never trusts ordinary users", async () => {
  const { runtime, state } = createRuntimeHarness();
  let serviceCalls = 0;
  const handler = runtime.createHttpHandler({
    authenticate: async () => ({ id: "account-a", role: "user" }),
    readJson: async () => ({
      collectItemId: "collect-a", expectedSourceVersion: "draft:1",
      descriptionCategoryId: 17028702, typeId: 94405, taxonomyScope: "OZON:DEFAULT",
      idempotencyKey: "category-confirmation-id", correlationId: "correlation-id",
    }),
    sendJson: (_res, status, body) => { serviceCalls += body.ok ? 1 : 0; _res.status = status; _res.body = body; },
  });
  const res = {};
  assert.equal(await handler({ method: "POST" }, res, new URL("http://local/ozon/category-confirmations")), true);
  assert.equal(res.status, 403);
  assert.equal(res.body.code, "PERMISSION_FORBIDDEN");
  assert.equal(serviceCalls, 0);
  assert.equal(state.accountOzonCategoryConfirmations.length, 0);
});

test("PostgreSQL administrator confirmation keeps transition, audit, and idempotency in one transaction", async () => {
  const queries = [];
  const HASH = crypto.createHash("sha256").update("raw-a").digest("hex");
  const source = Object.freeze({
    id: "evidence-a", accountId: "account-a", collectItemId: "collect-a",
    sourceVersion: "draft:1", productDraftId: "draft-a", productDraftVersion: 1,
    ozonProductId: 10001, sourceSku: "offer-a", taxonomyScope: "OZON:DEFAULT",
    sourceDescriptionCategoryId: 17028702, sourceTypeId: 94405,
    normalizedPath: Object.freeze(["家居", "杯子"]), attributeSummary: Object.freeze([]),
    provenance: Object.freeze({
      accountId: "account-a", collectItemId: "collect-a", sourceKind: "PRODUCT_DRAFT",
      sourceRecordId: "draft-a", rawResponseRef: "raw-a", rawResponseHash: HASH,
      capturedAt: NOW,
    }),
    capturedAt: NOW, rawResponseRef: "raw-a", rawResponseHash: HASH,
  });
  const shared = Object.freeze({
    accountId: "account-a", sourceDescriptionCategoryId: 17028702, sourceTypeId: 94405,
    taxonomyScope: "OZON:DEFAULT", currentDescriptionCategoryId: 17028702,
    currentTypeId: 94405, status: "ACTIVE", source: "SOURCE_DIRECT",
    taxonomyFingerprint: null, version: 1, evidenceId: "evidence-a", validatedAt: null,
  });
  let confirmationCalls = 0;
  let confirmationInput = null;
  const client = {
    async query(sql, params = []) {
      queries.push({ sql: String(sql), params });
      if (String(sql).includes("FROM account_ozon_category_confirmation_audit")) return { rows: [] };
      if (String(sql).includes("FROM collect_ozon_category_manual_confirmation_evidence")) {
        return { rows: [{ id: "manual-confirmation:v1:" + "a".repeat(64) }] };
      }
      if (String(sql).includes("INSERT INTO account_ozon_category_confirmation_audit")) {
        return { rowCount: 1, rows: [{ id: params[0] }] };
      }
      if (String(sql).includes("INSERT INTO audit_events")) return { rowCount: 1, rows: [{ event_id: params[0] }] };
      return { rows: [] };
    },
    release() {},
  };
  const runtime = createAccountSharedOzonCategoryRuntime({
    loadState: async () => ({}), saveState: async () => {},
    stateTransaction: createJsonStateTransactionBoundary({ enabled: () => true }),
    persistenceMode: () => "postgres", now: () => new Date(NOW), randomUUID: () => "manual-evidence-a",
    postgresPool: async () => ({ connect: async () => client }),
    initializePostgresTransactionRepository: () => ({
      readCurrentEvidence: async () => [source],
      readSharedForEvidence: async () => [shared],
      confirmManualCategory: async (input) => {
        confirmationCalls += 1;
        confirmationInput = input;
        return Object.freeze({
          ...shared, source: "MANUAL", taxonomyFingerprint: crypto.createHash("sha256")
            .update("OZON:DEFAULT:17028702:94405").digest("hex"),
          version: 2, evidenceId: "evidence-a", validatedAt: NOW,
        });
      },
    }),
  });
  const result = await runtime.confirmManualCategory({
    actor: { id: "account-a", role: "admin" }, collectItemId: "collect-a",
    expectedSourceVersion: "draft:1", descriptionCategoryId: 17028702, typeId: 94405,
    taxonomyScope: "OZON:DEFAULT", idempotencyKey: "category-confirmation-id",
    correlationId: "correlation-id",
  });
  assert.equal(result.categoryResolution.source, "MANUAL");
  assert.equal(confirmationCalls, 1);
  assert.equal(confirmationInput.collectItemId, "collect-a");
  assert.equal(confirmationInput.expectedSourceVersion, "draft:1");
  assert.equal(confirmationInput.actorId, "account-a");
  assert.equal(confirmationInput.correlationId, "correlation-id");
  assert.equal(confirmationInput.idempotencyKey, "category-confirmation-id");
  assert.match(confirmationInput.requestHash, /^[0-9a-f]{64}$/u);
  assert.equal(Object.hasOwn(confirmationInput, "evidence"), false);
  assert.equal(queries[0].sql, "BEGIN");
  assert.ok(queries.some(({ sql }) => sql.includes("pg_advisory_xact_lock")));
  assert.ok(queries.some(({ sql }) => sql.includes("INSERT INTO audit_events")));
  assert.equal(queries.at(-1).sql, "COMMIT");
});

test('collection admission records Seller target while preserving the different original source evidence',async()=>{
  const h=createRuntimeHarness();
  const item=h.state.caches.collectBox[0];
  item.listingDraft.collectionAdmission={status:'PASSED',checkedAt:NOW,taxonomyFingerprint:'a'.repeat(64),
    targets:[{status:'MATCHED',method:'DICTIONARY_VALUE_ID',source:{descriptionCategoryId:17028702,typeIdCandidate:94405},
      target:{storeId:'store-a',descriptionCategoryId:17028701,typeId:94405}}]};
  await h.runtime.recordCollectionResult({state:h.state,accountId:'account-a',collectItemId:'collect-a',item,
    productDraftId:'draft:collect-a',productDraftVersion:1,sourceVersion:'draft:1',capturedAt:NOW,
    rawResponseRef:'collect-request:fixture',rawResponseHash:'b'.repeat(64)});
  const rows=await h.runtime.readForItems({accountId:'account-a',collectItemIds:['collect-a']});
  assert.equal(rows[0].categoryResolution.sourceDescriptionCategoryId,17028702);
  assert.equal(rows[0].categoryResolution.currentDescriptionCategoryId,17028701);
  assert.equal(rows[0].categoryResolution.validatedAt,NOW);
});
