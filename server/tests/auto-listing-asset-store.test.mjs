import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import * as assetStore from "../auto-listing-asset-store.mjs";
import {
  buildGeneratedAssetObjectKey,
  normalizeListingImage,
  sha256,
  storeGeneratedAsset,
} from "../auto-listing-asset-store.mjs";

const scope = Object.freeze({ accountId: "account-a", jobId: "job-a", itemId: "item-a", planId: "plan-a", visualGroupKey: "main", slotKey: "cover", attemptIdentityHash: "d".repeat(64), inputHash: "a".repeat(64), attemptNo: 1 });
async function image() { return sharp({ create: { width: 768, height: 1024, channels: 4, background: "#ff0000" } }).jpeg().toBuffer(); }
const repository = (overrides = {}) => ({
  async findStoredGenerationAsset() { return null; },
  async recordStoredGenerationAsset(value) { return value; },
  async recordAssetCleanupRequired(value) { return value; },
  ...overrides,
});

test("normalizes real image bytes and stores them only after storage confirms every returned field", async () => {
  const normalized = await normalizeListingImage({ bytes: await image(), ratio: "3:4", resolution: "1K" });
  assert.equal(normalized.contentType, "image/png");
  assert.equal(normalized.width, 768);
  const calls = [];
  const stored = await storeGeneratedAsset({ scope, normalized, repository: repository(), storage: {
    async putObjectFromBuffer(input) { calls.push(input); assert.equal(input.maxBytes, 32 * 1024 * 1024); return { key: input.key, sha256: normalized.contentHash, contentType: "image/png", size: normalized.bytes.length }; },
    async getObjectBuffer(key, options) { assert.equal(key, calls[0].key); assert.deepEqual(options, { maxBytes: 16 * 1024 * 1024 }); return normalized.bytes; },
  } });
  assert.equal(calls.length, 1);
  assert.equal(stored.contentHash, normalized.contentHash);
  assert.equal(stored.objectKeyVersion, "ATTEMPT_V2");
  assert.equal(stored.objectKey, `auto-listing/v2/YWNjb3VudC1h/am9iLWE/aXRlbS1h/cGxhbi1h/bWFpbg/Y292ZXI/${scope.attemptIdentityHash}/attempt-1/${scope.inputHash}/${normalized.contentHash}.png`);
});

test("ATTEMPT_V2 keys physically isolate identical bytes by trusted attempt identity and number", async () => {
  const contentHash = "b".repeat(64);
  const first = buildGeneratedAssetObjectKey({ ...scope, attemptNo: 1, contentHash });
  const second = buildGeneratedAssetObjectKey({ ...scope, attemptNo: 2, contentHash });
  assert.notEqual(first, second);
  assert.equal(first, `auto-listing/v2/YWNjb3VudC1h/am9iLWE/aXRlbS1h/cGxhbi1h/bWFpbg/Y292ZXI/${scope.attemptIdentityHash}/attempt-1/${scope.inputHash}/${contentHash}.png`);
  assert.equal(second, `auto-listing/v2/YWNjb3VudC1h/am9iLWE/aXRlbS1h/cGxhbi1h/bWFpbg/Y292ZXI/${scope.attemptIdentityHash}/attempt-2/${scope.inputHash}/${contentHash}.png`);
});

test("only an explicit migrated LEGACY_V1 record may use the exact previous key formula", () => {
  const contentHash = "b".repeat(64);
  const legacyKey = `auto-listing/YWNjb3VudC1h/am9iLWE/aXRlbS1h/cGxhbi1h/bWFpbg/Y292ZXI/${scope.inputHash}/${contentHash}.png`;
  const verify = assetStore.verifyGeneratedAssetObjectKey;
  assert.equal(typeof verify, "function");
  assert.equal(verify({ ...scope, contentHash, objectKey: legacyKey, objectKeyVersion: "LEGACY_V1" }), true);
  assert.equal(verify({ ...scope, contentHash, objectKey: legacyKey, objectKeyVersion: "ATTEMPT_V2" }), false);
  assert.equal(verify({ ...scope, contentHash, objectKey: legacyKey }), false);
});

test("only persisted ACCEPTED replay may interpret an unversioned exact legacy key", () => {
  const contentHash = "b".repeat(64);
  const legacyKey = `auto-listing/YWNjb3VudC1h/am9iLWE/aXRlbS1h/cGxhbi1h/bWFpbg/Y292ZXI/${scope.inputHash}/${contentHash}.png`;
  const persisted = assetStore.verifyPersistedAcceptedGeneratedAssetObjectKey;
  assert.equal(typeof persisted, "function");
  const accepted = { ...scope, status: "ACCEPTED", contentHash, objectKey: legacyKey, objectKeyVersion: null };
  assert.equal(assetStore.verifyGeneratedAssetObjectKey(accepted), false);
  assert.equal(persisted(accepted), true);
  assert.equal(persisted({ ...accepted, status: "GENERATING" }), false);
  assert.equal(persisted({ ...accepted, objectKey: `${legacyKey}.wrong` }), false);
});

