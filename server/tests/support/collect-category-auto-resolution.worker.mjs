import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { isolateCollectCategoryE2EEnvironment } from "./collect-category-e2e-environment.mjs";
import { assertNoSensitiveMarkersDeep } from "./safe-observability-scanner.mjs";

const ACCOUNT_A = "account-e2e-a";
const ACCOUNT_B = "account-e2e-b";
const STORE_A = "store-e2e-a";
const STORE_B = "store-e2e-b";
const FOREIGN_STORE = "store-e2e-foreign";
const WEB_TOKEN_A = "token_e2e_a";
const WEB_TOKEN_B = "token_e2e_b";
const COLLECTOR_TOKEN = "cst_category_e2e_collector_token_0001";
const COLLECTOR_SESSION = "collector-e2e-a";
const SOURCE_DESCRIPTION_CATEGORY_ID = 17_033_604;
const TARGET_DESCRIPTION_CATEGORY_ID = 17_028_702;
const TYPE_ID = 94_405;
const TAXONOMY_SCOPE = "OZON:DEFAULT";
const STARTED_AT_MS = Date.parse("2026-08-03T00:00:00.000Z");
const RAW_FAILURE_MARKER = "raw-upstream-marker-must-not-persist";
const PRIVATE_STORE_MARKER = "fixture-private-store-material";

function categoryTree({ changed = false } = {}) {
  return [{
    description_category_id: TARGET_DESCRIPTION_CATEGORY_ID,
    category_name: "家居",
    children: [
      { type_id: TYPE_ID, type_name: "杯子", children: [] },
      ...(changed ? [{ type_id: 99_999, type_name: "结构变更节点", children: [] }] : []),
    ],
  }];
}

function seedState({ hashCollectorSecret }) {
  const startedAt = new Date(STARTED_AT_MS).toISOString();
  return {
    accounts: [
      { id: ACCOUNT_A, username: "e2e-a", role: "admin", status: "active" },
      { id: ACCOUNT_B, username: "e2e-b", role: "admin", status: "active" },
    ],
    sessions: {
      [WEB_TOKEN_A]: { token: WEB_TOKEN_A, accountId: ACCOUNT_A, issuedAt: startedAt },
      [WEB_TOKEN_B]: { token: WEB_TOKEN_B, accountId: ACCOUNT_B, issuedAt: startedAt },
    },
    currentStoreIdsByAccount: { [ACCOUNT_A]: STORE_A, [ACCOUNT_B]: FOREIGN_STORE },
    stores: [
      {
        id: STORE_A,
        ownerAccountId: ACCOUNT_A,
        status: "ACTIVE",
        clientId: "fixture-client-a",
        apiKey: `${PRIVATE_STORE_MARKER}-a`,
        updatedAt: new Date(STARTED_AT_MS - 60_000).toISOString(),
      },
      {
        id: STORE_B,
        ownerAccountId: ACCOUNT_A,
        status: "ACTIVE",
        clientId: "fixture-client-b",
        apiKey: `${PRIVATE_STORE_MARKER}-b`,
        updatedAt: new Date(STARTED_AT_MS - 60_000).toISOString(),
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
      tokenHash: hashCollectorSecret(COLLECTOR_TOKEN),
      accountId: ACCOUNT_A,
      parentSessionToken: WEB_TOKEN_A,
      deviceFingerprint: "category-e2e-device",
      extensionVersion: "category-e2e",
      permissions: [
        "collector.upload",
        "collector.job.read",
        "collector.config.read",
        "collector.ozon.read",
      ],
      expiresAt: "9999-12-31T23:59:59.999Z",
      revokedAt: null,
      createdAt: startedAt,
    }],
    hashes: {},
    leases: {},
    browserAgents: {},
    jobs: {},
    reports: [],
    auditEvents: [],
    updatedAt: startedAt,
  };
}

