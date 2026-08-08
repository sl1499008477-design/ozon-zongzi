import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createAutoListingAiAdminPostgres } from "../auto-listing-ai-admin-postgres.mjs";

const connectionString = process.env.SONLI_MIGRATION_TEST_DATABASE_URL;
const enabled = process.env.AUTO_LISTING_POSTGRES_TESTS === "1" && Boolean(connectionString);
const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../db/migrations");
const quote = (value) => `"${String(value).replaceAll('"', '""')}"`;

const profile = (displayName) => ({
  displayName,
  baseUrl: "https://gateway.example.test/v1",
  apiKeyEnvName: `SUB2API_${displayName.toUpperCase()}_KEY`,
  textProtocol: "SUB2API_RESPONSES",
  imageProtocol: "SUB2API_OPENAI_IMAGES",
  textModel: "text-model",
  imageModel: "image-model",
  configVersion: 1,
});

const strategyRules = (ruleId) => [{
  ruleId,
  ruleOrder: 1,
  matchType: "PRODUCT_STYLE",
  productStyle: "GENERAL",
  style: "BALANCED_DEFAULT",
  textDensityByRole: { MAIN: "NONE", SELLING_POINT: "LIGHT" },
}];

async function rawRejectsCode(operation, expectedCode) {
  try {
    await operation();
    return false;
  } catch (error) {
    return error?.code === expectedCode;
  }
}

