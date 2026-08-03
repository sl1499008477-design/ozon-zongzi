import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import {
  buildAutoListingSourceSnapshot,
  verifyAutoListingSourceSnapshot,
} from "../auto-listing-source-snapshot.mjs";

const collectItem = (overrides = {}) => ({
  id: "collect-1",
  accountId: "account-a",
  sku: "sku-primary",
  name: "Primary product",
  listingDraft: {
    sku: "sku-primary",
    brand: "Brand one",
    collectedAt: "2026-08-04T01:02:03.000Z",
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
    variants: [{ sku: "sku-primary", offerId: "offer-primary", name: "Primary product", images: ["https://media.example/primary.jpg"], blackKopecks: "10000", greenKopecks: "8000", currency: "RUB", variantGroupId: "group-a" }],
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
  assert.equal(result.snapshot.identity.brand, "Brand one");
  assert.equal(result.snapshot.source.collectedAt, "2026-08-04T01:02:03.000Z");
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

test("preserves variant price, media and grouping facts and hashes every frozen business field", () => {
  const baseline = source({
    collectItem: collectItem({
      listingDraft: {
        ...collectItem().listingDraft,
        brand: "Brand one",
        variants: [{ sku: "sku-primary", offerId: "offer-primary", name: "Primary product", images: ["one"], blackKopecks: "10000", greenKopecks: "8000", currency: "RUB", variantGroupId: "group-a", relation: { visual: "same" } }],
      },
    }),
  });
  const first = buildAutoListingSourceSnapshot(baseline);
  assert.deepEqual(first.snapshot.variants[0].priceEvidence, { blackKopecks: "10000", greenKopecks: "8000", currency: "RUB" });
  assert.equal(first.snapshot.variants[0].groupId, "group-a");
  assert.deepEqual(first.snapshot.variants[0].media, ["one"]);
  for (const mutate of [
    (draft) => ({ ...draft, brand: "Brand two" }),
    (draft) => ({ ...draft, variants: [{ ...draft.variants[0], blackKopecks: "10001" }] }),
    (draft) => ({ ...draft, variants: [{ ...draft.variants[0], greenKopecks: "7999" }] }),
    (draft) => ({ ...draft, variants: [{ ...draft.variants[0], variantGroupId: "group-b" }] }),
    (draft) => ({ ...draft, variants: [{ ...draft.variants[0], images: ["two"] }] }),
  ]) {
    const next = buildAutoListingSourceSnapshot(source({ collectItem: collectItem({ listingDraft: mutate(baseline.collectItem.listingDraft) }) }));
    assert.notEqual(next.snapshotHash, first.snapshotHash);
  }
});

test("requires complete trusted scope and makes raw evidence and arrays JSON-exact", () => {
  for (const input of [
    source({ collectItem: collectItem({ accountId: undefined }) }),
    source({ collectItem: collectItem({ id: undefined }) }),
    source({ rawResponseRef: { id: "raw" } }),
    source({ rawResponseHash: ["hash"] }),
  ]) {
    assert.throws(() => buildAutoListingSourceSnapshot(input), (error) => error?.code === "AUTO_LISTING_SOURCE_SCOPE" || error?.code === "AUTO_LISTING_SOURCE_INVALID");
  }
  const sparse = source({ collectItem: collectItem({ listingDraft: { ...collectItem().listingDraft, attributes: Array(1) } }) });
  assert.throws(() => buildAutoListingSourceSnapshot(sparse), (error) => error?.code === "AUTO_LISTING_SOURCE_INVALID");
});

test("keeps matched target-store and reliable ancestor IDs separate from display labels", () => {
  const result = buildAutoListingSourceSnapshot(source({
    collectItem: collectItem({ listingDraft: {
      ...collectItem().listingDraft,
      categoryResolution: {
        ...collectItem().listingDraft.categoryResolution,
        target: { ...collectItem().listingDraft.categoryResolution.target, ancestorCategoryIds: ["ancestor-1", "ancestor-2"] },
        source: { path: ["Kitchen", "Tea kettles"] },
      },
    } }),
  }));
  assert.equal(result.snapshot.targetCategory.targetStoreId, "store-a");
  assert.deepEqual(result.snapshot.targetCategory.ancestorCategoryIds, ["ancestor-1", "ancestor-2"]);
  assert.deepEqual(verifyAutoListingSourceSnapshot(result), result);
  assert.throws(() => verifyAutoListingSourceSnapshot({ snapshot: { identity: {} }, snapshotHash: "bad" }), (error) => error?.code === "AUTO_LISTING_SOURCE_INVALID");
});

test("rejects semantically incomplete snapshots even when the supplied hash matches", () => {
  const valid = buildAutoListingSourceSnapshot(source());
  const malformed = structuredClone(valid.snapshot);
  malformed.variants = null;
  const snapshotHash = crypto.createHash("sha256").update(JSON.stringify(malformed)).digest("hex");
  assert.throws(
    () => verifyAutoListingSourceSnapshot({ ...valid, snapshot: malformed, snapshotHash }),
    (error) => error?.code === "AUTO_LISTING_SOURCE_INVALID",
  );
});

test("rejects non-scalar nested source versions even when canonical hashing succeeds", () => {
  const valid = buildAutoListingSourceSnapshot(source());
  const malformed = structuredClone(valid.snapshot);
  malformed.source.productDraftVersion = [];
  const snapshotHash = crypto.createHash("sha256").update(JSON.stringify(malformed)).digest("hex");
  assert.throws(
    () => verifyAutoListingSourceSnapshot({ ...valid, snapshot: malformed, snapshotHash }),
    (error) => error?.code === "AUTO_LISTING_SOURCE_INVALID",
  );
});

test("rejects rehashed empty and mismatched provenance facts", () => {
  const valid = buildAutoListingSourceSnapshot(source());
  for (const mutate of [
    (snapshot) => { snapshot.identity.primarySku = ""; },
    (snapshot) => { snapshot.source.sourceRecordId = "another-record"; },
  ]) {
    const malformed = structuredClone(valid.snapshot);
    mutate(malformed);
    const snapshotHash = crypto.createHash("sha256").update(JSON.stringify(malformed)).digest("hex");
    assert.throws(
      () => verifyAutoListingSourceSnapshot({ ...valid, snapshot: malformed, snapshotHash }),
      (error) => error?.code === "AUTO_LISTING_SOURCE_INVALID",
    );
  }
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
