import assert from "node:assert/strict";
import test from "node:test";

import { createAutoListingRuntime } from "../auto-listing-runtime.mjs";

function enabledEnv(overrides = {}) {
  return {
    AUTO_LISTING_ENABLED: "true",
    AUTO_LISTING_AI_ENABLED: "1",
    AUTO_LISTING_AI_ALLOWED_SECRET_ENV_NAMES: "SUB2API_API_KEY",
    AUTO_LISTING_AI_ALLOWED_GATEWAY_BASE_URLS: "https://gateway.invalid/v1",
    AUTO_LISTING_CREDENTIAL_MASTER_KEY: Buffer.alloc(32, 7).toString("base64url"),
    AUTO_LISTING_CREDENTIAL_KEY_VERSION: "runtime-v1",
    SUB2API_API_KEY: "test-only-key",
    ...overrides,
  };
}

function bossHarness() {
  const calls = [];
  return {
    calls,
    boss: {
      async start() { calls.push("start"); },
      async createQueue() { calls.push("createQueue"); },
      async work() { calls.push("work"); return "worker-a"; },
      async stop() { calls.push("stop"); },
    },
  };
}

test("runtime keeps AI worker fully dormant when either feature flag is disabled", async () => {
  for (const env of [
    enabledEnv({ AUTO_LISTING_ENABLED: "0" }),
    enabledEnv({ AUTO_LISTING_AI_ENABLED: "false" }),
    {},
  ]) {
    let dependencyFactories = 0;
    let relayFactories = 0;
    let pools = 0;
    const runtime = createAutoListingRuntime({
      env,
      getPostgresPool: async () => { pools += 1; throw new Error("must not connect"); },
      createAiWorkerDependencies: async () => { dependencyFactories += 1; throw new Error("must not compose"); },
      createAiOutboxRelay: async () => { relayFactories += 1; throw new Error("must not compose relay"); },
    });

    assert.equal(await runtime.startAiWorker(), false);
    await runtime.stopAiWorker();
    assert.equal(dependencyFactories, 0);
    assert.equal(relayFactories, 0);
    assert.equal(pools, 0);
  }
});

test("auto listing fails closed before PostgreSQL when shared category authority is JSON", async () => {
  let pools = 0;
  const runtime = createAutoListingRuntime({
    env: enabledEnv({ AUTO_LISTING_AI_ENABLED: "0" }),
    persistenceMode: () => "json",
    getPostgresPool: async () => { pools += 1; throw new Error("must not connect"); },
  });
  await assert.rejects(runtime.getService(), { code: "AUTO_LISTING_CATEGORY_LEASE_UNAVAILABLE" });
  assert.equal(pools, 0);
});

test("production service composition fails closed when the exact category-strategy read port is absent or hostile", async () => {
  for (const [label, repository] of [
    ["absent", { async loadTargetWarehouse() { return null; } }],
    ["proxy", new Proxy({ async loadCategoryStrategyControl() {} }, {})],
    ["accessor", (() => {
      const value = {};
      Object.defineProperty(value, "loadCategoryStrategyControl", { enumerable: true, get() { throw new Error("must not read"); } });
      return value;
    })()],
  ]) {
    const runtime = createAutoListingRuntime({
      env: enabledEnv({ AUTO_LISTING_AI_ENABLED: "0" }),
      getPostgresPool: async () => ({ name: "pool-a" }),
      createRepository: () => repository,
      createListingBasePreparer: async () => async () => ({}),
      createCategoryFreshness: async () => async () => ({ status: "CURRENT" }),
    });
    await assert.rejects(runtime.getService(), {
      code: "AUTO_LISTING_CATEGORY_STRATEGY_RUNTIME_INITIALIZATION_FAILED",
      message: "自动上架类目策略运行时初始化失败",
    }, label);
  }
});

test("enabled runtime starts the queue consumer before startup replay and stops relay before draining the worker", async () => {
  const events = [];
  const runtime = createAutoListingRuntime({
    env: enabledEnv(),
    createAiWorkerDependencies: async () => ({ marker: "worker-dependencies" }),
    createAiWorker(config) {
      assert.equal(config.marker, "worker-dependencies");
      assert.equal(config.enabled, true);
      return {
        async start() { events.push("worker-start"); return true; },
        async stop() { events.push("worker-stop"); },
      };
    },
    createAiOutboxRelay: async () => ({
      async start() { events.push("relay-startup-replay"); return true; },
      async stop() { events.push("relay-stop"); },
    }),
  });

  assert.equal(await runtime.startAiWorker(), true);
  await runtime.stopAiWorker();
  assert.deepEqual(events, ["worker-start", "relay-startup-replay", "relay-stop", "worker-stop"]);
});

