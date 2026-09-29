import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL(
  "../db/migrations/105_auto_listing_source_image_derivatives.sql",
  import.meta.url,
);

const sql = async () => readFile(migrationUrl, "utf8").catch(() => "");

test("migration 105 adds immutable account-scoped source-image cleanup attempts", async () => {
  const source = await sql();

  assert.match(source, /CREATE TABLE auto_listing_source_image_derivatives/iu);
  assert.match(source, /status TEXT NOT NULL CHECK \(status IN \(\s*'RESERVED','GENERATED','ACCEPTED','REJECTED','FAILED'\s*\)\)/iu);
  assert.match(source, /UNIQUE \(account_id,analysis_run_id,source_asset_id,input_hash,attempt_no\)/iu);
  assert.match(source, /FOREIGN KEY \(account_id,job_id,item_id,analysis_run_id,source_asset_id\)[\s\S]*auto_listing_source_image_assessments/iu);
  assert.match(source, /CREATE UNIQUE INDEX auto_listing_source_image_derivatives_one_accepted[\s\S]*WHERE status='ACCEPTED'/iu);
  assert.match(source, /IF TG_OP='DELETE'/iu);
  assert.match(source, /OLD\.status IN \('ACCEPTED','REJECTED','FAILED'\)/iu);
});

test("migration 105 opens only the V2 run and cleanup outbox constraints needed by the feature", async () => {
  const source = await sql();

  assert.match(source, /AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_V1/iu);
  assert.match(source, /AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_V2/iu);
  assert.match(source, /pg_get_constraintdef\(constraint_definition\.oid\)[\s\S]*intelligence_contract_version/iu);
  assert.match(source, /DROP CONSTRAINT %I/iu);
  assert.match(source, /ADD CONSTRAINT auto_listing_source_image_analysis_contract_check/iu);
  assert.match(source, /CLEAN_SOURCE_IMAGE_OVERLAY/iu);
  assert.match(source, /CHECK_SOURCE_IMAGE_CLEANUP/iu);
  assert.match(source, /derivativeAttemptId/iu);
  assert.match(source, /value \? 'analysisRunId'/iu);
  assert.match(source, /key_count=8/iu);
  assert.doesNotMatch(source, /ALTER TABLE[\s\S]+DISABLE TRIGGER/iu);
});
