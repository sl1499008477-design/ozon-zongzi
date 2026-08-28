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
    "addProfileChannel",
    "claimModelSync",
    "completeModelSync",
    "connectionIdForIntent",
    "createPendingConnection",
    "createProfileFromSelection",
    "enqueueModelSync",
    "failModelSync",
    "listProfileChannels",
    "listRunnableSyncAccountIds",
    "loadCatalogSyncConnectionForSecretResolution",
    "loadConnectionForSecretResolution",
    "loadRollbackConnectionForSecretResolution",
    "loadSettingsCatalog",
    "loadSettingsConnection",
    "loadSettingsOverview",
    "loadSettingsOverviewPage",
    "markConnectionValidated",
    "setProfileChannelEnabled",
  ]);
  assert.throws(() => createAutoListingAiSettingsPostgres({ pool, secret: "raw" }), {
    code: "AUTO_LISTING_AI_SETTINGS_REPOSITORY_INVALID",
  });
  assert.throws(() => createAutoListingAiSettingsPostgres({ pool: {} }), {
    code: "AUTO_LISTING_AI_SETTINGS_REPOSITORY_INVALID",
  });
});

test("connection intent identity is deterministic and rejects cross-shape input before database access", () => {
  const pool = { async connect() {}, async query() {} };
  const repository = createAutoListingAiSettingsPostgres({ pool });
  const first = repository.connectionIdForIntent({ accountId: "account-a", idempotencyKey: "intent-a" });
  const second = repository.connectionIdForIntent({ accountId: "account-a", idempotencyKey: "intent-a" });
  assert.equal(first, second);
  assert.match(first, /^aigconn_[a-f0-9]{40}$/u);
  assert.notEqual(repository.connectionIdForIntent({ accountId: "account-b", idempotencyKey: "intent-a" }), first);
  assert.throws(() => repository.connectionIdForIntent({ accountId: "account-a", idempotencyKey: "intent-a", extra: true }), {
    code: "AUTO_LISTING_AI_SETTINGS_REPOSITORY_INVALID",
  });
});

test("profile channel reads join the exact frozen connection version without the bounded overview directory", async () => {
  const { pool, calls, remaining } = scriptedPool([
    { rows: [] },
    { rows: [{ channel_id: "primary", display_name: "Primary", channel_order: 1, enabled: true,
      status: "BUSY", connection_display_name: "Gateway A", connection_id: "connection-a", connection_version: 2,
      assigned_item_id: "item-a", cooldown_until: null, requires_revalidation: false, last_error_code: null }] },
    { rows: [{ connection_id: "connection-b", connection_version: 3, connection_display_name: "Gateway B" }] },
    { rows: [] },
  ]);
  const result = await createAutoListingAiSettingsPostgres({ pool }).listProfileChannels({
    accountId: "account-a", profileId: "profile-a", profileVersion: 4,
  });
  assert.equal(result.channels[0].connectionVersion, 2);
  assert.deepEqual(result.channelCandidates, [{ connectionId: "connection-b", connectionVersion: 3,
    connectionDisplayName: "Gateway B" }]);
  assert.match(calls[1].sql, /connection\.version=channel\.connection_version/iu);
  assert.match(calls[1].sql, /channel\.account_id=\$1 AND channel\.profile_id=\$2 AND channel\.profile_version=\$3/iu);
  assert.doesNotMatch(calls[1].sql, /loadSettingsOverview|LIMIT 10/iu);
  assert.match(calls[2].sql, /ai_gateway_capability_attempts/iu,
    "candidates require authoritative paid text/image capability evidence, not only catalog names");
  assert.match(calls[2].sql, /target_connection_id=connection\.id/iu);
  assert.match(calls[2].sql, /STRUCTURED_TEXT/iu);
  assert.match(calls[2].sql, /IMAGE_GENERATION/iu);
  assert.match(calls[2].sql, /profile\.api_key_env_name='SUB2API_ENCRYPTED_KEY'/iu);
  assert.match(calls[2].sql, /JOIN ai_gateway_profiles proof_profile/iu,
    "candidate proof may come from an inactive profile bound to the exact candidate connection");
  assert.match(calls[2].sql, /proof_profile\.text_model=profile\.text_model/iu);
  assert.match(calls[2].sql, /proof_profile\.image_model=profile\.image_model/iu);
  assert.match(calls[2].sql, /proof_profile\.text_protocol=profile\.text_protocol/iu);
  assert.match(calls[2].sql, /proof_profile\.image_protocol=profile\.image_protocol/iu);
  assert.match(calls[2].sql, /LIMIT 100/iu, "candidate discovery is bounded independently from exact channel membership");
  assert.equal(remaining.length, 0);
});

