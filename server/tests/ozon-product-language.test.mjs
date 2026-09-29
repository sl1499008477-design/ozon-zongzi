import test from "node:test";
import assert from "node:assert/strict";
import { prepareCollectRequestV4 } from "../collection-pipeline.mjs";
import { normalizeOzonAgentResult } from "../collector-ozon-enrichment-contract.mjs";
import { mergeSkuEnrichment } from "../collect-enrichment-recovery.mjs";
import { assertOzonRussianProductText } from "../ozon-product-language.mjs";
import { buildCollectBoxListingItems } from "../collect-box-listing-items.mjs";
import { normalizeOzonImportItems } from "../ozon-import-normalizer.mjs";
const prepare = payload => prepareCollectRequestV4({authenticatedAccount:{id:"acct-language"},input:{
  source:"ozon",sourceSku:"100",requestId:"language-capture",payload}});
test("new collection rejects Chinese product facts including sibling variants, before persistence",()=>{
  for(const payload of [
    {name:"中文商品"}, {name:"Светильник",description:"中文详情"},
    {name:"Светильник",variantData:{variants:[{sku:"101",name:"中文变体"}]}},
    {name:"Светильник",variantData:{variants:[{sku:"101",name:"Светильник",aspectValues:{"Цвет":"灰色"}}]}},
    {name:"Светильник",richContent:JSON.stringify({content:[{text:{content:["中文富文本"]}}]})},
  ]) assert.throws(()=>prepare(payload),error=>error.code==="ZONGZI_PRODUCT_RUSSIAN_REQUIRED" && /俄语/.test(error.message));
  const payload={name:"Светильник LED IP65",description:"Тёплый белый свет",variantData:{variants:[{sku:"101",name:"Светильник",aspectValues:{"Цвет":"Серый"}}]}};
  assert.equal(prepare(payload).normalizedItem.name,payload.name);
  assert.equal(prepareCollectRequestV4({authenticatedAccount:{id:"acct-language"},input:{source:"1688",sourceSku:"100",requestId:"cn-source",payload:{name:"中文商品"}}}).normalizedItem.name,"中文商品");
});
test("Seller enrichment also rejects Chinese facts and fills only the matching SKU's Russian name",()=>{
  const variantData={description_category_id:12,weight:120,depth:236,width:225,height:86,
    attributes:[{key:"4180",values:[{value:"Светильник белый"}]}]};
  assert.throws(()=>normalizeOzonAgentResult({sku:"white",variantData:{...variantData,attributes:[{key:"4180",value:"中文标题"}]}}),error=>error.code==="ZONGZI_PRODUCT_RUSSIAN_REQUIRED");
  const result=normalizeOzonAgentResult({sku:"white",variantData});
  const draft={sku:"parent",name:"Parent",variants:[{sku:"white",name:"中文旧名称"},{sku:"black",name:"Светильник чёрный"}]};
  const next=mergeSkuEnrichment(draft,result);
  assert.equal(next.name,"Parent");assert.equal(next.variants[0].name,"Светильник белый");
  assert.deepEqual(next.variants[1],draft.variants[1]);assert.equal(draft.variants[0].name,"中文旧名称");
});

test("Chinese video names remain unchanged in collection and supported Seller attribute shapes", () => {
  const name = "1月16日.mp4";
  const shapes = [
    { attributes: [{ key: "21837", values: [{ value: name }] }] },
    { attributes: [{ attribute_id: "21837", collection: [name] }] },
    { complex_attributes: [{ attributes: [{ id: 21837, complex_id: 100001, values: [{ value: name }] }] }] },
    { bundleComplexAttrs: [{ attributeId: 21837, value: name }] },
    { videos: [{ url: "https://cdn.test/video.mp4", name }] },
    { videos: [{ url: "https://cdn.test/video.mp4", title: name }] },
  ];
  for (const shape of shapes) {
    const input = { sku: "100", name: "Душевой комплект", variantData: { variants: [{ sku: "3698268572", ...shape }] } };
    const before = structuredClone(input);
    assert.doesNotThrow(() => prepare(input));
    assert.deepEqual(input, before);
  }
});

test("Chinese video and model name permission does not exempt product prose or other attributes", () => {
  const videos = [{ url: "https://cdn.test/video.mp4", name: "中文视频名" }];
  for (const patch of [
    { name: "中文商品名称" }, { description: "中文详情" },
    { attributes: [{ id: 7002, values: [{ value: "中文规格" }] }] },
    { complex_attributes: [{ attributes: [{ id: 7002, values: [{ value: "中文规格" }] }] }] },
    { videos: [{ ...videos[0], description: "中文视频描述" }] },
  ]) assert.throws(() => assertOzonRussianProductText({ videos, ...patch }), error => error.code === "ZONGZI_PRODUCT_RUSSIAN_REQUIRED");
});

