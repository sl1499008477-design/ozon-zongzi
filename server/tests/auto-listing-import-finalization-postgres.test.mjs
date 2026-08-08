import assert from "node:assert/strict";
import test from "node:test";

import { createPostgresAutoListingImportFinalizationRepository } from "../auto-listing-import-finalization-postgres.mjs";

function harness({ file, jobRows = [] } = {}) {
  const calls = [];
  const currentFile = file || {
    id: "import-1", account_id: "account-a", status: "COLLECTING", status_version: "2",
    accepted_rows: 2, ready_rows: 1, failed_rows: 1, generated_job_id: null,
  };
  const client = {
    async query(sql, params = []) {
      calls.push({ sql: String(sql), params });
      if (/SELECT \* FROM auto_listing_import_files/u.test(sql)) return { rows: [currentFile] };
      if (/SELECT j\.id AS job_id/u.test(sql)) return { rows: jobRows };
      if (/SELECT id,status,auto_listing_item_id/u.test(sql)) return { rows: [{ id: "row-1", status: "READY", auto_listing_item_id: null }] };
      if (/UPDATE auto_listing_import_files/u.test(sql)) return { rows: [{ ...currentFile, status: "PARTIAL", status_version: "3", generated_job_id: "job-1" }], rowCount: 1 };
      if (/UPDATE auto_listing_import_rows/u.test(sql)) return { rows: [{ id: "row-1" }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
    release() { calls.push({ sql: "RELEASE", params: [] }); },
  };
  return {
    calls,
    repository: createPostgresAutoListingImportFinalizationRepository({
      pool: { query: async () => ({ rows: [] }), connect: async () => client },
    }),
  };
}

test("finalizes a collected import only after verifying exact Excel job row links", async () => {
  const { repository, calls } = harness({ jobRows: [{
    job_id: "job-1", account_id: "account-a", source_type: "EXCEL_SKU",
    item_id: "item-1", source_record_id: "row-1",
  }] });
  const result = await repository.finalizeWithJob({
    accountId: "account-a", importFileId: "import-1", expectedStatusVersion: 2,
    jobId: "job-1", itemLinks: [{ rowId: "row-1", itemId: "item-1" }],
  });
  assert.deepEqual(result, { status: "PARTIAL", jobId: "job-1", duplicate: false });
  const statements = calls.map(({ sql }) => sql);
  const fileUpdate = statements.findIndex((sql) => /UPDATE auto_listing_import_files/u.test(sql));
  const rowUpdate = statements.findIndex((sql) => /UPDATE auto_listing_import_rows/u.test(sql));
  assert.ok(fileUpdate >= 0 && rowUpdate > fileUpdate);
  assert.match(statements[fileUpdate], /generated_job_id=\$4/u);
  assert.match(statements[rowUpdate], /auto_listing_item_id=\$3/u);
});

test("an import with no accepted SKU closes without creating a job", async () => {
  const { repository, calls } = harness({ file: {
    id: "import-empty", account_id: "account-a", status: "QUEUED", status_version: "1",
    accepted_rows: 0, ready_rows: 0, failed_rows: 0, generated_job_id: null,
  } });
  const result = await repository.finalizeWithoutJob({
    accountId: "account-a", importFileId: "import-empty", expectedStatusVersion: 1,
  });
  assert.deepEqual(result, { status: "FAILED", jobId: null, duplicate: false });
  const update = calls.find(({ sql }) => /UPDATE auto_listing_import_files/u.test(sql));
  assert.match(update.sql, /last_error_code='AUTO_LISTING_IMPORT_NO_ACCEPTED_SKUS'/u);
  assert.equal(calls.some(({ sql }) => /auto_listing_jobs/u.test(sql)), false);
});

test("lists only counter-complete collecting imports or queued imports with no accepted rows", async () => {
  const queries = [];
  const repository = createPostgresAutoListingImportFinalizationRepository({
    pool: {
      connect: async () => assert.fail("list uses a direct query"),
      async query(sql, params) {
        queries.push({ sql: String(sql), params });
        return { rows: [{
          id: "import-1", account_id: "account-a", status: "COLLECTING", status_version: "2",
          accepted_rows: 1, ready_rows: 1, failed_rows: 0,
        }] };
      },
    },
  });
  const rows = await repository.listFinalizableImports({ accountId: "account-a", limit: 20 });
  assert.equal(rows[0].id, "import-1");
  assert.match(queries[0].sql, /ready_rows\+failed_rows=accepted_rows/u);
  assert.match(queries[0].sql, /status='QUEUED' AND accepted_rows=0/u);
  assert.deepEqual(queries[0].params, ["account-a", 20]);
});

test("discovers accounts whose imports are ready for finalization", async () => {
  const queries = [];
  const repository = createPostgresAutoListingImportFinalizationRepository({
    pool: {
      connect: async () => assert.fail("discovery uses a direct query"),
      async query(sql, params) {
        queries.push({ sql: String(sql), params });
        return { rows: [{ account_id: "account-a" }] };
      },
    },
  });
  assert.deepEqual(await repository.listFinalizableAccountIds({ cursor: null, limit: 50 }), ["account-a"]);
  assert.match(queries[0].sql, /ready_rows\+failed_rows=accepted_rows/u);
  assert.deepEqual(queries[0].params, [null, 50]);
});

test("rejects a job whose snapshot rows do not exactly match the ready import rows", async () => {
  const { repository, calls } = harness({ jobRows: [{
    job_id: "job-1", account_id: "account-a", source_type: "EXCEL_SKU",
    item_id: "item-foreign", source_record_id: "row-foreign",
  }] });
  await assert.rejects(repository.finalizeWithJob({
    accountId: "account-a", importFileId: "import-1", expectedStatusVersion: 2,
    jobId: "job-1", itemLinks: [{ rowId: "row-1", itemId: "item-1" }],
  }), { code: "AUTO_LISTING_IMPORT_FINALIZATION_CONFLICT" });
  assert.equal(calls.some(({ sql }) => /UPDATE auto_listing_import_files/u.test(sql)), false);
});
