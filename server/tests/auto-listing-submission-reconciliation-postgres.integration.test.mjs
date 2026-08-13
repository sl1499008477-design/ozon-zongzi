import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createPostgresAutoListingSubmissionReconciliationRepository } from "../auto-listing-submission-reconciliation-postgres.mjs";
import { createAutoListingSubmissionReconciler } from "../auto-listing-submission-reconciler.mjs";

const databaseUrl = process.env.AUTO_LISTING_RECONCILIATION_TEST_DATABASE_URL || "";
const enabled = process.env.RUN_AUTO_LISTING_RECONCILIATION_PG === "1"
  && /auto_listing_test/iu.test(databaseUrl);
const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../db/migrations");

function quote(value) { return `"${value.replaceAll('"', '""')}"`; }

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonical(value[key])]),
  );
  return value;
}

function stableHash(value) {
  return crypto.createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function categoryEvidence(offerId = "offer-a") {
  return {
    schemaVersion: "OZON_CATEGORY_IMPORT_ERROR_EVIDENCE_V1",
    policyVersion: "ozon-category-policy.v2",
    errorCode: "CATEGORY_INVALID",
    field: "description_category_id",
    attributeId: null,
    state: "FAILED",
    offerId,
    productId: null,
    classification: "EXPLICIT_CATEGORY_FAILURE",
  };
}

test("durable reconciliation survives an expired lease and applies one tenant-scoped terminal result", {
  skip: !enabled,
  timeout: 60_000,
}, async () => {
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  const owner = await pool.connect();
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const schema = `auto_listing_reconcile_${suffix}`;
  const schemaSql = quote(schema);
  const accountA = `account-a-${suffix}`;
  const accountB = `account-b-${suffix}`;
  const h = "a".repeat(64);
  const h2 = "c".repeat(64);
  try {
    await owner.query(`CREATE SCHEMA ${schemaSql}`);
    await owner.query(`SET search_path TO ${schemaSql},public`);
    const migrationFiles = (await readdir(migrationsDir))
      .filter((file) => /^\d{3}_.+\.sql$/u.test(file)).sort();
    for (const migration of migrationFiles) {
      await owner.query(await readFile(path.join(migrationsDir, migration), "utf8"));
    }
    await owner.query(`CREATE TABLE IF NOT EXISTS schema_migrations(
      version TEXT PRIMARY KEY,applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    for (const migration of migrationFiles) {
      await owner.query("INSERT INTO schema_migrations(version) VALUES($1) ON CONFLICT DO NOTHING",
        [migration.replace(/\.sql$/u, "")]);
    }
    for (const accountId of [accountA, accountB]) {
      await owner.query(
        "INSERT INTO accounts (id,username,display_name,role,status) VALUES ($1,$2,$2,'admin','active')",
        [accountId, `user-${accountId}`],
      );
    }
    await owner.query(
      `INSERT INTO stores (id,label,client_id,status,owner_account_id)
       VALUES ('store-a','Store A','client-a','active',$1)`, [accountA],
    );
    await owner.query(
      `INSERT INTO warehouses (id,store_id,warehouse_id,warehouse_type,status,is_active,is_archived)
       VALUES ('warehouse-a','store-a','platform-warehouse-a','FBS','active',TRUE,FALSE)`,
    );
    await owner.query(
      `INSERT INTO collect_items (id,account_id,source_sku,summary)
       VALUES ('collect-a',$1,'sku-a','{}'::jsonb)`, [accountA],
    );
    await owner.query(
      `INSERT INTO collect_raw_payloads (id,collect_item_id,account_id,source_sku,payload_hash,payload,collected_at)
       VALUES ('raw-a','collect-a',$1,'sku-a','raw-hash-a','{}'::jsonb,NOW())`, [accountA],
    );
    await owner.query(
      `INSERT INTO product_drafts (id,collect_item_id,source_payload_id,version,data_hash,data)
       VALUES ('draft-a','collect-a','raw-a',1,$1,'{}'::jsonb)`, [h],
    );
    await owner.query(
      `INSERT INTO ai_content_strategy_versions
        (id,account_id,strategy_key,version,status,content,content_hash,published_at,published_by,created_by)
       VALUES ('strategy-a',$1,'default',1,'PUBLISHED','{}'::jsonb,$2,NOW(),$1,$1)`, [accountA, h],
    );
    await owner.query(
      `INSERT INTO ai_gateway_profiles
        (id,account_id,display_name,base_url,api_key_env_name,text_protocol,image_protocol,
         text_model,image_model,config_version,enabled,created_by)
       VALUES ('profile-a',$1,'Profile','https://gateway.invalid','TEST_AI_KEY','SUB2API_RESPONSES',
         'SUB2API_OPENAI_IMAGES','text-model','image-model',1,FALSE,$1)`, [accountA],
    );
    await owner.query(
      `INSERT INTO auto_listing_upload_policy_versions
        (id,account_id,mode,enabled,version,publication_reason,created_by,published_by,published_at,
         publication_origin,publication_base_url,publication_prefix,publication_version,publication_policy_hash)
       VALUES ('policy-a',$1,'REVIEW',TRUE,1,'integration',$1,$1,NOW(),
         'https://assets.invalid','https://assets.invalid/listing/','listing','V1',$2)`, [accountA, h],
    );
    await owner.query(
      `INSERT INTO auto_listing_source_snapshots
        (id,account_id,source_type,source_record_id,source_version,snapshot,snapshot_hash,raw_response_ref)
       VALUES ('source-a',$1,'COLLECT_BOX','collect-a','1','{}'::jsonb,$2,'raw-a')`, [accountA, h],
    );
    await owner.query(
      `INSERT INTO auto_listing_jobs
        (id,account_id,source_type,status,idempotency_key,config_snapshot,config_hash,
         strategy_version_id,created_by,correlation_id,upload_policy_version_id)
       VALUES ('job-a',$1,'COLLECT_BOX','UPLOADING','job-key-a','{}'::jsonb,$2,
         'strategy-a',$1,'job-correlation-a','policy-a')`, [accountA, h],
    );
    await owner.query(
      `INSERT INTO auto_listing_job_items
        (id,job_id,account_id,snapshot_id,target_store_id,target_warehouse_id,status,status_version)
       VALUES ('item-a','job-a',$1,'source-a','store-a','warehouse-a','UPLOADING',8)`, [accountA],
    );
    await owner.query(
      `INSERT INTO ai_content_plans
        (id,account_id,job_id,item_id,source_snapshot_id,strategy_version_id,profile_id,
         strategy_hash,config_hash,source_hash,input_hash,planner_model,profile_version,
         prompt_template_version,plan,plan_hash)
       VALUES ('plan-a',$1,'job-a','item-a','source-a','strategy-a','profile-a',
         $2,$2,$2,$2,'text-model',1,'V1','{}'::jsonb,$2)`, [accountA, h],
    );
    await owner.query("UPDATE auto_listing_job_items SET active_content_plan_id='plan-a' WHERE id='item-a'");
    await owner.query(
      `INSERT INTO auto_listing_listing_bases
        (id,account_id,job_id,item_id,source_snapshot_id,collect_item_id,target_store_id,
         product_draft_id,product_draft_version,product_draft_data_hash,ozon_ready_variants,
         pricing_evidence,rich_content_attribute_supported,listing_base_version,canonical_hash,
         normalizer_version,category_rule_version,dictionary_version)
       VALUES ('base-a',$1,'job-a','item-a','source-a','collect-a','store-a','draft-a',1,$2,
         '[]'::jsonb,jsonb_build_object('currency','RUB','evidenceHash',$2::text),FALSE,
         'AUTO_LISTING_LISTING_BASE_V1',$2,'V1','V1','V1')`, [accountA, h],
    );
    const originalCategoryItems = [{
      offer_id: "offer-a", sku: "sku-a", description_category_id: 10, type_id: 20,
      attributes: [], price: "1", currency_code: "RUB",
    }];
    await owner.query(
      `INSERT INTO submission_snapshots
        (id,collect_item_id,draft_id,draft_version,account_id,store_id,idempotency_key,
         snapshot_hash,item_count,items,stocks)
       VALUES ('submission-snapshot-a','collect-a','draft-a',1,$1,'store-a','snapshot-key-a',$2,1,
         $3::jsonb,'[]'::jsonb)`, [accountA, h, JSON.stringify(originalCategoryItems)],
    );
    await owner.query(
      `INSERT INTO submission_jobs
        (id,snapshot_id,collect_item_id,account_id,store_id,status,correlation_id,item_count,ozon_task_id)
       VALUES ('submission-a','submission-snapshot-a','collect-a',$1,'store-a','FAILED',
         'submission-correlation-a',1,'ozon-task-original')`, [accountA],
    );
    await owner.query(
      `INSERT INTO submission_items
        (id,job_id,snapshot_id,variant_key,offer_id,sku,status,product_id,response)
       VALUES ('submission-item-a','submission-a','submission-snapshot-a','variant-a','offer-a','sku-a',
         'FAILED','',$1::jsonb)`, [JSON.stringify({
        schemaVersion: "OZON_SUBMISSION_ITEM_RESPONSE_V1", rawResponse: {},
        errorEvidence: categoryEvidence(),
      })],
    );
    await owner.query(`INSERT INTO collect_ozon_category_source_evidence(
      id,account_id,source_kind,source_record_id,source_version,collect_item_id,product_draft_id,
      source_description_category_id,source_type_id,taxonomy_scope,captured_at,raw_response_hash,
      raw_response_ref,product_raw_response_ref,provenance)
      VALUES('category-source-a',$1,'PRODUCT_DRAFT','draft-a','1','collect-a','draft-a',
        10,20,'OZON:DEFAULT',NOW(),$2,'raw-a','raw-a','{}'::jsonb)`, [accountA, h]);
    await owner.query(`INSERT INTO account_ozon_shared_categories(
      id,account_id,source_description_category_id,source_type_id,taxonomy_scope,
      current_description_category_id,current_type_id,status,source,version,source_evidence_id,
      created_at,updated_at)
      VALUES('category-shared-a',$1,10,20,'OZON:DEFAULT',10,20,'ACTIVE','SOURCE_DIRECT',1,
        'category-source-a','2026-08-13T00:00:00.000Z','2026-08-13T00:00:00.000Z')`, [accountA]);
    await owner.query(`INSERT INTO submission_category_error_evidence(
      id,account_id,submission_job_id,submission_snapshot_id,submission_item_id,offer_id,
      original_ozon_task_id,original_snapshot_hash,original_items,source_evidence_id,
      old_shared_category_id,old_shared_category_version,classifier_policy_version,safe_evidence)
      VALUES('category-error-a',$1,'submission-a','submission-snapshot-a','submission-item-a','offer-a',
        'ozon-task-original',$2,$3::jsonb,'category-source-a','category-shared-a',1,
        'ozon-category-policy.v2',$4::jsonb)`,
    [accountA, h, JSON.stringify(originalCategoryItems), JSON.stringify(categoryEvidence())]);
    await owner.query(`INSERT INTO submission_category_recovery_attempts(
      id,account_id,submission_job_id,submission_snapshot_id,triggering_error_evidence_id,
      source_evidence_id,old_shared_category_id,old_shared_category_version,original_ozon_task_id,
      original_snapshot_hash,status,correlation_id,claimed_at,updated_at)
      VALUES('category-attempt-a',$1,'submission-a','submission-snapshot-a','category-error-a',
        'category-source-a','category-shared-a',1,'ozon-task-original',$2,'CLAIMED',
        'submission-correlation-a','2026-08-13T00:00:01.000Z','2026-08-13T00:00:01.000Z')`,
    [accountA, h]);
    const retrySubmitCases = ["notsent", "local", "persist", "schedule",
      "watchdog-submit", "watchdog-validating", "watchdog-accepted",
      "watchdog-wrong-tenant", "watchdog-ambiguous", "watchdog-pending-legal",
      "watchdog-pending-queue", "watchdog-pending-queued", "watchdog-pending-task",
      "watchdog-pending-correlation", "watchdog-pending-tuple"];
    for (const label of retrySubmitCases) {
      await owner.query(`INSERT INTO submission_snapshots(
        id,collect_item_id,draft_id,draft_version,account_id,store_id,idempotency_key,
        snapshot_hash,item_count,items,stocks)
        VALUES($2,'collect-a','draft-a',1,$1,'store-a',$3,$4,1,$5::jsonb,'[]'::jsonb)`,
      [accountA, `submission-snapshot-${label}`, `snapshot-key-${label}`, h,
        JSON.stringify(originalCategoryItems)]);
      await owner.query(`INSERT INTO submission_jobs(
        id,snapshot_id,collect_item_id,account_id,store_id,status,correlation_id,item_count,ozon_task_id)
        VALUES($2,$3,'collect-a',$1,'store-a','FAILED',$4,1,$5)`,
      [accountA, `submission-${label}`, `submission-snapshot-${label}`,
        `submission-correlation-${label}`, `ozon-task-original-${label}`]);
      await owner.query(`INSERT INTO submission_items(
        id,job_id,snapshot_id,variant_key,offer_id,sku,status,product_id,response)
        VALUES($1,$2,$3,$4,'offer-a','sku-a','FAILED','',$5::jsonb)`,
      [`submission-item-${label}`, `submission-${label}`,
        `submission-snapshot-${label}`, `variant-${label}`, JSON.stringify({
          schemaVersion: "OZON_SUBMISSION_ITEM_RESPONSE_V1", rawResponse: {},
          errorEvidence: categoryEvidence(),
        })]);
      await owner.query(`INSERT INTO submission_category_error_evidence(
        id,account_id,submission_job_id,submission_snapshot_id,submission_item_id,offer_id,
        original_ozon_task_id,original_snapshot_hash,original_items,source_evidence_id,
        old_shared_category_id,old_shared_category_version,classifier_policy_version,safe_evidence)
        VALUES($2,$1,$3,$4,$5,'offer-a',$6,$7,$8::jsonb,'category-source-a',
          'category-shared-a',1,'ozon-category-policy.v2',$9::jsonb)`,
      [accountA, `category-error-${label}`, `submission-${label}`,
        `submission-snapshot-${label}`, `submission-item-${label}`,
        `ozon-task-original-${label}`, h, JSON.stringify(originalCategoryItems),
        JSON.stringify(categoryEvidence())]);
      await owner.query(`INSERT INTO submission_category_recovery_attempts(
        id,account_id,submission_job_id,submission_snapshot_id,triggering_error_evidence_id,
        source_evidence_id,old_shared_category_id,old_shared_category_version,original_ozon_task_id,
        original_snapshot_hash,status,correlation_id,claimed_at,updated_at)
        VALUES($2,$1,$3,$4,$5,'category-source-a','category-shared-a',1,$6,$7,'CLAIMED',$8,
          '2026-08-13T00:00:01.000Z','2026-08-13T00:00:01.000Z')`,
      [accountA, `category-attempt-${label}`, `submission-${label}`,
        `submission-snapshot-${label}`, `category-error-${label}`,
        `ozon-task-original-${label}`, h, `submission-correlation-${label}`]);
    }
    await owner.query(`UPDATE account_ozon_shared_categories
      SET status='INVALIDATED',version=2,safe_failure_code='OZON_CATEGORY_INVALIDATED',
          updated_at='2026-08-13T00:00:02.000Z'
      WHERE account_id=$1 AND id='category-shared-a'`, [accountA]);
    await owner.query(`UPDATE account_ozon_shared_categories
      SET current_description_category_id=30,current_type_id=40,status='ACTIVE',source='OZON_REFRESH',
          version=3,taxonomy_fingerprint=$2,safe_failure_code='',validated_at='2026-08-13T00:00:03.000Z',
          updated_at='2026-08-13T00:00:03.000Z'
      WHERE account_id=$1 AND id='category-shared-a'`, [accountA, "b".repeat(64)]);
    const correctedCategoryItems = [{ ...originalCategoryItems[0], description_category_id: 30,
      type_id: 40, attributes: [{ complex_id: 0, id: 1, values: [{ value: "required" }] }] }];
    const categoryMetadata = { descriptionCategoryId: 30, typeId: 40, attributes: [
      { id: 1, complexId: 0, required: true, dictionaryId: null, dictionaryValues: [] },
    ] };
    const correctedHash = stableHash(correctedCategoryItems);
    await owner.query(`UPDATE submission_category_recovery_attempts
      SET status='MATCHED',corrected_items=$2::jsonb,corrected_items_hash=$3,
          replacement_shared_category_id='category-shared-a',replacement_shared_category_version=3,
          replacement_category_metadata=$4::jsonb,updated_at='2026-08-13T00:00:04.000Z'
      WHERE account_id=$1 AND id='category-attempt-a'`,
    [accountA, JSON.stringify(correctedCategoryItems), correctedHash, JSON.stringify(categoryMetadata)]);
    for (const label of retrySubmitCases) {
      await owner.query(`UPDATE submission_category_recovery_attempts
        SET status='MATCHED',corrected_items=$2::jsonb,corrected_items_hash=$3,
            replacement_shared_category_id='category-shared-a',replacement_shared_category_version=3,
            replacement_category_metadata=$4::jsonb,updated_at='2026-08-13T00:00:04.000Z'
        WHERE account_id=$1 AND id=$5`,
      [accountA, JSON.stringify(correctedCategoryItems), correctedHash,
        JSON.stringify(categoryMetadata), `category-attempt-${label}`]);
      await owner.query(`UPDATE submission_category_recovery_attempts
        SET status='RETRY_PENDING',updated_at='2026-08-13T00:00:05.000Z'
        WHERE account_id=$1 AND id=$2`, [accountA, `category-attempt-${label}`]);
    }
    await owner.query(`UPDATE submission_category_recovery_attempts
      SET status='RETRY_PENDING',updated_at='2026-08-13T00:00:05.000Z'
      WHERE account_id=$1 AND id='category-attempt-a'`, [accountA]);
    const pipelineUrl = new URL(databaseUrl);
    pipelineUrl.searchParams.set("options", `-c search_path=${schema},public`);
    process.env.DATABASE_URL = pipelineUrl.toString();
    const pipeline = await import(`../listing-pipeline.mjs?task8=${suffix}`);
    const listingWorker = await import(`../listing-worker.mjs?task8fix2=${suffix}`);
    const recoveryController = listingWorker.createListingWorkerCategoryRecoveryController({
      async beginCategoryRecovery() { throw new Error("must not begin another recovery"); },
      async recoverCategory() { throw new Error("must not refresh or import again"); },
      persistRetryResults: pipeline.persistSubmissionCategoryRetryResultsV3,
      markRetryAccepted: pipeline.markSubmissionCategoryRetryAcceptedV3,
      completeRecovery: pipeline.completeSubmissionCategoryRecoveryV3,
      requireRecoveryReview: pipeline.requireSubmissionCategoryRecoveryReviewV3,
      reviewUncertainRetry: pipeline.requireSubmissionCategoryRetryUncertainReviewV3,
    });
    const submitFailureErrors = new Map([
      ["notsent", { code: "SUBMISSION_NOT_SENT" }],
      ["local", { code: "LISTING_RFBS_PHASE_VALIDATION_REQUIRED" }],
      ["persist", { code: "LISTING_CATEGORY_RECOVERY_TRANSITION_CONFLICT" }],
    ]);
    for (const label of ["notsent", "local", "persist", "schedule"]) {
      await pipeline.scheduleSubmissionCategoryRetryV3({
        accountId: accountA, jobId: `submission-${label}`,
        snapshotId: `submission-snapshot-${label}`, attemptId: `category-attempt-${label}`,
        correctedItemsHash: correctedHash, correlationId: `submission-correlation-${label}`,
      });
      await owner.query(`UPDATE outbox_events SET status='PUBLISHED',published_at=NOW()
        WHERE aggregate_id=$1 AND event_type='listing.submit.requested'`, [`submission-${label}`]);
      await owner.query(`UPDATE submission_jobs SET status=$2
        WHERE account_id=$1 AND id=$3`, [accountA,
        label === "local" ? "VALIDATING" : "SUBMITTING", `submission-${label}`]);
    }
    for (const [label, error] of submitFailureErrors) {
      const pending = await pipeline.loadSubmissionWorkV3(`submission-${label}`);
      for (let replay = 0; replay < 2; replay += 1) {
        assert.deepEqual(await recoveryController.handleSubmitFailure({ work: pending, error }), {
          handled: true, attemptId: `category-attempt-${label}`, status: "NEEDS_REVIEW",
        });
      }
      assert.deepEqual((await owner.query(`SELECT
        (SELECT status FROM submission_category_recovery_attempts WHERE id=$1) AS attempt_status,
        (SELECT status FROM submission_jobs WHERE id=$2) AS job_status,
        (SELECT count(*)::int FROM outbox_events WHERE aggregate_id=$2
          AND event_type='listing.submit.requested') AS imports`,
      [`category-attempt-${label}`, `submission-${label}`])).rows[0], {
        attempt_status: "NEEDS_REVIEW", job_status: "FAILED", imports: 1,
      });
    }
    const notsentIdentity = {
      accountId: accountA, jobId: "submission-notsent", snapshotId: "submission-snapshot-notsent",
      evidenceId: "category-error-notsent", attemptId: "category-attempt-notsent",
      sourceEvidenceId: "category-source-a", oldSharedCategoryId: "category-shared-a",
      oldSharedCategoryVersion: 1, originalOzonTaskId: "ozon-task-original-notsent",
      correlationId: "submission-correlation-notsent",
      safeReviewCode: "AUTO_LISTING_CATEGORY_RETRY_SUBMIT_FAILED",
    };
    await assert.rejects(pipeline.requireSubmissionCategoryRetryUncertainReviewV3({
      ...notsentIdentity, accountId: accountB,
    }), { code: "LISTING_CATEGORY_RECOVERY_TRANSITION_CONFLICT" });

    const schedulePending = await pipeline.loadSubmissionWorkV3("submission-schedule");
    await pipeline.markSubmissionCategoryRetryAcceptedV3({
      accountId: accountA, jobId: "submission-schedule", snapshotId: "submission-snapshot-schedule",
      evidenceId: "category-error-schedule", attemptId: "category-attempt-schedule",
      sourceEvidenceId: "category-source-a", oldSharedCategoryId: "category-shared-a",
      oldSharedCategoryVersion: 1, originalOzonTaskId: "ozon-task-original-schedule",
      correlationId: "submission-correlation-schedule", retryOzonTaskId: "ozon-task-retry-schedule",
    });
    const scheduleLatest = await pipeline.loadSubmissionWorkV3("submission-schedule");
    for (let replay = 0; replay < 2; replay += 1) {
      assert.deepEqual(await recoveryController.handleSubmitFailure({
        work: schedulePending, latestWork: scheduleLatest,
        error: { code: "STATUS_CHECK_SCHEDULE_FAILED" },
      }), { handled: true, status: "RETRY_ACCEPTED", retryOzonTaskId: "ozon-task-retry-schedule" });
    }
    await owner.query(`UPDATE submission_jobs
      SET updated_at=NOW()-INTERVAL '10 minutes',locked_by='',lock_expires_at=NULL
      WHERE id='submission-schedule'`);
    assert.deepEqual((await pipeline.recoverStaleSubmissionJobsV3({
      workerId: "task8-fix3-watchdog", limit: 10,
    })).filter((row) => row.id === "submission-schedule").map((row) => ({
      fromStatus: row.fromStatus, toStatus: row.toStatus, action: row.action,
    })), [{ fromStatus: "OZON_ACCEPTED", toStatus: "CHECKING", action: "check" }]);
    assert.equal((await pipeline.recoverStaleSubmissionJobsV3({
      workerId: "task8-fix3-watchdog", limit: 10,
    })).some((row) => row.id === "submission-schedule"), false);
    assert.deepEqual((await owner.query(`SELECT
      (SELECT status FROM submission_category_recovery_attempts
        WHERE id='category-attempt-schedule') AS attempt_status,
      (SELECT status FROM submission_jobs WHERE id='submission-schedule') AS job_status,
      (SELECT ozon_task_id FROM submission_jobs WHERE id='submission-schedule') AS task_id,
      (SELECT count(*)::int FROM outbox_events WHERE aggregate_id='submission-schedule'
        AND event_type='listing.submit.requested') AS imports,
      (SELECT count(*)::int FROM outbox_events WHERE aggregate_id='submission-schedule'
        AND event_type='listing.check.requested') AS checks`)).rows[0], {
      attempt_status: "RETRY_ACCEPTED", job_status: "CHECKING",
      task_id: "ozon-task-retry-schedule", imports: 1, checks: 1,
    });

    for (const label of ["watchdog-submit", "watchdog-validating", "watchdog-accepted",
      "watchdog-wrong-tenant", "watchdog-ambiguous"]) {
      await pipeline.scheduleSubmissionCategoryRetryV3({
        accountId: accountA, jobId: `submission-${label}`,
        snapshotId: `submission-snapshot-${label}`, attemptId: `category-attempt-${label}`,
        correctedItemsHash: correctedHash, correlationId: `submission-correlation-${label}`,
      });
      await owner.query(`UPDATE outbox_events SET status='PUBLISHED',published_at=NOW()
        WHERE aggregate_id=$1 AND event_type='listing.submit.requested'`, [`submission-${label}`]);
    }
    await owner.query(`UPDATE submission_jobs SET status='SUBMITTING',
      updated_at=NOW()-INTERVAL '10 minutes' WHERE id='submission-watchdog-submit'`);
    await owner.query(`UPDATE submission_jobs SET status='VALIDATING',
      updated_at=NOW()-INTERVAL '10 minutes' WHERE id='submission-watchdog-validating'`);
    await owner.query(`UPDATE submission_jobs SET status='SUBMITTING'
      WHERE id='submission-watchdog-accepted'`);
    await pipeline.markSubmissionCategoryRetryAcceptedV3({
      accountId: accountA, jobId: "submission-watchdog-accepted",
      snapshotId: "submission-snapshot-watchdog-accepted",
      evidenceId: "category-error-watchdog-accepted",
      attemptId: "category-attempt-watchdog-accepted", sourceEvidenceId: "category-source-a",
      oldSharedCategoryId: "category-shared-a", oldSharedCategoryVersion: 1,
      originalOzonTaskId: "ozon-task-original-watchdog-accepted",
      correlationId: "submission-correlation-watchdog-accepted",
      retryOzonTaskId: "ozon-task-retry-watchdog-accepted",
    });
    await owner.query(`UPDATE submission_jobs SET updated_at=NOW()-INTERVAL '10 minutes'
      WHERE id='submission-watchdog-accepted'`);
    for (const label of ["watchdog-wrong-tenant", "watchdog-ambiguous"]) {
      await owner.query(`UPDATE submission_jobs SET status='SUBMITTING',
        updated_at=NOW()-INTERVAL '10 minutes' WHERE id=$1`, [`submission-${label}`]);
    }
    await owner.query("SET session_replication_role='replica'");
    await owner.query(`UPDATE submission_category_recovery_attempts SET account_id=$1
      WHERE id='category-attempt-watchdog-wrong-tenant'`, [accountB]);
    await owner.query(`INSERT INTO submission_category_recovery_attempts(
        id,account_id,submission_job_id,submission_snapshot_id,triggering_error_evidence_id,
        source_evidence_id,old_shared_category_id,old_shared_category_version,original_ozon_task_id,
        original_snapshot_hash,corrected_items,corrected_items_hash,replacement_category_metadata,
        replacement_shared_category_id,replacement_shared_category_version,retry_ozon_task_id,status,
        safe_review_code,correlation_id,claimed_at,updated_at,completed_at)
      SELECT 'category-attempt-watchdog-ambiguous-foreign',$1,submission_job_id,
        submission_snapshot_id,triggering_error_evidence_id,source_evidence_id,old_shared_category_id,
        old_shared_category_version,original_ozon_task_id,original_snapshot_hash,corrected_items,
        corrected_items_hash,replacement_category_metadata,replacement_shared_category_id,
        replacement_shared_category_version,retry_ozon_task_id,status,safe_review_code,
        correlation_id,claimed_at,updated_at,completed_at
      FROM submission_category_recovery_attempts
      WHERE id='category-attempt-watchdog-ambiguous'`, [accountB]);
    await owner.query("SET session_replication_role='origin'");
    await owner.query(`INSERT INTO submission_snapshots(
      id,collect_item_id,draft_id,draft_version,account_id,store_id,idempotency_key,
      snapshot_hash,item_count,items,stocks)
      VALUES('submission-snapshot-watchdog-ordinary','collect-a','draft-a',1,$1,'store-a',
        'snapshot-key-watchdog-ordinary',$2,1,$3::jsonb,'[]'::jsonb)`,
    [accountA, h, JSON.stringify(originalCategoryItems)]);
    await owner.query(`INSERT INTO submission_jobs(
      id,snapshot_id,collect_item_id,account_id,store_id,status,correlation_id,item_count,ozon_task_id,
      updated_at)
      VALUES('submission-watchdog-ordinary','submission-snapshot-watchdog-ordinary','collect-a',$1,'store-a',
        'SUBMITTING','ordinary-correlation',1,'ordinary-original-task',NOW()-INTERVAL '10 minutes')`,
    [accountA]);

    const watchdogFirst = await pipeline.recoverStaleSubmissionJobsV3({
      workerId: "task8-fix4-watchdog", limit: 20,
    });
    const watchdogSecond = await pipeline.recoverStaleSubmissionJobsV3({
      workerId: "task8-fix4-watchdog", limit: 20,
    });
    assert.deepEqual(watchdogFirst.filter((row) => row.id.startsWith("submission-watchdog-"))
      .map((row) => ({ id: row.id, fromStatus: row.fromStatus,
        toStatus: row.toStatus, action: row.action })).sort((a, b) => a.id.localeCompare(b.id)), [
      { id: "submission-watchdog-accepted", fromStatus: "OZON_ACCEPTED",
        toStatus: "CHECKING", action: "check" },
      { id: "submission-watchdog-ordinary", fromStatus: "SUBMITTING",
        toStatus: "RECONCILING", action: "" },
      { id: "submission-watchdog-submit", fromStatus: "SUBMITTING",
        toStatus: "FAILED", action: "" },
      { id: "submission-watchdog-validating", fromStatus: "VALIDATING",
        toStatus: "FAILED", action: "" },
    ]);
    assert.equal(watchdogSecond.some((row) => row.id.startsWith("submission-watchdog-")), false);
    assert.deepEqual((await owner.query(`SELECT
      (SELECT status FROM submission_category_recovery_attempts
        WHERE id='category-attempt-watchdog-submit') AS submit_attempt,
      (SELECT safe_review_code FROM submission_category_recovery_attempts
        WHERE id='category-attempt-watchdog-submit') AS submit_code,
      (SELECT status FROM submission_category_recovery_attempts
        WHERE id='category-attempt-watchdog-validating') AS validating_attempt,
      (SELECT safe_review_code FROM submission_category_recovery_attempts
        WHERE id='category-attempt-watchdog-validating') AS validating_code,
      (SELECT status FROM submission_category_recovery_attempts
        WHERE id='category-attempt-watchdog-accepted') AS accepted_attempt,
      (SELECT ozon_task_id FROM submission_jobs
        WHERE id='submission-watchdog-accepted') AS accepted_task,
      (SELECT count(*)::int FROM outbox_events WHERE aggregate_id IN
        ('submission-watchdog-submit','submission-watchdog-validating')
        AND event_type IN ('listing.submit.requested','listing.check.requested')
        AND status IN ('PENDING','PUBLISHING')) AS pending_bad_outbox,
      (SELECT count(*)::int FROM outbox_events WHERE aggregate_id='submission-watchdog-accepted'
        AND event_type='listing.check.requested') AS accepted_checks`)).rows[0], {
      submit_attempt: "NEEDS_REVIEW", submit_code: "AUTO_LISTING_CATEGORY_RETRY_TASK_UNKNOWN",
      validating_attempt: "NEEDS_REVIEW",
      validating_code: "AUTO_LISTING_CATEGORY_RETRY_SUBMIT_FAILED",
      accepted_attempt: "RETRY_ACCEPTED", accepted_task: "ozon-task-retry-watchdog-accepted",
      pending_bad_outbox: 0, accepted_checks: 1,
    });
    assert.deepEqual((await owner.query(`SELECT
      (SELECT status FROM submission_jobs WHERE id='submission-watchdog-wrong-tenant') AS wrong_job,
      (SELECT status FROM submission_jobs WHERE id='submission-watchdog-ambiguous') AS ambiguous_job,
      (SELECT count(*)::int FROM submission_category_recovery_attempts
        WHERE submission_job_id='submission-watchdog-ambiguous') AS ambiguous_attempts,
      (SELECT count(*)::int FROM outbox_events WHERE aggregate_id IN
        ('submission-watchdog-wrong-tenant','submission-watchdog-ambiguous')
        AND status IN ('PENDING','PUBLISHING')) AS pending_outbox`)).rows[0], {
      wrong_job: "SUBMITTING", ambiguous_job: "SUBMITTING", ambiguous_attempts: 2,
      pending_outbox: 0,
    });

    const pendingWatchdogCases = ["legal", "queue", "queued", "task", "correlation", "tuple"];
    for (const label of pendingWatchdogCases) {
      const full = `watchdog-pending-${label}`;
      await pipeline.scheduleSubmissionCategoryRetryV3({
        accountId: accountA, jobId: `submission-${full}`,
        snapshotId: `submission-snapshot-${full}`, attemptId: `category-attempt-${full}`,
        correctedItemsHash: correctedHash, correlationId: `submission-correlation-${full}`,
      });
      await owner.query(`UPDATE outbox_events SET status='PUBLISHED',published_at=NOW()
        WHERE aggregate_id=$1 AND event_type='listing.submit.requested'`, [`submission-${full}`]);
      await owner.query(`UPDATE submission_jobs SET updated_at=NOW()-INTERVAL '10 minutes'
        WHERE id=$1`, [`submission-${full}`]);
    }
    await owner.query(`UPDATE submission_jobs SET status='QUEUE_PENDING'
      WHERE id='submission-watchdog-pending-queue'`);
    await owner.query(`UPDATE submission_jobs SET status='QUEUED'
      WHERE id='submission-watchdog-pending-queued'`);
    await owner.query(`UPDATE submission_jobs SET ozon_task_id='drifted-original-task'
      WHERE id='submission-watchdog-pending-task'`);
    await owner.query("SET session_replication_role='replica'");
    await owner.query(`UPDATE submission_jobs SET correlation_id='drifted-correlation'
      WHERE id='submission-watchdog-pending-correlation'`);
    await owner.query(`UPDATE submission_category_recovery_attempts
      SET submission_snapshot_id='submission-snapshot-a'
      WHERE id='category-attempt-watchdog-pending-tuple'`);
    await owner.query("SET session_replication_role='origin'");
    const pendingFirst = await pipeline.recoverStaleSubmissionJobsV3({
      workerId: "task8-fix5-watchdog", limit: 30,
    });
    const pendingSecond = await pipeline.recoverStaleSubmissionJobsV3({
      workerId: "task8-fix5-watchdog", limit: 30,
    });
    assert.deepEqual(pendingFirst.filter((row) => row.id.startsWith("submission-watchdog-pending-"))
      .map((row) => ({ id: row.id, fromStatus: row.fromStatus,
        toStatus: row.toStatus, action: row.action })), [{
      id: "submission-watchdog-pending-legal", fromStatus: "RETRY_PENDING",
      toStatus: "RETRY_PENDING", action: "submit",
    }]);
    assert.equal(pendingSecond.some((row) => row.id.startsWith("submission-watchdog-pending-")), false);
    assert.deepEqual((await owner.query(`SELECT
      (SELECT status FROM submission_jobs WHERE id='submission-watchdog-pending-queue') AS queue_status,
      (SELECT status FROM submission_jobs WHERE id='submission-watchdog-pending-queued') AS queued_status,
      (SELECT status FROM submission_jobs WHERE id='submission-watchdog-pending-task') AS task_status,
      (SELECT status FROM submission_jobs WHERE id='submission-watchdog-pending-correlation') AS correlation_status,
      (SELECT status FROM submission_jobs WHERE id='submission-watchdog-pending-tuple') AS tuple_status,
      (SELECT count(*)::int FROM outbox_events
        WHERE aggregate_id='submission-watchdog-pending-legal'
          AND event_type='listing.submit.requested' AND status='PENDING') AS legal_pending,
      (SELECT count(*)::int FROM outbox_events
        WHERE aggregate_id LIKE 'submission-watchdog-pending-%'
          AND aggregate_id <> 'submission-watchdog-pending-legal'
          AND event_type IN ('listing.submit.requested','listing.check.requested')
          AND status IN ('PENDING','PUBLISHING')) AS attack_pending`)).rows[0], {
      queue_status: "QUEUE_PENDING", queued_status: "QUEUED", task_status: "RETRY_PENDING",
      correlation_status: "RETRY_PENDING", tuple_status: "RETRY_PENDING",
      legal_pending: 1, attack_pending: 0,
    });
    assert.equal((await pipeline.scheduleSubmissionCategoryRetryV3({
      accountId: accountA, jobId: "submission-a", snapshotId: "submission-snapshot-a",
      attemptId: "category-attempt-a", correctedItemsHash: correctedHash,
      correlationId: "submission-correlation-a",
    })).status, "RETRY_PENDING");
    await owner.query(`UPDATE submission_jobs SET status='SUBMITTING'
      WHERE account_id=$1 AND id='submission-a'`, [accountA]);
    const recoveryIdentity = {
      accountId: accountA, jobId: "submission-a", snapshotId: "submission-snapshot-a",
      evidenceId: "category-error-a", attemptId: "category-attempt-a",
      sourceEvidenceId: "category-source-a", oldSharedCategoryId: "category-shared-a",
      oldSharedCategoryVersion: 1, originalOzonTaskId: "ozon-task-original",
      correlationId: "submission-correlation-a", retryOzonTaskId: "ozon-task-retry",
    };
    assert.deepEqual(await pipeline.markSubmissionCategoryRetryAcceptedV3(recoveryIdentity), {
      attemptId: "category-attempt-a", status: "RETRY_ACCEPTED", retryOzonTaskId: "ozon-task-retry",
    });
    await owner.query(`UPDATE submission_jobs SET status='CHECKING'
      WHERE account_id=$1 AND id='submission-a'`, [accountA]);
    await assert.rejects(owner.query(`UPDATE submission_category_recovery_attempts SET
      status='SUCCEEDED',completed_at=NOW(),updated_at=GREATEST(NOW(),updated_at+INTERVAL '1 microsecond')
      WHERE account_id=$1 AND id='category-attempt-a'`, [accountA]), (error) => error?.code === "23514");
    const successChildCommand = {
      accountId: accountA, jobId: "submission-a", snapshotId: "submission-snapshot-a",
      attemptId: "category-attempt-a", retryOzonTaskId: "ozon-task-retry",
      items: [{ offerId: "offer-a", status: "SUCCEEDED", productId: "101" }],
    };
    for (const mutation of [
      { accountId: accountB }, { jobId: "submission-other" },
      { snapshotId: "submission-snapshot-other" }, { attemptId: "category-attempt-other" },
      { retryOzonTaskId: "ozon-task-other" },
      { items: [{ offerId: "offer-other", status: "SUCCEEDED", productId: "101" }] },
      { items: [{ offerId: "商品 SKU", status: "SUCCEEDED", productId: "101" }] },
    ]) {
      await assert.rejects(pipeline.persistSubmissionCategoryRetryResultsV3({
        ...successChildCommand, ...mutation,
      }), { code: "LISTING_CATEGORY_RECOVERY_RESULT_CONFLICT" });
    }
    assert.equal((await owner.query(
      "SELECT count(*)::int AS count FROM submission_category_recovery_item_results",
    )).rows[0].count, 0);
    assert.deepEqual(await pipeline.persistSubmissionCategoryRetryResultsV3(successChildCommand), {
      attemptId: "category-attempt-a", status: "RECORDED", count: 1, idempotent: false,
    });
    assert.deepEqual(await pipeline.persistSubmissionCategoryRetryResultsV3(successChildCommand), {
      attemptId: "category-attempt-a", status: "RECORDED", count: 1, idempotent: true,
    });
    await assert.rejects(pipeline.persistSubmissionCategoryRetryResultsV3({
      ...successChildCommand,
      items: [{ offerId: "offer-a", status: "SUCCEEDED", productId: "102" }],
    }), { code: "LISTING_CATEGORY_RECOVERY_RESULT_CONFLICT" });
    const crashAfterSuccessAttempt = new Error("simulated crash after attempt success");
    await assert.rejects(listingWorker.resumeListingCategoryRecoveryFromChildResults({
      work: await pipeline.loadSubmissionWorkV3("submission-a"), controller: recoveryController,
      continueImport: async () => { throw crashAfterSuccessAttempt; },
    }), crashAfterSuccessAttempt);
    assert.deepEqual((await owner.query(`SELECT
      (SELECT status FROM submission_category_recovery_attempts WHERE id='category-attempt-a') AS attempt,
      (SELECT status FROM submission_jobs WHERE id='submission-a') AS job`)).rows[0], {
      attempt: "SUCCEEDED", job: "CHECKING",
    });
    let stockWrites = 0;
    assert.deepEqual(await listingWorker.resumeListingCategoryRecoveryFromChildResults({
      work: await pipeline.loadSubmissionWorkV3("submission-a"), controller: recoveryController,
      continueImport: async (_work, statusInfo) => {
        stockWrites += 1;
        await pipeline.transitionSubmissionJobV3("submission-a", "SUCCEEDED", {
          successCount: statusInfo.success, failedCount: statusInfo.failed,
          skippedCount: statusInfo.skipped, resultSummary: { success: 1, failed: 0, skipped: 0, stockCount: 1 },
        }, { type: "submission.completed", actorId: "task8-fix2-test" });
      },
    }), { handled: true, status: "SUCCEEDED" });
    assert.deepEqual(await listingWorker.resumeListingCategoryRecoveryFromChildResults({
      work: await pipeline.loadSubmissionWorkV3("submission-a"), controller: recoveryController,
      continueImport: async () => { stockWrites += 1; },
    }), { handled: false });
    assert.equal(stockWrites, 1);
    assert.deepEqual(await pipeline.persistSubmissionCategoryRetryResultsV3(successChildCommand), {
      attemptId: "category-attempt-a", status: "RECORDED", count: 1, idempotent: true,
    });
    await assert.rejects(owner.query(`UPDATE submission_category_recovery_item_results
      SET product_id='103' WHERE recovery_attempt_id='category-attempt-a'`),
    (error) => error?.code === "23514");
    await assert.rejects(owner.query(`DELETE FROM submission_category_recovery_item_results
      WHERE recovery_attempt_id='category-attempt-a'`), (error) => error?.code === "23514");
    assert.deepEqual((await owner.query(`SELECT status,product_id,
      response->'errorEvidence'->>'classification' AS classification,
      (SELECT count(*)::int FROM submission_category_recovery_item_results
        WHERE recovery_attempt_id='category-attempt-a') AS child_count,
      (SELECT status FROM submission_jobs WHERE id='submission-a') AS job_status
      FROM submission_items WHERE job_id='submission-a' AND id='submission-item-a'`)).rows[0], {
      status: "FAILED", product_id: "", classification: "EXPLICIT_CATEGORY_FAILURE",
      child_count: 1, job_status: "SUCCEEDED",
    });

    const failedOriginalItems = [{
      offer_id: "offer-fail", sku: "sku-fail", description_category_id: 50, type_id: 60,
      attributes: [], price: "2", currency_code: "RUB",
    }];
    await owner.query(`INSERT INTO collect_items(id,account_id,source_sku,summary)
      VALUES('collect-fail',$1,'sku-fail','{}'::jsonb)`, [accountA]);
    await owner.query(`INSERT INTO collect_raw_payloads(
      id,collect_item_id,account_id,source_sku,payload_hash,payload,collected_at)
      VALUES('raw-fail','collect-fail',$1,'sku-fail','raw-hash-fail','{}'::jsonb,NOW())`, [accountA]);
    await owner.query(`INSERT INTO product_drafts(
      id,collect_item_id,source_payload_id,version,data_hash,data)
      VALUES('draft-fail','collect-fail','raw-fail',1,$1,'{}'::jsonb)`, [h2]);
    await owner.query(`INSERT INTO collect_ozon_category_source_evidence(
      id,account_id,source_kind,source_record_id,source_version,collect_item_id,product_draft_id,
      source_description_category_id,source_type_id,taxonomy_scope,captured_at,raw_response_hash,
      raw_response_ref,product_raw_response_ref,provenance)
      VALUES('category-source-fail',$1,'PRODUCT_DRAFT','draft-fail','1','collect-fail','draft-fail',
        50,60,'OZON:DEFAULT',NOW(),$2,'raw-fail','raw-fail','{}'::jsonb)`, [accountA, h2]);
    await owner.query(`INSERT INTO account_ozon_shared_categories(
      id,account_id,source_description_category_id,source_type_id,taxonomy_scope,
      current_description_category_id,current_type_id,status,source,version,source_evidence_id,
      created_at,updated_at)
      VALUES('category-shared-fail',$1,50,60,'OZON:DEFAULT',50,60,'ACTIVE','SOURCE_DIRECT',1,
        'category-source-fail','2026-08-13T01:00:00.000Z','2026-08-13T01:00:00.000Z')`, [accountA]);
    await owner.query(`INSERT INTO submission_snapshots(
      id,collect_item_id,draft_id,draft_version,account_id,store_id,idempotency_key,
      snapshot_hash,item_count,items,stocks)
      VALUES('submission-snapshot-fail','collect-fail','draft-fail',1,$1,'store-a',
        'snapshot-key-fail',$2,1,$3::jsonb,'[]'::jsonb)`,
    [accountA, h2, JSON.stringify(failedOriginalItems)]);
    await owner.query(`INSERT INTO submission_jobs(
      id,snapshot_id,collect_item_id,account_id,store_id,status,correlation_id,item_count,ozon_task_id)
      VALUES('submission-fail','submission-snapshot-fail','collect-fail',$1,'store-a','FAILED',
        'submission-correlation-fail',1,'ozon-task-original-fail')`, [accountA]);
    await owner.query(`INSERT INTO submission_items(
      id,job_id,snapshot_id,variant_key,offer_id,sku,status,product_id,response)
      VALUES('submission-item-fail','submission-fail','submission-snapshot-fail','variant-fail',
        'offer-fail','sku-fail','FAILED','',$1::jsonb)`, [JSON.stringify({
      schemaVersion: "OZON_SUBMISSION_ITEM_RESPONSE_V1", rawResponse: {},
      errorEvidence: categoryEvidence("offer-fail"),
    })]);
    await owner.query(`INSERT INTO submission_category_error_evidence(
      id,account_id,submission_job_id,submission_snapshot_id,submission_item_id,offer_id,
      original_ozon_task_id,original_snapshot_hash,original_items,source_evidence_id,
      old_shared_category_id,old_shared_category_version,classifier_policy_version,safe_evidence)
      VALUES('category-error-fail',$1,'submission-fail','submission-snapshot-fail',
        'submission-item-fail','offer-fail','ozon-task-original-fail',$2,$3::jsonb,
        'category-source-fail','category-shared-fail',1,'ozon-category-policy.v2',$4::jsonb)`,
    [accountA, h2, JSON.stringify(failedOriginalItems), JSON.stringify(categoryEvidence("offer-fail"))]);
    await owner.query(`INSERT INTO submission_category_recovery_attempts(
      id,account_id,submission_job_id,submission_snapshot_id,triggering_error_evidence_id,
      source_evidence_id,old_shared_category_id,old_shared_category_version,original_ozon_task_id,
      original_snapshot_hash,status,correlation_id,claimed_at,updated_at)
      VALUES('category-attempt-fail',$1,'submission-fail','submission-snapshot-fail',
        'category-error-fail','category-source-fail','category-shared-fail',1,
        'ozon-task-original-fail',$2,'CLAIMED','submission-correlation-fail',
        '2026-08-13T01:00:01.000Z','2026-08-13T01:00:01.000Z')`, [accountA, h2]);
    await owner.query(`UPDATE account_ozon_shared_categories SET
      status='INVALIDATED',version=2,safe_failure_code='OZON_CATEGORY_INVALIDATED',
      updated_at='2026-08-13T01:00:02.000Z'
      WHERE account_id=$1 AND id='category-shared-fail'`, [accountA]);
    await owner.query(`UPDATE account_ozon_shared_categories SET
      current_description_category_id=70,current_type_id=80,status='ACTIVE',source='OZON_REFRESH',
      version=3,taxonomy_fingerprint=$2,safe_failure_code='',validated_at='2026-08-13T01:00:03.000Z',
      updated_at='2026-08-13T01:00:03.000Z'
      WHERE account_id=$1 AND id='category-shared-fail'`, [accountA, "d".repeat(64)]);
    const failedCorrectedItems = [{ ...failedOriginalItems[0], description_category_id: 70,
      type_id: 80, attributes: [{ complex_id: 0, id: 1, values: [{ value: "required" }] }] }];
    const failedCorrectedHash = stableHash(failedCorrectedItems);
    await owner.query(`UPDATE submission_category_recovery_attempts SET
      status='MATCHED',corrected_items=$2::jsonb,corrected_items_hash=$3,
      replacement_shared_category_id='category-shared-fail',replacement_shared_category_version=3,
      replacement_category_metadata=$4::jsonb,updated_at='2026-08-13T01:00:04.000Z'
      WHERE account_id=$1 AND id='category-attempt-fail'`,
    [accountA, JSON.stringify(failedCorrectedItems), failedCorrectedHash, JSON.stringify({
      descriptionCategoryId: 70, typeId: 80, attributes: [
        { id: 1, complexId: 0, required: true, dictionaryId: null, dictionaryValues: [] },
      ],
    })]);
    await owner.query(`UPDATE submission_category_recovery_attempts SET
      status='RETRY_PENDING',updated_at='2026-08-13T01:00:05.000Z'
      WHERE account_id=$1 AND id='category-attempt-fail'`, [accountA]);
    await pipeline.scheduleSubmissionCategoryRetryV3({
      accountId: accountA, jobId: "submission-fail", snapshotId: "submission-snapshot-fail",
      attemptId: "category-attempt-fail", correctedItemsHash: failedCorrectedHash,
      correlationId: "submission-correlation-fail",
    });
    await owner.query(`UPDATE submission_jobs SET status='SUBMITTING'
      WHERE account_id=$1 AND id='submission-fail'`, [accountA]);
    const failedRecoveryIdentity = {
      accountId: accountA, jobId: "submission-fail", snapshotId: "submission-snapshot-fail",
      evidenceId: "category-error-fail", attemptId: "category-attempt-fail",
      sourceEvidenceId: "category-source-fail", oldSharedCategoryId: "category-shared-fail",
      oldSharedCategoryVersion: 1, originalOzonTaskId: "ozon-task-original-fail",
      correlationId: "submission-correlation-fail", retryOzonTaskId: "ozon-task-retry-fail",
    };
    await pipeline.markSubmissionCategoryRetryAcceptedV3(failedRecoveryIdentity);
    await owner.query(`UPDATE submission_jobs SET status='CHECKING'
      WHERE account_id=$1 AND id='submission-fail'`, [accountA]);
    await assert.rejects(owner.query(`UPDATE submission_category_recovery_attempts SET
      status='NEEDS_REVIEW',safe_review_code='AUTO_LISTING_CATEGORY_RECOVERY_RETRY_FAILED',
      completed_at=NOW(),updated_at=GREATEST(NOW(),updated_at+INTERVAL '1 microsecond')
      WHERE account_id=$1 AND id='category-attempt-fail'`, [accountA]),
    (error) => error?.code === "23514");
    await pipeline.persistSubmissionCategoryRetryResultsV3({
      accountId: accountA, jobId: "submission-fail", snapshotId: "submission-snapshot-fail",
      attemptId: "category-attempt-fail", retryOzonTaskId: "ozon-task-retry-fail",
      items: [{ offerId: "offer-fail", status: "FAILED", productId: null }],
    });
    const crashAfterReviewAttempt = new Error("simulated crash after attempt review");
    await assert.rejects(listingWorker.resumeListingCategoryRecoveryFromChildResults({
      work: await pipeline.loadSubmissionWorkV3("submission-fail"), controller: recoveryController,
      continueImport: async () => { throw crashAfterReviewAttempt; },
    }), crashAfterReviewAttempt);
    assert.deepEqual((await owner.query(`SELECT
      (SELECT status FROM submission_category_recovery_attempts WHERE id='category-attempt-fail') AS attempt,
      (SELECT status FROM submission_jobs WHERE id='submission-fail') AS job`)).rows[0], {
      attempt: "NEEDS_REVIEW", job: "CHECKING",
    });
    let failedContinuations = 0;
    assert.deepEqual(await listingWorker.resumeListingCategoryRecoveryFromChildResults({
      work: await pipeline.loadSubmissionWorkV3("submission-fail"), controller: recoveryController,
      continueImport: async (_work, statusInfo) => {
        failedContinuations += 1;
        await pipeline.transitionSubmissionJobV3("submission-fail", "FAILED", {
          successCount: statusInfo.success, failedCount: statusInfo.failed,
          skippedCount: statusInfo.skipped, errorCode: "OZON_ITEM_RESULT",
          resultSummary: { success: 0, failed: 1, skipped: 0, stockCount: 0 },
        }, { type: "submission.completed", actorId: "task8-fix2-test" });
      },
    }), { handled: true, status: "FAILED" });
    assert.deepEqual(await listingWorker.resumeListingCategoryRecoveryFromChildResults({
      work: await pipeline.loadSubmissionWorkV3("submission-fail"), controller: recoveryController,
      continueImport: async () => { failedContinuations += 1; },
    }), { handled: false });
    assert.equal(failedContinuations, 1);
    assert.deepEqual(await pipeline.persistSubmissionCategoryRetryResultsV3({
      accountId: accountA, jobId: "submission-fail", snapshotId: "submission-snapshot-fail",
      attemptId: "category-attempt-fail", retryOzonTaskId: "ozon-task-retry-fail",
      items: [{ offerId: "offer-fail", status: "FAILED", productId: null }],
    }), { attemptId: "category-attempt-fail", status: "RECORDED", count: 1, idempotent: true });
    assert.deepEqual((await owner.query(`SELECT
      (SELECT status FROM submission_items WHERE id='submission-item-fail') AS original_status,
      (SELECT status FROM submission_category_recovery_item_results
        WHERE recovery_attempt_id='category-attempt-fail') AS retry_status,
      (SELECT status FROM submission_category_recovery_attempts
        WHERE id='category-attempt-fail') AS attempt_status,
      (SELECT status FROM submission_jobs WHERE id='submission-fail') AS job_status,
      (SELECT response->'errorEvidence'->>'classification' FROM submission_items
        WHERE id='submission-item-fail') AS classification,
      (SELECT count(*)::int FROM submission_category_recovery_item_results
        WHERE recovery_attempt_id='category-attempt-fail') AS child_count,
      (SELECT count(*)::int FROM outbox_events
        WHERE aggregate_id='submission-fail' AND event_type='listing.submit.requested') AS imports`
    )).rows[0], {
      original_status: "FAILED", retry_status: "FAILED", attempt_status: "NEEDS_REVIEW",
      job_status: "FAILED", classification: "EXPLICIT_CATEGORY_FAILURE", child_count: 1, imports: 1,
    });
    await owner.query(
      `INSERT INTO auto_listing_submission_links
        (id,account_id,job_id,auto_listing_item_id,listing_base_id,active_plan_id,target_store_id,
         source_hash,config_hash,request_hash,result_hash,upload_policy_version_id,
         submission_snapshot_id,submission_job_id,idempotency_key,status)
       VALUES ('link-a',$1,'job-a','item-a','base-a','plan-a','store-a',$2,$2,$2,$2,
         'policy-a','submission-snapshot-a','submission-a','link-key-a','SUBMITTED')`, [accountA, h],
    );
    await owner.query(
      `INSERT INTO auto_listing_jobs
        (id,account_id,source_type,status,idempotency_key,config_snapshot,config_hash,
         strategy_version_id,created_by,correlation_id,upload_policy_version_id)
       VALUES ('job-b',$1,'COLLECT_BOX','UPLOADING','job-key-b','{}'::jsonb,$2,
         'strategy-a',$1,'job-correlation-b','policy-a')`, [accountA, h],
    );
    await owner.query(
      `INSERT INTO auto_listing_job_items
        (id,job_id,account_id,snapshot_id,target_store_id,target_warehouse_id,status,status_version)
       VALUES ('item-b','job-b',$1,'source-a','store-a','warehouse-a','UPLOADING',8)`, [accountA],
    );
    await owner.query(
      `INSERT INTO ai_content_plans
        (id,account_id,job_id,item_id,source_snapshot_id,strategy_version_id,profile_id,
         strategy_hash,config_hash,source_hash,input_hash,planner_model,profile_version,
         prompt_template_version,plan,plan_hash)
       VALUES ('plan-b',$1,'job-b','item-b','source-a','strategy-a','profile-a',
         $2,$2,$2,$2,'text-model',1,'V1','{}'::jsonb,$2)`, [accountA, h],
    );
    await owner.query("UPDATE auto_listing_job_items SET active_content_plan_id='plan-b' WHERE id='item-b'");
    await owner.query(
      `INSERT INTO auto_listing_listing_bases
        (id,account_id,job_id,item_id,source_snapshot_id,collect_item_id,target_store_id,
         product_draft_id,product_draft_version,product_draft_data_hash,ozon_ready_variants,
         pricing_evidence,rich_content_attribute_supported,listing_base_version,canonical_hash,
         normalizer_version,category_rule_version,dictionary_version)
       VALUES ('base-b',$1,'job-b','item-b','source-a','collect-a','store-a','draft-a',1,$2,
         '[]'::jsonb,jsonb_build_object('currency','RUB','evidenceHash',$2::text),FALSE,
         'AUTO_LISTING_LISTING_BASE_V1',$2,'V1','V1','V1')`, [accountA, h],
    );
    await owner.query(
      `INSERT INTO submission_snapshots
        (id,collect_item_id,draft_id,draft_version,account_id,store_id,idempotency_key,
         snapshot_hash,item_count,items,stocks)
       VALUES ('submission-snapshot-b','collect-a','draft-a',1,$1,'store-a','snapshot-key-b',$2,1,
         '[]'::jsonb,'[]'::jsonb)`, [accountA, h],
    );
    await owner.query(
      `INSERT INTO submission_jobs
        (id,snapshot_id,collect_item_id,account_id,store_id,status,correlation_id,item_count,ozon_task_id,
         success_count,failed_count)
       VALUES ('submission-b','submission-snapshot-b','collect-a',$1,'store-a','RECONCILING',
         'submission-correlation-b',1,'ozon-task-b',1,1)`, [accountA],
    );
    await owner.query(
      `INSERT INTO auto_listing_submission_links
        (id,account_id,job_id,auto_listing_item_id,listing_base_id,active_plan_id,target_store_id,
         source_hash,config_hash,request_hash,result_hash,upload_policy_version_id,
         submission_snapshot_id,submission_job_id,idempotency_key,status)
       VALUES ('link-b',$1,'job-b','item-b','base-b','plan-b','store-a',$2,$2,$2,$2,
         'policy-a','submission-snapshot-b','submission-b','link-key-b','SUBMITTED')`, [accountA, h],
    );

    const scopedPool = {
      async connect() {
        const client = await pool.connect();
        await client.query(`SET search_path TO ${schemaSql},public`);
        return client;
      },
      async query(sql, values) {
        const client = await pool.connect();
        try {
          await client.query(`SET search_path TO ${schemaSql},public`);
          return await client.query(sql, values);
        } finally { client.release(); }
      },
    };
    const repository = createPostgresAutoListingSubmissionReconciliationRepository({ pool: scopedPool });
    const reconciler = createAutoListingSubmissionReconciler({ repository });
    assert.equal((await reconciler.reconcile({
      accountId: accountA, itemId: "item-b", submissionLinkId: "link-b", correlationId: "reconcile-b-uncertain",
    })).status, "BLOCKED");
    await owner.query(
      "UPDATE submission_jobs SET status='PARTIAL_SUCCESS' WHERE account_id=$1 AND id='submission-b'",
      [accountA],
    );
    assert.equal((await reconciler.reconcile({
      accountId: accountA, itemId: "item-b", submissionLinkId: "link-b", correlationId: "reconcile-b-partial",
    })).statusVersion, 10);
    assert.deepEqual((await owner.query(
      `SELECT item.status,item.status_version,item.failure_code,link.status AS link_status,job.status AS job_status
         FROM auto_listing_job_items item
         JOIN auto_listing_jobs job ON job.account_id=item.account_id AND job.id=item.job_id
         JOIN auto_listing_submission_links link
           ON link.account_id=item.account_id AND link.auto_listing_item_id=item.id
        WHERE item.account_id=$1 AND item.id='item-b'`, [accountA],
    )).rows[0], {
      status: "BLOCKED", status_version: 10,
      failure_code: "OZON_PARTIAL_SUCCESS_REQUIRES_REVIEW", link_status: "BLOCKED", job_status: "BLOCKED",
    });
    const enqueued = await repository.enqueue({
      accountId: accountA, jobId: "job-a", itemId: "item-a", submissionLinkId: "link-a",
      submissionJobId: "submission-a", correlationId: "enqueue-a",
    });
    assert.equal(enqueued.duplicate, false);
    assert.match(enqueued.taskId, /^reconcile_task-/u);
    await assert.rejects(owner.query(
      `UPDATE auto_listing_submission_reconcile_tasks
          SET state='LEASED',lease_owner='manual',lease_token='manual',lease_expires_at=NOW()+INTERVAL '1 minute'
        WHERE account_id=$1 AND id=$2`, [accountA, enqueued.taskId],
    ), (error) => error?.code === "23514");

    await assert.rejects(repository.loadReconciliationEvidence({
      accountId: accountB, itemId: "item-a", submissionLinkId: "link-a", correlationId: "cross-account",
    }), { code: "AUTO_LISTING_RECONCILE_NOT_FOUND" });

    const leases = await Promise.all([
      repository.leaseNext({ workerId: "worker-a", leaseMs: 1_000 }),
      repository.leaseNext({ workerId: "worker-b", leaseMs: 1_000 }),
    ]);
    const first = leases.find(Boolean);
    assert.equal(leases.filter(Boolean).length, 1);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const recovered = await repository.leaseNext({ workerId: "worker-c", leaseMs: 30_000 });
    assert.equal(recovered.attemptCount, 2);
    assert.notEqual(recovered.leaseToken, first.leaseToken);
    await assert.rejects(repository.completeLease({
      accountId: accountA, taskId: first.taskId, leaseToken: first.leaseToken,
      correlationId: "stale-lease", evidence: { itemStatus: "SUCCEEDED", linkStatus: "SUCCEEDED" },
    }), { code: "AUTO_LISTING_RECONCILE_LEASE_LOST" });

    await owner.query(
      `UPDATE submission_jobs SET status='RECONCILING'
        WHERE account_id=$1 AND id='submission-a'`,
      [accountA],
    );
    const uncertain = await reconciler.reconcile({
      accountId: accountA, itemId: "item-a", submissionLinkId: "link-a", correlationId: "reconcile-uncertain-a",
    });
    assert.equal(uncertain.status, "BLOCKED");
    assert.deepEqual((await owner.query(
      `SELECT item.status,item.status_version,item.failure_code,link.status AS link_status
         FROM auto_listing_job_items item
         JOIN auto_listing_submission_links link
           ON link.account_id=item.account_id AND link.auto_listing_item_id=item.id
        WHERE item.account_id=$1 AND item.id='item-a'`, [accountA],
    )).rows[0], {
      status: "BLOCKED", status_version: 9,
      failure_code: "OZON_RECONCILIATION_REQUIRED", link_status: "RECONCILING",
    });

    await owner.query(
      "UPDATE submission_jobs SET status='CHECKING' WHERE account_id=$1 AND id='submission-a'",
      [accountA],
    );
    const resumed = await reconciler.reconcile({
      accountId: accountA, itemId: "item-a", submissionLinkId: "link-a", correlationId: "reconcile-resumed-a",
    });
    assert.deepEqual({ status: resumed.status, statusVersion: resumed.statusVersion, linkStatus: resumed.linkStatus },
      { status: "BLOCKED", statusVersion: 9, linkStatus: "RECONCILING" });

    await owner.query(
      `UPDATE submission_jobs SET status='SUCCEEDED',success_count=1,result_summary=$1::jsonb
        WHERE account_id=$2 AND id='submission-a'`,
      [JSON.stringify({ success: 1, failed: 0, skipped: 0, stockCount: 1 }), accountA],
    );
    const result = await reconciler.reconcile({
      accountId: accountA, itemId: "item-a", submissionLinkId: "link-a", correlationId: "reconcile-success-a",
    });
    assert.equal(result.status, "SUCCEEDED");
    const categoryRecoveryResultAudit = (await owner.query(
      `SELECT details->'summary'->'categoryRecovery' AS recovery,
              details->'summary'->'variants' AS variants
         FROM auto_listing_events
        WHERE account_id=$1 AND item_id='item-a' AND correlation_id='reconcile-success-a'
          AND event_type='OZON_SUBMISSION_RECONCILED'`, [accountA],
    )).rows[0];
    assert.deepEqual(categoryRecoveryResultAudit?.recovery, {
      attemptId: "category-attempt-a", status: "SUCCEEDED",
      originalOzonTaskId: "ozon-task-original", retryOzonTaskId: "ozon-task-retry",
      oldSharedCategoryVersion: 1, replacementSharedCategoryVersion: 3,
    });
    assert.deepEqual(categoryRecoveryResultAudit?.variants, [{
      offerId: "offer-a", status: "SUCCEEDED", productId: "101", errorCode: null,
    }]);
    assert.doesNotMatch(JSON.stringify(categoryRecoveryResultAudit), /corrected|raw|apiKey/iu);
    await repository.completeLease({
      accountId: accountA, taskId: recovered.taskId, leaseToken: recovered.leaseToken,
      correlationId: `${recovered.taskId}:2`, evidence: { itemStatus: "SUCCEEDED", linkStatus: "SUCCEEDED" },
    });
    assert.equal((await reconciler.reconcile({
      accountId: accountA, itemId: "item-a", submissionLinkId: "link-a", correlationId: "replay-a",
    })).duplicate, true);
    const counts = (await owner.query(
      `SELECT
         (SELECT count(*)::int FROM auto_listing_events WHERE event_type='OZON_SUBMISSION_RECONCILED') AS result_events,
         (SELECT count(*)::int FROM auto_listing_submission_reconcile_tasks WHERE state='COMPLETED') AS completed_tasks,
         (SELECT count(*)::int FROM auto_listing_submission_reconcile_events WHERE event_type='LEASED') AS lease_events`,
    )).rows[0];
    assert.deepEqual(counts, { result_events: 4, completed_tasks: 1, lease_events: 2 });
    const parent = (await owner.query(
      "SELECT status FROM auto_listing_jobs WHERE account_id=$1 AND id='job-a'",
      [accountA],
    )).rows[0];
    assert.deepEqual(parent, { status: "SUCCEEDED" });
    const parentEvents = (await owner.query(
      `SELECT count(*)::int AS count
         FROM auto_listing_events
        WHERE account_id=$1 AND job_id='job-a' AND item_id IS NULL
          AND event_type='AUTO_LISTING_JOB_AGGREGATED'`,
      [accountA],
    )).rows[0];
    assert.deepEqual(parentEvents, { count: 2 });
    await assert.rejects(owner.query(
      "UPDATE auto_listing_submission_reconcile_events SET evidence='{}'::jsonb WHERE account_id=$1",
      [accountA],
    ), (error) => error?.code === "23514");

    const recoveryTask = await repository.enqueue({
      accountId: accountA, jobId: "job-b", itemId: "item-b", submissionLinkId: "link-b",
      submissionJobId: "submission-b", correlationId: "enqueue-recovery-b",
    });
    const recoveryLease = await repository.leaseNext({ workerId: "worker-recovery-b", leaseMs: 30_000 });
    assert.equal(recoveryLease.taskId, recoveryTask.taskId);
    await repository.deadLetterLease({
      accountId: accountA, taskId: recoveryTask.taskId, leaseToken: recoveryLease.leaseToken,
      correlationId: "dead-recovery-b", errorCode: "MANUAL_TEST_PERMANENT",
      evidence: { itemStatus: "BLOCKED", linkStatus: "BLOCKED" },
    });
    const bindingBefore = (await owner.query(
      `SELECT account_id,job_id,auto_listing_item_id,submission_link_id,submission_job_id,state,
              attempt_count,recovery_count
         FROM auto_listing_submission_reconcile_tasks
        WHERE account_id=$1 AND id=$2`, [accountA, recoveryTask.taskId],
    )).rows[0];
    assert.equal(bindingBefore.state, "DEAD");
    const recoveryRequest = {
      accountId: accountA, actorId: accountA, taskId: recoveryTask.taskId,
      reason: "集成测试确认依赖恢复", idempotencyKey: "recover-b-once", correlationId: "recover-b-correlation",
    };
    assert.deepEqual(await repository.reopenDeadTask(recoveryRequest), {
      accountId: accountA, taskId: recoveryTask.taskId, state: "PENDING", recoveryCount: 1, duplicate: false,
    });
    assert.deepEqual(await repository.reopenDeadTask(recoveryRequest), {
      accountId: accountA, taskId: recoveryTask.taskId, state: "PENDING", recoveryCount: 1, duplicate: true,
    });
    await assert.rejects(repository.reopenDeadTask({ ...recoveryRequest, reason: "冲突的恢复原因" }), {
      code: "AUTO_LISTING_RECONCILE_ADMIN_CONFLICT",
    });
    await assert.rejects(repository.reopenDeadTask({
      ...recoveryRequest, accountId: accountB, actorId: accountB,
      idempotencyKey: "cross-tenant-recover", correlationId: "cross-tenant-recover-correlation",
    }), { code: "AUTO_LISTING_RECONCILE_ADMIN_NOT_FOUND" });
    const bindingAfter = (await owner.query(
      `SELECT account_id,job_id,auto_listing_item_id,submission_link_id,submission_job_id,state,
              attempt_count,recovery_count
         FROM auto_listing_submission_reconcile_tasks
        WHERE account_id=$1 AND id=$2`, [accountA, recoveryTask.taskId],
    )).rows[0];
    assert.deepEqual(bindingAfter, {
      ...bindingBefore, state: "PENDING", attempt_count: 0, recovery_count: 1,
    });
    const recoveryAudit = (await owner.query(
      `SELECT
         (SELECT count(*)::int FROM auto_listing_submission_reconcile_events
           WHERE account_id=$1 AND reconcile_task_id=$2 AND event_type='RECOVERED') AS recovery_events,
         (SELECT count(*)::int FROM audit_events
           WHERE account_id=$1 AND entity_id=$2
             AND action='AUTO_LISTING_RECONCILIATION_TASK_RECOVERED') AS audit_events`,
      [accountA, recoveryTask.taskId],
    )).rows[0];
    assert.deepEqual(recoveryAudit, { recovery_events: 1, audit_events: 1 });
    await assert.rejects(owner.query(
      `UPDATE audit_events SET metadata='{}'::jsonb
        WHERE account_id=$1 AND entity_id=$2
          AND action='AUTO_LISTING_RECONCILIATION_TASK_RECOVERED'`,
      [accountA, recoveryTask.taskId],
    ), (error) => error?.code === "23514");
    await assert.rejects(owner.query(
      `DELETE FROM audit_events
        WHERE account_id=$1 AND entity_id=$2
          AND action='AUTO_LISTING_RECONCILIATION_TASK_RECOVERED'`,
      [accountA, recoveryTask.taskId],
    ), (error) => error?.code === "23514");

    const progressedRecovery = await repository.leaseNext({ workerId: "worker-progressed-b", leaseMs: 30_000 });
    assert.equal(progressedRecovery.taskId, recoveryTask.taskId);
    assert.deepEqual(await repository.reopenDeadTask(recoveryRequest), {
      accountId: accountA, taskId: recoveryTask.taskId, state: "PENDING", recoveryCount: 1, duplicate: true,
    });
    // Construct the otherwise expensive 1000th-attempt boundary only inside this disposable schema.
    await owner.query(
      "ALTER TABLE auto_listing_submission_reconcile_tasks DISABLE TRIGGER auto_listing_submission_reconcile_tasks_protected",
    );
    await owner.query(
      `UPDATE auto_listing_submission_reconcile_tasks
          SET attempt_count=1000,lease_expires_at=NOW()-INTERVAL '1 second'
        WHERE account_id=$1 AND id=$2`, [accountA, recoveryTask.taskId],
    );
    await owner.query(
      "ALTER TABLE auto_listing_submission_reconcile_tasks ENABLE TRIGGER auto_listing_submission_reconcile_tasks_protected",
    );
    assert.equal(await repository.leaseNext({ workerId: "worker-attempt-limit-b", leaseMs: 30_000 }), null);
    assert.equal(await repository.leaseNext({ workerId: "worker-no-auto-revive-b", leaseMs: 30_000 }), null);
    const exhausted = (await owner.query(
      `SELECT state,attempt_count,last_error_code,
              (SELECT count(*)::int FROM auto_listing_submission_reconcile_events event
                WHERE event.account_id=task.account_id AND event.reconcile_task_id=task.id
                  AND event.event_type='DEAD'
                  AND event.error_code='AUTO_LISTING_RECONCILE_ATTEMPT_LIMIT_REACHED') AS dead_events
         FROM auto_listing_submission_reconcile_tasks task
        WHERE account_id=$1 AND id=$2`, [accountA, recoveryTask.taskId],
    )).rows[0];
    assert.deepEqual(exhausted, {
      state: "DEAD", attempt_count: 1000,
      last_error_code: "AUTO_LISTING_RECONCILE_ATTEMPT_LIMIT_REACHED", dead_events: 1,
    });
  } finally {
    delete process.env.DATABASE_URL;
    try {
      const { closePostgresPool } = await import("../db/connection.mjs");
      await closePostgresPool();
    } catch {}
    try { await owner.query("RESET search_path"); } catch {}
    try { await owner.query(`DROP SCHEMA IF EXISTS ${schemaSql} CASCADE`); } catch {}
    owner.release();
    await pool.end();
  }
});
