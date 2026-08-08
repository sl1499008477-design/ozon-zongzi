import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import sharp from "sharp";
import { sha256 } from "../auto-listing-asset-store.mjs";
import { buildAutoListingSourceSnapshot } from "../auto-listing-source-snapshot.mjs";

const load = () => import("../auto-listing-source-materializer.mjs");
const H = (char) => char.repeat(64);
const SOURCE_URL = "https://cdn.example.test/image.png?token=do-not-persist";
const SOURCE_REF_HASH = crypto.createHash("sha256").update(SOURCE_URL).digest("hex");
const SOURCE_ASSET_ID = `source-url-${SOURCE_REF_HASH.slice(0, 24)}`;
const SOURCE_CAPTURE = buildAutoListingSourceSnapshot({
  accountId: "account-a", sourceType: "COLLECT_BOX", sourceRecordId: "collect-a", sourceVersion: "1",
  collectItem: {
    id: "collect-a", accountId: "account-a",
    listingDraft: {
      sku: "sku-a", title: "Товар", brand: "Brand", currency: "RUB", blackKopecks: "10000", greenKopecks: "8000",
      categoryResolution: { status: "MATCHED", method: "taxonomy", target: { storeId: "store-a", descriptionCategoryId: "170", typeId: "99" } },
      descriptionCategoryId: "170", typeId: "99", attributes: [], logistics: {}, productMeasurements: {}, images: [SOURCE_URL],
      variants: [{ sku: "sku-a", offerId: "offer-a", name: "Товар", currency: "RUB", blackKopecks: "10000", greenKopecks: "8000", images: [SOURCE_URL] }],
    },
  },
  productDraft: { id: "draft-a", version: 1 }, rawResponseRef: "raw-a", rawResponseHash: "raw-hash-a",
});
const scope = Object.freeze({ accountId: "account-a", jobId: "job-a", itemId: "item-a", parentPlanId: "plan-a", sourceAssetId: SOURCE_ASSET_ID, expectedStatusVersion: 7 });

function frozenSourceSnapshot(overrides = {}) {
  return { accountId: scope.accountId, jobId: scope.jobId, itemId: scope.itemId, sourceSnapshotId: "snapshot-a", sourceCapture: structuredClone(SOURCE_CAPTURE), ...overrides };
}

function parentPlan(reference = { assetId: scope.sourceAssetId, sourceRefHash: SOURCE_REF_HASH, contentHash: null, sourceRef: null, evidenceKind: "SOURCE_REF_HASH" }, sourceHash = SOURCE_CAPTURE.snapshotHash) {
  const groups = [{ visualGroupKey: "group-a", sourceSkus: ["sku-a"], variantIds: ["variant-a"], referenceImages: [reference], factEvidence: [], reasonCodes: ["COMPLETE_APPEARANCE_EVIDENCE"] }];
  const visualBase = { sourceHash, groups, reasonCodes: ["COMPLETE_APPEARANCE_EVIDENCE"] };
  const visualGroups = { ...visualBase, visualGroupsHash: sha256(visualBase) };
  const plan = { version: 1, language: "ru", slots: [] };
  return { id: scope.parentPlanId, sourceAccountId: scope.accountId, jobId: scope.jobId, itemId: scope.itemId, sourceSnapshotId: "snapshot-a", sourceHash, planHash: sha256(plan), plan, visualGroupsHash: visualGroups.visualGroupsHash, visualGroups };
}

async function downloaded() {
  const bytes = await sharp({ create: { width: 9, height: 12, channels: 4, background: "green" } }).png().toBuffer();
  return { bytes, contentHash: sha256(bytes), contentType: "image/png", width: 9, height: 12, sizeBytes: bytes.length };
}

function exactReservation(input, overrides = {}) {
  return { status: "RESERVED", ...input, attemptId: "attempt-a", attemptNo: 1, leaseToken: "lease-a", leaseExpiresAt: "2026-08-04T01:00:00.000Z", ...overrides };
}

function repository(overrides = {}) {
  return {
    async reserveSourceMaterialization(input) { return exactReservation(input); },
    async recordStoredSourceMaterialization(value) { return { ...value, leaseExpiresAt: "2026-08-04T01:00:00.000Z", status: "STORED" }; },
    async recordSourceObjectCleanupRequired(value) { return { ...value, status: "PENDING" }; },
    async completeSourceMaterialization(value) { return { ...value, status: "ACCEPTED", acceptedAt: "2026-08-04T00:00:00.000Z", leaseToken: null, leaseExpiresAt: null }; },
    async failSourceMaterialization(value) { return { ...value, status: "FAILED", leaseToken: null, leaseExpiresAt: null }; },
    ...overrides,
  };
}

