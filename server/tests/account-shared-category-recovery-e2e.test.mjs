import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { createAccountSharedOzonCategoryService } from "../account-shared-ozon-category-service.mjs";
import { createAccountSharedOzonCategoryRuntime } from "../account-shared-ozon-category-runtime.mjs";
import { createPostgresAccountSharedOzonCategoryRepository } from "../account-shared-ozon-category-repository.mjs";
import { createAutoListingCategoryRecoveryPostgres } from "../auto-listing-category-recovery-postgres.mjs";
import { createAutoListingCategoryRecoveryService } from "../auto-listing-category-recovery-service.mjs";
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

async function migrationFiles(maximum = 69) {
  const files = (await readdir(migrationsDir))
    .filter((file) => /^\d{3}_.+\.sql$/u.test(file) && Number(file.slice(0, 3)) <= maximum)
    .sort();
  if (maximum === 69) assert.equal(files.at(-1), "069_submission_category_recovery_item_results.sql");
  return files;
}

async function applyMigrations(client, maximum = 69) {
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
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    calls.push(Object.freeze({ path: request.url, body: structuredClone(body) }));
    response.setHeader("content-type", "application/json");
    if (request.url === "/v3/product/info/list") {
      response.end(JSON.stringify({ items: [] }));
    } else if (request.url === "/v1/description-category/tree") {
      response.end(JSON.stringify({ result: [{ descriptionCategoryId: 30, typeId: 40 }] }));
    } else if (request.url === "/v3/product/import") {
      response.end(JSON.stringify({ result: { task_id: "task-retry" } }));
    } else if (request.url === "/v2/products/stocks") {
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

async function seedCollection(client, { accountId, storeId, collectId, rawId, draftId, sku }) {
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
  await client.query(
    `INSERT INTO product_drafts(id,collect_item_id,source_payload_id,version,data_hash,data,updated_by)
     VALUES($1,$2,$3,1,$4,$5::jsonb,$6)`,
    [draftId, collectId, rawId, sha(draftId), JSON.stringify({ sourceCategory: category }), accountId],
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

if (!enabled) {
  test("Task 10 E2E requires two disposable PostgreSQL 16 databases", {
    skip: "set ACCOUNT_SHARED_CATEGORY_RECOVERY_E2E=1 and both disposable database URLs",
  }, () => {});
} else {
  test("001-069 account-shared category and one recovery use real PG and loopback-only Ozon", { timeout: 180_000 }, async () => {
    assert.ok(sourceUrl && restoreUrl && sourceContainer && restoreContainer, "two disposable DB/container identities are required");
    const pool = new Pool({ connectionString: sourceUrl });
    const client = await pool.connect();
    const schema = `task10_e2e_${crypto.randomUUID().replaceAll("-", "")}`;
    const fake = await listenFakeOzon();
    let ids = 0;
    try {
      await client.query(`CREATE SCHEMA ${q(schema)}`);
      await client.query(`SET search_path TO ${q(schema)}, public`);
      await applyMigrations(client, 69);
      const accountA = `account-a-${schema}`;
      const accountB = `account-b-${schema}`;
      const storeA = `store-a-${schema}`;
      const storeB = `store-b-${schema}`;
      await client.query("INSERT INTO accounts(id,username,display_name,role,status) VALUES($1,$1,$1,'admin','active'),($2,$2,$2,'admin','active')", [accountA, accountB]);
      await client.query("INSERT INTO stores(id,label,company_name,client_id,status,owner_account_id) VALUES($1,$1,$1,$1,'active',$3),($2,$2,$2,$2,'active',$3)", [storeA, storeB, accountA]);
      const sourceA = await seedCollection(client, { accountId: accountA, storeId: storeA, collectId: `collect-a-${schema}`, rawId: `raw-a-${schema}`, draftId: `draft-a-${schema}`, sku: "sku-a" });
      const sourceB = await seedCollection(client, { accountId: accountA, storeId: storeB, collectId: `collect-b-${schema}`, rawId: `raw-b-${schema}`, draftId: `draft-b-${schema}`, sku: "sku-b" });
      const db = scopedPool(pool, schema);
      const categoryRepository = createPostgresAccountSharedOzonCategoryRepository({
        pool: db, idFactory: () => `category-${schema}-${++ids}`, now: () => "2026-08-12T00:00:00.000Z",
      });
      let lookupCalls = 0;
      const categoryService = createAccountSharedOzonCategoryService({
        repository: categoryRepository,
        sourceLookup: { async lookup() { lookupCalls += 1; await fake.post("/v3/product/info/list", { offer_id: "missing" }); return { status: "UNRESOLVED" }; } },
      });
      const recordedA = await categoryService.recordCollectionSource(sourceA);
      await categoryService.recordCollectionSource(sourceB);
      assert.equal(recordedA.categoryResolution.status, "ACTIVE");
      assert.equal((await db.query("SELECT COUNT(*)::int AS count FROM account_ozon_shared_categories")).rows[0].count, 1, "two stores reuse one account-shared row");
      assert.deepEqual(await categoryService.readForItems({ accountId: accountB, collectItemIds: [sourceA.collectItemId] }), [], "cross-account read fails closed before transport");
      assert.equal(lookupCalls, 0);
      const unresolved = await categoryService.resolveCollectionSource({ ...sourceA, sourceDescriptionCategoryId: null, sourceTypeId: null, lookupContext: { accountId: accountA, offerId: "missing" } });
      assert.equal(unresolved.categoryResolution.status, "NEEDS_REVIEW");
      assert.equal(lookupCalls, 1);
      assert.equal(fake.calls.filter((call) => call.path === "/v3/product/import").length, 0);

      const runtime = createAccountSharedOzonCategoryRuntime({
        loadState: async () => ({}), saveState: async () => {}, stateTransaction: { run: (operation) => operation() },
        persistenceMode: () => "postgres", postgresPool: async () => db,
        initializePostgresRepository: async () => categoryRepository,
        now: () => new Date("2026-08-12T01:00:00.000Z"), randomUUID: () => `runtime-${schema}-${++ids}`,
      });
      const confirmation = {
        collectItemId: sourceA.collectItemId, expectedSourceVersion: "draft:1",
        descriptionCategoryId: 10, typeId: 20, taxonomyScope: "OZON:DEFAULT",
        idempotencyKey: `confirm-${schema}`, correlationId: `confirm-corr-${schema}`,
      };
      await assert.rejects(runtime.confirmManualCategory({ actor: { id: accountA, role: "user" }, ...confirmation }), (error) => error.code === "PERMISSION_FORBIDDEN");
      const confirmed = await runtime.confirmManualCategory({ actor: { id: accountA, role: "admin" }, ...confirmation });
      assert.equal(confirmed.categoryResolution.source, "MANUAL");
      assert.deepEqual(await runtime.confirmManualCategory({ actor: { id: accountA, role: "admin" }, ...confirmation }), confirmed, "manual confirmation is idempotently reusable");

      const current = (await db.query("SELECT * FROM account_ozon_shared_categories WHERE account_id=$1", [accountA])).rows[0];
      const sourceEvidence = (await db.query("SELECT * FROM collect_ozon_category_source_evidence WHERE account_id=$1 AND collect_item_id=$2", [accountA, sourceA.collectItemId])).rows[0];
      const item = {
        offer_id: "offer-a", sku: "sku-a", name: "Frozen item", price: "100.00", currency_code: "RUB",
        description_category_id: 10, type_id: 20, weight: 500, weight_unit: "g", depth: 200,
        width: 100, height: 50, dimension_unit: "mm", images: ["https://cdn.example.test/item.jpg"],
        primary_image: "https://cdn.example.test/item.jpg",
        attributes: [{ complex_id: 0, id: 1, values: [{ value: "safe" }] }],
      };
      const snapshotId = `snapshot-${schema}`;
      const jobId = `job-${schema}`;
      const itemId = `item-${schema}`;
      const originalHash = canonicalSha([item]);
      await db.query(`INSERT INTO submission_snapshots(id,collect_item_id,draft_id,draft_version,account_id,store_id,idempotency_key,snapshot_hash,item_count,items)
        VALUES($1,$2,$3,1,$4,$5,$6,$7,1,$8::jsonb)`, [snapshotId, sourceA.collectItemId, sourceA.productDraftId, accountA, storeA, `idem-${schema}`, originalHash, JSON.stringify([item])]);
      await db.query(`INSERT INTO submission_jobs(id,snapshot_id,collect_item_id,account_id,store_id,status,ozon_task_id,item_count,failed_count,correlation_id)
        VALUES($1,$2,$3,$4,$5,'FAILED','task-original',1,1,$6)`, [jobId, snapshotId, sourceA.collectItemId, accountA, storeA, `corr-${schema}`]);
      await db.query(`INSERT INTO submission_items(id,job_id,snapshot_id,variant_key,sort_order,sku,offer_id,status,product_id,response)
        VALUES($1,$2,$3,'variant-1',0,'sku-a','offer-a','FAILED','',$4::jsonb)`, [itemId, jobId, snapshotId, JSON.stringify({ schemaVersion: "OZON_SUBMISSION_ITEM_RESPONSE_V1", rawResponse: { fixture: "test-only-authoritative-history" }, errorEvidence: historicalEvidence() })]);
      const recoveryRepository = createAutoListingCategoryRecoveryPostgres({ pool: db, idFactory: () => `attempt-${schema}`, now: () => "2026-08-12T02:00:00.000Z" });
      const disabledInput = {
        accountId: accountA, jobId, snapshotId, itemId, offerId: "offer-a", originalOzonTaskId: "task-original",
        policyVersion: "ozon-category-policy.v2", safeEvidence: historicalEvidence(), sourceEvidenceId: sourceEvidence.id,
        oldSharedCategoryId: current.id, oldSharedCategoryVersion: Number(current.version), originalSnapshotHash: originalHash,
      };
      assert.equal(projectProductionOzonImportErrorEvidence(historicalEvidence()), null);
      assert.notEqual(classifyOzonCategoryImportResult({ item: { offer_id: "offer-a", errors: [{ code: "CATEGORY_INVALID" }] }, expectedOfferId: "offer-a", batchHasPartialOutcome: false }).classification, "EXPLICIT_CATEGORY_FAILURE");
      await assert.rejects(recoveryRepository.recordCategoryErrorEvidence(disabledInput), (error) => error.code === "AUTO_LISTING_CATEGORY_RECOVERY_POLICY_DISABLED");
      const evidenceId = `evidence-${schema}`;
      await db.query(`INSERT INTO submission_category_error_evidence(
        id,account_id,submission_job_id,submission_snapshot_id,submission_item_id,offer_id,original_ozon_task_id,
        original_snapshot_hash,original_items,source_evidence_id,old_shared_category_id,old_shared_category_version,
        classifier_policy_version,safe_evidence) VALUES($1,$2,$3,$4,$5,'offer-a','task-original',$6,$7::jsonb,$8,$9,$10,'ozon-category-policy.v2',$11::jsonb)`,
      [evidenceId, accountA, jobId, snapshotId, itemId, originalHash, JSON.stringify([item]), sourceEvidence.id, current.id, Number(current.version), JSON.stringify(historicalEvidence())]);
      let schedules = 0;
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
        scheduleRetry: async () => { schedules += 1; },
        now: () => "2026-08-12T02:00:00.000Z",
      });
      const request = { accountId: accountA, jobId, evidenceId, correlationId: `corr-${schema}` };
      const pending = await recovery.recover(request);
      assert.equal(pending.status, "RETRY_PENDING");
      assert.equal(schedules, 1);
      const attempt = (await db.query("SELECT * FROM submission_category_recovery_attempts WHERE account_id=$1 AND submission_job_id=$2", [accountA, jobId])).rows[0];
      assert.equal(attempt.status, "RETRY_PENDING");
      assert.equal(attempt.corrected_items[0].description_category_id, 30);
      assert.deepEqual(Object.fromEntries(Object.entries(attempt.corrected_items[0]).filter(([key]) => !["description_category_id", "type_id", "attributes", "complex_attributes"].includes(key))), Object.fromEntries(Object.entries(item).filter(([key]) => !["description_category_id", "type_id", "attributes", "complex_attributes"].includes(key))));
      await fake.post("/v3/product/import", { items: attempt.corrected_items, recovery_attempt_id: attempt.id });
      const identity = exactRecoveryIdentity({ accountId: accountA, jobId, snapshotId, evidenceId, sourceEvidenceId: sourceEvidence.id, oldSharedCategoryId: current.id, oldSharedCategoryVersion: Number(current.version), originalOzonTaskId: "task-original" }, attempt.id, `corr-${schema}`);
      await recoveryRepository.markCategoryRecoveryRetryAccepted({ ...identity, expectedStatus: "RETRY_PENDING", retryOzonTaskId: "task-retry", transitionedAt: "2026-08-12T02:01:00.000Z" });
      await db.query("UPDATE submission_jobs SET ozon_task_id='task-retry',status='CHECKING' WHERE account_id=$1 AND id=$2", [accountA, jobId]);
      await db.query(`INSERT INTO submission_category_recovery_item_results(
        id,account_id,submission_job_id,submission_snapshot_id,recovery_attempt_id,retry_ozon_task_id,
        submission_item_id,offer_id,status,product_id) VALUES($1,$2,$3,$4,$5,'task-retry',$6,'offer-a','SUCCEEDED','101')`,
      [`child-${schema}`, accountA, jobId, snapshotId, attempt.id, itemId]);
      await recoveryRepository.completeCategoryRecovery({ ...identity, expectedStatus: "RETRY_ACCEPTED", retryOzonTaskId: "task-retry", transitionedAt: "2026-08-12T02:02:00.000Z" });
      await fake.post("/v2/products/stocks", { stocks: [{ offer_id: "offer-a", stock: 5 }] });
      const replay = await recovery.recover(request);
      assert.equal(replay.status, "SUCCEEDED");
      assert.equal(fake.calls.filter((call) => call.path === "/v3/product/import").length, 1);
      assert.equal(fake.calls.filter((call) => call.path === "/v2/products/stocks").length, 1);
      assert.equal((await db.query("SELECT COUNT(*)::int AS count FROM submission_category_error_evidence WHERE account_id=$1 AND submission_job_id=$2", [accountA, jobId])).rows[0].count, 1);
      assert.equal((await db.query("SELECT COUNT(*)::int AS count FROM submission_category_recovery_attempts WHERE account_id=$1 AND submission_job_id=$2", [accountA, jobId])).rows[0].count, 1);
      const original = (await db.query("SELECT status,product_id,response FROM submission_items WHERE id=$1", [itemId])).rows[0];
      assert.equal(original.status, "FAILED");
      assert.equal(original.product_id, "");

      for (const fixture of ["second-category", "ambiguous", "missing-required", "present", "unknown", "response-loss", "authentication", "throttling", "brand", "currency", "warehouse", "stock"]) {
        const classified = classifyOzonCategoryImportResult({ item: { offer_id: "offer-a", error: { code: fixture } }, expectedOfferId: "offer-a", batchHasPartialOutcome: false });
        assert.notEqual(classified.classification, "EXPLICIT_CATEGORY_FAILURE");
      }
      assert.equal(fake.calls.filter((call) => call.path === "/v3/product/import").length, 1, "non-allowlisted failures never add a product import");
      assert.equal(fake.calls.some((call) => /match/i.test(call.path)), false, "no store-category matching endpoint is used");
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
      const source = await (async () => {
        await sourceClient.query("INSERT INTO accounts(id,username,display_name,role,status) VALUES($1,$1,$1,'admin','active')", [account]);
        await sourceClient.query("INSERT INTO stores(id,label,company_name,client_id,status,owner_account_id) VALUES($1,$1,$1,$1,'active',$2)", [store, account]);
        return seedCollection(sourceClient, { accountId: account, storeId: store, collectId: `collect-${suffix}`, rawId: `raw-${suffix}`, draftId: `draft-${suffix}`, sku: "sku-old" });
      })();
      await sourceClient.query(`INSERT INTO collect_category_resolutions(id,account_id,collect_item_id,taxonomy_scope,source_type_id,target_description_category_id,target_type_id,method,status)
        VALUES($1,$2,$3,'OZON:DEFAULT',20,999,888,'legacy','MATCHED')`, [`legacy-${suffix}`, account, source.collectItemId]);
      await sourceClient.query("INSERT INTO audit_events(event_id,account_id,action,entity_type,entity_id) VALUES($1,$2,'TASK10_SENTINEL','test',$1)", [`audit-${suffix}`, account]);
      const databaseName = new URL(sourceUrl).pathname.slice(1);
      execFileSync("docker", ["exec", sourceContainer, "pg_dump", "-U", "postgres", "-d", databaseName, "-Fc", "-n", upgradeSchema, "-f", "/tmp/task10-pre-upgrade.dump"]);
      execFileSync("docker", ["cp", `${sourceContainer}:/tmp/task10-pre-upgrade.dump`, dump]);
      const migration063 = await readFile(path.join(migrationsDir, "063_account_shared_ozon_categories.sql"), "utf8");
      await sourceClient.query("BEGIN");
      await sourceClient.query(migration063);
      await sourceClient.query("COMMIT");
      assert.equal((await sourceClient.query("SELECT to_regclass('collect_category_resolutions') AS value")).rows[0].value, null);
      assert.equal((await sourceClient.query("SELECT current_description_category_id::int AS category FROM account_ozon_shared_categories")).rows[0].category, 10);
      assert.equal((await sourceClient.query("SELECT COUNT(*)::int AS count FROM audit_events WHERE event_id=$1", [`audit-${suffix}`])).rows[0].count, 1);
      for (const file of (await migrationFiles(69)).filter((name) => Number(name.slice(0, 3)) >= 64)) await sourceClient.query(await readFile(path.join(migrationsDir, file), "utf8"));

      await sourceClient.query(`CREATE SCHEMA ${q(rejectedSchema)}`);
      await sourceClient.query(`SET search_path TO ${q(rejectedSchema)}, public`);
      await applyMigrations(sourceClient, 62);
      await sourceClient.query("INSERT INTO accounts(id,username,display_name,role,status) VALUES($1,$1,$1,'admin','active')", [`bad-account-${suffix}`]);
      await sourceClient.query("INSERT INTO stores(id,label,company_name,client_id,status,owner_account_id) VALUES($1,$1,$1,$1,'active',$2)", [`bad-store-${suffix}`, `bad-account-${suffix}`]);
      const bad = await seedCollection(sourceClient, { accountId: `bad-account-${suffix}`, storeId: `bad-store-${suffix}`, collectId: `bad-collect-${suffix}`, rawId: `bad-raw-${suffix}`, draftId: `bad-draft-${suffix}`, sku: "bad" });
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
      assert.match(oldRepository, /collect_category_resolutions/u, "the restored table remains readable by the pre-upgrade implementation contract");
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
