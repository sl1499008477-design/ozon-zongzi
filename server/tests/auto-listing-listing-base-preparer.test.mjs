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
  description_category_id: 789,
  type_id: 999,
  images: [`https://source.example.test/${suffix}.jpg`],
  primary_image: `https://source.example.test/${suffix}.jpg`,
  weight: 386,
  weight_unit: "g",
  depth: 2100,
  width: 80,
  height: 80,
  dimension_unit: "mm",
  attributes: [{
    id: 85,
    complex_id: 0,
    values: [{ value: "Нет бренда", dictionary_value_id: 126745801 }],
  }],
});

const frozenTargetCategory = (provenance = "MANUAL") => ({
  schemaVersion: "AUTO_LISTING_ACCOUNT_CATEGORY_V2",
  evidenceId: "evidence-a",
  sharedCategoryId: "shared-a",
  sharedCategoryVersion: 7,
  sourceDescriptionCategoryId: 123,
  sourceTypeId: 456,
  descriptionCategoryId: 789,
  typeId: 999,
  taxonomyScope: "OZON:DEFAULT",
  taxonomyFingerprint: "",
  provenance,
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
        return { items: [{ id: 85, dictionary_id: 7, is_required: true }, { id: 11254 }] };
      },
      async getCategoryAttributeValues() {
        return { items: [{ id: 126745801, value: "Нет бренда" }] };
      },
    },
    normalizeItems: async (items, context) => {
      calls.push(["normalize", { count: items.length, targetStoreId: context.targetStoreId }]);
      await context.getCategoryAttributes(789, 999);
      return { items: [normalizedItem("blue"), normalizedItem("red")], warnings: [] };
    },
    ...overrides,
  };
}

test("freezes a complete target-store-normalized template before AI work", async () => {
  const deps = dependencies();
  const prepare = createAutoListingListingBasePreparer(deps);
  const price = { currency: "RUB", blackKopecks: "10000", greenKopecks: "8000" };
  const sourceInput = source();
  const sourceBefore = structuredClone(sourceInput);
  const result = await prepare({
    accountId: "account-a",
    source: sourceInput,
    targetStore: { id: "store-a", ownerAccountId: "account-a" },
    targetCategory: frozenTargetCategory(),
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
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.variants), true);
  assert.equal(Object.isFrozen(result.variants[0]), true);
  assert.equal(Object.isFrozen(result.variants[0].item), true);
  assert.equal(Object.isFrozen(result.variants[0].item.attributes), true);
  assert.equal(Object.isFrozen(result.variants[0].item.attributes[0].values), true);
  assert.deepEqual(sourceInput, sourceBefore);
  assert.equal(Object.isFrozen(sourceInput), false);
  assert.equal(Object.isFrozen(sourceInput.collectItem.listingDraft.variants), false);
});

test("forwards the category preparation abort signal to every Ozon category read", async () => {
  const controller = new AbortController();
  const seen = [];
  const deps = dependencies({
    categoryService: {
      async getCategoryAttributes(input) {
        seen.push(input.signal);
        return { items: [{ id: 85, dictionary_id: 7, is_required: true }, { id: 11254 }] };
      },
      async getCategoryAttributeValues(input) {
        seen.push(input.signal);
        return { items: [{ id: 126745801, value: "Нет бренда" }] };
      },
    },
    normalizeItems: async (items, context) => {
      await context.getCategoryAttributes(789, 999);
      await Promise.all([
        context.getCategoryAttributeValues(789, 999, 85),
        context.getCategoryAttributeValues(789, 999, 85),
      ]);
      return { items: items.map((_item, index) => normalizedItem(index ? "red" : "blue")) };
    },
  });
  await createAutoListingListingBasePreparer(deps)({
    accountId: "account-a", source: source(), targetStore: { id: "store-a", ownerAccountId: "account-a" },
    targetCategory: frozenTargetCategory(), signal: controller.signal,
    pricingEvidence: { currency: "RUB", blackKopecks: "10000", greenKopecks: "8000" },
  });
  assert.deepEqual(seen, [controller.signal, controller.signal]);
});

