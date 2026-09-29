import test from "node:test";
import assert from "node:assert/strict";
import { prepareAiListingItems, createAiListingSubmissionPorts } from "../ai-listing-submission.mjs";
import { normalizeOzonImportItems } from "../ozon-import-normalizer.mjs";

const input = () => ({ accountId: "a", config: { stock: 5, priceAdjustmentKopecks: -100, priceMultiplier: "1.25", brandMode: "FORCE_NO_BRAND" },
  source: { sku: "sku", sourceSnapshot: { currency: "RUB", blackPrice: "100", greenPrice: "80" }, items: [
    { sku: "sku", images: ["https://original/a", "https://original/b"], listingItem: { scraped_sku: "sku", offer_id: "offer", name: "Product",
      price: "100.00", currency_code: "RUB", description_category_id: 10, type_id: 20,
      attributes: [{ id: 85, values: [{ dictionary_value_id: 88, value: "Source brand" }] }] } }] },
  images: [{ sku: "sku", index: 0, generatedUrl: "https://generated/a" }, { sku: "sku", index: 1, generatedUrl: "https://generated/b" }] });

test("freeze listing uses exact real price, all generated images and category no-brand id without mutating source", async () => {
  const data = input(); const before = structuredClone(data);
  const result = await prepareAiListingItems(data, { currencyCode: "RUB" }, {
    resolveNoBrand: async () => ({ dictionary_value_id: 777, value: "Нет бренда" }),
    normalizeItems: async items => ({ items }),
  });
  assert.equal(result[0].price, "180.00"); // (100 + (100-80)*2.25 - 1) * 1.25
  assert.deepEqual(result[0].images, ["https://generated/a", "https://generated/b"]);
  assert.deepEqual(result[0].attributes.find(a => a.id === 85).values, [{ dictionary_value_id: 777, value: "Нет бренда" }]);
  assert.deepEqual(data, before);
});

test("submission refuses missing generated images and does not relabel currencies", async () => {
  const ports = { normalizeItems: async items => ({ items }), resolveNoBrand: async () => ({ dictionary_value_id: 777, value: "Нет бренда" }) };
  const missing = input(); missing.images.pop();
  await assert.rejects(prepareAiListingItems(missing, { currencyCode: "RUB" }, ports), { definitelyNotSubmitted: true });
  await assert.rejects(prepareAiListingItems(input(), { currencyCode: "CNY" }, ports), { code: "AI_LISTING_CURRENCY_CONVERSION_REQUIRED", definitelyNotSubmitted: true });
});

test("brand preference retains source attribute without dictionary replacement", async () => {
  const data = input(); data.config.brandMode = "PREFER_SOURCE";
  const result = await prepareAiListingItems(data, { currencyCode: "RUB" }, {
    normalizeItems: async items => ({ items }), resolveNoBrand: () => { throw new Error("must not replace brand"); },
  });
  assert.equal(result[0].attributes[0].values[0].dictionary_value_id, 88);
});

test("no-brand submission removes source brand from all published prose while preserving media and source", async () => {
  const data = input();
  const rich = { version: 0.3, content: [{ widgetName: 'raTextBlock', text: { content: ['Xiaomi Mijia: мощность 120 Вт'] } },
    { widgetName: 'raShowcase', blocks: [{ img: { src: 'https://media.test/Xiaomi.jpg', alt: 'Пылесос Xiaomi' } }] }] };
  Object.assign(data.source.items[0].listingItem, { name: 'Ручной пылесос Xiaomi Mijia Car Cleaner', brand: 'Xiaomi',
    weight: 100, depth: 100, width: 100, height: 100,
    _sourceVariant: { brand: 'Xiaomi', descriptionHTML: '<p>Пылесос <b>XIAOMI</b> Mijia, мощность 120 Вт.</p>', richContent: JSON.stringify(rich) },
    attributes: [{ id: 85, values: [{ value: 'Xiaomi', dictionary_value_id: 88 }] },
      { id: 4180, values: [{ value: 'Ручной пылесос Xiaomi Mijia Car Cleaner' }] },
      { id: 23171, values: [{ value: '#пылесос #пылесос_xiaomi #mijia #мощный' }] }] });
  const before = structuredClone(data);
  const [result] = await prepareAiListingItems(data, { currencyCode: 'RUB' }, {
    resolveNoBrand: async () => ({ dictionary_value_id: 777, value: 'Нет бренда' }),
    normalizeItems: items => normalizeOzonImportItems(items, { strictTypeMatch: true,
      getCategoryTree: async () => [{ description_category_id: 10, children: [{ type_id: 20, type_name: 'Product' }] }],
      getCategoryAttributes: async () => [85, 4180, 4191, 23171, 11254].map(id => ({ id })) }),
  });
  assert.equal(result.name, 'Ручной пылесос Car Cleaner');
  const attr = id => result.attributes.find(a => a.id === id)?.values[0].value;
  assert.equal(attr(4180), 'Ручной пылесос Car Cleaner');
  assert.doesNotMatch(attr(4191), /xiaomi|mijia/i);
  assert.match(attr(4191), /120 Вт/);
  assert.equal(attr(23171), '#пылесос #мощный');
  const uploadedRich = JSON.parse(attr(11254));
  assert.doesNotMatch(JSON.stringify(uploadedRich.content[0]), /xiaomi|mijia/i);
  assert.equal(uploadedRich.content[1].blocks[0].img.src, 'https://media.test/Xiaomi.jpg');
  assert.equal(uploadedRich.content[1].blocks[0].img.alt, 'Пылесос');
  assert.deepEqual(result.images, ['https://generated/a', 'https://generated/b']);
  assert.deepEqual(data, before);
});

