import assert from "node:assert/strict";
import test from "node:test";

import { rebuildOzonItemsForCategory } from "../ozon-category-item-rebuilder.mjs";
import { buildOzonCategoryRebuildMetadata } from "../ozon-category-service.mjs";

const replacementCategory = Object.freeze({
  kind: "UNIQUE_MATCH",
  descriptionCategoryId: 789,
  typeId: 999,
});

const currentCategoryMetadata = Object.freeze({
  descriptionCategoryId: 789,
  typeId: 999,
  attributes: Object.freeze([
    Object.freeze({
      id: 85,
      required: true,
      dictionaryId: 7,
      dictionaryValues: Object.freeze([
        Object.freeze({ id: 126745801, value: "Нет бренда" }),
        Object.freeze({ id: 12345, value: "Brand X" }),
      ]),
    }),
    Object.freeze({ id: 200, required: true, dictionaryId: null, dictionaryValues: Object.freeze([]) }),
    Object.freeze({ id: 300, complexId: 77, required: false, dictionaryId: null, dictionaryValues: Object.freeze([]) }),
    Object.freeze({ id: 11254, required: false, dictionaryId: null, dictionaryValues: Object.freeze([]) }),
  ]),
});

function originalItem(suffix = "blue") {
  const richContent = JSON.stringify({ widgetName: "raShowcase", type: "billboard", blocks: [{ title: suffix }] });
  return {
    sku: `sku-${suffix}`,
    offer_id: `offer-${suffix}`,
    name: `Product ${suffix}`,
    description: `Description ${suffix}`,
    content: { language: "ru", body: `Content ${suffix}` },
    images: [`https://cdn.example.test/${suffix}.jpg`],
    primary_image: `https://cdn.example.test/${suffix}.jpg`,
    rich_content: richContent,
    price: suffix === "blue" ? "100.00" : "200.00",
    old_price: suffix === "blue" ? "120.00" : "240.00",
    min_price: suffix === "blue" ? "90.00" : "180.00",
    currency_code: suffix === "blue" ? "RUB" : "CNY",
    vat: "0.2",
    depth: 210,
    width: 80,
    height: 80,
    dimension_unit: "mm",
    weight: 386,
    weight_unit: "g",
    barcode: `460000000000${suffix === "blue" ? "1" : "2"}`,
    barcodes: [`460000000000${suffix === "blue" ? "1" : "2"}`],
    variant_id: `variant-${suffix}`,
    preserved_zero: 0,
    preserved_false: false,
    preserved_empty: "",
    description_category_id: 123,
    type_id: 456,
    attributes: [
      { id: 85, complex_id: 0, values: [{ value: "Нет бренда", dictionary_value_id: 126745801 }] },
      { id: 11254, complex_id: 0, values: [{ value: richContent }] },
      { id: 999_999, complex_id: 0, values: [{ value: "foreign category attribute" }] },
    ],
    complex_attributes: [{
      attributes: [{ id: 888_888, complex_id: 66, values: [{ value: "old complex category attribute" }] }],
    }],
  };
}

const categoryIndependent = ({
  description_category_id: _descriptionCategoryId,
  type_id: _typeId,
  attributes: _attributes,
  complex_attributes: _complexAttributes,
  ...item
}) => item;

function assertDeepFrozen(value, seen = new WeakSet()) {
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  assert.equal(Object.isFrozen(value), true);
  for (const nested of Object.values(value)) assertDeepFrozen(nested, seen);
}