test("snapshots only used or required replacement dictionaries once in exact sorted scope", async () => {
  const itemSource = source();
  itemSource.collectItem.listingDraft.variants = itemSource.collectItem.listingDraft.variants.map((variant) => ({
    ...variant,
    attributes: [{ id: 500, values: [{ value: "input option", dictionary_value_id: 500001 }] }],
  }));
  const dictionaryReads = [];
  const options = new Map([
    [85, { id: 126745801, value: "Нет бренда" }],
    [400, { id: 400001, value: "Required option" }],
    [500, { id: 500001, value: "Used option" }],
  ]);
  const deps = dependencies({
    categoryService: {
      async getCategoryAttributes() {
        return { items: [
          { id: 900, dictionary_id: 90 },
          { id: 500, dictionary_id: 50 },
          { id: 85, dictionary_id: 7, is_required: true },
          { id: 400, dictionary_id: 40, is_required: true },
          { id: 11254 },
        ] };
      },
      async getCategoryAttributeValues(input) {
        dictionaryReads.push({
          descriptionCategoryId: input.descriptionCategoryId,
          typeId: input.typeId,
          attributeId: input.attributeId,
          limit: input.limit,
        });
        return { items: [options.get(input.attributeId)] };
      },
    },
    async normalizeItems(items, context) {
      await context.getCategoryAttributes(789, 999);
      return { items: items.map((item, index) => ({
        ...normalizedItem(index ? "red" : "blue"),
        currency_code: item.currency_code,
        attributes: [
          { id: 500, values: [{ value: "stale label", dictionary_value_id: 500001 }] },
          { id: 85, values: [{ value: "stale label", dictionary_value_id: 126745801 }] },
          { id: 400, values: [{ value: "stale label", dictionary_value_id: 400001 }] },
        ],
      })), warnings: [] };
    },
  });

  await createAutoListingListingBasePreparer(deps)({
    accountId: "account-a", source: itemSource, targetStore: { id: "store-a", ownerAccountId: "account-a" },
    targetCategory: frozenTargetCategory(),
    pricingEvidence: { currency: "RUB", blackKopecks: "10000", greenKopecks: "8000" },
  });

  assert.deepEqual(dictionaryReads, [85, 400, 500].map((attributeId) => ({
    descriptionCategoryId: 789,
    typeId: 999,
    attributeId,
    limit: 5_000,
  })));
});

test("sorts real strict-normalizer dictionary reads instead of letting input attribute order drive network", async () => {
  const itemSource = source();
  const orderedAttributes = [
    { id: 500, values: [{ value: "stale", dictionary_value_id: 500001 }] },
    { id: 85, values: [{ value: "stale", dictionary_value_id: 126745801 }] },
    { id: 400, values: [{ value: "stale", dictionary_value_id: 400001 }] },
  ];
  itemSource.collectItem.listingDraft.variants = itemSource.collectItem.listingDraft.variants.map((variant) => ({
    ...variant,
    price: "100.00",
    currency_code: "RUB",
    images: ["https://source.example.test/strict.jpg"],
    attributes: orderedAttributes,
  }));
  const dictionaryReads = [];
  const values = new Map([
    [85, { id: 126745801, value: "Нет бренда" }],
    [400, { id: 400001, value: "Required" }],
    [500, { id: 500001, value: "Used" }],
  ]);
  const deps = dependencies({
    categoryService: {
      async getCategoryAttributes() {
        return { items: [
          { id: 900, dictionary_id: 90 },
          { id: 500, dictionary_id: 50 },
          { id: 85, dictionary_id: 7, is_required: true },
          { id: 400, dictionary_id: 40, is_required: true },
          { id: 11254 },
        ] };
      },
      async getCategoryAttributeValues(input) {
        dictionaryReads.push(input.attributeId);
        return { items: [values.get(input.attributeId)] };
      },
    },
  });
  delete deps.normalizeItems;
  await createAutoListingListingBasePreparer(deps)({
    accountId: "account-a", source: itemSource, targetStore: { id: "store-a", ownerAccountId: "account-a" },
    targetCategory: frozenTargetCategory(),
    pricingEvidence: { currency: "RUB", blackKopecks: "10000", greenKopecks: "8000" },
  });
  assert.deepEqual(dictionaryReads, [85, 400, 500]);
});

