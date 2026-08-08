import assert from "node:assert/strict";
import test from "node:test";

import { createAutoListingImportRecoveryService } from "../auto-listing-import-recovery-service.mjs";

const actor = Object.freeze({ id: "account-a", role: "user" });

function fixture(overrides = {}) {
  return {
    importFile: {
      id: "import-a", accountId: "account-a", sourceFileName: "skus.xlsx", status: "PARTIAL",
      statusVersion: 4, totalRows: 4, readyRows: 1, failedRows: 2, rejectedRows: 1,
      duplicateRows: 0, generatedJobId: "job-secret", retryOfImportId: null,
      objectKey: "auto-listing/imports/v1/account-a/import-a/workbook.xlsx",
      configSnapshot: { secret: true }, createdAt: "2026-08-08T00:00:00.000Z",
      updatedAt: "2026-08-08T00:01:00.000Z", ...overrides,
    },
    rowsTruncated: false,
    recoverableFailedRows: 1,
    hasRetrySuccessor: false,
    rows: [
      { id: "row-3", accountId: "account-a", importFileId: "import-a", rowNumber: 3,
        normalizedSku: "SKU-3", rawSku: "private raw", status: "FAILED", statusVersion: 4,
        attemptCount: 5, lastErrorCode: "OZON_SKU_COLLECTION_FAILED", collectItemId: null, autoListingItemId: null },
      { id: "row-4", accountId: "account-a", importFileId: "import-a", rowNumber: 4,
        normalizedSku: "SKU-4", rawSku: "private raw", status: "FAILED", statusVersion: 4,
        attemptCount: 5, lastErrorCode: "AUTO_LISTING_SOURCE_RESULT_INVALID", collectItemId: null, autoListingItemId: null },
    ],
  };
}

function harness() {
  const calls = [];
  const repository = {
    async getImportDetail(input) { calls.push(["detail", input]); return fixture(); },
    async retryFailedRows(input) {
      calls.push(["retry", input]);
      return { ...fixture({ id: "import-retry", status: "QUEUED", statusVersion: 1,
        totalRows: 1, readyRows: 0, failedRows: 0, rejectedRows: 0, generatedJobId: null,
        retryOfImportId: "import-a" }).importFile, duplicate: false };
    },
  };
  return { service: createAutoListingImportRecoveryService({ repository }), calls };
}

test("import detail is account scoped and exposes only safe row summaries", async () => {
  const { service, calls } = harness();
  const result = await service.getImportDetail({ actor, importId: "import-a" });
  assert.deepEqual(calls, [["detail", { accountId: "account-a", importId: "import-a" }]]);
  assert.equal(result.id, "import-a");
  assert.equal(result.statusVersion, 4);
  assert.equal(result.recoverableFailedRows, 1);
  assert.equal(result.actions.retry, true);
  assert.equal(result.rowsTruncated, false);
  assert.deepEqual(result.rows, [
    { rowNumber: 3, sku: "SKU-3", status: "FAILED", attemptCount: 5,
      errorCode: "OZON_SKU_COLLECTION_FAILED", recoverable: true },
    { rowNumber: 4, sku: "SKU-4", status: "FAILED", attemptCount: 5,
      errorCode: "AUTO_LISTING_SOURCE_RESULT_INVALID", recoverable: false },
  ]);
  const encoded = JSON.stringify(result);
  for (const secret of ["private raw", "objectKey", "configSnapshot", "collect-secret", "item-secret", "job-secret"]) {
    assert.equal(encoded.includes(secret), false);
  }
});

test("detail uses the complete repository aggregate and disables retry after a successor exists", async () => {
  const detail = fixture();
  detail.recoverableFailedRows = 1002;
  detail.hasRetrySuccessor = true;
  const guarded = createAutoListingImportRecoveryService({ repository: {
    async getImportDetail() { return detail; },
    async retryFailedRows() { assert.fail("not called"); },
  } });
  const result = await guarded.getImportDetail({ actor, importId: "import-a" });
  assert.equal(result.recoverableFailedRows, 1002);
  assert.equal(result.actions.retry, false);
});

test("retry delegates actor-derived scope and closed command authority", async () => {
  const { service, calls } = harness();
  const result = await service.retryImport({ actor, importId: "import-a", expectedStatusVersion: 4,
    idempotencyKey: "retry-1", correlationId: "corr-1" });
  assert.deepEqual(calls, [["retry", {
    accountId: "account-a", actorId: "account-a", importId: "import-a", expectedStatusVersion: 4,
    idempotencyKey: "retry-1", correlationId: "corr-1",
  }]]);
  assert.equal(result.id, "import-retry");
  assert.equal(result.retryOfImportId, "import-a");
  assert.equal(Object.hasOwn(result, "objectKey"), false);
});

test("recovery service rejects malformed and foreign-account evidence", async () => {
  const { service, calls } = harness();
  await assert.rejects(service.getImportDetail({ actor, importId: "bad/id" }), { code: "AUTO_LISTING_IMPORT_RECOVERY_INVALID" });
  await assert.rejects(service.retryImport({ actor, importId: "import-a", expectedStatusVersion: -1,
    idempotencyKey: "retry-1", correlationId: "corr-1" }), { code: "AUTO_LISTING_IMPORT_RECOVERY_INVALID" });
  assert.equal(calls.length, 0);
  const foreign = createAutoListingImportRecoveryService({ repository: {
    async getImportDetail() { return fixture({ accountId: "account-b" }); },
    async retryFailedRows() { return fixture({ accountId: "account-b" }).importFile; },
  } });
  await assert.rejects(foreign.getImportDetail({ actor, importId: "import-a" }), { code: "AUTO_LISTING_IMPORT_RECOVERY_BOUNDARY" });
});