test("Chinese model grouping names remain unchanged through collection and final import", async () => {
  const model = "淋浴系统-70";
  for (const shape of [
    { attributes: [{ key: "9048", values: [{ value: model }] }] },
    { attributes: [{ attribute_id: 9048, collection: [model] }] },
    { complex_attributes: [{ attributes: [{ attributeId: 9048, value: model }] }] },
    { modelName: model }, { model_name: model }, { scraped_model_name: model },
  ]) {
    const input = { sku: "3849697224", name: "Душевая система", listingDraft: shape };
    const before = structuredClone(input);
    assert.doesNotThrow(() => assertOzonRussianProductText(input));
    assert.doesNotThrow(() => prepare(input));
    assert.deepEqual(input, before);
  }
  const variantData = { description_category_id: 123, type_id: 456, weight: 4500, depth: 300, width: 200, height: 100,
    attributes: [{ key: "9048", values: [{ value: model }] }] };
  const original = structuredClone(variantData);
  const result = normalizeOzonAgentResult({ sku: "3849697224", variantData });
  assert.equal(result.status, "COMPLETE");
  const draft = mergeSkuEnrichment({ sku: "3849697224", title: "Душевая система", modelName: model,
    categoryResolution: { status: "MATCHED", method: "MANUAL", target: { storeId: "target", descriptionCategoryId: 123, typeId: 456 } },
    variants: ["3849697224", "3849697225"].map(sku => ({ sku, name: "Душевая система", offerId: sku, price: "100", images: ["https://cdn.test/product.jpg"],
      logistics: { weightG: 4500, lengthMm: 300, widthMm: 200, heightMm: 100 } })) }, result);
  const rows = buildCollectBoxListingItems({ sku: "3849697224", listingDraft: draft }, "target");
  const output = await normalizeOzonImportItems(rows, { strictTypeMatch: true,
    getCategoryAttributes: async () => [4180, 9048].map(id => ({ id })), getCategoryAttributeValues: async () => [] });
  assert.equal(output.items.length, 2);
  for (const item of output.items) assert.equal(item.attributes.find(attr => attr.id === 9048).values[0].value, model);
  assert.deepEqual(variantData, original);
});

test("Chinese video names survive Seller enrichment through final import with media intact", async () => {
  const sku = "3698268572";
  const videos = [
    { url: "https://cdn.test/first.mp4", coverUrl: "https://cdn.test/first.jpg", name: "安装演示.mp4" },
    { url: "https://v-1.ozone.ru/vod/video-70/01KF2YXCTC6EFVDRAYK4Z5PTVD/asset_3_h264.mp4", coverUrl: "https://cdn.test/second.jpg", name: "1月16日.mp4" },
  ];
  const complex_attributes = [{ attributes: [
    { id: 21841, complex_id: 100001, values: videos.map(video => ({ value: video.url })) },
    { id: 21837, complex_id: 100001, values: videos.map(video => ({ value: video.name })) },
  ] }];
  const variantData = { description_category_id: 123, type_id: 456, weight: 4500, depth: 300, width: 200, height: 100,
    attributes: [{ key: "4180", values: [{ value: "Душевой комплект" }] }], complex_attributes };
  const original = structuredClone(variantData);
  const result = normalizeOzonAgentResult({ sku, variantData });
  assert.equal(result.status, "COMPLETE");
  const draft = mergeSkuEnrichment({ sku, title: "Душевой комплект", modelName: sku,
    categoryResolution: { status: "MATCHED", method: "MANUAL", target: { storeId: "target", descriptionCategoryId: 123, typeId: 456 } },
    variants: [{ sku, name: "Душевой комплект", offerId: sku, price: "100", images: ["https://cdn.test/product.jpg"], videos }] }, result);
  assert.deepEqual(draft.variants[0].videos, videos);
  const rows = buildCollectBoxListingItems({ sku, listingDraft: draft }, "target");
  const output = await normalizeOzonImportItems(rows, { strictTypeMatch: true,
    getCategoryAttributes: async () => [4180, 21837, 21841].map(id => ({ id })), getCategoryAttributeValues: async () => [] });
  assert.deepEqual(output.items[0].complex_attributes, complex_attributes);
  assert.deepEqual(output.items[0].images, ["https://cdn.test/product.jpg"]);
  assert.deepEqual(variantData, original);
});
