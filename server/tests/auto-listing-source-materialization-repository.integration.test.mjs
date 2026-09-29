import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { SOURCE_IMAGE_INTELLIGENCE_CONTRACT_VERSION } from "../auto-listing-source-image-intelligence-contract.mjs";
import { createPostgresSourceImageIntelligenceRepository } from "../auto-listing-source-image-intelligence-repository.mjs";
import {
  buildSourceMaterializationObjectKey,
  createPostgresSourceMaterializationRepository,
} from "../auto-listing-source-materialization-repository.mjs";

const enabled = process.env.AUTO_LISTING_POSTGRES_TESTS === "1"
  && Boolean(process.env.SONLI_MIGRATION_TEST_DATABASE_URL);
const migrationsDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../db/migrations");

test("PostgreSQL adapter binds analysis reservations and transitions to source_analysis_run_id", async () => {
  const scope = {
    accountId: "account-a",
    jobId: "job-a",
    itemId: "item-a",
    owner: { kind: "SOURCE_IMAGE_ANALYSIS", id: "analysis-run-a" },
    sourceAssetId: "source-a",
    sourceRefHash: "a".repeat(64),
    inputHash: "b".repeat(64),
    expectedStatusVersion: 7,
  };
  const row = (overrides = {}) => ({
    id: "attempt-a",
    account_id: scope.accountId,
    job_id: scope.jobId,
    item_id: scope.itemId,
    parent_plan_id: null,
    source_analysis_run_id: scope.owner.id,
    source_asset_id: scope.sourceAssetId,
    source_ref_hash: scope.sourceRefHash,
    input_hash: scope.inputHash,
    expected_status_version: scope.expectedStatusVersion,
    attempt_no: 1,
    status: "MATERIALIZING",
    lease_owner: "source-materializer",
    lease_token: "lease-a:1",
    lease_expires_at: new Date("2026-08-30T01:00:00.000Z"),
    object_key_version: null,
    object_key: null,
    content_hash: null,
    content_type: null,
    width: null,
    height: null,
    size_bytes: null,
    accepted_at: null,
    error_code: null,
    error_retryable: null,
    created_at: new Date("2026-08-30T00:00:00.000Z"),
    updated_at: new Date("2026-08-30T00:00:00.000Z"),
    ...overrides,
  });
  const calls = [];
  let evidence;
  const handler = async (sql, parameters) => {
    calls.push({ sql, parameters });
    if (/^(BEGIN|COMMIT|ROLLBACK)$/u.test(sql)) return { rows: [], rowCount: 0 };
    if (/JOIN auto_listing_source_image_analysis_runs AS analysis/u.test(sql)) {
      return { rows: [{ status: "PLANNING", status_version: 7 }], rowCount: 1 };
    }
    if (/SET status='STORED'/u.test(sql)) {
      return { rows: [row({
        status: "STORED",
        object_key_version: evidence.objectKeyVersion,
        object_key: evidence.objectKey,
        content_hash: evidence.contentHash,
        content_type: evidence.contentType,
        width: evidence.width,
        height: evidence.height,
        size_bytes: evidence.sizeBytes,
      })], rowCount: 1 };
    }
    if (/SET status='ACCEPTED'/u.test(sql)) {
      return { rows: [row({
        status: "ACCEPTED",
        lease_owner: null,
        lease_token: null,
        lease_expires_at: null,
        accepted_at: new Date("2026-08-30T00:00:01.000Z"),
        object_key_version: evidence.objectKeyVersion,
        object_key: evidence.objectKey,
        content_hash: evidence.contentHash,
        content_type: evidence.contentType,
        width: evidence.width,
        height: evidence.height,
        size_bytes: evidence.sizeBytes,
      })], rowCount: 1 };
    }
    if (/status='ACCEPTED'/u.test(sql)) return { rows: [], rowCount: 0 };
    if (/status IN \('MATERIALIZING','STORED'\).*lease_expires_at > NOW\(\)/su.test(sql)) return { rows: [], rowCount: 0 };
    if (/SET lease_owner=\$9/u.test(sql)) return { rows: [], rowCount: 0 };
    if (/SET status='FAILED'/u.test(sql)) return { rows: [], rowCount: 0 };
    if (/COALESCE\(MAX\(attempt_no\),0\)/u.test(sql)) return { rows: [{ attempt_no: 0 }], rowCount: 1 };
    if (/INSERT INTO auto_listing_source_materialization_attempts/u.test(sql)) return { rows: [row()], rowCount: 1 };
    throw new Error(`unexpected SQL: ${sql}`);
  };
  const client = { query: handler, async release() {} };
  const pool = { query: handler, async connect() { return client; } };
  const repository = createPostgresSourceMaterializationRepository({
    pool,
    token: () => "lease-a",
    id: () => "attempt-a",
  });
  const lease = await repository.reserveSourceMaterialization({ ...scope, maxAttempts: 3 });
  const content = {
    objectKeyVersion: "SOURCE_V2",
    contentHash: "c".repeat(64),
    contentType: "image/png",
    width: 9,
    height: 12,
    sizeBytes: 128,
  };
  evidence = {
    ...scope,
    attemptId: lease.attemptId,
    attemptNo: lease.attemptNo,
    leaseToken: lease.leaseToken,
    ...content,
    objectKey: buildSourceMaterializationObjectKey({ ...scope, attemptNo: lease.attemptNo, ...content }),
  };
  assert.equal((await repository.recordStoredSourceMaterialization(evidence)).status, "STORED");
  assert.equal((await repository.completeSourceMaterialization(evidence)).status, "ACCEPTED");
  const sql = calls.map(({ sql: statement }) => statement).join("\n");
  assert.match(sql, /source_analysis_run_id=\$4/u);
  assert.match(sql, /item\.current_source_image_analysis_run_id=analysis\.id/u);
  assert.doesNotMatch(sql, /attempt\.parent_plan_id=\$4/u);
});

