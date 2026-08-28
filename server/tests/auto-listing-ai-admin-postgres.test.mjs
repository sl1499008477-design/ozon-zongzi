import assert from "node:assert/strict";
import test from "node:test";

import { createAutoListingAiAdminPostgres } from "../auto-listing-ai-admin-postgres.mjs";

const profileRow = {
  id: "profile-a", account_id: "account-a", display_name: "Profile A", config_version: 1,
  base_url: "https://gateway.example/v1", api_key_env_name: "SUB2API_PRIMARY_KEY",
  text_protocol: "SUB2API_RESPONSES", image_protocol: "SUB2API_OPENAI_IMAGES",
  text_model: "text-model-a", image_model: "image-model-a", enabled: false,
  capability_result: {}, capability_checked_at: null, created_at: "2026-08-04T10:00:00.000Z",
};

const profileCommand = {
  accountId: "account-a", actorId: "account-a", idempotencyKey: "idem-profile-a",
  correlationId: "corr-profile-a",
  profile: {
    displayName: "Profile A", configVersion: 1, baseUrl: "https://gateway.example/v1",
    apiKeyEnvName: "SUB2API_PRIMARY_KEY", textProtocol: "SUB2API_RESPONSES",
    imageProtocol: "SUB2API_OPENAI_IMAGES", textModel: "text-model-a", imageModel: "image-model-a",
  },
};

const capabilityRequestKey = "b".repeat(64);
const capabilityAuthorizationHash = "a".repeat(64);

function authorizedAttempt(overrides = {}) {
  return {
    id: "attempt-a", fence: 1, account_id: "account-a", profile_id: "profile-a",
    config_version: 1, correlation_id: "corr-a", status: "RUNNING", response: null,
    lease_version: 1, lease_token: "caplease_initial", lease_expires_at: "2026-08-08T00:10:00.000Z",
    authorization_schema_version: "AI_GATEWAY_CAPABILITY_AUTHORIZATION_V1",
    purpose: "PROFILE_CAPABILITY", cost_confirmed: true,
    authorization_hash: capabilityAuthorizationHash, request_key: capabilityRequestKey,
    actor_id: "account-a", target_connection_id: null, target_connection_version: null,
    target_connection_status: "LEGACY", target_connection_status_version: 0,
    authorized_at: "2026-08-08T00:00:00.000Z",
    ...overrides,
  };
}

function capabilitySubcallExecution(overrides = {}) {
  return {
    accountId: "account-a", profileId: "profile-a", configVersion: 1,
    attemptId: "attempt-authorized", correlationId: "corr-authorized", fence: 12,
    leaseVersion: 1, leaseToken: "caplease_authorized", purpose: "PROFILE_CAPABILITY",
    authorizationHash: capabilityAuthorizationHash, requestKey: capabilityRequestKey,
    connectionId: "connection-a", connectionVersion: 1,
    expectedConnectionStatus: "VALIDATED", expectedConnectionStatusVersion: 2,
    probe: "TEXT", ...overrides,
  };
}

function scriptedPool(steps) {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      if (/UPDATE ai_gateway_capability_attempts[\s\S]*AUTO_LISTING_AI_LEGACY_CAPABILITY_QUARANTINED/iu.test(sql)
        || /response->>'errorCode'='AUTO_LISTING_AI_LEGACY_CAPABILITY_QUARANTINED'/iu.test(sql)
        || /auto_listing_cleanup_expired_prepared_capability_subcalls/iu.test(sql)
        || /SELECT id FROM ai_gateway_capability_subcall_reservations[\s\S]*status IN \('PREPARED','SENDING'\)/iu.test(sql)
        || /UPDATE ai_gateway_capability_subcall_reservations[\s\S]*reservation_version=reservation_version\+1/iu.test(sql)) {
        return { rowCount: 0, rows: [] };
      }
      calls.push({ sql, params });
      const step = steps.shift();
      assert.ok(step, `unexpected query: ${sql}`);
      if (typeof step === "function") return step(sql, params);
      return step;
    },
    release() { calls.push({ sql: "RELEASE", params: [] }); },
  };
  const pool = {
    async connect() { return client; },
    async query(sql, params = []) { return client.query(sql, params); },
  };
  return { pool, client, calls, remaining: steps };
}

test("admin PostgreSQL repository factory is closed and requires a real pool", () => {
  const pool = { async connect() {}, async query() {} };
  assert.deepEqual(Object.keys(createAutoListingAiAdminPostgres({ pool })).sort(), [
    "archiveCategoryStrategyDraft", "beginCapabilityTest", "completeCapabilitySubcall", "completeCapabilityTest", "createProfile", "createStrategyVersion",
    "listProfiles", "listStrategyVersions", "loadCapabilityExecutionForSecretResolution",
    "loadConnectionForCapabilitySecretResolution",
    "markCapabilitySubcallSending",
    "prepareProfileRollback", "publishCategoryStrategyDraft", "publishProfile", "publishStrategyVersion",
    "rollbackCategoryStrategyVersion", "rollbackProfile",
  ]);
  assert.equal(typeof createAutoListingAiAdminPostgres({ pool }).publishCategoryStrategyDraft, "function");
  assert.equal(typeof createAutoListingAiAdminPostgres({ pool }).archiveCategoryStrategyDraft, "function");
  assert.equal(typeof createAutoListingAiAdminPostgres({ pool }).rollbackCategoryStrategyVersion, "function");
  assert.throws(() => createAutoListingAiAdminPostgres({ pool, apiKey: "raw" }), {
    code: "AUTO_LISTING_AI_ADMIN_REPOSITORY_INVALID",
  });
  assert.throws(() => createAutoListingAiAdminPostgres({ pool: {} }), {
    code: "AUTO_LISTING_AI_ADMIN_REPOSITORY_INVALID",
  });
});

test("category publish and rollback reject hidden fields, accessors, custom prototypes, and proxies before traps or I/O", async () => {
  let poolCalls = 0;
  let getterRuns = 0;
  let proxyTrapRuns = 0;
  const pool = {
    async connect() { poolCalls += 1; throw new Error("database must not be reached"); },
    async query() { poolCalls += 1; throw new Error("database must not be reached"); },
  };
  const repository = createAutoListingAiAdminPostgres({ pool });
  const commands = [{
    method: "publishCategoryStrategyDraft",
    input: {
      accountId: "account-a", actorId: "account-a", draftId: "draft-a", expectedDraftVersion: 4,
      expectedPublishedStrategyVersionId: "strategy-a", idempotencyKey: "publish-a", correlationId: "corr-a",
    },
  }, {
    method: "archiveCategoryStrategyDraft",
    input: {
      accountId: "account-a", actorId: "account-a", draftId: "draft-a", expectedDraftVersion: 4,
      idempotencyKey: "archive-a", correlationId: "corr-a",
    },
  }, {
    method: "rollbackCategoryStrategyVersion",
    input: {
      accountId: "account-a", actorId: "account-a", targetStrategyVersionId: "strategy-old",
      expectedPublishedStrategyVersionId: "strategy-a", idempotencyKey: "rollback-a", correlationId: "corr-a",
    },
  }];
  const hostileInputs = [
    (input) => Object.assign({ ...input }, { [Symbol("hidden")]: "secret" }),
    (input) => {
      const value = { ...input };
      Object.defineProperty(value, "hidden", { value: "secret", enumerable: false });
      return value;
    },
    (input) => {
      const value = { ...input };
      Object.defineProperty(value, "hidden", {
        enumerable: true,
        get() { getterRuns += 1; throw new Error("getter-secret"); },
      });
      return value;
    },
    (input) => Object.assign(Object.create({ inherited: true }), input),
    (input) => new Proxy({ ...input }, {
      getPrototypeOf() { proxyTrapRuns += 1; throw new Error("proxy-secret"); },
      ownKeys() { proxyTrapRuns += 1; throw new Error("proxy-secret"); },
      getOwnPropertyDescriptor() { proxyTrapRuns += 1; throw new Error("proxy-secret"); },
      get() { proxyTrapRuns += 1; throw new Error("proxy-secret"); },
    }),
    (input) => new Proxy({ ...input }, {}),
    (input) => {
      const revoked = Proxy.revocable({ ...input }, {});
      revoked.revoke();
      return revoked.proxy;
    },
  ];
  for (const { method, input } of commands) {
    for (const hostile of hostileInputs) {
      await assert.rejects(repository[method](hostile(input)), {
        code: "AUTO_LISTING_AI_ADMIN_REPOSITORY_INVALID", status: 422,
      });
    }
  }
  assert.equal(getterRuns, 0);
  assert.equal(proxyTrapRuns, 0);
  assert.equal(poolCalls, 0);
});

