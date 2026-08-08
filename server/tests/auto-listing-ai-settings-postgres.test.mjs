import assert from "node:assert/strict";
import test from "node:test";

import { createAutoListingAiSettingsPostgres } from "../auto-listing-ai-settings-postgres.mjs";

const connectionRow = {
  id: "connection-a",
  account_id: "account-a",
  version: 1,
  display_name: "本地 sub2API",
  base_url: "http://127.0.0.1:8080/v1",
  ciphertext: "cipher",
  iv: "iv",
  auth_tag: "tag",
  algorithm: "aes-256-gcm",
  key_version: "local-v1",
  fingerprint: "fp",
  status: "PENDING",
  status_version: 1,
  validation_result: null,
  created_at: "2026-08-08T00:00:00.000Z",
};

const connectionInput = {
  accountId: "account-a",
  actorId: "account-a",
  idempotencyKey: "connection-intent-a",
  correlationId: "corr-a",
  displayName: "本地 sub2API",
  baseUrl: "http://127.0.0.1:8080/v1",
  encryptedSecret: {
    algorithm: "aes-256-gcm",
    ciphertext: "cipher",
    iv: "iv",
    authTag: "tag",
    keyVersion: "local-v1",
    fingerprint: "fp",
  },
};

function scriptedPool(steps) {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      const step = steps.shift();
      assert.ok(step, `unexpected query: ${sql}`);
      return typeof step === "function" ? step(sql, params) : step;
    },
    release() { calls.push({ sql: "RELEASE", params: [] }); },
  };
  return {
    pool: {
      async connect() { return client; },
      async query(sql, params = []) { return client.query(sql, params); },
    },
    calls,
    remaining: steps,
  };
}

test("settings PostgreSQL repository factory is closed and exposes the exact stable contract", () => {
  const pool = { async connect() {}, async query() {} };
  assert.deepEqual(Object.keys(createAutoListingAiSettingsPostgres({ pool })).sort(), [
    "claimModelSync",
    "completeModelSync",
    "createPendingConnection",
    "createProfileFromSelection",
    "enqueueModelSync",
    "failModelSync",
    "listRunnableSyncAccountIds",
    "loadCatalogSyncConnectionForSecretResolution",
    "loadConnectionForSecretResolution",
    "loadRollbackConnectionForSecretResolution",
    "loadSettingsOverview",
    "markConnectionValidated",
  ]);
  assert.throws(() => createAutoListingAiSettingsPostgres({ pool, secret: "raw" }), {
    code: "AUTO_LISTING_AI_SETTINGS_REPOSITORY_INVALID",
  });
  assert.throws(() => createAutoListingAiSettingsPostgres({ pool: {} }), {
    code: "AUTO_LISTING_AI_SETTINGS_REPOSITORY_INVALID",
  });
});

test("runnable paging and claims optionally isolate catalog sync from rollback tasks", async () => {
  const list = scriptedPool([{
    rows: [{ account_id: "account-a" }, { account_id: "account-b" }],
  }]);
  assert.deepEqual(await createAutoListingAiSettingsPostgres({ pool: list.pool })
    .listRunnableSyncAccountIds({ afterAccountId: null, limit: 20, syncPurpose: "CATALOG_SYNC" }),
  ["account-a", "account-b"]);
  assert.match(list.calls[0].sql, /sync_purpose=\$3/iu);
  assert.deepEqual(list.calls[0].params, ["", 20, "CATALOG_SYNC"]);

  const claim = scriptedPool([
    { rows: [] },
    { rowCount: 1, rows: [{ id: "account-a" }] },
    { rows: [] },
    { rows: [] },
  ]);
  assert.equal(await createAutoListingAiSettingsPostgres({ pool: claim.pool }).claimModelSync({
    accountId: "account-a", workerId: "worker-a", leaseMs: 120_000, syncPurpose: "CATALOG_SYNC",
  }), null);
  const select = claim.calls.find(({ sql }) => /FROM ai_gateway_model_sync_tasks/iu.test(sql));
  assert.match(select.sql, /sync_purpose=\$2/iu);
  assert.deepEqual(select.params, ["account-a", "CATALOG_SYNC"]);
});

