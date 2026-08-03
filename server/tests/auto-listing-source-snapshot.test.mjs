import assert from "node:assert/strict";
import test from "node:test";
import { buildAutoListingSourceSnapshot } from "../auto-listing-source-snapshot.mjs";

const collectItem = (overrides = {}) => ({
  id: "collect-1",
  accountId: "account-a",
  sku: "sku-primary",
  name: "Primary product",
  listingDraft: {
    sku: "sku-primary",
    offerId: "offer-primary",
    title: "Primary product",
    categoryResolution: {
      status: "MATCHED",
      method: "taxonomy",
      target: { storeId: "store-a", descriptionCategoryId: "123", typeId: "456" },
      source: { sourceCategoryId: "source-8", path: ["root", "child"] },
      match: { dictionaryId: "dict-1" },
      taxonomy: { version: "v2" },
    },
    attributes: [{ attributeId: "10", dictionaryValueId: "20", values: ["red"], multiple: true }],
    logistics: { weight: 1200, weightUnit: "g", length: 30, width: 20, height: 10, dimensionUnit: "cm" },
    productMeasurements: { length: 28, unit: "cm", reliable: true, source: "manufacturer" },
    blackKopecks: "10000",
    greenKopecks: "8000",
    currency: "RUB",
    images: ["https://media.example/primary.jpg"],
    videos: [{ url: "https://media.example/video.mp4" }],
    richContent: { blocks: [{ text: "facts" }] },
    variants: [{ sku: "sku-primary", offerId: "offer-primary", name: "Primary product", images: ["https://media.example/primary.jpg"] }],
  },
  ...overrides,
});

const source = (overrides = {}) => ({
  accountId: "account-a",
  sourceType: "COLLECT_BOX",
  sourceRecordId: "collect-1",
  sourceVersion: "7",
  collectItem: collectItem(),
  productDraft: { id: "draft-1", version: 7 },
  rawResponseRef: "raw-response-1",
  ...overrides,
});

const reverseKeys = (value) => {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).reverse().map(([key, nested]) => [key, reverseKeys(nested)]));
};

test("builds an isolated snapshot preserving listing facts and multi-variant evidence", () => {
  const input = source({
    collectItem: collectItem({
      listingDraft: {
        ...collectItem().listingDraft,
        variants: [
          { sku: "sku-primary", offerId: "offer-primary", name: "Primary product", images: ["https://media.example/primary.jpg"], relation: { group: "g-1" } },
          { sku: "sku-blue", offerId: "offer-blue", name: "Blue product", images: ["https://media.example/blue.jpg"], relation: { group: "g-1" } },
        ],
      },
    }),
  });
  const before = structuredClone(input);

  const result = buildAutoListingSourceSnapshot(input);

  assert.deepEqual(Object.keys(result.snapshot).sort(), [
    "identity", "source", "targetCategory", "attributes", "logistics", "productMeasurements",
    "priceEvidence", "variants", "media", "richContent", "rawEvidence",
  ].sort());
  assert.equal(result.snapshot.identity.primarySku, "sku-primary");
  assert.equal(result.snapshot.targetCategory.descriptionCategoryId, "123");
  assert.equal(result.snapshot.targetCategory.typeId, "456");
  assert.equal(result.snapshot.attributes[0].dictionaryValueId, "20");
  assert.equal(result.snapshot.logistics.weight, 1200);
  assert.equal(result.snapshot.productMeasurements.reliable, true);
  assert.deepEqual(result.snapshot.priceEvidence, { blackKopecks: "10000", greenKopecks: "8000", currency: "RUB" });
  assert.equal(result.snapshot.variants.length, 2);
  assert.equal(result.snapshot.variants[1].sku, "sku-blue");
  assert.deepEqual(result.snapshot.media.videos, [{ url: "https://media.example/video.mp4" }]);
  assert.deepEqual(result.snapshot.richContent, { blocks: [{ text: "facts" }] });
  assert.equal(result.rawResponseRef, "raw-response-1");
  assert.match(result.snapshotHash, /^[a-f0-9]{64}$/);
  result.snapshot.variants[0].sku = "changed";
  assert.deepEqual(input, before);
});

test("hashes equivalent key orders equally and business changes differently", () => {
  const left = source();
  const right = source({
    collectItem: collectItem({
      listingDraft: reverseKeys(collectItem().listingDraft),
    }),
  });
  const first = buildAutoListingSourceSnapshot(left);
  const second = buildAutoListingSourceSnapshot(right);
  const changed = buildAutoListingSourceSnapshot(source({
    collectItem: collectItem({ listingDraft: { ...collectItem().listingDraft, blackKopecks: "10001" } }),
  }));
  assert.equal(first.snapshotHash, second.snapshotHash);
  assert.notEqual(first.snapshotHash, changed.snapshotHash);
});

test("rejects untrusted scope and missing required source facts with stable codes", () => {
  for (const [input, code] of [
    [source({ accountId: "account-b" }), "AUTO_LISTING_SOURCE_SCOPE"],
    [source({ sourceRecordId: "" }), "AUTO_LISTING_SOURCE_INVALID"],
    [source({ collectItem: collectItem({ listingDraft: { ...collectItem().listingDraft, categoryResolution: { ...collectItem().listingDraft.categoryResolution, target: { ...collectItem().listingDraft.categoryResolution.target, descriptionCategoryId: "" } } } }) }), "AUTO_LISTING_SOURCE_CATEGORY_REQUIRED"],
    [source({ collectItem: collectItem({ listingDraft: { ...collectItem().listingDraft, variants: [{ sku: "" }] } }) }), "AUTO_LISTING_SOURCE_SKU_REQUIRED"],
    [source({ collectItem: collectItem({ listingDraft: { ...collectItem().listingDraft, currency: "USD" } }) }), "AUTO_LISTING_SOURCE_CURRENCY_NOT_RUB"],
  ]) {
    assert.throws(() => buildAutoListingSourceSnapshot(input), (error) => error?.code === code);
  }
});

test("rejects cycles, dangerous keys and non-json source values", () => {
  const cyclic = source();
  cyclic.collectItem.listingDraft.attributes = [{ self: cyclic }];
  const dangerous = source({
    collectItem: collectItem({ listingDraft: { ...collectItem().listingDraft, richContent: JSON.parse('{"__proto__":{"polluted":true}}') } }),
  });
  const nonFinite = source({
    collectItem: collectItem({ listingDraft: { ...collectItem().listingDraft, logistics: { weight: Number.POSITIVE_INFINITY } } }),
  });
  for (const input of [cyclic, dangerous, nonFinite]) {
    assert.throws(() => buildAutoListingSourceSnapshot(input), (error) => error?.code === "AUTO_LISTING_SOURCE_INVALID");
  }
});
