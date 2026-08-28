import assert from "node:assert/strict";
import test from "node:test";

import { createAutoListingAiSettingsService } from "../auto-listing-ai-settings-service.mjs";

const admin = Object.freeze({ id: "account-a", role: "admin" });
const user = Object.freeze({ id: "account-a", role: "user" });

function overview(overrides = {}) {
  return {
    accountId: "account-a",
    activeConnection: null,
    activeProfile: null,
    connections: [],
    catalogs: [],
    syncTasks: [],
    profiles: [],
    pageInfo: {
      connections: { pageSize: 10, next: null },
      profiles: { pageSize: 10, next: null },
    },
    ...overrides,
  };
}

function harness({ currentOverview = overview(), referencedConnections = [], connectionLoader = null,
  allowLocalGateway = true } = {}) {
  const calls = [];
  const rollbackIntents = new Map();
  const rollbackResults = new Map();
  const repository = {
    connectionIdForIntent(input) {
      calls.push(["connection-id", input]);
      return "aigconn-account-a-intent-a";
    },
    async loadSettingsOverviewPage(input) {
      calls.push(["overview", input]);
      return currentOverview;
    },
    async loadSettingsCatalog(input) {
      calls.push(["catalog", input]);
      const catalog = currentOverview.catalogs.find((row) => row.id === input.catalogId) || null;
      return catalog ? { catalog, canCreateProfile: true } : null;
    },
    async loadSettingsConnection(input) {
      calls.push(["connection", input]);
      if (connectionLoader) return connectionLoader(input);
      return [...currentOverview.connections, ...referencedConnections].find((row) => row.accountId === input.accountId
        && row.id === input.connectionId
        && row.version === input.connectionVersion) || null;
    },
    async createPendingConnection(input) {
      calls.push(["create-connection", input]);
      return {
        id: input.connectionId, accountId: input.accountId, version: 1,
        displayName: input.displayName, baseUrl: input.baseUrl, fingerprint: input.encryptedSecret.fingerprint,
        keyVersion: input.encryptedSecret.keyVersion, status: "PENDING", statusVersion: 1,
        validationResult: null, validatedAt: null, activatedAt: null, retiredAt: null,
        createdAt: "2026-08-08T00:00:00.000Z", duplicate: false,
      };
    },
    async enqueueModelSync(input) {
      calls.push(["enqueue", input]);
      return { id: "sync-a", accountId: input.accountId, connectionId: input.connectionId,
        connectionVersion: input.connectionVersion, syncPurpose: input.syncPurpose,
        targetConnectionStatusVersion: input.expectedConnectionStatusVersion,
        status: "PENDING", statusVersion: 1, attemptCount: 0, maxAttempts: 5,
        leaseVersion: 0, availableAt: null, completedAt: null, lastErrorCode: null,
        lastErrorSafe: null, createdAt: "2026-08-08T00:00:00.000Z", duplicate: false };
    },
    async createProfileFromSelection(input) {
      calls.push(["selection", input]);
      return {
        id: "profile-a", accountId: input.accountId, displayName: input.displayName,
        configVersion: 1, baseUrl: "http://127.0.0.1:8080/v1",
        apiKeyEnvName: "SUB2API_ENCRYPTED_KEY", textProtocol: input.textProtocol,
        imageProtocol: input.imageProtocol, textModel: input.textModel, imageModel: input.imageModel,
        enabled: false, capabilityResult: {}, capabilityCheckedAt: null,
        connectionId: input.connectionId, connectionVersion: input.connectionVersion,
        createdAt: "2026-08-08T00:00:00.000Z", duplicate: false,
      };
    },
    async listProfileChannels(input) {
      calls.push(["list-channels", input]);
      return { channels: [], channelCandidates: [] };
    },
    async addProfileChannel(input) {
      calls.push(["add-channel", input]);
      return { channelId: "channel-b", displayName: input.displayName, channelOrder: 2,
        enabled: true, status: "AVAILABLE", connectionDisplayName: "Gateway B",
        connectionId: input.connectionId, connectionVersion: input.connectionVersion,
        assignedItemId: null, cooldownUntil: null, requiresRevalidation: false, lastErrorCode: null };
    },
    async setProfileChannelEnabled(input) {
      calls.push(["set-channel-enabled", input]);
      return { channelId: input.channelId, displayName: "Gateway B", channelOrder: 2,
        enabled: input.enabled, status: input.enabled ? "AVAILABLE" : "DISABLED",
        connectionDisplayName: "Gateway B", connectionId: "connection-b", connectionVersion: 1,
        assignedItemId: null, cooldownUntil: null, requiresRevalidation: false, lastErrorCode: null };
    },
  };
  const profileRepository = {
    async prepareProfileRollback(input) {
      calls.push(["prepare-rollback", input]);
      const identity = `${input.profileId}\0${input.configVersion}`;
      const existing = rollbackIntents.get(input.idempotencyKey);
      if (existing && existing !== identity) {
        throw Object.assign(new Error("conflict"), { code: "AUTO_LISTING_AI_ADMIN_IDEMPOTENCY_CONFLICT", status: 409 });
      }
      rollbackIntents.set(input.idempotencyKey, identity);
      return rollbackResults.has(input.idempotencyKey)
        ? { completed: true, duplicate: true, profile: rollbackResults.get(input.idempotencyKey) }
        : { completed: false, duplicate: Boolean(existing), profile: null };
    },
    async publishProfile(input) {
      calls.push(["publish", input]);
      return { id: input.profileId, accountId: input.accountId, displayName: "Profile A",
        configVersion: input.configVersion, baseUrl: "http://127.0.0.1:8080/v1",
        apiKeyEnvName: "SUB2API_ENCRYPTED_KEY", textProtocol: "SUB2API_RESPONSES",
        imageProtocol: "SUB2API_OPENAI_IMAGES", textModel: "text-a", imageModel: "image-a",
        enabled: true, capabilityResult: { outcome: "PASSED" }, capabilityCheckedAt: "2026-08-08T00:00:00.000Z",
        connectionId: "connection-a", connectionVersion: 1, createdAt: "2026-08-08T00:00:00.000Z",
        duplicate: false };
    },
    async rollbackProfile(input) {
      calls.push(["rollback", input]);
      const row = { ...await this.publishProfile(input), activation: {
        kind: "ROLLBACK", occurredAt: "2026-08-09T03:04:05.000Z", actorId: input.accountId,
      } };
      rollbackResults.set(input.idempotencyKey, row);
      return row;
    },
  };
  const cipher = {
    encrypt(scope, plaintext) {
      calls.push(["encrypt", scope, plaintext]);
      return { algorithm: "aes-256-gcm", ciphertext: "ciphertext-safe", iv: "iv-safe",
        authTag: "tag-safe", keyVersion: "local-v1" };
    },
    fingerprint(plaintext) { calls.push(["fingerprint", plaintext]); return "fingerprint-safe"; },
  };
      const capabilityService = {
    async testGatewayCapabilities(input) {
      calls.push(["capability", input]);
      return { profileId: input.profileId, configVersion: input.configVersion, outcome: "PASSED",
        features: ["STRUCTURED_TEXT", "IMAGE_GENERATION", "IMAGE_DECODE_PNG"], latencyMs: 10,
        models: { text: "text-a", image: "image-a" }, checkedAt: "2026-08-08T00:00:00.000Z",
        errorCode: null, enabled: false };
    },
  };
  const service = createAutoListingAiSettingsService({
    repository, profileRepository, cipher, capabilityService, allowLocalGateway,
  });
  return { service, calls, repository, profileRepository, cipher, capabilityService };
}

