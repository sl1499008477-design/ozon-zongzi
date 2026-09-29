import assert from "node:assert/strict";
import test from "node:test";
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
    categoryMatchPolicy: options.categoryMatchPolicy,
    sourceCategory: options.sourceCategory,
    targetStoreId: options.targetStoreId,
    now: options.now,
    allowUnresolvedRequiredDictionaryValues: !!options.allowUnresolvedRequiredDictionaryValues,
    searchCategoryAttributeValuesExact: options.searchCategoryAttributeValuesExact,
    getCategoryTree: async () => options.tree || tree,
    getCategoryAttributes: async () => options.attrs || attrs,
    getCategoryAttributeValues: async (_descriptionCategoryId, _typeId, attributeId, dictionaryOptions = {}) => {
      if (dictionaryOptions.language === "ZH_HANS") {
        if (options.localizedAttributeValuesError?.[Number(attributeId)]) throw options.localizedAttributeValuesError[Number(attributeId)];
        return options.localizedAttributeValues?.[Number(attributeId)] || [];
      }
      if (options.attributeValuesError?.[Number(attributeId)] || options.attributeValuesError?.[String(attributeId)]) {
        throw new Error(options.attributeValuesError[Number(attributeId)] || options.attributeValuesError[String(attributeId)]);
      }
      return options.attributeValues?.[Number(attributeId)] || options.attributeValues?.[String(attributeId)] || [];
    },
  });
}

function collectedCategoryItem({ offerId, descriptionCategoryId, typeName, typeIdCandidate }) {
  return {
    offer_id: offerId,
    name: `Collected ${offerId}`,
    weight: 230, depth: 140, width: 150, height: 160,
    price: "100.00",
    images: [`https://cdn.example.test/${offerId}.jpg`],
    _sourceVariant: {
      description_category_id: descriptionCategoryId,
      attributes: [
        {
          key: "8229",
          value: typeName,
          ...(typeIdCandidate ? { dictionary_value_id: typeIdCandidate } : {}),
        },
      ],
    },
  };
}

const fixedNow = () => new Date("2026-08-01T00:00:00.000Z");

const strictSourceCategory = Object.freeze({
  kind: "UNIQUE_MATCH",
  descriptionCategoryId: 17031664,
  typeId: 971001,
});

function strictMetadata(attributes = attrs, dictionaryValues = {}) {
  return {
    descriptionCategoryId: 17031664,
    typeId: 971001,
    attributes: attributes.map((attribute) => ({
      id: attribute.id,
      complexId: attribute.complex_id || 0,
      required: attribute.is_required === true,
      dictionaryId: attribute.dictionary_id || null,
      dictionaryValues: dictionaryValues[attribute.id] || [],
    })),
  };
}

function strictCategoryItem(overrides = {}) {
  return {
    offer_id: "strict-source-category",
    sku: "strict-source-sku",
    name: "Strict source category product",
    price: "100.00",
    currency_code: "RUB",
    images: ["https://cdn.example.test/strict.jpg"],
    description_category_id: 17031664,
    type_id: 971001,
    weight: 100,
    depth: 100,
    width: 100,
    height: 100,
    attributes: [{ id: 85, values: [{ value: "Нет бренда" }] }],
    _sourceVariant: {
      description_category_id: 99999999,
      type_id: 88888888,
      attributes: [{ key: "8229", value: "fuzzy source name must never be consulted" }],
    },
    ...overrides,
  };
}

async function testSourceCategoryStrictUsesOnlyFrozenUniqueMatch() {
  let treeReads = 0;
  const result = await normalizeOzonImportItems([strictCategoryItem()], {
    strictTypeMatch: true,
    categoryMatchPolicy: "SOURCE_CATEGORY_STRICT",
    sourceCategory: strictSourceCategory,
    currentCategoryMetadata: strictMetadata(),
    targetStoreId: "store-secret-must-not-enter-result",
    getCategoryTree: async () => {
      treeReads += 1;
      throw new Error("fuzzy/store category matching is forbidden");
    },
    getCategoryAttributes: async () => attrs,
    getCategoryAttributeValues: async () => [],
  });

  assert.equal(treeReads, 0);
  assert.equal(result.items[0].description_category_id, 17031664);
  assert.equal(result.items[0].type_id, 971001);
  assert.doesNotMatch(JSON.stringify(result), /store-secret|targetStoreId|storeId/);

  for (const sourceCategory of [
    undefined,
    { ...strictSourceCategory, descriptionCategoryId: 17028737 },
    { kind: "NEEDS_REVIEW", reasonCode: "TYPE_AMBIGUOUS" },
  ]) {
    await assert.rejects(
      () => normalizeOzonImportItems([strictCategoryItem()], {
        strictTypeMatch: true,
        categoryMatchPolicy: "SOURCE_CATEGORY_STRICT",
        sourceCategory,
        currentCategoryMetadata: strictMetadata(),
        getCategoryTree: async () => { throw new Error("must not read tree"); },
        getCategoryAttributes: async () => attrs,
      }),
      (error) => error?.code === "AUTO_LISTING_SOURCE_CATEGORY_REQUIRED"
        && error.status === 409 && error.cause === null,
    );
  }

  let coercions = 0;
  await assert.rejects(() => normalizeOzonImportItems([strictCategoryItem()], {
    strictTypeMatch: true,
    categoryMatchPolicy: "SOURCE_CATEGORY_STRICT",
    sourceCategory: {
      ...strictSourceCategory,
      descriptionCategoryId: { valueOf() { coercions += 1; throw new Error("secret"); } },
    },
    currentCategoryMetadata: strictMetadata(),
    getCategoryAttributes: async () => attrs,
  }), { code: "AUTO_LISTING_SOURCE_CATEGORY_REQUIRED" });
  assert.equal(coercions, 0);
}

async function testSourceCategoryStrictRequiresEveryRequiredAttribute() {
  await assert.rejects(
    () => normalizeOzonImportItems([strictCategoryItem()], {
      strictTypeMatch: true,
      categoryMatchPolicy: "SOURCE_CATEGORY_STRICT",
      sourceCategory: strictSourceCategory,
      currentCategoryMetadata: strictMetadata([
        ...attrs,
        { id: 777, is_required: true, name: "vendor-secret-name" },
      ]),
    }),
    (error) => error?.code === "AUTO_LISTING_CATEGORY_ATTRIBUTES_INCOMPLETE"
      && error.status === 422 && error.cause === null
      && !error.message.includes("vendor-secret-name") && !JSON.stringify(error).includes("vendor-secret-name"),
  );
}

async function testSourceCategoryStrictChecksRequiredComplexAttributes() {
  const item = strictCategoryItem({
    bundleComplexAttrs: [{
      id: 901,
      complex_id: 77,
      values: [{ value: "complex evidence" }],
    }],
  });
  const result = await normalizeOzonImportItems([item], {
    strictTypeMatch: true,
    categoryMatchPolicy: "SOURCE_CATEGORY_STRICT",
    sourceCategory: strictSourceCategory,
    currentCategoryMetadata: strictMetadata([
      ...attrs,
      { id: 901, complex_id: 77, is_required: true },
    ]),
  });
  assert.deepEqual(result.items[0].complex_attributes, [{
    attributes: [{ complex_id: 77, id: 901, values: [{ value: "complex evidence" }] }],
  }]);

  await assert.rejects(() => normalizeOzonImportItems([strictCategoryItem()], {
    strictTypeMatch: true,
    categoryMatchPolicy: "SOURCE_CATEGORY_STRICT",
    sourceCategory: strictSourceCategory,
    currentCategoryMetadata: strictMetadata([...attrs, { id: 901, complex_id: 77, is_required: true }]),
  }), { code: "AUTO_LISTING_CATEGORY_ATTRIBUTES_INCOMPLETE" });
}

