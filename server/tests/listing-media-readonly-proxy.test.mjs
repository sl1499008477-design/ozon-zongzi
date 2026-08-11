import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { createListingMediaReadonlyHandler } from "../../scripts/listing-media-readonly-proxy.mjs";

function responseCapture() {
  return {
    statusCode: null,
    headers: null,
    body: null,
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end(body = null) { this.body = body; },
  };
}

test("只读媒体代理只读取精确的健康检查和内容哈希图片路径", async () => {
  const image = Buffer.from("safe-image-bytes");
  const hash = crypto.createHash("sha256").update(image).digest("hex");
  const healthKey = "listing-media/v1/health/123e4567-e89b-12d3-a456-426614174000.bin";
  const imageKey = `listing-media/v1/${hash.slice(0, 2)}/${hash}.png`;
  const calls = [];
  const handler = createListingMediaReadonlyHandler({
    getObject: async (key, options) => {
      calls.push({ key, options });
      return key === healthKey ? Buffer.from("health") : image;
    },
  });

  const health = responseCapture();
  await handler({ method: "GET", url: `/${healthKey}` }, health);
  assert.equal(health.statusCode, 200);
  assert.equal(health.headers["Content-Type"], "application/octet-stream");
  assert.deepEqual(health.body, Buffer.from("health"));

  const published = responseCapture();
  await handler({ method: "GET", url: `/${imageKey}` }, published);
  assert.equal(published.statusCode, 200);
  assert.equal(published.headers["Content-Type"], "image/png");
  assert.deepEqual(published.body, image);
  assert.deepEqual(calls.map((entry) => entry.key), [healthKey, imageKey]);
});

test("只读媒体代理拒绝写方法、查询参数、路径穿越和非媒体路径", async () => {
  let reads = 0;
  const handler = createListingMediaReadonlyHandler({
    getObject: async () => { reads += 1; return Buffer.from("unexpected"); },
  });
  const cases = [
    { method: "POST", url: "/listing-media/v1/health/123e4567-e89b-12d3-a456-426614174000.bin", status: 405 },
    { method: "DELETE", url: "/listing-media/v1/aa/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png", status: 405 },
    { method: "GET", url: "/listing-media/v1/health/123e4567-e89b-12d3-a456-426614174000.bin?secret=1", status: 404 },
    { method: "GET", url: "/listing-media/v1/../admin", status: 404 },
    { method: "GET", url: "/admin", status: 404 },
    { method: "GET", url: "/", status: 404 },
  ];

  for (const entry of cases) {
    const res = responseCapture();
    await handler({ method: entry.method, url: entry.url }, res);
    assert.equal(res.statusCode, entry.status, `${entry.method} ${entry.url}`);
  }
  assert.equal(reads, 0);
});

test("只读媒体代理验证图片内容哈希并隐藏存储错误", async () => {
  const expectedHash = "a".repeat(64);
  const handler = createListingMediaReadonlyHandler({
    getObject: async () => Buffer.from("different-image"),
  });
  const mismatch = responseCapture();
  await handler({ method: "HEAD", url: `/listing-media/v1/aa/${expectedHash}.webp` }, mismatch);
  assert.equal(mismatch.statusCode, 404);
  assert.equal(mismatch.body, null);

  const unavailable = createListingMediaReadonlyHandler({
    getObject: async () => { throw new Error("MINIO_SECRET_KEY=must-not-leak"); },
  });
  const missing = responseCapture();
  await unavailable({ method: "GET", url: "/listing-media/v1/health/123e4567-e89b-12d3-a456-426614174000.bin" }, missing);
  assert.equal(missing.statusCode, 404);
  assert.equal(String(missing.body).includes("must-not-leak"), false);
});