test("relay startup failure rolls back the already-started consumer and stays safely retryable", async () => {
  const events = [];
  const runtime = createAutoListingRuntime({
    env: enabledEnv(),
    createAiWorkerDependencies: async () => ({}),
    createAiWorker: () => ({
      async start() { events.push("worker-start"); return true; },
      async stop() { events.push("worker-stop"); },
    }),
    createAiOutboxRelay: async () => ({
      async start() { events.push("relay-start"); throw new Error("password=raw-production-secret"); },
      async stop() { events.push("relay-stop"); },
    }),
  });

  await assert.rejects(runtime.startAiWorker(), (error) => error?.code === "AUTO_LISTING_AI_RUNTIME_START_FAILED"
    && !/password|production|secret/iu.test(error.message));
  assert.deepEqual(events, ["worker-start", "relay-start", "relay-stop", "worker-stop"]);
});

test("enabled runtime lazily composes one dedicated worker and stops it gracefully without initializing the legacy service", async () => {
  const harness = bossHarness();
  let dependencyFactories = 0;
  let pools = 0;
  const runtime = createAutoListingRuntime({
    env: enabledEnv(),
    getPostgresPool: async () => { pools += 1; throw new Error("legacy service must remain lazy"); },
    createAiWorkerDependencies: async () => {
      dependencyFactories += 1;
      return {
        bossFactory: () => harness.boss,
        executionRepository: {
          async adopt() { throw new Error("no job in this test"); },
          async renew() { throw new Error("no job in this test"); },
          async requeueChannelFailure() { throw new Error("no job in this test"); },
        },
        loadContext: async () => { throw new Error("no job in this test"); },
        orchestrate: async () => { throw new Error("no job in this test"); },
        workflow: { async applyOutcome() { throw new Error("no job in this test"); } },
        logger: { log() {} },
        timers: { setTimeout, clearTimeout },
      };
    },
  });

  assert.equal(dependencyFactories, 0);
  assert.equal(await runtime.startAiWorker(), true);
  assert.equal(await runtime.startAiWorker(), true);
  assert.equal(dependencyFactories, 1);
  assert.equal(pools, 0);
  assert.deepEqual(harness.calls, ["start", "createQueue", "createQueue", "work", "work"]);
  await runtime.stopAiWorker();
  assert.deepEqual(harness.calls, ["start", "createQueue", "createQueue", "work", "work", "stop"]);
});

test("enabled runtime has a default production composition and missing configuration fails safely before database connection", async () => {
  let pools = 0;
  const runtime = createAutoListingRuntime({
    env: enabledEnv(),
    getPostgresPool: async () => { pools += 1; throw new Error("password=raw-secret"); },
  });

  await assert.rejects(
    runtime.startAiWorker(),
    (error) => error?.code === "AUTO_LISTING_AI_RUNTIME_INITIALIZATION_FAILED"
      && error?.message === "自动上架 AI 运行时初始化失败"
      && !/password|raw-secret/iu.test(error.message),
  );
  assert.equal(pools, 0);
});

test("enabled runtime composes the real worker graph lazily without querying PostgreSQL or starting external services", async () => {
  let queries = 0;
  let connects = 0;
  const runtime = createAutoListingRuntime({
    env: enabledEnv({
      DATABASE_URL: "postgres://runtime.invalid/sonli",
      MINIO_ENDPOINT: "storage.internal",
      MINIO_ACCESS_KEY: "storage-access",
      MINIO_SECRET_KEY: "storage-secret-value",
      MINIO_BUCKET: "auto-listing",
    }),
    getPostgresPool: async () => ({
      async query() { queries += 1; throw new Error("must remain lazy"); },
      async connect() { connects += 1; throw new Error("must remain lazy"); },
    }),
  });

  const worker = await runtime.getAiWorker();
  assert.deepEqual(Object.keys(worker).sort(), ["start", "stop"]);
  assert.deepEqual({ queries, connects }, { queries: 0, connects: 0 });
});