test("resolves legacy source category dictionary text by an exact current Ozon option", async () => {
  const itemSource = source();
  itemSource.collectItem.listingDraft.sourceCategory = {
    attributes: [
      { key: "8229", value: "Source type", dictionary_value_id: 94453 },
      { key: "85", value: "MQOUO" },
      { key: "4195", value: null },
    ],
  };
  const reads = [];
  const deps = dependencies({
    categoryService: {
      async getCategoryAttributes() {
        return { items: [
          { id: 8229, dictionary_id: 1960, is_required: true },
          { id: 85, dictionary_id: 28732849, is_required: true },
          { id: 9048, dictionary_id: 0, is_required: true },
          { id: 11254, dictionary_id: 0 },
        ] };
      },
      async getCategoryAttributeValues(input) {
        reads.push({ attributeId: input.attributeId, matchCandidates: input.matchCandidates });
        if (input.attributeId === 8229) return { items: [{ id: 94453, value: "Target type" }] };
        if (input.attributeId === 85) return { items: [{ id: 972053798, value: "MQOUO" }] };
        return { items: [] };
      },
    },
  });
  delete deps.normalizeItems;
  const result = await createAutoListingListingBasePreparer(deps)({
    accountId: "account-a",
    source: itemSource,
    targetStore: { id: "store-a", ownerAccountId: "account-a" },
    targetCategory: frozenTargetCategory(),
    pricingEvidence: { currency: "RUB", blackKopecks: "10000", greenKopecks: "8000" },
  });
  assert.deepEqual(reads, [
    { attributeId: 85, matchCandidates: [{ value: "MQOUO" }] },
    { attributeId: 8229, matchCandidates: [{ id: 94453, value: "Source type" }] },
  ]);
  assert.deepEqual(result.variants.map((variant) =>
    variant.item.attributes.find((attribute) => attribute.id === 85)?.values), [
    [{ value: "MQOUO", dictionary_value_id: 972053798 }],
    [{ value: "MQOUO", dictionary_value_id: 972053798 }],
  ]);
});

test("normalizes category dictionary read failures without leaking the upstream error", async () => {
  const deps = dependencies();
  let dictionaryReadCount = 0;
  deps.categoryService.getCategoryAttributeValues = async () => {
    dictionaryReadCount += 1;
    throw new Error("credential-secret from upstream");
  };
  await assert.rejects(createAutoListingListingBasePreparer(deps)({
    accountId: "account-a", source: source(), targetStore: { id: "store-a", ownerAccountId: "account-a" },
    targetCategory: frozenTargetCategory(),
    pricingEvidence: { currency: "RUB", blackKopecks: "10000", greenKopecks: "8000" },
  }), (error) => error?.code === "AUTO_LISTING_CATEGORY_DICTIONARY_UNRESOLVED"
    && error.status === 422 && error.retryable === false && error.cause === null
    && !error.message.includes("secret") && !JSON.stringify(error).includes("secret"));
  assert.equal(dictionaryReadCount, 1);

  let getterReads = 0;
  const hostileResult = {};
  Object.defineProperty(hostileResult, "items", {
    enumerable: true,
    get() { getterReads += 1; throw new Error("credential-secret dictionary getter"); },
  });
  const hostileDeps = dependencies();
  hostileDeps.categoryService.getCategoryAttributeValues = async () => hostileResult;
  await assert.rejects(createAutoListingListingBasePreparer(hostileDeps)({
    accountId: "account-a", source: source(), targetStore: { id: "store-a", ownerAccountId: "account-a" },
    targetCategory: frozenTargetCategory(),
    pricingEvidence: { currency: "RUB", blackKopecks: "10000", greenKopecks: "8000" },
  }), (error) => error?.code === "AUTO_LISTING_CATEGORY_DICTIONARY_UNRESOLVED"
    && error.cause === null && !error.message.includes("secret"));
  assert.equal(getterReads, 1);
});

test("normalizes category attribute read failures before dictionary or later write boundaries", async () => {
  let dictionaryReads = 0;
  let normalizedReturns = 0;
  const deps = dependencies({
    categoryService: {
      async getCategoryAttributes() { throw new Error("credential-secret attribute failure"); },
      async getCategoryAttributeValues() { dictionaryReads += 1; return { items: [] }; },
    },
    async normalizeItems(items, context) {
      await context.getCategoryAttributes(789, 999);
      normalizedReturns += 1;
      return { items };
    },
  });
  await assert.rejects(createAutoListingListingBasePreparer(deps)({
    accountId: "account-a", source: source(), targetStore: { id: "store-a", ownerAccountId: "account-a" },
    targetCategory: frozenTargetCategory(),
    pricingEvidence: { currency: "RUB", blackKopecks: "10000", greenKopecks: "8000" },
  }), (error) => error?.code === "AUTO_LISTING_CATEGORY_ATTRIBUTES_INCOMPLETE"
    && error.status === 422 && error.retryable === false && error.cause === null
    && !error.message.includes("secret") && !JSON.stringify(error).includes("secret"));
  assert.equal(dictionaryReads, 0);
  assert.equal(normalizedReturns, 0);

  let getterReads = 0;
  const hostileResult = {};
  Object.defineProperty(hostileResult, "items", {
    enumerable: true,
    get() { getterReads += 1; throw new Error("credential-secret getter"); },
  });
  const hostileDeps = dependencies();
  hostileDeps.categoryService.getCategoryAttributes = async () => hostileResult;
  await assert.rejects(createAutoListingListingBasePreparer(hostileDeps)({
    accountId: "account-a", source: source(), targetStore: { id: "store-a", ownerAccountId: "account-a" },
    targetCategory: frozenTargetCategory(),
    pricingEvidence: { currency: "RUB", blackKopecks: "10000", greenKopecks: "8000" },
  }), (error) => error?.code === "AUTO_LISTING_CATEGORY_ATTRIBUTES_INCOMPLETE"
    && error.cause === null && !error.message.includes("secret"));
  assert.equal(getterReads, 1);
});

