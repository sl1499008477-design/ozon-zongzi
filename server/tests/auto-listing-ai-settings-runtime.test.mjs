import assert from "node:assert/strict";
import test from "node:test";

import { createAutoListingAiSettingsRuntime } from "../auto-listing-ai-settings-runtime.mjs";

function enabledEnv(overrides = {}) {
  return {
    NODE_ENV: "development",
    AUTO_LISTING_ENABLED: "true",
    AUTO_LISTING_AI_ENABLED: "true",
    AUTO_LISTING_AI_ALLOWED_SECRET_ENV_NAMES: "SUB2API_API_KEY",
    AUTO_LISTING_AI_ALLOWED_GATEWAY_BASE_URLS: "http://127.0.0.1:8080/v1",
    AUTO_LISTING_AI_ALLOWED_GATEWAY_ORIGINS: "",
    AUTO_LISTING_AI_ALLOW_LOCAL_GATEWAY: "true",
    AUTO_LISTING_CREDENTIAL_MASTER_KEY: "test-key-source",
    AUTO_LISTING_CREDENTIAL_KEY_VERSION: "local-v1",
    SUB2API_API_KEY: "legacy-secret",
    ...overrides,
  };
}

function harness(env = enabledEnv()) {
  const calls = [];
  const pool = Object.freeze({ async query() {}, async connect() {} });
  const settingsRepository = Object.freeze({ marker: "settings-repository" });
  const profileRepository = Object.freeze({ marker: "profile-repository" });
  const cipher = Object.freeze({ encrypt() {}, decrypt() {}, fingerprint() {} });
  const capabilityResolver = Object.freeze({
    async resolveCredential(execution) { return { resolvedAttemptId: execution.attemptId }; },
  });
  const catalogResolver = Object.freeze({ async resolveCredential(lease) { return { lease }; } });
  const gateway = Object.freeze({ marker: "gateway" });
  const capabilityService = Object.freeze({ marker: "capability" });
  const settingsService = Object.freeze({ marker: "settings-service" });
  const syncService = Object.freeze({ marker: "sync-service" });
  const scheduler = Object.freeze({ marker: "scheduler" });
  const worker = Object.freeze({
    async start() { calls.push(["worker-start"]); return true; },
    async stop() { calls.push(["worker-stop"]); },
    async runOnce() {},
  });
  const runtime = createAutoListingAiSettingsRuntime({
    env,
    async getPostgresPool() { calls.push(["pool"]); return pool; },
    async loadCredentialKey(input) { calls.push(["key", input]); return Buffer.alloc(32, 7); },
    createCipher(input) { calls.push(["cipher", input]); return cipher; },
    createSettingsRepository(input) { calls.push(["settings-repository", input]); return settingsRepository; },
    createProfileRepository(input) { calls.push(["profile-repository", input]); return profileRepository; },
    createCapabilityCredentialResolver(input) {
      calls.push(["capability-resolver", input]);
      return capabilityResolver;
    },
    createCatalogCredentialResolver(input) { calls.push(["catalog-resolver", input]); return catalogResolver; },
    createGateway(input) {
      calls.push(["gateway", {
        allowLocalGateway: input.allowLocalGateway,
        allowedSecretEnvNames: input.allowedSecretEnvNames,
        allowedGatewayBaseUrls: input.allowedGatewayBaseUrls,
        legacySecret: input.readSecret("SUB2API_API_KEY"),
        hiddenSecret: input.readSecret("POSTGRES_PASSWORD"),
        resolveCapabilityCredential: input.resolveCapabilityCredential,
        resolveCatalogSyncCredential: input.resolveCatalogSyncCredential,
      }]);
      return gateway;
    },
    createProfileService(input) { calls.push(["profile-service", input]); return capabilityService; },
    createSettingsService(input) { calls.push(["settings-service", input]); return settingsService; },
    createSyncService(input) { calls.push(["sync-service", input]); return syncService; },
    createScheduler(input) { calls.push(["scheduler", input]); return scheduler; },
    createWorker(input) { calls.push(["worker", input]); return worker; },
    logger: Object.freeze({ log() {} }),
    timers: Object.freeze({ setTimeout() {}, clearTimeout() {} }),
    resolveGatewayHostname: async () => [{ address: "127.0.0.1", family: 4 }],
  });
  return { runtime, calls, pool, settingsRepository, profileRepository, cipher,
    capabilityResolver, catalogResolver, gateway, capabilityService, settingsService, syncService, scheduler };
}

test("settings runtime stays completely dormant when either feature flag is off", async () => {
  for (const env of [
    enabledEnv({ AUTO_LISTING_ENABLED: "false" }),
    enabledEnv({ AUTO_LISTING_AI_ENABLED: "false" }),
  ]) {
    const { runtime, calls } = harness(env);
    assert.deepEqual(Object.keys(runtime), ["getService", "startWorker", "stopWorker"]);
    await assert.rejects(runtime.getService(), { code: "AUTO_LISTING_AI_SETTINGS_DISABLED", status: 404 });
    assert.equal(await runtime.startWorker(), false);
    await runtime.stopWorker();
    assert.deepEqual(calls, []);
  }
});