test("category publish accepts the authoritative manual-confirmation source before checking analysis", async () => {
  const draft = {
    id: "category-draft-manual", account_id: "account-a", draft_version: 4, status: "DRAFT_READY",
    source_collect_item_id: "collect-manual", source_product_draft_id: "product-draft-manual",
    source_product_draft_version: 2, expected_source_version: "draft:2",
    taxonomy_scope: "OZON:DEFAULT", description_category_id: "17027923", type_id: "94891",
  };
  const { pool, calls } = scriptedPool([
    { rows: [] },
    { rows: [{ id: "account-a" }] },
    { rows: [] },
    { rows: [] },
    { rows: [] },
    { rows: [{ mode: "REQUIRE_EXACT_STRATEGY" }] },
    { rows: [draft] },
    (sql) => {
      const rejectsManual = /pointer\.source_kind='PRODUCT_DRAFT'/u.test(sql)
        || /pointer\.source_version IN \(product_draft\.version::TEXT,'draft:' \|\| product_draft\.version::TEXT\)/u.test(sql);
      return { rows: rejectsManual ? [] : [{ id: draft.source_collect_item_id }] };
    },
    { rows: [] },
    { rows: [] },
  ]);

  await assert.rejects(createAutoListingAiAdminPostgres({ pool }).publishCategoryStrategyDraft({
    accountId: "account-a", actorId: "account-a", draftId: draft.id, expectedDraftVersion: 4,
    expectedPublishedStrategyVersionId: "strategy-current", idempotencyKey: "publish-manual",
    correlationId: "publish-manual-correlation",
  }), { code: "AUTO_LISTING_AI_STRATEGY_NOT_PUBLISHABLE", status: 409 });

  assert.equal(calls.at(-2).sql, "ROLLBACK");
});

test("profile creation serializes by account, persists only an env reference, and writes idempotent audit evidence", async () => {
  const { pool, calls, remaining } = scriptedPool([
    { rows: [] },
    (sql, params) => {
      assert.match(sql, /FROM accounts WHERE id=\$1 FOR UPDATE/iu);
      assert.deepEqual(params, ["account-a"]);
      return { rowCount: 1, rows: [{ id: "account-a" }] };
    },
    { rowCount: 0, rows: [] },
    (sql, params) => {
      assert.match(sql, /INSERT INTO ai_gateway_profiles/iu);
      assert.match(sql, /api_key_env_name/iu);
      assert.doesNotMatch(sql, /api_key_value|secret|raw_key/iu);
      assert.equal(params.includes("SUB2API_PRIMARY_KEY"), true);
      assert.equal(params.some((value) => value === "raw-secret"), false);
      return { rowCount: 1, rows: [profileRow] };
    },
    (sql, params) => {
      assert.match(sql, /INSERT INTO audit_events/iu);
      const metadata = JSON.parse(params.find((value) => typeof value === "string" && value.startsWith("{")));
      assert.match(metadata.requestHash, /^[a-f0-9]{64}$/);
      assert.equal(metadata.entityId, "profile-a");
      assert.doesNotMatch(JSON.stringify(metadata), /SUB2API_PRIMARY_KEY|base_url|model|secret/iu);
      return { rowCount: 1, rows: [{ event_id: params[0] }] };
    },
    { rows: [] },
  ]);
  const repository = createAutoListingAiAdminPostgres({ pool });
  const result = await repository.createProfile(profileCommand);
  assert.equal(result.id, "profile-a");
  assert.equal(result.duplicate, false);
  assert.equal(calls[0].sql, "BEGIN");
  assert.equal(calls.at(-2).sql, "COMMIT");
  assert.equal(remaining.length, 0);
});

test("profile creation replay returns its exact recorded entity without another insert", async () => {
  const { pool, calls } = scriptedPool([
    { rows: [] },
    { rowCount: 1, rows: [{ id: "account-a" }] },
    (_sql, params) => ({ rowCount: 1, rows: [{
      metadata: { requestHash: params[2], entityId: "profile-a", configVersion: 1 },
    }] }),
    { rowCount: 1, rows: [profileRow] },
    { rows: [] },
  ]);
  const repository = createAutoListingAiAdminPostgres({ pool });
  const result = await repository.createProfile(profileCommand);
  assert.equal(result.duplicate, true);
  assert.equal(calls.some(({ sql }) => /INSERT INTO ai_gateway_profiles/iu.test(sql)), false);
  assert.equal(calls.at(-2).sql, "COMMIT");
});

test("an idempotency key reused with different profile content fails closed before writes", async () => {
  const { pool, calls } = scriptedPool([
    { rows: [] },
    { rowCount: 1, rows: [{ id: "account-a" }] },
    { rowCount: 1, rows: [{ metadata: { requestHash: "other-hash", entityId: "profile-a", configVersion: 1 } }] },
    { rows: [] },
  ]);
  const repository = createAutoListingAiAdminPostgres({ pool });
  await assert.rejects(repository.createProfile(profileCommand), {
    code: "AUTO_LISTING_AI_ADMIN_IDEMPOTENCY_CONFLICT", retryable: false,
  });
  assert.equal(calls.some(({ sql }) => /INSERT INTO|UPDATE (?:ai_gateway|ai_content)/iu.test(sql)), false);
  assert.equal(calls.at(-2).sql, "ROLLBACK");
});

test("profile list is exact account-scoped", async () => {
  const { pool, calls } = scriptedPool([{ rows: [profileRow] }]);
  const repository = createAutoListingAiAdminPostgres({ pool });
  const listed = await repository.listProfiles({ accountId: "account-a" });
  assert.equal(listed[0].accountId, "account-a");
  assert.equal(listed[0].connectionId, null);
  assert.equal(listed[0].connectionVersion, null);
  assert.match(calls[0].sql, /connection_id,connection_version/iu);
  assert.match(calls[0].sql, /WHERE account_id=\$1/iu);
});

test("capability secret resolution exposes encrypted data only for exact VALIDATED ACTIVE or RETIRED connection scope", async () => {
  const encryptedConnection = {
    id: "connection-a", account_id: "account-a", version: 1, display_name: "Gateway",
    base_url: "https://gateway.example/v1", status: "VALIDATED", ciphertext: "cipher",
    iv: "iv", auth_tag: "tag", algorithm: "aes-256-gcm", key_version: "local-v1", fingerprint: "fp",
  };
  const { pool, calls } = scriptedPool([{ rows: [encryptedConnection] }]);
  const repository = createAutoListingAiAdminPostgres({ pool });
  const result = await repository.loadConnectionForCapabilitySecretResolution({
    accountId: "account-a", connectionId: "connection-a", connectionVersion: 1,
  });
  assert.equal(result.status, "VALIDATED");
  assert.equal(result.encryptedSecret.ciphertext, "cipher");
  assert.match(calls[0].sql, /status IN \('VALIDATED','ACTIVE','RETIRED'\)/iu);
  assert.deepEqual(calls[0].params, ["account-a", "connection-a", 1]);
});

