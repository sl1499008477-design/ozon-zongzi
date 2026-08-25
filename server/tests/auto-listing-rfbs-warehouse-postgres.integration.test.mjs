import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createAutoListingRepository } from "../auto-listing-repository.mjs";
import { normalizeAndHashAutoListingConfig } from "../auto-listing-contract.mjs";
import { deriveEffectiveAutoListingImageConfig } from "../auto-listing-item-image-config.mjs";
import { deleteRemovedAccountScopes } from "../formal-persistence.mjs";
import {
  buildAutoListingBlockedSourceEvidence,
  buildAutoListingSourceSnapshot,
} from "../auto-listing-source-snapshot.mjs";

const databaseUrl = process.env.SONLI_MIGRATION_TEST_DATABASE_URL;
const enabled = process.env.AUTO_LISTING_POSTGRES_TESTS === "1" && Boolean(databaseUrl);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(__dirname, "../db/migrations");
const quoteIdentifier = (value) => `"${String(value).replaceAll('"', '""')}"`;
const hashJson = (value) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");

function categoryAuthority(accountId, suffix) {
  const evidenceId = `category-evidence-${suffix}`;
  return {
    categoryEvidence: { id: evidenceId, accountId, sourceDescriptionCategoryId: 123,
      sourceTypeId: 456, taxonomyScope: "OZON:DEFAULT" },
    sharedCategory: { id: `shared-category-${accountId}`, accountId, version: 1,
      evidenceId, status: "ACTIVE", source: "SOURCE_DIRECT",
      sourceDescriptionCategoryId: 123, sourceTypeId: 456, currentDescriptionCategoryId: 123,
      currentTypeId: 456, taxonomyScope: "OZON:DEFAULT", taxonomyFingerprint: null },
  };
}

function validation(accountId, storeId, warehouseId, platformWarehouseId, correlationId, dates = {}) {
  const observedAt = dates.observedAt || new Date(Date.now() - 5_000).toISOString();
  const expiresAt = dates.expiresAt || new Date(Date.now() + 300_000).toISOString();
  const normalized = {
    schemaVersion: "AUTO_LISTING_RFBS_WAREHOUSE_EVIDENCE_V1",
    accountId,
    storeId,
    warehouseRecordId: warehouseId,
    platformWarehouseId,
    fulfillmentType: "RFBS",
    status: "ACTIVE",
    outcome: "PASSED",
    observedAt,
    expiresAt,
    correlationId,
    actorAccountId: accountId,
  };
  return { ...normalized, evidenceHash: hashJson(normalized) };
}

function graph(accountId, storeId, warehouseId, idempotencyKey, sourceSuffix, warehouseValidation) {
  const sourceRecordId = `collect-${sourceSuffix}`;
  const { config, configHash } = normalizeAndHashAutoListingConfig({
    targetStoreId: storeId, targetWarehouseId: warehouseId, stock: 1, priceAdjustmentKopecks: "0",
  });
  const captured = buildAutoListingSourceSnapshot({
    accountId, sourceType: "COLLECT_BOX", sourceRecordId, sourceVersion: "1",
    rawResponseRef: `raw-${sourceSuffix}`, rawResponseHash: `raw-hash-${sourceSuffix}`,
    productDraft: { id: `draft-${sourceSuffix}`, version: 1 },
    ...categoryAuthority(accountId, sourceSuffix),
    targetStoreCurrency: "RUB",
    collectItem: {
      id: sourceRecordId, accountId, sku: `sku-${sourceSuffix}`,
      listingDraft: {
        sku: `sku-${sourceSuffix}`, offerId: `offer-${sourceSuffix}`, title: "RFBS product",
        currency: "RUB", blackKopecks: "10000", greenKopecks: "8000", images: [],
        variants: [{ sku: `sku-${sourceSuffix}`, offerId: `offer-${sourceSuffix}` }],
        categoryResolution: { status: "MATCHED", method: "test",
          target: { storeId, descriptionCategoryId: "123", typeId: "456" }, source: { path: [] } },
      },
    },
  });
  return {
    accountId, actorAccountId: accountId,
    categoryPreparationLeaseId: `category-lease-${sourceSuffix}`,
    sourceType: "COLLECT_BOX", idempotencyKey,
    correlationId: warehouseValidation.correlationId, configSnapshot: config, configHash,
    strategyVersionId: `strategy-${accountId}`, uploadPolicyVersionId: `policy-${accountId}`,
    warehouseValidation,
    items: [{
      sourceType: "COLLECT_BOX", sourceRecordId, sourceVersion: "1", snapshot: captured.snapshot,
      snapshotHash: captured.snapshotHash, rawResponseRef: captured.rawResponseRef,
      targetStoreId: storeId, targetWarehouseId: warehouseId, sourceOrder: 1, status: "SOURCE_READY",
      strategyId: `strategy-key-${accountId}`, strategyVersionId: `strategy-${accountId}`,
      ruleId: null, style: "BALANCED_DEFAULT", matchedBy: "DEFAULT",
      price: { currency: "RUB", branch: "BLACK_GTE_80", blackKopecks: "10000", greenKopecks: "8000",
        realPriceKopecks: "14500", adjustmentKopecks: "0", finalPriceKopecks: "14500" },
      effectiveImageConfig: deriveEffectiveAutoListingImageConfig({ configSnapshot: config, configHash, sourceCapture: captured }),
      listingBaseTemplate: {
        productDraft: { id: `draft-${sourceSuffix}`, version: 1, dataHash: "1".repeat(64) },
        pricingEvidence: { currency: "RUB", currencySource: "SOURCE",
          blackKopecks: "10000", greenKopecks: "8000",
          evidenceHash: "4c6f549e1668186515248caffeb08fe2f9ba91ca1dab9edbdd8d159aa2b11bf8" },
        richContentAttributeSupported: true,
        variants: [{ sourceVariantId: `variant-${sourceSuffix}`, sourceSku: `sku-${sourceSuffix}`,
          item: { offer_id: `offer-${sourceSuffix}`, name: "RFBS product", price: "100.00", currency_code: "RUB",
            description_category_id: 123, type_id: 456, primary_image: "https://source.example.test/a.jpg",
            images: ["https://source.example.test/a.jpg"], weight: 100, weight_unit: "g", depth: 100,
            width: 100, height: 100, dimension_unit: "mm",
            attributes: [{ id: 85, complex_id: 0, values: [{ value: "No brand" }] }] } }],
        versions: { normalizerVersion: "v3", categoryRuleVersion: "v1", dictionaryVersion: "live" },
      },
    }],
  };
}