test("rejects hostile raw listing evidence before category, dictionary, or normalization boundaries", async (t) => {
  const secret = "source-evidence-secret";
  const baseItem = () => ({
    sku: "sku-hostile",
    offer_id: "offer-hostile",
    _sourceVariant: {
      attributes: [{
        id: 85,
        values: [{ value: "Нет бренда", dictionary_value_id: 126745801 }],
      }],
    },
  });
  const customArray = (values) => {
    const array = [...values];
    Object.setPrototypeOf(array, Object.create(Array.prototype));
    return array;
  };
  const proxyCases = [];
  for (const revoked of [false, true]) {
    const wrap = (value) => {
      if (!revoked) return new Proxy(value, {});
      const pair = Proxy.revocable(value, {});
      pair.revoke();
      return pair.proxy;
    };
    for (const location of ["itemsArray", "item", "sourceVariant", "attributes", "values", "nestedValue"]) {
      proxyCases.push({
        name: `${revoked ? "revoked" : "transparent"} proxy at ${location}`,
        build() {
          const item = baseItem();
          if (location === "itemsArray") return wrap([item]);
          if (location === "item") return [wrap(item)];
          if (location === "sourceVariant") item._sourceVariant = wrap(item._sourceVariant);
          if (location === "attributes") item._sourceVariant.attributes = wrap(item._sourceVariant.attributes);
          if (location === "values") item._sourceVariant.attributes[0].values = wrap(
            item._sourceVariant.attributes[0].values,
          );
          if (location === "nestedValue") item._sourceVariant.attributes[0].values[0] = wrap(
            item._sourceVariant.attributes[0].values[0],
          );
          return [item];
        },
      });
    }
  }

  const hostileCases = [
    {
      name: "accessor descriptor",
      build(mutations) {
        const item = baseItem();
        Object.defineProperty(item._sourceVariant.attributes[0].values[0], "value", {
          enumerable: true,
          get() { mutations.getters += 1; throw new Error(secret); },
          set() { mutations.setters += 1; },
        });
        return [item];
      },
    },
    {
      name: "setter-only descriptor",
      build(mutations) {
        const item = baseItem();
        Object.defineProperty(item._sourceVariant.attributes[0].values[0], "value", {
          enumerable: true,
          set() { mutations.setters += 1; },
        });
        return [item];
      },
    },
    ...proxyCases,
    {
      name: "cycle",
      build() {
        const item = baseItem();
        item._sourceVariant.attributes[0].values[0].cycle = item;
        return [item];
      },
    },
    {
      name: "dangerous key",
      build() {
        const item = baseItem();
        Object.defineProperty(item._sourceVariant, "__proto__", {
          enumerable: true, configurable: true, writable: true, value: { polluted: true },
        });
        return [item];
      },
    },
    {
      name: "custom prototype",
      build() {
        const item = baseItem();
        item._sourceVariant.attributes[0].values[0] = Object.assign(
          Object.create({ inherited: secret }),
          { value: "Нет бренда", dictionary_value_id: 126745801 },
        );
        return [item];
      },
    },
    {
      name: "symbol extra",
      build() {
        const item = baseItem();
        item._sourceVariant.attributes[0][Symbol(secret)] = true;
        return [item];
      },
    },
    {
      name: "attribute key extra",
      build() {
        const item = baseItem();
        item._sourceVariant.attributes[0].unexpected = secret;
        return [item];
      },
    },
    {
      name: "nested value key extra",
      build() {
        const item = baseItem();
        item._sourceVariant.attributes[0].values[0].unexpected = secret;
        return [item];
      },
    },
    {
      name: "array extra",
      build() {
        const item = baseItem();
        item._sourceVariant.attributes.extra = secret;
        return [item];
      },
    },
    {
      name: "custom prototype outer items array",
      build() { return customArray([baseItem()]); },
    },
    {
      name: "custom prototype attributes array",
      build() {
        const item = baseItem();
        item._sourceVariant.attributes = customArray(item._sourceVariant.attributes);
        return [item];
      },
    },
    {
      name: "custom prototype values array",
      build() {
        const item = baseItem();
        item._sourceVariant.attributes[0].values = customArray(item._sourceVariant.attributes[0].values);
        return [item];
      },
    },
    {
      name: "oversized string",
      build() {
        const item = baseItem();
        item._sourceVariant.attributes[0].values[0].value = "x".repeat(2_000_001);
        return [item];
      },
    },
    {
      name: "oversized array",
      build() {
        const item = baseItem();
        item._sourceVariant.attributes[0].values = Array.from({ length: 5_001 }, () => ({ value: "x" }));
        return [item];
      },
    },
    {
      name: "over depth",
      build() {
        const item = baseItem();
        let cursor = item._sourceVariant.attributes[0].values[0];
        for (let index = 0; index < 66; index += 1) {
          cursor.next = {};
          cursor = cursor.next;
        }
        return [item];
      },
    },
    {
      name: "over node limit",
      build() {
        const item = baseItem();
        item._sourceVariant.attributes[0].values[0].padding = Array.from({ length: 5_000 }, () => {
          const root = {};
          let cursor = root;
          for (let index = 0; index < 40; index += 1) {
            cursor.next = {};
            cursor = cursor.next;
          }
          return root;
        });
        return [item];
      },
    },
  ];

  for (const hostileCase of hostileCases) {
    await t.test(hostileCase.name, async () => {
      const calls = { access: 0, build: 0, attributes: 0, dictionary: 0, normalize: 0 };
      const mutations = { getters: 0, setters: 0 };
      const deps = dependencies({
        async loadStoreAccess() {
          calls.access += 1;
          return {
            id: "store-a", ownerAccountId: "account-a", clientId: "client-a",
            apiKey: "must-never-be-persisted", currencyCode: "RUB",
          };
        },
        buildRawItems() {
          calls.build += 1;
          return hostileCase.build(mutations);
        },
        categoryService: {
          async getCategoryAttributes() { calls.attributes += 1; return { items: [] }; },
          async getCategoryAttributeValues() { calls.dictionary += 1; return { items: [] }; },
        },
        async normalizeItems() { calls.normalize += 1; return { items: [] }; },
      });
      let caught;
      try {
        await createAutoListingListingBasePreparer(deps)({
          accountId: "account-a", source: source(),
          targetStore: { id: "store-a", ownerAccountId: "account-a" },
          targetCategory: frozenTargetCategory(),
          pricingEvidence: { currency: "RUB", blackKopecks: "10000", greenKopecks: "8000" },
        });
      } catch (error) {
        caught = error;
      }
      assert.equal(caught?.code, "AUTO_LISTING_CATEGORY_ATTRIBUTES_INCOMPLETE");
      assert.equal(caught?.message, "AUTO_LISTING_CATEGORY_ATTRIBUTES_INCOMPLETE");
      assert.equal(caught?.status, 422);
      assert.equal(caught?.retryable, false);
      assert.equal(caught?.cause, null);
      assert.doesNotMatch(String(caught?.message), /source-evidence-secret/u);
      assert.doesNotMatch(JSON.stringify(caught), /source-evidence-secret/u);
      assert.deepEqual(calls, { access: 0, build: 1, attributes: 0, dictionary: 0, normalize: 0 });
      assert.deepEqual(mutations, { getters: 0, setters: 0 });
    });
  }
});

