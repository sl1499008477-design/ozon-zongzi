import assert from "node:assert/strict";
import test from "node:test";

import { createPostgresListingAssetPublicationHealthRepository } from "../listing-asset-publication-health-postgres.mjs";

const row = {
  id: "health-a", account_id: "account-a", publication_version: "LISTING_MEDIA_V1",
  public_base_url: "https://media.example.com/ozon/", public_prefix: "listing-media/v1",
  outcome: "PASSED", evidence: { probeKind: "PUBLIC_READBACK", httpStatus: 200, contentTypeMatched: true, bytesMatched: true },
  checked_by_account_id: "account-a", checked_at: new Date("2026-08-08T00:00:00Z"),
  expires_at: new Date("2026-08-08T00:05:00Z"),
};

test("health repository appends account and exact-policy evidence", async () => {
  const calls = [];
  const pool = { async query(sql, values) { calls.push({ sql, values }); return { rows: [row] }; } };
  const repo = createPostgresListingAssetPublicationHealthRepository({ pool, randomUUID: () => "fixed" });
  const result = await repo.recordEvidence({
    accountId: "account-a", publicationVersion: "LISTING_MEDIA_V1",
    publicBaseUrl: row.public_base_url, publicPrefix: row.public_prefix, outcome: "PASSED",
    evidence: row.evidence, checkedByAccountId: "account-a", checkedAt: row.checked_at, expiresAt: row.expires_at,
  });
  assert.equal(result.id, "health-a");
  assert.match(calls[0].sql, /INSERT INTO auto_listing_asset_publication_health_evidence/iu);
  assert.doesNotMatch(calls[0].sql, /ON CONFLICT|UPDATE/iu);
  assert.deepEqual(calls[0].values.slice(0, 3), ["health-fixed", "account-a", "LISTING_MEDIA_V1"]);
});

test("DIRECT readiness reads only unexpired PASSED evidence for exact account and policy", async () => {
  const calls = [];
  const pool = { async query(sql, values) { calls.push({ sql, values }); return { rows: [row] }; } };
  const repo = createPostgresListingAssetPublicationHealthRepository({ pool });
  const result = await repo.findReadyEvidence({
    accountId: "account-a", publicationVersion: "LISTING_MEDIA_V1",
    publicBaseUrl: row.public_base_url, publicPrefix: row.public_prefix, now: new Date("2026-08-08T00:01:00Z"),
  });
  assert.equal(result.outcome, "PASSED");
  assert.match(calls[0].sql, /account_id=\$1[\s\S]*publication_version=\$2[\s\S]*public_base_url=\$3[\s\S]*public_prefix=\$4/iu);
  assert.match(calls[0].sql, /outcome='PASSED'[\s\S]*expires_at>\$5/iu);
});