test("connection-backed capability begin locks an ACTIVE successor to the exact status and latest successful catalog before paid work", async () => {
  const connected = { ...profileRow, api_key_env_name: "SUB2API_ENCRYPTED_KEY",
    connection_id: "connection-a", connection_version: 1 };
  const { pool, calls } = scriptedPool([
    { rows: [] },
    { rowCount: 1, rows: [{ id: "account-a" }] },
    { rowCount: 1, rows: [connected] },
    { rowCount: 0, rows: [] },
    { rowCount: 1, rows: [{ id: "connection-a", version: 1,
      status: "ACTIVE", status_version: 3, catalog_id: "catalog-a" }] },
    (sql, params) => {
      assert.match(sql, /ai_gateway_profile_binding_events/iu);
      assert.match(sql, /enabled IS TRUE/iu);
      assert.match(sql, /enabled IS FALSE/iu);
      assert.match(sql, /ai_gateway_model_catalogs/iu);
      assert.deepEqual(params, ["account-a", "profile-a", 1, "connection-a", 1]);
      return { rowCount: 1, rows: [{ active_profile_id: "profile-current", catalog_id: "catalog-a" }] };
    },
    { rowCount: 1, rows: [authorizedAttempt({
      target_connection_id: "connection-a", target_connection_version: 1,
      target_connection_status: "ACTIVE", target_connection_status_version: 3,
    })] },
    { rowCount: 1, rows: [{ event_id: "authorization-audit" }] },
    { rows: [] },
  ]);
  const result = await createAutoListingAiAdminPostgres({ pool }).beginCapabilityTest({ costConfirmed: true,
    accountId: "account-a", actorId: "account-a", profileId: "profile-a", configVersion: 1,
    correlationId: "corr-a", attemptId: "attempt-a", purpose: "PROFILE_CAPABILITY",
    requestKey: capabilityRequestKey,
  });
  assert.equal(result.profile.connectionId, "connection-a");
  assert.equal(result.capabilityExecution.expectedConnectionStatus, "ACTIVE");
  assert.equal(result.capabilityExecution.expectedConnectionStatusVersion, 3);
  assert.match(calls[4].sql, /c\.status IN \('VALIDATED','ACTIVE'\)/iu);
  assert.match(calls[4].sql, /ai_gateway_model_catalogs/iu);
  assert.match(calls[4].sql, /catalog->'models'/iu);
});

test("ACTIVE capability begin rejects the current enabled profile before creating a paid attempt", async () => {
  const current = { ...profileRow, enabled: true, api_key_env_name: "SUB2API_ENCRYPTED_KEY",
    connection_id: "connection-a", connection_version: 1 };
  const { pool, calls } = scriptedPool([
    { rows: [] }, { rows: [{ id: "account-a" }] }, { rows: [current] }, { rows: [] },
    { rows: [{ id: "connection-a", version: 1, status: "ACTIVE", status_version: 3,
      catalog_id: "catalog-a" }] },
    { rows: [] }, { rows: [] },
  ]);

  await assert.rejects(createAutoListingAiAdminPostgres({ pool }).beginCapabilityTest({
    costConfirmed: true, accountId: "account-a", actorId: "account-a",
    profileId: "profile-a", configVersion: 1, correlationId: "corr-current",
    attemptId: "attempt-current", purpose: "PROFILE_CAPABILITY", requestKey: capabilityRequestKey,
  }), { code: "AUTO_LISTING_AI_PROFILE_CONNECTION_NOT_VALIDATED", status: 409 });
  assert.equal(calls.some(({ sql }) => /INSERT INTO ai_gateway_capability_attempts/iu.test(sql)), false);
});

test("capability begin creates one fenced account-scoped attempt in a transaction", async () => {
  const { pool, calls } = scriptedPool([
    { rows: [] },
    { rowCount: 1, rows: [{ id: "account-a" }] },
    { rowCount: 1, rows: [profileRow] },
    { rowCount: 0, rows: [] },
    { rowCount: 1, rows: [authorizedAttempt({ fence: "9" })] },
    { rowCount: 1, rows: [{ event_id: "authorization-audit" }] },
    { rows: [] },
  ]);
  const repository = createAutoListingAiAdminPostgres({ pool });
  const result = await repository.beginCapabilityTest({ costConfirmed: true,
    accountId: "account-a", actorId: "account-a", profileId: "profile-a", configVersion: 1,
    correlationId: "corr-a", attemptId: "attempt-a", requestKey: capabilityRequestKey,
  });
  assert.equal(result.fence, 9);
  assert.equal(result.leaseVersion, 1);
  assert.equal(result.leaseToken, "caplease_initial");
  assert.equal(result.profile.apiKeyEnvName, "SUB2API_PRIMARY_KEY");
  assert.match(calls[2].sql, /ai_gateway_profiles[\s\S]*FOR UPDATE/iu);
  assert.match(calls[4].sql, /INSERT INTO ai_gateway_capability_attempts/iu);
  assert.equal(calls.at(-2).sql, "COMMIT");
});

test("capability begin durably authorizes purpose cost identity and connection fence before provider work", async () => {
  const connected = { ...profileRow, api_key_env_name: "SUB2API_ENCRYPTED_KEY",
    connection_id: "connection-a", connection_version: 1 };
  const authorizationHash = "a".repeat(64);
  const requestKey = "b".repeat(64);
  const { pool, calls, remaining } = scriptedPool([
    { rows: [] },
    { rows: [{ id: "account-a" }] },
    { rows: [connected] },
    { rows: [] },
    { rows: [{ id: "connection-a", version: 1, status: "VALIDATED", status_version: 2, catalog_id: "catalog-a" }] },
    (sql) => {
      assert.match(sql, /INSERT INTO ai_gateway_capability_attempts/iu);
      for (const column of ["purpose", "cost_confirmed", "authorization_hash", "request_key", "actor_id",
        "target_connection_id", "target_connection_version", "target_connection_status",
        "target_connection_status_version", "authorized_at"]) assert.match(sql, new RegExp(column, "iu"));
      return { rowCount: 1, rows: [{ id: "attempt-authorized", fence: 12, account_id: "account-a",
        profile_id: "profile-a", config_version: 1, correlation_id: "corr-authorized",
        status: "RUNNING", response: null,
        lease_version: 1, lease_token: "caplease_authorized", lease_expires_at: "2026-08-08T00:10:00.000Z",
        authorization_schema_version: "AI_GATEWAY_CAPABILITY_AUTHORIZATION_V1",
        purpose: "PROFILE_CAPABILITY", cost_confirmed: true, authorization_hash: authorizationHash,
        request_key: requestKey, actor_id: "account-a",
        target_connection_id: "connection-a", target_connection_version: 1,
        target_connection_status: "VALIDATED", target_connection_status_version: 2 }] };
    },
    (sql, params) => {
      assert.match(sql, /INSERT INTO audit_events/iu);
      assert.equal(params.includes("AUTO_LISTING_AI_PROFILE_CAPABILITY_AUTHORIZED"), true);
      const metadata = JSON.parse(params.find((value) => typeof value === "string" && value.startsWith("{")));
      assert.equal(metadata.purpose, "PROFILE_CAPABILITY");
      assert.equal(metadata.costConfirmed, true);
      assert.equal(metadata.authorizationHash, authorizationHash);
      assert.equal(metadata.targetConnectionStatus, "VALIDATED");
      assert.equal(metadata.targetConnectionStatusVersion, 2);
      assert.match(metadata.leaseTokenHash, /^[a-f0-9]{64}$/u);
      assert.doesNotMatch(JSON.stringify(metadata), /caplease_authorized/iu);
      return { rowCount: 1, rows: [{ event_id: params[0] }] };
    },
    { rows: [] },
  ]);
  const result = await createAutoListingAiAdminPostgres({ pool }).beginCapabilityTest({
    costConfirmed: true, accountId: "account-a", actorId: "account-a",
    profileId: "profile-a", configVersion: 1, correlationId: "corr-authorized",
    attemptId: "attempt-authorized", purpose: "PROFILE_CAPABILITY", requestKey,
  });
  assert.deepEqual(result.capabilityExecution, {
    accountId: "account-a", profileId: "profile-a", configVersion: 1,
    attemptId: "attempt-authorized", correlationId: "corr-authorized", fence: 12, leaseVersion: 1,
    leaseToken: "caplease_authorized", purpose: "PROFILE_CAPABILITY",
    authorizationHash, requestKey, connectionId: "connection-a", connectionVersion: 1,
    expectedConnectionStatus: "VALIDATED", expectedConnectionStatusVersion: 2,
  });
  assert.equal(calls.at(-2).sql, "COMMIT");
  assert.equal(remaining.length, 0);
});

