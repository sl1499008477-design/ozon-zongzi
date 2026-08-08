import assert from "node:assert/strict";
import test from "node:test";

import { createPostgresAutoListingUploadPolicyAdminRepository } from "../auto-listing-upload-policy-admin-postgres.mjs";

const publication = Object.freeze({
  accountId: "account-a", actorId: "account-a", mode: "REVIEW",
  publicationReason: "开发期间人工审核", idempotencyKey: "policy-key", correlationId: "corr-a",
  publicationOrigin: "https://media.example.com",
  publicationBaseUrl: "https://media.example.com/listing/",
  publicationPrefix: "listing-media/v2", publicationVersion: "LISTING_MEDIA_V2",
  publicationPolicyHash: "a".repeat(64), healthEvidenceId: null,
});

function row(overrides = {}) {
  return {
    id: "policy-2", account_id: "account-a", version: 2, mode: "REVIEW", enabled: true,
    publication_reason: "开发期间人工审核", published_by: "account-a",
    published_at: new Date("2026-08-08T00:00:00.000Z"),
    publication_origin: publication.publicationOrigin,
    publication_base_url: publication.publicationBaseUrl,
    publication_prefix: publication.publicationPrefix,
    publication_version: publication.publicationVersion,
    publication_policy_hash: publication.publicationPolicyHash,
    ...overrides,
  };
}

test("list query is explicitly account scoped and maps only public policy evidence", async () => {
  const calls = [];
  const repository = createPostgresAutoListingUploadPolicyAdminRepository({
    pool: {
      query: async (sql, params) => { calls.push([sql, params]); return { rows: [row()] }; },
      connect: async () => { throw new Error("unused"); },
    },
  });
  const result = await repository.listPolicies({ accountId: "account-a" });
  assert.equal(result[0].accountId, "account-a");
  assert.equal(Object.hasOwn(result[0], "apiKey"), false);
  assert.match(calls[0][0], /WHERE account_id=\$1/iu);
  for (const column of ["publication_origin", "publication_base_url", "publication_prefix",
    "publication_version"]) {
    assert.match(calls[0][0], new RegExp(`${column} IS NOT NULL`, "iu"));
  }
  assert.match(calls[0][0], /publication_policy_hash\s*~/iu);
  assert.deepEqual(calls[0][1], ["account-a"]);
});

test("preflight replay uses only the client command so runtime publication drift cannot break idempotency", async () => {
  let metadata = null;
  let stored = null;
  const client = {
    async query(sql, params = []) {
      if (/SELECT id,role FROM accounts/iu.test(sql)) return { rows: [{ id: "account-a", role: "admin" }] };
      if (/SELECT metadata FROM audit_events/iu.test(sql)) return { rows: [] };
      if (/MAX\(version\)/iu.test(sql)) return { rows: [{ current_version: 0 }] };
      if (/INSERT INTO auto_listing_upload_policy_versions/iu.test(sql)) {
        stored = row({ id: params[0], version: 1 });
        return { rows: [stored] };
      }
      if (/INSERT INTO audit_events/iu.test(sql)) {
        metadata = JSON.parse(params[4]);
        return { rowCount: 1, rows: [{}] };
      }
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };
  const pool = {
    connect: async () => client,
    async query(sql) {
      if (/SELECT metadata FROM audit_events/iu.test(sql)) return { rows: [{ metadata }] };
      if (/FROM auto_listing_upload_policy_versions/iu.test(sql)) return { rows: [stored] };
      return { rows: [] };
    },
  };
  const repository = createPostgresAutoListingUploadPolicyAdminRepository({ pool });
  await repository.publishPolicy(publication);
  const replay = await repository.findPolicyReplay({
    accountId: publication.accountId, mode: publication.mode,
    publicationReason: publication.publicationReason, idempotencyKey: publication.idempotencyKey,
  });
  assert.equal(replay.duplicate, true);
  assert.equal(replay.publicationBaseUrl, publication.publicationBaseUrl);
});

test("publish locks the account, allocates the next version and writes policy plus audit atomically", async () => {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push([sql, params]);
      if (/SELECT id,role FROM accounts/iu.test(sql)) return { rows: [{ id: "account-a", role: "admin" }] };
      if (/SELECT metadata FROM audit_events/iu.test(sql)) return { rows: [] };
      if (/MAX\(version\)/iu.test(sql)) return { rows: [{ current_version: 1 }] };
      if (/INSERT INTO auto_listing_upload_policy_versions/iu.test(sql)) return { rows: [row()] };
      if (/INSERT INTO audit_events/iu.test(sql)) return { rowCount: 1, rows: [{}] };
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };
  const repository = createPostgresAutoListingUploadPolicyAdminRepository({
    pool: { connect: async () => client, query: async () => ({ rows: [] }) },
  });
  const result = await repository.publishPolicy(publication);
  assert.equal(result.version, 2);
  assert.equal(result.duplicate, false);
  assert.match(calls.find(([sql]) => /SELECT id,role FROM accounts/iu.test(sql))[0], /FOR UPDATE/iu);
  const inserted = calls.find(([sql]) => /INSERT INTO auto_listing_upload_policy_versions/iu.test(sql));
  assert.equal(inserted[1].includes("REVIEW"), true);
  assert.equal(inserted[1].includes("LISTING_MEDIA_V2"), true);
  assert.equal(calls.some(([sql]) => sql === "COMMIT"), true);
});