test("using source brand preserves branded prose and no-brand matching does not erase parts of other words", async () => {
  for (const mode of ['PREFER_SOURCE', 'FORCE_NO_BRAND']) {
    const data = input();data.config.brandMode = mode;
    Object.assign(data.source.items[0].listingItem, { brand: 'AC', name: 'AC VACUUM CLEANER',
      description: 'VACUUM CLEANER AC: 120 W', attributes: [{ id: 85, values: [{ value: 'AC', dictionary_value_id: 88 }] }] });
    const [result] = await prepareAiListingItems(data, { currencyCode: 'RUB' }, {
      resolveNoBrand: async () => ({ dictionary_value_id: 777, value: 'Нет бренда' }), normalizeItems: async items => ({ items }),
    });
    assert.equal(result.name, mode === 'PREFER_SOURCE' ? 'AC VACUUM CLEANER' : 'VACUUM CLEANER');
    assert.equal(result.description, mode === 'PREFER_SOURCE' ? 'VACUUM CLEANER AC: 120 W' : 'VACUUM CLEANER: 120 W');
  }
});

test("no-brand publication cleans legacy collected attribute values before normalization can restore them", async () => {
  const data = input();
  Object.assign(data.source.items[0].listingItem, {
    name: 'Xiaomi Mijia пылесос', weight: 100, depth: 100, width: 100, height: 100,
    attributes: [],
    _sourceVariant: { attributes: [
      { key: '85', collection: ['Xiaomi'] },
      { key: '4191', value: 'Пылесос Xiaomi Mijia: 120 Вт' },
      { key: '23171', collection: ['#xiaomi #пылесос'] },
    ] },
  });
  const before = structuredClone(data);
  const [result] = await prepareAiListingItems(data, { currencyCode: 'RUB' }, {
    resolveNoBrand: async () => ({ dictionary_value_id: 777, value: 'Нет бренда' }),
    normalizeItems: items => normalizeOzonImportItems(items, {
      getCategoryTree: async () => [{ description_category_id: 10, children: [{ type_id: 20 }] }],
      getCategoryAttributes: async () => [85, 4180, 4191, 23171].map(id => ({ id })),
    }),
  });
  assert.equal(result.name, 'пылесос');
  assert.equal(result.attributes.find(attr => attr.id === 4191)?.values[0].value, 'Пылесос: 120 Вт');
  assert.equal(result.attributes.find(attr => attr.id === 23171)?.values[0].value, '#пылесос');
  assert.deepEqual(data, before);
});

test("CNY persisted price evidence with empty draft currency uses exact target-currency minor-unit adjustment", async () => {
  const data = input();
  data.source.sourceSnapshot = { priceCurrency: "CNY", blackPriceCurrency: "CNY", blackPrice: "15.40", greenPrice: "13.85", listingDraft: { currencyCode: "" } };
  data.config.priceMultiplier = "1.25"; data.config.priceAdjustmentKopecks = 100;
  const result = await prepareAiListingItems(data, { currencyCode: "CNY" }, {
    normalizeItems: async items => ({ items }), resolveNoBrand: async () => ({ dictionary_value_id: 777, value: "Нет бренда" }),
  });
  assert.equal(result[0].currency_code, "CNY");
  assert.equal(result[0].price, "19.21"); // round(15.40/1.0715)=14.37; (14.37+1.00)*1.25=19.2125.
});

test("only-existing-real-price fallback does not apply the black-price discount formula again", async () => {
  const data = input(); data.source.sourceSnapshot = { currency: "CNY", price: "15.40" };
  data.config.priceMultiplier = "1"; data.config.priceAdjustmentKopecks = 0;
  const result = await prepareAiListingItems(data, { currencyCode: "CNY" }, {
    normalizeItems: async items => ({ items }), resolveNoBrand: async () => ({ dictionary_value_id: 777, value: "Нет бренда" }),
  });
  assert.equal(result[0].price, "15.40");
});

test("preserves rich content text and replaces only this SKU's exact original image references", async () => {
  const data = input(); const item = data.source.items[0].listingItem;
  const rich = JSON.stringify({ content: [{ image: { src: "https://original/a" }, text: "Existing description", sibling: "https://original/sibling", prefix: "https://original/abc" }] });
  item.richContent = rich;
  item._sourceVariant = { attributes: [{ id: 11254, values: [{ value: rich }] }, { id: 4180, values: [{ value: "Original title" }] }] };
  const result = await prepareAiListingItems(data, { currencyCode: "RUB" }, {
    normalizeItems: async items => ({ items }), resolveNoBrand: async () => ({ dictionary_value_id: 777, value: "Нет бренда" }),
  });
  const expected = { content: [{ image: { src: "https://generated/a" }, text: "Existing description", sibling: "https://original/sibling", prefix: "https://original/abc" }] };
  assert.deepEqual(JSON.parse(result[0].richContent), expected);
  assert.deepEqual(JSON.parse(result[0]._sourceVariant.attributes[0].values[0].value), expected);
  assert.equal(result[0]._sourceVariant.attributes[1].values[0].value, "Original title");
  assert.equal(item.richContent, rich);
});

test("newly imported product waits for Ozon tagging and resumes only stock writes", async () => {
  const { createAiListingSubmissionPorts } = await import("../ai-listing-submission.mjs");
  let body = { status: "STOCKING", config: { targetStoreId: "store" }, stocks: [{ offer_id: "offer", warehouse_id: 123, stock: 5, completed: false }] };
  let calls = 0; let now = 100000;
  const client = { release() {}, async query(sql, values) {
    if (sql.includes("pg_try_advisory_lock")) return { rows: [{ locked: true }] };
    if (sql.startsWith("SELECT *")) return { rows: [{ body: structuredClone(body) }] };
    if (sql.startsWith("UPDATE")) body = JSON.parse(values[2]);
    return { rows: [] };
  } };
  const ports = createAiListingSubmissionPorts({ pool: { connect: async () => client }, clock:()=>now, reserveCapacity:async()=>({allowed:true}),
    validateTarget: async () => ({}), readCredential: async () => ({}),
    callOzonSellerApi: async (_credential, path) => {
      if(path === "/v3/product/info/list") return {items:[{offer_id:"offer",statuses:{status:"price_sent"}}]};
      assert.equal(path, "/v2/products/stocks");
      return { result: [{ offer_id: "offer", warehouse_id: 123, updated: ++calls > 1,
        errors: calls === 1 ? [{ code: "PRODUCT_HAS_NOT_BEEN_TAGGED_YET" }] : [] }] };
    },
  });
  const request = { accountId: "account", submissionId: "submission" };
  assert.equal((await ports.readSubmission(request)).status, "SUBMITTED");
  assert.equal(body.status, "STOCKING");
  now += 60000;
  assert.equal((await ports.readSubmission(request)).status, "COMPLETED");
  assert.equal(body.stocks[0].completed, true);
  assert.equal(calls, 2);
});

