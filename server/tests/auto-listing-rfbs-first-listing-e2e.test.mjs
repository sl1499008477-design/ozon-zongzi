import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { normalizeAndHashAutoListingConfig } from "../auto-listing-contract.mjs";
import { buildGeneratedAssetObjectKey } from "../auto-listing-asset-store.mjs";
import { createAutoListingRepository } from "../auto-listing-repository.mjs";
import { createAutoListingRfbsWarehouseVerifier } from "../auto-listing-rfbs-warehouse-verifier.mjs";
import { createAutoListingService } from "../auto-listing-service.mjs";
import { createPostgresAutoListingUploadRepository } from "../auto-listing-upload-postgres.mjs";
import { createAutoListingUploadService } from "../auto-listing-upload-service.mjs";
import { createPostgresListingAssetPublicationRepository } from "../listing-asset-publication-postgres.mjs";

const connectionString = process.env.SONLI_MIGRATION_TEST_DATABASE_URL;
const enabled = process.env.AUTO_LISTING_POSTGRES_TESTS === "1" && Boolean(connectionString);
const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../db/migrations");
const quote = (value) => `"${String(value).replaceAll('"', '""')}"`;
const H = (character) => character.repeat(64);
const canonical = (value) => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const digest = (value) => crypto.createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");

const publicationPolicy = Object.freeze({
  origin: "https://cdn.example.com",
  baseUrl: "https://cdn.example.com/",
  prefix: "listing-media/v1",
  publicationVersion: "LISTING_MEDIA_V1",
});

function listingVariant(offerId) {
  return {
    offer_id: offerId,
    name: `RFBS ${offerId}`,
    price: "100.00",
    currency_code: "RUB",
    description_category_id: 17028702,
    type_id: 92576,
    weight: 500,
    weight_unit: "g",
    depth: 200,
    width: 100,
    height: 50,
    dimension_unit: "mm",
    images: ["https://cdn.example.com/rfbs.jpg"],
    primary_image: "https://cdn.example.com/rfbs.jpg",
    attributes: [{ complex_id: 0, id: 85, values: [{ value: "Brand" }] }],
  };
}

function configFor(scenario) {
  return normalizeAndHashAutoListingConfig({
    targetStoreId: scenario.store,
    targetWarehouseId: scenario.warehouse,
    stock: 5,
    priceAdjustmentKopecks: "0",
    image: { ratio: "3:4", resolution: "1K", quality: "Medium", language: "ru",
      roles: { main: 1, sellingPoint: 2, detail: 1, scene: 1, specification: 0, infographic: 1 } },
  }).config;
}

function listingDraftFor(scenario) {
  return {
    sku: scenario.offer,
    offerId: scenario.offer,
    title: `RFBS ${scenario.name}`,
    currency: "RUB",
    blackKopecks: "10000",
    greenKopecks: "8000",
    sourceCategory: { descriptionCategoryId: 17028702, typeIdCandidate: 92576 },
    logistics: { weightG: 799, lengthMm: 350, widthMm: 85, heightMm: 50 },
    images: [],
    variants: [{ sku: scenario.offer, offerId: scenario.offer }],
    categoryResolution: { status: "MATCHED", method: "test",
      target: { storeId: scenario.store, descriptionCategoryId: "17028702", typeId: "92576" },
      source: { path: [] } },
  };
}

function prepareListingBase({ source, pricingEvidence }) {
  return {
    productDraft: { id: source.productDraft.id, version: source.productDraft.version,
      dataHash: source.productDraft.dataHash },
    pricingEvidence: { ...pricingEvidence, evidenceHash: digest(pricingEvidence) },
    richContentAttributeSupported: true,
    variants: [{ sourceVariantId: `variant-${source.id}`, sourceSku: source.collectItem.listingDraft.sku,
      item: listingVariant(source.collectItem.listingDraft.offerId) }],
    versions: { normalizerVersion: source.productDraft.normalizerVersion,
      categoryRuleVersion: source.productDraft.categoryRuleVersion,
      dictionaryVersion: source.productDraft.dictionaryVersion },
  };
}

