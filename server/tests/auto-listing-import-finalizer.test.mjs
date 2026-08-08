import assert from "node:assert/strict";
import test from "node:test";

import { createAutoListingImportFinalizer } from "../auto-listing-import-finalizer.mjs";

test("creates one job for ready rows and links it through the repository", async () => {
  const calls = { create: [], finalize: [] };
  const finalizer = createAutoListingImportFinalizer({
    repository: {
      async listFinalizableImports() { return [{ id: "import-1", accountId: "account-a", status: "COLLECTING", statusVersion: 2, acceptedRows: 2, readyRows: 1, failedRows: 1 }]; },
      async finalizeWithJob(input) { calls.finalize.push(input); return { status: "PARTIAL", jobId: "job-1" }; },
      async finalizeWithoutJob() { assert.fail("ready rows require a job"); },
    },
    async createExcelJob(input) {
      calls.create.push(input);
      return { jobId: "job-1", sourceType: "EXCEL_SKU", items: [{ itemId: "item-1", sourceRecordId: "row-1" }] };
    },
  });
  assert.deepEqual(await finalizer.finalizeAccount({ accountId: "account-a", limit: 10 }), {
    inspected: 1, finalized: 1, failed: 0,
  });
  assert.deepEqual(calls.create, [{ actor: { id: "account-a", role: "user" }, importFileId: "import-1" }]);
  assert.deepEqual(calls.finalize[0].itemLinks, [{ rowId: "row-1", itemId: "item-1" }]);
});

test("closes a zero-accepted import without invoking job creation", async () => {
  let creates = 0;
  const finalizer = createAutoListingImportFinalizer({
    repository: {
      async listFinalizableImports() { return [{ id: "import-empty", accountId: "account-a", status: "QUEUED", statusVersion: 1, acceptedRows: 0, readyRows: 0, failedRows: 0 }]; },
      async finalizeWithJob() { assert.fail("empty import has no job"); },
      async finalizeWithoutJob(input) { assert.equal(input.importFileId, "import-empty"); return { status: "FAILED" }; },
    },
    async createExcelJob() { creates += 1; },
  });
  const result = await finalizer.finalizeAccount({ accountId: "account-a", limit: 10 });
  assert.equal(result.finalized, 1);
  assert.equal(creates, 0);
});

test("isolates one import failure and never logs raw upstream text", async () => {
  const logs = [];
  const finalizer = createAutoListingImportFinalizer({
    repository: {
      async listFinalizableImports() { return [
        { id: "import-bad", accountId: "account-a", status: "COLLECTING", statusVersion: 2, acceptedRows: 1, readyRows: 1, failedRows: 0 },
        { id: "import-empty", accountId: "account-a", status: "QUEUED", statusVersion: 1, acceptedRows: 0, readyRows: 0, failedRows: 0 },
      ]; },
      async finalizeWithJob() {},
      async finalizeWithoutJob() { return { status: "FAILED" }; },
    },
    async createExcelJob() { throw new Error("api-key=secret upstream"); },
    logger: { warn(value) { logs.push(value); } },
  });
  assert.deepEqual(await finalizer.finalizeAccount({ accountId: "account-a", limit: 10 }), {
    inspected: 2, finalized: 1, failed: 1,
  });
  assert.doesNotMatch(JSON.stringify(logs), /secret|api-key|upstream/i);
});
