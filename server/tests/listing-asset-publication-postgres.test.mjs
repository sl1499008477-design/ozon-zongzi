import assert from "node:assert/strict";
import test from "node:test";

import { createPostgresListingAssetPublicationRepository } from "../listing-asset-publication-postgres.mjs";

const hash = "a".repeat(64);
const publicationRow = {
  account_id: "account-a", job_id: "job-a", item_id: "item-a", plan_id: "plan-a", asset_id: "asset-a",
  visual_group_key: "group-a", slot_key: "main-1", role: "MAIN", content_hash: hash,
  content_type: "image/png", size_bytes: "123", width: 900, height: 1200,
  public_object_key: `listing-media/v1/aa/${hash}.png`, public_url: `https://media.example.com/${hash}.png`,
  publication_version: "LISTING_MEDIA_V2", public_base_url: "https://media.example.com/", public_prefix: "listing-media/v2",
};

test("repository finds publications only when exact immutable evidence remains accepted on the current plan", async () => {
  const calls = [];
  const pool = { async query(sql, values) { calls.push({ sql, values }); return { rows: [publicationRow] }; } };
  const repo = createPostgresListingAssetPublicationRepository({ pool });
  const result = await repo.findPublication({ accountId: "account-a", itemId: "item-a", assetId: "asset-a", publicationVersion: "LISTING_MEDIA_V2" });
  assert.equal(result.publicationVersion, "LISTING_MEDIA_V2");
  assert.deepEqual(calls[0].values, ["account-a", "item-a", "asset-a", "LISTING_MEDIA_V2"]);
  assert.match(calls[0].sql, /JOIN ai_generation_assets AS asset/iu);
  assert.match(calls[0].sql, /asset\.plan_id=item\.active_content_plan_id/iu);
  assert.match(calls[0].sql, /asset\.status='ACCEPTED'/iu);
  for (const field of ["visual_group_key", "slot_key", "role", "content_hash", "content_type", "size_bytes", "width", "height", "private_object_key"]) {
    assert.match(calls[0].sql, new RegExp(`publication\\.${field}=asset\\.${field === "private_object_key" ? "object_key" : field}`, "iu"));
  }
});

test("repository loads complete ATTEMPT_V2 evidence before private storage access", async () => {
  const calls = [];
  const pool = { async query(sql, values) {
    calls.push({ sql, values });
    return { rows: [{
      id: "asset-a", account_id: "account-a", job_id: "job-a", item_id: "item-a", plan_id: "plan-a",
      visual_group_key: "group-a", slot_key: "main-1", role: "MAIN", status: "ACCEPTED",
      object_key_version: "ATTEMPT_V2", object_key: "auto-listing/v2/key.png",
      attempt_identity_hash: "b".repeat(64), attempt_no: 1, input_hash: "c".repeat(64),
      content_hash: hash, content_type: "image/png", size_bytes: "123", width: 900, height: 1200,
    }] };
  } };
  const repo = createPostgresListingAssetPublicationRepository({ pool });
  const result = await repo.loadAcceptedAsset({ accountId: "account-a", itemId: "item-a", assetId: "asset-a" });
  assert.equal(result.objectKeyVersion, "ATTEMPT_V2");
  assert.equal(result.attemptIdentityHash, "b".repeat(64));
  assert.equal(result.attemptNo, 1);
  assert.equal(result.inputHash, "c".repeat(64));
  assert.match(calls[0].sql, /object_key_version/iu);
  assert.match(calls[0].sql, /attempt_identity_hash/iu);
});

test("record uses one atomic INSERT SELECT from current accepted source and reloads only same version", async () => {
  const calls = [];
  const pool = { async query(sql, values) {
    calls.push({ sql, values });
    if (/INSERT INTO auto_listing_asset_publications/iu.test(sql)) return { rows: [publicationRow] };
    return { rows: [publicationRow] };
  } };
  const repo = createPostgresListingAssetPublicationRepository({ pool, randomUUID: () => "fixed" });
  const input = {
    accountId: "account-a", jobId: "job-a", itemId: "item-a", planId: "plan-a", assetId: "asset-a",
    publicObjectKey: `listing-media/v2/aa/${hash}.png`, publishedUrl: `https://media.example.com/${hash}.png`,
    publicationVersion: "LISTING_MEDIA_V2", publicBaseUrl: "https://media.example.com/",
    publicPrefix: "listing-media/v2", publishedByAccountId: "account-a",
  };
  const result = await repo.recordPublication(input);
  assert.equal(result.assetId, "asset-a");
  assert.match(calls[0].sql, /INSERT INTO auto_listing_asset_publications[\s\S]*SELECT[\s\S]*FROM ai_generation_assets AS asset/iu);
  assert.match(calls[0].sql, /asset\.plan_id=item\.active_content_plan_id/iu);
  assert.match(calls[0].sql, /asset\.status='ACCEPTED'/iu);
  assert.match(calls[0].sql, /ON CONFLICT \(account_id,asset_id,content_hash,publication_version\) DO NOTHING/iu);
  assert.deepEqual(calls[0].values.slice(0, 6), ["publication-fixed", "account-a", "job-a", "item-a", "plan-a", "asset-a"]);
});

test("record returns null when plan changed and no current-version publication exists", async () => {
  const pool = { async query(sql) {
    if (/INSERT INTO/iu.test(sql)) return { rows: [] };
    return { rows: [] };
  } };
  const repo = createPostgresListingAssetPublicationRepository({ pool, randomUUID: () => "fixed" });
  const result = await repo.recordPublication({
    accountId: "account-a", jobId: "job-a", itemId: "item-a", planId: "plan-a", assetId: "asset-a",
    publicObjectKey: "listing-media/v2/key.png", publishedUrl: "https://media.example.com/key.png",
    publicationVersion: "LISTING_MEDIA_V2", publicBaseUrl: "https://media.example.com/",
    publicPrefix: "listing-media/v2", publishedByAccountId: "account-a",
  });
  assert.equal(result, null);
});