async function requestJson(origin, method, pathname, { token = "", collector = false, body } = {}) {
  const response = await fetch(`${origin}${pathname}`, {
    method,
    headers: {
      ...(token ? { authorization: `${collector ? "Collector" : "Bearer"} ${token}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
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

function assertPublicLogistics(item) {
  assert.deepEqual({
    weightG: item?.listingDraft?.logistics?.weightG,
    lengthMm: item?.listingDraft?.logistics?.lengthMm,
    widthMm: item?.listingDraft?.logistics?.widthMm,
    heightMm: item?.listingDraft?.logistics?.heightMm,
  }, {
    weightG: 500,
    lengthMm: 300,
    widthMm: 200,
    heightMm: 100,
  });
}

function createControlledTimers() {
  let nextId = 0;
  const pending = [];
  const timers = {
    setTimeout(callback) {
      const timer = {
        id: ++nextId,
        callback,
        cancelled: false,
        unref() {},
      };
      pending.push(timer);
      return timer;
    },
    clearTimeout(timer) {
      if (timer) timer.cancelled = true;
    },
    setInterval(callback) {
      return { id: ++nextId, callback, cancelled: false, unref() {} };
    },
    clearInterval(timer) {
      if (timer) timer.cancelled = true;
    },
  };
  return {
    timers,
    async drainTimeouts() {
      while (pending.length) {
        const timer = pending.shift();
        if (!timer.cancelled) await timer.callback();
      }
    },
  };
}

async function main() {
  const dataDir = process.env.E2E_TEMP_DATA_DIR;
  isolateCollectCategoryE2EEnvironment({ dataDir });
  const dataFile = path.join(dataDir, "local-state.json");
  const [
    { hashCollectorSecret },
    { loadPersistedState, persistenceMode, savePersistedState },
    index,
  ] = await Promise.all([
    import("../../collector-auth-service.mjs"),
    import("../../persistence.mjs"),
    import("../../index.mjs"),
  ]);
  assert.equal(typeof index.createServerCollectCategoryAutoResolutionComposition, "function");
  assert.equal(typeof index.createHttpHandler, "function");
  assert.equal(persistenceMode(), "json");

  const seeded = seedState({ hashCollectorSecret });
  await savePersistedState({ dataDir, dataFile, state: seeded });
  const seedDisk = await readFile(dataFile, "utf8");
  let nowMs = STARTED_AT_MS;
  let currentFingerprint = "taxonomy-e2e-v1";
  let rateLimitPending = true;
  let categorySnapshotCalls = 0;
  let lease = 0;
  const validationCalls = [];
  const operationalLogs = [];
  const controlledTimers = createControlledTimers();
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
  async function currentCredentialStoreForAccount(accountId) {
    if (accountId === "account-log-synthetic") {
      throw Object.assign(new Error(RAW_FAILURE_MARKER), { code: "STORE_CONTEXT_UNAVAILABLE" });
    }
    const state = await loadPersistedState({ dataFile });
    return state?.currentStoreIdsByAccount?.[accountId] || "";
  }
  const composition = index.createServerCollectCategoryAutoResolutionComposition({
    categoryService,
    currentCredentialStoreForAccount,
    now: () => new Date(nowMs),
    randomUUID: () => `category-e2e-lease-${++lease}`,
    sleep: async () => {},
    logger: { error: (...values) => operationalLogs.push(values) },
    timers: controlledTimers.timers,
  });
  const readMetrics = { batch: 0, single: 0, singlePersistenceReads: 0 };
  const categoryResolutionReadPort = {
    async readForItems(input) {
      readMetrics.batch += 1;
      return composition.collectCategoryResolutionRuntime.readForItems(input);
    },
    async readForItem(input) {
      readMetrics.single += 1;
      readMetrics.singlePersistenceReads += 1;
      return composition.collectCategoryResolutionRuntime.readForItem(input);
    },
  };
  const handle = index.createHttpHandler({ composition, categoryResolutionReadPort });
  const server = http.createServer((req, res) => {
    handle(req, res).catch((error) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, code: String(error?.code || "UNHANDLED") }));
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const nativeFetch = globalThis.fetch;
  try {
    const address = server.address();
    const origin = `http://127.0.0.1:${address.port}`;
    let controlledProfileCalls = 0;
    globalThis.fetch = async (input, init) => {
      const target = String(input?.url || input || "");
      if (target.includes("api-seller.ozon.ru")) {
        controlledProfileCalls += 1;
        return new Response(JSON.stringify({ result: { company: { name: "Controlled E2E fixture" } } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (!target.startsWith(origin)) throw new Error("unexpected external E2E request");
      return nativeFetch(input, init);
    };
    const health = await requestJson(origin, "GET", "/health");
    assert.equal(health.status, 200);
    assert.equal(health.body.persistence, "json");

    const inputs = [
      { sku: "4862904234", requestId: "request-e2e-one" },
      { sku: "4862904235", requestId: "request-e2e-two" },
    ];
    const uploaded = [];
    for (const input of inputs) {
      const payload = {
        source: "ozon",
        sourceSku: input.sku,
        requestId: input.requestId,
        capturedAt: new Date(STARTED_AT_MS).toISOString(),
        payload: {
          sku: input.sku,
          name: `来源旧类目杯子 ${input.sku}`,
          description_category_id: SOURCE_DESCRIPTION_CATEGORY_ID,
          type_id: TYPE_ID,
        },
      };
      const [first, duplicate] = await Promise.all([
        requestJson(origin, "POST", "/sources/ozon/collect", {
          token: COLLECTOR_TOKEN, collector: true, body: payload,
        }),
        requestJson(origin, "POST", "/sources/ozon/collect", {
          token: COLLECTOR_TOKEN, collector: true, body: payload,
        }),
      ]);
      assert.deepEqual([first.status, duplicate.status], [200, 200]);
      assert.deepEqual([first.body.data.duplicate, duplicate.body.data.duplicate].sort(), [false, true]);
      uploaded.push(first.body.data.id);
    }
    let persisted = await loadPersistedState({ dataFile });
    assert.equal(persisted.caches.collectBox.length, 2);
    assert.equal(persisted.collectRequests.length, 2);
    assert.equal(persisted.collectorOzonEnrichmentJobs.length, 2);
    assert.equal(persisted.collectCategoryResolutions.length, 2);
    assert.deepEqual(
      persisted.collectorOzonEnrichmentJobs.map((job) => job.status).sort(),
      ["PENDING", "PENDING"],
    );

    const completionBodies = new Map();
    for (let indexOfJob = 0; indexOfJob < 2; indexOfJob += 1) {
      const captureContext = {
        sellerCompanyId: "1234567890",
        revision: 1,
        observedAt: new Date(nowMs).toISOString(),
      };
      const claimed = await requestJson(origin, "POST", "/collector/ozon/enrichment-jobs/next", {
        token: COLLECTOR_TOKEN,
        collector: true,
        body: { captureContext },
      });
      assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
      assert.ok(claimed.body.job?.id, JSON.stringify(claimed.body));
      const completionBody = {
        variantData: {
          description_category_id: SOURCE_DESCRIPTION_CATEGORY_ID,
          type_id: TYPE_ID,
          weight: 500,
          depth: 300,
          width: 200,
          height: 100,
          attributes: [{ key: "8229", value: "杯子", dictionary_value_id: TYPE_ID }],
        },
        captureContext,
        claimFence: claimed.body.job.claimFence,
      };
      const completed = await requestJson(
        origin,
        "POST",
        `/collector/ozon/enrichment-jobs/${encodeURIComponent(claimed.body.job.id)}/result`,
        { token: COLLECTOR_TOKEN, collector: true, body: completionBody },
      );
      assert.equal(completed.status, 200, JSON.stringify(completed.body));
      completionBodies.set(claimed.body.job.id, completionBody);

      persisted = await loadPersistedState({ dataFile });
      const collectItem = persisted.caches.collectBox.find((item) => item.sku === claimed.body.job.sku);
      const resolution = persisted.collectCategoryResolutions.find((record) => (
        record.accountId === ACCOUNT_A && record.collectItemId === collectItem.id
      ));
      assert.equal(collectItem.status, "COMPLETE");
      assert.equal(collectItem.enrichment.status, "COMPLETE");
      assertPublicLogistics(collectItem);
      assert.equal(resolution.status, "QUEUED", "the real completion hook must schedule immediately");

      if (indexOfJob === 0) {
        const replay = await requestJson(
          origin,
          "POST",
          `/collector/ozon/enrichment-jobs/${encodeURIComponent(claimed.body.job.id)}/result`,
          { token: COLLECTOR_TOKEN, collector: true, body: completionBody },
        );
        assert.equal(replay.status, 409);
        assert.equal(replay.body.code, "OZON_ENRICHMENT_JOB_OWNERSHIP");
        const replayState = await loadPersistedState({ dataFile });
        assert.equal(replayState.collectorOzonEnrichmentJobs.length, 2);
        assert.equal(replayState.collectCategoryResolutions.length, 2);
        assert.equal(replayState.caches.collectBox.length, 2);
      }
    }

    const firstDrain = await composition.collectCategoryResolutionRuntime.resolveDue({ accountId: ACCOUNT_A });
    assert.equal(firstDrain.errors.length, 0);
    persisted = await loadPersistedState({ dataFile });
    assert.equal(persisted.caches.collectBox.every((item) => item.status === "COMPLETE"), true);
    const deferred = persisted.collectCategoryResolutions.find((record) => record.status === "RETRYABLE_ERROR");
    assert.equal(deferred.failureCode, "OZON_RATE_LIMITED");
    assert.equal(new Date(deferred.nextAttemptAt).getTime() - nowMs, 30_000);
    nowMs += 30_000;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await composition.collectCategoryResolutionRuntime.resolveDue({ accountId: ACCOUNT_A });
      persisted = await loadPersistedState({ dataFile });
      if (persisted.collectCategoryResolutions.every((record) => record.status === "MATCHED")) break;
    }
    assert.equal(persisted.collectCategoryResolutions.every((record) => record.status === "MATCHED"), true);
    assert.equal(persisted.collectCategoryResolutions.every((record) => (
      record.targetDescriptionCategoryId === TARGET_DESCRIPTION_CATEGORY_ID
      && record.targetTypeId === TYPE_ID
      && record.method === "TYPE_ID_EXACT"
    )), true);
    const snapshotCallsAfterMatch = categorySnapshotCalls;

    const validationsBeforeStoreSwitch = validationCalls.length;
    const profileCallsBeforeStoreSwitch = controlledProfileCalls;
    const [firstStoreSwitch, duplicateStoreWake] = await Promise.all([
      requestJson(origin, "POST", "/local/current-store", {
        token: WEB_TOKEN_A,
        body: { storeId: STORE_B },
      }),
      requestJson(origin, "POST", "/local/current-store", {
        token: WEB_TOKEN_A,
        body: { storeId: STORE_B },
      }),
    ]);
    assert.equal(firstStoreSwitch.status, 200, JSON.stringify(firstStoreSwitch.body));
    assert.equal(duplicateStoreWake.status, 200, JSON.stringify(duplicateStoreWake.body));
    await controlledTimers.drainTimeouts();
    persisted = await loadPersistedState({ dataFile });
    assert.equal(persisted.currentStoreIdsByAccount[ACCOUNT_A], STORE_B);
    assert.equal(persisted.collectCategoryResolutions.every((record) => record.credentialStoreId === STORE_B), true);
    assert.equal(categorySnapshotCalls - snapshotCallsAfterMatch, 0);
    assert.equal(validationCalls.length - validationsBeforeStoreSwitch, 2);
    assert.equal(controlledProfileCalls - profileCallsBeforeStoreSwitch, 2);
    assert.deepEqual(
      validationCalls.slice(validationsBeforeStoreSwitch).map((call) => call.storeId),
      [STORE_B, STORE_B],
    );

    nowMs += 60_000;
    currentFingerprint = "taxonomy-e2e-v2";
    const credentialRefresh = await requestJson(
      origin,
      "PATCH",
      `/local/stores/${encodeURIComponent(STORE_B)}`,
      { token: WEB_TOKEN_A, body: { apiKey: `${PRIVATE_STORE_MARKER}-b-v2` } },
    );
    assert.equal(credentialRefresh.status, 200, JSON.stringify(credentialRefresh.body));
    await controlledTimers.drainTimeouts();
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await composition.collectCategoryResolutionRuntime.resolveDue({ accountId: ACCOUNT_A });
      persisted = await loadPersistedState({ dataFile });
      if (persisted.collectCategoryResolutions.every((record) => (
        record.status === "MATCHED" && record.taxonomyFingerprint === "taxonomy-e2e-v2"
      ))) break;
    }
    persisted = await loadPersistedState({ dataFile });
    assert.equal(persisted.collectCategoryResolutions.every((record) => (
      record.status === "MATCHED" && record.taxonomyFingerprint === "taxonomy-e2e-v2"
    )), true);
    assert.equal(categorySnapshotCalls, snapshotCallsAfterMatch + 2);

    readMetrics.batch = 0;
    readMetrics.single = 0;
    readMetrics.singlePersistenceReads = 0;
    const listRead = await requestJson(origin, "GET", "/ozon/collect-box", { token: WEB_TOKEN_A });
    assert.equal(listRead.status, 200);
    assert.equal(listRead.body.data.length, 2);
    listRead.body.data.forEach(assertPublicLogistics);
    assert.deepEqual(readMetrics, { batch: 1, single: 0, singlePersistenceReads: 0 });
    const listReadMetrics = structuredClone(readMetrics);
    const listOutcomeById = new Map(listRead.body.data.map((item) => [item.id, publicCategoryOutcome(item)]));

    const editStateRead = await requestJson(origin, "GET", "/local/state", { token: WEB_TOKEN_A });
    const foreignRead = await requestJson(origin, "GET", "/ozon/collect-box", { token: WEB_TOKEN_B });
    const foreignStateRead = await requestJson(origin, "GET", "/local/state", { token: WEB_TOKEN_B });
    assert.equal(editStateRead.status, 200);
    assert.equal(foreignRead.status, 200);
    assert.equal(foreignStateRead.status, 200);
    assert.equal(editStateRead.body.caches.collectBox.length, 2);
    assert.equal(foreignRead.body.data.length, 0);
    assert.equal(foreignStateRead.body.caches.collectBox.length, 0);
    const foreignPublicState = JSON.stringify({
      list: foreignRead.body,
      localState: foreignStateRead.body,
    });
    for (const collectItemId of uploaded) assert.equal(foreignPublicState.includes(collectItemId), false);
    for (const resolution of persisted.collectCategoryResolutions) {
      assert.equal(foreignPublicState.includes(resolution.id), false);
    }
    assert.equal(foreignPublicState.includes(PRIVATE_STORE_MARKER), false);
    for (const item of editStateRead.body.caches.collectBox) {
      assertPublicLogistics(item);
      assert.deepEqual(publicCategoryOutcome(item), listOutcomeById.get(item.id));
      assert.deepEqual(item.sourceCategory, {
        descriptionCategoryId: SOURCE_DESCRIPTION_CATEGORY_ID,
        typeIdCandidate: TYPE_ID,
      });
      assert.equal(item.categoryResolution.status, "MATCHED");
      assert.equal(item.categoryResolution.targetDescriptionCategoryId, TARGET_DESCRIPTION_CATEGORY_ID);
      assert.equal(item.categoryResolution.targetTypeId, TYPE_ID);
    }

    await composition.collectCategoryResolutionRuntime.captureCredentialStoreSnapshot({
      accountId: "account-log-synthetic",
    });
    assert.equal(operationalLogs.length > 0, true);
    const allowedLogKeys = new Set(["accountId", "collectItemId", "taxonomyScope", "code"]);
    for (const [, context = {}] of operationalLogs) {
      assert.equal(Object.keys(context).every((key) => allowedLogKeys.has(key)), true);
    }
    assertNoSensitiveMarkersDeep(
      operationalLogs,
      [RAW_FAILURE_MARKER, PRIVATE_STORE_MARKER],
    );
    const allowedAuditKeys = new Set([
      "collectItemId",
      "taxonomyScope",
      "sourceTypeId",
      "targetDescriptionCategoryId",
      "targetTypeId",
      "taxonomyFingerprint",
      "attempt",
      "failureCode",
    ]);
    const categoryAudits = persisted.auditEvents.filter(
      (candidate) => candidate.source === "collect-category-resolution",
    );
    assert.ok(categoryAudits.length > 0, "category audit coverage must not be empty");
    const categoryAuditActions = new Set(categoryAudits.map((event) => event.action));
    for (const requiredAction of [
      "COLLECT_CATEGORY_RESOLUTION_RETRY_DEFERRED",
      "COLLECT_CATEGORY_RESOLUTION_MATCHED",
      "COLLECT_CATEGORY_RESOLUTION_VALIDATED",
      "COLLECT_CATEGORY_RESOLUTION_INVALIDATED",
    ]) {
      assert.equal(
        categoryAuditActions.has(requiredAction),
        true,
        `category audit must include ${requiredAction}`,
      );
    }
    for (const event of categoryAudits) {
      assert.equal(event.accountId, ACCOUNT_A);
      assert.equal(Object.keys(event.metadata).every((key) => allowedAuditKeys.has(key)), true);
      assertNoSensitiveMarkersDeep(
        event.metadata,
        [RAW_FAILURE_MARKER, PRIVATE_STORE_MARKER],
      );
    }
    const publicAndObservability = JSON.stringify({
      list: listRead.body,
      localState: editStateRead.body,
      auditEvents: persisted.auditEvents,
    });
    assert.equal(publicAndObservability.includes(RAW_FAILURE_MARKER), false);
    assert.equal(publicAndObservability.includes(PRIVATE_STORE_MARKER), false);

    const finalDisk = await readFile(dataFile, "utf8");
    assert.notEqual(finalDisk, seedDisk, "HTTP ingress and completion must durably change JSON state");
    assert.equal(finalDisk.includes(RAW_FAILURE_MARKER), false);
    assert.equal(finalDisk.includes(PRIVATE_STORE_MARKER), false);
    assert.equal(completionBodies.size, 2);
    return {
      persistence: persistenceMode(),
      items: listRead.body.data.length,
      batchReads: listReadMetrics.batch,
      singleReads: listReadMetrics.single,
      operationalLogs: operationalLogs.length,
    };
  } finally {
    globalThis.fetch = nativeFetch;
    composition.collectCategoryResolutionRuntime.stop();
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

const result = await main();
process.stdout.write(JSON.stringify(result));