test("paid credential loading atomically binds authorization audit lease latest attempt and connection status fence", async () => {
  const execution = capabilitySubcallExecution({ expectedConnectionStatus: "ACTIVE",
    expectedConnectionStatusVersion: 3 });
  const { pool, calls } = scriptedPool([
    { rows: [] }, { rows: [{ id: "account-a" }] },
    { rows: [{
      id: "attempt-authorized", status: "RUNNING", account_id: "account-a", profile_id: "profile-a",
      config_version: 1, api_key_env_name: "SUB2API_ENCRYPTED_KEY", connection_id: "connection-a",
      connection_version: 1, connection_status: "ACTIVE", connection_status_version: 3,
      ciphertext: "cipher", iv: "iv", auth_tag: "tag", algorithm: "aes-256-gcm",
      key_version: "local-v1", fingerprint: "fp",
    }] },
    { rows: [{ active_profile_id: "profile-current", catalog_id: "catalog-a" }] },
    { rowCount: 0, rows: [] },
    (sql, params) => ({ rowCount: 1, rows: [{ id: params[0], status: "PREPARED",
      lease_version: 1, reservation_version: 1,
      provider_request_key: params[8], provider_correlation_id: params[9] }] }),
    { rowCount: 0, rows: [] },
    { rowCount: 1, rows: [{ event_id: "reservation-audit" }] },
    { rows: [] },
  ]);
  const loaded = await createAutoListingAiAdminPostgres({ pool })
    .loadCapabilityExecutionForSecretResolution(execution);
  assert.equal(loaded.connection.status, "ACTIVE");
  assert.equal(loaded.connection.statusVersion, 3);
  assert.equal(loaded.connection.encryptedSecret.ciphertext, "cipher");
  assert.match(loaded.providerRequestKey, /^[a-f0-9]{64}$/u);
  assert.match(loaded.providerCorrelationId, /^cap_[a-f0-9]{40}$/u);
  assert.match(calls[2].sql, /ai_gateway_capability_attempts/iu);
  assert.match(calls[2].sql, /AUTO_LISTING_AI_PROFILE_CAPABILITY_AUTHORIZED/iu);
  assert.match(calls[2].sql, /lease_expires_at\s*>\s*NOW\(\)/iu);
  assert.match(calls[2].sql, /newer\.fence/iu);
  assert.match(calls[2].sql, /c\.status=\$\d+/iu);
  assert.match(calls[2].sql, /c\.status_version=\$\d+/iu);
});

test("publishing a tested successor on its already ACTIVE connection atomically swaps profiles without rotating the connection", async () => {
  const passed = {
    ...profileRow,
    api_key_env_name: "SUB2API_ENCRYPTED_KEY", connection_id: "connection-active", connection_version: 1,
    capability_result: { outcome: "PASSED", features: ["STRUCTURED_TEXT", "IMAGE_GENERATION", "IMAGE_DECODE_PNG"],
      models: { text: "text-model-a", image: "image-model-a" }, checkedAt: "2026-08-04T10:01:00.000Z" },
    capability_checked_at: "2026-08-04T10:01:00.000Z",
  };
  const { pool, calls, remaining } = scriptedPool([
    { rows: [] }, { rows: [{ id: "account-a" }] }, { rows: [] }, { rows: [passed] },
    { rows: [{ id: "catalog-active", status: "ACTIVE", version: 1, status_version: 3 }] },
    { rows: [{ active_profile_id: "profile-current", catalog_id: "catalog-active" }] },
    { rows: [{ id: "profile-current", config_version: 1 }] }, { rows: [] },
    { rows: [{ id: "connection-active", version: 1, status_version: 3 }] },
    { rows: [{ ...passed, enabled: true }] },
    { rowCount: 1, rows: [{ event_id: "audit-profile", action: "AUTO_LISTING_AI_PROFILE_PUBLISH",
      actor_id: "account-a", occurred_at: new Date("2026-08-09T02:03:04.000Z") }] }, { rows: [] },
  ]);

  const result = await createAutoListingAiAdminPostgres({ pool }).publishProfile({
    accountId: "account-a", actorId: "account-a", profileId: "profile-a", configVersion: 1,
    idempotencyKey: "publish-active-successor", correlationId: "corr-active-successor",
  });

  assert.equal(result.enabled, true);
  assert.deepEqual(result.activation, {
    kind: "PUBLISH", occurredAt: "2026-08-09T02:03:04.000Z", actorId: "account-a",
  });
  assert.equal(calls.some(({ sql }) => /SET status='RETIRED'|SET status='ACTIVE'/iu.test(sql)), false);
  assert.equal(calls.some(({ sql }) => /SET enabled=FALSE/iu.test(sql)), true);
  assert.equal(calls.some(({ sql }) => /SET enabled=TRUE/iu.test(sql)), true);
  assert.equal(calls.at(-2).sql, "COMMIT");
  assert.equal(remaining.length, 0);
});

test("paid credential preparation recovers exact ownership after its COMMIT response is lost", async () => {
  let providerRequestKey;
  let providerCorrelationId;
  const loaded = {
    id: "attempt-authorized", status: "RUNNING", account_id: "account-a", profile_id: "profile-a",
    config_version: 1, api_key_env_name: "SUB2API_ENCRYPTED_KEY", connection_id: "connection-a",
    connection_version: 1, connection_status: "VALIDATED", connection_status_version: 2,
    ciphertext: "cipher", iv: "iv", auth_tag: "tag", algorithm: "aes-256-gcm",
    key_version: "local-v1", fingerprint: "fp",
  };
  const { pool, calls, remaining } = scriptedPool([
    { rows: [] }, { rows: [{ id: "account-a" }] }, { rows: [loaded] }, { rows: [] },
    (_sql, params) => {
      providerRequestKey = params[8];
      providerCorrelationId = params[9];
      return { rowCount: 1, rows: [{ id: "reservation-a", status: "PREPARED", lease_version: 1,
        reservation_version: 1, provider_request_key: providerRequestKey,
        provider_correlation_id: providerCorrelationId }] };
    },
    { rows: [] }, { rowCount: 1, rows: [{ event_id: "reservation-audit" }] },
    () => { throw new Error("commit response lost"); }, { rows: [] },
    (sql, params) => {
      assert.match(sql, /prepared_audit_matches/iu);
      assert.equal(params.includes("AUTO_LISTING_AI_PROFILE_CAPABILITY_SUBCALL_RESERVED"), true);
      return { rows: [{ ...loaded, reservation_status: "PREPARED", reservation_version: 1,
        provider_request_key: providerRequestKey, provider_correlation_id: providerCorrelationId,
        prepared_audit_matches: true }] };
    },
  ]);

  const result = await createAutoListingAiAdminPostgres({ pool })
    .loadCapabilityExecutionForSecretResolution(capabilitySubcallExecution());

  assert.equal(result.connection.encryptedSecret.ciphertext, "cipher");
  assert.equal(result.providerRequestKey, providerRequestKey);
  assert.equal(result.providerCorrelationId, providerCorrelationId);
  assert.equal(calls.some(({ sql }) => sql === "ROLLBACK"), true);
  assert.equal(remaining.length, 0);
});

