import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import sharp from "sharp";

import {
  buildGeneratedAssetObjectKey,
  GENERATED_ASSET_OBJECT_KEY_VERSIONS,
} from "../auto-listing-asset-store.mjs";
import { createListingAssetPublicationService } from "../listing-asset-publication.mjs";
import { listingAssetPublicationConfig } from "../runtime-config.mjs";

const bytes = await sharp({ create: { width: 2, height: 3, channels: 4, background: "red" } }).png().toBuffer();
const contentHash = crypto.createHash("sha256").update(bytes).digest("hex");
const attemptIdentityHash = "b".repeat(64);
const inputHash = "c".repeat(64);
const actor = { id: "account-a", role: "user" };
const RECORD_FROM_INPUT = Symbol("record-from-input");

function asset(overrides = {}) {
  const scope = {
    accountId: "account-a", jobId: "job-a", itemId: "item-a", planId: "plan-a",
    assetId: "asset-a", visualGroupKey: "group-a", slotKey: "main-1", role: "MAIN",
    status: "ACCEPTED", objectKeyVersion: GENERATED_ASSET_OBJECT_KEY_VERSIONS.ATTEMPT_V2,
    attemptIdentityHash, attemptNo: 1, inputHash, contentHash,
    contentType: "image/png", sizeBytes: bytes.length, width: 2, height: 3,
  };
  scope.objectKey = buildGeneratedAssetObjectKey(scope);
  return { ...scope, ...overrides };
}

function assetWithValidKey(overrides = {}) {
  const row = asset(overrides);
  row.objectKey = buildGeneratedAssetObjectKey(row);
  return row;
}

const config = (overrides = {}) => listingAssetPublicationConfig({
  AUTO_LISTING_UPLOAD_ENABLED: "true",
  LISTING_ASSET_PUBLIC_BASE_URL: "https://media.example.com/ozon/",
  LISTING_ASSET_PUBLIC_PREFIX: "listing-media/v1",
  LISTING_ASSET_PUBLICATION_VERSION: "LISTING_MEDIA_V1",
  ...overrides,
});

function harness({ row = asset(), existing = null, readBytes = bytes, publicReadBytes = bytes,
  putResult = null, recordResult = RECORD_FROM_INPUT, recordError = null, cleanupError = null } = {}) {
  const calls = [];
  const events = [];
  const metrics = [];
  const repository = {
    async findPublication(input) { calls.push(["find", input]); return existing; },
    async loadAcceptedAsset(input) { calls.push(["load", input]); return row; },
    async recordPublication(input) {
      calls.push(["record", input]);
      if (recordError) throw recordError;
      return recordResult === RECORD_FROM_INPUT ? { ...row, ...input, status: "ACCEPTED" } : recordResult;
    },
  };
  const service = createListingAssetPublicationService({
    repository,
    async readPrivateObject(input) { calls.push(["read-private", input]); return readBytes; },
    async putPublicObject(input) {
      calls.push(["put", input]);
      return putResult || { key: input.key, contentType: input.contentType, size: input.buffer.length, sha256: contentHash };
    },
    async readPublicObject(input) { calls.push(["read-public", input]); return publicReadBytes; },
    async recordOrphanCleanup(input) {
      calls.push(["cleanup", input]);
      if (cleanupError) throw cleanupError;
      return { ...input, id: "cleanup-a", status: "PENDING" };
    },
    logger: { warn(event) { events.push(event); } },
    metrics: { increment(name, labels) { metrics.push({ name, labels }); } },
    config: config(),
  });
  return { service, calls, events, metrics };
}

test("publishes one same-account current-plan accepted asset after strict private and public readback", async () => {
  const h = harness();
  const result = await h.service.publishListingAsset({ actor, itemId: "item-a", assetId: "asset-a" });
  assert.equal(result.accountId, "account-a");
  assert.equal(result.itemId, "item-a");
  assert.equal(result.status, "ACCEPTED");
  assert.equal(result.publishedUrl, `https://media.example.com/ozon/listing-media/v1/${contentHash.slice(0, 2)}/${contentHash}.png`);
  assert.equal(result.contentHash, contentHash);
  assert.equal(result.publicationVersion, "LISTING_MEDIA_V1");
  const put = h.calls.find(([name]) => name === "put")[1];
  assert.equal(put.key, `listing-media/v1/${contentHash.slice(0, 2)}/${contentHash}.png`);
  assert.deepEqual(put.buffer, bytes);
  assert.doesNotMatch(put.key, /account-a|asset-a|SKU|title/iu);
  assert.deepEqual(h.calls.map(([name]) => name), ["find", "load", "read-private", "put", "read-public", "record"]);
  assert.deepEqual(h.events, []);
  assert.deepEqual(h.metrics, []);
});

