import assert from "node:assert/strict";
import test from "node:test";

import { createPostgresAutoListingUploadRepository } from "../auto-listing-upload-postgres.mjs";

function pool() {
  const calls = [];
  const client = { async query(sql, params) {
    calls.push({ sql, params });
    if (/FROM auto_listing_job_items AS item/.test(sql) && /ai_content_plans/.test(sql)) return { rows: [] };
    return { rows: [], rowCount: 0 };
  }, release() {} };
  return { calls, connect: async () => client, query: client.query.bind(client) };
}

test("PostgreSQL evidence read is account-scoped and joins every frozen/accepted boundary", async () => {
  const database = pool();
  const repository = createPostgresAutoListingUploadRepository({ pool: database });
  assert.equal(await repository.loadUploadEvidence({ accountId: "account-a", itemId: "item-a" }), null);
  const sql = await import("node:fs/promises").then((fs) => fs.readFile(new URL("../auto-listing-upload-postgres.mjs", import.meta.url), "utf8"));
  assert.match(sql, /item\.account_id=\$1 AND item\.id=\$2/);
  assert.match(sql, /auto_listing_listing_bases/);
  assert.match(sql, /ai_content_plans/);
  assert.match(sql, /product_drafts/);
  assert.match(sql, /store_credentials/);
  assert.match(sql, /ai_generation_assets/);
  assert.match(sql, /ai_rich_content_results/);
  assert.match(sql, /DISTINCT ON \(group_key\)/);
  assert.match(sql, /expected_status_version DESC NULLS LAST/);
});

test("reserve and bind use short transactions, lock item/version/source evidence, and never call Ozon", async () => {
  const database = pool();
  const repository = createPostgresAutoListingUploadRepository({ pool: database, randomUUID: () => "uuid" });
  await assert.rejects(repository.reserveSubmission({ accountId: "account-a" }), /INVALID/);
  const source = await import("node:fs/promises").then((fs) => fs.readFile(new URL("../auto-listing-upload-postgres.mjs", import.meta.url), "utf8"));
  assert.match(source, /BEGIN/);
  assert.match(source, /FOR UPDATE OF item/);
  assert.match(source, /product_draft_data_hash/);
  assert.match(source, /ON CONFLICT \(account_id,auto_listing_item_id\)/);
  assert.match(source, /status='UPLOAD_QUEUED'/);
  assert.match(source, /SET status='UPLOADING',status_version=status_version\+1/);
  assert.match(source, /claim_token=\$6/);
  assert.match(source, /INSERT INTO auto_listing_upload_attempts/);
  assert.match(source, /INSERT INTO auto_listing_submission_reconcile_tasks/);
  assert.match(source, /INSERT INTO auto_listing_submission_reconcile_events/);
  assert.match(source, /UPDATE auto_listing_submission_links/);
  assert.doesNotMatch(source, /callOzonSellerApi|ozon-client|putPublicObject|createSubmissionV3/);
});

test("PostgreSQL infrastructure failures retain retryable evidence for the durable worker", async () => {
  const client = {
    async query(sql) {
      if (/^BEGIN/u.test(sql) || /^ROLLBACK/u.test(sql)) return { rows: [], rowCount: 0 };
      throw Object.assign(new Error("database unavailable"), { code: "08006" });
    },
    release() {},
  };
  const repository = createPostgresAutoListingUploadRepository({
    pool: { connect: async () => client, query: client.query.bind(client) },
  });
  await assert.rejects(repository.loadUploadEvidence({ accountId: "account-a", itemId: "item-a" }), {
    code: "AUTO_LISTING_UPLOAD_REPOSITORY_FAILED",
    retryable: true,
  });
});
