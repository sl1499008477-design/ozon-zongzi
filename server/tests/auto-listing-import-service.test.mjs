import assert from "node:assert/strict";
import test from "node:test";

import { createAutoListingImportService } from "../auto-listing-import-service.mjs";

const WORKBOOK = Buffer.from("bounded workbook bytes");
const CONFIG = Object.freeze({
  targetStoreId: "store-a",
  targetWarehouseId: "warehouse-a",
  stock: 5,
  priceAdjustmentKopecks: "100",
  imageConfig: { ratio: "3:4", count: 8, language: "ru", resolution: "1K", quality: "MEDIUM" },
});

function parsedWorkbook() {
  return {
    sheetName: "SKU",
    acceptedRows: [
      { rowNumber: 2, rawSku: "1001", sku: "1001" },
      { rowNumber: 3, rawSku: " 1002 ", sku: "1002" },
    ],
    rejectedRows: [{ rowNumber: 4, rawSku: "", code: "INVALID_SKU" }],
    duplicateRows: [{ rowNumber: 5, rawSku: "1001", sku: "1001", firstRowNumber: 2 }],
    totals: { rows: 4, accepted: 2, rejected: 1, duplicates: 1 },
  };
}

function createHarness({ existing = null, findResults = null, failCreate = null, failRemove = null } = {}) {
  const calls = { find: [], parse: [], put: [], read: [], remove: [], cleanup: [], create: [] };
  const records = [];
  const service = createAutoListingImportService({
    now: () => "2026-08-04T13:00:00.000Z",
    parseWorkbook: async (input) => {
      calls.parse.push({ ...input, buffer: Buffer.from(input.buffer) });
      return parsedWorkbook();
    },
    repository: {
      async findImportByIdempotency(input) {
        calls.find.push(structuredClone(input));
        return Array.isArray(findResults) ? (findResults.shift() ?? null) : existing;
      },
      async createImportWithRows(input) {
        calls.create.push(structuredClone(input));
        if (failCreate) throw failCreate;
        records.push(structuredClone(input));
        return structuredClone(input.importFile);
      },
      async enqueueObjectCleanup(input) {
        calls.cleanup.push(structuredClone(input));
      },
    },
    workbookStore: {
      async putWorkbook(input) {
        calls.put.push({ ...input, bytes: Buffer.from(input.bytes) });
        return { objectKey: input.objectKey, sizeBytes: input.bytes.length, fileHash: input.fileHash };
      },
      async readWorkbook(input) {
        calls.read.push(structuredClone(input));
        return Buffer.from(WORKBOOK);
      },
      async removeWorkbook(input) {
        calls.remove.push(structuredClone(input));
        if (failRemove) throw failRemove;
      },
    },
  });
  return { service, calls, records };
}

function input(overrides = {}) {
  return {
    actor: { id: "account-a", permissions: ["auto-listing:write"] },
    name: "skus.xlsx",
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: Buffer.from(WORKBOOK),
    config: structuredClone(CONFIG),
    idempotencyKey: "excel-import-1",
    correlationId: "trace-1",
    ...overrides,
  };
}

test("stores and verifies the workbook, then atomically creates scoped rows and one outbox event per accepted SKU", async () => {
  const { service, calls } = createHarness();
  const result = await service.createExcelImport(input());

  assert.equal(result.accountId, "account-a");
  assert.equal(result.status, "QUEUED");
  assert.match(result.fileHash, /^[a-f0-9]{64}$/);
  assert.match(result.configHash, /^[a-f0-9]{64}$/);
  assert.match(result.objectKey, /^auto-listing\/imports\/v1\/account-a\/import_[a-f0-9]{40}\/workbook\.xlsx$/);
  assert.equal(calls.put.length, 1);
  assert.equal(calls.read.length, 1);
  assert.deepEqual(calls.parse[0].buffer, WORKBOOK);
  assert.equal(calls.create.length, 1);

  const created = calls.create[0];
  assert.deepEqual(created.importFile.configSnapshot, CONFIG);
  assert.equal(created.rows.length, 4);
  assert.deepEqual(created.rows.map(({ rowNumber, status }) => [rowNumber, status]), [
    [2, "PENDING"], [3, "PENDING"], [4, "INVALID_SKU"], [5, "DUPLICATE_IN_FILE"],
  ]);
  assert.equal(created.outbox.length, 2);
  assert.deepEqual(created.outbox.map(({ accountId, eventType, state }) => [accountId, eventType, state]), [
    ["account-a", "COLLECT_EXCEL_SKU", "PENDING"],
    ["account-a", "COLLECT_EXCEL_SKU", "PENDING"],
  ]);
  assert.equal(new Set(created.outbox.map((row) => row.dedupeKey)).size, 2);
});