test("a worker configuration failure leaves durable queued work untouched and can compose after configuration is repaired", async () => {
  const env = enabledEnv();
  let pools = 0;
  let queries = 0;
  let connects = 0;
  const runtime = createAutoListingRuntime({
    env,
    getPostgresPool: async () => {
      pools += 1;
      return {
        async query() { queries += 1; throw new Error("queued work must remain untouched"); },
        async connect() { connects += 1; throw new Error("queued work must remain untouched"); },
      };
    },
  });

  await assert.rejects(runtime.getAiWorker(), {
    code: "AUTO_LISTING_AI_RUNTIME_INITIALIZATION_FAILED",
  });
  assert.deepEqual({ pools, queries, connects }, { pools: 0, queries: 0, connects: 0 });

  Object.assign(env, {
    DATABASE_URL: "postgres://runtime.invalid/sonli",
    MINIO_ENDPOINT: "storage.internal",
    MINIO_ACCESS_KEY: "storage-access",
    MINIO_SECRET_KEY: "storage-secret-value",
    MINIO_BUCKET: "auto-listing",
  });
  const worker = await runtime.getAiWorker();
  assert.deepEqual(Object.keys(worker).sort(), ["start", "stop"]);
  assert.deepEqual({ pools, queries, connects }, { pools: 1, queries: 0, connects: 0 });
});

test("runtime injects the AI workflow into job creation only when both feature flags are enabled", async () => {
  for (const [env, expectedWorkflowFactories] of [
    [enabledEnv(), 1],
    [enabledEnv({ AUTO_LISTING_AI_ENABLED: "0" }), 0],
  ]) {
    const pool = { name: "pool-a" };
    const workflow = {
      async stageInitialPlanWork() {},
      async applyPhaseOutcome() {},
      async requeueChannelFailure() {},
    };
    const repository = { name: "repository-a" };
    const service = { name: "service-a" };
    const rfbsWarehouseVerifier = { async verifyRfbsWarehouse() {} };
    const prepareListingBase = async () => {};
    const ensureCategoryFresh = async () => ({ status: "CURRENT" });
    let workflowFactories = 0;
    let workerDependencyFactories = 0;
    const repositoryInputs = [];
    const runtime = createAutoListingRuntime({
      env,
      getPostgresPool: async () => pool,
      createAiWorkflow: async (input) => {
        workflowFactories += 1;
        assert.deepEqual(input, { pool, directUploadAllowed: false });
        return workflow;
      },
      createRepository(input) { repositoryInputs.push(input); return repository; },
      createRfbsWarehouseVerifier() { return rfbsWarehouseVerifier; },
      createListingBasePreparer(input) {
        assert.equal(input.pool, pool);
        assert.equal(input.env, env);
        return prepareListingBase;
      },
      createCategoryFreshness: async () => ensureCategoryFresh,
      createService(input) {
        assert.notEqual(input.rfbsWarehouseVerifier, rfbsWarehouseVerifier);
        assert.equal(Object.isFrozen(input.rfbsWarehouseVerifier), true);
        assert.deepEqual(Object.keys(input.rfbsWarehouseVerifier), ["verifyRfbsWarehouse"]);
        assert.equal(input.rfbsWarehouseVerifier.verifyRfbsWarehouse, rfbsWarehouseVerifier.verifyRfbsWarehouse);
        assert.deepEqual({ ...input, rfbsWarehouseVerifier: undefined, selectPlanningContract: undefined }, {
          repository, prepareListingBase, ensureCategoryFresh, rfbsWarehouseVerifier: undefined,
          selectPlanningContract: undefined, uploadPolicyGates: {
          directUploadAllowed: false, uploadEnabled: false, listingPipelineEnabled: true,
          },
        });
        return service;
      },
      createAiWorkerDependencies: async () => {
        workerDependencyFactories += 1;
        throw new Error("worker must remain lazy");
      },
    });

    assert.equal(await runtime.getService(), service);
    assert.equal(workflowFactories, expectedWorkflowFactories);
    assert.equal(workerDependencyFactories, 0);
    assert.deepEqual(repositoryInputs, [expectedWorkflowFactories
      ? { pool, stageInitialPlanWork: workflow.stageInitialPlanWork } : { pool }]);
  }
});

