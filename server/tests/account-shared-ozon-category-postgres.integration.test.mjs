import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

const databaseUrl = process.env.SONLI_MIGRATION_TEST_DATABASE_URL || "";
const enabled = process.env.ACCOUNT_SHARED_CATEGORY_POSTGRES_TESTS === "1" && Boolean(databaseUrl);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(__dirname, "../db/migrations");
const migration063Path = path.join(migrationsDir, "063_account_shared_ozon_categories.sql");
const q = (value) => `"${String(value).replaceAll('"', '""')}"`;
const sha = (value) => crypto.createHash("sha256").update(String(value)).digest("hex");

async function baseMigrationFiles() {
  return (await readdir(migrationsDir))
    .filter((file) => /^\d{3}_.+\.sql$/.test(file) && Number(file.slice(0, 3)) <= 62)
    .sort();
}

async function applyBaseMigrations(client) {
  for (const file of await baseMigrationFiles()) {
    await client.query(await readFile(path.join(migrationsDir, file), "utf8"));
  }
}

async function apply063(client) {
  const sql = await readFile(migration063Path, "utf8");
  await client.query("BEGIN");
  try {
    await client.query(sql);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function insertAccount(client, accountId) {
  await client.query(
    "INSERT INTO accounts (id,username,display_name,role,status) VALUES ($1,$2,$2,'admin','active')",
    [accountId, `user-${accountId}`],
  );
}

async function insertStore(client, { id, accountId }) {
  await client.query(
    "INSERT INTO stores (id,label,company_name,client_id,status,owner_account_id) VALUES ($1,$1,$1,$2,'active',$3)",
    [id, `client-${id}`, accountId],
  );
}

async function insertCollectItem(client, { id, accountId, storeId, sku }) {
  await client.query(
    `INSERT INTO collect_items (id,account_id,store_id,source,identity_key,source_sku,summary)
     VALUES ($1,$2,$3,'ozon',$4,$5,'{}'::jsonb)`,
    [id, accountId, storeId || null, `identity-${id}`, sku],
  );
}

async function insertDraftSource(client, {
  accountId,
  storeId,
  collectItemId,
  draftId,
  rawId,
  sku,
  sourceDescriptionCategoryId,
  sourceTypeId,
  capturedAt,
}) {
  await insertCollectItem(client, { id: collectItemId, accountId, storeId, sku });
  const payloadHash = sha(`raw:${rawId}`);
  await client.query(
    `INSERT INTO collect_raw_payloads
       (id,collect_item_id,account_id,store_id,source_sku,source_url,payload_hash,payload,collected_at)
     VALUES ($1,$2,$3,$4,$5,'https://source.invalid/item',$6,'{}'::jsonb,$7)`,
    [rawId, collectItemId, accountId, storeId, sku, payloadHash, capturedAt],
  );
  const sourceCategory = {
    descriptionCategoryId: sourceDescriptionCategoryId,
    ...(sourceTypeId === undefined ? {} : { typeIdCandidate: sourceTypeId }),
    path: ["source", `category-${sourceDescriptionCategoryId}`],
  };
  await client.query(
    `INSERT INTO product_drafts
       (id,collect_item_id,source_payload_id,version,data_hash,data,updated_by)
     VALUES ($1,$2,$3,1,$4,$5::jsonb,$6)`,
    [draftId, collectItemId, rawId, sha(`draft:${draftId}`), JSON.stringify({ sourceCategory }), accountId],
  );
  return { payloadHash };
}

async function insertCacheSource(client, {
  accountId,
  sku,
  sourceDescriptionCategoryId,
  sourceTypeId,
  capturedAt,
}) {
  const responseHash = sha(`cache:${accountId}:${sku}`);
  const result = {
    status: "COMPLETE",
    contractVersion: "collector.ozon.enrichment.v1",
    sku,
    sourceCategory: {
      descriptionCategoryId: sourceDescriptionCategoryId,
      typeIdCandidate: sourceTypeId,
      path: ["source", `category-${sourceDescriptionCategoryId}`],
    },
    capturedAt,
  };
  await client.query(
    `INSERT INTO collector_ozon_enrichment_cache
       (account_id,source,sku,contract_version,status,result_json,response_hash,captured_at,expires_at)
     VALUES ($1,'ozon',$2,'collector.ozon.enrichment.v1','COMPLETE',$3::jsonb,$4,$5,$6)`,
    [accountId, sku, JSON.stringify(result), responseHash, capturedAt, "2099-01-01T00:00:00.000Z"],
  );
  return { responseHash };
}

async function tableCounts(client) {
  return (await client.query(`
    SELECT
      (SELECT COUNT(*)::INT FROM audit_events) AS audits,
      (SELECT COUNT(*)::INT FROM submission_jobs) AS submission_jobs,
      (SELECT COUNT(*)::INT FROM submission_events) AS submission_events,
      (SELECT COUNT(*)::INT FROM auto_listing_jobs) AS auto_listing_jobs,
      (SELECT COUNT(*)::INT FROM auto_listing_events) AS auto_listing_events,
      (SELECT COUNT(*)::INT FROM collect_raw_payloads) AS raw_payloads,
      (SELECT COUNT(*)::INT FROM product_drafts) AS product_drafts,
      (SELECT COUNT(*)::INT FROM collector_ozon_enrichment_cache) AS enrichment_cache
  `)).rows[0];
}

async function rejectedCode(operation) {
  try {
    await operation();
    return null;
  } catch (error) {
    return error?.code || null;
  }
}

if (!enabled) {
  test("account-shared category migration requires a disposable PostgreSQL 16 database", {
    skip: "requires ACCOUNT_SHARED_CATEGORY_POSTGRES_TESTS=1 and SONLI_MIGRATION_TEST_DATABASE_URL",
  }, () => {});
} else {
  test("063 reconstructs account-shared categories only from canonical source evidence", { timeout: 60_000 }, async () => {
    const pool = new Pool({ connectionString: databaseUrl });
    const client = await pool.connect();
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const schema = `shared_category_${suffix}`;
    const accountA = `account-a-${suffix}`;
    const accountB = `account-b-${suffix}`;
    const storeA1 = `store-a1-${suffix}`;
    const storeA2 = `store-a2-${suffix}`;
    const storeB = `store-b-${suffix}`;
    try {
      await client.query(`CREATE SCHEMA ${q(schema)}`);
      await client.query(`SET search_path TO ${q(schema)}, public`);
      await applyBaseMigrations(client);
      await insertAccount(client, accountA);
      await insertAccount(client, accountB);
      await insertStore(client, { id: storeA1, accountId: accountA });
      await insertStore(client, { id: storeA2, accountId: accountA });
      await insertStore(client, { id: storeB, accountId: accountB });

      await insertDraftSource(client, {
        accountId: accountA, storeId: storeA1, collectItemId: `collect-a1-${suffix}`,
        draftId: `draft-a1-${suffix}`, rawId: `raw-a1-${suffix}`, sku: `sku-a1-${suffix}`,
        sourceDescriptionCategoryId: 111_111, sourceTypeId: 222_222,
        capturedAt: "2026-08-10T01:02:03.000Z",
      });
      await insertDraftSource(client, {
        accountId: accountA, storeId: storeA2, collectItemId: `collect-a2-${suffix}`,
        draftId: `draft-a2-${suffix}`, rawId: `raw-a2-${suffix}`, sku: `sku-a2-${suffix}`,
        sourceDescriptionCategoryId: 111_111, sourceTypeId: 222_222,
        capturedAt: "2026-08-10T02:02:03.000Z",
      });
      await insertDraftSource(client, {
        accountId: accountA, storeId: storeA1, collectItemId: `collect-missing-${suffix}`,
        draftId: `draft-missing-${suffix}`, rawId: `raw-missing-${suffix}`,
        sku: `sku-missing-${suffix}`, sourceDescriptionCategoryId: 555_555,
        sourceTypeId: undefined, capturedAt: "2026-08-10T03:02:03.000Z",
      });
      await insertCacheSource(client, {
        accountId: accountA, sku: `cache-a-${suffix}`,
        sourceDescriptionCategoryId: 333_333, sourceTypeId: 444_444,
        capturedAt: "2026-08-10T04:02:03.000Z",
      });
      await insertCacheSource(client, {
        accountId: accountB, sku: `cache-b-${suffix}`,
        sourceDescriptionCategoryId: 111_111, sourceTypeId: 222_222,
        capturedAt: "2026-08-10T05:02:03.000Z",
      });

      await client.query(
        `INSERT INTO collect_category_resolutions
           (id,account_id,collect_item_id,taxonomy_scope,source_type_id,
            target_description_category_id,target_type_id,method,status)
         VALUES ($1,$2,$3,'OZON:DEFAULT',222222,999999,888888,'legacy-target','MATCHED')`,
        [`old-resolution-${suffix}`, accountA, `collect-a1-${suffix}`],
      );
      await client.query(
        `INSERT INTO audit_events (event_id,account_id,action,entity_type,entity_id)
         VALUES ($1,$2,'MIGRATION_SENTINEL','test',$1)`,
        [`audit-${suffix}`, accountA],
      );
      const before = await tableCounts(client);

      await apply063(client);

      const after = await tableCounts(client);
      assert.deepEqual(after, before, "063 must preserve audit/job/history/raw source counts");
      assert.equal((await client.query("SELECT to_regclass('collect_category_resolutions') AS name")).rows[0].name, null);
      assert.equal((await client.query("SELECT to_regclass('collect_category_resolution_runtime_cursors') AS name")).rows[0].name, null);

      const evidence = (await client.query(`
        SELECT id,account_id,source_kind,source_description_category_id,source_type_id,
               captured_at,raw_response_hash,raw_response_ref,provenance
        FROM collect_ozon_category_source_evidence
        ORDER BY account_id,source_kind,source_description_category_id
      `)).rows;
      assert.equal(evidence.length, 4);
      assert.equal(evidence.filter((row) => row.source_kind === "PRODUCT_DRAFT").length, 2);
      assert.equal(evidence.filter((row) => row.source_kind === "ENRICHMENT_CACHE").length, 2);
      assert.equal(evidence.every((row) => /^[0-9a-f]{64}$/.test(row.raw_response_hash)), true);
      assert.equal(evidence.every((row) => new Date(row.captured_at).toISOString().endsWith("Z")), true);
      assert.equal(JSON.stringify(evidence).includes("999999"), false);
      assert.equal(JSON.stringify(evidence).includes("888888"), false);

      const shared = (await client.query(`
        SELECT id,account_id,source_description_category_id,source_type_id,taxonomy_scope,
               current_description_category_id,current_type_id,status,source,version,
               taxonomy_fingerprint,source_evidence_id
        FROM account_ozon_shared_categories
        ORDER BY account_id,source_description_category_id
      `)).rows;
      assert.equal(shared.length, 3);
      assert.equal(shared.filter((row) => row.account_id === accountA
        && Number(row.source_description_category_id) === 111_111
        && Number(row.source_type_id) === 222_222).length, 1,
      "two stores in one account collapse to one source signature");
      assert.equal(shared.filter((row) => row.account_id === accountB
        && Number(row.source_description_category_id) === 111_111
        && Number(row.source_type_id) === 222_222).length, 1,
      "the second account owns a separate signature");
      assert.equal(shared.some((row) => Number(row.source_description_category_id) === 555_555), false);
      assert.equal(shared.some((row) => Number(row.current_description_category_id) === 999_999), false);
      assert.equal(shared.every((row) => Number(row.current_description_category_id)
        === Number(row.source_description_category_id)), true);
      assert.equal(shared.every((row) => Number(row.current_type_id) === Number(row.source_type_id)), true);
      assert.equal(shared.every((row) => row.status === "ACTIVE" && row.source === "SOURCE_DIRECT"
        && Number(row.version) === 1), true);

      const events = (await client.query(
        "SELECT * FROM account_ozon_shared_category_events ORDER BY account_id,id",
      )).rows;
      assert.equal(events.length, 3);
      assert.equal(events.every((row) => row.event_type === "MIGRATED_SOURCE_DIRECT"), true);
      assert.equal(JSON.stringify(events).includes("999999"), false);
      assert.equal(JSON.stringify(events).includes("888888"), false);

      const accountAShared = shared.find((row) => row.account_id === accountA);
      const accountBEvidence = (await client.query(
        "SELECT id FROM collect_ozon_category_source_evidence WHERE account_id=$1 ORDER BY id LIMIT 1",
        [accountB],
      )).rows[0].id;
      assert.equal(await rejectedCode(() => client.query(
        `UPDATE account_ozon_shared_categories
         SET source_evidence_id=$1,version=version+1,updated_at=updated_at+INTERVAL '1 second'
         WHERE id=$2`,
        [accountBEvidence, accountAShared.id],
      )), "23503");
      const evidenceId = evidence[0].id;
      assert.equal(await rejectedCode(() => client.query(
        "UPDATE collect_ozon_category_source_evidence SET provenance='{}'::jsonb WHERE id=$1",
        [evidenceId],
      )), "23514");
      assert.equal(await rejectedCode(() => client.query(
        "DELETE FROM collect_ozon_category_source_evidence WHERE id=$1",
        [evidenceId],
      )), "23514");
      assert.equal(await rejectedCode(() => client.query(
        "UPDATE account_ozon_shared_category_events SET provenance='{}'::jsonb WHERE id=$1",
        [events[0].id],
      )), "23514");
      assert.equal(await rejectedCode(() => client.query(
        "DELETE FROM account_ozon_shared_category_events WHERE id=$1",
        [events[0].id],
      )), "23514");
      assert.equal(await rejectedCode(() => client.query(
        "UPDATE account_ozon_shared_categories SET version=version+2 WHERE id=$1",
        [accountAShared.id],
      )), "23514");

      const eventCountBeforeTransition = (await client.query(
        "SELECT COUNT(*)::INT AS count FROM account_ozon_shared_category_events WHERE shared_category_id=$1",
        [accountAShared.id],
      )).rows[0].count;
      await client.query(
        `UPDATE account_ozon_shared_categories
         SET status='NEEDS_REVIEW',source='MANUAL',safe_failure_code='MANUAL_REVIEW_REQUIRED',
             version=version+1,updated_at=updated_at+INTERVAL '1 second'
         WHERE id=$1`,
        [accountAShared.id],
      );
      const transitionEvents = (await client.query(
        `SELECT event_type,from_status,to_status,from_version,to_version
           FROM account_ozon_shared_category_events
          WHERE shared_category_id=$1 ORDER BY created_at,id`,
        [accountAShared.id],
      )).rows;
      assert.equal(transitionEvents.length, eventCountBeforeTransition + 1);
      assert.deepEqual(transitionEvents.at(-1), {
        event_type: "CURRENT_ROW_TRANSITION",
        from_status: "ACTIVE",
        to_status: "NEEDS_REVIEW",
        from_version: 1,
        to_version: 2,
      });

      await client.query("DELETE FROM accounts WHERE id=$1", [accountB]);
      assert.equal((await client.query(
        "SELECT COUNT(*)::INT AS count FROM collect_ozon_category_source_evidence WHERE account_id=$1",
        [accountB],
      )).rows[0].count, 0);
      assert.equal((await client.query(
        "SELECT COUNT(*)::INT AS count FROM account_ozon_shared_category_events WHERE account_id=$1",
        [accountB],
      )).rows[0].count, 0);
    } finally {
      await client.query(`DROP SCHEMA IF EXISTS ${q(schema)} CASCADE`);
      client.release();
      await pool.end();
    }
  });

  test("063 preflight failure rolls back all DDL and keeps retired rows intact", { timeout: 60_000 }, async () => {
    const pool = new Pool({ connectionString: databaseUrl });
    const client = await pool.connect();
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const schema = `shared_category_preflight_${suffix}`;
    const accountA = `account-a-${suffix}`;
    const accountB = `account-b-${suffix}`;
    const storeA = `store-a-${suffix}`;
    const collectItemId = `collect-a-${suffix}`;
    try {
      await client.query(`CREATE SCHEMA ${q(schema)}`);
      await client.query(`SET search_path TO ${q(schema)}, public`);
      await applyBaseMigrations(client);
      await insertAccount(client, accountA);
      await insertAccount(client, accountB);
      await insertStore(client, { id: storeA, accountId: accountA });
      await insertCollectItem(client, {
        id: collectItemId, accountId: accountA, storeId: storeA, sku: `sku-${suffix}`,
      });
      await client.query(
        `INSERT INTO collect_category_resolutions
           (id,account_id,collect_item_id,taxonomy_scope,status)
         VALUES ($1,$2,$3,'OZON:DEFAULT','WAITING_ENRICHMENT')`,
        [`conflicting-owner-${suffix}`, accountB, collectItemId],
      );

      await assert.rejects(apply063(client), (error) => error?.code === "23514");

      assert.equal((await client.query(
        "SELECT COUNT(*)::INT AS count FROM collect_category_resolutions",
      )).rows[0].count, 1);
      assert.notEqual((await client.query(
        "SELECT to_regclass('collect_category_resolution_runtime_cursors') AS name",
      )).rows[0].name, null);
      for (const table of [
        "collect_ozon_category_source_evidence",
        "account_ozon_shared_categories",
        "account_ozon_shared_category_events",
      ]) {
        assert.equal((await client.query("SELECT to_regclass($1) AS name", [table])).rows[0].name, null);
      }
    } finally {
      await client.query(`DROP SCHEMA IF EXISTS ${q(schema)} CASCADE`);
      client.release();
      await pool.end();
    }
  });
}
