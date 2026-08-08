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

function scriptedPool(steps) {
  const calls = [];
  const client = {
    async query(sql, params = []) {
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
    "beginCapabilityTest", "completeCapabilityTest", "createProfile", "createStrategyVersion",
    "listProfiles", "listStrategyVersions", "publishProfile", "publishStrategyVersion",
  ]);
  assert.throws(() => createAutoListingAiAdminPostgres({ pool, apiKey: "raw" }), {
    code: "AUTO_LISTING_AI_ADMIN_REPOSITORY_INVALID",
  });
  assert.throws(() => createAutoListingAiAdminPostgres({ pool: {} }), {
    code: "AUTO_LISTING_AI_ADMIN_REPOSITORY_INVALID",
  });
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
  assert.match(calls[0].sql, /WHERE account_id=\$1/iu);
});

test("capability begin creates one fenced account-scoped attempt in a transaction", async () => {
  const { pool, calls } = scriptedPool([
    { rows: [] },
    { rowCount: 1, rows: [{ id: "account-a" }] },
    { rowCount: 1, rows: [profileRow] },
    { rowCount: 0, rows: [] },
    { rowCount: 1, rows: [{
      id: "attempt-a", fence: "9", status: "RUNNING", response: null,
      lease_version: 1, lease_token: "caplease_initial", lease_expires_at: "2026-08-04T10:10:00.000Z",
    }] },
    { rows: [] },
  ]);
  const repository = createAutoListingAiAdminPostgres({ pool });
  const result = await repository.beginCapabilityTest({
    accountId: "account-a", actorId: "account-a", profileId: "profile-a", configVersion: 1,
    correlationId: "corr-a", attemptId: "attempt-a",
  });
  assert.equal(result.fence, 9);
  assert.equal(result.leaseVersion, 1);
  assert.equal(result.leaseToken, "caplease_initial");
  assert.equal(result.profile.apiKeyEnvName, "SUB2API_PRIMARY_KEY");
  assert.match(calls[2].sql, /ai_gateway_profiles[\s\S]*FOR UPDATE/iu);
  assert.match(calls[4].sql, /INSERT INTO ai_gateway_capability_attempts/iu);
  assert.equal(calls.at(-2).sql, "COMMIT");
});

test("capability completion applies its fence and audit in one transaction", async () => {
  const { pool, calls } = scriptedPool([
    { rows: [] },
    { rowCount: 1, rows: [{ id: "account-a" }] },
    { rowCount: 1, rows: [profileRow] },
    { rowCount: 1, rows: [{ id: "attempt-a", fence: "9", correlation_id: "corr-a", status: "RUNNING",
      completion_hash: null, response: null, lease_version: 1, lease_token: "caplease_initial" }] },
    { rowCount: 1, rows: [{ id: "attempt-a", fence: "9" }] },
    { rowCount: 1, rows: [{ enabled: false }] },
    { rowCount: 1, rows: [{ id: "attempt-a" }] },
    { rowCount: 0, rows: [] },
    { rowCount: 1, rows: [{ event_id: "audit" }] },
    { rows: [] },
  ]);
  const repository = createAutoListingAiAdminPostgres({ pool });
  const result = await repository.completeCapabilityTest({
    accountId: "account-a", actorId: "account-a", profileId: "profile-a", configVersion: 1,
    correlationId: "corr-a", attemptId: "attempt-a", fence: 9,
    leaseVersion: 1, leaseToken: "caplease_initial",
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

test("capability begin reclaims only an expired running lease and advances its lease fence", async () => {
  const expired = {
    id: "attempt-a", fence: "9", account_id: "account-a", profile_id: "profile-a",
    config_version: 1, correlation_id: "corr-a", status: "RUNNING", response: null,
    lease_version: 1, lease_token: "caplease_old", lease_expires_at: "2026-08-04T09:00:00.000Z",
  };
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
    { rows: [] },
  ]);
  const repository = createAutoListingAiAdminPostgres({ pool });
  const result = await repository.beginCapabilityTest({
    accountId: "account-a", actorId: "account-a", profileId: "profile-a", configVersion: 1,
    correlationId: "corr-a", attemptId: "attempt-a",
  });
  assert.equal(result.duplicate, false);
  assert.equal(result.reclaimed, true);
  assert.equal(result.leaseVersion, 2);
  assert.notEqual(result.leaseToken, "caplease_old");
  assert.equal(calls.some(({ sql }) => /INSERT INTO ai_gateway_capability_attempts/iu.test(sql)), false);
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
    { rowCount: 1, rows: [{ id: "profile-old", config_version: 2 }] },
    { rowCount: 1, rows: [] },
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
  assert.match(calls[4].sql, /enabled IS TRUE[\s\S]*FOR UPDATE/iu);
  assert.doesNotMatch(calls[4].sql, /ORDER BY|LIMIT|latest/iu);
  assert.match(calls[5].sql, /SET enabled=FALSE/iu);
  assert.match(calls[6].sql, /SET enabled=TRUE/iu);
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
  assert.equal(calls.some(({ sql }) => /SET enabled=/iu.test(sql)), false);
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
