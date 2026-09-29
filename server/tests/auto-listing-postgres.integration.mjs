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

function exactCategoryStrategyRule(ruleId) {
  const roleGuidance = Object.fromEntries([
    "MAIN", "SELLING_POINT", "DETAIL", "SCENE", "SPECIFICATION", "INFOGRAPHIC",
  ].map((role) => [role, { composition: `composition-${role}`, background: `background-${role}`,
    textDensity: role === "MAIN" ? "NONE" : "LIGHT", layout: `layout-${role}` }]));
  return { ruleId, matchType: "EXACT_CATEGORY_TYPE_V2",
    scope: { taxonomyScope: "OZON:DEFAULT", descriptionCategoryId: 123, typeId: 456 },
    overallStyle: "exact integration strategy", prohibitedPatterns: [], roleGuidance,
    sampleSetHash: "a".repeat(64), analysisAttemptId: `attempt-${ruleId}`, analysisResultId: `result-${ruleId}` };
}

function withExactCategoryStrategy(input, { strategyVersionId, ruleId, policyVersion }) {
  input.strategyVersionId = strategyVersionId;
  input.categoryStrategyGate = { mode: "REQUIRE_EXACT_STRATEGY", policyVersion,
    scopes: [{ taxonomyScope: "OZON:DEFAULT", descriptionCategoryId: 123, typeId: 456, ruleId }] };
  for (const item of input.items) {
    if (item.status !== "SOURCE_READY") continue;
    item.strategyId = "default";
    item.strategyVersionId = strategyVersionId;
    item.ruleId = ruleId;
    item.style = "BALANCED_DEFAULT";
    item.matchedBy = "EXACT_CATEGORY_TYPE_V2";
  }
  return input;
}

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
    image: { roles: { main: 1, sellingPoint: 3, detail: 1, scene: 1, specification: 0, infographic: 1 }, total: 7 },
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
        productMeasurements: { reliable: true, length: 20, width: 10, height: 5, unit: "cm", source: "test" },
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
      sourceOrder: 1,
      status: "SOURCE_READY",
      planningContract: "LEGACY_FULL_PLAN_V3",
      strategyId: "default",
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

