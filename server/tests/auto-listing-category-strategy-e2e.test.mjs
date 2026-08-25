import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

import { createCategoryStrategyAnalyzer } from "../auto-listing-category-strategy-analyzer.mjs";
import {
  createAutoListingCategoryStrategyRuntime,
  createCategoryStrategyExtensionChannel,
} from "../auto-listing-category-strategy-runtime.mjs";
import { buildPlannerInput } from "../auto-listing-content-planner.mjs";
import { buildFixedSkeleton } from "../auto-listing-fixed-skeleton.mjs";
import {
  createAutoListingCategoryStrategyExtensionHttpHandler,
  createAutoListingCategoryStrategyHttpHandler,
} from "../auto-listing-category-strategy-routes.mjs";
import { createExpectedHashObjectStorage } from "../object-storage.mjs";
import { createAutoListingCategoryFreshness } from "../auto-listing-category-freshness.mjs";
import { createPostgresAccountSharedOzonCategoryRepository } from "../account-shared-ozon-category-repository.mjs";
import { createAutoListingHttpHandler } from "../auto-listing-routes.mjs";
import { createAutoListingRuntime } from "../auto-listing-runtime.mjs";
import { buildVisualGroups } from "../auto-listing-visual-groups.mjs";

const databaseUrl = process.env.TEST_DATABASE_URL;
const enabled = [process.env.AUTO_LISTING_CATEGORY_STRATEGY_E2E,
  process.env.AUTO_LISTING_CATEGORY_STRATEGY_POSTGRES_TESTS].includes("1") && Boolean(databaseUrl);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const migrationsDir = path.join(root, "server/db/migrations");
const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");
const canonical = (value) => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const jsonHash = (value) => sha(JSON.stringify(canonical(value)));
const quote = (value) => `"${String(value).replaceAll('"', '""')}"`;
const scope = Object.freeze({ taxonomyScope: "OZON:DEFAULT", descriptionCategoryId: 170, typeId: 99 });
const roles = Object.freeze(["MAIN", "SELLING_POINT", "DETAIL", "SCENE", "SPECIFICATION", "INFOGRAPHIC"]);

