import assert from "node:assert/strict";
import test from "node:test";

import { createAutoListingRuntime } from "../auto-listing-runtime.mjs";

function enabledEnv(overrides = {}) {
  return {
    AUTO_LISTING_ENABLED: "true",
    AUTO_LISTING_AI_ENABLED: "1",
    AUTO_LISTING_AI_ALLOWED_SECRET_ENV_NAMES: "SUB2API_API_KEY",
    AUTO_LISTING_AI_ALLOWED_GATEWAY_BASE_URLS: "https://gateway.invalid/v1",
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
  assert.deepEqual(harness.calls, ["start", "createQueue", "work"]);
  await runtime.stopAiWorker();
  assert.deepEqual(harness.calls, ["start", "createQueue", "work", "stop"]);
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
    [enabledEnv({ AUTO_LISTING_ENABLED: "0" }), 0],
    [enabledEnv({ AUTO_LISTING_AI_ENABLED: "0" }), 0],
  ]) {
    const pool = { name: "pool-a" };
    const workflow = {
      async stageInitialPlanWork() {},
      async applyPhaseOutcome() {},
    };
    const repository = { name: "repository-a" };
    const service = { name: "service-a" };
    const prepareListingBase = async () => {};
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
      createListingBasePreparer(input) {
        assert.equal(input.pool, pool);
        assert.equal(input.env, env);
        return prepareListingBase;
      },
      createService(input) {
        assert.deepEqual(input, { repository, prepareListingBase, uploadPolicyGates: {
          directUploadAllowed: false, uploadEnabled: false, listingPipelineEnabled: true,
        } });
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
  const prepareListingBase = async () => {};
  let pools = 0;
  let repositories = 0;
  let services = 0;
  const runtime = createAutoListingRuntime({
    env: {},
    getPostgresPool: async () => { pools += 1; return pool; },
    createRepository(input) { repositories += 1; assert.deepEqual(input, { pool }); return repository; },
    createListingBasePreparer(input) {
      assert.equal(input.pool, pool);
      return prepareListingBase;
    },
    createService(input) {
      services += 1;
      assert.deepEqual(input, { repository, prepareListingBase, uploadPolicyGates: {
        directUploadAllowed: false, uploadEnabled: false, listingPipelineEnabled: true,
      } });
      return service;
    },
    createAiWorkerDependencies: async () => { throw new Error("must not compose"); },
  });

  assert.equal(await runtime.startAiWorker(), false);
  assert.equal(await runtime.getService(), service);
  assert.equal(await runtime.getService(), service);
  assert.deepEqual({ pools, repositories, services }, { pools: 1, repositories: 1, services: 1 });
});