test("repeated publication reuses current-version durable evidence without storage access", async () => {
  const existing = {
    ...asset(), status: "ACCEPTED", publishedUrl: `https://media.example.com/ozon/listing-media/v1/${contentHash.slice(0, 2)}/${contentHash}.png`,
    publicObjectKey: `listing-media/v1/${contentHash.slice(0, 2)}/${contentHash}.png`, publicationVersion: "LISTING_MEDIA_V1",
    publicBaseUrl: "https://media.example.com/ozon/", publicPrefix: "listing-media/v1",
  };
  const h = harness({ existing });
  const result = await h.service.publishListingAsset({ actor, itemId: "item-a", assetId: "asset-a" });
  assert.equal(result.publishedUrl, existing.publishedUrl);
  assert.equal(Object.hasOwn(result, "objectKey"), false);
  assert.deepEqual(h.calls.map(([name]) => name), ["find"]);
  assert.equal(h.calls[0][1].publicationVersion, "LISTING_MEDIA_V1");
});

test("same publication version fails closed when its frozen public base or prefix was changed", async () => {
  for (const existing of [
    {
      ...asset(), publishedUrl: `https://old-cdn.example.com/legacy/${contentHash.slice(0, 2)}/${contentHash}.png`,
      publicObjectKey: `legacy/${contentHash.slice(0, 2)}/${contentHash}.png`, publicationVersion: "LISTING_MEDIA_V1",
      publicBaseUrl: "https://old-cdn.example.com/", publicPrefix: "legacy",
    },
    {
      ...asset(), publishedUrl: `https://media.example.com/ozon/other/${contentHash.slice(0, 2)}/${contentHash}.png`,
      publicObjectKey: `other/${contentHash.slice(0, 2)}/${contentHash}.png`, publicationVersion: "LISTING_MEDIA_V1",
      publicBaseUrl: "https://media.example.com/ozon/", publicPrefix: "other",
    },
  ]) {
    const h = harness({ existing });
    await assert.rejects(h.service.publishListingAsset({ actor, itemId: "item-a", assetId: "asset-a" }), {
      code: "LISTING_ASSET_PUBLICATION_BOUNDARY",
    });
    assert.deepEqual(h.calls.map(([name]) => name), ["find"]);
  }
});

test("rejects malformed or cross-scope ATTEMPT_V2 keys before any private storage read", async () => {
  for (const row of [
    asset({ objectKey: "private/account-b/asset.png" }),
    asset({ objectKeyVersion: "LEGACY_V1" }),
    asset({ attemptIdentityHash: "d".repeat(64) }),
  ]) {
    const h = harness({ row });
    await assert.rejects(h.service.publishListingAsset({ actor, itemId: "item-a", assetId: "asset-a" }), { code: "LISTING_ASSET_PUBLICATION_BOUNDARY" });
    assert.equal(h.calls.some(([name]) => name === "read-private"), false);
  }
});

test("decodes private bytes and rejects MIME, dimensions, hash, size, or non-buffer failures with stable errors", async () => {
  const jpeg = await sharp(bytes).jpeg().toBuffer();
  for (const setup of [
    { row: assetWithValidKey({ contentHash: crypto.createHash("sha256").update(jpeg).digest("hex"), sizeBytes: jpeg.length }), readBytes: jpeg },
    { row: asset({ width: 3 }) },
    { row: assetWithValidKey({ contentHash: "f".repeat(64) }) },
    { row: asset({ sizeBytes: bytes.length + 1 }) },
    { readBytes: { not: "bytes" } },
  ]) {
    const h = harness(setup);
    await assert.rejects(h.service.publishListingAsset({ actor, itemId: "item-a", assetId: "asset-a" }), { code: "LISTING_ASSET_PUBLICATION_BOUNDARY" });
    assert.equal(h.calls.some(([name]) => name === "put"), false);
  }
});

test("strictly validates put acknowledgement and public readback before immutable record", async () => {
  for (const setup of [
    { putResult: { key: "wrong", contentType: "image/png", size: bytes.length, sha256: contentHash } },
    { putResult: { key: `listing-media/v1/${contentHash.slice(0, 2)}/${contentHash}.png`, contentType: "image/jpeg", size: bytes.length, sha256: contentHash } },
    { putResult: { key: `listing-media/v1/${contentHash.slice(0, 2)}/${contentHash}.png`, contentType: "image/png", size: bytes.length - 1, sha256: contentHash } },
    { putResult: { key: `listing-media/v1/${contentHash.slice(0, 2)}/${contentHash}.png`, contentType: "image/png", size: bytes.length, sha256: "f".repeat(64) } },
    { publicReadBytes: Buffer.from(bytes).fill(0) },
  ]) {
    const h = harness(setup);
    await assert.rejects(h.service.publishListingAsset({ actor, itemId: "item-a", assetId: "asset-a" }), { code: "LISTING_ASSET_PUBLICATION_FAILED" });
    assert.equal(h.calls.some(([name]) => name === "record"), false);
    assert.equal(h.events.length, 1);
    assert.equal(Object.values(h.events[0]).some((value) => String(value).includes("auto-listing/v2/")), false);
    assert.equal(h.metrics.length, 1);
  }
});