test("ordinary users are rejected before settings persistence, encryption, or paid gateway work", async () => {
  const { service, calls } = harness();
  const operations = [
    () => service.getOverview({ actor: user }),
    () => service.createConnection({ actor: user, idempotencyKey: "intent-a", correlationId: "corr-a",
      displayName: "Local gateway", baseUrl: "http://127.0.0.1:8080/v1", gatewayKey: "raw-key" }),
    () => service.requestModelSync({ actor: user, connectionId: "connection-a", connectionVersion: 1,
      idempotencyKey: "sync-a", correlationId: "corr-a" }),
    () => service.testProfile({ actor: user, profileId: "profile-a", configVersion: 1,
      correlationId: "corr-a", costConfirmed: true }),
  ];
  for (const operation of operations) {
    await assert.rejects(operation, (error) => error?.code === "PERMISSION_FORBIDDEN");
  }
  assert.deepEqual(calls, []);
});

test("connection creation encrypts with the immutable connection scope and never reads raw secrets back", async () => {
  const { service, calls } = harness();
  const result = await service.createConnection({ actor: admin, idempotencyKey: "intent-a",
    correlationId: "corr-a", displayName: "Local gateway",
    baseUrl: "http://127.0.0.1:8080/v1", gatewayKey: "raw-gateway-key" });

  assert.deepEqual(calls[0], ["connection-id", { accountId: "account-a", idempotencyKey: "intent-a" }]);
  assert.deepEqual(calls[1], ["encrypt", {
    accountId: "account-a", connectionId: "aigconn-account-a-intent-a", connectionVersion: 1,
  }, "raw-gateway-key"]);
  assert.deepEqual(calls[2], ["fingerprint", "raw-gateway-key"]);
  const persisted = calls.find(([name]) => name === "create-connection")[1];
  assert.equal(persisted.gatewayKey, undefined);
  assert.equal(persisted.encryptedSecret.ciphertext, "ciphertext-safe");
  assert.equal(JSON.stringify(result).includes("raw-gateway-key"), false);
  assert.equal(JSON.stringify(result).includes("ciphertext-safe"), false);
});