test("materialization input is deterministic and binds the exact closed scope, parent plan and sourceRefHash", async () => {
  const { buildSourceMaterializationInput } = await load();
  const first = buildSourceMaterializationInput({ scope, parentPlan: parentPlan() });
  const second = buildSourceMaterializationInput({ scope: { ...scope }, parentPlan: structuredClone(parentPlan()) });
  assert.deepEqual(first, second);
  const nextStatusVersion = buildSourceMaterializationInput({ scope: { ...scope, expectedStatusVersion: scope.expectedStatusVersion + 1 }, parentPlan: parentPlan() });
  assert.equal(nextStatusVersion.sourceRefHash, first.sourceRefHash);
  assert.notEqual(nextStatusVersion.inputHash, first.inputHash, "status-version fencing must not collide with a prior accepted unique input");
  assert.match(first.sourceRefHash, /^[a-f0-9]{64}$/u);
  assert.match(first.inputHash, /^[a-f0-9]{64}$/u);
  assert.equal(Object.hasOwn(first, "sourceUrl"), false);
  assert.throws(() => buildSourceMaterializationInput({ scope: { ...scope, extra: true }, parentPlan: parentPlan() }), (error) => error?.code === "AUTO_LISTING_SOURCE_MATERIALIZATION_INPUT_INVALID");
  assert.throws(() => buildSourceMaterializationInput({ scope: { ...scope, accountId: "other" }, parentPlan: parentPlan() }), (error) => error?.code === "AUTO_LISTING_SOURCE_MATERIALIZATION_INPUT_INVALID");
  assert.throws(() => buildSourceMaterializationInput({
    scope,
    parentPlan: parentPlan(),
    policy: { policyVersion: "SOURCE_DOWNLOAD_V1", timeoutMs: 10_000, maxBytes: 8 * 1024 * 1024, maxPixels: 40_000_000, maxRedirects: 3, maxAttempts: 3, forbidHttpsDowngrade: true, apiKey: "forbidden" },
  }), (error) => error?.code === "AUTO_LISTING_SOURCE_MATERIALIZATION_INPUT_INVALID");
  for (const policy of [
    { ...structuredClone((await import("../auto-listing-source-downloader.mjs")).AUTO_LISTING_SOURCE_DOWNLOAD_POLICY), maxBytes: 8 * 1024 * 1024 + 1 },
    { ...structuredClone((await import("../auto-listing-source-downloader.mjs")).AUTO_LISTING_SOURCE_DOWNLOAD_POLICY), maxPixels: 40_000_001 },
    { ...structuredClone((await import("../auto-listing-source-downloader.mjs")).AUTO_LISTING_SOURCE_DOWNLOAD_POLICY), maxRedirects: 4 },
    { ...structuredClone((await import("../auto-listing-source-downloader.mjs")).AUTO_LISTING_SOURCE_DOWNLOAD_POLICY), maxAttempts: 2 },
  ]) {
    assert.throws(() => buildSourceMaterializationInput({ scope, parentPlan: parentPlan(), policy }), (error) => error?.code === "AUTO_LISTING_SOURCE_MATERIALIZATION_INPUT_INVALID");
  }
  for (const accountId of ["https://credentials.example.test", "account-api-key-secret", "密".repeat(81)]) {
    assert.throws(() => buildSourceMaterializationInput({
      scope: { ...scope, accountId },
      parentPlan: { ...parentPlan(), sourceAccountId: accountId },
    }), (error) => error?.code === "AUTO_LISTING_SOURCE_MATERIALIZATION_INPUT_INVALID");
  }
});

