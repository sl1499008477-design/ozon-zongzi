import assert from "node:assert/strict";
import test from "node:test";

import { createAutoListingReviewView } from "../auto-listing-view.mjs";

function fixture(overrides = {}) {
  return {
    accountId: "account-a",
    item: {
      accountId: "account-a",
      id: "item-a",
      status: "READY_FOR_REVIEW",
      sourceRecordId: "collect-a",
      targetStoreId: "store-a",
      targetWarehouseId: "warehouse-a",
      stock: 5,
      variantCount: 2,
      price: {
        currency: "RUB", branch: "BLACK_GTE_80", blackKopecks: "10000",
        greenKopecks: "8000", realPriceKopecks: "14500", adjustmentKopecks: "100",
        finalPriceKopecks: "14600",
      },
      failureCode: null,
      statusVersion: 5,
    },
    source: {
      accountId: "account-a",
      title: "Термос",
      sku: "1001",
      thumbnailUrl: "https://cdn.example/source.jpg",
    },
    store: { accountId: "account-a", id: "store-a", label: "主店" },
    warehouse: { accountId: "account-a", id: "warehouse-a", name: "CEL-陆运" },
    visualGroups: [{ key: "group-a", sourceAssetIds: ["source-a"] }],
    images: [{
      accountId: "account-a", id: "image-a", visualGroupKey: "group-a", role: "MAIN", slotKey: "main-1", accepted: true,
      requestedRole: "MAIN", substitutionReasonCode: null, manualReviewWarnings: [],
      publicUrl: "https://cdn.example/generated.jpg", objectKey: "private/object/key",
      checkerEvidence: { raw: "private reasoning" }, requestBody: "private",
    }],
    richContent: {
      accountId: "account-a", accepted: true, previewText: "Новый текст",
      internalDocument: { hidden: true }, requestId: "private-request",
    },
    events: [{
      accountId: "account-a", eventCode: "CONTENT_READY", outcome: "SUCCESS",
      createdAt: "2026-08-04T14:00:00.000Z", metadata: { private: true },
    }],
    ...overrides,
  };
}

test("returns the closed ordinary-user review DTO and omits internal evidence", () => {
  const view = createAutoListingReviewView(fixture());

  assert.deepEqual(view, {
    itemId: "item-a",
    status: "READY_FOR_REVIEW",
    statusVersion: 5,
    failureCode: null,
    source: {
      recordId: "collect-a", title: "Термос", sku: "1001",
      thumbnailUrl: "https://cdn.example/source.jpg",
    },
    target: {
      storeId: "store-a", storeLabel: "主店", warehouseId: "warehouse-a",
      warehouseLabel: "CEL-陆运", stock: 5, variantCount: 2, imageCount: 1,
    },
    price: {
      currency: "RUB", branch: "BLACK_GTE_80", blackKopecks: "10000",
      greenKopecks: "8000", realPriceKopecks: "14500", adjustmentKopecks: "100",
      finalPriceKopecks: "14600",
    },
    visualGroups: [{ key: "group-a", sourceAssetIds: ["source-a"] }],
    images: [{
      id: "image-a", visualGroupKey: "group-a", role: "MAIN", roleLabel: "主图", slotKey: "main-1",
      requestedRole: "MAIN", requestedRoleLabel: "主图", substitutionReasonCode: null,
      substitutionReasonLabel: "", manualReviewWarnings: [], manualReviewWarningLabels: [],
      accepted: true, url: "https://cdn.example/generated.jpg",
    }],
    richContent: { accepted: true, previewText: "Новый текст" },
    generationSummary: "已生成并接受新的商品图片和富文本",
    actions: { review: true, retry: false, regenerate: true, cancel: true },
    timeline: [{ code: "CONTENT_READY", outcome: "SUCCESS", createdAt: "2026-08-04T14:00:00.000Z" }],
  });
  const serialized = JSON.stringify(view);
  assert.doesNotMatch(serialized, /objectKey|checker|reasoning|requestBody|requestId|internalDocument|metadata|private/i);
});

