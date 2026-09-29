import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createListingMediaStorage } from "../listing-media-storage.mjs";
import * as minio from "../object-storage.mjs";

const env = { LISTING_MEDIA_STORAGE: "cos", LISTING_COS_BUCKET: "public-media-1250000000",
  LISTING_COS_REGION: "ap-shanghai", LISTING_COS_SECRET_ID: "fixture-id", LISTING_COS_SECRET_KEY: "fixture-key" };
const sha = buffer => createHash("sha256").update(buffer).digest("hex");

test("default public storage keeps the three existing MinIO operations", () => {
  const storage = createListingMediaStorage({ env: {} });
  for (const method of ["putObjectFromBuffer", "putObjectFromFile", "statObject"]) assert.equal(storage[method], minio[method]);
});

test("COS buffer writes preserve bytes, MIME, immutable cache and SHA metadata before acknowledging", async () => {
  let params, finish;
  const uploaded = new Promise(resolve => { finish = resolve; });
  const storage = createListingMediaStorage({ env, cosClient: { putObject: async input => { params = input; return uploaded; } } });
  const bytes = Buffer.from("representative-image");
  let acknowledged = false;
  const put = storage.putObjectFromBuffer({ key: "listing-media/v1/prepared/image.jpg", buffer: bytes,
    contentType: "image/jpeg", metadata: { "X-Amz-Meta-Content-Sha256": sha(bytes), "source-kind": "original" } })
    .then(result => { acknowledged = true; return result; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(acknowledged, false);
  assert.equal(params.Bucket, env.LISTING_COS_BUCKET); assert.equal(params.Region, env.LISTING_COS_REGION);
  assert.equal(params.Body, bytes); assert.equal(params.ContentLength, bytes.length); assert.equal(params.ContentType, "image/jpeg");
  assert.equal(params.CacheControl, "public,max-age=31536000,immutable");
  assert.equal(params.Headers["x-cos-meta-content-sha256"], sha(bytes));
  assert.equal(params.Headers["x-cos-meta-source-kind"], "original");
  assert.equal(params.Headers["X-Amz-Meta-Content-Sha256"], undefined);
  finish({ statusCode: 200, ETag: '"stored-etag"', headers: {} });
  assert.deepEqual(await put, { key: "listing-media/v1/prepared/image.jpg", bucket: env.LISTING_COS_BUCKET,
    contentType: "image/jpeg", size: bytes.length, sha256: sha(bytes) });
});

test("COS upload failures and missing confirmation never become successful receipts", async () => {
  const failure = Object.assign(new Error("request failed"), { code: "AccessDenied", statusCode: 403 });
  const storage = createListingMediaStorage({ env, cosClient: { putObject: async () => { throw failure; } } });
  await assert.rejects(storage.putObjectFromBuffer({ key: "one", buffer: Buffer.from("bytes") }), error => error === failure);
  const unconfirmed = createListingMediaStorage({ env, cosClient: { putObject: async () => ({ statusCode: 200 }) } });
  await assert.rejects(unconfirmed.putObjectFromBuffer({ key: "one", buffer: Buffer.from("bytes") }), { code: "LISTING_COS_UPLOAD_UNCONFIRMED" });
});

test("COS rejects empty and oversized buffers before transfer", async () => {
  let transfers = 0;
  const storage = createListingMediaStorage({ env, cosClient: { putObject: async () => { transfers++; } } });
  for (const input of [ { buffer: Buffer.alloc(0) }, { buffer: Buffer.alloc(50 * 1024 ** 2 + 1) },
    { buffer: Buffer.from("123"), maxBytes: 2 }, { buffer: Buffer.from("1"), maxBytes: 0 } ]) {
    await assert.rejects(storage.putObjectFromBuffer({ key: "one", ...input }));
  }
  assert.equal(transfers, 0);
});

test("COS file transfer delegates a path for streaming and applies the 2GiB limit without loading it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cos-file-test-"));
  try {
    const path = join(directory, "clip.mp4"), bytes = Buffer.alloc(128 * 1024, 7); await writeFile(path, bytes);
    let transfers = 0;
    const storage = createListingMediaStorage({ env, cosClient: { uploadFile: async params => {
      transfers++; assert.equal(params.FilePath, path); assert.equal(params.Body, undefined);
      assert.equal(params.ContentType, "video/mp4"); assert.equal(params.Headers["x-cos-meta-content-sha256"], sha(bytes));
      assert.equal(params.CacheControl, "public,max-age=31536000,immutable");
      const parts = []; for await (const part of createReadStream(params.FilePath)) parts.push(part);
      assert.deepEqual(Buffer.concat(parts), bytes); return { statusCode: 200, ETag: '"file-etag"', headers: {} };
    } } });
    assert.deepEqual(await storage.putObjectFromFile({ key: "clip.mp4", path, contentType: "video/mp4",
      metadata: { "X-Amz-Meta-Content-Sha256": sha(bytes) } }),
    { key: "clip.mp4", bucket: env.LISTING_COS_BUCKET, contentType: "video/mp4", size: bytes.length, sha256: sha(bytes) });
    await assert.rejects(storage.putObjectFromFile({ key: "clip.mp4", path, contentType: "video/mp4", maxBytes: 32 }));
    const oversized = join(directory, "oversized.mp4"), handle = await open(oversized, "w");
    try { await handle.truncate(2 * 1024 ** 3 + 1); } finally { await handle.close(); }
    await assert.rejects(storage.putObjectFromFile({ key: "big.mp4", path: oversized }));
    assert.equal(transfers, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("COS HEAD exposes size, type and SHA while distinguishing missing objects from access and transport errors", async () => {
  let failure;
  const storage = createListingMediaStorage({ env, cosClient: { headObject: async params => {
    assert.equal(params.Key, "saved.jpg"); if (failure) throw failure;
    return { statusCode: 200, ETag: '"stored-etag"', headers: { "content-length": "123", "content-type": "image/jpeg",
      "cache-control": "public,max-age=31536000,immutable", "x-cos-meta-content-sha256": "a".repeat(64) } };
  } } });
  const saved = await storage.statObject("saved.jpg");
  assert.equal(saved.size, 123); assert.equal(saved.contentType, "image/jpeg"); assert.equal(saved.sha256, "a".repeat(64));
  assert.equal(saved.metaData["content-sha256"], "a".repeat(64)); assert.equal(saved.etag, "stored-etag");
  for (const [code, statusCode] of [["NotFound", 404], ["AccessDenied", 403], ["Unauthorized", 401], ["ECONNRESET", undefined]]) {
    failure = Object.assign(new Error(code), { code, statusCode });
    await assert.rejects(storage.statObject("saved.jpg"), error => error === failure);
  }
});