test("disabling a busy channel leaves its frozen assignment and execution lease untouched", async () => {
  const busy = { channel_id: "channel-b", display_name: "Gateway B", channel_order: 2, enabled: true,
    connection_id: "connection-b", connection_version: 2, connection_status: "VALIDATED",
    assigned_item_id: "item-a", assigned_status_version: 7, execution_lease_token: "lease-secret",
    requires_revalidation: false, cooldown_until: null, last_error_code: null };
  const { pool, calls, remaining } = scriptedPool([
    { rows: [] }, { rows: [{ id: "account-a" }] }, { rows: [busy] },
    { rows: [{ ...busy, enabled: false }] },
    { rows: [{ ...busy, enabled: false, connection_display_name: "Gateway B", status: "DISABLED" }] },
    { rowCount: 1, rows: [{ event_id: "audit-channel" }] }, { rows: [] },
  ]);
  const result = await createAutoListingAiSettingsPostgres({ pool }).setProfileChannelEnabled({
    accountId: "account-a", actorAccountId: "account-a", profileId: "profile-a", profileVersion: 1,
    channelId: "channel-b", enabled: false,
  });
  assert.equal(result.status, "DISABLED");
  const update = calls.find(({ sql }) => /UPDATE auto_listing_ai_profile_channels SET enabled=\$5/iu.test(sql));
  assert.doesNotMatch(update.sql, /assigned_|execution_lease_/iu);
  assert.equal(update.params.includes("lease-secret"), false);
  assert.equal(remaining.length, 0);
});

test("enabling always enforces the channel-order connection eligibility fence", async () => {
  const { pool } = scriptedPool([
    { rows: [] }, { rows: [{ id: "account-a" }] },
    { rows: [{ channel_id: "channel-b", channel_order: 2, requires_revalidation: false,
      profile_enabled: true, connection_status: "RETIRED", connection_id: "connection-b", connection_version: 2 }] },
    { rows: [] },
  ]);
  await assert.rejects(createAutoListingAiSettingsPostgres({ pool }).setProfileChannelEnabled({
    accountId: "account-a", actorAccountId: "account-a", profileId: "profile-a", profileVersion: 1,
    channelId: "channel-b", enabled: true,
  }), { code: "AUTO_LISTING_AI_PROFILE_CHANNEL_CONNECTION_INELIGIBLE", status: 409 });
});

test("enabling an inactive historical profile channel is rejected under the locked current-profile fence", async () => {
  const { pool } = scriptedPool([
    { rows: [] }, { rows: [{ id: "account-a" }] },
    { rows: [{ channel_id: "primary", channel_order: 1, enabled: false, requires_revalidation: false,
      profile_enabled: false, connection_status: "ACTIVE", connection_id: "connection-a", connection_version: 1 }] },
    { rows: [] },
  ]);
  await assert.rejects(createAutoListingAiSettingsPostgres({ pool }).setProfileChannelEnabled({
    accountId: "account-a", actorAccountId: "account-a", profileId: "profile-old", profileVersion: 1,
    channelId: "primary", enabled: true,
  }), { code: "AUTO_LISTING_AI_PROFILE_CHANNEL_NOT_CURRENT", status: 409 });
});

