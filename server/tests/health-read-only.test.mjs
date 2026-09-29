import assert from "node:assert/strict";
import test from "node:test";

process.env.QH_LOCAL_NO_DOTENV = "1";
process.env.QH_LOCAL_NO_LISTEN = "1";
process.env.DATABASE_URL = "postgresql://unused.invalid/health_test";
process.env.LISTING_PIPELINE_V3 = "1";
const { getPostgresPool, closePostgresPool } = await import("../db/connection.mjs");
const { persistenceHealth } = await import("../persistence.mjs");
const { listingPipelineHealth } = await import("../listing-pipeline.mjs");

test("health probes can run on a read-only database without creating schemas or running migrations", async (t) => {
  const pool = await getPostgresPool();
  t.after(closePostgresPool);
  const statements = [];
  // No real socket is opened. The boundary rejects the same DDL as a read-only DB.
  t.mock.method(pool, "query", async (query) => {
    const sql = typeof query === "string" ? query : query.text;
    statements.push(sql);
    assert.match(sql.trim(), /^SELECT\b/i, "a health request must not write or initialize schema");
    return { rows: [{}], rowCount: 1 };
  });
  assert.equal((await persistenceHealth()).ok, true);
  assert.equal((await listingPipelineHealth()).enabled, true);
  assert.ok(statements.length > 0);
});