test("materializer rejects CONTENT_HASH, forged parent hash, and ambiguous source evidence before reservation", async () => {
  const { materializeSourceAsset } = await load();
  const inputs = [
    parentPlan({ assetId: scope.sourceAssetId, sourceRefHash: null, contentHash: H("c"), sourceRef: null, evidenceKind: "CONTENT_HASH" }),
    { ...parentPlan(), planHash: H("0") },
    (() => { const value = parentPlan(); value.visualGroups.groups[0].referenceImages.push({ ...value.visualGroups.groups[0].referenceImages[0], sourceRef: "https://other.example.test/a.png" }); return value; })(),
  ];
  for (const candidate of inputs) {
    let reserves = 0;
    await assert.rejects(materializeSourceAsset({ scope, parentPlan: candidate, sourceSnapshot: frozenSourceSnapshot(), repository: repository({ async reserveSourceMaterialization() { reserves += 1; } }), downloader: { async downloadSourceImage() { throw new Error("must not download"); } }, storage: {} }), (error) => /^AUTO_LISTING_SOURCE_(?:ALREADY_MATERIALIZED|MATERIALIZATION_INPUT_INVALID)$/u.test(error?.code || ""));
    assert.equal(reserves, 0);
  }
});

test("materializer requires one exact frozen snapshot and rejects missing, duplicate or cross-scope evidence before reservation", async () => {
  const { materializeSourceAsset } = await load();
  const missingReference = parentPlan({
    assetId: `source-url-${H("f").slice(0, 24)}`,
    sourceRefHash: H("f"),
    contentHash: null,
    sourceRef: null,
    evidenceKind: "SOURCE_REF_HASH",
  });
  const candidates = [
    { parentPlan: parentPlan(), sourceSnapshot: undefined },
    { parentPlan: parentPlan(), sourceSnapshot: frozenSourceSnapshot({ accountId: "account-b" }) },
    { parentPlan: parentPlan(), sourceSnapshot: frozenSourceSnapshot({ jobId: "job-b" }) },
    { parentPlan: parentPlan(), sourceSnapshot: frozenSourceSnapshot({ itemId: "item-b" }) },
    { parentPlan: parentPlan(), sourceSnapshot: frozenSourceSnapshot({ sourceSnapshotId: "snapshot-latest" }) },
    { parentPlan: parentPlan(), sourceSnapshot: frozenSourceSnapshot({ sourceCapture: [SOURCE_CAPTURE, SOURCE_CAPTURE] }) },
    { parentPlan: missingReference, sourceSnapshot: frozenSourceSnapshot() },
  ];
  for (const candidate of candidates) {
    let reservations = 0;
    await assert.rejects(materializeSourceAsset({
      scope,
      ...candidate,
      repository: repository({ async reserveSourceMaterialization() { reservations += 1; } }),
      downloader: { async downloadSourceImage() { throw new Error("must not download"); } },
      storage: {},
    }), { code: "AUTO_LISTING_SOURCE_MATERIALIZATION_INPUT_INVALID" });
    assert.equal(reservations, 0);
  }
});

test("reservation happens before the only download and accepted completion", async () => {
  const { materializeSourceAsset } = await load();
  const bytes = await downloaded();
  const calls = [];
  const result = await materializeSourceAsset({
    scope, parentPlan: parentPlan(), sourceSnapshot: frozenSourceSnapshot(),
    repository: repository({
      async reserveSourceMaterialization(input) { calls.push("reserve"); return exactReservation(input); },
      async recordStoredSourceMaterialization(value) { calls.push("record-stored"); return { ...value, leaseExpiresAt: "2026-08-04T01:00:00.000Z", status: "STORED" }; },
      async completeSourceMaterialization(value) { calls.push("complete"); return { ...value, status: "ACCEPTED", acceptedAt: "2026-08-04T00:00:00.000Z", leaseToken: null, leaseExpiresAt: null }; },
    }),
    downloader: { async downloadSourceImage() { calls.push("download"); return bytes; } },
    storage: {
      async putObjectFromBuffer(input) { calls.push("put"); return { key: input.key, sha256: bytes.contentHash, contentType: bytes.contentType, size: bytes.sizeBytes }; },
      async getObjectBuffer() { calls.push("read"); return bytes.bytes; },
    },
  });
  assert.deepEqual(calls, ["reserve", "download", "put", "read", "record-stored", "complete"]);
  assert.equal(result.status, "ACCEPTED");
  assert.equal(result.sourceRefHash.length, 64);
  assert.equal(JSON.stringify(result).includes("cdn.example"), false);
});

