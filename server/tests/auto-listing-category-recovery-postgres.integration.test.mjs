import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { createPostgresAccountSharedOzonCategoryRepository } from "../account-shared-ozon-category-repository.mjs";
import { createAutoListingCategoryRecoveryPostgres } from "../auto-listing-category-recovery-postgres.mjs";
import { createAutoListingCategoryRecoveryService } from "../auto-listing-category-recovery-service.mjs";
import { createAutoListingListingBasePreparer } from "../auto-listing-listing-base-preparer.mjs";
import { rebuildOzonItemsForCategory } from "../ozon-category-item-rebuilder.mjs";

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

const recoveryMetadata = Object.freeze({
  descriptionCategoryId: 30,
  typeId: 40,
  attributes: Object.freeze([
    Object.freeze({ id: 1, complexId: 0, required: true, dictionaryId: null, dictionaryValues: Object.freeze([]) }),
    Object.freeze({ id: 2, complexId: 0, required: false, dictionaryId: 6,
      dictionaryValues: Object.freeze([Object.freeze({ id: 901, value: "simple-canonical" })]) }),
    Object.freeze({ id: 300, complexId: 77, required: true, dictionaryId: 5,
      dictionaryValues: Object.freeze([Object.freeze({ id: 900, value: "canonical" })]) }),
    Object.freeze({ id: 400, complexId: 77, required: false, dictionaryId: null, dictionaryValues: Object.freeze([]) }),
    Object.freeze({ id: 400, complexId: 88, required: false, dictionaryId: null, dictionaryValues: Object.freeze([]) }),
  ]),
});

