import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { createAutoListingListingBasePreparer } from "../auto-listing-listing-base-preparer.mjs";

const canonical = (value) => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
    : value;
const digest = (value) => crypto.createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");

function source() {
  return {
    id: "collect-a",
    collectItemId: "collect-a",
    productDraft: {
      id: "draft-a",
      version: 4,
      dataHash: "1".repeat(64),
      normalizerVersion: "normalizer-v3",
      categoryRuleVersion: "category-v5",
      dictionaryVersion: "dictionary-live",
    },
    collectItem: {
      id: "collect-a",
      listingDraft: {
        variants: [
          { sku: "sku-blue", offer_id: "offer-blue", name: "Blue" },
          { sku: "sku-red", offer_id: "offer-red", name: "Red" },
        ],
      },
    },
  };
}

const normalizedItem = (suffix) => ({
  offer_id: `offer-${suffix}`,
  name: `Product ${suffix}`,
  price: "100.00",
  currency_code: "RUB",
  description_category_id: 17031664,
  type_id: 971001,
  images: [`https://source.example.test/${suffix}.jpg`],
  primary_image: `https://source.example.test/${suffix}.jpg`,
  weight: 386,
  weight_unit: "g",
  depth: 2100,
  width: 80,
  height: 80,
  dimension_unit: "mm",
  attributes: [{ id: 85, complex_id: 0, values: [{ value: "Нет бренда" }] }],
});

function dependencies(overrides = {}) {
  const calls = [];
  return {
    calls,
    loadStoreAccess: async (input) => {
      calls.push(["access", input]);
      return {
        id: "store-a", ownerAccountId: "account-a", clientId: "client-a",
        apiKey: "must-never-be-persisted", currencyCode: "RUB",
      };
    },
    categoryService: {
      async getCategoryTree(input) {
        calls.push(["tree", { ...input, store: { ...input.store, apiKey: "[secret]" } }]);
        return { items: [{ description_category_id: 17031664, type_id: 971001 }] };
      },
      async getCategoryAttributes(input) {
        calls.push(["attributes", { descriptionCategoryId: input.descriptionCategoryId, typeId: input.typeId }]);
        return { items: [{ id: 85 }, { id: 11254 }] };
      },
      async getCategoryAttributeValues() { return { items: [] }; },
    },
    normalizeItems: async (items, context) => {
      calls.push(["normalize", { count: items.length, targetStoreId: context.targetStoreId }]);
      await context.getCategoryTree();
      await context.getCategoryAttributes(17031664, 971001);
      return { items: [normalizedItem("blue"), normalizedItem("red")], warnings: [] };
    },
    ...overrides,
  };
}

test("freezes a complete target-store-normalized template before AI work", async () => {
  const deps = dependencies();
  const prepare = createAutoListingListingBasePreparer(deps);
  const price = { currency: "RUB", blackKopecks: "10000", greenKopecks: "8000" };
  const result = await prepare({
    accountId: "account-a",
    source: source(),
    targetStore: { id: "store-a", ownerAccountId: "account-a" },
    pricingEvidence: price,
  });

  assert.deepEqual(result.productDraft, {
    id: "draft-a", version: 4, dataHash: "1".repeat(64),
  });
  assert.deepEqual(result.pricingEvidence, { ...price, evidenceHash: digest(price) });
  assert.equal(result.richContentAttributeSupported, true);
  assert.deepEqual(result.variants.map(({ sourceVariantId, sourceSku }) => ({ sourceVariantId, sourceSku })), [
    { sourceVariantId: "offer-blue", sourceSku: "sku-blue" },
    { sourceVariantId: "offer-red", sourceSku: "sku-red" },
  ]);
  assert.deepEqual(result.versions, {
    normalizerVersion: "normalizer-v3",
    categoryRuleVersion: "category-v5",
    dictionaryVersion: "dictionary-live",
  });
  assert.doesNotMatch(JSON.stringify(result), /must-never-be-persisted|client-a|apiKey/);
  assert.deepEqual(deps.calls[0], ["access", { accountId: "account-a", targetStoreId: "store-a" }]);
});

