import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import {
  buildGeneratedAssetObjectKey,
  normalizeListingImage,
  storeGeneratedAsset,
} from "../auto-listing-asset-store.mjs";

const scope = Object.freeze({ accountId: "account-a", jobId: "job-a", itemId: "item-a", planId: "plan-a", visualGroupKey: "main", slotKey: "cover", inputHash: "a".repeat(64) });
async function image() { return sharp({ create: { width: 768, height: 1024, channels: 4, background: "#ff0000" } }).jpeg().toBuffer(); }

test("normalizes real image bytes and stores them only after storage confirms every returned field", async () => {
  const normalized = await normalizeListingImage({ bytes: await image(), ratio: "3:4", resolution: "1K" });
  assert.equal(normalized.contentType, "image/png");
  assert.equal(normalized.width, 768);
  const calls = [];
  const stored = await storeGeneratedAsset({ scope, normalized, storage: {
    async putObjectFromBuffer(input) { calls.push(input); return { key: input.key, sha256: normalized.contentHash, contentType: "image/png", size: normalized.bytes.length }; },
  } });
  assert.equal(calls.length, 1);
  assert.equal(stored.contentHash, normalized.contentHash);
  assert.match(stored.objectKey, /^auto-listing\/YWNjb3VudC1h\/am9iLWE\/aXRlbS1h\/cGxhbi1h\/bWFpbg\/Y292ZXI\//);
});

test("rejects path traversal and an unverified storage reply", async () => {
  assert.doesNotThrow(() => buildGeneratedAssetObjectKey({ ...scope, itemId: "..", contentHash: "b".repeat(64) }));
  const normalized = await normalizeListingImage({ bytes: await image(), ratio: "3:4", resolution: "1K" });
  let removed = 0;
  await assert.rejects(
    storeGeneratedAsset({ scope, normalized, storage: { async putObjectFromBuffer(input) { return { key: input.key, sha256: "0".repeat(64), contentType: "image/png", size: normalized.bytes.length }; }, async removeObject() { removed += 1; } } }),
    (error) => error?.code === "AUTO_LISTING_ASSET_STORAGE_UNVERIFIED",
  );
  assert.equal(removed, 1);
});

test("reuses a byte-identical scoped object and never records acceptance after storage failure", async () => {
  const normalized = await normalizeListingImage({ bytes: await image(), ratio: "3:4", resolution: "1K" });
  const objectKey = buildGeneratedAssetObjectKey({ ...scope, contentHash: normalized.contentHash });
  let puts = 0; let recorded = 0;
  const reused = await storeGeneratedAsset({ scope, normalized, repository: { async findStoredGenerationAsset() { return { ...scope, objectKey, contentHash: normalized.contentHash, contentType: normalized.contentType, width: normalized.width, height: normalized.height, size: normalized.bytes.length }; } }, storage: { async putObjectFromBuffer() { puts += 1; throw new Error("must not write"); } } });
  assert.equal(reused.objectKey, objectKey); assert.equal(puts, 0);
  await assert.rejects(storeGeneratedAsset({ scope, normalized, repository: { async recordStoredGenerationAsset() { recorded += 1; } }, storage: { async putObjectFromBuffer() { throw new Error("offline"); } } }), (error) => error?.code === "AUTO_LISTING_ASSET_STORAGE_UNAVAILABLE");
  assert.equal(recorded, 0);
});
