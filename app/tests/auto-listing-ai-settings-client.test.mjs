import assert from "node:assert/strict";
import test from "node:test";

import {
  AI_SETTINGS_SAFE_ERROR_CODES,
  addAutoListingAiChannel,
  createAiSettingsIntentStore,
  createGatewayConnection,
  createModelProfile,
  loadAiSettings,
  loadAiSettingsCatalog,
  pollAiSettingsUntil,
  publishModelProfile,
  requestModelSync,
  rollbackModelProfile,
  setAutoListingAiChannelEnabled,
  testModelProfile,
} from "../src/auto-listing-ai-settings-client.js";
import { AUTO_LISTING_AI_SETTINGS_SAFE_CODES } from "../../server/auto-listing-ai-settings-routes.mjs";
import { createAutoListingAiSettingsService } from "../../server/auto-listing-ai-settings-service.mjs";
import { createAutoListingAiSettingsPostgres } from "../../server/auto-listing-ai-settings-postgres.mjs";
import { createAutoListingAiAdminPostgres } from "../../server/auto-listing-ai-admin-postgres.mjs";
import { recommendAutoListingModels } from "../../server/auto-listing-ai-model-recommendation.mjs";

const CHECKED_AT = "2026-08-08T00:00:00.000Z";
const CATALOG_HASH = "a".repeat(64);
const CAPABILITY_HASH = "b".repeat(64);
const PAID_FEATURES = Object.freeze(["STRUCTURED_TEXT", "IMAGE_GENERATION", "IMAGE_DECODE_PNG"]);
const PAID_ERROR_CODES = Object.freeze([
  "AI_GATEWAY_CAPABILITY_FAILED", "AI_GATEWAY_PROFILE_INVALID", "AI_GATEWAY_PROFILE_DISABLED",
  "AI_GATEWAY_REQUEST_INVALID", "AI_GATEWAY_SECRET_MISSING", "AI_GATEWAY_PROTOCOL_UNSUPPORTED",
  "AI_GATEWAY_MODEL_MISMATCH", "AI_GATEWAY_INPUT_UNSUPPORTED", "GATEWAY_REDIRECT_BLOCKED",
  "GATEWAY_TIMEOUT", "GATEWAY_CANCELLED", "RETRYABLE_GATEWAY", "NON_RETRYABLE_AUTH",
  "NON_RETRYABLE_GATEWAY", "INVALID_GATEWAY_RESPONSE",
]);

function memoryStorage() {
  const values = new Map();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key), dump: () => Object.fromEntries(values) };
}

function response(data, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify({ ok: true, data }) };
}

function connection(overrides = {}) {
  return { id: "connection-a", accountId: "account-a", version: 1, displayName: "本地 sub2API",
    baseUrl: "http://127.0.0.1:8080/v1", fingerprint: "fingerprint-a", keyVersion: "local-v1",
    status: "PENDING", statusVersion: 1, validationResult: null, validatedAt: null, activatedAt: null,
    retiredAt: null, createdAt: "2026-08-08T00:00:00.000Z", duplicate: false, ...overrides };
}

function syncTask(overrides = {}) {
  return { id: "sync-a", accountId: "account-a", connectionId: "connection-a", connectionVersion: 1,
    syncPurpose: "CATALOG_SYNC", targetConnectionStatusVersion: 1, status: "PENDING", statusVersion: 1,
    attemptCount: 0, maxAttempts: 5, leaseVersion: 0, availableAt: CHECKED_AT, completedAt: null, lastErrorCode: null,
    lastErrorSafe: null, createdAt: CHECKED_AT, duplicate: false, ...overrides };
}

function profile(overrides = {}) {
  return { id: "profile-a", accountId: "account-a", displayName: "商品图模型", configVersion: 1,
    baseUrl: "http://127.0.0.1:8080/v1", textProtocol: "SUB2API_RESPONSES", imageProtocol: "SUB2API_OPENAI_IMAGES",
    textModel: "text-a", imageModel: "image-a", enabled: false, capabilityResult: {}, capabilityCheckedAt: null,
    connectionId: "connection-a", connectionVersion: 1, activation: null,
    createdAt: "2026-08-08T00:00:00.000Z", duplicate: false, ...overrides };
}

function capability(overrides = {}) {
  return { profileId: "profile-a", configVersion: 1, outcome: "PASSED",
    features: [...PAID_FEATURES], latencyMs: 123,
    models: { text: "text-a", image: "image-a" }, checkedAt: CHECKED_AT,
    errorCode: null, enabled: false, ...overrides };
}

function paidCapability(overrides = {}) {
  return { outcome: "PASSED", features: [...PAID_FEATURES], latencyMs: 123,
    models: { text: "text-a", image: "image-a" }, checkedAt: CHECKED_AT,
    errorCode: null, ...overrides };
}

function channel(overrides = {}) {
  return { channelId: "channel-a", displayName: "备用 Gateway", channelOrder: 2, enabled: true,
    status: "AVAILABLE", connectionDisplayName: "备用 sub2API", connectionId: "connection-b", connectionVersion: 2,
    assignedItemId: null, cooldownUntil: null, requiresRevalidation: false, lastErrorCode: null, ...overrides };
}

function channelCandidate(overrides = {}) {
  return { connectionId: "connection-b", connectionVersion: 2,
    connectionDisplayName: "备用 sub2API", ...overrides };
}

function catalogCapability(overrides = {}) {
  return { outcome: "NOT_TESTED", checkedAt: CHECKED_AT, text: false, image: false, ...overrides };
}

function rollbackCapability(overrides = {}) {
  return { schemaVersion: "AI_GATEWAY_ROLLBACK_TEST_RESULT_V1", outcome: "PASSED", checkedAt: CHECKED_AT,
    connectionId: "connection-rollback", connectionVersion: 1,
    checks: { authentication: true, modelsEndpoint: true }, ...overrides };
}

function catalogEnvelope(overrides = {}) {
  const models = [
    { id: "image-a", ownedBy: "", metadata: {} },
    { id: "text-a", ownedBy: "", metadata: {} },
  ];
  return { schemaVersion: "AUTO_LISTING_AI_MODEL_CATALOG_V1", connectionVersion: 1,
    syncedAt: CHECKED_AT, requestIdHash: "c".repeat(64), activeSelectionState: "NOT_SELECTED",
    activeSelection: null, models, recommendation: recommendAutoListingModels({ models }), ...overrides };
}

