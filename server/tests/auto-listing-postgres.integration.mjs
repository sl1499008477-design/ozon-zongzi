import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createAutoListingRepository } from "../auto-listing-repository.mjs";
import { createAutoListingService } from "../auto-listing-service.mjs";
import { normalizeAndHashAutoListingConfig } from "../auto-listing-contract.mjs";
import { deriveEffectiveAutoListingImageConfig } from "../auto-listing-item-image-config.mjs";
import {
  buildAutoListingBlockedSourceEvidence,
  buildAutoListingSourceSnapshot,
  canonicalAutoListingSourceSnapshot,
} from "../auto-listing-source-snapshot.mjs";

const databaseUrl = process.env.SONLI_MIGRATION_TEST_DATABASE_URL;
const enabled = process.env.AUTO_LISTING_POSTGRES_TESTS === "1" && Boolean(databaseUrl);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(__dirname, "../db/migrations");
const quoteIdentifier = (value) => `"${String(value).replaceAll('"', '""')}"`;
const publicationPolicy = Object.freeze({ origin: "https://cdn.example.com",
  baseUrl: "https://cdn.example.com/", prefix: "listing-media/v1",
  publicationVersion: "LISTING_MEDIA_V1" });
const publicationPolicyHash = crypto.createHash("sha256").update(JSON.stringify({
  baseUrl: publicationPolicy.baseUrl, origin: publicationPolicy.origin,
  prefix: publicationPolicy.prefix, publicationVersion: publicationPolicy.publicationVersion,
})).digest("hex");

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

function graph(accountId, idempotencyKey, suffix, overrides = {}) {
  const sourceRecordId = `collect-${suffix}`;
  const productDraftId = `draft-${suffix}`;
  const sourceVersion = "1";
  const { config, configHash } = normalizeAndHashAutoListingConfig({
    targetStoreId: `store-${accountId}`,
    targetWarehouseId: `warehouse-${accountId}`,
    stock: 1,
    priceAdjustmentKopecks: "0",
  });
  const captured = buildAutoListingSourceSnapshot({
    accountId,
    sourceType: "COLLECT_BOX",
    sourceRecordId,
    sourceVersion,
    rawResponseRef: `raw-${suffix}`,
    rawResponseHash: `raw-hash-${suffix}`,
    productDraft: { id: productDraftId, version: 1 },
    ...categoryAuthority(accountId, suffix),
    targetStoreCurrency: "RUB",
    collectItem: {
      id: sourceRecordId,
      accountId,
      sku: `sku-${suffix}`,
      listingDraft: {
        sku: `sku-${suffix}`,
        offerId: `offer-${suffix}`,
        title: `Product ${suffix}`,
        currency: "RUB", blackKopecks: "10000", greenKopecks: "8000", images: [], variants: [{ sku: `sku-${suffix}`, offerId: `offer-${suffix}` }],
        categoryResolution: { status: "MATCHED", method: "test", target: { storeId: `store-${accountId}`, descriptionCategoryId: "123", typeId: "456" }, source: { path: [] } },
      },
    },
  });
  return {
    accountId,
    actorAccountId: accountId,
    categoryPreparationLeaseId: `category-lease-${suffix}`,
    sourceType: "COLLECT_BOX",
    idempotencyKey,
    correlationId: `corr-${suffix}`,
    configSnapshot: config,
    configHash,
    strategyVersionId: `strategy-version-${accountId}`,
    uploadPolicyVersionId: `upload-policy-${accountId}`,
    warehouseValidation: null,
    items: [{
      sourceType: "COLLECT_BOX",
      sourceRecordId,
      sourceVersion,
      snapshot: captured.snapshot,
      snapshotHash: captured.snapshotHash,
      rawResponseRef: captured.rawResponseRef,
      targetStoreId: `store-${accountId}`,
      targetWarehouseId: `warehouse-${accountId}`,
      sourceOrder: 0,
      status: "SOURCE_READY",
      strategyId: `strategy-${accountId}`,
      strategyVersionId: `strategy-version-${accountId}`,
      ruleId: null,
      style: "BALANCED_DEFAULT",
      matchedBy: "DEFAULT",
      price: { currency: "RUB", branch: "BLACK_GTE_80", blackKopecks: "10000", greenKopecks: "8000", realPriceKopecks: "14500", adjustmentKopecks: "0", finalPriceKopecks: "14500" },
      effectiveImageConfig: deriveEffectiveAutoListingImageConfig({
        configSnapshot: config, configHash, sourceCapture: captured,
      }),
      listingBaseTemplate: {
        productDraft: { id: productDraftId, version: 1, dataHash: "1".repeat(64) },
        pricingEvidence: {
          currency: "RUB", currencySource: "SOURCE", blackKopecks: "10000", greenKopecks: "8000",
          evidenceHash: "4c6f549e1668186515248caffeb08fe2f9ba91ca1dab9edbdd8d159aa2b11bf8",
        },
        richContentAttributeSupported: true,
        variants: [{
          sourceVariantId: `variant-${suffix}`, sourceSku: `sku-${suffix}`,
          item: {
            offer_id: `offer-${suffix}`, name: `Product ${suffix}`, price: "100.00", currency_code: "RUB",
            description_category_id: 123, type_id: 456,
            primary_image: `https://source.example.test/${suffix}.jpg`, images: [`https://source.example.test/${suffix}.jpg`],
            weight: 100, weight_unit: "g", depth: 100, width: 100, height: 100, dimension_unit: "mm",
            attributes: [{ id: 85, complex_id: 0, values: [{ value: "No brand" }] }],
          },
        }],
        versions: { normalizerVersion: "v3", categoryRuleVersion: "v1", dictionaryVersion: "live" },
      },
    }],
    ...overrides,
  };
}

function withChangedSourceHash(input) {
  const changed = structuredClone(input);
  changed.items[0].snapshot.rawEvidence.rawResponseHash = "different-raw-hash";
  changed.items[0].snapshotHash = crypto.createHash("sha256")
    .update(canonicalAutoListingSourceSnapshot(changed.items[0].snapshot)).digest("hex");
  return changed;
}

function twoConnectionSnapshotBarrier(scopedPool, timeoutMs = 5_000) {
  let arrivals = 0;
  let settled = false;
  let abortCause = null;
  let resolveBarrier;
  const barrier = new Promise((resolve) => { resolveBarrier = resolve; });
  const abort = (cause = new Error("snapshot insertion barrier aborted")) => {
    if (settled) return;
    settled = true;
    abortCause = cause;
    clearTimeout(timeout);
    resolveBarrier();
  };
  const timeout = setTimeout(() => abort(new Error(`snapshot insertion barrier timed out after ${timeoutMs}ms (arrivals=${arrivals})`)), timeoutMs);
  const release = () => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    resolveBarrier();
  };
  return {
    query: (...args) => scopedPool.query(...args),
    abort,
    dispose: () => abort(new Error("snapshot insertion barrier disposed")),
    async connect() {
      const connection = await scopedPool.connect();
      return {
        async query(sql, params) {
          if (/INSERT INTO auto_listing_source_snapshots/.test(sql)) {
            arrivals += 1;
            if (arrivals === 2) release();
            await barrier;
            if (abortCause) throw abortCause;
          }
          return connection.query(sql, params);
        },
        release: () => connection.release(),
      };
    },
  };
}

async function runBarrierRace(repository, barrier, inputs) {
  const tasks = inputs.map((input) => repository.createJobGraph(input).catch((error) => {
    barrier.abort(error);
    throw error;
  }));
  try {
    return await Promise.allSettled(tasks);
  } finally {
    barrier.dispose();
  }
}