test("submission carries the selected SKU's collected color into category normalization", async () => {
  const data = input(); data.config.brandMode = "PREFER_SOURCE";
  data.source.sourceSnapshot.listingDraft = { variants: [
    { sku: "other", aspectValues: { "Цвет": "красный" } },
    { sku: "sku", aspectValues: { "Цвет": "фиолетовый" } },
  ] };
  const result = await prepareAiListingItems(data, { currencyCode: "RUB" }, { normalizeItems: async items => ({ items }) });
  assert.deepEqual(result[0].attributes.find(a => a.id === 10096)?.values, [{ value: "фиолетовый" }]);
});

test("prepared color preserves captured dictionary IDs through normalization instead of replacing them with storefront aliases", async () => {
  for (const [dictionary_value_id, value, alias] of [[61610, 'серебристый', 'Серебро'], [61574, 'черный', 'черное']]) {
    const data = input(); data.config.brandMode = 'PREFER_SOURCE';
    data.source.sourceSnapshot.aspectValues = { 'Цвет': alias };
    Object.assign(data.source.items[0].listingItem, { weight: 100, depth: 100, width: 100, height: 100,
      _sourceVariant: { attributes: [{ id: 10096, values: [{ dictionary_value_id, value }] }] } });
    const before = structuredClone(data);
    let notices;
    const [result] = await prepareAiListingItems(data, { currencyCode: 'RUB' }, {
      normalizeItems: items => normalizeOzonImportItems(items, {
        getCategoryTree: async () => [{ description_category_id: 10, children: [{ type_id: 20 }] }],
        getCategoryAttributes: async () => [{ id: 10096, dictionary_id: 10096, name: 'Цвет товара' }],
        getCategoryAttributeValues: async () => [{ id: dictionary_value_id, value }],
        searchCategoryAttributeValuesExact: async () => [],
      }), onWarnings: rows => { notices = rows; },
    });
    assert.deepEqual(result.attributes?.find(attribute => attribute.id === 10096)?.values, [{ dictionary_value_id, value }]);
    assert.ok(!notices.some(row => row.warnings.some(warning => warning.includes('(10096)'))));
    assert.deepEqual(data, before);
  }
});

test("prepared color respects an explicit edited dictionary value or clearing over collected color", async () => {
  for (const values of [[{ dictionary_value_id: 61575, value: 'белый' }], []]) {
    const data = input(); data.config.brandMode = 'PREFER_SOURCE';
    data.source.sourceSnapshot.aspectValues = { 'Цвет': 'Серебро' };
    data.source.items[0].listingItem.attributes.push({ id: 10096, values });
    data.source.items[0].listingItem._sourceVariant = { attributes: [{ id: 10096, values: [{ dictionary_value_id: 61610, value: 'серебристый' }] }] };
    const [result] = await prepareAiListingItems(data, { currencyCode: 'RUB' }, { normalizeItems: async items => ({ items }) });
    assert.deepEqual(result.attributes.find(attribute => attribute.id === 10096)?.values, values);
  }
});


test("real normalization recovers selected SKU media from the frozen draft without mutating it", async () => {
  const data = input();
  const rich = JSON.stringify({ content: [
    { widgetName: "raTextBlock", text: { content: ["Selected SKU description ".repeat(40).trim()] } },
    { widgetName: "raShowcase", type: "billboard", blocks: [{ img: { src: "https://original/a", srcMobile: "https://original/a" } }] },
  ], version: 0.3 });
  const video = [{ attributes: [{ id: 100001, complex_id: 77, values: [{ value: "https://cdn.example.test/selected.mp4" }] }] }];
  Object.assign(data.source.items[0].listingItem, {
    weight: 100, depth: 100, width: 100, height: 100,
    richContent: rich.slice(0, 500), complex_attributes: [],
    barcode: "OZN1553617193",
  });
  data.source.sourceSnapshot.listingDraft = { variants: [
    { sku: "other", richContent: rich.replaceAll("Selected SKU", "WRONG SKU") },
    { sku: "sku", richContent: rich, complex_attributes: video },
  ] };
  const before = structuredClone(data);
  const result = await prepareAiListingItems(data, { currencyCode: "RUB" }, {
    resolveNoBrand: async () => ({ dictionary_value_id: 777, value: "Нет бренда" }),
    normalizeItems: items => normalizeOzonImportItems(items, {
      strictTypeMatch: true,
      getCategoryTree: async () => [{ description_category_id: 10, children: [{ type_id: 20, type_name: "Product" }] }],
      getCategoryAttributes: async () => [85, 11254, 100001].map(id => ({ id })),
    }),
  });
  const expectedRich = JSON.parse(rich.replaceAll("https://original/a", "https://generated/a"));
  assert.deepEqual(JSON.parse(result[0].attributes.find(attribute => attribute.id === 11254)?.values[0].value || "null"), expectedRich);
  assert.deepEqual(result[0].complex_attributes, video);
  assert.equal(Object.hasOwn(result[0], "barcode"), false);
  assert.deepEqual(data, before);
});