test("auto-listing runtime injects the shared safe category observability boundary", async () => {
  let serviceInput;
  const runtime = createAutoListingRuntime({
    env: enabledEnv({ AUTO_LISTING_AI_ENABLED: "0",
      AUTO_LISTING_CATEGORY_STRATEGY_OBSERVABILITY_HASH_SECRET: "test-observer-hash-secret-long-enough" }),
    metrics: { increment() {} }, logger: { info() {} },
    getPostgresPool: async () => ({ name: "pool-a" }),
    createRepository: () => ({ async loadCategoryStrategyControl() {} }),
    createListingBasePreparer: async () => async () => ({}),
    createCategoryFreshness: async () => async () => ({ status: "CURRENT" }),
    createRfbsWarehouseVerifier: () => ({ async verifyRfbsWarehouse() {} }),
    createService(input) { serviceInput = input; return { marker: "service" }; },
  });
  await runtime.getService();
  assert.equal(typeof serviceInput.observability.observe, "function");
});

test("runtime rejects an open AI workflow factory result before constructing the repository", async () => {
  let repositories = 0;
  const runtime = createAutoListingRuntime({
    env: enabledEnv(),
    getPostgresPool: async () => ({ query() {}, connect() {} }),
    createAiWorkflow: async () => ({
      async stageInitialPlanWork() {},
      async applyPhaseOutcome() {},
      selectLatestProfile() { return "forbidden"; },
    }),
    createRepository() { repositories += 1; },
    createListingBasePreparer: async () => async () => {},
    createCategoryFreshness: async () => async () => ({ status: "CURRENT" }),
    createService() { throw new Error("must not create service"); },
    createAiWorkerDependencies: async () => { throw new Error("worker must remain lazy"); },
  });

  await assert.rejects(runtime.getService(), {
    code: "AUTO_LISTING_AI_RUNTIME_INITIALIZATION_FAILED",
    message: "自动上架 AI 运行时初始化失败",
  });
  assert.equal(repositories, 0);
});

test("legacy auto-listing service remains lazy, memoized, and behaviorally independent from the AI worker seam", async () => {
  const pool = { name: "pool-a" };
  const repository = { name: "repository-a" };
  const service = { name: "service-a" };
  const rfbsWarehouseVerifier = { async verifyRfbsWarehouse() {} };
  const prepareListingBase = async () => {};
  const ensureCategoryFresh = async () => ({ status: "CURRENT" });
  let pools = 0;
  let repositories = 0;
  let services = 0;
  const runtime = createAutoListingRuntime({
    env: enabledEnv({ AUTO_LISTING_AI_ENABLED: "0" }),
    getPostgresPool: async () => { pools += 1; return pool; },
    createRepository(input) { repositories += 1; assert.deepEqual(input, { pool }); return repository; },
    createRfbsWarehouseVerifier() { return rfbsWarehouseVerifier; },
    createListingBasePreparer(input) {
      assert.equal(input.pool, pool);
      return prepareListingBase;
    },
    createCategoryFreshness: async () => ensureCategoryFresh,
    createService(input) {
      services += 1;
      assert.notEqual(input.rfbsWarehouseVerifier, rfbsWarehouseVerifier);
      assert.equal(Object.isFrozen(input.rfbsWarehouseVerifier), true);
      assert.equal(input.rfbsWarehouseVerifier.verifyRfbsWarehouse, rfbsWarehouseVerifier.verifyRfbsWarehouse);
      assert.deepEqual({ ...input, rfbsWarehouseVerifier: undefined, selectPlanningContract: undefined }, {
        repository, prepareListingBase, ensureCategoryFresh, rfbsWarehouseVerifier: undefined,
        selectPlanningContract: undefined, uploadPolicyGates: {
        directUploadAllowed: false, uploadEnabled: false, listingPipelineEnabled: true,
        },
      });
      return service;
    },
    createAiWorkerDependencies: async () => { throw new Error("must not compose"); },
  });

  assert.equal(await runtime.startAiWorker(), false);
  assert.equal(await runtime.getService(), service);
  assert.equal(await runtime.getService(), service);
  assert.deepEqual({ pools, repositories, services }, { pools: 1, repositories: 1, services: 1 });
});