test("connection creation rejects unsafe gateway base URLs at the service boundary before encryption", async () => {
  for (const baseUrl of [
    "not-a-url",
    "ftp://gateway.example/v1",
    "https://user:password@gateway.example/v1",
    "https://gateway.example/v1?redirect=https://evil.example",
    "https://gateway.example/v1#secret",
    "http://127.0.0.1:8080/v1",
  ]) {
    const { service, calls } = harness({ allowLocalGateway: false });
    await assert.rejects(service.createConnection({ actor: admin, idempotencyKey: "intent-a",
      correlationId: "corr-a", displayName: "Gateway", baseUrl, gatewayKey: "raw-gateway-key" }),
    (error) => error?.code === "AUTO_LISTING_AI_SETTINGS_BASE_URL_INVALID" && error?.status === 422);
    assert.deepEqual(calls, []);
  }
  const { service, calls } = harness({ allowLocalGateway: true });
  await service.createConnection({ actor: admin, idempotencyKey: "intent-local",
    correlationId: "corr-local", displayName: "Local gateway",
    baseUrl: "http://127.0.0.1:8080/v1/", gatewayKey: "raw-gateway-key" });
  assert.equal(calls.find(([name]) => name === "create-connection")[1].baseUrl,
    "http://127.0.0.1:8080/v1");
});

test("manual model synchronization uses the exact PENDING VALIDATED or ACTIVE fence and never invokes paid capability work", async () => {
  for (const connection of [
    { id: "connection-a", accountId: "account-a", version: 1, status: "PENDING", statusVersion: 1 },
    { id: "connection-a", accountId: "account-a", version: 1, status: "VALIDATED", statusVersion: 2 },
    { id: "connection-a", accountId: "account-a", version: 1, status: "ACTIVE", statusVersion: 3 },
  ]) {
    const { service, calls } = harness({ currentOverview: overview({ connections: [connection] }) });
    const result = await service.requestModelSync({ actor: admin, connectionId: "connection-a",
      connectionVersion: 1, idempotencyKey: `sync-${connection.status}`, correlationId: "corr-a" });
    const enqueue = calls.find(([name]) => name === "enqueue")[1];
    assert.equal(enqueue.syncPurpose, "CATALOG_SYNC");
    assert.equal(enqueue.expectedConnectionStatusVersion, connection.statusVersion);
    assert.equal(enqueue.maxAttempts, 5);
    assert.equal(calls.some(([name]) => name === "capability"), false);
    assert.equal(result.status, "PENDING");
  }
});

test("manual synchronization rejects RETIRED, stale, or cross-account connection evidence before enqueue", async () => {
  for (const connection of [
    { id: "connection-a", accountId: "account-a", version: 1, status: "RETIRED", statusVersion: 4 },
    { id: "connection-a", accountId: "account-b", version: 1, status: "PENDING", statusVersion: 1 },
  ]) {
    const { service, calls } = harness({ currentOverview: overview({ connections: [connection] }) });
    await assert.rejects(
      service.requestModelSync({ actor: admin, connectionId: "connection-a", connectionVersion: 1,
        idempotencyKey: "sync-a", correlationId: "corr-a" }),
      (error) => ["AUTO_LISTING_AI_SETTINGS_CONNECTION_NOT_SYNCABLE",
        "AUTO_LISTING_AI_SETTINGS_CONNECTION_NOT_FOUND"].includes(error?.code),
    );
    assert.equal(calls.some(([name]) => name === "enqueue"), false);
  }
});

