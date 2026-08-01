import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const databaseUrl = process.env.SONLI_MIGRATION_TEST_DATABASE_URL;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(__dirname, "../db/migrations");

function quoteIdentifier(identifier) {
  return `"${String(identifier).replaceAll('"', '""')}"`;
}

if (!databaseUrl) {
  test("PostgreSQL v21 duplicate linked jobs upgrade deterministically through v22", {
    skip: "SONLI_MIGRATION_TEST_DATABASE_URL is not configured",
  }, () => {});
} else {
  test("PostgreSQL v21 duplicate linked jobs upgrade deterministically through v22", async () => {
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: databaseUrl });
    const client = await pool.connect();
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const schema = `ozon_enrichment_v22_${suffix}`;
    const accountId = `account_${suffix}`;
    const collectItemId = `collect_${suffix}`;
    try {
      await client.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
      await client.query(`SET search_path TO ${quoteIdentifier(schema)}, public`);
      const migrations = (await readdir(migrationsDir))
        .filter((file) => /^\d{3}_.+\.sql$/.test(file))
        .sort();
      for (const migration of migrations) {
        const version = Number(migration.slice(0, 3));
        if (version > 21) continue;
        await client.query(await readFile(path.join(migrationsDir, migration), "utf8"));
      }
      await client.query(
        "INSERT INTO accounts (id,username,display_name,role,status) VALUES ($1,$2,$2,'user','active')",
        [accountId, `user_${suffix}`],
      );
      await client.query(
        `INSERT INTO collect_items (id,account_id,source,identity_key,source_sku,summary)
         VALUES ($1,$2,'ozon',$3,'4862904234','{}'::jsonb)`,
        [collectItemId, accountId, `identity_${suffix}`],
      );
      for (const [index, status] of ["PENDING", "PROCESSING", "PENDING"].entries()) {
        await client.query(
          `INSERT INTO collector_ozon_enrichment_jobs (
             id,account_id,collect_item_id,request_id,sku,status,refresh_bundle,
             deadline_at,next_attempt_at,created_at,updated_at
           ) VALUES ($1,$2,$3,$4,'4862904234',$5,'{}'::jsonb,
                     '9999-12-31T23:59:59.999Z','2026-08-01T00:00:00.000Z',
                     $6::timestamptz,$6::timestamptz)`,
          [
            `job_${index}_${suffix}`,
            accountId,
            collectItemId,
            `request_${index}_${suffix}`,
            status,
            `2026-08-01T00:00:0${index}.000Z`,
          ],
        );
      }

      await client.query(await readFile(
        path.join(migrationsDir, "022_ozon_enrichment_claim_fence.sql"),
        "utf8",
      ));

      const upgraded = await client.query(
        `SELECT id,status,error_json,completed_at
           FROM collector_ozon_enrichment_jobs
          WHERE account_id=$1 AND collect_item_id=$2 AND sku='4862904234'
          ORDER BY created_at ASC,id ASC`,
        [accountId, collectItemId],
      );
      assert.equal(upgraded.rows.length, 3, "superseded jobs remain as audit history");
      assert.equal(upgraded.rows[0].status, "PENDING");
      for (const duplicate of upgraded.rows.slice(1)) {
        assert.equal(duplicate.status, "FAILED");
        assert.deepEqual(duplicate.error_json, {
          code: "OZON_ENRICHMENT_DUPLICATE_SUPERSEDED",
          status: 409,
        });
        assert.notEqual(duplicate.completed_at, null);
      }
      const active = upgraded.rows.filter(({ status }) => ["PENDING", "PROCESSING"].includes(status));
      assert.deepEqual(active.map(({ id }) => id), [`job_0_${suffix}`]);

      await assert.rejects(
        client.query(
          `INSERT INTO collector_ozon_enrichment_jobs (
             id,account_id,collect_item_id,request_id,sku,status,refresh_bundle,
             deadline_at,next_attempt_at,created_at,updated_at
           ) VALUES ($1,$2,$3,$4,'4862904234','PENDING','{}'::jsonb,
                     '9999-12-31T23:59:59.999Z',NOW(),NOW(),NOW())`,
          [`job_new_${suffix}`, accountId, collectItemId, `request_new_${suffix}`],
        ),
        (error) => error?.code === "23505"
          && error?.constraint === "collector_ozon_enrichment_jobs_active_linked_key",
      );
    } finally {
      await client.query("RESET search_path").catch(() => {});
      await client.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`).catch(() => {});
      client.release();
      await pool.end();
    }
  });
}
