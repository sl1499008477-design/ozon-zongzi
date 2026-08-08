import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";

const load = () => import("../auto-listing-source-asset-store.mjs");
const H = (char) => char.repeat(64);
const scope = Object.freeze({
  accountId: "account-a", jobId: "job-a", itemId: "item-a", parentPlanId: "plan-a", sourceAssetId: "source-a",
  sourceRefHash: H("a"), inputHash: H("b"), expectedStatusVersion: 4,
  attemptId: "source-attempt-a", attemptNo: 1, leaseToken: "lease-a", leaseExpiresAt: "2026-08-04T01:00:00.000Z",
});

async function sourceImage() {
  const bytes = await sharp({ create: { width: 8, height: 9, channels: 4, background: "#102030" } }).webp().toBuffer();
  return { bytes, contentHash: (await import("../auto-listing-asset-store.mjs")).sha256(bytes), contentType: "image/webp", width: 8, height: 9, sizeBytes: bytes.length };
}

function repo(overrides = {}) {
  return {
    async recordStoredSourceMaterialization(value) { return { ...value, leaseExpiresAt: scope.leaseExpiresAt, status: "STORED" }; },
    async recordSourceObjectCleanupRequired(value) { return { ...value, status: "PENDING" }; },
    ...overrides,
  };
}

