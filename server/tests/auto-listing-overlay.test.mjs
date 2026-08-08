import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import {
  buildAutoListingSubmissionDraft,
  freezeAutoListingListingBase,
} from "../auto-listing-overlay.mjs";

const canonical = (value) => Array.isArray(value)
  ? value.map(canonical)
  : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
    : value;
const digest = (value) => crypto.createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");

const item = (suffix) => ({
  offer_id: `offer-${suffix}`,
  sku: `immutable-sku-${suffix}`,
  name: `Товар ${suffix}`,
  price: "100.00",
  old_price: "130.00",
  min_price: "90.00",
  vat: "0.20",
  currency_code: "RUB",
  description_category_id: 17031664,
  type_id: 971001,
  barcode: `46000000000${suffix}`,
  primary_image: `https://source.example.test/${suffix}-main.jpg`,
  images: [`https://source.example.test/${suffix}-main.jpg`, `https://source.example.test/${suffix}-detail.jpg`],
  weight: 386,
  weight_unit: "g",
  depth: 2100,
  width: 80,
  height: 80,
  dimension_unit: "mm",
  product_measurements: { length: 2050, width: 75, height: 75, unit: "mm" },
  attributes: [
    { complex_id: 0, id: 85, values: [{ value: "Нет бренда", dictionary_value_id: 126745801 }] },
    { complex_id: 0, id: 11254, values: [{ value: JSON.stringify({ widgetName: "raShowcase", type: "roll", blocks: [{ title: { content: "Старый текст" } }] }) }] },
    { complex_id: 0, id: 7853, values: [{ value: suffix === "blue" ? "Синий" : "Красный", dictionary_value_id: suffix === "blue" ? 101 : 102 }] },
  ],
  richContent: "old-top-level-rich-content",
  rich_content: "old-top-level-rich-content-alias",
  complex_attributes: [{
    attributes: [
      { complex_id: 7, id: 9001, values: [{ value: "Комплект", dictionary_value_id: 9001001 }] },
      { complex_id: 7, id: 9002, values: [{ value: `relation-${suffix}` }] },
    ],
  }],
  video: [`https://video.example.test/${suffix}.mp4`],
  video_names: [`Видео ${suffix}`],
  model_info: { model_id: 7755, model_name: "Серия A" },
  variant_relations: { group_id: "family-a", parent_offer_id: "offer-parent", relation: suffix },
  related_skus: [`related-${suffix}`],
  extra_listing_fact: { fragile: true, customs_code: "9617000001" },
});

const wrapper = (suffix) => ({
  sourceVariantId: `variant-${suffix}`,
  sourceSku: `source-sku-${suffix}`,
  item: item(suffix),
});

const freezeInput = (variants = [wrapper("blue")]) => ({
  accountId: "account-a",
  jobId: "job-a",
  itemId: "item-a",
  sourceSnapshotId: "snapshot-a",
  collectItemId: "collect-a",
  targetStoreId: "store-a",
  productDraft: { id: "draft-a", version: 4, dataHash: "1".repeat(64) },
  pricingEvidence: {
    currency: "RUB", blackKopecks: "10000", greenKopecks: "8000",
    evidenceHash: digest({ currency: "RUB", blackKopecks: "10000", greenKopecks: "8000" }),
  },
  richContentAttributeSupported: true,
  variants,
  versions: {
    normalizerVersion: "ozon-import-normalizer-v3",
    categoryRuleVersion: "target-store-category-v5",
    dictionaryVersion: "ozon-dictionary-2026-08-08",
  },
});

const publication = (group, role, index) => ({
  assetId: `${group}-${role.toLowerCase()}-${index}`,
  status: "ACCEPTED",
  accountId: "account-a",
  jobId: "job-a",
  itemId: "item-a",
  planId: "plan-a",
  visualGroupKey: group,
  slotKey: `${group}-slot-${index}`,
  role,
  publishedUrl: `https://listing.example.test/${group}/${role.toLowerCase()}-${index}.webp`,
  contentHash: String((index % 9) + 1).repeat(64),
  width: 1200,
  height: 1600,
  publicationVersion: "listing-media-v1",
});