test("paid credential preparation retries the same operation when failed COMMIT left no reservation", async () => {
  const loaded = {
    id: "attempt-authorized", status: "RUNNING", account_id: "account-a", profile_id: "profile-a",
    config_version: 1, api_key_env_name: "SUB2API_ENCRYPTED_KEY", connection_id: "connection-a",
    connection_version: 1, connection_status: "VALIDATED", connection_status_version: 2,
    ciphertext: "cipher", iv: "iv", auth_tag: "tag", algorithm: "aes-256-gcm",
    key_version: "local-v1", fingerprint: "fp",
  };
  const reservation = (_sql, params) => ({ rowCount: 1, rows: [{ id: "reservation-a",
    status: "PREPARED", lease_version: 1, reservation_version: 1,
    provider_request_key: params[8], provider_correlation_id: params[9] }] });
  const { pool, calls, remaining } = scriptedPool([
    { rows: [] }, { rows: [{ id: "account-a" }] }, { rows: [loaded] }, { rows: [] },
    reservation, { rows: [] }, { rowCount: 1, rows: [{ event_id: "reservation-audit-rolled-back" }] },
    () => { throw new Error("commit rejected before persistence"); }, { rows: [] },
    { rows: [] },
    { rows: [] }, { rows: [{ id: "account-a" }] }, { rows: [loaded] }, { rows: [] },
    reservation, { rows: [] }, { rowCount: 1, rows: [{ event_id: "reservation-audit-retried" }] },
    { rows: [] },
  ]);

  const result = await createAutoListingAiAdminPostgres({ pool })
    .loadCapabilityExecutionForSecretResolution(capabilitySubcallExecution());

  assert.equal(result.connection.status, "VALIDATED");
  assert.match(result.providerRequestKey, /^[a-f0-9]{64}$/u);
  assert.equal(calls.filter(({ sql }) => sql === "BEGIN").length, 2);
  assert.equal(remaining.length, 0);
});

test("capability subcall completion records exact terminal evidence before releasing the account fence", async () => {
  let providerRequestKey;
  let providerCorrelationId;
  const { pool, calls, remaining } = scriptedPool([
    { rows: [] },
    { rowCount: 1, rows: [{ id: "account-a" }] },
    (_sql, params) => {
      providerRequestKey = params[11];
      providerCorrelationId = params[12];
      return { rowCount: 1, rows: [{ status: "SUCCEEDED", provider_request_key: providerRequestKey,
        provider_correlation_id: providerCorrelationId, reservation_version: 1 }] };
    },
    { rowCount: 0, rows: [] },
    (sql, params) => {
      assert.match(sql, /INSERT INTO audit_events/iu);
      const metadata = JSON.parse(params.find((value) => typeof value === "string" && value.startsWith("{")));
      assert.equal(metadata.outcome, "SUCCEEDED");
      assert.equal(metadata.reason, "PROVIDER_ACCEPTED");
      assert.equal(metadata.attemptId, "attempt-authorized");
      assert.equal(metadata.stage, "TEXT");
      assert.equal(metadata.providerRequestKey, providerRequestKey);
      assert.match(metadata.providerRequestKeyHash, /^[a-f0-9]{64}$/u);
      assert.equal(metadata.providerCorrelationId, providerCorrelationId);
      assert.equal(metadata.reservationVersion, 1);
      return { rowCount: 1, rows: [{ event_id: params[0] }] };
    },
    { rows: [] },
  ]);

  const result = await createAutoListingAiAdminPostgres({ pool }).completeCapabilitySubcall({
    ...capabilitySubcallExecution(), outcome: "SUCCEEDED", reason: "PROVIDER_ACCEPTED",
  });

  assert.deepEqual(result, { terminal: true, duplicate: false, reconciled: false });
  assert.equal(calls[0].sql, "BEGIN");
  assert.equal(calls.at(-2).sql, "COMMIT");
  assert.equal(remaining.length, 0);
});

test("capability subcall completion reconciles an exact committed success after COMMIT response loss", async () => {
  let providerRequestKey;
  let providerCorrelationId;
  const { pool, calls, remaining } = scriptedPool([
    { rows: [] },
    { rowCount: 1, rows: [{ id: "account-a" }] },
    (_sql, params) => {
      providerRequestKey = params[11];
      providerCorrelationId = params[12];
      return { rowCount: 1, rows: [{ status: "SUCCEEDED", provider_request_key: providerRequestKey,
        provider_correlation_id: providerCorrelationId, reservation_version: 1 }] };
    },
    { rowCount: 0, rows: [] },
    { rowCount: 1, rows: [{ event_id: "terminal-audit" }] },
    () => { throw new Error("commit response lost"); },
    { rows: [] },
    (sql, params) => {
      assert.match(sql, /ai_gateway_capability_subcall_reservations/iu);
      assert.match(sql, /audit_events/iu);
      assert.deepEqual(params.slice(0, 4), ["account-a", "attempt-authorized", "TEXT", 1]);
      return { rowCount: 1, rows: [{ status: "SUCCEEDED", provider_request_key: providerRequestKey,
        provider_correlation_id: providerCorrelationId, reservation_version: 1,
        terminal_reason: "PROVIDER_ACCEPTED",
        terminal_audit_matches: true }] };
    },
  ]);

  const result = await createAutoListingAiAdminPostgres({ pool }).completeCapabilitySubcall({
    ...capabilitySubcallExecution(), outcome: "SUCCEEDED", reason: "PROVIDER_ACCEPTED",
  });

  assert.deepEqual(result, { terminal: true, duplicate: true, reconciled: true });
  assert.equal(calls.some(({ sql }) => sql === "ROLLBACK"), true);
  assert.equal(remaining.length, 0);
});

test("capability completion applies its fence and audit in one transaction", async () => {
  const { pool, calls } = scriptedPool([
    { rows: [] },
    { rowCount: 1, rows: [{ id: "account-a" }] },
    { rowCount: 1, rows: [profileRow] },
    { rowCount: 1, rows: [authorizedAttempt({ fence: "9", completion_hash: null, lease_live: true })] },
    { rowCount: 1, rows: [{ id: "attempt-a", fence: "9" }] },
    { rowCount: 1, rows: [{ enabled: false }] },
    { rowCount: 1, rows: [{ id: "attempt-a" }] },
    { rowCount: 0, rows: [] },
    { rowCount: 1, rows: [{ event_id: "audit" }] },
    { rows: [] },
  ]);
  const repository = createAutoListingAiAdminPostgres({ pool });
  const result = await repository.completeCapabilityTest({ costConfirmed: true,
    accountId: "account-a", actorId: "account-a", profileId: "profile-a", configVersion: 1,
    correlationId: "corr-a", attemptId: "attempt-a", fence: 9,
    leaseVersion: 1, leaseToken: "caplease_initial", requestKey: capabilityRequestKey,
    capabilityResult: { outcome: "PASSED", features: ["STRUCTURED_TEXT", "IMAGE_GENERATION", "IMAGE_DECODE_PNG"],
      latencyMs: 50, models: { text: "text-model-a", image: "image-model-a" },
      checkedAt: "2026-08-04T10:01:00.000Z", errorCode: null },
  });
  assert.equal(result.applied, true);
  assert.equal(result.response.enabled, false);
  assert.match(calls[5].sql, /UPDATE ai_gateway_profiles/iu);
  assert.match(calls[6].sql, /UPDATE ai_gateway_capability_attempts/iu);
  assert.match(calls[8].sql, /INSERT INTO audit_events/iu);
  assert.equal(calls[0].sql, "BEGIN");
  assert.equal(calls.at(-2).sql, "COMMIT");
});

test("a legacy running failure cannot disable a profile that is already the formal enabled version", async () => {
  const enabledProfile = { ...profileRow, enabled: true };
  const { pool, calls } = scriptedPool([
    { rows: [] }, { rows: [{ id: "account-a" }] }, { rows: [enabledProfile] },
    { rows: [authorizedAttempt({ fence: "9", lease_live: true })] },
    { rows: [{ id: "attempt-a", fence: "9" }] },
    { rowCount: 1, rows: [{ id: "attempt-a" }] }, { rows: [] },
    { rowCount: 1, rows: [{ event_id: "stale-audit" }] }, { rows: [] },
  ]);
  const result = await createAutoListingAiAdminPostgres({ pool }).completeCapabilityTest({
    costConfirmed: true, accountId: "account-a", actorId: "account-a", profileId: "profile-a",
    configVersion: 1, correlationId: "corr-a", attemptId: "attempt-a", fence: 9,
    leaseVersion: 1, leaseToken: "caplease_initial", requestKey: capabilityRequestKey,
    capabilityResult: { outcome: "FAILED", features: [], latencyMs: null,
      models: { text: "text-model-a", image: "image-model-a" },
      checkedAt: "2026-08-04T10:01:00.000Z", errorCode: "GATEWAY_TIMEOUT" },
  });
  assert.equal(result.applied, false);
  assert.equal(result.stale, true);
  assert.equal(result.response.enabled, true);
  assert.equal(calls.some(({ sql }) => /UPDATE ai_gateway_profiles/iu.test(sql)), false);
});

