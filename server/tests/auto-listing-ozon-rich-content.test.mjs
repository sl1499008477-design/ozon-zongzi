import assert from "node:assert/strict";
import test from "node:test";

import {
  AUTO_LISTING_OZON_RICH_CONTENT_VERSION,
  convertAutoListingRichContentToOzon,
  isVerifiedAutoListingOzonRichContentVersion,
} from "../auto-listing-ozon-rich-content.mjs";
import { testExports as normalizerTestExports } from "../ozon-import-normalizer.mjs";

const publishedAsset = (assetId, role, url, overrides = {}) => ({
  assetId,
  status: "ACCEPTED",
  accountId: "account-a",
  jobId: "job-a",
  itemId: "item-a",
  planId: "plan-a",
  visualGroupKey: "group-a",
  slotKey: `slot-${assetId}`,
  role,
  publishedUrl: url,
  contentHash: "a".repeat(64),
  width: 1200,
  height: 1600,
  publicationVersion: "listing-media-v1",
  ...overrides,
});

const binding = (factId, field, value) => ({
  sourceFactId: factId,
  field,
  value,
  numericValue: null,
  unit: null,
});

const fixture = () => ({
  richContent: {
    version: "AUTO_LISTING_RICH_CONTENT_V1",
    language: "ru",
    blocks: [
      { type: "HERO_IMAGE", assetId: "asset-main" },
      {
        type: "HEADING",
        text: "Удобная бутылка",
        sourceFactIds: ["fact-title"],
        factBindings: [binding("fact-title", "identity.name", "Бутылка")],
      },
      {
        type: "IMAGE_TEXT",
        assetId: "asset-detail",
        text: "Корпус из стали",
        sourceFactIds: ["fact-material"],
        factBindings: [binding("fact-material", "attributes.material", "Сталь")],
      },
      {
        type: "TEXT",
        text: "Подходит для ежедневного использования",
        sourceFactIds: ["fact-use"],
        factBindings: [binding("fact-use", "attributes.use", "Ежедневное использование")],
      },
    ],
  },
  publishedAssets: [
    publishedAsset("asset-main", "MAIN", "https://listing.example.test/main.webp"),
    publishedAsset("asset-detail", "DETAIL", "https://listing.example.test/detail.webp", { contentHash: "b".repeat(64) }),
  ],
  scope: { accountId: "account-a", jobId: "job-a", itemId: "item-a", planId: "plan-a", visualGroupKey: "group-a" },
  publicationPolicy: { origin: "https://listing.example.test" },
});

test("releases only the current Ozon rich-content adapter after real acceptance", () => {
  assert.equal(isVerifiedAutoListingOzonRichContentVersion(AUTO_LISTING_OZON_RICH_CONTENT_VERSION), true);
  assert.equal(isVerifiedAutoListingOzonRichContentVersion("AUTO_LISTING_OZON_RICH_CONTENT_V1"), false);
});

test("converts accepted Russian blocks in source order to the official Ozon 0.3 envelope", () => {
  const input = fixture();
  const first = convertAutoListingRichContentToOzon(input);
  const second = convertAutoListingRichContentToOzon(structuredClone(input));

  assert.deepEqual(first, second);
  assert.equal(first.version, "AUTO_LISTING_OZON_RICH_CONTENT_V2");
  assert.match(first.valueHash, /^[a-f0-9]{64}$/);
  const document = JSON.parse(first.value);
  assert.equal(document.version, 0.3);
  assert.equal(document.content.length, 4);
  assert.deepEqual(document.content[0], {
    widgetName: "raShowcase", type: "billboard",
    blocks: [{ img: {
      src: "https://listing.example.test/main.webp",
      srcMobile: "https://listing.example.test/main.webp",
    } }],
  });
  assert.deepEqual(document.content[1], {
    widgetName: "raTextBlock", title: { content: ["Удобная бутылка"] },
  });
  assert.deepEqual(document.content[2], {
    widgetName: "raShowcase", type: "billboard",
    blocks: [{
      img: {
        src: "https://listing.example.test/detail.webp",
        srcMobile: "https://listing.example.test/detail.webp",
      },
      title: { content: ["Корпус из стали"] },
    }],
  });
  assert.deepEqual(document.content[3], {
    widgetName: "raTextBlock", text: { content: ["Подходит для ежедневного использования"] },
  });
  assert.equal(first.value, JSON.stringify(document));
  assert.equal(normalizerTestExports.normalizeRichContentValue(first.value), first.value);
  assert.equal(Object.isFrozen(first), true);
});