test("review DTO explains a substituted role and manual-review warning in ordinary language", () => {
  const value = createAutoListingReviewView(fixture({
    images: [{
      ...fixture().images[0],
      role: "DETAIL",
      requestedRole: "SPECIFICATION",
      substitutionReasonCode: "PRODUCT_DIMENSIONS_UNAVAILABLE",
      manualReviewWarnings: ["SUBJECT_NOT_DOMINANT", "LABEL_READABILITY_LOW"],
    }],
  }));

  assert.deepEqual(value.images[0], {
    id: "image-a", visualGroupKey: "group-a", role: "DETAIL", roleLabel: "细节图", slotKey: "main-1",
    requestedRole: "SPECIFICATION", requestedRoleLabel: "产品实拍图",
    substitutionReasonCode: "PRODUCT_DIMENSIONS_UNAVAILABLE",
    substitutionReasonLabel: "历史任务缺少可信参数，已改用细节图",
    manualReviewWarnings: ["SUBJECT_NOT_DOMINANT", "LABEL_READABILITY_LOW"],
    manualReviewWarningLabels: ["商品主体不够突出", "标签在缩略图下不易阅读"],
    accepted: true, url: "https://cdn.example/generated.jpg",
  });
});

test("preserves a native CNY price in the review contract", () => {
  const value = createAutoListingReviewView(fixture({
    item: {
      ...fixture().item,
      price: { ...fixture().item.price, currency: "CNY" },
    },
  }));
  assert.equal(value.price.currency, "CNY");
  assert.equal(value.price.finalPriceKopecks, "14600");
});

test("includes exact multiplier evidence in the safe review price", () => {
  const value = createAutoListingReviewView(fixture({
    item: {
      ...fixture().item,
      price: {
        ...fixture().item.price,
        preMultiplierPriceKopecks: "14600",
        priceMultiplierMicros: "1250000",
        finalPriceKopecks: "18250",
      },
    },
  }));
  assert.equal(value.price.preMultiplierPriceKopecks, "14600");
  assert.equal(value.price.priceMultiplierMicros, "1250000");
  assert.equal(value.price.finalPriceKopecks, "18250");
});

test("renders all 72 accepted images for an eleven-variant review", () => {
  const visualGroups = Array.from({ length: 11 }, (_, index) => ({
    key: `group-${index + 1}`,
    sourceAssetIds: [`source-${index + 1}`],
  }));
  const roles = ["MAIN", "SELLING_POINT", "DETAIL", "SCENE", "INFOGRAPHIC", "SELLING_POINT"];
  const images = visualGroups.flatMap((group, groupIndex) => {
    const count = groupIndex < 6 ? 7 : 6;
    return Array.from({ length: count }, (_, imageIndex) => ({
      accountId: "account-a",
      id: `image-${groupIndex + 1}-${imageIndex + 1}`,
      visualGroupKey: group.key,
      role: roles[imageIndex % roles.length],
      slotKey: `slot-${groupIndex + 1}-${imageIndex + 1}`,
      accepted: true,
      publicUrl: `https://cdn.example/generated-${groupIndex + 1}-${imageIndex + 1}.jpg`,
    }));
  });

  const value = createAutoListingReviewView(fixture({
    item: { ...fixture().item, variantCount: 11 },
    visualGroups,
    images,
  }));

  assert.equal(images.length, 72);
  assert.equal(value.images.length, 72);
  assert.equal(value.target.imageCount, 72);
});