test("capability begin reclaims only an expired running lease and advances its lease fence", async () => {
  const expired = authorizedAttempt({ fence: "9", lease_token: "caplease_old",
    lease_expires_at: "2026-08-04T09:00:00.000Z" });
  const { pool, calls } = scriptedPool([
    { rows: [] },
    { rowCount: 1, rows: [{ id: "account-a" }] },
    { rowCount: 1, rows: [profileRow] },
    { rowCount: 1, rows: [expired] },
    (sql, params) => {
      assert.match(sql, /lease_version=lease_version\+1/iu);
      assert.match(sql, /status='RUNNING' AND lease_expires_at<=NOW\(\)/iu);
      assert.match(params[4], /^caplease_[a-f0-9]{32}$/u);
      return { rowCount: 1, rows: [{
        ...expired, lease_version: 2, lease_token: params[4], lease_expires_at: "2026-08-04T10:10:00.000Z",
      }] };
    },
    { rowCount: 1, rows: [{ event_id: "authorization-reclaim-audit" }] },
    { rows: [] },
  ]);
  const repository = createAutoListingAiAdminPostgres({ pool });
  const result = await repository.beginCapabilityTest({ costConfirmed: true,
    accountId: "account-a", actorId: "account-a", profileId: "profile-a", configVersion: 1,
    correlationId: "corr-a", attemptId: "attempt-a", requestKey: capabilityRequestKey,
  });
  assert.equal(result.duplicate, false);
  assert.equal(result.reclaimed, true);
  assert.equal(result.leaseVersion, 2);
  assert.notEqual(result.leaseToken, "caplease_old");
  assert.equal(calls.some(({ sql }) => /INSERT INTO ai_gateway_capability_attempts/iu.test(sql)), false);
});

test("completed rollback capability replays before the retired connection status fence", async () => {
  const connected = { ...profileRow, api_key_env_name: "SUB2API_ENCRYPTED_KEY",
    connection_id: "connection-a", connection_version: 1 };
  const response = { profileId: "profile-a", configVersion: 1, outcome: "PASSED" };
  const { pool, calls } = scriptedPool([
    { rows: [] }, { rows: [{ id: "account-a" }] }, { rows: [connected] },
    { rows: [{ id: "attempt-rollback", fence: 2, account_id: "account-a", profile_id: "profile-a",
      config_version: 1, correlation_id: "corr-rollback", status: "PASSED", response,
      lease_version: 1, lease_token: "caplease_done", lease_expires_at: "2026-08-08T00:10:00.000Z",
      confirmation_matches: true }] },
    { rows: [] },
  ]);
  const replay = await createAutoListingAiAdminPostgres({ pool }).beginCapabilityTest({ costConfirmed: true,
    accountId: "account-a", actorId: "account-a", profileId: "profile-a", configVersion: 1,
    correlationId: "corr-rollback", attemptId: "attempt-rollback", purpose: "ROLLBACK_CAPABILITY",
    requestKey: capabilityRequestKey,
  });
  assert.equal(replay.status, "PASSED");
  assert.equal(replay.duplicate, true);
  assert.equal(calls.some(({ sql }) => /ai_gateway_connection_versions c/iu.test(sql)), false);
});

test("profile publish requires exact passed text+image evidence and switches one enabled profile under the account lock", async () => {
  const passed = {
    ...profileRow,
    capability_result: {
      outcome: "PASSED", features: ["STRUCTURED_TEXT", "IMAGE_GENERATION", "IMAGE_DECODE_PNG"],
      models: { text: "text-model-a", image: "image-model-a" }, checkedAt: "2026-08-04T10:01:00.000Z",
    },
    capability_checked_at: "2026-08-04T10:01:00.000Z",
  };
  const { pool, calls } = scriptedPool([
    { rows: [] },
    { rowCount: 1, rows: [{ id: "account-a" }] },
    { rowCount: 0, rows: [] },
    { rowCount: 1, rows: [passed] },
    { rows: [] },
    { rowCount: 1, rows: [{ id: "profile-old", config_version: 2 }] },
    { rowCount: 1, rows: [] },
    { rows: [] },
    { rowCount: 1, rows: [{ ...passed, enabled: true }] },
    { rowCount: 1, rows: [{ event_id: "audit" }] },
    { rows: [] },
  ]);
  const repository = createAutoListingAiAdminPostgres({ pool });
  const result = await repository.publishProfile({
    accountId: "account-a", actorId: "account-a", profileId: "profile-a", configVersion: 1,
    idempotencyKey: "idem-publish-a", correlationId: "corr-publish-a",
  });
  assert.equal(result.enabled, true);
  assert.match(calls[1].sql, /FROM accounts WHERE id=\$1 FOR UPDATE/iu);
  assert.match(calls[3].sql, /WHERE account_id=\$1 AND id=\$2 AND config_version=\$3 FOR UPDATE/iu);
  assert.match(calls[5].sql, /enabled IS TRUE[\s\S]*FOR UPDATE/iu);
  assert.doesNotMatch(calls[5].sql, /ORDER BY|LIMIT|latest/iu);
  assert.match(calls[6].sql, /SET enabled=FALSE/iu);
  assert.match(calls[6].sql, /capability_result='\{\}'::JSONB/iu);
  assert.match(calls[6].sql, /capability_checked_at=NULL/iu);
  assert.match(calls[8].sql, /SET enabled=TRUE/iu);
});

test("a new publish intent rejects an already enabled target without writing a false activation", async () => {
  const passedEnabled = { ...profileRow, enabled: true,
    capability_result: { outcome: "PASSED",
      features: ["STRUCTURED_TEXT", "IMAGE_GENERATION", "IMAGE_DECODE_PNG"],
      models: { text: "text-model-a", image: "image-model-a" }, checkedAt: "2026-08-04T10:01:00.000Z" },
    capability_checked_at: "2026-08-04T10:01:00.000Z" };
  const { pool, calls } = scriptedPool([
    { rows: [] }, { rows: [{ id: "account-a" }] }, { rows: [] }, { rows: [passedEnabled] }, { rows: [] },
  ]);
  await assert.rejects(createAutoListingAiAdminPostgres({ pool }).publishProfile({
    accountId: "account-a", actorId: "account-a", profileId: "profile-a", configVersion: 1,
    idempotencyKey: "publish-current-new-intent", correlationId: "corr-current-new-intent",
  }), { code: "AUTO_LISTING_AI_PROFILE_VERSION_CONFLICT", status: 409 });
  assert.equal(calls.some(({ sql }) => /INSERT INTO audit_events|SET enabled=/iu.test(sql)), false);
});

test("completed rollback preparation replays the exact stored activation after response loss", async () => {
  const occurredAt = new Date("2026-08-09T03:04:05.000Z");
  const { pool } = scriptedPool([
    { rows: [] }, { rows: [{ id: "account-a" }] },
    (_sql, params) => ({ rows: [{
      metadata: { requestHash: params[2], entityId: "profile-a", configVersion: 1 },
      action: "AUTO_LISTING_AI_PROFILE_ROLLBACK", actor_id: "account-a", occurred_at: occurredAt,
    }] }),
    { rows: [{ ...profileRow, enabled: true }] }, { rows: [] },
  ]);
  const replay = await createAutoListingAiAdminPostgres({ pool }).prepareProfileRollback({
    accountId: "account-a", actorId: "account-a", profileId: "profile-a", configVersion: 1,
    idempotencyKey: "rollback-response-loss", correlationId: "corr-response-loss",
  });
  assert.deepEqual(replay.profile.activation, {
    kind: "ROLLBACK", occurredAt: occurredAt.toISOString(), actorId: "account-a",
  });
});