function legacyV1CatalogEnvelope() {
  const models = [
    { id: "image-a", ownedBy: "", metadata: {} },
    { id: "text-a", ownedBy: "", metadata: {} },
  ];
  return catalogEnvelope({
    models,
    recommendation: {
      ruleVersion: "AUTO_LISTING_MODEL_RECOMMENDATION_V1",
      verified: false,
      warnings: ["RECOMMENDATIONS_UNVERIFIED"],
      textCandidates: [{ modelId: "text-a", score: 10, confidence: "LOW", verified: false,
        reasonCodes: ["MODEL_ID_TEXT_HINT"] }],
      imageCandidates: [{ modelId: "image-a", score: 10, confidence: "LOW", verified: false,
        reasonCodes: ["MODEL_ID_IMAGE_HINT"] }],
    },
  });
}

function oauthV2CatalogEnvelope() {
  const models = [
    { id: "gpt-5.4", ownedBy: "openai", metadata: {} },
    { id: "gpt-5.5", ownedBy: "openai", metadata: {} },
    { id: "gpt-image-2", ownedBy: "openai", metadata: {} },
  ];
  return catalogEnvelope({ models, recommendation: recommendAutoListingModels({ models }) });
}

function catalog(overrides = {}) {
  return { id: "catalog-a", accountId: "account-a", connectionId: "connection-a", connectionVersion: 1,
    syncTaskId: "sync-a", catalog: catalogEnvelope(), catalogHash: CATALOG_HASH,
    capabilityResult: catalogCapability(), capabilityHash: CAPABILITY_HASH, rollbackEvidenceIdentity: null,
    testedAt: CHECKED_AT, createdAt: CHECKED_AT, ...overrides };
}

function overview(overrides = {}) {
  return { accountId: "account-a", activeConnection: null, activeProfile: null,
    connections: [], catalogs: [], syncTasks: [], profiles: [], channels: [], channelCandidates: [],
    pagination: { connections: { pageSize: 10, hasMore: false, nextCursor: null },
      profiles: { pageSize: 10, hasMore: false, nextCursor: null } },
    actions: { canCreateConnection: true, syncableConnectionIds: [], profileCreatableCatalogIds: [], testableProfileIds: [], publishableProfileIds: [], rollbackProfileIds: [] },
    ...overrides };
}

async function task7ProfileRollbackValidation() {
  let persistedValidation = null;
  const paid = paidCapability();
  const passedProfile = {
    id: "profile-rollback", account_id: "account-a", display_name: "Profile rollback", config_version: 1,
    base_url: "http://127.0.0.1:8080/v1", api_key_env_name: "SUB2API_ENCRYPTED_KEY",
    text_protocol: "SUB2API_RESPONSES", image_protocol: "SUB2API_OPENAI_IMAGES",
    text_model: "text-a", image_model: "image-a", enabled: false,
    capability_result: paid, capability_checked_at: CHECKED_AT,
    connection_id: "connection-profile-rollback", connection_version: 1, created_at: CHECKED_AT,
  };
  const steps = [
    { rows: [] }, { rows: [{ id: "account-a" }] }, { rows: [] }, { rows: [passedProfile] },
    { rows: [{ id: "connection-profile-rollback", retired_at: "2026-08-07T00:00:00.000Z", status_version: 4 }] },
    { rows: [{ id: "attempt-profile-rollback", completed_at: CHECKED_AT }] },
    (sql, params) => {
      assert.match(sql, /SET status='VALIDATED'/u);
      persistedValidation = JSON.parse(params[3]);
      return { rows: [{ id: "connection-profile-rollback", version: 1, status_version: 5 }] };
    },
    { rows: [] }, { rowCount: 1, rows: [{ event_id: "audit-validated" }] },
    { rows: [{ id: "profile-current", config_version: 1 }] }, { rows: [] },
    { rows: [{ id: "connection-current", version: 1, status_version: 3 }] },
    { rows: [{ id: "connection-current", version: 1, status_version: 4 }] },
    { rows: [] }, { rowCount: 1, rows: [{ event_id: "audit-retired" }] },
    { rows: [{ id: "connection-profile-rollback", version: 1, status_version: 6 }] },
    { rows: [] }, { rowCount: 1, rows: [{ event_id: "audit-active" }] },
    { rows: [{ ...passedProfile, enabled: true }] }, { rowCount: 1, rows: [] },
    { rowCount: 1, rows: [{ event_id: "audit-profile" }] }, { rows: [] },
  ];
  const client = {
    async query(sql, params = []) {
      if (/auto_listing_cleanup_expired_prepared_capability_subcalls/u.test(sql)
        || /SELECT id FROM ai_gateway_capability_subcall_reservations[\s\S]*status IN \('PREPARED','SENDING'\)/u.test(sql)) {
        return { rowCount: 0, rows: [] };
      }
      const step = steps.shift();
      assert.ok(step, `unexpected profile rollback query: ${sql}`);
      return typeof step === "function" ? step(sql, params) : step;
    },
    release() {},
  };
  const pool = { async connect() { return client; }, async query(sql, params) { return client.query(sql, params); } };
  const rolledBack = await createAutoListingAiAdminPostgres({ pool }).rollbackProfile({
    accountId: "account-a", actorId: "account-a", profileId: "profile-rollback", configVersion: 1,
    idempotencyKey: "rollback-profile-producer", correlationId: "rollback-profile-producer-corr",
  });
  assert.equal(rolledBack.enabled, true);
  assert.equal(steps.length, 0);
  assert.deepEqual(persistedValidation, paid);
  return persistedValidation;
}