test("runtime defaults new collect-box items to the server-owned fixed skeleton", async () => {
  let serviceInput;
  const runtime = createAutoListingRuntime({
    env: enabledEnv({ AUTO_LISTING_AI_ENABLED: "0" }),
    getPostgresPool: async () => ({ name: "pool-a" }),
    createRepository: () => ({ name: "repository-a" }),
    createListingBasePreparer: async () => async () => {},
    createCategoryFreshness: async () => async () => ({ status: "CURRENT" }),
    createRfbsWarehouseVerifier: () => ({ async verifyRfbsWarehouse() {} }),
    createService(input) { serviceInput = input; return { name: "service-a" }; },
  });

  await runtime.getService();
  assert.equal(typeof serviceInput.selectPlanningContract, "function");
  assert.equal(serviceInput.selectPlanningContract({
    accountId: "account-a", sourceType: "COLLECT_BOX", collectItemId: "collect-a",
  }), "FIXED_SKELETON_V1");
  assert.equal(serviceInput.selectPlanningContract({
    accountId: "account-a", sourceType: "COLLECT_BOX", collectItemId: "collect-b",
  }), "FIXED_SKELETON_V1");
  assert.equal(serviceInput.selectPlanningContract({
    accountId: "account-a", sourceType: "EXCEL_SKU", collectItemId: "collect-b",
  }), "LEGACY_FULL_PLAN_V3");
});

test("runtime composes the RFBS verifier from tenant-scoped warehouse and credential ports", async () => {
  const pool = { name: "pool-a" };
  const warehouse = { id: "warehouse-a", accountId: "account-a", storeId: "store-a" };
  const credential = { id: "store-a", clientId: "client-a", apiKey: "test-only-key" };
  const repositoryCalls = [];
  const credentialCalls = [];
  const repository = {
    async loadTargetWarehouse(input) {
      repositoryCalls.push(input);
      return { warehouse, products: [] };
    },
  };
  const rfbsWarehouseVerifier = { async verifyRfbsWarehouse() {} };
  let verifierDependencies;
  const sellerApi = async () => ({ result: [] });
  const service = { name: "service-a" };
  const runtime = createAutoListingRuntime({
    env: enabledEnv({ AUTO_LISTING_AI_ENABLED: "0" }),
    getPostgresPool: async () => pool,
    createRepository(input) { assert.deepEqual(input, { pool }); return repository; },
    createListingBasePreparer: async () => async () => {},
    createCategoryFreshness: async () => async () => ({ status: "CURRENT" }),
    createRfbsWarehouseVerifier(input) {
      verifierDependencies = input;
      return rfbsWarehouseVerifier;
    },
    readStoreCredential: async (storeId, accountId) => {
      credentialCalls.push({ storeId, accountId });
      return credential;
    },
    callOzonSellerApi: sellerApi,
    createService(input) {
      assert.notEqual(input.rfbsWarehouseVerifier, rfbsWarehouseVerifier);
      assert.equal(Object.isFrozen(input.rfbsWarehouseVerifier), true);
      assert.deepEqual(Object.keys(input.rfbsWarehouseVerifier), ["verifyRfbsWarehouse"]);
      assert.equal(input.rfbsWarehouseVerifier.verifyRfbsWarehouse, rfbsWarehouseVerifier.verifyRfbsWarehouse);
      return service;
    },
  });

  assert.equal(await runtime.getService(), service);
  assert.deepEqual(Object.keys(verifierDependencies).sort(), ["callOzonSellerApi", "loadTarget", "readCredential"]);
  assert.equal(verifierDependencies.callOzonSellerApi, sellerApi);
  assert.equal(await verifierDependencies.loadTarget({
    accountId: "account-a", targetStoreId: "store-a", targetWarehouseId: "warehouse-a",
  }), warehouse);
  assert.deepEqual(repositoryCalls, [{
    accountId: "account-a", targetStoreId: "store-a", targetWarehouseId: "warehouse-a",
  }]);
  assert.equal(await verifierDependencies.readCredential({ accountId: "account-a", targetStoreId: "store-a" }), credential);
  assert.deepEqual(credentialCalls, [{ storeId: "store-a", accountId: "account-a" }]);
});

