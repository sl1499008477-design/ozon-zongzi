import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL(
  "../db/migrations/053_auto_listing_ai_model_configuration.sql",
  import.meta.url,
);

async function migrationSql() {
  return readFile(migrationUrl, "utf8");
}

function functionBlock(sql, name) {
  const match = sql.match(new RegExp(
    `CREATE OR REPLACE FUNCTION ${name}\\(\\)[\\s\\S]*?\\$\\$;`,
    "iu",
  ));
  assert.ok(match, `expected function ${name}`);
  return match[0];
}

test("053 adds tenant-scoped encrypted connection versions and preserves legacy profiles", async () => {
  const sql = await migrationSql();

  assert.match(sql, /CREATE TABLE IF NOT EXISTS ai_gateway_connection_versions/iu);
  assert.match(sql, /UNIQUE \(account_id, id, version\)/iu);
  assert.match(sql, /ciphertext TEXT NOT NULL/iu);
  assert.match(sql, /iv TEXT NOT NULL/iu);
  assert.match(sql, /auth_tag TEXT NOT NULL/iu);
  assert.match(sql, /algorithm TEXT NOT NULL/iu);
  assert.match(sql, /key_version TEXT NOT NULL/iu);
  assert.match(sql, /fingerprint TEXT NOT NULL/iu);
  assert.doesNotMatch(sql, /\b(?:api_key|raw_key|secret|credential)\s+(?:TEXT|JSONB|BYTEA)\b/iu);

  assert.match(sql, /ALTER TABLE ai_gateway_profiles[\s\S]*ADD COLUMN IF NOT EXISTS connection_id TEXT[\s\S]*ADD COLUMN IF NOT EXISTS connection_version INTEGER/iu);
  assert.match(sql, /FOREIGN KEY \(account_id, connection_id, connection_version\)[\s\S]*REFERENCES ai_gateway_connection_versions\(account_id, id, version\)/iu);
  assert.match(sql, /connection_id IS NULL AND connection_version IS NULL[\s\S]*OR[\s\S]*connection_id IS NOT NULL[\s\S]*api_key_env_name = 'SUB2API_ENCRYPTED_KEY'/iu);
  assert.doesNotMatch(sql, /UPDATE\s+ai_gateway_profiles\s+SET/iu);
});

test("053 closes connection state transitions and keeps connection identity and ciphertext immutable", async () => {
  const sql = await migrationSql();
  const guard = functionBlock(sql, "auto_listing_guard_ai_gateway_connection_version");

  assert.match(sql, /CHECK \(status IN \('PENDING', 'VALIDATED', 'ACTIVE', 'RETIRED'\)\)/iu);
  assert.match(guard, /OLD\.status = 'PENDING'[\s\S]*NEW\.status = 'VALIDATED'/iu);
  assert.match(guard, /OLD\.status = 'VALIDATED'[\s\S]*NEW\.status = 'ACTIVE'/iu);
  assert.match(guard, /OLD\.status = 'ACTIVE'[\s\S]*NEW\.status = 'RETIRED'/iu);
  assert.match(guard, /OLD\.status = 'RETIRED'[\s\S]*NEW\.status = 'VALIDATED'/iu);
  for (const column of [
    "id", "account_id", "version", "display_name", "base_url", "ciphertext",
    "iv", "auth_tag", "algorithm", "key_version", "fingerprint", "request_hash",
    "idempotency_key", "created_by", "created_at",
  ]) {
    assert.match(guard, new RegExp(`NEW\\.${column} IS DISTINCT FROM OLD\\.${column}`, "iu"));
  }
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS ai_gateway_connection_versions_one_active_per_account_uq[\s\S]*ON ai_gateway_connection_versions\(account_id\)[\s\S]*WHERE status = 'ACTIVE'/iu);
});

test("053 only inserts PENDING connections and binds rollback to stored passed capability evidence", async () => {
  const sql = await migrationSql();
  const insertGuard = functionBlock(sql, "auto_listing_require_pending_ai_gateway_connection_insert");
  const transitionGuard = functionBlock(sql, "auto_listing_guard_ai_gateway_connection_version");

  assert.match(insertGuard, /NEW\.status IS DISTINCT FROM 'PENDING'/iu);
  assert.match(insertGuard, /NEW\.status_version IS DISTINCT FROM 1/iu);
  assert.match(insertGuard, /NEW\.version IS DISTINCT FROM 1/iu);
  assert.match(sql, /rollback_evidence JSONB/iu);
  assert.match(sql, /rollback_evidence_hash TEXT/iu);
  assert.match(transitionGuard, /OLD\.status = 'RETIRED'[\s\S]*NEW\.status = 'VALIDATED'[\s\S]*ai_gateway_model_catalogs/iu);
  assert.match(transitionGuard, /t\.status = 'SUCCEEDED'/iu);
  assert.match(transitionGuard, /t\.sync_purpose = 'ROLLBACK_CAPABILITY'/iu);
  assert.match(transitionGuard, /catalog_hash = NEW\.rollback_evidence->>'catalogHash'/iu);
  assert.match(transitionGuard, /capability_hash = NEW\.rollback_evidence->>'capabilityHash'/iu);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS ai_gateway_rollback_evidence_consumptions/iu);
  assert.match(transitionGuard, /ai_gateway_rollback_evidence_consumptions/iu);
});

