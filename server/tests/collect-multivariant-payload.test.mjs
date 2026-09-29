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
    categoryResolution: {
      status: "MATCHED",
      method: "MANUAL",
      source: { descriptionCategoryId: 17000001, typeIdCandidate: 910001 },
      target: {
        storeId: "target-store",
        descriptionCategoryId: 17999999,
        typeId: 919999,
      },
    },
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

const rawItems = testExports.buildCollectBoxListingItems(collected, "target-store");
assert.equal(rawItems.length, 2);
assert.equal(rawItems[0]._sourceVariant, firstSource);
assert.equal(rawItems[1]._sourceVariant, secondSource);
assert.equal(rawItems[0].scraped_model_name, "shared-model-name");
assert.equal(rawItems[1].scraped_model_name, "shared-model-name");
assert.equal(rawItems[0].description_category_id, 17999999);
assert.equal(rawItems[1].description_category_id, 17999999, "siblings inherit only the explicit target marker");
assert.equal(rawItems[0].type_id, 919999);
assert.equal(rawItems[1].type_id, 919999);
assert.notEqual(rawItems[0].description_category_id, firstSource.description_category_id);
assert.notEqual(rawItems[1].type_id, secondSource.type_id);
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

assert.equal(red.description_category_id, 17999999);
assert.equal(red.type_id, 919999);
assert.equal(blue.description_category_id, 17999999);
assert.equal(blue.type_id, 919999);
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


// Exercise the collector's raw media fields, not a prebuilt complex-attribute payload.
const { prepareCollectRequestV4 } = await import("../collection-pipeline.mjs");
const { buildCollectItemDraftV4 } = await import("../listing-pipeline.mjs");
const { test } = await import("node:test");
const rawMediaVariants = [firstSource, secondSource].map((source, index) => ({
  sku: source.sku,
  name: "Медиа " + source.sku,
  price: "120",
  priceCurrency: "RUB",
  images: ["https://cdn.example.test/" + source.sku + ".jpg"],
  description: "<p>" + (index === 0 ? "Полное описание. " : "Другое описание. ").repeat(45) + "</p><br/>Конец",
  richContent: JSON.stringify({ version: 0.3, content: [{ widgetName: "raTextBlock", text: { content: ["Текст ".repeat(100).trim()] } }] }),
  videos: [1, 2].map(number => ({
    url: "https://cdn.example.test/" + source.sku + "-" + number + ".mp4",
    coverUrl: "https://cdn.example.test/" + source.sku + "-" + number + "-cover.jpg",
  })),
  sourceCategory: { attributes: source.attributes },
  logistics: { weightG: 100, lengthMm: 200, widthMm: 300, heightMm: 400 },
}));
const rawMediaCollect = prepareCollectRequestV4({
  authenticatedAccount: { id: "offline-media-test" },
  input: { source: "ozon", sourceSku: firstSource.sku, requestId: "raw-media-regression",
    payload: { sku: firstSource.sku, variantData: { variants: rawMediaVariants } } },
}).normalizedItem;
rawMediaCollect.categoryResolution = collected.listingDraft.categoryResolution;
rawMediaCollect.listingDraft = buildCollectItemDraftV4(rawMediaCollect);
const builtRawMedia = testExports.buildCollectBoxListingItems(rawMediaCollect, "target-store");

test("raw variant videos, poster URLs and full descriptions survive collect, draft and builder", () => {
  for (const [index, expected] of rawMediaVariants.entries()) {
    assert.deepEqual(rawMediaCollect.variantData.variants[index].videos, expected.videos);
    assert.deepEqual(rawMediaCollect.listingDraft.variants[index].videos, expected.videos);
    assert.equal(rawMediaCollect.listingDraft.variants[index].description, expected.description);
    assert.deepEqual(builtRawMedia[index].videos, expected.videos);
    assert.equal(builtRawMedia[index].scraped_description, expected.description);
    assert.equal(builtRawMedia[index].richContent, expected.richContent);
    assert.deepEqual(builtRawMedia[index].complex_attributes, []);
  }
});