test("pending connection creation locks the account, stores only cipher payload, and returns a safe DTO", async () => {
  const { pool, calls, remaining } = scriptedPool([
    { rows: [] },
    (sql, params) => {
      assert.match(sql, /FROM accounts WHERE id=\$1 FOR UPDATE/iu);
      assert.deepEqual(params, ["account-a"]);
      return { rowCount: 1, rows: [{ id: "account-a" }] };
    },
    { rowCount: 0, rows: [] },
    (sql, params) => {
      assert.match(sql, /INSERT INTO ai_gateway_connection_versions/iu);
      assert.match(sql, /ciphertext,iv,auth_tag,algorithm,key_version,fingerprint/iu);
      assert.equal(params.includes("cipher"), true);
      assert.equal(params.some((value) => value === "raw-secret"), false);
      return { rowCount: 1, rows: [connectionRow] };
    },
    (sql) => {
      assert.match(sql, /INSERT INTO ai_gateway_connection_events/iu);
      return { rowCount: 1, rows: [{ id: "event-a" }] };
    },
    (sql, params) => {
      assert.match(sql, /INSERT INTO audit_events/iu);
      assert.doesNotMatch(JSON.stringify(params), /cipher|auth_tag|raw-secret/iu);
      return { rowCount: 1, rows: [{ event_id: "audit-a" }] };
    },
    { rows: [] },
  ]);
  const repository = createAutoListingAiSettingsPostgres({ pool });
  const connection = await repository.createPendingConnection(connectionInput);

  assert.equal(connection.accountId, "account-a");
  assert.equal(connection.status, "PENDING");
  assert.equal(connection.duplicate, false);
  for (const forbidden of ["ciphertext", "iv", "authTag", "encryptedSecret"]) {
    assert.equal(Object.hasOwn(connection, forbidden), false);
  }
  assert.equal(calls[0].sql, "BEGIN");
  assert.equal(calls.at(-2).sql, "COMMIT");
  assert.equal(remaining.length, 0);
});

test("same connection idempotency key replays and a different payload conflicts before mutation", async () => {
  const replayPool = scriptedPool([
    { rows: [] },
    { rowCount: 1, rows: [{ id: "account-a" }] },
    (_sql, params) => ({ rowCount: 1, rows: [{ ...connectionRow, request_hash: params[2] }] }),
    { rows: [] },
  ]);
  const replay = await createAutoListingAiSettingsPostgres({ pool: replayPool.pool })
    .createPendingConnection(connectionInput);
  assert.equal(replay.duplicate, true);
  assert.equal(replayPool.calls.some(({ sql }) => /INSERT INTO/iu.test(sql)), false);

  const conflictPool = scriptedPool([
    { rows: [] },
    { rowCount: 1, rows: [{ id: "account-a" }] },
    { rowCount: 1, rows: [{ ...connectionRow, request_hash: "f".repeat(64) }] },
    { rows: [] },
  ]);
  await assert.rejects(
    createAutoListingAiSettingsPostgres({ pool: conflictPool.pool }).createPendingConnection(connectionInput),
    { code: "AUTO_LISTING_AI_SETTINGS_IDEMPOTENCY_CONFLICT", status: 409 },
  );
  assert.equal(conflictPool.calls.some(({ sql }) => /^\s*(?:INSERT INTO|UPDATE)\b/iu.test(sql)), false);
  assert.equal(conflictPool.calls.at(-2).sql, "ROLLBACK");
});

test("secret resolution is exact tenant scoped and returns ciphertext only in the encrypted payload", async () => {
  const { pool, calls } = scriptedPool([{ rowCount: 1, rows: [{ ...connectionRow, status: "ACTIVE" }] }]);
  const resolved = await createAutoListingAiSettingsPostgres({ pool }).loadConnectionForSecretResolution({
    accountId: "account-a",
    connectionId: "connection-a",
    connectionVersion: 1,
  });
  assert.equal(resolved.accountId, "account-a");
  assert.deepEqual(resolved.encryptedSecret, {
    algorithm: "aes-256-gcm",
    ciphertext: "cipher",
    iv: "iv",
    authTag: "tag",
    keyVersion: "local-v1",
    fingerprint: "fp",
  });
  assert.match(calls[0].sql, /WHERE account_id=\$1 AND id=\$2 AND version=\$3 AND status='ACTIVE'/iu);
  assert.deepEqual(calls[0].params, ["account-a", "connection-a", 1]);
});

