import assert from "node:assert/strict";
import test from "node:test";

import { createAutoListingAiSettingsPostgres } from "../auto-listing-ai-settings-postgres.mjs";
import { createAutoListingAiSettingsHttpHandler } from "../auto-listing-ai-settings-routes.mjs";
import { createAutoListingAiSettingsService } from "../auto-listing-ai-settings-service.mjs";

const NOW = "2026-08-09T00:00:00.000Z";
const admin = Object.freeze({ id: "account-a", role: "admin" });

function connectionRow(id, fence, createdAt = NOW) {
  return {
    fence: String(fence), id, account_id: "account-a", version: 1, display_name: id,
    base_url: "http://127.0.0.1:8080/v1", fingerprint: `fp-${id}`, key_version: "local-v1",
    status: "RETIRED", status_version: 4, validation_result: null, validated_at: null,
    activated_at: null, retired_at: createdAt, created_at: createdAt,
  };
}

function profileRow(id, createdAt = NOW) {
  return {
    id, account_id: "account-a", display_name: id, config_version: 1,
    base_url: "http://127.0.0.1:8080/v1", api_key_env_name: "SUB2API_ENCRYPTED_KEY",
    text_protocol: "SUB2API_RESPONSES", image_protocol: "SUB2API_OPENAI_IMAGES",
    text_model: "text-a", image_model: "image-a", enabled: false,
    capability_result: {}, capability_checked_at: null, connection_id: null,
    connection_version: null, created_at: createdAt,
  };
}

function modelCatalog(modelCount = 2) {
  const models = Array.from({ length: modelCount }, (_unused, index) => ({
    id: `model-${String(index).padStart(4, "0")}`,
    ownedBy: "provider",
    metadata: {},
  }));
  return {
    schemaVersion: "AUTO_LISTING_AI_MODEL_CATALOG_V1",
    connectionVersion: 1,
    syncedAt: NOW,
    requestIdHash: "c".repeat(64),
    activeSelectionState: "NOT_SELECTED",
    activeSelection: null,
    models,
    recommendation: {
      schemaVersion: "AUTO_LISTING_AI_MODEL_RECOMMENDATION_V1",
      verified: false,
      textCandidates: [],
      imageCandidates: [],
      warnings: ["RECOMMENDATIONS_UNVERIFIED", "NO_TEXT_MODEL_CANDIDATE", "NO_IMAGE_MODEL_CANDIDATE"],
    },
  };
}

function catalogDto(modelCount = 2) {
  return {
    id: "catalog-a", accountId: "account-a", connectionId: "connection-a", connectionVersion: 1,
    syncTaskId: "sync-a", catalog: modelCatalog(modelCount), catalogHash: "a".repeat(64),
    capabilityResult: { outcome: "NOT_TESTED", checkedAt: NOW, text: false, image: false },
    capabilityHash: "b".repeat(64), rollbackEvidenceIdentity: null, testedAt: NOW, createdAt: NOW,
  };
}

function serviceHarness(page) {
  const calls = [];
  const repository = {
    connectionIdForIntent() { return "connection-new"; },
    async loadSettingsOverview() { return structuredClone(page); },
    async loadSettingsOverviewPage(input) { calls.push(["page", input]); return structuredClone(page); },
    async loadSettingsCatalog(input) {
      calls.push(["catalog", input]);
      return { catalog: catalogDto(2_000), canCreateProfile: true };
    },
    async loadSettingsConnection() { return null; },
    async createPendingConnection() {}, async enqueueModelSync() {}, async createProfileFromSelection() {},
  };
  const service = createAutoListingAiSettingsService({
    repository,
    profileRepository: { async publishProfile() {}, async prepareProfileRollback() {}, async rollbackProfile() {} },
    cipher: { encrypt() {}, fingerprint() {} },
    capabilityService: { async testGatewayCapabilities() {} },
    allowLocalGateway: true,
  });
  return { service, calls };
}