test("rejects unknown blocks, extra patch-like keys, non-Russian documents, and missing asset mappings", () => {
  const mutations = [
    (value) => { value.richContent.blocks[1].type = "HTML"; },
    (value) => { value.richContent.blocks[1].style = "position:fixed"; },
    (value) => { value.richContent.language = "en"; },
    (value) => { value.richContent.blocks[0].assetId = "asset-private"; },
    (value) => { value.richContent.blocks[2].sourceFactIds = []; },
    (value) => { value.richContent.blocks[2].factBindings = []; },
    (value) => { value.patch = { attributes: [] }; },
    (value) => { value.publishedAssets[0].planId = "plan-b"; },
    (value) => { value.publishedAssets[0].visualGroupKey = "group-b"; },
  ];
  for (const mutate of mutations) {
    const value = fixture();
    mutate(value);
    assert.throws(
      () => convertAutoListingRichContentToOzon(value),
      (error) => error?.code === "AUTO_LISTING_OZON_RICH_CONTENT_INVALID",
    );
  }
});

test("binds every URL to the injected production publication origin", () => {
  for (const origin of [
    "http://listing.example.test", "https://localhost", "https://127.0.0.1",
    "https://[::1]", "https://listing.example.test/path", "https://user:pass@listing.example.test",
  ]) {
    const value = fixture();
    value.publicationPolicy.origin = origin;
    assert.throws(() => convertAutoListingRichContentToOzon(value), (error) => error?.code === "AUTO_LISTING_OZON_RICH_CONTENT_INVALID");
  }
  const crossOrigin = fixture();
  crossOrigin.publishedAssets[0].publishedUrl = "https://other.example.test/main.webp";
  assert.throws(() => convertAutoListingRichContentToOzon(crossOrigin), (error) => error?.code === "AUTO_LISTING_OZON_RICH_CONTENT_INVALID");
});

test("rejects private, temporary, credential-bearing, non-HTTPS, duplicate, and unaccepted publication evidence", () => {
  const invalidAssets = [
    publishedAsset("asset-main", "MAIN", "/auto-listing/items/item-a/assets/asset-main"),
    publishedAsset("asset-main", "MAIN", "http://listing.example.test/main.webp"),
    publishedAsset("asset-main", "MAIN", "https://user:secret@listing.example.test/main.webp"),
    publishedAsset("asset-main", "MAIN", "https://listing.example.test/main.webp?X-Amz-Expires=60"),
    publishedAsset("asset-main", "MAIN", "https://listing.example.test/main.webp?token=short-lived"),
    publishedAsset("asset-main", "MAIN", "https://listing.example.test/main.webp", { status: "GENERATED" }),
    publishedAsset("asset-main", "MAIN", "https://listing.example.test/main.webp", { publicationVersion: "" }),
  ];
  for (const invalid of invalidAssets) {
    const value = fixture();
    value.publishedAssets[0] = invalid;
    assert.throws(
      () => convertAutoListingRichContentToOzon(value),
      (error) => error?.code === "AUTO_LISTING_OZON_RICH_CONTENT_INVALID",
    );
  }
  const duplicate = fixture();
  duplicate.publishedAssets.push({ ...duplicate.publishedAssets[0] });
  assert.throws(
    () => convertAutoListingRichContentToOzon(duplicate),
    (error) => error?.code === "AUTO_LISTING_OZON_RICH_CONTENT_INVALID",
  );
});

test("keeps output within the versioned UTF-8 boundary and rejects oversized text or URLs", () => {
  const maximumBlock = fixture();
  maximumBlock.richContent.blocks[1].text = `Русский ${"а".repeat(4_080)}`;
  assert.ok(Buffer.byteLength(convertAutoListingRichContentToOzon(maximumBlock).value, "utf8") < 256 * 1024);

  const oversizedText = fixture();
  oversizedText.richContent.blocks[1].text = `Русский ${"а".repeat(8_192)}`;
  assert.throws(
    () => convertAutoListingRichContentToOzon(oversizedText),
    (error) => error?.code === "AUTO_LISTING_OZON_RICH_CONTENT_INVALID",
  );

  const oversizedUrl = fixture();
  oversizedUrl.publishedAssets[0].publishedUrl = `https://listing.example.test/${"a".repeat(8_192)}.webp`;
  assert.throws(
    () => convertAutoListingRichContentToOzon(oversizedUrl),
    (error) => error?.code === "AUTO_LISTING_OZON_RICH_CONTENT_INVALID",
  );
});