test("raw videos reach the documented Ozon video fields without injecting complex attributes", async () => {
  // This regression covers media transport. Real category metadata is used by the saved seven-SKU replay.
  const result = await normalizeOzonImportItems(builtRawMedia, { strictTypeMatch: true });
  for (const [index, expected] of rawMediaVariants.entries()) {
    const attrs = result.items[index].complex_attributes?.flatMap(group => group.attributes) || [];
    assert.deepEqual(attrs.find(attr => attr.id === 21841)?.values.map(value => value.value), expected.videos.map(video => video.url));
    assert.equal(attrs.find(attr => attr.id === 21837)?.values.length, 2);
    assert.ok(attrs.every(attr => attr.complex_id === 100001));
    assert.equal(attrs.some(attr => attr.id === 21845), false, "JPG poster is not an MP4 video cover");
    assert.equal(result.items[index].attributes.find(attr => attr.id === 4191)?.values[0].value, expected.description);
    assert.deepEqual(JSON.parse(result.items[index].attributes.find(attr => attr.id === 11254)?.values[0].value), JSON.parse(expected.richContent));
  }
});


test("structured and legacy dictionary IDs round-trip enrichment, JSON storage, collect draft and listing", async () => {
  const { normalizeOzonAgentResult } = await import("../collector-ozon-enrichment-contract.mjs");
  const attributes = [
    { key: "8229", value: "old", values: [{ value: "Бра", dictionary_value_id: 91647 }] },
    { key: "10096", value: "old color", values: [{ value: "серый", dictionary_value_id: 61576 }, { dictionary_value_id: 61607 }] },
    { key: "4389", values: [{ dictionary_value_id: 90296 }] },
    { key: "6317", value: "flattened lamps", collection: [{ value: "Светодиодная", dictionary_value_id: 1896 }, { dictionary_value_id: 1897 }] },
    { key: "6324", value: "Механический", dictionary_value_id: 1825 },
    { key: "9048", value: "Legacy model" },
    { key: "8385", value: "stale light", values: [] },
  ];
  const enriched = normalizeOzonAgentResult({ sku: "structured", variantData: { description_category_id: 17028941, type_id: 91647, weight: 100, depth: 200, width: 300, height: 400, attributes } });
  const ingress = prepareCollectRequestV4({ authenticatedAccount: { id: "structured-owner" }, input: {
    source: "ozon", sourceSku: "structured", requestId: "structured-id-roundtrip", payload: {
      sku: "structured", variantData: { variants: [{ sku: "structured", price: "100", priceCurrency: "RUB", images: ["https://cdn.example.test/structured.jpg"], sourceCategory: enriched.sourceCategory, logistics: enriched.logistics }] },
    },
  } }).normalizedItem;
  const collect = JSON.parse(JSON.stringify(ingress));
  collect.categoryResolution = collected.listingDraft.categoryResolution;
  collect.listingDraft = buildCollectItemDraftV4(collect);
  const uploaded = await normalizeOzonImportItems(testExports.buildCollectBoxListingItems(collect, "target-store"), { strictTypeMatch: true });
  const actual = new Map(uploaded.items[0].attributes.map(attribute => [attribute.id, attribute.values]));
  assert.deepEqual(actual.get(10096), [{ value: "серый", dictionary_value_id: 61576 }, { dictionary_value_id: 61607 }]);
  assert.deepEqual(actual.get(4389), [{ dictionary_value_id: 90296 }]);
  assert.deepEqual(actual.get(6317), [{ value: "Светодиодная", dictionary_value_id: 1896 }, { dictionary_value_id: 1897 }]);
  assert.deepEqual(actual.get(6324), [{ value: "Механический", dictionary_value_id: 1825 }]);
  assert.equal(actual.has(8385), false);
  assert.equal(collect.accountId, "structured-owner");
  // The editable categoryAttributes projection also keeps old single IDs and collection ID-only values.
  collect.listingDraft.variants[0].categoryAttributes = attributes;
  const projected = testExports.buildCollectBoxListingItems(collect, "target-store")[0].attributes;
  assert.deepEqual(projected.find(attribute => attribute.id === 6324)?.values, [{ value: "Механический", dictionary_value_id: 1825 }]);
  assert.deepEqual(projected.find(attribute => attribute.id === 6317)?.values, attributes.find(attribute => attribute.key === "6317").collection);
  assert.deepEqual(projected.find(attribute => attribute.id === 8385)?.values, [], "the builder must retain a clear marker until normalization");
  const editedItems = testExports.buildCollectBoxListingItems(collect, "target-store");
  const stale = editedItems[0]._sourceVariant.attributes.find(attribute => attribute.key === "8385");
  stale.values = [{ dictionary_value_id: 38307 }];
  const edited = await normalizeOzonImportItems(editedItems, { strictTypeMatch: true });
  assert.equal(edited.items[0].attributes.some(attribute => attribute.id === 8385), false, "an editor clear must not revive the historical source ID");
});


