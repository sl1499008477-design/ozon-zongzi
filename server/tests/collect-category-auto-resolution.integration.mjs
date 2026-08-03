import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { createJsonAccountScopedCollectionHandler } from "../account-scoped-collection-routes.mjs";
import { createCollectCategoryResolutionRuntime } from "../collect-category-resolution-runtime.mjs";
import { createCollectorOzonEnrichmentRuntime } from "../collector-ozon-enrichment-runtime.mjs";
import { createJsonStateTransactionBoundary } from "../json-state-transaction.mjs";

const ACCOUNT_A = "account-e2e-a";
const ACCOUNT_B = "account-e2e-b";
const STORE_A = "store-e2e-a";
const STORE_B = "store-e2e-b";
const FOREIGN_STORE = "store-e2e-foreign";
const COLLECTOR_SESSION = "collector-e2e-a";
const SOURCE_SKU = "4862904234";
const SOURCE_DESCRIPTION_CATEGORY_ID = 17_033_604;
const TARGET_DESCRIPTION_CATEGORY_ID = 17_028_702;
const TYPE_ID = 94_405;
const TAXONOMY_SCOPE = "OZON:DEFAULT";
const RAW_FAILURE_MARKER = "raw-upstream-marker-must-not-persist";
const PRIVATE_STORE_MARKER = "fixture-private-store-material";

function categoryTree({ changed = false } = {}) {
  return [{
    description_category_id: TARGET_DESCRIPTION_CATEGORY_ID,
    category_name: "家居",
    children: [
      { type_id: TYPE_ID, type_name: "杯子", children: [] },
      ...(changed
        ? [{ type_id: 99_999, type_name: "结构变更节点", children: [] }]
        : []),
    ],
  }];
}

function responseRecorder() {
  return {
    status: 0,
    body: null,
    writeHead(status) { this.status = status; },
    end(body = "") { this.body = body ? JSON.parse(String(body)) : null; },
  };
}

async function invokeCollection(handler, state, { accountId = ACCOUNT_A, body }) {
  const req = {
    method: "POST",
    headers: {},
    accountId,
    testBody: structuredClone(body),
  };
  const res = responseRecorder();
  await handler(req, res, new URL("http://local.test/sources/ozon/collect"), state);
  return res;
}

async function requestJson(handle, pathname, token) {
  const req = Readable.from([]);
  req.method = "GET";
  req.url = pathname;
  req.headers = { authorization: `Bearer ${token}` };
  const res = responseRecorder();
  await handle(req, res);
  return res;
}

function publicCategoryOutcome(item) {
  return {
    sourceCategory: item.sourceCategory,
    status: item.categoryResolution?.status,
    taxonomyScope: item.categoryResolution?.taxonomyScope,
    targetDescriptionCategoryId: item.categoryResolution?.targetDescriptionCategoryId,
    targetTypeId: item.categoryResolution?.targetTypeId,
    method: item.categoryResolution?.method,
    message: item.categoryResolution?.message,
  };
}

