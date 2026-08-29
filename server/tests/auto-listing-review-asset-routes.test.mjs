import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { createAutoListingReviewAssetHttpHandler } from "../auto-listing-review-asset-routes.mjs";

const bytes = Buffer.from("verified-image-bytes");
const contentHash = crypto.createHash("sha256").update(bytes).digest("hex");

function harness({ enabled = true, authenticate, service, storedBytes = bytes, readPreview, cachePreview } = {}) {
  const replies = []; const objectReads = []; const writes = [];
  const value = service || {
    async getAcceptedAsset(input) {
      return {
        accountId: "account-a", itemId: input.itemId, assetId: input.assetId,
        objectKey: "auto-listing/account-a/item-a/asset-a.png", contentType: "image/png",
        contentHash, sizeBytes: bytes.length,
      };
    },
  };
  const response = {
    writeHead(status, headers) { writes.push({ status, headers }); },
    end(body) { writes.push({ body }); },
  };
  const handler = createAutoListingReviewAssetHttpHandler({
    isEnabled: () => enabled,
    authenticate: authenticate || (async () => ({ id: "account-a", role: "user" })),
    async getService() { return value; },
    async getObject(objectKey, options) {
      objectReads.push({ objectKey, options });
      return storedBytes;
    },
    readPreview,
    cachePreview,
    sendJson: (_res, status, payload) => replies.push({ status, payload }),
  });
  return { handler, response, replies, objectReads, writes };
}

test("authenticated review asset route streams only hash-verified accepted bytes", async () => {
  const local = harness();
  assert.equal(await local.handler(
    { method: "GET" }, local.response,
    new URL("http://local/auto-listing/items/item-a/assets/asset-a"),
  ), true);
  assert.deepEqual(local.objectReads, [{
    objectKey: "auto-listing/account-a/item-a/asset-a.png",
    options: { maxBytes: bytes.length },
  }]);
  assert.equal(local.writes[0].status, 200);
  assert.deepEqual(local.writes[0].headers, {
    "Content-Type": "image/png",
    "Content-Length": String(bytes.length),
    "Cache-Control": "private, max-age=60",
    "X-Content-Type-Options": "nosniff",
  });
  assert.deepEqual(local.writes[1].body, bytes);
  assert.deepEqual(local.replies, []);
});

test("authenticated preview route serves cached WebP bytes without rereading the full object", async () => {
  const previewBytes = Buffer.from("cached-webp-preview");
  const local = harness({
    readPreview: async ({ contentHash: requestedHash }) => {
      assert.equal(requestedHash, contentHash);
      return previewBytes;
    },
    cachePreview: async () => { throw new Error("must not recreate cached preview"); },
  });

  assert.equal(await local.handler(
    { method: "GET" }, local.response,
    new URL("http://local/auto-listing/items/item-a/assets/asset-a/preview"),
  ), true);
  assert.deepEqual(local.objectReads, []);
  assert.equal(local.writes[0].status, 200);
  assert.equal(local.writes[0].headers["Content-Type"], "image/webp");
  assert.deepEqual(local.writes[1].body, previewBytes);
});

test("uncached preview verifies the full object once before caching and serving its derivative", async () => {
  const previewBytes = Buffer.from("created-webp-preview");
  const cached = [];
  const local = harness({
    readPreview: async () => null,
    cachePreview: async (value) => { cached.push(value); return previewBytes; },
  });

  await local.handler(
    { method: "GET" }, local.response,
    new URL("http://local/auto-listing/items/item-a/assets/asset-a/preview"),
  );
  assert.deepEqual(local.objectReads, [{
    objectKey: "auto-listing/account-a/item-a/asset-a.png",
    options: { maxBytes: bytes.length },
  }]);
  assert.equal(cached.length, 1);
  assert.equal(cached[0].contentHash, contentHash);
  assert.equal(cached[0].bytes.equals(bytes), true);
  assert.deepEqual(local.writes[1].body, previewBytes);
});

test("review asset route rejects cross-input, wrong methods, and disabled access before object read", async () => {
  for (const [enabled, method, path, expectedStatus] of [
    [true, "POST", "/auto-listing/items/item-a/assets/asset-a", 405],
    [true, "GET", "/auto-listing/items/item-a/assets/asset-a?objectKey=private", 400],
    [true, "GET", "/auto-listing/items/%/assets/asset-a", 400],
    [false, "GET", "/auto-listing/items/item-a/assets/asset-a", 503],
  ]) {
    const local = harness({ enabled });
    await local.handler({ method }, local.response, new URL(`http://local${path}`));
    assert.equal(local.replies[0].status, expectedStatus);
    assert.equal(local.objectReads.length, 0);
  }
});

test("missing, oversized, malformed, or corrupted asset evidence fails closed without internals", async () => {
  const fixtures = [
    {
      service: { async getAcceptedAsset() { throw Object.assign(new Error("private/key"), { code: "AUTO_LISTING_REVIEW_ASSET_NOT_FOUND" }); } },
      status: 404,
    },
    {
      service: { async getAcceptedAsset() { return { objectKey: "private/key", contentType: "image/svg+xml", contentHash, sizeBytes: bytes.length }; } },
      status: 503,
    },
    {
      service: { async getAcceptedAsset() { return { objectKey: "private/key", contentType: "image/png", contentHash, sizeBytes: 30 * 1024 * 1024 }; } },
      status: 503,
    },
    { storedBytes: Buffer.from("tampered"), status: 503 },
  ];
  for (const fixture of fixtures) {
    const local = harness(fixture);
    await local.handler({ method: "GET" }, local.response,
      new URL("http://local/auto-listing/items/item-a/assets/asset-a"));
    assert.equal(local.replies[0].status, fixture.status);
    assert.doesNotMatch(JSON.stringify(local.replies[0]), /private|objectKey|tampered/i);
    assert.equal(local.writes.length, 0);
  }
});

test("unrelated paths remain untouched", async () => {
  const local = harness();
  assert.equal(await local.handler({ method: "GET" }, local.response, new URL("http://local/unrelated")), false);
});
