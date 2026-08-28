import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createAutoListingCredentialCipher } from "../auto-listing-ai-credential-crypto.mjs";
import { createAutoListingAiCatalogSyncCredentialResolver } from "../auto-listing-ai-credential-resolver.mjs";
import { createAutoListingAiModelSyncService } from "../auto-listing-ai-model-sync-service.mjs";
import {
  createAutoListingAiModelSyncSchedulePostgres,
  createAutoListingAiModelSyncWorker,
} from "../auto-listing-ai-model-sync-worker.mjs";
import { createAutoListingAiSettingsPostgres } from "../auto-listing-ai-settings-postgres.mjs";
import { createSub2ApiAdapter } from "../sub2api-ai-adapter.mjs";

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
  const accountC = `account-c-${suffix}`;
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
    for (const accountId of [accountA, accountB, accountC]) {
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
    await admin.query(await readFile(path.join(migrationsDir, "054_auto_listing_ai_capability_authorization.sql"), "utf8"));
    for (const migration of migrations.filter((file) => file > "054_")) {
      await admin.query(await readFile(path.join(migrationsDir, migration), "utf8"));
    }

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
    assert.deepEqual(await repository.listProfileChannels({
      accountId: accountA, profileId: legacyProfileId, profileVersion: 1,
    }), { channels: [], channelCandidates: [] }, "legacy environment profiles never gain fabricated channels or candidates");
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
      maxAttempts: 5, syncPurpose: "CATALOG_SYNC",
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
    const restartedRepository = createAutoListingAiSettingsPostgres({ pool });
    const rollbackSecret = await restartedRepository.loadRollbackConnectionForSecretResolution({
      accountId: accountA, taskId: rollbackTask.id, workerId: "worker-rollback",
      leaseVersion: rollbackLease.leaseVersion, leaseToken: rollbackLease.leaseToken,
    });
    assert.equal(rollbackSecret.status, "RETIRED");
    assert.deepEqual(rollbackSecret.encryptedSecret, encryptedSecret);
    for (const rejectedLease of [
      { accountId: accountB, workerId: "worker-rollback", leaseToken: rollbackLease.leaseToken },
      { accountId: accountA, workerId: "worker-other", leaseToken: rollbackLease.leaseToken },
      { accountId: accountA, workerId: "worker-rollback", leaseToken: "aiglease_wrong" },
    ]) {
      await assert.rejects(restartedRepository.loadRollbackConnectionForSecretResolution({
        ...rejectedLease, taskId: rollbackTask.id, leaseVersion: rollbackLease.leaseVersion,
      }), { code: "AUTO_LISTING_AI_SETTINGS_ROLLBACK_LEASE_CONFLICT", status: 409 });
    }
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
    const stalePendingRollback = await repository.enqueueModelSync({
      accountId: accountA, actorId: accountA, connectionId: first.id,
      connectionVersion: first.version, expectedConnectionStatusVersion: Number(retiredFirst.status_version),
      idempotencyKey: `rollback-stale-pending-${suffix}`,
      correlationId: `corr-rollback-stale-pending-${suffix}`,
      maxAttempts: 1, syncPurpose: "ROLLBACK_CAPABILITY",
    });
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
    assert.equal(await repository.claimModelSync({
      accountId: accountA, workerId: "worker-stale-claim", leaseMs: 30_000,
    }), null);
    assert.deepEqual((await pool.query(
      `SELECT status,last_error_code FROM ai_gateway_model_sync_tasks
        WHERE account_id=$1 AND id=$2`,
      [accountA, stalePendingRollback.id],
    )).rows[0], {
      status: "DEAD", last_error_code: "AUTO_LISTING_AI_ROLLBACK_FENCE_EXPIRED",
    });
    assert.equal((await pool.query(
      `SELECT COUNT(*)::INTEGER AS count FROM ai_gateway_model_sync_events
        WHERE account_id=$1 AND task_id=$2 AND event_type='DEAD'`,
      [accountA, stalePendingRollback.id],
    )).rows[0].count, 1);
    assert.equal((await pool.query(
      `SELECT COUNT(*)::INTEGER AS count FROM audit_events
        WHERE account_id=$1 AND source='auto-listing-ai-settings'
          AND entity_id=$2 AND action='AUTO_LISTING_AI_MODEL_SYNC_DEAD'`,
      [accountA, stalePendingRollback.id],
    )).rows[0].count, 1);
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

    const fourth = await createPending("d");
    await repository.markConnectionValidated({
      accountId: accountA, actorId: accountA, connectionId: fourth.id,
      connectionVersion: fourth.version, expectedStatusVersion: 1,
      idempotencyKey: `activate-d-${suffix}`, correlationId: `corr-activate-d-${suffix}`,
      rollbackCapabilityEvidence: null,
      validationResult: { ...validationResult, checkedAt: new Date().toISOString() },
    });
    const retiredAgain = (await pool.query(
      `SELECT status,status_version FROM ai_gateway_connection_versions
        WHERE account_id=$1 AND id=$2 AND version=$3`,
      [accountA, first.id, first.version],
    )).rows[0];
    assert.equal(retiredAgain.status, "RETIRED");
    const secondEvidenceTask = await repository.enqueueModelSync({
      accountId: accountA, actorId: accountA, connectionId: first.id,
      connectionVersion: first.version,
      expectedConnectionStatusVersion: Number(retiredAgain.status_version),
      idempotencyKey: `rollback-second-evidence-${suffix}`,
      correlationId: `corr-rollback-second-evidence-${suffix}`,
      maxAttempts: 1, syncPurpose: "ROLLBACK_CAPABILITY",
    });
    const secondEvidenceLease = await repository.claimModelSync({
      accountId: accountA, workerId: "worker-rollback-second", leaseMs: 30_000,
    });
    const secondRollbackTestResult = {
      schemaVersion: "AI_GATEWAY_ROLLBACK_TEST_RESULT_V1", outcome: "PASSED",
      checkedAt: new Date().toISOString(), connectionId: first.id,
      connectionVersion: first.version,
      checks: { authentication: true, modelsEndpoint: true },
    };
    const secondEvidence = await repository.completeModelSync({
      accountId: accountA, workerId: "worker-rollback-second", taskId: secondEvidenceTask.id,
      leaseVersion: secondEvidenceLease.leaseVersion, leaseToken: secondEvidenceLease.leaseToken,
      correlationId: `corr-rollback-second-evidence-complete-${suffix}`,
      catalog: { models: [] }, capabilityResult: secondRollbackTestResult,
    });
    const expiredSecretTask = await repository.enqueueModelSync({
      accountId: accountA, actorId: accountA, connectionId: first.id,
      connectionVersion: first.version,
      expectedConnectionStatusVersion: Number(retiredAgain.status_version),
      idempotencyKey: `rollback-expired-secret-${suffix}`,
      correlationId: `corr-rollback-expired-secret-${suffix}`,
      maxAttempts: 1, syncPurpose: "ROLLBACK_CAPABILITY",
    });
    const expiredSecretLease = await repository.claimModelSync({
      accountId: accountA, workerId: "worker-expired-secret", leaseMs: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await assert.rejects(restartedRepository.loadRollbackConnectionForSecretResolution({
      accountId: accountA, taskId: expiredSecretTask.id, workerId: "worker-expired-secret",
      leaseVersion: expiredSecretLease.leaseVersion, leaseToken: expiredSecretLease.leaseToken,
    }), { code: "AUTO_LISTING_AI_SETTINGS_ROLLBACK_LEASE_CONFLICT", status: 409 });
    assert.equal(await repository.claimModelSync({
      accountId: accountA, workerId: "worker-expired-secret-reaper", leaseMs: 30_000,
    }), null);
    const staleLeasedTask = await repository.enqueueModelSync({
      accountId: accountA, actorId: accountA, connectionId: first.id,
      connectionVersion: first.version,
      expectedConnectionStatusVersion: Number(retiredAgain.status_version),
      idempotencyKey: `rollback-stale-leased-${suffix}`,
      correlationId: `corr-rollback-stale-leased-${suffix}`,
      maxAttempts: 1, syncPurpose: "ROLLBACK_CAPABILITY",
    });
    const staleLease = await repository.claimModelSync({
      accountId: accountA, workerId: "worker-stale-complete", leaseMs: 30_000,
    });
    assert.equal(staleLease.taskId, staleLeasedTask.id);
    assert.equal((await restartedRepository.loadRollbackConnectionForSecretResolution({
      accountId: accountA, taskId: staleLeasedTask.id, workerId: "worker-stale-complete",
      leaseVersion: staleLease.leaseVersion, leaseToken: staleLease.leaseToken,
    })).status, "RETIRED");
    const rolledBackAgain = await repository.markConnectionValidated({
      accountId: accountA, actorId: accountA, connectionId: first.id,
      connectionVersion: first.version, expectedStatusVersion: Number(retiredAgain.status_version),
      idempotencyKey: `rollback-first-again-${suffix}`,
      correlationId: `corr-rollback-first-again-${suffix}`,
      rollbackCapabilityEvidence: {
        schemaVersion: "AI_GATEWAY_ROLLBACK_CAPABILITY_V2", taskId: secondEvidenceTask.id,
        catalogId: secondEvidence.catalog.id, catalogHash: secondEvidence.catalog.catalogHash,
        capabilityHash: secondEvidence.catalog.capabilityHash,
        evidenceIdentity: secondEvidence.catalog.rollbackEvidenceIdentity,
        targetConnectionStatusVersion: Number(retiredAgain.status_version),
      },
      validationResult: secondRollbackTestResult,
    });
    await assert.rejects(restartedRepository.loadRollbackConnectionForSecretResolution({
      accountId: accountA, taskId: staleLeasedTask.id, workerId: "worker-stale-complete",
      leaseVersion: staleLease.leaseVersion, leaseToken: staleLease.leaseToken,
    }), { code: "AUTO_LISTING_AI_SETTINGS_ROLLBACK_LEASE_CONFLICT", status: 409 });
    const staleCompletionInput = {
      accountId: accountA, workerId: "worker-stale-complete", taskId: staleLeasedTask.id,
      leaseVersion: staleLease.leaseVersion, leaseToken: staleLease.leaseToken,
      correlationId: `corr-stale-rollback-complete-${suffix}`, catalog: { models: [] },
      capabilityResult: {
        ...secondRollbackTestResult, checkedAt: new Date().toISOString(),
      },
    };
    const staleCompletion = await repository.completeModelSync(staleCompletionInput);
    assert.deepEqual({ status: staleCompletion.status, error: staleCompletion.lastErrorCode }, {
      status: "DEAD", error: "AUTO_LISTING_AI_ROLLBACK_FENCE_EXPIRED",
    });
    const staleCompletionReplay = await repository.completeModelSync(staleCompletionInput);
    assert.equal(staleCompletionReplay.duplicate, true);
    assert.equal((await pool.query(
      `SELECT COUNT(*)::INTEGER AS count FROM ai_gateway_model_sync_events
        WHERE account_id=$1 AND task_id=$2 AND event_type='DEAD'`,
      [accountA, staleLeasedTask.id],
    )).rows[0].count, 1);
    assert.equal((await pool.query(
      `SELECT COUNT(*)::INTEGER AS count FROM audit_events
        WHERE account_id=$1 AND source='auto-listing-ai-settings'
          AND entity_id=$2 AND action='AUTO_LISTING_AI_MODEL_SYNC_DEAD'`,
      [accountA, staleLeasedTask.id],
    )).rows[0].count, 1);
    assert.equal((await pool.query(
      "SELECT COUNT(*)::INTEGER AS count FROM ai_gateway_model_catalogs WHERE account_id=$1 AND sync_task_id=$2",
      [accountA, staleLeasedTask.id],
    )).rows[0].count, 0);
    let active = {
      id: rolledBackAgain.id,
      version: rolledBackAgain.version,
      status_version: rolledBackAgain.statusVersion,
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
      maxAttempts: 5,
      syncPurpose: "CATALOG_SYNC",
    });
    await assert.rejects(repository.enqueueModelSync({
      accountId: accountA, actorId: accountA, connectionId: active.id,
      connectionVersion: active.version, expectedConnectionStatusVersion: Number(active.status_version),
      idempotencyKey: `sync-conflict-${suffix}`, correlationId: `corr-sync-conflict-${suffix}`,
      maxAttempts: 5,
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

    const selectionConnection = await createPending("selection");
    const emptyTask = await repository.enqueueModelSync({
      accountId: accountA, actorId: accountA, connectionId: selectionConnection.id,
      connectionVersion: selectionConnection.version,
      expectedConnectionStatusVersion: selectionConnection.statusVersion,
      idempotencyKey: `sync-empty-${suffix}`, correlationId: `corr-sync-empty-${suffix}`,
      maxAttempts: 5, syncPurpose: "CATALOG_SYNC",
    });
    const emptyLease = await repository.claimModelSync({ accountId: accountA, workerId: "worker-empty", leaseMs: 30_000 });
    const emptyCompleted = await repository.completeModelSync({
      accountId: accountA, workerId: "worker-empty", taskId: emptyTask.id,
      leaseVersion: emptyLease.leaseVersion, leaseToken: emptyLease.leaseToken,
      correlationId: `corr-sync-empty-complete-${suffix}`, catalog: { models: [] },
      capabilityResult: { outcome: "NOT_TESTED", checkedAt: new Date().toISOString(), text: false, image: false },
    });
    assert.equal(emptyCompleted.status, "SUCCEEDED");
    const validatedSelection = (await pool.query(
      `SELECT id,version,status,status_version FROM ai_gateway_connection_versions
        WHERE account_id=$1 AND id=$2 AND version=$3`,
      [accountA, selectionConnection.id, selectionConnection.version],
    )).rows[0];
    assert.equal(validatedSelection.status, "VALIDATED");

    const singleTask = await repository.enqueueModelSync({
      accountId: accountA, actorId: accountA, connectionId: validatedSelection.id,
      connectionVersion: Number(validatedSelection.version),
      expectedConnectionStatusVersion: Number(validatedSelection.status_version),
      idempotencyKey: `sync-single-${suffix}`, correlationId: `corr-sync-single-${suffix}`,
      maxAttempts: 5, syncPurpose: "CATALOG_SYNC",
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
      accountId: accountA, actorId: accountA, connectionId: validatedSelection.id,
      connectionVersion: Number(validatedSelection.version), catalogId: singleCompleted.catalog.id,
      displayName: "invalid single mode", textModel: "text-only", imageModel: "missing-image",
      textProtocol: "SUB2API_RESPONSES", imageProtocol: "SUB2API_OPENAI_IMAGES",
      idempotencyKey: `profile-single-${suffix}`, correlationId: `corr-profile-single-${suffix}`,
    }), { code: "AUTO_LISTING_AI_SETTINGS_MODEL_SELECTION_INVALID" });

    const latestFullTask = await repository.enqueueModelSync({
      accountId: accountA, actorId: accountA, connectionId: validatedSelection.id,
      connectionVersion: Number(validatedSelection.version),
      expectedConnectionStatusVersion: Number(validatedSelection.status_version),
      idempotencyKey: `sync-latest-full-${suffix}`, correlationId: `corr-sync-latest-full-${suffix}`,
      maxAttempts: 5, syncPurpose: "CATALOG_SYNC",
    });
    const latestFullLease = await repository.claimModelSync({
      accountId: accountA, workerId: "worker-latest-full", leaseMs: 30_000,
    });
    const latestFullCompleted = await repository.completeModelSync({
      accountId: accountA, workerId: "worker-latest-full", taskId: latestFullTask.id,
      leaseVersion: latestFullLease.leaseVersion, leaseToken: latestFullLease.leaseToken,
      correlationId: `corr-sync-latest-full-complete-${suffix}`, catalog,
      capabilityResult: { outcome: "NOT_TESTED", checkedAt: new Date().toISOString(), text: false, image: false },
    });

    const profile = await repository.createProfileFromSelection({
      accountId: accountA,
      actorId: accountA,
      connectionId: validatedSelection.id,
      connectionVersion: Number(validatedSelection.version),
      catalogId: latestFullCompleted.catalog.id,
      displayName: "本地模型组合",
      textModel: "text-model",
      imageModel: "image-model",
      textProtocol: "SUB2API_RESPONSES",
      imageProtocol: "SUB2API_OPENAI_IMAGES",
      idempotencyKey: `profile-a-${suffix}`,
      correlationId: `corr-profile-a-${suffix}`,
    });
    assert.equal(profile.apiKeyEnvName, "SUB2API_ENCRYPTED_KEY");
    assert.equal(profile.connectionId, validatedSelection.id);
    const fixtureClient = await pool.connect();
    try {
      await fixtureClient.query("BEGIN");
      await fixtureClient.query(
        `UPDATE ai_gateway_connection_versions
            SET status='RETIRED',status_version=status_version+1,
                retired_at=NOW(),retired_by=$4
          WHERE account_id=$1 AND id=$2 AND version=$3 AND status='ACTIVE'`,
        [accountA, active.id, active.version, accountA],
      );
      await fixtureClient.query(
        `UPDATE ai_gateway_connection_versions
            SET status='ACTIVE',status_version=status_version+1,
                activated_at=NOW(),activated_by=$4
          WHERE account_id=$1 AND id=$2 AND version=$3 AND status='VALIDATED'`,
        [accountA, validatedSelection.id, Number(validatedSelection.version), accountA],
      );
      await fixtureClient.query(
        "UPDATE ai_gateway_profiles SET enabled=TRUE WHERE account_id=$1 AND id=$2 AND config_version=$3",
        [accountA, profile.id, profile.configVersion],
      );
      await fixtureClient.query("COMMIT");
    } catch (error) {
      await fixtureClient.query("ROLLBACK");
      throw error;
    } finally {
      fixtureClient.release();
    }
    active = (await pool.query(
      `SELECT id,version,status_version FROM ai_gateway_connection_versions
        WHERE account_id=$1 AND status='ACTIVE'`,
      [accountA],
    )).rows[0];
    assert.equal(active.id, validatedSelection.id);
    await pool.query(
      `INSERT INTO auto_listing_ai_profile_channels (
         account_id,profile_id,profile_version,channel_id,display_name,
         connection_id,connection_version,channel_order
       ) VALUES ($1,$2,$3,'primary',$4,$5,$6,1)`,
      [accountA, profile.id, profile.configVersion, profile.displayName, active.id, active.version],
    );

    const missingTask = await repository.enqueueModelSync({
      accountId: accountA, actorId: accountA, connectionId: active.id,
      connectionVersion: active.version, expectedConnectionStatusVersion: Number(active.status_version),
      idempotencyKey: `sync-active-missing-${suffix}`,
      correlationId: `corr-sync-active-missing-${suffix}`,
      maxAttempts: 5, syncPurpose: "CATALOG_SYNC",
    });
    const missingLease = await repository.claimModelSync({
      accountId: accountA, workerId: "worker-service-replay", leaseMs: 120_000,
      syncPurpose: "CATALOG_SYNC",
    });
    assert.equal(missingLease.taskId, missingTask.id);
    await assert.rejects(repository.loadCatalogSyncConnectionForSecretResolution({
      accountId: accountA, taskId: missingTask.id, workerId: "worker-service-replay",
      leaseVersion: missingLease.leaseVersion, leaseToken: "aiglease_forged",
      minimumLeaseRemainingMs: 45_000,
    }), { code: "AUTO_LISTING_AI_SETTINGS_CATALOG_LEASE_CONFLICT", status: 409 });
    let completionResponseLost = true;
    const responseLossRepository = {
      loadCatalogSyncConnectionForSecretResolution: repository.loadCatalogSyncConnectionForSecretResolution,
      loadSettingsOverview: repository.loadSettingsOverview,
      failModelSync: repository.failModelSync,
      async completeModelSync(input) {
        const result = await repository.completeModelSync(input);
        if (completionResponseLost) {
          completionResponseLost = false;
          const error = new Error("simulated response loss after committed catalog");
          error.code = "AUTO_LISTING_AI_SETTINGS_DATABASE_FAILED";
          error.retryable = true;
          throw error;
        }
        return result;
      },
    };
    let paidCalls = 0;
    const syncService = createAutoListingAiModelSyncService({
      repository: responseLossRepository,
      gateway: {
        async listModels() {
          return {
            requestId: `models-missing-${suffix}`,
            models: [{ id: "text-model", ownedBy: "provider", metadata: {} }],
          };
        },
        async createTextResponse() { paidCalls += 1; throw new Error("paid call forbidden"); },
        async generateImage() { paidCalls += 1; throw new Error("paid call forbidden"); },
        async testCapabilities() { paidCalls += 1; throw new Error("paid call forbidden"); },
      },
      workerId: "worker-service-replay",
      timeoutMs: 30_000,
      clock: () => new Date("2026-08-08T12:00:00.000Z"),
    });
    const missingResult = await syncService.syncModelCatalog({
      accountId: missingLease.accountId,
      connectionId: missingLease.connectionId,
      connectionVersion: missingLease.connectionVersion,
      syncPurpose: missingLease.syncPurpose,
      targetConnectionStatusVersion: missingLease.targetConnectionStatusVersion,
      taskId: missingLease.taskId,
      attemptCount: missingLease.attemptCount,
      maxAttempts: missingLease.maxAttempts,
      leaseVersion: missingLease.leaseVersion,
      leaseToken: missingLease.leaseToken,
      leaseExpiresAt: missingLease.leaseExpiresAt,
      correlationId: `corr-sync-active-missing-complete-${suffix}`,
    });
    assert.equal(missingResult.status, "SUCCEEDED");
    assert.equal(missingResult.activeSelectionState, "MISSING");
    assert.equal(paidCalls, 0);
    const missingCatalog = (await pool.query(
      "SELECT catalog FROM ai_gateway_model_catalogs WHERE account_id=$1 AND sync_task_id=$2",
      [accountA, missingTask.id],
    )).rows[0].catalog;
    assert.equal(missingCatalog.activeSelectionState, "MISSING");
    assert.deepEqual(missingCatalog.activeSelection, {
      profileId: profile.id,
      configVersion: profile.configVersion,
      textModel: "text-model",
      imageModel: "image-model",
    });
    assert.equal(missingCatalog.connectionVersion, active.version);
    assert.match(missingCatalog.requestIdHash, /^[a-f0-9]{64}$/u);
    assert.equal(Object.hasOwn(missingCatalog, "requestId"), false);
    assert.equal(missingCatalog.recommendation.verified, false);
    assert.equal((await pool.query(
      "SELECT COUNT(*)::INTEGER AS count FROM ai_gateway_model_catalogs WHERE account_id=$1 AND sync_task_id=$2",
      [accountA, missingTask.id],
    )).rows[0].count, 1);

    const connectionB = await repository.createPendingConnection({
      accountId: accountB, actorId: accountB,
      idempotencyKey: `connection-daily-${suffix}`,
      correlationId: `corr-connection-daily-${suffix}`,
      displayName: "Daily sub2API",
      baseUrl: "http://127.0.0.1:8080/v1",
      encryptedSecret: { ...encryptedSecret, fingerprint: "fp-daily-b" },
    });
    const activeB = await repository.markConnectionValidated({
      accountId: accountB, actorId: accountB, connectionId: connectionB.id,
      connectionVersion: connectionB.version, expectedStatusVersion: 1,
      idempotencyKey: `activate-daily-${suffix}`,
      correlationId: `corr-activate-daily-${suffix}`,
      rollbackCapabilityEvidence: null,
      validationResult: { outcome: "PASSED", checkedAt: new Date().toISOString(), endpoint: "models" },
    });
    const scheduler = createAutoListingAiModelSyncSchedulePostgres({ pool });
    assert.deepEqual((await scheduler.listDueConnections({ afterAccountId: null, limit: 10 }))
      .map((entry) => entry.accountId), [accountB]);
    const dailyGateway = {
      async listModels() { return { requestId: "daily-models", models: [] }; },
    };
    const workerConfig = (workerId) => ({
      enabled: true,
      repository,
      scheduler,
      syncService: createAutoListingAiModelSyncService({
        repository, gateway: dailyGateway, workerId, timeoutMs: 30_000, clock: () => new Date(),
      }),
      workerId,
      pollIntervalMs: 60_000,
      accountPageSize: 10,
      logger: { log() {} },
      timers: { setTimeout() { return 1; }, clearTimeout() {} },
    });
    const [dailyA, dailyB] = await Promise.all([
      createAutoListingAiModelSyncWorker(workerConfig("daily-worker-a")).runOnce(),
      createAutoListingAiModelSyncWorker(workerConfig("daily-worker-b")).runOnce(),
    ]);
    assert.equal(dailyA.scheduled + dailyB.scheduled, 1);
    assert.equal(dailyA.succeeded + dailyB.succeeded, 1);
    const dailyTasks = (await pool.query(
      `SELECT status,idempotency_key FROM ai_gateway_model_sync_tasks
        WHERE account_id=$1 AND connection_id=$2 AND connection_version=$3
          AND idempotency_key LIKE 'aigsyncdaily_%'`,
      [accountB, activeB.id, activeB.version],
    )).rows;
    assert.equal(dailyTasks.length, 1);
    assert.equal(dailyTasks[0].status, "SUCCEEDED");
    assert.deepEqual(await scheduler.listDueConnections({ afterAccountId: null, limit: 10 }), []);

    const preflightRotationTask = await repository.enqueueModelSync({
      accountId: accountB, actorId: accountB, connectionId: activeB.id,
      connectionVersion: activeB.version,
      expectedConnectionStatusVersion: activeB.statusVersion,
      idempotencyKey: `sync-preflight-rotation-${suffix}`,
      correlationId: `corr-sync-preflight-rotation-${suffix}`,
      maxAttempts: 5, syncPurpose: "CATALOG_SYNC",
    });
    const preflightRotationLease = await repository.claimModelSync({
      accountId: accountB, workerId: "worker-preflight-rotation", leaseMs: 120_000,
      syncPurpose: "CATALOG_SYNC",
    });
    assert.equal(preflightRotationLease.taskId, preflightRotationTask.id);
    const activeBReplacement = await repository.createPendingConnection({
      accountId: accountB, actorId: accountB,
      idempotencyKey: `connection-preflight-rotation-${suffix}`,
      correlationId: `corr-connection-preflight-rotation-${suffix}`,
      displayName: "Preflight rotation replacement",
      baseUrl: "http://127.0.0.1:8080/v1",
      encryptedSecret: { ...encryptedSecret, fingerprint: "fp-preflight-rotation" },
    });
    await repository.markConnectionValidated({
      accountId: accountB, actorId: accountB, connectionId: activeBReplacement.id,
      connectionVersion: activeBReplacement.version, expectedStatusVersion: 1,
      idempotencyKey: `activate-preflight-rotation-${suffix}`,
      correlationId: `corr-activate-preflight-rotation-${suffix}`,
      rollbackCapabilityEvidence: null,
      validationResult: { outcome: "PASSED", checkedAt: new Date().toISOString(), endpoint: "models" },
    });
    let preflightGatewayCalls = 0;
    const preflightRotationService = createAutoListingAiModelSyncService({
      repository,
      gateway: {
        async listModels() {
          preflightGatewayCalls += 1;
          const error = new Error("connection changed before credential resolution");
          error.code = "AUTO_LISTING_AI_MODEL_SYNC_CONNECTION_STALE";
          error.retryable = false;
          throw error;
        },
      },
      workerId: "worker-preflight-rotation",
      timeoutMs: 30_000,
      clock: () => new Date(),
    });
    const preflightRotationResult = await preflightRotationService.syncModelCatalog({
      accountId: preflightRotationLease.accountId,
      connectionId: preflightRotationLease.connectionId,
      connectionVersion: preflightRotationLease.connectionVersion,
      syncPurpose: preflightRotationLease.syncPurpose,
      targetConnectionStatusVersion: preflightRotationLease.targetConnectionStatusVersion,
      taskId: preflightRotationLease.taskId,
      attemptCount: preflightRotationLease.attemptCount,
      maxAttempts: preflightRotationLease.maxAttempts,
      leaseVersion: preflightRotationLease.leaseVersion,
      leaseToken: preflightRotationLease.leaseToken,
      leaseExpiresAt: preflightRotationLease.leaseExpiresAt,
      correlationId: `corr-sync-preflight-rotation-run-${suffix}`,
    });
    assert.equal(preflightRotationResult.status, "DEAD");
    assert.equal(preflightRotationResult.lastErrorCode, "AUTO_LISTING_AI_MODEL_SYNC_CONNECTION_STALE");
    assert.equal(preflightGatewayCalls, 1);
    assert.equal((await pool.query(
      "SELECT COUNT(*)::INTEGER AS count FROM ai_gateway_model_catalogs WHERE account_id=$1 AND sync_task_id=$2",
      [accountB, preflightRotationTask.id],
    )).rows[0].count, 0);

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

    const firstOverviewPage = await repository.loadSettingsOverviewPage({
      accountId: accountA, connectionCursor: null, profileCursor: null, pageSize: 2,
    });
    assert.ok(firstOverviewPage.connections.length <= 2);
    assert.ok(firstOverviewPage.profiles.length <= 2);
    assert.equal(firstOverviewPage.activeConnection.id, active.id);
    assert.equal(firstOverviewPage.activeProfile.id, profile.id);
    assert.doesNotMatch(JSON.stringify(firstOverviewPage), /Y2lwaGVy|dGFn|ciphertext|authTag/iu);
    assert.ok(firstOverviewPage.pageInfo.connections.next);
    const secondOverviewPage = await repository.loadSettingsOverviewPage({
      accountId: accountA,
      connectionCursor: firstOverviewPage.pageInfo.connections.next,
      profileCursor: null,
      pageSize: 2,
    });
    const firstConnectionIds = new Set(firstOverviewPage.connections.map((row) => row.id));
    assert.equal(secondOverviewPage.connections.some((row) => firstConnectionIds.has(row.id)), false);
    assert.equal((await repository.loadSettingsConnection({
      accountId: accountA, connectionId: active.id, connectionVersion: Number(active.version),
    })).id, active.id);
    const latestVisibleCatalog = firstOverviewPage.catalogs.find((row) => row.connectionId === active.id);
    assert.ok(latestVisibleCatalog);
    const latestCatalog = await repository.loadSettingsCatalog({
      accountId: accountA, catalogId: latestVisibleCatalog.id,
    });
    assert.equal(latestCatalog.catalog.id, latestVisibleCatalog.id);
    assert.equal(latestCatalog.canCreateProfile, true);
    await assert.rejects(repository.loadSettingsCatalog({
      accountId: accountB, catalogId: latestVisibleCatalog.id,
    }), { code: "AUTO_LISTING_AI_SETTINGS_CATALOG_NOT_FOUND", status: 404 });

    const retryTask = await repository.enqueueModelSync({
      accountId: accountA,
      actorId: accountA,
      connectionId: active.id,
      connectionVersion: active.version,
      expectedConnectionStatusVersion: Number(active.status_version),
      idempotencyKey: `sync-retry-${suffix}`,
      correlationId: `corr-sync-retry-${suffix}`,
      maxAttempts: 5,
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
      maxAttempts: 5,
      syncPurpose: "CATALOG_SYNC",
    });
    let exhaustedLease;
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      exhaustedLease = await repository.claimModelSync({
        accountId: accountA, workerId: `worker-expiring-${attempt}`, leaseMs: 1,
      });
      assert.equal(exhaustedLease.taskId, exhaustedTask.id);
      assert.equal(exhaustedLease.attemptCount, attempt);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
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

    const replacement = await repository.createPendingConnection({
      ...createInput,
      idempotencyKey: `connection-rotation-${suffix}`,
      correlationId: `corr-connection-rotation-${suffix}`,
      displayName: "Rotation fence replacement",
      encryptedSecret: { ...encryptedSecret, fingerprint: "fp-rotation" },
    });
    const rotationTask = await repository.enqueueModelSync({
      accountId: accountA, actorId: accountA, connectionId: active.id,
      connectionVersion: active.version, expectedConnectionStatusVersion: Number(active.status_version),
      idempotencyKey: `sync-rotation-fence-${suffix}`,
      correlationId: `corr-sync-rotation-fence-${suffix}`,
      maxAttempts: 5, syncPurpose: "CATALOG_SYNC",
    });
    const rotationLease = await repository.claimModelSync({
      accountId: accountA, workerId: "worker-rotation", leaseMs: 120_000,
      syncPurpose: "CATALOG_SYNC",
    });
    const rotationService = createAutoListingAiModelSyncService({
      repository,
      gateway: {
        async listModels() {
          await repository.markConnectionValidated({
            accountId: accountA, actorId: accountA, connectionId: replacement.id,
            connectionVersion: replacement.version, expectedStatusVersion: 1,
            idempotencyKey: `activate-rotation-${suffix}`,
            correlationId: `corr-activate-rotation-${suffix}`,
            rollbackCapabilityEvidence: null,
            validationResult: { outcome: "PASSED", checkedAt: new Date().toISOString(), endpoint: "models" },
          });
          return { requestId: "models-after-rotation", models: [] };
        },
      },
      workerId: "worker-rotation",
      timeoutMs: 30_000,
      clock: () => new Date(),
    });
    const rotationResult = await rotationService.syncModelCatalog({
      accountId: rotationLease.accountId,
      connectionId: rotationLease.connectionId,
      connectionVersion: rotationLease.connectionVersion,
      syncPurpose: rotationLease.syncPurpose,
      targetConnectionStatusVersion: rotationLease.targetConnectionStatusVersion,
      taskId: rotationLease.taskId,
      attemptCount: rotationLease.attemptCount,
      maxAttempts: rotationLease.maxAttempts,
      leaseVersion: rotationLease.leaseVersion,
      leaseToken: rotationLease.leaseToken,
      leaseExpiresAt: rotationLease.leaseExpiresAt,
      correlationId: `corr-sync-rotation-complete-${suffix}`,
    });
    assert.equal(rotationResult.status, "DEAD");
    assert.equal(rotationResult.lastErrorCode, "AUTO_LISTING_AI_MODEL_SYNC_CONNECTION_STALE");
    assert.equal((await pool.query(
      "SELECT COUNT(*)::INTEGER AS count FROM ai_gateway_model_catalogs WHERE account_id=$1 AND sync_task_id=$2",
      [accountA, rotationTask.id],
    )).rows[0].count, 0);

    const historicalActive = (await pool.query(
      `SELECT id,version,status_version FROM ai_gateway_connection_versions
        WHERE account_id=$1 AND status='ACTIVE'`,
      [accountA],
    )).rows[0];
    const historicalAttemptTaskId = `historical-max-attempts-${suffix}`;
    await pool.query(
      `INSERT INTO ai_gateway_model_sync_tasks (
         account_id,id,connection_id,connection_version,sync_purpose,
         target_connection_status_version,status,status_version,attempt_count,max_attempts,
         request_hash,idempotency_key,correlation_id,created_by
       ) VALUES ($1,$2,$3,$4,'CATALOG_SYNC',$5,'PENDING',1,0,6,$6,$7,$8,$1)`,
      [accountA, historicalAttemptTaskId, historicalActive.id, historicalActive.version,
        historicalActive.status_version, "e".repeat(64), `historical-max-${suffix}`,
        `corr-historical-max-${suffix}`],
    );
    assert.equal(await repository.claimModelSync({
      accountId: accountA,
      workerId: "worker-historical-attempt-policy",
      leaseMs: 120_000,
      syncPurpose: "CATALOG_SYNC",
    }), null);
    assert.deepEqual((await pool.query(
      `SELECT status,last_error_code,attempt_count,max_attempts
         FROM ai_gateway_model_sync_tasks WHERE account_id=$1 AND id=$2`,
      [accountA, historicalAttemptTaskId],
    )).rows[0], {
      status: "DEAD",
      last_error_code: "AUTO_LISTING_AI_MODEL_SYNC_ATTEMPT_POLICY_INVALID",
      attempt_count: 1,
      max_attempts: 6,
    });
    assert.equal((await pool.query(
      `SELECT COUNT(*)::INTEGER AS count FROM ai_gateway_model_sync_events
        WHERE account_id=$1 AND task_id=$2 AND event_type='DEAD'`,
      [accountA, historicalAttemptTaskId],
    )).rows[0].count, 1);
    assert.equal((await pool.query(
      `SELECT COUNT(*)::INTEGER AS count FROM audit_events
        WHERE account_id=$1 AND entity_id=$2 AND action='AUTO_LISTING_AI_MODEL_SYNC_DEAD'`,
      [accountA, historicalAttemptTaskId],
    )).rows[0].count, 1);

    const catalogCipher = createAutoListingCredentialCipher({
      key: Buffer.alloc(32, 19), keyVersion: "catalog-sync-v1",
    });
    const catalogBaseUrl = "http://127.0.0.1:8080/v1";
    const catalogPlaintextSecret = "sk-catalog-real-resolver-chain";
    const deterministicConnectionId = (accountId, idempotencyKey) => `aigconn_${crypto
      .createHash("sha256").update([accountId, idempotencyKey].join("\0"), "utf8")
      .digest("hex").slice(0, 40)}`;
    async function createEncryptedConnection(accountId, label) {
      const idempotencyKey = `catalog-chain-${label}-${suffix}`;
      const connectionId = deterministicConnectionId(accountId, idempotencyKey);
      const encrypted = catalogCipher.encrypt({
        accountId, connectionId, connectionVersion: 1,
      }, catalogPlaintextSecret);
      const pending = await repository.createPendingConnection({
        accountId, actorId: accountId, idempotencyKey,
        correlationId: `corr-catalog-chain-${label}-${suffix}`,
        displayName: `Catalog resolver ${label}`,
        baseUrl: catalogBaseUrl,
        encryptedSecret: {
          ...encrypted,
          fingerprint: catalogCipher.fingerprint(catalogPlaintextSecret),
        },
      });
      assert.equal(pending.id, connectionId);
      return repository.markConnectionValidated({
        accountId, actorId: accountId, connectionId: pending.id,
        connectionVersion: pending.version, expectedStatusVersion: 1,
        idempotencyKey: `activate-catalog-chain-${label}-${suffix}`,
        correlationId: `corr-activate-catalog-chain-${label}-${suffix}`,
        rollbackCapabilityEvidence: null,
        validationResult: { outcome: "PASSED", checkedAt: new Date().toISOString(), endpoint: "models" },
      });
    }
    const catalogConnection = await createEncryptedConnection(accountC, "initial");
    const catalogCredentialResolver = createAutoListingAiCatalogSyncCredentialResolver({
      repository, cipher: catalogCipher,
    });
    let genericSecretReads = 0;
    let catalogTransportCalls = 0;
    const task4Gateway = createSub2ApiAdapter({
      fetchImpl: async (_url, init) => {
        catalogTransportCalls += 1;
        assert.equal(init.headers.Authorization, `Bearer ${catalogPlaintextSecret}`);
        return new Response(JSON.stringify({
          object: "list",
          data: [{ object: "model", id: "catalog-text", owned_by: "local-test" }],
        }), { status: 200, headers: { "content-type": "application/json" } });
      },
      readSecret: () => { throw new Error("environment resolver forbidden"); },
      resolveSecret: async () => { genericSecretReads += 1; throw new Error("generic resolver forbidden"); },
      resolveCatalogSyncCredential: catalogCredentialResolver.resolveCredential,
      allowLocalGateway: true,
      resolveHostname: async () => [{ address: "127.0.0.1", family: 4 }],
      allowedSecretEnvNames: [],
      allowedGatewayBaseUrls: [catalogBaseUrl],
    });
    const commandForLease = (leased, correlationId) => ({
      accountId: leased.accountId,
      connectionId: leased.connectionId,
      connectionVersion: leased.connectionVersion,
      syncPurpose: leased.syncPurpose,
      targetConnectionStatusVersion: leased.targetConnectionStatusVersion,
      taskId: leased.taskId,
      attemptCount: leased.attemptCount,
      maxAttempts: leased.maxAttempts,
      leaseVersion: leased.leaseVersion,
      leaseToken: leased.leaseToken,
      leaseExpiresAt: leased.leaseExpiresAt,
      correlationId,
    });
    const enqueueCatalogChain = (label, connection = catalogConnection) => repository.enqueueModelSync({
      accountId: accountC, actorId: accountC, connectionId: connection.id,
      connectionVersion: connection.version,
      expectedConnectionStatusVersion: connection.statusVersion,
      idempotencyKey: `sync-catalog-chain-${label}-${suffix}`,
      correlationId: `corr-sync-catalog-chain-${label}-${suffix}`,
      maxAttempts: 5, syncPurpose: "CATALOG_SYNC",
    });
    const catalogChainTask = await enqueueCatalogChain("success");
    const catalogChainLease = await repository.claimModelSync({
      accountId: accountC, workerId: "worker-catalog-chain", leaseMs: 120_000,
      syncPurpose: "CATALOG_SYNC",
    });
    assert.equal(catalogChainLease.taskId, catalogChainTask.id);
    const catalogChainService = createAutoListingAiModelSyncService({
      repository, gateway: task4Gateway, workerId: "worker-catalog-chain",
      timeoutMs: 30_000, clock: () => new Date(),
    });
    assert.equal((await catalogChainService.syncModelCatalog(commandForLease(
      catalogChainLease, `corr-catalog-chain-success-${suffix}`,
    ))).status, "SUCCEEDED");
    assert.deepEqual({ genericSecretReads, catalogTransportCalls }, {
      genericSecretReads: 0, catalogTransportCalls: 1,
    });

    const expiredChainTask = await enqueueCatalogChain("expired");
    const expiredChainLease = await repository.claimModelSync({
      accountId: accountC, workerId: "worker-catalog-expired", leaseMs: 1,
      syncPurpose: "CATALOG_SYNC",
    });
    assert.equal(expiredChainLease.taskId, expiredChainTask.id);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const expiredChainService = createAutoListingAiModelSyncService({
      repository, gateway: task4Gateway, workerId: "worker-catalog-expired",
      timeoutMs: 30_000, clock: () => new Date(),
    });
    await assert.rejects(expiredChainService.syncModelCatalog(commandForLease(
      expiredChainLease, `corr-catalog-chain-expired-${suffix}`,
    )), { code: "AUTO_LISTING_AI_MODEL_SYNC_LEASE_CONFLICT" });
    assert.equal(catalogTransportCalls, 1);
    const takeoverChainLease = await repository.claimModelSync({
      accountId: accountC, workerId: "worker-catalog-takeover", leaseMs: 120_000,
      syncPurpose: "CATALOG_SYNC",
    });
    await assert.rejects(expiredChainService.syncModelCatalog(commandForLease(
      expiredChainLease, `corr-catalog-chain-taken-over-${suffix}`,
    )), { code: "AUTO_LISTING_AI_MODEL_SYNC_LEASE_CONFLICT" });
    assert.equal(catalogTransportCalls, 1);
    assert.equal((await repository.failModelSync({
      accountId: accountC, workerId: "worker-catalog-takeover",
      taskId: takeoverChainLease.taskId, leaseVersion: takeoverChainLease.leaseVersion,
      leaseToken: takeoverChainLease.leaseToken,
      correlationId: `corr-catalog-chain-takeover-dead-${suffix}`,
      errorCode: "AUTO_LISTING_AI_MODEL_SYNC_TEST_TERMINAL",
      errorSafe: "test lease terminalized", retryable: false, retryDelayMs: 0,
    })).status, "DEAD");

    const rotationChainTask = await enqueueCatalogChain("rotation");
    const rotationChainLease = await repository.claimModelSync({
      accountId: accountC, workerId: "worker-catalog-rotation", leaseMs: 120_000,
      syncPurpose: "CATALOG_SYNC",
    });
    assert.equal(rotationChainLease.taskId, rotationChainTask.id);
    await createEncryptedConnection(accountC, "replacement");
    const rotationChainService = createAutoListingAiModelSyncService({
      repository, gateway: task4Gateway, workerId: "worker-catalog-rotation",
      timeoutMs: 30_000, clock: () => new Date(),
    });
    const rotationChainResult = await rotationChainService.syncModelCatalog(commandForLease(
      rotationChainLease, `corr-catalog-chain-rotation-${suffix}`,
    ));
    assert.equal(rotationChainResult.status, "DEAD");
    assert.equal(rotationChainResult.lastErrorCode, "AUTO_LISTING_AI_MODEL_SYNC_CONNECTION_STALE");
    assert.deepEqual({ genericSecretReads, catalogTransportCalls }, {
      genericSecretReads: 0, catalogTransportCalls: 1,
    });
    assert.equal((await pool.query(
      `SELECT COUNT(*)::INTEGER AS count FROM ai_gateway_model_catalogs
        WHERE account_id=$1 AND sync_task_id IN ($2,$3)`,
      [accountC, expiredChainTask.id, rotationChainTask.id],
    )).rows[0].count, 0);

    const channelCandidate = await repository.createPendingConnection({
      ...createInput, idempotencyKey: `channel-candidate-${suffix}`,
      correlationId: `channel-candidate-corr-${suffix}`, displayName: "Channel candidate",
      encryptedSecret: { ...encryptedSecret, fingerprint: `channel-candidate-fp-${suffix}` },
    });
    await pool.query(
      `UPDATE ai_gateway_connection_versions SET status='VALIDATED',status_version=status_version+1,
          validation_result='{"outcome":"PASSED"}'::JSONB,validation_hash=$4,validated_at=NOW(),validated_by=$1
        WHERE account_id=$1 AND id=$2 AND version=$3`,
      [accountA, channelCandidate.id, channelCandidate.version, "c".repeat(64)],
    );
    const channelProofProfileId = `channel-proof-${suffix}`;
    await pool.query(
      `INSERT INTO ai_gateway_profiles (
         id,account_id,display_name,base_url,api_key_env_name,text_protocol,image_protocol,
         text_model,image_model,config_version,enabled,created_by,connection_id,connection_version
       ) VALUES ($1,$2,'Candidate proof','https://gateway.example/v1','SUB2API_ENCRYPTED_KEY',$3,$4,$5,$6,1,FALSE,$2,$7,$8)`,
      [channelProofProfileId, accountA, profile.textProtocol, profile.imageProtocol, profile.textModel,
        profile.imageModel, channelCandidate.id, channelCandidate.version],
    );
    const channelCapability = { outcome: "PASSED", features: ["STRUCTURED_TEXT", "IMAGE_GENERATION", "IMAGE_DECODE_PNG"],
      latencyMs: 1, models: { text: profile.textModel, image: profile.imageModel },
      checkedAt: new Date().toISOString(), errorCode: null };
    await pool.query(
      "UPDATE ai_gateway_profiles SET capability_result=$4::JSONB,capability_checked_at=$5 WHERE account_id=$1 AND id=$2 AND config_version=$3",
      [accountA, channelProofProfileId, 1, JSON.stringify(channelCapability), channelCapability.checkedAt],
    );
    async function seedChannelCapability(attemptId) {
      const response = { profileId: channelProofProfileId, configVersion: 1,
        ...channelCapability, enabled: true };
      const digest = crypto.createHash("sha256").update(attemptId).digest("hex");
      await pool.query(
        `INSERT INTO ai_gateway_capability_attempts (
           id,account_id,profile_id,config_version,correlation_id,lease_token,lease_expires_at,status,
           completion_hash,response,completed_at,authorization_schema_version,purpose,cost_confirmed,
           authorization_hash,request_key,actor_id,target_connection_id,target_connection_version,
           target_connection_status,target_connection_status_version,authorized_at
         ) VALUES ($1,$2,$3,$4,$5,$6,NOW(),'PASSED',$7,$8::JSONB,NOW(),
           'AI_GATEWAY_CAPABILITY_AUTHORIZATION_V1','PROFILE_CAPABILITY',TRUE,$7,$7,$2,$9,$10,'VALIDATED',$11,NOW())`,
        [attemptId, accountA, channelProofProfileId, 1, `corr-${attemptId}`, `lease-${attemptId}`,
          digest, JSON.stringify(response), channelCandidate.id, channelCandidate.version, 2],
      );
      await pool.query(
        `INSERT INTO audit_events (
           event_id,account_id,store_id,action,status,actor_type,actor_id,device_id,source,
           entity_type,entity_id,correlation_id,metadata,occurred_at,created_at
         ) VALUES ($1,$2,NULL,'AUTO_LISTING_AI_PROFILE_CAPABILITY_TEST','SUCCESS','account',$2,'',
           'auto-listing-ai-admin','ai_gateway_profile',$3,$4,$5::JSONB,NOW(),NOW())`,
        [`audit-${attemptId}`, accountA, channelProofProfileId, `corr-${attemptId}`,
          JSON.stringify({ attemptId, purpose: "PROFILE_CAPABILITY" })],
      );
    }
    await seedChannelCapability(`channel-capability-${suffix}`);
    await pool.query("UPDATE ai_gateway_profiles SET text_model='wrong-text' WHERE account_id=$1 AND id=$2 AND config_version=1", [accountA, channelProofProfileId]);
    assert.equal((await repository.listProfileChannels({ accountId: accountA, profileId: profile.id, profileVersion: profile.configVersion }))
      .channelCandidates.some((row) => row.connectionId === channelCandidate.id), false, "a passed proof with a mismatched text model is excluded");
    await pool.query("UPDATE ai_gateway_profiles SET text_model=$3 WHERE account_id=$1 AND id=$2 AND config_version=1", [accountA, channelProofProfileId, profile.textModel]);
    await pool.query("UPDATE ai_gateway_profiles SET image_model='wrong-image' WHERE account_id=$1 AND id=$2 AND config_version=1", [accountA, channelProofProfileId]);
    assert.equal((await repository.listProfileChannels({ accountId: accountA, profileId: profile.id, profileVersion: profile.configVersion }))
      .channelCandidates.some((row) => row.connectionId === channelCandidate.id), false, "a passed proof with a mismatched image model is excluded");
    await pool.query("UPDATE ai_gateway_profiles SET image_model=$3 WHERE account_id=$1 AND id=$2 AND config_version=1", [accountA, channelProofProfileId, profile.imageModel]);
    const otherImageProtocol = profile.imageProtocol === "SUB2API_OPENAI_IMAGES" ? "SUB2API_RESPONSES_IMAGE_TOOL" : "SUB2API_OPENAI_IMAGES";
    await pool.query("UPDATE ai_gateway_profiles SET image_protocol=$3 WHERE account_id=$1 AND id=$2 AND config_version=1", [accountA, channelProofProfileId, otherImageProtocol]);
    assert.equal((await repository.listProfileChannels({ accountId: accountA, profileId: profile.id, profileVersion: profile.configVersion }))
      .channelCandidates.some((row) => row.connectionId === channelCandidate.id), false, "a passed proof with a mismatched image protocol is excluded");
    await pool.query("UPDATE ai_gateway_profiles SET image_protocol=$3 WHERE account_id=$1 AND id=$2 AND config_version=1", [accountA, channelProofProfileId, profile.imageProtocol]);
    const beforeAdd = await repository.listProfileChannels({
      accountId: accountA, profileId: profile.id, profileVersion: profile.configVersion,
    });
    assert.deepEqual(beforeAdd.channelCandidates.map((row) => row.connectionId), [channelCandidate.id]);
    const addedChannel = await repository.addProfileChannel({
      accountId: accountA, actorAccountId: accountA, profileId: profile.id, profileVersion: profile.configVersion,
      connectionId: channelCandidate.id, connectionVersion: channelCandidate.version, displayName: "Candidate channel",
    });
    assert.equal(addedChannel.channelOrder, 2);
    await assert.rejects(repository.addProfileChannel({
      accountId: accountB, actorAccountId: accountB, profileId: profile.id, profileVersion: profile.configVersion,
      connectionId: channelCandidate.id, connectionVersion: channelCandidate.version, displayName: "Foreign",
    }), { code: "AUTO_LISTING_AI_PROFILE_CHANNEL_NOT_CURRENT", status: 409 });
    await assert.rejects(repository.addProfileChannel({
      accountId: accountA, actorAccountId: accountA, profileId: profile.id, profileVersion: profile.configVersion,
      connectionId: channelCandidate.id, connectionVersion: channelCandidate.version + 1, displayName: "Wrong version",
    }), { code: "AUTO_LISTING_AI_PROFILE_CHANNEL_CONNECTION_INCOMPATIBLE", status: 409 });
    const unvalidated = await repository.createPendingConnection({
      ...createInput, idempotencyKey: `channel-unvalidated-${suffix}`,
      correlationId: `channel-unvalidated-corr-${suffix}`, displayName: "Unvalidated",
      encryptedSecret: { ...encryptedSecret, fingerprint: `channel-unvalidated-fp-${suffix}` },
    });
    await assert.rejects(repository.addProfileChannel({
      accountId: accountA, actorAccountId: accountA, profileId: profile.id, profileVersion: profile.configVersion,
      connectionId: unvalidated.id, connectionVersion: unvalidated.version, displayName: "Unvalidated channel",
    }), { code: "AUTO_LISTING_AI_PROFILE_CHANNEL_CONNECTION_INCOMPATIBLE", status: 409 });
    const busyStore = `channel-store-${suffix}`;
    const busyWarehouse = `channel-warehouse-${suffix}`;
    const busyStrategy = `channel-strategy-${suffix}`;
    const busySnapshot = `channel-snapshot-${suffix}`;
    const busyJob = `channel-job-${suffix}`;
    const busyItem = `channel-item-${suffix}`;
    await pool.query("INSERT INTO stores (id,label,company_name,client_id,status,owner_account_id) VALUES ($1,$1,$1,$2,'active',$3)",
      [busyStore, `client-${suffix}`, accountA]);
    await pool.query("INSERT INTO warehouses (id,store_id,warehouse_id,warehouse_type,status,is_active,is_archived) VALUES ($1,$2,$1,'FBS','active',TRUE,FALSE)",
      [busyWarehouse, busyStore]);
    await pool.query("INSERT INTO ai_content_strategy_versions (id,account_id,strategy_key,version,status,content,content_hash) VALUES ($1,$2,'channel',1,'DRAFT','{}'::JSONB,$3)",
      [busyStrategy, accountA, "d".repeat(64)]);
    await pool.query("INSERT INTO auto_listing_source_snapshots (id,account_id,source_type,source_record_id,source_version,snapshot,snapshot_hash) VALUES ($1,$2,'COLLECT_BOX',$1,'1','{}'::JSONB,$3)",
      [busySnapshot, accountA, "e".repeat(64)]);
    await pool.query("INSERT INTO auto_listing_jobs (id,account_id,source_type,idempotency_key,config_hash,strategy_version_id) VALUES ($1,$2,'COLLECT_BOX',$1,$3,$4)",
      [busyJob, accountA, "f".repeat(64), busyStrategy]);
    await pool.query("INSERT INTO auto_listing_job_items (id,job_id,account_id,snapshot_id,target_store_id,target_warehouse_id,status,status_version,source_order) VALUES ($1,$2,$3,$4,$5,$6,'SOURCE_READY',1,1)",
      [busyItem, busyJob, accountA, busySnapshot, busyStore, busyWarehouse]);
    const busy = await pool.query(
      `UPDATE auto_listing_ai_profile_channels SET assigned_job_id=$5,assigned_item_id=$6,
          assigned_status_version=1,assigned_at=NOW(),execution_lease_owner='worker',execution_lease_token='lease',
          execution_lease_expires_at=NOW()+INTERVAL '1 minute'
        WHERE account_id=$1 AND profile_id=$2 AND profile_version=$3 AND channel_id=$4 RETURNING assigned_item_id,assigned_status_version,execution_lease_token`,
      [accountA, profile.id, profile.configVersion, addedChannel.channelId, busyJob, busyItem],
    );
    assert.equal(busy.rowCount, 1);
    const disabledChannel = await repository.setProfileChannelEnabled({
      accountId: accountA, actorAccountId: accountA, profileId: profile.id, profileVersion: profile.configVersion,
      channelId: addedChannel.channelId, enabled: false,
    });
    assert.equal(disabledChannel.status, "DISABLED");
    assert.deepEqual((await pool.query(
      "SELECT assigned_item_id,assigned_status_version,execution_lease_token FROM auto_listing_ai_profile_channels WHERE account_id=$1 AND profile_id=$2 AND profile_version=$3 AND channel_id=$4",
      [accountA, profile.id, profile.configVersion, addedChannel.channelId],
    )).rows[0], { assigned_item_id: busyItem, assigned_status_version: 1, execution_lease_token: "lease" });
    assert.equal(Number((await pool.query(
      "SELECT COUNT(*)::INTEGER AS count FROM audit_events WHERE account_id=$1 AND action='AUTO_LISTING_AI_PROFILE_CHANNEL_SET_ENABLED'",
      [accountA],
    )).rows[0].count), 1);
    assert.equal((await repository.setProfileChannelEnabled({
      accountId: accountA, actorAccountId: accountA, profileId: profile.id, profileVersion: profile.configVersion,
      channelId: addedChannel.channelId, enabled: false,
    })).enabled, false);
    assert.equal(Number((await pool.query(
      "SELECT COUNT(*)::INTEGER AS count FROM audit_events WHERE account_id=$1 AND action='AUTO_LISTING_AI_PROFILE_CHANNEL_SET_ENABLED'",
      [accountA],
    )).rows[0].count), 1, "repeated disable is a no-op without a duplicate audit event");
    await pool.query(
      `UPDATE auto_listing_ai_profile_channels SET requires_revalidation=TRUE,
          updated_at=(SELECT completed_at FROM ai_gateway_capability_attempts WHERE account_id=$1 AND id=$5)
        WHERE account_id=$1 AND profile_id=$2 AND profile_version=$3 AND channel_id=$4`,
      [accountA, profile.id, profile.configVersion, addedChannel.channelId, `channel-capability-${suffix}`],
    );
    await assert.rejects(repository.setProfileChannelEnabled({
      accountId: accountA, actorAccountId: accountA, profileId: profile.id, profileVersion: profile.configVersion,
      channelId: addedChannel.channelId, enabled: true,
    }), { code: "AUTO_LISTING_AI_PROFILE_CHANNEL_REVALIDATION_REQUIRED", status: 409 });
    await seedChannelCapability(`channel-revalidation-${suffix}`);
    assert.equal((await repository.setProfileChannelEnabled({
      accountId: accountA, actorAccountId: accountA, profileId: profile.id, profileVersion: profile.configVersion,
      channelId: addedChannel.channelId, enabled: true,
    })).enabled, true);
    assert.equal((await repository.setProfileChannelEnabled({
      accountId: accountA, actorAccountId: accountA, profileId: profile.id, profileVersion: profile.configVersion,
      channelId: addedChannel.channelId, enabled: true,
    })).enabled, true);
    assert.equal(Number((await pool.query(
      "SELECT COUNT(*)::INTEGER AS count FROM audit_events WHERE account_id=$1 AND action='AUTO_LISTING_AI_PROFILE_CHANNEL_SET_ENABLED'",
      [accountA],
    )).rows[0].count), 2, "repeated eligible enable is a no-op without a duplicate audit event");
    assert.equal((await repository.setProfileChannelEnabled({
      accountId: accountA, actorAccountId: accountA, profileId: profile.id, profileVersion: profile.configVersion,
      channelId: addedChannel.channelId, enabled: false,
    })).enabled, false);
    assert.equal((await repository.setProfileChannelEnabled({
      accountId: accountA, actorAccountId: accountA, profileId: profile.id, profileVersion: profile.configVersion,
      channelId: addedChannel.channelId, enabled: false,
    })).enabled, false);
    assert.equal(Number((await pool.query(
      "SELECT COUNT(*)::INTEGER AS count FROM audit_events WHERE account_id=$1 AND action='AUTO_LISTING_AI_PROFILE_CHANNEL_SET_ENABLED'",
      [accountA],
    )).rows[0].count), 3, "rapid disable-enable-disable creates one audit per real transition only");
    const channelAudits = (await pool.query(
      `SELECT metadata FROM audit_events WHERE account_id=$1 AND action='AUTO_LISTING_AI_PROFILE_CHANNEL_SET_ENABLED'
       ORDER BY occurred_at,id`, [accountA],
    )).rows.map((row) => row.metadata);
    assert.equal(channelAudits.every((metadata) => metadata.profileId === profile.id
      && metadata.profileVersion === profile.configVersion && metadata.channelId === addedChannel.channelId
      && metadata.connectionId === channelCandidate.id && metadata.connectionVersion === channelCandidate.version
      && ["ENABLE", "DISABLE"].includes(metadata.action) && metadata.result === "SUCCESS"
      && JSON.stringify(metadata).includes("lease") === false), true);

    const activeForHistory = (await pool.query(
      "SELECT id,version FROM ai_gateway_connection_versions WHERE account_id=$1 AND status='ACTIVE'",
      [accountA],
    )).rows[0];
    const historicProfileId = `historic-profile-${suffix}`;
    await pool.query(
      `INSERT INTO ai_gateway_profiles (id,account_id,display_name,base_url,api_key_env_name,text_protocol,image_protocol,
         text_model,image_model,config_version,enabled,created_by,connection_id,connection_version)
       VALUES ($1,$2,'Historical','https://gateway.example/v1','SUB2API_ENCRYPTED_KEY',$3,$4,$5,$6,1,FALSE,$2,$7,$8)`,
      [historicProfileId, accountA, profile.textProtocol, profile.imageProtocol, profile.textModel, profile.imageModel,
        activeForHistory.id, activeForHistory.version],
    );
    await pool.query(
      `INSERT INTO auto_listing_ai_profile_channels (account_id,profile_id,profile_version,channel_id,display_name,
         connection_id,connection_version,channel_order,enabled)
       VALUES ($1,$2,1,'primary','Historical',$3,$4,1,TRUE)`,
      [accountA, historicProfileId, activeForHistory.id, activeForHistory.version],
    );
    await assert.rejects(repository.setProfileChannelEnabled({
      accountId: accountA, actorAccountId: accountA, profileId: historicProfileId, profileVersion: 1,
      channelId: "primary", enabled: true,
    }), { code: "AUTO_LISTING_AI_PROFILE_CHANNEL_NOT_CURRENT", status: 409 });
    assert.equal((await repository.setProfileChannelEnabled({
      accountId: accountA, actorAccountId: accountA, profileId: historicProfileId, profileVersion: 1,
      channelId: "primary", enabled: false,
    })).enabled, false, "disabled historical channels remain safely disableable");

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
    for (const token of [seedLease.leaseToken, rollbackLease.leaseToken,
      secondEvidenceLease.leaseToken, expiredSecretLease.leaseToken, staleLease.leaseToken, leased.leaseToken,
      reclaimed.leaseToken, emptyLease.leaseToken, singleLease.leaseToken,
      retryLease.leaseToken, finalLease.leaseToken, exhaustedLease.leaseToken]) {
      assert.doesNotMatch(workerAudits.map((row) => row.metadata).join("\n"), new RegExp(token, "u"));
    }

    const retainedAuditCount = (await pool.query(
      "SELECT COUNT(*)::INTEGER AS count FROM audit_events WHERE account_id=$1 AND source='auto-listing-ai-settings'",
      [accountA],
    )).rows[0].count;
    assert.equal(Number(retainedAuditCount) > 0, true);
    assert.equal((await pool.query("SELECT COUNT(*)::INTEGER AS count FROM accounts WHERE id=$1", [accountA])).rows[0].count, 1);
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
