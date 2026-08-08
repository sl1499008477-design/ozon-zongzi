import assert from "node:assert/strict";
import test from "node:test";

import { createAutoListingReviewService } from "../auto-listing-review-service.mjs";

function evidence(overrides = {}) {
  return {
    accountId: "account-a",
    item: {
      accountId: "account-a", id: "item-a", status: "READY_FOR_REVIEW", sourceRecordId: "collect-a",
      targetStoreId: "store-a", targetWarehouseId: "warehouse-a", stock: 5, variantCount: 2, statusVersion: 5,
      failureCode: null, price: { currency: "RUB", branch: "BLACK_LT_80", blackKopecks: "7000", realPriceKopecks: "6533", adjustmentKopecks: "0", finalPriceKopecks: "6533" },
    },
    source: { accountId: "account-a", title: "Товар", sku: "1001", thumbnailUrl: "" },
    store: { accountId: "account-a", id: "store-a", label: "主店" },
    warehouse: { accountId: "account-a", id: "warehouse-a", name: "仓库" },
    visualGroups: [{ key: "group-a", sourceAssetIds: ["source-a"] }],
    images: Array.from({ length: 6 }, (_, index) => ({
      accountId: "account-a", id: `asset-${index}`, visualGroupKey: "group-a",
      role: index === 0 ? "MAIN" : "SELLING_POINT",
      slotKey: `slot-${index}`, accepted: true, publicUrl: `/auto-listing/items/item-a/assets/asset-${index}`,
    })),
    richContent: { accountId: "account-a", accepted: true, previewText: "Описание" },
    events: [],
    ...overrides,
  };
}

test("review service enforces permission and returns the closed public view", async () => {
  const service = createAutoListingReviewService({ repository: { async loadReviewEvidence() { return evidence(); } } });
  const result = await service.getReview({ actor: { id: "account-a", role: "user" }, itemId: "item-a" });
  assert.equal(result.itemId, "item-a");
  assert.equal(result.statusVersion, 5);
  assert.equal(result.images.length, 6);
  assert.doesNotMatch(JSON.stringify(result), /objectKey|private|checker/i);
});

test("review service hides cross-account existence and rejects incomplete accepted evidence", async () => {
  for (const value of [null, evidence({ images: evidence().images.slice(0, 5) }), evidence({ images: evidence().images.map((image) => ({ ...image, role: "DETAIL" })) })]) {
    const service = createAutoListingReviewService({ repository: { async loadReviewEvidence() { return value; } } });
    await assert.rejects(service.getReview({ actor: { id: "account-a", role: "user" }, itemId: "item-a" }), {
      code: value === null ? "AUTO_LISTING_REVIEW_NOT_FOUND" : "AUTO_LISTING_REVIEW_NOT_READY",
    });
  }
});

test("review service exposes completed review states only", async () => {
  for (const status of [
    "CREATED", "SOURCE_READY", "PLANNING", "GENERATING", "UPLOAD_QUEUED",
    "UPLOADING", "RETRYABLE_ERROR", "BLOCKED", "CANCELLED",
  ]) {
    const service = createAutoListingReviewService({ repository: {
      async loadReviewEvidence() {
        return evidence({ item: { ...evidence().item, status } });
      },
    } });
    await assert.rejects(
      service.getReview({ actor: { id: "account-a", role: "user" }, itemId: "item-a" }),
      { code: "AUTO_LISTING_REVIEW_NOT_READY" },
      status,
    );
  }
  for (const status of ["READY_FOR_REVIEW", "SUCCEEDED"]) {
    const service = createAutoListingReviewService({ repository: {
      async loadReviewEvidence() {
        return evidence({ item: { ...evidence().item, status } });
      },
    } });
    const result = await service.getReview({ actor: { id: "account-a", role: "user" }, itemId: "item-a" });
    assert.equal(result.status, status);
  }
});

test("review asset read derives account authority, validates ids, and hides missing assets", async () => {
  const calls = [];
  const acceptedAsset = {
    accountId: "account-a", itemId: "item-a", assetId: "asset-a", objectKey: "private/a.png",
    contentType: "image/png", contentHash: "a".repeat(64), sizeBytes: 1024,
  };
  const service = createAutoListingReviewService({ repository: {
    async loadReviewEvidence() { return evidence(); },
    async loadAcceptedAsset(input) { calls.push(input); return input.assetId === "missing" ? null : acceptedAsset; },
  } });
  const actor = { id: "account-a", role: "user" };
  assert.deepEqual(await service.getAcceptedAsset({ actor, itemId: "item-a", assetId: "asset-a" }), acceptedAsset);
  assert.deepEqual(calls, [{ accountId: "account-a", itemId: "item-a", assetId: "asset-a" }]);
  await assert.rejects(service.getAcceptedAsset({ actor, itemId: "item-a", assetId: "missing" }), {
    code: "AUTO_LISTING_REVIEW_ASSET_NOT_FOUND",
  });
  await assert.rejects(service.getAcceptedAsset({ actor, itemId: "item-a", assetId: "private/a.png" }), {
    code: "AUTO_LISTING_REVIEW_INVALID",
  });
  await assert.rejects(service.getAcceptedAsset({ actor: { id: "", role: "user" }, itemId: "item-a", assetId: "asset-a" }), {
    code: "PERMISSION_FORBIDDEN",
  });
  const forgedScope = { actor, itemId: "item-a", assetId: "asset-a" };
  Object.defineProperty(forgedScope, "accountId", { value: "account-b" });
  await assert.rejects(service.getAcceptedAsset(forgedScope), { code: "AUTO_LISTING_REVIEW_INVALID" });
});

test("review asset service hides repository records whose scope does not exactly match", async () => {
  for (const asset of [
    { accountId: "account-b", itemId: "item-a", assetId: "asset-a" },
    { accountId: "account-a", itemId: "item-b", assetId: "asset-a" },
    { accountId: "account-a", itemId: "item-a", assetId: "asset-b" },
  ]) {
    const service = createAutoListingReviewService({ repository: {
      async loadReviewEvidence() { return evidence(); },
      async loadAcceptedAsset() { return { ...asset, objectKey: "private/a.png", contentType: "image/png", contentHash: "a".repeat(64), sizeBytes: 1024 }; },
    } });
    await assert.rejects(service.getAcceptedAsset({
      actor: { id: "account-a", role: "user" }, itemId: "item-a", assetId: "asset-a",
    }), { code: "AUTO_LISTING_REVIEW_ASSET_NOT_FOUND" });
  }
});
