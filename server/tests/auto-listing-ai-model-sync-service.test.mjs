import assert from "node:assert/strict";
import test from "node:test";

import { createAutoListingAiModelSyncService } from "../auto-listing-ai-model-sync-service.mjs";

const SYNCED_AT = "2026-08-08T08:00:00.000Z";

function command(overrides = {}) {
  return {
    accountId: "account-a",
    connectionId: "connection-a",
    connectionVersion: 3,
    syncPurpose: "CATALOG_SYNC",
    targetConnectionStatusVersion: 7,
    taskId: "sync-task-a",
    attemptCount: 1,
    maxAttempts: 5,
    leaseVersion: 1,
    leaseToken: "aiglease_secret-token",
    leaseExpiresAt: "2026-08-08T08:02:00.000Z",
    correlationId: "sync-task-a:1",
    ...overrides,
  };
}

function activeConnection(overrides = {}) {
  return {
    id: "connection-a",
    accountId: "account-a",
    version: 3,
    displayName: "Local sub2API",
    baseUrl: "http://127.0.0.1:8080/v1",
    status: "ACTIVE",
    encryptedSecret: {
      algorithm: "aes-256-gcm",
      ciphertext: "cipher",
      iv: "iv",
      authTag: "tag",
      keyVersion: "local-v1",
      fingerprint: "fingerprint-a",
    },
    ...overrides,
  };
}

function enabledProfile(overrides = {}) {
  return {
    id: "profile-a",
    accountId: "account-a",
    configVersion: 4,
    enabled: true,
    connectionId: "connection-a",
    connectionVersion: 3,
    textModel: "text-a",
    imageModel: "image-a",
    ...overrides,
  };
}

function repositoryHarness({
  connection = activeConnection(), profiles = [], responseLoss = false,
  loadError = null, failError = null, completionError = null,
} = {}) {
  const state = {
    completeInputs: [],
    failInputs: [],
    overviewReads: 0,
    connectionReads: [],
    committed: null,
    failed: null,
    responseLoss,
  };
  const repository = {
    async loadCatalogSyncConnectionForSecretResolution(input) {
      state.connectionReads.push(structuredClone(input));
      if (loadError) throw loadError;
      return connection && structuredClone(connection);
    },
    async loadSettingsOverview() {
      state.overviewReads += 1;
      return { profiles: structuredClone(profiles) };
    },
    async completeModelSync(input) {
      state.completeInputs.push(structuredClone(input));
      if (completionError) throw completionError;
      if (state.committed) {
        assert.deepEqual(input, state.committed.input, "same lease replay must carry the identical result");
        return { ...structuredClone(state.committed.result), duplicate: true };
      }
      const result = {
        taskId: input.taskId,
        status: "SUCCEEDED",
        completedAt: input.capabilityResult.checkedAt,
        catalog: {
          id: "catalog-a",
          catalogHash: "a".repeat(64),
          testedAt: input.capabilityResult.checkedAt,
        },
        duplicate: false,
      };
      state.committed = { input: structuredClone(input), result: structuredClone(result) };
      if (state.responseLoss) {
        state.responseLoss = false;
        const error = new Error("database response lost after commit");
        error.code = "AUTO_LISTING_AI_SETTINGS_DATABASE_FAILED";
        error.retryable = true;
        throw error;
      }
      return result;
    },
    async failModelSync(input) {
      state.failInputs.push(structuredClone(input));
      if (failError) throw failError;
      if (state.failed) {
        assert.deepEqual(input, state.failed.input);
        return { ...structuredClone(state.failed.result), duplicate: true };
      }
      const status = input.retryable && input.retryDelayMs > 0 ? "FAILED" : "DEAD";
      const result = { taskId: input.taskId, status, duplicate: false };
      state.failed = { input: structuredClone(input), result };
      return result;
    },
  };
  return { repository, state };
}