test("rejects path traversal and an unverified storage reply", async () => {
  assert.doesNotThrow(() => buildGeneratedAssetObjectKey({ ...scope, itemId: "..", contentHash: "b".repeat(64) }));
  const normalized = await normalizeListingImage({ bytes: await image(), ratio: "3:4", resolution: "1K" });
  let removed = 0;
  await assert.rejects(
    storeGeneratedAsset({ scope, normalized, repository: repository(), storage: { async putObjectFromBuffer(input) { return { key: input.key, sha256: "0".repeat(64), contentType: "image/png", size: normalized.bytes.length }; }, async getObjectBuffer() { return normalized.bytes; }, async removeObject() { removed += 1; } } }),
    (error) => error?.code === "AUTO_LISTING_ASSET_STORAGE_UNVERIFIED",
  );
  assert.equal(removed, 1);
});

test("reuses a byte-identical scoped object and never records acceptance after storage failure", async () => {
  const normalized = await normalizeListingImage({ bytes: await image(), ratio: "3:4", resolution: "1K" });
  const objectKey = buildGeneratedAssetObjectKey({ ...scope, contentHash: normalized.contentHash });
  let puts = 0; let recorded = 0;
  let reads = 0;
  const reused = await storeGeneratedAsset({ scope, normalized, repository: repository({ async findStoredGenerationAsset() { return { ...scope, objectKeyVersion: "ATTEMPT_V2", objectKey, contentHash: normalized.contentHash, contentType: normalized.contentType, width: normalized.width, height: normalized.height, size: normalized.bytes.length }; } }), storage: { async putObjectFromBuffer() { puts += 1; throw new Error("must not write"); }, async getObjectBuffer(key, options) { reads += 1; assert.equal(key, objectKey); assert.deepEqual(options, { maxBytes: 16 * 1024 * 1024 }); return normalized.bytes; } } });
  assert.equal(reused.objectKey, objectKey); assert.equal(puts, 0);
  assert.equal(reads, 1);
  await assert.rejects(storeGeneratedAsset({ scope, normalized, repository: repository({ async recordStoredGenerationAsset() { recorded += 1; } }), storage: { async putObjectFromBuffer() { throw new Error("offline"); }, async getObjectBuffer() { throw new Error("must not read"); } } }), (error) => error?.code === "AUTO_LISTING_ASSET_STORAGE_UNAVAILABLE");
  assert.equal(recorded, 0);
});

test("put and reuse fail closed when bounded object readback differs from normalized bytes", async () => {
  const normalized = await normalizeListingImage({ bytes: await image(), ratio: "3:4", resolution: "1K" });
  const objectKey = buildGeneratedAssetObjectKey({ ...scope, contentHash: normalized.contentHash });
  let removed = 0;
  await assert.rejects(storeGeneratedAsset({
    scope,
    normalized,
    repository: repository(), storage: {
      async putObjectFromBuffer(input) { return { key: input.key, sha256: normalized.contentHash, contentType: normalized.contentType, size: normalized.bytes.length }; },
      async getObjectBuffer() { return Buffer.from("different"); },
      async removeObject() { removed += 1; },
    },
  }), (error) => error?.code === "AUTO_LISTING_ASSET_STORAGE_UNVERIFIED");
  assert.equal(removed, 1);

  await assert.rejects(storeGeneratedAsset({
    scope,
    normalized,
    repository: repository({ async findStoredGenerationAsset() { return { ...scope, objectKeyVersion: "ATTEMPT_V2", objectKey, contentHash: normalized.contentHash, contentType: normalized.contentType, width: normalized.width, height: normalized.height, size: normalized.bytes.length }; } }),
    storage: { async putObjectFromBuffer() { throw new Error("must not put"); }, async getObjectBuffer() { return Buffer.from("different"); } },
  }), (error) => error?.code === "AUTO_LISTING_ASSET_STORAGE_UNVERIFIED");
});

