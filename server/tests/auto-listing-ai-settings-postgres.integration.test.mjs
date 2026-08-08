import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createAutoListingAiSettingsPostgres } from "../auto-listing-ai-settings-postgres.mjs";

const enabled = process.env.AUTO_LISTING_POSTGRES_TESTS === "1"
  && Boolean(process.env.SONLI_MIGRATION_TEST_DATABASE_URL);
const connectionString = process.env.SONLI_MIGRATION_TEST_DATABASE_URL;
const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../db/migrations");
const quote = (value) => `"${String(value).replaceAll('"', '""')}"`;

async function rejectsCode(operation, code) {
  return assert.rejects(operation, (error) => error?.code === code);
}

test("053 and the settings repository preserve legacy profiles and enforce tenant, lease, and immutable evidence contracts", {
  skip: !enabled,
  timeout: 90_000,
}, async () => {
  const { Pool } = await import("pg");
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const schema = `auto_listing_ai_settings_${suffix}`;
  const schemaSql = quote(schema);
  const adminPool = new Pool({ connectionString, max: 2 });
  const admin = await adminPool.connect();
  let pool;
  const accountA = `account-a-${suffix}`;
  const accountB = `account-b-${suffix}`;
  const legacyProfileId = `legacy-profile-${suffix}`;

  try {
    await admin.query(`CREATE SCHEMA ${schemaSql}`);
    await admin.query(`SET search_path TO ${schemaSql}, public`);
    const migrations = (await readdir(migrationsDir))
      .filter((file) => /^\d{3}_.+\.sql$/u.test(file))
      .sort();
    for (const migration of migrations.filter((file) => file < "053_")) {
      await admin.query(await readFile(path.join(migrationsDir, migration), "utf8"));
    }
    for (const accountId of [accountA, accountB]) {
      await admin.query(
        "INSERT INTO accounts (id,username,display_name,role,status) VALUES ($1,$2,$2,'admin','active')",
        [accountId, `user-${accountId}`],
      );
    }
    await admin.query(
      `INSERT INTO ai_gateway_profiles (
         id,account_id,display_name,base_url,api_key_env_name,text_protocol,image_protocol,
         text_model,image_model,config_version,enabled,created_by
       ) VALUES ($1,$2,'Legacy','https://legacy.example/v1','SUB2API_LEGACY_KEY',
         'SUB2API_RESPONSES','SUB2API_OPENAI_IMAGES','legacy-text','legacy-image',1,FALSE,$2)`,
      [legacyProfileId, accountA],
    );
    await admin.query(await readFile(path.join(migrationsDir, "053_auto_listing_ai_model_configuration.sql"), "utf8"));

    const legacy = (await admin.query(
      "SELECT api_key_env_name,connection_id,connection_version FROM ai_gateway_profiles WHERE account_id=$1 AND id=$2",
      [accountA, legacyProfileId],
    )).rows[0];
    assert.deepEqual(legacy, {
      api_key_env_name: "SUB2API_LEGACY_KEY",
      connection_id: null,
      connection_version: null,
    });

    pool = new Pool({ connectionString, max: 6, options: `-c search_path=${schema},public` });
    const repository = createAutoListingAiSettingsPostgres({ pool });
    const encryptedSecret = {
      algorithm: "aes-256-gcm",
      ciphertext: "Y2lwaGVy",
      iv: "aXY=",
      authTag: "dGFn",
      keyVersion: "local-v1",
      fingerprint: "fp-a",
    };
    const createInput = {
      accountId: accountA,
      actorId: accountA,
      idempotencyKey: `connection-a-${suffix}`,
      correlationId: `corr-connection-a-${suffix}`,
      displayName: "本地 sub2API A",
      baseUrl: "http://127.0.0.1:8080/v1",
      encryptedSecret,
    };
    const first = await repository.createPendingConnection(createInput);
    assert.equal(first.accountId, accountA);
    assert.equal(Object.hasOwn(first, "ciphertext"), false);
    assert.equal((await repository.createPendingConnection(createInput)).duplicate, true);
    await assert.rejects(repository.createPendingConnection({ ...createInput, displayName: "changed" }), {
      code: "AUTO_LISTING_AI_SETTINGS_IDEMPOTENCY_CONFLICT",
      status: 409,
    });
    assert.equal(await repository.loadConnectionForSecretResolution({
      accountId: accountB,
      connectionId: first.id,
      connectionVersion: first.version,
    }), null);

    const validationResult = {
      outcome: "PASSED",
      checkedAt: new Date().toISOString(),
      endpoint: "models",
    };
    const activatedFirst = await repository.markConnectionValidated({
      accountId: accountA,
      actorId: accountA,
      connectionId: first.id,
      connectionVersion: first.version,
      expectedStatusVersion: 1,
      idempotencyKey: `activate-a-${suffix}`,
      correlationId: `corr-activate-a-${suffix}`,
      validationResult,
    });
    assert.equal(activatedFirst.status, "ACTIVE");
    assert.deepEqual((await repository.loadConnectionForSecretResolution({
      accountId: accountA,
      connectionId: first.id,
      connectionVersion: first.version,
    })).encryptedSecret, encryptedSecret);

    async function createPending(label) {
      return repository.createPendingConnection({
        ...createInput,
        idempotencyKey: `connection-${label}-${suffix}`,
        correlationId: `corr-connection-${label}-${suffix}`,
        displayName: `本地 sub2API ${label}`,
        encryptedSecret: { ...encryptedSecret, fingerprint: `fp-${label}` },
      });
    }
    const [second, third] = await Promise.all([createPending("b"), createPending("c")]);
    await Promise.all([second, third].map((candidate, index) => repository.markConnectionValidated({
      accountId: accountA,
      actorId: accountA,
      connectionId: candidate.id,
      connectionVersion: candidate.version,
      expectedStatusVersion: 1,
      idempotencyKey: `activate-concurrent-${index}-${suffix}`,
      correlationId: `corr-activate-concurrent-${index}-${suffix}`,
      validationResult: { ...validationResult, checkedAt: new Date(Date.now() + index).toISOString() },
    })));
    const activeRows = await pool.query(
      "SELECT id,version,status_version FROM ai_gateway_connection_versions WHERE account_id=$1 AND status='ACTIVE'",
      [accountA],
    );
    assert.equal(activeRows.rowCount, 1);
    const retiredFirst = (await pool.query(
      "SELECT status,status_version FROM ai_gateway_connection_versions WHERE account_id=$1 AND id=$2 AND version=$3",
      [accountA, first.id, first.version],
    )).rows[0];
    assert.equal(retiredFirst.status, "RETIRED");
    const rolledBack = await repository.markConnectionValidated({
      accountId: accountA,
      actorId: accountA,
      connectionId: first.id,
      connectionVersion: first.version,
      expectedStatusVersion: Number(retiredFirst.status_version),
      idempotencyKey: `rollback-first-${suffix}`,
      correlationId: `corr-rollback-first-${suffix}`,
      validationResult: { ...validationResult, checkedAt: new Date().toISOString(), rollbackTest: true },
    });
    assert.equal(rolledBack.status, "ACTIVE");
    assert.equal((await pool.query(
      `SELECT COUNT(*)::INTEGER AS count FROM ai_gateway_connection_events
        WHERE account_id=$1 AND connection_id=$2 AND connection_version=$3
          AND event_type='ROLLBACK_VALIDATED'`,
      [accountA, first.id, first.version],
    )).rows[0].count, 1);
    const active = {
      id: rolledBack.id,
      version: rolledBack.version,
      status_version: rolledBack.statusVersion,
    };

    await rejectsCode(() => pool.query(
      `UPDATE ai_gateway_profiles
          SET connection_id=$3,connection_version=$4,
              api_key_env_name='SUB2API_ENCRYPTED_KEY',base_url='http://127.0.0.1:8080/v1'
        WHERE account_id=$1 AND id=$2`,
      [accountA, legacyProfileId, active.id, active.version],
    ), "23514");
    await rejectsCode(() => pool.query(
      `UPDATE ai_gateway_connection_versions
          SET status='RETIRED',status_version=status_version+1,
              validation_result='{"outcome":"PASSED","checkedAt":"2026-08-08T00:00:00.000Z","tampered":true}'::JSONB,
              validation_hash=$4,retired_at=NOW(),retired_by=$1
        WHERE account_id=$1 AND id=$2 AND version=$3`,
      [accountA, active.id, active.version, "f".repeat(64)],
    ), "23514");

    await rejectsCode(() => pool.query(
      `INSERT INTO ai_gateway_profiles (
         id,account_id,display_name,base_url,api_key_env_name,text_protocol,image_protocol,
         text_model,image_model,config_version,connection_id,connection_version
       ) VALUES ($1,$2,'Cross tenant','http://127.0.0.1:8080/v1','SUB2API_ENCRYPTED_KEY',
         'SUB2API_RESPONSES','SUB2API_OPENAI_IMAGES','text','image',1,$3,$4)`,
      [`foreign-profile-${suffix}`, accountB, active.id, active.version],
    ), "23503");
    await rejectsCode(() => pool.query(
      "UPDATE ai_gateway_connection_versions SET ciphertext='changed' WHERE account_id=$1 AND id=$2 AND version=$3",
      [accountA, active.id, active.version],
    ), "23514");

    const task = await repository.enqueueModelSync({
      accountId: accountA,
      actorId: accountA,
      connectionId: active.id,
      connectionVersion: active.version,
      expectedConnectionStatusVersion: Number(active.status_version),
      idempotencyKey: `sync-a-${suffix}`,
      correlationId: `corr-sync-a-${suffix}`,
      maxAttempts: 3,
    });
    assert.deepEqual(await repository.listRunnableSyncAccountIds({ afterAccountId: null, limit: 10 }), [accountA]);
    const leased = await repository.claimModelSync({ accountId: accountA, workerId: "worker-a", leaseMs: 1 });
    assert.equal(leased.taskId, task.id);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const reclaimed = await repository.claimModelSync({ accountId: accountA, workerId: "worker-b", leaseMs: 30_000 });
    assert.equal(reclaimed.taskId, task.id);
    assert.equal(reclaimed.leaseVersion, leased.leaseVersion + 1);
    await assert.rejects(repository.completeModelSync({
      accountId: accountA,
      workerId: "worker-a",
      taskId: task.id,
      leaseVersion: leased.leaseVersion,
      leaseToken: leased.leaseToken,
      correlationId: `corr-stale-${suffix}`,
      catalog: { models: [{ id: "text-model", capabilities: ["TEXT"] }] },
      capabilityResult: { outcome: "PASSED", checkedAt: new Date().toISOString() },
    }), { code: "AUTO_LISTING_AI_SETTINGS_LEASE_CONFLICT", status: 409 });

    const testedAt = new Date().toISOString();
    const catalog = {
      models: [
        { id: "text-model", capabilities: ["TEXT"] },
        { id: "image-model", capabilities: ["IMAGE"] },
      ],
    };
    const completed = await repository.completeModelSync({
      accountId: accountA,
      workerId: "worker-b",
      taskId: task.id,
      leaseVersion: reclaimed.leaseVersion,
      leaseToken: reclaimed.leaseToken,
      correlationId: `corr-complete-${suffix}`,
      catalog,
      capabilityResult: { outcome: "PASSED", checkedAt: testedAt, text: true, image: true },
    });
    assert.equal(completed.status, "SUCCEEDED");
    assert.equal(completed.catalog.catalogHash.length, 64);

    const profile = await repository.createProfileFromSelection({
      accountId: accountA,
      actorId: accountA,
      connectionId: active.id,
      connectionVersion: active.version,
      catalogId: completed.catalog.id,
      displayName: "本地模型组合",
      textModel: "text-model",
      imageModel: "image-model",
      textProtocol: "SUB2API_RESPONSES",
      imageProtocol: "SUB2API_OPENAI_IMAGES",
      idempotencyKey: `profile-a-${suffix}`,
      correlationId: `corr-profile-a-${suffix}`,
    });
    assert.equal(profile.apiKeyEnvName, "SUB2API_ENCRYPTED_KEY");
    assert.equal(profile.connectionId, active.id);
    await rejectsCode(() => pool.query(
      "UPDATE ai_gateway_profiles SET connection_id=$1 WHERE account_id=$2 AND id=$3",
      [second.id, accountA, profile.id],
    ), "23514");
    await rejectsCode(() => pool.query(
      "UPDATE ai_gateway_model_catalogs SET catalog='{}'::JSONB WHERE account_id=$1 AND id=$2",
      [accountA, completed.catalog.id],
    ), "23514");

    const overview = await repository.loadSettingsOverview({ accountId: accountA });
    assert.equal(overview.activeConnection.id, active.id);
    assert.equal(overview.profiles.some((candidate) => candidate.id === profile.id), true);
    assert.doesNotMatch(JSON.stringify(overview), /Y2lwaGVy|dGFn|ciphertext|authTag/iu);

    const retryTask = await repository.enqueueModelSync({
      accountId: accountA,
      actorId: accountA,
      connectionId: active.id,
      connectionVersion: active.version,
      expectedConnectionStatusVersion: Number(active.status_version),
      idempotencyKey: `sync-retry-${suffix}`,
      correlationId: `corr-sync-retry-${suffix}`,
      maxAttempts: 2,
    });
    const retryLease = await repository.claimModelSync({ accountId: accountA, workerId: "worker-c", leaseMs: 30_000 });
    await repository.failModelSync({
      accountId: accountA,
      workerId: "worker-c",
      taskId: retryTask.id,
      leaseVersion: retryLease.leaseVersion,
      leaseToken: retryLease.leaseToken,
      correlationId: `corr-fail-retry-${suffix}`,
      errorCode: "GATEWAY_TIMEOUT",
      errorSafe: "gateway timed out",
      retryable: true,
      retryDelayMs: 0,
    });
    const finalLease = await repository.claimModelSync({ accountId: accountA, workerId: "worker-d", leaseMs: 30_000 });
    const finalFailureInput = {
      accountId: accountA,
      workerId: "worker-d",
      taskId: retryTask.id,
      leaseVersion: finalLease.leaseVersion,
      leaseToken: finalLease.leaseToken,
      correlationId: `corr-fail-dead-${suffix}`,
      errorCode: "NON_RETRYABLE_AUTH",
      errorSafe: "credential rejected",
      retryable: false,
      retryDelayMs: 0,
    };
    const dead = await repository.failModelSync(finalFailureInput);
    assert.equal(dead.status, "DEAD");
    const deadReplay = await repository.failModelSync(finalFailureInput);
    assert.equal(deadReplay.status, "DEAD");
    assert.equal(deadReplay.duplicate, true);

    const eventRow = (await pool.query(
      "SELECT id FROM ai_gateway_model_sync_events WHERE account_id=$1 AND task_id=$2 ORDER BY created_at LIMIT 1",
      [accountA, task.id],
    )).rows[0];
    await rejectsCode(() => pool.query(
      "UPDATE ai_gateway_model_sync_events SET payload='{}'::JSONB WHERE account_id=$1 AND id=$2",
      [accountA, eventRow.id],
    ), "23514");
    const auditRow = (await pool.query(
      "SELECT id FROM audit_events WHERE account_id=$1 AND source='auto-listing-ai-settings' ORDER BY id LIMIT 1",
      [accountA],
    )).rows[0];
    await rejectsCode(() => pool.query(
      "DELETE FROM audit_events WHERE account_id=$1 AND id=$2",
      [accountA, auditRow.id],
    ), "23514");
    assert.equal(Number((await pool.query(
      "SELECT COUNT(*)::INTEGER AS count FROM ai_gateway_profile_binding_events WHERE account_id=$1 AND profile_id=$2",
      [accountA, profile.id],
    )).rows[0].count), 1);
  } finally {
    await pool?.end();
    try {
      await admin.query("SET search_path TO public");
      await admin.query(`DROP SCHEMA IF EXISTS ${schemaSql} CASCADE`);
    } finally {
      admin.release();
      await adminPool.end();
    }
  }
});