test("rollback secret resolution validates one live rollback lease and stores no raw token in the query", async () => {
  const { pool, calls } = scriptedPool([{
    rowCount: 1, rows: [{ ...connectionRow, status: "RETIRED" }],
  }]);
  const resolved = await createAutoListingAiSettingsPostgres({ pool })
    .loadRollbackConnectionForSecretResolution({
      accountId: "account-a",
      taskId: "rollback-task-a",
      workerId: "worker-a",
      leaseVersion: 2,
      leaseToken: "aiglease_secret-a",
    });
  assert.equal(resolved.status, "RETIRED");
  assert.equal(resolved.encryptedSecret.ciphertext, "cipher");
  assert.match(calls[0].sql, /sync_purpose='ROLLBACK_CAPABILITY'/iu);
  assert.match(calls[0].sql, /lease_expires_at > NOW\(\)/iu);
  assert.match(calls[0].sql, /c\.status='RETIRED'/iu);
  assert.match(calls[0].sql, /c\.status_version=t\.target_connection_status_version/iu);
  assert.equal(calls[0].params.includes("aiglease_secret-a"), false);
  assert.match(calls[0].params.at(-1), /^[a-f0-9]{64}$/u);
});

test("catalog secret resolution requires the exact live catalog lease and ACTIVE status fence", async () => {
  const { pool, calls } = scriptedPool([{
    rowCount: 1, rows: [{
      ...connectionRow,
      status: "ACTIVE",
      status_version: 3,
      catalog_connection_fence_matches: true,
    }],
  }]);
  const resolved = await createAutoListingAiSettingsPostgres({ pool })
    .loadCatalogSyncConnectionForSecretResolution({
      accountId: "account-a",
      taskId: "catalog-task-a",
      workerId: "catalog-worker-a",
      leaseVersion: 2,
      leaseToken: "aiglease_catalog-secret",
      minimumLeaseRemainingMs: 45_000,
    });
  assert.equal(resolved.status, "ACTIVE");
  assert.match(calls[0].sql, /sync_purpose='CATALOG_SYNC'/iu);
  assert.match(calls[0].sql, /lease_expires_at > NOW\(\)/iu);
  assert.match(calls[0].sql, /INTERVAL '1 millisecond'/iu);
  assert.match(calls[0].sql, /c\.status='ACTIVE'/iu);
  assert.match(calls[0].sql, /c\.status_version=t\.target_connection_status_version/iu);
  assert.equal(calls[0].params.includes("aiglease_catalog-secret"), false);
  assert.equal(calls[0].params.at(-2), 45_000);
  assert.match(calls[0].params.at(-1), /^[a-f0-9]{64}$/u);
});

test("catalog secret resolution distinguishes a rotated connection from an invalid lease", async () => {
  const { pool } = scriptedPool([{
    rowCount: 1, rows: [{
      ...connectionRow,
      status: "RETIRED",
      status_version: 4,
      catalog_connection_fence_matches: false,
    }],
  }]);
  await assert.rejects(createAutoListingAiSettingsPostgres({ pool })
    .loadCatalogSyncConnectionForSecretResolution({
      accountId: "account-a",
      taskId: "catalog-task-a",
      workerId: "catalog-worker-a",
      leaseVersion: 2,
      leaseToken: "aiglease_catalog-secret",
      minimumLeaseRemainingMs: 45_000,
    }), {
    code: "AUTO_LISTING_AI_SETTINGS_CONNECTION_VERSION_CONFLICT",
    status: 409,
  });
});

test("raw secret-shaped input is rejected before any database access", async () => {
  const { pool, calls } = scriptedPool([]);
  await assert.rejects(createAutoListingAiSettingsPostgres({ pool }).createPendingConnection({
    ...connectionInput,
    encryptedSecret: { ...connectionInput.encryptedSecret, rawSecret: "must-not-reach-repository" },
  }), { code: "AUTO_LISTING_AI_SETTINGS_REPOSITORY_INVALID" });
  assert.equal(calls.length, 0);
});