test("AI prepare uses ZH_HANS platform values before freezing a Chinese Seller attribute", async () => {
  const data = input();
  data.config.brandMode = "PREFER_SOURCE";
  data.config.targetStoreId = "bilingual-test-store";
  data.taskId = "bilingual-test-task"; data.idempotencyKey = "bilingual-test-key";
  Object.assign(data.source.items[0].listingItem, {
    weight: 100, depth: 100, width: 100, height: 100,
    _sourceVariant: { attributes: [{ key: "8385", value: "暖白色" }] },
  });
  let frozen;
  const stopAfterPrepare = new Error("stop before persistence");
  const client = { release() {}, async query(sql, values) {
    if (sql.includes("pg_try_advisory_lock")) return { rows: [{ locked: true }] };
    if (sql.startsWith("INSERT INTO ai_image_listing_submissions")) {
      frozen = JSON.parse(values[4]);
      throw stopAfterPrepare;
    }
    return { rows: [] };
  } };
  const ports = createAiListingSubmissionPorts({
    pool: { connect: async () => client },
    readCredential: async () => ({ id: "bilingual-test-store" }),
    validateTarget: async () => ({ store: { currencyCode: "RUB" }, warehouse: { platformWarehouseId: 1 } }),
    reserveCapacity: async () => ({ allowed: false, retryAfterMs: 60_000 }),
    callOzonSellerApi: async (_credential, path, body) => {
      if (path === "/v1/description-category/tree") return { result: [{ description_category_id: 10, children: [{ type_id: 20, type_name: "Product" }] }] };
      if (path === "/v1/description-category/attribute") return { result: [{ id: 85 }, { id: 8385, dictionary_id: 8385 }] };
      if (path === "/v1/description-category/attribute/values") return {
        result: [{ id: 101, value: body.language === "ZH_HANS" ? "暖白色" : "Теплый белый" }], has_next: false,
      };
      if (path === "/v1/description-category/attribute/values/search") return { result: [] };
      assert.fail("Unexpected Ozon call: " + path);
    },
  });
  await assert.rejects(ports.submitListing(data), caught => caught === stopAfterPrepare);
  assert.deepEqual(frozen.items[0].attributes.find(attribute => attribute.id === 8385)?.values,
    [{ value: "Теплый белый", dictionary_value_id: 101 }]);
});


test("AI prepare keeps the real 749-character HTML description and its paragraphs for the selected SKU", async () => {
  const descriptionHTML = "Мирное слияние оптики и эстетики, уголок внутреннего двора<br/><br/>Не боится ветра и дождя, водонепроницаем, защищен от насекомых и пыли<br/><br/>Стою неподвижно, освещая прекрасную ночь<br/><br/>Мягкое освещение, не уступающее суровым условиям наружного освещения<br/><br/>Наружный водонепроницаемый акриловый абажур, высокий уровень водонепроницаемости акрилового абажура, хорошая плотность и однородность, матовая поверхность, мягкий свет и равномерное светопропускание<br/><br/>Наружный водонепроницаемый корпус лампы из нержавеющей стали текстура сырья кованый корпус лампы, технологическая обработка водонепроницаемой краской, нежный цвет краски на поверхности, равномерная плотность, антикоррозийная, антикоррозийно-ржавеющая и износостойкая";
  const data = input();
  Object.assign(data.source.items[0].listingItem, { weight: 100, depth: 100, width: 100, height: 100 });
  data.source.sourceSnapshot.listingDraft = { variants: [
    { sku: "other", descriptionHTML: "Another SKU description" },
    { sku: "sku", descriptionHTML },
  ] };
  const before = structuredClone(data);
  const result = await prepareAiListingItems(data, { currencyCode: "RUB" }, {
    resolveNoBrand: async () => ({ dictionary_value_id: 777, value: "Нет бренда" }),
    normalizeItems: items => normalizeOzonImportItems(items, {
      strictTypeMatch: true,
      getCategoryTree: async () => [{ description_category_id: 10, children: [{ type_id: 20, type_name: "Product" }] }],
      getCategoryAttributes: async () => [85, 4191, 11254].map(id => ({ id })),
    }),
  });
  const uploaded = result[0].attributes.find(attribute => attribute.id === 4191)?.values[0].value;
  assert.equal(uploaded, descriptionHTML);
  assert.equal((uploaded.match(/<br\/>/g) || []).length, 10);
  assert.equal(result[0].attributes.some(attribute => attribute.id === 11254), false);
  assert.deepEqual(data, before);
});


test("frozen AI preparation recovers the selected SKU's raw description and all videos", async () => {
  const data = input();
  data.source.sku = "anchor";
  const description = "<p>" + "Полное описание. ".repeat(45) + "</p><br/>Конец";
  const videos = [1, 2].map(index => ({ url: "https://cdn.example.test/selected-" + index + ".mp4", coverUrl: "https://cdn.example.test/selected-" + index + ".jpg" }));
  data.source.sourceSnapshot.listingDraft = { variants: [
    { sku: "anchor", description: "Другой товар", videos: [{ url: "https://cdn.example.test/anchor.mp4" }] },
    { sku: "sku", description, videos },
  ] };
  Object.assign(data.source.items[0].listingItem, { scraped_description: description.slice(0, 500), weight: 100, depth: 200, width: 300, height: 400 });
  const before = structuredClone(data);
  const result = await prepareAiListingItems(data, { currencyCode: "RUB" }, {
    resolveNoBrand: async () => ({ dictionary_value_id: 777, value: "Нет бренда" }),
    normalizeItems: items => normalizeOzonImportItems(items, { strictTypeMatch: true }),
  });
  assert.equal(result[0].attributes.find(attr => attr.id === 4191)?.values[0].value, description);
  assert.deepEqual(result[0].complex_attributes?.flatMap(group => group.attributes).find(attr => attr.id === 21841)?.values.map(value => value.value), videos.map(video => video.url));
  assert.deepEqual(data, before);
});


