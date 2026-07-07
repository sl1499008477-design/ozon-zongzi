import assert from "node:assert/strict";
import { normalizeOzonImportItems } from "../ozon-import-normalizer.mjs";

const tree = [
  {
    description_category_id: 17031663,
    category_name: "Освещение",
    children: [
      {
        description_category_id: 17031664,
        category_name: "Трековое освещение",
        children: [
          { type_id: 971001, type_name: "Трековый светильник", children: [] },
        ],
      },
      {
        description_category_id: 17028737,
        category_name: "Сантехника",
        children: [
          { type_id: 94637, type_name: "Смеситель", children: [] },
        ],
      },
    ],
  },
];

const attrs = [
  31,
  4180,
  4191,
  4497,
  7822,
  8229,
  9048,
  9454,
  9455,
  9456,
  100001,
].map((id) => ({ id }));

async function normalize(items, options = {}) {
  return normalizeOzonImportItems(items, {
    strictTypeMatch: !!options.strictTypeMatch,
    getCategoryTree: async () => tree,
    getCategoryAttributes: async () => attrs,
  });
}

async function testFollowSellPayloadToOzonImportItem() {
  const raw = {
    offer_id: "jz-test-1424490696",
    name: "Тестовый трековый светильник",
    price: "469.03",
    old_price: "586.29",
    currency_code: "RUB",
    images: [
      { file_name: "https://cdn.example.test/secondary.jpg", default: false },
      { file_name: "https://cdn.example.test/main.jpg", default: true },
    ],
    scraped_sku: "1424490696",
    scraped_description: "Описание из источника",
    _sourceVariant: {
      description_category_id: 17031664,
      attributes: [
        { key: "8229", value: "Трековый светильник" },
        { key: "4180", value: "Название из Ozon" },
        { key: "4191", value: "Старое описание" },
        { key: "4497", value: "333" },
        { key: "9454", value: "10" },
        { key: "9455", value: "20" },
        { key: "9456", value: "30" },
        { key: "7822", value: "4600000000001" },
      ],
      _bundleItem: {
        barcode: "4600000000001",
        weight: 444,
        depth: 11,
        width: 22,
        height: 33,
        attributes: [
          {
            attribute_id: 31,
            complex_id: 0,
            values: [{ value: "Brand X", dictionary_value_id: 12345 }],
          },
          {
            attribute_id: 8229,
            complex_id: 0,
            values: [{ value: "Трековый светильник", dictionary_value_id: 67890 }],
          },
          {
            attribute_id: 9048,
            complex_id: 0,
            values: [{ value: "source-model" }],
          },
          {
            attribute_id: 99999,
            complex_id: 0,
            values: [{ value: "must be filtered" }],
          },
          {
            attribute_id: 100001,
            complex_id: 77,
            values: [{ value: "https://cdn.example.test/video.mp4" }],
          },
        ],
      },
    },
  };

  const result = await normalize([raw], { strictTypeMatch: true });
  assert.equal(result.warnings.length, 0);
  assert.equal(result.items.length, 1);
  const item = result.items[0];

  assert.equal(item.description_category_id, 17031664);
  assert.equal(item.type_id, 971001);
  assert.equal(item.primary_image, "https://cdn.example.test/main.jpg");
  assert.deepEqual(item.images, [
    "https://cdn.example.test/main.jpg",
    "https://cdn.example.test/secondary.jpg",
  ]);
  assert.equal(item.barcode, "4600000000001");
  assert.equal(item.weight, 333);
  assert.equal(item.depth, 10);
  assert.equal(item.width, 20);
  assert.equal(item.height, 30);

  const byId = new Map(item.attributes.map((attr) => [attr.id, attr]));
  assert.equal(byId.get(31).values[0].dictionary_value_id, 12345);
  assert.equal(byId.get(4191).values[0].value, "Описание из источника");
  assert.equal(byId.get(9048).values[0].value, "jz-test-1424490696");
  assert.equal(byId.get(7822).values[0].value, "4600000000001");
  assert.equal(byId.has(99999), false);
  assert.equal(item.complex_attributes.length, 1);
  assert.equal(item.complex_attributes[0].attributes[0].id, 100001);
}

async function testStrictTypeMatchFailsFast() {
  await assert.rejects(
    () => normalize([
      {
        offer_id: "bad-item",
        price: "10",
        _sourceVariant: {
          description_category_id: 17031664,
          attributes: [{ key: "8229", value: "Несуществующий тип" }],
        },
      },
    ], { strictTypeMatch: true }),
    /type_id/,
  );
}

async function testSearchTypeDictionaryValueCanRecoverRealDescriptionCategory() {
  const result = await normalize([
    {
      offer_id: "jz-test-faucet",
      name: "Смеситель для кухни",
      price: "1025.00",
      images: [{ file_name: "https://cdn.example.test/faucet.jpg", default: true }],
      scraped_sku: "1424490696",
      _sourceVariant: {
        description_category_id: 94637,
        categories: [
          { id: 17027482, level: 2 },
          { id: 17028737, level: 3 },
          { id: 17031929, level: 4 },
        ],
        attributes: [
          { key: "8229", value: "Смеситель" },
          { key: "4180", value: "Смеситель для кухни" },
          { key: "4194", value: "https://cdn.example.test/faucet.jpg" },
        ],
        _bundleItem: {
          description_category_id: "17031929",
          attributes: [
            {
              attribute_id: 8229,
              complex_id: 0,
              values: [{ value: "Смеситель", dictionary_value_id: 94637 }],
            },
          ],
        },
      },
    },
  ], { strictTypeMatch: true });

  assert.equal(result.warnings.length, 0);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].description_category_id, 17028737);
  assert.equal(result.items[0].type_id, 94637);
}

await testFollowSellPayloadToOzonImportItem();
await testStrictTypeMatchFailsFast();
await testSearchTypeDictionaryValueCanRecoverRealDescriptionCategory();

console.log("ozon import normalizer ok");
