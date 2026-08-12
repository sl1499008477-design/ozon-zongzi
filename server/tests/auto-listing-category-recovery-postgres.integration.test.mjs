import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { createAutoListingCategoryRecoveryPostgres } from "../auto-listing-category-recovery-postgres.mjs";

const databaseUrl = process.env.SONLI_MIGRATION_TEST_DATABASE_URL || "";
const enabled = process.env.ACCOUNT_SHARED_CATEGORY_POSTGRES_TESTS === "1" && Boolean(databaseUrl);
const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(here, "../db/migrations");
const q = (value) => `"${String(value).replaceAll('"', '""')}"`;
const sha = (value) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const canonical = (value) => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const canonicalSha = (value) => crypto.createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");

async function applyAll(client) {
  const files = (await readdir(migrationsDir)).filter((file) => /^\d{3}_.+\.sql$/u.test(file)).sort();
  assert.equal(files.at(-1), "068_auto_listing_category_recovery.sql");
  for (const file of files) await client.query(await readFile(path.join(migrationsDir, file), "utf8"));
}

function safeEvidence(offerId = "offer-a") {
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

async function seed(client, suffix) {
  const ids = Object.fromEntries([
    "account", "store", "collect", "raw", "draft", "source", "shared", "snapshot", "job", "item",
  ].map((key) => [key, `${key}-${suffix}`]));
  await client.query("INSERT INTO accounts(id,username,display_name,role,status) VALUES($1,$1,$1,'admin','active')", [ids.account]);
  await client.query("INSERT INTO stores(id,label,company_name,client_id,status,owner_account_id) VALUES($1,$1,$1,$1,'active',$2)", [ids.store, ids.account]);
  await client.query("INSERT INTO collect_items(id,account_id,store_id,source,identity_key,source_sku,summary) VALUES($1,$2,$3,'ozon',$1,'sku-a','{}')", [ids.collect, ids.account, ids.store]);
  await client.query("INSERT INTO collect_raw_payloads(id,collect_item_id,account_id,store_id,source_sku,source_url,payload_hash,payload,collected_at) VALUES($1,$2,$3,$4,'sku-a','https://source.invalid',$5,'{}',NOW())", [ids.raw, ids.collect, ids.account, ids.store, "a".repeat(64)]);
  await client.query("INSERT INTO product_drafts(id,collect_item_id,source_payload_id,version,data_hash,data,updated_by) VALUES($1,$2,$3,1,$4,'{}',$5)", [ids.draft, ids.collect, ids.raw, "b".repeat(64), ids.account]);
  await client.query("UPDATE collect_items SET current_draft_id=$1 WHERE id=$2", [ids.draft, ids.collect]);
  await client.query(`INSERT INTO collect_ozon_category_source_evidence(
    id,account_id,source_kind,source_record_id,source_version,collect_item_id,product_draft_id,
    source_description_category_id,source_type_id,taxonomy_scope,captured_at,raw_response_hash,
    raw_response_ref,product_raw_response_ref,provenance)
    VALUES($1,$2,'PRODUCT_DRAFT',$3,'1',$4,$3,10,20,'OZON:DEFAULT',NOW(),$5,$6,$6,'{}')`,
  [ids.source, ids.account, ids.draft, ids.collect, "a".repeat(64), ids.raw]);
  await client.query(`INSERT INTO account_ozon_shared_categories(
    id,account_id,source_description_category_id,source_type_id,taxonomy_scope,
    current_description_category_id,current_type_id,status,source,version,source_evidence_id,created_at,updated_at)
    VALUES($1,$2,10,20,'OZON:DEFAULT',10,20,'ACTIVE','SOURCE_DIRECT',1,$3,NOW(),NOW())`,
  [ids.shared, ids.account, ids.source]);
  const item = { offer_id: "offer-a", sku: "sku-a", description_category_id: 10, type_id: 20, attributes: [], price: "1", currency_code: "RUB" };
  await client.query(`INSERT INTO submission_snapshots(
    id,collect_item_id,draft_id,draft_version,account_id,store_id,idempotency_key,snapshot_hash,item_count,items)
    VALUES($1,$2,$3,1,$4,$5,$6,$7,1,$8)`,
  [ids.snapshot, ids.collect, ids.draft, ids.account, ids.store, `idem-${suffix}`, sha([item]), JSON.stringify([item])]);
  await client.query(`INSERT INTO submission_jobs(
    id,snapshot_id,collect_item_id,account_id,store_id,status,ozon_task_id,item_count,failed_count,correlation_id)
    VALUES($1,$2,$3,$4,$5,'FAILED','task-original',1,1,$6)`,
  [ids.job, ids.snapshot, ids.collect, ids.account, ids.store, `corr-${suffix}`]);
  await client.query(`INSERT INTO submission_items(
    id,job_id,snapshot_id,variant_key,sort_order,sku,offer_id,status,product_id,response)
    VALUES($1,$2,$3,'variant-a',0,'sku-a','offer-a','FAILED','',$4)`,
  [ids.item, ids.job, ids.snapshot, JSON.stringify({
    schemaVersion: "OZON_SUBMISSION_ITEM_RESPONSE_V1", rawResponse: {}, errorEvidence: safeEvidence(),
  })]);
  return ids;
}

if (!enabled) {
  test("Task 7 recovery PostgreSQL requires a disposable database", { skip: "requires disposable PG16" }, () => {});
} else {
  test("001-068 persists one exact tenant-bound recovery and enforces immutable transitions", { timeout: 120_000 }, async () => {
    const pool = new Pool({ connectionString: databaseUrl });
    const client = await pool.connect();
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const schema = `category_recovery_${suffix}`;
    try {
      await client.query(`CREATE SCHEMA ${q(schema)}`);
      await client.query(`SET search_path TO ${q(schema)}, public`);
      await applyAll(client);
      const ids = await seed(client, suffix);
      const scopedPool = {
        connect: async () => {
          const next = await pool.connect();
          await next.query(`SET search_path TO ${q(schema)}, public`);
          return next;
        },
        query: async (...args) => {
          const next = await pool.connect();
          try { await next.query(`SET search_path TO ${q(schema)}, public`); return await next.query(...args); }
          finally { next.release(); }
        },
      };
      const repository = createAutoListingCategoryRecoveryPostgres({
        pool: scopedPool, idFactory: () => `recovery-${suffix}`, now: () => "2026-08-13T00:00:00.000Z",
      });
      const evidenceInput = {
        accountId: ids.account, jobId: ids.job, snapshotId: ids.snapshot, itemId: ids.item,
        offerId: "offer-a", originalOzonTaskId: "task-original", policyVersion: "ozon-category-policy.v2",
        safeEvidence: safeEvidence(), sourceEvidenceId: ids.source, oldSharedCategoryId: ids.shared,
        oldSharedCategoryVersion: 1,
        originalSnapshotHash: (await client.query(`SELECT snapshot_hash FROM ${q(schema)}.submission_snapshots WHERE id=$1`, [ids.snapshot])).rows[0].snapshot_hash,
      };
      await assert.rejects(repository.recordCategoryErrorEvidence(evidenceInput), (error) => {
        assert.equal(error.code, "AUTO_LISTING_CATEGORY_RECOVERY_POLICY_DISABLED");
        return true;
      });
      const evidence = { id: `category-error-${suffix}`, ...evidenceInput };
      await client.query(`INSERT INTO ${q(schema)}.submission_category_error_evidence(
        id,account_id,submission_job_id,submission_snapshot_id,submission_item_id,offer_id,
        original_ozon_task_id,original_snapshot_hash,original_items,source_evidence_id,old_shared_category_id,
        old_shared_category_version,classifier_policy_version,safe_evidence)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`, [
        evidence.id, ids.account, ids.job, ids.snapshot, ids.item, evidence.offerId,
        evidence.originalOzonTaskId, evidence.originalSnapshotHash,
        JSON.stringify((await client.query(`SELECT items FROM ${q(schema)}.submission_snapshots WHERE id=$1`, [ids.snapshot])).rows[0].items),
        ids.source, ids.shared, 1,
        evidence.policyVersion, JSON.stringify(evidence.safeEvidence),
      ]);
      const claimInput = {
        accountId: ids.account, jobId: ids.job, snapshotId: ids.snapshot, evidenceId: evidence.id,
        sourceEvidenceId: ids.source, oldSharedCategoryId: ids.shared, oldSharedCategoryVersion: 1,
        originalOzonTaskId: "task-original", correlationId: `corr-${suffix}`,
      };
      await client.query(`UPDATE ${q(schema)}.submission_jobs SET status='SUCCEEDED' WHERE id=$1`, [ids.job]);
      await assert.rejects(repository.claimCategoryRecovery(claimInput), (error) => error.code === "AUTO_LISTING_CATEGORY_RECOVERY_NOT_FOUND");
      assert.equal((await client.query(`SELECT COUNT(*)::INT AS count FROM ${q(schema)}.submission_category_recovery_attempts`)).rows[0].count, 0);
      await client.query(`UPDATE ${q(schema)}.submission_jobs SET status='FAILED' WHERE id=$1`, [ids.job]);
      await client.query(`UPDATE ${q(schema)}.submission_items SET product_id='99' WHERE id=$1`, [ids.item]);
      await assert.rejects(repository.claimCategoryRecovery(claimInput), (error) => error.code === "AUTO_LISTING_CATEGORY_RECOVERY_NOT_FOUND");
      assert.equal((await client.query(`SELECT COUNT(*)::INT AS count FROM ${q(schema)}.submission_category_recovery_attempts`)).rows[0].count, 0);
      await client.query(`UPDATE ${q(schema)}.submission_items SET product_id='' WHERE id=$1`, [ids.item]);
      const attempt = await repository.claimCategoryRecovery(claimInput);
      assert.equal(attempt.status, "CLAIMED");
      assert.equal(attempt.claimed, true);
      const claimReplay = await repository.claimCategoryRecovery(claimInput);
      assert.deepEqual(claimReplay, { attemptId: attempt.attemptId, status: "CLAIMED", claimed: false });
      const corrected = [{ offer_id: "offer-a", sku: "sku-a", description_category_id: 30, type_id: 40, attributes: [], price: "1", currency_code: "RUB" }];
      await client.query("BEGIN");
      await client.query(`UPDATE ${q(schema)}.account_ozon_shared_categories
        SET current_description_category_id=30,current_type_id=40,status='ACTIVE',source='OZON_REFRESH',
            version=2,taxonomy_fingerprint=$1,safe_failure_code='',validated_at=$2,updated_at=$2
        WHERE account_id=$3 AND id=$4`, ["c".repeat(64), "2026-08-13T00:00:00.500Z", ids.account, ids.shared]);
      await client.query("COMMIT");
      const matchInput = {
        accountId: ids.account, attemptId: attempt.attemptId, expectedStatus: "CLAIMED",
        replacementSharedCategoryId: ids.shared, replacementSharedCategoryVersion: 2,
        correctedItems: corrected, correctedItemsHash: canonicalSha(corrected), transitionedAt: "2026-08-13T00:00:01.000Z",
      };
      await repository.saveCategoryRecoveryMatch(matchInput);
      assert.equal((await repository.saveCategoryRecoveryMatch(matchInput)).status, "MATCHED");
      const pendingInput = {
        accountId: ids.account, attemptId: attempt.attemptId, expectedStatus: "MATCHED",
        transitionedAt: "2026-08-13T00:00:02.000Z",
      };
      await repository.markCategoryRecoveryRetryPending(pendingInput);
      assert.equal((await repository.markCategoryRecoveryRetryPending(pendingInput)).status, "RETRY_PENDING");
      const acceptedInput = {
        accountId: ids.account, attemptId: attempt.attemptId, expectedStatus: "RETRY_PENDING",
        retryOzonTaskId: "task-retry", transitionedAt: "2026-08-13T00:00:03.000Z",
      };
      await repository.markCategoryRecoveryRetryAccepted(acceptedInput);
      assert.equal((await repository.markCategoryRecoveryRetryAccepted(acceptedInput)).status, "RETRY_ACCEPTED");
      await client.query(`UPDATE ${q(schema)}.submission_jobs
        SET ozon_task_id='task-retry',status='CHECKING' WHERE account_id=$1 AND id=$2`,
      [ids.account, ids.job]);
      const completeInput = {
        accountId: ids.account, attemptId: attempt.attemptId, expectedStatus: "RETRY_ACCEPTED",
        retryOzonTaskId: "task-retry", transitionedAt: "2026-08-13T00:00:04.000Z",
      };
      const completed = await repository.completeCategoryRecovery(completeInput);
      assert.equal(completed.status, "SUCCEEDED");
      assert.equal((await repository.completeCategoryRecovery(completeInput)).status, "SUCCEEDED");
      await assert.rejects(repository.markCategoryRecoveryRetryAccepted({
        ...acceptedInput, retryOzonTaskId: "task-other",
      }), (error) => error.code === "AUTO_LISTING_CATEGORY_RECOVERY_CONFLICT");
      const terminalReplay = await repository.claimCategoryRecovery(claimInput);
      assert.deepEqual(terminalReplay, { attemptId: attempt.attemptId, status: "SUCCEEDED", claimed: false });
      const terminalBasis = await repository.loadCategoryRecoveryBasis({
        accountId: ids.account, jobId: ids.job, evidenceId: evidence.id,
      });
      assert.deepEqual(terminalBasis.existingAttempt, {
        attemptId: attempt.attemptId, status: "SUCCEEDED",
      });
      await assert.rejects(client.query(`UPDATE ${q(schema)}.submission_category_recovery_attempts SET corrected_items='[]' WHERE id=$1`, [attempt.attemptId]), (error) => error.code === "23514");
      await assert.rejects(client.query(`DELETE FROM ${q(schema)}.submission_category_error_evidence WHERE id=$1`, [evidence.id]), (error) => error.code === "23514");
      const foreign = createAutoListingCategoryRecoveryPostgres({ pool: scopedPool });
      await assert.rejects(foreign.loadCategoryRecoveryBasis({ accountId: "account-foreign", jobId: ids.job, evidenceId: evidence.id }), (error) => error.code === "AUTO_LISTING_CATEGORY_RECOVERY_NOT_FOUND");
      await client.query(`DELETE FROM ${q(schema)}.submission_jobs WHERE account_id=$1 AND id=$2`, [ids.account, ids.job]);
      const cleanup = (await client.query(`SELECT
        (SELECT COUNT(*)::INT FROM ${q(schema)}.submission_category_error_evidence) AS evidence,
        (SELECT COUNT(*)::INT FROM ${q(schema)}.submission_category_recovery_attempts) AS attempts`)).rows[0];
      assert.deepEqual(cleanup, { evidence: 0, attempts: 0 });
    } finally {
      await client.query(`DROP SCHEMA IF EXISTS ${q(schema)} CASCADE`).catch(() => {});
      client.release();
      await pool.end();
    }
  });
}

test("repository rejects malformed commands before opening PostgreSQL", async () => {
  let connects = 0;
  const repository = createAutoListingCategoryRecoveryPostgres({ pool: { connect: async () => { connects += 1; } } });
  const hostile = {};
  Object.defineProperty(hostile, "accountId", { enumerable: true, get() { throw new Error("secret"); } });
  await assert.rejects(repository.loadCategoryRecoveryBasis(hostile), (error) => {
    assert.equal(error.code, "AUTO_LISTING_CATEGORY_RECOVERY_INVALID");
    assert.equal(error.cause, null);
    return true;
  });
  assert.equal(connects, 0);
});