async function testSourceCategoryStrictValidatesCurrentDictionaryIdsWithSafeFailure() {
  for (const value of [
    { value: "Нет бренда" },
    { value: "Нет бренда", dictionary_value_id: 99999999 },
  ]) {
    const item = strictCategoryItem({
      attributes: [{ id: 85, values: [value] }],
    });
    await assert.rejects(
      () => normalizeOzonImportItems([item], {
        strictTypeMatch: true,
        categoryMatchPolicy: "SOURCE_CATEGORY_STRICT",
        sourceCategory: strictSourceCategory,
        currentCategoryMetadata: strictMetadata([
          ...attrs.filter((attribute) => attribute.id !== 85),
          { id: 85, dictionary_id: 28732849, is_required: true, name: "Brand secret" },
        ], { 85: [{ id: 126745801, value: "Нет бренда" }] }),
      }),
      (error) => error?.code === "AUTO_LISTING_CATEGORY_DICTIONARY_UNRESOLVED"
        && error.status === 422 && error.cause === null
        && !error.message.includes("Нет бренда") && !JSON.stringify(error).includes("Нет бренда"),
    );
  }

  await assert.rejects(() => normalizeOzonImportItems([strictCategoryItem({
    attributes: [{ id: 85, values: [{ value: "Нет бренда", dictionary_value_id: 126745801 }] }],
  })], {
    strictTypeMatch: true,
    categoryMatchPolicy: "SOURCE_CATEGORY_STRICT",
    sourceCategory: strictSourceCategory,
    currentCategoryMetadata: strictMetadata([
      ...attrs.filter((attribute) => attribute.id !== 85),
      { id: 85, dictionary_id: 28732849, is_required: true },
    ]),
  }), { code: "AUTO_LISTING_CATEGORY_DICTIONARY_UNRESOLVED" });
}

async function testSourceCategoryStrictAcceptsOnlyAnExactCurrentDictionaryId() {
  const result = await normalizeOzonImportItems([strictCategoryItem({
    attributes: [{ id: 85, values: [{ value: "stale display label", dictionary_value_id: 126745801 }] }],
  })], {
    strictTypeMatch: true,
    categoryMatchPolicy: "SOURCE_CATEGORY_STRICT",
    sourceCategory: strictSourceCategory,
    currentCategoryMetadata: strictMetadata([
      ...attrs.filter((attribute) => attribute.id !== 85),
      { id: 85, dictionary_id: 28732849, is_required: true },
    ], { 85: [{ id: 126745801, value: "Нет бренда" }] }),
  });
  assert.deepEqual(result.items[0].attributes.find((attribute) => attribute.id === 85).values, [
    { value: "stale display label", dictionary_value_id: 126745801 },
  ], "strict policy validates by current dictionary ID and does not infer by text");
}

async function testSourceCategoryStrictMakesImmutableSourceAttributesAuthoritative() {
  const item = strictCategoryItem({
    attributes: [{ id: 200, values: [{ value: "OLD upload value" }] }],
    _sourceVariant: {
      attributes: [{ id: 200, values: [{ value: "SOURCE immutable value" }] }],
    },
  });
  const result = await normalizeOzonImportItems([item], {
    strictTypeMatch: true,
    categoryMatchPolicy: "SOURCE_CATEGORY_STRICT",
    sourceCategory: strictSourceCategory,
    currentCategoryMetadata: strictMetadata([{ id: 200, is_required: true }]),
  });
  assert.deepEqual(result.items[0].attributes, [{
    complex_id: 0,
    id: 200,
    values: [{ value: "SOURCE immutable value" }],
  }]);
}

async function testSourceCategoryStrictConsumesClosedMetadataWithoutNetworkReads() {
  let attributeReads = 0;
  let dictionaryReads = 0;
  const result = await normalizeOzonImportItems([strictCategoryItem({
    attributes: [{ id: 85, values: [{ value: "stale", dictionary_value_id: 126745801 }] }],
  })], {
    strictTypeMatch: true,
    categoryMatchPolicy: "SOURCE_CATEGORY_STRICT",
    sourceCategory: strictSourceCategory,
    currentCategoryMetadata: {
      descriptionCategoryId: 17031664,
      typeId: 971001,
      attributes: [{
        id: 85,
        complexId: 0,
        required: true,
        dictionaryId: 28732849,
        dictionaryValues: [{ id: 126745801, value: "Нет бренда" }],
      }],
    },
    getCategoryAttributes: async () => { attributeReads += 1; throw new Error("network forbidden"); },
    getCategoryAttributeValues: async () => { dictionaryReads += 1; throw new Error("network forbidden"); },
  });
  assert.equal(attributeReads, 0);
  assert.equal(dictionaryReads, 0);
  assert.deepEqual(result.items[0].attributes[0].values, [
    { value: "stale", dictionary_value_id: 126745801 },
  ]);
}

async function testTargetStoreValidatesDictionaryTypeCandidate() {
  const targetTree = [{
    description_category_id: 17039736,
    category_name: "Чайники",
    children: [{ type_id: 123456, type_name: "Заварочный чайник", children: [] }],
  }];
  const result = await normalize([
    collectedCategoryItem({
      offerId: "candidate-valid",
      descriptionCategoryId: 17039736,
      typeName: "Заварочный чайник",
      typeIdCandidate: 123456,
    }),
  ], {
    categoryMatchPolicy: "TARGET_STORE_EXACT",
    targetStoreId: "store-a",
    now: fixedNow,
    tree: targetTree,
  });

  assert.equal(result.items[0].description_category_id, 17039736);
  assert.equal(result.items[0].type_id, 123456);
  assert.deepEqual(result.categoryResolutions[0], {
    offerId: "candidate-valid",
    status: "MATCHED",
    method: "DICTIONARY_VALUE_ID",
    source: {
      descriptionCategoryId: 17039736,
      typeName: "Заварочный чайник",
      typeIdCandidate: 123456,
      path: [],
    },
    target: {
      storeId: "store-a",
      descriptionCategoryId: 17039736,
      typeId: 123456,
    },
    resolvedAt: "2026-08-01T00:00:00.000Z",
  });
}

async function testTargetStoreRejectsUnknownDictionaryTypeCandidate() {
  const result = await normalize([
    collectedCategoryItem({
      offerId: "candidate-missing",
      descriptionCategoryId: 17039736,
      typeName: "不存在的类型",
      typeIdCandidate: 999999,
    }),
  ], {
    categoryMatchPolicy: "TARGET_STORE_EXACT",
    targetStoreId: "store-a",
    now: fixedNow,
  });

  assert.equal(result.items.length, 0);
  assert.equal(result.categoryResolutions[0].status, "PENDING");
  assert.equal(result.categoryResolutions[0].reason, "TARGET_TYPE_NOT_FOUND");
  assert.equal(result.categoryResolutions[0].target, undefined);
}