test("profile selection is passed to the exact catalog-binding repository with the encrypted sentinel supplied by persistence", async () => {
  const { service, calls } = harness();
  const result = await service.createProfileSelection({ actor: admin, connectionId: "connection-a",
    connectionVersion: 1, catalogId: "catalog-a", displayName: "Profile A", textModel: "text-a",
    imageModel: "image-a", textProtocol: "SUB2API_RESPONSES", imageProtocol: "SUB2API_OPENAI_IMAGES",
    idempotencyKey: "profile-intent-a", correlationId: "corr-a" });
  const persisted = calls.find(([name]) => name === "selection")[1];
  assert.deepEqual(Object.keys(persisted).sort(), ["accountId", "actorId", "catalogId", "connectionId",
    "connectionVersion", "correlationId", "displayName", "idempotencyKey", "imageModel",
    "imageProtocol", "textModel", "textProtocol"].sort());
  assert.equal(result.apiKeyEnvName, undefined);
  assert.equal(result.connectionId, "connection-a");
});

test("paid capability testing requires explicit cost confirmation and replays by correlation without sync coupling", async () => {
  const { service, calls } = harness();
  await assert.rejects(
    service.testProfile({ actor: admin, profileId: "profile-a", configVersion: 1,
      correlationId: "capability-intent-a", costConfirmed: false }),
    (error) => error?.code === "AUTO_LISTING_AI_SETTINGS_COST_CONFIRMATION_REQUIRED" && error?.status === 409,
  );
  assert.equal(calls.some(([name]) => name === "capability"), false);

  const first = await service.testProfile({ actor: admin, profileId: "profile-a", configVersion: 1,
    correlationId: "capability-intent-a", costConfirmed: true });
  const second = await service.testProfile({ actor: admin, profileId: "profile-a", configVersion: 1,
    correlationId: "capability-intent-a", costConfirmed: true });
  assert.equal(first.outcome, "PASSED");
  assert.deepEqual(second, first);
  assert.equal(calls.filter(([name]) => name === "capability").length, 2,
    "the delegated capability attempt owns durable replay and may be safely called again");
  assert.equal(calls.find(([name]) => name === "capability")[1].purpose, "PROFILE_CAPABILITY");
  assert.equal(calls.some(([name]) => name === "enqueue"), false);
});

test("publish delegates only exact profile/config intents and rollback always runs a confirmed capability attempt first", async () => {
  const { service, calls } = harness();
  const published = await service.publishProfile({ actor: admin, profileId: "profile-a", configVersion: 1,
    idempotencyKey: "publish-a", correlationId: "corr-publish-a" });
  assert.equal(published.enabled, true);

  await assert.rejects(
    service.rollbackProfile({ actor: admin, profileId: "profile-a", configVersion: 1,
      idempotencyKey: "rollback-a", correlationId: "corr-rollback-a", costConfirmed: false }),
    (error) => error?.code === "AUTO_LISTING_AI_SETTINGS_COST_CONFIRMATION_REQUIRED",
  );
  const rolledBack = await service.rollbackProfile({ actor: admin, profileId: "profile-a", configVersion: 1,
    idempotencyKey: "rollback-a", correlationId: "corr-rollback-a", costConfirmed: true });
  assert.equal(rolledBack.enabled, true);
  const capabilityIndex = calls.findIndex(([name]) => name === "capability");
  const rollbackIndex = calls.findIndex(([name]) => name === "rollback");
  assert.ok(capabilityIndex >= 0 && rollbackIndex > capabilityIndex);
  assert.match(calls[capabilityIndex][1].correlationId, /^rollback-capability:[a-f0-9]{40}$/u);
  assert.equal(calls[capabilityIndex][1].purpose, "ROLLBACK_CAPABILITY");
});