test("independent content survives ingress, JSON persistence, draft and per-SKU request builder", async () => {
  for (const count of [1, 2]) {
    const variants = rawMediaVariants.slice(0, count).map((v, i) => ({...v,
      color_image: `https://cdn.example.test/${v.sku}/sample.jpg`,
      videoCoverUrl: `https://cdn.example.test/${v.sku}/cover.mp4`,
      contentDiagnostics: {description:{status:'provided',source:'json_ld'},color_image:{status:'provided'},videoCoverUrl:{status:'provided'}},
    }));
    const raw = {sku: variants[0].sku,...(count===1 ? variants[0] : {variantData:{variants}})};
    const normalized = prepareCollectRequestV4({authenticatedAccount:{id:'content-owner'},input:{source:'ozon',sourceSku:raw.sku,requestId:`content-${count}`,payload:raw}}).normalizedItem;
    const saved = JSON.parse(JSON.stringify(normalized));
    saved.categoryResolution=collected.listingDraft.categoryResolution;
    saved.listingDraft=buildCollectItemDraftV4(saved);
    const rows=testExports.buildCollectBoxListingItems(saved,'target-store');
    for(const [i,row] of rows.entries()) {
      assert.equal(row.color_image,variants[i].color_image);
      assert.equal(row.videoCoverUrl,variants[i].videoCoverUrl);
      assert.equal(row.contentDiagnostics.description.source,'json_ld');
      assert.equal(row.scraped_description,variants[i].description);
    }
    const request=await normalizeOzonImportItems(rows,{strictTypeMatch:true});
    for(const [i,row] of request.items.entries()) {
      assert.equal(row.color_image,variants[i].color_image);
      assert.equal(row.complex_attributes.flatMap(g=>g.attributes).find(a=>a.id===21845)?.values[0].value,variants[i].videoCoverUrl);
    }
  }
});

test("explicit independent media clears survive the builder without reviving source or anchor values", async () => {
  const saved = {sku:'parent',listingDraft:{sku:'parent',color_image:'https://cdn.example.test/parent.jpg',videoCoverUrl:'https://cdn.example.test/parent.mp4',variants:[
    {sku:'child',name:'Светильник',sellPrice:'100',images:['https://cdn.example.test/child.jpg'],color_image:'',videoCoverUrl:'',
      contentDiagnostics:{color_image:{status:'not_provided',source:'manual'},videoCoverUrl:{status:'not_provided',source:'manual'}},
      sourceVariant:{sku:'child',color_image:'https://cdn.example.test/old.jpg',videoCoverUrl:'https://cdn.example.test/old.mp4'},
      packageWeight:100,packageLength:200,packageWidth:300,packageHeight:400},
  ]}};
  saved.listingDraft.categoryResolution = collected.listingDraft.categoryResolution;
  const rows = testExports.buildCollectBoxListingItems(saved);
  assert.equal(rows[0].color_image,'');
  assert.equal(rows[0].videoCoverUrl,'');
  const request=await normalizeOzonImportItems(rows,{strictTypeMatch:true});
  assert.equal(request.items[0].color_image,undefined);
  assert.equal((request.items[0].complex_attributes || []).flatMap(g=>g.attributes).some(a=>a.id===21845),false);
});


test("initial single-SKU draft retains all source photos before any editor save", async () => {
  const images = Array.from({ length: 9 }, (_, index) => `https://cdn.example.test/single/${index + 1}.jpg`);
  const payload = { ...rawMediaVariants[0], images };
  const normalized = prepareCollectRequestV4({ authenticatedAccount: { id: "single-gallery-owner" }, input: {
    source: "ozon", sourceSku: payload.sku, requestId: "single-gallery", payload,
  } }).normalizedItem;
  const saved = JSON.parse(JSON.stringify(normalized));
  saved.categoryResolution = collected.listingDraft.categoryResolution;
  saved.listingDraft = buildCollectItemDraftV4(saved);
  const rows = testExports.buildCollectBoxListingItems(saved, "target-store");
  assert.deepEqual(rows[0].images, images, "preparing a new single-SKU draft must keep its complete gallery");
  const request = await normalizeOzonImportItems(rows, { strictTypeMatch: true });
  assert.deepEqual([...new Set([request.items[0].primary_image, ...request.items[0].images].filter(Boolean))], images);
});