test("reservation cannot swap the exact frozen snapshot URL before download", async () => {
  const { materializeSourceAsset } = await load();
  const bytes = await downloaded();
  const mutablePlan = parentPlan();
  const mutableSnapshot = frozenSourceSnapshot();
  const originalUrl = SOURCE_URL;
  let downloadedUrl;
  const result = await materializeSourceAsset({
    scope, parentPlan: mutablePlan, sourceSnapshot: mutableSnapshot,
    repository: repository({
      async reserveSourceMaterialization(input) {
        mutableSnapshot.sourceCapture.snapshot.variants[0].media[0] = "https://attacker.example.test/swapped.png";
        return exactReservation(input);
      },
    }),
    downloader: { async downloadSourceImage(input) { downloadedUrl = input.sourceUrl; return bytes; } },
    storage: {
      async putObjectFromBuffer(input) { return { key: input.key, sha256: bytes.contentHash, contentType: bytes.contentType, size: bytes.sizeBytes }; },
      async getObjectBuffer() { return bytes.bytes; },
    },
  });
  assert.equal(result.status, "ACCEPTED");
  assert.equal(downloadedUrl, originalUrl);
});

test("the production memory repository composes with the materializer without timestamp or record-shape adapters", async () => {
  const { materializeSourceAsset } = await load();
  const { createMemorySourceMaterializationRepository } = await import("../auto-listing-source-materialization-repository.mjs");
  const bytes = await downloaded();
  const actualRepository = createMemorySourceMaterializationRepository({
    now: () => Date.parse("2026-08-04T00:00:00.000Z"), token: () => "lease-production", id: () => "attempt-production",
  });
  const result = await materializeSourceAsset({
    scope, parentPlan: parentPlan(), sourceSnapshot: frozenSourceSnapshot(), repository: actualRepository,
    downloader: { async downloadSourceImage() { return bytes; } },
    storage: {
      async putObjectFromBuffer(input) { return { key: input.key, sha256: bytes.contentHash, contentType: bytes.contentType, size: bytes.sizeBytes }; },
      async getObjectBuffer() { return bytes.bytes; },
    },
  });
  assert.equal(result.status, "ACCEPTED");
  assert.equal(result.sourceAssetId, scope.sourceAssetId);
});

test("a production repository records cleanup even when the object was never recorded on the attempt row", async () => {
  const { materializeSourceAsset } = await load();
  const { createMemorySourceMaterializationRepository } = await import("../auto-listing-source-materialization-repository.mjs");
  const bytes = await downloaded();
  const actual = createMemorySourceMaterializationRepository({
    now: () => Date.parse("2026-08-04T00:00:00.000Z"), token: () => "lease-cleanup", id: () => "attempt-cleanup",
  });
  let cleanupRecord;
  const wrapped = {
    ...actual,
    async recordStoredSourceMaterialization() { throw new Error("database failed before evidence was stored"); },
    async recordSourceObjectCleanupRequired(input) {
      cleanupRecord = await actual.recordSourceObjectCleanupRequired(input);
      return cleanupRecord;
    },
  };
  await assert.rejects(materializeSourceAsset({
    scope, parentPlan: parentPlan(), sourceSnapshot: frozenSourceSnapshot(), repository: wrapped,
    downloader: { async downloadSourceImage() { return bytes; } },
    storage: {
      async putObjectFromBuffer(input) { return { key: input.key, sha256: bytes.contentHash, contentType: bytes.contentType, size: bytes.sizeBytes }; },
      async getObjectBuffer() { return bytes.bytes; },
      async removeObject() { throw new Error("object store temporarily unavailable"); },
    },
  }), (error) => error?.code === "AUTO_LISTING_SOURCE_MATERIALIZATION_REPOSITORY_FAILED" && error?.retryable === true);
  assert.equal(cleanupRecord?.status, "PENDING");
  assert.equal(cleanupRecord?.materializationAttemptId, "attempt-cleanup");
});

test("cancelled and stale reservations acknowledge with zero downloader or storage calls", async () => {
  const { materializeSourceAsset } = await load();
  for (const status of ["CANCELLED", "STALE"]) {
    let externalCalls = 0;
    const result = await materializeSourceAsset({
      scope, parentPlan: parentPlan(), sourceSnapshot: frozenSourceSnapshot(), repository: repository({ async reserveSourceMaterialization() { return { status }; } }),
      downloader: { async downloadSourceImage() { externalCalls += 1; } },
      storage: { async putObjectFromBuffer() { externalCalls += 1; }, async getObjectBuffer() { externalCalls += 1; } },
    });
    assert.deepEqual(result, { status: "SKIPPED", reasonCode: status === "CANCELLED" ? "AUTO_LISTING_SOURCE_MATERIALIZATION_CANCELLED" : "AUTO_LISTING_SOURCE_MATERIALIZATION_STALE" });
    assert.equal(externalCalls, 0);
  }
});

