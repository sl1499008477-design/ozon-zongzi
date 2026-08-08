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
  try {
    await owner.query(`CREATE SCHEMA ${schemaSql}`);
    await owner.query(`SET search_path TO ${schemaSql},public`);
    for (const migration of (await readdir(migrationsDir)).filter((file) => /^\d{3}_.+\.sql$/u.test(file)).sort()) {
      await owner.query(await readFile(path.join(migrationsDir, migration), "utf8"));
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
    await owner.query(
      `INSERT INTO submission_snapshots
        (id,collect_item_id,draft_id,draft_version,account_id,store_id,idempotency_key,
         snapshot_hash,item_count,items,stocks)
       VALUES ('submission-snapshot-a','collect-a','draft-a',1,$1,'store-a','snapshot-key-a',$2,1,
         '[]'::jsonb,'[]'::jsonb)`, [accountA, h],
    );
    await owner.query(
      `INSERT INTO submission_jobs
        (id,snapshot_id,collect_item_id,account_id,store_id,status,correlation_id,item_count,ozon_task_id)
       VALUES ('submission-a','submission-snapshot-a','collect-a',$1,'store-a','CHECKING',
         'submission-correlation-a',1,'ozon-task-a')`, [accountA],
    );
    await owner.query(
      `INSERT INTO submission_items
        (id,job_id,snapshot_id,variant_key,offer_id,status,product_id)
       VALUES ('submission-item-a','submission-a','submission-snapshot-a','variant-a','offer-a','SUCCESS','product-a')`,
    );
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
    try { await owner.query("RESET search_path"); } catch {}
    try { await owner.query(`DROP SCHEMA IF EXISTS ${schemaSql} CASCADE`); } catch {}
    owner.release();
    await pool.end();
  }
});