test("settings runtime composes every Task 2-6 security port once and uses one worker identity", async () => {
  const h = harness();
  assert.equal(await h.runtime.getService(), h.settingsService);
  assert.equal(await h.runtime.getService(), h.settingsService);
  assert.equal(await h.runtime.startWorker(), true);
  await h.runtime.stopWorker();

  assert.equal(h.calls.filter(([name]) => name === "pool").length, 1);
  assert.equal(h.calls.filter(([name]) => name === "key").length, 1);
  assert.deepEqual(h.calls.find(([name]) => name === "settings-repository"),
    ["settings-repository", { pool: h.pool }]);
  assert.deepEqual(h.calls.find(([name]) => name === "profile-repository"),
    ["profile-repository", { pool: h.pool }]);
  const capabilityResolverInput = h.calls.find(([name]) => name === "capability-resolver")[1];
  assert.equal(capabilityResolverInput.repository, h.profileRepository);
  assert.equal(capabilityResolverInput.cipher, h.cipher);
  assert.equal(capabilityResolverInput.readSecret("SUB2API_API_KEY"), "legacy-secret");
  assert.equal(capabilityResolverInput.readSecret("POSTGRES_PASSWORD"), undefined);
  assert.deepEqual(h.calls.find(([name]) => name === "catalog-resolver"),
    ["catalog-resolver", { repository: h.settingsRepository, cipher: h.cipher }]);
  const gatewayInput = h.calls.find(([name]) => name === "gateway")[1];
  assert.equal(gatewayInput.allowLocalGateway, true);
  assert.deepEqual(gatewayInput.allowedSecretEnvNames, ["SUB2API_API_KEY", "SUB2API_ENCRYPTED_KEY"]);
  assert.deepEqual(gatewayInput.allowedGatewayBaseUrls, ["http://127.0.0.1:8080/v1"]);
  assert.equal(gatewayInput.legacySecret, "legacy-secret");
  assert.equal(gatewayInput.hiddenSecret, undefined);
  assert.deepEqual(await gatewayInput.resolveCapabilityCredential({ attemptId: "attempt-a" }), {
    resolvedAttemptId: "attempt-a",
  });
  assert.deepEqual(await gatewayInput.resolveCatalogSyncCredential({ taskId: "task-a" }), {
    lease: { taskId: "task-a" },
  });
  assert.deepEqual(h.calls.find(([name]) => name === "profile-service"),
    ["profile-service", { repository: h.profileRepository, gateway: h.gateway }]);
  assert.deepEqual(h.calls.find(([name]) => name === "settings-service"), ["settings-service", {
    repository: h.settingsRepository, profileRepository: h.profileRepository,
    cipher: h.cipher, capabilityService: h.capabilityService, allowLocalGateway: true,
  }]);
  const syncInput = h.calls.find(([name]) => name === "sync-service")[1];
  const workerInput = h.calls.find(([name]) => name === "worker")[1];
  assert.equal(syncInput.repository, h.settingsRepository);
  assert.equal(syncInput.gateway, h.gateway);
  assert.equal(workerInput.repository, h.settingsRepository);
  assert.equal(workerInput.scheduler, h.scheduler);
  assert.equal(workerInput.syncService, h.syncService);
  assert.equal(syncInput.workerId, workerInput.workerId);
  assert.match(syncInput.workerId, /^auto-listing-ai-model-sync-worker-v1$/u);
  assert.deepEqual(h.calls.slice(-2), [["worker-start"], ["worker-stop"]]);
});

test("settings runtime rejects local gateway in production and malformed policy before pool or key access", async () => {
  for (const env of [
    enabledEnv({ NODE_ENV: "production", AUTO_LISTING_AI_ALLOW_LOCAL_GATEWAY: "true" }),
    enabledEnv({ AUTO_LISTING_AI_ALLOW_LOCAL_GATEWAY: "sometimes" }),
    enabledEnv({ AUTO_LISTING_CREDENTIAL_KEY_VERSION: "" }),
  ]) {
    const { runtime, calls } = harness(env);
    await assert.rejects(runtime.getService(), (error) => error?.code === "AUTO_LISTING_AI_SETTINGS_CONFIGURATION_INVALID"
      && !/secret|test-key-source|legacy-secret/iu.test(error.message));
    assert.deepEqual(calls, []);
  }
});

test("settings runtime needs no legacy env-secret allowlist for encrypted UI profiles", async () => {
  const h = harness(enabledEnv({ AUTO_LISTING_AI_ALLOWED_SECRET_ENV_NAMES: "", SUB2API_API_KEY: undefined }));
  assert.equal(await h.runtime.getService(), h.settingsService);
  const gatewayInput = h.calls.find(([name]) => name === "gateway")[1];
  assert.deepEqual(gatewayInput.allowedSecretEnvNames, ["SUB2API_ENCRYPTED_KEY"]);
  assert.equal(gatewayInput.legacySecret, undefined);
});
