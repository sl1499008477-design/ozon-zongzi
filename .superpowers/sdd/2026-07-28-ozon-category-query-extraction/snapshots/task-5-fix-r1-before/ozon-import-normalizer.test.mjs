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
  11254,
  23171,
].map((id) => ({ id }));

async function normalize(items, options = {}) {
  return normalizeOzonImportItems(items, {
    strictTypeMatch: !!options.strictTypeMatch,
    allowUnresolvedRequiredDictionaryValues: !!options.allowUnresolvedRequiredDictionaryValues,
    getCategoryTree: async () => tree,
    getCategoryAttributes: async () => options.attrs || attrs,
    getCategoryAttributeValues: async (_descriptionCategoryId, _typeId, attributeId) => {
      if (options.attributeValuesError?.[Number(attributeId)] || options.attributeValuesError?.[String(attributeId)]) {
        throw new Error(options.attributeValuesError[Number(attributeId)] || options.attributeValuesError[String(attributeId)]);
      }
      return options.attributeValues?.[Number(attributeId)] || options.attributeValues?.[String(attributeId)] || [];
    },
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

async function testDictionaryTextValueResolvesToOzonDictionaryId() {
  for (const brandValue of ["Нет бренда", "без бренда"]) {
    const result = await normalize([
      {
        offer_id: `jz-no-brand-${brandValue}`,
        name: "Тестовый товар без бренда",
        price: "100.00",
        images: ["https://cdn.example.test/no-brand.jpg"],
        description_category_id: 17031664,
        type_id: 971001,
        weight: 100,
        depth: 100,
        width: 100,
        height: 100,
        attributes: [
          {
            id: 85,
            values: [{ value: brandValue }],
          },
        ],
      },
    ], {
      strictTypeMatch: true,
      attrs: [...attrs, { id: 85, dictionary_id: 28732849 }],
      attributeValues: {
        85: [
          { id: 222, value: "без бренда" },
          { id: 126745801, value: "Нет бренда" },
          { id: 123, value: "Brand X" },
        ],
      },
    });

    const byId = new Map(result.items[0].attributes.map((attr) => [attr.id, attr]));
    assert.equal(byId.get(85).values[0].value, "Нет бренда");
    assert.equal(byId.get(85).values[0].dictionary_value_id, 126745801);
  }
}

async function testInvalidRichContentIsOmittedBeforeUpload() {
  const invalidRichContent = JSON.stringify({
    content: [
      {
        widgetName: "raShowcase",
        type: "roll",
        blocks: [],
      },
    ],
  });

  const result = await normalize([
    {
      offer_id: "jz-invalid-rich-content",
      name: "Товар с неверным rich content",
      price: "100.00",
      images: ["https://cdn.example.test/rich.jpg"],
      description_category_id: 17031664,
      type_id: 971001,
      weight: 100,
      depth: 100,
      width: 100,
      height: 100,
      richContent: invalidRichContent,
      attributes: [
        {
          id: 11254,
          values: [{ value: invalidRichContent }],
        },
      ],
      scraped_description: "Обычное описание остается доступным для карточки.",
    },
  ], { strictTypeMatch: true });

  const byId = new Map(result.items[0].attributes.map((attr) => [attr.id, attr]));
  assert.equal(byId.has(11254), false);
  assert.equal(byId.get(4191).values[0].value, "Обычное описание остается доступным для карточки.");
}

async function testValidRichContentTemplateCanPass() {
  const richContent = JSON.stringify({
    widgetName: "raShowcase",
    type: "billboard",
    blocks: [
      {
        img: {
          src: "https://cdn.example.test/rich.jpg",
          width: 1280,
          height: 853,
        },
      },
    ],
  });

  const result = await normalize([
    {
      offer_id: "jz-valid-rich-content",
      name: "Товар с валидным rich content",
      price: "100.00",
      images: ["https://cdn.example.test/rich.jpg"],
      description_category_id: 17031664,
      type_id: 971001,
      weight: 100,
      depth: 100,
      width: 100,
      height: 100,
      richContent,
    },
  ], { strictTypeMatch: true });

  const byId = new Map(result.items[0].attributes.map((attr) => [attr.id, attr]));
  assert.equal(JSON.parse(byId.get(11254).values[0].value).widgetName, "raShowcase");
}

async function testFrontendRichContentWrapperIsConvertedBeforeUpload() {
  const richContent = JSON.stringify({
    content: [
      {
        widgetName: "raShowcase",
        type: "roll",
        blocks: [
          {
            img: { src: "https://cdn.example.test/rich-1.jpg" },
            title: { content: "Товар с rich content" },
          },
        ],
      },
    ],
    version: 0.3,
  });

  const result = await normalize([
    {
      offer_id: "jz-frontend-rich-content",
      name: "Товар с rich content",
      price: "100.00",
      images: ["https://cdn.example.test/rich-1.jpg"],
      description_category_id: 17031664,
      type_id: 971001,
      weight: 100,
      depth: 100,
      width: 100,
      height: 100,
      richContent,
    },
  ], { strictTypeMatch: true });

  const byId = new Map(result.items[0].attributes.map((attr) => [attr.id, attr]));
  const uploaded = JSON.parse(byId.get(11254).values[0].value);
  assert.equal(uploaded.widgetName, "raShowcase");
  assert.equal(uploaded.type, "roll");
  assert.equal(Array.isArray(uploaded.blocks), true);
  assert.equal(uploaded.content, undefined);
  assert.equal(uploaded.version, undefined);
}

async function testHashtagsAreSanitizedForOzon() {
  const result = await normalize([
    {
      offer_id: "jz-hashtags",
      name: "Товар с хештегами",
      price: "100.00",
      images: ["https://cdn.example.test/tags.jpg"],
      description_category_id: 17031664,
      type_id: 971001,
      weight: 100,
      depth: 100,
      width: 100,
      height: 100,
      _aiHashtags: ["Уличный、светильник", "#LED lamp", "bad!!!", "#LED"],
    },
  ], { strictTypeMatch: true });

  const byId = new Map(result.items[0].attributes.map((attr) => [attr.id, attr]));
  const tags = byId.get(23171).values.map((value) => value.value);
  assert.deepEqual(tags, ["#Уличный", "#светильник", "#LED", "#lamp", "#bad"]);
  assert.equal(tags.every((tag) => /^#[\p{L}\p{N}_]{1,29}$/u.test(tag)), true);
}

async function testHashtagsUseCategorySpecificAttributeId() {
  const result = await normalize([
    {
      offer_id: "jz-hashtag-specific",
      name: "Товар с другим полем хештегов",
      price: "100.00",
      images: ["https://cdn.example.test/tags-specific.jpg"],
      description_category_id: 17031664,
      type_id: 971001,
      weight: 100,
      depth: 100,
      width: 100,
      height: 100,
      _aiHashtags: ["светильник", "LED"],
    },
  ], {
    strictTypeMatch: true,
    attrs: attrs
      .filter((attr) => Number(attr.id) !== 23171)
      .concat([{ id: 22508, name: "Хештеги" }]),
  });

  const byId = new Map(result.items[0].attributes.map((attr) => [attr.id, attr]));
  assert.equal(byId.has(23171), false);
  assert.deepEqual(byId.get(22508).values.map((value) => value.value), ["#светильник", "#LED"]);
}

async function testOptionalUnresolvedDictionaryAttributeIsOmitted() {
  const result = await normalize([
    {
      offer_id: "jz-optional-dictionary",
      name: "Товар с опциональным справочником",
      price: "100.00",
      images: ["https://cdn.example.test/optional.jpg"],
      description_category_id: 17031664,
      type_id: 971001,
      weight: 100,
      depth: 100,
      width: 100,
      height: 100,
      attributes: [
        {
          id: 777,
          values: [{ value: "unknown value" }],
        },
      ],
    },
  ], {
    strictTypeMatch: true,
    attrs: [...attrs, { id: 777, dictionary_id: 700, required: false }],
    attributeValues: { 777: [{ id: 1, value: "known value" }] },
  });

  const byId = new Map(result.items[0].attributes.map((attr) => [attr.id, attr]));
  assert.equal(byId.has(777), false);
}

async function testRequiredUnresolvedDictionaryFailsBeforeOzon() {
  await assert.rejects(
    () => normalize([
      {
        offer_id: "jz-required-dictionary",
        name: "Товар с обязательным справочником",
        price: "100.00",
        images: ["https://cdn.example.test/required.jpg"],
        description_category_id: 17031664,
        type_id: 971001,
        weight: 100,
        depth: 100,
        width: 100,
        height: 100,
        attributes: [
          {
            id: 778,
            values: [{ value: "unknown required value" }],
          },
        ],
      },
    ], {
      strictTypeMatch: true,
      attrs: [...attrs, { id: 778, dictionary_id: 701, is_required: true, name: "必填字典" }],
      attributeValues: { 778: [{ id: 1, value: "known value" }] },
    }),
    /必填字典属性「必填字典」未匹配到 Ozon 字典值/,
  );
}

async function testCategoryPreviewKeepsMatchedCategoryWhenRequiredDictionaryIsUnresolved() {
  const result = await normalize([
    {
      offer_id: "jz-category-preview-brand-mismatch",
      name: "Светильник с брендом вне справочника",
      price: "100.00",
      images: ["https://cdn.example.test/category-preview.jpg"],
      description_category_id: 17031664,
      type_id: 971001,
      weight: 100,
      depth: 100,
      width: 100,
      height: 100,
      attributes: [
        {
          id: 85,
          values: [{ value: "Свети-ка" }],
        },
      ],
    },
  ], {
    strictTypeMatch: true,
    allowUnresolvedRequiredDictionaryValues: true,
    attrs: [...attrs, { id: 85, dictionary_id: 28732849, is_required: true, name: "Бренд" }],
    attributeValues: { 85: [{ id: 126745801, value: "Нет бренда" }] },
  });

  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].description_category_id, 17031664);
  assert.equal(result.items[0].type_id, 971001);
  assert.equal(result.items[0].attributes.some((attr) => attr.id === 85), false);
  assert.match(result.warnings.join("\n"), /Бренд.*Свети-ка/);
}

async function testOptionalDictionaryFetchFailureIsOmitted() {
  const result = await normalize([
    {
      offer_id: "jz-optional-dictionary-fetch-failed",
      name: "Товар с недоступным опциональным справочником",
      price: "100.00",
      images: ["https://cdn.example.test/optional-fetch.jpg"],
      description_category_id: 17031664,
      type_id: 971001,
      weight: 100,
      depth: 100,
      width: 100,
      height: 100,
      attributes: [
        {
          id: 779,
          values: [{ value: "unknown optional value" }],
        },
      ],
    },
  ], {
    strictTypeMatch: true,
    attrs: [...attrs, { id: 779, dictionary_id: 702, required: false, name: "可选字典" }],
    attributeValuesError: { 779: "fetch failed" },
  });

  const byId = new Map(result.items[0].attributes.map((attr) => [attr.id, attr]));
  assert.equal(byId.has(779), false);
}

async function testRequiredDictionaryFetchFailureNamesAttribute() {
  await assert.rejects(
    () => normalize([
      {
        offer_id: "jz-required-dictionary-fetch-failed",
        name: "Товар с недоступным обязательным справочником",
        price: "100.00",
        images: ["https://cdn.example.test/required-fetch.jpg"],
        description_category_id: 17031664,
        type_id: 971001,
        weight: 100,
        depth: 100,
        width: 100,
        height: 100,
        attributes: [
          {
            id: 780,
            values: [{ value: "required value" }],
          },
        ],
      },
    ], {
      strictTypeMatch: true,
      attrs: [...attrs, { id: 780, dictionary_id: 703, is_required: true, name: "网络失败必填字典" }],
      attributeValuesError: { 780: "fetch failed" },
    }),
    /获取必填字典属性「网络失败必填字典」可选值失败：fetch failed/,
  );
}

await testFollowSellPayloadToOzonImportItem();
await testStrictTypeMatchFailsFast();
await testSearchTypeDictionaryValueCanRecoverRealDescriptionCategory();
await testDictionaryTextValueResolvesToOzonDictionaryId();
await testInvalidRichContentIsOmittedBeforeUpload();
await testValidRichContentTemplateCanPass();
await testFrontendRichContentWrapperIsConvertedBeforeUpload();
await testHashtagsAreSanitizedForOzon();
await testHashtagsUseCategorySpecificAttributeId();
await testOptionalUnresolvedDictionaryAttributeIsOmitted();
await testRequiredUnresolvedDictionaryFailsBeforeOzon();
await testCategoryPreviewKeepsMatchedCategoryWhenRequiredDictionaryIsUnresolved();
await testOptionalDictionaryFetchFailureIsOmitted();
await testRequiredDictionaryFetchFailureNamesAttribute();

console.log("ozon import normalizer ok");
