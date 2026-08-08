import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL("../db/migrations/048_auto_listing_upload_claim_integrity.sql", import.meta.url);

test("048 freezes publication evidence and enforces one immutable claim per account item", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /publication_origin TEXT/iu);
  assert.match(sql, /publication_policy_hash TEXT/iu);
  assert.match(sql, /media_evidence_hash TEXT/iu);
  assert.match(sql, /claim_token TEXT/iu);
  assert.match(sql, /attempt_generation INTEGER NOT NULL DEFAULT 1/iu);
  assert.match(sql, /UNIQUE INDEX[\s\S]*?\(account_id,auto_listing_item_id\)/iu);
  assert.match(sql, /NEW\.created_by IS DISTINCT FROM NEW\.account_id/iu);
  assert.match(sql, /NEW\.published_by IS DISTINCT FROM NEW\.account_id/iu);
  assert.match(sql, /role='admin'/iu);
  assert.match(sql, /auto_listing_upload_policy_versions_publication_evidence_check/iu);
  assert.doesNotMatch(sql, /OLD\.status='FAILED' AND NEW\.status='RESERVED'/iu);
});