test("rejects every cross-account component instead of filtering it silently", () => {
  for (const [field, value] of [
    ["item", { ...fixture().item, accountId: "account-b" }],
    ["source", { ...fixture().source, accountId: "account-b" }],
    ["store", { ...fixture().store, accountId: "account-b" }],
    ["warehouse", { ...fixture().warehouse, accountId: "account-b" }],
    ["images", [{ ...fixture().images[0], accountId: "account-b" }]],
    ["richContent", { ...fixture().richContent, accountId: "account-b" }],
    ["events", [{ ...fixture().events[0], accountId: "account-b" }]],
  ]) {
    assert.throws(() => createAutoListingReviewView(fixture({ [field]: value })), {
      code: "AUTO_LISTING_REVIEW_SCOPE_MISMATCH",
    });
  }
});

test("rejects unsafe image URLs and malformed price/status evidence", () => {
  assert.throws(() => createAutoListingReviewView(fixture({
    images: [{ ...fixture().images[0], publicUrl: "javascript:alert(1)" }],
  })), { code: "AUTO_LISTING_REVIEW_INVALID" });
  assert.throws(() => createAutoListingReviewView(fixture({
    item: { ...fixture().item, price: { ...fixture().item.price, currency: "USD" } },
  })), { code: "AUTO_LISTING_REVIEW_INVALID" });
  assert.throws(() => createAutoListingReviewView(fixture({
    item: { ...fixture().item, status: "ARBITRARY" },
  })), { code: "AUTO_LISTING_REVIEW_INVALID" });
});

test("only accepted images and bounded safe timeline fields reach the DTO", () => {
  const view = createAutoListingReviewView(fixture({
    images: [fixture().images[0], { ...fixture().images[0], id: "failed", accepted: false }],
    events: [
      fixture().events[0],
      { accountId: "account-a", eventCode: "bad text", outcome: "RAW", createdAt: "invalid" },
    ],
  }));
  assert.equal(view.images.length, 1);
  assert.deepEqual(view.timeline, [
    { code: "CONTENT_READY", outcome: "SUCCESS", createdAt: "2026-08-04T14:00:00.000Z" },
  ]);
});

test("accepts only the authenticated same-item asset proxy path as a relative image URL", () => {
  const value = createAutoListingReviewView(fixture({
    images: [{ ...fixture().images[0], publicUrl: "/auto-listing/items/item-a/assets/image-a" }],
  }));
  assert.equal(value.images[0].url, "/auto-listing/items/item-a/assets/image-a");
  for (const publicUrl of ["/local/files/private", "//evil.test/image", "/auto-listing/items/item-b/assets/image-a?token=x"]) {
    assert.throws(() => createAutoListingReviewView(fixture({
      images: [{ ...fixture().images[0], publicUrl }],
    })), { code: "AUTO_LISTING_REVIEW_INVALID" });
  }
});

test("review DTO never invents retry, blocked, uploading, or cancellation authority", () => {
  assert.deepEqual(createAutoListingReviewView(fixture()).actions, {
    review: true, retry: false, regenerate: true, cancel: true,
  });
  assert.deepEqual(createAutoListingReviewView(fixture({
    item: { ...fixture().item, status: "SUCCEEDED" },
  })).actions, {
    review: true, retry: false, regenerate: false, cancel: false,
  });
  for (const status of ["RETRYABLE_ERROR", "BLOCKED", "UPLOADING", "CANCELLED"]) {
    assert.deepEqual(createAutoListingReviewView(fixture({
      item: { ...fixture().item, status },
    })).actions, {
      review: false, retry: false, regenerate: false, cancel: false,
    }, status);
  }
});

test("review accepts the maximum contract-sized rich-text projection", () => {
  const previewText = "a".repeat(20 * 8192);
  const value = createAutoListingReviewView(fixture({
    richContent: { accountId: "account-a", accepted: true, previewText },
  }));
  assert.equal(value.richContent.previewText.length, previewText.length);
});

test("generation summary states only evidence already accepted by the review contract", () => {
  const value = createAutoListingReviewView(fixture());
  assert.equal(value.generationSummary, "已生成并接受新的商品图片和富文本");
  assert.doesNotMatch(value.generationSummary, /类目/u);
});
