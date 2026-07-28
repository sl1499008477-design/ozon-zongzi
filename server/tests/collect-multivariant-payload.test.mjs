import assert from "node:assert/strict";
import { normalizeOzonImportItems } from "../ozon-import-normalizer.mjs";

process.env.QH_LOCAL_NO_LISTEN = "1";
process.env.QH_LOCAL_NO_DOTENV = "1";

const { testExports } = await import("../index.mjs");

const sourceVariant = ({ sku, categoryId, typeId, color, description, image, weight, depth, width, height }) => ({
  sku,
  description_category_id: categoryId,
  type_id: typeId,
  attributes: [
    { key: "500", value: color },
    { key: "4191", value: description },
    { key: "4194", value: image },
    { key: "4497", value: String(weight) },
    { key: "9454", value: String(depth) },
    { key: "9455", value: String(width) },
    { key: "9456", value: String(height) },
  ],
});

const firstSource = sourceVariant({
  sku: "sku-red",
  categoryId: 17000001,
  typeId: 910001,
  color: "Красный",
  description: "Описание красного варианта",
  image: "https://cdn.example.test/red.jpg",
  weight: 110,
  depth: 210,
  width: 310,
  height: 410,
});
const secondSource = sourceVariant({
  sku: "sku-blue",
  categoryId: 17000002,
  typeId: 910002,
  color: "Синий",
  description: "Описание синего варианта",
  image: "https://cdn.example.test/blue.jpg",
  weight: 120,
  depth: 220,
  width: 320,
  height: 420,
});

const collected = {
  id: "collect-multi-variant",
  sku: "sku-red",
  listingDraft: {
    sku: "sku-red",
    modelName: "shared-model-name",
    listingWarehouseId: "1020000000001",
    listingStock: "5",
    variants: [
      {
        sku: "sku-red",
        offerId: "offer-red",
        name: "Красный вариант",
        sellPrice: "101.00",
        images: ["https://cdn.example.test/red.jpg"],
        sourceVariant: firstSource,
        descriptionCategoryId: 17000001,
        typeId: 910001,
        categoryAttributes: [{ id: 500, values: [{ value: "Красный вручную" }] }],
        packageWeight: "111",
        packageLength: "211",
        packageWidth: "311",
        packageHeight: "411",
      },
      {
        sku: "sku-blue",
        offerId: "offer-blue",
        name: "Синий вариант",
        sellPrice: "202.00",
        images: ["https://cdn.example.test/blue.jpg"],
        sourceVariant: secondSource,
      },
    ],
  },
};

const rawItems = testExports.buildCollectBoxListingItems(collected);
assert.equal(rawItems.length, 2);
assert.equal(rawItems[0]._sourceVariant, firstSource);
assert.equal(rawItems[1]._sourceVariant, secondSource);
assert.equal(rawItems[0].scraped_model_name, "shared-model-name");
assert.equal(rawItems[1].scraped_model_name, "shared-model-name");
assert.equal(rawItems[0].description_category_id, 17000001);
assert.equal(rawItems[1].description_category_id, undefined, "sibling category must come from its own source snapshot");
assert.equal(rawItems[0].attributes[0].values[0].value, "Красный вручную");
assert.deepEqual(rawItems[1].attributes, [], "anchor edits must not be copied to sibling variants");

const attrs = [500, 4191, 4194, 4497, 9048, 9454, 9455, 9456].map((id) => ({ id }));
const normalized = await normalizeOzonImportItems(rawItems, {
  strictTypeMatch: true,
  getCategoryAttributes: async () => attrs,
  getCategoryAttributeValues: async () => [],
});

assert.deepEqual(normalized.warnings, []);
assert.equal(normalized.items.length, 2);
const [red, blue] = normalized.items;
const redAttrs = new Map(red.attributes.map((attr) => [attr.id, attr]));
const blueAttrs = new Map(blue.attributes.map((attr) => [attr.id, attr]));

assert.equal(red.description_category_id, 17000001);
assert.equal(red.type_id, 910001);
assert.equal(blue.description_category_id, 17000002);
assert.equal(blue.type_id, 910002);
assert.equal(redAttrs.get(500).values[0].value, "Красный вручную");
assert.equal(blueAttrs.get(500).values[0].value, "Синий");
assert.equal(redAttrs.get(4191).values[0].value, "Описание красного варианта");
assert.equal(blueAttrs.get(4191).values[0].value, "Описание синего варианта");
assert.equal(redAttrs.get(9048).values[0].value, "shared-model-name");
assert.equal(blueAttrs.get(9048).values[0].value, "shared-model-name");
assert.equal(red.primary_image, "https://cdn.example.test/red.jpg");
assert.equal(blue.primary_image, "https://cdn.example.test/blue.jpg");
assert.deepEqual([red.weight, red.depth, red.width, red.height], [111, 211, 311, 411]);
assert.deepEqual([blue.weight, blue.depth, blue.width, blue.height], [120, 220, 320, 420]);

const stocks = testExports.listingStockRowsFromDraft(collected.listingDraft, collected, rawItems);
assert.equal(stocks.length, 2);
assert.deepEqual(stocks.map((row) => row.stock), [5, 5]);
assert.deepEqual(stocks.map((row) => row.warehouse_id), [1020000000001, 1020000000001]);

const legacyItems = testExports.buildCollectBoxListingItems({
  id: "legacy-multi",
  sku: "legacy-one",
  listingDraft: {
    sku: "legacy-one",
    listingWarehouseId: "1020000000001",
    listingStock: "5",
    variants: [
      { sku: "legacy-one", offerId: "legacy-offer-one", name: "One", sellPrice: "10", images: ["https://cdn.example.test/one.jpg"], sourceVariant: firstSource },
      { sku: "legacy-two", offerId: "legacy-offer-two", name: "Two", sellPrice: "20", images: ["https://cdn.example.test/two.jpg"] },
    ],
  },
});
assert.match(
  testExports.validateCollectBoxListingDraft(
    { id: "legacy-multi" },
    legacyItems,
    testExports.listingStockRowsFromDraft({ listingWarehouseId: "1020000000001", listingStock: "5" }, {}, legacyItems),
  ).join("\n"),
  /完整采集源数据/,
);

console.log("collect multivariant payload isolation passed");