test("pure rebuild changes only replacement category IDs and replacement-category attributes", () => {
  const blue = originalItem("blue");
  const red = originalItem("red");
  const callerImages = blue.images;
  const originals = Object.freeze([Object.freeze(blue), Object.freeze(red)]);
  const sourceEvidenceAttributes = Object.freeze([
    Object.freeze([
      { id: 85, complex_id: 0, values: [{ value: "source Brand X", dictionary_value_id: 12345 }] },
      { id: 200, complex_id: 0, values: [{ value: "source-blue" }] },
      { id: 300, complex_id: 77, values: [{ value: "replacement complex blue" }] },
      { id: 777_777, complex_id: 0, values: [{ value: "foreign source attribute" }] },
    ]),
    Object.freeze([{ id: 200, complex_id: 0, values: [{ value: "source-red" }] }]),
  ]);
  const before = structuredClone(originals);

  const rebuilt = rebuildOzonItemsForCategory({
    originalItems: originals,
    sourceEvidenceAttributes,
    replacementCategory,
    currentCategoryMetadata,
  });

  assert.equal(rebuilt.length, originals.length);
  assert.deepEqual(originals, before, "caller-owned immutable input must not be mutated");
  for (let index = 0; index < rebuilt.length; index += 1) {
    assert.deepEqual(categoryIndependent(rebuilt[index]), categoryIndependent(before[index]));
    assert.equal(rebuilt[index].description_category_id, 789);
    assert.equal(rebuilt[index].type_id, 999);
    assert.deepEqual(rebuilt[index].attributes.map((attribute) => attribute.id).sort((a, b) => a - b), [85, 200, 11254]);
    assert.equal(rebuilt[index].attributes.find((attribute) => attribute.id === 200).values[0].value,
      index === 0 ? "source-blue" : "source-red");
    assert.equal(rebuilt[index].attributes.some((attribute) => attribute.id === 999_999), false);
    assert.equal(rebuilt[index].attributes.some((attribute) => attribute.id === 777_777), false);
  }
  assert.deepEqual(rebuilt[0].attributes.find((attribute) => attribute.id === 85).values, [
    { value: "Brand X", dictionary_value_id: 12345 },
  ], "immutable source evidence must override an old attribute at the same exact replacement key");
  assert.deepEqual(rebuilt[0].complex_attributes, [{
    attributes: [{ complex_id: 77, id: 300, values: [{ value: "replacement complex blue" }] }],
  }]);
  assert.equal(Object.hasOwn(rebuilt[1], "complex_attributes"), false,
    "old complex attributes outside replacement metadata must be removed");
  assert.equal(rebuilt[0].preserved_zero, 0);
  assert.equal(rebuilt[0].preserved_false, false);
  assert.equal(rebuilt[0].preserved_empty, "");
  assertDeepFrozen(rebuilt);
  assert.equal(Object.isFrozen(callerImages), false, "deep-freezing output must not freeze caller-owned nested data");
  assert.equal(Object.isFrozen(sourceEvidenceAttributes[0][0]), false,
    "source evidence must be cloned before freezing output");
});

test("requires one exact UNIQUE_MATCH and matching current category metadata", () => {
  for (const replacement of [
    { kind: "NEEDS_REVIEW", reasonCode: "TYPE_AMBIGUOUS" },
    { ...replacementCategory, descriptionCategoryId: 790 },
    { ...replacementCategory, storeId: "store-must-not-enter-category-contract" },
  ]) {
    assert.throws(() => rebuildOzonItemsForCategory({
      originalItems: [originalItem()],
      sourceEvidenceAttributes: [[{ id: 200, values: [{ value: "source" }] }]],
      replacementCategory: replacement,
      currentCategoryMetadata,
    }), (error) => error?.code === "AUTO_LISTING_SOURCE_CATEGORY_REQUIRED"
      && error.status === 409 && error.cause === null
      && !JSON.stringify(error).includes("store-must-not-enter-category-contract"));
  }
});

test("fails closed when a required replacement-category attribute is incomplete", () => {
  assert.throws(() => rebuildOzonItemsForCategory({
    originalItems: [originalItem()],
    sourceEvidenceAttributes: [[]],
    replacementCategory,
    currentCategoryMetadata,
  }), (error) => error?.code === "AUTO_LISTING_CATEGORY_ATTRIBUTES_INCOMPLETE"
    && error.status === 422 && error.cause === null);
});

