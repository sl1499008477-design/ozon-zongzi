import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import COS from "cos-nodejs-sdk-v5";
import { Client as MinioClient } from "minio";
import { createAiListingRuntime } from "../ai-listing-runtime.mjs";
import { normalizeAiListingConfig } from "../ai-listing-service.mjs";
import { createAiListingResultStore } from "../ai-listing-image-cache.mjs";
import { memoryRepository } from "./support/ai-listing-memory-repository.mjs";

const cosEnv = { LISTING_MEDIA_STORAGE: "cos", LISTING_COS_BUCKET: "public-media-1250000000",
  LISTING_COS_REGION: "ap-shanghai", LISTING_COS_SECRET_ID: "fixture-id", LISTING_COS_SECRET_KEY: "fixture-key",
  LISTING_ASSET_PUBLIC_BASE_URL: "https://assets.example.test/", LISTING_ASSET_DOWNLOAD_BASE_URL: "https://assets.example.test/" };
const sample = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

test("runtime publishes a saved SINGLE result and its preview to the selected COS bucket", async t => {
  t.mock.method(MinioClient.prototype, "bucketExists", async () => assert.fail("public COS assets must not touch MinIO"));
  const uploads = [];
  t.mock.method(COS.prototype, "putObject", async input => {
    uploads.push(input); return { statusCode: 200, ETag: '"saved"', headers: {} };
  });
  const directory = await mkdtemp(join(tmpdir(), "cos-runtime-test-"));
  const config = normalizeAiListingConfig({ targetStoreId: "store", targetWarehouseId: "warehouse", manualReview: true,
    prompt: "preserve product", generationMode: "SINGLE" });
  const input = { accountId: "account", taskId: "task", sku: "sku", index: 0, sourceUrl: "https://source.test/image.png",
    prompt: config.prompt, image: config.image, requestKey: "original-paid-request" };
  const repository = memoryRepository();
  await repository.create({ id: input.taskId, accountId: input.accountId, dedupeKey: "test", status: "QUEUED", nextRunAt: 0,
    sourceType: "COLLECT_BOX", source: { collectItemId: "source", items: [{ sku: input.sku, images: [input.sourceUrl] }] },
    config, createdAt: 1, updatedAt: 1, images: [{ sku: input.sku, index: 0, sourceUrl: input.sourceUrl,
      status: "PENDING", generatedUrl: null, requestKey: "image-request" }] });
  const store = createAiListingResultStore({ directory, minFreeBytes: 0 });
  await store.reserve(input, "SINGLE"); await store.save(input, "SINGLE", { bytes: sample, contentType: "image/png" });
  const runtime = createAiListingRuntime({ env: { ...cosEnv, AI_LISTING_RESULT_DIR: directory, AI_LISTING_CONCURRENCY: "1" },
    repository, resolvePool: async () => ({ query: async () => ({ rows: [] }) }),
    checkAccount: async () => ({ id: "account", role: "admin", status: "active" }),
    validateTarget: async () => ({}), submitListing: async () => assert.fail("review must precede Ozon submission") });
  try {
    await runtime.start();
    const saved = repository.rows.get("task");
    assert.equal(saved.status, "AWAITING_REVIEW", saved.errorMessage);
    assert.equal(uploads.length, 2); assert.equal(uploads[0].Bucket, cosEnv.LISTING_COS_BUCKET);
    assert.equal(uploads[0].ContentType, "image/png"); assert.deepEqual(uploads[0].Body, sample);
    assert.equal(uploads[1].ContentType, "image/webp");
    assert.equal(saved.images[0].generatedUrl, cosEnv.LISTING_ASSET_PUBLIC_BASE_URL + uploads[0].Key);
    assert.equal(saved.images[0].previewUrl, cosEnv.LISTING_ASSET_PUBLIC_BASE_URL + uploads[1].Key);
    assert.equal(await store.load(input, "SINGLE"), null, "the saved result is acknowledged after the task checkpoint");
  } finally { await runtime.stop(); await rm(directory, { recursive: true, force: true }); }
});

test("historical API gallery reads MinIO before initializing missing or unavailable COS", async t => {
  t.mock.method(COS.prototype, "headObject", async () => assert.fail("old gallery must not read COS"));
  const key = `listing-media/v1/ai-image-listing/${"a".repeat(64)}.jpg`;
  for (const env of [{ LISTING_MEDIA_STORAGE: "cos", LISTING_ASSET_PUBLIC_BASE_URL: "https://assets.example.test/" }, cosEnv]) {
    let status, bytes, reads = 0;
    const runtime = createAiListingRuntime({ env, getObject: async objectKey => {
      assert.equal(objectKey, key); reads++; return Buffer.from("old-MinIO-bytes");
    }, resolvePool: async () => assert.fail("public legacy image must not initialize COS or database"),
    sendJson: (_res, code) => { status = code; } });
    await runtime.handleRoute({ method: "GET" }, { writeHead: code => { status = code; }, end: body => { bytes = body; } },
      new URL(`https://www.ozonzongzi.com/${key}`));
    assert.equal(status, 200); assert.equal(reads, 1); assert.equal(bytes.toString(), "old-MinIO-bytes");
  }
});
