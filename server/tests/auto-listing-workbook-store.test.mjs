import assert from "node:assert/strict";
import test from "node:test";

import { createAutoListingWorkbookStore } from "../auto-listing-workbook-store.mjs";

const bytes = Buffer.from("workbook");
const scope = {
  accountId: "account-a",
  importId: "import-a",
  objectKey: "auto-listing/imports/v1/account-a/import-a/workbook.xlsx",
};

test("workbook store keeps every object operation inside the deterministic import scope", async () => {
  const calls = [];
  const store = createAutoListingWorkbookStore({
    async putObject(input) {
      calls.push(["put", input]);
      return { key: input.key, size: input.buffer.length, sha256: "a".repeat(64) };
    },
    async getObject(key, options) { calls.push(["get", key, options]); return Buffer.from(bytes); },
    async removeObject(key) { calls.push(["remove", key]); },
  });
  assert.deepEqual(await store.putWorkbook({ ...scope, bytes, fileHash: "a".repeat(64),
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), {
    objectKey: scope.objectKey, sizeBytes: bytes.length, fileHash: "a".repeat(64),
  });
  assert.deepEqual(await store.readWorkbook(scope), bytes);
  await store.removeWorkbook(scope);
  assert.deepEqual(calls.map(([name]) => name), ["put", "get", "remove"]);
  assert.equal(calls[0][1].maxBytes, 2_097_152);
  assert.deepEqual(calls[1][2], { maxBytes: 2_097_152 });
});

test("workbook store rejects cross-account paths before object storage", async () => {
  let calls = 0;
  const store = createAutoListingWorkbookStore({
    async putObject() { calls += 1; }, async getObject() { calls += 1; }, async removeObject() { calls += 1; },
  });
  await assert.rejects(store.readWorkbook({ ...scope,
    objectKey: "auto-listing/imports/v1/account-b/import-a/workbook.xlsx" }), {
    code: "AUTO_LISTING_IMPORT_STORAGE_INVALID",
  });
  assert.equal(calls, 0);
});

test("workbook store maps infrastructure details to stable errors", async () => {
  const store = createAutoListingWorkbookStore({
    async putObject() { throw new Error("storage credential=prod-secret"); },
    async getObject() { throw new Error("storage credential=prod-secret"); },
    async removeObject() { throw new Error("storage credential=prod-secret"); },
  });
  await assert.rejects(store.putWorkbook({ ...scope, bytes, fileHash: "a".repeat(64),
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }),
  (error) => error?.code === "AUTO_LISTING_IMPORT_STORAGE_FAILED" && !/credential|prod-secret/iu.test(error.message));
});

test("workbook store applies the configured service byte limit to put and read operations", async () => {
  const calls = [];
  const configured = 4_194_304;
  const store = createAutoListingWorkbookStore({
    maxBytes: configured,
    async putObject(input) {
      calls.push(input.maxBytes);
      return { key: input.key, size: input.buffer.length, sha256: "a".repeat(64) };
    },
    async getObject(_key, options) { calls.push(options.maxBytes); return Buffer.from(bytes); },
    async removeObject() {},
  });
  await store.putWorkbook({ ...scope, bytes, fileHash: "a".repeat(64),
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  await store.readWorkbook(scope);
  assert.deepEqual(calls, [configured, configured]);
});