async function task7ProducerOverview() {
  const profileRollbackValidation = await task7ProfileRollbackValidation();
  const catalogResult = catalogCapability();
  const catalogValue = catalogEnvelope();
  const connectionValidation = {
    schemaVersion: "AI_GATEWAY_CONNECTION_TEST_V1", outcome: "PASSED", checkedAt: CHECKED_AT,
    checks: { authentication: true, modelsEndpoint: true }, catalogId: "catalog-a", catalogHash: CATALOG_HASH,
  };
  const rows = {
    connections: [{ id: "connection-a", account_id: "account-a", version: 1, display_name: "本地 sub2API",
      base_url: "http://127.0.0.1:8080/v1", fingerprint: "fingerprint-a", key_version: "local-v1",
      status: "VALIDATED", status_version: 2, validation_result: connectionValidation, validated_at: new Date(CHECKED_AT),
      activated_at: null, retired_at: null, created_at: new Date(CHECKED_AT) },
    { id: "connection-rollback", account_id: "account-a", version: 1, display_name: "回退 sub2API",
      base_url: "http://127.0.0.1:8080/v1", fingerprint: "fingerprint-b", key_version: "local-v1",
      status: "VALIDATED", status_version: 4, validation_result: rollbackCapability(), validated_at: new Date(CHECKED_AT),
      activated_at: null, retired_at: new Date("2026-08-07T00:00:00.000Z"), created_at: new Date(CHECKED_AT) },
    { id: "connection-profile-rollback", account_id: "account-a", version: 1, display_name: "Profile 回退 sub2API",
      base_url: "http://127.0.0.1:8080/v1", fingerprint: "fingerprint-c", key_version: "local-v1",
      status: "ACTIVE", status_version: 6, validation_result: profileRollbackValidation, validated_at: new Date(CHECKED_AT),
      activated_at: new Date(CHECKED_AT), retired_at: new Date("2026-08-07T00:00:00.000Z"), created_at: new Date(CHECKED_AT) }],
    catalogs: [{ id: "catalog-a", account_id: "account-a", connection_id: "connection-a", connection_version: 1,
      sync_task_id: "sync-a", catalog: catalogValue, catalog_hash: CATALOG_HASH, capability_result: catalogResult,
      capability_hash: CAPABILITY_HASH, rollback_evidence_identity: null, tested_at: new Date(CHECKED_AT), created_at: new Date(CHECKED_AT) },
    { id: "catalog-rollback", account_id: "account-a", connection_id: "connection-rollback", connection_version: 1,
      sync_task_id: "sync-rollback", catalog: { models: [] }, catalog_hash: "d".repeat(64),
      capability_result: rollbackCapability(), capability_hash: "e".repeat(64), rollback_evidence_identity: "f".repeat(64),
      tested_at: new Date(CHECKED_AT), created_at: new Date(CHECKED_AT) }],
    tasks: [{ id: "sync-a", account_id: "account-a", connection_id: "connection-a", connection_version: 1,
      sync_purpose: "CATALOG_SYNC", target_connection_status_version: 1, status: "SUCCEEDED", status_version: 3,
      attempt_count: 1, max_attempts: 5, lease_version: 1, available_at: new Date(CHECKED_AT),
      completed_at: new Date(CHECKED_AT), last_error_code: null, last_error_safe: null, created_at: new Date(CHECKED_AT) },
    { id: "sync-rollback", account_id: "account-a", connection_id: "connection-rollback", connection_version: 1,
      sync_purpose: "ROLLBACK_CAPABILITY", target_connection_status_version: 3, status: "SUCCEEDED", status_version: 3,
      attempt_count: 1, max_attempts: 1, lease_version: 1, available_at: new Date(CHECKED_AT),
      completed_at: new Date(CHECKED_AT), last_error_code: null, last_error_safe: null, created_at: new Date(CHECKED_AT) }],
    profiles: [{ id: "profile-seeded", account_id: "account-a", display_name: "目录选型", config_version: 1,
      base_url: "http://127.0.0.1:8080/v1", api_key_env_name: "SUB2API_ENCRYPTED_KEY",
      text_protocol: "SUB2API_RESPONSES", image_protocol: "SUB2API_OPENAI_IMAGES", text_model: "text-a", image_model: "image-a",
      enabled: false, capability_result: catalogResult, capability_checked_at: new Date(CHECKED_AT),
      connection_id: "connection-a", connection_version: 1, created_at: new Date(CHECKED_AT) },
    { id: "profile-paid", account_id: "account-a", display_name: "已付费验证", config_version: 2,
      base_url: "http://127.0.0.1:8080/v1", api_key_env_name: "SUB2API_ENCRYPTED_KEY",
      text_protocol: "SUB2API_RESPONSES", image_protocol: "SUB2API_OPENAI_IMAGES", text_model: "text-a", image_model: "image-a",
      enabled: false, capability_result: paidCapability(), capability_checked_at: new Date(CHECKED_AT),
      connection_id: "connection-a", connection_version: 1, created_at: new Date(CHECKED_AT) },
    { id: "profile-failed", account_id: "account-a", display_name: "付费验证失败", config_version: 3,
      base_url: "http://127.0.0.1:8080/v1", api_key_env_name: "SUB2API_ENCRYPTED_KEY",
      text_protocol: "SUB2API_RESPONSES", image_protocol: "SUB2API_OPENAI_IMAGES", text_model: "text-a", image_model: "image-a",
      enabled: false, capability_result: paidCapability({ outcome: "FAILED", features: [], latencyMs: null, errorCode: "GATEWAY_TIMEOUT" }),
      capability_checked_at: new Date(CHECKED_AT), connection_id: "connection-a", connection_version: 1,
      created_at: new Date(CHECKED_AT) },
    { id: "profile-empty", account_id: "account-a", display_name: "旧配置", config_version: 1,
      base_url: "https://gateway.example/v1", api_key_env_name: "SUB2API_LEGACY_KEY",
      text_protocol: "SUB2API_RESPONSES", image_protocol: "SUB2API_OPENAI_IMAGES", text_model: "text-a", image_model: "image-a",
      enabled: false, capability_result: {}, capability_checked_at: null,
      connection_id: null, connection_version: null, created_at: new Date(CHECKED_AT) }],
  };
  const client = { async query(sql) {
    if (/FROM ai_gateway_connection_versions WHERE/u.test(sql)) return { rows: rows.connections };
    if (/FROM ai_gateway_model_catalogs WHERE/u.test(sql)) return { rows: rows.catalogs };
    if (/FROM ai_gateway_model_sync_tasks WHERE/u.test(sql)) return { rows: rows.tasks };
    if (/FROM ai_gateway_profiles(?:\s+p)?/u.test(sql)) return { rows: rows.profiles };
    return { rows: [] };
  }, release() {} };
  const pool = { async connect() { return client; }, async query() { return { rows: [] }; } };
  const producer = createAutoListingAiSettingsPostgres({ pool });
  const repository = { ...producer, connectionIdForIntent() { return "unused"; }, async createPendingConnection() {},
    async enqueueModelSync() {}, async createProfileFromSelection() {},
    async loadSettingsOverviewPage(input) {
      const loaded = await producer.loadSettingsOverview({ accountId: input.accountId });
      const catalogSyncIds = new Set(loaded.syncTasks.filter((task) => task.syncPurpose === "CATALOG_SYNC"
        && task.status === "SUCCEEDED").map((task) => task.id));
      return { ...loaded, activeProfile: loaded.profiles.find((row) => row.enabled) || null,
        catalogs: loaded.catalogs.filter((row) => catalogSyncIds.has(row.syncTaskId)),
        pageInfo: { connections: { pageSize: 10, next: null }, profiles: { pageSize: 10, next: null } } };
    },
    async loadSettingsCatalog(input) {
      const loaded = await producer.loadSettingsOverview({ accountId: input.accountId });
      const row = loaded.catalogs.find((candidate) => candidate.id === input.catalogId) || null;
      return row ? { catalog: row, canCreateProfile: true } : null;
    },
    async loadSettingsConnection(input) {
      const loaded = await producer.loadSettingsOverview({ accountId: input.accountId });
      return loaded.connections.find((row) => row.id === input.connectionId
        && row.version === input.connectionVersion) || null;
    } };
  const service = createAutoListingAiSettingsService({ repository,
    profileRepository: { async publishProfile() {}, async prepareProfileRollback() {}, async rollbackProfile() {} },
    cipher: { encrypt() {}, fingerprint() {} }, capabilityService: { async testGatewayCapabilities() {} }, allowLocalGateway: true });
  return service.getOverview({ actor: { id: "account-a", role: "admin" } });
}