test("rejects hostile source evidence before invoking even the pure raw-item builder", async () => {
  const itemSource = source();
  let getterReads = 0;
  Object.defineProperty(
    itemSource.collectItem.listingDraft.variants[0],
    "_sourceVariant",
    { enumerable: true, get() { getterReads += 1; throw new Error("source-evidence-secret"); } },
  );
  const calls = { access: 0, build: 0, attributes: 0, dictionary: 0, normalize: 0 };
  const deps = dependencies({
    async loadStoreAccess() { calls.access += 1; throw new Error("must not load credentials"); },
    buildRawItems() { calls.build += 1; return []; },
    categoryService: {
      async getCategoryAttributes() { calls.attributes += 1; return { items: [] }; },
      async getCategoryAttributeValues() { calls.dictionary += 1; return { items: [] }; },
    },
    async normalizeItems() { calls.normalize += 1; return { items: [] }; },
  });
  await assert.rejects(createAutoListingListingBasePreparer(deps)({
    accountId: "account-a", source: itemSource,
    targetStore: { id: "store-a", ownerAccountId: "account-a" },
    targetCategory: frozenTargetCategory(),
    pricingEvidence: { currency: "RUB", blackKopecks: "10000", greenKopecks: "8000" },
  }), (error) => error?.code === "AUTO_LISTING_CATEGORY_ATTRIBUTES_INCOMPLETE"
    && error.message === "AUTO_LISTING_CATEGORY_ATTRIBUTES_INCOMPLETE"
    && error.status === 422 && error.retryable === false && error.cause === null
    && !JSON.stringify(error).includes("source-evidence-secret"));
  assert.equal(getterReads, 0);
  assert.deepEqual(calls, { access: 0, build: 0, attributes: 0, dictionary: 0, normalize: 0 });
});