async function testTargetStoreExactTextPolicy() {
  const targetTree = [{
    description_category_id: 17039736,
    children: [
      { type_id: 123456, type_name: "Заварочный чайник", children: [] },
      { type_id: 123457, type_name: "Электрический чайник", children: [] },
    ],
  }];
  const cases = [
    ["text-exact", "Заварочный чайник", "TYPE_NAME_EXACT", 123456],
    ["text-normalized", "заварочный—чайник", "TYPE_NAME_NORMALIZED", 123456],
  ];
  for (const [offerId, typeName, method, typeId] of cases) {
    const result = await normalize([
      collectedCategoryItem({ offerId, descriptionCategoryId: 17039736, typeName }),
    ], {
      categoryMatchPolicy: "TARGET_STORE_EXACT",
      targetStoreId: "store-a",
      now: fixedNow,
      tree: targetTree,
    });
    assert.equal(result.items[0].type_id, typeId);
    assert.equal(result.categoryResolutions[0].method, method);
  }
}

async function testTargetStoreExactPolicyRejectsPartialName() {
  const result = await normalize([
    collectedCategoryItem({
      offerId: "text-partial",
      descriptionCategoryId: 17031664,
      typeName: "Трековый",
    }),
  ], {
    categoryMatchPolicy: "TARGET_STORE_EXACT",
    targetStoreId: "store-a",
    now: fixedNow,
  });
  assert.equal(result.items.length, 0);
  assert.equal(result.categoryResolutions[0].reason, "TARGET_TYPE_NOT_FOUND");
}