function installTransport(t, handler) {
  const originalFetch = globalThis.fetch;
  const originalLocalStorage = globalThis.localStorage;
  const originalSessionStorage = globalThis.sessionStorage;
  t.after(() => { globalThis.fetch = originalFetch; globalThis.localStorage = originalLocalStorage; globalThis.sessionStorage = originalSessionStorage; });
  globalThis.localStorage = memoryStorage();
  globalThis.sessionStorage = memoryStorage();
  globalThis.fetch = handler;
}

test("connection intent is reused across timeout retry and cleared only after confirmed success", async (t) => {
  const storage = memoryStorage();
  const intents = createAiSettingsIntentStore(storage);
  const first = intents.connectionIntent({ displayName: "本地 sub2API", baseUrl: "http://127.0.0.1:8080/v1" });
  const second = intents.connectionIntent({ displayName: "本地 sub2API", baseUrl: "http://127.0.0.1:8080/v1" });
  assert.equal(first.idempotencyKey, second.idempotencyKey);
  assert.doesNotMatch(JSON.stringify(storage.dump()), /gateway-secret/);
  let attempt = 0;
  installTransport(t, async () => {
    attempt += 1;
    if (attempt === 1) throw Object.assign(new Error("timeout"), { code: "REQUEST_TIMEOUT" });
    return response(connection());
  });
  const keyInput = { value: "gateway-secret" };
  await assert.rejects(createGatewayConnection({ displayName: "本地 sub2API", baseUrl: "http://127.0.0.1:8080/v1", gatewayKey: keyInput.value, gatewayKeyInput: keyInput }, first), { code: "REQUEST_TIMEOUT" });
  assert.equal(keyInput.value, "gateway-secret");
  assert.equal(intents.connectionIntent({ displayName: "本地 sub2API", baseUrl: "http://127.0.0.1:8080/v1" }).idempotencyKey, first.idempotencyKey);
  await createGatewayConnection({ displayName: "本地 sub2API", baseUrl: "http://127.0.0.1:8080/v1", gatewayKey: keyInput.value, gatewayKeyInput: keyInput }, second);
  assert.equal(keyInput.value, "");
  assert.equal(JSON.stringify(storage.dump()).includes("gateway-secret"), false);
  assert.notEqual(intents.connectionIntent({ displayName: "本地 sub2API", baseUrl: "http://127.0.0.1:8080/v1" }).idempotencyKey, first.idempotencyKey);
});

test("client sends only the exact Task 7 paths and closed DTO bodies", async (t) => {
  const calls = [];
  installTransport(t, async (url, options) => {
    calls.push({ url, options }); const path = new URL(url, "http://localhost").pathname;
    if (path.endsWith("/connections")) return response(connection());
    if (path.endsWith("/sync")) return response(syncTask());
    if (path.endsWith("/profiles/profile-a/test")) return response(capability());
    return response(profile({ enabled: path.endsWith("/publish") || path.endsWith("/rollback") }));
  });
  const intent = Object.freeze({ idempotencyKey: "intent-a", correlationId: "corr-a" });
  await createGatewayConnection({ displayName: "Gateway", baseUrl: "https://gateway.example/v1", gatewayKey: "gateway-secret" }, intent);
  await requestModelSync({ connectionId: "connection-a", connectionVersion: 1 }, intent);
  await createModelProfile({ connectionId: "connection-a", connectionVersion: 1, catalogId: "catalog-a", displayName: "Profile", textModel: "text-a", imageModel: "image-a", textProtocol: "SUB2API_RESPONSES", imageProtocol: "SUB2API_OPENAI_IMAGES" }, intent);
  await testModelProfile({ profileId: "profile-a", configVersion: 1, correlationId: "corr-test", costConfirmed: true });
  await publishModelProfile({ profileId: "profile-a", configVersion: 1 }, intent);
  await rollbackModelProfile({ profileId: "profile-a", configVersion: 1, costConfirmed: true }, intent);
  assert.deepEqual(calls.map(({ url, options }) => [new URL(url, "http://localhost").pathname, options.method, JSON.parse(options.body)]), [
    ["/api/admin/auto-listing/ai-settings/connections", "POST", { idempotencyKey: "intent-a", correlationId: "corr-a", displayName: "Gateway", baseUrl: "https://gateway.example/v1", gatewayKey: "gateway-secret" }],
    ["/api/admin/auto-listing/ai-settings/connections/connection-a/sync", "POST", { connectionVersion: 1, idempotencyKey: "intent-a", correlationId: "corr-a" }],
    ["/api/admin/auto-listing/ai-settings/profiles", "POST", { connectionId: "connection-a", connectionVersion: 1, catalogId: "catalog-a", displayName: "Profile", textModel: "text-a", imageModel: "image-a", textProtocol: "SUB2API_RESPONSES", imageProtocol: "SUB2API_OPENAI_IMAGES", idempotencyKey: "intent-a", correlationId: "corr-a" }],
    ["/api/admin/auto-listing/ai-settings/profiles/profile-a/test", "POST", { configVersion: 1, correlationId: "corr-test", costConfirmed: true }],
    ["/api/admin/auto-listing/ai-settings/profiles/profile-a/publish", "POST", { configVersion: 1, idempotencyKey: "intent-a", correlationId: "corr-a" }],
    ["/api/admin/auto-listing/ai-settings/profiles/profile-a/rollback", "POST", { configVersion: 1, idempotencyKey: "intent-a", correlationId: "corr-a", costConfirmed: true }],
  ]);
  assert.ok(calls.every(({ options }) => options.headers["X-Client-Ai-Settings"] === "1"));
});