function serviceHarness({ repositoryOptions, gatewayResult, gatewayError, recommendation } = {}) {
  const { repository, state } = repositoryHarness(repositoryOptions);
  const paid = { text: 0, image: 0, capabilities: 0, lists: 0 };
  const gateway = {
    async listModels() {
      paid.lists += 1;
      if (gatewayError) throw gatewayError;
      return gatewayResult ?? {
        requestId: "models-1",
        models: [
          { id: "text-a", ownedBy: "provider", metadata: { capabilities: ["structured_text"] } },
          { id: "image-a", ownedBy: "provider", metadata: { capabilities: ["image_generation"] } },
        ],
      };
    },
    async createTextResponse() { paid.text += 1; throw new Error("paid text call forbidden"); },
    async generateImage() { paid.image += 1; throw new Error("paid image call forbidden"); },
    async testCapabilities() { paid.capabilities += 1; throw new Error("paid capability call forbidden"); },
  };
  const service = createAutoListingAiModelSyncService({
    repository,
    gateway,
    recommendModels: recommendation ?? ((catalog) => ({
      ruleVersion: "TEST_RULE_V1",
      verified: false,
      warnings: [],
      textCandidates: catalog.models.filter((model) => model.id.startsWith("text"))
        .map((model) => ({ modelId: model.id })),
      imageCandidates: catalog.models.filter((model) => model.id.startsWith("image"))
        .map((model) => ({ modelId: model.id })),
    })),
    clock: () => new Date(SYNCED_AT),
    timeoutMs: 30_000,
    workerId: "model-sync-worker",
  });
  return { service, state, paid };
}

test("catalog synchronization persists only normalized no-cost evidence and returns a safe DTO", async () => {
  const { service, state, paid } = serviceHarness({
    repositoryOptions: { profiles: [enabledProfile()] },
    gatewayResult: {
      requestId: "models-1",
      models: [
        { id: "text-a", ownedBy: "provider", metadata: { capabilities: ["structured_text"] }, ignored: "raw" },
        { id: "image-a", ownedBy: "provider", metadata: { capabilities: ["image_generation"] } },
      ].reverse(),
    },
  });

  const result = await service.syncModelCatalog(command());

  assert.deepEqual(result, {
    taskId: "sync-task-a",
    status: "SUCCEEDED",
    modelCount: 2,
    catalogId: "catalog-a",
    syncedAt: SYNCED_AT,
    activeSelectionState: "AVAILABLE",
  });
  assert.deepEqual(paid, { text: 0, image: 0, capabilities: 0, lists: 1 });
  const persisted = state.completeInputs[0];
  assert.deepEqual(persisted.catalog.models.map((model) => model.id), ["image-a", "text-a"]);
  assert.equal(persisted.catalog.requestIdHash,
    "10a6e724ff33b4cef9058d1f70d3a9a35e578e8b93eaf6ebc46e4a1eb7ce6afa");
  assert.equal(persisted.catalog.connectionVersion, 3);
  assert.equal(persisted.catalog.syncedAt, SYNCED_AT);
  assert.equal(persisted.catalog.activeSelectionState, "AVAILABLE");
  assert.deepEqual(persisted.catalog.activeSelection, {
    profileId: "profile-a",
    configVersion: 4,
    textModel: "text-a",
    imageModel: "image-a",
  });
  assert.equal(persisted.catalog.recommendation.ruleVersion, "TEST_RULE_V1");
  assert.equal(JSON.stringify(persisted).includes("models-1"), false);
  assert.equal(JSON.stringify(persisted).includes("raw"), false);
  assert.deepEqual(persisted.capabilityResult, {
    outcome: "NOT_TESTED", checkedAt: SYNCED_AT, text: false, image: false,
  });
  assert.deepEqual(state.connectionReads, [{
    accountId: "account-a",
    taskId: "sync-task-a",
    workerId: "model-sync-worker",
    leaseVersion: 1,
    leaseToken: "aiglease_secret-token",
  }]);
});

