import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { Readable } from "node:stream";
import { isolateCollectCategoryE2EEnvironment } from "./collect-category-e2e-environment.mjs";

const ACCOUNT_ID = "account-seam";
const WEB_TOKEN = "token_seam";
const COLLECTOR_TOKEN = "cst_category_seam_collector_token_0001";
const COLLECTOR_SESSION_ID = "collector-seam";
const STORE_A = "store-seam-a";
const STORE_B = "store-seam-b";
const FIXED_AT = "2026-08-03T00:00:00.000Z";
const PRIVATE_STORE_MARKER = "fixture-seam-private-store-material";

const dataDir = process.env.E2E_TEMP_DATA_DIR;
isolateCollectCategoryE2EEnvironment({ dataDir });
const dataFile = path.join(dataDir, "local-state.json");
const mode = String(process.argv[2] || "");
const [index, persistence, auth] = await Promise.all([
  import("../../index.mjs"),
  import("../../persistence.mjs"),
  import("../../collector-auth-service.mjs"),
]);

function seedState() {
  return {
    accounts: [{ id: ACCOUNT_ID, username: "seam", role: "admin", status: "active" }],
    sessions: { [WEB_TOKEN]: { token: WEB_TOKEN, accountId: ACCOUNT_ID, issuedAt: FIXED_AT } },
    currentStoreIdsByAccount: { [ACCOUNT_ID]: STORE_A },
    stores: [
      {
        id: STORE_A,
        ownerAccountId: ACCOUNT_ID,
        status: "ACTIVE",
        clientId: "fixture-client-a",
        apiKey: `${PRIVATE_STORE_MARKER}-a`,
        updatedAt: FIXED_AT,
      },
      {
        id: STORE_B,
        ownerAccountId: ACCOUNT_ID,
        status: "ACTIVE",
        clientId: "fixture-client-b",
        apiKey: `${PRIVATE_STORE_MARKER}-b`,
        updatedAt: FIXED_AT,
      },
    ],
    caches: { collectBox: [] },
    collectRequests: [],
    collectCategoryResolutions: [],
    collectCategoryResolutionRuntimeCursors: {},
    collectorOzonEnrichmentJobs: [],
    collectorOzonEnrichmentCache: [],
    collectorSessions: [{
      id: COLLECTOR_SESSION_ID,
      tokenHash: auth.hashCollectorSecret(COLLECTOR_TOKEN),
      accountId: ACCOUNT_ID,
      parentSessionToken: WEB_TOKEN,
      deviceFingerprint: "seam-device",
      extensionVersion: "seam",
      permissions: ["collector.upload", "collector.job.read"],
      expiresAt: "9999-12-31T23:59:59.999Z",
      revokedAt: null,
      createdAt: FIXED_AT,
    }],
    hashes: {},
    leases: {},
    browserAgents: {},
    jobs: {},
    reports: [],
    auditEvents: [],
    updatedAt: FIXED_AT,
  };
}

function compositionWithWakeSink(wakeCalls) {
  const collectCategoryResolutionRuntime = {
    async readForItems() { return []; },
    async onOperatingStoreAvailable(input) {
      wakeCalls.push(structuredClone(input));
      return [];
    },
  };
  return {
    collectCategoryResolutionRuntime,
    collectorOzonEnrichmentRuntime: { async handleHttpRoute() { return false; } },
    async handleJsonAccountScopedCollectionRoute() { return false; },
  };
}

async function startServer(handle) {
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
  const address = server.address();
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => (
      server.close((error) => (error ? reject(error) : resolve()))
    )),
  };
}