test("channel commands use only the exact Task 2 routes and closed bodies", async (t) => {
  const calls = [];
  installTransport(t, async (url, options) => {
    calls.push({ url, options });
    return response(options.body.includes('"enabled"') ? channel({ enabled: false, status: "DISABLED" }) : channel());
  });
  await addAutoListingAiChannel({ profileId: "profile-a", profileVersion: 1,
    connectionId: "connection-b", connectionVersion: 2, displayName: "备用 Gateway" });
  await setAutoListingAiChannelEnabled({ profileId: "profile-a", profileVersion: 1, channelId: "channel-a", enabled: false });
  assert.deepEqual(calls.map(({ url, options }) => [new URL(url, "http://localhost").pathname, options.method, JSON.parse(options.body)]), [
    ["/api/admin/auto-listing/ai-settings/profiles/profile-a/versions/1/channels", "POST", {
      connectionId: "connection-b", connectionVersion: 2, displayName: "备用 Gateway" }],
    ["/api/admin/auto-listing/ai-settings/profiles/profile-a/versions/1/channels/channel-a/status", "POST", { enabled: false }],
  ]);
});

test("channel DTOs reject unknown fields, unsafe values, and sensitive aliases", async (t) => {
  const base = overview({ channels: [channel()], channelCandidates: [channelCandidate()] });
  installTransport(t, async () => response(base));
  assert.deepEqual((await loadAiSettings()).channels, [channel()]);
  for (const mutation of [
    { channels: [{ ...channel(), apiKey: "must-not-leak" }] },
    { channels: [channel({ cooldownUntil: "2026-08-08T00:00:00Z" })] },
    { channels: [channel({ status: "UNKNOWN" })] },
    { channelCandidates: [{ ...channelCandidate(), endpoint: "https://must-not-leak.example" }] },
  ]) {
    globalThis.fetch = async () => response({ ...base, ...mutation });
    await assert.rejects(loadAiSettings(), { code: "AI_SETTINGS_CLIENT_RESPONSE_INVALID" });
  }
});

test("abort, 64 KiB body limits, accessors, proxies, secret or oversized responses fail closed", async (t) => {
  let calls = 0;
  installTransport(t, async () => { calls += 1; return response(connection()); });
  const controller = new AbortController(); controller.abort("cancelled");
  await assert.rejects(requestModelSync({ connectionId: "connection-a", connectionVersion: 1 }, { idempotencyKey: "sync-a", correlationId: "corr-a", signal: controller.signal }), { code: "REQUEST_ABORTED" });
  await assert.rejects(createGatewayConnection({ displayName: "a".repeat(70_000), baseUrl: "https://gateway.example/v1", gatewayKey: "gateway-secret" }, { idempotencyKey: "intent-a", correlationId: "corr-a" }), { code: "AI_SETTINGS_CLIENT_REQUEST_INVALID" });
  const accessor = { connectionId: "connection-a" };
  Object.defineProperty(accessor, "connectionVersion", { enumerable: true, get: () => 1 });
  await assert.rejects(requestModelSync(accessor, { idempotencyKey: "sync-a", correlationId: "corr-a" }), { code: "AI_SETTINGS_CLIENT_REQUEST_INVALID" });
  const hostile = new Proxy({ connectionId: "connection-a", connectionVersion: 1 }, { ownKeys() { throw new Error("trap"); } });
  await assert.rejects(requestModelSync(hostile, { idempotencyKey: "sync-a", correlationId: "corr-a" }), { code: "AI_SETTINGS_CLIENT_REQUEST_INVALID" });
  assert.equal(calls, 0);
  globalThis.fetch = async () => response({ ...connection(), ciphertext: "encrypted-secret" });
  await assert.rejects(createGatewayConnection({ displayName: "Gateway", baseUrl: "https://gateway.example/v1", gatewayKey: "gateway-secret" }, { idempotencyKey: "intent-a", correlationId: "corr-a" }), { code: "AI_SETTINGS_CLIENT_RESPONSE_INVALID" });
  globalThis.fetch = async () => response({ ...connection(), validationResult: { payload: "x".repeat(70_000) } });
  await assert.rejects(createGatewayConnection({ displayName: "Gateway", baseUrl: "https://gateway.example/v1", gatewayKey: "gateway-secret" }, { idempotencyKey: "intent-a", correlationId: "corr-a" }), { code: "RESPONSE_TOO_LARGE" });
});

test("overview and polling only accept known terminal states and never promote unknown work", async (t) => {
  const base = overview();
  let reads = 0;
  installTransport(t, async () => { reads += 1; return response({ ...base, syncTasks: [syncTask({ status: reads === 1 ? "LEASED" : "SUCCEEDED" })] }); });
  assert.equal((await loadAiSettings()).syncTasks[0].status, "LEASED");
  assert.equal((await pollAiSettingsUntil((value) => value.syncTasks[0]?.status === "SUCCEEDED", { timeoutMs: 1_000 })).syncTasks[0].status, "SUCCEEDED");
  globalThis.fetch = async () => response({ ...base, syncTasks: [syncTask({ status: "MAGIC_DONE" })] });
  await assert.rejects(loadAiSettings(), { code: "AI_SETTINGS_CLIENT_RESPONSE_INVALID" });
});

test("Task 7 sync status is closed to PENDING LEASED SUCCEEDED FAILED DEAD", async (t) => {
  const base = overview();
  installTransport(t, async () => response({ ...base, syncTasks: [syncTask({ status: "LEASED" })] }));
  assert.equal((await loadAiSettings()).syncTasks[0].status, "LEASED");
  globalThis.fetch = async () => response({ ...base, syncTasks: [syncTask({ status: "RUNNING" })] });
  await assert.rejects(loadAiSettings(), { code: "AI_SETTINGS_CLIENT_RESPONSE_INVALID" });
});