test("repository overview pages use stable keyset limits and expose an explicit next cursor", async () => {
  const calls = [];
  let profileReads = 0;
  const pool = {
    async query() { return { rows: [] }; },
    async connect() {
      return {
        async query(sql, params = []) {
          calls.push({ sql, params });
          if (/^(?:BEGIN|COMMIT|ROLLBACK)/u.test(sql.trim())) return { rows: [] };
          if (/FROM ai_gateway_connection_versions[\s\S]*ORDER BY created_at DESC,fence DESC,id DESC/u.test(sql)) {
            return { rows: [connectionRow("connection-c", 3), connectionRow("connection-b", 2), connectionRow("connection-a", 1)] };
          }
          if (/FROM ai_gateway_connection_versions[\s\S]*status='ACTIVE'/u.test(sql)) return { rows: [] };
          if (/FROM ai_gateway_profiles p/u.test(sql)) {
            profileReads += 1;
            return { rows: profileReads % 2 === 1
              ? [profileRow("profile-c"), profileRow("profile-b"), profileRow("profile-a")] : [] };
          }
          return { rows: [] };
        },
        release() {},
      };
    },
  };
  const repository = createAutoListingAiSettingsPostgres({ pool });
  const first = await repository.loadSettingsOverviewPage({
    accountId: "account-a", connectionCursor: null, profileCursor: null, pageSize: 2,
  });
  assert.deepEqual(first.connections.map(({ id }) => id), ["connection-c", "connection-b"]);
  assert.deepEqual(first.profiles.map(({ id }) => id), ["profile-c", "profile-b"],
    calls.map(({ sql }) => sql.replace(/\s+/gu, " ").trim()).join("\n"));
  assert.deepEqual(first.pageInfo.connections.next, { createdAt: NOW, fence: "2", id: "connection-b" });
  assert.deepEqual(first.pageInfo.profiles.next, { createdAt: NOW, id: "profile-b" });
  const connectionSql = calls.find(({ sql }) => /ORDER BY created_at DESC,fence DESC,id DESC/u.test(sql));
  const profileSql = calls.find(({ sql }) => /ORDER BY p.created_at DESC,p.id DESC/u.test(sql));
  assert.match(connectionSql.sql, /LIMIT \$\d+/u);
  assert.match(profileSql.sql, /LIMIT \$\d+/u);
  assert.equal(connectionSql.params.at(-1), 3);
  assert.equal(profileSql.params.at(-1), 3);

  calls.length = 0;
  await repository.loadSettingsOverviewPage({
    accountId: "account-a",
    connectionCursor: first.pageInfo.connections.next,
    profileCursor: first.pageInfo.profiles.next,
    pageSize: 2,
  });
  assert.match(calls.find(({ sql }) => /ORDER BY created_at DESC,fence DESC,id DESC/u.test(sql)).sql,
    /\(created_at,fence,id\) < \(/u);
  assert.match(calls.find(({ sql }) => /ORDER BY p.created_at DESC,p.id DESC/u.test(sql)).sql,
    /\(p.created_at,p.id\) < \(/u);
});

test("overview returns bounded catalog summaries while an exact catalog endpoint keeps all 2000 models reachable", async () => {
  const fullCatalog = catalogDto(2_000);
  const page = {
    accountId: "account-a", activeConnection: null, activeProfile: null,
    connections: [], profiles: [], catalogs: [fullCatalog], syncTasks: [{
      id: "sync-a", accountId: "account-a", connectionId: "connection-a", connectionVersion: 1,
      syncPurpose: "CATALOG_SYNC", targetConnectionStatusVersion: 1, status: "SUCCEEDED",
      statusVersion: 3, attemptCount: 1, maxAttempts: 5, leaseVersion: 1,
      availableAt: NOW, completedAt: NOW, lastErrorCode: null, lastErrorSafe: null,
      createdAt: NOW, duplicate: false,
    }],
    pageInfo: {
      connections: { pageSize: 10, next: { createdAt: NOW, fence: "7", id: "connection-a" } },
      profiles: { pageSize: 10, next: null },
    },
  };
  const { service, calls } = serviceHarness(page);
  const first = await service.getOverview({ actor: admin });
  assert.equal(first.catalogs[0].catalog.modelCount, 2_000);
  assert.equal(Object.hasOwn(first.catalogs[0].catalog, "models"), false);
  assert.equal(Buffer.byteLength(JSON.stringify(first), "utf8") < 64 * 1024, true);
  assert.equal(first.pagination.connections.hasMore, true);
  assert.match(first.pagination.connections.nextCursor, /^[A-Za-z0-9_-]+$/u);

  await service.getOverview({ actor: admin, connectionCursor: first.pagination.connections.nextCursor });
  assert.deepEqual(calls.filter(([kind]) => kind === "page").at(-1)[1].connectionCursor,
    page.pageInfo.connections.next);

  const detail = await service.getCatalog({ actor: admin, catalogId: "catalog-a" });
  assert.equal(detail.catalog.catalog.models.length, 2_000);
  assert.equal(detail.actions.canCreateProfile, true);
  assert.deepEqual(calls.at(-1), ["catalog", { accountId: "account-a", catalogId: "catalog-a" }]);
});

test("overview cursors are tenant and kind bound and malformed cursors never reach persistence", async () => {
  const page = {
    accountId: "account-a", activeConnection: null, activeProfile: null,
    connections: [], profiles: [], catalogs: [], syncTasks: [],
    pageInfo: { connections: { pageSize: 10, next: null }, profiles: { pageSize: 10, next: null } },
  };
  const { service, calls } = serviceHarness(page);
  const foreign = Buffer.from(JSON.stringify({ v: 1, kind: "connections", accountId: "account-b",
    createdAt: NOW, fence: "1", id: "connection-a" }), "utf8").toString("base64url");
  for (const cursor of ["not+base64", foreign]) {
    await assert.rejects(service.getOverview({ actor: admin, connectionCursor: cursor }), {
      code: "AUTO_LISTING_AI_SETTINGS_REQUEST_INVALID",
    });
  }
  assert.equal(calls.length, 0);
});

test("repository pagination metadata fails closed before an invalid cursor reaches an administrator", async () => {
  const page = {
    accountId: "account-a", activeConnection: null, activeProfile: null,
    connections: [], profiles: [], catalogs: [], syncTasks: [],
    pageInfo: {
      connections: { pageSize: 10, next: { createdAt: "not-a-date", fence: "0", id: " connection" } },
      profiles: { pageSize: 10, next: null },
    },
  };
  const { service } = serviceHarness(page);
  await assert.rejects(service.getOverview({ actor: admin }), {
    code: "AUTO_LISTING_AI_SETTINGS_DATA_BOUNDARY",
  });
});

test("HTTP contracts bound overview to 64 KiB and allow a separately bounded catalog response", async () => {
  const responses = [];
  let mode = "overview";
  const service = {
    async getOverview(input) {
      assert.deepEqual(input, { actor: admin, connectionCursor: null, profileCursor: null });
      return mode === "oversized" ? { accountId: "account-a", payload: "x".repeat(70_000) }
        : { accountId: "account-a", pagination: {} };
    },
    async getCatalog(input) {
      assert.deepEqual(input, { actor: admin, catalogId: "catalog-a" });
      return { accountId: "account-a", catalog: { payload: "x".repeat(100_000) }, actions: { canCreateProfile: true } };
    },
  };
  const handler = createAutoListingAiSettingsHttpHandler({
    authenticate: async () => admin,
    getService: async () => service,
    readJson: async () => ({}),
    sendJson(_res, status, payload) { responses.push({ status, payload }); },
  });
  await handler({ method: "GET" }, {}, new URL("http://localhost/admin/auto-listing/ai-settings"));
  assert.equal(responses.at(-1).status, 200);
  await handler({ method: "GET" }, {}, new URL("http://localhost/admin/auto-listing/ai-settings/catalogs/catalog-a"));
  assert.equal(responses.at(-1).status, 200);
  assert.equal(Buffer.byteLength(JSON.stringify(responses.at(-1).payload), "utf8") > 64 * 1024, true);

  mode = "oversized";
  await handler({ method: "GET" }, {}, new URL("http://localhost/admin/auto-listing/ai-settings"));
  assert.deepEqual(responses.at(-1), {
    status: 500,
    payload: { ok: false, code: "AUTO_LISTING_AI_SETTINGS_RESPONSE_TOO_LARGE", message: "AI 模型设置请求处理失败" },
  });
});