function controlledGeneratedDraft({
  listingBase, visualGroups, acceptedAssets, acceptedRichContent, frozenConfig,
  targetWarehousePlatformId, publicationPolicy: policy,
}) {
  assert.equal(visualGroups.accountId, listingBase.accountId);
  assert.equal(visualGroups.itemId, listingBase.itemId);
  assert.equal(acceptedAssets.length, 6);
  assert.deepEqual(acceptedRichContent, []);
  assert.equal(policy.origin, publicationPolicy.origin);
  const images = acceptedAssets.map((asset) => asset.publishedUrl);
  const items = listingBase.variants.map(({ item }) => ({ ...item, images,
    primary_image: images[acceptedAssets.findIndex((asset) => asset.role === "MAIN")], price: "145.00" }));
  const stocks = items.map((item) => ({ offer_id: item.offer_id,
    warehouse_id: targetWarehousePlatformId, stock: frozenConfig.config.stock }));
  return Object.freeze({
    listingBaseHash: listingBase.canonicalHash,
    planId: visualGroups.planId,
    resultHash: digest({ listingBaseHash: listingBase.canonicalHash, images, stocks }),
    items,
    stocks,
    versions: { ...listingBase.versions,
      richContentRuleVersion: "AUTO_LISTING_OZON_RICH_CONTENT_V1_UNVERIFIED" },
  });
}

async function requestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

