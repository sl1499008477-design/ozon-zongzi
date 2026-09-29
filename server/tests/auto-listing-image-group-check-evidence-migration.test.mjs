import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL("../db/migrations/104_auto_listing_image_group_check_evidence.sql", import.meta.url);

test("migration 104 adds durable group-check call evidence without changing the seven-key result", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  for (const column of [
    "gateway_request_id TEXT", "model_evidence JSONB", "gateway_connection_id TEXT",
    "gateway_connection_version INTEGER",
  ]) assert.match(sql, new RegExp(column, "u"));
  assert.match(sql,
    /OR \(gateway_request_id IS NOT NULL AND model_evidence IS NOT NULL\s+AND auto_listing_ai_runtime_safe_identifier\(gateway_request_id\)/u,
    "single-sided NULL gateway evidence must not satisfy a PostgreSQL CHECK through UNKNOWN");
  assert.match(sql, /FOREIGN KEY \(account_id, gateway_connection_id, gateway_connection_version\)[\s\S]*ai_gateway_connection_versions/u);
  assert.match(sql, /gateway_connection_id IS NULL AND gateway_connection_version IS NULL/u);
  assert.match(sql, /gateway_connection_id IS NOT NULL AND gateway_connection_version IS NOT NULL/u);
});