test("builds CNY normalized variants and V2 price evidence from the target store", async () => {
  const deps = dependencies({
    loadStoreAccess: async () => ({
      id: "store-a", ownerAccountId: "account-a", clientId: "client-a",
      apiKey: "secret", currencyCode: "CNY",
    }),
    normalizeItems: async (items, context) => {
      await context.getCategoryAttributes(17031664, 971001);
      return {
        items: items.map((_, index) => ({
        ...normalizedItem(index === 0 ? "blue" : "red"), currency_code: "CNY",
        })),
        warnings: [],
      };
    },
  });
  const price = {
    currency: "CNY", currencySource: "TARGET_STORE",
    blackKopecks: "10000", greenKopecks: "8000",
  };
  const result = await createAutoListingListingBasePreparer(deps)({
    accountId: "account-a", source: source(),
    targetStore: { id: "store-a", ownerAccountId: "account-a", currencyCode: "CNY" },
    pricingEvidence: price,
  });
  assert.deepEqual(result.pricingEvidence, { ...price, evidenceHash: digest(price) });
  assert.deepEqual(result.variants.map(({ item }) => item.currency_code), ["CNY", "CNY"]);
});

test("rejects store-access or normalized-item currency mismatches", async () => {
  const price = {
    currency: "CNY", currencySource: "SOURCE", blackKopecks: "10000", greenKopecks: "8000",
  };
  for (const deps of [
    dependencies({ loadStoreAccess: async () => ({
      id: "store-a", ownerAccountId: "account-a", clientId: "client-a", apiKey: "secret", currencyCode: "RUB",
    }) }),
    dependencies({
      loadStoreAccess: async () => ({
        id: "store-a", ownerAccountId: "account-a", clientId: "client-a", apiKey: "secret", currencyCode: "CNY",
      }),
      normalizeItems: async () => ({ items: [normalizedItem("blue"), normalizedItem("red")], warnings: [] }),
    }),
  ]) {
    await assert.rejects(createAutoListingListingBasePreparer(deps)({
      accountId: "account-a", source: source(),
      targetStore: { id: "store-a", ownerAccountId: "account-a", currencyCode: "CNY" },
      pricingEvidence: price,
    }), { code: "AUTO_LISTING_PRICE_EVIDENCE_INVALID" });
  }
});

test("rejects normalization that drops any source variant", async () => {
  const deps = dependencies({
    normalizeItems: async () => ({ items: [normalizedItem("blue")], warnings: ["red failed"] }),
  });
  await assert.rejects(
    createAutoListingListingBasePreparer(deps)({
      accountId: "account-a", source: source(), targetStore: { id: "store-a", ownerAccountId: "account-a" },
      pricingEvidence: { currency: "RUB", blackKopecks: "10000", greenKopecks: "8000" },
    }),
    { code: "AUTO_LISTING_LISTING_BASE_INCOMPLETE" },
  );
});

test("rejects a category that cannot carry Ozon rich content", async () => {
  const deps = dependencies();
  deps.categoryService.getCategoryAttributes = async () => ({ items: [{ id: 85 }] });
  deps.normalizeItems = async (items, context) => {
    await context.getCategoryAttributes(17031664, 971001);
    return { items: [normalizedItem("blue"), normalizedItem("red")], warnings: [] };
  };
  await assert.rejects(
    createAutoListingListingBasePreparer(deps)({
      accountId: "account-a", source: source(), targetStore: { id: "store-a", ownerAccountId: "account-a" },
      pricingEvidence: { currency: "RUB", blackKopecks: "10000", greenKopecks: "8000" },
    }),
    { code: "AUTO_LISTING_RICH_CONTENT_UNSUPPORTED" },
  );
});

test("requires immutable product draft identity and hash", async () => {
  const invalid = source();
  delete invalid.productDraft.dataHash;
  await assert.rejects(
    createAutoListingListingBasePreparer(dependencies())({
      accountId: "account-a", source: invalid, targetStore: { id: "store-a", ownerAccountId: "account-a" },
      pricingEvidence: { currency: "RUB", blackKopecks: "10000", greenKopecks: "8000" },
    }),
    { code: "AUTO_LISTING_PRODUCT_DRAFT_REQUIRED" },
  );
});

test("freezes explicit runtime version fallbacks for legacy drafts with blank version columns", async () => {
  const legacy = source();
  legacy.productDraft.normalizerVersion = "";
  legacy.productDraft.categoryRuleVersion = "";
  legacy.productDraft.dictionaryVersion = "";
  const result = await createAutoListingListingBasePreparer({
    ...dependencies(),
    versions: {
      normalizerVersion: "runtime-normalizer",
      categoryRuleVersion: "runtime-category",
      dictionaryVersion: "runtime-dictionary",
    },
  })({
    accountId: "account-a", source: legacy, targetStore: { id: "store-a", ownerAccountId: "account-a" },
    pricingEvidence: { currency: "RUB", blackKopecks: "10000", greenKopecks: "8000" },
  });
  assert.deepEqual(result.versions, {
    normalizerVersion: "runtime-normalizer",
    categoryRuleVersion: "runtime-category",
    dictionaryVersion: "runtime-dictionary",
  });
});