async function testTargetStoreExactPolicyRejectsAmbiguousNormalizedName() {
  const ambiguousTree = [{
    description_category_id: 17039736,
    children: [
      { type_id: 123456, type_name: "Чайник-термос", children: [] },
      { type_id: 123457, type_name: "чайник термос", children: [] },
    ],
  }];
  const result = await normalize([
    collectedCategoryItem({
      offerId: "text-ambiguous",
      descriptionCategoryId: 17039736,
      typeName: "ЧАЙНИК ТЕРМОС",
    }),
  ], {
    categoryMatchPolicy: "TARGET_STORE_EXACT",
    targetStoreId: "store-a",
    now: fixedNow,
    tree: ambiguousTree,
  });
  assert.equal(result.items.length, 0);
  assert.equal(result.categoryResolutions[0].reason, "TARGET_TYPE_AMBIGUOUS");
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

async function testListingDraftTitleWinsBeforeSkuFallback() {
  const result = await normalize([{
    offer_id: "jz-test-2916074139",
    weight: 230, depth: 140, width: 150, height: 160,
    title: "Светильник с датчиком движения, 50 см, свет холодный, набор 2 штуки",
    scraped_sku: "2916074139",
    price: "100.00",
    images: ["https://cdn.example.test/title-fallback.jpg"],
    description_category_id: 17031664,
    type_id: 971001,
  }]);

  assert.equal(result.warnings.length, 0);
  assert.equal(result.items.length, 1);
  assert.equal(
    result.items[0].name,
    "Светильник с датчиком движения, 50 см, свет холодный, набор 2 штуки",
  );
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
      weight: 230, depth: 140, width: 150, height: 160,
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
  assert.equal(JSON.parse(byId.get(11254).values[0].value).content[0].widgetName, "raShowcase");
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
      { widgetName: "raTextBlock", text: { content: ["Сохранить второй блок"] } },
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
  assert.deepEqual(uploaded, JSON.parse(richContent));
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
  assert.equal(byId.get(23171).values.length, 1);
  const tags = byId.get(23171).values[0].value.split(" ");
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
  assert.deepEqual(byId.get(22508).values.map((value) => value.value), ["#светильник #LED"]);
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
    (error) => error.status === 422 && error.code === "ZONGZI_CATEGORY_DATA_INVALID" &&
      error.body?.operation === "REQUIRED_DICTIONARY_VALUE" && error.cause === null,
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

function requiredDictionaryItem(attributeId) {
  return {
    offer_id: `jz-category-error-${attributeId}`,
    name: "Category error item",
    price: "100.00",
    images: ["https://cdn.example.test/category-error.jpg"],
    description_category_id: 17031664,
    type_id: 971001,
    weight: 100,
    depth: 100,
    width: 100,
    height: 100,
    attributes: [{ id: attributeId, values: [{ value: "unknown required value" }] }],
  };
}

async function testCategoryDictionaryFetchErrorsPropagateWithoutLeakingCause() {
  for (const [status, code] of [[503, "ZONGZI_CATEGORY_VALUES_UNAVAILABLE"], [504, "ZONGZI_CATEGORY_VALUES_UNAVAILABLE"]]) {
    const source = new Error("未能从 Ozon 获取真实类目数据，请重试");
    source.status = status;
    source.code = code;
    source.body = { operation: "VALUES" };
    source.cause = null;
    await assert.rejects(
      () => normalizeOzonImportItems([requiredDictionaryItem(881)], {
        strictTypeMatch: false,
        getCategoryAttributes: async () => [...attrs, { id: 881, dictionary_id: 881, is_required: true, name: "Required dictionary" }],
        getCategoryAttributeValues: async () => { throw source; },
      }),
      (error) => error === source && error.status === status && error.code === code &&
        error.body.operation === "VALUES" && error.cause === null && !error.message.includes("local-key"),
    );
  }
}

async function testUnresolvedRequiredDictionaryUsesStableSafeCategoryError() {
  await assert.rejects(
    () => normalizeOzonImportItems([requiredDictionaryItem(882)], {
      strictTypeMatch: false,
      getCategoryAttributes: async () => [...attrs, { id: 882, dictionary_id: 882, is_required: true, name: "Required dictionary" }],
      getCategoryAttributeValues: async () => [],
    }),
    (error) => error.status === 422 && error.code === "ZONGZI_CATEGORY_DATA_INVALID" &&
      error.message === "必填字典属性未匹配到 Ozon 字典值，请检查后重试" &&
      error.body?.operation === "REQUIRED_DICTIONARY_VALUE" && error.cause === null,
  );
}

async function testNonCategoryFailureKeepsWarningWhenStrictTypeMatchIsFalse() {
  const result = await normalizeOzonImportItems([{ offer_id: "non-category-warning" }], { strictTypeMatch: false });
  assert.equal(result.items.length, 0);
  assert.equal(result.warnings.length, 1);
}

await testFollowSellPayloadToOzonImportItem();
await testListingDraftTitleWinsBeforeSkuFallback();
await testStrictTypeMatchFailsFast();
await testSourceCategoryStrictUsesOnlyFrozenUniqueMatch();
await testSourceCategoryStrictRequiresEveryRequiredAttribute();
await testSourceCategoryStrictChecksRequiredComplexAttributes();
await testSourceCategoryStrictValidatesCurrentDictionaryIdsWithSafeFailure();
await testSourceCategoryStrictAcceptsOnlyAnExactCurrentDictionaryId();
await testSourceCategoryStrictMakesImmutableSourceAttributesAuthoritative();
await testSourceCategoryStrictConsumesClosedMetadataWithoutNetworkReads();
await testTargetStoreValidatesDictionaryTypeCandidate();
await testTargetStoreRejectsUnknownDictionaryTypeCandidate();
await testTargetStoreExactTextPolicy();
await testTargetStoreExactPolicyRejectsPartialName();
await testTargetStoreExactPolicyRejectsAmbiguousNormalizedName();
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
await testCategoryDictionaryFetchErrorsPropagateWithoutLeakingCause();
await testUnresolvedRequiredDictionaryUsesStableSafeCategoryError();
await testNonCategoryFailureKeepsWarningWhenStrictTypeMatchIsFalse();

console.log("ozon import normalizer ok");


test("source OZN barcodes cannot reach either import barcode carrier", async () => {
  for (const sku of ["1553617193", "3376550236", "1553617193-legacy"]) {
    const result = await normalize([strictCategoryItem({
      barcode: "OZN" + sku,
      attributes: [{ id: 7822, values: [{ value: "OZN" + sku }] }],
      _bundleItem: { barcode: "OZN" + sku },
      _sourceVariant: { attributes: [{ key: "7822", value: "OZN" + sku }] },
    })], { strictTypeMatch: true });
    assert.equal(Object.hasOwn(result.items[0], "barcode"), false);
    assert.equal(result.items[0].attributes.some(attribute => attribute.id === 7822), false);
  }
});

test("real seller barcodes survive filtering mixed source barcode values", async () => {
  const result = await normalize([strictCategoryItem({
    barcode: "4600000000001",
    attributes: [{ id: 7822, values: [{ value: "OZN1553617193" }, { value: "4600000000001" }] }],
    _sourceVariant: { attributes: [{ key: "7822", value: "OZN1553617193" }] },
  })], { strictTypeMatch: true });
  assert.equal(result.items[0].barcode, "4600000000001");
  assert.deepEqual(result.items[0].attributes.find(attribute => attribute.id === 7822).values,
    [{ value: "4600000000001" }]);
});

test("a collected dictionary ID remains usable when display text is absent", async () => {
  const result = await normalize([strictCategoryItem({
    attributes: [],
    _sourceVariant: { attributes: [{ id: 777, values: [{ dictionary_value_id: 42 }] }] },
  })], { strictTypeMatch: true, attrs: [...attrs, { id: 777, dictionary_id: 700 }] });
  assert.deepEqual(result.items[0].attributes.find(attribute => attribute.id === 777)?.values,
    [{ dictionary_value_id: 42 }]);
});

test("dictionary values absent from the first page are resolved by exact search", async () => {
  const result = await normalize([strictCategoryItem({
    attributes: [{ id: 777, values: [{ value: "Late dictionary value" }] }],
  })], {
    strictTypeMatch: true,
    attrs: [...attrs, { id: 777, dictionary_id: 700 }],
    attributeValues: { 777: [{ id: 1, value: "First dictionary value" }] },
    searchCategoryAttributeValuesExact: async (categoryId, typeId, attributeId, value) => {
      assert.deepEqual([categoryId, typeId, attributeId, value], [17031664, 971001, 777, "Late dictionary value"]);
      return [{ id: 1001, value: "Late dictionary value" }];
    },
  });
  assert.deepEqual(result.items[0].attributes.find(attribute => attribute.id === 777)?.values,
    [{ value: "Late dictionary value", dictionary_value_id: 1001 }]);
});

test("valid nested rich content survives an already truncated top-level copy", async () => {
  const rich = JSON.stringify({ content: [{ widgetName: "raTextBlock", text: { content: ["Long description ".repeat(80).trim()] } }], version: 0.3 });
  const result = await normalize([strictCategoryItem({
    richContent: rich.slice(0, 500),
    _sourceVariant: { richContent: rich, attributes: [] },
  })], { strictTypeMatch: true });
  assert.deepEqual(JSON.parse(result.items[0].attributes.find(attribute => attribute.id === 11254)?.values[0].value || "null"),
    JSON.parse(rich));
});

test("canonical video groups retain separate entries and category filtering", async () => {
  const groups = ["one", "two"].map(name => ({ attributes: [
    { id: 100001, complex_id: 77, values: [{ value: "https://cdn.example.test/" + name + ".mp4" }] },
    { id: 99999, complex_id: 77, values: [{ value: "not allowed" }] },
  ] }));
  const result = await normalize([strictCategoryItem({ complex_attributes: groups })], { strictTypeMatch: true });
  assert.deepEqual(result.items[0].complex_attributes, [
    { attributes: [{ id: 100001, complex_id: 77, values: [{ value: "https://cdn.example.test/one.mp4" }] }] },
    { attributes: [{ id: 100001, complex_id: 77, values: [{ value: "https://cdn.example.test/two.mp4" }] }] },
  ]);
});

test("source complex attributes go to the complex carrier only", async () => {
  const result = await normalize([strictCategoryItem({
    _sourceVariant: { attributes: [{ id: 100001, complex_id: 77, values: [{ value: "https://cdn.example.test/source.mp4" }] }] },
  })], { strictTypeMatch: true });
  assert.equal(result.items[0].attributes.some(attribute => attribute.id === 100001), false);
  assert.deepEqual(result.items[0].complex_attributes, [{
    attributes: [{ id: 100001, complex_id: 77, values: [{ value: "https://cdn.example.test/source.mp4" }] }],
  }]);
});


test("Chinese Seller values resolve by platform dictionary ID while Russian values stay intact", async () => {
  const result = await normalize([strictCategoryItem({
    attributes: [],
    _sourceVariant: { attributes: [
      { key: "8385", value: "暖白色" }, { key: "6324", value: "机械" },
      { key: "10096", value: "Черно-серый" }, { key: "4400", value: "12V/24V" },
    ] },
  })], {
    strictTypeMatch: true,
    attrs: [...attrs, ...[8385, 6324, 10096, 4400].map(id => ({ id, dictionary_id: id }))],
    // Test dictionary IDs model the platform's shared IDs, not a translation table used by production.
    attributeValues: {
      8385: [{ id: 101, value: "Теплый белый" }], 6324: [{ id: 102, value: "Механический" }],
      10096: [{ id: 103, value: "Черно-серый" }], 4400: [{ id: 104, value: "12В/24В" }],
    },
    localizedAttributeValues: {
      8385: [{ id: 101, value: "暖白色" }], 6324: [{ id: 102, value: "机械" }],
      10096: [{ id: 103, value: "黑灰色" }], 4400: [{ id: 104, value: "12V/24V" }],
    },
  });
  for (const [id, dictionaryId, value] of [
    [8385, 101, "Теплый белый"], [6324, 102, "Механический"],
    [10096, 103, "Черно-серый"], [4400, 104, "12В/24В"],
  ]) assert.deepEqual(result.items[0].attributes.find(attribute => attribute.id === id)?.values,
    [{ value, dictionary_value_id: dictionaryId }]);
});


test("source HTML description retains only existing paragraph and break tags in 4191 without inventing rich JSON", async () => {
  const result = await normalize([strictCategoryItem({
    scraped_description: "Short flattened copy",
    _sourceVariant: { attributes: [], descriptionHTML: '<p class="source">Первый <b>абзац</b>.</p><p>Второй<br>Продолжение.</p>' },
  })], { strictTypeMatch: true });
  assert.equal(result.items[0].attributes.find(attribute => attribute.id === 4191)?.values[0].value,
    "<p>Первый абзац.</p><p>Второй<br/>Продолжение.</p>");
  assert.equal(result.items[0].attributes.some(attribute => attribute.id === 11254), false);
});

test("existing JSON rich content remains independent of the source HTML description", async () => {
  const rich = JSON.stringify({ content: [{ widgetName: "raTextBlock", text: { content: ["Existing rich text"] } }], version: 0.3 });
  const result = await normalize([strictCategoryItem({
    descriptionHTML: "Первый абзац.<br/><br/>Второй абзац.", richContent: rich,
  })], { strictTypeMatch: true });
  assert.equal(result.items[0].attributes.find(attribute => attribute.id === 4191)?.values[0].value,
    "Первый абзац.<br/><br/>Второй абзац.");
  assert.deepEqual(JSON.parse(result.items[0].attributes.find(attribute => attribute.id === 11254)?.values[0].value || "null"), JSON.parse(rich));
});

test("description conversion keeps list items, table cells and headings separated", async () => {
  const result = await normalize([strictCategoryItem({
    descriptionHTML: '<h2>Основные характеристики</h2><table><tr><th>Параметр</th><th>Значение</th></tr><tr><td>Диапазон частот</td><td>9 кГц – 6,4 ГГц</td></tr></table><ul class="features"><li>Два канала</li><li>USB Type-C</li></ul>',
  })], { strictTypeMatch: true });
  const description = result.items[0].attributes.find(attribute => attribute.id === 4191)?.values[0].value;
  assert.match(description, /Основные характеристики<br\/>/);
  assert.match(description, /Параметр Значение/);
  assert.match(description, /Диапазон частот 9 кГц – 6,4 ГГц/);
  assert.match(description, /<ul><li>Два канала<\/li><li>USB Type-C<\/li><\/ul>/);
  assert.doesNotMatch(description, /характеристикиПараметр|ПараметрЗначение|каналаUSB|class=/);
});

test("an unusable JSON-LD fallback is retained in source but omitted from submission with an explanation", async () => {
  const description = 'Основные характеристикиПараметрЗначениеДиапазон частот. Совместим с фильтрамиосциллографамилабораторными системами.';
  const rich = JSON.stringify({ content: [{ widgetName: "raShowcase", blocks: [{ img: { src: "https://cdn.example.test/description.jpg" } }] }], version: 0.3 });
  const source = strictCategoryItem({ scraped_description: description, description, richContent: rich,
    contentDiagnostics: { description: { source: "json_ld", status: "provided" } } });
  const before = structuredClone(source);
  const result = await normalize([source], { strictTypeMatch: true });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].attributes.some(attribute => attribute.id === 4191), false);
  assert.deepEqual(JSON.parse(result.items[0].attributes.find(attribute => attribute.id === 11254)?.values[0].value), JSON.parse(rich));
  assert.match(result.warnings.join(" "), /简介.*机器摘要.*27.*原文.*保留.*未.*提交/);
  assert.deepEqual(source, before);
});