test("collection ingress completes Seller evidence and resolves categories in the background with safe reuse and recovery", async (t) => {
  const startedAt = Date.now();
  let nowMs = startedAt;
  let currentStoreId = STORE_A;
  let currentFingerprint = "taxonomy-e2e-v1";
  let rateLimitPending = true;
  let categorySnapshotCalls = 0;
  let stateLoads = 0;
  let stateSaves = 0;
  let categoryLease = 0;
  let enrichmentLease = 0;
  const validationCalls = [];
  const operationalLogs = [];
  const state = {
    accounts: [
      { id: ACCOUNT_A, username: "e2e-a", role: "admin", status: "active" },
      { id: ACCOUNT_B, username: "e2e-b", role: "admin", status: "active" },
    ],
    sessions: {
      token_e2e_a: { token: "token_e2e_a", accountId: ACCOUNT_A, issuedAt: new Date(startedAt).toISOString() },
      token_e2e_b: { token: "token_e2e_b", accountId: ACCOUNT_B, issuedAt: new Date(startedAt).toISOString() },
    },
    currentStoreIdsByAccount: { [ACCOUNT_A]: STORE_A, [ACCOUNT_B]: FOREIGN_STORE },
    stores: [
      {
        id: STORE_A,
        ownerAccountId: ACCOUNT_A,
        status: "ACTIVE",
        clientId: "fixture-client-a",
        apiKey: `${PRIVATE_STORE_MARKER}-a`,
        updatedAt: new Date(startedAt - 60_000).toISOString(),
      },
      {
        id: STORE_B,
        ownerAccountId: ACCOUNT_A,
        status: "ACTIVE",
        clientId: "fixture-client-b",
        apiKey: `${PRIVATE_STORE_MARKER}-b`,
        updatedAt: new Date(startedAt - 60_000).toISOString(),
      },
      {
        id: FOREIGN_STORE,
        ownerAccountId: ACCOUNT_B,
        status: "ACTIVE",
        clientId: "fixture-client-foreign",
        apiKey: `${PRIVATE_STORE_MARKER}-foreign`,
      },
    ],
    caches: { collectBox: [] },
    collectRequests: [],
    collectCategoryResolutions: [],
    collectCategoryResolutionRuntimeCursors: {},
    collectorOzonEnrichmentJobs: [],
    collectorOzonEnrichmentCache: [],
    collectorSessions: [{
      id: COLLECTOR_SESSION,
      accountId: ACCOUNT_A,
      expiresAt: "9999-12-31T23:59:59.999Z",
      revokedAt: null,
    }],
    hashes: {},
    leases: {},
    browserAgents: {},
    jobs: {},
    reports: [],
    auditEvents: [],
  };
  const stateTransaction = createJsonStateTransactionBoundary({ enabled: () => true });
  const loadState = async () => {
    stateLoads += 1;
    return state;
  };
  const saveState = async () => { stateSaves += 1; };
  const categoryService = {
    async getCategorySnapshot({ accountId, store }) {
      assert.equal(accountId, ACCOUNT_A);
      assert.equal(store.ownerAccountId, ACCOUNT_A);
      assert.equal([STORE_A, STORE_B].includes(store.id), true);
      categorySnapshotCalls += 1;
      if (rateLimitPending) {
        rateLimitPending = false;
        throw Object.assign(new Error(RAW_FAILURE_MARKER), {
          status: 429,
          code: "OZON_RATE_LIMITED",
        });
      }
      return {
        items: categoryTree({ changed: currentFingerprint === "taxonomy-e2e-v2" }),
        taxonomyScope: TAXONOMY_SCOPE,
        taxonomyFingerprint: currentFingerprint,
        fetchedAt: new Date(nowMs).toISOString(),
        stale: false,
      };
    },
    async validateTarget({ accountId, store }, target) {
      assert.equal(accountId, ACCOUNT_A);
      assert.equal(store.ownerAccountId, ACCOUNT_A);
      validationCalls.push({ storeId: store.id, target: structuredClone(target) });
      return {
        valid: true,
        reasonCode: "VALID",
        taxonomyFingerprint: currentFingerprint,
        validatedAt: new Date(nowMs).toISOString(),
      };
    },
  };
  const categoryRuntime = createCollectCategoryResolutionRuntime({
    loadState,
    saveState,
    stateTransaction,
    persistenceMode: () => "json",
    categoryService,
    currentCredentialStoreForAccount: async (accountId) => {
      assert.equal(accountId, ACCOUNT_A);
      return currentStoreId;
    },
    now: () => new Date(nowMs),
    randomUUID: () => `category-lease-${++categoryLease}`,
    logger: { error: (...values) => operationalLogs.push(structuredClone(values)) },
  });
  const enrichmentRuntime = createCollectorOzonEnrichmentRuntime({
    loadState,
    saveState,
    persistenceMode: () => "json",
    stateTransaction,
    authenticate: async () => ({ collectorSessionId: COLLECTOR_SESSION, accountId: ACCOUNT_A }),
    authenticateAccount: async () => ({ id: ACCOUNT_A }),
    readJson: async (req) => structuredClone(req.testBody || {}),
    sendJson() {},
    now: () => new Date(nowMs),
    randomUUID: () => `enrichment-lease-${++enrichmentLease}`,
    sleep: async () => {},
    categoryResolutionPort: categoryRuntime,
    logger: { error: (...values) => operationalLogs.push(structuredClone(values)) },
  });
  const collectionHandler = createJsonAccountScopedCollectionHandler({
    authenticate: async (req) => ({ id: req.accountId }),
    readJson: async (req) => structuredClone(req.testBody || {}),
    normalizeItem: (item) => structuredClone(item),
    loadState,
    saveState,
    stateTransaction,
    enqueueForCollect: enrichmentRuntime.enqueueForCollect,
    completeLinkedJobsFromCollectEvidence: enrichmentRuntime.completeLinkedJobsFromCollectEvidence,
    sendJson(res, status, body) {
      res.status = status;
      res.body = structuredClone(body);
    },
    sendError(res, status, message, code, details) {
      res.status = status;
      res.body = { ok: false, message, code, ...(details || {}) };
    },
    countAccountItems(currentState, account) {
      return currentState.caches.collectBox.filter((item) => item.accountId === account.id);
    },
    categoryResolutionPort: categoryRuntime,
    logger: { error: (...values) => operationalLogs.push(structuredClone(values)) },
  });

  const collectInput = {
    source: "ozon",
    sourceSku: SOURCE_SKU,
    requestId: "request-e2e-source",
    capturedAt: new Date(startedAt).toISOString(),
    payload: {
      sku: SOURCE_SKU,
      name: "来源旧类目杯子",
      description_category_id: SOURCE_DESCRIPTION_CATEGORY_ID,
      type_id: TYPE_ID,
    },
  };

  const concurrentUploads = await Promise.all([
    invokeCollection(collectionHandler, state, { body: collectInput }),
    invokeCollection(collectionHandler, state, { body: collectInput }),
  ]);
  assert.deepEqual(concurrentUploads.map((result) => result.status), [200, 200]);
  assert.deepEqual(
    concurrentUploads.map((result) => result.body.data.duplicate).sort(),
    [false, true],
  );
  const collectItemId = concurrentUploads[0].body.data.id;
  assert.equal(state.caches.collectBox.length, 1);
  assert.equal(state.collectRequests.length, 1);
  assert.equal(state.collectorOzonEnrichmentJobs.length, 1);
  assert.equal(state.collectCategoryResolutions.length, 1);
  assert.equal(state.caches.collectBox[0].enrichment.status, "PENDING_ENRICHMENT");
  assert.equal(state.collectCategoryResolutions[0].status, "WAITING_ENRICHMENT");
  assert.deepEqual(state.caches.collectBox[0].sourceCategory, {
    descriptionCategoryId: SOURCE_DESCRIPTION_CATEGORY_ID,
    typeIdCandidate: TYPE_ID,
  });

  const beforeForgedUpload = {
    items: state.caches.collectBox.length,
    requests: state.collectRequests.length,
    enrichmentJobs: state.collectorOzonEnrichmentJobs.length,
    resolutions: state.collectCategoryResolutions.length,
  };
  const forgedScope = await invokeCollection(collectionHandler, state, {
    body: {
      ...collectInput,
      sourceSku: "forged-scope",
      requestId: "forged-scope",
      accountId: ACCOUNT_B,
    },
  });
  assert.equal(forgedScope.status, 400);
  assert.equal(forgedScope.body.code, "COLLECTOR_SCOPE_FIELD_FORBIDDEN");
  assert.deepEqual({
    items: state.caches.collectBox.length,
    requests: state.collectRequests.length,
    enrichmentJobs: state.collectorOzonEnrichmentJobs.length,
    resolutions: state.collectCategoryResolutions.length,
  }, beforeForgedUpload);

  nowMs = Date.now() + 1_000;
  const collectorSession = { collectorSessionId: COLLECTOR_SESSION, accountId: ACCOUNT_A };
  const claimed = await enrichmentRuntime.service.claimNext({ session: collectorSession });
  assert.equal(claimed.sku, SOURCE_SKU);
  const completed = await enrichmentRuntime.service.completeClaim({
    session: collectorSession,
    jobId: claimed.id,
    claimFence: claimed.claimFence,
    variantData: {
      description_category_id: SOURCE_DESCRIPTION_CATEGORY_ID,
      type_id: TYPE_ID,
      weight: 500,
      depth: 300,
      width: 200,
      height: 100,
      attributes: [{ key: "8229", value: "杯子", dictionary_value_id: TYPE_ID }],
      categories: [
        { level: 2, title: "旧杯子" },
        { level: 1, title: "旧家居" },
      ],
    },
  });
  assert.equal(completed.status, "COMPLETE");
  assert.equal(state.caches.collectBox[0].status, "COMPLETE");
  assert.equal(state.caches.collectBox[0].enrichment.status, "COMPLETE");
  assert.deepEqual({
    descriptionCategoryId:
      state.caches.collectBox[0].listingDraft.sourceCategory.descriptionCategoryId,
    typeIdCandidate: state.caches.collectBox[0].listingDraft.sourceCategory.typeIdCandidate,
    path: state.caches.collectBox[0].listingDraft.sourceCategory.path,
  }, {
    descriptionCategoryId: SOURCE_DESCRIPTION_CATEGORY_ID,
    typeIdCandidate: TYPE_ID,
    path: ["旧家居", "旧杯子"],
  });

  await Promise.all([
    categoryRuntime.onEnrichmentComplete({ accountId: ACCOUNT_A, collectItemId }),
    categoryRuntime.onEnrichmentComplete({ accountId: ACCOUNT_A, collectItemId }),
  ]);
  assert.equal(state.collectCategoryResolutions.length, 1);
  assert.equal(state.collectorOzonEnrichmentJobs.length, 1);
  assert.equal(state.collectorOzonEnrichmentJobs[0].status, "SUCCESS");

  const firstDrain = await categoryRuntime.resolveDue({ accountId: ACCOUNT_A });
  assert.equal(firstDrain.errors.length, 0);
  assert.equal(state.caches.collectBox[0].status, "COMPLETE", "a category 429 cannot reverse collection success");
  const deferred = await categoryRuntime.readForItem({ accountId: ACCOUNT_A, collectItemId });
  assert.equal(deferred.status, "RETRYABLE_ERROR");
  assert.equal(deferred.failureCode, "OZON_RATE_LIMITED");
  assert.equal(new Date(deferred.nextAttemptAt).getTime() - nowMs, 30_000);

  nowMs = new Date(deferred.nextAttemptAt).getTime();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await categoryRuntime.resolveDue({ accountId: ACCOUNT_A });
    if ((await categoryRuntime.readForItem({ accountId: ACCOUNT_A, collectItemId }))?.status === "MATCHED") break;
  }
  const matchedA = await categoryRuntime.readForItem({ accountId: ACCOUNT_A, collectItemId });
  assert.deepEqual({
    status: matchedA.status,
    sourceTypeId: matchedA.sourceTypeId,
    targetDescriptionCategoryId: matchedA.targetDescriptionCategoryId,
    targetTypeId: matchedA.targetTypeId,
    method: matchedA.method,
    credentialStoreId: matchedA.credentialStoreId,
  }, {
    status: "MATCHED",
    sourceTypeId: TYPE_ID,
    targetDescriptionCategoryId: TARGET_DESCRIPTION_CATEGORY_ID,
    targetTypeId: TYPE_ID,
    method: "TYPE_ID_EXACT",
    credentialStoreId: STORE_A,
  });
  const snapshotCallsAfterMatch = categorySnapshotCalls;

  currentStoreId = STORE_B;
  await categoryRuntime.resolveDue({ accountId: ACCOUNT_A });
  const reusedB = await categoryRuntime.readForItem({ accountId: ACCOUNT_A, collectItemId });
  assert.equal(reusedB.status, "MATCHED");
  assert.equal(reusedB.credentialStoreId, STORE_B);
  assert.equal(categorySnapshotCalls, snapshotCallsAfterMatch, "same-fingerprint store reuse must not rematch");
  assert.deepEqual(validationCalls.at(-1), {
    storeId: STORE_B,
    target: { descriptionCategoryId: TARGET_DESCRIPTION_CATEGORY_ID, typeId: TYPE_ID },
  });

  nowMs += 60_000;
  currentFingerprint = "taxonomy-e2e-v2";
  state.stores.find((store) => store.id === STORE_B).updatedAt = new Date(nowMs).toISOString();
  await categoryRuntime.resolveDue({ accountId: ACCOUNT_A });
  const invalidated = await categoryRuntime.readForItem({ accountId: ACCOUNT_A, collectItemId });
  assert.equal(invalidated.status, "QUEUED");
  assert.equal(invalidated.failureCode, null);
  assert.equal(
    state.auditEvents.some((event) => event.action === "COLLECT_CATEGORY_RESOLUTION_INVALIDATED"),
    true,
  );
  await categoryRuntime.resolveDue({ accountId: ACCOUNT_A });
  const rematched = await categoryRuntime.readForItem({ accountId: ACCOUNT_A, collectItemId });
  assert.equal(rematched.status, "MATCHED");
  assert.equal(rematched.taxonomyFingerprint, "taxonomy-e2e-v2");
  assert.equal(rematched.targetDescriptionCategoryId, TARGET_DESCRIPTION_CATEGORY_ID);
  assert.equal(rematched.targetTypeId, TYPE_ID);
  assert.equal(categorySnapshotCalls, snapshotCallsAfterMatch + 1);

  stateLoads = 0;
  const batchRead = await categoryRuntime.readForItems({
    accountId: ACCOUNT_A,
    collectItemIds: [collectItemId, collectItemId, "missing-a", "missing-b"],
  });
  assert.equal(batchRead.length, 1);
  assert.equal(stateLoads, 1, "list summary reads must use one Runtime/Repository state load, not N+1");
  assert.equal(
    await categoryRuntime.readForItem({ accountId: ACCOUNT_B, collectItemId }),
    null,
  );
  assert.deepEqual(
    await categoryRuntime.readForItems({ accountId: ACCOUNT_B, collectItemIds: [collectItemId] }),
    [],
  );

  const allowedCategoryAuditMetadata = new Set([
    "collectItemId",
    "taxonomyScope",
    "sourceTypeId",
    "targetDescriptionCategoryId",
    "targetTypeId",
    "taxonomyFingerprint",
    "attempt",
    "failureCode",
  ]);
  for (const event of state.auditEvents.filter((candidate) => candidate.source === "collect-category-resolution")) {
    assert.equal(event.accountId, ACCOUNT_A);
    assert.equal(
      Object.keys(event.metadata).every((key) => allowedCategoryAuditMetadata.has(key)),
      true,
      JSON.stringify(event.metadata),
    );
  }
  for (const [, context = {}] of operationalLogs) {
    assert.equal(
      Object.keys(context).every((key) => ["accountId", "collectItemId", "taxonomyScope", "code"].includes(key)),
      true,
      JSON.stringify(context),
    );
  }
  const persistedObservability = JSON.stringify({ auditEvents: state.auditEvents, operationalLogs });
  assert.equal(persistedObservability.includes(RAW_FAILURE_MARKER), false);
  assert.equal(persistedObservability.includes(PRIVATE_STORE_MARKER), false);

  const dataDir = await mkdtemp(path.join(os.tmpdir(), "sonli-category-e2e-read-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  await writeFile(path.join(dataDir, "local-state.json"), JSON.stringify(state), "utf8");
  const priorEnvironment = {
    dataDir: process.env.QH_LOCAL_DATA_DIR,
    noListen: process.env.QH_LOCAL_NO_LISTEN,
    noDotenv: process.env.QH_LOCAL_NO_DOTENV,
    listing: process.env.LISTING_PIPELINE_V3,
  };
  process.env.QH_LOCAL_DATA_DIR = dataDir;
  process.env.QH_LOCAL_NO_LISTEN = "1";
  process.env.QH_LOCAL_NO_DOTENV = "1";
  process.env.LISTING_PIPELINE_V3 = "0";
  t.after(() => {
    if (priorEnvironment.dataDir === undefined) delete process.env.QH_LOCAL_DATA_DIR;
    else process.env.QH_LOCAL_DATA_DIR = priorEnvironment.dataDir;
    if (priorEnvironment.noListen === undefined) delete process.env.QH_LOCAL_NO_LISTEN;
    else process.env.QH_LOCAL_NO_LISTEN = priorEnvironment.noListen;
    if (priorEnvironment.noDotenv === undefined) delete process.env.QH_LOCAL_NO_DOTENV;
    else process.env.QH_LOCAL_NO_DOTENV = priorEnvironment.noDotenv;
    if (priorEnvironment.listing === undefined) delete process.env.LISTING_PIPELINE_V3;
    else process.env.LISTING_PIPELINE_V3 = priorEnvironment.listing;
  });

  const { handle } = await import(`../index.mjs?category-e2e=${Date.now()}`);
  const listRead = await requestJson(handle, "/ozon/collect-box", "token_e2e_a");
  const editStateRead = await requestJson(handle, "/local/state", "token_e2e_a");
  const foreignRead = await requestJson(handle, "/ozon/collect-box", "token_e2e_b");
  assert.equal(listRead.status, 200);
  assert.equal(editStateRead.status, 200);
  assert.equal(foreignRead.status, 200);
  assert.equal(listRead.body.data.length, 1);
  assert.equal(editStateRead.body.caches.collectBox.length, 1);
  assert.equal(foreignRead.body.data.length, 0);
  assert.deepEqual(
    publicCategoryOutcome(listRead.body.data[0]),
    publicCategoryOutcome(editStateRead.body.caches.collectBox[0]),
  );
  assert.deepEqual(publicCategoryOutcome(listRead.body.data[0]), {
    sourceCategory: {
      descriptionCategoryId: SOURCE_DESCRIPTION_CATEGORY_ID,
      typeIdCandidate: TYPE_ID,
    },
    status: "MATCHED",
    taxonomyScope: TAXONOMY_SCOPE,
    targetDescriptionCategoryId: TARGET_DESCRIPTION_CATEGORY_ID,
    targetTypeId: TYPE_ID,
    method: "TYPE_ID_EXACT",
    message: "类目已匹配",
  });
  assert.equal(JSON.stringify(listRead.body).includes(PRIVATE_STORE_MARKER), false);
  assert.equal(stateSaves > 0, true);
});

test("the automatic category E2E remains an explicitly protected active verification gate", async () => {
  const manifest = await import("../../scripts/test-manifest.mjs");
  const file = "server/tests/collect-category-auto-resolution.integration.mjs";
  assert.equal(manifest.requiredActiveTestFiles?.includes(file), true);
  assert.equal(manifest.activeTestFiles.includes(file), true);
});
