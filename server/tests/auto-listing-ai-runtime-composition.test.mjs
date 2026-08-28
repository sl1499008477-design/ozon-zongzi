import assert from "node:assert/strict";
import test from "node:test";

import {
  createAutoListingAiProductionDependencies,
  createAutoListingAiProductionOutboxRelay,
  createAutoListingPlanDiagnosticProductionPorts,
  createDefaultAutoListingAiProductionDependencies,
  createDefaultAutoListingAiProductionOutboxRelay,
} from "../auto-listing-ai-runtime-composition.mjs";
import {
  createAutoListingAiWorkPublisher,
  createAutoListingAiWorkQueueAdapter,
  createLegacyAutoListingAiOutboxPublisher,
  createLegacyAutoListingAiQueueAdapter,
} from "../auto-listing-ai-queue.mjs";

const phases = Object.freeze({
  planContent: async () => ({ id: "plan-a" }),
  materializeSourceAsset: async () => ({ status: "ACCEPTED" }),
  finalizeMaterializedPlan: async () => ({ id: "derived-a" }),
  generateImageSlot: async () => ({ status: "ACCEPTED" }),
  generateRichContent: async () => ({ status: "ACCEPTED" }),
});

function enabledEnv(overrides = {}) {
  return {
    AUTO_LISTING_ENABLED: "1",
    AUTO_LISTING_AI_ENABLED: "1",
    AUTO_LISTING_AI_ALLOWED_SECRET_ENV_NAMES: "ACCOUNT_A_AI_KEY,ACCOUNT_B_AI_KEY",
    AUTO_LISTING_AI_ALLOWED_GATEWAY_BASE_URLS: "https://gateway.example.test/tenant/v1",
    DATABASE_URL: "postgres://runtime.invalid/sonli",
    MINIO_ENDPOINT: "storage.internal",
    MINIO_ACCESS_KEY: "storage-access",
    MINIO_SECRET_KEY: "storage-secret-value",
    MINIO_BUCKET: "auto-listing",
    ACCOUNT_A_AI_KEY: "account-a-secret",
    ACCOUNT_B_AI_KEY: "account-b-secret",
    AUTO_LISTING_CREDENTIAL_MASTER_KEY: Buffer.alloc(32, 7).toString("base64url"),
    AUTO_LISTING_CREDENTIAL_KEY_VERSION: "runtime-v1",
    ...overrides,
  };
}

function context(message, profile) {
  return Object.freeze({
    accountId: message.accountId,
    jobId: message.accountId === "account-a" ? "job-a" : "job-b",
    itemId: message.itemId,
    status: "PLANNING",
    statusVersion: message.expectedStatusVersion,
    activeContentPlanId: null,
    phaseInput: Object.freeze({ gatewayProfile: Object.freeze(profile) }),
  });
}