test("public paid test is a one-argument closed command and client exposes no remote error text", async (t) => {
  installTransport(t, async () => ({ ok: false, status: 503, text: async () => JSON.stringify({ code: "AUTO_LISTING_AI_SETTINGS_DATABASE_FAILED", message: "db password=secret" }) }));
  await assert.rejects(testModelProfile({ profileId: "profile-a", configVersion: 1, correlationId: "corr-a", costConfirmed: true }),
    (error) => error.code === "AUTO_LISTING_AI_SETTINGS_DATABASE_FAILED" && error.message === "AI 模型设置暂时不可用");
  await assert.rejects(testModelProfile({ profileId: "profile-a", configVersion: 1, correlationId: "corr-a", costConfirmed: true, extra: true }),
    { code: "AI_SETTINGS_CLIENT_REQUEST_INVALID" });
});

test("paid test has a default bounded timeout and poll cannot succeed after its deadline", async (t) => {
  let observedSignal = null;
  installTransport(t, async (_url, options) => { observedSignal = options.signal; return response(capability()); });
  await testModelProfile({ profileId: "profile-a", configVersion: 1, correlationId: "corr-timeout", costConfirmed: true });
  assert.ok(observedSignal instanceof AbortSignal);
  await assert.rejects(pollAiSettingsUntil(() => true, { timeoutMs: 1 }), (error) => ["AI_SETTINGS_CLIENT_POLL_TIMEOUT", "REQUEST_TIMEOUT", "AI_SETTINGS_CLIENT_RESPONSE_INVALID"].includes(error.code));
});

test("frontend safe error contract stays in parity with Task 7 routes", () => {
  for (const code of AUTO_LISTING_AI_SETTINGS_SAFE_CODES) assert.ok(AI_SETTINGS_SAFE_ERROR_CODES.includes(code), code);
});

test("paid-test command intent persists and reuses its correlation identity", async (t) => {
  const storage = memoryStorage(); const intents = createAiSettingsIntentStore(storage);
  const intent = intents.commandIntent({ operation: "test", targetId: "profile-a" });
  installTransport(t, async () => response(capability()));
  await testModelProfile({ profileId: "profile-a", configVersion: 1, costConfirmed: true }, intent);
  assert.equal(storage.getItem("ozon-ai-settings:connection:test:profile-a"), null);
});

test("paid-test response loss preserves the stored intent and retries the same correlation", async (t) => {
  const storage = memoryStorage(); const intents = createAiSettingsIntentStore(storage);
  const intent = intents.commandIntent({ operation: "test", targetId: "profile-a" });
  const sent = []; let call = 0;
  installTransport(t, async (_url, options) => { sent.push(JSON.parse(options.body)); call += 1; if (call === 1) throw Object.assign(new Error("lost"), { code: "REQUEST_TIMEOUT" }); return response(capability()); });
  await assert.rejects(testModelProfile({ profileId: "profile-a", configVersion: 1, costConfirmed: true }, intent), { code: "REQUEST_TIMEOUT" });
  assert.notEqual(storage.getItem("ozon-ai-settings:connection:test:profile-a"), null);
  await testModelProfile({ profileId: "profile-a", configVersion: 1, costConfirmed: true }, intent);
  assert.deepEqual(sent[1], sent[0]);
  assert.equal(storage.getItem("ozon-ai-settings:connection:test:profile-a"), null);
});

test("Task 7 entity IDs reject whitespace and traversal while model IDs stay independent", async () => {
  await assert.rejects(requestModelSync({ connectionId: " connection-a", connectionVersion: 1 }, { idempotencyKey: "sync-a", correlationId: "corr-a" }), { code: "AI_SETTINGS_CLIENT_REQUEST_INVALID" });
  await assert.rejects(requestModelSync({ connectionId: "connection..a", connectionVersion: 1 }, { idempotencyKey: "sync-a", correlationId: "corr-a" }), { code: "AI_SETTINGS_CLIENT_REQUEST_INVALID" });
});

test("overview rejects duplicate entity IDs and malformed nested validation evidence", async (t) => {
  const base = overview();
  installTransport(t, async () => response({ ...base, connections: [connection(), connection()] }));
  await assert.rejects(loadAiSettings(), { code: "AI_SETTINGS_CLIENT_RESPONSE_INVALID" });
});

test("overview accepts a closed audit-backed profile activation and rejects malformed or partial evidence", async (t) => {
  let current = overview({ profiles: [profile({ activation: {
    kind: "ROLLBACK", occurredAt: "2026-08-09T02:03:04.000Z", actorId: "account-admin-a",
  } })] });
  installTransport(t, async () => response(current));

  const loaded = await loadAiSettings();
  assert.deepEqual(loaded.profiles[0].activation, {
    kind: "ROLLBACK", occurredAt: "2026-08-09T02:03:04.000Z", actorId: "account-admin-a",
  });

  for (const [label, activation] of [
    ["open evidence", { kind: "PUBLISH", occurredAt: CHECKED_AT, actorId: "account-a", extra: true }],
    ["unknown kind", { kind: "CREATE", occurredAt: CHECKED_AT, actorId: "account-a" }],
    ["noncanonical timestamp", { kind: "PUBLISH", occurredAt: "2026-08-08T00:00:00Z", actorId: "account-a" }],
    ["unsafe actor", { kind: "PUBLISH", occurredAt: CHECKED_AT, actorId: " account-a" }],
    ["partial evidence", { kind: "PUBLISH", occurredAt: CHECKED_AT }],
  ]) {
    await t.test(label, async () => {
      current = overview({ profiles: [profile({ activation })] });
      await assert.rejects(loadAiSettings(), { code: "AI_SETTINGS_CLIENT_RESPONSE_INVALID" });
    });
  }
});

