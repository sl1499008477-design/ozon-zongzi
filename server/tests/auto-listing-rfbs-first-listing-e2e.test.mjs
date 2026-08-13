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
import { buildAutoListingBlockedSourceEvidence } from "../auto-listing-source-snapshot.mjs";
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

function listingVariant(offerId, currency = "RUB") {
  return {
    offer_id: offerId,
    name: `RFBS ${offerId}`,
    price: "100.00",
    currency_code: currency,
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
    ...(scenario.sourceCurrency ? { currency: scenario.sourceCurrency } : {}),
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
      item: listingVariant(source.collectItem.listingDraft.offerId, pricingEvidence.currency) }],
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
    const warehouseReadsByClientId = new Map();
    const taskById = new Map();
    let taskSequence = 700_000;
    const fakeOzon = http.createServer(async (request, response) => {
      const body = await requestBody(request).catch(() => ({}));
      const clientId = String(request.headers["client-id"] || "");
      const pathName = String(request.url || "");
      const offerId = String(body?.items?.[0]?.offer_id || body?.stocks?.[0]?.offer_id || "");
      calls.push({ path: pathName, clientId, offerId, body: structuredClone(body) });
      response.setHeader("content-type", "application/json");
      if (pathName === "/v2/warehouse/list") {
        const warehouseRead = Number(warehouseReadsByClientId.get(clientId) || 0) + 1;
        warehouseReadsByClientId.set(clientId, warehouseRead);
        if (clientId.includes("phase-response-loss") && warehouseRead === 3) {
          request.socket.destroy();
          return;
        }
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
      assert.equal(migrations.some((file) => file.startsWith("061_")), true,
        "E2E must include immutable RFBS standard-submission handoff migration 061");
      assert.equal(migrations.at(-1)?.startsWith("071_"), true,
        "E2E must apply the complete production migration chain through stock write ledger 071");
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

      async function seedScenario(name, { currency = "RUB", sourceCurrency = currency } = {}) {
        const scenario = Object.fromEntries([
          "account", "store", "warehouse", "collect", "draft", "strategy", "policy", "profile", "plan",
        ].map((key) => [key, `${name}-${key}-${suffix}`]));
        scenario.name = name;
        scenario.currency = currency;
        scenario.sourceCurrency = sourceCurrency;
        scenario.clientId = `${name}-client-${suffix}`;
        scenario.platformWarehouseId = `${name}-platform-${suffix}`;
        scenario.offer = `offer-${name}-${suffix}`;
        scenario.strategyKey = `strategy-key-${name}-${suffix}`;
        scenario.raw = `raw-${name}-${suffix}`;
        await admin.query("INSERT INTO accounts (id,username,display_name,role,status) VALUES ($1,$2,$2,'admin','active')",
          [scenario.account, `${name}-${suffix}`]);
        await admin.query("INSERT INTO stores (id,label,company_name,client_id,status,owner_account_id,currency_code) VALUES ($1,$2,$2,$3,'active',$4,$5)",
          [scenario.store, name, scenario.clientId, scenario.account, currency]);
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
        const categoryEvidenceId = `category-evidence-${name}-${suffix}`;
        await admin.query(`INSERT INTO collect_ozon_category_source_evidence(
          id,account_id,source_kind,source_record_id,source_version,collect_item_id,product_draft_id,
          source_description_category_id,source_type_id,taxonomy_scope,captured_at,raw_response_hash,
          raw_response_ref,provenance)
          VALUES($1,$2,'PRODUCT_DRAFT',$3,'draft:1',$3,$4,17028702,92576,'OZON:DEFAULT',NOW(),$5,$6,$7::jsonb)`,
        [categoryEvidenceId, scenario.account, scenario.collect, scenario.draft, H("b"), scenario.raw,
          JSON.stringify({ fixture: "task10-rfbs-adjacent", canonicalPath: ["RFBS"] })]);
        await admin.query(`INSERT INTO collect_ozon_category_current_sources(
          account_id,collect_item_id,source_evidence_id,source_kind,source_record_id,source_version)
          VALUES($1,$2,$3,'PRODUCT_DRAFT',$2,'draft:1')`,
        [scenario.account, scenario.collect, categoryEvidenceId]);
        await admin.query(`INSERT INTO account_ozon_shared_categories(
          id,account_id,source_description_category_id,source_type_id,taxonomy_scope,
          current_description_category_id,current_type_id,status,source,source_evidence_id)
          VALUES($1,$2,17028702,92576,'OZON:DEFAULT',17028702,92576,'ACTIVE','SOURCE_DIRECT',$3)`,
        [`shared-category-${name}-${suffix}`, scenario.account, categoryEvidenceId]);
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

      async function invokeScenarioJob(scenario, {
        targetScenario = scenario,
        verifierOptions = {},
        prepareListingBaseImpl = prepareListingBase,
      } = {}) {
        const correlationId = `create-${scenario.name}-${suffix}`;
        const service = createAutoListingService({
          repository: creationRepository,
          prepareListingBase: prepareListingBaseImpl,
          rfbsWarehouseVerifier: verifierFor(targetScenario, verifierOptions),
        });
        return service.createAutoListingJob({
          actor: { id: scenario.account, role: "admin" },
          collectItemIds: [scenario.collect],
          idempotencyKey: `job-${scenario.name}`,
          correlationId,
          config: configFor(targetScenario),
        });
      }

      async function createScenarioJob(scenario, options = {}) {
        const created = await invokeScenarioJob(scenario, options);
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

      async function reserveAndCreateSubmission(scenario, {
        mutateAfterRead = null,
        createSubmissionImpl = createSubmissionV3,
        expectedStatusVersion = 7,
      } = {}) {
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
          createSubmission: createSubmissionImpl,
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
          expectedStatusVersion,
          correlationId,
        });
        const reservation = (await pool.query(`SELECT link.id,link.warehouse_validation_evidence_id,
            attempt.id AS reserved_attempt_id
          FROM auto_listing_submission_links AS link
          LEFT JOIN auto_listing_upload_attempts AS attempt
            ON attempt.account_id=link.account_id AND attempt.submission_link_id=link.id
           AND attempt.outcome='RESERVED'
          WHERE link.account_id=$1 AND link.auto_listing_item_id=$2`,
        [scenario.account, scenario.item])).rows[0];
        return {
          reservation: { id: reservation.id,
            warehouseValidationEvidenceId: reservation.warehouse_validation_evidence_id,
            reservedAttemptId: reservation.reserved_attempt_id },
          submissionJobId: result.submissionJobId,
          submissionSnapshotId: result.submissionSnapshotId,
        };
      }

      ({ createSubmissionV3, findListingPreparationReplayV3, loadSubmissionWorkV3 }
        = await import("../listing-pipeline.mjs"));
      ({ processListingQueueMessage } = await import(`../listing-worker.mjs?rfbs-e2e=${suffix}`));
      ({ closePostgresPool } = await import("../db/connection.mjs"));

      // Re-apply the actual 061 migration over a pre-existing bound RFBS job and prove backfill is gated.
      const backfillCallsStart = calls.length;
      const backfill = await createScenarioJob(await seedScenario("migration-backfill"));
      const backfillSubmission = await reserveAndCreateSubmission(backfill);
      await pool.query("DROP TRIGGER submission_jobs_rfbs_handoff_commit_gate ON submission_jobs");
      await pool.query("DROP TABLE submission_rfbs_write_authorizations");
      await pool.query("DROP TABLE submission_rfbs_handoffs CASCADE");
      const ambiguousSnapshotId = `ambiguous-pre061-snapshot-${suffix}`;
      const ambiguousJobId = `ambiguous-pre061-job-${suffix}`;
      await pool.query(`INSERT INTO submission_snapshots
        (id,collect_item_id,account_id,store_id,idempotency_key,snapshot_hash,item_count,items,stocks)
        VALUES ($1,$2,$3,$4,$5,$6,1,$7::jsonb,$8::jsonb)`,
      [ambiguousSnapshotId, backfill.collect, backfill.account, backfill.store,
        `ambiguous-pre061-${suffix}`, H("3"), JSON.stringify([listingVariant(`ambiguous-${backfill.offer}`)]),
        JSON.stringify([{ offer_id: `ambiguous-${backfill.offer}`,
          warehouse_id: backfill.platformWarehouseId, stock: 5 }])]);
      await pool.query(`INSERT INTO submission_jobs
        (id,snapshot_id,collect_item_id,account_id,store_id,type,status,correlation_id,item_count)
        VALUES ($1,$2,$3,$4,$5,'AUTO_LISTING','QUEUE_PENDING',$6,1)`,
      [ambiguousJobId, ambiguousSnapshotId, backfill.collect, backfill.account, backfill.store,
        `ambiguous-pre061-${suffix}`]);
      const migrationSql = await readFile(path.join(migrationsDir,
        "061_auto_listing_rfbs_submission_handoff.sql"), "utf8");
      const migrationClient = await pool.connect();
      try {
        await migrationClient.query("BEGIN");
        await assert.rejects(migrationClient.query(migrationSql), (error) => error?.code === "23514");
        await migrationClient.query("ROLLBACK");
      } finally { migrationClient.release(); }
      await pool.query("DELETE FROM submission_jobs WHERE id=$1", [ambiguousJobId]);
      await pool.query("DELETE FROM submission_snapshots WHERE id=$1", [ambiguousSnapshotId]);
      await pool.query("SET session_replication_role='replica'");
      try {
        await pool.query(`UPDATE auto_listing_submission_links
          SET status='RESERVED',submission_job_id=NULL,submission_snapshot_id=NULL
          WHERE id=$1`, [backfillSubmission.reservation.id]);
        await pool.query("UPDATE warehouses SET warehouse_type='FBS' WHERE id=$1 AND store_id=$2",
          [backfill.warehouse, backfill.store]);
      } finally { await pool.query("SET session_replication_role='origin'"); }
      const unboundMigrationClient = await pool.connect();
      try {
        await unboundMigrationClient.query("BEGIN");
        await assert.rejects(unboundMigrationClient.query(migrationSql),
          (error) => error?.code === "23514");
        await unboundMigrationClient.query("ROLLBACK");
      } finally { unboundMigrationClient.release(); }
      await pool.query("SET session_replication_role='replica'");
      try {
        await pool.query(`UPDATE auto_listing_submission_links
          SET status='SUBMITTED',submission_job_id=$2,submission_snapshot_id=$3
          WHERE id=$1`, [backfillSubmission.reservation.id, backfillSubmission.submissionJobId,
          backfillSubmission.submissionSnapshotId]);
        await pool.query("UPDATE warehouses SET warehouse_type='RFBS' WHERE id=$1 AND store_id=$2",
          [backfill.warehouse, backfill.store]);
      } finally { await pool.query("SET session_replication_role='origin'"); }
      await pool.query(migrationSql);
      const backfilledHandoff = (await pool.query(`SELECT * FROM submission_rfbs_handoffs
        WHERE account_id=$1 AND submission_job_id=$2`,
      [backfill.account, backfillSubmission.submissionJobId])).rows[0];
      assert.equal(backfilledHandoff.submission_link_id, backfillSubmission.reservation.id);
      assert.equal(backfilledHandoff.link_identity_evidence_id,
        backfillSubmission.reservation.warehouseValidationEvidenceId);
      assert.equal(backfilledHandoff.reserved_attempt_id, backfillSubmission.reservation.reservedAttemptId);
      await pool.query("UPDATE warehouses SET warehouse_type='FBS' WHERE id=$1 AND store_id=$2",
        [backfill.warehouse, backfill.store]);
      await processListingQueueMessage({ submissionJobId: backfillSubmission.submissionJobId, action: "submit" });
      assert.equal(calls.slice(backfillCallsStart)
        .filter(({ path: value }) => value === "/v3/product/import").length, 0);
      await pool.query("UPDATE warehouses SET warehouse_type='RFBS' WHERE id=$1 AND store_id=$2",
        [backfill.warehouse, backfill.store]);

      // A post-061 old application cannot commit a new RFBS standard job without a handoff.
      const oldAppSnapshotId = `old-app-rfbs-snapshot-${suffix}`;
      await pool.query(`INSERT INTO submission_snapshots
        (id,collect_item_id,account_id,store_id,idempotency_key,snapshot_hash,item_count,items,stocks)
        VALUES ($1,$2,$3,$4,$5,$6,1,$7::jsonb,$8::jsonb)`,
      [oldAppSnapshotId, backfill.collect, backfill.account, backfill.store,
        `old-app-rfbs-${suffix}`, H("2"), JSON.stringify([listingVariant(`old-app-${backfill.offer}`)]),
        JSON.stringify([{ offer_id: `old-app-${backfill.offer}`,
          warehouse_id: backfill.platformWarehouseId, stock: 5 }])]);
      await pool.query("SET session_replication_role='replica'");
      try {
        await pool.query(`UPDATE auto_listing_submission_links
          SET status='RESERVED',submission_job_id=NULL,submission_snapshot_id=NULL WHERE id=$1`,
        [backfillSubmission.reservation.id]);
      } finally { await pool.query("SET session_replication_role='origin'"); }
      const oldAppClient = await pool.connect();
      try {
        await oldAppClient.query("BEGIN");
        await oldAppClient.query(`INSERT INTO submission_jobs
          (id,snapshot_id,collect_item_id,account_id,store_id,type,status,correlation_id,item_count)
          VALUES ($1,$2,$3,$4,$5,'AUTO_LISTING','QUEUE_PENDING',$6,1)`,
        [`old-app-rfbs-job-${suffix}`, oldAppSnapshotId, backfill.collect, backfill.account, backfill.store,
          `old-app-rfbs-${suffix}`]);
        await oldAppClient.query(`INSERT INTO outbox_events
          (id,aggregate_type,aggregate_id,event_type,payload,dedupe_key)
          VALUES ($1,'submission_job',$2,'listing.submit.requested',$3::jsonb,$4)`,
        [`old-app-rfbs-outbox-${suffix}`, `old-app-rfbs-job-${suffix}`,
          JSON.stringify({ submissionJobId: `old-app-rfbs-job-${suffix}`, action: "submit" }),
          `old-app-rfbs-job-${suffix}:submit:0`]);
        await pool.query("UPDATE warehouses SET warehouse_type='FBS' WHERE id=$1 AND store_id=$2",
          [backfill.warehouse, backfill.store]);
        await assert.rejects(oldAppClient.query("COMMIT"), (error) => error?.code === "23514");
        await oldAppClient.query("ROLLBACK").catch(() => {});
      } finally {
        oldAppClient.release();
        await pool.query("SET session_replication_role='replica'");
        try {
          await pool.query(`UPDATE auto_listing_submission_links
            SET status='SUBMITTED',submission_job_id=$2,submission_snapshot_id=$3 WHERE id=$1`,
          [backfillSubmission.reservation.id, backfillSubmission.submissionJobId,
            backfillSubmission.submissionSnapshotId]);
          await pool.query("UPDATE warehouses SET warehouse_type='RFBS' WHERE id=$1 AND store_id=$2",
            [backfill.warehouse, backfill.store]);
        } finally { await pool.query("SET session_replication_role='origin'"); }
      }
      assert.equal(Number((await pool.query("SELECT COUNT(*)::int AS count FROM submission_jobs WHERE id=$1",
        [`old-app-rfbs-job-${suffix}`])).rows[0].count), 0);
      assert.equal(Number((await pool.query("SELECT COUNT(*)::int AS count FROM outbox_events WHERE id=$1",
        [`old-app-rfbs-outbox-${suffix}`])).rows[0].count), 0);

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
        "/v2/warehouse/list", "/v2/warehouse/list", "/v2/warehouse/list", "/v3/product/import",
        "/v1/product/import/info", "/v2/warehouse/list", "/v2/products/stocks",
      ]);
      assert.deepEqual(calls.slice(successCallsStart, successUploadStart).map(({ path: value }) => value), [
        "/v2/warehouse/list",
      ]);
      assert.deepEqual(calls.slice(successUploadStart).map(({ path: value }) => value), [
        "/v2/warehouse/list", "/v2/warehouse/list", "/v3/product/import",
        "/v1/product/import/info", "/v2/warehouse/list", "/v2/products/stocks",
      ]);
      assert.equal((await pool.query("SELECT status FROM submission_jobs WHERE id=$1",
        [successSubmission.submissionJobId])).rows[0].status, "SUCCEEDED");
      assert.equal(Number((await pool.query("SELECT COUNT(*)::int AS count FROM auto_listing_jobs WHERE account_id=$1", [success.account])).rows[0].count), 1);
      assert.equal(Number((await pool.query("SELECT COUNT(*)::int AS count FROM products WHERE store_id=$1", [success.store])).rows[0].count), 0);
      assert.equal(Number((await pool.query("SELECT COUNT(*)::int AS count FROM auto_listing_rfbs_warehouse_evidence WHERE account_id=$1", [success.account])).rows[0].count), 4);
      const successPhaseAuthorizations = (await pool.query(`SELECT id,phase FROM submission_rfbs_write_authorizations
        WHERE account_id=$1 AND submission_job_id=$2 ORDER BY created_at`,
      [success.account, successSubmission.submissionJobId])).rows;
      assert.deepEqual(successPhaseAuthorizations.map(({ phase }) => phase),
      ["PRE_IMPORT", "PRE_STOCK"]);
      await assert.rejects(pool.query(`UPDATE submission_rfbs_write_authorizations
        SET correlation_id='forged-correlation' WHERE id=$1`, [successPhaseAuthorizations[0].id]),
      (error) => error?.code === "23514");
      await assert.rejects(pool.query("DELETE FROM submission_rfbs_write_authorizations WHERE id=$1",
        [successPhaseAuthorizations[0].id]), (error) => error?.code === "23514");
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

      // RED: a stock 200 followed by a crash-equivalent terminal write failure must not send stock again.
      const terminalCrashCallsStart = calls.length;
      const terminalCrash = await createScenarioJob(await seedScenario("stock-terminal-crash"));
      const terminalCrashSubmission = await reserveAndCreateSubmission(terminalCrash);
      await processListingQueueMessage({
        submissionJobId: terminalCrashSubmission.submissionJobId, action: "submit",
      });
      await pool.query(`CREATE FUNCTION reject_terminal_stock_crash_${suffix}()
        RETURNS TRIGGER LANGUAGE plpgsql AS $$
        BEGIN
          IF OLD.id='${terminalCrashSubmission.submissionJobId}' AND NEW.status='SUCCEEDED' THEN
            RAISE EXCEPTION 'controlled crash after stock response';
          END IF;
          RETURN NEW;
        END $$`);
      await pool.query(`CREATE TRIGGER reject_terminal_stock_crash_${suffix}
        BEFORE UPDATE ON submission_jobs FOR EACH ROW
        EXECUTE FUNCTION reject_terminal_stock_crash_${suffix}()`);
      await processListingQueueMessage({
        submissionJobId: terminalCrashSubmission.submissionJobId, action: "check",
      });
      await pool.query(`DROP TRIGGER reject_terminal_stock_crash_${suffix} ON submission_jobs`);
      await pool.query(`DROP FUNCTION reject_terminal_stock_crash_${suffix}()`);
      await processListingQueueMessage({
        submissionJobId: terminalCrashSubmission.submissionJobId, action: "check",
      });
      assert.equal(calls.slice(terminalCrashCallsStart)
        .filter(({ path: value }) => value === "/v2/products/stocks").length, 1,
      "terminal replay must not send a second stock request after the first response was accepted");
      assert.equal((await pool.query(`SELECT status FROM submission_stock_write_intents
        WHERE account_id=$1 AND submission_job_id=$2`,
      [terminalCrash.account, terminalCrashSubmission.submissionJobId])).rows[0].status, "DONE");
      const terminalCrashCounts = {
        imports: calls.slice(terminalCrashCallsStart)
          .filter(({ path: value }) => value === "/v3/product/import").length,
        stocks: calls.slice(terminalCrashCallsStart)
          .filter(({ path: value }) => value === "/v2/products/stocks").length,
      };
      await (await import("../listing-pipeline.mjs")).recoverStaleSubmissionJobsV3({
        workerId: "stock-terminal-watchdog", limit: 100,
      });
      await processListingQueueMessage({
        submissionJobId: terminalCrashSubmission.submissionJobId, action: "check",
      });
      assert.deepEqual({
        imports: calls.slice(terminalCrashCallsStart)
          .filter(({ path: value }) => value === "/v3/product/import").length,
        stocks: calls.slice(terminalCrashCallsStart)
          .filter(({ path: value }) => value === "/v2/products/stocks").length,
      }, terminalCrashCounts);

      // A 200 followed by failure to persist DONE is durably ambiguous and never resent.
      const responseCrashCallsStart = calls.length;
      const responseCrash = await createScenarioJob(await seedScenario("stock-response-crash"));
      const responseCrashSubmission = await reserveAndCreateSubmission(responseCrash);
      await processListingQueueMessage({
        submissionJobId: responseCrashSubmission.submissionJobId, action: "submit",
      });
      await pool.query(`CREATE FUNCTION reject_stock_done_${suffix}()
        RETURNS TRIGGER LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.submission_job_id='${responseCrashSubmission.submissionJobId}'
            AND OLD.status='IN_FLIGHT' AND NEW.status='DONE' THEN
            RAISE EXCEPTION 'controlled crash after stock 200 before DONE';
          END IF;
          RETURN NEW;
        END $$`);
      await pool.query(`CREATE TRIGGER reject_stock_done_${suffix}
        BEFORE UPDATE ON submission_stock_write_intents FOR EACH ROW
        EXECUTE FUNCTION reject_stock_done_${suffix}()`);
      await processListingQueueMessage({
        submissionJobId: responseCrashSubmission.submissionJobId, action: "check",
      });
      await pool.query(`DROP TRIGGER reject_stock_done_${suffix} ON submission_stock_write_intents`);
      await pool.query(`DROP FUNCTION reject_stock_done_${suffix}()`);
      await processListingQueueMessage({
        submissionJobId: responseCrashSubmission.submissionJobId, action: "check",
      });
      assert.equal(calls.slice(responseCrashCallsStart)
        .filter(({ path: value }) => value === "/v2/products/stocks").length, 1);
      assert.deepEqual((await pool.query(`SELECT intent.status,job.status AS job_status
        FROM submission_stock_write_intents AS intent
        JOIN submission_jobs AS job ON job.account_id=intent.account_id AND job.id=intent.submission_job_id
        WHERE intent.account_id=$1 AND intent.submission_job_id=$2`,
      [responseCrash.account, responseCrashSubmission.submissionJobId])).rows[0], {
        status: "AMBIGUOUS", job_status: "PARTIAL_SUCCESS",
      });

      // An orphaned IN_FLIGHT intent is fail-safe ambiguous: restart never calls stock.
      const preNetworkCrashCallsStart = calls.length;
      const preNetworkCrash = await createScenarioJob(await seedScenario("stock-pre-network-crash"));
      const preNetworkCrashSubmission = await reserveAndCreateSubmission(preNetworkCrash);
      await processListingQueueMessage({
        submissionJobId: preNetworkCrashSubmission.submissionJobId, action: "submit",
      });
      const preNetworkWork = await loadSubmissionWorkV3(preNetworkCrashSubmission.submissionJobId);
      await pool.query("UPDATE submission_jobs SET status='CHECKING' WHERE account_id=$1 AND id=$2",
        [preNetworkCrash.account, preNetworkCrashSubmission.submissionJobId]);
      const preNetworkStockItems = preNetworkWork.stocks.map((stock) => ({
        submissionItemId: preNetworkWork.submissionItems.find((entry) => entry.offerId === stock.offer_id)
          .submissionItemId,
        offerId: stock.offer_id,
        warehouseId: stock.warehouse_id,
        quantity: stock.stock,
      }));
      const stockPorts = await import("../listing-pipeline.mjs");
      const preNetworkCommand = {
        accountId: preNetworkWork.account_id,
        jobId: preNetworkWork.id,
        snapshotId: preNetworkWork.snapshot_id,
        storeId: preNetworkWork.store_id,
        importOzonTaskId: preNetworkWork.ozon_task_id,
        recoveryAttemptId: null,
        requestHash: stockPorts.submissionStockRequestHashV3(preNetworkStockItems),
        correlationId: preNetworkWork.correlation_id,
        actorId: "controlled-crash-worker",
        stocks: preNetworkStockItems,
      };
      await stockPorts.prepareSubmissionStockWriteV3(preNetworkCommand);
      const mutateStock = (patch) => {
        const stocks = preNetworkCommand.stocks.map((stock, index) => index === 0
          ? { ...stock, ...(patch.stock || {}) } : { ...stock });
        return { ...preNetworkCommand, ...(patch.command || {}), stocks,
          requestHash: patch.command?.requestHash
            ?? stockPorts.submissionStockRequestHashV3(stocks) };
      };
      for (const hostile of [
        mutateStock({ command: { accountId: "wrong-account" } }),
        mutateStock({ command: { jobId: "wrong-job" } }),
        mutateStock({ command: { snapshotId: "wrong-snapshot" } }),
        mutateStock({ command: { importOzonTaskId: "wrong-task" } }),
        mutateStock({ stock: { submissionItemId: "wrong-item" } }),
        mutateStock({ stock: { offerId: "wrong-offer" } }),
        mutateStock({ stock: { warehouseId: "wrong-warehouse" } }),
        mutateStock({ stock: { quantity: 6 } }),
        mutateStock({ command: { requestHash: "0".repeat(32) } }),
      ]) {
        await assert.rejects(stockPorts.prepareSubmissionStockWriteV3(hostile),
          { code: "LISTING_STOCK_WRITE_IDENTITY_CONFLICT" });
      }
      assert.equal(Number((await pool.query(`SELECT COUNT(*)::int AS count
        FROM submission_stock_write_intents WHERE submission_job_id=$1`,
      [preNetworkCrashSubmission.submissionJobId])).rows[0].count), 1);
      assert.equal(Number((await pool.query(`SELECT COUNT(*)::int AS count
        FROM submission_stock_write_events WHERE submission_job_id=$1`,
      [preNetworkCrashSubmission.submissionJobId])).rows[0].count), 1);
      await stockPorts.beginSubmissionStockWriteV3(preNetworkCommand);
      await processListingQueueMessage({
        submissionJobId: preNetworkCrashSubmission.submissionJobId, action: "check",
      });
      assert.equal(calls.slice(preNetworkCrashCallsStart)
        .filter(({ path: value }) => value === "/v2/products/stocks").length, 0);
      assert.deepEqual((await pool.query(`SELECT intent.status,job.status AS job_status,job.error_code
        FROM submission_stock_write_intents AS intent
        JOIN submission_jobs AS job ON job.account_id=intent.account_id AND job.id=intent.submission_job_id
        WHERE intent.account_id=$1 AND intent.submission_job_id=$2`,
      [preNetworkCrash.account, preNetworkCrashSubmission.submissionJobId])).rows[0], {
        status: "AMBIGUOUS",
        job_status: "PARTIAL_SUCCESS",
        error_code: "OZON_STOCK_RESULT_AMBIGUOUS",
      });
      await assert.rejects(pool.query(`UPDATE submission_stock_write_intents
        SET request_hash=$1 WHERE account_id=$2 AND submission_job_id=$3`,
      ["f".repeat(32), preNetworkCrash.account, preNetworkCrashSubmission.submissionJobId]),
      (error) => error?.code === "23514");
      await assert.rejects(pool.query(`UPDATE submission_stock_write_events
        SET actor_id='forged' WHERE account_id=$1 AND submission_job_id=$2`,
      [preNetworkCrash.account, preNetworkCrashSubmission.submissionJobId]),
      (error) => error?.code === "23514");
      await assert.rejects(pool.query(`DELETE FROM submission_stock_write_intents
        WHERE account_id=$1 AND submission_job_id=$2`,
      [preNetworkCrash.account, preNetworkCrashSubmission.submissionJobId]),
      (error) => error?.code === "23514");
      await assert.rejects(pool.query(`INSERT INTO submission_stock_write_intents(
        id,account_id,submission_job_id,submission_snapshot_id,store_id,
        import_ozon_task_id,recovery_attempt_id,request_hash,correlation_id,actor_id,
        stock_items,item_count,status)
        SELECT id||'-forged',account_id,submission_job_id,submission_snapshot_id,store_id,
          import_ozon_task_id,recovery_attempt_id,request_hash,correlation_id,actor_id,
          stock_items,item_count,'DONE'
        FROM submission_stock_write_intents
        WHERE account_id=$1 AND submission_job_id=$2`,
      [preNetworkCrash.account, preNetworkCrashSubmission.submissionJobId]),
      (error) => error?.code === "23514");
      const handoff = (await pool.query(`SELECT * FROM submission_rfbs_handoffs
        WHERE account_id=$1 AND submission_job_id=$2`,
      [success.account, successSubmission.submissionJobId])).rows[0];
      assert.equal(handoff.store_id, success.store);
      assert.equal(handoff.local_warehouse_id, success.warehouse);
      assert.equal(handoff.platform_warehouse_id, success.platformWarehouseId);
      assert.equal(handoff.fulfillment_type, "RFBS");
      assert.equal(handoff.link_identity_evidence_id,
        successSubmission.reservation.warehouseValidationEvidenceId);
      assert.equal(handoff.attempt_authorization_evidence_id,
        successSubmission.reservation.warehouseValidationEvidenceId);
      assert.equal(handoff.reserved_attempt_id, successSubmission.reservation.reservedAttemptId);
      assert.equal(handoff.submission_link_id, successSubmission.reservation.id);
      assert.equal(handoff.business_idempotency_key,
        `auto-listing:${success.item}:${(await pool.query("SELECT result_hash FROM auto_listing_submission_links WHERE id=$1",
          [successSubmission.reservation.id])).rows[0].result_hash}`);
      await assert.rejects(pool.query(`UPDATE submission_rfbs_handoffs
        SET platform_warehouse_id='forged-platform' WHERE id=$1`, [handoff.id]),
      (error) => error?.code === "23514");
      await assert.rejects(pool.query("DELETE FROM submission_rfbs_handoffs WHERE id=$1", [handoff.id]),
        (error) => error?.code === "23514");
      await assert.rejects(pool.query(`INSERT INTO submission_rfbs_handoffs (
          id,account_id,submission_job_id,submission_snapshot_id,store_id,local_warehouse_id,
          platform_warehouse_id,fulfillment_type,link_identity_evidence_id,
          attempt_authorization_evidence_id,reserved_attempt_id,submission_link_id,business_idempotency_key
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,'RFBS',$8,$9,$10,$11,$12)`,
      [`forged-cross-tenant-${suffix}`, attacker.account, successSubmission.submissionJobId,
        successSubmission.submissionSnapshotId, success.store, success.warehouse,
        success.platformWarehouseId, successSubmission.reservation.warehouseValidationEvidenceId,
        successSubmission.reservation.warehouseValidationEvidenceId,
        successSubmission.reservation.reservedAttemptId, successSubmission.reservation.id,
        handoff.business_idempotency_key]), (error) => ["23503", "23514"].includes(error?.code));
      assert.equal(Number((await pool.query(`SELECT COUNT(*)::int AS count
        FROM submission_rfbs_handoffs WHERE account_id=$1`, [attacker.account])).rows[0].count), 0);

      // A CNY store with no explicit source currency keeps CNY through create, upload, and Ozon import.
      const cnyCallsStart = calls.length;
      const cnyScenario = await seedScenario("cny-success", {
        currency: "CNY", sourceCurrency: null,
      });
      const [cnySource] = await creationRepository.loadCollectSources({
        accountId: cnyScenario.account,
        collectItemIds: [cnyScenario.collect],
      });
      const contractSuffix = ":AUTO_LISTING_SOURCE_SNAPSHOT_V2";
      assert.equal(cnySource.sourceVersion.endsWith(contractSuffix), true);
      const legacySourceVersion = cnySource.sourceVersion.slice(0, -contractSuffix.length);
      const legacyEvidence = buildAutoListingBlockedSourceEvidence({
        accountId: cnyScenario.account,
        sourceType: "COLLECT_BOX",
        sourceRecordId: cnyScenario.collect,
        sourceVersion: legacySourceVersion,
        productDraft: cnySource.productDraft,
        rawResponseRef: cnySource.rawResponseRef,
        rawResponseHash: cnySource.rawResponseHash,
        rawCollectedAt: cnySource.rawCollectedAt,
        failureCode: "AUTO_LISTING_SOURCE_CURRENCY_NOT_RUB",
      });
      await pool.query(`INSERT INTO auto_listing_source_snapshots (
        id,account_id,source_type,source_record_id,source_version,snapshot,snapshot_hash,raw_response_ref
      ) VALUES ($1,$2,'COLLECT_BOX',$3,$4,$5::jsonb,$6,$7)`, [
        `legacy-currency-${suffix}`, cnyScenario.account, cnyScenario.collect,
        legacySourceVersion, JSON.stringify(legacyEvidence.blockedEvidence),
        legacyEvidence.snapshotHash, legacyEvidence.rawResponseRef,
      ]);
      const cny = await createScenarioJob(cnyScenario);
      const versionRows = (await pool.query(`SELECT source_version,snapshot_hash
        FROM auto_listing_source_snapshots
        WHERE account_id=$1 AND source_record_id=$2 ORDER BY source_version`,
      [cnyScenario.account, cnyScenario.collect])).rows;
      assert.equal(versionRows.length, 2);
      assert.equal(versionRows.some(({ source_version }) => source_version === legacySourceVersion), true);
      assert.equal(versionRows.some(({ source_version }) => source_version === cnySource.sourceVersion), true);
      assert.equal(versionRows.find(({ source_version }) => source_version === legacySourceVersion).snapshot_hash,
        legacyEvidence.snapshotHash);
      const cnyBase = (await pool.query(`SELECT listing_base_version,pricing_evidence,ozon_ready_variants
        FROM auto_listing_listing_bases WHERE account_id=$1 AND job_id=$2 AND item_id=$3`,
      [cny.account, cny.job, cny.item])).rows[0];
      assert.equal(cnyBase.listing_base_version, "AUTO_LISTING_LISTING_BASE_V2");
      assert.equal(cnyBase.pricing_evidence.currency, "CNY");
      assert.equal(cnyBase.pricing_evidence.currencySource, "TARGET_STORE");
      assert.equal(cnyBase.ozon_ready_variants[0].item.currency_code, "CNY");
      const cnySubmission = await reserveAndCreateSubmission(cny);
      await processListingQueueMessage({ submissionJobId: cnySubmission.submissionJobId, action: "submit" });
      await processListingQueueMessage({ submissionJobId: cnySubmission.submissionJobId, action: "check" });
      const cnyImportCalls = calls.slice(cnyCallsStart)
        .filter(({ path: value, offerId }) => value === "/v3/product/import" && offerId === cny.offer);
      assert.equal(cnyImportCalls.length, 1);
      assert.equal(cnyImportCalls[0].body.items[0].currency_code, "CNY");
      assert.equal(cnyImportCalls[0].body.items[0].price, "145.00");
      assert.equal(calls.slice(cnyCallsStart)
        .filter(({ path: value }) => value === "/v2/products/stocks").length, 1);

      // An explicit RUB source in a CNY store creates one auditable blocked item and no AI or Ozon write.
      const mismatch = await seedScenario("cny-rub-source", { currency: "CNY", sourceCurrency: "RUB" });
      const mismatchCallsStart = calls.length;
      const mismatchJob = await invokeScenarioJob(mismatch);
      assert.equal(mismatchJob.items[0].status, "BLOCKED");
      assert.equal(mismatchJob.items[0].failureCode, "AUTO_LISTING_SOURCE_CURRENCY_MISMATCH");
      assert.equal(calls.slice(mismatchCallsStart).some(({ path: value }) => [
        "/v3/product/import", "/v2/products/stocks",
      ].includes(value)), false);
      assert.equal(Number((await pool.query("SELECT COUNT(*)::int AS count FROM auto_listing_jobs WHERE account_id=$1",
        [mismatch.account])).rows[0].count), 1);
      assert.equal(Number((await pool.query("SELECT COUNT(*)::int AS count FROM auto_listing_listing_bases WHERE account_id=$1",
        [mismatch.account])).rows[0].count), 0);
      assert.equal(Number((await pool.query("SELECT COUNT(*)::int AS count FROM auto_listing_ai_outbox WHERE account_id=$1",
        [mismatch.account])).rows[0].count), 0);

      // Unsupported target currency fails before any job, AI outbox, or Ozon write.
      const unsupported = await seedScenario("unsupported-usd", { currency: "USD", sourceCurrency: null });
      const unsupportedCallsStart = calls.length;
      await assert.rejects(invokeScenarioJob(unsupported), {
        code: "AUTO_LISTING_TARGET_STORE_CURRENCY_UNSUPPORTED",
      });
      assert.equal(calls.slice(unsupportedCallsStart).some(({ path: value }) => [
          "/v3/product/import", "/v2/products/stocks",
      ].includes(value)), false);
      assert.equal(Number((await pool.query("SELECT COUNT(*)::int AS count FROM auto_listing_jobs WHERE account_id=$1",
        [unsupported.account])).rows[0].count), 0);
      assert.equal(Number((await pool.query("SELECT COUNT(*)::int AS count FROM auto_listing_ai_outbox WHERE account_id=$1",
        [unsupported.account])).rows[0].count), 0);
      const forged = await seedScenario("forged-cny-variant", { currency: "CNY", sourceCurrency: null });
      const forgedCallsStart = calls.length;
      await assert.rejects(createScenarioJob(forged, {
        prepareListingBaseImpl(input) {
          const base = prepareListingBase(input);
          base.variants[0].item.currency_code = "RUB";
          return base;
        },
      }));
      assert.equal(calls.slice(forgedCallsStart).some(({ path: value }) => [
        "/v3/product/import", "/v2/products/stocks",
      ].includes(value)), false);
      assert.equal(Number((await pool.query("SELECT COUNT(*)::int AS count FROM auto_listing_jobs WHERE account_id=$1",
        [forged.account])).rows[0].count), 0);
      assert.equal(Number((await pool.query("SELECT COUNT(*)::int AS count FROM auto_listing_ai_outbox WHERE account_id=$1",
        [forged.account])).rows[0].count), 0);

      // A definitely-not-submitted first delivery gets a fresh attempt evidence and creates one handoff on retry.
      const safeRetryCallsStart = calls.length;
      const safeRetry = await createScenarioJob(await seedScenario("safe-retry-handoff"));
      await assert.rejects(reserveAndCreateSubmission(safeRetry, {
        async createSubmissionImpl() {
          throw Object.assign(new Error("controlled definitely-not-submitted fixture"), {
            code: "CONTROLLED_NOT_SUBMITTED", definitelyNotSubmitted: true,
          });
        },
      }), { code: "AUTO_LISTING_UPLOAD_RETRYABLE", retryable: true });
      const firstReservation = (await pool.query(`SELECT id,warehouse_validation_evidence_id
        FROM auto_listing_submission_links WHERE account_id=$1 AND auto_listing_item_id=$2`,
      [safeRetry.account, safeRetry.item])).rows[0];
      const firstReservedAttempt = (await pool.query(`SELECT id,warehouse_validation_evidence_id
        FROM auto_listing_upload_attempts WHERE account_id=$1 AND submission_link_id=$2 AND outcome='RESERVED'
        ORDER BY created_at,id LIMIT 1`, [safeRetry.account, firstReservation.id])).rows[0];
      const fbsWarehouseId = `safe-retry-fbs-warehouse-${suffix}`;
      const fbsPlatformWarehouseId = `safe-retry-fbs-platform-${suffix}`;
      const fbsSnapshotId = `safe-retry-fbs-snapshot-${suffix}`;
      const fbsSubmissionJobId = `safe-retry-fbs-job-${suffix}`;
      await pool.query(`INSERT INTO warehouses
        (id,store_id,warehouse_id,warehouse_type,status,is_active,is_archived)
        VALUES ($1,$2,$3,'FBS','active',TRUE,FALSE)`,
      [fbsWarehouseId, safeRetry.store, fbsPlatformWarehouseId]);
      await pool.query(`INSERT INTO submission_snapshots
        (id,collect_item_id,account_id,store_id,idempotency_key,snapshot_hash,item_count,items,stocks)
        VALUES ($1,$2,$3,$4,$5,$6,1,$7::jsonb,$8::jsonb)`,
      [fbsSnapshotId, safeRetry.collect, safeRetry.account, safeRetry.store,
        `side-by-side-fbs-${suffix}`, H("4"), JSON.stringify([listingVariant(`fbs-${safeRetry.offer}`)]),
        JSON.stringify([{ offer_id: `fbs-${safeRetry.offer}`, warehouse_id: fbsPlatformWarehouseId, stock: 5 }])]);
      await pool.query(`INSERT INTO submission_jobs
        (id,snapshot_id,collect_item_id,account_id,store_id,type,status,correlation_id,item_count)
        VALUES ($1,$2,$3,$4,$5,'AUTO_LISTING','QUEUE_PENDING',$6,1)`,
      [fbsSubmissionJobId, fbsSnapshotId, safeRetry.collect, safeRetry.account, safeRetry.store,
        `side-by-side-fbs-${suffix}`]);
      const sideBySideFbsWork = await loadSubmissionWorkV3(fbsSubmissionJobId);
      assert.equal(sideBySideFbsWork.rfbs_authorization_required, false);
      assert.equal(sideBySideFbsWork.rfbs_handoff_materialization_required, false);
      assert.equal(sideBySideFbsWork.rfbs_submission_link_id, null);
      const retryStatusVersion = Number((await pool.query(`SELECT status_version
        FROM auto_listing_job_items WHERE account_id=$1 AND id=$2`,
      [safeRetry.account, safeRetry.item])).rows[0].status_version);
      const safeRetrySubmission = await reserveAndCreateSubmission(safeRetry, {
        expectedStatusVersion: retryStatusVersion,
      });
      const retryHandoff = (await pool.query(`SELECT * FROM submission_rfbs_handoffs
        WHERE account_id=$1 AND submission_job_id=$2`,
      [safeRetry.account, safeRetrySubmission.submissionJobId])).rows[0];
      assert.equal(retryHandoff.submission_link_id, firstReservation.id);
      assert.equal(retryHandoff.link_identity_evidence_id, firstReservation.warehouse_validation_evidence_id);
      assert.notEqual(retryHandoff.attempt_authorization_evidence_id,
        firstReservation.warehouse_validation_evidence_id);
      assert.notEqual(retryHandoff.reserved_attempt_id, firstReservedAttempt.id);
      await processListingQueueMessage({ submissionJobId: safeRetrySubmission.submissionJobId, action: "submit" });
      await processListingQueueMessage({ submissionJobId: safeRetrySubmission.submissionJobId, action: "check" });
      assert.equal(calls.slice(safeRetryCallsStart)
        .filter(({ path: value }) => value === "/v3/product/import").length, 1);
      await pool.query("SET session_replication_role='replica'");
      try {
        await pool.query("DELETE FROM submission_rfbs_write_authorizations WHERE submission_job_id=$1",
          [safeRetrySubmission.submissionJobId]);
        await pool.query("DELETE FROM submission_rfbs_handoffs WHERE submission_job_id=$1",
          [safeRetrySubmission.submissionJobId]);
      } finally { await pool.query("SET session_replication_role='origin'"); }
      const insertForgedRetryHandoff = (id, linkIdentityEvidenceId, reservedAttemptId) => pool.query(
        `INSERT INTO submission_rfbs_handoffs (
          id,account_id,submission_job_id,submission_snapshot_id,store_id,local_warehouse_id,
          platform_warehouse_id,fulfillment_type,link_identity_evidence_id,
          attempt_authorization_evidence_id,reserved_attempt_id,submission_link_id,business_idempotency_key
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,'RFBS',$8,$9,$10,$11,$12)`,
        [id,retryHandoff.account_id,retryHandoff.submission_job_id,retryHandoff.submission_snapshot_id,
          retryHandoff.store_id,retryHandoff.local_warehouse_id,retryHandoff.platform_warehouse_id,
          linkIdentityEvidenceId,retryHandoff.attempt_authorization_evidence_id,reservedAttemptId,
          retryHandoff.submission_link_id,retryHandoff.business_idempotency_key]);
      await assert.rejects(insertForgedRetryHandoff(`forged-old-attempt-${suffix}`,
        retryHandoff.link_identity_evidence_id, firstReservedAttempt.id),
      (error) => error?.code === "23514");
      await assert.rejects(insertForgedRetryHandoff(`forged-link-evidence-${suffix}`,
        retryHandoff.attempt_authorization_evidence_id, retryHandoff.reserved_attempt_id),
      (error) => error?.code === "23514");

      const removeHandoffToSimulateRollingUpgrade = async (submissionJobId) => {
        await pool.query("SET session_replication_role='replica'");
        try {
          await pool.query("DELETE FROM submission_rfbs_handoffs WHERE submission_job_id=$1", [submissionJobId]);
        } finally { await pool.query("SET session_replication_role='origin'"); }
      };

      // A pre-061 bound RFBS submission remains RFBS after the local row changes type.
      const historicalTypeCallsStart = calls.length;
      const historicalType = await createScenarioJob(await seedScenario("historical-rfbs-type-drift"));
      const historicalTypeSubmission = await reserveAndCreateSubmission(historicalType);
      await removeHandoffToSimulateRollingUpgrade(historicalTypeSubmission.submissionJobId);
      await pool.query("UPDATE warehouses SET warehouse_type='FBS' WHERE id=$1 AND store_id=$2",
        [historicalType.warehouse, historicalType.store]);
      await processListingQueueMessage({ submissionJobId: historicalTypeSubmission.submissionJobId, action: "submit" });
      assert.equal(calls.slice(historicalTypeCallsStart)
        .filter(({ path: value }) => value === "/v3/product/import").length, 0);
      assert.equal(Number((await pool.query(`SELECT COUNT(*)::int AS count
        FROM submission_rfbs_write_authorizations WHERE submission_job_id=$1`,
      [historicalTypeSubmission.submissionJobId])).rows[0].count), 0);
      await pool.query("UPDATE warehouses SET warehouse_type='RFBS' WHERE id=$1 AND store_id=$2",
        [historicalType.warehouse, historicalType.store]);
      await processListingQueueMessage({ submissionJobId: historicalTypeSubmission.submissionJobId, action: "submit" });
      assert.equal(calls.slice(historicalTypeCallsStart)
        .filter(({ path: value }) => value === "/v3/product/import").length, 1);
      assert.equal(Number((await pool.query(`SELECT COUNT(*)::int AS count FROM submission_rfbs_handoffs
        WHERE account_id=$1 AND submission_job_id=$2`,
      [historicalType.account, historicalTypeSubmission.submissionJobId])).rows[0].count), 1);

      // The same historical RFBS identity fails closed if its local warehouse row is missing.
      const historicalMissingCallsStart = calls.length;
      const historicalMissing = await createScenarioJob(await seedScenario("historical-rfbs-missing"));
      const historicalMissingSubmission = await reserveAndCreateSubmission(historicalMissing);
      await removeHandoffToSimulateRollingUpgrade(historicalMissingSubmission.submissionJobId);
      await pool.query("SET session_replication_role='replica'");
      try {
        await pool.query("DELETE FROM warehouses WHERE id=$1 AND store_id=$2",
          [historicalMissing.warehouse, historicalMissing.store]);
      } finally { await pool.query("SET session_replication_role='origin'"); }
      await processListingQueueMessage({ submissionJobId: historicalMissingSubmission.submissionJobId, action: "submit" });
      assert.equal(calls.slice(historicalMissingCallsStart)
        .filter(({ path: value }) => value === "/v3/product/import").length, 0);
      assert.equal(Number((await pool.query(`SELECT COUNT(*)::int AS count
        FROM submission_rfbs_write_authorizations WHERE submission_job_id=$1`,
      [historicalMissingSubmission.submissionJobId])).rows[0].count), 0);

      // Queue-time status drift is zero-write and recovers only after a fresh read-only verification.
      const queueCallsStart = calls.length;
      const queued = await createScenarioJob(await seedScenario("queued-status-drift"));
      const queuedSubmission = await reserveAndCreateSubmission(queued);
      await pool.query("UPDATE warehouses SET status='disabled',is_active=FALSE WHERE id=$1 AND store_id=$2",
        [queued.warehouse, queued.store]);
      await processListingQueueMessage({ submissionJobId: queuedSubmission.submissionJobId, action: "submit" });
      assert.equal(calls.slice(queueCallsStart).filter(({ path: value }) => value === "/v3/product/import").length, 0);
      assert.equal((await pool.query("SELECT status FROM submission_jobs WHERE id=$1",
        [queuedSubmission.submissionJobId])).rows[0].status, "RETRY_PENDING");
      await pool.query("UPDATE warehouses SET status='active',is_active=TRUE WHERE id=$1 AND store_id=$2",
        [queued.warehouse, queued.store]);
      await processListingQueueMessage({ submissionJobId: queuedSubmission.submissionJobId, action: "submit" });
      assert.equal(calls.slice(queueCallsStart).filter(({ path: value }) => value === "/v3/product/import").length, 1);

      // Queue-time type drift is also zero-write and requires a new matching RFBS read before retry.
      const queuedTypeCallsStart = calls.length;
      const queuedType = await createScenarioJob(await seedScenario("queued-type-drift"));
      const queuedTypeSubmission = await reserveAndCreateSubmission(queuedType);
      await pool.query("UPDATE warehouses SET warehouse_type='FBS' WHERE id=$1 AND store_id=$2",
        [queuedType.warehouse, queuedType.store]);
      await processListingQueueMessage({ submissionJobId: queuedTypeSubmission.submissionJobId, action: "submit" });
      assert.equal(calls.slice(queuedTypeCallsStart).filter(({ path: value }) => value === "/v3/product/import").length, 0);
      assert.equal((await pool.query("SELECT status FROM submission_jobs WHERE id=$1",
        [queuedTypeSubmission.submissionJobId])).rows[0].status, "RETRY_PENDING");
      await pool.query("UPDATE warehouses SET warehouse_type='RFBS' WHERE id=$1 AND store_id=$2",
        [queuedType.warehouse, queuedType.store]);
      await processListingQueueMessage({ submissionJobId: queuedTypeSubmission.submissionJobId, action: "submit" });
      assert.equal(calls.slice(queuedTypeCallsStart).filter(({ path: value }) => value === "/v3/product/import").length, 1);

      // A lost PRE_IMPORT verifier response is safely retried and product import still occurs exactly once.
      const responseLossCallsStart = calls.length;
      const responseLoss = await createScenarioJob(await seedScenario("phase-response-loss"));
      const responseLossSubmission = await reserveAndCreateSubmission(responseLoss);
      await processListingQueueMessage({ submissionJobId: responseLossSubmission.submissionJobId, action: "submit" });
      assert.equal((await pool.query("SELECT status FROM submission_jobs WHERE id=$1",
        [responseLossSubmission.submissionJobId])).rows[0].status, "RETRY_PENDING");
      assert.equal(calls.slice(responseLossCallsStart).filter(({ path: value }) => value === "/v3/product/import").length, 0);
      await processListingQueueMessage({ submissionJobId: responseLossSubmission.submissionJobId, action: "submit" });
      assert.equal(calls.slice(responseLossCallsStart).filter(({ path: value }) => value === "/v3/product/import").length, 1);

      // An expired immutable upload evidence is renewed for PRE_IMPORT instead of retrying forever.
      const queueExpiryCallsStart = calls.length;
      const queueExpiry = await createScenarioJob(await seedScenario("queued-expiry-drift"));
      const queueExpirySubmission = await reserveAndCreateSubmission(queueExpiry);
      await pool.query("SET session_replication_role='replica'");
      try {
        await pool.query(`UPDATE auto_listing_rfbs_warehouse_evidence
          SET observed_at=NOW()-INTERVAL '20 minutes',expires_at=NOW()-INTERVAL '10 minutes'
          WHERE account_id=$1 AND id=$2`,
        [queueExpiry.account, queueExpirySubmission.reservation.warehouseValidationEvidenceId]);
      } finally { await pool.query("SET session_replication_role='origin'"); }
      await processListingQueueMessage({ submissionJobId: queueExpirySubmission.submissionJobId, action: "submit" });
      assert.equal(calls.slice(queueExpiryCallsStart).filter(({ path: value }) => value === "/v3/product/import").length, 1);
      assert.equal(Number((await pool.query(`SELECT COUNT(*)::int AS count
        FROM submission_rfbs_write_authorizations WHERE account_id=$1 AND submission_job_id=$2 AND phase='PRE_IMPORT'`,
      [queueExpiry.account, queueExpirySubmission.submissionJobId])).rows[0].count), 1);

      // Product acceptance followed by a type drift never writes stock or re-imports.
      const postImportCallsStart = calls.length;
      const drifted = await createScenarioJob(await seedScenario("post-import-type-drift"));
      const driftedSubmission = await reserveAndCreateSubmission(drifted);
      await processListingQueueMessage({ submissionJobId: driftedSubmission.submissionJobId, action: "submit" });
      await pool.query("UPDATE warehouses SET warehouse_type='FBS' WHERE id=$1 AND store_id=$2",
        [drifted.warehouse, drifted.store]);
      await processListingQueueMessage({ submissionJobId: driftedSubmission.submissionJobId, action: "check" });
      assert.equal((await pool.query("SELECT status FROM submission_jobs WHERE id=$1",
        [driftedSubmission.submissionJobId])).rows[0].status, "PARTIAL_SUCCESS");
      await processListingQueueMessage({ submissionJobId: driftedSubmission.submissionJobId, action: "submit" });
      await processListingQueueMessage({ submissionJobId: driftedSubmission.submissionJobId, action: "check" });
      assert.equal(calls.slice(postImportCallsStart).filter(({ path: value }) => value === "/v3/product/import").length, 1);
      assert.equal(calls.slice(postImportCallsStart).filter(({ path: value }) => value === "/v2/products/stocks").length, 0);

      // Expired upload evidence is independently renewed for PRE_STOCK and stock completes once.
      const postExpiryCallsStart = calls.length;
      const postExpiry = await createScenarioJob(await seedScenario("post-import-expiry-drift"));
      const postExpirySubmission = await reserveAndCreateSubmission(postExpiry);
      await processListingQueueMessage({ submissionJobId: postExpirySubmission.submissionJobId, action: "submit" });
      await pool.query("SET session_replication_role='replica'");
      try {
        await pool.query(`UPDATE auto_listing_rfbs_warehouse_evidence
          SET observed_at=NOW()-INTERVAL '20 minutes',expires_at=NOW()-INTERVAL '10 minutes'
          WHERE account_id=$1 AND id=$2`,
        [postExpiry.account, postExpirySubmission.reservation.warehouseValidationEvidenceId]);
      } finally { await pool.query("SET session_replication_role='origin'"); }
      await processListingQueueMessage({ submissionJobId: postExpirySubmission.submissionJobId, action: "check" });
      assert.equal((await pool.query("SELECT status FROM submission_jobs WHERE id=$1",
        [postExpirySubmission.submissionJobId])).rows[0].status, "SUCCEEDED");
      assert.equal(calls.slice(postExpiryCallsStart).filter(({ path: value }) => value === "/v3/product/import").length, 1);
      assert.equal(calls.slice(postExpiryCallsStart).filter(({ path: value }) => value === "/v2/products/stocks").length, 1);
      assert.equal(Number((await pool.query(`SELECT COUNT(*)::int AS count
        FROM submission_rfbs_write_authorizations WHERE account_id=$1 AND submission_job_id=$2 AND phase='PRE_STOCK'`,
      [postExpiry.account, postExpirySubmission.submissionJobId])).rows[0].count), 1);

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

      // Parent cleanup cascades the stock child ledger; ordinary child deletes remain blocked above.
      const cleanup = {
        account: `stock-cleanup-account-${suffix}`,
        store: `stock-cleanup-store-${suffix}`,
        snapshot: `stock-cleanup-snapshot-${suffix}`,
        job: `stock-cleanup-job-${suffix}`,
        item: `stock-cleanup-item-${suffix}`,
      };
      await pool.query(`INSERT INTO accounts(id,username,display_name,role,status)
        VALUES($1,$1,$1,'admin','active')`, [cleanup.account]);
      await pool.query(`INSERT INTO stores(id,label,company_name,client_id,status,owner_account_id)
        VALUES($1,$1,$1,$1,'active',$2)`, [cleanup.store, cleanup.account]);
      const cleanupStocks = [{ offer_id: "cleanup-offer", warehouse_id: "cleanup-platform", stock: 0 }];
      const cleanupItems = [{ offer_id: "cleanup-offer", sku: "cleanup-sku" }];
      await pool.query(`INSERT INTO submission_snapshots(
        id,account_id,store_id,idempotency_key,snapshot_hash,item_count,items,stocks)
        VALUES($1,$2,$3,$4,$5,1,$6::jsonb,$7::jsonb)`,
      [cleanup.snapshot, cleanup.account, cleanup.store, `cleanup-${suffix}`, H("e"),
        JSON.stringify(cleanupItems), JSON.stringify(cleanupStocks)]);
      await pool.query(`INSERT INTO submission_jobs(
        id,snapshot_id,account_id,store_id,status,ozon_task_id,item_count,correlation_id)
        VALUES($1,$2,$3,$4,'CHECKING','cleanup-task',1,'cleanup-correlation')`,
      [cleanup.job, cleanup.snapshot, cleanup.account, cleanup.store]);
      await pool.query(`INSERT INTO submission_items(
        id,job_id,snapshot_id,variant_key,offer_id,status,product_id)
        VALUES($1,$2,$3,'cleanup','cleanup-offer','SUCCEEDED','1')`,
      [cleanup.item, cleanup.job, cleanup.snapshot]);
      const cleanupStockItems = [{ submissionItemId: cleanup.item, offerId: "cleanup-offer",
        warehouseId: "cleanup-platform", quantity: 0 }];
      const cleanupCommand = {
        accountId: cleanup.account, jobId: cleanup.job, snapshotId: cleanup.snapshot,
        storeId: cleanup.store, importOzonTaskId: "cleanup-task", recoveryAttemptId: null,
        requestHash: (await import("../listing-pipeline.mjs"))
          .submissionStockRequestHashV3(cleanupStockItems),
        correlationId: "cleanup-correlation", actorId: "cleanup-worker", stocks: cleanupStockItems,
      };
      await (await import("../listing-pipeline.mjs")).prepareSubmissionStockWriteV3(cleanupCommand);
      await pool.query("DELETE FROM submission_jobs WHERE account_id=$1 AND id=$2",
        [cleanup.account, cleanup.job]);
      assert.equal(Number((await pool.query(`SELECT COUNT(*)::int AS count
        FROM submission_stock_write_intents WHERE account_id=$1`, [cleanup.account])).rows[0].count), 0);
      assert.equal(Number((await pool.query(`SELECT COUNT(*)::int AS count
        FROM submission_stock_write_events WHERE account_id=$1`, [cleanup.account])).rows[0].count), 0);
      await pool.query("DELETE FROM submission_snapshots WHERE account_id=$1 AND id=$2",
        [cleanup.account, cleanup.snapshot]);
      await pool.query("DELETE FROM accounts WHERE id=$1", [cleanup.account]);
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
let loadSubmissionWorkV3;
let processListingQueueMessage;