function blockedGraph(accountId, storeId, warehouseId, idempotencyKey, sourceSuffix, warehouseValidation) {
  const sourceRecordId = `collect-${sourceSuffix}`;
  const { config, configHash } = normalizeAndHashAutoListingConfig({
    targetStoreId: storeId, targetWarehouseId: warehouseId, stock: 1, priceAdjustmentKopecks: "0",
  });
  const captured = buildAutoListingBlockedSourceEvidence({
    accountId, sourceType: "COLLECT_BOX", sourceRecordId, sourceVersion: "1",
    rawCollectedAt: new Date().toISOString(), rawResponseRef: `raw-${sourceSuffix}`,
    rawResponseHash: `raw-hash-${sourceSuffix}`, failureCode: "AUTO_LISTING_SOURCE_CATEGORY_REQUIRED",
  });
  return {
    accountId, actorAccountId: accountId,
    categoryPreparationLeaseId: `category-lease-${sourceSuffix}`,
    sourceType: "COLLECT_BOX", idempotencyKey,
    correlationId: warehouseValidation.correlationId, configSnapshot: config, configHash,
    strategyVersionId: `strategy-${accountId}`, uploadPolicyVersionId: `policy-${accountId}`,
    warehouseValidation,
    items: [{
      sourceType: "COLLECT_BOX", sourceRecordId, sourceVersion: "1",
      blockedEvidence: captured.blockedEvidence, snapshotHash: captured.snapshotHash,
      rawResponseRef: captured.rawResponseRef, targetStoreId: storeId,
      targetWarehouseId: warehouseId, sourceOrder: 1, status: "BLOCKED",
      failureCode: "AUTO_LISTING_SOURCE_CATEGORY_REQUIRED",
    }],
  };
}