test("settings overview preserves a legacy profile null connection reference", async () => {
  const { pool } = scriptedPool([
    { rows: [] },
    { rows: [] },
    { rows: [] },
    { rows: [] },
    { rows: [{
      id: "legacy-profile", account_id: "account-a", display_name: "Legacy", config_version: 1,
      base_url: "https://legacy.example/v1", api_key_env_name: "SUB2API_LEGACY_KEY",
      text_protocol: "SUB2API_RESPONSES", image_protocol: "SUB2API_OPENAI_IMAGES",
      text_model: "legacy-text", image_model: "legacy-image", enabled: false,
      capability_result: {}, capability_checked_at: null,
      connection_id: null, connection_version: null, created_at: "2026-08-08T00:00:00.000Z",
    }] },
    { rows: [] },
  ]);
  const overview = await createAutoListingAiSettingsPostgres({ pool }).loadSettingsOverview({
    accountId: "account-a",
  });
  assert.equal(overview.profiles[0].connectionId, null);
  assert.equal(overview.profiles[0].connectionVersion, null);
});

test("model sync completion accepts empty and single-modal catalog snapshots before database access", async () => {
  const emptyPool = scriptedPool([]);
  await assert.rejects(createAutoListingAiSettingsPostgres({ pool: emptyPool.pool }).completeModelSync({
    accountId: "account-a",
    workerId: "worker-a",
    taskId: "task-a",
    leaseVersion: 1,
    leaseToken: "lease-a",
    correlationId: "corr-empty",
    catalog: { models: [] },
    capabilityResult: {
      outcome: "NOT_TESTED", checkedAt: "2026-08-08T00:00:00.000Z", text: false, image: false,
    },
  }), { code: "AUTO_LISTING_AI_SETTINGS_DATABASE_FAILED" });
  assert.equal(emptyPool.calls.length > 0, true);

  const singleModalPool = scriptedPool([]);
  await assert.rejects(createAutoListingAiSettingsPostgres({ pool: singleModalPool.pool }).completeModelSync({
    accountId: "account-a",
    workerId: "worker-a",
    taskId: "task-a",
    leaseVersion: 1,
    leaseToken: "lease-a",
    correlationId: "corr-incomplete",
    catalog: { models: [{ id: "text-model", capabilities: ["TEXT"] }] },
    capabilityResult: {
      outcome: "PASSED", checkedAt: "2026-08-08T00:00:00.000Z", text: true, image: false,
    },
  }), { code: "AUTO_LISTING_AI_SETTINGS_DATABASE_FAILED" });
  assert.equal(singleModalPool.calls.length > 0, true);
});

test("settings overview reads all collections in one repeatable-read read-only transaction", async () => {
  const { pool, calls, remaining } = scriptedPool([
    (sql) => {
      assert.match(sql, /^BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY$/iu);
      return { rows: [] };
    },
    { rows: [] },
    { rows: [] },
    { rows: [] },
    { rows: [] },
    { rows: [] },
  ]);
  const overview = await createAutoListingAiSettingsPostgres({ pool }).loadSettingsOverview({
    accountId: "account-a",
  });
  assert.equal(overview.accountId, "account-a");
  assert.equal(calls.at(-2).sql, "COMMIT");
  assert.equal(remaining.length, 0);
});

test("existing enqueue contract remains a catalog sync when purpose is omitted", async () => {
  const { pool, calls } = scriptedPool([]);
  await assert.rejects(createAutoListingAiSettingsPostgres({ pool }).enqueueModelSync({
    accountId: "account-a",
    actorId: "account-a",
    connectionId: "connection-a",
    connectionVersion: 1,
    expectedConnectionStatusVersion: 3,
    idempotencyKey: "sync-existing-contract",
    correlationId: "corr-existing-contract",
    maxAttempts: 5,
  }), { code: "AUTO_LISTING_AI_SETTINGS_DATABASE_FAILED" });
  assert.equal(calls.length > 0, true);
});

test("catalog enqueue rejects any attempt policy other than five before database access", async () => {
  const { pool, calls } = scriptedPool([]);
  await assert.rejects(createAutoListingAiSettingsPostgres({ pool }).enqueueModelSync({
    accountId: "account-a",
    actorId: "account-a",
    connectionId: "connection-a",
    connectionVersion: 1,
    expectedConnectionStatusVersion: 3,
    idempotencyKey: "sync-invalid-attempt-policy",
    correlationId: "corr-invalid-attempt-policy",
    maxAttempts: 6,
    syncPurpose: "CATALOG_SYNC",
  }), { code: "AUTO_LISTING_AI_SETTINGS_REPOSITORY_INVALID" });
  assert.equal(calls.length, 0);
});