test("053 stores bounded model catalogs and fenced sync tasks under composite tenant boundaries", async () => {
  const sql = await migrationSql();
  const catalogTable = sql.match(/CREATE TABLE IF NOT EXISTS ai_gateway_model_catalogs[\s\S]*?\n\);/iu)?.[0] ?? "";

  assert.match(sql, /CREATE TABLE IF NOT EXISTS ai_gateway_model_catalogs/iu);
  assert.match(sql, /FOREIGN KEY \(account_id, connection_id, connection_version\)[\s\S]*REFERENCES ai_gateway_connection_versions\(account_id, id, version\)/iu);
  assert.match(sql, /jsonb_typeof\(catalog\) = 'object'/iu);
  assert.match(sql, /octet_length\(catalog::TEXT\) <= 1048576/iu);

  assert.match(sql, /CREATE TABLE IF NOT EXISTS ai_gateway_model_sync_tasks/iu);
  assert.match(sql, /CHECK \(status IN \('PENDING', 'LEASED', 'SUCCEEDED', 'FAILED', 'DEAD'\)\)/iu);
  assert.match(sql, /attempt_count INTEGER NOT NULL DEFAULT 0 CHECK \(attempt_count >= 0 AND attempt_count <= max_attempts\)/iu);
  assert.match(sql, /lease_version INTEGER NOT NULL DEFAULT 0 CHECK \(lease_version >= 0\)/iu);
  assert.match(sql, /lease_token TEXT/iu);
  assert.match(sql, /lease_token ~ '\^\[a-f0-9\]\{64\}\$'/iu);
  assert.match(sql, /lease_expires_at TIMESTAMPTZ/iu);
  assert.match(sql, /request_hash TEXT NOT NULL CHECK \(request_hash ~ '\^\[a-f0-9\]\{64\}\$'\)/iu);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS ai_gateway_model_sync_tasks_one_runnable_uq[\s\S]*ON ai_gateway_model_sync_tasks\(account_id, connection_id, connection_version\)[\s\S]*WHERE status IN \('PENDING', 'LEASED', 'FAILED'\)/iu);
  assert.match(sql, /UNIQUE \(account_id, id, connection_id, connection_version\)/iu);
  assert.match(sql, /FOREIGN KEY \(account_id, task_id, connection_id, connection_version\)[\s\S]*REFERENCES ai_gateway_model_sync_tasks\(account_id, id, connection_id, connection_version\)/iu);
  assert.match(sql, /FOREIGN KEY \(account_id, sync_task_id, connection_id, connection_version\)[\s\S]*REFERENCES ai_gateway_model_sync_tasks\(account_id, id, connection_id, connection_version\)/iu);
  assert.doesNotMatch(catalogTable, /capability_result->>'outcome' = 'PASSED'/iu);
  assert.doesNotMatch(catalogTable, /capability_result->>'text' = 'true'/iu);
  assert.doesNotMatch(catalogTable, /capability_result->>'image' = 'true'/iu);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS ai_gateway_model_sync_attempt_outcomes/iu);
  assert.match(sql, /sync_purpose TEXT NOT NULL/iu);
  assert.match(sql, /target_connection_status_version INTEGER NOT NULL/iu);
  assert.match(sql, /auto_listing_require_succeeded_ai_gateway_model_catalog/iu);
  assert.match(sql, /status = 'SUCCEEDED'/iu);
});

test("053 makes sync domain events and connection transition audits append-only", async () => {
  const sql = await migrationSql();

  assert.match(sql, /CREATE TABLE IF NOT EXISTS ai_gateway_model_sync_events/iu);
  assert.match(sql, /FOREIGN KEY \(account_id, task_id, connection_id, connection_version\)[\s\S]*REFERENCES ai_gateway_model_sync_tasks\(account_id, id, connection_id, connection_version\)/iu);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS ai_gateway_connection_events/iu);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS ai_gateway_profile_binding_events/iu);
  assert.match(sql, /BEFORE UPDATE OR DELETE ON ai_gateway_model_sync_events/iu);
  assert.match(sql, /BEFORE UPDATE OR DELETE ON ai_gateway_connection_events/iu);
  assert.match(sql, /BEFORE UPDATE OR DELETE ON ai_gateway_profile_binding_events/iu);
  assert.match(sql, /BEFORE UPDATE OR DELETE ON audit_events/iu);
  assert.doesNotMatch(sql, /\b(?:DROP\s+(?:TABLE|COLUMN)|TRUNCATE|DELETE\s+FROM)\b/iu);
});

test("053 binds profiles and catalog evidence bidirectionally and keeps account privacy deletion coherent", async () => {
  const sql = await migrationSql();

  assert.match(sql, /connection_id IS NULL AND connection_version IS NULL[\s\S]*api_key_env_name <> 'SUB2API_ENCRYPTED_KEY'/iu);
  assert.match(sql, /UNIQUE \(account_id, id, config_version, connection_id, connection_version\)/iu);
  assert.match(sql, /FOREIGN KEY \(account_id, profile_id, config_version, connection_id, connection_version\)[\s\S]*REFERENCES ai_gateway_profiles\(account_id, id, config_version, connection_id, connection_version\)/iu);
  assert.match(sql, /FOREIGN KEY \(account_id, catalog_id, connection_id, connection_version\)[\s\S]*REFERENCES ai_gateway_model_catalogs\(account_id, id, connection_id, connection_version\)/iu);
  assert.match(sql, /NOT EXISTS \(SELECT 1 FROM accounts WHERE id = OLD\.account_id\)/iu);
  assert.match(sql, /NEW\.account_id IS NULL[\s\S]*NOT EXISTS \(SELECT 1 FROM accounts WHERE id = OLD\.account_id\)/iu);
});