test("Task 11 delivery pins the executable composition suite and rollout invariants", async () => {
  const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  assert.equal(packageJson.scripts["test:auto-listing-category-strategy-e2e"],
    "node --test --test-concurrency=1 server/tests/auto-listing-category-strategy-e2e.test.mjs");
  const runbook = await readFile(path.join(root,
    "docs/runbooks/auto-listing-category-strategy-rollout.md"), "utf8");
  for (const required of [
    "001–076", "0.13.46.3", "LEGACY_FALLBACK", "single process", "sticky",
    "category_strategy_required_total", "category_strategy_sampling_started_total",
    "category_strategy_sample_set_committed_total", "category_strategy_analysis_attempt_total",
    "category_strategy_publish_total", "category_strategy_continue_create_total",
    "NEEDS_REVIEW", "ABORTED", "DONE", "new immutable version", "never delete evidence",
  ]) assert.match(runbook, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  const migrations = (await readdir(migrationsDir)).filter((name) => /^\d{3}_.+\.sql$/u.test(name)).sort();
  assert.equal(migrations.includes("076_auto_listing_category_strategy_analysis_edits.sql"), true);
  assert.equal(migrations.at(-1), "088_auto_listing_batch_order_multiplier.sql");
  assert.equal(JSON.parse(await readFile(path.join(root, "package.json"), "utf8")).version, "0.13.46.17-local");
});

function memoryObjectStorage() {
  const objects = new Map();
  const metadata = new Map();
  const etags = new Map();
  let version = 0;
  let putCalls = 0;
  let failPutAt = null;
  const raw = {
    async putObject(input) {
      putCalls += 1;
      if (failPutAt === putCalls) {
        failPutAt = null;
        throw Object.assign(new Error("injected object failure"), { code: "ObjectStorageUnavailable" });
      }
      if (input.ifNoneMatch === "*" && objects.has(input.key)) {
        throw Object.assign(new Error("exists"), { code: "PreconditionFailed", statusCode: 412 });
      }
      if (input.ifMatch && etags.get(input.key) !== input.ifMatch) {
        throw Object.assign(new Error("changed"), { code: "PreconditionFailed", statusCode: 412 });
      }
      version += 1;
      objects.set(input.key, Buffer.from(input.buffer));
      metadata.set(input.key, { ...(input.metadata || {}) });
      etags.set(input.key, `etag-${version}`);
      return { key: input.key, sha256: sha(input.buffer), contentType: input.contentType,
        size: input.buffer.length, etag: etags.get(input.key), versionId: `version-${version}` };
    },
    async getObjectBuffer(key) {
      if (!objects.has(key)) throw Object.assign(new Error("missing"), { code: "NoSuchKey" });
      return Buffer.from(objects.get(key));
    },
    async statObject(key) {
      if (!objects.has(key)) throw Object.assign(new Error("missing"), { code: "NoSuchKey" });
      return { etag: etags.get(key), size: objects.get(key).length, metaData: { ...metadata.get(key) } };
    },
    async removeObject(key, options = {}) {
      if (options.expectedEtag && options.expectedEtag !== etags.get(key)) {
        throw Object.assign(new Error("changed"), { code: "PreconditionFailed", statusCode: 412 });
      }
      if (!objects.delete(key)) throw Object.assign(new Error("missing"), { code: "NoSuchKey" });
      metadata.delete(key); etags.delete(key);
    },
  };
  return { objects, metadata, api: createExpectedHashObjectStorage(raw),
    failAfterPutCount(offset) { failPutAt = putCalls + offset; } };
}

async function seedSource(client, { accountId, suffix, targetStoreId = `store-${accountId}`,
  createSharedCategory = true, categoryScope = scope }) {
  const collectItemId = `collect-${suffix}`;
  const productDraftId = `product-draft-${suffix}`;
  const rawId = `raw-${suffix}`;
  const evidenceId = `category-evidence-${suffix}`;
  await client.query("INSERT INTO collect_items (id,account_id,status,source_sku,source_url) VALUES ($1,$2,'COLLECTED',$3,$4)",
    [collectItemId, accountId, `sku-${suffix}`, `https://www.ozon.ru/product/${suffix}`]);
  const image = { assetId: `source-image-${suffix}`, contentHash: sha(`source-image-${suffix}`) };
  const listingDraft = { sku: "4862904234", offerId: `offer-${suffix}`, title: "Test product",
    buyerCategoryUrl: "https://www.ozon.ru/category/nabory-skladnoy-mebeli-11504/",
    categoryResolution: { status: "MATCHED", method: "taxonomy",
      target: { storeId: targetStoreId, descriptionCategoryId: String(categoryScope.descriptionCategoryId),
        typeId: String(categoryScope.typeId) }, source: { path: ["root"] } },
    attributes: [], logistics: {}, productMeasurements: { reliable: true, height: 22, unit: "cm", source: "manufacturer" },
    blackKopecks: "10000", greenKopecks: "8000", currency: "RUB", images: [image],
    variants: [{ sku: "4862904234", offerId: `offer-${suffix}`, images: [image],
      evidence: { contractVersion: 1, variantId: `variant-${suffix}`, appearanceStatus: "COMPLETE",
        appearanceFacts: [{ factId: "fact-color", kind: "COLOR", value: "brown" }], sizeFacts: [] } }] };
  await client.query(`INSERT INTO collect_raw_payloads
    (id,collect_item_id,account_id,source_sku,source_url,payload_hash,collector_version,payload,collected_at)
    VALUES ($1,$2,$3,$4,$5,$6,'e2e',$7::JSONB,NOW())`,
  [rawId, collectItemId, accountId, `sku-${suffix}`, `https://www.ozon.ru/product/${suffix}`,
    sha(rawId), JSON.stringify({ normalized: { listingDraft } })]);
  await client.query(`INSERT INTO product_drafts
    (id,collect_item_id,source_payload_id,version,data_hash,data,normalizer_version,category_rule_version,dictionary_version)
    VALUES ($1,$2,$3,7,$4,$5::JSONB,'e2e','e2e','e2e')`,
  [productDraftId, collectItemId, rawId, sha(productDraftId), JSON.stringify(listingDraft)]);
  await client.query("UPDATE collect_items SET current_draft_id=$1 WHERE account_id=$2 AND id=$3",
    [productDraftId, accountId, collectItemId]);
  await client.query(`INSERT INTO collect_ozon_category_source_evidence
    (id,account_id,source_kind,source_record_id,source_version,collect_item_id,product_draft_id,
     source_description_category_id,source_type_id,taxonomy_scope,captured_at,raw_response_hash,
     raw_response_ref,product_raw_response_ref,provenance)
    VALUES ($1,$2,'PRODUCT_DRAFT',$3,'7',$4,$3,$5,$6,'OZON:DEFAULT',NOW(),$7,$8,$8,'{}'::JSONB)`,
  [evidenceId, accountId, productDraftId, collectItemId, categoryScope.descriptionCategoryId,
    categoryScope.typeId, sha(rawId), rawId]);
  await client.query(`INSERT INTO collect_ozon_category_current_sources
    (account_id,collect_item_id,source_evidence_id,source_kind,source_record_id,source_version)
    VALUES ($1,$2,$3,'PRODUCT_DRAFT',$4,'7')`, [accountId, collectItemId, evidenceId, productDraftId]);
  if (createSharedCategory) {
    await client.query(`INSERT INTO account_ozon_shared_categories
      (id,account_id,source_description_category_id,source_type_id,taxonomy_scope,
       current_description_category_id,current_type_id,status,source,version,source_evidence_id,validated_at)
      VALUES ($1,$2,$3,$4,'OZON:DEFAULT',$3,$4,'ACTIVE','SOURCE_DIRECT',1,$5,NULL)`,
    [`shared-${suffix}`, accountId, categoryScope.descriptionCategoryId, categoryScope.typeId, evidenceId]);
  }
  return { collectItemId, expectedSourceVersion: "draft:7", scope: categoryScope };
}

async function seedPublishedV1(client, { accountId, suffix }) {
  const id = `strategy-v1-${suffix}`;
  await client.query(`INSERT INTO ai_content_strategy_versions
    (id,account_id,strategy_key,version,status,content,content_hash,published_at,published_by,created_by)
    VALUES ($1,$2,'default',1,'DRAFT','{"schemaVersion":"V1"}'::JSONB,$3,NULL,NULL,$2)`,
  [id, accountId, sha("strategy-v1")]);
  await client.query(`INSERT INTO ai_content_strategy_rules
    (id,account_id,strategy_version_id,rule_kind,rule_order,product_style,rule)
    VALUES ($1,$2,$3,'PRODUCT_STYLE',1,'GENERAL',$4::JSONB)`,
  [`legacy-rule-${suffix}`, accountId, id, JSON.stringify({ ruleId: `legacy-rule-${suffix}`,
    style: "BALANCED_DEFAULT", textDensityByRole: { MAIN: "NONE", SELLING_POINT: "LIGHT" } })]);
  await client.query("UPDATE ai_content_strategy_versions SET status='PUBLISHED',published_at=NOW(),published_by=$2 WHERE id=$1 AND account_id=$2",
    [id, accountId]);
  return id;
}

function validAiOutput(request) {
  const evidenceIds = request.images.slice(0, 2).map((image) => image.evidenceId);
  return { schemaVersion: 3,
    style: { ru: "чистый каталог", zh: "干净的目录风格" },
    roleGuidance: Object.fromEntries(roles.map((role) => [role, {
      composition: { ru: `${role} товар в фокусе`, zh: `${role} 商品突出` },
      background: { ru: "нейтральный", zh: "中性背景" }, textDensity: role === "MAIN" ? "NONE" : "LIGHT",
      layout: { ru: "ясная иерархия", zh: "清晰层级" }, evidenceIds, confidence: 0.91,
    }])), commonPatterns: [{ pattern: { ru: "товар в фокусе", zh: "商品突出" },
      evidenceIds, confidence: 0.91 }],
    differences: [{ pattern: { ru: "небольшое различие реквизита", zh: "道具略有差异" },
      evidenceIds: [evidenceIds[0]] }],
    cautions: [{ ru: "не копировать брендинг конкурентов", zh: "不要复制竞品品牌标识" }] };
}

async function seedAutoListingInfrastructure(client, { accountId, suffix,
  storeId = `store-${accountId}`, warehouseId = `warehouse-${accountId}`, createUploadPolicy = true }) {
  await client.query(`INSERT INTO stores
    (id,label,company_name,client_id,status,owner_account_id,currency_code,currency_source,currency_synced_at)
    VALUES ($1,'E2E store','E2E store',$2,'active',$3,'RUB','OZON_SELLER_INFO',NOW())`,
  [storeId, `client-${suffix}`, accountId]);
  await client.query("INSERT INTO store_credentials (store_id,client_id,encrypted_api_key,iv,auth_tag) VALUES ($1,$2,'cipher','iv','tag')",
    [storeId, `client-${suffix}`]);
  await client.query(`INSERT INTO warehouses
    (id,store_id,warehouse_id,warehouse_type,status,is_active,is_archived)
    VALUES ($1,$2,'1001','FBS','active',TRUE,FALSE)`, [warehouseId, storeId]);
  await client.query("INSERT INTO products (id,store_id,product_id,sku,status,raw) VALUES ($1,$2,$3,'4862904234','active','{}'::JSONB)",
    [`product-${suffix}`, storeId, `platform-product-${suffix}`]);
  await client.query("INSERT INTO product_stocks (product_id,warehouse_id,store_id,source) VALUES ($1,$2,$3,'fbs')",
    [`product-${suffix}`, warehouseId, storeId]);
  if (createUploadPolicy) {
    await client.query(`INSERT INTO auto_listing_upload_policy_versions
      (id,account_id,mode,enabled,version,publication_reason,created_by,published_by,published_at,
       publication_origin,publication_base_url,publication_prefix,publication_version,publication_policy_hash)
      VALUES ($1,$2,'REVIEW',TRUE,1,'task11 e2e',$2,$2,NOW(),'https://cdn.example.com',
        'https://cdn.example.com/','listing-media/v1','LISTING_MEDIA_V1',$3)`,
    [`upload-policy-${suffix}`, accountId, sha("task11-publication-policy")]);
  }
  return { storeId, warehouseId };
}

async function callAdmin(runtime, actor, method, pathname, body = null) {
  let response;
  const handler = createAutoListingCategoryStrategyHttpHandler({ authenticate: async () => actor,
    getService: runtime.getService, readJson: async () => body,
    sendJson(_res, status, payload) { response = { status, payload }; } });
  assert.equal(await handler({ method }, {}, new URL(`http://127.0.0.1${pathname}`)), true);
  return response;
}

async function callExtension(runtime, actor, method, pathname, body = null, extensionVersion = "0.13.46.17") {
  let response;
  const handler = createAutoListingCategoryStrategyExtensionHttpHandler({
    authenticateExtension: async () => actor, getService: runtime.getService,
    extensionChannel: runtime.extensionChannel, readJson: async () => body,
    sendJson(_res, status, payload) { response = { status, payload }; },
  });
  const req = { method, headers: { "x-zongzi-extension-version": extensionVersion } };
  assert.equal(await handler(req, {}, new URL(`http://127.0.0.1${pathname}`)), true);
  return response;
}

async function callAutoListing(runtime, actor, body, isEnabled = () => true) {
  let response;
  const handler = createAutoListingHttpHandler({ isEnabled,
    authenticate: async () => actor, runtime, readJson: async () => body,
    sendJson(_res, status, payload) { response = { status, payload }; } });
  assert.equal(await handler({ method: "POST" }, {},
    new URL("http://127.0.0.1/auto-listing/jobs/from-collect-box")), true);
  return response;
}

async function startDraftSession(runtime, actor, source, label) {
  const draftResponse = await callAdmin(runtime, actor, "POST",
    "/admin/auto-listing/category-strategies/drafts", {
      scope: source.scope || scope, sourceCollectItemId: source.collectItemId, expectedSourceVersion: source.expectedSourceVersion,
      idempotencyKey: `draft-${label}`, correlationId: `draft-corr-${label}`,
    });
  assert.equal(draftResponse.status, 201);
  const draft = draftResponse.payload.data;
  const sessionResponse = await callAdmin(runtime, actor, "POST",
    `/admin/auto-listing/category-strategies/${draft.draftId}/sampling-sessions`, {
      expectedDraftVersion: draft.draftVersion, idempotencyKey: `session-${label}`,
      correlationId: `session-corr-${label}`,
    });
  assert.equal(sessionResponse.status, 201);
  return { draft, session: sessionResponse.payload.data };
}

async function ordinaryCollectSnapshot(pool, accountId) {
  const statements = [
    "SELECT * FROM collect_items WHERE account_id=$1 ORDER BY id",
    "SELECT * FROM collect_raw_payloads WHERE account_id=$1 ORDER BY id",
    `SELECT draft.* FROM product_drafts draft JOIN collect_items item ON item.id=draft.collect_item_id
      WHERE item.account_id=$1 ORDER BY draft.id`,
    "SELECT * FROM collect_ozon_category_source_evidence WHERE account_id=$1 ORDER BY id",
    "SELECT * FROM collect_ozon_category_current_sources WHERE account_id=$1 ORDER BY collect_item_id",
    "SELECT * FROM account_ozon_shared_categories WHERE account_id=$1 ORDER BY id",
  ];
  const rows = [];
  for (const statement of statements) rows.push((await pool.query(statement, [accountId])).rows);
  return structuredClone(rows);
}

if (!enabled) {
  test("real category strategy composition requires explicit disposable PostgreSQL opt-in", {
    skip: "set AUTO_LISTING_CATEGORY_STRATEGY_POSTGRES_TESTS=1 and TEST_DATABASE_URL to a disposable PostgreSQL 16 database",
  }, () => {});
} else {
  test("real runtime and routes compose strict gate through six-sample manual publication without production externals", {
    timeout: 120_000,
  }, async () => {
    const { Pool } = await import("pg");
    const adminPool = new Pool({ connectionString: databaseUrl, max: 1 });
    const admin = await adminPool.connect();
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const schema = `category_strategy_e2e_${suffix}`;
    let pool;
    let fakeOzon;
    try {
      await admin.query(`CREATE SCHEMA ${quote(schema)}`);
      await admin.query(`SET search_path TO ${quote(schema)}, public`);
      const migrations = (await readdir(migrationsDir)).filter((name) => /^\d{3}_.+\.sql$/u.test(name)).sort();
      assert.equal(migrations.includes("076_auto_listing_category_strategy_analysis_edits.sql"), true);
      assert.equal(migrations.at(-1), "088_auto_listing_batch_order_multiplier.sql");
      for (const migration of migrations) await admin.query(await readFile(path.join(migrationsDir, migration), "utf8"));
      const accountId = `account-a-${suffix}`;
      const foreignAccountId = `account-b-${suffix}`;
      for (const id of [accountId, foreignAccountId]) await admin.query(
        "INSERT INTO accounts (id,username,display_name,role,status) VALUES ($1,$2,$2,'admin','active')", [id, `user-${id}`]);
      const source = await seedSource(admin, { accountId, suffix });
      const secondStoreId = `store-second-${suffix}`;
      const secondWarehouseId = `warehouse-second-${suffix}`;
      const secondSource = await seedSource(admin, { accountId, suffix: `${suffix}second`,
        targetStoreId: secondStoreId, createSharedCategory: false });
      const raceSourceA = await seedSource(admin, { accountId, suffix: `${suffix}racea`,
        categoryScope: { taxonomyScope: "OZON:DEFAULT", descriptionCategoryId: 180, typeId: 100 } });
      const raceSourceB = await seedSource(admin, { accountId, suffix: `${suffix}raceb`,
        categoryScope: { taxonomyScope: "OZON:DEFAULT", descriptionCategoryId: 181, typeId: 101 } });
      const foreignSource = await seedSource(admin, { accountId: foreignAccountId, suffix: `${suffix}foreign` });
      const publishedV1 = await seedPublishedV1(admin, { accountId, suffix });
      const foreignPublishedV1 = await seedPublishedV1(admin, { accountId: foreignAccountId, suffix: `${suffix}foreign` });
      const target = await seedAutoListingInfrastructure(admin, { accountId, suffix });
      const secondTarget = await seedAutoListingInfrastructure(admin, { accountId, suffix: `${suffix}second`,
        storeId: secondStoreId, warehouseId: secondWarehouseId, createUploadPolicy: false });
      const foreignTarget = await seedAutoListingInfrastructure(admin, {
        accountId: foreignAccountId, suffix: `${suffix}foreign`,
      });
      pool = new Pool({ connectionString: databaseUrl, max: 8, options: `-c search_path=${schema},public` });
      const objectStorage = memoryObjectStorage();
      const imageBytes = await sharp({ create: { width: 900, height: 1200, channels: 3, background: "#b08b61" } })
        .jpeg({ quality: 85 }).toBuffer();
      const fakeFacts = { pageFact: { pageScope: scope, sourceResponseHash: sha("page") },
        samples: Array.from({ length: 6 }, (_, index) => {
          const sku = String(4_862_904_234 + index);
          return { sku, sourceProductId: Number(sku), sourceProductRef: `product-${sku}`,
            sourceProductResponseHash: sha(`product-${sku}`), pageScope: scope, productScope: scope,
            sourceReferences: [{ imageId: `image-${sku}`, role: "MAIN", ordinal: 0,
              sourceUrl: `https://cdn1.ozone.ru/${sku}.jpg`, sourceResponseHash: sha(`image-${sku}`) }] };
        }) };
      fakeOzon = http.createServer((request, response) => {
        if (request.url === "/image.jpg") {
          response.writeHead(200, { "content-type": "image/jpeg", "content-length": imageBytes.length });
          response.end(imageBytes); return;
        }
        if (request.url === "/facts") {
          const bytes = Buffer.from(JSON.stringify(fakeFacts));
          response.writeHead(200, { "content-type": "application/json", "content-length": bytes.length });
          response.end(bytes); return;
        }
        response.writeHead(404).end();
      });
      await new Promise((resolve) => fakeOzon.listen(0, "127.0.0.1", resolve));
      const origin = `http://127.0.0.1:${fakeOzon.address().port}`;
      const aiRequests = [];
      let aiMode = "valid";
      const metrics = [];
      const logs = [];
      const analysisAiAdapter = {
        async assertReady() {},
        async analyze(request) {
          aiRequests.push({ mode: aiMode, request });
          if (aiMode === "known-failure") {
            throw Object.assign(new Error("known fake rejection"), { code: "AI_REQUEST_REJECTED" });
          }
          if (aiMode === "response-unknown") {
            throw Object.assign(new Error("unknown fake outcome"), { code: "AI_RESPONSE_UNKNOWN", retryable: true });
          }
          const output = validAiOutput(request);
          if (aiMode === "malformed") delete output.roleGuidance.INFOGRAPHIC;
          return output;
        },
        async recover(request) {
          aiRequests.push({ mode: `recover-${aiMode}`, request });
          if (aiMode === "response-unknown") {
            throw Object.assign(new Error("unknown fake outcome"), { code: "AI_RESPONSE_UNKNOWN", retryable: true });
          }
          return validAiOutput(request);
        },
      };
      const runtime = createAutoListingCategoryStrategyRuntime({
        env: { AUTO_LISTING_ENABLED: "true", APP_ENCRYPTION_KEY: "e2e-session-key-that-is-at-least-thirty-two-characters",
          AUTO_LISTING_CATEGORY_STRATEGY_OBSERVABILITY_HASH_SECRET: "e2e-observer-key-that-is-at-least-thirty-two-characters" },
        getPostgresPool: async () => pool, createObjectStorage: () => objectStorage.api,
        createAnalyzer(input) { return createCategoryStrategyAnalyzer({ ...input,
          configurationResolver: { async resolve() { return { analyzerVersion: "category-strategy-v1",
            promptVersion: "category-strategy-prompt-v2", profileId: "fake-paid-ai", profileVersion: 1,
            model: "fake-vision-model" }; } } }); },
        analysisAiAdapter,
        downloadImage: async () => { const response = await fetch(`${origin}/image.jpg`);
          return { bytes: Buffer.from(await response.arrayBuffer()), contentType: response.headers.get("content-type") }; },
        metrics: { increment(name, labels) { metrics.push({ name, labels }); } },
        logger: { info(event) { logs.push(event); } },
      });
      const actor = { id: accountId, role: "admin" };
      const autoPorts = { prepare: 0, freshness: 0, ozon: 0 };
      const autoConfig = { targetStoreId: target.storeId, targetWarehouseId: target.warehouseId, stock: 5,
        priceAdjustmentKopecks: "0", image: { ratio: "3:4", resolution: "1K", quality: "Medium", language: "ru",
          roles: { main: 1, sellingPoint: 3, detail: 1, scene: 1, specification: 1, infographic: 1 } } };
      const autoRuntime = createAutoListingRuntime({
        getPostgresPool: async () => pool,
        env: { AUTO_LISTING_ENABLED: "true", AUTO_LISTING_AI_ENABLED: "false",
          AUTO_LISTING_CATEGORY_STRATEGY_OBSERVABILITY_HASH_SECRET: "e2e-observer-key-that-is-at-least-thirty-two-characters" },
        createListingBasePreparer: async () => async ({ source: entry, pricingEvidence }) => {
          autoPorts.prepare += 1;
          return { productDraft: { id: entry.productDraft.id, version: entry.productDraft.version,
            dataHash: entry.productDraft.dataHash },
          pricingEvidence: { ...pricingEvidence,
            evidenceHash: "4c6f549e1668186515248caffeb08fe2f9ba91ca1dab9edbdd8d159aa2b11bf8" },
          richContentAttributeSupported: true,
          variants: [{ sourceVariantId: `variant-${suffix}`, sourceSku: "4862904234", item: {
            offer_id: `offer-${suffix}`, name: "Test product", price: "100.00", currency_code: "RUB",
            description_category_id: 170, type_id: 99,
            primary_image: "https://source.example.test/product.jpg",
            images: ["https://source.example.test/product.jpg"], weight: 100, weight_unit: "g",
            depth: 100, width: 100, height: 100, dimension_unit: "mm", attributes: [],
          } }], versions: { normalizerVersion: "e2e", categoryRuleVersion: "e2e", dictionaryVersion: "e2e" } };
        },
        createCategoryFreshness: async () => async () => { autoPorts.freshness += 1; return { status: "CURRENT" }; },
        readStoreCredential: async () => { throw new Error("FBS must not read credentials"); },
        callOzonSellerApi: async () => { autoPorts.ozon += 1; throw new Error("unexpected Ozon call"); },
        metrics: { increment(name, labels) { metrics.push({ name, labels }); } },
        logger: { info(event) { logs.push(event); } },
      });
      const ordinaryBefore = await ordinaryCollectSnapshot(pool, accountId);
      const before = await pool.query(`SELECT
        (SELECT COUNT(*)::INTEGER FROM auto_listing_jobs WHERE account_id=$1) jobs,
        (SELECT COUNT(*)::INTEGER FROM auto_listing_job_items WHERE account_id=$1) items,
        (SELECT COUNT(*)::INTEGER FROM auto_listing_ai_outbox WHERE account_id=$1) outbox`, [accountId]);
      assert.deepEqual(before.rows[0], { jobs: 0, items: 0, outbox: 0 });

      assert.equal((await callExtension(runtime, actor, "POST",
        "/extension/auto-listing/category-strategy/readiness", {})).status, 200);
      const settings = await callAdmin(runtime, actor, "PATCH", "/admin/auto-listing/category-strategies/settings",
        { expectedVersion: 1, mode: "REQUIRE_EXACT_STRATEGY", idempotencyKey: `strict-${suffix}`, correlationId: `strict-corr-${suffix}` });
      assert.equal(settings.status, 200);
      const blocked = await callAutoListing(autoRuntime, actor, {
        collectItemIds: [source.collectItemId], idempotencyKey: `blocked-create-${suffix}`,
        correlationId: `blocked-create-corr-${suffix}`, config: autoConfig,
      });
      assert.equal(blocked.status, 409);
      assert.equal(blocked.payload.code, "AUTO_LISTING_CATEGORY_STRATEGY_REQUIRED");
      assert.deepEqual(autoPorts, { prepare: 0, freshness: 0, ozon: 0 });
      assert.equal(aiRequests.length, 0);
      assert.equal(objectStorage.objects.size, 0);
      assert.deepEqual((await pool.query(`SELECT
        (SELECT COUNT(*)::INTEGER FROM auto_listing_jobs WHERE account_id=$1) jobs,
        (SELECT COUNT(*)::INTEGER FROM auto_listing_job_items WHERE account_id=$1) items,
        (SELECT COUNT(*)::INTEGER FROM auto_listing_ai_outbox WHERE account_id=$1) outbox,
        (SELECT COUNT(*)::INTEGER FROM auto_listing_source_snapshots WHERE account_id=$1) snapshots,
        (SELECT COUNT(*)::INTEGER FROM auto_listing_listing_bases WHERE account_id=$1) bases`, [accountId])).rows[0],
      { jobs: 0, items: 0, outbox: 0, snapshots: 0, bases: 0 });
      const draftResponse = await callAdmin(runtime, actor, "POST", "/admin/auto-listing/category-strategies/drafts",
        { scope, sourceCollectItemId: source.collectItemId, expectedSourceVersion: source.expectedSourceVersion,
          idempotencyKey: `draft-${suffix}`, correlationId: `draft-corr-${suffix}` });
      assert.equal(draftResponse.status, 201);
      const draft = draftResponse.payload.data;
      const foreignRead = await callAdmin(runtime, { id: foreignAccountId, role: "admin" }, "GET",
        `/admin/auto-listing/category-strategies/${draft.draftId}`);
      assert.equal(foreignRead.status, 404);
      const sessionResponse = await callAdmin(runtime, actor, "POST",
        `/admin/auto-listing/category-strategies/${draft.draftId}/sampling-sessions`,
        { expectedDraftVersion: draft.draftVersion, idempotencyKey: `session-${suffix}`, correlationId: `session-corr-${suffix}` });
      assert.equal(sessionResponse.status, 201);
      const session = sessionResponse.payload.data;
      assert.equal(
        new URL(session.browserUrl).pathname,
        "/category/nabory-skladnoy-mebeli-11504/",
      );
      const extensionSession = await callExtension(runtime, actor, "GET",
        `/extension/auto-listing/category-strategy/sampling-sessions/${session.sessionId}`);
      assert.equal(extensionSession.status, 200);
      const factsResponse = await fetch(`${origin}/facts`);
      assert.equal(factsResponse.status, 200);
      const { pageFact, samples } = await factsResponse.json();
      const sessionPath = `/extension/auto-listing/category-strategy/sampling-sessions/${session.sessionId}`;
      const expandedSamples = Array.from({ length: 21 }, (_, index) => {
        const template = samples[index % samples.length];
        const sku = String(5_862_904_234 + index);
        return { ...template, sku, sourceProductId: Number(sku), sourceProductRef: `product-${sku}`,
          sourceProductResponseHash: sha(`product-${sku}`), sourceReferences: template.sourceReferences.map((reference) => ({
            ...reference, imageId: `image-${sku}`, sourceResponseHash: sha(`image-${sku}`),
          })) };
      });
      const invalidFacts = [
        { body: { pageFact, samples: samples.slice(0, 4) }, status: 400 },
        { body: { pageFact, samples: expandedSamples }, status: 400 },
        { body: { pageFact: { ...pageFact, pageScope: { ...scope, typeId: 100 } }, samples }, status: 409 },
        { body: { pageFact, samples: samples.map((sample, index) => index === 0
          ? { ...sample, pageScope: { ...scope, descriptionCategoryId: 171 } } : sample) }, status: 409 },
        { body: { pageFact, samples: samples.map((sample, index) => index === 0
          ? { ...sample, productScope: { ...scope, typeId: 100 } } : sample) }, status: 409 },
      ];
      for (const [index, invalid] of invalidFacts.entries()) {
        const rejected = await callExtension(runtime, actor, "POST", `${sessionPath}/confirm`, {
          sessionId: session.sessionId, ...invalid.body,
          idempotencyKey: `invalid-confirm-${index}-${suffix}`,
          correlationId: `invalid-confirm-corr-${index}-${suffix}`,
        });
        assert.equal(rejected.status, invalid.status);
      }
      assert.equal((await callExtension(runtime, actor, "POST", `${sessionPath}/confirm`, {
        sessionId: session.sessionId, pageFact, samples,
        idempotencyKey: `old-extension-${suffix}`, correlationId: `old-extension-corr-${suffix}`,
      }, "0.13.46.2")).status, 426);
      const foreignSession = await callExtension(runtime, { id: foreignAccountId, role: "admin" }, "GET", sessionPath);
      assert.equal(foreignSession.status, 200);
      assert.equal(foreignSession.payload.data, null);
      assert.equal(objectStorage.objects.size, 0);
      assert.equal((await pool.query("SELECT COUNT(*)::INTEGER count FROM auto_listing_category_strategy_sample_sets WHERE account_id=$1",
        [accountId])).rows[0].count, 0);
      const confirm = await callExtension(runtime, actor, "POST",
        `${sessionPath}/confirm`,
        { sessionId: session.sessionId, pageFact, samples,
          idempotencyKey: `confirm-${suffix}`, correlationId: `confirm-corr-${suffix}` });
      assert.equal(confirm.status, 201);
      assert.equal(confirm.payload.data.sampleCount, 6);
      const committedObjectCount = objectStorage.objects.size;
      const confirmReplay = await callExtension(runtime, actor, "POST", `${sessionPath}/confirm`,
        { sessionId: session.sessionId, pageFact, samples,
          idempotencyKey: `confirm-${suffix}`, correlationId: `confirm-corr-${suffix}` });
      assert.equal(confirmReplay.status, 201);
      assert.deepEqual(confirmReplay.payload.data, confirm.payload.data);
      assert.equal(objectStorage.objects.size, committedObjectCount);
      assert.equal((await pool.query("SELECT COUNT(*)::INTEGER count FROM auto_listing_category_strategy_sample_sets WHERE account_id=$1",
        [accountId])).rows[0].count, 1);
      const analysis = await callAdmin(runtime, actor, "POST",
        `/admin/auto-listing/category-strategies/${draft.draftId}/analysis-attempts`,
        { costConfirmed: true, idempotencyKey: `analysis-${suffix}`, correlationId: `analysis-corr-${suffix}` });
      assert.equal(analysis.status, 201);
      assert.equal(analysis.payload.data.status, "DRAFT_READY");
      assert.equal(aiRequests.length, 1);
      assert.equal(new Set(aiRequests[0].request.productFacts.map((fact) => fact.sku)).size, 6);
      const editedGuidance = structuredClone(analysis.payload.data.guidance);
      editedGuidance.overallStyle = "Проверенный вручную чистый каталог";
      const edit = await callAdmin(runtime, actor, "PATCH", `/admin/auto-listing/category-strategies/${draft.draftId}`,
        { expectedDraftVersion: analysis.payload.data.draftVersion,
          patch: { guidance: editedGuidance, baseAnalysisAttemptId: analysis.payload.data.attemptId },
          idempotencyKey: `edit-${suffix}`, correlationId: `edit-corr-${suffix}` });
      assert.equal(edit.status, 200);
      assert.equal(edit.payload.data.provenance, "MANUAL");
      const published = await callAdmin(runtime, actor, "POST",
        `/admin/auto-listing/category-strategies/${draft.draftId}/publish`,
        { expectedDraftVersion: edit.payload.data.draftVersion, expectedPublishedStrategyVersionId: publishedV1,
          idempotencyKey: `publish-${suffix}`, correlationId: `publish-corr-${suffix}` });
      assert.equal(published.status, 201);
      assert.equal(published.payload.data.status, "PUBLISHED");
      const bundle = await pool.query(`SELECT version.status,rule.rule
        FROM ai_content_strategy_versions version JOIN ai_content_strategy_rules rule
          ON rule.account_id=version.account_id AND rule.strategy_version_id=version.id
        WHERE version.account_id=$1 AND version.id=$2 AND rule.rule_kind='EXACT_CATEGORY'`,
      [accountId, published.payload.data.id]);
      assert.equal(bundle.rows.length, 1);
      assert.equal(bundle.rows[0].rule.overallStyle, "Проверенный вручную чистый каталог");
      assert.equal(bundle.rows[0].rule.sampleSetHash, confirm.payload.data.sampleSetHash);
      assert.equal(samples.some((sample) => JSON.stringify(bundle.rows[0]).includes(sample.sourceReferences[0].sourceUrl)), false);
      assert.equal([...objectStorage.objects.keys()].some((key) => JSON.stringify(bundle.rows[0]).includes(key)), false);
      const continuedResponse = await callAutoListing(autoRuntime, actor, {
        collectItemIds: [source.collectItemId], idempotencyKey: `continued-create-${suffix}`,
        correlationId: `continued-create-corr-${suffix}`, config: autoConfig,
      });
      assert.equal(continuedResponse.status, 201);
      assert.equal(continuedResponse.payload.data.status, "CREATED");
      assert.equal(autoPorts.prepare, 1);
      assert.equal(autoPorts.freshness, 1);
      assert.equal(autoPorts.ozon, 0);
      const persisted = await pool.query(`SELECT job.id AS job_id,job.strategy_version_id,job.config_snapshot,job.config_hash,
          item.id AS item_id,item.planning_contract,item.snapshot_id,
          event.details AS source_details,snapshot.snapshot,snapshot.snapshot_hash,snapshot.raw_response_ref
        FROM auto_listing_jobs job
        JOIN auto_listing_job_items item ON item.account_id=job.account_id AND item.job_id=job.id
        JOIN auto_listing_events event ON event.account_id=item.account_id AND event.item_id=item.id
          AND event.event_type='SOURCE_CAPTURED'
        JOIN auto_listing_source_snapshots snapshot ON snapshot.account_id=item.account_id AND snapshot.id=item.snapshot_id
        WHERE job.account_id=$1 AND job.idempotency_key=$2`, [accountId, `continued-create-${suffix}`]);
      assert.equal(persisted.rows.length, 1);
      const graphItem = persisted.rows[0];
      assert.equal(graphItem.strategy_version_id, published.payload.data.id);
      assert.equal(graphItem.source_details.ruleId, bundle.rows[0].rule.ruleId);
      assert.equal(graphItem.source_details.matchedBy, "EXACT_CATEGORY_TYPE_V2");
      assert.equal(graphItem.planning_contract, "FIXED_SKELETON_V1");
      assert.deepEqual(graphItem.config_snapshot.image.roles, autoConfig.image.roles);
      assert.equal(JSON.stringify(graphItem).includes("category-strategy/"), false);
      assert.equal((await pool.query("SELECT COUNT(*)::INTEGER count FROM auto_listing_listing_bases WHERE account_id=$1 AND job_id=$2",
        [accountId, graphItem.job_id])).rows[0].count, 1);
      const sourceCapture = { snapshot: graphItem.snapshot, snapshotHash: graphItem.snapshot_hash,
        rawResponseRef: graphItem.raw_response_ref };
      const publishedRule = bundle.rows[0].rule;
      assert.equal(publishedRule.overallStyle, "Проверенный вручную чистый каталог");
      assert.equal(JSON.stringify(publishedRule).includes("干净的目录风格"), false);
      const strategySnapshot = {
        strategyId: "default",
        strategyVersionId: graphItem.strategy_version_id,
        ruleId: publishedRule.ruleId,
        matchedBy: "EXACT_CATEGORY_TYPE_V2",
        style: "BALANCED_DEFAULT",
        textDensityByRole: Object.fromEntries(Object.entries(publishedRule.roleGuidance)
          .map(([role, guidance]) => [role, guidance.textDensity])),
        evidence: { targetTaxonomyScope: "OZON:DEFAULT", targetDescriptionCategoryId: "170",
          targetTypeId: "99", ruleOrder: publishedRule.ruleOrder },
        scope, overallStyle: publishedRule.overallStyle,
        prohibitedPatterns: publishedRule.prohibitedPatterns,
        roleGuidance: publishedRule.roleGuidance,
        sampleSetHash: publishedRule.sampleSetHash,
        analysisAttemptId: publishedRule.analysisAttemptId,
        analysisResultId: publishedRule.analysisResultId,
        diagnostics: [],
      };
      const plannerContext = buildPlannerInput({ sourceCapture,
        strategyCapture: { strategySnapshot, strategyHash: jsonHash(strategySnapshot) },
        configCapture: { configSnapshot: graphItem.config_snapshot,
          configHash: graphItem.config_hash },
        visualGroupsCapture: buildVisualGroups({ sourceCapture }),
        profileRef: { id: "fake-planner", configVersion: 1, textModel: "fake-planner-model" },
        promptTemplateVersion: "AUTO_LISTING_CONTENT_PLAN_FILL_V1",
        prohibitedClaims: ["CERTIFICATION", "MEDICAL_BENEFIT", "UNLISTED_ACCESSORIES", "WARRANTY"],
        regeneration: null });
      const skeleton = buildFixedSkeleton({ plannerContext });
      const plannedCounts = Object.fromEntries(roles.map((role) => [role,
        skeleton.plan.slots.filter((slot) => slot.role === role).length]));
      assert.deepEqual(plannedCounts, { MAIN: 1, SELLING_POINT: 3, DETAIL: 1,
        SCENE: 1, SPECIFICATION: 1, INFOGRAPHIC: 1 });
      assert.equal(skeleton.plan.slots.length, 8);
      assert.equal(JSON.stringify(plannerContext).includes("category-strategy/"), false);

      const continuedReplay = await callAutoListing(autoRuntime, actor, {
        collectItemIds: [source.collectItemId], idempotencyKey: `continued-create-${suffix}`,
        correlationId: `continued-create-corr-${suffix}`, config: autoConfig,
      });
      assert.equal(continuedReplay.status, 201);
      assert.equal(continuedReplay.payload.data.jobId, continuedResponse.payload.data.jobId);
      assert.equal((await pool.query("SELECT COUNT(*)::INTEGER count FROM auto_listing_jobs WHERE account_id=$1",
        [accountId])).rows[0].count, 1);

      const secondStoreConfig = { ...autoConfig, targetStoreId: secondTarget.storeId,
        targetWarehouseId: secondTarget.warehouseId };
      const secondStoreCreate = await callAutoListing(autoRuntime, actor, {
        collectItemIds: [secondSource.collectItemId], idempotencyKey: `second-store-create-${suffix}`,
        correlationId: `second-store-create-corr-${suffix}`, config: secondStoreConfig,
      });
      assert.equal(secondStoreCreate.status, 201);
      const secondFrozen = await pool.query(`SELECT job.strategy_version_id,event.details
        FROM auto_listing_jobs job JOIN auto_listing_job_items item
          ON item.account_id=job.account_id AND item.job_id=job.id
        JOIN auto_listing_events event ON event.account_id=item.account_id AND event.item_id=item.id
          AND event.event_type='SOURCE_CAPTURED'
        WHERE job.account_id=$1 AND job.idempotency_key=$2`, [accountId, `second-store-create-${suffix}`]);
      assert.equal(secondFrozen.rows[0].strategy_version_id, published.payload.data.id);
      assert.equal(secondFrozen.rows[0].details.ruleId, bundle.rows[0].rule.ruleId);

      const foreignActor = { id: foreignAccountId, role: "admin" };
      const foreignConfig = { ...autoConfig, targetStoreId: foreignTarget.storeId,
        targetWarehouseId: foreignTarget.warehouseId };
      const legacyV1 = await callAutoListing(autoRuntime, foreignActor, {
        collectItemIds: [foreignSource.collectItemId], idempotencyKey: `foreign-v1-${suffix}`,
        correlationId: `foreign-v1-corr-${suffix}`, config: foreignConfig,
      });
      assert.equal(legacyV1.status, 201);
      assert.equal((await pool.query("SELECT strategy_version_id FROM auto_listing_jobs WHERE account_id=$1 AND id=$2",
        [foreignAccountId, legacyV1.payload.data.jobId])).rows[0].strategy_version_id, foreignPublishedV1);
      assert.equal((await callAdmin(runtime, foreignActor, "PATCH", "/admin/auto-listing/category-strategies/settings",
        { expectedVersion: 1, mode: "REQUIRE_EXACT_STRATEGY", idempotencyKey: `foreign-strict-${suffix}`,
          correlationId: `foreign-strict-corr-${suffix}` })).status, 200);
      const foreignBlocked = await callAutoListing(autoRuntime, foreignActor, {
        collectItemIds: [foreignSource.collectItemId], idempotencyKey: `foreign-blocked-${suffix}`,
        correlationId: `foreign-blocked-corr-${suffix}`, config: foreignConfig,
      });
      assert.equal(foreignBlocked.status, 409);
      assert.equal(foreignBlocked.payload.code, "AUTO_LISTING_CATEGORY_STRATEGY_REQUIRED");
      const foreignReplay = await callAutoListing(autoRuntime, foreignActor, {
        collectItemIds: [foreignSource.collectItemId], idempotencyKey: `foreign-v1-${suffix}`,
        correlationId: `foreign-v1-corr-${suffix}`, config: foreignConfig,
      });
      assert.equal(foreignReplay.status, 201);
      assert.equal(foreignReplay.payload.data.jobId, legacyV1.payload.data.jobId);
      assert.equal((await pool.query("SELECT COUNT(*)::INTEGER count FROM auto_listing_jobs WHERE account_id=$1",
        [foreignAccountId])).rows[0].count, 1);

      const jobsBeforeDisabled = (await pool.query("SELECT COUNT(*)::INTEGER count FROM auto_listing_jobs",
        [])).rows[0].count;
      const disabled = await callAutoListing(autoRuntime, actor, {
        collectItemIds: [source.collectItemId], idempotencyKey: `disabled-${suffix}`,
        correlationId: `disabled-corr-${suffix}`, config: autoConfig,
      }, () => false);
      assert.equal(disabled.status, 503);
      assert.equal(disabled.payload.code, "AUTO_LISTING_DISABLED");
      assert.equal((await pool.query("SELECT COUNT(*)::INTEGER count FROM auto_listing_jobs")).rows[0].count,
        jobsBeforeDisabled);

      const ordinaryAfter = await pool.query("SELECT COUNT(*)::INTEGER AS count FROM collect_items WHERE account_id=$1", [accountId]);
      assert.equal(ordinaryAfter.rows[0].count, 4);
      assert.deepEqual(await ordinaryCollectSnapshot(pool, accountId), ordinaryBefore);
      assert.deepEqual(metrics, [
        { name: "category_strategy_required_total", labels: {} },
        { name: "category_strategy_sampling_started_total", labels: {} },
        { name: "category_strategy_sample_set_committed_total", labels: {} },
        { name: "category_strategy_analysis_attempt_total", labels: { outcome: "success" } },
        { name: "category_strategy_publish_total", labels: { outcome: "success" } },
        { name: "category_strategy_continue_create_total", labels: { outcome: "success" } },
        { name: "category_strategy_continue_create_total", labels: { outcome: "replay" } },
        { name: "category_strategy_continue_create_total", labels: { outcome: "success" } },
        { name: "category_strategy_required_total", labels: {} },
      ]);
      assert.equal(logs.length, 9);
      assert.deepEqual(logs.map(({ metric, outcome }) => ({ metric, outcome })), [
        { metric: "category_strategy_required_total", outcome: "blocked" },
        { metric: "category_strategy_sampling_started_total", outcome: "success" },
        { metric: "category_strategy_sample_set_committed_total", outcome: "success" },
        { metric: "category_strategy_analysis_attempt_total", outcome: "success" },
        { metric: "category_strategy_publish_total", outcome: "success" },
        { metric: "category_strategy_continue_create_total", outcome: "success" },
        { metric: "category_strategy_continue_create_total", outcome: "replay" },
        { metric: "category_strategy_continue_create_total", outcome: "success" },
        { metric: "category_strategy_required_total", outcome: "blocked" },
      ]);
      const serializedLogs = JSON.stringify(logs);
      assert.equal(serializedLogs.includes(accountId), false);
      assert.equal(serializedLogs.includes("ozone.ru"), false);
      assert.equal(serializedLogs.includes("fake-paid-ai"), false);

      let expiryNow = Date.now();
      const expiryChannel = createCategoryStrategyExtensionChannel({ now: () => expiryNow });
      const expiryRuntime = createAutoListingCategoryStrategyRuntime({
        env: { AUTO_LISTING_ENABLED: "true", APP_ENCRYPTION_KEY: "e2e-session-key-that-is-at-least-thirty-two-characters",
          AUTO_LISTING_CATEGORY_STRATEGY_OBSERVABILITY_HASH_SECRET: "e2e-observer-key-that-is-at-least-thirty-two-characters" },
        getPostgresPool: async () => pool, createObjectStorage: () => objectStorage.api,
        extensionSessionChannel: expiryChannel, exactProductFacts: expiryChannel, now: () => expiryNow,
        createAnalyzer(input) { return createCategoryStrategyAnalyzer({ ...input,
          configurationResolver: { async resolve() { return { analyzerVersion: "category-strategy-v1",
            promptVersion: "category-strategy-prompt-v2", profileId: "fake-paid-ai", profileVersion: 1,
            model: "fake-vision-model" }; } } }); },
        analysisAiAdapter,
        downloadImage: async () => { const response = await fetch(`${origin}/image.jpg`);
          return { bytes: Buffer.from(await response.arrayBuffer()), contentType: response.headers.get("content-type") }; },
        metrics: { increment(name, labels) { metrics.push({ name, labels }); } },
        logger: { info(event) { logs.push(event); } },
      });
      assert.equal((await callExtension(expiryRuntime, actor, "POST",
        "/extension/auto-listing/category-strategy/readiness", {})).status, 200);
      const expiryCase = await startDraftSession(expiryRuntime, actor, source, `expiry-${suffix}`);
      expiryNow += 3 * 60 * 60 * 1000;
      const expiredRead = await callExtension(expiryRuntime, actor, "GET",
        `/extension/auto-listing/category-strategy/sampling-sessions/${expiryCase.session.sessionId}`);
      assert.equal(expiredRead.status, 200);
      assert.equal(expiredRead.payload.data, null);
      assert.equal((await callExtension(expiryRuntime, actor, "POST",
        `/extension/auto-listing/category-strategy/sampling-sessions/${expiryCase.session.sessionId}/confirm`, {
          sessionId: expiryCase.session.sessionId, pageFact, samples: expandedSamples.slice(0, 5),
          idempotencyKey: `expired-confirm-${suffix}`, correlationId: `expired-confirm-corr-${suffix}`,
        })).status, 404);
      assert.equal((await pool.query(`SELECT COUNT(*)::INTEGER count
        FROM auto_listing_category_strategy_sample_sets WHERE account_id=$1 AND draft_id=$2`,
      [accountId, expiryCase.draft.draftId])).rows[0].count, 0);

      const storageSession = await callAdmin(runtime, actor, "POST",
        `/admin/auto-listing/category-strategies/${expiryCase.draft.draftId}/sampling-sessions`, {
          expectedDraftVersion: expiryCase.draft.draftVersion, idempotencyKey: `storage-session-${suffix}`,
          correlationId: `storage-session-corr-${suffix}`,
        });
      assert.equal(storageSession.status, 201);
      const storageCase = { draft: expiryCase.draft, session: storageSession.payload.data };
      objectStorage.failAfterPutCount(2);
      const storageFailure = await callExtension(runtime, actor, "POST",
        `/extension/auto-listing/category-strategy/sampling-sessions/${storageCase.session.sessionId}/confirm`, {
          sessionId: storageCase.session.sessionId, pageFact, samples: expandedSamples.slice(0, 5),
          idempotencyKey: `storage-confirm-${suffix}`, correlationId: `storage-confirm-corr-${suffix}`,
        });
      assert.equal(storageFailure.status, 500);
      assert.match(storageFailure.payload.code,
        /^AUTO_LISTING_CATEGORY_STRATEGY_IMAGE_(?:STORAGE|CLEANUP)_FAILED$|^AUTO_LISTING_CATEGORY_STRATEGY_IMAGE_IN_PROGRESS$/u);
      assert.equal((await pool.query(`SELECT COUNT(*)::INTEGER count
        FROM auto_listing_category_strategy_sample_sets WHERE account_id=$1 AND draft_id=$2`,
      [accountId, storageCase.draft.draftId])).rows[0].count, 0);
      assert.equal([...objectStorage.metadata.values()].some((metadata) =>
        Object.values(metadata).includes("ABORTED")), true);
      const cancelled = await callExtension(runtime, actor, "POST",
        `/extension/auto-listing/category-strategy/sampling-sessions/${storageCase.session.sessionId}/cancel`,
        { sessionId: storageCase.session.sessionId });
      assert.equal(cancelled.status, 200);
      assert.equal(cancelled.payload.data.cancelled, true);
      assert.equal((await pool.query(
        `SELECT state FROM auto_listing_category_strategy_sampling_sessions
          WHERE account_id=$1 AND id=$2`, [accountId, storageCase.session.sessionId],
      )).rows[0].state, "CANCELLED");
      assert.equal((await callExtension(runtime, actor, "POST",
        `/extension/auto-listing/category-strategy/sampling-sessions/${storageCase.session.sessionId}/confirm`, {
          sessionId: storageCase.session.sessionId, pageFact, samples: expandedSamples.slice(0, 5),
          idempotencyKey: `cancelled-confirm-${suffix}`, correlationId: `cancelled-confirm-corr-${suffix}`,
        })).status, 404);

      const runAnalysisFailure = async (label, count, mode, suppliedScenario = null) => {
        const scenario = suppliedScenario || await startDraftSession(runtime, actor, source, `${label}-${suffix}`);
        const selected = expandedSamples.slice(0, count).map((sample) => ({ ...sample,
          sourceReferences: sample.sourceReferences.map((reference) => ({
            ...reference, imageId: `${reference.imageId}-${label}`,
          })),
        }));
        const confirmed = await callExtension(runtime, actor, "POST",
          `/extension/auto-listing/category-strategy/sampling-sessions/${scenario.session.sessionId}/confirm`, {
            sessionId: scenario.session.sessionId, pageFact, samples: selected,
            idempotencyKey: `${label}-confirm-${suffix}`, correlationId: `${label}-confirm-corr-${suffix}`,
          });
        assert.equal(confirmed.status, 201, JSON.stringify(confirmed.payload));
        assert.equal(confirmed.payload.data.sampleCount, count);
        aiMode = mode;
        const analyzed = await callAdmin(runtime, actor, "POST",
          `/admin/auto-listing/category-strategies/${scenario.draft.draftId}/analysis-attempts`, {
            costConfirmed: true, idempotencyKey: `${label}-analysis-${suffix}`,
            correlationId: `${label}-analysis-corr-${suffix}`,
          });
        return { scenario, analyzed };
      };

      const recoverySessionResponse = await callAdmin(runtime, actor, "POST",
        `/admin/auto-listing/category-strategies/${storageCase.draft.draftId}/sampling-sessions`, {
          expectedDraftVersion: storageCase.draft.draftVersion, idempotencyKey: `storage-recovery-session-${suffix}`,
          correlationId: `storage-recovery-session-corr-${suffix}`,
        });
      assert.equal(recoverySessionResponse.status, 201);
      const knownFailure = await runAnalysisFailure("five-known", 5, "known-failure", {
        draft: storageCase.draft, session: recoverySessionResponse.payload.data,
      });
      assert.equal(knownFailure.analyzed.status, 201);
      assert.equal(knownFailure.analyzed.payload.data.status, "NEEDS_REVIEW");
      assert.equal(knownFailure.analyzed.payload.data.safeCode, "AUTO_LISTING_CATEGORY_STRATEGY_AI_CALL_FAILED");
      const recoverAndPublish = async (failure, label, expectedPublishedStrategyVersionId) => {
        const recoveredEdit = await callAdmin(runtime, actor, "PATCH",
          `/admin/auto-listing/category-strategies/${failure.scenario.draft.draftId}`, {
            expectedDraftVersion: failure.analyzed.payload.data.draftVersion,
            patch: { guidance: editedGuidance,
              baseAnalysisAttemptId: failure.analyzed.payload.data.attemptId },
            idempotencyKey: `${label}-edit-${suffix}`, correlationId: `${label}-edit-corr-${suffix}`,
          });
        assert.equal(recoveredEdit.status, 200);
        const recoveredPublish = await callAdmin(runtime, actor, "POST",
          `/admin/auto-listing/category-strategies/${failure.scenario.draft.draftId}/publish`, {
            expectedDraftVersion: recoveredEdit.payload.data.draftVersion,
            expectedPublishedStrategyVersionId,
            idempotencyKey: `${label}-publish-${suffix}`, correlationId: `${label}-publish-corr-${suffix}`,
          });
        assert.equal(recoveredPublish.status, 201);
        return recoveredPublish.payload.data.id;
      };
      const knownPublished = await recoverAndPublish(knownFailure, "five-known", published.payload.data.id);
      const malformed = await runAnalysisFailure("twenty-malformed", 20, "malformed");
      assert.equal(malformed.analyzed.status, 201);
      assert.equal(malformed.analyzed.payload.data.status, "NEEDS_REVIEW");
      assert.match(malformed.analyzed.payload.data.safeCode, /^AUTO_LISTING_CATEGORY_STRATEGY_AI_/u);
      const malformedPublished = await recoverAndPublish(malformed, "twenty-malformed", knownPublished);
      const unknownStart = aiRequests.length;
      const unknown = await runAnalysisFailure("five-unknown", 5, "response-unknown");
      assert.equal(unknown.analyzed.status, 409, JSON.stringify(unknown.analyzed.payload));
      assert.equal(unknown.analyzed.payload.code, "AUTO_LISTING_CATEGORY_STRATEGY_AI_RESPONSE_UNKNOWN");
      const unknownReplay = await callAdmin(runtime, actor, "POST",
        `/admin/auto-listing/category-strategies/${unknown.scenario.draft.draftId}/analysis-attempts`, {
          costConfirmed: true, idempotencyKey: `five-unknown-analysis-${suffix}`,
          correlationId: `five-unknown-analysis-corr-${suffix}`,
        });
      assert.equal(unknownReplay.status, 409);
      assert.deepEqual(aiRequests.slice(unknownStart).map(({ mode }) => mode),
        ["response-unknown", "recover-response-unknown"]);
      const pendingUnknown = await pool.query(`SELECT draft.status,COUNT(attempt.id)::INTEGER attempt_count
        FROM auto_listing_category_strategy_drafts draft
        LEFT JOIN auto_listing_category_strategy_analysis_attempts attempt
          ON attempt.account_id=draft.account_id AND attempt.draft_id=draft.id
        WHERE draft.account_id=$1 AND draft.id=$2 GROUP BY draft.status`,
      [accountId, unknown.scenario.draft.draftId]);
      assert.deepEqual(pendingUnknown.rows[0], { status: "ANALYZING", attempt_count: 1 });
      assert.deepEqual(metrics.slice(9).map(({ name, labels }) => ({ name, labels })), [
        { name: "category_strategy_sampling_started_total", labels: {} },
        { name: "category_strategy_sampling_started_total", labels: {} },
        { name: "category_strategy_sample_set_committed_total", labels: {} },
        { name: "category_strategy_sampling_started_total", labels: {} },
        { name: "category_strategy_sampling_started_total", labels: {} },
        { name: "category_strategy_sample_set_committed_total", labels: {} },
        { name: "category_strategy_analysis_attempt_total", labels: { outcome: "rejected" } },
        { name: "category_strategy_publish_total", labels: { outcome: "success" } },
        { name: "category_strategy_sampling_started_total", labels: {} },
        { name: "category_strategy_sample_set_committed_total", labels: {} },
        { name: "category_strategy_analysis_attempt_total", labels: { outcome: "rejected" } },
        { name: "category_strategy_publish_total", labels: { outcome: "success" } },
        { name: "category_strategy_sampling_started_total", labels: {} },
        { name: "category_strategy_sample_set_committed_total", labels: {} },
        { name: "category_strategy_analysis_attempt_total", labels: { outcome: "response_unknown" } },
        { name: "category_strategy_analysis_attempt_total", labels: { outcome: "response_unknown" } },
      ]);

      let driftPrepareCalls = 0;
      const driftRuntime = createAutoListingRuntime({
        getPostgresPool: async () => pool,
        env: { AUTO_LISTING_ENABLED: "true", AUTO_LISTING_AI_ENABLED: "false",
          AUTO_LISTING_CATEGORY_STRATEGY_OBSERVABILITY_HASH_SECRET: "e2e-observer-key-that-is-at-least-thirty-two-characters" },
        createListingBasePreparer: async () => async () => {
          driftPrepareCalls += 1; throw new Error("source drift must stop before listing-base preparation");
        },
        createCategoryFreshness: async () => {
          const driftRepository = createPostgresAccountSharedOzonCategoryRepository({ pool });
          const freshness = createAutoListingCategoryFreshness({
          loadStoreAccess: async () => ({ id: target.storeId, ownerAccountId: accountId,
            clientId: `client-${suffix}`, apiKey: "loopback-only-key", currencyCode: "RUB" }),
          categoryService: {
            async getCategorySnapshot() { return { items: [{ description_category_id: 171, disabled: false,
              children: [{ type_id: 99, disabled: false }] }], taxonomyFingerprint: sha("refreshed-taxonomy"), stale: false }; },
            async getCategoryAttributes() { return { items: [{ id: 85, is_required: true }] }; },
          },
            repository: {
              async invalidateSharedCategory(input) {
                return driftRepository.invalidateSharedCategory({ ...input });
              },
              async activateRefreshedCategory(input) {
                return driftRepository.activateRefreshedCategory({ ...input });
              },
            },
          });
          return freshness;
        },
        readStoreCredential: async () => { throw new Error("FBS must not read credentials"); },
        callOzonSellerApi: async () => { throw new Error("unexpected Ozon seller call"); },
        metrics: { increment(name, labels) { metrics.push({ name, labels }); } },
        logger: { info(event) { logs.push(event); } },
      });
      const metricsBeforeDrift = metrics.length;
      const drifted = await callAutoListing(driftRuntime, actor, {
        collectItemIds: [source.collectItemId], idempotencyKey: `source-drift-${suffix}`,
        correlationId: `source-drift-corr-${suffix}`, config: autoConfig,
      });
      assert.equal(drifted.status, 409, JSON.stringify(drifted.payload));
      assert.equal(drifted.payload.code, "AUTO_LISTING_CATEGORY_STRATEGY_REQUIRED");
      assert.equal(driftPrepareCalls, 0);
      assert.equal((await pool.query("SELECT COUNT(*)::INTEGER count FROM auto_listing_jobs WHERE account_id=$1 AND idempotency_key=$2",
        [accountId, `source-drift-${suffix}`])).rows[0].count, 0);
      assert.deepEqual((await pool.query(`SELECT status,source,version,current_description_category_id,current_type_id
        FROM account_ozon_shared_categories WHERE account_id=$1 AND source_description_category_id=170 AND source_type_id=99`,
      [accountId])).rows[0], { status: "ACTIVE", source: "OZON_REFRESH", version: 3,
        current_description_category_id: "171", current_type_id: "99" });
      assert.deepEqual(metrics.slice(metricsBeforeDrift), [
        { name: "category_strategy_required_total", labels: {} },
        { name: "category_strategy_continue_create_total", labels: { outcome: "strategy_changed" } },
      ]);

      const metricsBeforeRace = metrics.length;
      const prepareRaceDraft = async (sourceEntry, label) => {
        const scenario = await startDraftSession(runtime, actor, sourceEntry, `${label}-${suffix}`);
        const selected = expandedSamples.slice(0, 5).map((sample) => ({ ...sample,
          pageScope: sourceEntry.scope, productScope: sourceEntry.scope,
          sourceReferences: sample.sourceReferences.map((reference) => ({
            ...reference, imageId: `${reference.imageId}-${label}-${suffix}`,
          })),
        }));
        const racePageFact = { ...pageFact, pageScope: sourceEntry.scope };
        const confirmed = await callExtension(runtime, actor, "POST",
          `/extension/auto-listing/category-strategy/sampling-sessions/${scenario.session.sessionId}/confirm`, {
            sessionId: scenario.session.sessionId, pageFact: racePageFact, samples: selected,
            idempotencyKey: `${label}-confirm-${suffix}`, correlationId: `${label}-confirm-corr-${suffix}`,
          });
        assert.equal(confirmed.status, 201);
        aiMode = "valid";
        const analyzed = await callAdmin(runtime, actor, "POST",
          `/admin/auto-listing/category-strategies/${scenario.draft.draftId}/analysis-attempts`, {
            costConfirmed: true, idempotencyKey: `${label}-analysis-${suffix}`,
            correlationId: `${label}-analysis-corr-${suffix}`,
          });
        assert.equal(analyzed.status, 201);
        assert.equal(analyzed.payload.data.status, "DRAFT_READY");
        return { scenario, analyzed };
      };
      const [raceA, raceB] = await Promise.all([
        prepareRaceDraft(raceSourceA, "race-a"), prepareRaceDraft(raceSourceB, "race-b"),
      ]);
      const publishRace = (entry, label) => callAdmin(runtime, actor, "POST",
        `/admin/auto-listing/category-strategies/${entry.scenario.draft.draftId}/publish`, {
          expectedDraftVersion: entry.analyzed.payload.data.draftVersion,
          expectedPublishedStrategyVersionId: malformedPublished,
          idempotencyKey: `${label}-publish-${suffix}`, correlationId: `${label}-publish-corr-${suffix}`,
        });
      const raceResults = await Promise.all([publishRace(raceA, "race-a"), publishRace(raceB, "race-b")]);
      assert.deepEqual(raceResults.map(({ status }) => status).sort((left, right) => left - right), [201, 409],
        JSON.stringify(raceResults));
      assert.equal((await pool.query(`SELECT COUNT(*)::INTEGER count FROM ai_content_strategy_versions
        WHERE account_id=$1 AND status='PUBLISHED'`, [accountId])).rows[0].count, 1);
      const raceMetrics = metrics.slice(metricsBeforeRace);
      assert.equal(raceMetrics.filter(({ name }) => name === "category_strategy_sampling_started_total").length, 2);
      assert.equal(raceMetrics.filter(({ name }) => name === "category_strategy_sample_set_committed_total").length, 2);
      assert.deepEqual(raceMetrics.filter(({ name }) => name === "category_strategy_analysis_attempt_total")
        .map(({ labels }) => labels), [{ outcome: "success" }, { outcome: "success" }]);
      assert.deepEqual(raceMetrics.filter(({ name }) => name === "category_strategy_publish_total")
        .map(({ labels }) => labels).sort((left, right) => left.outcome.localeCompare(right.outcome)),
      [{ outcome: "conflict" }, { outcome: "success" }]);
    } finally {
      fakeOzon?.closeAllConnections?.();
      if (fakeOzon?.listening) await new Promise((resolve) => fakeOzon.close(resolve));
      await pool?.end();
      try { await admin.query("SET search_path TO public"); await admin.query(`DROP SCHEMA IF EXISTS ${quote(schema)} CASCADE`); }
      finally { admin.release(); await adminPool.end(); }
    }
  });
}