test("same-SKU Seller description is preferred to a malformed JSON-LD fallback", async () => {
  const result = await normalize([strictCategoryItem({
    scraped_description: 'Основные характеристикиПараметрЗначениеДиапазон частот',
    contentDiagnostics: { description: { source: "json_ld", status: "provided" } },
    _sourceVariant: { attributes: [{ id: 4191, values: [{ value: '<p>Генератор с двумя каналами.</p>' }] }] },
  })], { strictTypeMatch: true });
  assert.equal(result.items[0].attributes.find(attribute => attribute.id === 4191)?.values[0].value, '<p>Генератор с двумя каналами.</p>');
  assert.doesNotMatch(result.warnings.join(" "), /机器摘要/);
});

test("ordered description lists retain a supported list container", async () => {
  const result = await normalize([strictCategoryItem({ descriptionHTML: '<ol><li>Первый режим</li><li>Второй режим</li></ol>' })], { strictTypeMatch: true });
  assert.equal(result.items[0].attributes.find(attribute => attribute.id === 4191)?.values[0].value,
    '<ul><li>Первый режим</li><li>Второй режим</li></ul>');
});

test("long translated JSON-LD text still reaches the existing Russian product language gate", async () => {
  await assert.rejects(normalize([strictCategoryItem({
    scraped_description: '这是一段翻译后的中文商品简介不能因为文字较长而跳过原有的俄语检查要求',
    contentDiagnostics: { description: { source: 'json_ld', status: 'provided' } },
  })], { strictTypeMatch: true }), { code: 'ZONGZI_PRODUCT_RUSSIAN_REQUIRED' });
});

test("a valid JSON-LD fallback retains technical terms and a manual revision overrides its historical HTML", async () => {
  for (const input of [
    { scraped_description: 'RF-генератор SL6 Pro. Два канала CH1/CH2, управление через USB Type-C и SCPI.', contentDiagnostics: { description: { source: 'json_ld', status: 'provided' } } },
    { scraped_description: 'Генератор с двумя каналами.', descriptionHTML: 'характеристикиПараметрЗначениеДиапазон', contentDiagnostics: { description: { source: 'manual', status: 'provided' } } },
  ]) {
    const result = await normalize([strictCategoryItem(input)], { strictTypeMatch: true });
    assert.equal(result.items[0].attributes.find(attribute => attribute.id === 4191)?.values[0].value, input.scraped_description);
    assert.doesNotMatch(result.warnings.join(" "), /机器摘要/);
  }
});


test("two Chinese color SKUs resolve their own candidate subsets", async () => {
  const requests = [];
  const result = await normalizeOzonImportItems([
    strictCategoryItem({ offer_id: "gray-sku", attributes: [{ id: 10096, values: [{ value: "灰" }] }] }),
    strictCategoryItem({ offer_id: "black-gray-sku", attributes: [{ id: 10096, values: [{ value: "黑灰" }] }] }),
  ], {
    strictTypeMatch: true,
    getCategoryTree: async () => tree,
    getCategoryAttributes: async () => [{ id: 10096, dictionary_id: 10096 }],
    getCategoryAttributeValues: async (_category, _type, _attribute, options = {}) => {
      if (options.language !== "ZH_HANS") return [{ id: 700, value: "Серый" }, { id: 61607, value: "черно-серый" }];
      const candidates = options.matchCandidates.map(candidate => candidate.value);
      requests.push(candidates);
      return [{ id: 700, value: "灰" }, { id: 61607, value: "黑灰" }].filter(value => candidates.includes(value.value));
    },
  });
  assert.deepEqual(result.items.map(item => item.attributes[0].values), [
    [{ value: "Серый", dictionary_value_id: 700 }],
    [{ value: "черно-серый", dictionary_value_id: 61607 }],
  ]);
  assert.deepEqual(requests, [["灰"], ["黑灰"]]);
});