test("model ordering produces identical catalog hash inputs and same-task replay is stable", async () => {
  const first = serviceHarness({ gatewayResult: {
    requestId: "models-1",
    models: [
      { id: "text-b", ownedBy: "x", metadata: {} },
      { id: "text-a", ownedBy: "x", metadata: {} },
    ],
  } });
  const second = serviceHarness({ gatewayResult: {
    requestId: "models-1",
    models: [
      { id: "text-a", ownedBy: "x", metadata: {} },
      { id: "text-b", ownedBy: "x", metadata: {} },
    ],
  } });

  await first.service.syncModelCatalog(command());
  await second.service.syncModelCatalog(command());
  assert.deepEqual(first.state.completeInputs[0].catalog, second.state.completeInputs[0].catalog);

  const replay = await first.service.syncModelCatalog(command());
  assert.equal(replay.status, "SUCCEEDED");
  assert.equal(first.state.completeInputs.length, 2);
});

test("successful empty and single-modal catalogs remain valid and report selection absence without mutating profiles", async () => {
  for (const models of [[], [{ id: "text-a", ownedBy: "x", metadata: {} }]]) {
    const profile = enabledProfile();
    const { service, state } = serviceHarness({
      repositoryOptions: { profiles: [profile] },
      gatewayResult: { requestId: "models-empty", models },
    });
    const result = await service.syncModelCatalog(command());
    assert.equal(result.status, "SUCCEEDED");
    assert.equal(result.modelCount, models.length);
    assert.equal(result.activeSelectionState, "MISSING");
    assert.deepEqual(profile, enabledProfile(), "synchronization must not replace the published profile");
    assert.equal(state.completeInputs[0].catalog.activeSelectionState, "MISSING");
  }

  const noSelection = serviceHarness({
    repositoryOptions: { profiles: [] },
    gatewayResult: { requestId: "models-empty", models: [] },
  });
  assert.equal((await noSelection.service.syncModelCatalog(command())).activeSelectionState, "NOT_SELECTED");
});

test("stale connection versions are dead-lettered before gateway access", async () => {
  const { service, state, paid } = serviceHarness({ repositoryOptions: { connection: null } });
  const result = await service.syncModelCatalog(command());
  assert.equal(result.status, "DEAD");
  assert.equal(paid.lists, 0);
  assert.equal(state.overviewReads, 0);
  assert.deepEqual(state.failInputs[0], {
    accountId: "account-a",
    workerId: "model-sync-worker",
    taskId: "sync-task-a",
    leaseVersion: 1,
    leaseToken: "aiglease_secret-token",
    correlationId: "sync-task-a:1",
    errorCode: "AUTO_LISTING_AI_MODEL_SYNC_CONNECTION_STALE",
    errorSafe: "active gateway connection changed",
    retryable: false,
    retryDelayMs: 0,
  });
});

test("a connection rotated after claim is classified as stale before gateway access", async () => {
  const rotated = new Error("connection changed after claim");
  rotated.code = "AUTO_LISTING_AI_SETTINGS_CONNECTION_VERSION_CONFLICT";
  rotated.retryable = false;
  const { service, state, paid } = serviceHarness({ repositoryOptions: { loadError: rotated } });
  const result = await service.syncModelCatalog(command());
  assert.equal(result.status, "DEAD");
  assert.equal(paid.lists, 0);
  assert.equal(state.overviewReads, 0);
  assert.equal(state.failInputs[0].errorCode, "AUTO_LISTING_AI_MODEL_SYNC_CONNECTION_STALE");
  assert.equal(state.failInputs[0].retryable, false);
});

test("expired or forged leases cannot resolve credentials or reach the gateway", async () => {
  const expired = new Error("leaseToken=raw-secret");
  expired.code = "AUTO_LISTING_AI_SETTINGS_CATALOG_LEASE_CONFLICT";
  expired.retryable = false;
  const failure = new Error("lease no longer owned");
  failure.code = "AUTO_LISTING_AI_SETTINGS_LEASE_CONFLICT";
  failure.retryable = false;
  const { service, paid, state } = serviceHarness({
    repositoryOptions: { loadError: expired, failError: failure },
  });
  await assert.rejects(service.syncModelCatalog(command({ leaseToken: "aiglease_forged" })), {
    code: "AUTO_LISTING_AI_SETTINGS_LEASE_CONFLICT",
  });
  assert.equal(paid.lists, 0);
  assert.equal(state.overviewReads, 0);
  assert.equal(JSON.stringify(state.failInputs).includes("raw-secret"), false);
});