function bindGraphToSharedVersion(input, version) {
  const item = input.items[0];
  item.snapshot.targetCategory.sharedCategoryVersion = version;
  item.snapshotHash = crypto.createHash("sha256")
    .update(canonicalAutoListingSourceSnapshot(item.snapshot)).digest("hex");
  item.effectiveImageConfig = deriveEffectiveAutoListingImageConfig({
    configSnapshot: input.configSnapshot,
    configHash: input.configHash,
    sourceCapture: { snapshot: item.snapshot, snapshotHash: item.snapshotHash },
  });
  return input;
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

function categoryGraphFenceBarrier(scopedPool, timeoutMs = 5_000) {
  let reached = false;
  let settled = false;
  let resolveReached;
  let rejectReached;
  let resolveProceed;
  const fenceReached = new Promise((resolve, reject) => {
    resolveReached = resolve;
    rejectReached = reject;
  });
  fenceReached.catch(() => {});
  const proceed = new Promise((resolve) => { resolveProceed = resolve; });
  const timeout = setTimeout(() => {
    if (settled) return;
    settled = true;
    const failure = new Error(`category graph fence barrier timed out after ${timeoutMs}ms`);
    if (!reached) rejectReached(failure);
    resolveProceed();
  }, timeoutMs);
  return {
    query: (...args) => scopedPool.query(...args),
    waitForFence: () => fenceReached,
    release() {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolveProceed();
    },
    async connect() {
      const connection = await scopedPool.connect();
      return {
        async query(sql, params) {
          const result = await connection.query(sql, params);
          if (!reached && /auto-listing-shared-category-fence/u.test(sql)) {
            reached = true;
            resolveReached();
            await proceed;
          }
          return result;
        },
        release: (error) => connection.release(error),
        on: (...args) => connection.on?.(...args),
        off: (...args) => connection.off?.(...args),
      };
    },
  };
}

function twoConnectionJobReplayBarrier(scopedPool, timeoutMs = 5_000) {
  let arrivals = 0;
  let settled = false;
  let rejectArrival;
  let resolveArrival;
  let resolveProceed;
  const bothArrived = new Promise((resolve, reject) => {
    resolveArrival = resolve;
    rejectArrival = reject;
  });
  bothArrived.catch(() => {});
  const proceed = new Promise((resolve) => { resolveProceed = resolve; });
  const timeout = setTimeout(() => {
    if (settled) return;
    settled = true;
    rejectArrival(new Error(`job replay barrier timed out after ${timeoutMs}ms (arrivals=${arrivals})`));
    resolveProceed();
  }, timeoutMs);
  return {
    query: (...args) => scopedPool.query(...args),
    waitForBoth: () => bothArrived,
    release() {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolveProceed();
    },
    async connect() {
      const connection = await scopedPool.connect();
      return {
        async query(sql, params) {
          const result = await connection.query(sql, params);
          if (/SELECT id FROM auto_listing_jobs WHERE account_id=\$1 AND idempotency_key=\$2 FOR UPDATE/u.test(sql)) {
            arrivals += 1;
            if (arrivals === 2) resolveArrival();
            await proceed;
          }
          return result;
        },
        release: (error) => connection.release(error),
        on: (...args) => connection.on?.(...args),
        off: (...args) => connection.off?.(...args),
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
       id,account_id,holder_backend_pid,holder_backend_started_at,state,acquired_at,expires_at
     ) VALUES ($1,$2,pg_backend_pid(),
       (SELECT backend_start FROM pg_stat_activity WHERE pid=pg_backend_pid()),
       'ACTIVE',NOW(),NOW()+INTERVAL '1 hour')
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
  test("PostgreSQL 067 safely repairs an old COMMITTED lease without a job binding", { timeout: 20_000 }, async () => {
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: databaseUrl });
    const client = await pool.connect();
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const schemaSql = quoteIdentifier(`auto_listing_task4_067_upgrade_${suffix}`);
    try {
      await client.query(`CREATE SCHEMA ${schemaSql}`);
      await client.query(`SET search_path TO ${schemaSql}, public`);
      const migrations = (await readdir(migrationsDir))
        .filter((file) => /^\d{3}_.+\.sql$/u.test(file) && file < "067_").sort();
      for (const migration of migrations) {
        await client.query(await readFile(path.join(migrationsDir, migration), "utf8"));
      }
      const accountId = `account-upgrade-${suffix}`;
      await client.query(
        "INSERT INTO accounts (id,username,display_name,role,status) VALUES ($1,$2,$2,'admin','active')",
        [accountId, `user-${accountId}`],
      );
      await client.query(
        `INSERT INTO auto_listing_category_preparation_leases (
           id,account_id,holder_backend_pid,holder_backend_started_at,state,
           acquired_at,expires_at,released_at,outcome
         ) VALUES ('old-response-loss',$1,pg_backend_pid(),
           (SELECT backend_start FROM pg_stat_activity WHERE pid=pg_backend_pid()),
           'RELEASED',NOW()-INTERVAL '2 minutes',NOW()-INTERVAL '1 minute',NOW(),'COMMITTED')`,
        [accountId],
      );
      await client.query(await readFile(
        path.join(migrationsDir, "067_auto_listing_category_lease_replay.sql"), "utf8",
      ));
      assert.deepEqual((await client.query(
        `SELECT state,outcome,finalized_job_id,replayed_job_id
           FROM auto_listing_category_preparation_leases WHERE account_id=$1 AND id='old-response-loss'`,
        [accountId],
      )).rows[0], { state: "RELEASED", outcome: "FAILED", finalized_job_id: null, replayed_job_id: null });
    } finally {
      await client.query("RESET search_path").catch(() => {});
      await client.query(`DROP SCHEMA IF EXISTS ${schemaSql} CASCADE`).catch(() => {});
      client.release();
      await pool.end();
    }
  });

  test("PostgreSQL 067 accepts only provably exact historical lease and job bindings", { timeout: 60_000 }, async () => {
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: databaseUrl });
    const client = await pool.connect();
    const migration067 = await readFile(
      path.join(migrationsDir, "067_auto_listing_category_lease_replay.sql"), "utf8",
    );
    const baseMigrations = (await readdir(migrationsDir))
      .filter((file) => /^\d{3}_.+\.sql$/u.test(file) && file < "067_").sort();
    const cases = [
      {
        name: "exact",
        leases: [{ id: "lease-a", finalizedJobId: "job-a" }],
        jobs: [{ id: "job-a", leaseId: "lease-a" }],
        accepted: true,
      },
      {
        name: "lease-to-job-only",
        leases: [{ id: "lease-a", finalizedJobId: "job-a" }],
        jobs: [{ id: "job-a", leaseId: null }],
      },
      {
        name: "lease-points-job-owned-by-other-lease",
        leases: [
          { id: "lease-a", finalizedJobId: "job-a" },
          { id: "lease-b", finalizedJobId: "job-a" },
        ],
        jobs: [{ id: "job-a", leaseId: "lease-b" }],
      },
      {
        name: "job-to-lease-only",
        leases: [{ id: "lease-a", finalizedJobId: null }],
        jobs: [{ id: "job-a", leaseId: "lease-a" }],
      },
      {
        name: "multiple-finalizing-candidates",
        leases: [
          { id: "lease-a", finalizedJobId: "job-a" },
          { id: "lease-b", finalizedJobId: "job-a" },
        ],
        jobs: [{ id: "job-a", leaseId: null }],
      },
    ];
    try {
      for (const [fixtureIndex, fixture] of cases.entries()) {
        const suffix = crypto.randomUUID().replaceAll("-", "");
        const schemaSql = quoteIdentifier(`auto_listing_task4_067_${fixtureIndex}_${suffix}`);
        const accountId = `account-${fixture.name}-${suffix}`;
        try {
          await client.query(`CREATE SCHEMA ${schemaSql}`);
          await client.query(`SET search_path TO ${schemaSql}, public`);
          for (const migration of baseMigrations) {
            await client.query(await readFile(path.join(migrationsDir, migration), "utf8"));
          }
          await client.query(
            "INSERT INTO accounts (id,username,display_name,role,status) VALUES ($1,$2,$2,'admin','active')",
            [accountId, `user-${accountId}`],
          );
          for (const lease of fixture.leases) {
            await client.query(
              `INSERT INTO auto_listing_category_preparation_leases (
                 id,account_id,holder_backend_pid,holder_backend_started_at,state,acquired_at,expires_at
               ) VALUES ($1,$2,pg_backend_pid(),
                 (SELECT backend_start FROM pg_stat_activity WHERE pid=pg_backend_pid()),
                 'ACTIVE',NOW(),NOW()+INTERVAL '1 hour')`,
              [lease.id, accountId],
            );
          }
          await client.query("ALTER TABLE auto_listing_jobs DISABLE TRIGGER auto_listing_jobs_category_handoff_commit_guard");
          for (const job of fixture.jobs) {
            await client.query(
              `INSERT INTO auto_listing_jobs (
                 id,account_id,source_type,status,idempotency_key,config_snapshot,config_hash,
                 correlation_id,category_preparation_lease_id
               ) VALUES ($1,$2,'COLLECT_BOX','CREATED',$1,'{}'::jsonb,$3,'067-upgrade',$4)`,
              [job.id, accountId, "a".repeat(64), job.leaseId],
            );
          }
          await client.query("ALTER TABLE auto_listing_jobs ENABLE TRIGGER auto_listing_jobs_category_handoff_commit_guard");
          for (const lease of fixture.leases.filter((entry) => entry.finalizedJobId)) {
            await client.query(
              `UPDATE auto_listing_category_preparation_leases
                  SET state='RELEASED',outcome='COMMITTED',finalized_job_id=$3,
                      released_at=clock_timestamp(),updated_at=clock_timestamp()
                WHERE account_id=$1 AND id=$2`,
              [accountId, lease.id, lease.finalizedJobId],
            );
          }
          const before = (await client.query(
            `SELECT id,state,outcome,finalized_job_id FROM auto_listing_category_preparation_leases
              WHERE account_id=$1 ORDER BY id`, [accountId],
          )).rows;
          const jobsBefore = (await client.query(
            `SELECT id,category_preparation_lease_id FROM auto_listing_jobs
              WHERE account_id=$1 ORDER BY id`, [accountId],
          )).rows;
          let migrationError = null;
          await client.query("BEGIN");
          try {
            await client.query(migration067);
            await client.query("COMMIT");
          } catch (error) {
            migrationError = error;
            await client.query("ROLLBACK");
          }
          if (fixture.accepted) {
            assert.equal(migrationError, null, fixture.name);
            assert.equal(Number((await client.query(
              `SELECT count(*)::int AS count
                 FROM auto_listing_category_preparation_leases lease
                 FULL JOIN auto_listing_jobs job
                   ON job.account_id=lease.account_id
                  AND job.id=lease.finalized_job_id
                  AND job.category_preparation_lease_id=lease.id
                WHERE COALESCE(lease.account_id,job.account_id)=$1
                  AND ((lease.outcome='COMMITTED' AND job.id IS NULL)
                    OR (job.category_preparation_lease_id IS NOT NULL AND lease.id IS NULL))`,
              [accountId],
            )).rows[0].count), 0);
          } else {
            assert.equal(migrationError?.code, "23514", fixture.name);
            assert.match(String(migrationError?.message), /historical category lease\/job binding requires manual repair/u);
            assert.equal(Number((await client.query(
              `SELECT count(*)::int AS count FROM information_schema.columns
                WHERE table_schema=current_schema() AND table_name='auto_listing_category_preparation_leases'
                  AND column_name='replayed_job_id'`,
            )).rows[0].count), 0, `${fixture.name}: migration must roll back DDL`);
            assert.deepEqual((await client.query(
              `SELECT id,state,outcome,finalized_job_id FROM auto_listing_category_preparation_leases
                WHERE account_id=$1 ORDER BY id`, [accountId],
            )).rows, before, `${fixture.name}: migration failure must leave audit rows intact`);
            assert.deepEqual((await client.query(
              `SELECT id,category_preparation_lease_id FROM auto_listing_jobs
                WHERE account_id=$1 ORDER BY id`, [accountId],
            )).rows, jobsBefore, `${fixture.name}: migration failure must leave jobs intact`);
          }
        } finally {
          await client.query("ROLLBACK").catch(() => {});
          await client.query("RESET search_path").catch(() => {});
          await client.query(`DROP SCHEMA IF EXISTS ${schemaSql} CASCADE`).catch(() => {});
        }
      }
    } finally {
      client.release();
      await pool.end();
    }
  });

  test("PostgreSQL repository rolls back graphs and exact category gate drift, then freezes continuation evidence", { timeout: 30_000 }, async () => {
    const { Pool, Client } = await import("pg");
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
          `INSERT INTO stores (id,label,company_name,client_id,status,owner_account_id,
             currency_code,currency_source,currency_synced_at)
           VALUES ($1,$2,$2,$3,'active',$4,'RUB','OZON_SELLER_INFO',STATEMENT_TIMESTAMP())`,
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
          [`strategy-version-${accountId}`, accountId, "default", `strategy-hash-${accountId}`],
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
        `draft:7:payload-one:category:shared-category-${accountA}:1:AUTO_LISTING_SOURCE_SNAPSHOT_V3`,
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
        sourceOrder: 2,
        status: "BLOCKED",
        planningContract: "LEGACY_FULL_PLAN_V3",
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

      const listOldInput = graph(accountA, "latest-list-old", "latest-list-source");
      const listNewInput = graph(accountA, "latest-list-new", "latest-list-source");
      listNewInput.categoryPreparationLeaseId = `category-lease-latest-list-new-${suffix}`;
      await registerGraphSources(client, listOldInput);
      await registerGraphSources(client, listNewInput);
      const listOld = await repository.createJobGraph(listOldInput);
      const listNew = await repository.createJobGraph(listNewInput);
      await client.query(
        "UPDATE auto_listing_jobs SET created_at='2099-01-01T00:00:00Z' WHERE account_id=$1 AND id=$2",
        [accountA, listOld.id],
      );
      await client.query(
        "UPDATE auto_listing_jobs SET created_at='2100-01-01T00:00:00Z' WHERE account_id=$1 AND id=$2",
        [accountA, listNew.id],
      );
      const latestVisible = await repository.listJobs({ accountId: accountA, limit: 1 });
      assert.deepEqual(latestVisible.map((job) => [job.id, job.items.map((entry) => entry.sourceRecordId)]), [
        [listNew.id, ["collect-latest-list-source"]],
      ], "ranking must remove the old same-source/store item before the visible-row limit");
      assert.equal((await repository.getJob({ accountId: accountA, jobId: listOld.id })).id, listOld.id,
        "historical getJob remains available after ordinary-list collapse");
      assert.equal(Number((await client.query(
        "SELECT count(*)::int AS count FROM auto_listing_jobs WHERE account_id=$1 AND id IN ($2,$3)",
        [accountA, listOld.id, listNew.id],
      )).rows[0].count), 2, "ordinary-list collapse must not delete history");

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
      sharedRight.categoryPreparationLeaseId = `category-lease-race-same-right-${suffix}`;
      await registerGraphSources(client, sharedLeft);
      await registerGraphSources(client, sharedRight);
      const sameHashRepository = createAutoListingRepository({ pool: scopedPool });
      const sameHashResults = await Promise.allSettled([
        sameHashRepository.createJobGraph(sharedLeft), sameHashRepository.createJobGraph(sharedRight),
      ]);
      assert.equal(sameHashResults.every((result) => result.status === "fulfilled"), true);
      const [sharedOne, sharedTwo] = sameHashResults.map((result) => result.value);
      assert.notEqual(sharedOne.id, sharedTwo.id);
      assert.equal(Number((await client.query(
        "SELECT count(*)::int AS count FROM auto_listing_source_snapshots WHERE account_id=$1 AND source_record_id='collect-race-same'",
        [accountA],
      )).rows[0].count), 1);

      const replayRace = graph(accountA, "race-same-idempotency", "race-same-idempotency");
      await registerGraphSources(client, replayRace);
      const replayRaceSource = (await repository.loadCollectSources({
        accountId: accountA, collectItemIds: [replayRace.items[0].sourceRecordId],
      }))[0];
      bindGraphToSharedVersion(replayRace, replayRaceSource.sharedCategory.version);
      const replayLeaseItem = {
        collectItemId: replayRaceSource.id,
        evidenceId: replayRaceSource.categoryEvidence.id,
        sharedCategoryId: replayRaceSource.sharedCategory.id,
        sharedCategoryVersion: replayRaceSource.sharedCategory.version,
        sourceDescriptionCategoryId: replayRaceSource.categoryEvidence.sourceDescriptionCategoryId,
        sourceTypeId: replayRaceSource.categoryEvidence.sourceTypeId,
        descriptionCategoryId: replayRaceSource.sharedCategory.currentDescriptionCategoryId,
        typeId: replayRaceSource.sharedCategory.currentTypeId,
        taxonomyScope: replayRaceSource.sharedCategory.taxonomyScope,
        taxonomyFingerprint: replayRaceSource.sharedCategory.taxonomyFingerprint || "",
        provenance: replayRaceSource.sharedCategory.source,
      };
      const replayBarrier = twoConnectionJobReplayBarrier(scopedPool);
      const replayRaceRepository = createAutoListingRepository({ pool: replayBarrier });
      const [firstLease, secondLease] = await Promise.all([
        replayRaceRepository.acquireCategoryPreparationLease({ accountId: accountA, items: [replayLeaseItem] }),
        replayRaceRepository.acquireCategoryPreparationLease({ accountId: accountA, items: [replayLeaseItem] }),
      ]);
      const replayGraphs = [firstLease, secondLease].map((lease) => ({
        ...structuredClone(replayRace),
        categoryPreparationLeaseId: lease.leaseId,
        categoryPreparationSignal: lease.signal,
      }));
      const replayCreations = replayGraphs.map((input) => replayRaceRepository.createJobGraph(input));
      try {
        await replayBarrier.waitForBoth();
        replayBarrier.release();
        const replayResults = await Promise.all(replayCreations);
        const winnerIndex = replayResults.findIndex((result) => result.duplicate !== true);
        const loserIndex = replayResults.findIndex((result) => result.duplicate === true);
        assert.notEqual(winnerIndex, -1);
        assert.notEqual(loserIndex, -1);
        assert.equal(replayResults[winnerIndex].id, replayResults[loserIndex].id);
        const winnerLease = [firstLease, secondLease][winnerIndex];
        const loserLease = [firstLease, secondLease][loserIndex];
        const winnerJobId = replayResults[winnerIndex].id;
        const committedRelease = {
          accountId: accountA, leaseId: winnerLease.leaseId, outcome: "COMMITTED", jobId: winnerJobId,
        };
        await replayRaceRepository.releaseCategoryPreparationLease(committedRelease);
        await assert.doesNotReject(replayRaceRepository.releaseCategoryPreparationLease(committedRelease));
        const replayRelease = {
          accountId: accountA, leaseId: loserLease.leaseId, outcome: "REPLAYED", jobId: winnerJobId,
        };
        await replayRaceRepository.releaseCategoryPreparationLease(replayRelease);
        await assert.doesNotReject(replayRaceRepository.releaseCategoryPreparationLease(replayRelease));
        await assert.rejects(replayRaceRepository.releaseCategoryPreparationLease({
          ...replayRelease, outcome: "COMMITTED",
        }), { code: "AUTO_LISTING_CATEGORY_LEASE_NOT_ACTIVE" });
        await assert.rejects(replayRaceRepository.releaseCategoryPreparationLease({
          ...replayRelease, jobId: created.id,
        }), { code: "AUTO_LISTING_CATEGORY_LEASE_NOT_ACTIVE" });
        const leaseRows = (await client.query(
          `SELECT id,outcome,finalized_job_id,replayed_job_id
             FROM auto_listing_category_preparation_leases
            WHERE account_id=$1 AND id=ANY($2::text[]) ORDER BY id`,
          [accountA, [winnerLease.leaseId, loserLease.leaseId]],
        )).rows;
        const committedLease = leaseRows.find((row) => row.id === winnerLease.leaseId);
        const replayedLease = leaseRows.find((row) => row.id === loserLease.leaseId);
        assert.deepEqual({ outcome: committedLease.outcome, finalizedJobId: committedLease.finalized_job_id,
          replayedJobId: committedLease.replayed_job_id },
        { outcome: "COMMITTED", finalizedJobId: winnerJobId, replayedJobId: null });
        assert.deepEqual({ outcome: replayedLease.outcome, finalizedJobId: replayedLease.finalized_job_id,
          replayedJobId: replayedLease.replayed_job_id },
        { outcome: "REPLAYED", finalizedJobId: null, replayedJobId: winnerJobId });
        assert.equal(Number((await client.query(
          `SELECT count(*)::int AS count FROM auto_listing_category_preparation_leases
            WHERE account_id=$1 AND outcome='COMMITTED' AND finalized_job_id IS NULL`,
          [accountA],
        )).rows[0].count), 0);
        assert.equal(Number((await client.query(
          "SELECT count(*)::int AS count FROM auto_listing_jobs WHERE account_id=$1 AND idempotency_key=$2",
          [accountA, replayRace.idempotencyKey],
        )).rows[0].count), 1);
        assert.equal((await client.query(
          "SELECT category_preparation_lease_id FROM auto_listing_jobs WHERE account_id=$1 AND id=$2",
          [accountA, winnerJobId],
        )).rows[0].category_preparation_lease_id, winnerLease.leaseId);
        for (const forbiddenLeaseId of [null, loserLease.leaseId]) {
          await client.query("BEGIN");
          try {
            await client.query(
              "UPDATE auto_listing_jobs SET category_preparation_lease_id=$1 WHERE account_id=$2 AND id=$3",
              [forbiddenLeaseId, accountA, winnerJobId],
            );
            await assert.rejects(client.query("SET CONSTRAINTS ALL IMMEDIATE"), (error) => error?.code === "23514");
          } finally {
            await client.query("ROLLBACK");
          }
        }
      } finally {
        replayBarrier.release();
        await Promise.allSettled(replayCreations);
      }

      const conflictLeft = graph(accountA, "race-conflict-left", "race-conflict");
      const conflictRight = withChangedSourceHash(graph(accountA, "race-conflict-right", "race-conflict"));
      conflictRight.categoryPreparationLeaseId = `category-lease-race-conflict-right-${suffix}`;
      await registerGraphSources(client, conflictLeft);
      await registerGraphSources(client, conflictRight);
      const conflictRepository = createAutoListingRepository({ pool: scopedPool });
      const conflictResults = await Promise.allSettled([
        conflictRepository.createJobGraph(conflictLeft), conflictRepository.createJobGraph(conflictRight),
      ]);
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
        `INSERT INTO stores (id,label,company_name,client_id,status,owner_account_id,currency_code,
           currency_source,currency_synced_at)
         VALUES ($1,'Second','Second',$2,'active',$3,'RUB','OZON_SELLER_INFO',STATEMENT_TIMESTAMP())`,
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
      reuseSecond.categoryPreparationLeaseId = `category-lease-shared-category-store-two-${suffix}`;
      reuseSecond.configSnapshot = secondFrozen.config;
      reuseSecond.configHash = secondFrozen.configHash;
      reuseSecond.items[0].targetStoreId = secondStoreId;
      reuseSecond.items[0].targetWarehouseId = secondWarehouseId;
      reuseSecond.items[0].effectiveImageConfig = deriveEffectiveAutoListingImageConfig({
        configSnapshot: secondFrozen.config, configHash: secondFrozen.configHash,
        sourceCapture: { snapshot: reuseSecond.items[0].snapshot, snapshotHash: reuseSecond.items[0].snapshotHash },
      });
      await registerGraphSources(client, reuseSecond);
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
      await client.query(
        "UPDATE warehouses SET warehouse_type='FBS' WHERE id=$1 AND store_id=$2",
        [`warehouse-${accountA}`, `store-${accountA}`],
      );
      await client.query(
        `INSERT INTO product_stocks (product_id,warehouse_id,store_id,source)
         VALUES ($1,$2,$3,'fbs') ON CONFLICT DO NOTHING`,
        [`product-${accountA}`, `warehouse-${accountA}`, `store-${accountA}`],
      );

      const graphCrashSource = (await repository.loadCollectSources({
        accountId: accountA, collectItemIds: [fullServiceRace.items[0].sourceRecordId],
      }))[0];
      const graphCrash = bindGraphToSharedVersion(
        graph(accountA, "shared-category-graph-crash", "shared-category-graph-crash"),
        graphCrashSource.sharedCategory.version,
      );
      await registerGraphSources(client, graphCrash);
      const graphCrashLoaded = (await repository.loadCollectSources({
        accountId: accountA, collectItemIds: [graphCrash.items[0].sourceRecordId],
      }))[0];
      const graphCrashItem = {
        collectItemId: graphCrashLoaded.id,
        evidenceId: graphCrashLoaded.categoryEvidence.id,
        sharedCategoryId: graphCrashLoaded.sharedCategory.id,
        sharedCategoryVersion: graphCrashLoaded.sharedCategory.version,
        sourceDescriptionCategoryId: graphCrashLoaded.categoryEvidence.sourceDescriptionCategoryId,
        sourceTypeId: graphCrashLoaded.categoryEvidence.sourceTypeId,
        descriptionCategoryId: graphCrashLoaded.sharedCategory.currentDescriptionCategoryId,
        typeId: graphCrashLoaded.sharedCategory.currentTypeId,
        taxonomyScope: graphCrashLoaded.sharedCategory.taxonomyScope,
        taxonomyFingerprint: graphCrashLoaded.sharedCategory.taxonomyFingerprint || "",
        provenance: graphCrashLoaded.sharedCategory.source,
      };
      const crashFence = categoryGraphFenceBarrier(scopedPool);
      const graphCrashRepository = createAutoListingRepository({ pool: crashFence });
      const graphCrashLease = await graphCrashRepository.acquireCategoryPreparationLease({
        accountId: accountA, items: [graphCrashItem],
      });
      graphCrash.categoryPreparationLeaseId = graphCrashLease.leaseId;
      graphCrash.categoryPreparationSignal = graphCrashLease.signal;
      const graphCrashCreation = graphCrashRepository.createJobGraph(graphCrash);
      graphCrashCreation.catch(() => {});
      const graphCrashTransition = new Client({ connectionString: databaseUrl });
      await graphCrashTransition.connect();
      let graphCrashMutation;
      try {
        await Promise.race([
          crashFence.waitForFence(),
          delay(2_000).then(() => { throw new Error("graph crash fence was not reached"); }),
        ]);
        const graphCrashPid = Number((await client.query(
          "SELECT holder_backend_pid FROM auto_listing_category_preparation_leases WHERE account_id=$1 AND id=$2",
          [accountA, graphCrashLease.leaseId],
        )).rows[0].holder_backend_pid);
        await client.query("SELECT pg_terminate_backend($1)", [graphCrashPid]);
        await graphCrashTransition.query(`SET search_path TO ${schemaSql}, public`);
        const mutationMarker = `auto-listing-graph-crash-transition-${suffix}`;
        graphCrashMutation = graphCrashTransition.query(
          `/* ${mutationMarker} */ UPDATE account_ozon_shared_categories
              SET version=version+1,updated_at=updated_at+INTERVAL '1 millisecond'
            WHERE account_id=$1 AND id=$2`,
          [accountA, graphCrashItem.sharedCategoryId],
        );
        graphCrashMutation.catch(() => {});
        await Promise.race([
          graphCrashMutation,
          delay(2_000).then(() => { throw new Error("transition did not recover after lease backend crash"); }),
        ]);
        crashFence.release();
        await assert.rejects(graphCrashCreation, (error) => [
          "AUTO_LISTING_CATEGORY_LEASE_UNAVAILABLE",
          "AUTO_LISTING_CATEGORY_LEASE_NOT_ACTIVE",
        ].includes(error?.code));
      } finally {
        crashFence.release();
        await graphCrashCreation.catch(() => {});
        await graphCrashRepository.releaseCategoryPreparationLease({
          accountId: accountA, leaseId: graphCrashLease.leaseId, outcome: "FAILED",
        }).catch(() => {});
        await graphCrashMutation?.catch(() => {});
        await graphCrashTransition.end();
      }
      for (const [table, predicate, params] of [
        ["auto_listing_jobs", "idempotency_key=$2", [accountA, graphCrash.idempotencyKey]],
        ["auto_listing_source_snapshots", "source_record_id=$2", [accountA, graphCrash.items[0].sourceRecordId]],
        ["auto_listing_listing_bases", "collect_item_id=$2", [accountA, graphCrash.items[0].sourceRecordId]],
        ["auto_listing_ai_outbox", "job_id IN (SELECT id FROM auto_listing_jobs WHERE account_id=$1 AND idempotency_key=$2)", [accountA, graphCrash.idempotencyKey]],
      ]) {
        assert.equal(Number((await client.query(
          `SELECT count(*)::int AS count FROM ${table} WHERE account_id=$1 AND ${predicate}`,
          params,
        )).rows[0].count), 0);
      }

      const graphExpirySource = (await repository.loadCollectSources({
        accountId: accountA, collectItemIds: [fullServiceRace.items[0].sourceRecordId],
      }))[0];
      const graphExpiry = bindGraphToSharedVersion(
        graph(accountA, "shared-category-graph-expiry", "shared-category-graph-expiry"),
        graphExpirySource.sharedCategory.version,
      );
      await registerGraphSources(client, graphExpiry);
      const graphExpiryLoaded = (await repository.loadCollectSources({
        accountId: accountA, collectItemIds: [graphExpiry.items[0].sourceRecordId],
      }))[0];
      const graphExpiryItem = { ...graphCrashItem,
        collectItemId: graphExpiryLoaded.id,
        evidenceId: graphExpiryLoaded.categoryEvidence.id,
        sharedCategoryVersion: graphExpiryLoaded.sharedCategory.version,
      };
      const expiryFence = categoryGraphFenceBarrier(scopedPool);
      const graphExpiryRepository = createAutoListingRepository({
        pool: expiryFence, categoryLeaseHoldTimeoutMs: 1_000,
      });
      const graphExpiryLease = await graphExpiryRepository.acquireCategoryPreparationLease({
        accountId: accountA, items: [graphExpiryItem],
      });
      graphExpiry.categoryPreparationLeaseId = graphExpiryLease.leaseId;
      graphExpiry.categoryPreparationSignal = graphExpiryLease.signal;
      const graphExpiryCreation = graphExpiryRepository.createJobGraph(graphExpiry);
      graphExpiryCreation.catch(() => {});
      const graphExpiryTransition = new Client({ connectionString: databaseUrl });
      const graphExpiryObserver = new Client({ connectionString: databaseUrl });
      await Promise.all([graphExpiryTransition.connect(), graphExpiryObserver.connect()]);
      let expiryMutation;
      try {
        await Promise.race([
          expiryFence.waitForFence(),
          delay(2_000).then(() => { throw new Error("graph expiry fence was not reached"); }),
        ]);
        await new Promise((resolve) => {
          if (graphExpiryLease.signal.aborted) resolve();
          else graphExpiryLease.signal.addEventListener("abort", resolve, { once: true });
        });
        await graphExpiryTransition.query(`SET search_path TO ${schemaSql}, public`);
        const expiryMutationPid = Number((await graphExpiryTransition.query(
          "SELECT pg_backend_pid() AS pid",
        )).rows[0].pid);
        const expiryMarker = `auto-listing-graph-expiry-transition-${suffix}`;
        expiryMutation = graphExpiryTransition.query(
          `/* ${expiryMarker} */ UPDATE account_ozon_shared_categories
              SET version=version+1,updated_at=updated_at+INTERVAL '1 millisecond'
            WHERE account_id=$1 AND id=$2`,
          [accountA, graphExpiryItem.sharedCategoryId],
        );
        expiryMutation.catch(() => {});
        await waitForBackendLock({
          observer: graphExpiryObserver, backendPid: expiryMutationPid,
          marker: expiryMarker, timeoutMs: 750, pollMs: 10,
        });
        expiryFence.release();
        await assert.rejects(graphExpiryCreation, {
          code: "AUTO_LISTING_CATEGORY_LEASE_EXPIRED",
        });
        await graphExpiryRepository.releaseCategoryPreparationLease({
          accountId: accountA, leaseId: graphExpiryLease.leaseId, outcome: "TIMEOUT",
        });
        await expiryMutation;
      } finally {
        expiryFence.release();
        await graphExpiryCreation.catch(() => {});
        await graphExpiryRepository.releaseCategoryPreparationLease({
          accountId: accountA, leaseId: graphExpiryLease.leaseId, outcome: "TIMEOUT",
        }).catch(() => {});
        await expiryMutation?.catch(() => {});
        await Promise.all([graphExpiryObserver.end(), graphExpiryTransition.end()]);
      }
      assert.deepEqual((await client.query(
        "SELECT state,outcome FROM auto_listing_category_preparation_leases WHERE account_id=$1 AND id=$2",
        [accountA, graphExpiryLease.leaseId],
      )).rows[0], { state: "EXPIRED", outcome: "TIMEOUT" });
      assert.equal(Number((await client.query(
        "SELECT count(*)::int AS count FROM auto_listing_jobs WHERE account_id=$1 AND idempotency_key=$2",
        [accountA, graphExpiry.idempotencyKey],
      )).rows[0].count), 0);

      const task9Account = `account-task9-${suffix}`;
      const task9OldVersion = `strategy-task9-old-${suffix}`;
      const task9NewVersion = `strategy-task9-new-${suffix}`;
      const task9OldRule = `rule-task9-old-${suffix}`;
      const task9NewRule = `rule-task9-new-${suffix}`;
      const task9RecoveryVersion = `strategy-task9-recovery-${suffix}`;
      const task9RecoveryRule = `rule-task9-recovery-${suffix}`;
      await client.query(
        "INSERT INTO accounts (id,username,display_name,role,status) VALUES ($1,$2,$2,'admin','active')",
        [task9Account, `user-${task9Account}`],
      );
      await client.query(
        `INSERT INTO stores (id,label,company_name,client_id,status,owner_account_id,
           currency_code,currency_source,currency_synced_at)
         VALUES ($1,'Task9','Task9',$2,'active',$3,'RUB','OZON_SELLER_INFO',STATEMENT_TIMESTAMP())`,
        [`store-${task9Account}`, `client-${task9Account}`, task9Account],
      );
      await client.query(
        "INSERT INTO store_credentials (store_id,client_id,encrypted_api_key,iv,auth_tag) VALUES ($1,$2,'ciphertext','iv','tag')",
        [`store-${task9Account}`, `client-${task9Account}`],
      );
      await client.query(
        `INSERT INTO warehouses (id,store_id,warehouse_id,warehouse_type,status,is_active,is_archived)
         VALUES ($1,$2,$3,'FBS','active',TRUE,FALSE)`,
        [`warehouse-${task9Account}`, `store-${task9Account}`, `platform-${task9Account}`],
      );
      await client.query(
        "INSERT INTO products (id,store_id,product_id,sku,status,raw) VALUES ($1,$2,$3,$4,'active','{}'::jsonb)",
        [`product-${task9Account}`, `store-${task9Account}`, `product-${task9Account}`, `sku-${task9Account}`],
      );
      await client.query(
        "INSERT INTO product_stocks (product_id,warehouse_id,store_id,source) VALUES ($1,$2,$3,'fbs')",
        [`product-${task9Account}`, `warehouse-${task9Account}`, `store-${task9Account}`],
      );
      for (const [strategyVersionId, version, status, ruleId] of [
        [task9OldVersion, 1, "RETIRED", task9OldRule],
        [task9NewVersion, 2, "PUBLISHED", task9NewRule],
      ]) {
        await client.query(
          `INSERT INTO ai_content_strategy_versions (id,account_id,strategy_key,version,status,content,content_hash)
           VALUES ($1,$2,'default',$3,'DRAFT','{"schemaVersion":"V2"}'::jsonb,$4)`,
          [strategyVersionId, task9Account, version, `${status.toLowerCase()}-hash-${suffix}`],
        );
        await client.query(
          `INSERT INTO ai_content_strategy_rules
             (id,account_id,strategy_version_id,rule_kind,rule_order,category_id,rule)
           VALUES ($1,$2,$3,'EXACT_CATEGORY',1,'123',$4::jsonb)`,
          [`physical-${ruleId}`, task9Account, strategyVersionId,
            JSON.stringify(exactCategoryStrategyRule(ruleId))],
        );
        await client.query(
          `UPDATE ai_content_strategy_versions
              SET status='PUBLISHED',published_at=STATEMENT_TIMESTAMP(),published_by=$2
            WHERE account_id=$2 AND id=$1 AND status='DRAFT'`,
          [strategyVersionId, task9Account],
        );
        if (status === "RETIRED") {
          await client.query(
            "UPDATE ai_content_strategy_versions SET status='RETIRED' WHERE account_id=$1 AND id=$2 AND status='PUBLISHED'",
            [task9Account, strategyVersionId],
          );
        }
      }
      await client.query(
        `UPDATE auto_listing_category_strategy_account_settings
            SET mode='REQUIRE_EXACT_STRATEGY',version=2,idempotency_key=$2,correlation_id=$3,
                request_hash=$4,actor_account_id=$1,updated_at=STATEMENT_TIMESTAMP()
          WHERE account_id=$1 AND mode='LEGACY_FALLBACK' AND version=1`,
        [task9Account, `settings-task9-${suffix}`, `settings-task9-corr-${suffix}`, "c".repeat(64)],
      );
      await client.query(
        `INSERT INTO auto_listing_upload_policy_versions (
           id,account_id,mode,enabled,version,publication_reason,created_by,published_by,published_at,
           publication_origin,publication_base_url,publication_prefix,publication_version,publication_policy_hash
         ) VALUES ($1,$2,'REVIEW',TRUE,1,'task9 review policy',$2,$2,NOW(),$3,$4,$5,$6,$7)`,
        [`upload-policy-${task9Account}`, task9Account, publicationPolicy.origin, publicationPolicy.baseUrl,
          publicationPolicy.prefix, publicationPolicy.publicationVersion, publicationPolicyHash],
      );
      await client.query(
        `INSERT INTO ai_gateway_profiles
          (id,account_id,display_name,base_url,api_key_env_name,text_protocol,image_protocol,text_model,image_model,config_version,enabled)
         VALUES ($1,$2,'Task9','https://gateway.invalid','TASK9_AI_KEY','SUB2API_RESPONSES',
           'SUB2API_OPENAI_IMAGES','text','image',1,TRUE)`,
        [`profile-${task9Account}`, task9Account],
      );
      const task9Repository = createAutoListingRepository({ pool: scopedPool });
      const assertTask9ZeroWrites = async (input) => {
        const row = (await client.query(
          `SELECT
             (SELECT COUNT(*)::INT FROM auto_listing_jobs WHERE account_id=$1 AND idempotency_key=$2) AS jobs,
             (SELECT COUNT(*)::INT FROM auto_listing_source_snapshots WHERE account_id=$1 AND source_record_id=$3) AS snapshots,
             (SELECT COUNT(*)::INT FROM auto_listing_listing_bases WHERE account_id=$1 AND collect_item_id=$3) AS bases,
             (SELECT COUNT(*)::INT FROM auto_listing_ai_outbox WHERE account_id=$1 AND job_id IN
               (SELECT id FROM auto_listing_jobs WHERE account_id=$1 AND idempotency_key=$2)) AS outbox`,
          [task9Account, input.idempotencyKey, input.items[0].sourceRecordId],
        )).rows[0];
        assert.deepEqual(row, { jobs: 0, snapshots: 0, bases: 0, outbox: 0 });
      };

      const modeDrift = withExactCategoryStrategy(
        graph(task9Account, `mode-drift-${suffix}`, `mode-drift-${suffix}`),
        { strategyVersionId: task9NewVersion, ruleId: task9NewRule, policyVersion: 3 },
      );
      await registerGraphSources(client, modeDrift);
      await assert.rejects(task9Repository.createJobGraph(modeDrift),
        { code: "AUTO_LISTING_CATEGORY_STRATEGY_CHANGED", status: 409 });
      await assertTask9ZeroWrites(modeDrift);

      const publishDrift = withExactCategoryStrategy(
        graph(task9Account, `publish-drift-${suffix}`, `publish-drift-${suffix}`),
        { strategyVersionId: task9OldVersion, ruleId: task9OldRule, policyVersion: 2 },
      );
      await registerGraphSources(client, publishDrift);
      await assert.rejects(task9Repository.createJobGraph(publishDrift),
        { code: "AUTO_LISTING_STRATEGY_NOT_PUBLISHED", status: 409 });
      await assertTask9ZeroWrites(publishDrift);

      const sourceDrift = withExactCategoryStrategy(
        graph(task9Account, `source-drift-${suffix}`, `source-drift-${suffix}`),
        { strategyVersionId: task9NewVersion, ruleId: task9NewRule, policyVersion: 2 },
      );
      await registerGraphSources(client, sourceDrift);
      await client.query(
        "UPDATE account_ozon_shared_categories SET version=2,updated_at=STATEMENT_TIMESTAMP() WHERE account_id=$1 AND id=$2",
        [task9Account, sourceDrift.items[0].snapshot.targetCategory.sharedCategoryId],
      );
      await assert.rejects(task9Repository.createJobGraph(sourceDrift),
        { code: "AUTO_LISTING_SOURCE_VERSION_CONFLICT", status: 409 });
      await assertTask9ZeroWrites(sourceDrift);

      const continuation = withExactCategoryStrategy(bindGraphToSharedVersion(
        graph(task9Account, `continue-new-key-${suffix}`, `continue-new-key-${suffix}`), 2,
      ), { strategyVersionId: task9NewVersion, ruleId: task9NewRule, policyVersion: 2 });
      await registerGraphSources(client, continuation);
      const task9Created = await task9Repository.createJobGraph(continuation);
      assert.equal(task9Created.accountId, task9Account);
      const task9Frozen = (await client.query(
        `SELECT job.strategy_version_id,job.config_snapshot,item.target_store_id,item.target_warehouse_id,
                event.details->>'ruleId' AS rule_id,event.details->>'matchedBy' AS matched_by
           FROM auto_listing_jobs job
           JOIN auto_listing_job_items item ON item.account_id=job.account_id AND item.job_id=job.id
           JOIN auto_listing_events event ON event.account_id=job.account_id AND event.job_id=job.id
             AND event.item_id=item.id AND event.event_type='SOURCE_CAPTURED'
          WHERE job.account_id=$1 AND job.idempotency_key=$2`,
        [task9Account, continuation.idempotencyKey],
      )).rows[0];
      assert.equal(task9Frozen.strategy_version_id, task9NewVersion);
      assert.equal(task9Frozen.rule_id, task9NewRule);
      assert.equal(task9Frozen.matched_by, "EXACT_CATEGORY_TYPE_V2");
      assert.equal(task9Frozen.target_store_id, continuation.configSnapshot.targetStoreId);
      assert.equal(task9Frozen.target_warehouse_id, continuation.configSnapshot.targetWarehouseId);
      assert.equal(task9Frozen.config_snapshot.image.total, 7);
      assert.deepEqual(task9Frozen.config_snapshot.image.roles, continuation.configSnapshot.image.roles);
      assert.equal(task9Created.items[0].price.currency, "RUB");

      const accountAttemptPool = () => {
        let resolveAttempt;
        const attempted = new Promise((resolve) => { resolveAttempt = resolve; });
        return {
          attempted,
          pool: {
            query: (...args) => scopedPool.query(...args),
            async connect() {
              const connection = await scopedPool.connect();
              return {
                async query(sql, params) {
                  if (/SELECT id FROM accounts WHERE id=\$1 FOR UPDATE/u.test(sql)) resolveAttempt();
                  return connection.query(sql, params);
                },
                release: (...args) => connection.release(...args),
              };
            },
          },
        };
      };
      const stageInitialPlanWork = async () => ({ status: "PLANNING", statusVersion: 2 });

      const publishWins = withExactCategoryStrategy(bindGraphToSharedVersion(
        graph(task9Account, `publish-wins-${suffix}`, `publish-wins-${suffix}`), 2,
      ), { strategyVersionId: task9NewVersion, ruleId: task9NewRule, policyVersion: 2 });
      await registerGraphSources(client, publishWins);
      const publisher = await pool.connect();
      await publisher.query(`SET search_path TO ${schemaSql}, public`);
      await publisher.query("BEGIN");
      await publisher.query("SELECT id FROM accounts WHERE id=$1 FOR UPDATE", [task9Account]);
      const blockedCreate = accountAttemptPool();
      const blockedRepository = createAutoListingRepository({ pool: blockedCreate.pool, stageInitialPlanWork });
      const blockedCreation = blockedRepository.createJobGraph(publishWins);
      await blockedCreate.attempted;
      await publisher.query(
        "UPDATE ai_content_strategy_versions SET status='RETIRED' WHERE account_id=$1 AND id=$2 AND status='PUBLISHED'",
        [task9Account, task9NewVersion],
      );
      await publisher.query("COMMIT");
      publisher.release();
      await assert.rejects(blockedCreation, { code: "AUTO_LISTING_STRATEGY_NOT_PUBLISHED", status: 409 });
      await assertTask9ZeroWrites(publishWins);

      await client.query(
        `INSERT INTO ai_content_strategy_versions (id,account_id,strategy_key,version,status,content,content_hash)
         VALUES ($1,$2,'default',3,'DRAFT','{"schemaVersion":"V2"}'::jsonb,$3)`,
        [task9RecoveryVersion, task9Account, `recovery-hash-${suffix}`],
      );
      await client.query(
        `INSERT INTO ai_content_strategy_rules
           (id,account_id,strategy_version_id,rule_kind,rule_order,category_id,rule)
         VALUES ($1,$2,$3,'EXACT_CATEGORY',1,'123',$4::jsonb)`,
        [`physical-${task9RecoveryRule}`, task9Account, task9RecoveryVersion,
          JSON.stringify(exactCategoryStrategyRule(task9RecoveryRule))],
      );
      await client.query(
        `UPDATE ai_content_strategy_versions SET status='PUBLISHED',published_at=STATEMENT_TIMESTAMP(),published_by=$2
          WHERE account_id=$2 AND id=$1 AND status='DRAFT'`,
        [task9RecoveryVersion, task9Account],
      );
      const rollbackWins = withExactCategoryStrategy(bindGraphToSharedVersion(
        graph(task9Account, `publish-rolls-back-${suffix}`, `publish-rolls-back-${suffix}`), 2,
      ), { strategyVersionId: task9RecoveryVersion, ruleId: task9RecoveryRule, policyVersion: 2 });
      await registerGraphSources(client, rollbackWins);
      const rollingPublisher = await pool.connect();
      await rollingPublisher.query(`SET search_path TO ${schemaSql}, public`);
      await rollingPublisher.query("BEGIN");
      await rollingPublisher.query("SELECT id FROM accounts WHERE id=$1 FOR UPDATE", [task9Account]);
      await rollingPublisher.query(
        "UPDATE ai_content_strategy_versions SET status='RETIRED' WHERE account_id=$1 AND id=$2 AND status='PUBLISHED'",
        [task9Account, task9RecoveryVersion],
      );
      const rollbackCreate = accountAttemptPool();
      const rollbackRepository = createAutoListingRepository({ pool: rollbackCreate.pool, stageInitialPlanWork });
      const rollbackCreation = rollbackRepository.createJobGraph(rollbackWins);
      await rollbackCreate.attempted;
      await rollingPublisher.query("ROLLBACK");
      rollingPublisher.release();
      const rollbackCreated = await rollbackCreation;
      assert.equal(rollbackCreated.accountId, task9Account);
      assert.equal(Number((await client.query(
        "SELECT count(*)::int AS count FROM auto_listing_jobs WHERE account_id=$1 AND idempotency_key=$2",
        [task9Account, rollbackWins.idempotencyKey],
      )).rows[0].count), 1);
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
        `INSERT INTO stores (id,label,company_name,client_id,status,owner_account_id,
           currency_code,currency_source,currency_synced_at)
         VALUES ($1,$2,$2,$3,'active',$4,'RUB','OZON_SELLER_INFO',STATEMENT_TIMESTAMP())`,
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
        [`strategy-version-${accountId}`, accountId, "default", `strategy-hash-${accountId}`],
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