if (!enabled) {
  test("RFBS first-listing E2E is explicitly gated to a disposable migration database", {
    skip: "requires AUTO_LISTING_POSTGRES_TESTS=1 and SONLI_MIGRATION_TEST_DATABASE_URL",
  }, () => {});
} else {
  test("zero-product RFBS first listing stays tenant-bound from read-only verification through stock update", {
    timeout: 120_000,
  }, async () => {
    const { Pool } = await import("pg");
    const adminPool = new Pool({ connectionString, max: 2 });
    const admin = await adminPool.connect();
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const schema = `rfbs_first_listing_${suffix}`;
    const calls = [];
    const remoteByClientId = new Map();
    const taskById = new Map();
    let taskSequence = 700_000;
    const fakeOzon = http.createServer(async (request, response) => {
      const body = await requestBody(request).catch(() => ({}));
      const clientId = String(request.headers["client-id"] || "");
      const pathName = String(request.url || "");
      const offerId = String(body?.items?.[0]?.offer_id || body?.stocks?.[0]?.offer_id || "");
      calls.push({ path: pathName, clientId, offerId });
      response.setHeader("content-type", "application/json");
      if (pathName === "/v2/warehouse/list") {
        const remote = remoteByClientId.get(clientId);
        response.end(JSON.stringify({ result: { warehouses: remote ? [remote] : [] } }));
        return;
      }
      if (pathName === "/v3/product/import") {
        if (offerId.includes("ambiguous")) {
          request.socket.destroy();
          return;
        }
        const taskId = ++taskSequence;
        taskById.set(String(taskId), offerId);
        response.end(JSON.stringify({ result: { task_id: taskId } }));
        return;
      }
      if (pathName === "/v1/product/import/info") {
        const savedOffer = taskById.get(String(body?.task_id || "")) || "unknown";
        response.end(JSON.stringify({ result: { items: [
          { offer_id: savedOffer, product_id: taskSequence + 1000, status: "imported" },
        ] } }));
        return;
      }
      if (pathName === "/v2/products/stocks") {
        if (offerId.includes("stock-fail")) {
          response.statusCode = 503;
          response.end(JSON.stringify({ code: "STOCK_TEMPORARY_FAILURE" }));
          return;
        }
        response.end(JSON.stringify({ result: [] }));
        return;
      }
      response.statusCode = 404;
      response.end("{}");
    });
    let pool;
    let closePostgresPool;
    try {
      await new Promise((resolve, reject) => {
        fakeOzon.once("error", reject);
        fakeOzon.listen(0, "127.0.0.1", resolve);
      });
      const address = fakeOzon.address();
      assert.equal(typeof address, "object");
      await admin.query(`CREATE SCHEMA ${quote(schema)}`);
      await admin.query(`SET search_path TO ${quote(schema)}, public`);
      const migrations = (await readdir(migrationsDir)).filter((file) => /^\d{3}_.+\.sql$/u.test(file)).sort();
      assert.equal(migrations.at(-1)?.startsWith("060_"), true, "E2E must include RESERVED authorization migration 060");
      for (const migration of migrations) await admin.query(await readFile(path.join(migrationsDir, migration), "utf8"));
      await admin.query("CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY,applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
      for (const migration of migrations) {
        await admin.query("INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT DO NOTHING",
          [migration.replace(/\.sql$/u, "")]);
      }
      process.env.APP_ENCRYPTION_KEY = `rfbs-e2e-${suffix}-local-only-key-material`;
      process.env.LISTING_PIPELINE_V3 = "1";
      process.env.OZON_API_BASE = `http://127.0.0.1:${address.port}`;
      const scopedUrl = new URL(connectionString);
      scopedUrl.searchParams.set("options", `-c search_path=${schema},public`);
      process.env.DATABASE_URL = scopedUrl.toString();
      const [{ encryptSecret }, { callOzonSellerApi }] = await Promise.all([
        import("../crypto-secrets.mjs"), import("../ozon-client.mjs"),
      ]);
      const encrypted = encryptSecret("fake-ozon-api-key");
      pool = new Pool({ connectionString, max: 8, options: `-c search_path=${schema},public` });
      const scopedPool = {
        connect: async () => {
          const client = await pool.connect();
          await client.query(`SET search_path TO ${quote(schema)}, public`);
          return client;
        },
        query: (...args) => pool.query(...args),
      };
      const creationRepository = createAutoListingRepository({ pool: scopedPool });
      const uploadRepository = createPostgresAutoListingUploadRepository({ pool: scopedPool });
      const publicationRepository = createPostgresListingAssetPublicationRepository({ pool: scopedPool });

      async function seedScenario(name) {
        const scenario = Object.fromEntries([
          "account", "store", "warehouse", "collect", "draft", "strategy", "policy", "profile", "plan",
        ].map((key) => [key, `${name}-${key}-${suffix}`]));
        scenario.name = name;
        scenario.clientId = `${name}-client-${suffix}`;
        scenario.platformWarehouseId = `${name}-platform-${suffix}`;
        scenario.offer = `offer-${name}-${suffix}`;
        scenario.strategyKey = `strategy-key-${name}-${suffix}`;
        scenario.raw = `raw-${name}-${suffix}`;
        await admin.query("INSERT INTO accounts (id,username,display_name,role,status) VALUES ($1,$2,$2,'admin','active')",
          [scenario.account, `${name}-${suffix}`]);
        await admin.query("INSERT INTO stores (id,label,company_name,client_id,status,owner_account_id) VALUES ($1,$2,$2,$3,'active',$4)",
          [scenario.store, name, scenario.clientId, scenario.account]);
        await admin.query(`INSERT INTO store_credentials
          (store_id,client_id,encrypted_api_key,iv,auth_tag,algorithm,key_version)
          VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [scenario.store, scenario.clientId, encrypted.ciphertext, encrypted.iv, encrypted.authTag,
          encrypted.algorithm, encrypted.keyVersion]);
        await admin.query(`INSERT INTO warehouses
          (id,store_id,warehouse_id,warehouse_type,status,is_active,is_archived)
          VALUES ($1,$2,$3,'RFBS','active',TRUE,FALSE)`,
        [scenario.warehouse, scenario.store, scenario.platformWarehouseId]);
        const draftData = listingDraftFor(scenario);
        await admin.query("INSERT INTO collect_items (id,account_id,source,identity_key,source_sku,summary) VALUES ($1,$2,'test',$3,$4,'{}'::jsonb)",
          [scenario.collect, scenario.account, `identity-${name}-${suffix}`, scenario.offer]);
        await admin.query(`INSERT INTO collect_raw_payloads
          (id,collect_item_id,account_id,source_sku,payload_hash,payload,collected_at)
          VALUES ($1,$2,$3,$4,$5,$6::jsonb,NOW())`,
        [scenario.raw, scenario.collect, scenario.account, scenario.offer, H("b"),
          JSON.stringify({ normalized: { listingDraft: draftData } })]);
        await admin.query(`INSERT INTO product_drafts
          (id,collect_item_id,source_payload_id,version,data_hash,data,normalizer_version,category_rule_version,dictionary_version)
          VALUES ($1,$2,$3,1,$4,$5::jsonb,'v3','cat-v1','dict-v1')`,
        [scenario.draft, scenario.collect, scenario.raw, H("a"), JSON.stringify(draftData)]);
        await admin.query("UPDATE collect_items SET current_draft_id=$1 WHERE id=$2", [scenario.draft, scenario.collect]);
        await admin.query(`INSERT INTO ai_content_strategy_versions
          (id,account_id,strategy_key,version,status,content,content_hash)
          VALUES ($1,$2,$3,1,'PUBLISHED','{}'::jsonb,$4)`,
        [scenario.strategy, scenario.account, scenario.strategyKey, H("1")]);
        await admin.query(`INSERT INTO auto_listing_upload_policy_versions
          (id,account_id,mode,enabled,version,publication_reason,created_by,published_by,published_at,
           publication_origin,publication_base_url,publication_prefix,publication_version,publication_policy_hash)
          VALUES ($1,$2,'REVIEW',TRUE,1,'e2e',$2,$2,NOW(),$3,$4,$5,$6,$7)`,
        [scenario.policy, scenario.account, publicationPolicy.origin, publicationPolicy.baseUrl,
          publicationPolicy.prefix, publicationPolicy.publicationVersion, digest(publicationPolicy)]);
        remoteByClientId.set(scenario.clientId, {
          warehouse_id: scenario.platformWarehouseId,
          warehouse_type: "RFBS",
          status: "active",
          is_active: true,
          is_archived: false,
        });
        return scenario;
      }

      function verifierFor(scenario, { mutateAfterRead = null, clock = () => new Date() } = {}) {
        return createAutoListingRfbsWarehouseVerifier({
          async loadTarget({ accountId, targetStoreId, targetWarehouseId }) {
            const row = (await pool.query(`SELECT w.id,s.owner_account_id AS account_id,w.store_id,w.warehouse_id,
                w.warehouse_type,w.status,w.is_active,w.is_archived
              FROM warehouses w JOIN stores s ON s.id=w.store_id
              WHERE s.owner_account_id=$1 AND w.store_id=$2 AND w.id=$3`,
            [accountId, targetStoreId, targetWarehouseId])).rows[0];
            return row ? { id: row.id, accountId: row.account_id, storeId: row.store_id,
              warehouse_id: row.warehouse_id, warehouse_type: row.warehouse_type,
              status: row.status, is_active: row.is_active, is_archived: row.is_archived } : null;
          },
          async readCredential() {
            return { id: scenario.store, clientId: scenario.clientId, apiKey: "fake-ozon-api-key" };
          },
          async callOzonSellerApi(credential, apiPath, body, timeoutMs, options) {
            const result = await callOzonSellerApi(credential, apiPath, body, timeoutMs, options);
            if (typeof mutateAfterRead === "function") await mutateAfterRead();
            return result;
          },
          now: clock,
        });
      }

      async function createScenarioJob(scenario, {
        targetScenario = scenario,
        verifierOptions = {},
      } = {}) {
        const correlationId = `create-${scenario.name}-${suffix}`;
        const service = createAutoListingService({
          repository: creationRepository,
          prepareListingBase,
          rfbsWarehouseVerifier: verifierFor(targetScenario, verifierOptions),
        });
        const created = await service.createAutoListingJob({
          actor: { id: scenario.account, role: "admin" },
          collectItemIds: [scenario.collect],
          idempotencyKey: `job-${scenario.name}`,
          correlationId,
          config: configFor(targetScenario),
        });
        scenario.job = created.jobId;
        scenario.item = created.items[0].itemId;
        scenario.creationEvidenceId = (await pool.query(`SELECT warehouse_validation_evidence_id
          FROM auto_listing_jobs WHERE account_id=$1 AND id=$2`, [scenario.account, scenario.job]))
          .rows[0].warehouse_validation_evidence_id;
        const binding = (await pool.query(`SELECT item.snapshot_id,base.id AS listing_base_id,
            base.product_draft_data_hash,job.config_hash
          FROM auto_listing_job_items item
          JOIN auto_listing_jobs job ON job.account_id=item.account_id AND job.id=item.job_id
          JOIN auto_listing_listing_bases base
            ON base.account_id=item.account_id AND base.job_id=item.job_id AND base.item_id=item.id
          WHERE item.account_id=$1 AND item.id=$2`, [scenario.account, scenario.item])).rows[0];
        scenario.snapshot = binding.snapshot_id;
        scenario.listingBase = binding.listing_base_id;
        scenario.configHash = binding.config_hash;
        await admin.query(`INSERT INTO ai_gateway_profiles
          (id,account_id,display_name,base_url,api_key_env_name,text_protocol,image_protocol,text_model,image_model,config_version)
          VALUES ($1,$2,'E2E','https://gateway.invalid','TEST_AI_KEY','SUB2API_RESPONSES',
            'SUB2API_OPENAI_IMAGES','text','image',1)`, [scenario.profile, scenario.account]);
        const slots = [
          ["main-1", "MAIN"], ["sell-1", "SELLING_POINT"], ["sell-2", "SELLING_POINT"],
          ["detail-1", "DETAIL"], ["scene-1", "SCENE"], ["info-1", "INFOGRAPHIC"],
        ].map(([slotKey, role], index) => ({ slotKey, visualGroupKey: "group-rfbs", role, order: index + 1 }));
        const visualGroups = { sourceHash: created.items[0].sourceHash, reasonCodes: [],
          visualGroupsHash: H("5"), groups: [{ visualGroupKey: "group-rfbs",
            sourceSkus: [scenario.offer], variantIds: [`variant-${scenario.collect}`],
            factEvidence: [], reasonCodes: [], referenceImages: [] }] };
        await admin.query(`INSERT INTO ai_content_plans
          (id,account_id,job_id,item_id,source_snapshot_id,strategy_version_id,profile_id,
           strategy_hash,config_hash,source_hash,input_hash,planner_model,profile_version,prompt_template_version,
           plan,plan_hash,visual_groups_hash,visual_groups,fact_registry,fact_registry_hash)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'text',1,'plan-v1',$12::jsonb,$13,$14,$15::jsonb,$16::jsonb,$17)`,
        [scenario.plan, scenario.account, scenario.job, scenario.item, scenario.snapshot, scenario.strategy,
          scenario.profile, H("6"), scenario.configHash, created.items[0].sourceHash, H("7"),
          JSON.stringify({ slots }), H("8"), H("5"),
          JSON.stringify(visualGroups), JSON.stringify([{ factId: "fact-rfbs", kind: "IDENTITY_NAME",
            value: `RFBS ${scenario.name}`, sourcePath: "identity.name", visualGroupKeys: ["group-rfbs"] }]), H("9")]);
        scenario.assets = [];
        for (const [index, slot] of slots.entries()) {
          const assetId = `asset-${index + 1}-${scenario.name}-${suffix}`;
          const inputHash = digest(`input-${scenario.name}-${index}`);
          const contentHash = digest(`content-${scenario.name}-${index}`);
          const attemptIdentityHash = digest(`attempt-${scenario.name}-${index}`);
          const objectKey = buildGeneratedAssetObjectKey({ accountId: scenario.account, jobId: scenario.job,
            itemId: scenario.item, planId: scenario.plan, visualGroupKey: "group-rfbs",
            slotKey: slot.slotKey, attemptIdentityHash, attemptNo: 1, inputHash, contentHash });
          await admin.query(`INSERT INTO ai_generation_assets
            (id,account_id,job_id,item_id,plan_id,profile_id,visual_group_key,slot_key,role,input_hash,
             attempt_no,status,gateway_request_id,model_name,profile_version,prompt_hash,object_key,content_hash,
             content_type,width,height,checker_result,accepted_at,plan_hash,source_hash,strategy_hash,config_hash,
             visual_groups_hash,prompt_template_version,source_asset_evidence,checker_request_id,model_evidence,
             size_bytes,attempt_identity_hash,generation_size,final_input_bound_at,object_key_version,expected_status_version)
            VALUES ($1,$2,$3,$4,$5,$6,'group-rfbs',$7,$8,$9,1,'ACCEPTED',$10,'image',1,$11,$12,$13,
              'image/png',768,1024,'{"accepted":true}'::jsonb,NOW(),$11,$14,$15,$16,$17,'image-v1',$18::jsonb,$19,
              '{"model":"image"}'::jsonb,1024,$20,'768x1024',NOW(),'ATTEMPT_V2',7)`,
          [assetId, scenario.account, scenario.job, scenario.item, scenario.plan, scenario.profile,
            slot.slotKey, slot.role, inputHash, `gateway-${index}-${scenario.name}-${suffix}`,
            H("c"), objectKey, contentHash, created.items[0].sourceHash, H("6"), scenario.configHash, H("5"),
            JSON.stringify([{ assetId: `source-${scenario.name}`, contentHash: H("d"), contentType: "image/png",
              width: 1, height: 1, size: 1 }]), `checker-${index}-${scenario.name}-${suffix}`, attemptIdentityHash]);
          scenario.assets.push({ assetId, contentHash });
        }
        await admin.query("SET session_replication_role='replica'");
        try {
          await admin.query(`UPDATE auto_listing_job_items
            SET active_content_plan_id=$1,status='UPLOAD_QUEUED',status_version=7
            WHERE account_id=$2 AND id=$3`, [scenario.plan, scenario.account, scenario.item]);
        } finally {
          await admin.query("SET session_replication_role='origin'");
        }
        return scenario;
      }

      async function reserveAndCreateSubmission(scenario, { mutateAfterRead = null } = {}) {
        const correlationId = `upload-${scenario.name}-${suffix}`;
        const service = createAutoListingUploadService({
          repository: uploadRepository,
          publishListingAsset: async ({ actor, itemId, assetId }) => {
            assert.equal(actor.id, scenario.account);
            assert.equal(itemId, scenario.item);
            const asset = scenario.assets.find((entry) => entry.assetId === assetId);
            assert.ok(asset);
            const publicObjectKey = `${publicationPolicy.prefix}/${asset.contentHash.slice(0, 2)}/${asset.contentHash}.png`;
            return publicationRepository.recordPublication({
              accountId: scenario.account, jobId: scenario.job, itemId: scenario.item,
              planId: scenario.plan, assetId,
              publicObjectKey,
              publishedUrl: `${publicationPolicy.baseUrl}${publicObjectKey}`,
              publicationVersion: publicationPolicy.publicationVersion,
              publicBaseUrl: publicationPolicy.baseUrl, publicPrefix: publicationPolicy.prefix,
              publishedByAccountId: scenario.account,
            });
          },
          createSubmission: createSubmissionV3,
          findSubmission: findListingPreparationReplayV3,
          assertDirectSystemReady: async () => ({ ready: false }),
          assertDirectReady: async () => ({ ready: false }),
          buildSubmissionDraft: controlledGeneratedDraft,
          uploadEnabled: true,
          listingPipelineEnabled: true,
          directUploadAllowed: false,
          publicationPolicy,
          richContentPublicationPolicy: { origin: publicationPolicy.origin },
          rfbsWarehouseVerifier: verifierFor(scenario, { mutateAfterRead }),
        });
        const result = await service.submitAutoListingItem({
          actor: { id: scenario.account, role: "admin" },
          itemId: scenario.item,
          expectedStatusVersion: 7,
          correlationId,
        });
        const reservation = (await pool.query(`SELECT id,warehouse_validation_evidence_id
          FROM auto_listing_submission_links WHERE account_id=$1 AND auto_listing_item_id=$2`,
        [scenario.account, scenario.item])).rows[0];
        return {
          reservation: { id: reservation.id,
            warehouseValidationEvidenceId: reservation.warehouse_validation_evidence_id },
          submissionJobId: result.submissionJobId,
          submissionSnapshotId: result.submissionSnapshotId,
        };
      }

      ({ createSubmissionV3, findListingPreparationReplayV3 } = await import("../listing-pipeline.mjs"));
      ({ processListingQueueMessage } = await import(`../listing-worker.mjs?rfbs-e2e=${suffix}`));
      ({ closePostgresPool } = await import("../db/connection.mjs"));

      // Fail-closed creation checks: no job/evidence and no product/stock write.
      const closed = await seedScenario("closed");
      const closedCallsStart = calls.length;
      remoteByClientId.set(closed.clientId, null);
      await assert.rejects(createScenarioJob(closed), { code: "RFBS_WAREHOUSE_NOT_FOUND" });
      remoteByClientId.set(closed.clientId, { warehouse_id: closed.platformWarehouseId,
        warehouse_type: "RFBS", status: "disabled", is_active: false, is_archived: false });
      await assert.rejects(createScenarioJob(closed), { code: "RFBS_WAREHOUSE_DISABLED" });
      remoteByClientId.set(closed.clientId, { warehouse_id: closed.platformWarehouseId,
        warehouse_type: "FBS", status: "active", is_active: true, is_archived: false });
      await assert.rejects(createScenarioJob(closed), { code: "RFBS_WAREHOUSE_CHANGED" });
      const attacker = await seedScenario("attacker");
      const crossCallsStart = calls.length;
      await assert.rejects(createScenarioJob(attacker, { targetScenario: closed }), { code: "TARGET_STORE_NOT_FOUND" });
      assert.deepEqual(calls.slice(crossCallsStart), [], "tenant-scoped target lookup must fail before Ozon");
      const expiredRemote = { warehouse_id: closed.platformWarehouseId, warehouse_type: "RFBS",
        status: "active", is_active: true, is_archived: false };
      remoteByClientId.set(closed.clientId, expiredRemote);
      await assert.rejects(createScenarioJob(closed, {
        verifierOptions: { clock: () => new Date(Date.now() - 700_000) },
      }));
      assert.equal(Number((await pool.query("SELECT COUNT(*)::int AS count FROM auto_listing_jobs WHERE account_id=$1", [closed.account])).rows[0].count), 0);
      assert.equal(Number((await pool.query("SELECT COUNT(*)::int AS count FROM auto_listing_rfbs_warehouse_evidence WHERE account_id=$1", [closed.account])).rows[0].count), 0);
      assert.equal(Number((await pool.query("SELECT COUNT(*)::int AS count FROM auto_listing_jobs WHERE account_id=$1", [attacker.account])).rows[0].count), 0);
      assert.equal(Number((await pool.query("SELECT COUNT(*)::int AS count FROM auto_listing_submission_links WHERE account_id=ANY($1::text[])", [[closed.account, attacker.account]])).rows[0].count), 0);
      assert.equal(calls.slice(closedCallsStart).some(({ path: value }) => ["/v3/product/import", "/v2/products/stocks"].includes(value)), false);

      // TOCTOU: verifier succeeds, the database type changes, and reserve writes nothing.
      const casCallsStart = calls.length;
      const cas = await createScenarioJob(await seedScenario("cas"));
      await assert.rejects(reserveAndCreateSubmission(cas, { mutateAfterRead: async () => {
        await pool.query("UPDATE warehouses SET warehouse_type='FBS' WHERE id=$1 AND store_id=$2",
          [cas.warehouse, cas.store]);
      } }), { code: "AUTO_LISTING_UPLOAD_WAREHOUSE_CHANGED" });
      assert.equal(Number((await pool.query("SELECT COUNT(*)::int AS count FROM auto_listing_submission_links WHERE account_id=$1", [cas.account])).rows[0].count), 0);
      assert.equal(Number((await pool.query("SELECT COUNT(*)::int AS count FROM auto_listing_rfbs_warehouse_evidence WHERE account_id=$1", [cas.account])).rows[0].count), 1);
      assert.equal(calls.slice(casCallsStart).some(({ path: value }) => value === "/v3/product/import"), false);

      // The immutable log proves both creation and upload verification; the upload subchain is exact.
      const successCallsStart = calls.length;
      const success = await createScenarioJob(await seedScenario("success"));
      const successUploadStart = calls.length;
      const successSubmission = await reserveAndCreateSubmission(success);
      await processListingQueueMessage({ submissionJobId: successSubmission.submissionJobId, action: "submit" });
      await processListingQueueMessage({ submissionJobId: successSubmission.submissionJobId, action: "check" });
      assert.deepEqual(calls.slice(successCallsStart).map(({ path: value }) => value), [
        "/v2/warehouse/list", "/v2/warehouse/list", "/v3/product/import",
        "/v1/product/import/info", "/v2/products/stocks",
      ]);
      assert.deepEqual(calls.slice(successCallsStart, successUploadStart).map(({ path: value }) => value), [
        "/v2/warehouse/list",
      ]);
      assert.deepEqual(calls.slice(successUploadStart).map(({ path: value }) => value), [
        "/v2/warehouse/list", "/v3/product/import", "/v1/product/import/info", "/v2/products/stocks",
      ]);
      assert.equal((await pool.query("SELECT status FROM submission_jobs WHERE id=$1",
        [successSubmission.submissionJobId])).rows[0].status, "SUCCEEDED");
      assert.equal(Number((await pool.query("SELECT COUNT(*)::int AS count FROM auto_listing_jobs WHERE account_id=$1", [success.account])).rows[0].count), 1);
      assert.equal(Number((await pool.query("SELECT COUNT(*)::int AS count FROM products WHERE store_id=$1", [success.store])).rows[0].count), 0);
      assert.equal(Number((await pool.query("SELECT COUNT(*)::int AS count FROM auto_listing_rfbs_warehouse_evidence WHERE account_id=$1", [success.account])).rows[0].count), 2);
      assert.equal(Number((await pool.query("SELECT COUNT(*)::int AS count FROM auto_listing_submission_links WHERE account_id=$1", [success.account])).rows[0].count), 1);
      assert.notEqual(success.creationEvidenceId, successSubmission.reservation.warehouseValidationEvidenceId);
      assert.equal((await pool.query(`SELECT warehouse_validation_evidence_id FROM auto_listing_jobs
        WHERE account_id=$1 AND id=$2`, [success.account, success.job])).rows[0].warehouse_validation_evidence_id,
      success.creationEvidenceId);
      assert.equal((await pool.query(`SELECT warehouse_validation_evidence_id FROM auto_listing_submission_links
        WHERE account_id=$1 AND id=$2`, [success.account, successSubmission.reservation.id]))
        .rows[0].warehouse_validation_evidence_id,
      successSubmission.reservation.warehouseValidationEvidenceId);
      assert.equal(Number((await pool.query(`SELECT COUNT(*)::int AS count FROM auto_listing_upload_attempts
        WHERE account_id=$1 AND outcome='RESERVED'`, [success.account])).rows[0].count), 1);
      assert.equal((await pool.query(`SELECT warehouse_validation_evidence_id
        FROM auto_listing_upload_attempts WHERE account_id=$1 AND outcome='RESERVED'`, [success.account]))
        .rows[0].warehouse_validation_evidence_id,
      successSubmission.reservation.warehouseValidationEvidenceId);

      // Ambiguous product response is reconciled and never re-imported.
      const ambiguousCallsStart = calls.length;
      const ambiguous = await createScenarioJob(await seedScenario("ambiguous"));
      const ambiguousSubmission = await reserveAndCreateSubmission(ambiguous);
      await processListingQueueMessage({ submissionJobId: ambiguousSubmission.submissionJobId, action: "submit" });
      assert.equal((await pool.query("SELECT status FROM submission_jobs WHERE id=$1",
        [ambiguousSubmission.submissionJobId])).rows[0].status, "RECONCILING");
      await processListingQueueMessage({ submissionJobId: ambiguousSubmission.submissionJobId, action: "submit" });
      assert.equal(calls.slice(ambiguousCallsStart).filter(({ path: value }) => value === "/v3/product/import").length, 1);
      assert.equal(calls.slice(ambiguousCallsStart).some(({ path: value }) => value === "/v2/products/stocks"), false);

      // Product success plus stock failure remains partial and replay does not re-import.
      const stockFailCallsStart = calls.length;
      const stockFail = await createScenarioJob(await seedScenario("stock-fail"));
      const stockSubmission = await reserveAndCreateSubmission(stockFail);
      await processListingQueueMessage({ submissionJobId: stockSubmission.submissionJobId, action: "submit" });
      await processListingQueueMessage({ submissionJobId: stockSubmission.submissionJobId, action: "check" });
      assert.equal((await pool.query("SELECT status FROM submission_jobs WHERE id=$1",
        [stockSubmission.submissionJobId])).rows[0].status, "PARTIAL_SUCCESS");
      await processListingQueueMessage({ submissionJobId: stockSubmission.submissionJobId, action: "submit" });
      await processListingQueueMessage({ submissionJobId: stockSubmission.submissionJobId, action: "check" });
      assert.equal(calls.slice(stockFailCallsStart).filter(({ path: value }) => value === "/v3/product/import").length, 1);
      assert.equal(calls.slice(stockFailCallsStart).filter(({ path: value }) => value === "/v2/products/stocks").length, 1);
    } finally {
      await closePostgresPool?.().catch(() => {});
      await pool?.end().catch(() => {});
      await new Promise((resolve) => fakeOzon.close(resolve));
      delete process.env.DATABASE_URL;
      delete process.env.OZON_API_BASE;
      delete process.env.APP_ENCRYPTION_KEY;
      delete process.env.LISTING_PIPELINE_V3;
      try {
        await admin.query("SET search_path TO public");
        await admin.query(`DROP SCHEMA IF EXISTS ${quote(schema)} CASCADE`);
      } finally {
        admin.release();
        await adminPool.end();
      }
    }
  });
}

let createSubmissionV3;
let findListingPreparationReplayV3;
let processListingQueueMessage;
