import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Pool } from "pg";
import { createAccountSharedOzonCategoryService } from "../account-shared-ozon-category-service.mjs";
import { createPostgresAccountSharedOzonCategoryRepository } from "../account-shared-ozon-category-repository.mjs";
import { createAutoListingCategoryRecoveryPostgres } from "../auto-listing-category-recovery-postgres.mjs";
import { createAutoListingCategoryRecoveryService } from "../auto-listing-category-recovery-service.mjs";
import { createAutoListingService } from "../auto-listing-service.mjs";
import { createAutoListingSubmissionReconciler } from "../auto-listing-submission-reconciler.mjs";
import { encryptSecret } from "../crypto-secrets.mjs";
import { classifyOzonCategoryImportResult, projectProductionOzonImportErrorEvidence } from "../ozon-category-import-error-policy.mjs";
import { rebuildOzonItemsForCategory } from "../ozon-category-item-rebuilder.mjs";

const enabled = process.env.ACCOUNT_SHARED_CATEGORY_RECOVERY_E2E === "1";
const sourceUrl = process.env.SONLI_MIGRATION_TEST_DATABASE_URL || "";
const restoreUrl = process.env.SONLI_RESTORE_TEST_DATABASE_URL || "";
const sourceContainer = process.env.SONLI_MIGRATION_TEST_CONTAINER || "";
const restoreContainer = process.env.SONLI_RESTORE_TEST_CONTAINER || "";
const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(here, "../db/migrations");
const q = (value) => `"${String(value).replaceAll('"', '""')}"`;
const sha = (value) => crypto.createHash("sha256").update(String(value)).digest("hex");
const canonical = (value) => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const canonicalSha = (value) => sha(JSON.stringify(canonical(value)));

async function migrationFiles(maximum = 73) {
  const files = (await readdir(migrationsDir))
    .filter((file) => /^\d{3}_.+\.sql$/u.test(file) && Number(file.slice(0, 3)) <= maximum)
    .sort();
  if (maximum === 69) assert.equal(files.at(-1), "069_submission_category_recovery_item_results.sql");
  if (maximum === 71) assert.equal(files.at(-1), "071_submission_stock_write_ledger.sql");
  if (maximum === 72) assert.equal(files.at(-1), "072_account_shared_category_confirmation_audit_provenance.sql");
  if (maximum === 73) assert.equal(files.at(-1), "073_store_currency_authority.sql");
  return files;
}

async function applyMigrations(client, maximum = 73) {
  for (const file of await migrationFiles(maximum)) {
    await client.query(await readFile(path.join(migrationsDir, file), "utf8"));
  }
}

function scopedPool(pool, schema) {
  return {
    async connect() {
      const client = await pool.connect();
      await client.query(`SET search_path TO ${q(schema)}, public`);
      return client;
    },
    async query(...args) {
      const client = await pool.connect();
      try {
        await client.query(`SET search_path TO ${q(schema)}, public`);
        return await client.query(...args);
      } finally { client.release(); }
    },
  };
}