test("connection rotation at completion dead-letters the old task and persists no stale catalog", async () => {
  const fence = new Error("connection changed");
  fence.code = "AUTO_LISTING_AI_SETTINGS_CONNECTION_VERSION_CONFLICT";
  fence.retryable = false;
  const { service, state } = serviceHarness({
    repositoryOptions: { completionError: fence, profiles: [enabledProfile()] },
  });
  const result = await service.syncModelCatalog(command());
  assert.equal(result.status, "DEAD");
  assert.equal(state.completeInputs.length, 1);
  assert.equal(state.failInputs[0].errorCode, "AUTO_LISTING_AI_MODEL_SYNC_CONNECTION_STALE");
  assert.equal(state.failInputs[0].retryable, false);
});

test("retryable gateway timeouts use the fixed exponential delays and attempt five becomes DEAD", async () => {
  const expected = [5_000, 15_000, 45_000, 135_000, 0];
  for (let attemptCount = 1; attemptCount <= 5; attemptCount += 1) {
    const timeout = new Error("authorization=must-not-escape");
    timeout.code = "GATEWAY_TIMEOUT";
    timeout.retryable = true;
    const { service, state } = serviceHarness({ gatewayError: timeout });
    const result = await service.syncModelCatalog(command({ attemptCount, leaseVersion: attemptCount }));
    assert.equal(result.status, attemptCount < 5 ? "FAILED" : "DEAD");
    assert.equal(state.failInputs[0].retryable, true);
    assert.equal(state.failInputs[0].retryDelayMs, expected[attemptCount - 1]);
    assert.equal(JSON.stringify(state.failInputs[0]).includes("must-not-escape"), false);
    assert.equal(state.overviewReads, 0, "a failed catalog cannot mark an active selection missing");
  }
});

test("authentication failures are non-retryable and never persist upstream text", async () => {
  const auth = new Error("api key raw-secret rejected by upstream body");
  auth.code = "NON_RETRYABLE_AUTH";
  auth.retryable = false;
  const { service, state } = serviceHarness({ gatewayError: auth });
  const result = await service.syncModelCatalog(command());
  assert.equal(result.status, "DEAD");
  assert.deepEqual(state.failInputs[0], {
    accountId: "account-a",
    workerId: "model-sync-worker",
    taskId: "sync-task-a",
    leaseVersion: 1,
    leaseToken: "aiglease_secret-token",
    correlationId: "sync-task-a:1",
    errorCode: "NON_RETRYABLE_AUTH",
    errorSafe: "gateway authentication failed",
    retryable: false,
    retryDelayMs: 0,
  });
  assert.equal(JSON.stringify(state.failInputs[0]).includes("raw-secret"), false);
});

test("a lost database response replays the committed outcome without a second gateway request", async () => {
  const { service, state, paid } = serviceHarness({
    repositoryOptions: { responseLoss: true, profiles: [enabledProfile()] },
  });
  const result = await service.syncModelCatalog(command());
  assert.equal(result.status, "SUCCEEDED");
  assert.equal(paid.lists, 1);
  assert.equal(state.completeInputs.length, 2);
  assert.deepEqual(state.completeInputs[0], state.completeInputs[1]);
});

test("service factory maps hostile proxy and accessor traps to one safe stable error", () => {
  assert.throws(() => createAutoListingAiModelSyncService(new Proxy({}, {
    getPrototypeOf() { throw new Error("authorization=raw-secret"); },
  })), (error) => error?.code === "AUTO_LISTING_AI_MODEL_SYNC_SERVICE_INVALID"
    && !/authorization|raw-secret/iu.test(error.message));

  let reads = 0;
  const config = {};
  Object.defineProperty(config, "repository", {
    enumerable: true,
    get() { reads += 1; throw new Error("ciphertext=raw-secret"); },
  });
  assert.throws(() => createAutoListingAiModelSyncService(config), {
    code: "AUTO_LISTING_AI_MODEL_SYNC_SERVICE_INVALID",
  });
  assert.equal(reads, 0);
});