test("same-account idempotent replay returns the existing import without storage or parsing", async () => {
  const first = createHarness();
  const created = await first.service.createExcelImport(input());
  const replay = createHarness({ existing: created });

  const result = await replay.service.createExcelImport(input());

  assert.deepEqual(result, created);
  assert.equal(replay.calls.parse.length, 0);
  assert.equal(replay.calls.put.length, 0);
  assert.equal(replay.calls.create.length, 0);
});

test("idempotency key cannot be replayed with different file or frozen config", async () => {
  const first = createHarness();
  const created = await first.service.createExcelImport(input());

  const differentFile = createHarness({ existing: created });
  await assert.rejects(
    differentFile.service.createExcelImport(input({ buffer: Buffer.from("different") })),
    { code: "AUTO_LISTING_IMPORT_IDEMPOTENCY_CONFLICT" },
  );
  const differentConfig = createHarness({ existing: created });
  await assert.rejects(
    differentConfig.service.createExcelImport(input({ config: { ...CONFIG, stock: 6 } })),
    { code: "AUTO_LISTING_IMPORT_IDEMPOTENCY_CONFLICT" },
  );
  assert.equal(differentFile.calls.put.length + differentConfig.calls.put.length, 0);
});

test("accounts use distinct import identities and object paths", async () => {
  const first = createHarness();
  const second = createHarness();
  const a = await first.service.createExcelImport(input());
  const b = await second.service.createExcelImport(input({ actor: { id: "account-b" } }));

  assert.notEqual(a.id, b.id);
  assert.notEqual(a.objectKey, b.objectKey);
  assert.match(b.objectKey, /\/account-b\//);
});

test("storage readback mismatch queues reference-safe cleanup without directly deleting the scoped object", async () => {
  const { service, calls } = createHarness();
  service.__testOnlySetWorkbookReadback?.();
  calls.read.length = 0;
  const badService = createAutoListingImportService({
    now: () => "2026-08-04T13:00:00.000Z",
    parseWorkbook: async () => parsedWorkbook(),
    repository: {
      findImportByIdempotency: async () => null,
      createImportWithRows: async () => assert.fail("database write must not run"),
      enqueueObjectCleanup: async (value) => calls.cleanup.push(structuredClone(value)),
    },
    workbookStore: {
      putWorkbook: async (value) => ({ objectKey: value.objectKey, sizeBytes: value.bytes.length, fileHash: value.fileHash }),
      readWorkbook: async () => Buffer.from("tampered"),
      removeWorkbook: async (value) => calls.remove.push(structuredClone(value)),
    },
  });

  await assert.rejects(badService.createExcelImport(input()), { code: "AUTO_LISTING_IMPORT_STORAGE_VERIFY_FAILED" });
  assert.equal(calls.remove.length, 0);
  assert.equal(calls.cleanup.length, 1);
});

test("ambiguous database failure never removes bytes and records a reference-safe cleanup obligation", async () => {
  const { service, calls } = createHarness({
    failCreate: new Error("relation secret_table missing"),
    failRemove: new Error("storage credential leaked"),
  });

  await assert.rejects(service.createExcelImport(input()), (error) => {
    assert.equal(error.code, "AUTO_LISTING_IMPORT_PERSIST_FAILED");
    assert.equal(error.message, "AUTO_LISTING_IMPORT_PERSIST_FAILED");
    return true;
  });
  assert.equal(calls.remove.length, 0);
  assert.equal(calls.cleanup.length, 1);
  assert.equal(calls.cleanup[0].accountId, "account-a");
  assert.match(calls.cleanup[0].objectKey, /^auto-listing\/imports\/v1\/account-a\//);
  assert.equal(calls.cleanup[0].reasonCode, "AUTO_LISTING_IMPORT_ORPHANED_WORKBOOK");
});

test("ambiguous persistence failure returns the committed idempotent import without deleting referenced bytes", async () => {
  const first = createHarness();
  const committed = await first.service.createExcelImport(input());
  const recovery = createHarness({
    failCreate: new Error("connection closed after commit"),
    findResults: [null, committed],
  });
  const result = await recovery.service.createExcelImport(input());
  assert.deepEqual(result, committed);
  assert.equal(recovery.calls.find.length, 2);
  assert.equal(recovery.calls.remove.length, 0);
  assert.equal(recovery.calls.cleanup.length, 0);
});

test("validates bounded closed request fields before any side effect", async () => {
  const { service, calls } = createHarness();
  for (const invalid of [
    input({ actor: {} }),
    input({ name: "../secret.xlsx" }),
    input({ contentType: "text/csv" }),
    input({ buffer: Buffer.alloc(0) }),
    input({ config: null }),
    input({ idempotencyKey: "" }),
    input({ correlationId: "" }),
  ]) {
    await assert.rejects(service.createExcelImport(invalid), { code: "AUTO_LISTING_IMPORT_REQUEST_INVALID" });
  }
  assert.equal(calls.find.length, 0);
  assert.equal(calls.put.length, 0);
});