test("rejects custom-prototype raw source arrays before invoking any dependency", async (t) => {
  const customArray = (values) => {
    const array = [...values];
    Object.setPrototypeOf(array, Object.create(Array.prototype));
    return array;
  };
  for (const location of ["variants", "attributes", "values"]) {
    await t.test(location, async () => {
      const itemSource = source();
      const variants = itemSource.collectItem.listingDraft.variants;
      variants[0]._sourceVariant = {
        attributes: [{ id: 85, values: [{ value: "Нет бренда", dictionary_value_id: 126745801 }] }],
      };
      if (location === "variants") itemSource.collectItem.listingDraft.variants = customArray(variants);
      if (location === "attributes") {
        variants[0]._sourceVariant.attributes = customArray(variants[0]._sourceVariant.attributes);
      }
      if (location === "values") {
        variants[0]._sourceVariant.attributes[0].values = customArray(
          variants[0]._sourceVariant.attributes[0].values,
        );
      }
      const calls = { access: 0, build: 0, attributes: 0, dictionary: 0, normalize: 0 };
      const deps = dependencies({
        async loadStoreAccess() { calls.access += 1; throw new Error("must not load credentials"); },
        buildRawItems() { calls.build += 1; return []; },
        categoryService: {
          async getCategoryAttributes() { calls.attributes += 1; return { items: [] }; },
          async getCategoryAttributeValues() { calls.dictionary += 1; return { items: [] }; },
        },
        async normalizeItems() { calls.normalize += 1; return { items: [] }; },
      });
      await assert.rejects(createAutoListingListingBasePreparer(deps)({
        accountId: "account-a", source: itemSource,
        targetStore: { id: "store-a", ownerAccountId: "account-a" },
        targetCategory: frozenTargetCategory(),
        pricingEvidence: { currency: "RUB", blackKopecks: "10000", greenKopecks: "8000" },
      }), (error) => error?.code === "AUTO_LISTING_CATEGORY_ATTRIBUTES_INCOMPLETE"
        && error.message === "AUTO_LISTING_CATEGORY_ATTRIBUTES_INCOMPLETE"
        && error.cause === null && !JSON.stringify(error).includes("secret"));
      assert.deepEqual(calls, { access: 0, build: 0, attributes: 0, dictionary: 0, normalize: 0 });
    });
  }
});

test("uses immutable raw source evidence over normalized old upload attributes for the exact variant", async () => {
  const itemSource = source();
  itemSource.collectItem.listingDraft.variants = itemSource.collectItem.listingDraft.variants.map((variant) => ({
    ...variant,
    _sourceVariant: {
      attributes: [{ id: 200, values: [{ value: `SOURCE ${variant.offer_id}` }] }],
    },
  }));
  const deps = dependencies({
    categoryService: {
      async getCategoryAttributes() { return { items: [{ id: 200, is_required: true }, { id: 11254 }] }; },
      async getCategoryAttributeValues() { assert.fail("non-dictionary evidence must not read values"); },
    },
    async normalizeItems(items, context) {
      await context.getCategoryAttributes(789, 999);
      return { items: items.map((item) => ({
        ...normalizedItem(item.offer_id.endsWith("red") ? "red" : "blue"),
        offer_id: item.offer_id,
        currency_code: item.currency_code,
        attributes: [{ id: 200, values: [{ value: `OLD ${item.offer_id}` }] }],
      })), warnings: [] };
    },
  });
  const result = await createAutoListingListingBasePreparer(deps)({
    accountId: "account-a", source: itemSource, targetStore: { id: "store-a", ownerAccountId: "account-a" },
    targetCategory: frozenTargetCategory(),
    pricingEvidence: { currency: "RUB", blackKopecks: "10000", greenKopecks: "8000" },
  });
  assert.deepEqual(result.variants.map(({ item }) => item.attributes[0].values[0].value), [
    "SOURCE offer-blue",
    "SOURCE offer-red",
  ]);
});