test("checks required attributes independently for every variant", () => {
  assert.throws(() => rebuildOzonItemsForCategory({
    originalItems: [originalItem("blue"), originalItem("red")],
    sourceEvidenceAttributes: [
      [{ id: 200, values: [{ value: "complete-blue" }] }],
      [],
    ],
    replacementCategory,
    currentCategoryMetadata,
  }), (error) => error?.code === "AUTO_LISTING_CATEGORY_ATTRIBUTES_INCOMPLETE");
});

test("fails closed when a dictionary value is absent or outside the current dictionary", () => {
  for (const [dictionaryValueId, value] of [
    [undefined, "Нет бренда"],
    [9_999_999, "Нет бренда"],
  ]) {
    const item = originalItem();
    item.attributes[0] = {
      id: 85,
      complex_id: 0,
      values: [{ value, ...(dictionaryValueId ? { dictionary_value_id: dictionaryValueId } : {}) }],
    };
    assert.throws(() => rebuildOzonItemsForCategory({
      originalItems: [item],
      sourceEvidenceAttributes: [[{ id: 200, values: [{ value: "source" }] }]],
      replacementCategory,
      currentCategoryMetadata,
    }), (error) => error?.code === "AUTO_LISTING_CATEGORY_DICTIONARY_UNRESOLVED"
      && error.status === 422 && error.cause === null
      && !error.message.includes("Нет бренда") && !JSON.stringify(error).includes("Нет бренда"));
  }
});

test("rejects hostile carriers without executing accessors and returns only safe errors", () => {
  let getterReads = 0;
  let coercions = 0;
  const hostileItem = { offer_id: "offer-hostile" };
  Object.defineProperty(hostileItem, "attributes", {
    enumerable: true,
    get() {
      getterReads += 1;
      throw new Error("credential-secret");
    },
  });
  for (const originalItems of [[hostileItem], [new Proxy(originalItem(), { get() { throw new Error("proxy-secret"); } })]]) {
    assert.throws(() => rebuildOzonItemsForCategory({
      originalItems,
      sourceEvidenceAttributes: [[]],
      replacementCategory,
      currentCategoryMetadata,
    }), (error) => error?.code === "AUTO_LISTING_SOURCE_CATEGORY_REQUIRED"
      && error.cause === null && !error.message.includes("secret") && !JSON.stringify(error).includes("secret"));
  }
  assert.throws(() => rebuildOzonItemsForCategory({
    originalItems: [originalItem()],
    sourceEvidenceAttributes: [[]],
    replacementCategory,
    currentCategoryMetadata: {
      ...currentCategoryMetadata,
      attributes: currentCategoryMetadata.attributes.map((attribute, index) => index === 0 ? {
        ...attribute,
        complexId: { valueOf() { coercions += 1; throw new Error("coercion-secret"); } },
      } : attribute),
    },
  }), (error) => error?.code === "AUTO_LISTING_CATEGORY_ATTRIBUTES_INCOMPLETE"
    && error.cause === null && !error.message.includes("secret"));
  assert.equal(getterReads, 0);
  assert.equal(coercions, 0);
});