function testPorts(events) {
  const repository = (name) => ({ name });
  return Object.freeze({
    createBoss(input) { events.push(["boss", input]); return { name: "boss-a" }; },
    async loadCredentialKey({ env }) {
      events.push(["credential-key", env.AUTO_LISTING_CREDENTIAL_KEY_VERSION]);
      return Buffer.alloc(32, 7);
    },
    createCipher(input) {
      events.push(["cipher", input.keyVersion]);
      return Object.freeze({ decrypt() { return "connection-secret"; } });
    },
    createCredentialRepository({ pool }) {
      events.push(["credential-repository", pool]);
      return Object.freeze({ async loadConnectionForSecretResolution() {} });
    },
    createCredentialResolver(input) {
      events.push(["credential-resolver", input]);
      return Object.freeze({ async resolveSecret() { return "connection-secret"; } });
    },
    createGateway({ readSecret, resolveSecret, gatewayPolicy, allowLocalGateway }) {
      events.push(["gateway", gatewayPolicy, allowLocalGateway]);
      return Object.freeze({
        readSecret,
        resolveSecret,
        async createTextResponse() { throw new Error("real AI must not be called by composition"); },
        async generateImage() { throw new Error("real AI must not be called by composition"); },
        async inspectImage() { throw new Error("real AI must not be called by composition"); },
      });
    },
    createWorkflow(input) {
      events.push(["workflow", input]);
      return Object.freeze({
        async stageInitialPlanWork() { throw new Error("job staging must not be called by worker composition"); },
        async applyPhaseOutcome(input) {
          events.push(["apply-outcome", input]);
          return Object.freeze({ applied: true });
        },
      });
    },
    createContentPlanRepository({ pool }) { events.push(["content", pool]); return repository("content"); },
    createContentPlanEvidenceRepository({ pool }) {
      events.push(["content-evidence", pool]);
      return Object.freeze({
        async recordResponse() {},
        async recordValidation() {},
        async loadOutcome() {},
      });
    },
    createSourceMaterializationRepository({ pool }) { events.push(["source", pool]); return repository("source"); },
    createGenerationRepository({ pool }) { events.push(["generation", pool]); return repository("generation"); },
    createRichContentRepository({ pool }) { events.push(["rich", pool]); return repository("rich"); },
    createDownloader() {
      events.push(["downloader"]);
      return Object.freeze({ async downloadSourceImage() { throw new Error("network must not be called"); } });
    },
    createStorage({ env }) {
      events.push(["storage", env.MINIO_BUCKET]);
      return Object.freeze({
        async putObjectFromBuffer() { throw new Error("storage must not be called"); },
        async getObjectBuffer() { throw new Error("storage must not be called"); },
        async removeObject() { throw new Error("storage must not be called"); },
      });
    },
    createSourceAssetLoader({ pool, storage }) {
      events.push(["source-loader", pool, storage]);
      return Object.freeze({ async loadSourceAsset() { throw new Error("loader must not be called"); } });
    },
    createContextLoader(options) {
      events.push(["context-loader", options]);
      assert.equal(Object.hasOwn(options, "gatewayProfile"), false);
      return async (message) => context(message, message.accountId === "account-a" ? {
        id: "profile-a", accountId: "account-a", configVersion: 3,
        apiKeyEnvName: "ACCOUNT_A_AI_KEY",
      } : {
        id: "profile-b", accountId: "account-b", configVersion: 9,
        apiKeyEnvName: "ACCOUNT_B_AI_KEY",
      });
    },
    orchestratePhase(input, services) {
      events.push(["orchestrate", input, services]);
      return Object.freeze({ disposition: "ACK" });
    },
    phaseServices: phases,
  });
}

test("production worker passes the enabled DIRECT server gate into its durable workflow", async () => {
  const events = [];
  const pool = Object.freeze({ async query() {}, async connect() {} });
  await createAutoListingAiProductionDependencies({
    env: enabledEnv({ AUTO_LISTING_DIRECT_UPLOAD_ALLOWED: "true" }),
    resolvePool: async () => pool,
    ports: testPorts(events),
  });

  assert.deepEqual(events.find(([name]) => name === "workflow")[1], {
    pool,
    directUploadAllowed: true,
  });
});