test("source object keys are deterministic, versioned, encoded and exact-verifiable", async () => {
  const { SOURCE_ASSET_OBJECT_KEY_VERSION, buildSourceAssetObjectKey, verifySourceAssetObjectKey } = await load();
  const contentHash = H("c");
  const record = { ...scope, accountId: "../account/秘密", contentHash, contentType: "image/webp", objectKeyVersion: SOURCE_ASSET_OBJECT_KEY_VERSION };
  const first = buildSourceAssetObjectKey(record);
  assert.equal(first, buildSourceAssetObjectKey(record));
  assert.match(first, /^auto-listing\/source\/v1\/[A-Za-z0-9_-]+\//u);
  assert.equal(first.includes("../account/秘密"), false);
  assert.equal(verifySourceAssetObjectKey({ ...record, objectKey: first }), true);
  assert.equal(verifySourceAssetObjectKey({ ...record, objectKey: `${first}.forged` }), false);
  for (const accountId of ["https://credentials.example.test", "account-api-key-secret", "密".repeat(81)]) {
    assert.throws(() => buildSourceAssetObjectKey({ ...record, accountId }), (error) => error?.code === "AUTO_LISTING_SOURCE_ASSET_SCOPE_INVALID");
  }
});

test("source storage accepts only exact put and byte readback evidence before recording STORED", async () => {
  const { storeMaterializedSourceAsset } = await load();
  const downloaded = await sourceImage();
  const calls = [];
  const record = await storeMaterializedSourceAsset({
    scope, downloaded, repository: repo({ async recordStoredSourceMaterialization(value) { calls.push("record"); return { ...value, leaseExpiresAt: scope.leaseExpiresAt, status: "STORED" }; } }),
    storage: {
      async putObjectFromBuffer(input) { calls.push("put"); return { key: input.key, sha256: downloaded.contentHash, contentType: downloaded.contentType, size: downloaded.sizeBytes }; },
      async getObjectBuffer() { calls.push("read"); return downloaded.bytes; },
    },
  });
  assert.deepEqual(calls, ["put", "read", "record"]);
  assert.equal(record.status, "STORED");
  assert.equal(record.objectKeyVersion, "SOURCE_V1");
  assert.equal(record.sizeBytes, downloaded.sizeBytes);
});

test("source storage accepts database-authoritative numeric or Date lease expiries without weakening the fence", async () => {
  const { storeMaterializedSourceAsset } = await load();
  const downloaded = await sourceImage();
  for (const leaseExpiresAt of [1_786_000_000_000, new Date("2026-08-04T01:00:00.000Z")]) {
    const authoritativeScope = { ...scope, leaseExpiresAt };
    const record = await storeMaterializedSourceAsset({
      scope: authoritativeScope,
      repository: repo({ async recordStoredSourceMaterialization(value) { return { ...value, leaseExpiresAt, status: "STORED" }; } }),
      downloaded,
      storage: {
        async putObjectFromBuffer(input) { return { key: input.key, sha256: downloaded.contentHash, contentType: downloaded.contentType, size: downloaded.sizeBytes }; },
        async getObjectBuffer() { return downloaded.bytes; },
      },
    });
    assert.equal(record.leaseExpiresAt, leaseExpiresAt);
  }
});

test("source storage rejects forged put replies or altered readback and removes the written object", async () => {
  const { storeMaterializedSourceAsset } = await load();
  const downloaded = await sourceImage();
  for (const mode of ["reply", "readback"]) {
    let removed = 0; let recorded = 0;
    await assert.rejects(storeMaterializedSourceAsset({
      scope, downloaded,
      repository: repo({ async recordStoredSourceMaterialization() { recorded += 1; } }),
      storage: {
        async putObjectFromBuffer(input) { return { key: input.key, sha256: mode === "reply" ? H("0") : downloaded.contentHash, contentType: downloaded.contentType, size: downloaded.sizeBytes }; },
        async getObjectBuffer() { return mode === "readback" ? Buffer.from("altered") : downloaded.bytes; },
        async removeObject() { removed += 1; },
      },
    }), (error) => error?.code === "AUTO_LISTING_SOURCE_ASSET_STORAGE_UNVERIFIED" && !error.cause);
    assert.equal(removed, 1);
    assert.equal(recorded, 0);
  }
});

test("a rejected put is treated as possibly committed and removes the deterministic key", async () => {
  const { storeMaterializedSourceAsset } = await load();
  const downloaded = await sourceImage();
  let removed = 0; let recorded = 0;
  await assert.rejects(storeMaterializedSourceAsset({
    scope, downloaded,
    repository: repo({ async recordStoredSourceMaterialization() { recorded += 1; } }),
    storage: {
      async putObjectFromBuffer() { throw new Error("connection dropped after object commit"); },
      async getObjectBuffer() { throw new Error("must not read"); },
      async removeObject() { removed += 1; },
    },
  }), (error) => error?.code === "AUTO_LISTING_SOURCE_ASSET_STORAGE_UNAVAILABLE" && error?.retryable === true);
  assert.equal(removed, 1);
  assert.equal(recorded, 0);
});

test("database failure after a verified object write removes it immediately", async () => {
  const { storeMaterializedSourceAsset } = await load();
  const downloaded = await sourceImage();
  const calls = [];
  await assert.rejects(storeMaterializedSourceAsset({
    scope, downloaded,
    repository: repo({ async recordStoredSourceMaterialization() { calls.push("record"); throw new Error("postgres secret dsn"); } }),
    storage: {
      async putObjectFromBuffer(input) { calls.push("put"); return { key: input.key, sha256: downloaded.contentHash, contentType: downloaded.contentType, size: downloaded.sizeBytes }; },
      async getObjectBuffer() { calls.push("read"); return downloaded.bytes; },
      async removeObject() { calls.push("remove"); },
    },
  }), (error) => error?.code === "AUTO_LISTING_SOURCE_MATERIALIZATION_REPOSITORY_FAILED"
    && error?.retryable === true && !/postgres|secret/u.test(error.message) && !error.cause);
  assert.deepEqual(calls, ["put", "read", "record", "remove"]);
});

test("failed removal persists an exact account-scoped cleanup obligation", async () => {
  const { storeMaterializedSourceAsset } = await load();
  const downloaded = await sourceImage();
  let cleanup;
  await assert.rejects(storeMaterializedSourceAsset({
    scope, downloaded,
    repository: repo({
      async recordStoredSourceMaterialization() { throw new Error("db offline"); },
      async recordSourceObjectCleanupRequired(value) { cleanup = value; return { ...value, status: "PENDING" }; },
    }),
    storage: {
      async putObjectFromBuffer(input) { return { key: input.key, sha256: downloaded.contentHash, contentType: downloaded.contentType, size: downloaded.sizeBytes }; },
      async getObjectBuffer() { return downloaded.bytes; },
      async removeObject() { throw new Error("minio secret"); },
    },
  }), (error) => error?.code === "AUTO_LISTING_SOURCE_MATERIALIZATION_REPOSITORY_FAILED");
  assert.deepEqual({ accountId: cleanup.accountId, parentPlanId: cleanup.parentPlanId, sourceAssetId: cleanup.sourceAssetId, materializationAttemptId: cleanup.materializationAttemptId, reasonCode: cleanup.reasonCode }, {
    accountId: scope.accountId, parentPlanId: scope.parentPlanId, sourceAssetId: scope.sourceAssetId,
    materializationAttemptId: scope.attemptId, reasonCode: "AUTO_LISTING_SOURCE_OBJECT_UNREFERENCED",
  });
  assert.deepEqual({
    sourceRefHash: cleanup.sourceRefHash,
    inputHash: cleanup.inputHash,
    expectedStatusVersion: cleanup.expectedStatusVersion,
    attemptNo: cleanup.attemptNo,
    leaseToken: cleanup.leaseToken,
    contentType: cleanup.contentType,
    width: cleanup.width,
    height: cleanup.height,
    sizeBytes: cleanup.sizeBytes,
  }, {
    sourceRefHash: scope.sourceRefHash,
    inputHash: scope.inputHash,
    expectedStatusVersion: scope.expectedStatusVersion,
    attemptNo: scope.attemptNo,
    leaseToken: scope.leaseToken,
    contentType: downloaded.contentType,
    width: downloaded.width,
    height: downloaded.height,
    sizeBytes: downloaded.sizeBytes,
  });
});

test("unverifiable cleanup persistence fails closed with a distinct retryable code", async () => {
  const { storeMaterializedSourceAsset } = await load();
  const downloaded = await sourceImage();
  await assert.rejects(storeMaterializedSourceAsset({
    scope, downloaded,
    repository: repo({
      async recordStoredSourceMaterialization() { throw new Error("db offline"); },
      async recordSourceObjectCleanupRequired(value) { return { ...value, accountId: "other", status: "PENDING" }; },
    }),
    storage: {
      async putObjectFromBuffer(input) { return { key: input.key, sha256: downloaded.contentHash, contentType: downloaded.contentType, size: downloaded.sizeBytes }; },
      async getObjectBuffer() { return downloaded.bytes; },
      async removeObject() { throw new Error("offline"); },
    },
  }), (error) => error?.code === "AUTO_LISTING_SOURCE_ASSET_CLEANUP_PERSIST_FAILED" && error?.retryable === true);
});