test("AI normalization warnings persist per result and remain separate from import errors", async () => {
  const data = input(); data.config.brandMode = "PREFER_SOURCE";
  data.config.targetStoreId = "warning-store"; data.taskId = "warning-task"; data.idempotencyKey = "warning-request";
  Object.assign(data.source.items[0].listingItem, { weight: 100, depth: 100, width: 100, height: 100,
    attributes: [{ id: 777, values: [{ dictionary_value_id: 42 }, { value: "unmapped" }] }] });
  let frozen;
  const stopBeforeWrite = new Error("stop before persistence/import");
  const client = { release() {}, async query(sql, values) {
    if (sql.includes("pg_try_advisory_lock")) return { rows: [{ locked: true }] };
    if (sql.startsWith("INSERT INTO ai_image_listing_submissions")) { frozen = JSON.parse(values[4]); throw stopBeforeWrite; }
    return { rows: [] };
  } };
  const ports = createAiListingSubmissionPorts({ pool: { connect: async () => client },
    readCredential: async () => ({ id: "warning-store" }),
    validateTarget: async () => ({ store: { currencyCode: "RUB" }, warehouse: { platformWarehouseId: 1 } }),
    normalizeItems: items => normalizeOzonImportItems(items, { strictTypeMatch: true,
      getCategoryAttributes: async () => [{ id: 777, dictionary_id: 700, name: "Optional color" }], getCategoryAttributeValues: async () => [] }),
    callOzonSellerApi: async () => assert.fail("No Ozon call before freezing the warning"),
  });
  await assert.rejects(ports.submitListing(data), caught => caught === stopBeforeWrite);
  assert.equal(frozen.results[0].normalizationWarnings?.length, 1);
  assert.match(frozen.results[0].normalizationWarnings[0], /777.*unmapped/);
  assert.deepEqual(frozen.results[0].errors, []);
  assert.equal(frozen.results[0].publicationWarnings, undefined);
  assert.equal(frozen.items[0].normalizationWarnings, undefined, "warnings must not enter the Ozon item payload");
  const complete = structuredClone(frozen); complete.status = "COMPLETED"; complete.attempts = [];
  complete.results[0].importStatus = "SUCCEEDED"; complete.results[0].stockStatus = "COMPLETED";
  const reader = createAiListingSubmissionPorts({ pool: { connect: async () => ({ release() {}, async query(sql) {
    if (sql.includes("pg_try_advisory_lock")) return { rows: [{ locked: true }] };
    return { rows: [{ body: complete }] };
  } }) }, callOzonSellerApi: async () => assert.fail("Completed journal read must not call Ozon") });
  const read = await reader.readSubmission({ accountId: data.accountId, submissionId: "warning-submission" });
  assert.deepEqual(read.items[0].normalizationWarnings, frozen.results[0].normalizationWarnings);
});


test("AI keeps independent swatches unchanged and sends explicit video covers from the frozen own SKU", async () => {
  const data=input(); data.config.brandMode='PREFER_SOURCE';
  Object.assign(data.source.items[0].listingItem,{weight:100,depth:200,width:300,height:400,color_image:'https://original/a',videoCoverUrl:'https://cdn.example.test/cover.mov'});
  const before=structuredClone(data);
  const rows=await prepareAiListingItems(data,{currencyCode:'RUB'},{normalizeItems:items=>normalizeOzonImportItems(items,{strictTypeMatch:true})});
  assert.equal(rows[0].color_image,'https://original/a','a swatch must not be replaced by an AI promotional image even if its URL is in the gallery');
  assert.equal((rows[0].complex_attributes || []).flatMap(g=>g.attributes).find(a=>a.id===21845)?.values[0].value,'https://cdn.example.test/cover.mov');
  assert.deepEqual(data,before);
});
test("frozen-source media fallback is exact-SKU and respects an explicit empty edit", async () => {
  const data=input();data.config.brandMode='PREFER_SOURCE';data.source.sku='parent';
  data.source.sourceSnapshot.listingDraft={variants:[{sku:'parent',color_image:'https://cdn.example.test/parent.jpg',videoCoverUrl:'https://cdn.example.test/parent.mp4'},
    {sku:'sku',color_image:'https://cdn.example.test/child.jpg',videoCoverUrl:'https://cdn.example.test/child.mp4'}]};
  Object.assign(data.source.items[0].listingItem,{weight:100,depth:200,width:300,height:400});
  const prepare=()=>prepareAiListingItems(data,{currencyCode:'RUB'},{normalizeItems:items=>normalizeOzonImportItems(items,{strictTypeMatch:true})});
  assert.equal((await prepare())[0].color_image,'https://cdn.example.test/child.jpg');
  data.source.items[0].listingItem.color_image='';data.source.items[0].listingItem.videoCoverUrl='';
  const cleared=(await prepare())[0];
  assert.equal(cleared.color_image,undefined);
  assert.equal((cleared.complex_attributes || []).flatMap(g=>g.attributes).some(a=>a.id===21845),false);
});
test("invalid JPG video cover yields a readable non-blocking warning and cannot reach 21845", async () => {
  const data=input();data.config.brandMode='PREFER_SOURCE';
  Object.assign(data.source.items[0].listingItem,{weight:100,depth:200,width:300,height:400,videoCover:'https://cdn.example.test/poster.jpg',videoCoverUrl:'https://cdn.example.test/wrong.jpg'});
  let warnings=[];
  const rows=await prepareAiListingItems(data,{currencyCode:'RUB'},{normalizeItems:items=>normalizeOzonImportItems(items,{strictTypeMatch:true}),onWarnings:rows=>{warnings=rows;}});
  assert.equal((rows[0].complex_attributes || []).flatMap(g=>g.attributes).some(a=>a.id===21845),false);
  assert.match(warnings.flatMap(r=>r.warnings).join(' '),/封面视频.*MP4.*MOV.*未提交/);
});
test("dynamic category audit distinguishes source absence, read failure and saved unsupported content", async () => {
  const base={offer_id:'content-audit',scraped_sku:'2102713967',name:'Светильник',price:'100',description_category_id:10,type_id:20,
    weight:100,depth:200,width:300,height:400,images:['https://cdn.example.test/a.jpg'],
    contentDiagnostics:{description:{status:'not_provided'},richContent:{status:'read_failed',message:'HTTP 503'},color_image:{status:'not_provided'},videoCoverUrl:{status:'unverified'}},
  };
  const schema=[{id:4191,name:'Описание'},{id:11254,name:'Rich'},{id:21845,complex_id:100002,name:'Видеообложка'},
    {id:7001,name:'Материал',is_required:false,is_collection:true}];
  const result=await normalizeOzonImportItems([base],{strictTypeMatch:true,getCategoryAttributes:async()=>schema});
  assert.equal(result.items.length,1);
  const warnings=result.itemWarnings[0].warnings.join(' ');
  assert.match(warnings,/SKU 2102713967.*简介.*源未提供/);
  assert.match(warnings,/富内容.*读取失败.*503/);
  assert.match(warnings,/封面视频.*待核实/);
  assert.doesNotMatch(warnings,/7001.*Материал/, 'an empty category template field is not missing source data');
  assert.equal(result.items[0].contentDiagnostics,undefined);
  const unsupported=await normalizeOzonImportItems([{...base,description:'Описание источника',videoCoverUrl:'https://cdn.example.test/cover.mp4'}],{strictTypeMatch:true,getCategoryAttributes:async()=>[{id:7001,name:'Материал'}]});
  assert.match(unsupported.warnings.join(' '),/简介.*已保存.*当前类目.*未提交/);
  assert.match(unsupported.warnings.join(' '),/封面视频.*已保存.*当前类目.*未提交/);
});


