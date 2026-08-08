import assert from "node:assert/strict";
import test from "node:test";

import { createAutoListingUploadRuntime } from "../auto-listing-upload-runtime.mjs";

test("runtime composes publication health, standard submission, durable task repository and global tenant scanner", async () => {
  const captured = {};
  const uploadService = { async submitAutoListingItem() {} };
  const worker = { async start() { return true; }, async runOnce() { return false; }, async stop() {} };
  const publicationRuntime = {
    publicationPolicy: { origin: "https://cdn.example.com", baseUrl: "https://cdn.example.com/",
      prefix: "listing-media/v1", publicationVersion: "LISTING_MEDIA_V1" },
    richContentPublicationPolicy: { origin: "https://cdn.example.com" },
    async publishListingAsset() {}, async assertDirectReady() {},
  };
  const standardSubmissionPort = { async createSubmission() {}, async findSubmission() {} };
  const assertDirectSystemReady = async () => ({ ready: true });
  const runtime = createAutoListingUploadRuntime({
    pool: { async connect() {}, async query() {} }, publicationRuntime, standardSubmissionPort,
    assertDirectSystemReady,
    uploadEnabled: true, listingPipelineEnabled: true, directUploadAllowed: false,
    worker: { enabled: true, workerId: "worker-a" }, logger: { log() {} },
    timers: { setTimeout() { return 1; }, clearTimeout() {} },
    createUploadRepository(input) { captured.uploadRepository = input; return { kind: "upload" }; },
    createTaskRepository(input) { captured.taskRepository = input; return { kind: "task" }; },
    createUploadService(input) { captured.service = input; return uploadService; },
    createTaskWorker(input) { captured.worker = input; return worker; },
  });
  assert.equal(captured.service.publishListingAsset, publicationRuntime.publishListingAsset);
  assert.equal(captured.service.assertDirectReady, publicationRuntime.assertDirectReady);
  assert.equal(captured.service.assertDirectSystemReady, assertDirectSystemReady);
  assert.equal(captured.service.createSubmission, standardSubmissionPort.createSubmission);
  assert.equal(captured.service.findSubmission, standardSubmissionPort.findSubmission);
  assert.equal(captured.worker.repository.kind, "task");
  assert.equal(captured.worker.uploadService, uploadService);
  assert.equal(captured.worker.accountScanLimit, 100);
  assert.equal(await runtime.start(), true);
  assert.equal(await runtime.runOnce(), false);
  await runtime.stop();
});

test("disabled runtime worker remains inert but the explicit upload service remains available for internal composition", async () => {
  let workerKeys;
  const service = { async submitAutoListingItem() {} };
  const runtime = createAutoListingUploadRuntime({
    pool: { async connect() {}, async query() {} },
    publicationRuntime: { publicationPolicy: {}, richContentPublicationPolicy: { origin: "https://cdn.example.com" },
      async publishListingAsset() {}, async assertDirectReady() {} },
    assertDirectSystemReady: async () => ({ ready: true }),
    standardSubmissionPort: { async createSubmission() {}, async findSubmission() {} },
    createUploadRepository() { return {}; }, createTaskRepository() { return {}; },
    createUploadService() { return service; },
    createTaskWorker(input) { workerKeys = Object.keys(input); return {
      async start() { return false; }, async runOnce() { return false; }, async stop() {},
    }; },
  });
  assert.deepEqual(workerKeys, ["enabled"]);
  assert.equal(runtime.uploadService, service);
  assert.equal(await runtime.start(), false);
});