test("maps transparent and revoked proxies at every rebuild contract layer to fixed safe failures", async (t) => {
  const contract = () => ({
    originalItems: [originalItem()],
    sourceEvidenceAttributes: [[{ id: 200, values: [{ value: "source" }] }]],
    replacementCategory: { ...replacementCategory },
    currentCategoryMetadata: structuredClone(currentCategoryMetadata),
  });
  const proxy = (value, revoked) => {
    if (!revoked) return new Proxy(value, {});
    const pair = Proxy.revocable(value, {});
    pair.revoke();
    return pair.proxy;
  };
  const cases = [
    ["originalItems", "AUTO_LISTING_SOURCE_CATEGORY_REQUIRED", (input, wrap) => { input.originalItems = wrap(input.originalItems); }],
    ["original item", "AUTO_LISTING_SOURCE_CATEGORY_REQUIRED", (input, wrap) => { input.originalItems[0] = wrap(input.originalItems[0]); }],
    ["replacement", "AUTO_LISTING_SOURCE_CATEGORY_REQUIRED", (input, wrap) => { input.replacementCategory = wrap(input.replacementCategory); }],
    ["source outer", "AUTO_LISTING_CATEGORY_ATTRIBUTES_INCOMPLETE", (input, wrap) => { input.sourceEvidenceAttributes = wrap(input.sourceEvidenceAttributes); }],
    ["source group", "AUTO_LISTING_CATEGORY_ATTRIBUTES_INCOMPLETE", (input, wrap) => { input.sourceEvidenceAttributes[0] = wrap(input.sourceEvidenceAttributes[0]); }],
    ["source attribute", "AUTO_LISTING_CATEGORY_ATTRIBUTES_INCOMPLETE", (input, wrap) => { input.sourceEvidenceAttributes[0][0] = wrap(input.sourceEvidenceAttributes[0][0]); }],
    ["source values", "AUTO_LISTING_CATEGORY_ATTRIBUTES_INCOMPLETE", (input, wrap) => { input.sourceEvidenceAttributes[0][0].values = wrap(input.sourceEvidenceAttributes[0][0].values); }],
    ["source value", "AUTO_LISTING_CATEGORY_ATTRIBUTES_INCOMPLETE", (input, wrap) => { input.sourceEvidenceAttributes[0][0].values[0] = wrap(input.sourceEvidenceAttributes[0][0].values[0]); }],
    ["metadata", "AUTO_LISTING_SOURCE_CATEGORY_REQUIRED", (input, wrap) => { input.currentCategoryMetadata = wrap(input.currentCategoryMetadata); }],
    ["metadata attributes", "AUTO_LISTING_SOURCE_CATEGORY_REQUIRED", (input, wrap) => { input.currentCategoryMetadata.attributes = wrap(input.currentCategoryMetadata.attributes); }],
    ["metadata attribute", "AUTO_LISTING_CATEGORY_ATTRIBUTES_INCOMPLETE", (input, wrap) => { input.currentCategoryMetadata.attributes[0] = wrap(input.currentCategoryMetadata.attributes[0]); }],
    ["dictionary values", "AUTO_LISTING_CATEGORY_DICTIONARY_UNRESOLVED", (input, wrap) => { input.currentCategoryMetadata.attributes[0].dictionaryValues = wrap(input.currentCategoryMetadata.attributes[0].dictionaryValues); }],
    ["dictionary option", "AUTO_LISTING_CATEGORY_DICTIONARY_UNRESOLVED", (input, wrap) => { input.currentCategoryMetadata.attributes[0].dictionaryValues[0] = wrap(input.currentCategoryMetadata.attributes[0].dictionaryValues[0]); }],
  ];
  for (const [name, expectedCode, mutate] of cases) {
    for (const revoked of [false, true]) {
      await t.test(`${revoked ? "revoked" : "transparent"} ${name}`, () => {
        const input = contract();
        mutate(input, (value) => proxy(value, revoked));
        assert.throws(() => rebuildOzonItemsForCategory(input), (error) =>
          error?.code === expectedCode && error.cause === null
          && error.retryable === false && error.message === expectedCode
          && !JSON.stringify(error).includes("secret"));
      });
    }
  }
});