function twoConnectionTargetEvidenceBarrier(scopedPool, timeoutMs = 5_000) {
  let settled = false;
  let locked = false;
  let abortCause = null;
  let resolveLocked;
  let rejectLocked;
  let resolveProceed;
  const lockReached = new Promise((resolve, reject) => {
    resolveLocked = resolve;
    rejectLocked = reject;
  });
  lockReached.catch(() => {});
  const proceed = new Promise((resolve) => { resolveProceed = resolve; });
  const finish = (cause = null) => {
    if (settled) return;
    settled = true;
    abortCause = cause;
    clearTimeout(timeout);
    if (cause && !locked) rejectLocked(cause);
    resolveProceed();
  };
  const timeout = setTimeout(() => finish(new Error(`target evidence barrier timed out after ${timeoutMs}ms`)), timeoutMs);
  return {
    query: (...args) => scopedPool.query(...args),
    waitForLock: () => lockReached,
    abort: (cause = new Error("target evidence barrier aborted")) => finish(cause),
    release: () => finish(),
    dispose: () => finish(new Error("target evidence barrier disposed")),
    async connect() {
      const connection = await scopedPool.connect();
      return {
        async query(sql, params) {
          const result = await connection.query(sql, params);
          if (/FROM product_stocks ps/.test(sql) && /FOR SHARE OF p,ps/.test(sql)) {
            if (!locked) {
              locked = true;
              resolveLocked();
            }
            await proceed;
            if (abortCause) throw abortCause;
          }
          return result;
        },
        release: () => connection.release(),
      };
    },
  };
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitForBackendLock({ observer, backendPid, marker, timeoutMs = 5_000, pollMs = 25 } = {}) {
  if (!observer || typeof observer.query !== "function" || !Number.isInteger(backendPid)
    || backendPid <= 0 || typeof marker !== "string" || !marker) {
    throw new TypeError("lock observer requires a backend PID and marker");
  }
  const deadline = Date.now() + timeoutMs;
  let lastRow = null;
  while (Date.now() <= deadline) {
    const result = await observer.query(
      "SELECT wait_event_type,query FROM pg_stat_activity WHERE pid=$1",
      [backendPid],
    );
    const row = result?.rows?.[0] || null;
    lastRow = row;
    if (row?.wait_event_type === "Lock" && typeof row.query === "string" && row.query.includes(marker)) {
      return row;
    }
    if (Date.now() >= deadline) break;
    await delay(pollMs);
  }
  throw new Error(`backend ${backendPid} did not enter marked lock wait (${marker}); last=${JSON.stringify(lastRow)}`);
}

async function registerGraphSources(client, graphInput) {
  for (const item of graphInput.items) {
    await client.query(
      `INSERT INTO collect_items (id,account_id,source,identity_key,source_sku,summary)
       VALUES ($1,$2,'test',$3,$4,'{}'::jsonb) ON CONFLICT (id) DO NOTHING`,
      [item.sourceRecordId, graphInput.accountId, `identity-${item.sourceRecordId}`, item.snapshot?.identity?.primarySku || `blocked-${item.sourceRecordId}`],
    );
    if (item.status === "SOURCE_READY") {
      const draft = item.listingBaseTemplate.productDraft;
      const category = item.snapshot.targetCategory;
      const categoryRawId = `category-raw-${item.sourceRecordId}`;
      await client.query(
        `INSERT INTO collect_raw_payloads (
           id,collect_item_id,account_id,source_sku,payload_hash,payload,collected_at
         ) VALUES ($1,$2,$3,$4,$5,'{}'::jsonb,NOW()) ON CONFLICT (id) DO NOTHING`,
        [categoryRawId, item.sourceRecordId, graphInput.accountId, item.snapshot.identity.primarySku,
          crypto.createHash("sha256").update(categoryRawId).digest("hex")],
      );
      await client.query(
        `INSERT INTO product_drafts (
           id,collect_item_id,source_payload_id,version,data_hash,data,normalizer_version,category_rule_version,dictionary_version
         ) VALUES ($1,$2,$3,$4,$5,'{}'::jsonb,$6,$7,$8)
         ON CONFLICT (id) DO NOTHING`,
        [draft.id, item.sourceRecordId, categoryRawId, draft.version, draft.dataHash,
          item.listingBaseTemplate.versions.normalizerVersion,
          item.listingBaseTemplate.versions.categoryRuleVersion,
          item.listingBaseTemplate.versions.dictionaryVersion],
      );
      await client.query(
        "UPDATE collect_items SET current_draft_id=$1 WHERE id=$2 AND account_id=$3",
        [draft.id, item.sourceRecordId, graphInput.accountId],
      );
      await client.query(
        `INSERT INTO collect_ozon_category_source_evidence (
           id,account_id,source_kind,source_record_id,source_version,collect_item_id,product_draft_id,
           source_description_category_id,source_type_id,taxonomy_scope,captured_at,
           raw_response_hash,raw_response_ref,provenance
         ) VALUES ($1,$2,'PRODUCT_DRAFT',$3,$4,$3,$5,$6,$7,$8,NOW(),$9,$10,'{}'::jsonb)
         ON CONFLICT (account_id,id) DO NOTHING`,
        [category.evidenceId, graphInput.accountId, item.sourceRecordId, String(draft.version), draft.id,
          category.sourceDescriptionCategoryId, category.sourceTypeId, category.taxonomyScope,
          crypto.createHash("sha256").update(categoryRawId).digest("hex"), categoryRawId],
      );
      await client.query(
        `INSERT INTO account_ozon_shared_categories (
           id,account_id,source_description_category_id,source_type_id,taxonomy_scope,
           current_description_category_id,current_type_id,status,source,version,
           taxonomy_fingerprint,safe_failure_code,source_evidence_id
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,'ACTIVE',$8,1,NULL,'',$9)
         ON CONFLICT (account_id,source_description_category_id,source_type_id,taxonomy_scope) DO NOTHING`,
        [category.sharedCategoryId, graphInput.accountId, category.sourceDescriptionCategoryId,
          category.sourceTypeId, category.taxonomyScope, category.descriptionCategoryId,
          category.typeId, category.provenance, category.evidenceId],
      );
      await client.query(
        `INSERT INTO collect_ozon_category_current_sources (
           account_id,collect_item_id,source_evidence_id,source_kind,source_record_id,source_version
         ) VALUES ($1,$2,$3,'PRODUCT_DRAFT',$2,$4)
         ON CONFLICT (account_id,collect_item_id) DO NOTHING`,
        [graphInput.accountId, item.sourceRecordId, category.evidenceId, String(draft.version)],
      );
    }
  }
  await client.query(
    `INSERT INTO auto_listing_category_preparation_leases (
       id,account_id,holder_backend_pid,state,acquired_at,expires_at
     ) VALUES ($1,$2,pg_backend_pid(),'ACTIVE',NOW(),NOW()+INTERVAL '1 hour')
     ON CONFLICT (account_id,id) DO NOTHING`,
    [graphInput.categoryPreparationLeaseId, graphInput.accountId],
  );
  for (const item of graphInput.items.filter((entry) => entry.status === "SOURCE_READY")) {
    const category = item.snapshot.targetCategory;
    await client.query(
      `INSERT INTO auto_listing_category_preparation_lease_items (
         account_id,lease_id,collect_item_id,evidence_id,shared_category_id,
         shared_category_version,source_description_category_id,source_type_id,
         description_category_id,type_id,taxonomy_scope,taxonomy_fingerprint,provenance
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (account_id,lease_id,collect_item_id) DO NOTHING`,
      [graphInput.accountId, graphInput.categoryPreparationLeaseId, item.collectItemId || item.sourceRecordId,
        category.evidenceId, category.sharedCategoryId, category.sharedCategoryVersion,
        category.sourceDescriptionCategoryId, category.sourceTypeId, category.descriptionCategoryId,
        category.typeId, category.taxonomyScope, category.taxonomyFingerprint, category.provenance],
    );
  }
}

test("snapshot insertion barrier aborts a waiting peer without an internal rejected promise", async () => {
  const barrier = twoConnectionSnapshotBarrier({
    query: async () => ({ rows: [] }),
    connect: async () => ({ query: async () => ({ rows: [] }), release() {} }),
  }, 100);
  const connection = await barrier.connect();
  const waiting = connection.query("INSERT INTO auto_listing_source_snapshots (id) VALUES ('one')");
  const cause = new Error("pre-barrier worker failed");
  barrier.abort(cause);
  await assert.rejects(waiting, (error) => error === cause);
  barrier.dispose();

  const noParticipant = twoConnectionSnapshotBarrier({ query: async () => ({ rows: [] }), connect: async () => ({}) }, 100);
  noParticipant.abort(new Error("no participants"));
  noParticipant.dispose();
});

test("target evidence barrier rejects independent waiters on abort, timeout, and dispose without hanging participants", async () => {
  const connection = { query: async () => ({ rows: [] }), release() {} };
  const pool = { query: async () => ({ rows: [] }), connect: async () => connection };
  const aborted = twoConnectionTargetEvidenceBarrier(pool, 100);
  const abortCause = new Error("worker failed before target evidence lock");
  aborted.abort(abortCause);
  await assert.rejects(aborted.waitForLock(), (error) => error === abortCause);
  aborted.dispose();

  const timedOut = twoConnectionTargetEvidenceBarrier(pool, 20);
  await assert.rejects(timedOut.waitForLock(), /timed out/);
  timedOut.dispose();

  const participantTimedOut = twoConnectionTargetEvidenceBarrier(pool, 20);
  const timedOutConnection = await participantTimedOut.connect();
  const timedOutQuery = timedOutConnection.query("SELECT * FROM product_stocks ps FOR SHARE OF p,ps");
  await participantTimedOut.waitForLock();
  await assert.rejects(timedOutQuery, /timed out/);
  participantTimedOut.dispose();

  const participantAborted = twoConnectionTargetEvidenceBarrier(pool, 100);
  const abortedConnection = await participantAborted.connect();
  const abortedQuery = abortedConnection.query("SELECT * FROM product_stocks ps FOR SHARE OF p,ps");
  await participantAborted.waitForLock();
  const participantCause = new Error("target evidence worker failed");
  participantAborted.abort(participantCause);
  await assert.rejects(abortedQuery, (error) => error === participantCause);
  participantAborted.dispose();

  const disposed = twoConnectionTargetEvidenceBarrier(pool, 100);
  disposed.dispose();
  await assert.rejects(disposed.waitForLock(), /disposed/);

  const released = twoConnectionTargetEvidenceBarrier(pool, 100);
  const lockedConnection = await released.connect();
  const waiting = lockedConnection.query("SELECT * FROM product_stocks ps FOR SHARE OF p,ps");
  await released.waitForLock();
  released.release();
  await waiting;
  released.dispose();
});

test("lock observer accepts only the mutation backend's marked lock wait", async () => {
  const marker = "auto-listing-task8-observer";
  const rows = [
    { wait_event_type: null, query: `/* ${marker} */ UPDATE warehouses` },
    { wait_event_type: "Lock", query: "UPDATE warehouses" },
    { wait_event_type: "Lock", query: `/* ${marker} */ UPDATE warehouses` },
  ];
  const queries = [];
  const observed = await waitForBackendLock({
    observer: {
      async query(sql, params) {
        queries.push({ sql, params });
        return { rows: [rows.shift()] };
      },
    },
    backendPid: 4242,
    marker,
    timeoutMs: 100,
    pollMs: 1,
  });
  assert.equal(observed.wait_event_type, "Lock");
  assert.match(observed.query, new RegExp(marker));
  assert.equal(queries.length, 3);
  assert.deepEqual(queries[0].params, [4242]);
});

if (!enabled) {
  test("auto listing PostgreSQL integration is explicitly gated to a dedicated migration database", {
    skip: "requires AUTO_LISTING_POSTGRES_TESTS=1 and SONLI_MIGRATION_TEST_DATABASE_URL",
  }, () => {});
} else {
  test("PostgreSQL repository rolls back graphs, scopes replays, preserves snapshots and orders events", { timeout: 20_000 }, async () => {
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: databaseUrl });
    const client = await pool.connect();
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const schema = `auto_listing_task4_${suffix}`;
    const schemaSql = quoteIdentifier(schema);
    const accountA = `account-a-${suffix}`;
    const accountB = `account-b-${suffix}`;
    try {
      await client.query(`CREATE SCHEMA ${schemaSql}`);
      await client.query(`SET search_path TO ${schemaSql}, public`);
      for (const migration of (await readdir(migrationsDir)).filter((file) => /^\d{3}_.+\.sql$/.test(file)).sort()) {
        await client.query(await readFile(path.join(migrationsDir, migration), "utf8"));
      }
      for (const accountId of [accountA, accountB]) {
        await client.query(
          "INSERT INTO accounts (id,username,display_name,role,status) VALUES ($1,$2,$2,'admin','active')",
          [accountId, `user-${accountId}`],
        );
        await client.query(
          `INSERT INTO stores (id,label,company_name,client_id,status,owner_account_id)
           VALUES ($1,$2,$2,$3,'active',$4)`,
          [`store-${accountId}`, `Store ${accountId}`, `client-${accountId}`, accountId],
        );
        await client.query(
          "INSERT INTO store_credentials (store_id,client_id,encrypted_api_key,iv,auth_tag) VALUES ($1,$2,'ciphertext','iv','tag')",
          [`store-${accountId}`, `client-${accountId}`],
        );
        await client.query(
          `INSERT INTO warehouses (id,store_id,warehouse_id,warehouse_type,status,is_active,is_archived)
           VALUES ($1,$2,$3,'FBS','active',TRUE,FALSE)`,
          [`warehouse-${accountId}`, `store-${accountId}`, `platform-${accountId}`],
        );
        await client.query(
          "INSERT INTO products (id,store_id,product_id,sku,status,raw) VALUES ($1,$2,$3,$4,'active','{}'::jsonb)",
          [`product-${accountId}`, `store-${accountId}`, `product-${accountId}`, `sku-${accountId}`],
        );
        await client.query(
          "INSERT INTO product_stocks (product_id,warehouse_id,store_id,source) VALUES ($1,$2,$3,'fbs')",
          [`product-${accountId}`, `warehouse-${accountId}`, `store-${accountId}`],
        );
        await client.query(
          `INSERT INTO ai_content_strategy_versions (id,account_id,strategy_key,version,status,content,content_hash)
           VALUES ($1,$2,$3,1,'PUBLISHED','{}'::jsonb,$4)`,
          [`strategy-version-${accountId}`, accountId, `strategy-${accountId}`, `strategy-hash-${accountId}`],
        );
        await client.query(
          `INSERT INTO auto_listing_upload_policy_versions (
             id,account_id,mode,enabled,version,publication_reason,created_by,published_by,published_at,
             publication_origin,publication_base_url,publication_prefix,publication_version,publication_policy_hash
           ) VALUES ($1,$2,'REVIEW',TRUE,1,'integration review policy',$2,$2,NOW(),$3,$4,$5,$6,$7)`,
          [`upload-policy-${accountId}`, accountId, publicationPolicy.origin, publicationPolicy.baseUrl,
            publicationPolicy.prefix, publicationPolicy.publicationVersion, publicationPolicyHash],
        );
      }
      const scopedPool = {
        async connect() {
          const connection = await pool.connect();
          await connection.query(`SET search_path TO ${schemaSql}, public`);
          return connection;
        },
        async query(sql, params) {
          return client.query(sql, params);
        },
      };
      const repository = createAutoListingRepository({ pool: scopedPool });

      const linkedCollect = `collect-linked-${suffix}`;
      const rawOne = `raw-one-${suffix}`;
      const rawTwo = `raw-two-${suffix}`;
      const linkedDraft = `draft-linked-${suffix}`;
      await client.query(
        `INSERT INTO collect_items (id,account_id,source,identity_key,source_sku,summary)
         VALUES ($1,$2,'test',$3,'sku-linked','{}'::jsonb)`,
        [linkedCollect, accountA, `identity-linked-${suffix}`],
      );
      for (const [id, payloadHash, collectedAt] of [[rawOne, "payload-one", "2026-08-04T00:00:00.000Z"], [rawTwo, "payload-two", "2026-08-05T00:00:00.000Z"]]) {
        await client.query(
          `INSERT INTO collect_raw_payloads (id,collect_item_id,account_id,source_sku,payload_hash,payload,collected_at)
           VALUES ($1,$2,$3,'sku-linked',$4,'{"normalized":{"name":"linked"}}'::jsonb,$5::timestamptz)`,
          [id, linkedCollect, accountA, payloadHash, collectedAt],
        );
      }
      await client.query(
        `INSERT INTO product_drafts (id,collect_item_id,source_payload_id,version,data_hash,data)
         VALUES ($1,$2,$3,7,'draft-hash','{}'::jsonb)`,
        [linkedDraft, linkedCollect, rawOne],
      );
      await client.query("UPDATE collect_items SET current_draft_id=$1 WHERE id=$2 AND account_id=$3", [linkedDraft, linkedCollect, accountA]);
      const linkedCategoryEvidence = `category-evidence-linked-${suffix}`;
      await client.query(
        `INSERT INTO collect_ozon_category_source_evidence (
           id,account_id,source_kind,source_record_id,source_version,collect_item_id,product_draft_id,
           source_description_category_id,source_type_id,taxonomy_scope,captured_at,
           raw_response_hash,raw_response_ref,provenance
         ) VALUES ($1,$2,'PRODUCT_DRAFT',$3,'7',$3,$4,123,456,'OZON:DEFAULT',NOW(),$5,$6,'{}'::jsonb)`,
        [linkedCategoryEvidence, accountA, linkedCollect, linkedDraft,
          crypto.createHash("sha256").update(rawOne).digest("hex"), rawOne],
      );
      await client.query(
        `INSERT INTO account_ozon_shared_categories (
           id,account_id,source_description_category_id,source_type_id,taxonomy_scope,
           current_description_category_id,current_type_id,status,source,version,safe_failure_code,source_evidence_id
         ) VALUES ($1,$2,123,456,'OZON:DEFAULT',123,456,'ACTIVE','SOURCE_DIRECT',1,'',$3)`,
        [`shared-category-${accountA}`, accountA, linkedCategoryEvidence],
      );
      await client.query(
        `INSERT INTO collect_ozon_category_current_sources (
           account_id,collect_item_id,source_evidence_id,source_kind,source_record_id,source_version
         ) VALUES ($1,$2,$3,'PRODUCT_DRAFT',$2,'7')`,
        [accountA, linkedCollect, linkedCategoryEvidence],
      );
      const linked = await repository.loadCollectSources({ accountId: accountA, collectItemIds: [linkedCollect] });
      assert.equal(
        linked[0].sourceVersion,
        "draft:7:payload-one:AUTO_LISTING_SOURCE_SNAPSHOT_V2",
      );
      assert.equal(linked[0].rawResponseRef, rawOne);
      assert.equal(linked[0].rawResponseHash, "payload-one");
      assert.equal(linked[0].rawCollectedAt, "2026-08-04T00:00:00.000Z");

      const bad = graph(accountA, "rollback-key", "rollback", {
        items: [
          graph(accountA, "x", "rollback-one").items[0],
          { ...graph(accountA, "x", "rollback-two").items[0], sourceOrder: 1 },
        ],
      });
      await registerGraphSources(client, bad);
      await client.query(
        `INSERT INTO auto_listing_source_snapshots (
           id,account_id,source_type,source_record_id,source_version,snapshot,snapshot_hash,raw_response_ref
         ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8)`,
        [
          `baseline-conflict-${suffix}`, accountA, bad.items[1].sourceType, bad.items[1].sourceRecordId,
          bad.items[1].sourceVersion, JSON.stringify(bad.items[1].snapshot), "different-existing-hash", bad.items[1].rawResponseRef,
        ],
      );
      const malformed = graph(accountA, "malformed-key", "malformed");
      await registerGraphSources(client, malformed);
      malformed.items[0].snapshot = { identity: { accountId: accountA } };
      await assert.rejects(repository.createJobGraph(malformed), (error) => error?.code === "AUTO_LISTING_REPOSITORY_INVALID");
      await assert.rejects(repository.createJobGraph(bad));
      assert.equal(Number((await client.query("SELECT count(*)::int AS count FROM auto_listing_jobs")).rows[0].count), 0);
      assert.equal(Number((await client.query("SELECT count(*)::int AS count FROM auto_listing_source_snapshots")).rows[0].count), 1);
      assert.equal(Number((await client.query("SELECT count(*)::int AS count FROM auto_listing_events")).rows[0].count), 0);

      const copiedHashCorruption = graph(accountA, "copied-hash-corruption", "copied-hash-corruption");
      await registerGraphSources(client, copiedHashCorruption);
      const corruptBody = structuredClone(copiedHashCorruption.items[0].snapshot);
      corruptBody.identity.brand = "corrupted after hash";
      await client.query(
        `INSERT INTO auto_listing_source_snapshots (
           id,account_id,source_type,source_record_id,source_version,snapshot,snapshot_hash,raw_response_ref
         ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8)`,
        [
          `copied-hash-corruption-${suffix}`, accountA, copiedHashCorruption.items[0].sourceType,
          copiedHashCorruption.items[0].sourceRecordId, copiedHashCorruption.items[0].sourceVersion,
          JSON.stringify(corruptBody), copiedHashCorruption.items[0].snapshotHash, copiedHashCorruption.items[0].rawResponseRef,
        ],
      );
      await assert.rejects(
        repository.createJobGraph(copiedHashCorruption),
        (error) => error?.code === "AUTO_LISTING_SOURCE_VERSION_CONFLICT",
      );
      assert.equal(Number((await client.query(
        "SELECT count(*)::int AS count FROM auto_listing_jobs WHERE account_id=$1 AND idempotency_key='copied-hash-corruption'",
        [accountA],
      )).rows[0].count), 0);
      assert.equal(Number((await client.query(
        "SELECT count(*)::int AS count FROM auto_listing_job_items WHERE account_id=$1",
        [accountA],
      )).rows[0].count), 0);

      const createdInput = graph(accountA, "shared-key", "a");
      const replayInput = graph(accountA, "shared-key", "different-payload");
      const otherInput = graph(accountB, "shared-key", "b");
      await registerGraphSources(client, createdInput);
      await registerGraphSources(client, replayInput);
      await registerGraphSources(client, otherInput);
      const created = await repository.createJobGraph(createdInput);
      const replay = await repository.createJobGraph(replayInput);
      const other = await repository.createJobGraph(otherInput);
      assert.equal(replay.duplicate, true);
      assert.equal(replay.id, created.id);
      assert.notEqual(other.id, created.id);
      assert.equal(Number((await client.query("SELECT count(*)::int AS count FROM auto_listing_jobs")).rows[0].count), 2);

      const mixedSourceBusiness = graph(accountA, "source-business-siblings", "source-business-good");
      const blockedSourceEvidence = buildAutoListingBlockedSourceEvidence({
        accountId: accountA,
        sourceType: "COLLECT_BOX",
        sourceRecordId: `collect-source-business-blocked-${suffix}`,
        sourceVersion: "1",
        productDraft: { id: `draft-source-business-blocked-${suffix}`, version: 1 },
        rawCollectedAt: "2026-08-04T00:00:00.000Z",
        rawResponseRef: `raw-source-business-blocked-${suffix}`,
        rawResponseHash: `hash-source-business-blocked-${suffix}`,
        failureCode: "AUTO_LISTING_SOURCE_CURRENCY_NOT_RUB",
      });
      mixedSourceBusiness.items.push({
        sourceType: "COLLECT_BOX",
        sourceRecordId: blockedSourceEvidence.blockedEvidence.sourceRecordId,
        sourceVersion: "1",
        blockedEvidence: blockedSourceEvidence.blockedEvidence,
        snapshotHash: blockedSourceEvidence.snapshotHash,
        rawResponseRef: blockedSourceEvidence.rawResponseRef,
        targetStoreId: mixedSourceBusiness.configSnapshot.targetStoreId,
        targetWarehouseId: mixedSourceBusiness.configSnapshot.targetWarehouseId,
        sourceOrder: 1,
        status: "BLOCKED",
        failureCode: "AUTO_LISTING_SOURCE_CURRENCY_NOT_RUB",
      });
      await registerGraphSources(client, mixedSourceBusiness);
      const mixedCreated = await repository.createJobGraph(mixedSourceBusiness);
      assert.deepEqual(mixedCreated.items.map((entry) => [entry.status, entry.failureCode || null]), [
        ["SOURCE_READY", null], ["BLOCKED", "AUTO_LISTING_SOURCE_CURRENCY_NOT_RUB"],
      ]);
      const persistedBlockedEvidence = (await client.query(
        "SELECT snapshot,snapshot_hash FROM auto_listing_source_snapshots WHERE account_id=$1 AND source_record_id=$2",
        [accountA, blockedSourceEvidence.blockedEvidence.sourceRecordId],
      )).rows[0];
      assert.deepEqual(persistedBlockedEvidence, {
        snapshot: blockedSourceEvidence.blockedEvidence,
        snapshot_hash: blockedSourceEvidence.snapshotHash,
      });
      assert.doesNotMatch(JSON.stringify(mixedCreated), /raw-source-business-blocked|rawPayload|credential/);

      const item = created.items[0];
      const snapshotBefore = await client.query(
        `SELECT snapshot,snapshot_hash FROM auto_listing_source_snapshots
          WHERE account_id=$1 AND source_record_id='collect-a'`, [accountA],
      );
      await assert.rejects(
        repository.updateItemStatus({ accountId: accountA, itemId: item.id, expectedStatusVersion: 1, eventType: "UPLOAD_SUCCEEDED", actorAccountId: accountA, correlationId: "bad" }),
        (error) => error?.code === "AUTO_LISTING_TRANSITION_FORBIDDEN",
      );
      await repository.updateItemStatus({ accountId: accountA, itemId: item.id, expectedStatusVersion: 1, eventType: "START_PLANNING", actorAccountId: accountA, correlationId: "plan" });
      await assert.rejects(
        repository.updateItemStatus({ accountId: accountA, itemId: item.id, expectedStatusVersion: 1, eventType: "PLAN_READY", actorAccountId: accountA, correlationId: "stale" }),
        (error) => error?.code === "AUTO_LISTING_VERSION_CONFLICT",
      );
      await repository.updateItemStatus({
        accountId: accountA, itemId: item.id, expectedStatusVersion: 2, eventType: "RETRYABLE_FAILURE",
        actorAccountId: accountA, correlationId: "planning-failure", details: { failureCode: "AUTO_LISTING_TRANSIENT" },
      });
      const failureState = (await client.query(
        "SELECT status,status_version,failure_code,recovery_point FROM auto_listing_job_items WHERE id=$1", [item.id],
      )).rows[0];
      assert.deepEqual(failureState, {
        status: "RETRYABLE_ERROR", status_version: 3, failure_code: "AUTO_LISTING_TRANSIENT", recovery_point: "PLANNING",
      });
      assert.deepEqual((await client.query(
        "SELECT transition_version,details FROM auto_listing_events WHERE item_id=$1 AND event_type='RETRYABLE_FAILURE'", [item.id],
      )).rows[0], {
        transition_version: 3,
        details: { failureCode: "AUTO_LISTING_TRANSIENT", recoveryPoint: "PLANNING" },
      });
      const retryEventCount = Number((await client.query(
        "SELECT count(*)::int AS count FROM auto_listing_events WHERE item_id=$1", [item.id],
      )).rows[0].count);
      await assert.rejects(
        repository.updateItemStatus({ accountId: accountA, itemId: item.id, expectedStatusVersion: 3, eventType: "RETRY_GENERATION", actorAccountId: accountA, correlationId: "wrong-retry" }),
        (error) => error?.code === "AUTO_LISTING_TRANSITION_FORBIDDEN",
      );
      assert.equal(Number((await client.query(
        "SELECT count(*)::int AS count FROM auto_listing_events WHERE item_id=$1", [item.id],
      )).rows[0].count), retryEventCount);
      await repository.updateItemStatus({
        accountId: accountA, itemId: item.id, expectedStatusVersion: 3, eventType: "RETRY_PLANNING",
        actorAccountId: accountA, correlationId: "correct-retry",
      });
      assert.deepEqual((await client.query(
        "SELECT status,status_version,failure_code,recovery_point FROM auto_listing_job_items WHERE id=$1", [item.id],
      )).rows[0], {
        status: "PLANNING", status_version: 4, failure_code: null, recovery_point: null,
      });
      const snapshotAfter = await client.query(
        `SELECT snapshot,snapshot_hash FROM auto_listing_source_snapshots
          WHERE account_id=$1 AND source_record_id='collect-a'`, [accountA],
      );
      assert.deepEqual(snapshotAfter.rows, snapshotBefore.rows);
      assert.equal(typeof repository.updateSnapshot, "undefined");

      const scoped = await repository.getJob({ accountId: accountA, jobId: created.id });
      assert.deepEqual(scoped.events.map((event) => event.eventType), [
        "CREATED", "SOURCE_CAPTURED", "START_PLANNING", "RETRYABLE_FAILURE", "RETRY_PLANNING",
      ]);
      assert.equal(await repository.getJob({ accountId: accountB, jobId: created.id }), null);
      assert.deepEqual((await repository.listJobs({ accountId: accountB, limit: 10 })).map((job) => job.id), [other.id]);

      const duplicateEvent = graph(accountA, "duplicate-transition-event", "duplicate-transition-event");
      await registerGraphSources(client, duplicateEvent);
      const duplicateJob = await repository.createJobGraph(duplicateEvent);
      const duplicateItem = duplicateJob.items[0];
      await client.query(
        `INSERT INTO auto_listing_events (
           id,account_id,job_id,item_id,actor_account_id,from_status,to_status,event_type,correlation_id,transition_version,details
         ) VALUES ($1,$2,$3,$4,$5,'SOURCE_READY','PLANNING','TEST_DUPLICATE',$6,2,'{}'::jsonb)`,
        [`duplicate-transition-${suffix}`, accountA, duplicateJob.id, duplicateItem.id, accountA, `duplicate-${suffix}`],
      );
      const duplicateEventCount = Number((await client.query(
        "SELECT count(*)::int AS count FROM auto_listing_events WHERE item_id=$1", [duplicateItem.id],
      )).rows[0].count);
      await assert.rejects(
        repository.updateItemStatus({
          accountId: accountA, itemId: duplicateItem.id, expectedStatusVersion: 1, eventType: "START_PLANNING",
          actorAccountId: accountA, correlationId: "duplicate-transition",
        }),
        (error) => error?.code === "23505",
      );
      assert.deepEqual((await client.query(
        "SELECT status,status_version FROM auto_listing_job_items WHERE id=$1", [duplicateItem.id],
      )).rows[0], { status: "SOURCE_READY", status_version: 1 });
      assert.equal(Number((await client.query(
        "SELECT count(*)::int AS count FROM auto_listing_events WHERE item_id=$1", [duplicateItem.id],
      )).rows[0].count), duplicateEventCount);

      const sharedLeft = graph(accountA, "race-same-left", "race-same");
      const sharedRight = graph(accountA, "race-same-right", "race-same");
      await registerGraphSources(client, sharedLeft);
      const sameHashBarrier = twoConnectionSnapshotBarrier(scopedPool);
      const sameHashRepository = createAutoListingRepository({ pool: sameHashBarrier });
      const sameHashResults = await runBarrierRace(sameHashRepository, sameHashBarrier, [sharedLeft, sharedRight]);
      assert.equal(sameHashResults.every((result) => result.status === "fulfilled"), true);
      const [sharedOne, sharedTwo] = sameHashResults.map((result) => result.value);
      assert.notEqual(sharedOne.id, sharedTwo.id);
      assert.equal(Number((await client.query(
        "SELECT count(*)::int AS count FROM auto_listing_source_snapshots WHERE account_id=$1 AND source_record_id='collect-race-same'",
        [accountA],
      )).rows[0].count), 1);

      const conflictLeft = graph(accountA, "race-conflict-left", "race-conflict");
      const conflictRight = withChangedSourceHash(graph(accountA, "race-conflict-right", "race-conflict"));
      await registerGraphSources(client, conflictLeft);
      const conflictBarrier = twoConnectionSnapshotBarrier(scopedPool);
      const conflictRepository = createAutoListingRepository({ pool: conflictBarrier });
      const conflictResults = await runBarrierRace(conflictRepository, conflictBarrier, [conflictLeft, conflictRight]);
      assert.equal(conflictResults.filter((result) => result.status === "fulfilled").length, 1);
      assert.equal(conflictResults.find((result) => result.status === "rejected")?.reason?.code, "AUTO_LISTING_SOURCE_VERSION_CONFLICT");
      assert.equal(Number((await client.query(
        "SELECT count(*)::int AS count FROM auto_listing_jobs WHERE account_id=$1 AND idempotency_key IN ('race-conflict-left','race-conflict-right')",
        [accountA],
      )).rows[0].count), 1);

      const eventFailure = graph(accountA, "event-failure", "event-failure");
      await registerGraphSources(client, eventFailure);
      const eventJob = await repository.createJobGraph(eventFailure);
      const eventItem = eventJob.items[0];
      await repository.updateItemStatus({
        accountId: accountA, itemId: eventItem.id, expectedStatusVersion: 1, eventType: "START_PLANNING",
        actorAccountId: accountA, correlationId: "event-failure-planning",
      });
      const eventCountBefore = Number((await client.query(
        "SELECT count(*)::int AS count FROM auto_listing_events WHERE item_id=$1", [eventItem.id],
      )).rows[0].count);
      await client.query(`CREATE OR REPLACE FUNCTION ${schemaSql}.fail_task4_status_event()
        RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN
          IF NEW.event_type = 'RETRYABLE_FAILURE' THEN RAISE EXCEPTION 'forced event failure'; END IF;
          RETURN NEW;
        END; $$`);
      await client.query(`CREATE TRIGGER fail_task4_status_event BEFORE INSERT ON auto_listing_events
        FOR EACH ROW EXECUTE FUNCTION ${schemaSql}.fail_task4_status_event()`);
      await assert.rejects(
        repository.updateItemStatus({
          accountId: accountA, itemId: eventItem.id, expectedStatusVersion: 2, eventType: "RETRYABLE_FAILURE",
          actorAccountId: accountA, correlationId: "event-failure", details: { failureCode: "AUTO_LISTING_TRANSIENT" },
        }),
      );
      const afterEventFailure = (await client.query(
        "SELECT status,status_version,failure_code,recovery_point FROM auto_listing_job_items WHERE id=$1", [eventItem.id],
      )).rows[0];
      assert.deepEqual(afterEventFailure, { status: "PLANNING", status_version: 2, failure_code: null, recovery_point: null });
      assert.equal(Number((await client.query(
        "SELECT count(*)::int AS count FROM auto_listing_events WHERE item_id=$1", [eventItem.id],
      )).rows[0].count), eventCountBefore);

      const secondStoreId = `store-second-${accountA}`;
      const secondWarehouseId = `warehouse-second-${accountA}`;
      const secondProductId = `product-second-${accountA}`;
      await client.query(
        `INSERT INTO stores (id,label,company_name,client_id,status,owner_account_id,currency_code)
         VALUES ($1,'Second','Second',$2,'active',$3,'RUB')`,
        [secondStoreId, `client-second-${accountA}`, accountA],
      );
      await client.query(
        "INSERT INTO store_credentials (store_id,client_id,encrypted_api_key,iv,auth_tag) VALUES ($1,$2,'ciphertext','iv','tag')",
        [secondStoreId, `client-second-${accountA}`],
      );
      await client.query(
        `INSERT INTO warehouses (id,store_id,warehouse_id,warehouse_type,status,is_active,is_archived)
         VALUES ($1,$2,$3,'FBS','active',TRUE,FALSE)`,
        [secondWarehouseId, secondStoreId, `platform-${secondWarehouseId}`],
      );
      await client.query(
        "INSERT INTO products (id,store_id,product_id,sku,status,raw) VALUES ($1,$2,$1,$3,'active','{}'::jsonb)",
        [secondProductId, secondStoreId, `sku-${secondProductId}`],
      );
      await client.query(
        "INSERT INTO product_stocks (product_id,warehouse_id,store_id,source) VALUES ($1,$2,$3,'fbs')",
        [secondProductId, secondWarehouseId, secondStoreId],
      );
      const reuseFirst = graph(accountA, "shared-category-store-one", "shared-category-store-reuse");
      await registerGraphSources(client, reuseFirst);
      const reuseFirstJob = await repository.createJobGraph(reuseFirst);
      const reuseSecond = structuredClone(reuseFirst);
      const secondFrozen = normalizeAndHashAutoListingConfig({
        targetStoreId: secondStoreId, targetWarehouseId: secondWarehouseId,
        stock: 1, priceAdjustmentKopecks: "0",
      });
      reuseSecond.idempotencyKey = "shared-category-store-two";
      reuseSecond.configSnapshot = secondFrozen.config;
      reuseSecond.configHash = secondFrozen.configHash;
      reuseSecond.items[0].targetStoreId = secondStoreId;
      reuseSecond.items[0].targetWarehouseId = secondWarehouseId;
      reuseSecond.items[0].effectiveImageConfig = deriveEffectiveAutoListingImageConfig({
        configSnapshot: secondFrozen.config, configHash: secondFrozen.configHash,
        sourceCapture: { snapshot: reuseSecond.items[0].snapshot, snapshotHash: reuseSecond.items[0].snapshotHash },
      });
      const reuseSecondJob = await repository.createJobGraph(reuseSecond);
      assert.notEqual(reuseFirstJob.id, reuseSecondJob.id);
      assert.equal(reuseFirstJob.items[0].sourceHash, reuseSecondJob.items[0].sourceHash);
      assert.equal(Number((await client.query(
        "SELECT count(*)::int AS count FROM auto_listing_source_snapshots WHERE account_id=$1 AND source_record_id=$2",
        [accountA, reuseFirst.items[0].sourceRecordId],
      )).rows[0].count), 1);

      const staleCategory = graph(accountA, "shared-category-stale", "shared-category-stale");
      await registerGraphSources(client, staleCategory);
      const loadedCategory = await repository.loadCollectSources({
        accountId: accountA, collectItemIds: [staleCategory.items[0].sourceRecordId],
      });
      assert.equal(loadedCategory[0].sharedCategory.version, 1);
      assert.equal((await repository.loadCollectSources({
        accountId: accountB, collectItemIds: [staleCategory.items[0].sourceRecordId],
      })).length, 0);

      await client.query(
        `INSERT INTO ai_gateway_profiles
          (id,account_id,display_name,base_url,api_key_env_name,text_protocol,image_protocol,text_model,image_model,config_version)
         VALUES ($1,$2,'Task4','https://gateway.invalid','TASK4_AI_KEY','SUB2API_RESPONSES',
           'SUB2API_OPENAI_IMAGES','text','image',1)`,
        [`profile-task4-${suffix}`, accountA],
      );
      await client.query(
        `UPDATE account_ozon_shared_categories
            SET version=version+1,updated_at=clock_timestamp()
          WHERE account_id=$1 AND id=$2`,
        [accountA, staleCategory.items[0].snapshot.targetCategory.sharedCategoryId],
      );
      await assert.rejects(repository.createJobGraph(staleCategory), {
        code: "AUTO_LISTING_SOURCE_VERSION_CONFLICT",
      });
      assert.equal(Number((await client.query(
        "SELECT count(*)::int AS count FROM auto_listing_jobs WHERE account_id=$1 AND idempotency_key=$2",
        [accountA, staleCategory.idempotencyKey],
      )).rows[0].count), 0);
      assert.equal(Number((await client.query(
        "SELECT count(*)::int AS count FROM auto_listing_source_snapshots WHERE account_id=$1 AND source_record_id=$2",
        [accountA, staleCategory.items[0].sourceRecordId],
      )).rows[0].count), 0);

      const fullServiceRace = graph(accountA, "shared-category-full-service-race", "shared-category-full-service-race");
      await registerGraphSources(client, fullServiceRace);
      const fullServiceRepository = createAutoListingRepository({ pool: scopedPool });
      const counters = { ozonCategory: 0, rfbs: 0, paidAi: 0, objectStorage: 0, graph: 0 };
      let transitioned = false;
      const racedRepository = {
        ...fullServiceRepository,
        async acquireCategoryPreparationLease(input) {
          if (!transitioned) {
            transitioned = true;
            await client.query(
              `UPDATE account_ozon_shared_categories
                  SET version=version+1,updated_at=clock_timestamp()
                WHERE account_id=$1 AND id=$2`,
              [accountA, fullServiceRace.items[0].snapshot.targetCategory.sharedCategoryId],
            );
          }
          return fullServiceRepository.acquireCategoryPreparationLease(input);
        },
        async createJobGraph(input) {
          counters.paidAi += 1;
          counters.objectStorage += 1;
          counters.graph += 1;
          return fullServiceRepository.createJobGraph(input);
        },
      };
      const racedService = createAutoListingService({
        repository: racedRepository,
        async prepareListingBase() {
          counters.ozonCategory += 1;
          throw new Error("Ozon category port must remain unreachable");
        },
        rfbsWarehouseVerifier: Object.freeze({
          async verifyRfbsWarehouse() {
            counters.rfbs += 1;
            throw new Error("RFBS port must remain unreachable");
          },
        }),
      });
      await assert.rejects(racedService.createAutoListingJob({
        actor: { id: accountA, role: "admin" },
        collectItemIds: [fullServiceRace.items[0].sourceRecordId],
        idempotencyKey: fullServiceRace.idempotencyKey,
        correlationId: fullServiceRace.correlationId,
        config: fullServiceRace.configSnapshot,
      }), { code: "AUTO_LISTING_SOURCE_VERSION_CONFLICT" });
      assert.equal(transitioned, true);
      assert.deepEqual(counters, { ozonCategory: 0, rfbs: 0, paidAi: 0, objectStorage: 0, graph: 0 });
      assert.equal(Number((await client.query(
        "SELECT count(*)::int AS count FROM auto_listing_jobs WHERE account_id=$1 AND idempotency_key=$2",
        [accountA, fullServiceRace.idempotencyKey],
      )).rows[0].count), 0);

      await client.query(
        "DELETE FROM product_stocks WHERE store_id=$1 AND warehouse_id=$2",
        [`store-${accountA}`, `warehouse-${accountA}`],
      );
      await client.query(
        "UPDATE warehouses SET warehouse_type='RFBS' WHERE id=$1 AND store_id=$2",
        [`warehouse-${accountA}`, `store-${accountA}`],
      );
      const leaseSource = (await repository.loadCollectSources({
        accountId: accountA, collectItemIds: [fullServiceRace.items[0].sourceRecordId],
      }))[0];
      const leaseItem = {
        collectItemId: leaseSource.id,
        evidenceId: leaseSource.categoryEvidence.id,
        sharedCategoryId: leaseSource.sharedCategory.id,
        sharedCategoryVersion: leaseSource.sharedCategory.version,
        sourceDescriptionCategoryId: leaseSource.categoryEvidence.sourceDescriptionCategoryId,
        sourceTypeId: leaseSource.categoryEvidence.sourceTypeId,
        descriptionCategoryId: leaseSource.sharedCategory.currentDescriptionCategoryId,
        typeId: leaseSource.sharedCategory.currentTypeId,
        taxonomyScope: leaseSource.sharedCategory.taxonomyScope,
        taxonomyFingerprint: leaseSource.sharedCategory.taxonomyFingerprint || "",
        provenance: leaseSource.sharedCategory.source,
      };
      let heldLease;
      let preparationStarted;
      let preparationFailedBeforeStart;
      let finishPreparation;
      const startedPreparation = new Promise((resolve, reject) => {
        preparationStarted = resolve;
        preparationFailedBeforeStart = reject;
      });
      const preparationBarrier = new Promise((resolve) => { finishPreparation = resolve; });
      const leaseFirstCounters = { ozonCategory: 0, rfbs: 0, paidAi: 0, objectStorage: 0, graph: 0 };
      const leaseFirstRepository = {
        ...repository,
        async loadCollectSources(input) {
          const loaded = await repository.loadCollectSources(input);
          return loaded.map((sourceRow) => ({
            ...sourceRow,
            collectItem: {
              ...sourceRow.collectItem,
              sku: fullServiceRace.items[0].snapshot.identity.primarySku,
              listingDraft: {
                sku: fullServiceRace.items[0].snapshot.identity.primarySku,
                offerId: fullServiceRace.items[0].snapshot.identity.primaryOfferId,
                title: "Lease race product",
                currency: "RUB",
                blackKopecks: "10000",
                greenKopecks: "8000",
                images: [],
                variants: [{
                  sku: fullServiceRace.items[0].snapshot.identity.primarySku,
                  offerId: fullServiceRace.items[0].snapshot.identity.primaryOfferId,
                }],
              },
            },
          }));
        },
        async acquireCategoryPreparationLease(input) {
          heldLease = await repository.acquireCategoryPreparationLease(input);
          return heldLease;
        },
        async createJobGraph(input) {
          assert.equal(input.categoryPreparationSignal, heldLease.signal);
          leaseFirstCounters.paidAi += 1;
          leaseFirstCounters.objectStorage += 1;
          leaseFirstCounters.graph += 1;
          return repository.createJobGraph(input);
        },
      };
      const observedAt = new Date().toISOString();
      const expiresAt = new Date(Date.now() + 600_000).toISOString();
      const rfbsEvidenceBody = {
        schemaVersion: "AUTO_LISTING_RFBS_WAREHOUSE_EVIDENCE_V1",
        accountId: accountA,
        storeId: `store-${accountA}`,
        warehouseRecordId: `warehouse-${accountA}`,
        platformWarehouseId: `platform-${accountA}`,
        fulfillmentType: "RFBS",
        status: "ACTIVE",
        outcome: "PASSED",
        observedAt,
        expiresAt,
        correlationId: fullServiceRace.correlationId,
        actorAccountId: accountA,
      };
      const leaseFirstService = createAutoListingService({
        repository: leaseFirstRepository,
        async prepareListingBase({ signal }) {
          assert.equal(signal, heldLease.signal);
          leaseFirstCounters.ozonCategory += 1;
          preparationStarted();
          await preparationBarrier;
          return fullServiceRace.items[0].listingBaseTemplate;
        },
        rfbsWarehouseVerifier: Object.freeze({
          async verifyRfbsWarehouse({ signal }) {
            assert.equal(signal, heldLease.signal);
            leaseFirstCounters.rfbs += 1;
            return Object.freeze({
              ...rfbsEvidenceBody,
              evidenceHash: crypto.createHash("sha256")
                .update(JSON.stringify(rfbsEvidenceBody)).digest("hex"),
            });
          },
        }),
      });
      const serviceCreation = leaseFirstService.createAutoListingJob({
        actor: { id: accountA, role: "admin" },
        collectItemIds: [fullServiceRace.items[0].sourceRecordId],
        idempotencyKey: `${fullServiceRace.idempotencyKey}-lease-first`,
        correlationId: fullServiceRace.correlationId,
        config: fullServiceRace.configSnapshot,
      });
      serviceCreation.catch(preparationFailedBeforeStart);
      await startedPreparation;
      const transitionClient = await pool.connect();
      const transitionObserver = await pool.connect();
      let transition;
      try {
        await transitionClient.query(`SET search_path TO ${schemaSql}, public`);
        const transitionPid = Number((await transitionClient.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
        const marker = `auto-listing-category-lease-transition-${suffix}`;
        transition = transitionClient.query(
          `/* ${marker} */ UPDATE account_ozon_shared_categories
              SET version=version+1,updated_at=updated_at+INTERVAL '1 millisecond'
            WHERE account_id=$1 AND id=$2`,
          [accountA, leaseItem.sharedCategoryId],
        );
        transition.catch(() => {});
        await waitForBackendLock({ observer: transitionObserver, backendPid: transitionPid, marker });
        assert.deepEqual(leaseFirstCounters,
          { ozonCategory: 1, rfbs: 0, paidAi: 0, objectStorage: 0, graph: 0 });
        assert.equal((await client.query(
          "SELECT state FROM auto_listing_category_preparation_leases WHERE account_id=$1 AND id=$2",
          [accountA, heldLease.leaseId],
        )).rows[0].state, "ACTIVE");
        finishPreparation();
        await serviceCreation;
        await transition;
      } finally {
        finishPreparation();
        await serviceCreation.catch(() => {});
        await transition?.catch(() => {});
        transitionObserver.release();
        transitionClient.release();
      }
      assert.deepEqual(leaseFirstCounters,
        { ozonCategory: 1, rfbs: 1, paidAi: 1, objectStorage: 1, graph: 1 });
      assert.deepEqual((await client.query(
        "SELECT state,outcome FROM auto_listing_category_preparation_leases WHERE account_id=$1 AND id=$2",
        [accountA, heldLease.leaseId],
      )).rows[0], { state: "RELEASED", outcome: "COMMITTED" });

      const expiringSource = (await repository.loadCollectSources({
        accountId: accountA, collectItemIds: [fullServiceRace.items[0].sourceRecordId],
      }))[0];
      const expiringItem = { ...leaseItem, sharedCategoryVersion: expiringSource.sharedCategory.version };
      const expiringRepository = createAutoListingRepository({
        pool: scopedPool, categoryLeaseHoldTimeoutMs: 1_000,
      });
      const expiringLease = await expiringRepository.acquireCategoryPreparationLease({
        accountId: accountA, items: [expiringItem],
      });
      const expiryTransitionClient = await pool.connect();
      const expiryObserver = await pool.connect();
      let expiryTransition;
      try {
        await expiryTransitionClient.query(`SET search_path TO ${schemaSql}, public`);
        const expiryTransitionPid = Number((await expiryTransitionClient.query(
          "SELECT pg_backend_pid() AS pid",
        )).rows[0].pid);
        const expiryMarker = `auto-listing-category-expiry-transition-${suffix}`;
        expiryTransition = expiryTransitionClient.query(
          `/* ${expiryMarker} */ UPDATE account_ozon_shared_categories
              SET version=version+1,updated_at=updated_at+INTERVAL '1 millisecond'
            WHERE account_id=$1 AND id=$2`,
          [accountA, expiringItem.sharedCategoryId],
        );
        expiryTransition.catch(() => {});
        await waitForBackendLock({
          observer: expiryObserver, backendPid: expiryTransitionPid, marker: expiryMarker,
        });
        await new Promise((resolve) => {
          if (expiringLease.signal.aborted) resolve();
          else expiringLease.signal.addEventListener("abort", resolve, { once: true });
        });
        await waitForBackendLock({
          observer: expiryObserver, backendPid: expiryTransitionPid, marker: expiryMarker,
        });
        await expiringRepository.releaseCategoryPreparationLease({
          accountId: accountA, leaseId: expiringLease.leaseId, outcome: "TIMEOUT",
        });
        await expiryTransition;
      } finally {
        await expiryTransition?.catch(() => {});
        expiryObserver.release();
        expiryTransitionClient.release();
      }
      assert.deepEqual((await client.query(
        "SELECT state,outcome FROM auto_listing_category_preparation_leases WHERE account_id=$1 AND id=$2",
        [accountA, expiringLease.leaseId],
      )).rows[0], { state: "EXPIRED", outcome: "TIMEOUT" });

      const crashSource = (await repository.loadCollectSources({
        accountId: accountA, collectItemIds: [fullServiceRace.items[0].sourceRecordId],
      }))[0];
      const crashItem = { ...leaseItem,
        sharedCategoryVersion: crashSource.sharedCategory.version,
      };
      const crashLease = await repository.acquireCategoryPreparationLease({
        accountId: accountA, items: [crashItem],
      });
      const crashPid = Number((await client.query(
        "SELECT holder_backend_pid FROM auto_listing_category_preparation_leases WHERE account_id=$1 AND id=$2",
        [accountA, crashLease.leaseId],
      )).rows[0].holder_backend_pid);
      await client.query("SELECT pg_terminate_backend($1)", [crashPid]);
      await client.query(
        `UPDATE account_ozon_shared_categories
            SET version=version+1,updated_at=updated_at+INTERVAL '1 millisecond'
          WHERE account_id=$1 AND id=$2`,
        [accountA, crashItem.sharedCategoryId],
      );
      await repository.recoverCategoryPreparationLeases({ accountId: accountA });
      assert.equal((await client.query(
        "SELECT state FROM auto_listing_category_preparation_leases WHERE account_id=$1 AND id=$2",
        [accountA, crashLease.leaseId],
      )).rows[0].state, "ORPHANED");
    } finally {
      await client.query("RESET search_path").catch(() => {});
      await client.query(`DROP SCHEMA IF EXISTS ${schemaSql} CASCADE`).catch(() => {});
      client.release();
      await pool.end();
    }
  });

  test("PostgreSQL target evidence locks invalidating warehouse and stock writes until a job commits", { timeout: 20_000 }, async () => {
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: databaseUrl });
    const client = await pool.connect();
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const schema = `auto_listing_task8_${suffix}`;
    const schemaSql = quoteIdentifier(schema);
    const accountId = `account-task8-${suffix}`;
    const storeId = `store-${accountId}`;
    const warehouseId = `warehouse-${accountId}`;
    const productId = `product-${accountId}`;
    const scopedPool = {
      async connect() {
        const connection = await pool.connect();
        await connection.query(`SET search_path TO ${schemaSql}, public`);
        return connection;
      },
      async query(sql, params) {
        return client.query(sql, params);
      },
    };
    try {
      await client.query(`CREATE SCHEMA ${schemaSql}`);
      await client.query(`SET search_path TO ${schemaSql}, public`);
      for (const migration of (await readdir(migrationsDir)).filter((file) => /^\d{3}_.+\.sql$/.test(file)).sort()) {
        await client.query(await readFile(path.join(migrationsDir, migration), "utf8"));
      }
      await client.query(
        "INSERT INTO accounts (id,username,display_name,role,status) VALUES ($1,$2,$2,'admin','active')",
        [accountId, `user-${accountId}`],
      );
      await client.query(
        "INSERT INTO stores (id,label,company_name,client_id,status,owner_account_id) VALUES ($1,$2,$2,$3,'active',$4)",
        [storeId, `Store ${accountId}`, `client-${accountId}`, accountId],
      );
      await client.query(
        "INSERT INTO store_credentials (store_id,client_id,encrypted_api_key,iv,auth_tag) VALUES ($1,$2,'ciphertext','iv','tag')",
        [storeId, `client-${accountId}`],
      );
      await client.query(
        "INSERT INTO warehouses (id,store_id,warehouse_id,warehouse_type,status,is_active,is_archived) VALUES ($1,$2,$3,'FBS','active',TRUE,FALSE)",
        [warehouseId, storeId, `platform-${accountId}`],
      );
      await client.query(
        "INSERT INTO products (id,store_id,product_id,sku,status,raw) VALUES ($1,$2,$3,$4,'active','{}'::jsonb)",
        [productId, storeId, productId, `sku-${accountId}`],
      );
      await client.query(
        "INSERT INTO product_stocks (product_id,warehouse_id,store_id,source) VALUES ($1,$2,$3,'fbs')",
        [productId, warehouseId, storeId],
      );
      await client.query(
        "INSERT INTO ai_content_strategy_versions (id,account_id,strategy_key,version,status,content,content_hash) VALUES ($1,$2,$3,1,'PUBLISHED','{}'::jsonb,$4)",
        [`strategy-version-${accountId}`, accountId, `strategy-${accountId}`, `strategy-hash-${accountId}`],
      );
      await client.query(
        `INSERT INTO auto_listing_upload_policy_versions (
           id,account_id,mode,enabled,version,publication_reason,created_by,published_by,published_at,
           publication_origin,publication_base_url,publication_prefix,publication_version,publication_policy_hash
         ) VALUES ($1,$2,'REVIEW',TRUE,1,'integration review policy',$2,$2,NOW(),$3,$4,$5,$6,$7)`,
        [`upload-policy-${accountId}`, accountId, publicationPolicy.origin, publicationPolicy.baseUrl,
          publicationPolicy.prefix, publicationPolicy.publicationVersion, publicationPolicyHash],
      );

      const runInvalidationRace = async ({ suffix: graphSuffix, sql, params }) => {
        const input = graph(accountId, `task8-${graphSuffix}`, graphSuffix);
        await registerGraphSources(client, input);
        const barrier = twoConnectionTargetEvidenceBarrier(scopedPool);
        const repository = createAutoListingRepository({ pool: barrier });
        const invalidator = await pool.connect();
        let observer;
        let creation;
        let invalidating;
        try {
          observer = await pool.connect();
          await invalidator.query(`SET search_path TO ${schemaSql}, public`);
          const backendPid = Number((await invalidator.query("SELECT pg_backend_pid() AS pid")).rows[0]?.pid);
          const marker = `auto-listing-task8-${suffix}-${graphSuffix}`;
          creation = repository.createJobGraph(input);
          creation.catch(() => {});
          await barrier.waitForLock();
          invalidating = invalidator.query(`/* ${marker} */ ${sql}`, params);
          invalidating.catch(() => {});
          await waitForBackendLock({ observer, backendPid, marker });
          barrier.release();
          const created = await creation;
          await invalidating;
          return created;
        } finally {
          barrier.abort(new Error("target evidence race cleanup"));
          await creation?.catch(() => {});
          await invalidating?.catch(() => {});
          await invalidator.query("ROLLBACK").catch(() => {});
          observer?.release();
          invalidator.release();
        }
      };

      const warehouseJob = await runInvalidationRace({
        suffix: "warehouse-update",
        sql: "UPDATE warehouses SET is_active=FALSE WHERE id=$1 AND store_id=$2",
        params: [warehouseId, storeId],
      });
      assert.ok(warehouseJob.id);
      assert.equal((await client.query("SELECT is_active FROM warehouses WHERE id=$1", [warehouseId])).rows[0].is_active, false);
      await client.query("UPDATE warehouses SET is_active=TRUE WHERE id=$1", [warehouseId]);

      const stockJob = await runInvalidationRace({
        suffix: "stock-delete",
        sql: "DELETE FROM product_stocks WHERE product_id=$1 AND warehouse_id=$2 AND store_id=$3 AND source='fbs'",
        params: [productId, warehouseId, storeId],
      });
      assert.ok(stockJob.id);
      assert.equal(Number((await client.query(
        "SELECT count(*)::int AS count FROM product_stocks WHERE product_id=$1 AND warehouse_id=$2", [productId, warehouseId],
      )).rows[0].count), 0);

      const invalidFirst = graph(accountId, "task8-invalid-first", "invalid-first");
      await registerGraphSources(client, invalidFirst);
      await assert.rejects(
        createAutoListingRepository({ pool: scopedPool }).createJobGraph(invalidFirst),
        (error) => error?.code === "LISTING_WAREHOUSE_NOT_ELIGIBLE",
      );
      assert.equal(Number((await client.query(
        "SELECT count(*)::int AS count FROM auto_listing_jobs WHERE account_id=$1", [accountId],
      )).rows[0].count), 2);
    } finally {
      await client.query("RESET search_path").catch(() => {});
      await client.query(`DROP SCHEMA IF EXISTS ${schemaSql} CASCADE`).catch(() => {});
      client.release();
      await pool.end();
    }
  });
}