test("JSON-LD description is a fallback to Seller 4191, while explicit Russian edits and clears win", async () => {
  const base={offer_id:'description-order',name:'Товар',price:'100',weight:100,depth:200,width:300,height:400,
    description_category_id:10,type_id:20,scraped_description:'Описание JSON-LD',
    contentDiagnostics:{description:{status:'provided',source:'json_ld'}},
    _sourceVariant:{attributes:[{key:'4191',value:'Описание из Seller'}]}};
  const description=async item => (await normalizeOzonImportItems([item],{strictTypeMatch:true})).items[0].attributes?.find(a=>a.id===4191)?.values[0].value;
  assert.equal(await description(base),'Описание из Seller');
  assert.equal(await description({...base,scraped_description:'Ручное описание',contentDiagnostics:{description:{status:'provided',source:'manual'}}}),'Ручное описание');
  assert.equal(await description({...base,scraped_description:'',contentDiagnostics:{description:{status:'not_provided',source:'manual'}}}),undefined);
});

test("the import port freezes warnings separately and passes independent content in the actual request body", async () => {
  const data=input();data.config.brandMode='PREFER_SOURCE';data.config.targetStoreId='fixture-store';data.config.targetWarehouseId='fixture-warehouse';data.taskId='content-fixture';data.idempotencyKey='content-fixture';
  Object.assign(data.source.items[0].listingItem,{weight:100,depth:200,width:300,height:400,scraped_description:'Описание товара',
    color_image:'https://cdn.example.test/sample.jpg',videoCoverUrl:'https://cdn.example.test/cover.mp4',
    contentDiagnostics:{richContent:{status:'read_failed',message:'HTTP 503'}}});
  let saved,request;
  const client={release(){},async query(sql,values){
    if(sql.includes('pg_try_advisory_lock'))return {rows:[{locked:true}]};
    if(sql.startsWith('INSERT INTO ai_image_listing_submissions'))saved=JSON.parse(values[4]);
    if(sql.startsWith('UPDATE ai_image_listing_submissions'))saved=JSON.parse(values[2]);
    return {rows:[]};
  }};
  const ports=createAiListingSubmissionPorts({pool:{connect:async()=>client},
    readCredential:async()=>({id:'fixture-store',clientId:'fixture-only'}),
    validateTarget:async()=>({store:{currencyCode:'RUB'},warehouse:{platformWarehouseId:1}}),
    reserveCapacity:async()=>({allowed:true}),
    normalizeItems:items=>normalizeOzonImportItems(items,{strictTypeMatch:true}),
    callOzonSellerApi:async(_credential,path,body)=>{
      if(path==='/v3/product/info/list')return {items:[]};
      if(path==='/v4/product/info/limit')return {daily_create:{limit:100,usage:0},total:{limit:100,usage:0}};
      assert.equal(path,'/v3/product/import');request=structuredClone(body);return {result:{task_id:1}};
    },
  });
  const result=await ports.submitListing(data);
  assert.ok(result.submissionId);assert.ok(request);
  assert.equal(request.items[0].color_image,'https://cdn.example.test/sample.jpg');
  assert.equal(request.items[0].complex_attributes.flatMap(g=>g.attributes).find(a=>a.id===21845).values[0].value,'https://cdn.example.test/cover.mp4');
  assert.equal(request.items[0].attributes.find(a=>a.id===4191).values[0].value,'Описание товара');
  assert.equal(request.items[0].contentDiagnostics,undefined);
  assert.match(saved.results[0].normalizationWarnings.join(' '),/富内容.*读取失败.*503/);
});


test("a JPG with an MP4-looking query is never submitted as a cover video", async () => {
  const data=input();data.config.brandMode='PREFER_SOURCE';
  Object.assign(data.source.items[0].listingItem,{weight:100,depth:200,width:300,height:400,videoCoverUrl:'https://cdn.example.test/poster.jpg?download=video.mp4'});
  const rows=await prepareAiListingItems(data,{currencyCode:'RUB'},{normalizeItems:items=>normalizeOzonImportItems(items,{strictTypeMatch:true})});
  assert.equal((rows[0].complex_attributes||[]).flatMap(g=>g.attributes).some(a=>a.id===21845),false);
});