test("production composition keeps account/job-frozen profiles per message and has no global profile selector", async () => {
  const events = [];
  const env = enabledEnv({
    AUTO_LISTING_AI_PROFILE_ID: "must-not-be-read",
    AUTO_LISTING_AI_PROFILE_VERSION: "999",
  });
  const pool = Object.freeze({ async query() {}, async connect() {} });
  let pools = 0;
  const dependencies = await createAutoListingAiProductionDependencies({
    env,
    resolvePool: async () => { pools += 1; return pool; },
    ports: testPorts(events),
  });

  assert.equal(pools, 1);
  assert.deepEqual(Object.keys(dependencies).sort(), ["bossFactory", "loadContext", "orchestrate", "workflow"]);
  assert.equal(events.filter(([name]) => name === "gateway").length, 1);
  assert.equal(events.filter(([name]) => name === "boss").length, 0);
  const options = events.find(([name]) => name === "context-loader")[1];
  assert.deepEqual(Object.keys(options).sort(), [
    "contentPlanEvidenceRepository", "contentPlanRepository", "downloader", "gateway", "generationRepository", "logger", "maxAttempts",
    "planPromptTemplateVersion", "pool", "prohibitedClaims", "referenceProjector", "richContentLeaseOwner",
    "richContentMaxAttempts", "richContentRepository", "sourceAssetLoader", "sourceMaterializationRepository", "storage",
  ]);
  assert.equal(options.planPromptTemplateVersion, "AUTO_LISTING_CONTENT_PLAN_V3");
  assert.equal(options.maxAttempts, 3);
  assert.equal(options.richContentMaxAttempts, 5);
  assert.equal(typeof options.referenceProjector, "function");

  const message = (accountId, itemId) => ({
    contractVersion: "V1", accountId, itemId, phase: "PLAN_CONTENT",
    expectedStatusVersion: 1, correlationId: `correlation-${accountId}`,
  });
  const accountA = await dependencies.loadContext(message("account-a", "item-a"));
  const accountB = await dependencies.loadContext(message("account-b", "item-b"));
  assert.deepEqual(
    [accountA.phaseInput.gatewayProfile.id, accountA.phaseInput.gatewayProfile.configVersion],
    ["profile-a", 3],
  );
  assert.deepEqual(
    [accountB.phaseInput.gatewayProfile.id, accountB.phaseInput.gatewayProfile.configVersion],
    ["profile-b", 9],
  );

  const gateway = options.gateway;
  assert.equal(gateway.readSecret(accountA.phaseInput.gatewayProfile.apiKeyEnvName), "account-a-secret");
  assert.equal(gateway.readSecret(accountB.phaseInput.gatewayProfile.apiKeyEnvName), "account-b-secret");
  assert.equal(gateway.readSecret("MINIO_SECRET_KEY"), undefined);
  assert.equal(await gateway.resolveSecret({
    accountId: "account-a", connectionId: "connection-a", connectionVersion: 1,
  }), "connection-secret");
  assert.equal(JSON.stringify(dependencies).includes("secret"), false);
  assert.deepEqual(Object.keys(dependencies.workflow), ["applyOutcome"]);
  const appliedMessage = message("account-a", "item-a");
  const appliedOutcome = Object.freeze({
    contractVersion: "V1", disposition: "ACK", phase: "PLAN_CONTENT", outcome: "PLAN_READY",
    retryable: false, failureCode: null, correlationId: appliedMessage.correlationId,
  });
  assert.deepEqual(await dependencies.workflow.applyOutcome(appliedMessage, appliedOutcome), { applied: true });
  assert.deepEqual(events.find(([name]) => name === "apply-outcome")[1], {
    message: appliedMessage, outcome: appliedOutcome,
  });
  assert.deepEqual(await dependencies.bossFactory(), { name: "boss-a" });
  assert.equal(events.filter(([name]) => name === "boss").length, 1);
});

test("production worker carries the same development-only local gateway opt-in as administrator testing", async () => {
  const events = [];
  await createAutoListingAiProductionDependencies({
    env: enabledEnv({
      AUTO_LISTING_AI_ALLOW_LOCAL_GATEWAY: "true",
      AUTO_LISTING_AI_ALLOWED_GATEWAY_BASE_URLS: "http://127.0.0.1:8080/v1",
    }),
    resolvePool: async () => Object.freeze({ async query() {}, async connect() {} }),
    ports: testPorts(events),
  });
  const gateway = events.find(([name]) => name === "gateway");
  assert.equal(gateway[2], true);

  const productionEvents = [];
  await assert.rejects(createAutoListingAiProductionDependencies({
    env: enabledEnv({
      NODE_ENV: "production",
      AUTO_LISTING_AI_ALLOW_LOCAL_GATEWAY: "true",
      AUTO_LISTING_AI_ALLOWED_GATEWAY_BASE_URLS: "http://127.0.0.1:8080/v1",
    }),
    resolvePool: async () => { productionEvents.push("pool"); return {}; },
    ports: testPorts(productionEvents),
  }), { code: "AUTO_LISTING_AI_RUNTIME_CONFIGURATION_INVALID" });
  assert.deepEqual(productionEvents, []);
});