async function establishActiveCategoryPreparationLease(client, input) {
  await client.query(`INSERT INTO auto_listing_category_preparation_leases(
    id,account_id,holder_backend_pid,holder_backend_started_at,state,acquired_at,expires_at)
    SELECT $1,$2,activity.pid,activity.backend_start,'ACTIVE',NOW(),NOW()+INTERVAL '1 hour'
      FROM pg_stat_activity AS activity
     WHERE activity.pid=pg_backend_pid() AND activity.datname=current_database()`,
  [input.categoryPreparationLeaseId, input.accountId]);
  for (const item of input.items.filter((entry) => entry.status === "SOURCE_READY")) {
    const category = item.snapshot.targetCategory;
    const draft = item.listingBaseTemplate.productDraft;
    const rawId = `category-raw-${item.sourceRecordId}`;
    const rawHash = crypto.createHash("sha256").update(rawId).digest("hex");
    await client.query(`INSERT INTO collect_raw_payloads(
      id,collect_item_id,account_id,source_sku,payload_hash,payload,collected_at)
      VALUES($1,$2,$3,$4,$5,'{}'::jsonb,NOW())`,
    [rawId, item.sourceRecordId, input.accountId, item.snapshot.identity.primarySku, rawHash]);
    await client.query("UPDATE product_drafts SET source_payload_id=$1 WHERE id=$2 AND collect_item_id=$3",
      [rawId, draft.id, item.sourceRecordId]);
    await client.query(`INSERT INTO collect_ozon_category_source_evidence(
      id,account_id,source_kind,source_record_id,source_version,collect_item_id,product_draft_id,
      source_description_category_id,source_type_id,taxonomy_scope,captured_at,raw_response_hash,
      raw_response_ref,product_raw_response_ref,provenance)
      VALUES($1,$2,'PRODUCT_DRAFT',$3,$4,$3,$5,$6,$7,$8,NOW(),$9,$10,$10,'{}'::jsonb)`,
    [category.evidenceId, input.accountId, item.sourceRecordId, String(draft.version), draft.id,
      category.sourceDescriptionCategoryId, category.sourceTypeId, category.taxonomyScope, rawHash, rawId]);
    await client.query(`INSERT INTO account_ozon_shared_categories(
      id,account_id,source_description_category_id,source_type_id,taxonomy_scope,
      current_description_category_id,current_type_id,status,source,version,taxonomy_fingerprint,
      safe_failure_code,source_evidence_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,'ACTIVE',$8,$9,$10,'',$11)
      ON CONFLICT(account_id,source_description_category_id,source_type_id,taxonomy_scope) DO NOTHING`,
    [category.sharedCategoryId, input.accountId, category.sourceDescriptionCategoryId,
      category.sourceTypeId, category.taxonomyScope, category.descriptionCategoryId,
      category.typeId, category.provenance, category.sharedCategoryVersion,
      category.taxonomyFingerprint || null, category.evidenceId]);
    await client.query(`INSERT INTO collect_ozon_category_current_sources(
      account_id,collect_item_id,source_evidence_id,source_kind,source_record_id,source_version)
      VALUES($1,$2,$3,'PRODUCT_DRAFT',$2,$4)`,
    [input.accountId, item.sourceRecordId, category.evidenceId, String(draft.version)]);
    await client.query(`INSERT INTO auto_listing_category_preparation_lease_items(
      account_id,lease_id,collect_item_id,evidence_id,shared_category_id,shared_category_version,
      source_description_category_id,source_type_id,description_category_id,type_id,taxonomy_scope,
      taxonomy_fingerprint,provenance)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [input.accountId, input.categoryPreparationLeaseId, item.sourceRecordId, category.evidenceId,
      category.sharedCategoryId, category.sharedCategoryVersion, category.sourceDescriptionCategoryId,
      category.sourceTypeId, category.descriptionCategoryId, category.typeId, category.taxonomyScope,
      category.taxonomyFingerprint || "", category.provenance]);
  }
  const row = (await client.query(`SELECT lease.state,warehouse.status,warehouse.is_active,warehouse.is_archived
      FROM auto_listing_category_preparation_leases AS lease
      JOIN warehouses AS warehouse ON warehouse.store_id=$3 AND warehouse.id=$4
     WHERE lease.account_id=$1 AND lease.id=$2`,
  [input.accountId, input.categoryPreparationLeaseId,
    input.configSnapshot.targetStoreId, input.configSnapshot.targetWarehouseId])).rows[0];
  assert.deepEqual(row, { state: "ACTIVE", status: "active", is_active: true, is_archived: false });
}

function cleanupState(accountId, storeId) {
  const state = {};
  Object.defineProperty(state, "__deletedAccountScopes", {
    value: [{
      accountId,
      storeIds: [storeId],
      legacyDataStorePurgePolicy: {
        actor: { type: "account", id: accountId },
        reason: "ACCOUNT_DELETION_PRIVACY_ERASURE",
        occurredAt: new Date().toISOString(),
      },
    }],
    configurable: true,
  });
  return state;
}

async function rejectedCode(operation) {
  try { await operation(); return null; } catch (error) { return error?.code || null; }
}

if (!enabled) {
  test("RFBS warehouse PostgreSQL integration is explicitly gated to a disposable migration database", {
    skip: "requires AUTO_LISTING_POSTGRES_TESTS=1 and SONLI_MIGRATION_TEST_DATABASE_URL",
  }, () => {});
} else {
  test("059 persists fresh tenant-bound RFBS evidence atomically and permits only parent-account cleanup", { timeout: 30_000 }, async () => {
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: databaseUrl });
    const client = await pool.connect();
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const schema = `rfbs_task3_${suffix}`;
    const schemaSql = quoteIdentifier(schema);
    const accountA = `account-a-${suffix}`;
    const accountB = `account-b-${suffix}`;
    const accountStoreFirst = `account-store-first-${suffix}`;
    const accountDirect = `account-direct-${suffix}`;
    const storeA = `store-a-${suffix}`;
    const storeB = `store-b-${suffix}`;
    const storeStoreFirst = `store-store-first-${suffix}`;
    const storeDirect = `store-direct-${suffix}`;
    const warehouseA = `warehouse-a-${suffix}`;
    const warehouseB = `warehouse-b-${suffix}`;
    const warehouseStoreFirst = `warehouse-store-first-${suffix}`;
    const warehouseDirect = `warehouse-direct-${suffix}`;
    const regression = {};
    try {
      await client.query(`CREATE SCHEMA ${schemaSql}`);
      await client.query(`SET search_path TO ${schemaSql}, public`);
      for (const migration of (await readdir(migrationsDir)).filter((file) => /^\d{3}_.+\.sql$/.test(file)).sort()) {
        await client.query(await readFile(path.join(migrationsDir, migration), "utf8"));
      }
      for (const [accountId, storeId, warehouseId, platformId] of [
        [accountA, storeA, warehouseA, `platform-a-${suffix}`],
        [accountB, storeB, warehouseB, `platform-b-${suffix}`],
        [accountStoreFirst, storeStoreFirst, warehouseStoreFirst, `platform-store-first-${suffix}`],
        [accountDirect, storeDirect, warehouseDirect, `platform-direct-${suffix}`],
      ]) {
        await client.query("INSERT INTO accounts (id,username,display_name,role,status) VALUES ($1,$2,$2,'admin','active')", [accountId, `user-${accountId}`]);
        await client.query("INSERT INTO stores (id,label,company_name,client_id,status,owner_account_id) VALUES ($1,$2,$2,$3,'active',$4)", [storeId, storeId, `client-${storeId}`, accountId]);
        await client.query("INSERT INTO store_credentials (store_id,client_id,encrypted_api_key,iv,auth_tag) VALUES ($1,$2,'cipher','iv','tag')", [storeId, `client-${storeId}`]);
        await client.query("INSERT INTO warehouses (id,store_id,warehouse_id,warehouse_type,status,is_active,is_archived) VALUES ($1,$2,$3,'RFBS','active',TRUE,FALSE)", [warehouseId, storeId, platformId]);
      }
      for (const accountId of [accountA, accountStoreFirst]) {
        await client.query("INSERT INTO ai_content_strategy_versions (id,account_id,strategy_key,version,status,content,content_hash) VALUES ($1,$2,$3,1,'PUBLISHED','{}'::jsonb,'hash')", [`strategy-${accountId}`, accountId, `strategy-key-${accountId}`]);
        await client.query(`INSERT INTO auto_listing_upload_policy_versions
          (id,account_id,mode,enabled,version,publication_reason,created_by,published_by,published_at,
           publication_origin,publication_base_url,publication_prefix,publication_version,publication_policy_hash)
          VALUES ($1,$2,'REVIEW',TRUE,1,'test',$2,$2,NOW(),'https://cdn.test','https://cdn.test/','media','V1',$3)`,
        [`policy-${accountId}`, accountId, "a".repeat(64)]);
      }
      const scopedPool = {
        async connect() { const connection = await pool.connect(); await connection.query(`SET search_path TO ${schemaSql}, public`); return connection; },
        query: (sql, params) => client.query(sql, params),
      };
      const repository = createAutoListingRepository({ pool: scopedPool });

      await client.query(`INSERT INTO auto_listing_jobs
        (id,account_id,source_type,status,idempotency_key,config_snapshot,config_hash,created_by,correlation_id)
        VALUES ($1,$2,'COLLECT_BOX','CREATED','historical-fbs','{}'::jsonb,'legacy',$2,'legacy')`, [`historical-fbs-${suffix}`, accountA]);
      assert.equal((await client.query("SELECT warehouse_validation_evidence_id FROM auto_listing_jobs WHERE id=$1", [`historical-fbs-${suffix}`])).rows[0].warehouse_validation_evidence_id, null);

      const storeFirstValidation = validation(accountStoreFirst, storeStoreFirst, warehouseStoreFirst,
        `platform-store-first-${suffix}`, `store-first-${suffix}`);
      const storeFirstInput = blockedGraph(accountStoreFirst, storeStoreFirst, warehouseStoreFirst,
        `store-first-${suffix}`, `store-first-${suffix}`, storeFirstValidation);
      await client.query("INSERT INTO collect_items (id,account_id,source,identity_key,source_sku,summary) VALUES ($1,$2,'test',$3,$4,'{}'::jsonb)",
        [storeFirstInput.items[0].sourceRecordId, accountStoreFirst, `identity-store-first-${suffix}`, `sku-store-first-${suffix}`]);
      await establishActiveCategoryPreparationLease(client, storeFirstInput);
      const storeFirstJob = await repository.createJobGraph(storeFirstInput);
      const storeFirstAuditId = `AUTO_LISTING_RFBS_WAREHOUSE_VALIDATED:${storeFirstJob.warehouseValidationEvidenceId}`;
      assert.deepEqual((await client.query(
        "SELECT account_id,store_id FROM audit_events WHERE event_id=$1",
        [storeFirstAuditId],
      )).rows[0], { account_id: accountStoreFirst, store_id: storeStoreFirst });
      assert.equal(await rejectedCode(() => client.query(
        "DELETE FROM auto_listing_rfbs_warehouse_evidence WHERE id=$1",
        [storeFirstJob.warehouseValidationEvidenceId],
      )), "23514");
      assert.equal(await rejectedCode(() => client.query(
        "UPDATE auto_listing_rfbs_warehouse_evidence SET correlation_id='changed' WHERE id=$1",
        [storeFirstJob.warehouseValidationEvidenceId],
      )), "23514");
      assert.equal(await rejectedCode(() => client.query(
        "UPDATE audit_events SET metadata=jsonb_build_object('attack',TRUE) WHERE event_id=$1",
        [storeFirstAuditId],
      )), "23514");
      assert.equal(await rejectedCode(() => client.query(
        "DELETE FROM audit_events WHERE event_id=$1",
        [storeFirstAuditId],
      )), "23514");

      await client.query("SET session_replication_role='replica'");
      try {
        await client.query("DELETE FROM auto_listing_events WHERE job_id=$1", [storeFirstJob.id]);
        await client.query("DELETE FROM auto_listing_job_items WHERE job_id=$1", [storeFirstJob.id]);
        await client.query("DELETE FROM auto_listing_jobs WHERE id=$1", [storeFirstJob.id]);
        await client.query("DELETE FROM auto_listing_upload_policy_versions WHERE account_id=$1", [accountStoreFirst]);
        await client.query("DELETE FROM ai_content_strategy_versions WHERE account_id=$1", [accountStoreFirst]);
      } finally {
        await client.query("SET session_replication_role='origin'");
      }
      let cleanupResult;
      try {
        await client.query("BEGIN");
        cleanupResult = await deleteRemovedAccountScopes(client, cleanupState(accountStoreFirst, storeStoreFirst));
        await client.query("COMMIT");
        regression.storeFirstCleanupCode = null;
      } catch (error) {
        regression.storeFirstCleanupCode = error?.code || null;
        regression.storeFirstCleanupConstraint = error?.constraint || null;
        await client.query("ROLLBACK").catch(() => {});
      }
      if (regression.storeFirstCleanupCode === null) {
        cleanupResult.afterCommit();
        assert.equal(Number((await client.query("SELECT COUNT(*)::INTEGER AS count FROM accounts WHERE id=$1", [accountStoreFirst])).rows[0].count), 0);
        assert.equal(Number((await client.query("SELECT COUNT(*)::INTEGER AS count FROM stores WHERE id=$1", [storeStoreFirst])).rows[0].count), 0);
        assert.equal(Number((await client.query("SELECT COUNT(*)::INTEGER AS count FROM auto_listing_rfbs_warehouse_evidence WHERE id=$1", [storeFirstJob.warehouseValidationEvidenceId])).rows[0].count), 0);
        assert.deepEqual((await client.query(
          "SELECT account_id,store_id FROM audit_events WHERE event_id=$1",
          [storeFirstAuditId],
        )).rows[0], { account_id: null, store_id: null });
      }

      const directEvidence = validation(accountDirect, storeDirect, warehouseDirect,
        `platform-direct-${suffix}`, `direct-${suffix}`);
      await client.query(`INSERT INTO auto_listing_rfbs_warehouse_evidence
        (id,account_id,store_id,warehouse_record_id,platform_warehouse_id,schema_version,fulfillment_type,status,
         outcome,observed_at,expires_at,evidence_hash,correlation_id,actor_account_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [`direct-evidence-${suffix}`, accountDirect, storeDirect, warehouseDirect, directEvidence.platformWarehouseId,
        directEvidence.schemaVersion, directEvidence.fulfillmentType, directEvidence.status, directEvidence.outcome,
        directEvidence.observedAt, directEvidence.expiresAt, directEvidence.evidenceHash,
        directEvidence.correlationId, directEvidence.actorAccountId]);
      const directAuditId = `direct-audit-${suffix}`;
      await client.query(`INSERT INTO audit_events
        (event_id,account_id,store_id,action,entity_type,entity_id,correlation_id,metadata,status,actor_type,
         actor_id,source,occurred_at)
        VALUES ($1,$2,$3,'AUTO_LISTING_RFBS_WAREHOUSE_VALIDATED','auto_listing_rfbs_warehouse_evidence',$4,
          $5,'{}'::jsonb,'SUCCESS','account',$2,'test',STATEMENT_TIMESTAMP())`,
      [directAuditId, accountDirect, storeDirect, `direct-evidence-${suffix}`, directEvidence.correlationId]);
      regression.directAccountCleanupCode = await rejectedCode(() => client.query(
        "DELETE FROM accounts WHERE id=$1", [accountDirect],
      ));
      if (regression.directAccountCleanupCode === null) {
        assert.equal(Number((await client.query("SELECT COUNT(*)::INTEGER AS count FROM auto_listing_rfbs_warehouse_evidence WHERE id=$1", [`direct-evidence-${suffix}`])).rows[0].count), 0);
        assert.deepEqual((await client.query(
          "SELECT account_id,store_id FROM audit_events WHERE event_id=$1", [directAuditId],
        )).rows[0], { account_id: null, store_id: null });
      }

      const expired = validation(accountA, storeA, warehouseA, `platform-a-${suffix}`, `expired-${suffix}`, {
        observedAt: new Date(Date.now() - 60_000).toISOString(), expiresAt: new Date(Date.now() - 30_000).toISOString(),
      });
      assert.equal(await rejectedCode(() => client.query(`INSERT INTO auto_listing_rfbs_warehouse_evidence
        (id,account_id,store_id,warehouse_record_id,platform_warehouse_id,schema_version,fulfillment_type,status,
         outcome,observed_at,expires_at,evidence_hash,correlation_id,actor_account_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [`expired-${suffix}`, accountA, storeA, warehouseA, expired.platformWarehouseId, expired.schemaVersion,
        expired.fulfillmentType, expired.status, expired.outcome, expired.observedAt, expired.expiresAt,
        expired.evidenceHash, expired.correlationId, expired.actorAccountId])), "23514");
      assert.equal(await rejectedCode(() => client.query(`INSERT INTO auto_listing_rfbs_warehouse_evidence
        (id,account_id,store_id,warehouse_record_id,platform_warehouse_id,schema_version,fulfillment_type,status,
         outcome,observed_at,expires_at,evidence_hash,correlation_id,actor_account_id)
        VALUES ('cross',$1,$2,$3,$4,'AUTO_LISTING_RFBS_WAREHOUSE_EVIDENCE_V1','RFBS','ACTIVE','PASSED',NOW(),NOW()+INTERVAL '1 minute',$5,'cross',$1)`,
      [accountA, storeB, warehouseB, `platform-b-${suffix}`, "b".repeat(64)])), "23503");

      const validationA = validation(accountA, storeA, warehouseA, `platform-a-${suffix}`, `commit-${suffix}`);
      const input = graph(accountA, storeA, warehouseA, `rfbs-shared-${suffix}`, `rfbs-${suffix}`, validationA);
      await client.query("INSERT INTO collect_items (id,account_id,source,identity_key,source_sku,summary) VALUES ($1,$2,'test',$3,$4,'{}'::jsonb)",
        [input.items[0].sourceRecordId, accountA, `identity-${suffix}`, input.items[0].snapshot.identity.primarySku]);
      await client.query(`INSERT INTO product_drafts (id,collect_item_id,version,data_hash,data,normalizer_version,category_rule_version,dictionary_version)
        VALUES ($1,$2,1,$3,'{}'::jsonb,'v3','v1','live')`, [`draft-rfbs-${suffix}`, input.items[0].sourceRecordId, "1".repeat(64)]);
      await client.query("UPDATE collect_items SET current_draft_id=$1 WHERE id=$2", [`draft-rfbs-${suffix}`, input.items[0].sourceRecordId]);
      await establishActiveCategoryPreparationLease(client, input);
      const [first, second] = await Promise.all([repository.createJobGraph(structuredClone(input)), repository.createJobGraph(structuredClone(input))]);
      assert.equal(first.id, second.id);
      assert.equal([first.duplicate, second.duplicate].filter(Boolean).length, 1);
      const persisted = (await client.query(`SELECT job.warehouse_validation_evidence_id,
          evidence.evidence_hash,evidence.store_id,evidence.warehouse_record_id
        FROM auto_listing_jobs job JOIN auto_listing_rfbs_warehouse_evidence evidence
          ON evidence.account_id=job.account_id AND evidence.id=job.warehouse_validation_evidence_id
        WHERE job.id=$1`, [first.id])).rows[0];
      assert.deepEqual(persisted, { warehouse_validation_evidence_id: first.warehouseValidationEvidenceId,
        evidence_hash: validationA.evidenceHash, store_id: storeA, warehouse_record_id: warehouseA });
      assert.equal(Number((await client.query("SELECT COUNT(*)::INTEGER AS count FROM auto_listing_rfbs_warehouse_evidence WHERE account_id=$1", [accountA])).rows[0].count), 1);
      assert.equal(Number((await client.query("SELECT COUNT(*)::INTEGER AS count FROM audit_events WHERE account_id=$1 AND action='AUTO_LISTING_RFBS_WAREHOUSE_VALIDATED'", [accountA])).rows[0].count), 1);
      assert.equal(await rejectedCode(() => client.query("INSERT INTO auto_listing_jobs (id,account_id,source_type,status,idempotency_key,config_snapshot,config_hash,created_by,correlation_id,warehouse_validation_evidence_id) VALUES ('cross-job',$1,'COLLECT_BOX','CREATED','cross-job','{}'::jsonb,'x',$1,'cross',$2)", [accountB, first.warehouseValidationEvidenceId])), "23503");

      const consumerEvidenceId = `consumer-evidence-${suffix}`;
      const consumerValidation = validation(accountA, storeA, warehouseA,
        `platform-a-${suffix}`, `consumer-${suffix}`);
      await client.query(`INSERT INTO auto_listing_rfbs_warehouse_evidence
        (id,account_id,store_id,warehouse_record_id,platform_warehouse_id,schema_version,fulfillment_type,status,
         outcome,observed_at,expires_at,evidence_hash,correlation_id,actor_account_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [consumerEvidenceId, accountA, storeA, warehouseA, consumerValidation.platformWarehouseId,
        consumerValidation.schemaVersion, consumerValidation.fulfillmentType, consumerValidation.status,
        consumerValidation.outcome, consumerValidation.observedAt, consumerValidation.expiresAt,
        consumerValidation.evidenceHash, consumerValidation.correlationId, consumerValidation.actorAccountId]);
      const itemBinding = (await client.query(`SELECT item.id AS item_id,item.snapshot_id,
          base.id AS listing_base_id,base.product_draft_data_hash
        FROM auto_listing_job_items item
        JOIN auto_listing_listing_bases base
          ON base.account_id=item.account_id AND base.job_id=item.job_id AND base.item_id=item.id
        WHERE item.account_id=$1 AND item.job_id=$2`, [accountA, first.id])).rows[0];
      const profileId = `profile-${suffix}`;
      const planId = `plan-${suffix}`;
      const linkId = `link-${suffix}`;
      const attemptId = `attempt-${suffix}`;
      const hex = "c".repeat(64);
      await client.query(`INSERT INTO ai_gateway_profiles
        (id,account_id,display_name,base_url,api_key_env_name,text_protocol,image_protocol,text_model,
         image_model,config_version,enabled,created_by)
        VALUES ($1,$2,'Consumer fixture','https://gateway.invalid','TEST_AI_KEY','SUB2API_RESPONSES',
          'SUB2API_OPENAI_IMAGES','text','image',1,FALSE,$2)`, [profileId, accountA]);
      await client.query(`INSERT INTO ai_content_plans
        (id,account_id,job_id,item_id,source_snapshot_id,strategy_version_id,profile_id,strategy_hash,
         config_hash,source_hash,input_hash,planner_model,profile_version,prompt_template_version,plan,plan_hash)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,$8,$8,'text',1,'V1','{}'::jsonb,$8)`,
      [planId, accountA, first.id, itemBinding.item_id, itemBinding.snapshot_id,
        `strategy-${accountA}`, profileId, hex]);
      await client.query(`INSERT INTO auto_listing_submission_links
        (id,account_id,job_id,auto_listing_item_id,listing_base_id,active_plan_id,target_store_id,
         source_hash,config_hash,request_hash,result_hash,upload_policy_version_id,idempotency_key,status,
         warehouse_validation_evidence_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,$8,$8,$9,$10,'FAILED',$11)`,
      [linkId, accountA, first.id, itemBinding.item_id, itemBinding.listing_base_id, planId, storeA,
        hex, `policy-${accountA}`, `link-idempotency-${suffix}`, consumerEvidenceId]);
      await client.query(`INSERT INTO auto_listing_upload_attempts
        (id,account_id,job_id,auto_listing_item_id,submission_link_id,actor_account_id,action,
         expected_item_version,target_store_id,target_warehouse_id,product_draft_hash,request_hash,result_hash,
         outcome,error_code,error_safe,correlation_id,warehouse_validation_evidence_id)
        VALUES ($1,$2,$3,$4,$5,$2,'REVIEW_APPROVE',1,$6,$7,$8,$9,$9,'FAILED','TEST_FAILURE',
          'consumer fixture',$10,$11)`,
      [attemptId, accountA, first.id, itemBinding.item_id, linkId, storeA, warehouseA,
        itemBinding.product_draft_data_hash, hex, `consumer-attempt-${suffix}`, consumerEvidenceId]);
      regression.consumerDeleteTypes = (await client.query(`SELECT conname,confdeltype
        FROM pg_constraint
        WHERE conname IN (
          'auto_listing_submission_links_rfbs_warehouse_evidence_fkey',
          'auto_listing_upload_attempts_rfbs_warehouse_evidence_fkey'
        ) AND connamespace=current_schema()::regnamespace ORDER BY conname`)).rows;
      await client.query("ALTER TABLE auto_listing_rfbs_warehouse_evidence DISABLE TRIGGER auto_listing_rfbs_warehouse_evidence_append_only");
      try {
        regression.boundConsumerDeleteCode = await rejectedCode(() => client.query(
          "DELETE FROM auto_listing_rfbs_warehouse_evidence WHERE id=$1", [consumerEvidenceId],
        ));
      } finally {
        await client.query("ALTER TABLE auto_listing_rfbs_warehouse_evidence ENABLE TRIGGER auto_listing_rfbs_warehouse_evidence_append_only");
      }
      assert.deepEqual((await client.query(`SELECT
          (SELECT warehouse_validation_evidence_id FROM auto_listing_submission_links WHERE id=$1) AS link_evidence_id,
          (SELECT warehouse_validation_evidence_id FROM auto_listing_upload_attempts WHERE id=$2) AS attempt_evidence_id`,
      [linkId, attemptId])).rows[0], {
        link_evidence_id: consumerEvidenceId,
        attempt_evidence_id: consumerEvidenceId,
      });

      const mismatch = structuredClone(input);
      mismatch.warehouseValidation = validation(accountA, storeA, warehouseA, `platform-a-${suffix}`, `different-${suffix}`);
      mismatch.correlationId = mismatch.warehouseValidation.correlationId;
      await assert.rejects(repository.createJobGraph(mismatch), { code: "AUTO_LISTING_WAREHOUSE_EVIDENCE_CONFLICT", status: 409 });

      await client.query(`CREATE OR REPLACE FUNCTION ${schemaSql}.fail_rfbs_audit() RETURNS TRIGGER LANGUAGE plpgsql AS $$
        BEGIN IF NEW.action='AUTO_LISTING_RFBS_WAREHOUSE_VALIDATED' AND NEW.correlation_id LIKE 'force-rollback-%'
          THEN RAISE EXCEPTION 'forced RFBS audit failure'; END IF; RETURN NEW; END; $$`);
      await client.query(`CREATE TRIGGER fail_rfbs_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION ${schemaSql}.fail_rfbs_audit()`);
      const rollbackValidation = validation(accountA, storeA, warehouseA, `platform-a-${suffix}`, `force-rollback-${suffix}`);
      const rollbackInput = graph(accountA, storeA, warehouseA, `rollback-${suffix}`, `rollback-${suffix}`, rollbackValidation);
      await client.query("INSERT INTO collect_items (id,account_id,source,identity_key,source_sku,summary) VALUES ($1,$2,'test',$3,$4,'{}'::jsonb)",
        [rollbackInput.items[0].sourceRecordId, accountA, `identity-rollback-${suffix}`, rollbackInput.items[0].snapshot.identity.primarySku]);
      await client.query(`INSERT INTO product_drafts (id,collect_item_id,version,data_hash,data,normalizer_version,category_rule_version,dictionary_version)
        VALUES ($1,$2,1,$3,'{}'::jsonb,'v3','v1','live')`, [`draft-rollback-${suffix}`, rollbackInput.items[0].sourceRecordId, "1".repeat(64)]);
      await client.query("UPDATE collect_items SET current_draft_id=$1 WHERE id=$2", [`draft-rollback-${suffix}`, rollbackInput.items[0].sourceRecordId]);
      await establishActiveCategoryPreparationLease(client, rollbackInput);
      await assert.rejects(repository.createJobGraph(rollbackInput));
      assert.equal(Number((await client.query("SELECT COUNT(*)::INTEGER AS count FROM auto_listing_jobs WHERE account_id=$1 AND idempotency_key=$2", [accountA, rollbackInput.idempotencyKey])).rows[0].count), 0);
      assert.equal(Number((await client.query("SELECT COUNT(*)::INTEGER AS count FROM auto_listing_rfbs_warehouse_evidence WHERE account_id=$1 AND correlation_id=$2", [accountA, rollbackValidation.correlationId])).rows[0].count), 0);

      assert.deepEqual(regression, {
        storeFirstCleanupCode: null,
        directAccountCleanupCode: null,
        consumerDeleteTypes: [
          { conname: "auto_listing_submission_links_rfbs_warehouse_evidence_fkey", confdeltype: "r" },
          { conname: "auto_listing_upload_attempts_rfbs_warehouse_evidence_fkey", confdeltype: "r" },
        ],
        boundConsumerDeleteCode: "23503",
      });

    } finally {
      await client.query("RESET search_path").catch(() => {});
      await client.query(`DROP SCHEMA IF EXISTS ${schemaSql} CASCADE`).catch(() => {});
      client.release();
      await pool.end();
    }
  });
}
