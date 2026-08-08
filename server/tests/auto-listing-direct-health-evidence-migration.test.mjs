import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL("../db/migrations/052_auto_listing_direct_health_evidence.sql", import.meta.url);

test("052 freezes account-scoped DIRECT health evidence on links and append-only attempts", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /ALTER TABLE auto_listing_submission_links[\s\S]*?direct_health_evidence_id TEXT/iu);
  assert.match(sql, /ALTER TABLE auto_listing_upload_attempts[\s\S]*?direct_health_evidence_id TEXT/iu);
  assert.match(sql, /direct_health_fkey[\s\S]*?NOT VALID/iu);
  assert.match(sql, /direct_health_shape_check[\s\S]*?NOT VALID/iu);
  assert.doesNotMatch(sql, /direct_health_evidence_id SET NOT NULL/iu);
  assert.match(sql, /auto_listing_asset_publication_health_evidence/iu);
  assert.match(sql, /health\.account_id = NEW\.account_id/iu);
  assert.match(sql, /health\.publication_version = NEW\.publication_version/iu);
  assert.match(sql, /health\.public_base_url = NEW\.publication_base_url/iu);
  assert.match(sql, /health\.public_prefix = NEW\.publication_prefix/iu);
  assert.match(sql, /health\.outcome = 'PASSED'/iu);
  assert.match(sql, /health\.expires_at > NOW\(\)/iu);
  assert.match(sql, /NEW\.direct_health_evidence_id IS DISTINCT FROM OLD\.direct_health_evidence_id/iu);
  assert.match(sql, /action = 'DIRECT_UPLOAD'/iu);
});