test("client accepts the exact Task 7 repository and service overview DTO variants", async (t) => {
  const produced = await task7ProducerOverview();
  installTransport(t, async () => response(produced));

  const loaded = await loadAiSettings();

  assert.equal(loaded.connections[0].validationResult.schemaVersion, "AI_GATEWAY_CONNECTION_TEST_V1");
  assert.deepEqual(loaded.connections[1].validationResult, rollbackCapability());
  assert.deepEqual(loaded.connections[2].validationResult, paidCapability());
  assert.deepEqual(loaded.catalogs[0].capabilityResult, catalogCapability());
  assert.equal(loaded.catalogs[0].catalog.modelCount, 2);
  assert.deepEqual(loaded.profiles.map((row) => row.capabilityResult.outcome ?? "EMPTY"),
    ["NOT_TESTED", "PASSED", "FAILED", "EMPTY"]);
  assert.equal(loaded.syncTasks[0].availableAt, CHECKED_AT);
});

test("catalog client accepts immutable V1 history and the exact V2 OAuth image recommendation", async (t) => {
  let envelope = legacyV1CatalogEnvelope();
  installTransport(t, async () => response({
    accountId: "account-a",
    catalog: catalog({ catalog: envelope }),
    actions: { canCreateProfile: true },
  }));

  assert.equal((await loadAiSettingsCatalog("catalog-a")).catalog.catalog.recommendation.ruleVersion,
    "AUTO_LISTING_MODEL_RECOMMENDATION_V1");

  envelope = oauthV2CatalogEnvelope();
  const loaded = await loadAiSettingsCatalog("catalog-a");
  assert.equal(loaded.catalog.catalog.recommendation.ruleVersion, "AUTO_LISTING_MODEL_RECOMMENDATION_V2");
  assert.equal(loaded.catalog.catalog.recommendation.textCandidates[0].modelId, "gpt-5.4");
});

test("catalog client rejects noncanonical OAuth image compatibility recommendations", async (t) => {
  const baseline = oauthV2CatalogEnvelope();
  let envelope = baseline;
  installTransport(t, async () => response({
    accountId: "account-a",
    catalog: catalog({ catalog: envelope }),
    actions: { canCreateProfile: true },
  }));
  for (const [label, mutate] of [
    ["unknown rule version", (value) => { value.recommendation.ruleVersion = "AUTO_LISTING_MODEL_RECOMMENDATION_V3"; }],
    ["forged compatibility score", (value) => { value.recommendation.textCandidates[0].score += 1; }],
    ["wrong compatibility reason order", (value) => { value.recommendation.textCandidates[0].reasonCodes.reverse(); }],
    ["compatibility reason without image model", (value) => {
      value.models = value.models.filter((model) => model.id !== "gpt-image-2");
      value.recommendation.imageCandidates = [];
      value.recommendation.warnings.push("NO_IMAGE_MODEL_CANDIDATE");
    }],
  ]) {
    await t.test(label, async () => {
      envelope = structuredClone(baseline);
      mutate(envelope);
      await assert.rejects(loadAiSettingsCatalog("catalog-a"), {
        code: "AI_SETTINGS_CLIENT_RESPONSE_INVALID",
      });
    });
  }
});

test("paid test response accepts only Task 7 PASSED and FAILED outcome-specific DTOs", async (t) => {
  let result = capability();
  installTransport(t, async () => response(result));
  assert.equal((await testModelProfile({ profileId: "profile-a", configVersion: 1,
    correlationId: "corr-paid-pass", costConfirmed: true })).outcome, "PASSED");

  result = capability({ outcome: "FAILED", features: [], latencyMs: null, errorCode: "GATEWAY_TIMEOUT" });
  assert.equal((await testModelProfile({ profileId: "profile-a", configVersion: 1,
    correlationId: "corr-paid-fail", costConfirmed: true })).outcome, "FAILED");

  for (const [label, malformed] of [
    ["unknown outcome", capability({ outcome: "NOT_TESTED" })],
    ["duplicate feature", capability({ features: ["STRUCTURED_TEXT", "IMAGE_GENERATION", "IMAGE_GENERATION"] })],
    ["unknown feature", capability({ features: ["STRUCTURED_TEXT", "IMAGE_GENERATION", "IMAGE_DECODE_GIF"] })],
    ["negative latency", capability({ latencyMs: -1 })],
    ["fractional latency", capability({ latencyMs: 1.5 })],
    ["PASSED error", capability({ errorCode: "GATEWAY_TIMEOUT" })],
    ["FAILED features", capability({ outcome: "FAILED", features: ["STRUCTURED_TEXT"], latencyMs: null, errorCode: "GATEWAY_TIMEOUT" })],
    ["FAILED latency", capability({ outcome: "FAILED", features: [], latencyMs: 1, errorCode: "GATEWAY_TIMEOUT" })],
    ["FAILED unsafe code", capability({ outcome: "FAILED", features: [], latencyMs: null, errorCode: "INTERNAL_SECRET" })],
    ["FAILED enabled", capability({ outcome: "FAILED", features: [], latencyMs: null, errorCode: "GATEWAY_TIMEOUT", enabled: true })],
    ["open models", capability({ models: { text: "text-a", image: "image-a", extra: true } })],
  ]) {
    await t.test(label, async () => {
      result = malformed;
      await assert.rejects(testModelProfile({ profileId: "profile-a", configVersion: 1,
        correlationId: `corr-${label.replaceAll(" ", "-")}`, costConfirmed: true }),
      { code: "AI_SETTINGS_CLIENT_RESPONSE_INVALID" });
    });
  }
});