const groupAssets = (group) => [
  publication(group, "MAIN", 0),
  publication(group, "SELLING_POINT", 1),
  publication(group, "SELLING_POINT", 2),
  publication(group, "DETAIL", 3),
  publication(group, "SCENE", 4),
  publication(group, "INFOGRAPHIC", 5),
];

const frozenConfig = {
  config: {
    targetStoreId: "store-a",
    targetWarehouseId: "warehouse-a",
    stock: 5,
    priceAdjustmentKopecks: "0",
    image: {
      ratio: "3:4", resolution: "1K", quality: "Medium", language: "ru",
      roles: { main: 1, sellingPoint: 2, detail: 1, scene: 1, specification: 0, infographic: 1 },
      total: 6,
    },
  },
};
frozenConfig.configHash = digest(frozenConfig.config);

const richContent = (mainAssetId) => ({
  version: "AUTO_LISTING_RICH_CONTENT_V1",
  language: "ru",
  blocks: [
    { type: "HERO_IMAGE", assetId: mainAssetId },
    {
      type: "HEADING", text: "Удобный товар", sourceFactIds: ["fact-name"],
      factBindings: [{ sourceFactId: "fact-name", field: "identity.name", value: "Товар", numericValue: null, unit: null }],
    },
    {
      type: "TEXT", text: "Подходит для ежедневного использования", sourceFactIds: ["fact-use"],
      factBindings: [{ sourceFactId: "fact-use", field: "attributes.use", value: "Ежедневно", numericValue: null, unit: null }],
    },
  ],
});

const groupContract = (visualGroupKey, variantIds, assets) => ({
  visualGroupKey,
  variantIds,
  slots: assets.map((asset, order) => ({ slotKey: asset.slotKey, role: asset.role, order })),
});

const submissionInput = (base, groups, assets) => {
  const richByGroup = groups.map((group) => {
    const content = richContent(assets.find((asset) => asset.visualGroupKey === group.visualGroupKey && asset.role === "MAIN").assetId);
    return {
      accountId: "account-a", jobId: "job-a", itemId: "item-a", planId: "plan-a",
      visualGroupKey: group.visualGroupKey, status: "ACCEPTED", content, outputHash: digest(content),
    };
  });
  return {
    listingBase: base,
    visualGroups: { accountId: "account-a", jobId: "job-a", itemId: "item-a", planId: "plan-a", groups },
    acceptedAssets: assets,
    acceptedRichContent: richByGroup,
    frozenConfig: structuredClone(frozenConfig),
    targetWarehousePlatformId: "platform-warehouse-a",
    publicationPolicy: { origin: "https://listing.example.test" },
  };
};

function nonAiFacts(value) {
  const copy = structuredClone(value);
  delete copy.images;
  delete copy.primary_image;
  delete copy.price;
  delete copy.richContent;
  delete copy.rich_content;
  copy.attributes = copy.attributes.filter((attribute) => Number(attribute.id) !== 11254);
  return copy;
}