test("profile publish rejects missing image capability without changing any enabled profile", async () => {
  const incomplete = {
    ...profileRow,
    capability_result: { outcome: "PASSED", features: ["STRUCTURED_TEXT"],
      models: { text: "text-model-a", image: "image-model-a" }, checkedAt: "2026-08-04T10:01:00.000Z" },
    capability_checked_at: "2026-08-04T10:01:00.000Z",
  };
  const { pool, calls } = scriptedPool([
    { rows: [] },
    { rowCount: 1, rows: [{ id: "account-a" }] },
    { rowCount: 0, rows: [] },
    { rowCount: 1, rows: [incomplete] },
    { rows: [] },
  ]);
  const repository = createAutoListingAiAdminPostgres({ pool });
  await assert.rejects(repository.publishProfile({
    accountId: "account-a", actorId: "account-a", profileId: "profile-a", configVersion: 1,
    idempotencyKey: "idem-publish-a", correlationId: "corr-publish-a",
  }), { code: "AUTO_LISTING_AI_PROFILE_CAPABILITY_REQUIRED" });
  assert.equal(calls.some(({ sql }) => /SET enabled=/iu.test(sql)), false);
  assert.equal(calls.at(-2).sql, "ROLLBACK");
});

test("profile publish replay never re-enables a profile superseded by a later publication", async () => {
  const { pool, calls } = scriptedPool([
    { rows: [] },
    { rowCount: 1, rows: [{ id: "account-a" }] },
    (_sql, params) => ({ rowCount: 1, rows: [{
      metadata: { requestHash: params[2], entityId: "profile-a", configVersion: 1 },
      action: "AUTO_LISTING_AI_PROFILE_PUBLISH", actor_id: "account-a",
      occurred_at: new Date("2026-08-09T02:03:04.000Z"),
    }] }),
    { rowCount: 1, rows: [{ ...profileRow, enabled: false }] },
    { rows: [] },
  ]);
  const repository = createAutoListingAiAdminPostgres({ pool });
  const replay = await repository.publishProfile({
    accountId: "account-a", actorId: "account-a", profileId: "profile-a", configVersion: 1,
    idempotencyKey: "idem-publish-a", correlationId: "corr-publish-a",
  });
  assert.equal(replay.duplicate, true);
  assert.equal(replay.enabled, false);
  assert.deepEqual(replay.activation, {
    kind: "PUBLISH", occurredAt: "2026-08-09T02:03:04.000Z", actorId: "account-a",
  });
  assert.equal(calls.some(({ sql }) => /SET enabled=/iu.test(sql)), false);
});

test("connection-backed publish activates the validated target and retires the prior active connection in one transaction", async () => {
  const passed = {
    ...profileRow,
    api_key_env_name: "SUB2API_ENCRYPTED_KEY", connection_id: "connection-new", connection_version: 1,
    capability_result: { outcome: "PASSED", features: ["STRUCTURED_TEXT", "IMAGE_GENERATION", "IMAGE_DECODE_PNG"],
      models: { text: "text-model-a", image: "image-model-a" }, checkedAt: "2026-08-04T10:01:00.000Z" },
    capability_checked_at: "2026-08-04T10:01:00.000Z",
  };
  const { pool, calls } = scriptedPool([
    { rows: [] }, { rows: [{ id: "account-a" }] }, { rows: [] }, { rows: [passed] },
    { rows: [{ id: "catalog-new" }] },
    { rows: [{ id: "profile-old", config_version: 1 }] },
    { rows: [] },
    { rows: [{ id: "connection-old", version: 1, status_version: 3 }] },
    { rows: [{ id: "connection-old", version: 1, status_version: 4 }] },
    { rows: [] }, { rowCount: 1, rows: [{ event_id: "audit-retired" }] },
    { rows: [{ id: "connection-new", version: 1, status_version: 3 }] },
    { rows: [] }, { rowCount: 1, rows: [{ event_id: "audit-active" }] },
    { rows: [{ ...passed, enabled: true }] },
    { rowCount: 1, rows: [{ event_id: "audit-profile" }] }, { rows: [] },
  ]);
  const result = await createAutoListingAiAdminPostgres({ pool }).publishProfile({
    accountId: "account-a", actorId: "account-a", profileId: "profile-a", configVersion: 1,
    idempotencyKey: "publish-connected-a", correlationId: "corr-connected-a",
  });
  assert.equal(result.enabled, true);
  const retired = calls.find(({ sql }) => /UPDATE ai_gateway_connection_versions[\s\S]*SET status='RETIRED'/iu.test(sql));
  const activated = calls.find(({ sql }) => /UPDATE ai_gateway_connection_versions[\s\S]*SET status='ACTIVE'/iu.test(sql));
  assert.deepEqual(retired.params.slice(0, 3), ["account-a", "connection-old", 1]);
  assert.deepEqual(activated.params.slice(0, 3), ["account-a", "connection-new", 1]);
  assert.equal(calls.at(-2).sql, "COMMIT");
});

test("publishing a legacy profile retires the prior active encrypted connection atomically", async () => {
  const passedLegacy = {
    ...profileRow,
    capability_result: { outcome: "PASSED", features: ["STRUCTURED_TEXT", "IMAGE_GENERATION", "IMAGE_DECODE_PNG"],
      models: { text: "text-model-a", image: "image-model-a" }, checkedAt: "2026-08-04T10:01:00.000Z" },
    capability_checked_at: "2026-08-04T10:01:00.000Z",
  };
  const { pool, calls } = scriptedPool([
    { rows: [] }, { rows: [{ id: "account-a" }] }, { rows: [] }, { rows: [passedLegacy] },
    { rows: [] },
    { rows: [{ id: "profile-connected", config_version: 1 }] }, { rows: [] },
    { rows: [{ id: "connection-old", version: 1, status_version: 3 }] },
    { rows: [{ id: "connection-old", version: 1, status_version: 4 }] },
    { rows: [] }, { rowCount: 1, rows: [{ event_id: "audit-retired" }] },
    { rows: [{ ...passedLegacy, enabled: true }] },
    { rowCount: 1, rows: [{ event_id: "audit-profile" }] }, { rows: [] },
  ]);
  const result = await createAutoListingAiAdminPostgres({ pool }).publishProfile({
    accountId: "account-a", actorId: "account-a", profileId: "profile-a", configVersion: 1,
    idempotencyKey: "publish-legacy-a", correlationId: "corr-legacy-a",
  });
  assert.equal(result.enabled, true);
  const retired = calls.find(({ sql }) => /UPDATE ai_gateway_connection_versions[\s\S]*SET status='RETIRED'/iu.test(sql));
  assert.deepEqual(retired.params.slice(0, 3), ["account-a", "connection-old", 1]);
  assert.equal(calls.some(({ sql }) => /SET status='ACTIVE'/iu.test(sql)), false);
  assert.equal(calls.at(-2).sql, "COMMIT");
});

test("a previously published legacy profile cannot bypass fresh rollback capability through publish", async () => {
  const passedLegacy = {
    ...profileRow,
    capability_result: { outcome: "PASSED", features: ["STRUCTURED_TEXT", "IMAGE_GENERATION", "IMAGE_DECODE_PNG"],
      models: { text: "text-model-a", image: "image-model-a" }, checkedAt: "2026-08-04T10:01:00.000Z" },
    capability_checked_at: "2026-08-04T10:01:00.000Z",
  };
  const { pool, calls } = scriptedPool([
    { rows: [] }, { rows: [{ id: "account-a" }] }, { rows: [] }, { rows: [passedLegacy] },
    { rows: [{ "?column?": 1 }] }, { rows: [] },
  ]);
  await assert.rejects(createAutoListingAiAdminPostgres({ pool }).publishProfile({
    accountId: "account-a", actorId: "account-a", profileId: "profile-a", configVersion: 1,
    idempotencyKey: "republish-legacy-a", correlationId: "corr-republish-legacy-a",
  }), { code: "AUTO_LISTING_AI_PROFILE_ROLLBACK_NOT_READY", status: 409 });
  assert.equal(calls.some(({ sql }) => /SET enabled=FALSE|SET status='RETIRED'/iu.test(sql)), false);
});

