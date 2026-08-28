import assert from "node:assert/strict";
import test from "node:test";

import { createAutoListingUserWorkflowService } from "../auto-listing-user-workflow-service.mjs";

const actor = Object.freeze({ id: "account-a", role: "user" });
const config = Object.freeze({
  targetStoreId: "store-a", targetWarehouseId: "warehouse-a", stock: 5,
  priceAdjustmentKopecks: "100",
  brandMode: "PREFER_SOURCE",
  image: { ratio: "3:4", resolution: "1K", quality: "Medium", language: "ru",
    roles: { main: 1, sellingPoint: 3, detail: 1, scene: 1, specification: 1, infographic: 1 } },
});

function harness({ preference = null } = {}) {
  const calls = [];
  const service = createAutoListingUserWorkflowService({
    preferencesRepository: {
      async getPreferences(input) { calls.push(["getPreferences", input]); return preference; },
      async savePreferences(input) { calls.push(["savePreferences", input]); return { ...input.config, configVersion: 1 }; },
    },
    importRepository: {
      async listImports(input) { calls.push(["listImports", input]); return [{
        id: "import-a", accountId: input.accountId, sourceFileName: "skus.xlsx", status: "QUEUED",
        totalRows: 2, readyRows: 0, failedRows: 0, rejectedRows: 0, duplicateRows: 0,
        createdAt: "2026-08-07T00:00:00.000Z", objectKey: "must-not-leak", configSnapshot: { hidden: true },
      }]; },
    },
    importService: {
      async createExcelImport(input) { calls.push(["createExcelImport", input]); return {
        id: "import-a", accountId: input.actor.id, sourceFileName: input.name, status: "QUEUED",
        totalRows: 2, readyRows: 0, failedRows: 0, rejectedRows: 0, duplicateRows: 0,
        createdAt: "2026-08-07T00:00:00.000Z", objectKey: "must-not-leak",
      }; },
    },
    recoveryService: {
      async getImportDetail(input) { calls.push(["getImportDetail", input]); return { id: "detail" }; },
      async retryImport(input) { calls.push(["retryImport", input]); return { id: "retry" }; },
    },
    limits: { maxBytes: 4, maxRows: 25 },
  });
  return { service, calls };
}

test("preference overview migrates only the unversioned legacy eight-image default", async () => {
  const legacy = {
    accountId: "account-a",
    ...config,
    configVersion: 7,
  };
  const migrated = await harness({ preference: legacy }).service.getOverview({ actor, importLimit: 50 });
  assert.deepEqual(migrated.preference.image.roles, {
    main: 1, sellingPoint: 2, detail: 1, scene: 1, specification: 0, infographic: 1,
  });
  assert.equal(migrated.preference.image.total, 6);
  assert.equal(migrated.preference.useCategoryStrategy, true);

  const current = await harness({
    preference: { ...legacy, imageDefaultsVersion: 2 },
  }).service.getOverview({ actor, importLimit: 50 });
  assert.equal(current.preference.image.total, 8);

  const custom = await harness({
    preference: {
      ...legacy,
      image: {
        ...legacy.image,
        roles: { main: 1, sellingPoint: 2, detail: 2, scene: 1, specification: 1, infographic: 1 },
      },
    },
  }).service.getOverview({ actor, importLimit: 50 });
  assert.equal(custom.preference.image.total, 8);

  const disabled = await harness({
    preference: { ...legacy, useCategoryStrategy: false, imageDefaultsVersion: 2 },
  }).service.getOverview({ actor, importLimit: 50 });
  assert.equal(disabled.preference.useCategoryStrategy, false);
});

test("ordinary users read only their preferences and safe import progress", async () => {
  const { service, calls } = harness();
  const result = await service.getOverview({ actor, importLimit: 50 });
  assert.deepEqual(calls, [
    ["getPreferences", { accountId: "account-a" }],
    ["listImports", { accountId: "account-a", limit: 50 }],
  ]);
  assert.deepEqual(result, {
    preference: null,
    limits: { maxBytes: 4, maxRows: 25 },
    imports: [{ id: "import-a", sourceFileName: "skus.xlsx", status: "QUEUED", totalRows: 2,
      readyRows: 0, failedRows: 0, rejectedRows: 0, duplicateRows: 0, createdAt: "2026-08-07T00:00:00.000Z" }],
  });
});

test("preference writes freeze the normalized config and version authority", async () => {
  const { service, calls } = harness();
  const result = await service.savePreferences({
    actor, config, expectedVersion: 0, idempotencyKey: "pref-a", correlationId: "corr-a",
  });
  assert.equal(result.configVersion, 1);
  assert.equal(result.brandMode, "PREFER_SOURCE");
  const saved = calls[0][1];
  assert.equal(saved.accountId, "account-a");
  assert.equal(saved.actorId, "account-a");
  assert.equal(saved.expectedVersion, 0);
  assert.match(saved.configHash, /^[a-f0-9]{64}$/u);
  assert.deepEqual(saved.config.image.total, 8);
  assert.equal(saved.config.brandMode, "PREFER_SOURCE");
});

test("Excel creation injects only the authenticated actor and returns a safe DTO", async () => {
  const { service, calls } = harness();
  const result = await service.createExcelImport({
    actor, name: "skus.xlsx",
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: Buffer.from("xlsx"), config, idempotencyKey: "import-a", correlationId: "corr-a",
  });
  assert.equal(calls[0][1].actor, actor);
  assert.equal(Object.hasOwn(calls[0][1], "accountId"), false);
  assert.equal(Object.hasOwn(result, "objectKey"), false);
  assert.equal(result.id, "import-a");
});

test("workflow facade exposes focused import recovery operations without accepting scope", async () => {
  const { service, calls } = harness();
  assert.deepEqual(await service.getImportDetail({ actor, importId: "import-a" }), { id: "detail" });
  assert.deepEqual(await service.retryImport({ actor, importId: "import-a", expectedStatusVersion: 2,
    idempotencyKey: "retry-1", correlationId: "corr-1" }), { id: "retry" });
  assert.deepEqual(calls, [
    ["getImportDetail", { actor, importId: "import-a" }],
    ["retryImport", { actor, importId: "import-a", expectedStatusVersion: 2,
      idempotencyKey: "retry-1", correlationId: "corr-1" }],
  ]);
});

test("Excel creation enforces the configured byte limit before the import service", async () => {
  const { service, calls } = harness();
  await assert.rejects(service.createExcelImport({ actor, name: "skus.xlsx",
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: Buffer.from("12345"), config, idempotencyKey: "import-a", correlationId: "corr-a" }), {
    code: "AUTO_LISTING_USER_REQUEST_INVALID",
  });
  assert.equal(calls.length, 0);
});

test("workflow service rejects invalid authority and inputs before repositories", async () => {
  const { service, calls } = harness();
  await assert.rejects(service.getOverview({ actor: { id: "" } }), { code: "PERMISSION_FORBIDDEN" });
  await assert.rejects(service.savePreferences({ actor, config, expectedVersion: -1,
    idempotencyKey: "pref-a", correlationId: "corr-a" }), { code: "AUTO_LISTING_USER_REQUEST_INVALID" });
  await assert.rejects(service.createExcelImport({ actor, name: "skus.xlsx", contentType: "text/csv",
    buffer: Buffer.from("x"), config, idempotencyKey: "import-a", correlationId: "corr-a" }),
  { code: "AUTO_LISTING_USER_REQUEST_INVALID" });
  assert.equal(calls.length, 0);
});