test("an in-progress duplicate acknowledges and exhausted attempts fail non-retryable with zero external calls", async () => {
  const { materializeSourceAsset } = await load();
  for (const status of ["IN_PROGRESS", "ATTEMPTS_EXHAUSTED"]) {
    let externalCalls = 0;
    const action = materializeSourceAsset({
      scope, parentPlan: parentPlan(), sourceSnapshot: frozenSourceSnapshot(), repository: repository({ async reserveSourceMaterialization() { return { status }; } }),
      downloader: { async downloadSourceImage() { externalCalls += 1; } },
      storage: { async putObjectFromBuffer() { externalCalls += 1; }, async getObjectBuffer() { externalCalls += 1; } },
    });
    if (status === "IN_PROGRESS") {
      assert.deepEqual(await action, { status: "SKIPPED", reasonCode: "AUTO_LISTING_SOURCE_MATERIALIZATION_IN_PROGRESS" });
    } else {
      await assert.rejects(action, (error) => error?.code === "AUTO_LISTING_SOURCE_MATERIALIZATION_ATTEMPTS_EXHAUSTED" && error?.retryable === false);
    }
    assert.equal(externalCalls, 0);
  }
});

test("cancellation discovered while recording stored evidence removes the object and acknowledges without acceptance", async () => {
  const { materializeSourceAsset } = await load();
  const bytes = await downloaded();
  let removed = 0; let completed = 0;
  const result = await materializeSourceAsset({
    scope, parentPlan: parentPlan(), sourceSnapshot: frozenSourceSnapshot(),
    repository: repository({
      async recordStoredSourceMaterialization() {
        const error = new Error("raw database message");
        error.code = "AUTO_LISTING_SOURCE_MATERIALIZATION_CLAIM_REJECTED";
        throw error;
      },
      async completeSourceMaterialization() { completed += 1; throw new Error("must not complete"); },
      async failSourceMaterialization() { throw new Error("must not fail a cancelled claim"); },
    }),
    downloader: { async downloadSourceImage() { return bytes; } },
    storage: {
      async putObjectFromBuffer(input) { return { key: input.key, sha256: bytes.contentHash, contentType: bytes.contentType, size: bytes.sizeBytes }; },
      async getObjectBuffer() { return bytes.bytes; },
      async removeObject() { removed += 1; },
    },
  });
  assert.deepEqual(result, { status: "SKIPPED", reasonCode: "AUTO_LISTING_SOURCE_MATERIALIZATION_STALE" });
  assert.equal(removed, 1);
  assert.equal(completed, 0);
});

test("cancellation discovered at completion removes the stored object before acknowledging", async () => {
  const { materializeSourceAsset } = await load();
  const bytes = await downloaded();
  let removed = 0;
  const result = await materializeSourceAsset({
    scope, parentPlan: parentPlan(), sourceSnapshot: frozenSourceSnapshot(),
    repository: repository({
      async completeSourceMaterialization() {
        const error = new Error("raw database message");
        error.code = "AUTO_LISTING_SOURCE_MATERIALIZATION_CLAIM_REJECTED";
        throw error;
      },
    }),
    downloader: { async downloadSourceImage() { return bytes; } },
    storage: {
      async putObjectFromBuffer(input) { return { key: input.key, sha256: bytes.contentHash, contentType: bytes.contentType, size: bytes.sizeBytes }; },
      async getObjectBuffer() { return bytes.bytes; },
      async removeObject() { removed += 1; },
    },
  });
  assert.deepEqual(result, { status: "SKIPPED", reasonCode: "AUTO_LISTING_SOURCE_MATERIALIZATION_STALE" });
  assert.equal(removed, 1);
});