test("rollback requires a fresh audited rollback capability and republishes the retired connection atomically", async () => {
  const passed = {
    ...profileRow,
    api_key_env_name: "SUB2API_ENCRYPTED_KEY", connection_id: "connection-old", connection_version: 1,
    capability_result: { outcome: "PASSED", features: ["STRUCTURED_TEXT", "IMAGE_GENERATION", "IMAGE_DECODE_PNG"],
      models: { text: "text-model-a", image: "image-model-a" }, checkedAt: "2026-08-08T10:01:00.000Z" },
    capability_checked_at: "2026-08-08T10:01:00.000Z",
  };
  const { pool, calls } = scriptedPool([
    { rows: [] }, { rows: [{ id: "account-a" }] }, { rows: [] }, { rows: [passed] },
    { rows: [{ id: "catalog-old", retired_at: "2026-08-08T09:00:00.000Z", status_version: 4 }] },
    { rows: [{ id: "attempt-rollback", completed_at: "2026-08-08T10:01:01.000Z" }] },
    { rows: [{ id: "connection-old", version: 1, status_version: 5 }] },
    { rows: [] }, { rowCount: 1, rows: [{ event_id: "audit-validated" }] },
    { rows: [{ id: "profile-current", config_version: 1 }] }, { rows: [] },
    { rows: [{ id: "connection-current", version: 1, status_version: 3 }] },
    { rows: [{ id: "connection-current", version: 1, status_version: 4 }] },
    { rows: [] }, { rowCount: 1, rows: [{ event_id: "audit-retired" }] },
    { rows: [{ id: "connection-old", version: 1, status_version: 6 }] },
    { rows: [] }, { rowCount: 1, rows: [{ event_id: "audit-active" }] },
    { rows: [{ ...passed, enabled: true }] },
    { rowCount: 1, rows: [{ event_id: "audit-profile", action: "AUTO_LISTING_AI_PROFILE_ROLLBACK",
      actor_id: "account-a", occurred_at: new Date("2026-08-09T03:04:05.000Z") }] }, { rows: [] },
  ]);
  const result = await createAutoListingAiAdminPostgres({ pool }).rollbackProfile({
    accountId: "account-a", actorId: "account-a", profileId: "profile-a", configVersion: 1,
    idempotencyKey: "rollback-connected-a", correlationId: "corr-rollback-connected-a",
  });
  assert.equal(result.enabled, true);
  assert.deepEqual(result.activation, {
    kind: "ROLLBACK", occurredAt: "2026-08-09T03:04:05.000Z", actorId: "account-a",
  });
  assert.match(calls[4].sql, /c\.status='RETIRED'/iu);
  assert.match(calls[5].sql, /metadata->>'purpose'='ROLLBACK_CAPABILITY'/iu);
  assert.match(calls[6].sql, /status='VALIDATED'/iu);
  assert.match(calls[15].sql, /status='ACTIVE'/iu);
  assert.equal(calls.at(-2).sql, "COMMIT");
});

const strategyCommand = {
  accountId: "account-a", actorId: "account-a", strategyKey: "default", version: 7,
  idempotencyKey: "idem-strategy-7", correlationId: "corr-strategy-7",
  content: { schemaVersion: "V1" },
  rules: [{ ruleId: "business-rule-a", ruleOrder: 1, matchType: "EXACT_CATEGORY", categoryId: "category-a",
    style: "VISUAL_FIRST", textDensityByRole: { MAIN: "NONE" } }],
};

const strategyRow = {
  id: "strategy-version-a", account_id: "account-a", strategy_key: "default", version: 7,
  status: "DRAFT", content: { schemaVersion: "V1" }, content_hash: "content-hash",
  published_at: null, created_at: "2026-08-04T10:00:00.000Z",
};

test("strategy creation uses an explicit version, deterministic content hash, and account-scoped rule inserts", async () => {
  const { pool, calls } = scriptedPool([
    { rows: [] },
    { rowCount: 1, rows: [{ id: "account-a" }] },
    { rowCount: 0, rows: [] },
    { rowCount: 0, rows: [] },
    { rowCount: 1, rows: [strategyRow] },
    { rowCount: 1, rows: [] },
    { rowCount: 1, rows: [{ event_id: "audit" }] },
    { rows: [] },
  ]);
  const repository = createAutoListingAiAdminPostgres({ pool });
  const result = await repository.createStrategyVersion(strategyCommand);
  assert.equal(result.version, 7);
  assert.equal(result.status, "DRAFT");
  assert.match(calls[3].sql, /account_id=\$1 AND strategy_key=\$2 AND version=\$3/iu);
  assert.doesNotMatch(calls[3].sql, /MAX\(|ORDER BY|LIMIT|latest/iu);
  assert.match(calls[4].sql, /INSERT INTO ai_content_strategy_versions/iu);
  assert.match(calls[5].sql, /INSERT INTO ai_content_strategy_rules/iu);
  assert.deepEqual(calls[5].params.slice(1, 3), ["account-a", "strategy-version-a"]);
});

test("strategy publish switches the one exact current version without guessing latest and keeps old IDs intact", async () => {
  const { pool, calls } = scriptedPool([
    { rows: [] },
    { rowCount: 1, rows: [{ id: "account-a" }] },
    { rowCount: 0, rows: [] },
    { rowCount: 1, rows: [strategyRow] },
    { rowCount: 1, rows: [{ id: "strategy-old", version: 6 }] },
    { rowCount: 1, rows: [] },
    { rowCount: 1, rows: [{ ...strategyRow, status: "PUBLISHED" }] },
    { rowCount: 1, rows: [{ event_id: "audit" }] },
    { rows: [] },
  ]);
  const repository = createAutoListingAiAdminPostgres({ pool });
  const result = await repository.publishStrategyVersion({
    accountId: "account-a", actorId: "account-a", strategyKey: "default",
    strategyVersionId: "strategy-version-a", version: 7,
    idempotencyKey: "idem-publish-strategy", correlationId: "corr-publish-strategy",
  });
  assert.equal(result.status, "PUBLISHED");
  assert.match(calls[3].sql, /id=\$2 AND strategy_key=\$3 AND version=\$4[\s\S]*FOR UPDATE/iu);
  assert.match(calls[4].sql, /status='PUBLISHED'[\s\S]*FOR UPDATE/iu);
  assert.doesNotMatch(calls[4].sql, /ORDER BY|LIMIT|latest/iu);
  assert.match(calls[5].sql, /SET status='RETIRED'/iu);
  assert.deepEqual(calls[5].params, ["account-a", "strategy-old"]);
  assert.match(calls[6].sql, /SET status='PUBLISHED'/iu);
  assert.deepEqual(calls[6].params.slice(0, 4), ["account-a", "strategy-version-a", "default", 7]);
});

test("strategy list is account and key scoped while database errors are always sanitized", async () => {
  const storedRules = [{ ruleId: "business-rule-a", ruleOrder: 1, matchType: "PRODUCT_STYLE",
    productStyle: "GENERAL", style: "BALANCED_DEFAULT", textDensityByRole: { MAIN: "NONE" } }];
  const { pool, calls } = scriptedPool([{ rows: [{ ...strategyRow, rules: storedRules }] }]);
  const repository = createAutoListingAiAdminPostgres({ pool });
  const rows = await repository.listStrategyVersions({ accountId: "account-a", strategyKey: "default" });
  assert.equal(rows[0].accountId, "account-a");
  assert.deepEqual(rows[0].rules, storedRules);
  assert.match(calls[0].sql, /WHERE v\.account_id=\$1 AND v\.strategy_key=\$2/iu);
  assert.match(calls[0].sql, /FROM ai_content_strategy_rules/iu);

  const raw = Object.assign(new Error("password=secret host=internal"), { code: "XX000" });
  const failed = createAutoListingAiAdminPostgres({
    pool: { async connect() { throw raw; }, async query() { throw raw; } },
  });
  await assert.rejects(failed.createProfile(profileCommand), (error) =>
    error?.code === "AUTO_LISTING_AI_ADMIN_DATABASE_FAILED"
      && error?.retryable === true
      && !/password|secret|internal|XX000/iu.test(error.message));
});