test("production worker internally allowlists the encrypted sentinel without reading it from env", async () => {
  const events = [];
  await createAutoListingAiProductionDependencies({
    env: enabledEnv({ AUTO_LISTING_AI_ALLOWED_SECRET_ENV_NAMES: "",
      SUB2API_ENCRYPTED_KEY: "must-not-be-read-as-legacy" }),
    resolvePool: async () => Object.freeze({ async query() {}, async connect() {} }),
    ports: testPorts(events),
  });
  const gatewayEvent = events.find(([name]) => name === "gateway");
  assert.deepEqual(gatewayEvent[1].allowedSecretEnvNames, ["SUB2API_ENCRYPTED_KEY"]);
  const gateway = events.find(([name]) => name === "context-loader")[1].gateway;
  assert.equal(gateway.readSecret("SUB2API_ENCRYPTED_KEY"), undefined);
});

test("production composition fails safely on missing database or storage configuration before any factory", async () => {
  for (const env of [
    enabledEnv({ DATABASE_URL: "" }),
    enabledEnv({ MINIO_SECRET_KEY: "" }),
    enabledEnv({ MINIO_PORT: "not-a-port" }),
    enabledEnv({ MINIO_USE_SSL: "sometimes" }),
    enabledEnv({ AUTO_LISTING_AI_ALLOWED_GATEWAY_BASE_URLS: "" }),
  ]) {
    const events = [];
    let pools = 0;
    await assert.rejects(
      createAutoListingAiProductionDependencies({
        env,
        resolvePool: async () => { pools += 1; throw new Error("password=raw-secret"); },
        ports: testPorts(events),
      }),
      (error) => error?.code === "AUTO_LISTING_AI_RUNTIME_CONFIGURATION_INVALID"
        && !/password|raw-secret|storage-secret-value/iu.test(error?.message || ""),
    );
    assert.equal(pools, 0);
    assert.deepEqual(events, []);
  }
});

test("production composition input and ports are closed before database or external initialization", async () => {
  const env = enabledEnv();
  const base = { env, resolvePool: async () => ({ query() {}, connect() {} }), ports: testPorts([]) };
  await assert.rejects(
    createAutoListingAiProductionDependencies({ ...base, profileId: "global-profile" }),
    (error) => error?.code === "AUTO_LISTING_AI_RUNTIME_CONFIGURATION_INVALID",
  );
  await assert.rejects(
    createAutoListingAiProductionDependencies({
      ...base,
      ports: { ...base.ports, selectLatestProfile: async () => null },
    }),
    (error) => error?.code === "AUTO_LISTING_AI_RUNTIME_CONFIGURATION_INVALID",
  );
});

test("production composition rejects an incomplete content-plan evidence repository before loading context", async () => {
  const events = [];
  const ports = testPorts(events);
  await assert.rejects(
    createAutoListingAiProductionDependencies({
      env: enabledEnv(),
      resolvePool: async () => Object.freeze({ async query() {}, async connect() {} }),
      ports: Object.freeze({
        ...ports,
        createContentPlanEvidenceRepository() {
          return Object.freeze({ async recordResponse() {} });
        },
      }),
    }),
    (error) => error?.code === "AUTO_LISTING_AI_RUNTIME_INITIALIZATION_FAILED",
  );
  assert.equal(events.some(([name]) => name === "context-loader"), false);
});

test("production composition accepts the host process.env object shape while still projecting closed configuration", async () => {
  const env = Object.assign(Object.create({ runtimeEnvironment: true }), enabledEnv());
  const events = [];
  const pool = Object.freeze({ async query() {}, async connect() {} });
  const dependencies = await createAutoListingAiProductionDependencies({
    env,
    resolvePool: async () => pool,
    ports: testPorts(events),
  });
  assert.deepEqual(Object.keys(dependencies).sort(), ["bossFactory", "loadContext", "orchestrate", "workflow"]);
});