test("freezes a complete normalized single-variant base and overlays only generated content, price, destination, and stock", () => {
  const raw = freezeInput();
  const rawBefore = structuredClone(raw);
  const base = freezeAutoListingListingBase(raw);
  assert.deepEqual(raw, rawBefore);
  assert.equal(Object.isFrozen(base), true);
  assert.equal(Object.isFrozen(base.variants[0].item.attributes[0].values[0]), true);
  assert.match(base.canonicalHash, /^[a-f0-9]{64}$/);

  const assets = groupAssets("group-a");
  const draft = buildAutoListingSubmissionDraft(submissionInput(base, [
    groupContract("group-a", ["variant-blue"], assets),
  ], assets));

  assert.equal(draft.targetStoreId, "store-a");
  assert.equal(draft.targetWarehouseId, "warehouse-a");
  assert.equal(draft.targetWarehousePlatformId, "platform-warehouse-a");
  assert.deepEqual(draft.stocks, [{ offer_id: "offer-blue", warehouse_id: "platform-warehouse-a", stock: 5 }]);
  assert.deepEqual(draft.items[0].images, assets.map((asset) => asset.publishedUrl));
  assert.equal(draft.items[0].primary_image, assets[0].publishedUrl);
  assert.equal(draft.items[0].price, "145.00");
  const rich = draft.items[0].attributes.find((attribute) => Number(attribute.id) === 11254);
  assert.equal(JSON.parse(rich.values[0].value).widgetName, "raShowcase");
  assert.equal(draft.items[0].richContent, rich.values[0].value);
  assert.equal(draft.items[0].rich_content, rich.values[0].value);
  assert.equal(draft.versions.richContentRuleVersion, "AUTO_LISTING_OZON_RICH_CONTENT_V1_UNVERIFIED");
  assert.match(draft.resultHash, /^[a-f0-9]{64}$/);
  assert.equal(digest(nonAiFacts(draft.items[0])), digest(nonAiFacts(base.variants[0].item)));
  assert.equal(JSON.stringify(nonAiFacts(draft.items[0])), JSON.stringify(nonAiFacts(base.variants[0].item)));
  assert.equal(base.variants[0].item.price, "100.00");
  assert.deepEqual(base.variants[0].item.images, rawBefore.variants[0].item.images);
});

test("keeps every multi-variant fact byte-identical while sharing size-only groups and separating visual groups", () => {
  const base = freezeAutoListingListingBase(freezeInput([
    wrapper("blue"), wrapper("blue-xl"), wrapper("red"),
  ]));
  const assetsA = groupAssets("group-blue");
  const assetsB = groupAssets("group-red").map((asset, index) => ({ ...asset, contentHash: String(9 - index).repeat(64) }));
  const draft = buildAutoListingSubmissionDraft(submissionInput(base, [
    groupContract("group-blue", ["variant-blue", "variant-blue-xl"], assetsA),
    groupContract("group-red", ["variant-red"], assetsB),
  ], [...assetsA, ...assetsB]));

  assert.equal(draft.items.length, 3);
  assert.deepEqual(draft.items[0].images, draft.items[1].images, "size-only variants reuse one visual group");
  assert.notDeepEqual(draft.items[0].images, draft.items[2].images, "visually different variants use separate assets");
  assert.deepEqual(draft.stocks, [
    { offer_id: "offer-blue", warehouse_id: "platform-warehouse-a", stock: 5 },
    { offer_id: "offer-blue-xl", warehouse_id: "platform-warehouse-a", stock: 5 },
    { offer_id: "offer-red", warehouse_id: "platform-warehouse-a", stock: 5 },
  ]);
  for (let index = 0; index < base.variants.length; index += 1) {
    assert.equal(digest(nonAiFacts(draft.items[index])), digest(nonAiFacts(base.variants[index].item)), `variant ${index}`);
    assert.equal(JSON.stringify(nonAiFacts(draft.items[index])), JSON.stringify(nonAiFacts(base.variants[index].item)), `variant bytes ${index}`);
    assert.equal(draft.items[index].offer_id, base.variants[index].item.offer_id);
    assert.equal(draft.items[index].description_category_id, base.variants[index].item.description_category_id);
    assert.equal(draft.items[index].type_id, base.variants[index].item.type_id);
  }
});

test("rejects compact snapshots, duplicate identities, unsafe JSON, missing Ozon-ready facts, and mutated frozen evidence", () => {
  const invalidInputs = [
    { ...freezeInput(), variants: [{ sku: "compact", title: "not a normalized item" }] },
    { ...freezeInput(), variants: [wrapper("blue"), wrapper("blue")] },
    { ...freezeInput(), variants: [{ ...wrapper("blue"), item: { ...item("blue"), offer_id: "" } }] },
    { ...freezeInput(), variants: [{ ...wrapper("blue"), item: { ...item("blue"), attributes: null } }] },
    { ...freezeInput(), variants: [{ ...wrapper("blue"), item: { ...item("blue"), weight: Number.NaN } }] },
  ];
  for (const value of invalidInputs) {
    assert.throws(
      () => freezeAutoListingListingBase(value),
      (error) => error?.code === "AUTO_LISTING_LISTING_BASE_INVALID",
    );
  }
  const base = structuredClone(freezeAutoListingListingBase(freezeInput()));
  base.variants[0].item.weight = 999;
  assert.throws(
    () => {
      const assets = groupAssets("group-a");
      return buildAutoListingSubmissionDraft(submissionInput(base, [groupContract("group-a", ["variant-blue"], assets)], assets));
    },
    (error) => error?.code === "AUTO_LISTING_LISTING_BASE_INVALID",
  );
});