test("rejects normalized variants whose offer order no longer matches immutable source evidence", async () => {
  const deps = dependencies({
    async normalizeItems(items, context) {
      await context.getCategoryAttributes(789, 999);
      return { items: items.toReversed().map((item) => ({
        ...normalizedItem(item.offer_id.endsWith("red") ? "red" : "blue"),
        offer_id: item.offer_id,
        currency_code: item.currency_code,
      })), warnings: [] };
    },
  });
  await assert.rejects(createAutoListingListingBasePreparer(deps)({
    accountId: "account-a", source: source(), targetStore: { id: "store-a", ownerAccountId: "account-a" },
    targetCategory: frozenTargetCategory(),
    pricingEvidence: { currency: "RUB", blackKopecks: "10000", greenKopecks: "8000" },
  }), { code: "AUTO_LISTING_SOURCE_CATEGORY_REQUIRED" });

  const duplicateSource = source();
  duplicateSource.collectItem.listingDraft.variants[1].offer_id = "offer-blue";
  const duplicateDeps = dependencies({
    async normalizeItems(items, context) {
      await context.getCategoryAttributes(789, 999);
      return { items: items.map((item, index) => ({
        ...normalizedItem(index ? "red" : "blue"),
        offer_id: item.offer_id,
        currency_code: item.currency_code,
      })) };
    },
  });
  await assert.rejects(createAutoListingListingBasePreparer(duplicateDeps)({
    accountId: "account-a", source: duplicateSource,
    targetStore: { id: "store-a", ownerAccountId: "account-a" },
    targetCategory: frozenTargetCategory(),
    pricingEvidence: { currency: "RUB", blackKopecks: "10000", greenKopecks: "8000" },
  }), { code: "AUTO_LISTING_SOURCE_CATEGORY_REQUIRED" });
});

for (const provenance of ["MANUAL", "OZON_REFRESH"]) {
  test(`frozen V2 ${provenance} category overrides source and draft category before Ozon normalization`, async () => {
    const itemSource = source();
    itemSource.collectItem.listingDraft.description_category_id = 123;
    itemSource.collectItem.listingDraft.type_id = 456;
    itemSource.collectItem.listingDraft.variants = itemSource.collectItem.listingDraft.variants.map((variant) => ({
      ...variant, description_category_id: 123, type_id: 456,
    }));
    const observed = { raw: [], attributes: [], values: [], tree: 0 };
    const deps = dependencies({
      categoryService: {
        async getCategoryTree() { observed.tree += 1; throw new Error("category tree is not authority"); },
        async getCategoryAttributes(input) {
          observed.attributes.push([input.descriptionCategoryId, input.typeId]);
          return { items: [{ id: 85, dictionary_id: 7, is_required: true }, { id: 11254 }] };
        },
        async getCategoryAttributeValues(input) {
          observed.values.push([input.descriptionCategoryId, input.typeId]);
          return { items: [{ id: 126745801, value: "Нет бренда" }] };
        },
      },
      async normalizeItems(items, context) {
        observed.raw = structuredClone(items);
        assert.equal(context.categoryMatchPolicy, "SOURCE_CATEGORY_STRICT");
        assert.deepEqual(context.sourceCategory, {
          kind: "UNIQUE_MATCH",
          descriptionCategoryId: 789,
          typeId: 999,
        });
        assert.equal(Object.hasOwn(context, "getCategoryTree"), false);
        assert.equal(Object.hasOwn(context, "targetStoreId"), false);
        await context.getCategoryAttributes(789, 999);
        await context.getCategoryAttributeValues(789, 999, 85);
        return {
          items: items.map((item, index) => ({
            ...normalizedItem(index === 0 ? "blue" : "red"),
            description_category_id: item.description_category_id,
            type_id: item.type_id,
          })),
          warnings: [],
        };
      },
    });
    const result = await createAutoListingListingBasePreparer(deps)({
      accountId: "account-a",
      source: itemSource,
      targetStore: { id: "store-a", ownerAccountId: "account-a" },
      targetCategory: frozenTargetCategory(provenance),
      pricingEvidence: { currency: "RUB", blackKopecks: "10000", greenKopecks: "8000" },
    });

    assert.deepEqual(observed.raw.map((item) => [item.description_category_id, item.type_id]), [[789, 999], [789, 999]]);
    assert.deepEqual(result.variants.map(({ item }) => [item.description_category_id, item.type_id]), [[789, 999], [789, 999]]);
    assert.deepEqual(observed.attributes, [[789, 999]]);
    assert.deepEqual(observed.values, [[789, 999]]);
    assert.equal(observed.tree, 0);
  });
}