test("records a safe observable failure when current plan changes after public put", async () => {
  const h = harness({ recordResult: null });
  await assert.rejects(h.service.publishListingAsset({ actor, itemId: "item-a", assetId: "asset-a" }), { code: "LISTING_ASSET_PUBLICATION_BOUNDARY" });
  assert.equal(h.calls.some(([name]) => name === "put"), true);
  assert.equal(h.calls.at(-1)[0], "cleanup");
  assert.deepEqual(Object.keys(h.calls.at(-1)[1]).sort(), [
    "accountId", "assetId", "contentHash", "itemId", "jobId", "planId", "publicBaseUrl",
    "publicObjectKey", "publicPrefix", "publicationVersion", "reasonCode",
  ]);
  assert.equal(h.events.at(-1).stage, "record");
  assert.equal(h.metrics.at(-1).labels.stage, "record");
});

test("ambiguous publication persistence always records a durable cleanup obligation", async () => {
  const h = harness({ recordError: new Error("database response lost") });
  await assert.rejects(h.service.publishListingAsset({ actor, itemId: "item-a", assetId: "asset-a" }), {
    code: "LISTING_ASSET_PUBLICATION_FAILED",
  });
  assert.deepEqual(h.calls.slice(-2).map(([name]) => name), ["record", "cleanup"]);
  assert.equal(h.calls.at(-1)[1].reasonCode, "RECORD_UNCERTAIN");
  assert.equal(JSON.stringify(h.events).includes("database response lost"), false);
});

test("cleanup obligation persistence failure is explicit and never triggers a blind delete", async () => {
  const h = harness({ recordResult: null, cleanupError: new Error("cleanup db unavailable") });
  await assert.rejects(h.service.publishListingAsset({ actor, itemId: "item-a", assetId: "asset-a" }), {
    code: "LISTING_ASSET_PUBLICATION_CLEANUP_PERSIST_FAILED",
  });
  assert.equal(h.calls.some(([name]) => name === "delete"), false);
  assert.equal(h.events.at(-1).stage, "cleanup-record");
  assert.equal(JSON.stringify(h.events).includes("cleanup db unavailable"), false);
});

test("configuration supports explicit policy version evolution and rejects unsafe policies", () => {
  assert.equal(listingAssetPublicationConfig({ AUTO_LISTING_UPLOAD_ENABLED: "false" }), null);
  assert.equal(config({ LISTING_ASSET_PUBLICATION_VERSION: "LISTING_MEDIA_V2" }).publicationVersion, "LISTING_MEDIA_V2");
  for (const entry of [
    { LISTING_ASSET_PUBLIC_BASE_URL: "http://media.example.com/" },
    { LISTING_ASSET_PUBLIC_BASE_URL: "https://user:pass@media.example.com/" },
    { LISTING_ASSET_PUBLIC_BASE_URL: "https://media.example.com/?token=x" },
    { LISTING_ASSET_PUBLIC_BASE_URL: "https://localhost/media/" },
    { LISTING_ASSET_PUBLIC_BASE_URL: "https://127.0.0.1/media/" },
    { LISTING_ASSET_PUBLICATION_VERSION: "bad version" },
  ]) {
    assert.throws(() => config(entry), { code: "LISTING_ASSET_PUBLICATION_CONFIG_INVALID" });
  }
});

test("disabled publication performs no repository or storage side effects", async () => {
  const calls = [];
  const service = createListingAssetPublicationService({
    repository: {
      async findPublication() { calls.push("find"); }, async loadAcceptedAsset() { calls.push("load"); },
      async recordPublication() { calls.push("record"); },
    },
    async readPrivateObject() { calls.push("read-private"); },
    async putPublicObject() { calls.push("put"); },
    async readPublicObject() { calls.push("read-public"); },
    async recordOrphanCleanup() { calls.push("cleanup"); },
    config: null,
  });
  await assert.rejects(service.publishListingAsset({ actor, itemId: "item-a", assetId: "asset-a" }), { code: "LISTING_ASSET_PUBLICATION_DISABLED" });
  assert.deepEqual(calls, []);
});

test("repository read failures are stable, observable, and never expose object keys", async () => {
  const events = [];
  const metrics = [];
  const service = createListingAssetPublicationService({
    repository: {
      async findPublication() { throw new Error("database secret detail"); },
      async loadAcceptedAsset() { throw new Error("must not run"); },
      async recordPublication() { throw new Error("must not run"); },
    },
    async readPrivateObject() { throw new Error("must not run"); },
    async putPublicObject() { throw new Error("must not run"); },
    async readPublicObject() { throw new Error("must not run"); },
    async recordOrphanCleanup() { throw new Error("must not run"); },
    logger: { warn(event) { events.push(event); } },
    metrics: { increment(name, labels) { metrics.push({ name, labels }); } },
    config: config(),
  });
  await assert.rejects(service.publishListingAsset({ actor, itemId: "item-a", assetId: "asset-a" }), {
    code: "LISTING_ASSET_PUBLICATION_FAILED", message: "LISTING_ASSET_PUBLICATION_FAILED",
  });
  assert.deepEqual(events.map(({ stage, code }) => ({ stage, code })), [{ stage: "find", code: "LISTING_ASSET_PUBLICATION_FAILED" }]);
  assert.equal(JSON.stringify(events).includes("database secret detail"), false);
  assert.deepEqual(metrics[0].labels, { stage: "find", code: "LISTING_ASSET_PUBLICATION_FAILED" });
});