test("rollback reserves idempotency before paid work and replays across changed correlation", async () => {
  const { service, calls } = harness();
  const first = await service.rollbackProfile({ actor: admin, profileId: "profile-a", configVersion: 1,
    idempotencyKey: "rollback-stable-a", correlationId: "corr-first", costConfirmed: true });
  const replay = await service.rollbackProfile({ actor: admin, profileId: "profile-a", configVersion: 1,
    idempotencyKey: "rollback-stable-a", correlationId: "corr-response-loss", costConfirmed: true });
  assert.deepEqual(replay, first);
  assert.deepEqual(replay.activation, first.activation);
  assert.equal(calls.filter(([name]) => name === "capability").length, 1);

  await assert.rejects(service.rollbackProfile({ actor: admin, profileId: "different-profile",
    configVersion: 1, idempotencyKey: "rollback-stable-a", correlationId: "corr-conflict",
    costConfirmed: true }), { code: "AUTO_LISTING_AI_ADMIN_IDEMPOTENCY_CONFLICT" });
  assert.equal(calls.filter(([name]) => name === "capability").length, 1,
    "a conflicting target must be rejected by the reserved command before paid gateway work");
});

test("overview returns an account-scoped closed DTO with explicit server action gates", async () => {
  const currentOverview = overview({
    connections: [{ id: "connection-a", accountId: "account-a", version: 1,
      status: "VALIDATED", statusVersion: 2 }],
    catalogs: [{ id: "catalog-a", accountId: "account-a", connectionId: "connection-a",
      connectionVersion: 1, catalog: { models: [] }, capabilityResult: { outcome: "NOT_TESTED" } }],
  });
  const { service } = harness({ currentOverview });
  const result = await service.getOverview({ actor: admin });
  assert.equal(result.accountId, "account-a");
  assert.deepEqual(result.actions, {
    canCreateConnection: true,
    syncableConnectionIds: ["connection-a"],
    profileCreatableCatalogIds: [],
    testableProfileIds: [],
    publishableProfileIds: [],
    rollbackProfileIds: [],
  });
  assert.equal(JSON.stringify(result).includes("ciphertext"), false);
});

test("channel membership is scoped to the exact active profile version and exposes only bounded safe DTOs", async () => {
  const currentOverview = overview({ activeProfile: { id: "profile-a", accountId: "account-a", configVersion: 3,
    connectionId: "connection-a", connectionVersion: 1, enabled: true }, });
  const { service, repository } = harness({ currentOverview });
  repository.listProfileChannels = async (input) => ({
    channels: [{ channelId: "primary", displayName: "Primary", channelOrder: 1, enabled: true,
      status: "AVAILABLE", connectionDisplayName: "Gateway A", connectionId: "connection-a", connectionVersion: 1,
      assignedItemId: null, cooldownUntil: null, requiresRevalidation: false, lastErrorCode: null,
      ciphertext: "must-not-leak" }],
    channelCandidates: [{ connectionId: "connection-b", connectionVersion: 2, connectionDisplayName: "Gateway B",
      baseUrl: "https://must-not-leak.example/v1" }],
  });
  const result = await service.getOverview({ actor: admin });
  assert.deepEqual(result.channels, [{ channelId: "primary", displayName: "Primary", channelOrder: 1, enabled: true,
    status: "AVAILABLE", connectionDisplayName: "Gateway A", connectionId: "connection-a", connectionVersion: 1,
    assignedItemId: null, cooldownUntil: null, requiresRevalidation: false, lastErrorCode: null }]);
  assert.deepEqual(result.channelCandidates, [{ connectionId: "connection-b", connectionVersion: 2,
    connectionDisplayName: "Gateway B" }]);
  assert.equal(JSON.stringify(result).includes("must-not-leak"), false);
});

test("channel commands retain account and exact profile-version fences", async () => {
  const { service, calls } = harness();
  const added = await service.addProfileChannel({ actor: admin, profileId: "profile-a", profileVersion: 1,
    connectionId: "connection-b", connectionVersion: 2, displayName: "Gateway B" });
  assert.equal(added.channelId, "channel-b");
  assert.deepEqual(calls.find(([name]) => name === "add-channel")[1], {
    accountId: "account-a", actorAccountId: "account-a", profileId: "profile-a", profileVersion: 1,
    connectionId: "connection-b", connectionVersion: 2, displayName: "Gateway B",
  });
  const updated = await service.setProfileChannelEnabled({ actor: admin, profileId: "profile-a", profileVersion: 1,
    channelId: "channel-b", enabled: false });
  assert.equal(updated.enabled, false);
  assert.deepEqual(calls.find(([name]) => name === "set-channel-enabled")[1], {
    accountId: "account-a", actorAccountId: "account-a", profileId: "profile-a", profileVersion: 1,
    channelId: "channel-b", enabled: false,
  });
});