test("manual descriptions override stale HTML in every source carrier, including explicit clearing", async () => {
  const base = { offer_id: 'manual-description', name: 'Товар', price: '100', weight: 100, depth: 200, width: 300, height: 400,
    description_category_id: 10, type_id: 20, descriptionHTML: '<p>Старое описание товара</p>',
    _sourceVariant: { descriptionHTML: '<p>Старое описание источника</p>', attributes: [{ key: '4191', value: 'Старое значение Seller' }] },
    _bundleItem: { descriptionHTML: '<p>Старое описание комплекта</p>' }, contentDiagnostics: { description: { status: 'provided', source: 'manual' } } };
  for (const [scraped_description, expected] of [['Новое описание вручную', 'Новое описание вручную'], ['', undefined]]) {
    const result = await normalizeOzonImportItems([{ ...base, scraped_description }], { strictTypeMatch: true });
    assert.equal(result.items[0].attributes?.find(a => a.id === 4191)?.values[0].value, expected);
  }
});

test("invalid color-image HTTP URLs are omitted with a readable nonblocking warning", async () => {
  const base = { offer_id: 'swatch-url', name: 'Товар', price: '100', weight: 100, depth: 200, width: 300, height: 400,
    description_category_id: 10, type_id: 20 };
  for (const color_image of ['https://', 'https://bad host/sample.jpg', 'https://cdn.test/a\nb.jpg', 'ftp://cdn.test/sample.jpg']) {
    const result = await normalizeOzonImportItems([{ ...base, color_image }], { strictTypeMatch: true });
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].color_image, undefined);
    assert.match(result.warnings.join(' '), /颜色样本.*有效 HTTP\(S\).*未提交/);
  }
  for (const url of ['http://cdn.example.test/sample.jpg', 'https://cdn.example.test/image?Signature=a%2Fb%2Bc%3D&Expires=999']) {
    const result = await normalizeOzonImportItems([{ ...base, color_image: '  ' + url + '  ' }], { strictTypeMatch: true });
    assert.equal(result.items[0].color_image, url);
    assert.equal(result.warnings.length, 0);
  }
});

test('non-positive final price identifies the SKU and exact frozen arithmetic without discarding images', async () => {
  const data=input();data.source.sku='3556540370';data.source.items[0].sku='3556540370';for(const row of data.images)row.sku='3556540370';
  data.source.sourceSnapshot={currency:'CNY',blackPrice:'7.65'};data.config.priceAdjustmentKopecks=-1000;data.config.priceMultiplier='5';
  const before=structuredClone(data);
  await assert.rejects(prepareAiListingItems(data,{currencyCode:'CNY'},{normalizeItems:async items=>({items})}),error=>{
    assert.equal(error.code,'PRICE_FINAL_NOT_POSITIVE');assert.equal(error.definitelyNotSubmitted,true);
    assert.match(error.message,/3556540370/);assert.match(error.message,/7\.14/);assert.match(error.message,/-10\.00/);assert.match(error.message,/CNY/);
    assert.equal(error.priceFailure.realPriceKopecks,'714');assert.equal(error.priceFailure.priceAdjustmentKopecks,-1000);assert.equal(error.priceFailure.priceMultiplier,'5');
    return true;
  });assert.deepEqual(data,before);
});


test('new card-only price evidence cannot turn its display card price into an ordinary source price',async()=>{
 const {aiListingItemPrice}=await import('../ai-listing-source-facts.mjs');const data=input();
 data.source.sourceSnapshot={currency:'CNY',price:'43.58',greenPrice:'43.58',storefrontPrice:{currency:'CNY',amount:'43.58',bankAmount:'43.58',ordinaryAmount:null}};
 assert.throws(()=>aiListingItemPrice(data.source,data.source.items[0],data.config,{currencyCode:'CNY'}),{code:'PRICE_INPUT_MISSING',priceValidationFailure:true});
 delete data.source.sourceSnapshot.storefrontPrice.ordinaryAmount;
 assert.equal(aiListingItemPrice(data.source,data.source.items[0],{...data.config,priceAdjustmentKopecks:0,priceMultiplier:'1'},{currencyCode:'CNY'}).pricing.finalPriceKopecks,'4358');
});


test('deferred media preparation releases database connections and persists without importing; finalizer sends once',async()=>{
 const data=input();Object.assign(data,{taskId:'media-task',idempotencyKey:'media-key',deferImport:true});Object.assign(data.config,{targetStoreId:'store',targetWarehouseId:'warehouse',brandMode:'PREFER_SOURCE'});
 let row=null,connections=0,downloads=0,imports=0;
 const query=async(sql,values)=>{
  if(sql.includes('pg_try_advisory_lock'))return {rows:[{locked:true}]};
  if(sql.startsWith('SELECT * FROM ai_image_listing_submissions'))return {rows:row?[structuredClone(row)]:[]};
  if(sql.startsWith('INSERT INTO ai_image_listing_submissions'))row={id:values[0],task_id:values[2],body:JSON.parse(values[4])};
  if(sql.startsWith('UPDATE ai_image_listing_submissions'))row.body=JSON.parse(values[2]);
  return {rows:[]};
 };
 const ports=createAiListingSubmissionPorts({pool:{query,connect:async()=>{connections++;return {query,release(){connections--;}};}},
  validateTarget:async()=>({store:{currencyCode:'RUB'},warehouse:{platformWarehouseId:123}}),readCredential:async()=>({clientId:'seller'}),normalizeItems:async items=>({items}),
  prepareMedia:async({items})=>{assert.equal(connections,0,'downloads must not hold a database connection');downloads++;return items;},
  callOzonSellerApi:async(_credential,path)=>{
   if(path==='/v4/product/info/limit')return {daily_create:{limit:100,usage:0}};
   if(path==='/v3/product/info/list')return {items:[]};
   if(path==='/v3/product/import'){imports++;return {result:{task_id:1234}};}
   if(path==='/v1/product/import/info')return {result:{items:[]}};
   assert.fail(path);
  }});
 const first=await ports.submitListing(data);assert.equal(imports,0);assert.equal(row.body.status,'PREPARED');assert.equal(downloads,1);
 assert.deepEqual(await ports.submitListing(data),first);assert.equal(downloads,1);assert.equal(imports,0);
 row.body.results[0].sku='offer';row.body.results[0].importStatus='FAILED';row.body.attempts[0].status='DONE';
 await ports.submitListing({...data,retryAttempt:1});assert.equal(downloads,2);assert.equal(imports,0);assert.equal(row.body.results[0].sku,'sku');
 await ports.readSubmission({accountId:data.accountId,submissionId:first.submissionId});assert.equal(imports,1);
 await ports.readSubmission({accountId:data.accountId,submissionId:first.submissionId});assert.equal(imports,1);
});