if (!enabled) {
  test("AI admin PostgreSQL integration requires explicit opt-in and a dedicated disposable database", {
    skip: "requires AUTO_LISTING_POSTGRES_TESTS=1 and SONLI_MIGRATION_TEST_DATABASE_URL",
  }, () => {});
} else {
  test("AI admin repository serializes publication, preserves immutable history, and enforces account boundaries", { timeout: 60_000 }, async () => {
    const { Pool } = await import("pg");
    const adminPool = new Pool({ connectionString, max: 1 });
    const admin = await adminPool.connect();
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const schema = `auto_listing_ai_admin_${suffix}`;
    const schemaSql = quote(schema);
    const accountA = `account-a-${suffix}`;
    const accountB = `account-b-${suffix}`;
    let pool;
    try {
      await admin.query(`CREATE SCHEMA ${schemaSql}`);
      await admin.query(`SET search_path TO ${schemaSql}, public`);
      const migrations = (await readdir(migrationsDir))
        .filter((file) => /^\d{3}_.+\.sql$/u.test(file))
        .sort();
      for (const migration of migrations) {
        await admin.query(await readFile(path.join(migrationsDir, migration), "utf8"));
      }
      for (const accountId of [accountA, accountB]) {
        await admin.query(
          "INSERT INTO accounts (id,username,display_name,role,status) VALUES ($1,$2,$2,'admin','active')",
          [accountId, `user-${accountId}`],
        );
      }
      pool = new Pool({ connectionString, max: 8, options: `-c search_path=${schema},public` });
      const repository = createAutoListingAiAdminPostgres({ pool });
      const scopedRuleConstraint = await pool.query(
        `SELECT convalidated
           FROM pg_constraint
          WHERE conname='ai_content_strategy_rules_account_version_fk'
            AND conrelid='ai_content_strategy_rules'::regclass`,
      );
      assert.deepEqual(scopedRuleConstraint.rows, [{ convalidated: true }]);

      async function createPassedProfile(name, idempotencyKey) {
        const created = await repository.createProfile({
          accountId: accountA, actorId: accountA, idempotencyKey,
          correlationId: `correlation-${idempotencyKey}`, profile: profile(name),
        });
        const checkedAt = new Date().toISOString();
        const capabilityResult = {
          outcome: "PASSED",
          features: ["STRUCTURED_TEXT", "IMAGE_GENERATION", "IMAGE_DECODE_PNG"],
          latencyMs: 5,
          models: { text: "text-model", image: "image-model" },
          checkedAt, errorCode: null,
        };
        const correlationId = `capability-${idempotencyKey}`;
        const attemptId = `attempt-${idempotencyKey}`;
        const begun = await repository.beginCapabilityTest({
          accountId: accountA, actorId: accountA, profileId: created.id, configVersion: 1,
          correlationId, attemptId,
        });
        const completed = await repository.completeCapabilityTest({
          accountId: accountA, actorId: accountA, profileId: created.id, configVersion: 1,
          correlationId, attemptId, fence: begun.fence,
          leaseVersion: begun.leaseVersion, leaseToken: begun.leaseToken, capabilityResult,
        });
        assert.equal(completed.applied, true);
        return created;
      }

      const first = await createPassedProfile("alpha", `create-alpha-${suffix}`);
      const replay = await repository.createProfile({
        accountId: accountA, actorId: accountA, idempotencyKey: `create-alpha-${suffix}`,
        correlationId: `correlation-create-alpha-${suffix}`, profile: profile("alpha"),
      });
      assert.equal(replay.id, first.id);
      assert.equal(replay.duplicate, true);
      const second = await createPassedProfile("beta", `create-beta-${suffix}`);
      assert.equal(await repository.beginCapabilityTest({
        accountId: accountB, actorId: accountB, profileId: first.id, configVersion: 1,
        correlationId: `foreign-capability-${suffix}`, attemptId: `foreign-attempt-${suffix}`,
      }), null);

      const oldAttempt = await repository.beginCapabilityTest({
        accountId: accountA, actorId: accountA, profileId: first.id, configVersion: 1,
        correlationId: `capability-old-${suffix}`, attemptId: `attempt-old-${suffix}`,
      });
      const newAttempt = await repository.beginCapabilityTest({
        accountId: accountA, actorId: accountA, profileId: first.id, configVersion: 1,
        correlationId: `capability-new-${suffix}`, attemptId: `attempt-new-${suffix}`,
      });
      const newestCheckedAt = new Date().toISOString();
      const newestResult = {
        outcome: "PASSED", features: ["STRUCTURED_TEXT", "IMAGE_GENERATION", "IMAGE_DECODE_PNG"], latencyMs: 7,
        models: { text: "text-model", image: "image-model" }, checkedAt: newestCheckedAt, errorCode: null,
      };
      assert.equal((await repository.completeCapabilityTest({
        accountId: accountA, actorId: accountA, profileId: first.id, configVersion: 1,
        correlationId: `capability-new-${suffix}`, attemptId: `attempt-new-${suffix}`,
        fence: newAttempt.fence, leaseVersion: newAttempt.leaseVersion, leaseToken: newAttempt.leaseToken,
        capabilityResult: newestResult,
      })).applied, true);
      const stale = await repository.completeCapabilityTest({
        accountId: accountA, actorId: accountA, profileId: first.id, configVersion: 1,
        correlationId: `capability-old-${suffix}`, attemptId: `attempt-old-${suffix}`,
        fence: oldAttempt.fence, leaseVersion: oldAttempt.leaseVersion, leaseToken: oldAttempt.leaseToken,
        capabilityResult: { outcome: "FAILED", features: [], latencyMs: null,
          models: { text: "text-model", image: "image-model" }, checkedAt: new Date().toISOString(),
          errorCode: "NON_RETRYABLE_AUTH" },
      });
      assert.deepEqual({ applied: stale.applied, stale: stale.stale }, { applied: false, stale: true });
      const preserved = await pool.query(
        "SELECT enabled,capability_result FROM ai_gateway_profiles WHERE account_id=$1 AND id=$2",
        [accountA, first.id],
      );
      assert.equal(preserved.rows[0].capability_result.checkedAt, newestCheckedAt);

      const crashCorrelation = `capability-crash-${suffix}`;
      const crashAttemptId = `attempt-crash-${suffix}`;
      const crashAttempt = await repository.beginCapabilityTest({
        accountId: accountA, actorId: accountA, profileId: second.id, configVersion: 1,
        correlationId: crashCorrelation, attemptId: crashAttemptId,
      });
      const beforeCrash = await pool.query(
        "SELECT capability_result FROM ai_gateway_profiles WHERE account_id=$1 AND id=$2",
        [accountA, second.id],
      );
      await pool.query(`CREATE OR REPLACE FUNCTION reject_selected_capability_audit()
        RETURNS TRIGGER LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.correlation_id='${crashCorrelation}' THEN
            RAISE EXCEPTION 'forced audit failure';
          END IF;
          RETURN NEW;
        END;
        $$`);
      await pool.query(`CREATE TRIGGER reject_selected_capability_audit_trigger
        BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_selected_capability_audit()`);
      const crashResult = { outcome: "PASSED",
        features: ["STRUCTURED_TEXT", "IMAGE_GENERATION", "IMAGE_DECODE_PNG"], latencyMs: 8,
        models: { text: "text-model", image: "image-model" }, checkedAt: new Date().toISOString(), errorCode: null };
      await assert.rejects(repository.completeCapabilityTest({
        accountId: accountA, actorId: accountA, profileId: second.id, configVersion: 1,
        correlationId: crashCorrelation, attemptId: crashAttemptId, fence: crashAttempt.fence,
        leaseVersion: crashAttempt.leaseVersion, leaseToken: crashAttempt.leaseToken,
        capabilityResult: crashResult,
      }), { code: "AUTO_LISTING_AI_ADMIN_DATABASE_FAILED" });
      const rolledBack = await pool.query(
        `SELECT p.capability_result,a.status,a.response
           FROM ai_gateway_profiles p
           JOIN ai_gateway_capability_attempts a
             ON a.account_id=p.account_id AND a.profile_id=p.id AND a.config_version=p.config_version
          WHERE p.account_id=$1 AND p.id=$2 AND a.id=$3`,
        [accountA, second.id, crashAttemptId],
      );
      assert.deepEqual(rolledBack.rows[0].capability_result, beforeCrash.rows[0].capability_result);
      assert.equal(rolledBack.rows[0].status, "RUNNING");
      assert.equal(rolledBack.rows[0].response, null);
      await pool.query("DROP TRIGGER reject_selected_capability_audit_trigger ON audit_events");
      await pool.query("DROP FUNCTION reject_selected_capability_audit()");
      assert.equal((await repository.completeCapabilityTest({
        accountId: accountA, actorId: accountA, profileId: second.id, configVersion: 1,
        correlationId: crashCorrelation, attemptId: crashAttemptId, fence: crashAttempt.fence,
        leaseVersion: crashAttempt.leaseVersion, leaseToken: crashAttempt.leaseToken,
        capabilityResult: crashResult,
      })).applied, true);
      assert.equal(await rawRejectsCode(() => pool.query(
        "UPDATE ai_gateway_capability_attempts SET response='{}'::JSONB WHERE account_id=$1 AND id=$2",
        [accountA, crashAttemptId],
      ), "23514"), true);
      assert.equal(await rawRejectsCode(() => pool.query(
        "DELETE FROM ai_gateway_capability_attempts WHERE account_id=$1 AND id=$2",
        [accountA, crashAttemptId],
      ), "23514"), true);

      const recoveryCorrelation = `capability-recovery-${suffix}`;
      const recoveryAttemptId = `attempt-recovery-${suffix}`;
      await pool.query(
        `INSERT INTO ai_gateway_capability_attempts (
           id,account_id,profile_id,config_version,correlation_id,status,
           lease_version,lease_token,lease_expires_at
         ) VALUES ($1,$2,$3,1,$4,'RUNNING',1,'caplease_crashed',NOW()-INTERVAL '1 minute')`,
        [recoveryAttemptId, accountA, second.id, recoveryCorrelation],
      );
      const recoveredAttempt = await repository.beginCapabilityTest({
        accountId: accountA, actorId: accountA, profileId: second.id, configVersion: 1,
        correlationId: recoveryCorrelation, attemptId: recoveryAttemptId,
      });
      assert.equal(recoveredAttempt.reclaimed, true);
      assert.equal(recoveredAttempt.leaseVersion, 2);
      assert.notEqual(recoveredAttempt.leaseToken, "caplease_crashed");
      const recoveryResult = { outcome: "PASSED",
        features: ["STRUCTURED_TEXT", "IMAGE_GENERATION", "IMAGE_DECODE_PNG"], latencyMs: 6,
        models: { text: "text-model", image: "image-model" }, checkedAt: new Date().toISOString(), errorCode: null };
      await assert.rejects(repository.completeCapabilityTest({
        accountId: accountA, actorId: accountA, profileId: second.id, configVersion: 1,
        correlationId: recoveryCorrelation, attemptId: recoveryAttemptId, fence: recoveredAttempt.fence,
        leaseVersion: 1, leaseToken: "caplease_crashed", capabilityResult: recoveryResult,
      }), { code: "AI_GATEWAY_PROFILE_VERSION_CONFLICT", status: 409 });
      const recoveredCompletion = await repository.completeCapabilityTest({
        accountId: accountA, actorId: accountA, profileId: second.id, configVersion: 1,
        correlationId: recoveryCorrelation, attemptId: recoveryAttemptId, fence: recoveredAttempt.fence,
        leaseVersion: recoveredAttempt.leaseVersion, leaseToken: recoveredAttempt.leaseToken,
        capabilityResult: recoveryResult,
      });
      assert.equal(recoveredCompletion.applied, true);

      const publicationInputs = [first, second].map((candidate, index) => ({
        accountId: accountA, actorId: accountA, profileId: candidate.id, configVersion: 1,
        idempotencyKey: `publish-profile-${index}-${suffix}`,
        correlationId: `correlation-publish-profile-${index}-${suffix}`,
      }));
      await Promise.all(publicationInputs.map((input) => repository.publishProfile(input)));
      const enabledProfiles = await pool.query(
        "SELECT id,config_version FROM ai_gateway_profiles WHERE account_id=$1 AND enabled IS TRUE",
        [accountA],
      );
      assert.equal(enabledProfiles.rowCount, 1);
      assert.equal(await rawRejectsCode(() => pool.query(
        "UPDATE ai_gateway_profiles SET enabled=TRUE WHERE account_id=$1 AND id<>$2",
        [accountA, enabledProfiles.rows[0].id],
      ), "23505"), true);
      await assert.rejects(repository.publishProfile({
        ...publicationInputs[0], accountId: accountB, actorId: accountB,
        idempotencyKey: `foreign-profile-${suffix}`,
      }), { code: "AUTO_LISTING_AI_PROFILE_NOT_FOUND", status: 404 });

      async function createStrategy(version) {
        return repository.createStrategyVersion({
          accountId: accountA, actorId: accountA, strategyKey: "default", version,
          idempotencyKey: `create-strategy-${version}-${suffix}`,
          correlationId: `correlation-create-strategy-${version}-${suffix}`,
          content: { schemaVersion: "V1" }, rules: strategyRules(`rule-${version}`),
        });
      }
      const strategy1 = await createStrategy(1);
      const strategy2 = await createStrategy(2);
      const strategyReadback = await repository.listStrategyVersions({ accountId: accountA, strategyKey: "default" });
      assert.deepEqual(strategyReadback.map((row) => row.rules[0].ruleId), ["rule-1", "rule-2"]);
      assert.deepEqual(strategyReadback[0].rules[0].textDensityByRole, { MAIN: "NONE", SELLING_POINT: "LIGHT" });
      const strategyPublicationInputs = [strategy1, strategy2].map((candidate) => ({
        accountId: accountA, actorId: accountA, strategyKey: "default",
        strategyVersionId: candidate.id, version: candidate.version,
        idempotencyKey: `publish-strategy-${candidate.version}-${suffix}`,
        correlationId: `correlation-publish-strategy-${candidate.version}-${suffix}`,
      }));
      await Promise.all(strategyPublicationInputs.map((input) => repository.publishStrategyVersion(input)));
      const strategies = await pool.query(
        "SELECT id,status,content,content_hash,published_at FROM ai_content_strategy_versions WHERE account_id=$1 AND strategy_key='default' ORDER BY version",
        [accountA],
      );
      assert.equal(strategies.rows.filter((row) => row.status === "PUBLISHED").length, 1);
      assert.equal(strategies.rows.filter((row) => row.status === "RETIRED").length, 1);
      const retired = strategies.rows.find((row) => row.status === "RETIRED");
      assert.ok(retired.published_at);
      assert.equal(await rawRejectsCode(() => pool.query(
        "UPDATE ai_content_strategy_versions SET content='{\"changed\":true}'::JSONB WHERE account_id=$1 AND id=$2",
        [accountA, retired.id],
      ), "23514"), true);
      assert.equal(await rawRejectsCode(() => pool.query(
        "DELETE FROM ai_content_strategy_versions WHERE account_id=$1 AND id=$2",
        [accountA, retired.id],
      ), "23514"), true);
      assert.equal(await rawRejectsCode(() => pool.query(
        `INSERT INTO ai_content_strategy_rules
           (id,account_id,strategy_version_id,rule_kind,rule_order,product_style,rule)
         VALUES ($1,$2,$3,'PRODUCT_STYLE',99,'GENERAL','{}'::JSONB)`,
        [`late-rule-${suffix}`, accountA, retired.id],
      ), "23514"), true);
      assert.equal(await rawRejectsCode(() => pool.query(
        `INSERT INTO ai_content_strategy_rules
           (id,account_id,strategy_version_id,rule_kind,rule_order,product_style,rule)
         VALUES ($1,$2,$3,'PRODUCT_STYLE',100,'GENERAL','{}'::JSONB)`,
        [`foreign-rule-${suffix}`, accountB, strategy1.id],
      ), "23503"), true);

      const legacyStrategy = `legacy-null-published-${suffix}`;
      await pool.query(
        `INSERT INTO ai_content_strategy_versions
           (id,account_id,strategy_key,version,status,content,content_hash,published_at)
         VALUES ($1,$2,'legacy-null',1,'PUBLISHED','{}'::JSONB,$3,NULL)`,
        [legacyStrategy, accountA, "f".repeat(64)],
      );
      assert.equal(await rawRejectsCode(() => pool.query(
        "UPDATE ai_content_strategy_versions SET content='{\"changed\":true}'::JSONB WHERE account_id=$1 AND id=$2",
        [accountA, legacyStrategy],
      ), "23514"), true);
      assert.equal(await rawRejectsCode(() => pool.query(
        `INSERT INTO ai_content_strategy_rules
           (id,account_id,strategy_version_id,rule_kind,rule_order,product_style,rule)
         VALUES ($1,$2,$3,'PRODUCT_STYLE',1,'GENERAL','{}'::JSONB)`,
        [`legacy-rule-${suffix}`, accountA, legacyStrategy],
      ), "23514"), true);
      await pool.query(
        "UPDATE ai_content_strategy_versions SET status='RETIRED' WHERE account_id=$1 AND id=$2",
        [accountA, legacyStrategy],
      );
      assert.equal(await rawRejectsCode(() => pool.query(
        "DELETE FROM ai_content_strategy_versions WHERE account_id=$1 AND id=$2",
        [accountA, legacyStrategy],
      ), "23514"), true);

      const audits = await pool.query(
        `SELECT action,COUNT(*)::INTEGER AS count
           FROM audit_events
          WHERE account_id=$1 AND source='auto-listing-ai-admin'
          GROUP BY action`,
        [accountA],
      );
      const counts = Object.fromEntries(audits.rows.map((row) => [row.action, row.count]));
      assert.deepEqual(counts, {
        AUTO_LISTING_AI_PROFILE_CAPABILITY_TEST: 6,
        AUTO_LISTING_AI_PROFILE_CREATE: 2,
        AUTO_LISTING_AI_PROFILE_PUBLISH: 2,
        AUTO_LISTING_AI_STRATEGY_VERSION_CREATE: 2,
        AUTO_LISTING_AI_STRATEGY_VERSION_PUBLISH: 2,
      });
    } finally {
      try {
        await pool?.end();
        await admin.query("SET search_path TO public");
        await admin.query(`DROP SCHEMA IF EXISTS ${schemaSql} CASCADE`);
      } finally {
        admin.release();
        await adminPool.end();
      }
    }
  });

  test("033 rejects a legacy cross-account strategy rule instead of leaving an unvalidated boundary", { timeout: 60_000 }, async () => {
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString, max: 1 });
    const client = await pool.connect();
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const schema = `auto_listing_ai_admin_dirty_${suffix}`;
    const schemaSql = quote(schema);
    const accountA = `account-a-${suffix}`;
    const accountB = `account-b-${suffix}`;
    try {
      await client.query(`CREATE SCHEMA ${schemaSql}`);
      await client.query(`SET search_path TO ${schemaSql}, public`);
      const migrations = (await readdir(migrationsDir))
        .filter((file) => /^\d{3}_.+\.sql$/u.test(file) && file < "033_")
        .sort();
      for (const migration of migrations) {
        await client.query(await readFile(path.join(migrationsDir, migration), "utf8"));
      }
      for (const accountId of [accountA, accountB]) {
        await client.query(
          "INSERT INTO accounts (id,username,display_name,role,status) VALUES ($1,$2,$2,'admin','active')",
          [accountId, `user-${accountId}`],
        );
      }
      const strategyId = `strategy-${suffix}`;
      await client.query(
        `INSERT INTO ai_content_strategy_versions
           (id,account_id,strategy_key,version,status,content,content_hash)
         VALUES ($1,$2,'default',1,'DRAFT','{}'::JSONB,$3)`,
        [strategyId, accountA, "d".repeat(64)],
      );
      await client.query(
        `INSERT INTO ai_content_strategy_rules
           (id,account_id,strategy_version_id,rule_kind,rule_order,product_style,rule)
         VALUES ($1,$2,$3,'PRODUCT_STYLE',1,'GENERAL','{}'::JSONB)`,
        [`dirty-rule-${suffix}`, accountB, strategyId],
      );
      const migration033 = await readFile(path.join(migrationsDir, "033_auto_listing_ai_admin_integrity.sql"), "utf8");
      await assert.rejects(client.query(migration033), (error) => error?.code === "23503"
        && /cross-account AI content strategy rules require explicit repair/iu.test(error.message));
    } finally {
      try {
        await client.query("SET search_path TO public");
        await client.query(`DROP SCHEMA IF EXISTS ${schemaSql} CASCADE`);
      } finally {
        client.release();
        await pool.end();
      }
    }
  });
}