test("same idempotency key replays the recorded policy and a different request conflicts", async () => {
  let metadata = null;
  let stored = null;
  const client = {
    async query(sql, params = []) {
      if (/SELECT id,role FROM accounts/iu.test(sql)) return { rows: [{ id: "account-a", role: "admin" }] };
      if (/SELECT metadata FROM audit_events/iu.test(sql)) return { rows: metadata ? [{ metadata }] : [] };
      if (/MAX\(version\)/iu.test(sql)) return { rows: [{ current_version: 1 }] };
      if (/INSERT INTO auto_listing_upload_policy_versions/iu.test(sql)) {
        stored = row({ id: params[0] });
        return { rows: [stored] };
      }
      if (/INSERT INTO audit_events/iu.test(sql)) {
        metadata = JSON.parse(params[4]);
        return { rowCount: 1, rows: [{}] };
      }
      if (/FROM auto_listing_upload_policy_versions/iu.test(sql)) return { rows: stored ? [stored] : [] };
      return { rows: [], rowCount: 0 };
    }, release() {},
  };
  const repository = createPostgresAutoListingUploadPolicyAdminRepository({
    pool: { connect: async () => client, query: async () => ({ rows: [] }) },
  });
  assert.equal((await repository.publishPolicy(publication)).duplicate, false);
  assert.equal((await repository.publishPolicy(publication)).duplicate, true);
  await assert.rejects(repository.publishPolicy({ ...publication, publicationReason: "changed" }), {
    code: "AUTO_LISTING_UPLOAD_POLICY_ADMIN_CONFLICT",
  });
});

test("invalid tenant input is rejected before a database query", async () => {
  let queried = false;
  const repository = createPostgresAutoListingUploadPolicyAdminRepository({
    pool: { query: async () => { queried = true; }, connect: async () => { queried = true; } },
  });
  await assert.rejects(repository.publishPolicy({ ...publication, actorId: "account-b" }), {
    code: "AUTO_LISTING_UPLOAD_POLICY_ADMIN_REPOSITORY_INVALID",
  });
  assert.equal(queried, false);
});

test("DIRECT publication rechecks the exact unexpired account media evidence inside the transaction", async () => {
  let inserted = false;
  const client = {
    async query(sql, params = []) {
      if (/SELECT id,role FROM accounts/iu.test(sql)) return { rows: [{ id: "account-a", role: "admin" }] };
      if (/SELECT metadata FROM audit_events/iu.test(sql)) return { rows: [] };
      if (/auto_listing_asset_publication_health_evidence/iu.test(sql)) {
        assert.deepEqual(params, ["account-a", "health-a", "LISTING_MEDIA_V2",
          "https://media.example.com/listing/", "listing-media/v2"]);
        return { rows: [] };
      }
      if (/INSERT INTO auto_listing_upload_policy_versions/iu.test(sql)) inserted = true;
      return { rows: [], rowCount: 0 };
    }, release() {},
  };
  const repository = createPostgresAutoListingUploadPolicyAdminRepository({
    pool: { connect: async () => client, query: async () => ({ rows: [] }) },
  });
  await assert.rejects(repository.publishPolicy({
    ...publication, mode: "DIRECT", healthEvidenceId: "health-a",
  }), { code: "AUTO_LISTING_DIRECT_POLICY_NOT_READY" });
  assert.equal(inserted, false);
});