test("optional dictionary fallback outages preserve already resolved values", async () => {
  for (const failedLookup of ["localized", "search"]) {
    const unavailable = Object.assign(new Error("fallback unavailable"), { code: "ZONGZI_CATEGORY_VALUES_UNAVAILABLE" });
    const result = await normalize([strictCategoryItem({
      attributes: [{ id: 777, values: [{ value: "Known RU" }, { value: "未知值" }] }],
    })], {
      strictTypeMatch: true,
      attrs: [...attrs, { id: 777, dictionary_id: 700, required: false }],
      attributeValues: { 777: [{ id: 1, value: "Known RU" }] },
      localizedAttributeValuesError: failedLookup === "localized" ? { 777: unavailable } : {},
      searchCategoryAttributeValuesExact: async () => {
        if (failedLookup === "search") throw unavailable;
        return [];
      },
    });
    assert.equal(result.items.length, 1);
    assert.deepEqual(result.items[0].attributes.find(attribute => attribute.id === 777)?.values,
      [{ value: "Known RU", dictionary_value_id: 1 }]);
  }
});

test("required dictionary fallback outages keep submission failure and preview warning semantics", async () => {
  const unavailable = Object.assign(new Error("fallback unavailable"), { code: "ZONGZI_CATEGORY_VALUES_UNAVAILABLE" });
  const item = strictCategoryItem({ attributes: [{ id: 777, values: [{ value: "未知值" }] }] });
  const options = {
    strictTypeMatch: true,
    attrs: [...attrs, { id: 777, dictionary_id: 700, required: true, name: "Required fixture" }],
    attributeValues: { 777: [{ id: 1, value: "Known RU" }] },
    localizedAttributeValuesError: { 777: unavailable },
  };
  await assert.rejects(normalize([item], options), { code: "ZONGZI_CATEGORY_DATA_INVALID", status: 422 });
  const preview = await normalize([item], { ...options, allowUnresolvedRequiredDictionaryValues: true });
  assert.equal(preview.items.length, 1);
  assert.equal(preview.warnings.length, 1);
  assert.equal(preview.items[0].attributes.some(attribute => attribute.id === 777), false);
});


test("optional unmapped values produce per-item warnings while retaining supplied dictionary IDs", async () => {
  for (const unavailable of [false, true]) {
    const result = await normalizeOzonImportItems([strictCategoryItem({ scraped_sku: "warning-sku", offer_id: "warning-offer", attributes: [
      { id: 777, values: [{ dictionary_value_id: 42 }, { value: "未匹配颜色" }] },
    ] })], { strictTypeMatch: true, getCategoryAttributes: async () => [{ id: 777, name: "Цвет", dictionary_id: 700 }],
      getCategoryAttributeValues: async () => {
        if (unavailable) throw Object.assign(new Error("private upstream detail"), { code: "ZONGZI_CATEGORY_VALUES_UNAVAILABLE", status: 502 });
        return [];
      },
    });
    assert.deepEqual(result.items[0].attributes[0].values, [{ dictionary_value_id: 42 }]);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /warning-sku.*777.*未匹配颜色/);
    assert.match(result.warnings[0], /未上传/);
    assert.doesNotMatch(result.warnings[0], /private upstream/);
    assert.deepEqual(result.itemWarnings, [{ offerId: "warning-offer", warnings: result.warnings }]);
  }
});

test("ID-only single and multi values bypass an unavailable dictionary", async () => {
  const result = await normalizeOzonImportItems([strictCategoryItem({ attributes: [
    { id: 777, values: [{ dictionary_value_id: 42 }, { dictionary_value_id: 43 }] },
    { id: 778, values: [{ dictionary_value_id: 44 }] },
  ] })], { strictTypeMatch: true, getCategoryAttributes: async () => [777, 778].map(id => ({ id, dictionary_id: 700 })),
    getCategoryAttributeValues: async () => { throw new Error("No dictionary lookup is needed for supplied IDs"); },
  });
  assert.deepEqual(result.items[0].attributes.map(attribute => attribute.values), [[{ dictionary_value_id: 42 }, { dictionary_value_id: 43 }], [{ dictionary_value_id: 44 }]]);
  assert.deepEqual(result.warnings, []);
});

test("optional dictionary warnings never hide account/store authorization failures", async () => {
  for (const stage of ["primary", "localized", "search"]) {
    const denied = Object.assign(new Error("denied"), { code: "ZONGZI_CATEGORY_STORE_FORBIDDEN", status: 403 });
    await assert.rejects(normalizeOzonImportItems([strictCategoryItem({ attributes: [{ id: 777, values: [{ value: "unknown" }] }] })], {
      strictTypeMatch: true, getCategoryAttributes: async () => [{ id: 777, dictionary_id: 700 }],
      getCategoryAttributeValues: async (_category, _type, _id, options = {}) => {
        if (stage === (options.language === "ZH_HANS" ? "localized" : "primary")) throw denied;
        return [];
      },
      searchCategoryAttributeValuesExact: async () => { throw denied; },
    }), caught => caught === denied);
  }
});


test("authoritative empty values survive item/source/bundle precedence without reviving old IDs", async () => {
  const known = id => ({ values: [{ dictionary_value_id: id }] });
  const cases = [
    { name: "current item clears stale source and bundle", attributes: [{ id: 777, values: [] }], source: [{ key: "777", ...known(42) }], bundle: [{ attribute_id: 777, ...known(43) }], expected: [] },
    { name: "current source clears its historical bundle", attributes: [], source: [{ key: "777", value: "stale", values: [] }], bundle: [{ attribute_id: 777, ...known(43) }], expected: [] },
    { name: "current item retains priority over an empty source", attributes: [{ id: 777, ...known(44) }], source: [{ key: "777", values: [] }], bundle: [{ attribute_id: 777, ...known(43) }], expected: [44] },
    { name: "structured source retains its IDs over historical bundle", attributes: [], source: [{ key: "777", ...known(42) }], bundle: [{ attribute_id: 777, ...known(43) }], expected: [42] },
  ];
  for (const row of cases) {
    const result = await normalizeOzonImportItems([strictCategoryItem({ attributes: row.attributes,
      _sourceVariant: { attributes: row.source, _bundleItem: { attributes: row.bundle } },
    })], { strictTypeMatch: true, getCategoryAttributes: async () => [{ id: 777, dictionary_id: 700 }],
      getCategoryAttributeValues: async () => { throw new Error("supplied IDs require no lookup"); } });
    assert.deepEqual((result.items[0].attributes || []).filter(attr => attr.id === 777).flatMap(attr => attr.values.map(value => value.dictionary_value_id)), row.expected, row.name);
  }
});

test("source strict policy also honors a cleared source while compatibility text cannot revive rich JSON", async () => {
  const rich = JSON.stringify({ version: 0.3, content: [{ widgetName: "raTextBlock", text: { content: ["Old rich"] } }] });
  const result = await normalizeOzonImportItems([strictCategoryItem({ attributes: [{ id: 777, values: [{ dictionary_value_id: 44 }] }],
    _sourceVariant: { attributes: [{ key: "777", values: [] }, { key: "11254", value: rich, values: [] }] },
  })], { strictTypeMatch: true, categoryMatchPolicy: "SOURCE_CATEGORY_STRICT", sourceCategory: strictSourceCategory,
    currentCategoryMetadata: strictMetadata([{ id: 777 }, { id: 11254 }]) });
  assert.equal((result.items[0].attributes || []).some(attr => [777, 11254].includes(attr.id)), false);
});