test("the real production dependency graph composes without starting PgBoss, MinIO, Sub2API or Ozon", async () => {
  let queries = 0;
  let connections = 0;
  const pool = Object.freeze({
    async query() { queries += 1; throw new Error("must remain lazy"); },
    async connect() { connections += 1; throw new Error("must remain lazy"); },
  });
  const dependencies = await createDefaultAutoListingAiProductionDependencies({
    env: enabledEnv(),
    resolvePool: async () => pool,
  });
  assert.deepEqual(Object.keys(dependencies).sort(), ["bossFactory", "loadContext", "orchestrate", "workflow"]);
  assert.equal(queries, 0);
  assert.equal(connections, 0);
});

test("text-only diagnostic production ports reuse the closed credential boundary without image or storage work", async () => {
  const events = [];
  const pool = Object.freeze({ async query() {}, async connect() {} });
  const gateway = Object.freeze({
    async createTextResponse() {},
    async generateImage() { throw new Error("diagnostic must not generate images"); },
    async inspectImage() { throw new Error("diagnostic must not inspect images"); },
  });
  const evidenceRepository = Object.freeze({
    async recordResponse() {}, async recordValidation() {}, async loadOutcome() {},
  });
  const ports = Object.freeze({
    async loadCredentialKey() { events.push("key"); return Buffer.alloc(32, 7); },
    createCipher() { events.push("cipher"); return {}; },
    createCredentialRepository(input) { events.push(["credentials", input]); return {}; },
    createCredentialResolver() { events.push("resolver"); return { async resolveSecret() {} }; },
    createGateway(input) { events.push(["gateway", input]); return gateway; },
    createEvidenceRepository(input) { events.push(["evidence", input]); return evidenceRepository; },
  });
  const result = await createAutoListingPlanDiagnosticProductionPorts({
    env: enabledEnv(), resolvePool: async () => pool, ports,
  });
  assert.deepEqual(result, { pool, gateway, evidenceRepository });
  assert.equal(events.some((entry) => Array.isArray(entry) && entry[0] === "storage"), false);
  assert.equal(events.filter((entry) => Array.isArray(entry) && entry[0] === "gateway").length, 1);
});

