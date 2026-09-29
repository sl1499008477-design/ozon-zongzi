import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const connectionString = process.env.SONLI_MIGRATION_TEST_DATABASE_URL;
const enabled = process.env.AUTO_LISTING_POSTGRES_TESTS === "1" && Boolean(connectionString);
const migrationsDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../db/migrations");
const H = (digit) => digit.repeat(64);
const canonical = (value) => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const digest = (value) => crypto.createHash("sha256")
  .update(JSON.stringify(canonical(value))).digest("hex");
const quote = (value) => `"${String(value).replaceAll('"', '""')}"`;

function reserve(ids, overrides = {}) {
  return {
    accountId: ids.accountA, jobId: ids.job, itemId: ids.item, analysisRunId: ids.run,
    sourceAssetId: ids.asset, expectedStatusVersion: 7,
    derivativeAttemptId: ids.attempt1, inputHash: H("1"), attemptNo: 1,
    originalContentHash: H("2"), overlayDecisionHash: H("3"),
    promptVersion: "source-cleanup-prompt-v1", ...overrides,
  };
}

function scope(ids, overrides = {}) {
  const input = reserve(ids, overrides);
  return Object.fromEntries(["accountId", "jobId", "itemId", "analysisRunId", "sourceAssetId",
    "expectedStatusVersion", "derivativeAttemptId"].map((key) => [key, input[key]]));
}

function generated(ids, overrides = {}) {
  return {
    ...scope(ids, overrides),
    generatedObjectKey: `auto-listing/source-derivative/v1/${ids.accountA}/${ids.job}/${ids.item}/${ids.run}/${ids.asset}/candidate.png`,
    generatedContentHash: H("4"), generatedContentType: "image/png",
    generatedWidth: 1024, generatedHeight: 1024, generatedSizeBytes: 4096,
    editGatewayRequestId: "edit-request-a",
    editModelEvidence: {
      requestedImageModel: "gpt-image-2", gatewayReportedImageModel: "gpt-image-2",
      gatewayReportedImageModelPresent: true, orchestratorModel: "",
    },
    editGatewayConnectionId: null, editGatewayConnectionVersion: null, ...overrides,
  };
}

function checkResult(ids, overrides = {}) {
  return {
    contractVersion: "AUTO_LISTING_SOURCE_IMAGE_CLEANUP_CHECK_V1",
    derivativeAttemptId: ids.attempt1, sourceAssetId: ids.asset,
    originalContentHash: H("2"), candidateContentHash: H("4"),
    overlayRemoved: true, productIdentityPreserved: true, nativeMarksPreserved: true,
    geometryPreserved: true, noInventedContent: true, reasonCodes: [], ...overrides,
  };
}

function checked(ids, overrides = {}) {
  const result = overrides.checkResult ?? checkResult(ids);
  return {
    ...scope(ids, overrides), checkResult: result, cleanupEvidenceHash: digest(result),
    checkerGatewayRequestId: "check-request-a",
    checkerModelEvidence: {
      requestedTextModel: "gpt-5.4", gatewayReportedTextModel: "gpt-5.4",
      gatewayReportedTextModelPresent: true,
    },
    checkerGatewayConnectionId: null, checkerGatewayConnectionVersion: null, ...overrides,
  };
}