test("an exact accepted replay makes zero downloader and storage calls even if the remote content changes", async () => {
  const { buildSourceMaterializationInput, materializeSourceAsset } = await load();
  const built = buildSourceMaterializationInput({ scope, parentPlan: parentPlan() });
  const accepted = {
    ...scope, sourceRefHash: built.sourceRefHash, inputHash: built.inputHash, expectedStatusVersion: scope.expectedStatusVersion,
    attemptId: "attempt-a", attemptNo: 1, status: "ACCEPTED", objectKeyVersion: "SOURCE_V1",
    contentHash: H("c"), contentType: "image/png", width: 9, height: 12, sizeBytes: 90, acceptedAt: "2026-08-04T00:00:00.000Z",
    leaseToken: null, leaseExpiresAt: null, errorCode: null, errorRetryable: null,
  };
  const { buildSourceAssetObjectKey } = await import("../auto-listing-source-asset-store.mjs");
  accepted.objectKey = buildSourceAssetObjectKey(accepted);
  let externalCalls = 0;
  const result = await materializeSourceAsset({
    scope, parentPlan: parentPlan(), sourceSnapshot: frozenSourceSnapshot(), repository: repository({ async reserveSourceMaterialization() { return { status: "EXISTING_ACCEPTED", record: accepted }; } }),
    downloader: { async downloadSourceImage() { externalCalls += 1; return downloaded(); } },
    storage: { async putObjectFromBuffer() { externalCalls += 1; }, async getObjectBuffer() { externalCalls += 1; } },
  });
  assert.equal(result.status, "ACCEPTED");
  assert.equal(result.contentHash, H("c"));
  assert.equal(externalCalls, 0);
});

test("a reclaimed STORED attempt is read back before completion with zero download or write calls", async () => {
  const { buildSourceMaterializationInput, materializeSourceAsset } = await load();
  const { buildSourceAssetObjectKey } = await import("../auto-listing-source-asset-store.mjs");
  const built = buildSourceMaterializationInput({ scope, parentPlan: parentPlan() });
  const bytes = await downloaded();
  const stored = {
    ...scope, sourceRefHash: built.sourceRefHash, inputHash: built.inputHash,
    attemptId: "attempt-a", attemptNo: 1, leaseToken: "reclaimed-lease", leaseExpiresAt: "2026-08-04T01:00:00.000Z",
    status: "STORED", objectKeyVersion: "SOURCE_V1", contentHash: bytes.contentHash, contentType: bytes.contentType,
    width: bytes.width, height: bytes.height, sizeBytes: bytes.sizeBytes,
  };
  stored.objectKey = buildSourceAssetObjectKey(stored);
  let downloads = 0; let writes = 0; let reads = 0; let completed = 0;
  const result = await materializeSourceAsset({
    scope, parentPlan: parentPlan(), sourceSnapshot: frozenSourceSnapshot(),
    repository: repository({
      async reserveSourceMaterialization() { return { status: "RESERVED_STORED", record: stored }; },
      async completeSourceMaterialization(value) { completed += 1; return { ...value, status: "ACCEPTED", acceptedAt: "2026-08-04T00:00:00.000Z", leaseToken: null, leaseExpiresAt: null }; },
    }),
    downloader: { async downloadSourceImage() { downloads += 1; } },
    storage: {
      async putObjectFromBuffer() { writes += 1; },
      async getObjectBuffer() { reads += 1; return bytes.bytes; },
    },
  });
  assert.equal(result.status, "ACCEPTED");
  assert.equal(result.contentHash, bytes.contentHash);
  assert.equal(completed, 1);
  assert.deepEqual({ downloads, writes, reads }, { downloads: 0, writes: 0, reads: 1 });
});

test("accepted replay fails closed on cross-scope, wrong hash or forged object evidence", async () => {
  const { buildSourceMaterializationInput, materializeSourceAsset } = await load();
  const built = buildSourceMaterializationInput({ scope, parentPlan: parentPlan() });
  const base = { ...scope, sourceRefHash: built.sourceRefHash, inputHash: built.inputHash, attemptId: "attempt-a", attemptNo: 1, status: "ACCEPTED", objectKeyVersion: "SOURCE_V1", objectKey: "forged", contentHash: H("c"), contentType: "image/png", width: 9, height: 12, sizeBytes: 90, acceptedAt: "2026-08-04T00:00:00.000Z", leaseToken: null, leaseExpiresAt: null, errorCode: null, errorRetryable: null };
  for (const record of [{ ...base, accountId: "other" }, { ...base, inputHash: H("d") }, base]) {
    await assert.rejects(materializeSourceAsset({ scope, parentPlan: parentPlan(), sourceSnapshot: frozenSourceSnapshot(), repository: repository({ async reserveSourceMaterialization() { return { status: "EXISTING_ACCEPTED", record }; } }), downloader: {}, storage: {} }), (error) => error?.code === "AUTO_LISTING_SOURCE_MATERIALIZATION_REPLAY_INVALID");
  }
});