test("record failure awaits cleanup and persists an orphan obligation when removal fails", async () => {
  const normalized = await normalizeListingImage({ bytes: await image(), ratio: "3:4", resolution: "1K" });
  const calls = [];
  await assert.rejects(storeGeneratedAsset({
    scope,
    normalized,
    storage: {
      async putObjectFromBuffer(input) { return { key: input.key, sha256: normalized.contentHash, contentType: normalized.contentType, size: normalized.bytes.length }; },
      async getObjectBuffer() { return normalized.bytes; },
      async removeObject() { calls.push("remove"); throw new Error("offline"); },
    },
    repository: repository({
      async recordStoredGenerationAsset() { calls.push("record"); throw new Error("db offline"); },
      async recordAssetCleanupRequired(value) { calls.push(["cleanup", value.objectKey, value.contentHash]); assert.equal(value.originalErrorCode, "AUTO_LISTING_ASSET_REPOSITORY_FAILED"); return { ...value, status: "PENDING" }; },
    }),
    logger: { warn() { return Promise.reject(new Error("logger offline")); } },
  }), (error) => error?.code === "AUTO_LISTING_ASSET_REPOSITORY_FAILED");
  assert.deepEqual(calls.map((entry) => Array.isArray(entry) ? entry[0] : entry), ["record", "remove", "cleanup"]);

  await assert.rejects(storeGeneratedAsset({
    scope,
    normalized,
    storage: {
      async putObjectFromBuffer(input) { return { key: input.key, sha256: normalized.contentHash, contentType: normalized.contentType, size: normalized.bytes.length }; },
      async getObjectBuffer() { return normalized.bytes; },
      async removeObject() { throw new Error("offline"); },
    },
    repository: repository({
      async recordStoredGenerationAsset() { throw new Error("db offline"); },
      async recordAssetCleanupRequired() { throw new Error("cleanup db offline"); },
    }),
  }), (error) => error?.code === "AUTO_LISTING_ASSET_CLEANUP_PERSIST_FAILED" && error?.retryable === true);
});

test("repository ports must return the exact durable stored and cleanup records", async () => {
  const normalized = await normalizeListingImage({ bytes: await image(), ratio: "3:4", resolution: "1K" });
  const successfulStorage = () => ({
    async putObjectFromBuffer(input) { return { key: input.key, sha256: normalized.contentHash, contentType: normalized.contentType, size: normalized.bytes.length }; },
    async getObjectBuffer() { return normalized.bytes; },
    async removeObject() {},
  });
  for (const returned of [null, undefined, { ...scope }]) {
    await assert.rejects(storeGeneratedAsset({ scope, normalized, storage: successfulStorage(), repository: repository({ async recordStoredGenerationAsset() { return returned; } }) }), (error) => error?.code === "AUTO_LISTING_ASSET_REPOSITORY_FAILED");
  }
  const validCleanup = { ...scope, objectKeyVersion: "ATTEMPT_V2", objectKey: buildGeneratedAssetObjectKey({ ...scope, contentHash: normalized.contentHash }), contentHash: normalized.contentHash, reason: "RECORD_STORED_FAILED", originalErrorCode: "AUTO_LISTING_ASSET_REPOSITORY_FAILED", status: "PENDING" };
  for (const returned of [null, { ...validCleanup, accountId: "other" }, { ...validCleanup, objectKey: "other" }, { ...validCleanup, contentHash: "0".repeat(64) }, { ...validCleanup, reason: "OTHER" }, { ...validCleanup, status: "COMPLETED" }]) {
    await assert.rejects(storeGeneratedAsset({
      scope, normalized,
      storage: { ...successfulStorage(), async removeObject() { throw new Error("offline"); } },
      repository: repository({ async recordStoredGenerationAsset() { throw new Error("db offline"); }, async recordAssetCleanupRequired() { return returned; } }),
    }), (error) => error?.code === "AUTO_LISTING_ASSET_CLEANUP_PERSIST_FAILED" && error?.retryable === true);
  }
});

test("normalized generated bytes are capped at 16 MiB before any storage or repository side effect", async () => {
  const bytes = Buffer.alloc(16 * 1024 * 1024 + 1, 7);
  let calls = 0;
  await assert.rejects(storeGeneratedAsset({
    scope,
    normalized: { bytes, contentHash: sha256(bytes), contentType: "image/png", width: 768, height: 1024 },
    repository: repository({ async findStoredGenerationAsset() { calls += 1; } }),
    storage: { async putObjectFromBuffer() { calls += 1; } },
  }), (error) => error?.code === "AUTO_LISTING_ASSET_TOO_LARGE");
  assert.equal(calls, 0);
});

test("all repository ports and attempt audit identity are required before storage side effects", async () => {
  const normalized = await normalizeListingImage({ bytes: await image(), ratio: "3:4", resolution: "1K" });
  for (const mutate of [
    (input) => { delete input.repository.recordStoredGenerationAsset; },
    (input) => { delete input.repository.recordAssetCleanupRequired; },
    (input) => { delete input.repository.findStoredGenerationAsset; },
    (input) => { input.scope = { ...input.scope, attemptIdentityHash: "bad" }; },
    (input) => { input.scope = { ...input.scope, attemptNo: 0 }; },
  ]) {
    let puts = 0;
    const input = { scope, normalized, repository: repository(), storage: { async putObjectFromBuffer() { puts += 1; }, async getObjectBuffer() {} } };
    mutate(input);
    await assert.rejects(storeGeneratedAsset(input), (error) => error?.code === "AUTO_LISTING_ASSET_INVALID");
    assert.equal(puts, 0);
  }
});