test("settings service requires every channel repository operation", () => {
  const h = harness();
  delete h.repository.listProfileChannels;
  assert.throws(() => createAutoListingAiSettingsService({ repository: h.repository,
    profileRepository: h.profileRepository, cipher: h.cipher, capabilityService: h.capabilityService,
    allowLocalGateway: true }), /settings service dependencies/u);
});

test("overview preserves only the repository activation evidence for the exact account profile version", async () => {
  const activation = { kind: "PUBLISH", occurredAt: "2026-08-09T02:03:04.000Z", actorId: "account-a" };
  const currentOverview = overview({
    profiles: [{ id: "profile-a", accountId: "account-a", configVersion: 1,
      connectionId: null, connectionVersion: null, textModel: "text-a", imageModel: "image-a",
      enabled: true, capabilityResult: {}, activation }],
  });
  const { service } = harness({ currentOverview });

  const result = await service.getOverview({ actor: admin });

  assert.deepEqual(result.profiles[0].activation, activation);
  assert.equal(result.profiles[0].createdAt, undefined,
    "the service must not invent an activation from a configuration creation timestamp");
  assert.deepEqual(result.actions.testableProfileIds, []);
  assert.deepEqual(result.actions.publishableProfileIds, []);
});

test("ACTIVE directory drift exposes only the closed successor workflow while the current profile stays enabled", async () => {
  const currentOverview = overview({
    activeConnection: { id: "connection-a", accountId: "account-a", version: 1,
      status: "ACTIVE", statusVersion: 3 },
    connections: [{ id: "connection-a", accountId: "account-a", version: 1,
      status: "ACTIVE", statusVersion: 3 }],
    catalogs: [{ id: "catalog-latest", accountId: "account-a", connectionId: "connection-a",
      connectionVersion: 1, syncTaskId: "catalog-task", catalog: {
        models: [{ id: "text-new" }, { id: "image-new" }],
      } }],
    syncTasks: [{ id: "catalog-task", accountId: "account-a", connectionId: "connection-a",
      connectionVersion: 1, syncPurpose: "CATALOG_SYNC", status: "SUCCEEDED" }],
    profiles: [
      { id: "profile-current", accountId: "account-a", connectionId: "connection-a",
        connectionVersion: 1, textModel: "text-old", imageModel: "image-old", enabled: true,
        capabilityResult: { outcome: "PASSED" } },
      { id: "profile-successor", accountId: "account-a", connectionId: "connection-a",
        connectionVersion: 1, textModel: "text-new", imageModel: "image-new", enabled: false,
        capabilityResult: { outcome: "PASSED" } },
    ],
  });
  const { service } = harness({ currentOverview });
  const result = await service.getOverview({ actor: admin });

  assert.deepEqual(result.actions, {
    canCreateConnection: true,
    syncableConnectionIds: ["connection-a"],
    profileCreatableCatalogIds: ["catalog-latest"],
    testableProfileIds: ["profile-successor"],
    publishableProfileIds: ["profile-successor"],
    rollbackProfileIds: [],
  });
  assert.equal(currentOverview.profiles[0].enabled, true);
});

test("an unverified ACTIVE successor can be tested but cannot replace the current profile", async () => {
  for (const capabilityResult of [
    { outcome: "NOT_TESTED" },
    { outcome: "FAILED" },
  ]) {
    const currentOverview = overview({
      connections: [{ id: "connection-a", accountId: "account-a", version: 1,
        status: "ACTIVE", statusVersion: 3 }],
      catalogs: [{ id: "catalog-latest", accountId: "account-a", connectionId: "connection-a",
        connectionVersion: 1, syncTaskId: "catalog-task",
        catalog: { models: [{ id: "text-new" }, { id: "image-new" }] } }],
      syncTasks: [{ id: "catalog-task", accountId: "account-a", connectionId: "connection-a",
        connectionVersion: 1, syncPurpose: "CATALOG_SYNC", status: "SUCCEEDED" }],
      profiles: [
        { id: "profile-current", accountId: "account-a", connectionId: "connection-a",
          connectionVersion: 1, textModel: "text-old", imageModel: "image-old", enabled: true,
          capabilityResult: { outcome: "PASSED" } },
        { id: "profile-successor", accountId: "account-a", connectionId: "connection-a",
          connectionVersion: 1, textModel: "text-new", imageModel: "image-new", enabled: false,
          capabilityResult },
      ],
    });
    const { service } = harness({ currentOverview });
    const actions = (await service.getOverview({ actor: admin })).actions;
    assert.deepEqual(actions.testableProfileIds, ["profile-successor"]);
    assert.deepEqual(actions.publishableProfileIds, []);
    assert.equal(currentOverview.profiles[0].enabled, true);
  }
});