test("localized collection label yields this SKU's Russian title without changing explicit names or reviving cleared values", async () => {
  const nativeTitle = "Уличный настенный светильник,220V IP65 Материал из алюминиевого сплава";
  const raw = { offer_id: "jz-2102714113-01", scraped_sku: "2102714113", name: "Lison 路灯",
    description_category_id: 17031664, type_id: 971001, price: "123.45", currency_code: "CNY",
    weight: 490, depth: 330, width: 40, height: 40, images: ["https://images.example.test/generated.jpg"],
    _sourceVariant: { attributes: [{key: "4180", value: "stale title", values: [{value: nativeTitle}]}] } };
  const original = structuredClone(raw);
  const result = (await normalize([raw], {strictTypeMatch:true})).items[0];
  assert.equal(result.name, nativeTitle);
  assert.equal(result.attributes.find(a=>a.id===4180).values[0].value, nativeTitle);
  assert.equal(result.offer_id, raw.offer_id);
  assert.deepEqual(result.images, raw.images);
  assert.deepEqual(raw, original);
  for (const name of ["Светильник с изменённым названием", "Lison XR-20"]) {
    assert.equal((await normalize([{...raw,name}], {strictTypeMatch:true})).items[0].name, name);
  }
  const cleared = {...raw, attributes:[{id:4180,values:[]}]};
  await assert.rejects(normalize([cleared], {strictTypeMatch:true}), /俄语.*name|name.*俄语/,
    "an explicitly cleared title must not be revived from collected evidence");
  const other = {...raw, offer_id:"other-sku", _sourceVariant:{attributes:[{key:4180,values:[{value:"Другой светильник, 60 см"}]}]}};
  assert.deepEqual((await normalize([raw,other],{strictTypeMatch:true})).items.map(item=>item.name),[nativeTitle,"Другой светильник, 60 см"]);
});


test("Russian source prose replaces localized prose; dictionary IDs carry facts without Chinese labels", async () => {
  const rich = JSON.stringify({version:0.3,content:[{widgetName:"raTextBlock",text:{content:["Русское описание товара"]}}]});
  const raw = {offer_id:"ru-source",name:"Светильник",description_category_id:17031664,type_id:971001,
    weight:490,depth:330,width:40,height:40,price:"100.00",images:["https://cdn.test/one.jpg"],
    scraped_description:"中文描述",richContent:JSON.stringify({version:0.3,content:[{widgetName:"raTextBlock",text:{content:["中文详情"]}}]}),
    attributes:[{id:777,values:[{dictionary_value_id:42,value:"暖白色"}]}],
    _sourceVariant:{description:"Русское описание товара",attributes:[{key:"11254",values:[{value:rich}]}]}};
  const result=(await normalize([raw],{strictTypeMatch:true,attrs:[...attrs,{id:777,dictionary_id:77}]})).items[0];
  assert.equal(result.attributes.find(a=>a.id===4191).values[0].value,"Русское описание товара");
  assert.deepEqual(JSON.parse(result.attributes.find(a=>a.id===11254).values[0].value),JSON.parse(rich));
  assert.deepEqual(result.attributes.find(a=>a.id===777).values,[{dictionary_value_id:42}]);
  for(const [field, patch] of [
    ["name",{name:"中文名称"}],
    ["4191",{scraped_description:"中文描述",_sourceVariant:{}}],
    ["11254",{richContent:raw.richContent,_sourceVariant:{}}],
    ["777",{attributes:[{id:777,values:[{value:"中文自由属性"}]}]}],
  ]) {
    await assert.rejects(normalize([{...raw,scraped_description:"",richContent:"",_sourceVariant:{},attributes:[],...patch}],
      {strictTypeMatch:true,attrs:[...attrs,{id:777},{id:21837},{id:21841}]}), error=>
        error.code==="ZONGZI_PRODUCT_RUSSIAN_REQUIRED" && error.message.includes(field));
  }
  const withChineseVideoNames = (await normalize([{...raw,scraped_description:"",richContent:"",_sourceVariant:{},attributes:[],
    videos:[{url:"https://cdn.test/video.mp4",name:"1月16日.mp4"},{url:"https://cdn.test/second.mp4",title:"安装演示"}]}],
    {strictTypeMatch:true,attrs:[...attrs,{id:21837},{id:21841}]})).items[0];
  assert.deepEqual(withChineseVideoNames.complex_attributes[0].attributes.find(attribute=>attribute.id===21837).values,
    [{value:"1月16日.mp4"},{value:"安装演示"}]);
});

test("content coverage retains supplied optional attributes without calling the whole category template missing", async () => {
  const result = await normalize([strictCategoryItem({
    attributes: [{ id: 7001, values: [{ value: "Сталь" }, { value: "Алюминий" }] }],
    complex_attributes: [{ attributes: [{ id: 7002, complex_id: 77, values: [{ value: "Комплект 2 шт." }] }] }],
    contentDiagnostics: { description: { status: "not_provided" } },
  })], { strictTypeMatch: true, attrs: [
    ...attrs, { id: 7001, name: "Материал", is_required: false },
    { id: 7002, complex_id: 77, name: "Комплект", is_required: false },
    { id: 7003, name: "Страна-изготовитель", is_required: false },
  ] });
  assert.deepEqual(result.items[0].attributes.find(attribute => attribute.id === 7001)?.values,
    [{ value: "Сталь" }, { value: "Алюминий" }]);
  assert.deepEqual(result.items[0].complex_attributes,
    [{ attributes: [{ id: 7002, complex_id: 77, values: [{ value: "Комплект 2 шт." }] }] }]);
  assert.doesNotMatch(result.warnings.join(" "), /7003|Страна-изготовитель|另有.*可选属性未提交/);
});

test("dedicated logistics and gallery fields are not reported as missing ordinary attributes", async () => {
  const result = await normalize([strictCategoryItem({
    offer_id: "jz-1602438352", weight: 102, depth: 317, width: 304, height: 41,
    images: ["https://cdn.example.test/one.jpg", "https://cdn.example.test/two.jpg"],
    contentDiagnostics: { description: { status: "provided" } },
    description: "Описание исходного товара",
  })], { strictTypeMatch: true, attrs: [
    { id: 4191 }, { id: 4497, name: "Вес в упаковке", is_required: false },
    ...[9454, 9455, 9456, 4194, 4195].map(id => ({ id, is_required: false })),
  ] });
  assert.equal(result.items[0].weight, 102);
  assert.deepEqual([result.items[0].depth, result.items[0].width, result.items[0].height], [317, 304, 41]);
  assert.deepEqual(result.items[0].images, ["https://cdn.example.test/one.jpg", "https://cdn.example.test/two.jpg"]);
  assert.doesNotMatch(result.warnings.join(" "), /4497|9454|9455|9456|4194|4195|Вес в упаковке/);
});

test("saved structured media outside the accepted destination produces a source-specific warning", async () => {
  const source = strictCategoryItem({
    _sourceVariant: {
      attributes: [],
      complex_attributes: [{ attributes: [
        { id: 21841, complex_id: 100001, values: [{ value: "https://cdn.example.test/source.mp4" }] },
        { id: 21845, complex_id: 100002, values: [{ value: "https://cdn.example.test/cover.mp4" }] },
      ] }],
    },
  });
  const result = await normalize([source], { strictTypeMatch: true, attrs: [{ id: 4191 }] });
  assert.equal(result.items[0].complex_attributes, undefined);
  assert.match(result.warnings.join(" "), /普通视频.*已保存.*当前类目.*未提交/);
  assert.match(result.warnings.join(" "), /封面视频.*已保存.*当前类目.*未提交/);
});

