import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL("../db/migrations/035_auto_listing_ai_capability_attempts.sql", import.meta.url);

test("035 adds an account-scoped immutable capability attempt fence without rewriting profiles", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS ai_gateway_capability_attempts/iu);
  assert.match(sql, /fence BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE/iu);
  assert.match(sql, /UNIQUE \(account_id, profile_id, config_version, correlation_id\)/iu);
  assert.match(sql, /FOREIGN KEY \(account_id, profile_id, config_version\)[\s\S]*?REFERENCES ai_gateway_profiles/iu);
  assert.match(sql, /status IN \('RUNNING', 'PASSED', 'FAILED', 'STALE'\)/iu);
  assert.match(sql, /lease_version INTEGER NOT NULL DEFAULT 1 CHECK \(lease_version > 0\)/iu);
  assert.match(sql, /lease_token TEXT NOT NULL/iu);
  assert.match(sql, /lease_expires_at TIMESTAMPTZ NOT NULL/iu);
  assert.match(sql, /NEW\.lease_version < OLD\.lease_version/iu);
  assert.match(sql, /terminal AI gateway capability attempts are immutable[\s\S]*?ERRCODE = '23514'/iu);
  assert.doesNotMatch(sql, /\b(?:UPDATE|DELETE\s+FROM|TRUNCATE|DROP\s+(?:TABLE|COLUMN))\s+ai_gateway_profiles\b/iu);
  assert.doesNotMatch(sql, /\b(?:api_key|access_token|refresh_token|credential|secret|cookie|bearer)\s+(?:TEXT|JSONB|BYTEA)\b/iu);
});
