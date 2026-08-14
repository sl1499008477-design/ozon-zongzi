import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { normalizeAndHashAutoListingConfig } from "../auto-listing-contract.mjs";
import { createPostgresContentPlanEvidenceRepository } from "../auto-listing-content-plan-evidence-postgres.mjs";
import { createPostgresAutoListingPlanDiagnosticContextRepository } from "../auto-listing-plan-diagnostic-context-postgres.mjs";
import { createPostgresAutoListingPlanDiagnosticRepository } from "../auto-listing-plan-diagnostic-postgres.mjs";
import { createAutoListingPlanDiagnosticService } from "../auto-listing-plan-diagnostic-service.mjs";
import { buildAutoListingSourceSnapshot } from "../auto-listing-source-snapshot.mjs";

const databaseUrl = process.env.SONLI_MIGRATION_TEST_DATABASE_URL;
const enabled = process.env.AUTO_LISTING_POSTGRES_TESTS === "1" && Boolean(databaseUrl);
const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../db/migrations");
const quote = (value) => `"${String(value).replaceAll('"', '""')}"`;

if (!enabled) {
  test("plan diagnostic replay PostgreSQL behavior requires explicit nonproduction gates", {
    skip: "requires AUTO_LISTING_POSTGRES_TESTS=1 and SONLI_MIGRATION_TEST_DATABASE_URL",
  }, () => {});
} else {
  test("one paid text replay diagnoses the frozen failed item without task, image, upload or Ozon writes", {
    timeout: 30_000,
  }, async () => {
    const { Pool } = await import("pg");
    const rootPool = new Pool({ connectionString: databaseUrl, max: 1 });
    const admin = await rootPool.connect();
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const schema = `plan_diagnostic_${suffix}`;
    const schemaSql = quote(schema);
    let pool;
    try {
      await admin.query(`CREATE SCHEMA ${schemaSql}`);
      await admin.query(`SET search_path TO ${schemaSql}, public`);
      for (const migration of (await readdir(migrationsDir)).filter((file) => /^\d{3}_.+\.sql$/u.test(file)).sort()) {
        await admin.query(await readFile(path.join(migrationsDir, migration), "utf8"));
      }
      pool = new Pool({
        connectionString: databaseUrl,
        max: 4,
        options: `-c search_path=${schema},public`,
      });
      const ids = Object.fromEntries([
        "account", "store", "warehouse", "strategy", "snapshot", "job", "item", "profile",
      ].map((name) => [name, `${name}-${suffix}`]));
      await pool.query(
        "INSERT INTO accounts (id,username,display_name,role,status) VALUES ($1,$2,$2,'admin','active')",
        [ids.account, `admin-${suffix}`],
      );
      await pool.query(
        "INSERT INTO stores (id,label,company_name,client_id,status,owner_account_id) VALUES ($1,$2,$2,$3,'active',$4)",
        [ids.store, `Store ${suffix}`, `client-${suffix}`, ids.account],
      );
      await pool.query(
        "INSERT INTO warehouses (id,store_id,warehouse_id,warehouse_type,status,is_active,is_archived) VALUES ($1,$2,$3,'FBS','active',TRUE,FALSE)",
        [ids.warehouse, ids.store, `platform-${suffix}`],
      );
      await pool.query(
        `INSERT INTO ai_gateway_profiles (
           id,account_id,display_name,base_url,api_key_env_name,text_protocol,image_protocol,
           text_model,image_model,config_version,enabled
         ) VALUES ($1,$2,'Diagnostic profile','https://gateway.example.test/tenant/v1','TEST_AI_KEY',
           'SUB2API_RESPONSES','SUB2API_OPENAI_IMAGES','text-model-a','image-model-a',3,TRUE)`,
        [ids.profile, ids.account],
      );
      await pool.query(
        "INSERT INTO ai_content_strategy_versions (id,account_id,strategy_key,version,status,content,content_hash) VALUES ($1,$2,'default',1,'DRAFT','{}'::JSONB,$3)",
        [ids.strategy, ids.account, "strategy-hash"],
      );
      await pool.query(
        `INSERT INTO ai_content_strategy_rules
           (id,account_id,strategy_version_id,rule_kind,rule_order,category_id,rule)
         VALUES ($1,$2,$3,'EXACT_CATEGORY',1,'170',$4::JSONB)`,
        [`rule-${suffix}`, ids.account, ids.strategy, JSON.stringify({
          style: "VISUAL_FIRST", textDensityByRole: {},
        })],
      );
      await pool.query(
        "UPDATE ai_content_strategy_versions SET status='PUBLISHED',published_at=NOW(),published_by=$2 WHERE id=$1",
        [ids.strategy, ids.account],
      );
      const source = buildAutoListingSourceSnapshot({
        accountId: ids.account,
        sourceType: "COLLECT_BOX",
        sourceRecordId: `collect-${suffix}`,
        sourceVersion: "draft:1",
        targetStoreCurrency: "RUB",
        categoryEvidence: {
          id: `evidence-${suffix}`, accountId: ids.account,
          sourceDescriptionCategoryId: 170, sourceTypeId: 99, taxonomyScope: "OZON:DEFAULT",
        },
        sharedCategory: {
          id: `shared-${suffix}`, accountId: ids.account, version: 1,
          evidenceId: `evidence-${suffix}`, status: "ACTIVE", source: "SOURCE_DIRECT",
          sourceDescriptionCategoryId: 170, sourceTypeId: 99,
          currentDescriptionCategoryId: 170, currentTypeId: 99,
          taxonomyScope: "OZON:DEFAULT", taxonomyFingerprint: null,
        },
        collectItem: { id: `collect-${suffix}`, accountId: ids.account, listingDraft: {
          sku: "sku-a", title: "商品 A", brand: "Brand A", blackKopecks: "8000", greenKopecks: "7000",
          categoryResolution: { status: "MATCHED", method: "taxonomy", target: {
            storeId: ids.store, descriptionCategoryId: "170", typeId: "99",
          } },
          descriptionCategoryId: "170", typeId: "99", productStyle: "UNKNOWN", currency: "RUB",
          attributes: [], logistics: { length: 10, width: 10, height: 10, dimensionUnit: "mm" },
          productMeasurements: {}, images: [{ assetId: "source-a", contentHash: "3".repeat(64) }],
          variants: [{ sku: "sku-a", offerId: "offer-a", name: "商品 A",
            images: [{ assetId: "source-a", contentHash: "3".repeat(64) }] }],
        } },
        productDraft: { id: `draft-${suffix}`, version: 1 },
        rawResponseRef: `raw-${suffix}`, rawResponseHash: "4".repeat(64),
      });
      const { config, configHash } = normalizeAndHashAutoListingConfig({
        targetStoreId: ids.store,
        targetWarehouseId: ids.warehouse,
        stock: 5,
        priceAdjustmentKopecks: "0",
        image: {
          ratio: "3:4", resolution: "1K", quality: "Medium", language: "ru",
          roles: { main: 1, sellingPoint: 2, detail: 1, scene: 1, specification: 0, infographic: 1 },
        },
      });
      await pool.query(
        `INSERT INTO auto_listing_source_snapshots
           (id,account_id,source_type,source_record_id,source_version,snapshot,snapshot_hash,raw_response_ref)
         VALUES ($1,$2,'COLLECT_BOX',$3,'draft:1',$4::JSONB,$5,$6)`,
        [ids.snapshot, ids.account, `collect-${suffix}`, JSON.stringify(source.snapshot), source.snapshotHash, `raw-${suffix}`],
      );
      await pool.query(
        `INSERT INTO auto_listing_jobs (
           id,account_id,source_type,status,idempotency_key,config_snapshot,config_hash,
           strategy_version_id,ai_profile_id,ai_profile_version,correlation_id
         ) VALUES ($1,$2,'COLLECT_BOX','PLANNING',$3,$4::JSONB,$5,$6,$7,3,$8)`,
        [ids.job, ids.account, `job-intent-${suffix}`, JSON.stringify(config), configHash,
          ids.strategy, ids.profile, `job-correlation-${suffix}`],
      );
      await pool.query(
        `INSERT INTO auto_listing_job_items (
           id,job_id,account_id,snapshot_id,target_store_id,target_warehouse_id,status,status_version,
           failure_code,planning_contract
         ) VALUES ($1,$2,$3,$4,$5,$6,'BLOCKED',9,'AUTO_LISTING_CONTENT_PLAN_INVALID','LEGACY_FULL_PLAN_V3')`,
        [ids.item, ids.job, ids.account, ids.snapshot, ids.store, ids.warehouse],
      );

      const gatewayCalls = [];
      const gateway = Object.freeze({
        async createTextResponse(input) {
          gatewayCalls.push(input);
          return { requestId: `gateway-${suffix}`, value: { version: 1, language: "ru", slots: [] } };
        },
      });
      const contextRepository = createPostgresAutoListingPlanDiagnosticContextRepository({
        pool,
        id: () => `diagnostic-${suffix}`,
      });
      const evidenceRepository = createPostgresContentPlanEvidenceRepository({
        pool,
        responseId: () => `response-${suffix}`,
        validationId: () => `validation-${suffix}`,
      });
      const repository = createPostgresAutoListingPlanDiagnosticRepository({ pool });
      const service = createAutoListingPlanDiagnosticService({
        repository, contextRepository, evidenceRepository, gateway,
        now: () => "2026-08-14T02:00:00.000Z",
      });
      const request = {
        actor: { id: ids.account, role: "admin" },
        jobId: ids.job,
        itemId: ids.item,
        sourceSnapshotId: ids.snapshot,
        expectedStatusVersion: 9,
        costConfirmed: true,
        idempotencyKey: `diagnostic-once-${suffix}`,
        correlationId: `diagnostic-correlation-${suffix}`,
      };
      const before = await pool.query(
        "SELECT status,status_version,failure_code,active_content_plan_id FROM auto_listing_job_items WHERE account_id=$1 AND id=$2",
        [ids.account, ids.item],
      );
      const first = await service.replay(request);
      assert.equal(first.created, true);
      assert.equal(first.detail.validation.status, "REJECTED");
      assert.ok(first.detail.validation.issues.length >= 1);
      assert.equal(gatewayCalls.length, 1);
      const replay = await service.replay(request);
      assert.equal(replay.created, false);
      assert.equal(replay.detail.responseId, first.detail.responseId);
      assert.equal(gatewayCalls.length, 1);

      const counts = await pool.query(
        `SELECT
           (SELECT COUNT(*)::INTEGER FROM auto_listing_content_plan_diagnostic_runs WHERE account_id=$1) AS runs,
           (SELECT COUNT(*)::INTEGER FROM auto_listing_content_plan_responses WHERE account_id=$1 AND diagnostic_run_id IS NOT NULL) AS responses,
           (SELECT COUNT(*)::INTEGER FROM auto_listing_content_plan_validation_results WHERE account_id=$1) AS validations,
           (SELECT COUNT(*)::INTEGER FROM ai_content_plans WHERE account_id=$1) AS plans,
           (SELECT COUNT(*)::INTEGER FROM ai_generation_assets WHERE account_id=$1) AS assets,
           (SELECT COUNT(*)::INTEGER FROM auto_listing_ai_outbox WHERE account_id=$1) AS ai_outbox`,
        [ids.account],
      );
      assert.deepEqual(counts.rows[0], {
        runs: 1, responses: 1, validations: 1, plans: 0, assets: 0, ai_outbox: 0,
      });
      const after = await pool.query(
        "SELECT status,status_version,failure_code,active_content_plan_id FROM auto_listing_job_items WHERE account_id=$1 AND id=$2",
        [ids.account, ids.item],
      );
      assert.deepEqual(after.rows, before.rows);
      await assert.rejects(service.replay({ ...request, sourceSnapshotId: `wrong-${suffix}` }));
      await assert.rejects(service.replay({ ...request, correlationId: `different-${suffix}` }), {
        code: "AUTO_LISTING_PLAN_DIAGNOSTIC_IDEMPOTENCY_CONFLICT",
      });
      assert.equal(gatewayCalls.length, 1);
    } finally {
      try {
        await pool?.end();
        await admin.query("SET search_path TO public");
        await admin.query(`DROP SCHEMA IF EXISTS ${schemaSql} CASCADE`);
      } finally {
        admin.release();
        await rootPool.end();
      }
    }
  });
}
