import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createAutoListingRepository } from "../auto-listing-repository.mjs";
import { normalizeAndHashAutoListingConfig } from "../auto-listing-contract.mjs";
import { deriveEffectiveAutoListingImageConfig } from "../auto-listing-item-image-config.mjs";
import { buildAutoListingSourceSnapshot } from "../auto-listing-source-snapshot.mjs";

const databaseUrl = process.env.SONLI_MIGRATION_TEST_DATABASE_URL;
const enabled = process.env.AUTO_LISTING_POSTGRES_TESTS === "1" && Boolean(databaseUrl);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(__dirname, "../db/migrations");
const quoteIdentifier = (value) => `"${String(value).replaceAll('"', '""')}"`;
const hashJson = (value) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");

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
    accountId, actorAccountId: accountId, sourceType: "COLLECT_BOX", idempotencyKey,
    correlationId: warehouseValidation.correlationId, configSnapshot: config, configHash,
    strategyVersionId: `strategy-${accountId}`, uploadPolicyVersionId: `policy-${accountId}`,
    warehouseValidation,
    items: [{
      sourceType: "COLLECT_BOX", sourceRecordId, sourceVersion: "1", snapshot: captured.snapshot,
      snapshotHash: captured.snapshotHash, rawResponseRef: captured.rawResponseRef,
      targetStoreId: storeId, targetWarehouseId: warehouseId, sourceOrder: 0, status: "SOURCE_READY",
      strategyId: `strategy-key-${accountId}`, strategyVersionId: `strategy-${accountId}`,
      ruleId: null, style: "BALANCED_DEFAULT", matchedBy: "DEFAULT",
      price: { currency: "RUB", branch: "BLACK_GTE_80", blackKopecks: "10000", greenKopecks: "8000",
        realPriceKopecks: "14500", adjustmentKopecks: "0", finalPriceKopecks: "14500" },
      effectiveImageConfig: deriveEffectiveAutoListingImageConfig({ configSnapshot: config, configHash, sourceCapture: captured }),
      listingBaseTemplate: {
        productDraft: { id: `draft-${sourceSuffix}`, version: 1, dataHash: "1".repeat(64) },
        pricingEvidence: { currency: "RUB", blackKopecks: "10000", greenKopecks: "8000",
          evidenceHash: "767a5b396ef1e82c9ebf280694cb5cb97ea39d654af13a0f78e021cad0db36c2" },
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
    const accountCleanup = `account-cleanup-${suffix}`;
    const storeA = `store-a-${suffix}`;
    const storeB = `store-b-${suffix}`;
    const storeCleanup = `store-cleanup-${suffix}`;
    const warehouseA = `warehouse-a-${suffix}`;
    const warehouseB = `warehouse-b-${suffix}`;
    const warehouseCleanup = `warehouse-cleanup-${suffix}`;
    try {
      await client.query(`CREATE SCHEMA ${schemaSql}`);
      await client.query(`SET search_path TO ${schemaSql}, public`);
      for (const migration of (await readdir(migrationsDir)).filter((file) => /^\d{3}_.+\.sql$/.test(file)).sort()) {
        await client.query(await readFile(path.join(migrationsDir, migration), "utf8"));
      }
      for (const [accountId, storeId, warehouseId, platformId] of [
        [accountA, storeA, warehouseA, `platform-a-${suffix}`],
        [accountB, storeB, warehouseB, `platform-b-${suffix}`],
        [accountCleanup, storeCleanup, warehouseCleanup, `platform-cleanup-${suffix}`],
      ]) {
        await client.query("INSERT INTO accounts (id,username,display_name,role,status) VALUES ($1,$2,$2,'admin','active')", [accountId, `user-${accountId}`]);
        await client.query("INSERT INTO stores (id,label,company_name,client_id,status,owner_account_id) VALUES ($1,$2,$2,$3,'active',$4)", [storeId, storeId, `client-${storeId}`, accountId]);
        await client.query("INSERT INTO store_credentials (store_id,client_id,encrypted_api_key,iv,auth_tag) VALUES ($1,$2,'cipher','iv','tag')", [storeId, `client-${storeId}`]);
        await client.query("INSERT INTO warehouses (id,store_id,warehouse_id,warehouse_type,status,is_active,is_archived) VALUES ($1,$2,$3,'RFBS','active',TRUE,FALSE)", [warehouseId, storeId, platformId]);
      }
      await client.query("INSERT INTO ai_content_strategy_versions (id,account_id,strategy_key,version,status,content,content_hash) VALUES ($1,$2,$3,1,'PUBLISHED','{}'::jsonb,'hash')", [`strategy-${accountA}`, accountA, `strategy-key-${accountA}`]);
      await client.query(`INSERT INTO auto_listing_upload_policy_versions
        (id,account_id,mode,enabled,version,publication_reason,created_by,published_by,published_at,
         publication_origin,publication_base_url,publication_prefix,publication_version,publication_policy_hash)
        VALUES ($1,$2,'REVIEW',TRUE,1,'test',$2,$2,NOW(),'https://cdn.test','https://cdn.test/','media','V1',$3)`,
      [`policy-${accountA}`, accountA, "a".repeat(64)]);

      await client.query(`INSERT INTO auto_listing_jobs
        (id,account_id,source_type,status,idempotency_key,config_snapshot,config_hash,created_by,correlation_id)
        VALUES ($1,$2,'COLLECT_BOX','CREATED','historical-fbs','{}'::jsonb,'legacy',$2,'legacy')`, [`historical-fbs-${suffix}`, accountA]);
      assert.equal((await client.query("SELECT warehouse_validation_evidence_id FROM auto_listing_jobs WHERE id=$1", [`historical-fbs-${suffix}`])).rows[0].warehouse_validation_evidence_id, null);

      const cleanupEvidence = validation(accountCleanup, storeCleanup, warehouseCleanup, `platform-cleanup-${suffix}`, `cleanup-${suffix}`);
      await client.query(`INSERT INTO auto_listing_rfbs_warehouse_evidence
        (id,account_id,store_id,warehouse_record_id,platform_warehouse_id,schema_version,fulfillment_type,status,
         outcome,observed_at,expires_at,evidence_hash,correlation_id,actor_account_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [`cleanup-evidence-${suffix}`, accountCleanup, storeCleanup, warehouseCleanup, cleanupEvidence.platformWarehouseId,
        cleanupEvidence.schemaVersion, cleanupEvidence.fulfillmentType, cleanupEvidence.status, cleanupEvidence.outcome,
        cleanupEvidence.observedAt, cleanupEvidence.expiresAt, cleanupEvidence.evidenceHash,
        cleanupEvidence.correlationId, cleanupEvidence.actorAccountId]);
      assert.equal(await rejectedCode(() => client.query("DELETE FROM auto_listing_rfbs_warehouse_evidence WHERE id=$1", [`cleanup-evidence-${suffix}`])), "23514");
      assert.equal(await rejectedCode(() => client.query("UPDATE auto_listing_rfbs_warehouse_evidence SET correlation_id='changed' WHERE id=$1", [`cleanup-evidence-${suffix}`])), "23514");
      await client.query(`INSERT INTO auto_listing_jobs
        (id,account_id,source_type,status,idempotency_key,config_snapshot,config_hash,created_by,correlation_id,
         warehouse_validation_evidence_id)
        VALUES ($1,$2,'COLLECT_BOX','CREATED','cleanup-bound','{}'::jsonb,'cleanup',$2,'cleanup',$3)`,
      [`cleanup-job-${suffix}`, accountCleanup, `cleanup-evidence-${suffix}`]);
      await client.query("DELETE FROM accounts WHERE id=$1", [accountCleanup]);
      assert.equal(Number((await client.query("SELECT COUNT(*)::INTEGER AS count FROM auto_listing_rfbs_warehouse_evidence WHERE account_id=$1", [accountCleanup])).rows[0].count), 0);
      assert.equal(Number((await client.query("SELECT COUNT(*)::INTEGER AS count FROM auto_listing_jobs WHERE account_id=$1", [accountCleanup])).rows[0].count), 0);

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
      const scopedPool = {
        async connect() { const connection = await pool.connect(); await connection.query(`SET search_path TO ${schemaSql}, public`); return connection; },
        query: (sql, params) => client.query(sql, params),
      };
      const repository = createAutoListingRepository({ pool: scopedPool });
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
      await assert.rejects(repository.createJobGraph(rollbackInput));
      assert.equal(Number((await client.query("SELECT COUNT(*)::INTEGER AS count FROM auto_listing_jobs WHERE account_id=$1 AND idempotency_key=$2", [accountA, rollbackInput.idempotencyKey])).rows[0].count), 0);
      assert.equal(Number((await client.query("SELECT COUNT(*)::INTEGER AS count FROM auto_listing_rfbs_warehouse_evidence WHERE account_id=$1 AND correlation_id=$2", [accountA, rollbackValidation.correlationId])).rows[0].count), 0);

    } finally {
      await client.query("RESET search_path").catch(() => {});
      await client.query(`DROP SCHEMA IF EXISTS ${schemaSql} CASCADE`).catch(() => {});
      client.release();
      await pool.end();
    }
  });
}