test("PostgreSQL adapter returns the exact last safe analysis failure when attempts are exhausted", async () => {
  const scope = {
    accountId: "account-a",
    jobId: "job-a",
    itemId: "item-a",
    owner: { kind: "SOURCE_IMAGE_ANALYSIS", id: "analysis-run-a" },
    sourceAssetId: "source-a",
    sourceRefHash: "a".repeat(64),
    inputHash: "b".repeat(64),
    expectedStatusVersion: 7,
  };
  const failedRow = {
    id: "attempt-c",
    account_id: scope.accountId,
    job_id: scope.jobId,
    item_id: scope.itemId,
    parent_plan_id: null,
    source_analysis_run_id: scope.owner.id,
    source_asset_id: scope.sourceAssetId,
    source_ref_hash: scope.sourceRefHash,
    input_hash: scope.inputHash,
    expected_status_version: scope.expectedStatusVersion,
    attempt_no: 3,
    status: "FAILED",
    lease_owner: null,
    lease_token: null,
    lease_expires_at: null,
    object_key_version: null,
    object_key: null,
    content_hash: null,
    content_type: null,
    width: null,
    height: null,
    size_bytes: null,
    accepted_at: null,
    error_code: "AUTO_LISTING_SOURCE_DOWNLOAD_FAILED",
    error_retryable: true,
    created_at: new Date("2026-08-30T00:00:00.000Z"),
    updated_at: new Date("2026-08-30T00:00:01.000Z"),
  };
  const handler = async (sql) => {
    if (/^(BEGIN|COMMIT|ROLLBACK)$/u.test(sql)) return { rows: [], rowCount: 0 };
    if (/JOIN auto_listing_source_image_analysis_runs AS analysis/u.test(sql)) {
      return { rows: [{ status: "PLANNING", status_version: 7 }], rowCount: 1 };
    }
    if (/status='ACCEPTED'/u.test(sql)) return { rows: [], rowCount: 0 };
    if (/status IN \('MATERIALIZING','STORED'\).*lease_expires_at > NOW\(\)/su.test(sql)) return { rows: [], rowCount: 0 };
    if (/SET lease_owner=\$9/u.test(sql)) return { rows: [], rowCount: 0 };
    if (/SET status='FAILED'/u.test(sql)) return { rows: [], rowCount: 0 };
    if (/COALESCE\(MAX\(attempt_no\),0\)/u.test(sql)) return { rows: [{ attempt_no: 3 }], rowCount: 1 };
    if (/attempt_no=\$9 AND status='FAILED'/u.test(sql)) return { rows: [failedRow], rowCount: 1 };
    throw new Error(`unexpected SQL: ${sql}`);
  };
  const client = { query: handler, async release() {} };
  const repository = createPostgresSourceMaterializationRepository({
    pool: { query: handler, async connect() { return client; } },
    token: () => "unused-lease",
    id: () => "unused-attempt",
  });

  const replay = await repository.reserveSourceMaterialization({ ...scope, maxAttempts: 3 });

  assert.equal(replay.status, "EXHAUSTED_SAFE_FAILURE");
  assert.equal(replay.record.attemptNo, 3);
  assert.equal(replay.record.errorCode, "AUTO_LISTING_SOURCE_DOWNLOAD_FAILED");
  assert.deepEqual(replay.record.owner, scope.owner);
});