async function requestJson(origin, method, pathname, { token = "", body } = {}) {
  const response = await fetch(`${origin}${pathname}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const responseText = await response.text();
  return { status: response.status, body: responseText ? JSON.parse(responseText) : null };
}

async function runStoreWake() {
  await persistence.savePersistedState({ dataDir, dataFile, state: seedState() });
  const nativeFetch = globalThis.fetch;
  let controlledProfileCalls = 0;
  globalThis.fetch = async (input, init) => {
    const target = String(input?.url || input || "");
    if (target.includes("api-seller.ozon.ru")) {
      controlledProfileCalls += 1;
      return new Response(JSON.stringify({ result: { company: { name: "Controlled fixture" } } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return nativeFetch(input, init);
  };
  const firstWakeCalls = [];
  const secondWakeCalls = [];
  const firstServer = await startServer(index.createHttpHandler({
    composition: compositionWithWakeSink(firstWakeCalls),
  }));
  const secondServer = await startServer(index.createHttpHandler({
    composition: compositionWithWakeSink(secondWakeCalls),
  }));
  try {
    const first = await requestJson(firstServer.origin, "POST", "/local/current-store", {
      token: WEB_TOKEN,
      body: { storeId: STORE_B },
    });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.deepEqual(firstWakeCalls, [{ accountId: ACCOUNT_ID, storeId: STORE_B }]);
    assert.deepEqual(secondWakeCalls, []);

    const second = await requestJson(secondServer.origin, "POST", "/local/current-store", {
      token: WEB_TOKEN,
      body: { storeId: STORE_A },
    });
    assert.equal(second.status, 200, JSON.stringify(second.body));
    assert.deepEqual(firstWakeCalls, [{ accountId: ACCOUNT_ID, storeId: STORE_B }]);
    assert.deepEqual(secondWakeCalls, [{ accountId: ACCOUNT_ID, storeId: STORE_A }]);
    return {
      firstWakeCount: firstWakeCalls.length,
      secondWakeCount: secondWakeCalls.length,
      controlledProfileCalls,
    };
  } finally {
    globalThis.fetch = nativeFetch;
    await Promise.all([firstServer.close(), secondServer.close()]);
  }
}

function responseRecorder() {
  return {
    status: 0,
    body: null,
    writeHead(status) { this.status = status; },
    end(body = "") { this.body = body ? JSON.parse(String(body)) : null; },
  };
}

async function runFastCollect() {
  assert.equal(typeof index.handleFastCollectionRoute, "function");
  let snapshotCalls = 0;
  let scheduleCalls = 0;
  const categoryResolutionPort = {
    async captureCredentialStoreSnapshot({ accountId }) {
      snapshotCalls += 1;
      assert.equal(accountId, ACCOUNT_ID);
      return Object.freeze({ accountId, storeId: STORE_A });
    },
    async scheduleForCollect({ accountId, collectItemId }) {
      scheduleCalls += 1;
      assert.equal(accountId, ACCOUNT_ID);
      assert.equal(collectItemId, "collect-seam");
    },
  };
  const body = {
    source: "ozon",
    sourceSku: "4862904234",
    requestId: "request-seam-fast",
    capturedAt: FIXED_AT,
    payload: {
      sku: "4862904234",
      name: "Seam fixture",
      description_category_id: 17_033_604,
      type_id: 94_405,
    },
  };
  const req = Readable.from([JSON.stringify(body)]);
  req.method = "POST";
  req.url = "/sources/ozon/collect";
  req.headers = { "content-type": "application/json" };
  const res = responseRecorder();
  await index.handleFastCollectionRoute(
    req,
    res,
    new URL("http://local.test/sources/ozon/collect"),
    {
      categoryResolutionPort,
      pipelineEnabled: () => true,
      authenticateRequest: async () => ({ id: ACCOUNT_ID }),
      captureStoreSnapshot: async (input) => {
        assert.equal(input.categoryResolutionPort, categoryResolutionPort);
        return input.categoryResolutionPort.captureCredentialStoreSnapshot(input);
      },
      ingestCollectRequest: async (input) => {
        assert.equal(input.categoryResolutionPort, categoryResolutionPort);
        await input.categoryResolutionPort.scheduleForCollect({
          accountId: ACCOUNT_ID,
          collectItemId: "collect-seam",
        });
        return {
          item: { id: "collect-seam", sku: body.sourceSku, source: "ozon" },
          collectItemId: "collect-seam",
          requestId: body.requestId,
          duplicate: false,
          action: "created",
        };
      },
    },
  );
  assert.equal(res.status, 200);
  assert.equal(res.body.data.id, "collect-seam");
  return { status: res.status, snapshotCalls, scheduleCalls };
}

async function runFastManual() {
  let draftUpdates = 0;
  let canonicalSaves = 0;
  let sharedExecutor = false;
  const transactionClient = { kind: "controlled-transaction-client" };
  const categoryResolutionPort = {
    async saveManualFromDraft(input) {
      canonicalSaves += 1;
      sharedExecutor = input.postgresExecutor === transactionClient;
      assert.equal(input.accountId, ACCOUNT_ID);
      assert.equal(input.collectItemId, "collect-manual-seam");
      assert.equal(input.categoryResolution.method, "MANUAL");
    },
  };
  const manualResolution = {
    status: "MATCHED",
    method: "MANUAL",
    target: {
      storeId: STORE_A,
      descriptionCategoryId: 17_028_702,
      typeId: 94_405,
    },
  };
  const req = Readable.from([JSON.stringify({ listingDraft: { categoryResolution: manualResolution } })]);
  req.method = "PATCH";
  req.url = "/ozon/collect-box/collect-manual-seam";
  req.headers = { "content-type": "application/json" };
  const res = responseRecorder();
  await index.handleFastCollectionRoute(
    req,
    res,
    new URL("http://local.test/ozon/collect-box/collect-manual-seam"),
    {
      categoryResolutionPort,
      pipelineEnabled: () => true,
      authenticateMutationRequest: async () => ({ id: ACCOUNT_ID }),
      updateCollectItemDraft: async ({ beforeCommit }) => {
        draftUpdates += 1;
        const item = {
          id: "collect-manual-seam",
          accountId: ACCOUNT_ID,
          listingDraft: { categoryResolution: manualResolution },
        };
        await beforeCommit({ client: transactionClient, item });
        return item;
      },
    },
  );
  return { status: res.status, draftUpdates, canonicalSaves, sharedExecutor };
}

async function runCredentialInvalidate() {
  await persistence.savePersistedState({ dataDir, dataFile, state: seedState() });
  const events = [];
  const composition = compositionWithWakeSink([]);
  composition.categoryService = {
    invalidateStore({ accountId, storeId }) {
      events.push(`invalidate:${accountId}:${storeId}`);
    },
  };
  composition.collectCategoryResolutionRuntime.onOperatingStoreAvailable = async ({ accountId, storeId }) => {
    events.push(`wake:${accountId}:${storeId}`);
    return [];
  };
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const target = String(input?.url || input || "");
    if (target.includes("api-seller.ozon.ru")) {
      return new Response(JSON.stringify({ result: { company: { name: "Controlled fixture" } } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return nativeFetch(input, init);
  };
  const server = await startServer(index.createHttpHandler({ composition }));
  try {
    const response = await requestJson(server.origin, "PATCH", `/local/stores/${STORE_A}`, {
      token: WEB_TOKEN,
      body: { apiKey: "rotated-controlled-key" },
    });
    return { status: response.status, events };
  } finally {
    globalThis.fetch = nativeFetch;
    await server.close();
  }
}

async function runOverrideValidation() {
  const invalidOverrideCases = [
    { now: null },
    { now: undefined },
    { now: "2026-08-03T00:00:00.000Z" },
    { randomUUID: null },
    { sleep: false },
    { timers: null },
  ];
  let invalidOverrides = 0;
  for (const overrides of invalidOverrideCases) {
    assert.throws(
      () => index.createServerCollectCategoryAutoResolutionComposition(overrides),
      /override|timers/i,
    );
    invalidOverrides += 1;
  }
  const composition = index.createServerCollectCategoryAutoResolutionComposition();
  composition.collectCategoryResolutionRuntime.stop();
  await persistence.savePersistedState({ dataDir, dataFile, state: seedState() });
  const defaultServer = await startServer(index.createHttpHandler());
  try {
    const health = await requestJson(defaultServer.origin, "GET", "/health");
    return {
      invalidOverrides,
      defaultHandler: health.status === 200 && health.body.persistence === "json",
    };
  } finally {
    await defaultServer.close();
  }
}

let result;
if (mode === "store-wake") result = await runStoreWake();
else if (mode === "fast-collect") result = await runFastCollect();
else if (mode === "fast-manual") result = await runFastManual();
else if (mode === "credential-invalidate") result = await runCredentialInvalidate();
else if (mode === "override-validation") result = await runOverrideValidation();
else throw new Error(`unknown seam worker mode: ${mode}`);

process.stdout.write(JSON.stringify(result));