test("media coverage verifies the complex destination instead of accepting the same ID in an ordinary field", async () => {
  const result = await normalize([strictCategoryItem({
    attributes: [{ id: 21841, values: [{ value: "https://cdn.example.test/source.mp4" }] }],
    contentDiagnostics: { videos: { status: "provided" } },
  })], { strictTypeMatch: true, attrs: [{ id: 21841, complex_id: 100001 }, { id: 21837, complex_id: 100001 }] });
  assert.match(result.warnings.join(" "), /普通视频.*未.*(?:请求|提交)/);
});

test("incomplete historical content diagnostics stay unverified and distinguish captured values from missing reads", async () => {
  const result = await normalize([strictCategoryItem({
    contentDiagnostics: {
      description: { status: "not_provided" },
      richContent: { status: "read_failed", message: "HTTP 503" },
      videos: { status: "provided" },
      videoCoverUrl: { status: "unverified" },
    },
  })], { strictTypeMatch: true, attrs: [...attrs, { id: 21841, complex_id: 100001 }, { id: 21845, complex_id: 100002 }] });
  const messages = result.warnings.join(" ");
  assert.match(messages, /简介.*源未提供/);
  assert.match(messages, /富内容.*读取失败.*503/);
  assert.match(messages, /普通视频.*采集时已提供.*未提交/);
  assert.match(messages, /颜色样本.*未记录来源状态.*待核实/);
  assert.match(messages, /封面视频.*待核实/);
  assert.doesNotMatch(messages, /颜色样本源未提供/);
});

test("explicitly cleared media cannot be restored from stale canonical or structured source values", async () => {
  const rich = JSON.stringify({ version: 0.3, content: [{ widgetName: "raTextBlock", text: { content: ["Старое описание"] } }] });
  const result = await normalize([strictCategoryItem({
    richContent: "", videos: [], color_image: "", videoCoverUrl: "",
    contentDiagnostics: Object.fromEntries(["richContent", "videos", "color_image", "videoCoverUrl"]
      .map(field => [field, { status: "not_provided", source: "manual" }])),
    _sourceVariant: {
      richContent: rich, videos: [{ url: "https://cdn.example.test/old.mp4" }],
      color_image: "https://cdn.example.test/old.jpg", videoCoverUrl: "https://cdn.example.test/old-cover.mp4",
      attributes: [{ key: "11254", values: [{ value: rich }] }],
      complex_attributes: [{ attributes: [
        { id: 21841, complex_id: 100001, values: [{ value: "https://cdn.example.test/structured.mp4" }] },
        { id: 21837, complex_id: 100001, values: [{ value: "Старое видео" }] },
        { id: 21845, complex_id: 100002, values: [{ value: "https://cdn.example.test/structured-cover.mp4" }] },
      ] }],
    },
  })], { strictTypeMatch: true, attrs: [...attrs, { id: 21841 }, { id: 21837 }, { id: 21845 }] });
  assert.equal((result.items[0].attributes || []).some(attribute => attribute.id === 11254), false);
  assert.equal(result.items[0].complex_attributes, undefined);
  assert.equal(result.items[0].color_image, undefined);
  assert.doesNotMatch(result.warnings.join(" "), /富内容源未提供|普通视频源未提供|颜色样本源未提供|封面视频源未提供/);
});

test("partly submitted video lists still report the source links omitted by the import limit", async () => {
  const videos = Array.from({ length: 6 }, (_, index) => ({ url: `https://cdn.example.test/video-${index + 1}.mp4` }));
  const result = await normalize([strictCategoryItem({ videos })], { strictTypeMatch: true,
    attrs: [...attrs, { id: 21841, complex_id: 100001 }, { id: 21837, complex_id: 100001 }],
  });
  assert.deepEqual(result.items[0].complex_attributes.flatMap(group => group.attributes)
    .find(attribute => attribute.id === 21841)?.values.map(value => value.value), [
    "https://cdn.example.test/video-1.mp4", "https://cdn.example.test/video-2.mp4",
    "https://cdn.example.test/video-3.mp4", "https://cdn.example.test/video-4.mp4",
    "https://cdn.example.test/video-5.mp4",
  ]);
  assert.match(result.warnings.join(" "), /普通视频.*1.*未.*(?:请求|提交)/);
});

test("manual description clearing is not mislabeled as source content lost in submission", async () => {
  const result = await normalize([strictCategoryItem({
    scraped_description: "", descriptionHTML: "<p>Старое описание</p>",
    contentDiagnostics: { description: { source: "manual", status: "not_provided" } },
    _sourceVariant: { attributes: [{ key: "4191", values: [{ value: "Старое описание Seller" }] }] },
  })], { strictTypeMatch: true });
  assert.equal(result.items[0].attributes.some(attribute => attribute.id === 4191), false);
  assert.match(result.warnings.join(" "), /简介.*手动清空/);
  assert.doesNotMatch(result.warnings.join(" "), /简介.*已保存.*未进入/);
});

test("historical empty media defaults preserve same-SKU Seller content and report their unknown edit intent", async () => {
  const rich = JSON.stringify({ version: 0.3, content: [{ widgetName: "raTextBlock", text: { content: ["Сохранённое описание Seller"] } }] });
  const result = await normalize([strictCategoryItem({
    richContent: "", videos: [], color_image: "", videoCoverUrl: "",
    contentDiagnostics: { description: { status: "not_provided", source: "json_ld" } },
    _sourceVariant: {
      color_image: "https://cdn.example.test/saved-color.jpg",
      attributes: [{ key: "11254", values: [{ value: rich }] }],
      complex_attributes: [{ attributes: [
        { id: 21841, complex_id: 100001, values: [{ value: "https://cdn.example.test/saved.mp4" }] },
        { id: 21837, complex_id: 100001, values: [{ value: "Сохранённое видео" }] },
        { id: 21845, complex_id: 100002, values: [{ value: "https://cdn.example.test/saved-cover.mp4" }] },
      ] }],
    },
  })], { strictTypeMatch: true, attrs: [...attrs, { id: 21841 }, { id: 21837 }, { id: 21845 }] });
  assert.deepEqual(JSON.parse(result.items[0].attributes.find(attribute => attribute.id === 11254)?.values[0].value || "null"), JSON.parse(rich));
  const complex = result.items[0].complex_attributes.flatMap(group => group.attributes);
  assert.equal(complex.find(attribute => attribute.id === 21841)?.values[0].value, "https://cdn.example.test/saved.mp4");
  assert.equal(complex.find(attribute => attribute.id === 21845)?.values[0].value, "https://cdn.example.test/saved-cover.mp4");
  assert.equal(result.items[0].color_image, "https://cdn.example.test/saved-color.jpg");
  for (const label of ["富内容", "普通视频", "颜色样本", "封面视频"]) {
    assert.match(result.warnings.join(" "), new RegExp(`${label}历史空值.*待核实.*保留`));
  }
});