test("PostgreSQL cleanup attempts preserve replay scope uniqueness and terminal immutability", {
  skip: enabled ? false : "requires AUTO_LISTING_POSTGRES_TESTS=1 and SONLI_MIGRATION_TEST_DATABASE_URL",
  timeout: 120_000,
}, async () => {
  const { Pool } = await import("pg");
  const { createAutoListingSourceImageDerivativeRepository } = await import(
    "../auto-listing-source-image-derivative-repository.mjs"
  );
  const adminPool = new Pool({ connectionString, max: 1 });
  const client = await adminPool.connect();
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const schema = `source_image_derivative_${suffix}`;
  const ids = Object.fromEntries([
    "accountA", "accountB", "store", "warehouse", "strategy", "snapshot", "job", "item",
    "profile", "run", "asset", "attempt1", "attempt2",
  ].map((key) => [key, `${key}-${suffix}`]));
  let pool;
  try {
    await client.query(`CREATE SCHEMA ${quote(schema)}`);
    await client.query(`SET search_path TO ${quote(schema)}, public`);
    const migrations = (await readdir(migrationsDirectory))
      .filter((file) => /^\d{3}_.+\.sql$/u.test(file)).sort();
    assert.equal(migrations.at(-1), "105_auto_listing_source_image_derivatives.sql");
    for (const migration of migrations) {
      await client.query(await readFile(path.join(migrationsDirectory, migration), "utf8"));
    }
    for (const accountId of [ids.accountA, ids.accountB]) {
      await client.query(
        "INSERT INTO accounts (id,username,display_name,role,status) VALUES ($1,$1,$1,'admin','active')",
        [accountId],
      );
    }
    await client.query(
      "INSERT INTO stores (id,label,company_name,client_id,status,owner_account_id) VALUES ($1,$1,$1,$2,'active',$3)",
      [ids.store, `client-${suffix}`, ids.accountA],
    );
    await client.query(
      "INSERT INTO warehouses (id,store_id,warehouse_id,warehouse_type,status,is_active,is_archived) VALUES ($1,$2,$1,'FBS','active',TRUE,FALSE)",
      [ids.warehouse, ids.store],
    );
    await client.query(
      "INSERT INTO ai_content_strategy_versions (id,account_id,strategy_key,version,status,content,content_hash) VALUES ($1,$2,'default',1,'PUBLISHED','{}'::JSONB,$3)",
      [ids.strategy, ids.accountA, H("5")],
    );
    await client.query(
      `INSERT INTO ai_gateway_profiles (
        id,account_id,display_name,base_url,api_key_env_name,text_protocol,image_protocol,
        text_model,image_model,config_version,enabled
      ) VALUES ($1,$2,'Profile','https://gateway.invalid','TEST_KEY','SUB2API_RESPONSES',
        'SUB2API_OPENAI_IMAGES','gpt-5.4','gpt-image-2',1,FALSE)`,
      [ids.profile, ids.accountA],
    );
    await client.query(
      "INSERT INTO auto_listing_source_snapshots (id,account_id,source_type,source_record_id,source_version,snapshot,snapshot_hash) VALUES ($1,$2,'COLLECT_BOX',$3,'1','{}'::JSONB,$4)",
      [ids.snapshot, ids.accountA, `record-${suffix}`, H("6")],
    );
    await client.query(
      `INSERT INTO auto_listing_jobs (
        id,account_id,source_type,idempotency_key,config_hash,strategy_version_id,ai_profile_id,ai_profile_version
      ) VALUES ($1,$2,'COLLECT_BOX',$3,$4,$5,$6,1)`,
      [ids.job, ids.accountA, `job-${suffix}`, H("7"), ids.strategy, ids.profile],
    );
    await client.query(
      `INSERT INTO auto_listing_job_items (
        id,job_id,account_id,snapshot_id,target_store_id,target_warehouse_id,status,status_version,source_order
      ) VALUES ($1,$2,$3,$4,$5,$6,'PLANNING',7,1)`,
      [ids.item, ids.job, ids.accountA, ids.snapshot, ids.store, ids.warehouse],
    );
    await client.query(
      `INSERT INTO auto_listing_source_image_analysis_runs (
        id,account_id,job_id,item_id,source_snapshot_id,expected_status_version,
        intelligence_contract_version,source_snapshot_hash,source_asset_set_hash,input_hash,
        prompt_template_version,profile_id,profile_version,model_name,expected_asset_count,
        terminal_asset_count,status,parent_run_id,derivation_kind,decision_set,decision_set_hash
      ) VALUES ($1,$2,$3,$4,$5,7,'AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_V2',$6,$7,$8,
        'source-image-analysis-v2',$9,1,'gpt-5.4',1,1,'ANALYZING',NULL,'INITIAL','[]'::JSONB,$10)`,
      [ids.run, ids.accountA, ids.job, ids.item, ids.snapshot, H("6"), H("8"), H("9"),
        ids.profile, digest([])],
    );
    await client.query(
      "UPDATE auto_listing_job_items SET current_source_image_analysis_run_id=$4 WHERE account_id=$1 AND job_id=$2 AND id=$3",
      [ids.accountA, ids.job, ids.item, ids.run],
    );
    await client.query(
      `INSERT INTO auto_listing_source_image_assessments (
        account_id,job_id,item_id,analysis_run_id,expected_status_version,source_asset_id,
        source_ordinal,record_status,source_ref_hash,object_key,content_hash,content_type,size_bytes,
        materialized_at,terminal_status,analysis_batch_id,batch_input_hash,batch_result_hash,input_hash,
        result_hash,assessment,error_code,accepted_at
      ) VALUES ($1,$2,$3,$4,7,$5,0,'ACCEPTED',$6,$7,$8,'image/png',4096,NOW(),
        'ANALYZED','batch-a',$9,$10,$11,$12,'{}'::JSONB,NULL,NOW())`,
      [ids.accountA, ids.job, ids.item, ids.run, ids.asset, H("a"),
        `auto-listing/source/v2/${ids.accountA}/${ids.job}/${ids.item}/analysis-run/${ids.run}/${ids.asset}/source.png`,
        H("2"), H("b"), H("c"), H("d"), H("e")],
    );

    pool = new Pool({
      connectionString, max: 2, options: `-c search_path=${schema},public`,
    });
    let rowSequence = 0;
    const repository = createAutoListingSourceImageDerivativeRepository({
      query: (text, values) => pool.query(text, values),
      id: () => `derivative-row-${++rowSequence}-${suffix}`,
      leaseToken: () => `derivative-lease-${rowSequence}-${suffix}`,
    });
    const reserved = await repository.reserveAttempt(reserve(ids));
    assert.deepEqual(await repository.reserveAttempt(reserve(ids)), reserved);
    const candidate = await repository.recordGeneratedCandidate(generated(ids));
    assert.equal(candidate.status, "GENERATED");
    assert.deepEqual(await repository.loadAttempt(scope(ids)), candidate);
    const accepted = await repository.recordCheckResult(checked(ids));
    assert.equal(accepted.status, "ACCEPTED");
    assert.equal((await repository.listAcceptedBindings({
      accountId: ids.accountA, jobId: ids.job, itemId: ids.item, analysisRunId: ids.run,
    })).length, 1);
    assert.equal(await repository.loadAttempt(scope(ids, { accountId: ids.accountB })), null);

    await assert.rejects(client.query(
      "DELETE FROM auto_listing_source_image_derivatives WHERE account_id=$1 AND derivative_attempt_id=$2",
      [ids.accountA, ids.attempt1],
    ), { code: "23514" });
    await assert.rejects(client.query(
      "UPDATE auto_listing_source_image_derivatives SET prompt_version='changed' WHERE account_id=$1 AND derivative_attempt_id=$2",
      [ids.accountA, ids.attempt1],
    ), { code: "23514" });
  } finally {
    if (pool) await pool.end();
    await client.query("RESET search_path").catch(() => {});
    await client.query(`DROP SCHEMA IF EXISTS ${quote(schema)} CASCADE`).catch(() => {});
    client.release();
    await adminPool.end();
  }
});

