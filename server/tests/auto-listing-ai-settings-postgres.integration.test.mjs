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
      rollbackCapabilityEvidence: null,
      validationResult,
    });
    assert.equal(activatedFirst.status, "ACTIVE");
    assert.deepEqual((await repository.loadConnectionForSecretResolution({
      accountId: accountA,
      connectionId: first.id,
      connectionVersion: first.version,
    })).encryptedSecret, encryptedSecret);

    const rollbackCapability = {
      outcome: "PASSED", checkedAt: new Date().toISOString(), text: true, image: true,
    };
    const rollbackCatalog = { models: [
      { id: "text-model", capabilities: ["TEXT"] },
      { id: "image-model", capabilities: ["IMAGE"] },
    ] };
    const seedTask = await repository.enqueueModelSync({
      accountId: accountA, actorId: accountA, connectionId: first.id,
      connectionVersion: first.version, expectedConnectionStatusVersion: activatedFirst.statusVersion,
      idempotencyKey: `sync-rollback-seed-${suffix}`, correlationId: `corr-sync-rollback-seed-${suffix}`,
      maxAttempts: 2, syncPurpose: "CATALOG_SYNC",
    });
    const seedLease = await repository.claimModelSync({ accountId: accountA, workerId: "worker-seed", leaseMs: 30_000 });
    const rollbackEvidenceCatalog = await repository.completeModelSync({
      accountId: accountA, workerId: "worker-seed", taskId: seedTask.id,
      leaseVersion: seedLease.leaseVersion, leaseToken: seedLease.leaseToken,
      correlationId: `corr-sync-rollback-seed-complete-${suffix}`,
      catalog: rollbackCatalog, capabilityResult: rollbackCapability,
    });

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
      rollbackCapabilityEvidence: null,
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
    await assert.rejects(repository.markConnectionValidated({
      accountId: accountA, actorId: accountA, connectionId: first.id,
      connectionVersion: first.version, expectedStatusVersion: Number(retiredFirst.status_version),
      idempotencyKey: `rollback-without-evidence-${suffix}`,
      correlationId: `corr-rollback-without-evidence-${suffix}`,
      rollbackCapabilityEvidence: null, validationResult: rollbackCapability,
    }), { code: "AUTO_LISTING_AI_SETTINGS_ROLLBACK_EVIDENCE_REQUIRED", status: 409 });
    await assert.rejects(repository.markConnectionValidated({
      accountId: accountA, actorId: accountA, connectionId: first.id,
      connectionVersion: first.version, expectedStatusVersion: Number(retiredFirst.status_version),
      idempotencyKey: `rollback-forged-evidence-${suffix}`,
      correlationId: `corr-rollback-forged-evidence-${suffix}`,
      rollbackCapabilityEvidence: {
        schemaVersion: "AI_GATEWAY_ROLLBACK_CAPABILITY_V2",
        taskId: seedTask.id,
        catalogId: rollbackEvidenceCatalog.catalog.id,
        catalogHash: rollbackEvidenceCatalog.catalog.catalogHash,
        capabilityHash: rollbackEvidenceCatalog.catalog.capabilityHash,
        evidenceIdentity: "d".repeat(64),
        targetConnectionStatusVersion: Number(retiredFirst.status_version),
      },
      validationResult: rollbackCapability,
    }), { code: "AUTO_LISTING_AI_SETTINGS_ROLLBACK_EVIDENCE_REQUIRED", status: 409 });
    const rollbackTask = await repository.enqueueModelSync({
      accountId: accountA, actorId: accountA, connectionId: first.id,
      connectionVersion: first.version, expectedConnectionStatusVersion: Number(retiredFirst.status_version),
      idempotencyKey: `rollback-test-${suffix}`, correlationId: `corr-rollback-test-${suffix}`,
      maxAttempts: 1, syncPurpose: "ROLLBACK_CAPABILITY",
    });
    await rejectsCode(() => pool.query(
      `INSERT INTO ai_gateway_model_catalogs (
         account_id,id,connection_id,connection_version,sync_task_id,catalog,catalog_hash,
         capability_result,capability_hash,tested_at,rollback_evidence_identity
       ) VALUES ($1,$2,$3,$4,$5,'{"models":[]}'::JSONB,$6,$7::JSONB,$8,NOW(),$9)`,
      [accountA, `pending-task-catalog-${suffix}`, first.id, first.version, rollbackTask.id,
        "a".repeat(64), JSON.stringify(rollbackCapability), "b".repeat(64), "c".repeat(64)],
    ), "23514");
    const rollbackLease = await repository.claimModelSync({
      accountId: accountA, workerId: "worker-rollback", leaseMs: 30_000,
    });
    assert.equal(rollbackLease.taskId, rollbackTask.id);
    const rollbackTestResult = {
      schemaVersion: "AI_GATEWAY_ROLLBACK_TEST_RESULT_V1",
      outcome: "PASSED", checkedAt: new Date().toISOString(),
      connectionId: first.id, connectionVersion: first.version,
      checks: { authentication: true, modelsEndpoint: true },
    };
    const freshRollbackEvidence = await repository.completeModelSync({
      accountId: accountA, workerId: "worker-rollback", taskId: rollbackTask.id,
      leaseVersion: rollbackLease.leaseVersion, leaseToken: rollbackLease.leaseToken,
      correlationId: `corr-rollback-test-complete-${suffix}`,
      catalog: { models: [] }, capabilityResult: rollbackTestResult,
    });
    assert.match(freshRollbackEvidence.catalog.rollbackEvidenceIdentity, /^[a-f0-9]{64}$/u);
    const rolledBack = await repository.markConnectionValidated({
      accountId: accountA,
      actorId: accountA,
      connectionId: first.id,
      connectionVersion: first.version,
      expectedStatusVersion: Number(retiredFirst.status_version),
      idempotencyKey: `rollback-first-${suffix}`,
      correlationId: `corr-rollback-first-${suffix}`,
      rollbackCapabilityEvidence: {
        schemaVersion: "AI_GATEWAY_ROLLBACK_CAPABILITY_V2",
        taskId: rollbackTask.id,
        catalogId: freshRollbackEvidence.catalog.id,
        catalogHash: freshRollbackEvidence.catalog.catalogHash,
        capabilityHash: freshRollbackEvidence.catalog.capabilityHash,
        evidenceIdentity: freshRollbackEvidence.catalog.rollbackEvidenceIdentity,
        targetConnectionStatusVersion: Number(retiredFirst.status_version),
      },
      validationResult: rollbackTestResult,
    });
    assert.equal(rolledBack.status, "ACTIVE");
    assert.equal((await pool.query(
      `SELECT COUNT(*)::INTEGER AS count FROM ai_gateway_connection_events
        WHERE account_id=$1 AND connection_id=$2 AND connection_version=$3
          AND event_type='ROLLBACK_VALIDATED'`,
      [accountA, first.id, first.version],
    )).rows[0].count, 1);
    await rejectsCode(() => pool.query(
      `INSERT INTO ai_gateway_rollback_evidence_consumptions (
         account_id,catalog_id,task_id,connection_id,connection_version,
         target_connection_status_version,evidence_identity,validation_hash,actor_id,correlation_id
       ) SELECT account_id,catalog_id,task_id,connection_id,connection_version,
           target_connection_status_version,evidence_identity,validation_hash,actor_id,$2
         FROM ai_gateway_rollback_evidence_consumptions
        WHERE account_id=$1 AND catalog_id=$3`,
      [accountA, `duplicate-consumption-${suffix}`, freshRollbackEvidence.catalog.id],
    ), "23505");
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
    await rejectsCode(() => pool.query(
      `INSERT INTO ai_gateway_connection_versions (
         account_id,id,version,display_name,base_url,ciphertext,iv,auth_tag,algorithm,key_version,
         fingerprint,status,status_version,idempotency_key,request_hash,correlation_id,created_by
       ) VALUES ($1,$2,1,'Bypass','http://127.0.0.1:8080/v1','cipher','iv','tag','aes-256-gcm','v1',
         'bypass','ACTIVE',1,$3,$4,$3,$1)`,
      [accountA, `bypass-active-${suffix}`, `bypass-${suffix}`, "a".repeat(64)],
    ), "23514");
    await rejectsCode(() => pool.query(
      `INSERT INTO ai_gateway_connection_versions (
         account_id,id,version,display_name,base_url,ciphertext,iv,auth_tag,algorithm,key_version,
         fingerprint,status,status_version,idempotency_key,request_hash,correlation_id,created_by
       ) VALUES ($1,$2,2,'Bypass v2','http://127.0.0.1:8080/v1','cipher','iv','tag','aes-256-gcm','v1',
         'bypass-v2','PENDING',1,$3,$4,$3,$1)`,
      [accountA, `bypass-v2-${suffix}`, `bypass-v2-${suffix}`, "f".repeat(64)],
    ), "23514");
    await rejectsCode(() => pool.query(
      `INSERT INTO ai_gateway_profiles (
         id,account_id,display_name,base_url,api_key_env_name,text_protocol,image_protocol,
         text_model,image_model,config_version,enabled,created_by
       ) VALUES ($1,$2,'Bad sentinel','https://legacy.example/v1','SUB2API_ENCRYPTED_KEY',
         'SUB2API_RESPONSES','SUB2API_OPENAI_IMAGES','text','image',1,FALSE,$2)`,
      [`bad-sentinel-${suffix}`, accountA],
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
      syncPurpose: "CATALOG_SYNC",
    });
    await assert.rejects(repository.enqueueModelSync({
      accountId: accountA, actorId: accountA, connectionId: active.id,
      connectionVersion: active.version, expectedConnectionStatusVersion: Number(active.status_version),
      idempotencyKey: `sync-conflict-${suffix}`, correlationId: `corr-sync-conflict-${suffix}`,
      maxAttempts: 3,
      syncPurpose: "CATALOG_SYNC",
    }), { code: "AUTO_LISTING_AI_SETTINGS_SYNC_ALREADY_RUNNABLE", status: 409 });
    assert.deepEqual(await repository.listRunnableSyncAccountIds({ afterAccountId: null, limit: 10 }), [accountA]);
    const leased = await repository.claimModelSync({ accountId: accountA, workerId: "worker-a", leaseMs: 1 });
    assert.equal(leased.taskId, task.id);
    const storedLeaseToken = (await pool.query(
      "SELECT lease_token FROM ai_gateway_model_sync_tasks WHERE account_id=$1 AND id=$2",
      [accountA, task.id],
    )).rows[0].lease_token;
    assert.notEqual(storedLeaseToken, leased.leaseToken);
    assert.match(storedLeaseToken, /^[a-f0-9]{64}$/u);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const expiredCompletion = {
      accountId: accountA, workerId: "worker-a", taskId: task.id,
      leaseVersion: leased.leaseVersion, leaseToken: leased.leaseToken,
      correlationId: `corr-expired-complete-${suffix}`, catalog: rollbackCatalog,
      capabilityResult: { ...rollbackCapability, checkedAt: new Date().toISOString() },
    };
    await assert.rejects(repository.completeModelSync(expiredCompletion), {
      code: "AUTO_LISTING_AI_SETTINGS_LEASE_CONFLICT", status: 409,
    });
    await assert.rejects(repository.failModelSync({
      accountId: accountA, workerId: "worker-a", taskId: task.id,
      leaseVersion: leased.leaseVersion, leaseToken: leased.leaseToken,
      correlationId: `corr-expired-fail-${suffix}`, errorCode: "EXPIRED_WORKER",
      errorSafe: "expired worker", retryable: true, retryDelayMs: 0,
    }), { code: "AUTO_LISTING_AI_SETTINGS_LEASE_CONFLICT", status: 409 });
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
      catalog: rollbackCatalog,
      capabilityResult: { ...rollbackCapability, checkedAt: new Date().toISOString() },
    }), { code: "AUTO_LISTING_AI_SETTINGS_LEASE_CONFLICT", status: 409 });

    const testedAt = new Date().toISOString();
    const catalog = {
      models: [
        { id: "text-model", capabilities: ["TEXT"] },
        { id: "image-model", capabilities: ["IMAGE"] },
      ],
    };
    const completionInput = {
      accountId: accountA,
      workerId: "worker-b",
      taskId: task.id,
      leaseVersion: reclaimed.leaseVersion,
      leaseToken: reclaimed.leaseToken,
      correlationId: `corr-complete-${suffix}`,
      catalog,
      capabilityResult: { outcome: "PASSED", checkedAt: testedAt, text: true, image: true },
    };
    const completed = await repository.completeModelSync(completionInput);
    assert.equal(completed.status, "SUCCEEDED");
    assert.equal(completed.catalog.catalogHash.length, 64);
    assert.equal((await repository.completeModelSync(completionInput)).duplicate, true);
    await assert.rejects(repository.completeModelSync({
      ...completionInput, workerId: "worker-forged",
    }), { code: "AUTO_LISTING_AI_SETTINGS_IDEMPOTENCY_CONFLICT", status: 409 });
    await assert.rejects(repository.completeModelSync({
      ...completionInput, leaseToken: "aiglease_forged",
    }), { code: "AUTO_LISTING_AI_SETTINGS_IDEMPOTENCY_CONFLICT", status: 409 });

    const emptyTask = await repository.enqueueModelSync({
      accountId: accountA, actorId: accountA, connectionId: active.id,
      connectionVersion: active.version, expectedConnectionStatusVersion: Number(active.status_version),
      idempotencyKey: `sync-empty-${suffix}`, correlationId: `corr-sync-empty-${suffix}`,
      maxAttempts: 1, syncPurpose: "CATALOG_SYNC",
    });
    const emptyLease = await repository.claimModelSync({ accountId: accountA, workerId: "worker-empty", leaseMs: 30_000 });
    const emptyCompleted = await repository.completeModelSync({
      accountId: accountA, workerId: "worker-empty", taskId: emptyTask.id,
      leaseVersion: emptyLease.leaseVersion, leaseToken: emptyLease.leaseToken,
      correlationId: `corr-sync-empty-complete-${suffix}`, catalog: { models: [] },
      capabilityResult: { outcome: "NOT_TESTED", checkedAt: new Date().toISOString(), text: false, image: false },
    });
    assert.equal(emptyCompleted.status, "SUCCEEDED");

    const singleTask = await repository.enqueueModelSync({
      accountId: accountA, actorId: accountA, connectionId: active.id,
      connectionVersion: active.version, expectedConnectionStatusVersion: Number(active.status_version),
      idempotencyKey: `sync-single-${suffix}`, correlationId: `corr-sync-single-${suffix}`,
      maxAttempts: 1, syncPurpose: "CATALOG_SYNC",
    });
    const singleLease = await repository.claimModelSync({ accountId: accountA, workerId: "worker-single", leaseMs: 30_000 });
    const singleCompleted = await repository.completeModelSync({
      accountId: accountA, workerId: "worker-single", taskId: singleTask.id,
      leaseVersion: singleLease.leaseVersion, leaseToken: singleLease.leaseToken,
      correlationId: `corr-sync-single-complete-${suffix}`,
      catalog: { models: [{ id: "text-only", capabilities: ["TEXT"] }] },
      capabilityResult: { outcome: "PASSED", checkedAt: new Date().toISOString(), text: true, image: false },
    });
    assert.equal(singleCompleted.status, "SUCCEEDED");
    await assert.rejects(repository.createProfileFromSelection({
      accountId: accountA, actorId: accountA, connectionId: active.id,
      connectionVersion: active.version, catalogId: singleCompleted.catalog.id,
      displayName: "invalid single mode", textModel: "text-only", imageModel: "missing-image",
      textProtocol: "SUB2API_RESPONSES", imageProtocol: "SUB2API_OPENAI_IMAGES",
      idempotencyKey: `profile-single-${suffix}`, correlationId: `corr-profile-single-${suffix}`,
    }), { code: "AUTO_LISTING_AI_SETTINGS_MODEL_SELECTION_INVALID" });

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
    await rejectsCode(() => pool.query(
      `INSERT INTO ai_gateway_model_sync_events (
         account_id,id,task_id,connection_id,connection_version,event_type,status_version,
         lease_version,actor_id,correlation_id,payload
       ) VALUES ($1,$2,$3,$4,$5,'SUCCEEDED',999,1,$1,$2,'{}'::JSONB)`,
      [accountA, `mismatched-event-${suffix}`, task.id, second.id, second.version],
    ), "23503");
    await rejectsCode(() => pool.query(
      `INSERT INTO ai_gateway_profile_binding_events (
         account_id,id,profile_id,config_version,connection_id,connection_version,
         catalog_id,actor_id,correlation_id,payload
       ) VALUES ($1,$2,$3,2,$4,$5,$6,$1,$2,'{}'::JSONB)`,
      [accountA, `mismatched-profile-event-${suffix}`, profile.id,
        second.id, second.version, completed.catalog.id],
    ), "23503");

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
      syncPurpose: "CATALOG_SYNC",
    });
    await rejectsCode(() => pool.query(
      `INSERT INTO ai_gateway_model_catalogs (
         account_id,id,connection_id,connection_version,sync_task_id,catalog,catalog_hash,
         capability_result,capability_hash,tested_at
       ) VALUES ($1,$2,$3,$4,$5,$6::JSONB,$7,$8::JSONB,$9,NOW())`,
      [accountA, `mismatched-catalog-${suffix}`, second.id, second.version, retryTask.id,
        JSON.stringify(rollbackCatalog), "b".repeat(64), JSON.stringify(rollbackCapability), "c".repeat(64)],
    ), "23514");
    await rejectsCode(() => pool.query(
      `INSERT INTO ai_gateway_model_catalogs (
         account_id,id,connection_id,connection_version,sync_task_id,catalog,catalog_hash,
         capability_result,capability_hash,tested_at
       ) VALUES ($1,$2,$3,$4,$5,$6::JSONB,$7,$8::JSONB,$9,NOW())`,
      [accountA, `failed-capability-${suffix}`, active.id, active.version, retryTask.id,
        JSON.stringify(rollbackCatalog), "d".repeat(64),
        JSON.stringify({ ...rollbackCapability, outcome: "FAILED", text: false }), "e".repeat(64)],
    ), "23514");
    const retryLease = await repository.claimModelSync({ accountId: accountA, workerId: "worker-c", leaseMs: 30_000 });
    const retryFailureInput = {
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
    };
    const retryFailure = await repository.failModelSync(retryFailureInput);
    assert.equal(retryFailure.status, "FAILED");
    const finalLease = await repository.claimModelSync({ accountId: accountA, workerId: "worker-d", leaseMs: 30_000 });
    const retryReplayAfterNextClaim = await repository.failModelSync(retryFailureInput);
    assert.equal(retryReplayAfterNextClaim.status, "FAILED");
    assert.equal(retryReplayAfterNextClaim.duplicate, true);
    assert.equal(retryReplayAfterNextClaim.statusVersion, retryFailure.statusVersion);
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
    await assert.rejects(repository.failModelSync({
      ...finalFailureInput, workerId: "worker-forged",
    }), { code: "AUTO_LISTING_AI_SETTINGS_IDEMPOTENCY_CONFLICT", status: 409 });
    await assert.rejects(repository.failModelSync({
      ...finalFailureInput, leaseToken: "aiglease_forged",
    }), { code: "AUTO_LISTING_AI_SETTINGS_IDEMPOTENCY_CONFLICT", status: 409 });

    const exhaustedTask = await repository.enqueueModelSync({
      accountId: accountA, actorId: accountA, connectionId: active.id,
      connectionVersion: active.version, expectedConnectionStatusVersion: Number(active.status_version),
      idempotencyKey: `sync-exhausted-${suffix}`, correlationId: `corr-sync-exhausted-${suffix}`,
      maxAttempts: 1,
      syncPurpose: "CATALOG_SYNC",
    });
    const exhaustedLease = await repository.claimModelSync({
      accountId: accountA, workerId: "worker-expiring", leaseMs: 1,
    });
    assert.equal(exhaustedLease.taskId, exhaustedTask.id);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(await repository.listRunnableSyncAccountIds({ afterAccountId: null, limit: 10 }), [accountA]);
    assert.equal(await repository.claimModelSync({
      accountId: accountA, workerId: "worker-reaper", leaseMs: 30_000,
    }), null);
    const exhausted = (await pool.query(
      "SELECT status,last_error_code FROM ai_gateway_model_sync_tasks WHERE account_id=$1 AND id=$2",
      [accountA, exhaustedTask.id],
    )).rows[0];
    assert.deepEqual(exhausted, {
      status: "DEAD", last_error_code: "AUTO_LISTING_AI_MODEL_SYNC_ATTEMPTS_EXHAUSTED",
    });
    assert.equal((await pool.query(
      `SELECT COUNT(*)::INTEGER AS count FROM ai_gateway_model_sync_events
        WHERE account_id=$1 AND task_id=$2 AND event_type='DEAD'`,
      [accountA, exhaustedTask.id],
    )).rows[0].count, 1);

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
    const workerAudits = (await pool.query(
      `SELECT actor_type,metadata::TEXT AS metadata FROM audit_events
        WHERE account_id=$1 AND source='auto-listing-ai-settings'
          AND action IN ('AUTO_LISTING_AI_MODEL_SYNC_LEASE','AUTO_LISTING_AI_MODEL_SYNC_SUCCEEDED',
            'AUTO_LISTING_AI_MODEL_SYNC_FAILED','AUTO_LISTING_AI_MODEL_SYNC_DEAD')`,
      [accountA],
    )).rows;
    assert.equal(workerAudits.length > 0, true);
    assert.equal(workerAudits.every((row) => row.actor_type === "worker"), true);
    assert.equal(workerAudits.some((row) => /"leaseIdentityHash"\s*:\s*"[a-f0-9]{64}"/iu.test(row.metadata)), true);
    for (const token of [seedLease.leaseToken, rollbackLease.leaseToken, leased.leaseToken,
      reclaimed.leaseToken, emptyLease.leaseToken, singleLease.leaseToken,
      retryLease.leaseToken, finalLease.leaseToken, exhaustedLease.leaseToken]) {
      assert.doesNotMatch(workerAudits.map((row) => row.metadata).join("\n"), new RegExp(token, "u"));
    }

    const retainedAuditCount = (await pool.query(
      "SELECT COUNT(*)::INTEGER AS count FROM audit_events WHERE account_id=$1 AND source='auto-listing-ai-settings'",
      [accountA],
    )).rows[0].count;
    await pool.query("DELETE FROM accounts WHERE id=$1", [accountA]);
    for (const table of [
      "ai_gateway_connection_versions", "ai_gateway_connection_events", "ai_gateway_model_sync_tasks",
      "ai_gateway_model_sync_events", "ai_gateway_model_catalogs", "ai_gateway_profiles",
      "ai_gateway_model_sync_attempt_outcomes", "ai_gateway_rollback_evidence_consumptions",
      "ai_gateway_profile_binding_events",
    ]) {
      assert.equal((await pool.query(`SELECT COUNT(*)::INTEGER AS count FROM ${table} WHERE account_id=$1`,
        [accountA])).rows[0].count, 0);
    }
    assert.equal((await pool.query(
      "SELECT COUNT(*)::INTEGER AS count FROM audit_events WHERE account_id IS NULL AND source='auto-listing-ai-settings'",
    )).rows[0].count, retainedAuditCount);
    assert.equal((await pool.query("SELECT COUNT(*)::INTEGER AS count FROM accounts WHERE id=$1", [accountB])).rows[0].count, 1);
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
