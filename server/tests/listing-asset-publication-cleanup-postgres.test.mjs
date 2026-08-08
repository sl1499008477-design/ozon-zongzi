import assert from "node:assert/strict";
import test from "node:test";

import { createPostgresListingAssetPublicationCleanupRepository } from "../listing-asset-publication-cleanup-postgres.mjs";

const row = {
  id: "cleanup-a", account_id: "account-a", job_id: "job-a", item_id: "item-a", plan_id: "plan-a",
  asset_id: "asset-a", content_hash: "a".repeat(64), public_object_key: "listing-media/v1/aa/file.png",
  publication_version: "LISTING_MEDIA_V1", public_base_url: "https://media.example.com/",
  public_prefix: "listing-media/v1", reason_code: "RECORD_UNCERTAIN", status: "PENDING",
  attempt_count: 0, lease_token: null, lease_expires_at: null,
};

test("cleanup repository records one account-scoped durable obligation", async () => {
  const calls = [];
  const pool = {
    async query(sql, values) { calls.push({ sql, values }); return { rows: [row] }; },
    async connect() { throw new Error("not used"); },
  };
  const repo = createPostgresListingAssetPublicationCleanupRepository({ pool, randomUUID: () => "fixed" });
  const result = await repo.recordCleanupRequired({
    accountId: "account-a", jobId: "job-a", itemId: "item-a", planId: "plan-a", assetId: "asset-a",
    contentHash: "a".repeat(64), publicObjectKey: row.public_object_key,
    publicationVersion: "LISTING_MEDIA_V1", publicBaseUrl: row.public_base_url,
    publicPrefix: row.public_prefix, reasonCode: "RECORD_UNCERTAIN",
  });
  assert.equal(result.accountId, "account-a");
  assert.match(calls[0].sql, /ON CONFLICT \(account_id,asset_id,content_hash,publication_version,public_object_key\) DO NOTHING/iu);
  assert.deepEqual(calls[0].values.slice(0, 3), ["cleanup-fixed", "account-a", "job-a"]);
});

test("claim serializes with publication inserts and globally checks references before DELETING", async () => {
  const calls = [];
  const client = { async query(sql, values) {
    calls.push({ sql, values });
    if (/FROM auto_listing_asset_publication_cleanup[\s\S]*FOR UPDATE/iu.test(sql)) return { rows: [row] };
    if (/FROM auto_listing_asset_publications/iu.test(sql)) return { rows: [] };
    if (/UPDATE auto_listing_asset_publication_cleanup/iu.test(sql)) return { rows: [{ ...row, status: "DELETING", attempt_count: 1, lease_token: "lease-fixed", lease_expires_at: new Date("2026-08-08T00:05:00Z") }] };
    return { rows: [] };
  }, release() { calls.push({ sql: "RELEASE" }); } };
  const pool = { async connect() { return client; }, async query() { throw new Error("unexpected pool query"); } };
  const repo = createPostgresListingAssetPublicationCleanupRepository({ pool, token: () => "lease-fixed", clock: () => new Date("2026-08-08T00:00:00Z") });
  const claimed = await repo.claimCleanup({ accountId: "account-a", cleanupId: "cleanup-a", workerId: "worker-a" });
  assert.equal(claimed.claimed, true);
  assert.equal(claimed.status, "DELETING");
  assert.equal(calls.some(({ sql }) => /pg_advisory_xact_lock\(hashtextextended/iu.test(sql)), true);
  const reference = calls.find(({ sql }) => /FROM auto_listing_asset_publications/iu.test(sql));
  assert.deepEqual(reference.values, [row.public_object_key, row.publication_version]);
  assert.doesNotMatch(reference.sql, /account_id=\$\d/iu);
});

test("cleanup poller returns only bounded runnable account-scoped task identities", async () => {
  const calls = [];
  const pool = {
    async query(sql, values) {
      calls.push({ sql, values });
      return { rows: [{ account_id: "account-a", id: "cleanup-a" }] };
    },
    async connect() { throw new Error("not used"); },
  };
  const repo = createPostgresListingAssetPublicationCleanupRepository({ pool });
  assert.deepEqual(await repo.listRunnableCleanupTasks({ limit: 10 }), [{ accountId: "account-a", cleanupId: "cleanup-a" }]);
  assert.match(calls[0].sql, /status='PENDING' OR \(status='DELETING' AND lease_expires_at<=NOW\(\)\)/iu);
  assert.deepEqual(calls[0].values, [10]);
});