test("overview action gates use only the latest successful catalog sync evidence", async () => {
  const currentOverview = overview({
    connections: [{ id: "connection-a", accountId: "account-a", version: 1,
      status: "VALIDATED", statusVersion: 2 }],
    catalogs: [
      { id: "rollback-catalog", accountId: "account-a", connectionId: "connection-a",
        connectionVersion: 1, syncTaskId: "rollback-task", catalog: { models: [] } },
      { id: "catalog-a", accountId: "account-a", connectionId: "connection-a",
        connectionVersion: 1, syncTaskId: "catalog-task", catalog: {
          models: [{ id: "text-a" }, { id: "image-a" }],
        } },
    ],
    syncTasks: [
      { id: "rollback-task", accountId: "account-a", syncPurpose: "ROLLBACK_CAPABILITY", status: "SUCCEEDED" },
      { id: "catalog-task", accountId: "account-a", syncPurpose: "CATALOG_SYNC", status: "SUCCEEDED" },
    ],
    profiles: [{ id: "profile-a", accountId: "account-a", connectionId: "connection-a",
      connectionVersion: 1, textModel: "text-a", imageModel: "image-a",
      capabilityResult: { outcome: "PASSED" } }],
  });
  const { service } = harness({ currentOverview });
  const result = await service.getOverview({ actor: admin });
  assert.deepEqual(result.actions.testableProfileIds, ["profile-a"]);
  assert.deepEqual(result.actions.publishableProfileIds, ["profile-a"]);
});

test("overview actions include the independent ACTIVE connection without adding it to the paged connection DTO", async () => {
  const currentOverview = overview({
    activeConnection: { id: "connection-active", accountId: "account-a", version: 2,
      status: "ACTIVE", statusVersion: 7 },
    connections: [],
    catalogs: [{ id: "catalog-active", accountId: "account-a", connectionId: "connection-active",
      connectionVersion: 2, syncTaskId: "task-active",
      catalog: { models: [{ id: "text-active" }, { id: "image-active" }] } }],
    syncTasks: [{ id: "task-active", accountId: "account-a", connectionId: "connection-active",
      connectionVersion: 2, syncPurpose: "CATALOG_SYNC", status: "SUCCEEDED" }],
    profiles: [{ id: "profile-successor", accountId: "account-a", connectionId: "connection-active",
      connectionVersion: 2, textModel: "text-active", imageModel: "image-active", enabled: false,
      capabilityResult: { outcome: "PASSED" } }],
  });
  const { service } = harness({ currentOverview });

  const result = await service.getOverview({ actor: admin });

  assert.deepEqual(result.connections, []);
  assert.equal(result.activeConnection.id, "connection-active");
  assert.deepEqual(result.actions, {
    canCreateConnection: true,
    syncableConnectionIds: ["connection-active"],
    profileCreatableCatalogIds: ["catalog-active"],
    testableProfileIds: ["profile-successor"],
    publishableProfileIds: ["profile-successor"],
    rollbackProfileIds: [],
  });
});