async function applyAll(client) {
  const files = (await readdir(migrationsDir)).filter((file) => /^\d{3}_.+\.sql$/u.test(file)).sort();
  assert.equal(files.at(-1), "073_store_currency_authority.sql");
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

async function seed(client, suffix, itemOverrides = {}) {
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
    VALUES($1,$2,10,20,'OZON:DEFAULT',10,20,'ACTIVE','SOURCE_DIRECT',1,$3,$4,$4)`,
  [ids.shared, ids.account, ids.source, "2026-08-12T00:00:00.000Z"]);
  const baseItem = {
    offer_id: "offer-a", sku: "sku-a", description_category_id: 10, type_id: 20,
    attributes: [], price: "1", currency_code: "RUB",
  };
  const items = Array.isArray(itemOverrides)
    ? itemOverrides.map((item, index) => ({ ...baseItem, offer_id: `offer-${index + 1}`,
      sku: `sku-${index + 1}`, ...item }))
    : [{ ...baseItem, ...itemOverrides }];
  await client.query(`INSERT INTO submission_snapshots(
    id,collect_item_id,draft_id,draft_version,account_id,store_id,idempotency_key,snapshot_hash,item_count,items)
    VALUES($1,$2,$3,1,$4,$5,$6,$7,$8,$9)`,
  [ids.snapshot, ids.collect, ids.draft, ids.account, ids.store, `idem-${suffix}`, sha(items),
    items.length, JSON.stringify(items)]);
  await client.query(`INSERT INTO submission_jobs(
    id,snapshot_id,collect_item_id,account_id,store_id,status,ozon_task_id,item_count,failed_count,correlation_id)
    VALUES($1,$2,$3,$4,$5,'FAILED','task-original',$6,$6,$7)`,
  [ids.job, ids.snapshot, ids.collect, ids.account, ids.store, items.length, `corr-${suffix}`]);
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    await client.query(`INSERT INTO submission_items(
      id,job_id,snapshot_id,variant_key,sort_order,sku,offer_id,status,product_id,response)
      VALUES($1,$2,$3,$4,$5,$6,$7,'FAILED','',$8)`,
    [index === 0 ? ids.item : `${ids.item}-${index + 1}`, ids.job, ids.snapshot,
      `variant-${index + 1}`, index, typeof item.sku === "string" ? item.sku : "", item.offer_id, JSON.stringify({
        schemaVersion: "OZON_SUBMISSION_ITEM_RESPONSE_V1", rawResponse: {},
        errorEvidence: safeEvidence(item.offer_id),
      })]);
  }
  return ids;
}

async function realPreparedItemWithoutSku(suffix) {
  const image = "https://cdn.example.test/item.jpg";
  const sourceVariant = {
    sku: "source-sku", offer_id: "offer-a", name: "Prepared item", price: "1.00",
    currency_code: "RUB", weight: 100, weight_unit: "g", depth: 100, width: 100,
    height: 100, dimension_unit: "mm", images: [image], primary_image: image,
    attributes: [{ complex_id: 0, id: 1, values: [{ value: "safe" }] }],
  };
  const prepare = createAutoListingListingBasePreparer({
    loadStoreAccess: async () => ({ id: `store-${suffix}`, ownerAccountId: `account-${suffix}`,
      clientId: "loopback-client", apiKey: "loopback-key", currencyCode: "RUB" }),
    categoryService: {
      getCategoryAttributes: async () => ({ items: [{ id: 1, is_required: true }, { id: 11254 }] }),
      getCategoryAttributeValues: async () => ({ items: [] }),
    },
  });
  const prepared = await prepare({
    accountId: `account-${suffix}`,
    source: {
      collectItem: { listingDraft: { ...sourceVariant, variants: [sourceVariant] } },
      productDraft: { id: `draft-${suffix}`, version: 1, dataHash: "b".repeat(64),
        normalizerVersion: "v3", categoryRuleVersion: "category-v1", dictionaryVersion: "dictionary-live" },
    },
    targetStore: { id: `store-${suffix}`, ownerAccountId: `account-${suffix}` },
    targetCategory: {
      schemaVersion: "AUTO_LISTING_ACCOUNT_CATEGORY_V2", evidenceId: `source-${suffix}`,
      sharedCategoryId: `shared-${suffix}`, sharedCategoryVersion: 1,
      sourceDescriptionCategoryId: 10, sourceTypeId: 20, descriptionCategoryId: 10,
      typeId: 20, taxonomyScope: "OZON:DEFAULT", taxonomyFingerprint: "",
      provenance: "SOURCE_DIRECT",
    },
    pricingEvidence: { currency: "RUB", currencySource: "SOURCE", blackKopecks: "100", greenKopecks: null },
  });
  const item = prepared.variants[0].item;
  assert.equal(Object.hasOwn(item, "sku"), false, "production preparer emits the valid Ozon item without sku");
  return item;
}

async function assertCheckRejected(client, sql, params) {
  await assert.rejects(client.query(sql, params), (error) => error.code === "23514");
}

async function insertSuccessfulRetryChild(client, schema, ids, attemptId, retryOzonTaskId) {
  await client.query(`INSERT INTO ${q(schema)}.submission_category_recovery_item_results(
    id,account_id,submission_job_id,submission_snapshot_id,recovery_attempt_id,
    retry_ozon_task_id,submission_item_id,offer_id,status,product_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,'offer-a','SUCCEEDED','101')`,
  [`${attemptId}-result`, ids.account, ids.job, ids.snapshot, attemptId, retryOzonTaskId, ids.item]);
}

if (!enabled) {
  test("Task 7 recovery PostgreSQL requires a disposable database", { skip: "requires disposable PG16" }, () => {});
} else {
  test("001-073 persists one exact tenant-bound recovery and enforces immutable transitions", { timeout: 120_000 }, async () => {
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
      const preparedSuffix = `${suffix}prepared`;
      const preparedItem = await realPreparedItemWithoutSku(preparedSuffix);
      const preparedIds = await seed(client, preparedSuffix, { ...preparedItem, sku: undefined });
      const skuCarrierIds = [preparedIds];
      const preparedSnapshot = (await client.query(
        `SELECT items,snapshot_hash FROM ${q(schema)}.submission_snapshots WHERE id=$1`,
        [preparedIds.snapshot],
      )).rows[0];
      const preparedEvidenceId = `category-error-${preparedSuffix}`;
      await client.query(`INSERT INTO ${q(schema)}.submission_category_error_evidence(
        id,account_id,submission_job_id,submission_snapshot_id,submission_item_id,offer_id,
        original_ozon_task_id,original_snapshot_hash,original_items,source_evidence_id,
        old_shared_category_id,old_shared_category_version,classifier_policy_version,safe_evidence)
        VALUES($1,$2,$3,$4,$5,'offer-a','task-original',$6,$7,$8,$9,1,'ozon-category-policy.v2',$10)`,
      [preparedEvidenceId, preparedIds.account, preparedIds.job, preparedIds.snapshot,
        preparedIds.item, preparedSnapshot.snapshot_hash, JSON.stringify(preparedSnapshot.items),
        preparedIds.source, preparedIds.shared, JSON.stringify(safeEvidence())]);
      const preparedBasis = await repository.loadCategoryRecoveryBasis({
        accountId: preparedIds.account, jobId: preparedIds.job, evidenceId: preparedEvidenceId,
      });
      assert.deepEqual(preparedBasis.offers, [{ offerId: "offer-a", sku: "" }],
        "a production-prepared Ozon item does not invent a sku for category recovery");
      const loadSkuCarrier = async (label, sku) => {
        const carrierSuffix = `${suffix}${label}`;
        const carrierIds = await seed(client, carrierSuffix, { ...preparedItem, sku });
        skuCarrierIds.push(carrierIds);
        const carrierSnapshot = (await client.query(
          `SELECT items,snapshot_hash FROM ${q(schema)}.submission_snapshots WHERE id=$1`,
          [carrierIds.snapshot],
        )).rows[0];
        const carrierEvidenceId = `category-error-${carrierSuffix}`;
        await client.query(`INSERT INTO ${q(schema)}.submission_category_error_evidence(
          id,account_id,submission_job_id,submission_snapshot_id,submission_item_id,offer_id,
          original_ozon_task_id,original_snapshot_hash,original_items,source_evidence_id,
          old_shared_category_id,old_shared_category_version,classifier_policy_version,safe_evidence)
          VALUES($1,$2,$3,$4,$5,'offer-a','task-original',$6,$7,$8,$9,1,'ozon-category-policy.v2',$10)`,
        [carrierEvidenceId, carrierIds.account, carrierIds.job, carrierIds.snapshot,
          carrierIds.item, carrierSnapshot.snapshot_hash, JSON.stringify(carrierSnapshot.items),
          carrierIds.source, carrierIds.shared, JSON.stringify(safeEvidence())]);
        return repository.loadCategoryRecoveryBasis({
          accountId: carrierIds.account, jobId: carrierIds.job, evidenceId: carrierEvidenceId,
        });
      };
      assert.deepEqual((await loadSkuCarrier("nullsku", null)).offers,
        [{ offerId: "offer-a", sku: "" }]);
      assert.deepEqual((await loadSkuCarrier("stringsku", "source-sku")).offers,
        [{ offerId: "offer-a", sku: "source-sku" }]);
      for (const [label, hostileSku] of [
        ["objectsku", {}], ["arraysku", []], ["numbersku", 7], ["longsku", "x".repeat(241)],
      ]) {
        await assert.rejects(loadSkuCarrier(label, hostileSku), (error) =>
          error.code === "AUTO_LISTING_CATEGORY_RECOVERY_CONFLICT" && error.cause === null);
      }
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
      const originalItems = (await client.query(
        `SELECT items FROM ${q(schema)}.submission_snapshots WHERE id=$1`, [ids.snapshot],
      )).rows[0].items;
      const insertEvidenceSql = `INSERT INTO ${q(schema)}.submission_category_error_evidence(
        id,account_id,submission_job_id,submission_snapshot_id,submission_item_id,offer_id,
        original_ozon_task_id,original_snapshot_hash,original_items,source_evidence_id,old_shared_category_id,
        old_shared_category_version,classifier_policy_version,safe_evidence)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`;
      const evidenceParams = [
        evidence.id, ids.account, ids.job, ids.snapshot, ids.item, evidence.offerId,
        evidence.originalOzonTaskId, evidence.originalSnapshotHash, JSON.stringify(originalItems),
        ids.source, ids.shared, 1, evidence.policyVersion, JSON.stringify(evidence.safeEvidence),
      ];
      await assertCheckRejected(client, insertEvidenceSql, [
        `forged-items-${suffix}`, ...evidenceParams.slice(1, 8),
        JSON.stringify([{ ...originalItems[0], price: "999" }]), ...evidenceParams.slice(9),
      ]);
      await assertCheckRejected(client, insertEvidenceSql, [
        `forged-hash-${suffix}`, ...evidenceParams.slice(1, 7), "d".repeat(64),
        ...evidenceParams.slice(8),
      ]);
      await assertCheckRejected(client, insertEvidenceSql, [
        `forged-version-${suffix}`, ...evidenceParams.slice(1, 11), 2,
        ...evidenceParams.slice(12),
      ]);
      await client.query(`UPDATE ${q(schema)}.submission_items SET product_id='99' WHERE id=$1`, [ids.item]);
      await assertCheckRejected(client, insertEvidenceSql, [`forged-product-${suffix}`, ...evidenceParams.slice(1)]);
      await client.query(`UPDATE ${q(schema)}.submission_items SET product_id='' WHERE id=$1`, [ids.item]);
      await client.query(`UPDATE ${q(schema)}.submission_items SET status='CHECKING' WHERE id=$1`, [ids.item]);
      await assertCheckRejected(client, insertEvidenceSql, [`forged-status-${suffix}`, ...evidenceParams.slice(1)]);
      await client.query(`UPDATE ${q(schema)}.submission_items SET status='FAILED' WHERE id=$1`, [ids.item]);
      const mismatchedEvidence = { ...evidence.safeEvidence, errorCode: "CATEGORY_OTHER" };
      await assertCheckRejected(client, insertEvidenceSql, [
        `forged-safe-${suffix}`, ...evidenceParams.slice(1, 13), JSON.stringify(mismatchedEvidence),
      ]);
      await client.query(insertEvidenceSql, evidenceParams);
      await assertCheckRejected(client,
        `UPDATE ${q(schema)}.submission_snapshots SET items=$2 WHERE account_id=$1 AND id=$3`,
        [ids.account, JSON.stringify([{ ...originalItems[0], price: "777" }]), ids.snapshot]);
      const forgedAttemptSql = `INSERT INTO ${q(schema)}.submission_category_recovery_attempts(
        id,account_id,submission_job_id,submission_snapshot_id,triggering_error_evidence_id,
        source_evidence_id,old_shared_category_id,old_shared_category_version,original_ozon_task_id,
        original_snapshot_hash,status,safe_review_code,correlation_id,claimed_at,updated_at,completed_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW(),NOW(),$14)`;
      const attemptBase = [
        `forged-attempt-${suffix}`, ids.account, ids.job, ids.snapshot, evidence.id, ids.source,
        ids.shared, 1, "task-original", evidence.originalSnapshotHash, "CLAIMED", "",
        `corr-${suffix}`, null,
      ];
      await assertCheckRejected(client, forgedAttemptSql, [
        ...attemptBase.slice(0, 7), 2, ...attemptBase.slice(8),
      ]);
      await assertCheckRejected(client, forgedAttemptSql, [
        ...attemptBase.slice(0, 5), "source-wrong", ...attemptBase.slice(6),
      ]);
      await assertCheckRejected(client, forgedAttemptSql, [
        ...attemptBase.slice(0, 6), "shared-wrong", ...attemptBase.slice(7),
      ]);
      await assertCheckRejected(client, forgedAttemptSql, [
        ...attemptBase.slice(0, 9), "e".repeat(64), ...attemptBase.slice(10),
      ]);
      await assertCheckRejected(client, forgedAttemptSql, [
        `forged-terminal-${suffix}`, ...attemptBase.slice(1, 10), "NEEDS_REVIEW",
        "AUTO_LISTING_CATEGORY_RECOVERY_INCOMPLETE", ...attemptBase.slice(12, 13),
        "2026-08-13T00:00:00.000Z",
      ]);
      const assertCurrentBasisRejectsDirectClaim = async (mutateSql, mutateParams) => {
        await client.query("BEGIN");
        try {
          await client.query(mutateSql, mutateParams);
          await assertCheckRejected(client, forgedAttemptSql, attemptBase);
        } finally {
          await client.query("ROLLBACK");
        }
      };
      await assertCurrentBasisRejectsDirectClaim(
        `UPDATE ${q(schema)}.submission_items SET product_id='99' WHERE id=$1`, [ids.item],
      );
      await assertCurrentBasisRejectsDirectClaim(
        `UPDATE ${q(schema)}.submission_items SET status='CHECKING' WHERE id=$1`, [ids.item],
      );
      await assertCurrentBasisRejectsDirectClaim(
        `UPDATE ${q(schema)}.submission_jobs SET status='SUCCEEDED' WHERE id=$1`, [ids.job],
      );
      await assertCurrentBasisRejectsDirectClaim(
        `UPDATE ${q(schema)}.submission_jobs SET ozon_task_id='task-stale' WHERE id=$1`, [ids.job],
      );
      await assertCurrentBasisRejectsDirectClaim(
        `UPDATE ${q(schema)}.account_ozon_shared_categories
            SET status='INVALIDATED',version=2,safe_failure_code='ZONGZI_CATEGORY_INVALIDATED',
                updated_at=updated_at+INTERVAL '1 second' WHERE id=$1`, [ids.shared],
      );
      await assertCurrentBasisRejectsDirectClaim(
        `UPDATE ${q(schema)}.account_ozon_shared_categories
            SET version=2,updated_at=updated_at+INTERVAL '1 second' WHERE id=$1`, [ids.shared],
      );
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
      await assertCheckRejected(client,
        `UPDATE ${q(schema)}.submission_category_recovery_attempts
            SET status='NEEDS_REVIEW',retry_ozon_task_id='forged-task',
                safe_review_code='AUTO_LISTING_CATEGORY_RECOVERY_INCOMPLETE',
                completed_at='2026-08-13T00:00:00.200Z',updated_at='2026-08-13T00:00:00.200Z'
          WHERE id=$1`, [attempt.attemptId]);
      const tupleMutations = {
        accountId: "account-foreign", jobId: "job-wrong", snapshotId: "snapshot-wrong",
        evidenceId: "evidence-wrong", attemptId: "attempt-wrong", sourceEvidenceId: "source-wrong",
        oldSharedCategoryId: "shared-wrong", oldSharedCategoryVersion: 99,
        originalOzonTaskId: "task-wrong", correlationId: "correlation-wrong",
      };
      const assertTupleClosed = async (operation, input, expectedStatus) => {
        for (const [key, value] of Object.entries(tupleMutations)) {
          await assert.rejects(operation({ ...input, [key]: value }), (error) => {
            assert.equal(error.code, "AUTO_LISTING_CATEGORY_RECOVERY_CONFLICT", key);
            return true;
          });
          const persisted = (await client.query(
            `SELECT status FROM ${q(schema)}.submission_category_recovery_attempts WHERE id=$1`,
            [attempt.attemptId],
          )).rows[0];
          assert.equal(persisted.status, expectedStatus, key);
        }
      };
      await assertTupleClosed((input) => repository.requireCategoryRecoveryReview(input), {
        ...claimInput, attemptId: attempt.attemptId,
        safeReviewCode: "AUTO_LISTING_CATEGORY_RECOVERY_INCOMPLETE",
        transitionedAt: "2026-08-13T00:00:00.250Z",
      }, "CLAIMED");
      const corrected = [{ offer_id: "offer-a", sku: "sku-a", description_category_id: 30, type_id: 40,
        attributes: [
          { complex_id: 0, id: 1, values: [{ value: "simple-safe", dictionary_value_id: 777 }] },
          { complex_id: 0, id: 2,
            values: [{ value: "simple-canonical", dictionary_value_id: 901 }] },
        ],
        complex_attributes: [{ attributes: [{ complex_id: 77, id: 300,
          values: [{ value: "canonical", dictionary_value_id: 900 }] }] }],
        price: "1", currency_code: "RUB" }];
      await assertCheckRejected(client,
        `UPDATE ${q(schema)}.submission_category_recovery_attempts
            SET status='NEEDS_REVIEW',corrected_items=$2,corrected_items_hash=$3,
                replacement_shared_category_id=$4,replacement_shared_category_version=2,
                safe_review_code='AUTO_LISTING_CATEGORY_RECOVERY_INCOMPLETE',
                completed_at='2026-08-13T00:00:00.300Z',updated_at='2026-08-13T00:00:00.300Z'
          WHERE id=$1`,
        [attempt.attemptId, JSON.stringify(corrected), canonicalSha(corrected), ids.shared]);
      await client.query("BEGIN");
      await client.query(`UPDATE ${q(schema)}.account_ozon_shared_categories
        SET current_description_category_id=30,current_type_id=40,status='ACTIVE',source='OZON_REFRESH',
            version=2,taxonomy_fingerprint=$1,safe_failure_code='',validated_at=$2,updated_at=$2
        WHERE account_id=$3 AND id=$4`, ["c".repeat(64), "2026-08-13T00:00:00.500Z", ids.account, ids.shared]);
      await client.query("COMMIT");
      const forgedSharedId = `forged-shared-${suffix}`;
      await client.query(`INSERT INTO ${q(schema)}.account_ozon_shared_categories(
        id,account_id,source_description_category_id,source_type_id,taxonomy_scope,
        current_description_category_id,current_type_id,status,source,version,source_evidence_id,
        taxonomy_fingerprint,safe_failure_code,validated_at,created_at,updated_at)
        VALUES($1,$2,11,21,'OZON:DEFAULT',30,40,'ACTIVE','OZON_REFRESH',2,$3,$4,'',$5,$5,$5)`,
      [forgedSharedId, ids.account, ids.source, "f".repeat(64), "2026-08-13T00:00:00.600Z"]);
      const directMatchSql = `UPDATE ${q(schema)}.submission_category_recovery_attempts
        SET status='MATCHED',corrected_items=$2::JSONB,corrected_items_hash=$3,
            replacement_shared_category_id=$4,replacement_shared_category_version=$5,
            replacement_category_metadata=$6::JSONB,
            updated_at='2026-08-13T00:00:00.750Z' WHERE id=$1`;
      const without = (object, key) => Object.fromEntries(
        Object.entries(object).filter(([candidate]) => candidate !== key),
      );
      const invalidCategoryIdentities = [
        without(corrected[0], "description_category_id"),
        without(corrected[0], "type_id"),
        ...[null, "30", 0, -1, 1.5, 9_007_199_254_740_992]
          .map((value) => ({ ...corrected[0], description_category_id: value })),
        ...[null, "40", 0, -1, 1.5, 9_007_199_254_740_992]
          .map((value) => ({ ...corrected[0], type_id: value })),
        { ...corrected[0], descriptionCategoryId: 30 },
        { ...corrected[0], descriptionCategoryId: 31 },
        { ...corrected[0], typeId: 40 },
        { ...corrected[0], typeId: 41 },
      ];
      const invalidComplexAttributes = [
        null,
        {},
        [],
        [{}],
        [{ attributes: null }],
        [{ attributes: [] }],
        [{ attributes: [null] }],
        [{ attributes: [{ id: 300, complex_id: 0, values: [{ value: "safe" }] }] }],
        [{ attributes: [{ id: 0, complex_id: 77, values: [{ value: "safe" }] }] }],
        [{ attributes: [{ id: 300, complex_id: 77, values: [] }] }],
        [{ attributes: [{ id: 300, complex_id: 77, values: [{ value: "" }] }] }],
        [{ attributes: [{ id: 300, complex_id: 77, values: [{ value: "safe", extra: true }] }] }],
        [{ attributes: [
          { id: 300, complex_id: 77, values: [{ value: "canonical", dictionary_value_id: 900 }] },
          { id: 400, complex_id: 88, values: [{ value: "safe" }] },
        ] }],
        [{ attributes: [
          { id: 300, complex_id: 77, values: [{ value: "canonical", dictionary_value_id: 900 }] },
          { id: 300, complex_id: 77, values: [{ value: "canonical", dictionary_value_id: 900 }] },
        ] }],
        [
          { attributes: [{ id: 400, complex_id: 77, values: [{ value: "safe" }] }] },
          { attributes: [{ id: 400, complex_id: 77, values: [{ value: "safe" }] }] },
        ],
        [
          { attributes: Array.from({ length: 1_000 }, (_, index) => ({
            id: index + 1, complex_id: 77, values: [{ value: "safe" }],
          })) },
          { attributes: [{ id: 1_001, complex_id: 88, values: [{ value: "safe" }] }] },
        ],
        ...[" ", "\t", "\n", "\u00a0", "\u1680", "\u2007", "\u202f", "\u3000", "\ufeff"]
          .map((value) => [{ attributes: [{
            id: 300, complex_id: 77, values: [{ value, dictionary_value_id: 900 }],
          }] }]),
        [{ attributes: [{ id: 999, complex_id: 77, values: [{ value: "safe" }] }] }],
        [{ attributes: [{
          id: 300, complex_id: 77, values: [{ value: "canonical", dictionary_value_id: 901 }],
        }] }],
        [{ attributes: [{
          id: 300, complex_id: 77, values: [{ value: "wrong", dictionary_value_id: 900 }],
        }] }],
        [{
          attributes: [{ id: 300, complex_id: 77, values: [{ value: "safe" }] }],
          extra: true,
        }],
      ];
      const invalidSimpleAttributes = [
        [],
        [{ id: 1, values: [{ value: "safe" }] }],
        [{ complex_id: 77, id: 1, values: [{ value: "safe" }] }],
        [{ complex_id: 0, id: 999, values: [{ value: "safe" }] }],
        [
          { complex_id: 0, id: 1, values: [{ value: "safe" }] },
          { complex_id: 0, id: 1, values: [{ value: "safe" }] },
        ],
        [{ complex_id: 0, id: 2, values: [{ value: "simple-canonical" }] }],
        [{ complex_id: 0, id: 2,
          values: [{ value: "simple-canonical", dictionary_value_id: 902 }] }],
        [{ complex_id: 0, id: 2,
          values: [{ value: "wrong", dictionary_value_id: 901 }] }],
        ...[" ", "\t", "\n", "\u00a0", "\u1680", "\u2007", "\u202f", "\u3000", "\ufeff"]
          .map((value) => [{ complex_id: 0, id: 1, values: [{ value }] }]),
      ];
      const requiredComplexOmitted = { ...corrected[0] };
      delete requiredComplexOmitted.complex_attributes;
      for (const invalidMetadata of [
        null,
        {},
        { ...recoveryMetadata, descriptionCategoryId: 31 },
        { ...recoveryMetadata, typeId: 41 },
        { ...recoveryMetadata, extra: true },
        { ...recoveryMetadata, attributes: [] },
        { ...recoveryMetadata, attributes: [...recoveryMetadata.attributes,
          recoveryMetadata.attributes[1]] },
        { ...recoveryMetadata, attributes: recoveryMetadata.attributes.map((attribute, index) =>
          index === 1 ? { ...attribute, extra: true } : attribute) },
        { ...recoveryMetadata, attributes: recoveryMetadata.attributes.map((attribute, index) =>
          index === 1 ? { ...attribute, dictionaryValues: [{ id: 900, value: "\u00a0" }] } : attribute) },
      ]) {
        await assertCheckRejected(client, directMatchSql, [
          attempt.attemptId, JSON.stringify(corrected), canonicalSha(corrected), ids.shared, 2,
          JSON.stringify(invalidMetadata),
        ]);
      }
      for (const [items, hash, replacementId, version] of [
        [{ forged: true }, "a".repeat(64), ids.shared, 2],
        [42, "a".repeat(64), ids.shared, 2],
        [null, "a".repeat(64), ids.shared, 2],
        [[{ ...corrected[0], description: "x".repeat(2_097_153) }], "a".repeat(64), ids.shared, 2],
        [corrected, "a".repeat(64), ids.shared, 2],
        [[{ ...corrected[0], description_category_id: 31 }], canonicalSha([{ ...corrected[0], description_category_id: 31 }]), ids.shared, 2],
        [corrected, canonicalSha(corrected), forgedSharedId, 2],
        [[Object.fromEntries(Object.entries(corrected[0]).filter(([key]) => key !== "attributes"))],
          canonicalSha([Object.fromEntries(Object.entries(corrected[0]).filter(([key]) => key !== "attributes"))]), ids.shared, 2],
        [[{ ...corrected[0], attributes: null }], canonicalSha([{ ...corrected[0], attributes: null }]), ids.shared, 2],
        [[{ ...corrected[0], attributes: {} }], canonicalSha([{ ...corrected[0], attributes: {} }]), ids.shared, 2],
        ...invalidCategoryIdentities.map((item) => [[item], canonicalSha([item]), ids.shared, 2]),
        ...invalidSimpleAttributes.map((attributes) => {
          const item = { ...corrected[0], attributes };
          return [[item], canonicalSha([item]), ids.shared, 2];
        }),
        [[requiredComplexOmitted], canonicalSha([requiredComplexOmitted]), ids.shared, 2],
        ...invalidComplexAttributes.map((complexAttributes) => {
          const item = { ...corrected[0], complex_attributes: complexAttributes };
          return [[item], canonicalSha([item]), ids.shared, 2];
        }),
      ]) {
        await assertCheckRejected(client, directMatchSql, [
          attempt.attemptId, JSON.stringify(items), hash, replacementId, version,
          JSON.stringify(recoveryMetadata),
        ]);
      }
      const forgedCorrection = [{ ...corrected[0], price: "999" }];
      await assertCheckRejected(client,
        `UPDATE ${q(schema)}.submission_category_recovery_attempts
            SET status='MATCHED',corrected_items=$2,corrected_items_hash=$3,
                replacement_shared_category_id=$4,replacement_shared_category_version=999,
                updated_at='2026-08-13T00:00:00.750Z'
          WHERE id=$1`,
        [attempt.attemptId, JSON.stringify(forgedCorrection), canonicalSha(forgedCorrection), ids.shared]);
      const matchInput = {
        ...claimInput, attemptId: attempt.attemptId, expectedStatus: "CLAIMED",
        replacementSharedCategoryId: ids.shared, replacementSharedCategoryVersion: 2,
        replacementCategoryMetadata: recoveryMetadata,
        correctedItems: corrected, correctedItemsHash: canonicalSha(corrected), transitionedAt: "2026-08-13T00:00:01.000Z",
      };
      await assertTupleClosed((input) => repository.saveCategoryRecoveryMatch(input), matchInput, "CLAIMED");
      const matchedDto = {
        attemptId: attempt.attemptId, status: "MATCHED", replacementSharedCategoryId: ids.shared,
        replacementSharedCategoryVersion: 2, correctedItemsHash: canonicalSha(corrected),
      };
      assert.deepEqual(await repository.saveCategoryRecoveryMatch(matchInput), matchedDto);
      assert.deepEqual(await repository.saveCategoryRecoveryMatch(matchInput), matchedDto);
      await assert.rejects(repository.saveCategoryRecoveryMatch({
        ...matchInput,
        replacementCategoryMetadata: { ...recoveryMetadata, attributes: recoveryMetadata.attributes.slice(0, 1) },
      }), (error) => error.code === "AUTO_LISTING_CATEGORY_RECOVERY_CONFLICT");
      const pendingInput = {
        ...claimInput, attemptId: attempt.attemptId, expectedStatus: "MATCHED",
        transitionedAt: "2026-08-13T00:00:02.000Z",
      };
      await assertTupleClosed((input) => repository.markCategoryRecoveryRetryPending(input), pendingInput, "MATCHED");
      await repository.markCategoryRecoveryRetryPending(pendingInput);
      assert.equal((await repository.markCategoryRecoveryRetryPending(pendingInput)).status, "RETRY_PENDING");
      const acceptedInput = {
        ...claimInput, attemptId: attempt.attemptId, expectedStatus: "RETRY_PENDING",
        retryOzonTaskId: "task-retry", transitionedAt: "2026-08-13T00:00:03.000Z",
      };
      await assertTupleClosed((input) => repository.markCategoryRecoveryRetryAccepted(input), acceptedInput, "RETRY_PENDING");
      const acceptedDto = { attemptId: attempt.attemptId, status: "RETRY_ACCEPTED", retryOzonTaskId: "task-retry" };
      assert.deepEqual(await repository.markCategoryRecoveryRetryAccepted(acceptedInput), acceptedDto);
      assert.deepEqual(await repository.markCategoryRecoveryRetryAccepted(acceptedInput), acceptedDto);
      await client.query(`UPDATE ${q(schema)}.submission_jobs
        SET ozon_task_id='task-retry',status='CHECKING' WHERE account_id=$1 AND id=$2`,
      [ids.account, ids.job]);
      await insertSuccessfulRetryChild(client, schema, ids, attempt.attemptId, "task-retry");
      const completeInput = {
        ...claimInput, attemptId: attempt.attemptId, expectedStatus: "RETRY_ACCEPTED",
        retryOzonTaskId: "task-retry", transitionedAt: "2026-08-13T00:00:04.000Z",
      };
      await assertTupleClosed((input) => repository.completeCategoryRecovery(input), completeInput, "RETRY_ACCEPTED");
      const completedDto = { attemptId: attempt.attemptId, status: "SUCCEEDED", retryOzonTaskId: "task-retry" };
      assert.deepEqual(await repository.completeCategoryRecovery(completeInput), completedDto);
      assert.deepEqual(await repository.completeCategoryRecovery(completeInput), completedDto);
      await assert.rejects(repository.markCategoryRecoveryRetryAccepted({
        ...acceptedInput, retryOzonTaskId: "task-other",
      }), (error) => error.code === "AUTO_LISTING_CATEGORY_RECOVERY_CONFLICT");
      const terminalReplay = await repository.claimCategoryRecovery(claimInput);
      assert.deepEqual(terminalReplay, { attemptId: attempt.attemptId, status: "SUCCEEDED", claimed: false });
      const terminalBasis = await repository.loadCategoryRecoveryBasis({
        accountId: ids.account, jobId: ids.job, evidenceId: evidence.id,
      });
      assert.deepEqual(terminalBasis.existingAttempt, {
        attemptId: attempt.attemptId, status: "SUCCEEDED", correlationId: `corr-${suffix}`,
      });
      const variantIds = await seed(client, `${suffix}required-variants`, [
        { offer_id: "offer-a", sku: "sku-a" },
        { offer_id: "offer-b", sku: "sku-b" },
      ]);
      const variantSnapshot = (await client.query(
        `SELECT items,snapshot_hash FROM ${q(schema)}.submission_snapshots WHERE id=$1`,
        [variantIds.snapshot],
      )).rows[0];
      const variantEvidenceId = `category-error-${suffix}-required-variants`;
      await client.query(insertEvidenceSql, [
        variantEvidenceId, variantIds.account, variantIds.job, variantIds.snapshot, variantIds.item,
        "offer-a", "task-original", variantSnapshot.snapshot_hash,
        JSON.stringify(variantSnapshot.items), variantIds.source, variantIds.shared, 1,
        "ozon-category-policy.v2", JSON.stringify(safeEvidence()),
      ]);
      const variantRepository = createAutoListingCategoryRecoveryPostgres({
        pool: scopedPool, idFactory: () => `recovery-${suffix}-required-variants`,
        now: () => "2026-08-13T00:00:05.500Z",
      });
      const variantClaim = {
        accountId: variantIds.account, jobId: variantIds.job, snapshotId: variantIds.snapshot,
        evidenceId: variantEvidenceId, sourceEvidenceId: variantIds.source,
        oldSharedCategoryId: variantIds.shared, oldSharedCategoryVersion: 1,
        originalOzonTaskId: "task-original", correlationId: `corr-${suffix}required-variants`,
      };
      const variantAttempt = await variantRepository.claimCategoryRecovery(variantClaim);
      await client.query(`UPDATE ${q(schema)}.account_ozon_shared_categories
        SET current_description_category_id=30,current_type_id=40,status='ACTIVE',
            source='OZON_REFRESH',version=2,taxonomy_fingerprint=$1,safe_failure_code='',
            validated_at=$2,updated_at=$2 WHERE account_id=$3 AND id=$4`,
      ["d".repeat(64), "2026-08-13T00:00:05.600Z", variantIds.account, variantIds.shared]);
      const requiredVariant = (item) => ({ ...item, description_category_id: 30, type_id: 40,
        attributes: [{ complex_id: 0, id: 1, values: [{ value: "required-simple" }] }],
        complex_attributes: [{ attributes: [{ complex_id: 77, id: 300,
          values: [{ value: "canonical", dictionary_value_id: 900 }] }] }],
      });
      const variantCorrection = [
        requiredVariant(variantSnapshot.items[0]),
        { ...requiredVariant(variantSnapshot.items[1]), attributes: [] },
      ];
      await assertCheckRejected(client,
        `UPDATE ${q(schema)}.submission_category_recovery_attempts
            SET status='MATCHED',corrected_items=$2::JSONB,corrected_items_hash=$3,
                replacement_shared_category_id=$4,replacement_shared_category_version=2,
                replacement_category_metadata=$5::JSONB,updated_at=$6
          WHERE account_id=$7 AND id=$1`,
        [variantAttempt.attemptId, JSON.stringify(variantCorrection), canonicalSha(variantCorrection),
          variantIds.shared, JSON.stringify(recoveryMetadata), "2026-08-13T00:00:05.700Z",
          variantIds.account]);
      await assert.rejects(client.query(`UPDATE ${q(schema)}.submission_category_recovery_attempts SET corrected_items='[]' WHERE id=$1`, [attempt.attemptId]), (error) => error.code === "23514");
      await assert.rejects(client.query(`DELETE FROM ${q(schema)}.submission_category_error_evidence WHERE id=$1`, [evidence.id]), (error) => error.code === "23514");
      const foreign = createAutoListingCategoryRecoveryPostgres({ pool: scopedPool });
      await assert.rejects(foreign.loadCategoryRecoveryBasis({ accountId: "account-foreign", jobId: ids.job, evidenceId: evidence.id }), (error) => error.code === "AUTO_LISTING_CATEGORY_RECOVERY_NOT_FOUND");
      const reviewIds = await seed(client, `${suffix}review`);
      const reviewSnapshot = (await client.query(
        `SELECT items,snapshot_hash FROM ${q(schema)}.submission_snapshots WHERE id=$1`, [reviewIds.snapshot],
      )).rows[0];
      const reviewEvidenceId = `category-error-${suffix}-review`;
      await client.query(insertEvidenceSql, [
        reviewEvidenceId, reviewIds.account, reviewIds.job, reviewIds.snapshot, reviewIds.item,
        "offer-a", "task-original", reviewSnapshot.snapshot_hash, JSON.stringify(reviewSnapshot.items),
        reviewIds.source, reviewIds.shared, 1, "ozon-category-policy.v2", JSON.stringify(safeEvidence()),
      ]);
      const reviewRepository = createAutoListingCategoryRecoveryPostgres({
        pool: scopedPool, idFactory: () => `review-recovery-${suffix}`,
        now: () => "2026-08-13T00:00:05.000Z",
      });
      const reviewInput = {
        accountId: reviewIds.account, jobId: reviewIds.job, snapshotId: reviewIds.snapshot,
        evidenceId: reviewEvidenceId, attemptId: null, sourceEvidenceId: reviewIds.source,
        oldSharedCategoryId: reviewIds.shared, oldSharedCategoryVersion: 1,
        originalOzonTaskId: "task-original", correlationId: `corr-${suffix}review`,
        safeReviewCode: "AUTO_LISTING_CATEGORY_RECOVERY_PRODUCT_UNKNOWN",
        transitionedAt: "2026-08-13T00:00:05.000Z",
      };
      const reviewDto = { attemptId: `review-recovery-${suffix}`, status: "NEEDS_REVIEW" };
      assert.deepEqual(await reviewRepository.requireCategoryRecoveryReview(reviewInput), reviewDto);
      assert.deepEqual(await reviewRepository.requireCategoryRecoveryReview(reviewInput), reviewDto);
      const reviewShape = (await client.query(`SELECT corrected_items,corrected_items_hash,
        replacement_category_metadata,
        replacement_shared_category_id,replacement_shared_category_version,retry_ozon_task_id
        FROM ${q(schema)}.submission_category_recovery_attempts WHERE id=$1`, [reviewDto.attemptId])).rows[0];
      assert.deepEqual(reviewShape, {
        corrected_items: null, corrected_items_hash: null, replacement_category_metadata: null,
        replacement_shared_category_id: null,
        replacement_shared_category_version: null, retry_ozon_task_id: null,
      });
      const postMatchJobIds = [];
      const assertPostMatchReviewPreservesProvenance = async (label, acceptRetry) => {
        const postIds = await seed(client, `${suffix}${label}`);
        postMatchJobIds.push(postIds);
        const postSnapshot = (await client.query(
          `SELECT items,snapshot_hash FROM ${q(schema)}.submission_snapshots WHERE id=$1`,
          [postIds.snapshot],
        )).rows[0];
        const postEvidenceId = `category-error-${suffix}-${label}`;
        await client.query(insertEvidenceSql, [
          postEvidenceId, postIds.account, postIds.job, postIds.snapshot, postIds.item,
          "offer-a", "task-original", postSnapshot.snapshot_hash, JSON.stringify(postSnapshot.items),
          postIds.source, postIds.shared, 1, "ozon-category-policy.v2", JSON.stringify(safeEvidence()),
        ]);
        const postRepository = createAutoListingCategoryRecoveryPostgres({
          pool: scopedPool, idFactory: () => `recovery-${suffix}-${label}`,
          now: () => "2026-08-13T00:01:00.000Z",
        });
        const postClaim = {
          accountId: postIds.account, jobId: postIds.job, snapshotId: postIds.snapshot,
          evidenceId: postEvidenceId, sourceEvidenceId: postIds.source,
          oldSharedCategoryId: postIds.shared, oldSharedCategoryVersion: 1,
          originalOzonTaskId: "task-original", correlationId: `corr-${suffix}${label}`,
        };
        const postAttempt = await postRepository.claimCategoryRecovery(postClaim);
        await client.query(`UPDATE ${q(schema)}.account_ozon_shared_categories
          SET current_description_category_id=30,current_type_id=40,status='ACTIVE',
              source='OZON_REFRESH',version=2,taxonomy_fingerprint=$1,safe_failure_code='',
              validated_at=$2,updated_at=$2 WHERE account_id=$3 AND id=$4`,
        ["c".repeat(64), "2026-08-13T00:01:00.100Z", postIds.account, postIds.shared]);
        const postCorrected = [{
          ...postSnapshot.items[0], description_category_id: 30, type_id: 40,
          attributes: [{ complex_id: 0, id: 1, values: [{ value: "required-simple" }] }],
          complex_attributes: [{ attributes: [{ complex_id: 77, id: 300,
            values: [{ value: "canonical", dictionary_value_id: 900 }] }] }],
        }];
        const postHash = canonicalSha(postCorrected);
        const identity = {
          ...postClaim, attemptId: postAttempt.attemptId,
        };
        await postRepository.saveCategoryRecoveryMatch({
          ...identity, expectedStatus: "CLAIMED", replacementSharedCategoryId: postIds.shared,
          replacementSharedCategoryVersion: 2, replacementCategoryMetadata: recoveryMetadata,
          correctedItems: postCorrected,
          correctedItemsHash: postHash, transitionedAt: "2026-08-13T00:01:01.000Z",
        });
        await postRepository.markCategoryRecoveryRetryPending({
          ...identity, expectedStatus: "MATCHED", transitionedAt: "2026-08-13T00:01:02.000Z",
        });
        let expectedRetry = null;
        if (acceptRetry) {
          expectedRetry = `task-retry-${label}`;
          await postRepository.markCategoryRecoveryRetryAccepted({
            ...identity, expectedStatus: "RETRY_PENDING", retryOzonTaskId: expectedRetry,
            transitionedAt: "2026-08-13T00:01:03.000Z",
          });
          await client.query(`UPDATE ${q(schema)}.submission_jobs
            SET ozon_task_id=$1,status='CHECKING' WHERE account_id=$2 AND id=$3`,
          [expectedRetry, postIds.account, postIds.job]);
          await client.query(`INSERT INTO ${q(schema)}.submission_category_recovery_item_results(
            id,account_id,submission_job_id,submission_snapshot_id,recovery_attempt_id,
            retry_ozon_task_id,submission_item_id,offer_id,status,product_id)
            VALUES($1,$2,$3,$4,$5,$6,$7,'offer-a','FAILED',NULL)`,
          [`${postAttempt.attemptId}-result`, postIds.account, postIds.job, postIds.snapshot,
            postAttempt.attemptId, expectedRetry, postIds.item]);
        }
        await assertCheckRejected(client,
          `UPDATE ${q(schema)}.submission_category_recovery_attempts
              SET status='NEEDS_REVIEW',corrected_items=NULL,corrected_items_hash=NULL,
                  replacement_shared_category_id=NULL,replacement_shared_category_version=NULL,
                  retry_ozon_task_id=NULL,safe_review_code='AUTO_LISTING_CATEGORY_RECOVERY_INCOMPLETE',
                  completed_at='2026-08-13T00:01:04.000Z',updated_at='2026-08-13T00:01:04.000Z'
            WHERE account_id=$1 AND id=$2`, [postIds.account, postAttempt.attemptId]);
        assert.deepEqual(await postRepository.requireCategoryRecoveryReview({
          ...identity, safeReviewCode: "AUTO_LISTING_CATEGORY_RECOVERY_INCOMPLETE",
          transitionedAt: "2026-08-13T00:01:05.000Z",
        }), { attemptId: postAttempt.attemptId, status: "NEEDS_REVIEW" });
        const preserved = (await client.query(`SELECT status,corrected_items,corrected_items_hash,
          replacement_category_metadata,
          replacement_shared_category_id,replacement_shared_category_version,retry_ozon_task_id
          FROM ${q(schema)}.submission_category_recovery_attempts WHERE account_id=$1 AND id=$2`,
        [postIds.account, postAttempt.attemptId])).rows[0];
        assert.deepEqual(preserved, {
          status: "NEEDS_REVIEW", corrected_items: postCorrected, corrected_items_hash: postHash,
          replacement_category_metadata: recoveryMetadata,
          replacement_shared_category_id: postIds.shared,
          replacement_shared_category_version: 2, retry_ozon_task_id: expectedRetry,
        });
        for (const [column, replacement] of [
          ["corrected_items", "NULL"], ["corrected_items_hash", "NULL"],
          ["replacement_category_metadata", "NULL"],
          ["replacement_shared_category_id", "NULL"],
          ["replacement_shared_category_version", "NULL"],
          ...(acceptRetry ? [["retry_ozon_task_id", "NULL"]] : []),
        ]) {
          await assertCheckRejected(client,
            `UPDATE ${q(schema)}.submission_category_recovery_attempts
                SET ${column}=${replacement},updated_at=updated_at+INTERVAL '1 second'
              WHERE account_id=$1 AND id=$2`, [postIds.account, postAttempt.attemptId]);
        }
      };
      await assertPostMatchReviewPreservesProvenance("pending-review", false);
      await assertPostMatchReviewPreservesProvenance("accepted-review", true);
      await client.query(`DELETE FROM ${q(schema)}.submission_jobs WHERE account_id=$1 AND id=$2`, [ids.account, ids.job]);
      await client.query(`DELETE FROM ${q(schema)}.submission_jobs WHERE account_id=$1 AND id=$2`,
        [variantIds.account, variantIds.job]);
      await client.query(`DELETE FROM ${q(schema)}.submission_jobs WHERE account_id=$1 AND id=$2`,
        [reviewIds.account, reviewIds.job]);
      for (const postIds of postMatchJobIds) {
        await client.query(`DELETE FROM ${q(schema)}.submission_jobs WHERE account_id=$1 AND id=$2`,
          [postIds.account, postIds.job]);
      }
      for (const carrierIds of skuCarrierIds) {
        await client.query(`DELETE FROM ${q(schema)}.submission_jobs WHERE account_id=$1 AND id=$2`,
          [carrierIds.account, carrierIds.job]);
      }
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

  test("real recovery and shared-category PostgreSQL ports compose through the service", { timeout: 120_000 }, async () => {
    const pool = new Pool({ connectionString: databaseUrl });
    const client = await pool.connect();
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const schema = `category_recovery_composition_${suffix}`;
    try {
      await client.query(`CREATE SCHEMA ${q(schema)}`);
      await client.query(`SET search_path TO ${q(schema)}, public`);
      await applyAll(client);
      const ids = await seed(client, suffix, {
        complex_attributes: [{ attributes: [
          { id: 300, complex_id: 77, values: [{ value: "old-replaced" }] },
          { id: 999, complex_id: 77, values: [{ value: "old-removed" }] },
        ] }],
      });
      const snapshot = (await client.query(
        `SELECT items,snapshot_hash FROM ${q(schema)}.submission_snapshots WHERE id=$1`, [ids.snapshot],
      )).rows[0];
      const evidenceId = `category-error-${suffix}`;
      await client.query(`INSERT INTO ${q(schema)}.submission_category_error_evidence(
        id,account_id,submission_job_id,submission_snapshot_id,submission_item_id,offer_id,
        original_ozon_task_id,original_snapshot_hash,original_items,source_evidence_id,old_shared_category_id,
        old_shared_category_version,classifier_policy_version,safe_evidence)
        VALUES($1,$2,$3,$4,$5,'offer-a','task-original',$6,$7,$8,$9,1,'ozon-category-policy.v2',$10)`,
      [evidenceId, ids.account, ids.job, ids.snapshot, ids.item, snapshot.snapshot_hash,
        JSON.stringify(snapshot.items), ids.source, ids.shared, JSON.stringify(safeEvidence())]);
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
      const recoveryRepository = createAutoListingCategoryRecoveryPostgres({
        pool: scopedPool, idFactory: () => `recovery-${suffix}`, now: () => "2026-08-13T01:00:00.000Z",
      });
      const sharedRepository = createPostgresAccountSharedOzonCategoryRepository({ pool: scopedPool });
      let schedules = 0;
      let externalCalls = 0;
      const service = createAutoListingCategoryRecoveryService({
        repository: recoveryRepository,
        loadOperatingStoreAccess: async () => { externalCalls += 1; return { clientId: "client", apiKey: "key" }; },
        confirmOfferAbsent: async () => { externalCalls += 1; return {
          status: "ABSENT", code: "OZON_OFFERS_CONFIRMED_ABSENT",
        }; },
        invalidateSharedCategory: async (input) => {
          externalCalls += 1; return sharedRepository.invalidateSharedCategory(input);
        },
        refreshCategory: async () => { externalCalls += 1; return {
          kind: "UNIQUE_MATCH", descriptionCategoryId: 30, typeId: 40,
          taxonomyFingerprint: "c".repeat(64), metadata: {
            descriptionCategoryId: 30, typeId: 40,
            attributes: [
              { id: 300, complexId: 77, required: true, dictionaryId: 5,
                dictionaryValues: [{ id: 900, value: "canonical-replaced" }] },
              { id: 400, complexId: 77, required: true, dictionaryId: null, dictionaryValues: [] },
            ],
          },
        }; },
        rebuildItems: async ({ originalItems, replacementCategory, currentCategoryMetadata }) => {
          externalCalls += 1;
          return rebuildOzonItemsForCategory({
            originalItems,
            sourceEvidenceAttributes: [[
              { id: 300, complex_id: 77,
                values: [{ value: "source-will-be-canonicalized", dictionary_value_id: 900 }] },
              { id: 400, complex_id: 77, values: [{ value: "source-added" }] },
            ]],
            replacementCategory: {
              kind: replacementCategory.kind,
              descriptionCategoryId: replacementCategory.descriptionCategoryId,
              typeId: replacementCategory.typeId,
            },
            currentCategoryMetadata,
          });
        },
        activateRefreshedCategory: async (input) => {
          externalCalls += 1; return sharedRepository.activateRefreshedCategory(input);
        },
        markSharedNeedsReview: async (input) => {
          externalCalls += 1; return sharedRepository.markSharedNeedsReview(input);
        },
        scheduleRetry: async () => { externalCalls += 1; schedules += 1; return { scheduled: true }; },
        now: () => "2026-08-13T01:00:00.000Z",
      });
      const result = await service.recover({
        accountId: ids.account, jobId: ids.job, evidenceId, correlationId: `corr-${suffix}`,
      });
      const persisted = (await client.query(`SELECT status,safe_review_code,corrected_items_hash,
        replacement_shared_category_version FROM ${q(schema)}.submission_category_recovery_attempts
        WHERE account_id=$1 AND submission_job_id=$2`, [ids.account, ids.job])).rows[0];
      persisted.shared = (await client.query(`SELECT status,source,version,validated_at,
        taxonomy_fingerprint FROM ${q(schema)}.account_ozon_shared_categories
        WHERE account_id=$1 AND id=$2`, [ids.account, ids.shared])).rows[0];
      assert.deepEqual(result, { attemptId: `recovery-${suffix}`, status: "RETRY_PENDING" },
        JSON.stringify(persisted));
      const correctedItems = (await client.query(`SELECT corrected_items
        FROM ${q(schema)}.submission_category_recovery_attempts
        WHERE account_id=$1 AND submission_job_id=$2`, [ids.account, ids.job])).rows[0].corrected_items;
      assert.deepEqual(correctedItems[0].complex_attributes, [{ attributes: [
        { complex_id: 77, id: 300,
          values: [{ value: "canonical-replaced", dictionary_value_id: 900 }] },
        { complex_id: 77, id: 400, values: [{ value: "source-added" }] },
      ] }]);
      assert.equal(schedules, 1);
      const request = {
        accountId: ids.account, jobId: ids.job, evidenceId, correlationId: `corr-${suffix}`,
      };
      const afterFirst = externalCalls;
      assert.deepEqual(await service.recover(request), {
        attemptId: `recovery-${suffix}`, status: "RETRY_PENDING",
      });
      assert.equal(externalCalls, afterFirst);
      const identity = {
        accountId: ids.account, jobId: ids.job, snapshotId: ids.snapshot, evidenceId,
        attemptId: `recovery-${suffix}`, sourceEvidenceId: ids.source,
        oldSharedCategoryId: ids.shared, oldSharedCategoryVersion: 1,
        originalOzonTaskId: "task-original", correlationId: `corr-${suffix}`,
      };
      await recoveryRepository.markCategoryRecoveryRetryAccepted({
        ...identity, expectedStatus: "RETRY_PENDING", retryOzonTaskId: "task-retry",
        transitionedAt: "2026-08-13T01:00:01.000Z",
      });
      assert.deepEqual(await service.recover(request), {
        attemptId: `recovery-${suffix}`, status: "RETRY_ACCEPTED",
      });
      assert.equal(externalCalls, afterFirst);
      await client.query(`UPDATE ${q(schema)}.submission_jobs
        SET ozon_task_id='task-retry',status='CHECKING' WHERE account_id=$1 AND id=$2`,
      [ids.account, ids.job]);
      await insertSuccessfulRetryChild(client, schema, ids, `recovery-${suffix}`, "task-retry");
      await recoveryRepository.completeCategoryRecovery({
        ...identity, expectedStatus: "RETRY_ACCEPTED", retryOzonTaskId: "task-retry",
        transitionedAt: "2026-08-13T01:00:02.000Z",
      });
      assert.deepEqual(await service.recover(request), {
        attemptId: `recovery-${suffix}`, status: "SUCCEEDED",
      });
      assert.equal(externalCalls, afterFirst);

      const staleIds = await seed(client, `${suffix}stale`);
      const staleSnapshot = (await client.query(
        `SELECT items,snapshot_hash FROM ${q(schema)}.submission_snapshots WHERE id=$1`, [staleIds.snapshot],
      )).rows[0];
      const staleEvidenceId = `category-error-${suffix}-stale`;
      await client.query(`INSERT INTO ${q(schema)}.submission_category_error_evidence(
        id,account_id,submission_job_id,submission_snapshot_id,submission_item_id,offer_id,
        original_ozon_task_id,original_snapshot_hash,original_items,source_evidence_id,old_shared_category_id,
        old_shared_category_version,classifier_policy_version,safe_evidence)
        VALUES($1,$2,$3,$4,$5,'offer-a','task-original',$6,$7,$8,$9,1,'ozon-category-policy.v2',$10)`,
      [staleEvidenceId, staleIds.account, staleIds.job, staleIds.snapshot, staleIds.item,
        staleSnapshot.snapshot_hash, JSON.stringify(staleSnapshot.items), staleIds.source,
        staleIds.shared, JSON.stringify(safeEvidence())]);
      let staleSchedules = 0;
      const staleService = createAutoListingCategoryRecoveryService({
        repository: createAutoListingCategoryRecoveryPostgres({
          pool: scopedPool, idFactory: () => `stale-recovery-${suffix}`,
          now: () => "2026-08-13T01:01:00.000Z",
        }),
        loadOperatingStoreAccess: async () => ({ clientId: "client", apiKey: "key" }),
        confirmOfferAbsent: async () => {
          await scopedPool.query("UPDATE submission_items SET product_id='99' WHERE job_id=$1 AND id=$2",
            [staleIds.job, staleIds.item]);
          return { status: "ABSENT", code: "OZON_OFFERS_CONFIRMED_ABSENT" };
        },
        invalidateSharedCategory: sharedRepository.invalidateSharedCategory,
        refreshCategory: async () => { throw new Error("must-not-refresh"); },
        rebuildItems: async () => { throw new Error("must-not-rebuild"); },
        activateRefreshedCategory: sharedRepository.activateRefreshedCategory,
        markSharedNeedsReview: sharedRepository.markSharedNeedsReview,
        scheduleRetry: async () => { staleSchedules += 1; },
        now: () => "2026-08-13T01:01:00.000Z",
      });
      await assert.rejects(staleService.recover({
        accountId: staleIds.account, jobId: staleIds.job, evidenceId: staleEvidenceId,
        correlationId: `corr-${suffix}stale`,
      }), (error) => error.code === "AUTO_LISTING_CATEGORY_RECOVERY_NOT_ELIGIBLE"
        && error.cause === null);
      assert.equal(staleSchedules, 0);
      assert.equal((await client.query(`SELECT COUNT(*)::INT AS count
        FROM ${q(schema)}.submission_category_recovery_attempts WHERE account_id=$1`,
      [staleIds.account])).rows[0].count, 0);
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

test("recovery basis rejects hostile sku carriers without executing traps", async () => {
  const command = { accountId: "account-a", jobId: "job-a", evidenceId: "evidence-a" };
  const rejectCarrier = async (item) => {
    const client = {
      async query(sql) {
        return String(sql).includes("SELECT evidence.*")
          ? { rows: [{ original_items: [item], safe_evidence: safeEvidence() }] }
          : { rows: [] };
      },
      release() {},
    };
    const repository = createAutoListingCategoryRecoveryPostgres({
      pool: { connect: async () => client },
    });
    await assert.rejects(repository.loadCategoryRecoveryBasis(command), (error) =>
      error.code === "AUTO_LISTING_CATEGORY_RECOVERY_CONFLICT"
        && error.cause === null && !String(error.message).includes("secret"));
  };
  let traps = 0;
  const accessor = { offer_id: "offer-a" };
  Object.defineProperty(accessor, "sku", { enumerable: true, get() { traps += 1; return "secret"; } });
  await rejectCarrier(accessor);
  const transparent = new Proxy({ offer_id: "offer-a", sku: "secret" }, {
    get() { traps += 1; return "secret"; }, ownKeys() { traps += 1; return []; },
    getOwnPropertyDescriptor() { traps += 1; return undefined; }, getPrototypeOf() { traps += 1; return Object.prototype; },
  });
  await rejectCarrier(transparent);
  const revocable = Proxy.revocable({ offer_id: "offer-a", sku: "secret" }, {});
  revocable.revoke();
  await rejectCarrier(revocable.proxy);
  await rejectCarrier(Object.assign(Object.create({ inherited: "secret" }), { offer_id: "offer-a", sku: "secret" }));
  await rejectCarrier({ offer_id: "offer-a", sku: undefined });
  assert.equal(traps, 0);
});