test("rejects arbitrary patches and every forbidden caller override before producing a draft", () => {
  const base = freezeAutoListingListingBase(freezeInput());
  const assets = groupAssets("group-a");
  const valid = submissionInput(base, [groupContract("group-a", ["variant-blue"], assets)], assets);
  const forbidden = [
    ["patch", { sku: "evil" }], ["sku", "evil"], ["offer_id", "evil"], ["category_id", 1],
    ["description_category_id", 1], ["attributes", []], ["weight", 1], ["depth", 1],
    ["width", 1], ["height", 1], ["variants", []], ["storeCredentials", { apiKey: "secret" }],
    ["modelOutput", { arbitrary: true }],
  ];
  for (const [key, value] of forbidden) {
    assert.throws(
      () => buildAutoListingSubmissionDraft({ ...valid, [key]: value }),
      (error) => error?.code === "AUTO_LISTING_OVERLAY_INVALID",
      key,
    );
  }
});

test("rejects incomplete group mappings, private or unaccepted assets, missing MAIN, fewer than six images, and price/config tampering", () => {
  const base = freezeAutoListingListingBase(freezeInput([wrapper("blue"), wrapper("red")]));
  const assets = groupAssets("group-a");
  const valid = submissionInput(base, [groupContract("group-a", ["variant-blue", "variant-red"], assets)], assets);
  const mutations = [
    (value) => { value.visualGroups.groups[0].variantIds = ["variant-blue"]; },
    (value) => { value.visualGroups.groups.push(groupContract("group-b", ["variant-blue"], value.acceptedAssets)); },
    (value) => { value.acceptedAssets[0].status = "GENERATED"; },
    (value) => { value.acceptedAssets[0].publishedUrl = "/private/image"; },
    (value) => { value.acceptedAssets.splice(5, 1); },
    (value) => { value.acceptedAssets[0].role = "DETAIL"; },
    (value) => { value.frozenConfig.config.stock = 99; },
    (value) => { value.acceptedRichContent[0].outputHash = "f".repeat(64); },
  ];
  for (const mutate of mutations) {
    const value = structuredClone(valid);
    mutate(value);
    assert.throws(
      () => buildAutoListingSubmissionDraft(value),
      (error) => ["AUTO_LISTING_OVERLAY_INVALID", "AUTO_LISTING_OZON_RICH_CONTENT_INVALID"].includes(error?.code),
    );
  }
});

test("derives price only from frozen source pricing evidence plus the frozen adjustment", () => {
  const base = freezeAutoListingListingBase(freezeInput());
  const assets = groupAssets("group-a");
  const groups = [groupContract("group-a", ["variant-blue"], assets)];
  const input = submissionInput(base, groups, assets);
  input.frozenConfig.config.priceAdjustmentKopecks = "100";
  input.frozenConfig.configHash = digest(input.frozenConfig.config);
  const draft = buildAutoListingSubmissionDraft(input);
  assert.equal(draft.items[0].price, "146.00");
  assert.throws(
    () => buildAutoListingSubmissionDraft({ ...input, calculatedPrice: { currency: "RUB", finalPriceKopecks: "1" } }),
    (error) => error?.code === "AUTO_LISTING_OVERLAY_INVALID",
  );

  const forgedEvidence = freezeInput();
  forgedEvidence.pricingEvidence.blackKopecks = "9999";
  assert.throws(() => freezeAutoListingListingBase(forgedEvidence), (error) => error?.code === "AUTO_LISTING_LISTING_BASE_INVALID");
  const unbounded = freezeInput();
  unbounded.pricingEvidence.blackKopecks = "9".repeat(31);
  unbounded.pricingEvidence.evidenceHash = digest({
    currency: "RUB", blackKopecks: unbounded.pricingEvidence.blackKopecks, greenKopecks: "8000",
  });
  assert.throws(() => freezeAutoListingListingBase(unbounded), (error) => error?.code === "AUTO_LISTING_LISTING_BASE_INVALID");
});