test("overview resolves only exact off-page connection references for profile actions", async () => {
  const currentOverview = overview({
    connections: [{ id: "connection-visible", accountId: "account-a", version: 1,
      status: "PENDING", statusVersion: 1 }],
    catalogs: [
      { id: "catalog-validated", accountId: "account-a", connectionId: "connection-validated",
        connectionVersion: 3, syncTaskId: "task-validated",
        catalog: { models: [{ id: "text-v" }, { id: "image-v" }] } },
      { id: "catalog-retired", accountId: "account-a", connectionId: "connection-retired",
        connectionVersion: 4, syncTaskId: "task-retired",
        catalog: { models: [{ id: "text-r" }, { id: "image-r" }] } },
    ],
    syncTasks: [
      { id: "task-validated", accountId: "account-a", connectionId: "connection-validated",
        connectionVersion: 3, syncPurpose: "CATALOG_SYNC", status: "SUCCEEDED" },
      { id: "task-retired", accountId: "account-a", connectionId: "connection-retired",
        connectionVersion: 4, syncPurpose: "CATALOG_SYNC", status: "SUCCEEDED" },
    ],
    profiles: [
      { id: "profile-validated", accountId: "account-a", connectionId: "connection-validated",
        connectionVersion: 3, textModel: "text-v", imageModel: "image-v", enabled: false,
        capabilityResult: { outcome: "PASSED" } },
      { id: "profile-retired", accountId: "account-a", connectionId: "connection-retired",
        connectionVersion: 4, textModel: "text-r", imageModel: "image-r", enabled: false,
        capabilityResult: { outcome: "PASSED" } },
    ],
  });
  const referencedConnections = [
    { id: "connection-validated", accountId: "account-a", version: 3,
      status: "VALIDATED", statusVersion: 2 },
    { id: "connection-retired", accountId: "account-a", version: 4,
      status: "RETIRED", statusVersion: 9 },
    { id: "connection-unrelated", accountId: "account-a", version: 1,
      status: "ACTIVE", statusVersion: 3 },
  ];
  const { service, calls } = harness({ currentOverview, referencedConnections });

  const result = await service.getOverview({ actor: admin });

  assert.deepEqual(result.connections.map((row) => row.id), ["connection-visible"]);
  assert.deepEqual(result.actions.syncableConnectionIds, ["connection-visible"],
    "off-page references must not leak into the public sync action allowlist");
  assert.deepEqual(result.actions.profileCreatableCatalogIds, ["catalog-validated"]);
  assert.deepEqual(result.actions.testableProfileIds, ["profile-validated"]);
  assert.deepEqual(result.actions.publishableProfileIds, ["profile-validated"]);
  assert.deepEqual(result.actions.rollbackProfileIds, ["profile-retired"]);
  assert.deepEqual(calls.filter(([name]) => name === "connection").map(([, input]) => input), [
    { accountId: "account-a", connectionId: "connection-validated", connectionVersion: 3 },
    { accountId: "account-a", connectionId: "connection-retired", connectionVersion: 4 },
  ]);
  assert.equal(JSON.stringify(result).includes("connection-unrelated"), false);
});

test("overview action reference resolution fails closed for missing, malformed, mismatched, and foreign evidence", async () => {
  const missingOverview = overview({
    profiles: [{ id: "profile-missing", accountId: "account-a", connectionId: "connection-missing",
      connectionVersion: 1, textModel: "text-a", imageModel: "image-a", enabled: false,
      capabilityResult: { outcome: "PASSED" } }],
  });
  const missing = harness({ currentOverview: missingOverview });
  assert.deepEqual((await missing.service.getOverview({ actor: admin })).actions, {
    canCreateConnection: true, syncableConnectionIds: [], profileCreatableCatalogIds: [],
    testableProfileIds: [], publishableProfileIds: [], rollbackProfileIds: [],
  });

  const malformed = harness({ currentOverview: overview({
    profiles: [{ id: "profile-malformed", accountId: "account-a", connectionId: "../foreign",
      connectionVersion: 1, textModel: "text-a", imageModel: "image-a", enabled: false,
      capabilityResult: { outcome: "PASSED" } }],
  }) });
  await assert.rejects(malformed.service.getOverview({ actor: admin }), {
    code: "AUTO_LISTING_AI_SETTINGS_DATA_BOUNDARY", status: 500,
  });
  assert.equal(malformed.calls.some(([name]) => name === "connection"), false);

  for (const maliciousConnection of [
    { id: "different-connection", accountId: "account-a", version: 1,
      status: "VALIDATED", statusVersion: 2 },
    { id: "connection-missing", accountId: "account-b", version: 1,
      status: "VALIDATED", statusVersion: 2 },
  ]) {
    const currentOverview = overview({
      profiles: [{ id: "profile-mismatch", accountId: "account-a", connectionId: "connection-missing",
        connectionVersion: 1, textModel: "text-a", imageModel: "image-a", enabled: false,
        capabilityResult: { outcome: "PASSED" } }],
    });
    const checked = harness({ currentOverview, connectionLoader: () => maliciousConnection });
    await assert.rejects(checked.service.getOverview({ actor: admin }), {
      code: "AUTO_LISTING_AI_SETTINGS_DATA_BOUNDARY", status: 500,
    });
  }
});
