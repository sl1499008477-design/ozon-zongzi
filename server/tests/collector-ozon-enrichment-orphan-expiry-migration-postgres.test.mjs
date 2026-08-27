import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(__dirname, "../db/migrations");
const databaseConfig = process.env.SONLI_MIGRATION_TEST_DATABASE_URL
  ? { connectionString: process.env.SONLI_MIGRATION_TEST_DATABASE_URL }
  : process.env.POSTGRES_HOST
    ? {
        host: process.env.POSTGRES_HOST,
        port: Number(process.env.POSTGRES_PORT || 5432),
        database: process.env.POSTGRES_DB,
        user: process.env.POSTGRES_USER,
        password: process.env.POSTGRES_PASSWORD,
        ssl: false,
      }
    : null;

function quoteIdentifier(identifier) {
  return `"${String(identifier).replaceAll('"', '""')}"`;
}

test("migration 089 expires only unlinked nonterminal jobs whose deadline passed", {
  skip: databaseConfig ? false : "PostgreSQL test configuration is unavailable",
}, async () => {
  const { Pool } = await import("pg");
  const pool = new Pool(databaseConfig);
  const client = await pool.connect();
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const schema = `ozon_enrichment_v89_${suffix}`;
  const accountId = `account_${suffix}`;
  const collectItemId = `collect_${suffix}`;
  try {
    await client.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    await client.query(`SET search_path TO ${quoteIdentifier(schema)}, public`);
    const migrations = (await readdir(migrationsDir))
      .filter((file) => /^\d{3}_.+\.sql$/.test(file))
      .sort();
    for (const migration of migrations) {
      if (Number(migration.slice(0, 3)) > 22) continue;
      await client.query(await readFile(path.join(migrationsDir, migration), "utf8"));
    }
    await client.query(
      "INSERT INTO accounts (id,username,display_name,role,status) VALUES ($1,$2,$2,'user','active')",
      [accountId, `user_${suffix}`],
    );
    await client.query(
      `INSERT INTO collect_items (id,account_id,source,identity_key,source_sku,summary)
       VALUES ($1,$2,'ozon',$3,'linked-sku','{}'::jsonb)`,
      [collectItemId, accountId, `identity_${suffix}`],
    );
    const rows = [
      ["expired-pending", null, "PENDING", "expired-pending", "2000-01-01T00:00:00.000Z", null, null],
      ["expired-processing", null, "PROCESSING", "expired-processing", "2000-01-01T00:00:00.000Z", null, null],
      ["live-unlinked", null, "PENDING", "live-unlinked", "9999-12-31T23:59:59.999Z", null, null],
      ["expired-linked", collectItemId, "PENDING", "linked-sku", "2000-01-01T00:00:00.000Z", null, null],
      ["terminal-unlinked", null, "SUCCESS", "terminal-unlinked", "2000-01-01T00:00:00.000Z", { ok: true }, "2000-01-01T00:00:01.000Z"],
    ];
    for (const [id, linkedId, status, sku, deadlineAt, result, completedAt] of rows) {
      await client.query(
        `INSERT INTO collector_ozon_enrichment_jobs (
           id,account_id,collect_item_id,request_id,sku,status,refresh_bundle,
           deadline_at,result_json,created_at,updated_at,completed_at
         ) VALUES ($1,$2,$3,$4,$5,$6,'{}'::jsonb,$7,$8::jsonb,NOW(),NOW(),$9)`,
        [
          `${id}_${suffix}`,
          accountId,
          linkedId,
          `request_${id}_${suffix}`,
          sku,
          status,
          deadlineAt,
          result == null ? null : JSON.stringify(result),
          completedAt,
        ],
      );
    }

    await client.query(await readFile(
      path.join(migrationsDir, "089_expire_orphan_ozon_enrichment_jobs.sql"),
      "utf8",
    ));

    const result = await client.query(
      `SELECT split_part(id, '_', 1) AS fixture,status,error_json,last_error_json,
              completed_at,claimed_session_id,claim_expires_at,claim_fence
         FROM collector_ozon_enrichment_jobs
        WHERE account_id=$1
        ORDER BY fixture`,
      [accountId],
    );
    const byFixture = Object.fromEntries(result.rows.map((row) => [row.fixture, row]));
    for (const fixture of ["expired-pending", "expired-processing"]) {
      assert.equal(byFixture[fixture].status, "FAILED");
      assert.deepEqual(byFixture[fixture].error_json, {
        code: "OZON_ENRICHMENT_ORPHAN_EXPIRED",
        status: 410,
      });
      assert.deepEqual(byFixture[fixture].last_error_json, byFixture[fixture].error_json);
      assert.notEqual(byFixture[fixture].completed_at, null);
      assert.equal(byFixture[fixture].claimed_session_id, null);
      assert.equal(byFixture[fixture].claim_expires_at, null);
      assert.equal(byFixture[fixture].claim_fence, null);
    }
    assert.equal(byFixture["live-unlinked"].status, "PENDING");
    assert.equal(byFixture["expired-linked"].status, "PENDING");
    assert.equal(byFixture["terminal-unlinked"].status, "SUCCESS");
  } finally {
    await client.query("RESET search_path").catch(() => {});
    await client.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`).catch(() => {});
    client.release();
    await pool.end();
  }
});