test("binds target store, plan scope, visual groups, assets, and group-local rich content", () => {
  const base = freezeAutoListingListingBase(freezeInput([wrapper("blue"), wrapper("red")]));
  const blue = groupAssets("group-blue");
  const red = groupAssets("group-red");
  const groups = [
    groupContract("group-blue", ["variant-blue"], blue),
    groupContract("group-red", ["variant-red"], red),
  ];
  const valid = submissionInput(base, groups, [...blue, ...red]);
  const mutations = [
    (value) => { value.frozenConfig.config.targetStoreId = "store-b"; value.frozenConfig.configHash = digest(value.frozenConfig.config); },
    (value) => { value.visualGroups.accountId = "account-b"; },
    (value) => { value.visualGroups.planId = "plan-b"; },
    (value) => { value.acceptedAssets[0].jobId = "job-b"; },
    (value) => { value.acceptedAssets[0].planId = "plan-b"; },
    (value) => { value.acceptedRichContent[0].itemId = "item-b"; },
    (value) => { value.acceptedRichContent.pop(); },
    (value) => { value.acceptedRichContent[1].content.blocks[0].assetId = blue[0].assetId; value.acceptedRichContent[1].outputHash = digest(value.acceptedRichContent[1].content); },
  ];
  for (const mutate of mutations) {
    const value = structuredClone(valid); mutate(value);
    assert.throws(() => buildAutoListingSubmissionDraft(value), (error) => [
      "AUTO_LISTING_OVERLAY_INVALID", "AUTO_LISTING_OZON_RICH_CONTENT_INVALID",
    ].includes(error?.code));
  }
});

test("requires exact configured role counts and one accepted asset for every verified slot in stable slot order", () => {
  const base = freezeAutoListingListingBase(freezeInput());
  const assets = groupAssets("group-a").reverse();
  const group = groupContract("group-a", ["variant-blue"], groupAssets("group-a"));
  const valid = submissionInput(base, [group], assets);
  const draft = buildAutoListingSubmissionDraft(valid);
  assert.deepEqual(draft.items[0].images, group.slots.map((slot) =>
    groupAssets("group-a").find((asset) => asset.slotKey === slot.slotKey).publishedUrl));

  for (const mutate of [
    (value) => { value.visualGroups.groups[0].slots[1].slotKey = value.visualGroups.groups[0].slots[0].slotKey; },
    (value) => { value.visualGroups.groups[0].slots[1].order = value.visualGroups.groups[0].slots[0].order; },
    (value) => { value.acceptedAssets[1].slotKey = value.acceptedAssets[0].slotKey; },
    (value) => { value.acceptedAssets[1].role = "DETAIL"; },
    (value) => { value.frozenConfig.config.image.roles.sellingPoint = 3; value.frozenConfig.config.image.total = 7; value.frozenConfig.configHash = digest(value.frozenConfig.config); },
  ]) {
    const value = structuredClone(valid); mutate(value);
    assert.throws(() => buildAutoListingSubmissionDraft(value), (error) => error?.code === "AUTO_LISTING_OVERLAY_INVALID");
  }
});

test("records unsupported category rich-content capability but blocks upload without attribute 11254 support", () => {
  const source = freezeInput();
  source.richContentAttributeSupported = false;
  const base = freezeAutoListingListingBase(source);
  const assets = groupAssets("group-a");
  assert.throws(
    () => buildAutoListingSubmissionDraft(submissionInput(base, [groupContract("group-a", ["variant-blue"], assets)], assets)),
    (error) => error?.code === "AUTO_LISTING_OVERLAY_INVALID",
  );
});
