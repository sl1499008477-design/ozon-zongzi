import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sql = await readFile(new URL("../db/migrations/041_auto_listing_asset_publications.sql", import.meta.url), "utf8").catch(() => "");
const compatibilitySql = await readFile(new URL("../db/migrations/045_auto_listing_asset_publication_integrity.sql", import.meta.url), "utf8").catch(() => "");
const runtimeSql = await readFile(new URL("../db/migrations/047_auto_listing_asset_publication_runtime.sql", import.meta.url), "utf8").catch(() => "");
const envExample = await readFile(new URL("../../.env.example", import.meta.url), "utf8").catch(() => "");
const compose = await readFile(new URL("../../docker-compose.yml", import.meta.url), "utf8").catch(() => "");

test("041 stores immutable account/item/plan-bound public media evidence", () => {
  assert.match(sql, /CREATE TABLE IF NOT EXISTS auto_listing_asset_publications/iu);
  for (const column of ["account_id", "job_id", "item_id", "plan_id", "asset_id", "content_hash", "content_type", "size_bytes", "private_object_key", "public_object_key", "public_url", "publication_version"]) {
    assert.match(sql, new RegExp(`\\b${column}\\b`, "u"));
  }
  assert.match(sql, /FOREIGN KEY \(account_id,job_id,item_id,plan_id,asset_id\)[\s\S]*REFERENCES ai_generation_assets/iu);
  assert.match(sql, /UNIQUE \(account_id,asset_id,content_hash\)/iu);
  assert.match(sql, /BEFORE UPDATE OR DELETE ON auto_listing_asset_publications/iu);
  assert.doesNotMatch(sql, /DROP TABLE|DROP COLUMN|TRUNCATE|DELETE FROM|UPDATE\s+auto_listing/iu);
});

test("047 freezes publication policy and durably fences cleanup and DIRECT health evidence", () => {
  assert.match(runtimeSql, /ADD COLUMN IF NOT EXISTS public_base_url TEXT/iu);
  assert.match(runtimeSql, /ADD COLUMN IF NOT EXISTS public_prefix TEXT/iu);
  assert.match(runtimeSql, /public_url = public_base_url \|\| public_object_key/iu);
  assert.match(runtimeSql, /CREATE TABLE IF NOT EXISTS auto_listing_asset_publication_cleanup/iu);
  assert.match(runtimeSql, /UNIQUE \(account_id,asset_id,content_hash,publication_version,public_object_key\)/iu);
  assert.match(runtimeSql, /FOREIGN KEY \(account_id,job_id,item_id,plan_id,asset_id\)/iu);
  assert.match(runtimeSql, /CREATE TABLE IF NOT EXISTS auto_listing_asset_publication_health_evidence/iu);
  assert.match(runtimeSql, /evidence \?& ARRAY\['probeKind','httpStatus','contentTypeMatched','bytesMatched'\]/iu);
  assert.match(runtimeSql, /evidence - 'probeKind' - 'httpStatus' - 'contentTypeMatched' - 'bytesMatched'/iu);
  assert.match(runtimeSql, /checked_by_account_id = account_id/iu);
  assert.match(runtimeSql, /BEFORE UPDATE OR DELETE ON auto_listing_asset_publication_health_evidence/iu);
  assert.match(runtimeSql, /pg_advisory_xact_lock\(hashtextextended/iu);
  assert.match(runtimeSql, /cleanup\.status = 'DELETING'/iu);
  assert.doesNotMatch(runtimeSql, /DROP TABLE|DROP COLUMN|TRUNCATE|DELETE FROM/iu);
});

test("publication policy version is explicit in local and deployed configuration", () => {
  assert.match(envExample, /^LISTING_ASSET_PUBLICATION_VERSION=LISTING_MEDIA_V1$/mu);
  assert.match(compose, /LISTING_ASSET_PUBLICATION_VERSION:\s*\$\{LISTING_ASSET_PUBLICATION_VERSION:-LISTING_MEDIA_V1\}/u);
});

test("045 makes publication policy versioned and insert evidence exact, current-plan and accepted", () => {
  assert.match(compatibilitySql, /DROP CONSTRAINT IF EXISTS auto_listing_asset_publicatio_account_id_asset_id_content_h_key/iu);
  assert.match(compatibilitySql, /UNIQUE \(account_id,asset_id,content_hash,publication_version\)/iu);
  assert.match(compatibilitySql, /UNIQUE \(account_id,public_object_key,publication_version\)/iu);
  assert.match(compatibilitySql, /publication_version ~ '\^\[A-Z0-9\]/iu);
  assert.match(compatibilitySql, /BEFORE INSERT ON auto_listing_asset_publications/iu);
  assert.match(compatibilitySql, /asset\.status = 'ACCEPTED'/iu);
  assert.match(compatibilitySql, /item\.active_content_plan_id = NEW\.plan_id/iu);
  assert.match(compatibilitySql, /asset\.plan_id = NEW\.plan_id/iu);
  assert.match(compatibilitySql, /FOR UPDATE/iu);
  for (const comparison of [
    "NEW.visual_group_key = asset.visual_group_key", "NEW.slot_key = asset.slot_key",
    "NEW.role = asset.role", "NEW.content_hash = asset.content_hash",
    "NEW.content_type = asset.content_type", "NEW.size_bytes = asset.size_bytes",
    "NEW.width = asset.width", "NEW.height = asset.height",
    "NEW.private_object_key = asset.object_key",
  ]) assert.match(compatibilitySql, new RegExp(comparison.replaceAll(".", "\\."), "iu"));
  assert.doesNotMatch(compatibilitySql, /DROP TABLE|DROP COLUMN|TRUNCATE|DELETE FROM|UPDATE\s+auto_listing/iu);
});
