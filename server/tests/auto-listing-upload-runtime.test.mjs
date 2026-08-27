import assert from "node:assert/strict";
import test from "node:test";

import { createAutoListingUploadRuntime } from "../auto-listing-upload-runtime.mjs";

test("runtime composes publication health, standard submission, durable task repository and global tenant scanner", async () => {
  const captured = {};
  const pool = { async connect() {}, async query(sql, params) {
    captured.targetQuery = { sql, params };
    return { rows: [{ id: "warehouse-a", account_id: "account-a", store_id: "store-a",
      warehouse_id: "platform-a", warehouse_type: "RFBS", status: "active",
      is_active: true, is_archived: false }] };
  } };
  const uploadService = { async submitAutoListingItem() {} };
  const worker = { async start() { return true; }, async runOnce() { return false; }, async stop() {} };
  const publicationRuntime = {
    publicationPolicy: { origin: "https://cdn.example.com", baseUrl: "https://cdn.example.com/",
      prefix: "listing-media/v1", publicationVersion: "LISTING_MEDIA_V1" },
    richContentPublicationPolicy: { origin: "https://cdn.example.com" },
    async publishListingAsset() {}, async assertDirectReady() {}, async checkPublicationHealth() {},
  };
  const standardSubmissionPort = { async createSubmission() {}, async findSubmission() {} };
  const assertDirectSystemReady = async () => ({ ready: true });
  const readStoreCredential = async (...args) => { captured.credentialArgs = args; return { id: "store-a" }; };
  const callOzonSellerApi = async () => ({ result: [] });
  const runtime = createAutoListingUploadRuntime({
    pool, publicationRuntime, standardSubmissionPort,
    assertDirectSystemReady,
    readStoreCredential, callOzonSellerApi,
    uploadEnabled: true, listingPipelineEnabled: true, directUploadAllowed: false,
    worker: { enabled: true, workerId: "worker-a" }, logger: { log() {} },
    timers: { setTimeout() { return 1; }, clearTimeout() {} },
    createUploadRepository(input) { captured.uploadRepository = input; return { kind: "upload" }; },
    createTaskRepository(input) { captured.taskRepository = input; return { kind: "task" }; },
    createRfbsWarehouseVerifier(input) {
      captured.rfbsFactory = input;
      return { async verifyRfbsWarehouse() {} };
    },
    createUploadService(input) { captured.service = input; return uploadService; },
    createTaskWorker(input) { captured.worker = input; return worker; },
  });
  assert.equal(captured.service.publishListingAsset, publicationRuntime.publishListingAsset);
  assert.equal(captured.service.assertDirectReady, publicationRuntime.assertDirectReady);
  assert.equal(captured.service.checkPublicationHealth, publicationRuntime.checkPublicationHealth);
  assert.equal(captured.service.assertDirectSystemReady, assertDirectSystemReady);
  assert.equal(captured.service.createSubmission, standardSubmissionPort.createSubmission);
  assert.equal(captured.service.findSubmission, standardSubmissionPort.findSubmission);
  assert.equal(Object.isFrozen(captured.service.rfbsWarehouseVerifier), true);
  assert.deepEqual(Object.keys(captured.service.rfbsWarehouseVerifier), ["verifyRfbsWarehouse"]);
  assert.equal(captured.rfbsFactory.callOzonSellerApi, callOzonSellerApi);
  assert.deepEqual(await captured.rfbsFactory.loadTarget({ accountId: "account-a",
    targetStoreId: "store-a", targetWarehouseId: "warehouse-a" }), {
    id: "warehouse-a", accountId: "account-a", storeId: "store-a", warehouse_id: "platform-a",
    warehouse_type: "RFBS", status: "active", is_active: true, is_archived: false,
  });
  assert.deepEqual(captured.targetQuery.params, ["account-a", "store-a", "warehouse-a"]);
  assert.match(captured.targetQuery.sql, /owner_account_id=\$1/);
  assert.deepEqual(await captured.rfbsFactory.readCredential({ accountId: "account-a", targetStoreId: "store-a" }),
    { id: "store-a" });
  assert.deepEqual(captured.credentialArgs, ["store-a", "account-a"]);
  assert.equal(captured.worker.repository.kind, "task");
  assert.equal(captured.worker.uploadService, uploadService);
  assert.equal(captured.worker.accountScanLimit, 100);
  assert.equal(await runtime.start(), true);
  assert.equal(await runtime.runOnce(), false);
  await runtime.stop();
});

test("disabled runtime worker remains inert but the explicit upload service remains available for internal composition", async () => {
  let workerKeys;
  let sensitiveCalls = 0;
  const service = { async submitAutoListingItem() {} };
  const runtime = createAutoListingUploadRuntime({
    pool: { async connect() {}, async query() {} },
    publicationRuntime: { publicationPolicy: {}, richContentPublicationPolicy: { origin: "https://cdn.example.com" },
      async publishListingAsset() {}, async assertDirectReady() {}, async checkPublicationHealth() {} },
    assertDirectSystemReady: async () => ({ ready: true }),
    standardSubmissionPort: { async createSubmission() {}, async findSubmission() {} },
    readStoreCredential: async () => { sensitiveCalls += 1; throw new Error("must stay lazy"); },
    callOzonSellerApi: async () => { sensitiveCalls += 1; throw new Error("must stay lazy"); },
    createRfbsWarehouseVerifier(input) {
      assert.equal(typeof input.loadTarget, "function");
      return { async verifyRfbsWarehouse() { throw new Error("must stay lazy"); } };
    },
    createUploadRepository() { return {}; }, createTaskRepository() { return {}; },
    createUploadService() { return service; },
    createTaskWorker(input) { workerKeys = Object.keys(input); return {
      async start() { return false; }, async runOnce() { return false; }, async stop() {},
    }; },
  });
  assert.deepEqual(workerKeys, ["enabled"]);
  assert.equal(runtime.uploadService, service);
  assert.equal(await runtime.start(), false);
  assert.equal(sensitiveCalls, 0);
});

test("runtime rejects open or proxied verifier factories instead of exposing sensitive ports", () => {
  const base = {
    pool: { async connect() {}, async query() { return { rows: [] }; } },
    publicationRuntime: { publicationPolicy: {}, richContentPublicationPolicy: { origin: "https://cdn.example.com" },
      async publishListingAsset() {}, async assertDirectReady() {}, async checkPublicationHealth() {} },
    assertDirectSystemReady: async () => ({ ready: true }),
    standardSubmissionPort: { async createSubmission() {}, async findSubmission() {} },
    createUploadRepository() { return {}; }, createTaskRepository() { return {}; },
    createUploadService() { return { async submitAutoListingItem() {} }; },
    createTaskWorker() { return { async start() {}, async runOnce() {}, async stop() {} }; },
  };
  for (const createRfbsWarehouseVerifier of [
    () => ({ async verifyRfbsWarehouse() {}, extra: true }),
    () => new Proxy({ async verifyRfbsWarehouse() {} }, {}),
  ]) {
    assert.throws(() => createAutoListingUploadRuntime({ ...base, createRfbsWarehouseVerifier }), {
      code: "AUTO_LISTING_RFBS_RUNTIME_INITIALIZATION_FAILED",
    });
  }
});