for (const [label, verifierFactory] of [
  ["transparent object Proxy", () => new Proxy({ async verifyRfbsWarehouse() {} }, {})],
  ["callable method Proxy", () => ({ verifyRfbsWarehouse: new Proxy(async () => {}, {}) })],
  ["revoked object Proxy", () => {
    const value = Proxy.revocable({ async verifyRfbsWarehouse() {} }, {});
    value.revoke();
    return value.proxy;
  }],
]) {
  test(`runtime rejects ${label} before service, credential, or network calls`, async () => {
    const calls = { services: 0, credentials: 0, network: 0 };
    const runtime = createAutoListingRuntime({
      env: enabledEnv({ AUTO_LISTING_AI_ENABLED: "0" }),
      getPostgresPool: async () => ({ name: "pool-a" }),
      createRepository: () => ({ async loadTargetWarehouse() { return { warehouse: null, products: [] }; } }),
      createListingBasePreparer: async () => async () => ({}),
      createCategoryFreshness: async () => async () => ({ status: "CURRENT" }),
      createRfbsWarehouseVerifier: verifierFactory,
      readStoreCredential: async () => { calls.credentials += 1; return null; },
      callOzonSellerApi: async () => { calls.network += 1; return { result: [] }; },
      createService: () => { calls.services += 1; return { name: "must-not-compose" }; },
    });

    await assert.rejects(runtime.getService(), {
      code: "AUTO_LISTING_RFBS_RUNTIME_INITIALIZATION_FAILED",
      message: "RFBS 仓库验证运行时初始化失败",
    });
    assert.deepEqual(calls, { services: 0, credentials: 0, network: 0 });
  });
}

test("runtime captures one ordinary verifier method against late factory-result mutation", async () => {
  let originalCalls = 0;
  let replacementCalls = 0;
  const factoryResult = {
    async verifyRfbsWarehouse() { originalCalls += 1; },
  };
  let captured;
  const runtime = createAutoListingRuntime({
    env: enabledEnv({ AUTO_LISTING_AI_ENABLED: "0" }),
    getPostgresPool: async () => ({ name: "pool-a" }),
    createRepository: () => ({ async loadTargetWarehouse() { return { warehouse: null, products: [] }; } }),
    createListingBasePreparer: async () => async () => ({}),
    createCategoryFreshness: async () => async () => ({ status: "CURRENT" }),
    createRfbsWarehouseVerifier: () => factoryResult,
    createService(input) { captured = input.rfbsWarehouseVerifier; return { name: "service-a" }; },
  });

  await runtime.getService();
  factoryResult.verifyRfbsWarehouse = async () => { replacementCalls += 1; };
  factoryResult.writeWarehouse = async () => { replacementCalls += 1; };
  await captured.verifyRfbsWarehouse();

  assert.equal(Object.isFrozen(captured), true);
  assert.deepEqual(Object.keys(captured), ["verifyRfbsWarehouse"]);
  assert.deepEqual({ originalCalls, replacementCalls }, { originalCalls: 1, replacementCalls: 0 });
});

test("disabled auto-listing getService performs zero composition, credential, decrypt, and network calls", async () => {
  for (const env of [
    {},
    enabledEnv({ AUTO_LISTING_ENABLED: "", AUTO_LISTING_AI_ENABLED: "0" }),
    enabledEnv({ AUTO_LISTING_ENABLED: "0", AUTO_LISTING_AI_ENABLED: "0" }),
    enabledEnv({ AUTO_LISTING_ENABLED: "false", AUTO_LISTING_AI_ENABLED: "0" }),
  ]) {
    const calls = {
      pools: 0,
      repositories: 0,
      preparers: 0,
      verifiers: 0,
      credentials: 0,
      network: 0,
      services: 0,
    };
    const runtime = createAutoListingRuntime({
      env,
      getPostgresPool: async () => { calls.pools += 1; throw new Error("pool must remain dormant"); },
      createRepository: () => { calls.repositories += 1; throw new Error("repository must remain dormant"); },
      createListingBasePreparer: async () => { calls.preparers += 1; throw new Error("preparer must remain dormant"); },
      createRfbsWarehouseVerifier: () => { calls.verifiers += 1; throw new Error("verifier must remain dormant"); },
      readStoreCredential: async () => {
        calls.credentials += 1;
        throw new Error("credential must remain encrypted");
      },
      callOzonSellerApi: async () => {
        calls.network += 1;
        throw new Error("network must remain dormant");
      },
      createService: () => { calls.services += 1; throw new Error("service must remain dormant"); },
    });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await assert.rejects(runtime.getService(), {
        code: "AUTO_LISTING_DISABLED",
        message: "自动上架功能暂未启用",
        retryable: false,
      });
    }
    assert.equal(await runtime.startAiWorker(), false);
    await runtime.stopAiWorker();
    assert.deepEqual(calls, {
      pools: 0,
      repositories: 0,
      preparers: 0,
      verifiers: 0,
      credentials: 0,
      network: 0,
      services: 0,
    });
  }
});