test("rejects explicit invalid source attribute IDs instead of folding them into the simple key", () => {
  for (const attribute of [
    { id: 200, complex_id: -1, values: [{ value: "invalid complex id" }] },
    { id: Number.MAX_SAFE_INTEGER + 1, complex_id: 0, values: [{ value: "unsafe id" }] },
  ]) {
    assert.throws(() => rebuildOzonItemsForCategory({
      originalItems: [originalItem()],
      sourceEvidenceAttributes: [[attribute]],
      replacementCategory,
      currentCategoryMetadata,
    }), (error) => error?.code === "AUTO_LISTING_CATEGORY_ATTRIBUTES_INCOMPLETE"
      && error.status === 422 && error.cause === null);
  }
});

test("bounds source attribute nested strings, arrays, nodes, and depth with safe failures", () => {
  const tooDeep = {};
  let cursor = tooDeep;
  for (let depth = 0; depth < 66; depth += 1) {
    cursor.child = {};
    cursor = cursor.child;
  }
  const cases = [
    { id: 200, values: [{ value: "x".repeat(2_000_001) }] },
    { id: 200, values: ["x".repeat(2_000_001)] },
    { id: 200, values: Array.from({ length: 5_001 }, () => ({ value: "x" })) },
    { id: 200, values: [{ value: tooDeep }] },
  ];
  for (const attribute of cases) {
    assert.throws(() => rebuildOzonItemsForCategory({
      originalItems: [originalItem()],
      sourceEvidenceAttributes: [[attribute]],
      replacementCategory,
      currentCategoryMetadata,
    }), (error) => error?.code === "AUTO_LISTING_CATEGORY_ATTRIBUTES_INCOMPLETE"
      && error.status === 422 && error.cause === null
      && !JSON.stringify(error).includes("xxxxx"));
  }
});

test("category metadata projection binds exact category, attribute, and dictionary IDs without store identity", () => {
  const metadata = buildOzonCategoryRebuildMetadata({
    descriptionCategoryId: 789,
    typeId: 999,
    attributes: [
      { id: 85, complex_id: 0, is_required: true, dictionary_id: 7, vendor_label: "ignored" },
      { id: 200, complex_id: 77, required: false },
    ],
    dictionaryValues: [{
      attributeId: 85,
      values: [{ id: 126745801, value: "Нет бренда", vendor_payload: "ignored" }],
    }],
  });
  assert.deepEqual(metadata, {
    descriptionCategoryId: 789,
    typeId: 999,
    attributes: [
      {
        id: 85, complexId: 0, required: true, dictionaryId: 7,
        dictionaryValues: [{ id: 126745801, value: "Нет бренда" }],
      },
      { id: 200, complexId: 77, required: false, dictionaryId: null, dictionaryValues: [] },
    ],
  });
  assert.doesNotMatch(JSON.stringify(metadata), /store|vendor/);
  assertDeepFrozen(metadata);

  let reads = 0;
  const hostile = {};
  Object.defineProperty(hostile, "attributes", {
    enumerable: true,
    get() { reads += 1; throw new Error("credential-secret"); },
  });
  assert.throws(() => buildOzonCategoryRebuildMetadata(hostile), (error) =>
    error?.code === "AUTO_LISTING_SOURCE_CATEGORY_REQUIRED" && error.cause === null);
  assert.equal(reads, 0);

  assert.throws(() => buildOzonCategoryRebuildMetadata({
    descriptionCategoryId: 789,
    typeId: 999,
    attributes: [{ id: 85, dictionary_id: 7 }],
    dictionaryValues: [{ attributeId: 86, values: [{ id: 126745801, value: "Нет бренда" }] }],
  }), (error) => error?.code === "AUTO_LISTING_CATEGORY_DICTIONARY_UNRESOLVED" && error.cause === null);
  assert.throws(() => buildOzonCategoryRebuildMetadata({
    descriptionCategoryId: 789,
    typeId: 999,
    attributes: [{ id: 85, dictionary_id: 7 }],
    dictionaryValues: [{ attributeId: 85, values: [{ id: 0, value: "invalid" }] }],
  }), { code: "AUTO_LISTING_CATEGORY_DICTIONARY_UNRESOLVED" });
});