test("a repeated channel state request returns the locked safe DTO without another write or audit", async () => {
  const disabled = { channel_id: "channel-b", display_name: "Gateway B", channel_order: 2, enabled: false,
    connection_id: "connection-b", connection_version: 2, connection_status: "VALIDATED",
    connection_display_name: "Gateway B", assigned_item_id: "item-a", cooldown_until: null,
    requires_revalidation: false, last_error_code: null, status: "DISABLED" };
  const { pool, calls, remaining } = scriptedPool([
    { rows: [] }, { rows: [{ id: "account-a" }] }, { rows: [disabled] },
    { rows: [] },
  ]);
  const result = await createAutoListingAiSettingsPostgres({ pool }).setProfileChannelEnabled({
    accountId: "account-a", actorAccountId: "account-a", profileId: "profile-a", profileVersion: 1,
    channelId: "channel-b", enabled: false,
  });
  assert.equal(result.status, "DISABLED");
  assert.equal(calls.some(({ sql }) => /UPDATE auto_listing_ai_profile_channels SET enabled=\$5/iu.test(sql)), false);
  assert.equal(calls.some(({ sql }) => /INSERT INTO audit_events/iu.test(sql)), false);
  assert.equal(remaining.length, 0);
});

test("service-derived connection identity accepts randomized ciphertext replay by stable fingerprint", async () => {
  const connectionId = "aigconn_066ef301d634906b00caefb38b3d6276d8448b11";
  const input = { ...connectionInput, connectionId };
  const replayPool = scriptedPool([
    { rows: [] },
    { rowCount: 1, rows: [{ id: "account-a" }] },
    (_sql, params) => ({ rowCount: 1, rows: [{ ...connectionRow, id: connectionId, request_hash: params[2] }] }),
    { rows: [] },
  ]);
  const replay = await createAutoListingAiSettingsPostgres({ pool: replayPool.pool }).createPendingConnection(input);
  assert.equal(replay.id, connectionId);
  assert.equal(replay.duplicate, true);
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

test("runtime secret resolution is tenant scoped, supports frozen retired jobs, and returns ciphertext only", async () => {
  const { pool, calls } = scriptedPool([{ rowCount: 1, rows: [{ ...connectionRow, status: "RETIRED" }] }]);
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
  assert.match(calls[0].sql, /WHERE account_id=\$1 AND id=\$2 AND version=\$3 AND status IN \('VALIDATED','ACTIVE','RETIRED'\)/iu);
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

test("catalog secret resolution requires the exact live manual-or-active catalog status fence", async () => {
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
  assert.match(calls[0].sql, /c\.status IN \('PENDING','VALIDATED','ACTIVE'\)/iu);
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
  assert.equal(overview.profiles[0].activation, null);
});

test("settings overview projects the latest exact tenant profile activation audit instead of configuration creation time", async () => {
  const occurredAt = new Date("2026-08-09T02:03:04.000Z");
  const profile = {
    id: "profile-a", account_id: "account-a", display_name: "Profile A", config_version: 2,
    base_url: "https://gateway.example/v1", api_key_env_name: "SUB2API_ENCRYPTED_KEY",
    text_protocol: "SUB2API_RESPONSES", image_protocol: "SUB2API_OPENAI_IMAGES",
    text_model: "text-a", image_model: "image-a", enabled: true,
    capability_result: {}, capability_checked_at: null, connection_id: null, connection_version: null,
    created_at: "2026-08-08T00:00:00.000Z", activation_action: "AUTO_LISTING_AI_PROFILE_ROLLBACK",
    activation_occurred_at: occurredAt, activation_actor_id: "account-admin-a",
  };
  const { pool, calls } = scriptedPool([
    { rows: [] }, { rows: [] }, { rows: [] }, { rows: [] }, { rows: [profile] }, { rows: [] },
  ]);

  const result = await createAutoListingAiSettingsPostgres({ pool }).loadSettingsOverview({ accountId: "account-a" });

  assert.deepEqual(result.profiles[0].activation, {
    kind: "ROLLBACK", occurredAt: "2026-08-09T02:03:04.000Z", actorId: "account-admin-a",
  });
  const profileQuery = calls.find(({ sql }) => /FROM ai_gateway_profiles/iu.test(sql));
  assert.match(profileQuery.sql, /activation\.account_id=p\.account_id/iu);
  assert.match(profileQuery.sql, /activation\.entity_id=p\.id/iu);
  assert.match(profileQuery.sql, /activation\.metadata->>'entityId'=p\.id/iu);
  assert.match(profileQuery.sql, /activation\.metadata->>'configVersion'=p\.config_version::TEXT/iu);
  assert.match(profileQuery.sql, /activation\.status='SUCCESS'/iu);
  assert.match(profileQuery.sql, /activation\.actor_id\s*~\s*'\^\[A-Za-z0-9\]/u,
    "legacy audits without a safe actor ID must be ignored as unavailable evidence");
  assert.match(profileQuery.sql, /AUTO_LISTING_AI_PROFILE_PUBLISH/iu);
  assert.match(profileQuery.sql, /AUTO_LISTING_AI_PROFILE_ROLLBACK/iu);
  assert.match(profileQuery.sql, /ORDER BY activation\.occurred_at DESC,activation\.event_id DESC NULLS LAST,activation\.id DESC/iu);
  assert.deepEqual(profileQuery.params, ["account-a"]);
});

test("settings overview producer keeps task and profile duplicate flags boolean across multiple rows", async () => {
  const task = (id) => ({ id, account_id: "account-a", connection_id: "connection-a", connection_version: 1,
    sync_purpose: "CATALOG_SYNC", target_connection_status_version: 1, status: "PENDING", status_version: 1,
    attempt_count: 0, max_attempts: 5, lease_version: 0, available_at: "2026-08-08T00:00:00.000Z",
    completed_at: null, last_error_code: null, last_error_safe: null, created_at: "2026-08-08T00:00:00.000Z" });
  const profile = (id) => ({ id, account_id: "account-a", display_name: id, config_version: 1,
    base_url: "https://legacy.example/v1", api_key_env_name: "SUB2API_LEGACY_KEY",
    text_protocol: "SUB2API_RESPONSES", image_protocol: "SUB2API_OPENAI_IMAGES",
    text_model: "legacy-text", image_model: "legacy-image", enabled: false,
    capability_result: {}, capability_checked_at: null, connection_id: null, connection_version: null,
    created_at: "2026-08-08T00:00:00.000Z" });
  const { pool } = scriptedPool([
    { rows: [] }, { rows: [] }, { rows: [] }, { rows: [task("task-a"), task("task-b")] },
    { rows: [profile("profile-a"), profile("profile-b")] }, { rows: [] },
  ]);

  const overview = await createAutoListingAiSettingsPostgres({ pool }).loadSettingsOverview({ accountId: "account-a" });

  assert.deepEqual(overview.syncTasks.map((row) => row.duplicate), [false, false]);
  assert.deepEqual(overview.profiles.map((row) => row.duplicate), [false, false]);
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

test("active paid reservation maps the database state guard to one stable 409", async () => {
  const guarded = scriptedPool([
    { rows: [] },
    { rowCount: 1, rows: [{ id: "account-a" }] },
    { rows: [] },
    { rows: [{ ...connectionRow, status: "PENDING", status_version: 1 }] },
    () => { throw Object.assign(new Error("active paid capability subcall blocks connection state transition"), {
      code: "23514",
    }); },
    { rows: [] },
  ]);
  await assert.rejects(createAutoListingAiSettingsPostgres({ pool: guarded.pool }).markConnectionValidated({
    accountId: "account-a", actorId: "account-a", connectionId: "connection-a", connectionVersion: 1,
    expectedStatusVersion: 1, idempotencyKey: "validate-during-paid-subcall",
    correlationId: "validate-during-paid-subcall-corr", rollbackCapabilityEvidence: null,
    validationResult: { outcome: "PASSED", checkedAt: "2026-08-08T00:00:00.000Z", endpoint: "models" },
  }), {
    code: "AUTO_LISTING_AI_SETTINGS_CAPABILITY_SUBCALL_CONFLICT", status: 409, retryable: true,
  });
});

test("profile binding accepts an ACTIVE connection latest catalog as a disabled successor without invented modality metadata", async () => {
  const profile = {
    id: "profile-a", account_id: "account-a", display_name: "Profile A", config_version: 1,
    base_url: connectionRow.base_url, api_key_env_name: "SUB2API_ENCRYPTED_KEY",
    text_protocol: "SUB2API_RESPONSES", image_protocol: "SUB2API_OPENAI_IMAGES",
    text_model: "text-model-a", image_model: "image-model-a", enabled: false,
    capability_result: {}, capability_checked_at: null,
    connection_id: "connection-a", connection_version: 1,
  };
  const { pool, calls } = scriptedPool([
    { rows: [] }, { rows: [{ id: "account-a" }] }, { rows: [] },
    { rows: [{ ...connectionRow, status: "ACTIVE", status_version: 3 }] },
    { rows: [{ id: "catalog-a", catalog: { models: [{ id: "image-model-a" }, { id: "text-model-a" }] },
      catalog_hash: "a".repeat(64), capability_result: {}, tested_at: null }] },
    { rows: [profile] }, { rows: [] }, { rowCount: 1, rows: [{ event_id: "audit-a" }] }, { rows: [] },
  ]);
  const result = await createAutoListingAiSettingsPostgres({ pool }).createProfileFromSelection({
    accountId: "account-a", actorId: "account-a", connectionId: "connection-a", connectionVersion: 1,
    catalogId: "catalog-a", displayName: "Profile A", textModel: "text-model-a", imageModel: "image-model-a",
    textProtocol: "SUB2API_RESPONSES", imageProtocol: "SUB2API_OPENAI_IMAGES",
    idempotencyKey: "bind-profile-a", correlationId: "corr-bind-profile-a",
  });
  assert.equal(result.id, "profile-a");
  assert.equal(result.enabled, false);
  assert.match(calls[3].sql, /status IN \('VALIDATED','ACTIVE'\)/u);
  assert.match(calls[4].sql, /NOT EXISTS[\s\S]*newer\.created_at,newer\.id/iu);
  assert.equal(calls.some(({ sql }) => /capabilities|capability_result->>'outcome'/iu.test(sql)), false);
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

test("settings overview normalizes PostgreSQL timestamps into closed JSON DTO values", async () => {
  const timestamp = new Date("2026-08-08T00:00:00.000Z");
  const { pool } = scriptedPool([
    { rows: [] },
    { rows: [{ ...connectionRow, created_at: timestamp, validated_at: timestamp }] },
    { rows: [{ id: "catalog-a", account_id: "account-a", connection_id: "connection-a",
      connection_version: 1, sync_task_id: "task-a", catalog: { models: [] },
      catalog_hash: "a".repeat(64), capability_result: { outcome: "NOT_TESTED" },
      capability_hash: "b".repeat(64), tested_at: timestamp, created_at: timestamp }] },
    { rows: [{ id: "task-a", account_id: "account-a", connection_id: "connection-a",
      connection_version: 1, sync_purpose: "CATALOG_SYNC", target_connection_status_version: 1,
      status: "SUCCEEDED", status_version: 3, attempt_count: 1, max_attempts: 5,
      lease_version: 1, available_at: timestamp, completed_at: timestamp, created_at: timestamp }] },
    { rows: [] },
    { rows: [] },
  ]);
  const overview = await createAutoListingAiSettingsPostgres({ pool }).loadSettingsOverview({
    accountId: "account-a",
  });
  assert.equal(overview.connections[0].createdAt, timestamp.toISOString());
  assert.equal(overview.connections[0].validatedAt, timestamp.toISOString());
  assert.equal(overview.catalogs[0].testedAt, timestamp.toISOString());
  assert.equal(overview.catalogs[0].createdAt, timestamp.toISOString());
  assert.equal(overview.syncTasks[0].availableAt, timestamp.toISOString());
  assert.equal(overview.syncTasks[0].completedAt, timestamp.toISOString());
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