test("PostgreSQL persists analysis-owned SOURCE_V2 attempts and cleanup obligations after migration 103", {
  skip: enabled ? false : "requires AUTO_LISTING_POSTGRES_TESTS=1 and SONLI_MIGRATION_TEST_DATABASE_URL",
}, async () => {
  const { Pool } = await import("pg");
  const adminPool = new Pool({ connectionString: process.env.SONLI_MIGRATION_TEST_DATABASE_URL, max: 1 });
  const schema = `source_materialization_${randomUUID().replaceAll("-", "")}`;
  const suffix = randomUUID().replaceAll("-", "");
  const ids = Object.fromEntries([
    "account", "store", "warehouse", "strategy", "snapshot", "job", "item", "profile",
  ].map((key) => [key, `${key}-${suffix}`]));
  const client = await adminPool.connect();
  let pool;
  try {
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}, public`);
    const migrations = (await readdir(migrationsDirectory))
      .filter((file) => /^\d{3}_.+\.sql$/u.test(file))
      .sort();
    for (const migration of migrations) {
      await client.query(await readFile(path.join(migrationsDirectory, migration), "utf8"));
    }
    await client.query(
      "INSERT INTO accounts (id,username,display_name,role,status) VALUES ($1,$2,$2,'admin','active')",
      [ids.account, `user-${suffix}`],
    );
    await client.query(
      "INSERT INTO stores (id,label,company_name,client_id,status,owner_account_id) VALUES ($1,$1,$1,$2,'active',$3)",
      [ids.store, `client-${suffix}`, ids.account],
    );
    await client.query(
      "INSERT INTO warehouses (id,store_id,warehouse_id,warehouse_type,status,is_active,is_archived) VALUES ($1,$2,$1,'FBS','active',TRUE,FALSE)",
      [ids.warehouse, ids.store],
    );
    await client.query(
      "INSERT INTO ai_content_strategy_versions (id,account_id,strategy_key,version,status,content,content_hash) VALUES ($1,$2,'default',1,'PUBLISHED','{}'::JSONB,$3)",
      [ids.strategy, ids.account, "a".repeat(64)],
    );
    await client.query(
      `INSERT INTO ai_gateway_profiles (
        id,account_id,display_name,base_url,api_key_env_name,text_protocol,image_protocol,
        text_model,image_model,config_version,enabled
      ) VALUES ($1,$2,'Profile','https://gateway.invalid','TEST_KEY','SUB2API_RESPONSES',
        'SUB2API_OPENAI_IMAGES','text-model','vision-model',1,FALSE)`,
      [ids.profile, ids.account],
    );
    await client.query(
      "INSERT INTO auto_listing_source_snapshots (id,account_id,source_type,source_record_id,source_version,snapshot,snapshot_hash) VALUES ($1,$2,'COLLECT_BOX',$3,'1','{}'::JSONB,$4)",
      [ids.snapshot, ids.account, `record-${suffix}`, "b".repeat(64)],
    );
    await client.query(
      `INSERT INTO auto_listing_jobs (
        id,account_id,source_type,idempotency_key,config_hash,strategy_version_id,ai_profile_id,ai_profile_version
      ) VALUES ($1,$2,'COLLECT_BOX',$3,$4,$5,$6,1)`,
      [ids.job, ids.account, `job-${suffix}`, "c".repeat(64), ids.strategy, ids.profile],
    );
    await client.query(
      `INSERT INTO auto_listing_job_items (
        id,job_id,account_id,snapshot_id,target_store_id,target_warehouse_id,status,status_version,source_order
      ) VALUES ($1,$2,$3,$4,$5,$6,'PLANNING',7,1)`,
      [ids.item, ids.job, ids.account, ids.snapshot, ids.store, ids.warehouse],
    );
    pool = new Pool({
      connectionString: process.env.SONLI_MIGRATION_TEST_DATABASE_URL,
      max: 2,
      options: `-c search_path=${schema},public`,
    });
    const intelligenceRepository = createPostgresSourceImageIntelligenceRepository({
      pool,
      id: () => `analysis-run-${suffix}`,
      token: () => `analysis-token-${suffix}`,
    });
    const analysisRun = await intelligenceRepository.reserveAnalysisRun({
      accountId: ids.account,
      jobId: ids.job,
      itemId: ids.item,
      sourceSnapshotId: ids.snapshot,
      expectedStatusVersion: 7,
      contractVersion: SOURCE_IMAGE_INTELLIGENCE_CONTRACT_VERSION,
      sourceSnapshotHash: "b".repeat(64),
      sourceAssetSetHash: "d".repeat(64),
      inputHash: "e".repeat(64),
      promptTemplateVersion: "source-image-analysis-v1",
      profileId: ids.profile,
      profileVersion: 1,
      modelName: "vision-model",
      expectedAssetCount: 2,
    });
    let sequence = 0;
    const repository = createPostgresSourceMaterializationRepository({
      pool,
      token: () => `lease-${++sequence}`,
      id: () => `materialization-${sequence}-${suffix}`,
    });
    const base = {
      accountId: ids.account,
      jobId: ids.job,
      itemId: ids.item,
      owner: { kind: "SOURCE_IMAGE_ANALYSIS", id: analysisRun.id },
      sourceAssetId: "source-analysis-a",
      sourceRefHash: "f".repeat(64),
      inputHash: "1".repeat(64),
      expectedStatusVersion: 7,
    };
    const lease = await repository.reserveSourceMaterialization({ ...base, maxAttempts: 3 });
    const content = {
      objectKeyVersion: "SOURCE_V2",
      contentHash: "2".repeat(64),
      contentType: "image/png",
      width: 9,
      height: 12,
      sizeBytes: 128,
    };
    const evidence = {
      ...base,
      attemptId: lease.attemptId,
      attemptNo: lease.attemptNo,
      leaseToken: lease.leaseToken,
      ...content,
      objectKey: buildSourceMaterializationObjectKey({ ...base, attemptNo: lease.attemptNo, ...content }),
    };
    assert.equal((await repository.recordStoredSourceMaterialization(evidence)).status, "STORED");
    const accepted = await repository.completeSourceMaterialization(evidence);
    assert.equal(accepted.status, "ACCEPTED");
    assert.deepEqual(accepted.owner, base.owner);
    assert.equal(Object.hasOwn(accepted, "parentPlanId"), false);

    const secondBase = {
      ...base,
      sourceAssetId: "source-analysis-b",
      sourceRefHash: "3".repeat(64),
      inputHash: "4".repeat(64),
    };
    const secondLease = await repository.reserveSourceMaterialization({ ...secondBase, maxAttempts: 3 });
    const secondEvidence = {
      ...secondBase,
      attemptId: secondLease.attemptId,
      attemptNo: secondLease.attemptNo,
      leaseToken: secondLease.leaseToken,
      ...content,
      contentHash: "5".repeat(64),
    };
    secondEvidence.objectKey = buildSourceMaterializationObjectKey(secondEvidence);
    const cleanup = await repository.recordSourceObjectCleanupRequired({
      ...secondBase,
      materializationAttemptId: secondLease.attemptId,
      attemptNo: secondLease.attemptNo,
      leaseToken: secondLease.leaseToken,
      objectKeyVersion: secondEvidence.objectKeyVersion,
      objectKey: secondEvidence.objectKey,
      contentHash: secondEvidence.contentHash,
      contentType: secondEvidence.contentType,
      width: secondEvidence.width,
      height: secondEvidence.height,
      sizeBytes: secondEvidence.sizeBytes,
      reasonCode: "AUTO_LISTING_SOURCE_OBJECT_UNREFERENCED",
      originalErrorCode: "AUTO_LISTING_SOURCE_MATERIALIZATION_CLAIM_REJECTED",
    });
    assert.equal(cleanup.status, "PENDING");
    assert.deepEqual(cleanup.owner, base.owner);

    const persisted = await pool.query(
      `SELECT parent_plan_id,source_analysis_run_id,object_key_version,object_key
        FROM auto_listing_source_materialization_attempts
        WHERE account_id=$1 AND id=$2`,
      [ids.account, lease.attemptId],
    );
    assert.deepEqual({
      parentPlanId: persisted.rows[0].parent_plan_id,
      analysisRunId: persisted.rows[0].source_analysis_run_id,
      objectKeyVersion: persisted.rows[0].object_key_version,
    }, {
      parentPlanId: null,
      analysisRunId: analysisRun.id,
      objectKeyVersion: "SOURCE_V2",
    });
    assert.match(persisted.rows[0].object_key, /\/analysis-run\//u);
  } finally {
    await pool?.end().catch(() => {});
    await client.query("SET search_path TO public").catch(() => {});
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    client.release();
    await adminPool.end().catch(() => {});
  }
});