test('submission trusts the collected category snapshot without a tree read and still builds dictionary payloads and real logistics',async()=>{
 const data=input();Object.assign(data,{taskId:'collected-task',idempotencyKey:'collected-key',deferImport:true});Object.assign(data.config,{targetStoreId:'collected-store',targetWarehouseId:'warehouse',brandMode:'PREFER_SOURCE'});
 const group=data.source.items[0];group.categoryResolution={status:'ACTIVE',sourceDescriptionCategoryId:10,sourceTypeId:20,taxonomyScope:'global',currentDescriptionCategoryId:30,currentTypeId:40};
 Object.assign(group.listingItem,{weight:100,depth:200,width:300,height:400,_sourceVariant:{attributes:[{key:'8385',value:'暖白色'}]}});
 const original=structuredClone(data),rows=new Map();let attributeReads=0;
 const query=async(sql,values)=>{
  assert.doesNotMatch(sql,/account_ozon_shared_categories|collect_ozon_category_|platform_product_restrictions|product_restriction_events/,'submission must consume collected facts without policy rechecks');
  if(sql.includes('pg_try_advisory_lock'))return {rows:[{locked:true}]};
  if(sql.startsWith('SELECT * FROM ai_image_listing_submissions'))return {rows:rows.has(values[1])?[structuredClone(rows.get(values[1]))]:[]};
  if(sql.startsWith('INSERT INTO ai_image_listing_submissions'))rows.set(values[0],{id:values[0],task_id:values[2],body:JSON.parse(values[4])});
  return {rows:[]};
 };
 const ports=createAiListingSubmissionPorts({pool:{query,connect:async()=>({query,release(){}})},
  validateTarget:async()=>({store:{currencyCode:'RUB'},warehouse:{platformWarehouseId:123}}),readCredential:async()=>({id:'collected-store',clientId:'seller'}),
  callOzonSellerApi:async(_credential,path,body)=>{
   assert.notEqual(path,'/v1/description-category/tree','collected category must not depend on a fresh official tree');
   assert.equal(body.description_category_id,30);assert.equal(body.type_id,40);
   if(path==='/v1/description-category/attribute'){attributeReads++;return {result:[{id:85},{id:8385,dictionary_id:8385}]};}
   if(path==='/v1/description-category/attribute/values')return {result:[{id:101,value:body.language==='ZH_HANS'?'暖白色':'Теплый белый'}],has_next:false};
   assert.fail('Unexpected Ozon call: '+path);
  }});
 const first=await ports.submitListing(data);const item=rows.get(first.submissionId).body.items[0];
 assert.equal(item.description_category_id,30);assert.equal(item.type_id,40);assert.equal(item.price,'180.00');assert.equal(item.currency_code,'RUB');
 assert.deepEqual([item.weight,item.depth,item.width,item.height],[100,200,300,400]);assert.equal(item.weight_unit,'g');assert.equal(item.dimension_unit,'mm');
 assert.deepEqual(item.attributes.find(a=>a.id===8385).values,[{value:'Теплый белый',dictionary_value_id:101}]);
 assert.deepEqual(await ports.submitListing(data),first);assert.equal(rows.size,1);assert.equal(attributeReads,1);assert.deepEqual(data,original);
 const incomplete=structuredClone(data);incomplete.idempotencyKey='missing-logistics';incomplete.taskId='missing-logistics';delete incomplete.source.items[0].listingItem.weight;
 await assert.rejects(ports.submitListing(incomplete),{code:'ZONGZI_IMPORT_LOGISTICS_REQUIRED',definitelyNotSubmitted:true});assert.equal(rows.size,1);
});

test('submission does not rerun restriction rules after collection accepted the source',async()=>{
 const data=input();Object.assign(data,{taskId:'accepted-task',idempotencyKey:'accepted-key',deferImport:true});Object.assign(data.config,{targetStoreId:'store',targetWarehouseId:'warehouse',brandMode:'PREFER_SOURCE'});
 let saved,ruleReads=0;
 const query=async(sql,values)=>{
  if(sql.includes('platform_product_restrictions')){ruleReads++;return {rows:[{id:'later-rule',payload:{enabled:true,action:'BLOCK',name:'later rule',reason:'changed after capture',categories:[{categoryId:10,typeId:20}]}}]};}
  if(sql.includes('pg_try_advisory_lock'))return {rows:[{locked:true}]};
  if(sql.startsWith('INSERT INTO ai_image_listing_submissions'))saved=JSON.parse(values[4]);
  return {rows:[]};
 };
 const ports=createAiListingSubmissionPorts({pool:{query,connect:async()=>({query,release(){}})},
  validateTarget:async()=>({store:{currencyCode:'RUB'},warehouse:{platformWarehouseId:123}}),readCredential:async()=>({clientId:'seller'}),normalizeItems:async items=>({items}),
  callOzonSellerApi:async()=>assert.fail('deferred preparation cannot write to Ozon')});
 const result=await ports.submitListing(data);assert.ok(result.submissionId);assert.equal(saved.items[0].offer_id,'offer');assert.equal(ruleReads,0);
});