test("overview rejects every open or contradictory Task 7 nested DTO", async (t) => {
  const produced = await task7ProducerOverview();
  const baseline = structuredClone(produced);
  let current = baseline;
  installTransport(t, async () => response(current));
  await loadAiSettings();
  const cases = [
    ["connection catalog validation open", (value) => { value.connections[0].validationResult.extra = true; }],
    ["connection catalog validation combination", (value) => { value.connections[0].validationResult.checks.authentication = false; }],
    ["connection rollback validation open", (value) => { value.connections[1].validationResult.extra = true; }],
    ["connection rollback validation identity", (value) => { value.connections[1].validationResult.connectionId = "connection-other"; }],
    ["connection rollback validation combination", (value) => { value.connections[1].validationResult.checks.modelsEndpoint = false; }],
    ["connection profile rollback paid open", (value) => { value.connections[2].validationResult.extra = true; }],
    ["connection profile rollback paid FAILED", (value) => { value.connections[2].validationResult = paidCapability({ outcome: "FAILED", features: [], latencyMs: null, errorCode: "GATEWAY_TIMEOUT" }); }],
    ["connection profile rollback paid NOT_TESTED", (value) => { value.connections[2].validationResult = catalogCapability(); }],
    ["connection profile rollback paid combination", (value) => { value.connections[2].validationResult.features = ["STRUCTURED_TEXT", "IMAGE_GENERATION"]; }],
    ["catalog capability open", (value) => { value.catalogs[0].capabilityResult.extra = true; }],
    ["catalog capability combination", (value) => { value.catalogs[0].capabilityResult.text = true; }],
    ["catalog sync unexpected rollback identity", (value) => { value.catalogs[0].rollbackEvidenceIdentity = "f".repeat(64); }],
    ["active selection open", (value) => { value.catalogs[0].catalog.activeSelection = { profileId: "profile-paid", configVersion: 2, textModel: "text-a", imageModel: "image-a", extra: true }; value.catalogs[0].catalog.activeSelectionState = "AVAILABLE"; }],
    ["active selection state mismatch", (value) => { value.catalogs[0].catalog.activeSelectionState = "AVAILABLE"; }],
    ["request hash", (value) => { value.catalogs[0].catalog.requestIdHash = "not-a-hash"; }],
    ["catalog hash", (value) => { value.catalogs[0].catalogHash = "not-a-hash"; }],
    ["nullable testedAt", (value) => { value.catalogs[0].testedAt = null; }],
    ["noncanonical availableAt", (value) => { value.syncTasks[0].availableAt = "2026-08-08T00:00:00Z"; }],
    ["unsafe profile connection ID", (value) => { value.profiles[0].connectionId = "connection..a"; }],
    ["profile paid unknown feature", (value) => { value.profiles[1].capabilityResult.features[2] = "IMAGE_DECODE_GIF"; }],
    ["profile paid FAILED combination", (value) => { value.profiles[2].capabilityResult.features = ["STRUCTURED_TEXT"]; }],
    ["profile paid FAILED enabled", (value) => { value.profiles[2].enabled = true; }],
    ["profile paid unsafe error", (value) => { value.profiles[2].capabilityResult.errorCode = "INTERNAL_SECRET"; }],
  ];
  for (const [label, mutate] of cases) {
    await t.test(label, async () => {
      current = structuredClone(baseline);
      mutate(current);
      await assert.rejects(loadAiSettings(), { code: "AI_SETTINGS_CLIENT_RESPONSE_INVALID" });
    });
  }
});

test("explicit catalog endpoint rejects every open or contradictory full model directory DTO", async (t) => {
  const baseline = { accountId: "account-a", catalog: catalog(), actions: { canCreateProfile: true } };
  let current = baseline;
  installTransport(t, async () => response(current));
  assert.equal((await loadAiSettingsCatalog("catalog-a")).catalog.catalog.models.length, 2);
  const cases = [
    ["active selection missing contradiction", (value) => {
      value.catalog.catalog.activeSelection = { profileId: "profile-paid", configVersion: 2,
        textModel: "text-a", imageModel: "image-a" };
      value.catalog.catalog.activeSelectionState = "MISSING";
    }],
    ["recommendation open", (value) => { value.catalog.catalog.recommendation.extra = true; }],
    ["candidate open", (value) => { value.catalog.catalog.recommendation.textCandidates[0].extra = true; }],
    ["candidate score", (value) => { value.catalog.catalog.recommendation.textCandidates[0].score += 1; }],
    ["candidate confidence", (value) => { value.catalog.catalog.recommendation.textCandidates[0].confidence = "DECLARED"; }],
    ["candidate declaration without metadata", (value) => {
      value.catalog.catalog.recommendation.textCandidates[0] = {
        modelId: "text-a", score: 160, confidence: "DECLARED", verified: false,
        reasonCodes: ["DECLARED_STRUCTURED_TEXT", "DECLARED_RESPONSES_PROTOCOL"],
      };
    }],
    ["candidate duplicate model ID", (value) => {
      value.catalog.catalog.recommendation.textCandidates.push(
        structuredClone(value.catalog.catalog.recommendation.textCandidates[0]),
      );
    }],
    ["candidate unknown reason", (value) => {
      value.catalog.catalog.recommendation.textCandidates[0].reasonCodes = ["INTERNAL_HINT"];
    }],
    ["warning duplicate", (value) => {
      value.catalog.catalog.recommendation.warnings.push("RECOMMENDATIONS_UNVERIFIED");
    }],
    ["warning combination", (value) => {
      value.catalog.catalog.recommendation.warnings.push("NO_TEXT_MODEL_CANDIDATE");
    }],
    ["warning order", (value) => {
      value.catalog.catalog.recommendation.textCandidates = [];
      value.catalog.catalog.recommendation.imageCandidates = [];
      value.catalog.catalog.recommendation.warnings = [
        "RECOMMENDATIONS_UNVERIFIED", "NO_IMAGE_MODEL_CANDIDATE", "NO_TEXT_MODEL_CANDIDATE",
      ];
    }],
    ["model duplicate ID", (value) => {
      value.catalog.catalog.models.push(structuredClone(value.catalog.catalog.models[0]));
    }],
    ["model noncanonical order", (value) => { value.catalog.catalog.models.reverse(); }],
    ["model traversal segment", (value) => { value.catalog.catalog.models[0].id = "provider/../image-a"; }],
  ];
  for (const [label, mutate] of cases) {
    await t.test(label, async () => {
      current = structuredClone(baseline);
      mutate(current);
      await assert.rejects(loadAiSettingsCatalog("catalog-a"), {
        code: "AI_SETTINGS_CLIENT_RESPONSE_INVALID",
      });
    });
  }
});

test("overview rejects duplicate IDs inside each server action array", async (t) => {
  const produced = await task7ProducerOverview();
  const baseline = structuredClone(produced);
  let current = baseline;
  installTransport(t, async () => response(current));
  await loadAiSettings();
  for (const key of ["syncableConnectionIds", "profileCreatableCatalogIds", "testableProfileIds", "publishableProfileIds", "rollbackProfileIds"]) {
    await t.test(key, async () => {
      current = structuredClone(baseline);
      const id = key === "syncableConnectionIds" ? "connection-a"
        : key === "profileCreatableCatalogIds" ? "catalog-paid" : "profile-paid";
      current.actions[key] = [id, id];
      await assert.rejects(loadAiSettings(), { code: "AI_SETTINGS_CLIENT_RESPONSE_INVALID" });
    });
  }
});