test("production relay discovers runnable accounts from the shared outbox in fair pages and starts with replay", async () => {
  const events = [];
  const pages = new Map([
    [null, ["account-a", "account-b"]],
    ["account-b", ["account-c"]],
    ["account-c", []],
  ]);
  const repository = {
    async listRunnableAutoListingAiAccountIds(input) {
      events.push(["discover", input]);
      return pages.get(input.afterAccountId) || [];
    },
    async claimAutoListingAiMessages(input) { events.push(["claim", input.accountId]); return []; },
    async claimLegacyAutoListingAiMessages(input) { events.push(["legacy-claim", input.accountId]); return []; },
    async claimAutoListingAiWork(input) { events.push(["v3-claim", input.accountId]); return []; },
    async markAutoListingAiWorkPublished() { throw new Error("no rows"); },
    async releaseUnpublishedAutoListingAiWork() { throw new Error("no rows"); },
    async renewAutoListingAiMessageLease() { throw new Error("no rows"); },
    async completeAutoListingAiMessage() {},
    async failAutoListingAiMessage() {},
    async reconcileDeadLegacyAutoListingAiMessages() { events.push(["legacy-dead"]); return { recovered: 0 }; },
    async reconcileDeadAutoListingAiMessages() { events.push(["generic-dead"]); throw new Error("must stay fenced"); },
    async reconcileInterruptedAutoListingAiItems() { return { recovered: 0 }; },
  };
  const boss = {
    async start() { events.push(["boss-start"]); },
    async createQueue(name) { events.push(["queue", name]); },
    async send() { throw new Error("empty outbox must not send"); },
    async stop() { events.push(["boss-stop"]); },
  };
  const ticks = [];
  const ports = Object.freeze({
    createBoss() { events.push(["boss-create"]); return boss; },
    createOutboxRepository({ pool }) { events.push(["repository", pool]); return repository; },
    createQueueAdapter: createLegacyAutoListingAiQueueAdapter,
    createPublisher(options) {
      return createLegacyAutoListingAiOutboxPublisher({
        ...options,
        timers: {
          setTimeout, clearTimeout,
          setInterval(callback) { ticks.push(callback); return { unref() {} }; },
          clearInterval() { events.push(["timer-stop"]); },
        },
        intervalMs: 5_000,
      });
    },
    createWorkQueueAdapter: createAutoListingAiWorkQueueAdapter,
    createWorkPublisher(options) {
      return createAutoListingAiWorkPublisher({
        ...options,
        timers: {
          setTimeout, clearTimeout,
          setInterval(callback) { ticks.push(callback); return { unref() {} }; },
          clearInterval() { events.push(["work-timer-stop"]); },
        },
        intervalMs: 5_000,
      });
    },
  });
  const pool = Object.freeze({ async query() {}, async connect() {} });
  const relay = await createAutoListingAiProductionOutboxRelay({
    env: enabledEnv(), resolvePool: async () => pool, ports,
  });

  assert.deepEqual(Object.keys(relay).sort(), ["start", "stop"]);
  assert.equal(events.some(([name]) => name === "boss-create" || name === "discover"), false);
  assert.equal(await relay.start(), true);
  assert.equal(ticks.length, 2);
  await Promise.all(ticks.map((tick) => tick()));
  await Promise.all(ticks.map((tick) => tick()));
  await relay.stop();

  assert.deepEqual(events.filter(([name]) => name === "discover").map(([, input]) => input), [
    { afterAccountId: null, limit: 100 },
    { afterAccountId: null, limit: 100 },
    { afterAccountId: "account-b", limit: 100 },
    { afterAccountId: "account-b", limit: 100 },
    { afterAccountId: "account-c", limit: 100 },
    { afterAccountId: "account-c", limit: 100 },
    { afterAccountId: null, limit: 100 },
    { afterAccountId: null, limit: 100 },
  ]);
  assert.deepEqual(events.filter(([name]) => name === "claim").map(([, accountId]) => accountId), []);
  assert.deepEqual(events.filter(([name]) => name === "legacy-claim").map(([, accountId]) => accountId), [
    "account-a", "account-b", "account-c", "account-a", "account-b",
  ]);
  assert.deepEqual(events.filter(([name]) => name === "v3-claim").map(([, accountId]) => accountId), [
    "account-a", "account-b", "account-c", "account-a", "account-b",
  ]);
  assert.deepEqual(events.filter(([name]) => name === "queue").map(([, name]) => name).sort(), [
    "auto-listing-ai-v2", "auto-listing-ai-v3",
  ]);
  assert.equal(events.filter(([name]) => name === "legacy-dead").length, 5);
  assert.equal(events.some(([name]) => name === "generic-dead"), false);
  assert.equal(events.filter(([name]) => name === "boss-create").length, 2);
  assert.equal(events.filter(([name]) => name === "boss-stop").length, 2);
  assert.equal(events.filter(([name]) => name === "timer-stop").length, 1);
  assert.equal(events.filter(([name]) => name === "work-timer-stop").length, 1);
});

test("default production relay is lazy, uses the same database configuration and does not query before start", async () => {
  let pools = 0;
  let queries = 0;
  let connections = 0;
  const relay = await createDefaultAutoListingAiProductionOutboxRelay({
    env: enabledEnv(),
    resolvePool: async () => {
      pools += 1;
      return {
        async query() { queries += 1; throw new Error("must remain lazy"); },
        async connect() { connections += 1; throw new Error("must remain lazy"); },
      };
    },
  });
  assert.deepEqual(Object.keys(relay).sort(), ["start", "stop"]);
  assert.deepEqual({ pools, queries, connections }, { pools: 1, queries: 0, connections: 0 });
});