test("the same account keeps category shared while two stores retain separate credentials and currencies", async () => {
  const categoryReads = [];
  const deps = dependencies({
    async loadStoreAccess({ accountId, targetStoreId }) {
      return { id: targetStoreId, ownerAccountId: accountId, clientId: `client-${targetStoreId}`,
        apiKey: `credential-${targetStoreId}`, currencyCode: targetStoreId === "store-a" ? "RUB" : "CNY" };
    },
    categoryService: {
      async getCategoryAttributes(input) {
        categoryReads.push({
          storeId: input.store.id,
          clientId: input.store.clientId,
          credential: input.store.apiKey,
          category: [input.descriptionCategoryId, input.typeId],
        });
        return { items: [{ id: 85 }, { id: 11254 }] };
      },
      async getCategoryAttributeValues() { return { items: [] }; },
    },
    async normalizeItems(items, context) {
      assert.equal(context.categoryMatchPolicy, "SOURCE_CATEGORY_STRICT");
      assert.equal(Object.hasOwn(context, "targetStoreId"), false);
      await context.getCategoryAttributes(789, 999);
      return { items: items.map((item, index) => ({
        ...normalizedItem(index === 0 ? "blue" : "red"),
        currency_code: item.currency_code,
        description_category_id: item.description_category_id,
        type_id: item.type_id,
      })), warnings: [] };
    },
  });
  const prepare = createAutoListingListingBasePreparer(deps);
  const frozen = frozenTargetCategory("MANUAL");
  const results = await Promise.all(["store-a", "store-b"].map((targetStoreId) => prepare({
    accountId: "account-a", source: source(), targetStore: { id: targetStoreId, ownerAccountId: "account-a" },
    targetCategory: frozen,
    pricingEvidence: {
      currency: targetStoreId === "store-a" ? "RUB" : "CNY",
      currencySource: "TARGET_STORE",
      blackKopecks: "10000",
      greenKopecks: "8000",
    },
  })));
  assert.deepEqual(results.map((result) => result.variants.map(({ item }) =>
    [item.description_category_id, item.type_id])), [
    [[789, 999], [789, 999]],
    [[789, 999], [789, 999]],
  ]);
  assert.deepEqual(results.map((result) => result.variants.map(({ item }) => item.currency_code)), [
    ["RUB", "RUB"],
    ["CNY", "CNY"],
  ]);
  assert.deepEqual(categoryReads, [
    { storeId: "store-a", clientId: "client-store-a", credential: "credential-store-a", category: [789, 999] },
    { storeId: "store-b", clientId: "client-store-b", credential: "credential-store-b", category: [789, 999] },
  ]);
  assert.doesNotMatch(JSON.stringify(results), /store-a|store-b|client-store|credential-store/);
});

test("builds CNY normalized variants and V2 price evidence from the target store", async () => {
  const deps = dependencies({
    loadStoreAccess: async () => ({
      id: "store-a", ownerAccountId: "account-a", clientId: "client-a",
      apiKey: "secret", currencyCode: "CNY",
    }),
    normalizeItems: async (items, context) => {
      await context.getCategoryAttributes(789, 999);
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
    targetCategory: frozenTargetCategory(),
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
      targetCategory: frozenTargetCategory(),
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
      targetCategory: frozenTargetCategory(),
      pricingEvidence: { currency: "RUB", blackKopecks: "10000", greenKopecks: "8000" },
    }),
    { code: "AUTO_LISTING_LISTING_BASE_INCOMPLETE" },
  );
});

test("rejects a category that cannot carry Ozon rich content", async () => {
  const deps = dependencies();
  deps.categoryService.getCategoryAttributes = async () => ({ items: [{ id: 85 }] });
  deps.normalizeItems = async (items, context) => {
    await context.getCategoryAttributes(789, 999);
    return { items: [normalizedItem("blue"), normalizedItem("red")], warnings: [] };
  };
  await assert.rejects(
    createAutoListingListingBasePreparer(deps)({
      accountId: "account-a", source: source(), targetStore: { id: "store-a", ownerAccountId: "account-a" },
      targetCategory: frozenTargetCategory(),
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
      targetCategory: frozenTargetCategory(),
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
    targetCategory: frozenTargetCategory(),
    pricingEvidence: { currency: "RUB", blackKopecks: "10000", greenKopecks: "8000" },
  });
  assert.deepEqual(result.versions, {
    normalizerVersion: "runtime-normalizer",
    categoryRuleVersion: "runtime-category",
    dictionaryVersion: "runtime-dictionary",
  });
});