test("download failure is persisted with only a closed safe error code and never the source URL", async () => {
  const { materializeSourceAsset } = await load();
  let failure;
  await assert.rejects(materializeSourceAsset({
    scope, parentPlan: parentPlan(), sourceSnapshot: frozenSourceSnapshot(),
    repository: repository({ async failSourceMaterialization(value) { failure = value; return { ...value, status: "FAILED", leaseToken: null, leaseExpiresAt: null }; } }),
    downloader: { async downloadSourceImage() { const error = new Error("https://cdn.example.test/?token=secret socket failed"); error.code = "AUTO_LISTING_SOURCE_DOWNLOAD_FAILED"; error.retryable = true; throw error; } },
    storage: {},
  }), (error) => error?.code === "AUTO_LISTING_SOURCE_DOWNLOAD_FAILED" && error?.retryable === true
    && !/cdn|secret|socket/u.test(error.message) && !error.cause);
  assert.equal(failure.errorCode, "AUTO_LISTING_SOURCE_DOWNLOAD_FAILED");
  assert.equal(failure.errorRetryable, true);
  assert.equal(JSON.stringify(failure).includes("cdn.example"), false);
});

test("cancellation discovered while persisting a download failure acknowledges without raw errors or later effects", async () => {
  const { materializeSourceAsset } = await load();
  const result = await materializeSourceAsset({
    scope, parentPlan: parentPlan(), sourceSnapshot: frozenSourceSnapshot(),
    repository: repository({
      async failSourceMaterialization() {
        const error = new Error("raw database url and secret");
        error.code = "AUTO_LISTING_SOURCE_MATERIALIZATION_CLAIM_REJECTED";
        throw error;
      },
    }),
    downloader: { async downloadSourceImage() { const error = new Error("raw socket url"); error.code = "AUTO_LISTING_SOURCE_DOWNLOAD_FAILED"; error.retryable = true; throw error; } },
    storage: {},
  });
  assert.deepEqual(result, { status: "SKIPPED", reasonCode: "AUTO_LISTING_SOURCE_MATERIALIZATION_STALE" });
});

test("an expired completion lease cannot later accept a STORED record whose object was removed", async () => {
  const { materializeSourceAsset } = await load();
  const { createMemorySourceMaterializationRepository } = await import("../auto-listing-source-materialization-repository.mjs");
  const bytes = await downloaded();
  let clock = 1_000;
  let nonce = 0;
  const actual = createMemorySourceMaterializationRepository({
    now: () => clock,
    leaseMs: 10,
    token: () => `lease-${++nonce}`,
    id: () => `attempt-expired-completion-${nonce}`,
  });
  const wrapped = {
    ...actual,
    async recordStoredSourceMaterialization(input) {
      const value = await actual.recordStoredSourceMaterialization(input);
      clock = 1_011;
      return value;
    },
  };
  let exists = false;
  let removals = 0;
  const storage = {
    async putObjectFromBuffer(input) {
      exists = true;
      return { key: input.key, sha256: bytes.contentHash, contentType: bytes.contentType, size: bytes.sizeBytes };
    },
    async getObjectBuffer() { if (!exists) throw new Error("missing object"); return bytes.bytes; },
    async removeObject() { removals += 1; exists = false; },
  };
  assert.deepEqual(await materializeSourceAsset({
    scope, parentPlan: parentPlan(), sourceSnapshot: frozenSourceSnapshot(), repository: wrapped,
    downloader: { async downloadSourceImage() { return bytes; } }, storage,
  }), { status: "SKIPPED", reasonCode: "AUTO_LISTING_SOURCE_MATERIALIZATION_STALE" });
  assert.equal(exists, false);

  await assert.rejects(materializeSourceAsset({
    scope, parentPlan: parentPlan(), sourceSnapshot: frozenSourceSnapshot(), repository: actual,
    downloader: { async downloadSourceImage() { throw new Error("must not use the remote URL for a STORED recovery"); } },
    storage,
  }), (error) => error?.code === "AUTO_LISTING_SOURCE_ASSET_STORAGE_UNAVAILABLE" && error?.retryable === true);
  assert.equal(actual.snapshot()[0].status, "FAILED");
  assert.equal(removals, 2, "both stale completion and failed recovery must leave no unreferenced object");
});