test("default production relay runs bounded v2 legacy and v3 connection cycles without crossing claim kinds", async () => {
  const events = [];
  const pool = Object.freeze({ async query() {}, async connect() {} });
  const repository = Object.freeze({
    async listRunnableAutoListingAiAccountIds(input) { events.push(["discover", input]); return ["account-a"]; },
    async claimLegacyAutoListingAiMessages(input) { events.push(["legacy-claim", input]); return []; },
    async claimAutoListingAiMessages() { events.push(["generic-claim"]); throw new Error("must not claim generic work"); },
    async claimAutoListingAiWork(input) { events.push(["v3-claim", input]); return []; },
    async markAutoListingAiWorkPublished() { throw new Error("no rows"); },
    async releaseUnpublishedAutoListingAiWork() { throw new Error("no rows"); },
    async renewAutoListingAiMessageLease() { throw new Error("no rows"); },
    async completeAutoListingAiMessage() { throw new Error("no rows"); },
    async failAutoListingAiMessage() { throw new Error("no rows"); },
    async reconcileDeadLegacyAutoListingAiMessages(input) { events.push(["reconcile-legacy-dead", input]); return { recovered: 0 }; },
    async reconcileDeadAutoListingAiMessages() { events.push(["reconcile-generic-dead"]); throw new Error("must not reconcile generic rows"); },
    async reconcileInterruptedAutoListingAiItems(input) { events.push(["reconcile-interrupted", input]); return { recovered: 0 }; },
  });
  const boss = Object.freeze({
    async start() { events.push(["boss-start"]); },
    async createQueue(name, options) { events.push(["queue", name, options]); },
    async send() { events.push(["send"]); throw new Error("empty outbox must not publish"); },
    async stop() { events.push(["boss-stop"]); },
  });

  const relay = await createDefaultAutoListingAiProductionOutboxRelay({
    env: enabledEnv(),
    resolvePool: async () => pool,
  }, Object.freeze({
    createBoss(input) { events.push(["boss-create", input]); return boss; },
    createOutboxRepository(input) { events.push(["repository", input]); return repository; },
  }));

  assert.deepEqual(events, [["repository", { pool }]]);
  assert.equal(await relay.start(), true);
  await relay.stop();

  assert.deepEqual(events.filter(([name]) => name === "discover"), [
    ["discover", { afterAccountId: null, limit: 100 }],
    ["discover", { afterAccountId: null, limit: 100 }],
  ]);
  assert.deepEqual(events.filter(([name]) => name === "legacy-claim"), [[
    "legacy-claim",
    { accountId: "account-a", workerId: "auto-listing-ai-outbox-relay-v1", limit: 1, leaseMs: 30_000 },
  ]]);
  assert.deepEqual(events.filter(([name]) => name === "v3-claim"), [[
    "v3-claim",
    { accountId: "account-a", workerId: "auto-listing-ai-work-relay-v3", limit: 1, leaseMs: 30_000 },
  ]]);
  assert.equal(events.some(([name]) => name === "generic-claim" || name === "send"), false);
  assert.deepEqual(events.filter(([name]) => name === "reconcile-legacy-dead"), [
    ["reconcile-legacy-dead", { accountId: "account-a", limit: 1 }],
  ]);
  assert.equal(events.some(([name]) => name === "reconcile-generic-dead"), false);
  const queues = events.filter(([name]) => name === "queue");
  assert.deepEqual(queues.map(([, name]) => name).sort(), ["auto-listing-ai-v2", "auto-listing-ai-v3"]);
  assert.equal(queues.every((queue) => !Object.hasOwn(queue[2], "expireInSeconds")), true);
  assert.equal(events.filter(([name]) => name === "boss-create").length, 2);
  assert.equal(events.filter(([name]) => name === "boss-stop").length, 2);
});
