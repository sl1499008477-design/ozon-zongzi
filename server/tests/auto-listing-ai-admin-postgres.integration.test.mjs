import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createAutoListingAiAdminPostgres } from "../auto-listing-ai-admin-postgres.mjs";
import { createAiGatewayProfileService } from "../ai-gateway-profile-service.mjs";
import { createAutoListingAiCapabilityCredentialResolver } from "../auto-listing-ai-credential-resolver.mjs";
import { createAutoListingAiSettingsPostgres } from "../auto-listing-ai-settings-postgres.mjs";
import { createSub2ApiAdapter } from "../sub2api-ai-adapter.mjs";

const connectionString = process.env.SONLI_MIGRATION_TEST_DATABASE_URL;
const enabled = process.env.AUTO_LISTING_POSTGRES_TESTS === "1" && Boolean(connectionString);
const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../db/migrations");
const quote = (value) => `"${String(value).replaceAll('"', '""')}"`;
const requestKeyFor = (attemptId) => crypto.createHash("sha256")
  .update(`integration-capability\0${attemptId}`).digest("hex");

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
        const begun = await repository.beginCapabilityTest({ costConfirmed: true,
          accountId: accountA, actorId: accountA, profileId: created.id, configVersion: 1,
          correlationId, attemptId, requestKey: requestKeyFor(attemptId),
        });
        const completed = await repository.completeCapabilityTest({ costConfirmed: true,
          accountId: accountA, actorId: accountA, profileId: created.id, configVersion: 1,
          correlationId, attemptId, fence: begun.fence,
          leaseVersion: begun.leaseVersion, leaseToken: begun.leaseToken,
          requestKey: requestKeyFor(attemptId), capabilityResult,
        });
        assert.equal(completed.applied, true);
        return created;
      }

      const first = await createPassedProfile("alpha", `create-alpha-${suffix}`);
      assert.equal(await rawRejectsCode(() => pool.query(
        `INSERT INTO ai_gateway_capability_attempts (
           id,account_id,profile_id,config_version,correlation_id,status,
           lease_version,lease_token,lease_expires_at
         ) VALUES ($1,$2,$3,1,$4,'RUNNING',1,'caplease_unauthorized',NOW()+INTERVAL '1 minute')`,
        [`unauthorized-attempt-${suffix}`, accountA, first.id, `unauthorized-corr-${suffix}`],
      ), "23514"), true);
      const replay = await repository.createProfile({
        accountId: accountA, actorId: accountA, idempotencyKey: `create-alpha-${suffix}`,
        correlationId: `correlation-create-alpha-${suffix}`, profile: profile("alpha"),
      });
      assert.equal(replay.id, first.id);
      assert.equal(replay.duplicate, true);
      const second = await createPassedProfile("beta", `create-beta-${suffix}`);
      assert.equal(await repository.beginCapabilityTest({ costConfirmed: true,
        accountId: accountB, actorId: accountB, profileId: first.id, configVersion: 1,
        correlationId: `foreign-capability-${suffix}`, attemptId: `foreign-attempt-${suffix}`,
        requestKey: requestKeyFor(`foreign-attempt-${suffix}`),
      }), null);

      const oldAttempt = await repository.beginCapabilityTest({ costConfirmed: true,
        accountId: accountA, actorId: accountA, profileId: first.id, configVersion: 1,
        correlationId: `capability-old-${suffix}`, attemptId: `attempt-old-${suffix}`,
        requestKey: requestKeyFor(`attempt-old-${suffix}`),
      });
      const newAttempt = await repository.beginCapabilityTest({ costConfirmed: true,
        accountId: accountA, actorId: accountA, profileId: first.id, configVersion: 1,
        correlationId: `capability-new-${suffix}`, attemptId: `attempt-new-${suffix}`,
        requestKey: requestKeyFor(`attempt-new-${suffix}`),
      });
      const newestCheckedAt = new Date().toISOString();
      const newestResult = {
        outcome: "PASSED", features: ["STRUCTURED_TEXT", "IMAGE_GENERATION", "IMAGE_DECODE_PNG"], latencyMs: 7,
        models: { text: "text-model", image: "image-model" }, checkedAt: newestCheckedAt, errorCode: null,
      };
      assert.equal((await repository.completeCapabilityTest({ costConfirmed: true,
        accountId: accountA, actorId: accountA, profileId: first.id, configVersion: 1,
        correlationId: `capability-new-${suffix}`, attemptId: `attempt-new-${suffix}`,
        fence: newAttempt.fence, leaseVersion: newAttempt.leaseVersion, leaseToken: newAttempt.leaseToken,
        requestKey: requestKeyFor(`attempt-new-${suffix}`),
        capabilityResult: newestResult,
      })).applied, true);
      const stale = await repository.completeCapabilityTest({ costConfirmed: true,
        accountId: accountA, actorId: accountA, profileId: first.id, configVersion: 1,
        correlationId: `capability-old-${suffix}`, attemptId: `attempt-old-${suffix}`,
        fence: oldAttempt.fence, leaseVersion: oldAttempt.leaseVersion, leaseToken: oldAttempt.leaseToken,
        requestKey: requestKeyFor(`attempt-old-${suffix}`),
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
      const crashAttempt = await repository.beginCapabilityTest({ costConfirmed: true,
        accountId: accountA, actorId: accountA, profileId: second.id, configVersion: 1,
        correlationId: crashCorrelation, attemptId: crashAttemptId, requestKey: requestKeyFor(crashAttemptId),
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
      await assert.rejects(repository.completeCapabilityTest({ costConfirmed: true,
        accountId: accountA, actorId: accountA, profileId: second.id, configVersion: 1,
        correlationId: crashCorrelation, attemptId: crashAttemptId, fence: crashAttempt.fence,
        leaseVersion: crashAttempt.leaseVersion, leaseToken: crashAttempt.leaseToken,
        requestKey: requestKeyFor(crashAttemptId),
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
      assert.equal((await repository.completeCapabilityTest({ costConfirmed: true,
        accountId: accountA, actorId: accountA, profileId: second.id, configVersion: 1,
        correlationId: crashCorrelation, attemptId: crashAttemptId, fence: crashAttempt.fence,
        leaseVersion: crashAttempt.leaseVersion, leaseToken: crashAttempt.leaseToken,
        requestKey: requestKeyFor(crashAttemptId),
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
           lease_version,lease_token,lease_expires_at,authorization_schema_version,
           purpose,cost_confirmed,authorization_hash,request_key,actor_id,
           target_connection_status,target_connection_status_version,authorized_at
         ) VALUES ($1,$2,$3,1,$4,'RUNNING',1,'caplease_crashed',NOW()-INTERVAL '1 minute',
           'AI_GATEWAY_CAPABILITY_AUTHORIZATION_V1','PROFILE_CAPABILITY',TRUE,$5,$6,$2,'LEGACY',0,NOW())`,
        [recoveryAttemptId, accountA, second.id, recoveryCorrelation,
          "a".repeat(64), requestKeyFor(recoveryAttemptId)],
      );
      const recoveredAttempt = await repository.beginCapabilityTest({ costConfirmed: true,
        accountId: accountA, actorId: accountA, profileId: second.id, configVersion: 1,
        correlationId: recoveryCorrelation, attemptId: recoveryAttemptId,
        requestKey: requestKeyFor(recoveryAttemptId),
      });
      assert.equal(recoveredAttempt.reclaimed, true);
      assert.equal(recoveredAttempt.leaseVersion, 2);
      assert.notEqual(recoveredAttempt.leaseToken, "caplease_crashed");
      const recoveryResult = { outcome: "PASSED",
        features: ["STRUCTURED_TEXT", "IMAGE_GENERATION", "IMAGE_DECODE_PNG"], latencyMs: 6,
        models: { text: "text-model", image: "image-model" }, checkedAt: new Date().toISOString(), errorCode: null };
      await assert.rejects(repository.completeCapabilityTest({ costConfirmed: true,
        accountId: accountA, actorId: accountA, profileId: second.id, configVersion: 1,
        correlationId: recoveryCorrelation, attemptId: recoveryAttemptId, fence: recoveredAttempt.fence,
        leaseVersion: 1, leaseToken: "caplease_crashed", requestKey: requestKeyFor(recoveryAttemptId),
        capabilityResult: recoveryResult,
      }), { code: "AI_GATEWAY_PROFILE_VERSION_CONFLICT", status: 409 });
      const recoveredCompletion = await repository.completeCapabilityTest({ costConfirmed: true,
        accountId: accountA, actorId: accountA, profileId: second.id, configVersion: 1,
        correlationId: recoveryCorrelation, attemptId: recoveryAttemptId, fence: recoveredAttempt.fence,
        leaseVersion: recoveredAttempt.leaseVersion, leaseToken: recoveredAttempt.leaseToken,
        requestKey: requestKeyFor(recoveryAttemptId),
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
        AUTO_LISTING_AI_PROFILE_CAPABILITY_AUTHORIZED: 6,
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

  test("connection-backed publish and paid rollback switch profile plus connection state atomically", {
    timeout: 60_000,
  }, async () => {
    const { Pool } = await import("pg");
    const adminPool = new Pool({ connectionString, max: 1 });
    const admin = await adminPool.connect();
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const schema = `auto_listing_ai_connected_${suffix}`;
    const schemaSql = quote(schema);
    const accountId = `account-connected-${suffix}`;
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
      await admin.query(
        "INSERT INTO accounts (id,username,display_name,role,status) VALUES ($1,$1,$1,'admin','active')",
        [accountId],
      );
      pool = new Pool({ connectionString, max: 4, options: `-c search_path=${schema},public` });
      const settings = createAutoListingAiSettingsPostgres({ pool });
      const profiles = createAutoListingAiAdminPostgres({ pool });

      async function createConnected(label) {
        const connection = await settings.createPendingConnection({
          accountId, actorId: accountId, idempotencyKey: `connection-${label}-${suffix}`,
          correlationId: `connection-corr-${label}-${suffix}`, displayName: `Connection ${label}`,
          baseUrl: "https://gateway.example.test/v1",
          encryptedSecret: { algorithm: "aes-256-gcm", ciphertext: "Y2lwaGVy", iv: "aXY=",
            authTag: "dGFn", keyVersion: "local-v1", fingerprint: `fp-${label}-${suffix}` },
        });
        const task = await settings.enqueueModelSync({
          accountId, actorId: accountId, connectionId: connection.id, connectionVersion: 1,
          expectedConnectionStatusVersion: 1, syncPurpose: "CATALOG_SYNC", maxAttempts: 5,
          idempotencyKey: `catalog-${label}-${suffix}`, correlationId: `catalog-corr-${label}-${suffix}`,
        });
        const workerId = `worker-${label}-${suffix}`;
        const lease = await settings.claimModelSync({ accountId, workerId, leaseMs: 30_000,
          syncPurpose: "CATALOG_SYNC" });
        assert.equal(lease.taskId, task.id);
        const checkedAt = new Date().toISOString();
        const completed = await settings.completeModelSync({
          accountId, workerId, taskId: task.id, leaseVersion: lease.leaseVersion,
          leaseToken: lease.leaseToken, correlationId: `complete-${label}-${suffix}`,
          catalog: { models: [{ id: "image-model" }, { id: "text-model" }] },
          capabilityResult: { outcome: "NOT_TESTED", checkedAt, text: false, image: false },
        });
        const profileRow = await settings.createProfileFromSelection({
          accountId, actorId: accountId, connectionId: connection.id, connectionVersion: 1,
          catalogId: completed.catalog.id, displayName: `Profile ${label}`,
          textModel: "text-model", imageModel: "image-model",
          textProtocol: "SUB2API_RESPONSES", imageProtocol: "SUB2API_OPENAI_IMAGES",
          idempotencyKey: `profile-${label}-${suffix}`, correlationId: `profile-corr-${label}-${suffix}`,
        });
        return { connection, profile: profileRow };
      }

      async function passCapability(target, purpose, label) {
        const correlationId = `paid-${purpose}-${label}-${suffix}`;
        const attemptId = `attempt-${purpose}-${label}-${suffix}`;
        const begun = await profiles.beginCapabilityTest({ costConfirmed: true,
          accountId, actorId: accountId, profileId: target.profile.id, configVersion: 1,
          correlationId, attemptId, purpose, requestKey: requestKeyFor(attemptId),
        });
        const retiredAt = purpose === "ROLLBACK_CAPABILITY"
          ? (await pool.query(
            `SELECT retired_at FROM ai_gateway_connection_versions
              WHERE account_id=$1 AND id=$2 AND version=1`,
            [accountId, target.connection.id],
          )).rows[0]?.retired_at
          : null;
        const checkedAt = new Date(Math.max(Date.now(), retiredAt ? retiredAt.getTime() + 1 : 0)).toISOString();
        const capabilityResult = {
          outcome: "PASSED", features: ["STRUCTURED_TEXT", "IMAGE_GENERATION", "IMAGE_DECODE_PNG"],
          latencyMs: 5, models: { text: "text-model", image: "image-model" },
          checkedAt, errorCode: null,
        };
        await profiles.completeCapabilityTest({ costConfirmed: true,
          accountId, actorId: accountId, profileId: target.profile.id, configVersion: 1,
          correlationId, attemptId, fence: begun.fence, leaseVersion: begun.leaseVersion,
          leaseToken: begun.leaseToken, purpose, requestKey: requestKeyFor(attemptId), capabilityResult,
        });
      }

      const first = await createConnected("first");
      await passCapability(first, "PROFILE_CAPABILITY", "first");
      await profiles.publishProfile({
        accountId, actorId: accountId, profileId: first.profile.id, configVersion: 1,
        idempotencyKey: `publish-first-${suffix}`, correlationId: `publish-first-corr-${suffix}`,
      });
      const second = await createConnected("second");
      await passCapability(second, "PROFILE_CAPABILITY", "second");
      await profiles.publishProfile({
        accountId, actorId: accountId, profileId: second.profile.id, configVersion: 1,
        idempotencyKey: `publish-second-${suffix}`, correlationId: `publish-second-corr-${suffix}`,
      });
      const rollbackInput = {
        accountId, actorId: accountId, profileId: first.profile.id, configVersion: 1,
        idempotencyKey: `rollback-first-${suffix}`, correlationId: `rollback-first-corr-${suffix}`,
      };
      assert.deepEqual(await profiles.prepareProfileRollback(rollbackInput), {
        completed: false, duplicate: false, profile: null,
      });
      await assert.rejects(profiles.prepareProfileRollback({ ...rollbackInput,
        profileId: second.profile.id, correlationId: `rollback-conflict-${suffix}` }), {
        code: "AUTO_LISTING_AI_ADMIN_IDEMPOTENCY_CONFLICT", status: 409,
      });
      await passCapability(first, "ROLLBACK_CAPABILITY", "first");
      const rolledBack = await profiles.rollbackProfile(rollbackInput);
      assert.equal(rolledBack.enabled, true);
      assert.equal((await profiles.rollbackProfile(rollbackInput)).duplicate, true);
      const preparedReplay = await profiles.prepareProfileRollback({ ...rollbackInput,
        correlationId: `rollback-response-loss-${suffix}` });
      assert.equal(preparedReplay.completed, true);
      assert.equal(preparedReplay.profile.enabled, true);
      const states = await pool.query(
        `SELECT id,status FROM ai_gateway_connection_versions
          WHERE account_id=$1 ORDER BY id`,
        [accountId],
      );
      assert.deepEqual(Object.fromEntries(states.rows.map((row) => [row.id, row.status])), {
        [first.connection.id]: "ACTIVE",
        [second.connection.id]: "RETIRED",
      });
      const purposeAudit = await pool.query(
        `SELECT COUNT(*)::INTEGER AS count FROM audit_events
          WHERE account_id=$1 AND action='AUTO_LISTING_AI_PROFILE_CAPABILITY_TEST'
            AND metadata->>'purpose'='ROLLBACK_CAPABILITY'`,
        [accountId],
      );
      assert.equal(purposeAudit.rows[0].count, 1);

      const beforeFirstProbe = await createConnected("before-first-probe");
      await passCapability(beforeFirstProbe, "PROFILE_CAPABILITY", "before-first-probe-seed");
      const beforeFirstCorrelation = `paid-before-first-probe-${suffix}`;
      const beforeFirstAttemptId = `attempt-before-first-probe-${suffix}`;
      const beforeFirstAttempt = await profiles.beginCapabilityTest({
        costConfirmed: true, accountId, actorId: accountId,
        profileId: beforeFirstProbe.profile.id, configVersion: 1,
        correlationId: beforeFirstCorrelation, attemptId: beforeFirstAttemptId,
        purpose: "PROFILE_CAPABILITY", requestKey: requestKeyFor(beforeFirstAttemptId),
      });
      const preparedCredential = await profiles.loadCapabilityExecutionForSecretResolution({
        ...beforeFirstAttempt.capabilityExecution, probe: "REACHABILITY",
      });
      assert.match(preparedCredential.providerRequestKey, /^[a-f0-9]{64}$/u);
      await assert.rejects(profiles.publishProfile({
        accountId, actorId: accountId, profileId: beforeFirstProbe.profile.id, configVersion: 1,
        idempotencyKey: `publish-before-first-probe-${suffix}`,
        correlationId: `publish-before-first-probe-corr-${suffix}`,
      }), { code: "AUTO_LISTING_AI_ADMIN_CAPABILITY_SUBCALL_CONFLICT", status: 409 });
      await profiles.completeCapabilitySubcall({
        ...beforeFirstAttempt.capabilityExecution, probe: "REACHABILITY", outcome: "FAILED",
      });
      await profiles.publishProfile({
        accountId, actorId: accountId, profileId: beforeFirstProbe.profile.id, configVersion: 1,
        idempotencyKey: `publish-before-first-probe-${suffix}`,
        correlationId: `publish-before-first-probe-corr-${suffix}`,
      });
      await assert.rejects(profiles.loadCapabilityExecutionForSecretResolution({
        ...beforeFirstAttempt.capabilityExecution, probe: "REACHABILITY",
      }), { code: "AUTO_LISTING_AI_ADMIN_CAPABILITY_EXECUTION_STALE", status: 409 });
      const beforeFirstStored = await pool.query(
        "SELECT status FROM ai_gateway_capability_attempts WHERE account_id=$1 AND id=$2",
        [accountId, beforeFirstAttemptId],
      );
      assert.equal(beforeFirstStored.rows[0].status, "STALE");

      const afterFirstProbe = await createConnected("after-first-probe");
      await passCapability(afterFirstProbe, "PROFILE_CAPABILITY", "after-first-probe-seed");
      const transitionCandidate = await settings.createPendingConnection({
        accountId, actorId: accountId, idempotencyKey: `connection-transition-${suffix}`,
        correlationId: `connection-transition-corr-${suffix}`, displayName: "Transition candidate",
        baseUrl: "https://gateway.example.test/v1",
        encryptedSecret: { algorithm: "aes-256-gcm", ciphertext: "Y2lwaGVy", iv: "aXY=",
          authTag: "dGFn", keyVersion: "local-v1", fingerprint: `fp-transition-${suffix}` },
      });
      let paidFetches = 0;
      let releaseFirstDns;
      let signalFirstDns;
      const firstDnsEntered = new Promise((resolve) => { signalFirstDns = resolve; });
      const firstDnsGate = new Promise((resolve) => { releaseFirstDns = resolve; });
      let gateDns = true;
      const resolver = createAutoListingAiCapabilityCredentialResolver({
        repository: profiles,
        cipher: { async decrypt() { return "paid-test-secret"; } },
        readSecret() { return undefined; },
      });
      const adapter = createSub2ApiAdapter({
        readSecret() { throw new Error("generic secret path must not authorize paid work"); },
        resolveCapabilityCredential: (execution) => resolver.resolveCredential(execution),
        markCapabilitySubcallSending: (execution) => resolver.markSending(execution),
        completeCapabilitySubcall: (execution, outcome) => resolver.completeSubcall(execution, outcome),
        resolveHostname: async () => {
          if (gateDns) {
            gateDns = false;
            signalFirstDns();
            await firstDnsGate;
          }
          return [{ address: "203.0.113.10", family: 4 }];
        },
        allowedSecretEnvNames: ["SUB2API_ENCRYPTED_KEY"],
        allowedGatewayBaseUrls: ["https://gateway.example.test/v1"],
        fetchImpl: async () => {
          paidFetches += 1;
          if (paidFetches === 1) {
            await assert.rejects(profiles.publishProfile({
              accountId, actorId: accountId, profileId: afterFirstProbe.profile.id, configVersion: 1,
              idempotencyKey: `publish-after-first-probe-${suffix}`,
              correlationId: `publish-after-first-probe-corr-${suffix}`,
            }), { code: "AUTO_LISTING_AI_ADMIN_CAPABILITY_SUBCALL_CONFLICT", status: 409 });
          }
          if (paidFetches === 2) return new Response(JSON.stringify({
            id: "text-reservation", output: [{ type: "message",
              content: [{ type: "output_text", text: "{\"ok\":true}" }] }],
          }), { status: 200, headers: { "content-type": "application/json" } });
          if (paidFetches === 3) return new Response(JSON.stringify({
            id: "image-reservation", data: [{ b64_json: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=" }],
          }), { status: 200, headers: { "content-type": "application/json" } });
          return new Response(JSON.stringify({ object: "list", data: [] }), {
            status: 200, headers: { "content-type": "application/json" },
          });
        },
      });
      const fencedService = createAiGatewayProfileService({ repository: profiles, gateway: adapter });
      const fencedCorrelation = `fenced-after-first-probe-${suffix}`;
      const fencedPromise = fencedService.testGatewayCapabilities({
        actor: { id: accountId, role: "admin" }, profileId: afterFirstProbe.profile.id,
        configVersion: 1, correlationId: fencedCorrelation, costConfirmed: true,
      });
      await firstDnsEntered;
      await assert.rejects(profiles.publishProfile({
        accountId, actorId: accountId, profileId: afterFirstProbe.profile.id, configVersion: 1,
        idempotencyKey: `publish-during-dns-${suffix}`,
        correlationId: `publish-during-dns-corr-${suffix}`,
      }), { code: "AUTO_LISTING_AI_ADMIN_CAPABILITY_SUBCALL_CONFLICT", status: 409 });
      await assert.rejects(settings.markConnectionValidated({
        accountId, actorId: accountId, connectionId: transitionCandidate.id, connectionVersion: 1,
        expectedStatusVersion: 1, idempotencyKey: `validate-during-dns-${suffix}`,
        correlationId: `validate-during-dns-corr-${suffix}`, rollbackCapabilityEvidence: null,
        validationResult: { outcome: "PASSED", checkedAt: new Date().toISOString(), endpoint: "models" },
      }), { code: "AUTO_LISTING_AI_SETTINGS_CAPABILITY_SUBCALL_CONFLICT", status: 409 });
      releaseFirstDns();
      const fencedResult = await fencedPromise;
      assert.equal(fencedResult.outcome, "PASSED");
      assert.equal(paidFetches, 3, "all paid stages use terminal reservations before moving on");
      const fencedStored = await pool.query(
        `SELECT status FROM ai_gateway_capability_attempts
          WHERE account_id=$1 AND profile_id=$2 AND correlation_id=$3`,
        [accountId, afterFirstProbe.profile.id, fencedCorrelation],
      );
      assert.equal(fencedStored.rows[0].status, "PASSED");
      await profiles.publishProfile({
        accountId, actorId: accountId, profileId: afterFirstProbe.profile.id, configVersion: 1,
        idempotencyKey: `publish-after-first-probe-${suffix}`,
        correlationId: `publish-after-first-probe-corr-${suffix}`,
      });

      const crashReplay = await createConnected("provider-response-loss");
      let providerCalls = 0;
      const chargedRequestKeys = new Set();
      const replayGateway = createSub2ApiAdapter({
        readSecret() { throw new Error("generic resolver must not authorize paid replay"); },
        resolveCapabilityCredential: (execution) => resolver.resolveCredential(execution),
        markCapabilitySubcallSending: (execution) => resolver.markSending(execution),
        completeCapabilitySubcall: (execution, outcome) => resolver.completeSubcall(execution, outcome),
        resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }],
        allowedSecretEnvNames: ["SUB2API_ENCRYPTED_KEY"],
        allowedGatewayBaseUrls: ["https://gateway.example.test/v1"],
        fetchImpl: async (url, init) => {
          providerCalls += 1;
          chargedRequestKeys.add(init.headers["Idempotency-Key"]);
          if (String(url).endsWith("/models")) return new Response(JSON.stringify({ object: "list", data: [] }), {
            status: 200, headers: { "content-type": "application/json" },
          });
          if (String(url).endsWith("/responses")) return new Response(JSON.stringify({
            id: "text-replay", output: [{ type: "message",
              content: [{ type: "output_text", text: "{\"ok\":true}" }] }],
          }), { status: 200, headers: { "content-type": "application/json" } });
          return new Response(JSON.stringify({ id: "image-replay", data: [{
            b64_json: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
          }] }), { status: 200, headers: { "content-type": "application/json" } });
        },
      });
      const replayService = createAiGatewayProfileService({ repository: profiles, gateway: replayGateway });
      const replayCorrelation = `provider-response-loss-${suffix}`;
      await pool.query(`CREATE OR REPLACE FUNCTION reject_capability_completion_${suffix}()
        RETURNS TRIGGER LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.action='AUTO_LISTING_AI_PROFILE_CAPABILITY_TEST'
            AND NEW.correlation_id='${replayCorrelation}' THEN
            RAISE EXCEPTION 'forced completion persistence failure';
          END IF;
          RETURN NEW;
        END;
        $$`);
      await pool.query(`CREATE TRIGGER reject_capability_completion_${suffix}_trigger
        BEFORE INSERT ON audit_events FOR EACH ROW
        EXECUTE FUNCTION reject_capability_completion_${suffix}()`);
      const replayInput = { actor: { id: accountId, role: "admin" },
        profileId: crashReplay.profile.id, configVersion: 1,
        correlationId: replayCorrelation, costConfirmed: true };
      await assert.rejects(replayService.testGatewayCapabilities(replayInput), {
        code: "AUTO_LISTING_AI_ADMIN_DATABASE_FAILED",
      });
      assert.deepEqual({ providerCalls, charged: chargedRequestKeys.size }, { providerCalls: 3, charged: 3 });
      await assert.rejects(replayService.testGatewayCapabilities(replayInput), {
        code: "AI_GATEWAY_CAPABILITY_IN_PROGRESS", status: 409,
      });
      assert.deepEqual({ providerCalls, charged: chargedRequestKeys.size }, { providerCalls: 3, charged: 3 });
      const replayAttempt = await pool.query(
        `SELECT id,request_key FROM ai_gateway_capability_attempts
          WHERE account_id=$1 AND profile_id=$2 AND correlation_id=$3`,
        [accountId, crashReplay.profile.id, replayCorrelation],
      );
      await assert.rejects(profiles.beginCapabilityTest({
        costConfirmed: true, accountId, actorId: accountId, profileId: crashReplay.profile.id,
        configVersion: 1, correlationId: replayCorrelation, attemptId: replayAttempt.rows[0].id,
        purpose: "PROFILE_CAPABILITY", requestKey: "f".repeat(64),
      }), { code: "AUTO_LISTING_AI_ADMIN_IDEMPOTENCY_CONFLICT", status: 409 });
      assert.equal(providerCalls, 3, "a conflicting persisted intent must not reach the provider");
      await pool.query(`DROP TRIGGER reject_capability_completion_${suffix}_trigger ON audit_events`);
      await pool.query(`DROP FUNCTION reject_capability_completion_${suffix}()`);
      const faultClient = await pool.connect();
      try {
        await faultClient.query("SET session_replication_role='replica'");
        await faultClient.query(
          "UPDATE ai_gateway_capability_attempts SET lease_expires_at=NOW()-INTERVAL '1 second' WHERE account_id=$1 AND id=$2",
          [accountId, replayAttempt.rows[0].id],
        );
      } finally {
        await faultClient.query("SET session_replication_role='origin'").catch(() => {});
        faultClient.release();
      }
      const recovered = await replayService.testGatewayCapabilities(replayInput);
      assert.equal(recovered.outcome, "PASSED");
      assert.deepEqual({ providerCalls, charged: chargedRequestKeys.size }, { providerCalls: 6, charged: 3 });
      assert.deepEqual(await replayService.testGatewayCapabilities(replayInput), recovered);
      assert.deepEqual({ providerCalls, charged: chargedRequestKeys.size }, { providerCalls: 6, charged: 3 });
      await assert.rejects(profiles.beginCapabilityTest({
        costConfirmed: true, accountId, actorId: accountId, profileId: crashReplay.profile.id,
        configVersion: 1, correlationId: `changed-payload-${suffix}`,
        attemptId: `changed-payload-attempt-${suffix}`, purpose: "PROFILE_CAPABILITY",
        requestKey: replayAttempt.rows[0].request_key,
      }), { code: "AUTO_LISTING_AI_ADMIN_IDEMPOTENCY_CONFLICT", status: 409 });
      assert.deepEqual({ providerCalls, charged: chargedRequestKeys.size }, { providerCalls: 6, charged: 3 });
      const replayReservations = await pool.query(
        `SELECT stage,provider_request_key,reservation_version,status
           FROM ai_gateway_capability_subcall_reservations
          WHERE account_id=$1 AND attempt_id=$2 ORDER BY stage`,
        [accountId, replayAttempt.rows[0].id],
      );
      assert.equal(replayReservations.rows.length, 3);
      assert.equal(replayReservations.rows.every((row) => chargedRequestKeys.has(row.provider_request_key)
        && Number(row.reservation_version) === 2 && row.status === "SUCCEEDED"), true);

      const immutableAuthorization = await pool.query(
        `SELECT event_id FROM audit_events
          WHERE account_id=$1 AND action='AUTO_LISTING_AI_PROFILE_CAPABILITY_AUTHORIZED'
          ORDER BY created_at DESC LIMIT 1`,
        [accountId],
      );
      assert.equal(await rawRejectsCode(() => pool.query(
        "UPDATE audit_events SET status='FAILED' WHERE event_id=$1",
        [immutableAuthorization.rows[0].event_id],
      ), "23514"), true);
      assert.equal(await rawRejectsCode(() => pool.query(
        "UPDATE ai_gateway_capability_attempts SET request_key=$3 WHERE account_id=$1 AND id=$2",
        [accountId, replayAttempt.rows[0].id, "e".repeat(64)],
      ), "23514"), true);

      const privacyAccountId = `account-paid-privacy-${suffix}`;
      const privacyProfileId = `profile-paid-privacy-${suffix}`;
      const privacyAttemptId = `attempt-paid-privacy-${suffix}`;
      await pool.query(
        "INSERT INTO accounts (id,username,display_name,role,status) VALUES ($1,$1,$1,'admin','active')",
        [privacyAccountId],
      );
      await pool.query(
        `INSERT INTO ai_gateway_profiles (
           id,account_id,display_name,base_url,api_key_env_name,text_protocol,image_protocol,
           text_model,image_model,config_version,enabled,created_by
         ) VALUES ($1,$2,'Privacy profile','https://gateway.example.test/v1','SUB2API_LEGACY_KEY',
           'SUB2API_RESPONSES','SUB2API_OPENAI_IMAGES','text-model','image-model',1,FALSE,$2)`,
        [privacyProfileId, privacyAccountId],
      );
      const privacyAttempt = await profiles.beginCapabilityTest({
        costConfirmed: true, accountId: privacyAccountId, actorId: privacyAccountId,
        profileId: privacyProfileId, configVersion: 1,
        correlationId: `privacy-paid-${suffix}`, attemptId: privacyAttemptId,
        purpose: "PROFILE_CAPABILITY", requestKey: requestKeyFor(privacyAttemptId),
      });
      await profiles.loadCapabilityExecutionForSecretResolution({
        ...privacyAttempt.capabilityExecution, probe: "REACHABILITY",
      });
      assert.equal((await pool.query(
        "SELECT COUNT(*)::INTEGER AS count FROM ai_gateway_capability_subcall_reservations WHERE account_id=$1",
        [privacyAccountId],
      )).rows[0].count, 1);
      assert.equal(await rawRejectsCode(() => pool.query(
        "DELETE FROM ai_gateway_capability_subcall_reservations WHERE account_id=$1",
        [privacyAccountId],
      ), "23514"), true);
      assert.equal(await rawRejectsCode(() => pool.query(
        "DELETE FROM ai_gateway_capability_attempts WHERE account_id=$1",
        [privacyAccountId],
      ), "23514"), true);
      await pool.query("DELETE FROM accounts WHERE id=$1", [privacyAccountId]);
      assert.equal((await pool.query(
        "SELECT COUNT(*)::INTEGER AS count FROM ai_gateway_capability_subcall_reservations WHERE account_id=$1",
        [privacyAccountId],
      )).rows[0].count, 0);
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

  test("054 quarantines legacy unknown RUNNING attempts and runtime blocks new paid correlation", {
    timeout: 60_000,
  }, async () => {
    const { Pool } = await import("pg");
    const adminPool = new Pool({ connectionString, max: 1 });
    const admin = await adminPool.connect();
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const schema = `auto_listing_ai_legacy_attempt_${suffix}`;
    const schemaSql = quote(schema);
    const accountId = `account-legacy-attempt-${suffix}`;
    const profileId = `profile-legacy-attempt-${suffix}`;
    const attemptId = `attempt-legacy-unknown-${suffix}`;
    let pool;
    try {
      await admin.query(`CREATE SCHEMA ${schemaSql}`);
      await admin.query(`SET search_path TO ${schemaSql}, public`);
      const migrations = (await readdir(migrationsDir))
        .filter((file) => /^\d{3}_.+\.sql$/u.test(file) && file < "053_")
        .sort();
      for (const migration of migrations) {
        await admin.query(await readFile(path.join(migrationsDir, migration), "utf8"));
      }
      await admin.query(
        "INSERT INTO accounts (id,username,display_name,role,status) VALUES ($1,$1,$1,'admin','active')",
        [accountId],
      );
      await admin.query(
        `INSERT INTO ai_gateway_profiles (
           id,account_id,display_name,base_url,api_key_env_name,text_protocol,image_protocol,
           text_model,image_model,config_version,enabled,created_by
         ) VALUES ($1,$2,'Legacy profile','https://gateway.example.test/v1','SUB2API_LEGACY_KEY',
           'SUB2API_RESPONSES','SUB2API_OPENAI_IMAGES','text-model','image-model',1,FALSE,$2)`,
        [profileId, accountId],
      );
      await admin.query(
        `INSERT INTO ai_gateway_capability_attempts (
           id,account_id,profile_id,config_version,correlation_id,lease_token,lease_expires_at,status
         ) VALUES ($1,$2,$3,1,$4,$5,NOW()+INTERVAL '1 hour','RUNNING')`,
        [attemptId, accountId, profileId, `corr-legacy-unknown-${suffix}`, `caplease_legacy_${suffix}`],
      );
      for (const migration of [
        "053_auto_listing_ai_model_configuration.sql",
        "054_auto_listing_ai_capability_authorization.sql",
      ]) await admin.query(await readFile(path.join(migrationsDir, migration), "utf8"));
      await admin.query(`CREATE OR REPLACE FUNCTION auto_listing_reject_terminal_gateway_capability_attempt_mutation()
        RETURNS TRIGGER LANGUAGE plpgsql AS $$
        BEGIN
          IF TG_OP='DELETE' OR OLD.status IN ('PASSED','FAILED','STALE') THEN
            RAISE EXCEPTION 'legacy 054 capability attempts are append-only' USING ERRCODE='23514';
          END IF;
          RETURN NEW;
        END;
        $$`);
      await admin.query(await readFile(path.join(migrationsDir,
        "055_auto_listing_ai_capability_subcall_reservations.sql"), "utf8"));

      const quarantined = await admin.query(
        `SELECT status,authorization_schema_version,response->>'errorCode' AS error_code
           FROM ai_gateway_capability_attempts WHERE account_id=$1 AND id=$2`,
        [accountId, attemptId],
      );
      assert.deepEqual(quarantined.rows[0], {
        status: "STALE", authorization_schema_version: null,
        error_code: "AUTO_LISTING_AI_LEGACY_CAPABILITY_QUARANTINED",
      });
      const upgradeAudit = await admin.query(
        `SELECT actor_type,actor_id,metadata FROM audit_events
          WHERE account_id=$1 AND action='AUTO_LISTING_AI_PROFILE_CAPABILITY_UPGRADE_QUARANTINED'`,
        [accountId],
      );
      assert.equal(upgradeAudit.rows.length, 1);
      assert.equal(upgradeAudit.rows[0].actor_type, "system");
      assert.equal(upgradeAudit.rows[0].metadata.schemaVersion,
        "AI_GATEWAY_LEGACY_CAPABILITY_QUARANTINE_V1");
      assert.equal(Object.hasOwn(upgradeAudit.rows[0].metadata, "costConfirmed"), false);

      pool = new Pool({ connectionString, max: 2, options: `-c search_path=${schema},public` });
      const repository = createAutoListingAiAdminPostgres({ pool });
      await assert.rejects(repository.beginCapabilityTest({
        costConfirmed: true, accountId, actorId: accountId, profileId, configVersion: 1,
        correlationId: `corr-new-paid-${suffix}`, attemptId: `attempt-new-paid-${suffix}`,
        purpose: "PROFILE_CAPABILITY", requestKey: requestKeyFor(`attempt-new-paid-${suffix}`),
      }), { code: "AUTO_LISTING_AI_ADMIN_LEGACY_CAPABILITY_QUARANTINED", status: 409 });
      const attempts = await pool.query(
        "SELECT COUNT(*)::INTEGER AS count FROM ai_gateway_capability_attempts WHERE account_id=$1 AND profile_id=$2",
        [accountId, profileId],
      );
      assert.equal(attempts.rows[0].count, 1);

      const runtimeAttemptId = `attempt-runtime-legacy-${suffix}`;
      await pool.query(
        "ALTER TABLE ai_gateway_capability_attempts DISABLE TRIGGER ai_gateway_capability_attempts_authorized_insert",
      );
      try {
        await pool.query(
          `INSERT INTO ai_gateway_capability_attempts (
             id,account_id,profile_id,config_version,correlation_id,lease_token,lease_expires_at,status
           ) VALUES ($1,$2,$3,1,$4,$5,NOW()+INTERVAL '1 hour','RUNNING')`,
          [runtimeAttemptId, accountId, profileId,
            `corr-runtime-legacy-${suffix}`, `caplease_runtime_legacy_${suffix}`],
        );
      } finally {
        await pool.query(
          "ALTER TABLE ai_gateway_capability_attempts ENABLE TRIGGER ai_gateway_capability_attempts_authorized_insert",
        );
      }
      await assert.rejects(repository.beginCapabilityTest({
        costConfirmed: true, accountId, actorId: accountId, profileId, configVersion: 1,
        correlationId: `corr-runtime-new-${suffix}`, attemptId: `attempt-runtime-new-${suffix}`,
        purpose: "PROFILE_CAPABILITY", requestKey: requestKeyFor(`attempt-runtime-new-${suffix}`),
      }), { code: "AUTO_LISTING_AI_ADMIN_LEGACY_CAPABILITY_QUARANTINED", status: 409 });
      const runtimeQuarantined = await pool.query(
        `SELECT status,response->>'errorCode' AS error_code
           FROM ai_gateway_capability_attempts WHERE account_id=$1 AND id=$2`,
        [accountId, runtimeAttemptId],
      );
      assert.deepEqual(runtimeQuarantined.rows[0], {
        status: "STALE", error_code: "AUTO_LISTING_AI_LEGACY_CAPABILITY_QUARANTINED",
      });
      const runtimeAudit = await pool.query(
        `SELECT actor_type,actor_id FROM audit_events
          WHERE account_id=$1 AND action='AUTO_LISTING_AI_PROFILE_CAPABILITY_UPGRADE_QUARANTINED'
            AND metadata->>'attemptId'=$2`,
        [accountId, runtimeAttemptId],
      );
      assert.deepEqual(runtimeAudit.rows[0], { actor_type: "system", actor_id: "runtime-quarantine" });

      const upgradedDeleteAccountId = `account-upgraded-delete-${suffix}`;
      const upgradedDeleteProfileId = `profile-upgraded-delete-${suffix}`;
      const upgradedDeleteAttemptId = `attempt-upgraded-delete-${suffix}`;
      await pool.query(
        "INSERT INTO accounts (id,username,display_name,role,status) VALUES ($1,$1,$1,'admin','active')",
        [upgradedDeleteAccountId],
      );
      await pool.query(
        `INSERT INTO ai_gateway_profiles (
           id,account_id,display_name,base_url,api_key_env_name,text_protocol,image_protocol,
           text_model,image_model,config_version,enabled,created_by
         ) VALUES ($1,$2,'Upgraded delete','https://gateway.example.test/v1','SUB2API_LEGACY_KEY',
           'SUB2API_RESPONSES','SUB2API_OPENAI_IMAGES','text-model','image-model',1,FALSE,$2)`,
        [upgradedDeleteProfileId, upgradedDeleteAccountId],
      );
      const upgradedDeleteAttempt = await repository.beginCapabilityTest({
        costConfirmed: true, accountId: upgradedDeleteAccountId, actorId: upgradedDeleteAccountId,
        profileId: upgradedDeleteProfileId, configVersion: 1,
        correlationId: `corr-upgraded-delete-${suffix}`, attemptId: upgradedDeleteAttemptId,
        purpose: "PROFILE_CAPABILITY", requestKey: requestKeyFor(upgradedDeleteAttemptId),
      });
      await repository.loadCapabilityExecutionForSecretResolution({
        ...upgradedDeleteAttempt.capabilityExecution, probe: "REACHABILITY",
      });
      await pool.query("DELETE FROM accounts WHERE id=$1", [upgradedDeleteAccountId]);
      assert.equal((await pool.query(
        "SELECT COUNT(*)::INTEGER AS count FROM ai_gateway_capability_subcall_reservations WHERE account_id=$1",
        [upgradedDeleteAccountId],
      )).rows[0].count, 0);
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