async function listenFakeOzon() {
  const calls = [];
  const state = {
    importCount: 0,
    checkCount: 0,
    offerStatus: "ABSENT",
    retryResult: "SUCCEEDED",
    scenarios: new Map(),
    taskOffers: new Map(),
  };
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    calls.push(Object.freeze({
      path: request.url,
      clientId: String(request.headers["client-id"] || ""),
      apiKeyPresent: typeof request.headers["api-key"] === "string" && request.headers["api-key"].length > 0,
      body: structuredClone(body),
    }));
    response.setHeader("content-type", "application/json");
    if (request.url === "/v3/product/info/list") {
      response.end(JSON.stringify({ items: state.offerStatus === "PRESENT" ? [{ offer_id: "offer-a" }] : [] }));
    } else if (request.url === "/v1/description-category/tree") {
      response.end(JSON.stringify({ result: [{ descriptionCategoryId: 30, typeId: 40 }] }));
    } else if (request.url === "/v3/product/import") {
      const offerId = String(body?.items?.[0]?.offer_id || "");
      const scenario = state.scenarios.get(offerId) || {};
      state.importCount += 1;
      if (scenario.importHttpStatus) {
        response.statusCode = scenario.importHttpStatus;
        response.end(JSON.stringify({ code: scenario.errorCode, message: scenario.errorCode }));
        return;
      }
      const taskId = offerId === "offer-a"
        ? (state.importCount === 1 ? "task-original" : "task-retry")
        : `task-${offerId}`;
      if (offerId !== "offer-a") state.taskOffers.set(taskId, offerId);
      response.end(JSON.stringify({ result: { task_id: taskId } }));
    } else if (request.url === "/v1/product/import/info") {
      state.checkCount += 1;
      const retry = body.task_id === "task-retry";
      const matrixOfferId = state.taskOffers.get(String(body.task_id || ""));
      const matrixScenario = state.scenarios.get(matrixOfferId) || {};
      response.end(JSON.stringify({ result: { items: matrixOfferId
        ? [{ offer_id: matrixOfferId, product_id: matrixScenario.checkErrorCode ? "" : "201",
          status: matrixScenario.checkErrorCode ? "failed" : "imported",
          ...(matrixScenario.checkErrorCode ? { errors: [{ code: matrixScenario.checkErrorCode, field: matrixScenario.errorField || "offer_id" }] } : {}) }]
        : retry && state.retryResult === "SUCCEEDED"
        ? [{ offer_id: "offer-a", product_id: "101", status: "imported" }]
        : [{ offer_id: "offer-a", product_id: "", status: "failed",
          errors: [{ code: "CATEGORY_INVALID", field: "description_category_id" }] }] } }));
    } else if (request.url === "/v2/products/stocks") {
      const offerId = String(body?.stocks?.[0]?.offer_id || "");
      const scenario = state.scenarios.get(offerId) || {};
      if (scenario.stockHttpStatus) {
        response.statusCode = scenario.stockHttpStatus;
        response.end(JSON.stringify({ code: scenario.errorCode, message: scenario.errorCode }));
        return;
      }
      response.end(JSON.stringify({ result: [{ offer_id: "offer-a", updated: true }] }));
    } else {
      response.statusCode = 404;
      response.end(JSON.stringify({ error: "not-found" }));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    calls,
    state,
    baseUrl: `http://127.0.0.1:${address.port}`,
    async post(route, body) {
      const response = await fetch(`http://127.0.0.1:${address.port}${route}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      });
      assert.equal(response.status, 200);
      return response.json();
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function seedLegacyPreUpgradeCollection(client, { accountId, storeId, collectId, rawId, draftId, sku }) {
  await client.query(
    "INSERT INTO collect_items(id,account_id,store_id,source,identity_key,source_sku,summary) VALUES($1,$2,$3,'ozon',$1,$4,'{}')",
    [collectId, accountId, storeId, sku],
  );
  await client.query(
    `INSERT INTO collect_raw_payloads(id,collect_item_id,account_id,store_id,source_sku,source_url,payload_hash,payload,collected_at)
     VALUES($1,$2,$3,$4,$5,'https://source.invalid/item',$6,'{}',$7)`,
    [rawId, collectId, accountId, storeId, sku, sha(rawId), "2026-08-12T00:00:00.000Z"],
  );
  const category = { descriptionCategoryId: 10, typeIdCandidate: 20, path: ["root", "leaf"] };
  const image = "https://cdn.example.test/item.jpg";
  const listingVariant = {
    sku, offer_id: "offer-a", name: "Frozen item", price: "100.00", currency_code: "RUB",
    sourceCategory: category, weight: 500, weight_unit: "g", depth: 200, width: 100, height: 50,
    dimension_unit: "mm", images: [image], primary_image: image,
    attributes: [{ complex_id: 0, id: 1, values: [{ value: "safe" }] }],
  };
  const draftData = { ...listingVariant, sourceCategory: category, variants: [listingVariant],
    blackKopecks: "10000", greenKopecks: "8000", currency: "RUB" };
  await client.query(
    `INSERT INTO product_drafts(id,collect_item_id,source_payload_id,version,data_hash,data,updated_by)
     VALUES($1,$2,$3,1,$4,$5::jsonb,$6)`,
    [draftId, collectId, rawId, sha(draftId), JSON.stringify(draftData), accountId],
  );
  await client.query("UPDATE collect_items SET current_draft_id=$1 WHERE account_id=$2 AND id=$3", [draftId, accountId, collectId]);
  return {
    accountId, collectItemId: collectId, sourceVersion: "draft:1", productDraftId: draftId,
    productDraftVersion: 1, ozonProductId: null, sourceSku: sku, taxonomyScope: "OZON:DEFAULT",
    sourceDescriptionCategoryId: 10, sourceTypeId: 20, normalizedPath: ["root", "leaf"],
    attributeSummary: [], capturedAt: "2026-08-12T00:00:00.000Z",
    rawResponseRef: rawId, rawResponseHash: sha(rawId),
  };
}

function autoListingSource({ source, accountId, evidence, shared }) {
  const category = { descriptionCategoryId: 10, typeIdCandidate: 20, path: ["root", "leaf"] };
  const image = "https://cdn.example.test/item.jpg";
  const variant = {
    sku: source.sourceSku, offer_id: "offer-a", name: "Frozen item", price: "100.00",
    currency_code: "RUB", sourceCategory: category, weight: 500, weight_unit: "g", depth: 200,
    width: 100, height: 50, dimension_unit: "mm", images: [image], primary_image: image,
    attributes: [{ complex_id: 0, id: 1, values: [{ value: "safe" }] }],
  };
  return {
    id: source.collectItemId, collectItemId: source.collectItemId, accountId,
    sourceVersion: source.sourceVersion, rawResponseRef: source.rawResponseRef,
    rawResponseHash: source.rawResponseHash, rawCollectedAt: source.capturedAt,
    categoryEvidence: {
      id: evidence.id, accountId, sourceDescriptionCategoryId: Number(evidence.source_description_category_id),
      sourceTypeId: Number(evidence.source_type_id), taxonomyScope: evidence.taxonomy_scope,
    },
    sharedCategory: {
      id: shared.id, accountId, version: Number(shared.version), evidenceId: evidence.id,
      status: shared.status, source: shared.source,
      sourceDescriptionCategoryId: Number(shared.source_description_category_id),
      sourceTypeId: Number(shared.source_type_id),
      currentDescriptionCategoryId: Number(shared.current_description_category_id),
      currentTypeId: Number(shared.current_type_id), taxonomyScope: shared.taxonomy_scope,
      taxonomyFingerprint: shared.taxonomy_fingerprint,
    },
    collectItem: { id: source.collectItemId, accountId, sku: source.sourceSku,
      listingDraft: { ...variant, sourceCategory: category, variants: [variant],
        blackKopecks: "10000", greenKopecks: "8000", currency: "RUB" } },
    productDraft: { id: source.productDraftId, version: source.productDraftVersion,
      dataHash: sha(source.productDraftId), normalizerVersion: "v3",
      categoryRuleVersion: "category-v1", dictionaryVersion: "dictionary-live" },
  };
}

function productionAutoListingHarness({ source, accountId, storeId, warehouseId, listingBasePreparer }) {
  const calls = [];
  const controller = new AbortController();
  let graph = null;
  const repository = {
    async loadCollectSources(input) { calls.push(["loadCollectSources", input]); return [source]; },
    async loadTargetStore(input) { calls.push(["loadTargetStore", input]); return {
      id: storeId, ownerAccountId: accountId, status: "active", clientId: storeId,
      currencyCode: "RUB", credentialsSaved: true,
    }; },
    async loadTargetWarehouse(input) { calls.push(["loadTargetWarehouse", input]); return {
      warehouse: { id: warehouseId, storeId, accountId, warehouse_id: "platform-fbs-a",
        warehouse_type: "FBS", status: "active", is_active: true, is_archived: false },
      products: [{ accountId, storeId, warehouse_stocks: [{ warehouse_id: "platform-fbs-a", source: "fbs" }] }],
    }; },
    async loadPublishedStrategy(input) { calls.push(["loadPublishedStrategy", input]); return {
      strategyVersion: { strategyId: "strategy-a", strategyVersionId: "strategy-v1" }, rules: [],
    }; },
    async loadPublishedUploadPolicies(input) { calls.push(["loadPublishedUploadPolicies", input]); return [{
      id: "policy-review-v1", accountId, version: 1, mode: "REVIEW", enabled: true,
      publishedBy: accountId, publishedAt: "2026-08-12T00:00:00.000Z",
    }]; },
    async acquireCategoryPreparationLease(input) { calls.push(["acquireCategoryPreparationLease", input]);
      return { leaseId: "category-lease-a", expiresAt: "2099-01-01T00:00:00.000Z", signal: controller.signal }; },
    async releaseCategoryPreparationLease(input) { calls.push(["releaseCategoryPreparationLease", input]);
      return { released: true }; },
    async getJobByIdempotencyKey(input) { calls.push(["getJobByIdempotencyKey", input]); return null; },
    async createJobGraph(input) { calls.push(["createJobGraph", input]); graph = {
      ...input, id: "auto-job-a", createdAt: "2026-08-12T00:00:00.000Z", items: input.items,
    }; return graph; },
    async getJob() { return graph; },
    async listJobs() { return graph ? [graph] : []; },
  };
  const service = createAutoListingService({ repository, prepareListingBase: listingBasePreparer,
    rfbsWarehouseVerifier: Object.freeze({ async verifyRfbsWarehouse() {
      throw new Error("FBS must not use RFBS verifier");
    } }) });
  return { calls, repository, service, get graph() { return graph; } };
}

function historicalEvidence(offerId = "offer-a") {
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

function exactRecoveryIdentity(basis, attemptId, correlationId) {
  return {
    accountId: basis.accountId, jobId: basis.jobId, snapshotId: basis.snapshotId,
    evidenceId: basis.evidenceId, attemptId, sourceEvidenceId: basis.sourceEvidenceId,
    oldSharedCategoryId: basis.oldSharedCategoryId,
    oldSharedCategoryVersion: basis.oldSharedCategoryVersion,
    originalOzonTaskId: basis.originalOzonTaskId, correlationId,
  };
}

function failureMatrixRecoveryHarness({ absenceStatus = "ABSENT", refreshResult = "MATCHED",
  rebuildFailure = false, basisClassification = "EXPLICIT_CATEGORY_FAILURE" } = {}) {
  const calls = [];
  let shared = {
    accountId: "matrix-account", sourceDescriptionCategoryId: 10, sourceTypeId: 20,
    taxonomyScope: "OZON:DEFAULT", currentDescriptionCategoryId: 10, currentTypeId: 20,
    status: "ACTIVE", source: "SOURCE_DIRECT", taxonomyFingerprint: null,
    version: 1, evidenceId: "matrix-source", validatedAt: null,
  };
  const basis = {
    accountId: "matrix-account", jobId: "matrix-job", snapshotId: "matrix-snapshot",
    evidenceId: "matrix-error", policyVersion: "ozon-category-policy.v2",
    classification: basisClassification, productId: null, originalOzonTaskId: "matrix-original-task",
    sourceEvidenceId: "matrix-source", oldSharedCategoryId: "matrix-shared",
    oldSharedCategoryVersion: 1, existingAttempt: null, sharedCategory: shared,
    offers: [{ offerId: "matrix-offer", sku: "" }],
    frozenItems: [{ offer_id: "matrix-offer", description_category_id: 10, type_id: 20,
      attributes: [{ complex_id: 0, id: 1, values: [{ value: "safe" }] }],
      price: "1.00", currency_code: "RUB" }],
    safeEvidence: {
      schemaVersion: "OZON_CATEGORY_IMPORT_ERROR_EVIDENCE_V1",
      policyVersion: "ozon-category-policy.v2", errorCode: "CATEGORY_INVALID",
      field: "description_category_id", attributeId: null, state: "FAILED",
      offerId: "matrix-offer", productId: null, classification: "EXPLICIT_CATEGORY_FAILURE",
    },
  };
  const repository = {
    loadCategoryRecoveryBasis: async () => { calls.push("load"); return basis; },
    claimCategoryRecovery: async () => { calls.push("claim"); return {
      attemptId: "matrix-attempt", status: "CLAIMED", claimed: true,
    }; },
    saveCategoryRecoveryMatch: async (input) => { calls.push("save"); return {
      attemptId: "matrix-attempt", status: "MATCHED",
      replacementSharedCategoryId: input.replacementSharedCategoryId,
      replacementSharedCategoryVersion: input.replacementSharedCategoryVersion,
      correctedItemsHash: input.correctedItemsHash,
    }; },
    markCategoryRecoveryRetryPending: async () => { calls.push("pending"); return {
      attemptId: "matrix-attempt", status: "RETRY_PENDING",
    }; },
    requireCategoryRecoveryReview: async () => { calls.push("review"); return {
      attemptId: "matrix-attempt", status: "NEEDS_REVIEW",
    }; },
  };
  const service = createAutoListingCategoryRecoveryService({
    repository,
    loadOperatingStoreAccess: async () => { calls.push("access"); return { fixture: "safe" }; },
    confirmOfferAbsent: async () => { calls.push("absence"); return absenceStatus === "ABSENT"
      ? { status: "ABSENT", code: "OZON_OFFERS_CONFIRMED_ABSENT" }
      : absenceStatus === "PRESENT"
        ? { status: "PRESENT", code: "OZON_OFFER_PRESENT" }
        : { status: "UNKNOWN", code: "OZON_OFFER_RECONCILIATION_UNKNOWN" }; },
    invalidateSharedCategory: async () => { calls.push("invalidate"); shared = {
      ...shared, status: "INVALIDATED", version: 2,
    }; return shared; },
    refreshCategory: async () => { calls.push("refresh"); return refreshResult === "MATCHED" ? {
      kind: "UNIQUE_MATCH", descriptionCategoryId: 30, typeId: 40,
      taxonomyFingerprint: "a".repeat(64), metadata: {
        descriptionCategoryId: 30, typeId: 40,
        attributes: [{ id: 1, complexId: 0, required: true, dictionaryId: null, dictionaryValues: [] }],
      },
    } : { kind: "NEEDS_REVIEW" }; },
    rebuildItems: async ({ originalItems }) => { calls.push("rebuild");
      if (rebuildFailure) throw new Error("safe local validation failure");
      return originalItems.map((item) => ({ ...item, description_category_id: 30, type_id: 40 })); },
    activateRefreshedCategory: async (input) => { calls.push("activate"); shared = {
      ...shared, currentDescriptionCategoryId: input.currentDescriptionCategoryId,
      currentTypeId: input.currentTypeId, status: "ACTIVE", source: "OZON_REFRESH",
      taxonomyFingerprint: input.taxonomyFingerprint, version: 3, validatedAt: input.validatedAt,
    }; return shared; },
    markSharedNeedsReview: async () => { calls.push("shared-review"); shared = {
      ...shared, status: "NEEDS_REVIEW", version: shared.version + 1,
    }; return shared; },
    scheduleRetry: async () => { calls.push("schedule"); },
    now: () => "2026-08-13T00:00:00.000Z",
  });
  return { service, calls };
}

test("Task 10 recovery acceptance cannot self-simulate product import, stock, or recovery state", async () => {
  const source = await readFile(fileURLToPath(import.meta.url), "utf8");
  for (const forbidden of [
    "await fake" + ".post(\"/v3/product/import\"",
    "await fake" + ".post(\"/v2/products/stocks\"",
    "INSERT INTO submission_category_recovery_" + "item_results",
    "UPDATE submission_jobs SET ozon_task_id=" + "'task-retry'",
  ]) assert.equal(source.includes(forbidden), false, forbidden);
  for (const required of [
    "ingestCollectRequest" + "V4",
    "createAutoListing" + "Service", "createAutoListingListingBase" + "Preparer",
    "createSubmission" + "V3", "processListingQueue" + "Message",
    "createAutoListingSubmission" + "Reconciler",
  ]) assert.equal(source.includes(required), true, required);
  assert.equal(source.includes("seed" + "Collection("), false,
    "the successful collection path must use the production collection pipeline");
});

test("production recovery boundaries fail closed for the Task 10 failure matrix", async () => {
  const request = { accountId: "matrix-account", jobId: "matrix-job",
    evidenceId: "matrix-error", correlationId: "matrix-correlation" };
  for (const absenceStatus of ["PRESENT", "UNKNOWN"]) {
    const { service, calls } = failureMatrixRecoveryHarness({ absenceStatus });
    assert.equal((await service.recover(request)).status, "NEEDS_REVIEW");
    assert.deepEqual(calls, ["load", "access", "absence", "review"]);
  }
  for (const scenario of [
    { refreshResult: "AMBIGUOUS" },
    { rebuildFailure: true },
  ]) {
    const { service, calls } = failureMatrixRecoveryHarness(scenario);
    assert.equal((await service.recover(request)).status, "NEEDS_REVIEW");
    assert.equal(calls.includes("schedule"), false);
    assert.equal(calls.includes("save"), false);
    assert.equal(calls.at(-1), "review");
  }
  for (const errorCode of [
    "AUTH_FAILED", "THROTTLED", "BRAND_RESTRICTED", "CURRENCY_INVALID",
    "WAREHOUSE_INVALID", "STOCK_INVALID",
  ]) {
    const classified = classifyOzonCategoryImportResult({
      item: { offer_id: "matrix-offer", status: "failed", product_id: null,
        errors: [{ code: errorCode, field: "offer_id" }] },
      expectedOfferId: "matrix-offer", batchHasPartialOutcome: false,
    });
    assert.notEqual(classified.classification, "EXPLICIT_CATEGORY_FAILURE");
    const { service, calls } = failureMatrixRecoveryHarness({
      basisClassification: classified.classification,
    });
    await assert.rejects(service.recover(request), (error) =>
      error.code === "AUTO_LISTING_CATEGORY_RECOVERY_NOT_ELIGIBLE" && error.cause === null);
    assert.deepEqual(calls, ["load"], `${errorCode} stops before store, Ozon, attempt, and retry ports`);
  }
  let secondFailureApply = null;
  const secondFailureReconciler = createAutoListingSubmissionReconciler({ repository: {
    async loadReconciliationEvidence(input) {
      return {
        accountId: input.accountId, jobId: "matrix-auto-job", itemId: input.itemId,
        itemStatus: "UPLOADING", itemStatusVersion: 2,
        submissionLinkId: input.submissionLinkId, submissionLinkStatus: "SUBMITTED",
        submissionJobId: "matrix-job", submission: {
          id: "matrix-job", accountId: input.accountId, status: "FAILED",
          ozonTaskId: "matrix-retry-task", errorCode: "OZON_ITEM_RESULT",
          successCount: 0, failedCount: 1, skippedCount: 0,
          resultSummary: { success: 0, failed: 1, skipped: 0, stockCount: 0 },
          items: [{ offerId: "matrix-offer", status: "FAILED", productId: null,
            errorCode: "OZON_ITEM_RESULT" }],
          categoryRecovery: {
            attemptId: "matrix-attempt", status: "NEEDS_REVIEW",
            originalOzonTaskId: "matrix-original-task", retryOzonTaskId: "matrix-retry-task",
            oldSharedCategoryVersion: 1, replacementSharedCategoryVersion: 3,
          },
        },
      };
    },
    async applyReconciliation(input) { secondFailureApply = input; return {
      itemId: input.itemId, status: input.itemStatus, statusVersion: 3,
      linkStatus: input.linkStatus, duplicate: false,
    }; },
  } });
  const secondFailure = await secondFailureReconciler.reconcile({
    accountId: "matrix-account", itemId: "matrix-item", submissionLinkId: "matrix-link",
    correlationId: "matrix-second-failure",
  });
  assert.equal(secondFailure.status, "BLOCKED");
  assert.equal(secondFailureApply.allowResubmission, false);
  assert.equal(secondFailureApply.enqueueNextCheck, false);
});

if (!enabled) {
  test("Task 10 E2E requires two disposable PostgreSQL 16 databases", {
    skip: "set ACCOUNT_SHARED_CATEGORY_RECOVERY_E2E=1 and both disposable database URLs",
  }, () => {});
} else {
  test("001-073 account-shared category and one recovery use real PG and loopback-only Ozon", { timeout: 180_000 }, async () => {
    assert.ok(sourceUrl && restoreUrl && sourceContainer && restoreContainer, "two disposable DB/container identities are required");
    const pool = new Pool({ connectionString: sourceUrl });
    const client = await pool.connect();
    const schema = `task10_e2e_${crypto.randomUUID().replaceAll("-", "")}`;
    const fake = await listenFakeOzon();
    process.env.OZON_API_BASE = fake.baseUrl;
    let ids = 0;
    try {
      await client.query(`CREATE SCHEMA ${q(schema)}`);
      await client.query(`SET search_path TO ${q(schema)}, public`);
      await applyMigrations(client, 73);
      await client.query("CREATE TABLE schema_migrations(version TEXT PRIMARY KEY,applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
      for (const migration of await migrationFiles(73)) {
        await client.query("INSERT INTO schema_migrations(version) VALUES($1)", [migration.replace(/\.sql$/u, "")]);
      }
      const accountA = `account-a-${schema}`;
      const accountB = `account-b-${schema}`;
      const storeA = `store-a-${schema}`;
      const storeB = `store-b-${schema}`;
      await client.query("INSERT INTO accounts(id,username,display_name,role,status) VALUES($1,$1,$1,'admin','active'),($2,$2,$2,'admin','active')", [accountA, accountB]);
      await client.query("INSERT INTO stores(id,label,company_name,client_id,status,owner_account_id) VALUES($1,$1,$1,$1,'active',$3),($2,$2,$2,$2,'active',$3)", [storeA, storeB, accountA]);
      const db = scopedPool(pool, schema);
      const categoryRepository = createPostgresAccountSharedOzonCategoryRepository({
        pool: db, idFactory: () => `category-${schema}-${++ids}`, now: () => "2026-08-12T00:00:00.000Z",
      });
      let lookupCalls = 0;
      const categoryService = createAccountSharedOzonCategoryService({
        repository: categoryRepository,
        sourceLookup: { async lookup() { lookupCalls += 1; await fake.post("/v3/product/info/list", { offer_id: "missing" }); return { status: "UNRESOLVED" }; } },
      });
      const { createAccountSharedOzonCategoryRuntime } = await import(
        `../account-shared-ozon-category-runtime.mjs?task10=${schema}`
      );
      const runtime = createAccountSharedOzonCategoryRuntime({
        loadState: async () => ({}), saveState: async () => {}, stateTransaction: { run: (operation) => operation() },
        persistenceMode: () => "postgres", postgresPool: async () => db,
        initializePostgresRepository: async () => categoryRepository,
        now: () => new Date("2026-08-12T01:00:00.000Z"), randomUUID: () => `runtime-${schema}-${++ids}`,
      });
      const pipelineUrl = new URL(sourceUrl);
      pipelineUrl.searchParams.set("options", `-c search_path=${schema},public`);
      process.env.DATABASE_URL = pipelineUrl.toString();
      process.env.LISTING_PIPELINE_V3 = "1";
      process.env.QH_LOCAL_NO_DOTENV = "1";
      const { ingestCollectRequestV4 } = await import(`../collection-pipeline.mjs?task10=${schema}`);
      const collectThroughProduction = async (sku, requestId) => ingestCollectRequestV4({
        authenticatedAccount: { id: accountA }, categoryEvidencePort: runtime,
        input: {
          source: "ozon", sourceSku: sku, requestId,
          sourceUrl: `https://source.invalid/${sku}`, capturedAt: "2026-08-12T00:00:00.000Z",
          payload: {
            sku, offerId: "offer-a", offer_id: "offer-a", name: "Frozen item",
            price: "100.00", currency: "RUB", currency_code: "RUB",
            blackKopecks: "10000", greenKopecks: "8000",
            images: ["https://cdn.example.test/item.jpg"], primary_image: "https://cdn.example.test/item.jpg",
            logistics: { weightG: 500, lengthMm: 200, widthMm: 100, heightMm: 50 },
            sourceCategory: { descriptionCategoryId: 10, typeIdCandidate: 20, path: ["root", "leaf"] },
            attributes: [{ complex_id: 0, id: 1, values: [{ value: "safe" }] }],
          },
        },
      });
      const collectedA = await collectThroughProduction("sku-a", `collect-a-${schema}`);
      const collectedB = await collectThroughProduction("sku-b", `collect-b-${schema}`);
      const loadProductionSource = async (collectItemId) => {
        const row = (await db.query(`SELECT item.id AS collect_item_id,draft.id AS product_draft_id,
          draft.version AS product_draft_version,raw.id AS raw_response_ref,raw.payload_hash,
          COALESCE(raw.collected_at,raw.created_at) AS captured_at,item.source_sku
          FROM collect_items AS item JOIN product_drafts AS draft ON draft.id=item.current_draft_id
          JOIN collect_raw_payloads AS raw ON raw.id=draft.source_payload_id
          WHERE item.account_id=$1 AND item.id=$2`, [accountA, collectItemId])).rows[0];
        return {
          accountId: accountA, collectItemId: row.collect_item_id,
          sourceVersion: `draft:${Number(row.product_draft_version)}`,
          productDraftId: row.product_draft_id, productDraftVersion: Number(row.product_draft_version),
          ozonProductId: null, sourceSku: row.source_sku, taxonomyScope: "OZON:DEFAULT",
          sourceDescriptionCategoryId: 10, sourceTypeId: 20,
          normalizedPath: ["root", "leaf"], attributeSummary: [],
          capturedAt: new Date(row.captured_at).toISOString(),
          rawResponseRef: row.raw_response_ref, rawResponseHash: row.payload_hash,
        };
      };
      const sourceA = await loadProductionSource(collectedA.collectItemId);
      const sourceB = await loadProductionSource(collectedB.collectItemId);
      assert.equal((await db.query("SELECT COUNT(*)::int AS count FROM collect_requests WHERE account_id=$1 AND status='SUCCEEDED'", [accountA])).rows[0].count, 2,
        "both sources pass through the production collection pipeline");
      const [recordedA] = await runtime.readForItems({ accountId: accountA, collectItemIds: [sourceA.collectItemId] });
      assert.equal(recordedA.categoryResolution.status, "ACTIVE");
      assert.equal((await db.query("SELECT COUNT(*)::int AS count FROM account_ozon_shared_categories")).rows[0].count, 1, "two stores reuse one account-shared row");
      assert.deepEqual(await categoryService.readForItems({ accountId: accountB, collectItemIds: [sourceA.collectItemId] }), [], "cross-account read fails closed before transport");
      assert.equal(lookupCalls, 0);
      const unresolved = await categoryService.resolveCollectionSource({ ...sourceA, sourceDescriptionCategoryId: null, sourceTypeId: null, lookupContext: { accountId: accountA, offerId: "missing" } });
      assert.equal(unresolved.categoryResolution.status, "NEEDS_REVIEW");
      assert.equal(lookupCalls, 1);
      assert.equal(fake.calls.filter((call) => call.path === "/v3/product/import").length, 0);

      const confirmation = {
        collectItemId: sourceA.collectItemId, expectedSourceVersion: "draft:1",
        descriptionCategoryId: 10, typeId: 20, taxonomyScope: "OZON:DEFAULT",
        idempotencyKey: `confirm-${schema}`, correlationId: `confirm-corr-${schema}`,
      };
      await assert.rejects(runtime.confirmManualCategory({ actor: { id: accountA, role: "user" }, ...confirmation }), (error) => error.code === "PERMISSION_FORBIDDEN");
      const confirmed = await runtime.confirmManualCategory({ actor: { id: accountA, role: "admin" }, ...confirmation });
      assert.equal(confirmed.categoryResolution.source, "MANUAL");
      assert.deepEqual(await runtime.confirmManualCategory({ actor: { id: accountA, role: "admin" }, ...confirmation }), confirmed, "manual confirmation is idempotently reusable");
      const exactConfirmationAudit = (await db.query(`SELECT *
        FROM account_ozon_category_confirmation_audit WHERE account_id=$1`, [accountA])).rows[0];
      assert.equal(Number(exactConfirmationAudit.provenance_version), 2);
      assert.ok(exactConfirmationAudit.manual_confirmation_evidence_id);
      await assert.rejects(db.query(`INSERT INTO account_ozon_category_confirmation_audit(
        id,account_id,collect_item_id,source_evidence_id,expected_source_version,
        selected_description_category_id,selected_type_id,taxonomy_scope,actor_id,
        correlation_id,idempotency_key,request_hash,result_json,confirmed_at,created_at,
        manual_confirmation_evidence_id,provenance_version)
        SELECT id||'-null',account_id,collect_item_id,source_evidence_id,expected_source_version,
          selected_description_category_id,selected_type_id,taxonomy_scope,actor_id,
          correlation_id,idempotency_key||'-null',request_hash,result_json,confirmed_at,created_at,
          NULL,2 FROM account_ozon_category_confirmation_audit WHERE id=$1`,
      [exactConfirmationAudit.id]), (error) => error?.code === "23514");
      const sourceBEvidence = (await db.query(`SELECT id FROM collect_ozon_category_source_evidence
        WHERE account_id=$1 AND collect_item_id=$2 ORDER BY captured_at DESC,id DESC LIMIT 1`,
      [accountA, sourceB.collectItemId])).rows[0].id;
      const auditAttacks = [
        { label: "cross-item", collectItemId: sourceB.collectItemId },
        { label: "cross-source", sourceEvidenceId: sourceBEvidence },
        { label: "cross-observation", manualEvidenceId: `manual-confirmation:v1:${"f".repeat(64)}` },
        { label: "selected-category", descriptionCategoryId: 11 },
        { label: "selected-type", typeId: 21 },
        { label: "actor", actorId: accountB },
        { label: "correlation", correlationId: `tampered-correlation-${schema}` },
        { label: "request-hash", requestHash: "f".repeat(64) },
        { label: "timestamp", confirmedAt: "2026-08-12T03:00:00.000Z" },
        { label: "source-version", expectedSourceVersion: "draft:999" },
      ];
      for (const attack of auditAttacks) {
        await assert.rejects(db.query(`INSERT INTO account_ozon_category_confirmation_audit(
          id,account_id,collect_item_id,source_evidence_id,expected_source_version,
          selected_description_category_id,selected_type_id,taxonomy_scope,actor_id,
          correlation_id,idempotency_key,request_hash,result_json,confirmed_at,created_at,
          manual_confirmation_evidence_id,provenance_version)
          SELECT id||'-'||$2,account_id,COALESCE($3,collect_item_id),COALESCE($4,source_evidence_id),
            COALESCE($5,expected_source_version),COALESCE($6,selected_description_category_id),
            COALESCE($7,selected_type_id),taxonomy_scope,COALESCE($8,actor_id),
            COALESCE($9,correlation_id),idempotency_key||'-'||$2,COALESCE($10,request_hash),
            result_json,COALESCE($11::timestamptz,confirmed_at),COALESCE($11::timestamptz,created_at),
            COALESCE($12,manual_confirmation_evidence_id),2
          FROM account_ozon_category_confirmation_audit WHERE id=$1`,
        [exactConfirmationAudit.id, attack.label, attack.collectItemId ?? null,
          attack.sourceEvidenceId ?? null, attack.expectedSourceVersion ?? null,
          attack.descriptionCategoryId ?? null, attack.typeId ?? null, attack.actorId ?? null,
          attack.correlationId ?? null, attack.requestHash ?? null, attack.confirmedAt ?? null,
          attack.manualEvidenceId ?? null]), (error) => error?.code === "23514",
        attack.label);
      }
      const confirmationCounts = (await db.query(`SELECT
        (SELECT COUNT(*)::int FROM account_ozon_shared_categories) AS shared,
        (SELECT COUNT(*)::int FROM account_ozon_category_confirmation_audit) AS confirmations,
        (SELECT COUNT(*)::int FROM account_ozon_shared_category_events) AS events`)).rows[0];
      const confirmationTransportCalls = fake.calls.length;
      await assert.rejects(runtime.confirmManualCategory({
        actor: { id: accountB, role: "admin" }, ...confirmation, idempotencyKey: `foreign-${schema}`,
      }));
      assert.deepEqual((await db.query(`SELECT
        (SELECT COUNT(*)::int FROM account_ozon_shared_categories) AS shared,
        (SELECT COUNT(*)::int FROM account_ozon_category_confirmation_audit) AS confirmations,
        (SELECT COUNT(*)::int FROM account_ozon_shared_category_events) AS events`)).rows[0], confirmationCounts,
      "cross-account public confirmation cannot mutate category or audit state");
      assert.equal(fake.calls.length, confirmationTransportCalls,
        "cross-account public confirmation fails before Ozon transport");

      const current = (await db.query("SELECT * FROM account_ozon_shared_categories WHERE account_id=$1", [accountA])).rows[0];
      const sourceEvidence = (await db.query(`SELECT * FROM collect_ozon_category_source_evidence
        WHERE account_id=$1 AND collect_item_id=$2 AND id=$3`,
      [accountA, sourceA.collectItemId, current.source_evidence_id])).rows[0];
      const warehouseId = `warehouse-${schema}`;
      await db.query(`INSERT INTO warehouses(id,store_id,warehouse_id,warehouse_type,status,is_active,is_archived)
        VALUES($1,$2,'platform-fbs-a','FBS','active',TRUE,FALSE)`, [warehouseId, storeA]);
      await db.query(`INSERT INTO products(id,store_id,product_id,sku,offer_id,name,status,is_archived)
        VALUES($1,$2,$3,'existing-sku','existing-offer','Existing active product','active',FALSE)`,
      [`product-${schema}`, storeA, `existing-product-${schema}`]);
      await db.query(`INSERT INTO product_stocks(product_id,warehouse_id,store_id,sku,offer_id,source,present)
        VALUES($1,$2,$3,'existing-sku','existing-offer','fbs',1)`,
      [`product-${schema}`, warehouseId, storeA]);
      process.env.APP_ENCRYPTION_KEY = `task10-loopback-key-${schema}`;
      process.env.APP_ENCRYPTION_KEY_VERSION = "task10-v1";
      const encrypted = encryptSecret("loopback-api-key");
      await db.query(`INSERT INTO store_credentials(store_id,client_id,encrypted_api_key,iv,auth_tag,algorithm,key_version)
        VALUES($1,$1,$2,$3,$4,$5,$6)`, [storeA, encrypted.ciphertext, encrypted.iv,
        encrypted.authTag, encrypted.algorithm, encrypted.keyVersion]);

      const listedSource = autoListingSource({ source: sourceA, accountId: accountA,
        evidence: sourceEvidence, shared: current });
      const { createAutoListingListingBasePreparer } = await import(
        `../auto-listing-listing-base-preparer.mjs?task10=${schema}`
      );
      const preparer = createAutoListingListingBasePreparer({
        loadStoreAccess: async () => ({ id: storeA, ownerAccountId: accountA, clientId: storeA,
          apiKey: "loopback-api-key", currencyCode: "RUB" }),
        categoryService: {
          async getCategoryAttributes() { return { items: [
            { id: 1, is_required: true }, { id: 11254 },
          ] }; },
          async getCategoryAttributeValues() { return { items: [] }; },
        },
      });
      const autoHarness = productionAutoListingHarness({ source: listedSource, accountId: accountA,
        storeId: storeA, warehouseId, listingBasePreparer: preparer });
      const foreignAutoCalls = autoHarness.calls.length;
      const foreignAutoTransportCalls = fake.calls.length;
      await assert.rejects(autoHarness.service.createAutoListingJob({
        actor: { id: accountB, role: "user" }, collectItemIds: [sourceA.collectItemId],
        idempotencyKey: `foreign-auto-${schema}`, correlationId: `foreign-corr-${schema}`,
        config: { targetStoreId: storeA, targetWarehouseId: warehouseId, stock: 5,
          priceAdjustmentKopecks: "0" },
      }));
      assert.equal(autoHarness.calls.some(([name], index) => index >= foreignAutoCalls && name === "createJobGraph"), false);
      assert.equal(fake.calls.length, foreignAutoTransportCalls,
        "cross-account auto listing fails before category/Ozon transport");
      const autoJob = await autoHarness.service.createAutoListingJob({
        actor: { id: accountA, role: "user" }, collectItemIds: [sourceA.collectItemId],
        idempotencyKey: `auto-job-${schema}`, correlationId: `auto-corr-${schema}`,
        config: { targetStoreId: storeA, targetWarehouseId: warehouseId, stock: 5,
          priceAdjustmentKopecks: "0" },
      });
      assert.equal(autoJob.jobId, "auto-job-a");
      const autoGraph = autoHarness.graph;
      assert.ok(autoHarness.calls.some(([name]) => name === "createJobGraph"));
      const listingBase = autoGraph.items[0].listingBaseTemplate;
      const item = listingBase.variants[0].item;

      const pipeline = await import(`../listing-pipeline.mjs?task10=${schema}`);
      let worker = await import(`../listing-worker.mjs?task10=${schema}`);
      const publishPersistedOutbox = async ({ dedupeKey = null, eventType = null }) => {
        const result = await db.query(`SELECT id,event_type,payload,dedupe_key,status
          FROM outbox_events
          WHERE aggregate_id=$1
            AND ($2::text IS NULL OR dedupe_key=$2)
            AND ($3::text IS NULL OR event_type=$3)
            AND status='PENDING'
          ORDER BY created_at DESC,id DESC`, [jobId, dedupeKey, eventType]);
        assert.equal(result.rows.length, 1,
          `exactly one persisted queue message must be eligible: ${JSON.stringify(result.rows)}`);
        const [event] = result.rows;
        await pipeline.markOutboxPublishedV3(event.id);
        const published = (await db.query("SELECT status,published_at FROM outbox_events WHERE id=$1", [event.id])).rows[0];
        assert.equal(published.status, "PUBLISHED");
        assert.ok(published.published_at);
        return {
          submissionJobId: event.payload.submissionJobId,
          action: event.payload.action,
        };
      };
      const liveDraft = (await db.query(`SELECT draft.id,draft.version,draft.data_hash
        FROM collect_items AS item JOIN product_drafts AS draft ON draft.id=item.current_draft_id
        WHERE item.account_id=$1 AND item.id=$2`, [accountA, sourceA.collectItemId])).rows[0];
      const submission = await pipeline.createSubmissionV3({
        collectItem: listedSource.collectItem, storeId: storeA, accountId: accountA,
        targetStoreId: storeA, idempotencyKey: `task10-listing-${schema}`,
        normalizedItems: [item], stocks: [{ offer_id: "offer-a", warehouse_id: "platform-fbs-a", stock: 5 }],
        type: "AUTO_LISTING", versions: listingBase.versions,
        frozenProductDraft: { id: liveDraft.id, version: Number(liveDraft.version), dataHash: liveDraft.data_hash },
      });
      const jobId = submission.job.clientJobId;
      await worker.processListingQueueMessage(await publishPersistedOutbox({ eventType: "listing.submit.requested" }));
      await worker.processListingQueueMessage(await publishPersistedOutbox({ eventType: "listing.check.requested" }));
      const failedWork = await pipeline.loadSubmissionWorkV3(jobId);
      assert.equal(failedWork.status, "FAILED");
      assert.equal(failedWork.ozon_task_id, "task-original", JSON.stringify({
        job: failedWork, calls: fake.calls.map((call) => call.path),
      }));
      const snapshotId = failedWork.snapshot_id;
      const originalHash = (await db.query("SELECT snapshot_hash FROM submission_snapshots WHERE id=$1", [snapshotId])).rows[0].snapshot_hash;
      const frozenItems = (await db.query("SELECT items FROM submission_snapshots WHERE id=$1", [snapshotId])).rows[0].items;
      const itemId = (await db.query("SELECT id FROM submission_items WHERE job_id=$1", [jobId])).rows[0].id;
      const recoveryRepository = createAutoListingCategoryRecoveryPostgres({ pool: db, idFactory: () => `attempt-${schema}`, now: () => "2026-08-12T02:00:00.000Z" });
      const disabledInput = {
        accountId: accountA, jobId, snapshotId, itemId, offerId: "offer-a", originalOzonTaskId: "task-original",
        policyVersion: "ozon-category-policy.v2", safeEvidence: historicalEvidence(), sourceEvidenceId: sourceEvidence.id,
        oldSharedCategoryId: current.id, oldSharedCategoryVersion: Number(current.version), originalSnapshotHash: originalHash,
      };
      assert.equal(projectProductionOzonImportErrorEvidence(historicalEvidence()), null);
      assert.notEqual(classifyOzonCategoryImportResult({ item: { offer_id: "offer-a", errors: [{ code: "CATEGORY_INVALID" }] }, expectedOfferId: "offer-a", batchHasPartialOutcome: false }).classification, "EXPLICIT_CATEGORY_FAILURE");
      await assert.rejects(recoveryRepository.recordCategoryErrorEvidence(disabledInput), (error) => error.code === "AUTO_LISTING_CATEGORY_RECOVERY_POLICY_DISABLED");
      // The production V1 classifier is intentionally empty. This single write represents an
      // already-persisted historical V2 terminal-evidence carrier; all recovery state after it
      // must be created and advanced exclusively through production services and workers.
      const historicalCarrier = {
        schemaVersion: "OZON_SUBMISSION_ITEM_RESPONSE_V1", rawResponse: {},
        errorEvidence: historicalEvidence(),
      };
      const seededHistoricalCarrier = await db.query(`UPDATE submission_items
        SET response=$1::jsonb
        WHERE id=$2 AND job_id=$3 AND snapshot_id=$4 AND status='FAILED'
          AND NULLIF(BTRIM(product_id),'') IS NULL AND response->'errorEvidence'='null'::jsonb`,
      [JSON.stringify(historicalCarrier), itemId, jobId, snapshotId]);
      assert.equal(seededHistoricalCarrier.rowCount, 1, "the sole test-only exception seeds exact historical terminal evidence");
      const evidenceId = `evidence-${schema}`;
      await db.query(`INSERT INTO submission_category_error_evidence(
        id,account_id,submission_job_id,submission_snapshot_id,submission_item_id,offer_id,original_ozon_task_id,
        original_snapshot_hash,original_items,source_evidence_id,old_shared_category_id,old_shared_category_version,
        classifier_policy_version,safe_evidence) VALUES($1,$2,$3,$4,$5,'offer-a','task-original',$6,$7::jsonb,$8,$9,$10,'ozon-category-policy.v2',$11::jsonb)`,
      [evidenceId, accountA, jobId, snapshotId, itemId, originalHash, JSON.stringify(frozenItems), sourceEvidence.id, current.id, Number(current.version), JSON.stringify(historicalEvidence())]);
      const metadata = { descriptionCategoryId: 30, typeId: 40, attributes: [{ id: 1, complexId: 0, required: true, dictionaryId: null, dictionaryValues: [] }] };
      const recovery = createAutoListingCategoryRecoveryService({
        repository: recoveryRepository,
        loadOperatingStoreAccess: async () => ({ accountId: accountA, storeId: storeA, fixture: "loopback-only" }),
        confirmOfferAbsent: async ({ offers }) => { const response = await fake.post("/v3/product/info/list", { offer_id: offers[0].offerId }); return response.items.length === 0 ? { status: "ABSENT", code: "OZON_OFFERS_CONFIRMED_ABSENT" } : { status: "PRESENT", code: "OZON_OFFER_PRESENT" }; },
        invalidateSharedCategory: (input) => categoryRepository.invalidateSharedCategory(input),
        refreshCategory: async () => { await fake.post("/v1/description-category/tree", { source: [10, 20] }); return { kind: "UNIQUE_MATCH", descriptionCategoryId: 30, typeId: 40, taxonomyFingerprint: "c".repeat(64), metadata }; },
        rebuildItems: ({ originalItems, replacementCategory, currentCategoryMetadata }) => rebuildOzonItemsForCategory({
          originalItems,
          sourceEvidenceAttributes: originalItems.map((entry) => entry.attributes),
          replacementCategory: {
            kind: replacementCategory.kind,
            descriptionCategoryId: replacementCategory.descriptionCategoryId,
            typeId: replacementCategory.typeId,
          },
          currentCategoryMetadata,
        }),
        activateRefreshedCategory: (input) => categoryRepository.activateRefreshedCategory(input),
        markSharedNeedsReview: (input) => categoryRepository.markSharedNeedsReview(input),
        scheduleRetry: pipeline.scheduleSubmissionCategoryRetryV3,
        now: () => "2026-08-12T02:00:00.000Z",
      });
      const request = { accountId: accountA, jobId, evidenceId, correlationId: failedWork.correlation_id };
      const foreignRecoveryCalls = fake.calls.length;
      await assert.rejects(recovery.recover({ ...request, accountId: accountB }), (error) =>
        error.code === "AUTO_LISTING_CATEGORY_RECOVERY_NOT_FOUND"
          && error.status === 404 && error.cause === null);
      assert.equal((await db.query("SELECT COUNT(*)::int AS count FROM submission_category_recovery_attempts WHERE submission_job_id=$1", [jobId])).rows[0].count, 0);
      assert.equal(fake.calls.length, foreignRecoveryCalls,
        "cross-account recovery fails before offer/category/Ozon transport");
      const pending = await recovery.recover(request);
      const attempt = (await db.query("SELECT * FROM submission_category_recovery_attempts WHERE account_id=$1 AND submission_job_id=$2", [accountA, jobId])).rows[0];
      assert.equal(pending.status, "RETRY_PENDING", JSON.stringify({ pending, attempt }));
      assert.equal(attempt.status, "RETRY_PENDING");
      assert.equal(attempt.corrected_items[0].description_category_id, 30);
      assert.deepEqual(Object.fromEntries(Object.entries(attempt.corrected_items[0]).filter(([key]) => !["description_category_id", "type_id", "attributes", "complex_attributes"].includes(key))), Object.fromEntries(Object.entries(frozenItems[0]).filter(([key]) => !["description_category_id", "type_id", "attributes", "complex_attributes"].includes(key))));
      const retrySchedule = (await db.query(`SELECT event_type,payload FROM submission_events
        WHERE job_id=$1 AND event_type='submission.category_retry_scheduled'`, [jobId])).rows;
      assert.deepEqual(retrySchedule, [{
        event_type: "submission.category_retry_scheduled",
        payload: { attemptId: attempt.id, correctedItemsHash: attempt.corrected_items_hash,
          correlationId: failedWork.correlation_id },
      }]);
      const retryOutbox = (await db.query(`SELECT event_type,payload,dedupe_key FROM outbox_events
        WHERE aggregate_id=$1 AND dedupe_key=$2`, [jobId, `${jobId}:category-retry:${attempt.id}`])).rows;
      assert.deepEqual(retryOutbox, [{
        event_type: "listing.submit.requested",
        payload: { submissionJobId: jobId, action: "submit" },
        dedupe_key: `${jobId}:category-retry:${attempt.id}`,
      }], `the retry queue identity is bound to the persisted recovery attempt: ${JSON.stringify(
        (await db.query("SELECT id,aggregate_id,event_type,payload,dedupe_key,status FROM outbox_events ORDER BY created_at,id")).rows,
      )}`);
      worker = null;
      const restartedRetrySubmitWorker = await import(`../listing-worker.mjs?task10-retry-submit=${schema}`);
      const retrySubmitMessage = await publishPersistedOutbox({ dedupeKey: `${jobId}:category-retry:${attempt.id}` });
      await restartedRetrySubmitWorker.processListingQueueMessage(retrySubmitMessage);
      const countsAtRetryAcceptance = {
        evidence: (await db.query("SELECT COUNT(*)::int AS count FROM submission_category_error_evidence WHERE submission_job_id=$1", [jobId])).rows[0].count,
        attempts: (await db.query("SELECT COUNT(*)::int AS count FROM submission_category_recovery_attempts WHERE submission_job_id=$1", [jobId])).rows[0].count,
        imports: fake.calls.filter((call) => call.path === "/v3/product/import").length,
        stocks: fake.calls.filter((call) => call.path === "/v2/products/stocks").length,
      };
      const restartedRetryCheckWorker = await import(`../listing-worker.mjs?task10-retry-check=${schema}`);
      const retryCheckMessage = await publishPersistedOutbox({ eventType: "listing.check.requested" });
      await restartedRetryCheckWorker.processListingQueueMessage(retrySubmitMessage);
      await restartedRetryCheckWorker.processListingQueueMessage(retryCheckMessage);
      await restartedRetryCheckWorker.processListingQueueMessage(retryCheckMessage);
      const replay = await recovery.recover(request);
      assert.equal(replay.status, "SUCCEEDED");
      assert.equal(fake.calls.filter((call) => call.path === "/v3/product/import").length, 2);
      assert.equal(fake.calls.filter((call) => call.path === "/v2/products/stocks").length, 1);
      assert.equal((await db.query("SELECT COUNT(*)::int AS count FROM submission_category_error_evidence WHERE account_id=$1 AND submission_job_id=$2", [accountA, jobId])).rows[0].count, 1);
      assert.equal((await db.query("SELECT COUNT(*)::int AS count FROM submission_category_recovery_attempts WHERE account_id=$1 AND submission_job_id=$2", [accountA, jobId])).rows[0].count, 1);
      assert.equal((await db.query("SELECT COUNT(*)::int AS count FROM submission_category_recovery_item_results WHERE account_id=$1 AND submission_job_id=$2", [accountA, jobId])).rows[0].count, 1);
      assert.deepEqual({
        evidence: (await db.query("SELECT COUNT(*)::int AS count FROM submission_category_error_evidence WHERE submission_job_id=$1", [jobId])).rows[0].count,
        attempts: (await db.query("SELECT COUNT(*)::int AS count FROM submission_category_recovery_attempts WHERE submission_job_id=$1", [jobId])).rows[0].count,
        imports: fake.calls.filter((call) => call.path === "/v3/product/import").length,
        stocks: fake.calls.filter((call) => call.path === "/v2/products/stocks").length,
      }, { ...countsAtRetryAcceptance, stocks: 1 },
      "a cache-busted worker restart resumes the exact retry without growing evidence, attempt, or import counts");
      const original = (await db.query("SELECT status,product_id,response FROM submission_items WHERE id=$1", [itemId])).rows[0];
      assert.equal(original.status, "FAILED");
      assert.equal(original.product_id, "");
      const succeededWork = await pipeline.loadSubmissionWorkV3(jobId);
      assert.equal(succeededWork.status, "SUCCEEDED");
      const productImportCalls = fake.calls.filter((call) => call.path === "/v3/product/import");
      assert.equal(productImportCalls.length, 2);
      assert.deepEqual(productImportCalls[0].body, { items: frozenItems },
        "the standard import uses the immutable production snapshot");
      assert.deepEqual(productImportCalls[1].body, { items: attempt.corrected_items },
        "the retry import uses only the attempt's persisted corrected items");
      for (const call of productImportCalls) {
        assert.equal(call.clientId, storeA, "standard and retry imports use the same frozen store credential");
        assert.equal(call.apiKeyPresent, true);
        assert.notEqual(call.clientId, storeB);
      }
      const stockCalls = fake.calls.filter((call) => call.path === "/v2/products/stocks");
      assert.deepEqual(stockCalls.map(({ clientId, apiKeyPresent, body }) => ({ clientId, apiKeyPresent, body })), [{
        clientId: storeA, apiKeyPresent: true,
        body: { stocks: [{ offer_id: "offer-a", warehouse_id: "platform-fbs-a", stock: 5 }] },
      }], "stock continuation preserves the exact store, offer, platform warehouse, and quantity");
      const stockIntent = (await db.query(`SELECT * FROM submission_stock_write_intents
        WHERE account_id=$1 AND submission_job_id=$2`, [accountA, jobId])).rows;
      assert.equal(stockIntent.length, 1);
      assert.deepEqual({
        accountId: stockIntent[0].account_id,
        jobId: stockIntent[0].submission_job_id,
        snapshotId: stockIntent[0].submission_snapshot_id,
        storeId: stockIntent[0].store_id,
        importTaskId: stockIntent[0].import_ozon_task_id,
        recoveryAttemptId: stockIntent[0].recovery_attempt_id,
        correlationId: stockIntent[0].correlation_id,
        status: stockIntent[0].status,
        stocks: stockIntent[0].stock_items,
      }, {
        accountId: accountA, jobId, snapshotId, storeId: storeA,
        importTaskId: "task-retry", recoveryAttemptId: attempt.id,
        correlationId: failedWork.correlation_id, status: "DONE",
        stocks: [{ submissionItemId: itemId, offerId: "offer-a",
          warehouseId: "platform-fbs-a", quantity: 5 }],
      });
      assert.deepEqual((await db.query(`SELECT from_status,to_status,event_type
        FROM submission_stock_write_events WHERE account_id=$1 AND stock_write_intent_id=$2
        ORDER BY id`, [accountA, stockIntent[0].id])).rows, [
        { from_status: "", to_status: "PREPARED", event_type: "submission.stock_write_prepared" },
        { from_status: "PREPARED", to_status: "IN_FLIGHT", event_type: "submission.stock_write_started" },
        { from_status: "IN_FLIGHT", to_status: "DONE", event_type: "submission.stock_write_done" },
      ]);
      const terminalAttempt = (await db.query(`SELECT * FROM submission_category_recovery_attempts
        WHERE account_id=$1 AND submission_job_id=$2`, [accountA, jobId])).rows[0];
      assert.deepEqual({
        id: terminalAttempt.id, accountId: terminalAttempt.account_id,
        jobId: terminalAttempt.submission_job_id, snapshotId: terminalAttempt.submission_snapshot_id,
        evidenceId: terminalAttempt.triggering_error_evidence_id,
        originalTaskId: terminalAttempt.original_ozon_task_id,
        retryTaskId: terminalAttempt.retry_ozon_task_id,
        correlationId: terminalAttempt.correlation_id, status: terminalAttempt.status,
      }, {
        id: attempt.id, accountId: accountA, jobId, snapshotId,
        evidenceId, originalTaskId: "task-original", retryTaskId: "task-retry",
        correlationId: failedWork.correlation_id, status: "SUCCEEDED",
      });
      const child = (await db.query(`SELECT * FROM submission_category_recovery_item_results
        WHERE account_id=$1 AND submission_job_id=$2`, [accountA, jobId])).rows[0];
      assert.deepEqual({
        accountId: child.account_id, jobId: child.submission_job_id,
        snapshotId: child.submission_snapshot_id, attemptId: child.recovery_attempt_id,
        retryTaskId: child.retry_ozon_task_id, itemId: child.submission_item_id,
        offerId: child.offer_id, status: child.status,
      }, {
        accountId: accountA, jobId, snapshotId, attemptId: attempt.id,
        retryTaskId: "task-retry", itemId, offerId: "offer-a", status: "SUCCEEDED",
      });
      const queueHistory = (await db.query(`SELECT event_type,dedupe_key,status,published_at
        FROM outbox_events WHERE aggregate_id=$1
          AND event_type IN ('listing.submit.requested','listing.check.requested')
        ORDER BY created_at,id`, [jobId])).rows;
      assert.equal(queueHistory.length, 4);
      assert.equal(queueHistory.every((event) => event.status === "PUBLISHED" && event.published_at), true,
        "the production relay lifecycle retains an immutable delivered outbox history");
      assert.equal(queueHistory.some((event) => event.dedupe_key === `${jobId}:category-retry:${attempt.id}`), true,
        "the delivered retry remains durably tied to the persisted attempt identity");
      let reconciled = null;
      const { createAutoListingSubmissionReconciler: createRestartedReconciler } = await import(
        `../auto-listing-submission-reconciler.mjs?task10-restart=${schema}`
      );
      const reconciler = createRestartedReconciler({ repository: {
        async loadReconciliationEvidence(input) {
          return {
            accountId: input.accountId, jobId: autoJob.jobId, itemId: input.itemId,
            itemStatus: "UPLOADING", itemStatusVersion: 1,
            submissionLinkId: input.submissionLinkId, submissionLinkStatus: "SUBMITTED",
            submissionJobId: jobId,
            submission: {
              id: jobId, accountId: input.accountId, status: succeededWork.status,
              ozonTaskId: "task-retry", errorCode: null, successCount: 1, failedCount: 0,
              skippedCount: 0, resultSummary: { success: 1, failed: 0, skipped: 0, stockCount: 1 },
              items: [{ offerId: "offer-a", status: "SUCCEEDED", productId: "101" }],
              categoryRecovery: {
                attemptId: attempt.id, status: "SUCCEEDED", originalOzonTaskId: "task-original",
                retryOzonTaskId: "task-retry", oldSharedCategoryVersion: Number(attempt.old_shared_category_version),
                replacementSharedCategoryVersion: Number(attempt.replacement_shared_category_version),
              },
            },
          };
        },
        async applyReconciliation(input) {
          reconciled = input;
          return { itemId: input.itemId, status: input.itemStatus, statusVersion: 2,
            linkStatus: input.linkStatus, duplicate: false };
        },
      } });
      const reconciliation = await reconciler.reconcile({
        accountId: accountA, itemId: "auto-item-a", submissionLinkId: "submission-link-a",
        correlationId: `reconcile-${schema}`,
      });
      assert.equal(reconciliation.status, "SUCCEEDED");
      assert.equal(reconciled.allowResubmission, false,
        "response-loss reconciliation never submits a third product import");
      assert.equal(reconciled.summary.categoryRecovery.retryOzonTaskId, "task-retry");
      assert.equal(fake.calls.filter((call) => call.path === "/v3/product/import").length, 2);
      assert.equal(fake.calls.some((call) => /match/i.test(call.path)), false, "no store-category matching endpoint is used");

      const runWorkerFailure = async ({ label, scenario, expectedStatus,
        stocks = [{ warehouse_id: "platform-fbs-a", stock: 5 }], expectedStockCalls = 0 }) => {
        const offerId = `matrix-${label}-${schema}`;
        fake.state.scenarios.set(offerId, scenario);
        const beforeImport = fake.calls.filter((call) => call.path === "/v3/product/import").length;
        const beforeStock = fake.calls.filter((call) => call.path === "/v2/products/stocks").length;
        const matrixItem = { ...item, offer_id: offerId, sku: `${label}-sku` };
        const matrixSubmission = await pipeline.createSubmissionV3({
          collectItem: listedSource.collectItem, storeId: storeA, accountId: accountA,
          targetStoreId: storeA, idempotencyKey: `task10-matrix-${label}-${schema}`,
          normalizedItems: [matrixItem], stocks: stocks.map((stock) => ({ ...stock, offer_id: offerId })),
          type: "AUTO_LISTING", versions: listingBase.versions,
          frozenProductDraft: { id: liveDraft.id, version: Number(liveDraft.version), dataHash: liveDraft.data_hash },
        });
        const matrixJobId = matrixSubmission.job.clientJobId;
        await restartedRetryCheckWorker.processListingQueueMessage({ submissionJobId: matrixJobId, action: "submit" });
        const afterSubmit = await pipeline.loadSubmissionWorkV3(matrixJobId);
        if (["OZON_ACCEPTED", "CHECKING", "RECONCILING"].includes(afterSubmit.status)) {
          await restartedRetryCheckWorker.processListingQueueMessage({ submissionJobId: matrixJobId, action: "check" });
        }
        const final = await pipeline.loadSubmissionWorkV3(matrixJobId);
        assert.equal(final.status, expectedStatus, `${label}: ${JSON.stringify(final)}`);
        assert.equal(fake.calls.slice().filter((call) => call.path === "/v3/product/import"
          && call.body?.items?.[0]?.offer_id === offerId).length, 1, `${label}: one real product import`);
        assert.equal(fake.calls.filter((call) => call.path === "/v3/product/import").length, beforeImport + 1);
        assert.equal((await db.query(`SELECT COUNT(*)::int AS count
          FROM submission_category_recovery_attempts WHERE submission_job_id=$1`, [matrixJobId])).rows[0].count, 0,
        `${label}: non-category failure creates no recovery attempt`);
        assert.equal((await db.query(`SELECT COUNT(*)::int AS count
          FROM submission_category_error_evidence WHERE submission_job_id=$1`, [matrixJobId])).rows[0].count, 0,
        `${label}: disabled production policy persists no category evidence`);
        const stockDelta = fake.calls.filter((call) => call.path === "/v2/products/stocks").length - beforeStock;
        assert.equal(stockDelta, expectedStockCalls, `${label}: exact stock transport count`);
        return { matrixJobId, offerId };
      };
      await runWorkerFailure({ label: "auth", scenario: { importHttpStatus: 401, errorCode: "AUTH_FAILED" }, expectedStatus: "FAILED" });
      await runWorkerFailure({ label: "throttle", scenario: { importHttpStatus: 429, errorCode: "THROTTLED" }, expectedStatus: "FAILED" });
      await runWorkerFailure({ label: "brand", scenario: { checkErrorCode: "BRAND_RESTRICTED" }, expectedStatus: "FAILED" });
      await runWorkerFailure({ label: "currency", scenario: { checkErrorCode: "CURRENCY_INVALID" }, expectedStatus: "FAILED" });
      const stockFailure = await runWorkerFailure({ label: "stock", scenario: { stockHttpStatus: 503, errorCode: "STOCK_INVALID" },
        expectedStatus: "PARTIAL_SUCCESS", expectedStockCalls: 1 });
      const stockCounts = {
        imports: fake.calls.filter((call) => call.path === "/v3/product/import").length,
        stocks: fake.calls.filter((call) => call.path === "/v2/products/stocks").length,
      };
      await restartedRetryCheckWorker.processListingQueueMessage({ submissionJobId: stockFailure.matrixJobId, action: "submit" });
      await restartedRetryCheckWorker.processListingQueueMessage({ submissionJobId: stockFailure.matrixJobId, action: "check" });
      assert.deepEqual({
        imports: fake.calls.filter((call) => call.path === "/v3/product/import").length,
        stocks: fake.calls.filter((call) => call.path === "/v2/products/stocks").length,
      }, stockCounts, "stock-only partial replay never reimports or repeats stock");
    } finally {
      await client.query(`DROP SCHEMA IF EXISTS ${q(schema)} CASCADE`).catch(() => {});
      client.release();
      await pool.end();
      await fake.close();
    }
  });

  test("063 is destructive, preflight rollback is atomic, and a dump restores the old schema in database two", { timeout: 180_000 }, async () => {
    assert.ok(sourceUrl && restoreUrl && sourceContainer && restoreContainer);
    const sourcePool = new Pool({ connectionString: sourceUrl });
    const restorePool = new Pool({ connectionString: restoreUrl });
    const sourceClient = await sourcePool.connect();
    const restoreClient = await restorePool.connect();
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const upgradeSchema = `task10_upgrade_${suffix}`;
    const rejectedSchema = `task10_rejected_${suffix}`;
    const restoredSchema = `task10_restored_${suffix}`;
    const temp = await mkdtemp(path.join(os.tmpdir(), "task10-category-restore-"));
    const dump = path.join(temp, "pre-upgrade.dump");
    try {
      await sourceClient.query(`CREATE SCHEMA ${q(upgradeSchema)}`);
      await sourceClient.query(`SET search_path TO ${q(upgradeSchema)}, public`);
      await applyMigrations(sourceClient, 62);
      const account = `account-${suffix}`;
      const store = `store-${suffix}`;
      const secondStore = `store-two-${suffix}`;
      const source = await (async () => {
        await sourceClient.query("INSERT INTO accounts(id,username,display_name,role,status) VALUES($1,$1,$1,'admin','active')", [account]);
        await sourceClient.query("INSERT INTO stores(id,label,company_name,client_id,status,owner_account_id) VALUES($1,$1,$1,$1,'active',$3),($2,$2,$2,$2,'active',$3)", [store, secondStore, account]);
        return seedLegacyPreUpgradeCollection(sourceClient, { accountId: account, storeId: store, collectId: `collect-${suffix}`, rawId: `raw-${suffix}`, draftId: `draft-${suffix}`, sku: "sku-old" });
      })();
      const secondSource = await seedLegacyPreUpgradeCollection(sourceClient, { accountId: account, storeId: secondStore,
        collectId: `collect-two-${suffix}`, rawId: `raw-two-${suffix}`, draftId: `draft-two-${suffix}`, sku: "sku-two" });
      await sourceClient.query(`INSERT INTO collect_category_resolutions(id,account_id,collect_item_id,taxonomy_scope,source_type_id,target_description_category_id,target_type_id,method,status)
        VALUES($1,$2,$3,'OZON:DEFAULT',20,999,888,'legacy','MATCHED')`, [`legacy-${suffix}`, account, source.collectItemId]);
      await sourceClient.query(`INSERT INTO collect_category_resolutions(id,account_id,collect_item_id,taxonomy_scope,source_type_id,target_description_category_id,target_type_id,method,status)
        VALUES($1,$2,$3,'OZON:DEFAULT',20,777,666,'legacy-two','MATCHED')`,
      [`legacy-two-${suffix}`, account, secondSource.collectItemId]);
      await sourceClient.query("INSERT INTO audit_events(event_id,account_id,action,entity_type,entity_id) VALUES($1,$2,'TASK10_SENTINEL','test',$1)", [`audit-${suffix}`, account]);
      const snapshot = `snapshot-${suffix}`;
      const job = `job-${suffix}`;
      await sourceClient.query(`INSERT INTO submission_snapshots(
        id,collect_item_id,draft_id,draft_version,account_id,store_id,idempotency_key,snapshot_hash,item_count,items)
        VALUES($1,$2,$3,1,$4,$5,$6,$7,1,$8::jsonb)`,
      [snapshot, source.collectItemId, source.productDraftId, account, store, `idem-${suffix}`,
        canonicalSha([{ offer_id: "offer-a", sku: "sku-old" }]), JSON.stringify([{ offer_id: "offer-a", sku: "sku-old" }])]);
      await sourceClient.query(`INSERT INTO submission_jobs(
        id,snapshot_id,collect_item_id,account_id,store_id,status,item_count,correlation_id)
        VALUES($1,$2,$3,$4,$5,'QUEUE_PENDING',1,$6)`,
      [job, snapshot, source.collectItemId, account, store, `corr-${suffix}`]);
      await sourceClient.query(`INSERT INTO submission_events(job_id,to_status,event_type,message)
        VALUES($1,'QUEUE_PENDING','TASK10_HISTORY_SENTINEL','history survives')`, [job]);
      const databaseName = new URL(sourceUrl).pathname.slice(1);
      execFileSync("docker", ["exec", sourceContainer, "pg_dump", "-U", "postgres", "-d", databaseName, "-Fc", "-n", upgradeSchema, "-f", "/tmp/task10-pre-upgrade.dump"]);
      execFileSync("docker", ["cp", `${sourceContainer}:/tmp/task10-pre-upgrade.dump`, dump]);
      const migration063 = await readFile(path.join(migrationsDir, "063_account_shared_ozon_categories.sql"), "utf8");
      await sourceClient.query("BEGIN");
      await sourceClient.query(migration063);
      await sourceClient.query("COMMIT");
      assert.equal((await sourceClient.query("SELECT to_regclass('collect_category_resolutions') AS value")).rows[0].value, null);
      assert.equal((await sourceClient.query("SELECT current_description_category_id::int AS category FROM account_ozon_shared_categories")).rows[0].category, 10);
      assert.equal((await sourceClient.query("SELECT COUNT(*)::int AS count FROM account_ozon_shared_categories")).rows[0].count, 1,
        "two stores with conflicting retired targets collapse to one source-derived shared category");
      assert.equal((await sourceClient.query("SELECT COUNT(*)::int AS count FROM submission_jobs WHERE id=$1 AND status='QUEUE_PENDING'", [job])).rows[0].count, 1);
      assert.equal((await sourceClient.query("SELECT COUNT(*)::int AS count FROM submission_events WHERE job_id=$1 AND event_type='TASK10_HISTORY_SENTINEL'", [job])).rows[0].count, 1);
      assert.equal((await sourceClient.query("SELECT COUNT(*)::int AS count FROM audit_events WHERE event_id=$1", [`audit-${suffix}`])).rows[0].count, 1);
      for (const file of (await migrationFiles(72)).filter((name) => Number(name.slice(0, 3)) >= 64)) await sourceClient.query(await readFile(path.join(migrationsDir, file), "utf8"));

      await sourceClient.query(`CREATE SCHEMA ${q(rejectedSchema)}`);
      await sourceClient.query(`SET search_path TO ${q(rejectedSchema)}, public`);
      await applyMigrations(sourceClient, 62);
      await sourceClient.query("INSERT INTO accounts(id,username,display_name,role,status) VALUES($1,$1,$1,'admin','active')", [`bad-account-${suffix}`]);
      await sourceClient.query("INSERT INTO stores(id,label,company_name,client_id,status,owner_account_id) VALUES($1,$1,$1,$1,'active',$2)", [`bad-store-${suffix}`, `bad-account-${suffix}`]);
      const bad = await seedLegacyPreUpgradeCollection(sourceClient, { accountId: `bad-account-${suffix}`, storeId: `bad-store-${suffix}`, collectId: `bad-collect-${suffix}`, rawId: `bad-raw-${suffix}`, draftId: `bad-draft-${suffix}`, sku: "bad" });
      await sourceClient.query("UPDATE product_drafts SET data=$1::jsonb WHERE id=$2", [JSON.stringify({ sourceCategory: { descriptionCategoryId: -1, typeIdCandidate: 20 } }), bad.productDraftId]);
      await sourceClient.query("BEGIN");
      await assert.rejects(sourceClient.query(migration063), (error) => error.code === "23514");
      await sourceClient.query("ROLLBACK");
      assert.notEqual((await sourceClient.query("SELECT to_regclass('collect_category_resolutions') AS value")).rows[0].value, null);
      assert.equal((await sourceClient.query("SELECT to_regclass('account_ozon_shared_categories') AS value")).rows[0].value, null);

      const restoreDatabase = new URL(restoreUrl).pathname.slice(1);
      execFileSync("docker", ["cp", dump, `${restoreContainer}:/tmp/task10-pre-upgrade.dump`]);
      await restoreClient.query(`CREATE SCHEMA ${q(upgradeSchema)}`);
      execFileSync("docker", ["exec", restoreContainer, "pg_restore", "-U", "postgres", "-d", restoreDatabase, "--no-owner", "--no-privileges", "--schema", upgradeSchema, "/tmp/task10-pre-upgrade.dump"]);
      await restoreClient.query(`ALTER SCHEMA ${q(upgradeSchema)} RENAME TO ${q(restoredSchema)}`);
      await restoreClient.query(`SET search_path TO ${q(restoredSchema)}, public`);
      assert.equal((await restoreClient.query("SELECT target_description_category_id::int AS category FROM collect_category_resolutions WHERE id=$1", [`legacy-${suffix}`])).rows[0].category, 999);
      const oldRepository = execFileSync("git", ["show", "411d33b7de78865d6bf23c4eed0b17437b43d113:server/collect-category-resolution-repository.mjs"], { cwd: path.join(here, "../.."), encoding: "utf8" });
      const oldRepositoryPath = path.join(temp, "collect-category-resolution-repository.mjs");
      await writeFile(oldRepositoryPath, oldRepository, { encoding: "utf8", mode: 0o600 });
      const oldModule = await import(`${pathToFileURL(oldRepositoryPath).href}?task10=${suffix}`);
      const restoredOldRepository = oldModule.createPostgresCollectCategoryResolutionRepository({
        pool: { query: (...args) => restoreClient.query(...args) },
      });
      const restoredLegacy = await restoredOldRepository.readForItem({
        accountId: account, collectItemId: source.collectItemId, taxonomyScope: "OZON:DEFAULT",
      });
      assert.equal(restoredLegacy.targetDescriptionCategoryId, 999,
        "the actual pre-upgrade repository implementation reads the restored legacy row");
      assert.equal((await restoreClient.query("SELECT COUNT(*)::int AS count FROM submission_jobs WHERE id=$1", [job])).rows[0].count, 1);
      assert.equal((await restoreClient.query("SELECT COUNT(*)::int AS count FROM submission_events WHERE job_id=$1 AND event_type='TASK10_HISTORY_SENTINEL'", [job])).rows[0].count, 1);
    } finally {
      await sourceClient.query(`DROP SCHEMA IF EXISTS ${q(upgradeSchema)} CASCADE`).catch(() => {});
      await sourceClient.query(`DROP SCHEMA IF EXISTS ${q(rejectedSchema)} CASCADE`).catch(() => {});
      await restoreClient.query(`DROP SCHEMA IF EXISTS ${q(restoredSchema)} CASCADE`).catch(() => {});
      sourceClient.release();
      restoreClient.release();
      await sourcePool.end();
      await restorePool.end();
      await rm(temp, { recursive: true, force: true });
    }
  });
}
