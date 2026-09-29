import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";
import React from "react";
import { App as AntApp, ConfigProvider, Tag } from "antd";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer, transformWithEsbuild } from "vite";
import { buildCollectBoxListingItems, listingFirstText, listingNumber } from "../../server/collect-box-listing-items.mjs";
import { collectEnrichmentView } from "../src/collect-enrichment-view.js";

const appRoot = new URL("..", import.meta.url);
const vite = await createServer({
  root: fileURLToPath(appRoot),
  server: {
    middlewareMode: true,
    hmr: { port: 30_000 + (process.pid % 10_000) },
  },
});
after(async () => {
  await vite.close();
});
const appModule = await vite.ssrLoadModule("/src/App.jsx");

test('collection status cells keep every SKU diagnostic in the bounded detail and hover text', async () => {
  const source = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  const marker = source.indexOf('const views=row._enrichment');
  const start = source.lastIndexOf('render: ', marker) + 'render: '.length;
  const end = source.indexOf('\n              },', marker);
  const { code } = await transformWithEsbuild(`const render = ${source.slice(start, end)}\n};`, 'collect-status-cell.jsx', { jsx: 'transform' });
  const render = new Function('React', 'Tag', 'collectEnrichmentTagColors', `${code}\nreturn render;`)(React, Tag, { danger: 'red', warning: 'gold', processing: 'blue' });
  const enrichment = {
    status: 'PENDING_ENRICHMENT', executionState: 'PENDING', completedSkus: 0, totalSkus: 17,
    missingFields: ['descriptionCategoryId', 'weightG', 'lengthMm', 'widthMm', 'heightMm'],
    failures: Array.from({length: 17}, (_, index) => ({sku: String(2102713900 + index), status: 'PENDING', code: 'OZON_SELLER_LOGIN_REQUIRED', message: '请登录 Seller 后继续补全资料'})),
  };
  const view = collectEnrichmentView(enrichment);
  const categoryView = { tone: 'warning', label: '类目待确认', detail: '请在查看页确认商品类目' };
  const row = { _enrichment: enrichment, _enrichmentView: view, _categoryResolutionView: categoryView };
  const before = structuredClone(row);
  const markup = renderToStaticMarkup(render('', row));
  for (const detail of [view.detail, categoryView.detail]) {
    assert(markup.includes(`<span class="collect-enrichment-detail" title="${detail}">${detail}</span>`), 'bounded detail and native hover must retain the complete original diagnostic');
  }
  for (const failure of enrichment.failures) assert(markup.includes(failure.sku));
  assert.deepEqual(row, before);
});

test("the collection list waits for its account-owned summary instead of displaying bootstrap cache prices", () => {
  const markup = renderToStaticMarkup(React.createElement(ConfigProvider, null,
    React.createElement(AntApp, null, React.createElement(appModule.CollectPage, {
      hasStore: true,
      localData: { currentStoreId: "store-cny", caches: { collectBox: [{
        id: "collect-currency", sku: "2157503620", price: "555.35", currencyCode: "RUB",
      }] } },
      onBind() {}, onRefresh() {}, navigate() {},
    }))));
  assert.doesNotMatch(markup, /555\.35|2157503620/);
});

test("editor rows preserve saved target quotes and leave unpriced foreign-currency siblings empty", () => {
  const item = {
    id: "collect-currency", sku: "2157503620", price: "555.35", currencyCode: "RUB",
    variants: [
      { sku: "2157503620", name: "A", price: "555.35", currencyCode: "RUB" },
      { sku: "2157503621", name: "B", price: "600.00", currencyCode: "RUB" },
    ],
    listingDraft: {
      currencyCode: "CNY", price: "70.00",
      variants: [{ sku: "2157503620", sellPrice: "70.00", oldPrice: "85.00" }, { sku: "2157503621" }],
    },
  };
  const common = { sku: item.sku, price: "70.00", sourceItem: item, item: { ...item, variants: item.listingDraft.variants } };
  const cnyRows = appModule.collectEditVariantRows({ ...common, targetCurrencyCode: "CNY" });
  assert.deepEqual(cnyRows.map(row => row.sellPrice), ["70.00", ""]);
  assert.deepEqual(cnyRows.map(row => row.oldPrice), ["85.00", ""]);
  assert.deepEqual(cnyRows.map(row => row.currencyCode), ["CNY", "CNY"]);
  assert.equal(cnyRows[1].sourcePriceDisplay, "600.00 RUB");
  const rubRows = appModule.collectEditVariantRows({ ...common, targetCurrencyCode: "RUB" });
  assert.deepEqual(rubRows.map(row => row.sellPrice), ["555.35", "600.00"]);
});

test("draft save and listing guards preserve source prices and require every SKU before autosave", () => {
  const source = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
  const save = source.slice(source.indexOf("const saveListingDraft ="), source.indexOf("const handleSaveDraft ="));
  assert.doesNotMatch(save, /\n\s+price,\n|currency_code:\s*currencyCode/);
  const request = source.slice(source.indexOf("const runListingRequest ="), source.indexOf("const buildListingDraft ="));
  const perSkuGuard = request.indexOf("variantRows.some");
  assert.ok(perSkuGuard >= 0 && perSkuGuard < request.indexOf("await saveListingDraft"));
  assert.match(request.slice(perSkuGuard, request.indexOf("await saveListingDraft")), /row\.sellPrice/);
  const required = source.slice(source.indexOf("const variantRequiredReady ="), source.indexOf("const enrichmentListingBlockedText ="));
  assert.doesNotMatch(required, /collectEditFirst\(row\.sellPrice,\s*row\.price,\s*price\)/);
});

test("the collection list does not expose cached category states before the current summary arrives", () => {
  assert.equal(typeof appModule.CollectPage, "function");
  const resolutions = [
    {
      status: "ACTIVE", taxonomyScope: "OZON:DEFAULT",
      sourceDescriptionCategoryId: 10, sourceTypeId: 20,
      currentDescriptionCategoryId: 30, currentTypeId: 40,
      source: "SOURCE_DIRECT", version: 1, validatedAt: null,
      action: "NONE", message: "使用采集类目准备上架",
    },
    {
      status: "INVALIDATED", taxonomyScope: "OZON:DEFAULT",
      sourceDescriptionCategoryId: 10, sourceTypeId: 20,
      currentDescriptionCategoryId: 30, currentTypeId: 40,
      source: "OZON_REFRESH", version: 2, validatedAt: "2026-08-12T01:02:03.000Z",
      action: "WAIT", message: "Ozon 类目已失效，正在自动修复",
    },
    {
      status: "NEEDS_REVIEW", taxonomyScope: "OZON:DEFAULT",
      sourceDescriptionCategoryId: null, sourceTypeId: null,
      currentDescriptionCategoryId: null, currentTypeId: null,
      source: null, version: null, validatedAt: null,
      action: "REVIEW", message: "无法确认商品类目，请人工选择",
    },
    { status: "UNKNOWN_VENDOR_STATE", raw: "untrusted backend copy must not render" },
  ];
  const markup = renderToStaticMarkup(
    React.createElement(
      ConfigProvider,
      null,
      React.createElement(
        AntApp,
        null,
        React.createElement(appModule.CollectPage, {
          hasStore: true,
          localData: {
            currentStoreId: "store-a",
            caches: {
              collectBox: resolutions.map((categoryResolution, index) => ({
                id: `collect-${index}`,
                name: `商品 ${index}`,
                enrichment: { status: "COMPLETE" },
                categoryResolution,
              })),
            },
          },
          onBind: () => {},
          onRefresh: () => {},
          navigate: () => {},
        }),
      ),
    ),
  );

  for (const label of [
    "类目与包装已补全",
    "Ozon 类目已失效，正在自动修复",
    "无法确认商品类目，请人工选择",
    "商品类目状态暂时无法确认，请联系管理员",
  ]) {
    assert.ok(!markup.includes(label), `cached category state rendered before account summary: ${label}`);
  }
  assert.doesNotMatch(markup, /untrusted backend copy must not render|目标店铺类目/);
});

test("saved ACTIVE account-shared IDs flow into preview without store rematching", () => {
  const item = {
    id: "collect-matched",
    sku: "sku-matched",
    categoryResolution: {
      status: "ACTIVE",
      taxonomyScope: "OZON:DEFAULT",
      sourceDescriptionCategoryId: 17_028_702,
      sourceTypeId: 94_405,
      currentDescriptionCategoryId: 17_028_702,
      currentTypeId: 94_405,
      source: "SOURCE_DIRECT",
      version: 1,
      validatedAt: null,
      action: "NONE",
      message: "使用采集类目准备上架",
    },
  };
  const preview = appModule.collectEditPreviewPayload({
    item,
    sku: "sku-matched",
    title: "已匹配商品",
    price: "100",
    targetStoreId: "store-a",
  });

  assert.deepEqual(
    { descriptionCategoryId: preview.description_category_id, typeId: preview.type_id },
    { descriptionCategoryId: 17_028_702, typeId: 94_405 },
  );
});

test("a confirmed shared manual category replaces an unresolved summary independent of store", () => {
  const manual = {
    status: "ACTIVE",
    taxonomyScope: "OZON:DEFAULT",
    currentDescriptionCategoryId: 333,
    currentTypeId: 444,
    source: "MANUAL",
    sourceDescriptionCategoryId: 111,
    sourceTypeId: 222,
    version: 2,
    validatedAt: "2026-08-12T01:02:03.000Z",
    action: "NONE",
    message: "使用采集类目准备上架",
  };
  const selected = appModule.collectEditDraftVariantCategory({
    item: {
      id: "collect-review",
      categoryResolution: { status: "NEEDS_REVIEW", taxonomyScope: "OZON:DEFAULT" },
    },
    itemId: "collect-review",
    row: { sku: "sku-matched" },
    targetStoreId: "store-b",
    fallbackResolution: manual,
    manualOverride: {
      itemId: "collect-review",
      targetStoreId: "store-a",
      taxonomyScope: "OZON:DEFAULT",
      resolution: manual,
    },
  });

  assert.equal(selected.categoryResolution.source, "MANUAL");
  assert.deepEqual(
    { descriptionCategoryId: selected.descriptionCategoryId, typeId: selected.typeId },
    { descriptionCategoryId: 333, typeId: 444 },
  );
});

test("editor exposes administrator confirmation only for review state", () => {
  assert.equal(typeof appModule.CollectEditPage, "function");
  const priorWindow = globalThis.window;
  const priorStorage = globalThis.localStorage;
  globalThis.window = { location: { search: "?id=collect-needs-review" } };
  globalThis.localStorage = { getItem: () => "" };
  try {
    const markup = renderToStaticMarkup(
        React.createElement(
          ConfigProvider,
          null,
          React.createElement(
            AntApp,
            null,
            React.createElement(appModule.CollectEditPage, {
              account: { id: "account-a", role: "admin" },
              binding: { id: "store-a" },
              hasStore: true,
              localData: {
                currentStoreId: "store-a",
                caches: {
                  collectBox: [{
                    id: "collect-needs-review",
                    sku: "sku-needs-review",
                    draftVersion: 7,
                    categoryResolution: { status: "NEEDS_REVIEW", taxonomyScope: "OZON:DEFAULT" },
                  }],
                },
              },
              onBind: () => {},
              onRefresh: () => {},
              navigate: () => {},
            }),
          ),
        ),
      );
    assert.match(markup, /aria-label="管理员确认类目"/);
    assert.doesNotMatch(markup, /手动匹配类目|目标店铺类目/);
  } finally {
    globalThis.window = priorWindow;
    globalThis.localStorage = priorStorage;
  }
});

test("editor empty state explains there is no pending listing and offers safe destinations", () => {
  const priorWindow = globalThis.window;
  const priorStorage = globalThis.localStorage;
  globalThis.window = { location: { search: "?id=collect-already-listed" } };
  globalThis.localStorage = { getItem: () => "" };
  const destinations = [];
  try {
    const markup = renderToStaticMarkup(
      React.createElement(ConfigProvider, null,
        React.createElement(AntApp, null,
          React.createElement(appModule.CollectEditPage, {
            localData: { caches: { collectBox: [], products: [] } },
            navigate: (path) => destinations.push(path),
          }),
        ),
      ),
    );
    assert.match(markup, /当前没有可编辑的待上架商品。若已完成上架，请在上架记录中查看。/);
    assert.match(markup, /返回采集箱/);
    assert.match(markup, /查看上架记录/);
  } finally {
    globalThis.window = priorWindow;
    globalThis.localStorage = priorStorage;
  }
});


test("editor preserves full Russian description and explicit per-SKU media including clears", () => {
  const description='Описание. '.repeat(130);
  const item={sku:'parent',color_image:'https://cdn.example.test/parent.jpg',videoCoverUrl:'https://cdn.example.test/parent.mp4',variants:[
    {sku:'parent',description,color_image:'https://cdn.example.test/sample.jpg',videoCover:'https://cdn.example.test/poster.jpg',videos:[{url:'https://cdn.example.test/video.mp4',coverUrl:'https://cdn.example.test/poster.jpg',isCoverAutoPlayOn:true}],videoCoverUrl:'https://cdn.example.test/cover.mov',contentDiagnostics:{description:{status:'provided',source:'json_ld'}}},
    {sku:'child',sourceVariant:{color_image:'https://cdn.example.test/old.jpg',videoCoverUrl:'https://cdn.example.test/old.mp4'},color_image:'',videoCoverUrl:''},
  ]};
  const rows=appModule.collectEditVariantRows({item,sku:'parent'});
  assert.equal(rows[0].description,description.trim());
  assert.equal(rows[0].color_image,'https://cdn.example.test/sample.jpg');
  assert.equal(rows[0].videoCoverUrl,'https://cdn.example.test/cover.mov');
  assert.equal(rows[0].cover,'https://cdn.example.test/poster.jpg');
  assert.equal(rows[0].videos[0].isCoverAutoPlayOn,true);
  assert.equal(rows[0].contentDiagnostics.description.source,'json_ld');
  assert.equal(rows[1].color_image,'');assert.equal(rows[1].videoCoverUrl,'');
});
test("content notes show missing versus failed versus saved without changing task status", () => {
  const notes=appModule.collectEditContentNotes({sku:'child',description:'Описание',contentDiagnostics:{color_image:{status:'not_provided'},videoCoverUrl:{status:'unverified'},richContent:{status:'read_failed',message:'HTTP 503'}}});
  assert.match(notes,/简介：已保存/);assert.match(notes,/颜色样本：源未提供/);assert.match(notes,/封面视频：待核实/);assert.match(notes,/富内容：读取失败.*503/);
});


test("missing optional description is a content note while schema-required fields still block listing", () => {
  const source = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
  const start = source.indexOf("  const requiredCategoryAttributeRows =");
  const finish = source.indexOf("  const readyChecks =", start);
  assert.ok(start > 0 && finish > start);
  const defaults = {
    categoryAttributeInputRows: [{ id: "4191", key: "4191", label: "Описание", required: false, value: "" }],
    categoryAttributeValues: {}, categoryMatched: true, categoryResolutionViewState: {},
    variantRows: [{ offerId: "offer", name: "Товар", sellPrice: "100" }],
    preparationModel: { listingBlocked: false }, enrichmentView: {}, targetStoreId: "store", sku: "sku", title: "Товар", description: "",
    price: "100", productImageList: ["https://cdn.example.test/image.jpg"], brand: "Нет бренда", activeCurrencyCode: "CNY", currencyCode: "CNY",
    listingWarehouseReady: true, listingStockReady: true, hasPackageDimensions: true, variantPackageMissingRows: [],
    categoryReadinessState: { ready: true }, categorySchemaLoading: false, categorySchemaError: "", listingResult: null, loading: false,
    collectEditRequiredValueFilled: value => String(value ?? "").trim() !== "",
    collectEditFirst: (...values) => values.find(value => String(value ?? "").trim() !== "") || "", numberFromMoney: Number,
  };
  const run = overrides => {
    const context = { ...defaults, ...overrides };
    const evaluate = new Function(...Object.keys(context), source.slice(start, finish) + "return { missing: listingRequiredMissingFields, disabled: listingSubmitDisabled };");
    return evaluate(...Object.values(context));
  };
  assert.deepEqual(run({}), { missing: [], disabled: false });
  const required = run({ categoryAttributeInputRows: [{ id: "4191", key: "4191", label: "Описание", required: true, value: "" }] });
  assert.equal(required.disabled, true);
  assert.ok(required.missing.includes("类目属性「Описание」"));
  assert.equal(run({ title: "" }).disabled, true);
  assert.equal(run({ categorySchemaError: "schema unavailable" }).disabled, true);
});


function saveContentDraftForTest(variantRows, overrides = {}) {
  const source = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  const start = source.indexOf('  const buildListingDraft = function()');
  const finish = source.indexOf('  const saveListingDraft =', start);
  assert.ok(start > 0 && finish > start);
  const context = { item: { sku: 'parent' }, itemId: 'content-test', variantRows, sku: 'parent', description: 'Описание родителя',
    categoryAttributeInputRows: [], categoryAttributeValues: {}, collectEditSourceCategorySnapshot: () => ({ path: [], attributes: [] }),
    sourceCategoryEvidenceOf: () => ({}), collectEditDraftVariantCategory: appModule.collectEditDraftVariantCategory,
    collectEditFirst: (...values) => values.find(value => String(value || '').trim()) || '',
    categoryStoreId: '', categoryTaxonomyScope: 'OZON:DEFAULT', categoryResolution: null, scopedPreviewItem: null,
    richContent: 'Родительский Rich', brand: '', tags: [], packageWeight: '100', packageLength: '200', packageWidth: '300', packageHeight: '400',
    categoryLabel: '', categoryRussianLabel: '', title: 'Товар', price: '100', currencyCode: 'RUB', productImageList: [], modelName: '', offerPrefix: 'jz-',
    listingWarehouseId: '', listingStock: '1', categoryDescriptionId: '', categoryTypeId: '', sourceLink: '', note: '', ...overrides };
  return new Function(...Object.keys(context), source.slice(start, finish) + 'return buildListingDraft();')(...Object.values(context));
}

test('saving with a missing anchor preserves every selected sibling field', () => {
  const child = { sku: 'child', description: 'Описание варианта', richContent: 'Rich варианта', packageWeight: '250', packageLength: '260', packageWidth: '270', packageHeight: '280',
    color_image: 'https://cdn.example.test/child.jpg', videoCoverUrl: 'https://cdn.example.test/child.mov' };
  for (const description of ['Описание родителя', '']) {
    const draft = saveContentDraftForTest([child], { description });
    for (const key of ['description', 'richContent', 'packageWeight', 'packageLength', 'packageWidth', 'packageHeight', 'color_image', 'videoCoverUrl']) {
      assert.equal(draft.variants[0][key], child[key], key + ' must remain the child value');
    }
  }
  const draft = saveContentDraftForTest([child, { sku: 'parent', description: 'Старое описание родителя' }]);
  assert.equal(draft.variants[0].description, child.description);
  assert.equal(draft.variants[1].description, 'Описание родителя');
});

test('a sibling manual description clear survives reopen and another draft save', () => {
  const item = { sku: 'parent', variants: [
    { sku: 'parent', description: 'Описание родителя' },
    { sku: 'child', description: '', color_image: '', videoCoverUrl: '', contentDiagnostics: { description: { status: 'not_provided', source: 'manual' } },
      sourceVariant: { description: 'Старое описание варианта', attributes: [{ key: '4191', value: 'Старое значение Seller' }], color_image: 'https://cdn.example.test/old.jpg', videoCoverUrl: 'https://cdn.example.test/old.mp4' } },
  ] };
  const rows = appModule.collectEditVariantRows({ item, sku: item.sku });
  assert.equal(rows[1].description, '');
  const draft = saveContentDraftForTest(rows);
  assert.equal(draft.variants[1].description, '');
  const reopened = appModule.collectEditVariantRows({ item: { ...item, variants: draft.variants }, sku: item.sku });
  assert.equal(reopened[1].description, '');
  assert.equal(reopened[1].color_image, '');
  assert.equal(reopened[1].videoCoverUrl, '');
  assert.equal(reopened[1].contentDiagnostics.description.source, 'manual');
  delete item.variants[1].description;
  assert.equal(appModule.collectEditVariantRows({ item, sku: item.sku })[1].description, 'Старое описание варианта');
});

function applyEditorRowPatch(rows, key, patch) {
  const source = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  const start = source.indexOf('  const updateVariantRow =');
  const finish = source.indexOf('  const deleteVariantRow =', start);
  const result = { rows, price: rows[0]?.sellPrice, stock: '5' };
  const context = {
    variantRows: rows, sku: rows[0]?.sku, title: rows[0]?.name,
    setVariantRows: fn => { result.rows = typeof fn === 'function' ? fn(result.rows) : fn; },
    setPrice: value => { result.price = value; },
    setListingStock: value => { result.stock = value; },
    setSku: () => {}, setTitle: () => {}, setImage: () => {}, markDraftEdited: () => {},
  };
  const apply = new Function(...Object.keys(context), source.slice(start, finish) + 'return updateVariantRow;')(...Object.values(context));
  apply(key, patch);
  return result;
}

test('manual rich-content and independent media edits record intent, while untouched historical blanks remain unknown', () => {
  const row = { key: 'parent-row', sku: 'parent', description: 'Описание родителя', richContent: 'Original Rich',
    videoCoverUrl: 'https://cdn.example.test/cover.mp4', color_image: 'https://cdn.example.test/color.jpg' };
  const draft = saveContentDraftForTest([row], { richContent: '' });
  assert.equal(draft.variants[0].contentDiagnostics.richContent.source, 'manual');
  assert.equal(draft.contentDiagnostics.richContent.source, 'manual');
  const updated = applyEditorRowPatch([row], row.key, { videoCoverUrl: '', color_image: '' }).rows[0];
  assert.equal(updated.contentDiagnostics.videoCoverUrl.source, 'manual');
  assert.equal(updated.contentDiagnostics.color_image.source, 'manual');
  const unchanged = saveContentDraftForTest([{ ...row, richContent: '' }], { richContent: '' });
  assert.equal(unchanged.variants[0].contentDiagnostics.richContent, undefined);
});

test('SKU edits use stable row identity after filtering or pagination and synchronize the first quote', () => {
  const rows = Array.from({ length: 38 }, (_, index) => ({
    key: `row-${index}`, sku: String(2102713967 + index), name: `Светильник ${index}`,
    sellPrice: `${100 + index}.25`, stock: String(index), images: [`https://cdn.example.test/${index}.jpg`],
  }));
  const laterPage = applyEditorRowPatch(rows, 'row-20', { sellPrice: '289.99', stock: '8' });
  assert.equal(laterPage.price, '100.25');
  assert.equal(laterPage.rows[20].sellPrice, '289.99');
  assert.equal(laterPage.rows[20].stock, '8');
  assert.equal(laterPage.rows[0], rows[0]);
  assert.deepEqual(laterPage.rows.map(row => row.key), rows.map(row => row.key));
  const first = applyEditorRowPatch(laterPage.rows, 'row-0', { sellPrice: '118.94' });
  assert.equal(first.price, '118.94');
  assert.equal(first.rows[20].sellPrice, '289.99');
});

test('a direct single-SKU stock edit updates both the SKU and listing fallback without losing its nine images', () => {
  const images = Array.from({ length: 9 }, (_, index) => `https://cdn.example.test/fuel-${index}.jpg`);
  const row = { key: 'fuel', sku: '3252770347', name: 'Fuel Pump', sellPrice: '81.23', stock: '5', images };
  const edited = applyEditorRowPatch([row], 'fuel', { sellPrice: '88.88', stock: '0' });
  assert.equal(edited.price, '88.88');
  assert.equal(edited.stock, '0');
  assert.deepEqual(edited.rows[0].images, images);
});

test('all 38 saved SKU overrides survive reopen, including collapsed media and commercial fields', () => {
  const variants = Array.from({ length: 38 }, (_, index) => ({
    key: `saved-${index}`, sku: String(2102713967 + index), name: `Светильник ${index}`, offerId: `lamp-${index}`,
    sellPrice: `${100 + index}.19`, oldPrice: `${120 + index}.24`, purchasePrice: `${10 + index}.07`, stock: String(index),
    specification: `Мощность: ${index + 1} Вт`, images: [`https://cdn.example.test/${index}-1.jpg`, `https://cdn.example.test/${index}-2.jpg`],
    description: index === 20 ? '' : `Описание ${index}`, richContent: index === 20 ? '' : `{"content":[${index}]}`,
    color_image: '', videoCoverUrl: '', videos: [{ url: `https://cdn.example.test/${index}.mp4`, coverUrl: `https://cdn.example.test/${index}-poster.jpg` }],
    barcode: `barcode-${index}`, packageWeight: String(200 + index), packageLength: '100', packageWidth: '200', packageHeight: '300',
    categoryAttributes: [{ id: '85', values: [{ dictionary_value_id: index + 1, value: `Цвет ${index}` }] }],
    sourceVariant: { richContent: 'Оригинальное описание', description: 'Оригинальный текст' },
  }));
  const draft = saveContentDraftForTest(variants, { sku: 'already-listed-anchor' });
  const item = { sku: 'already-listed-anchor', listingDraft: draft, variants: draft.variants };
  const reopened = appModule.collectEditVariantRows({ item, sku: item.sku });
  assert.equal(reopened.length, 38);
  for (let index = 0; index < 38; index++) {
    for (const field of ['key', 'sku', 'offerId', 'sellPrice', 'oldPrice', 'purchasePrice', 'stock', 'specification', 'images', 'description', 'richContent', 'videos', 'barcode', 'categoryAttributes', 'packageWeight']) {
      assert.deepEqual(reopened[index][field], variants[index][field], `SKU ${index}: ${field}`);
    }
  }
});

test('an enriched sibling retains its own package and category evidence in the editable row', () => {
  const logistics = { weightG: 2001, lengthMm: 1230, widthMm: 40, heightMm: 40 };
  const sourceCategory = { descriptionCategoryId: 17028702, typeIdCandidate: 94405, typeName: 'Светильник', attributes: [{ id: 85, values: [{ dictionary_value_id: 1, value: 'Нет бренда' }] }] };
  const variant = { sku: 'child', logistics, sourceCategory, images: ['https://cdn.example.test/child.jpg'] };
  const rows = appModule.collectEditVariantRows({ item: { sku: 'listed-parent', variants: [variant] }, sku: 'listed-parent', images: ['https://cdn.example.test/parent.jpg'] });
  assert.deepEqual(rows[0].logistics, logistics);
  assert.deepEqual([rows[0].packageWeight, rows[0].packageLength, rows[0].packageWidth, rows[0].packageHeight], ['2001', '1230', '40', '40']);
  assert.equal(rows[0].sourceCategory.descriptionCategoryId, sourceCategory.descriptionCategoryId);
  assert.deepEqual(rows[0].sourceVariant.attributes, sourceCategory.attributes);
  assert.deepEqual(rows[0].images, variant.images, 'a sibling gallery must not acquire the parent cover');
});

test('batch price edits update selected keys across pages and preserve all original stock values', () => {
  const source = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  const start = source.indexOf('  const applySelectedVariantValues =');
  const finish = source.indexOf('  const skuMissingFields =', start);
  let rows = Array.from({ length: 38 }, (_, index) => ({ key: `row-${index}`, sellPrice: `${index + 100}.11`, stock: '5', images: [`https://cdn.example.test/${index}.jpg`] }));
  const original = structuredClone(rows);
  let price = rows[0].sellPrice;
  const context = { variantRows: rows, selectedVariantKeys: ['row-1', 'row-20'], batchPrice: '188.88', markDraftEdited: () => {}, setVariantRows: fn => { rows = fn(rows); }, setPrice: value => { price = value; } };
  new Function(...Object.keys(context), source.slice(start, finish) + 'applySelectedVariantValues();')(...Object.values(context));
  assert.equal(price, original[0].sellPrice);
  for (let index = 0; index < rows.length; index++) {
    assert.deepEqual(rows[index], [1, 20].includes(index) ? { ...original[index], sellPrice: '188.88' } : original[index]);
  }
});

test('initial single and multi-SKU inventory uses the actual uniform listing quantity while preserving row history', () => {
  const source = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  const direct = source.slice(source.indexOf('className="collect-edit-grid collect-edit-single-commerce"'), source.indexOf('<CollectEditSkuMedia row={variantRows[0]}'));
  assert.match(direct, /上架库存[^\n]*value=\{listingStock\}/);
  assert.doesNotMatch(direct, /value=\{variantRows\[0\]\.stock\}/);
  const serverSource = readFileSync(new URL('../../server/index.mjs', import.meta.url), 'utf8');
  const start = serverSource.indexOf('function listingStockRowsFromDraft(');
  const finish = serverSource.indexOf('\nfunction validateCollectBoxListingDraft', start);
  const stockRows = new Function('listingFirstText', 'listingNumber', serverSource.slice(start, finish) + ';return listingStockRowsFromDraft;')(
    listingFirstText, listingNumber,
  );
  for (const variantRows of [[{ sku: 'parent', stock: '0' }], [{ sku: 'child-a', stock: '0' }, { sku: 'child-b', stock: '99' }]]) {
    const draft = saveContentDraftForTest(variantRows, { listingStock: '5', listingWarehouseId: '123' });
    assert.deepEqual(draft.variants.map(row => row.stock), variantRows.map(row => row.stock));
    const submitted = stockRows(draft, {}, variantRows.map(row => ({ scraped_sku: row.sku, offer_id: row.sku })));
    assert.deepEqual(submitted.map(row => row.stock), variantRows.map(() => 5));
  }
});

test('a removed draft SKU is not reintroduced from the retained raw collection snapshot', () => {
  const sourceRows = [{ sku: 'a', name: 'A' }, { sku: 'b', name: 'B' }];
  const savedRows = [{ key: 'b-stable', sku: 'b', name: 'Edited B', sellPrice: '88.88' }];
  const item = { sku: 'a', variants: savedRows, listingDraft: { variants: savedRows }, variantData: { variants: sourceRows } };
  const rows = appModule.collectEditVariantRows({ item, sku: 'a' });
  assert.deepEqual(rows.map(row => row.sku), ['b']);
  assert.equal(rows[0].key, 'b-stable');
  assert.equal(item.variantData.variants.length, 2, 'the raw source remains intact');
});

test('clearing a SKU package value clears its listing fallback and preserves the original evidence', () => {
  const sourceVariant = { logistics: { weightG: 2001, lengthMm: 1230, widthMm: 40, heightMm: 40 } };
  const row = { key: 'child', sku: 'child', packageWeight: '2001', logistics: structuredClone(sourceVariant.logistics), sourceVariant };
  const edited = applyEditorRowPatch([row], 'child', { packageWeight: '' });
  assert.equal(edited.rows[0].packageWeight, '');
  assert.equal(edited.rows[0].logistics.weightG, '');
  assert.equal(edited.rows[0].logistics.lengthMm, 1230);
  assert.equal(edited.rows[0].sourceVariant.logistics.weightG, 2001);
  assert.deepEqual(edited.rows[0].packageEditedFields, ['packageWeight']);
  const reopened = appModule.collectEditVariantRows({ item: { sku: 'parent', listingDraft: { variants: edited.rows }, variants: edited.rows }, sku: 'parent' });
  assert.deepEqual(reopened[0].packageEditedFields, ['packageWeight']);
  const anchorDraft = saveContentDraftForTest([{ ...row, sku: 'parent' }], { packageWeight: '' });
  assert.equal(anchorDraft.variants[0].logistics.weightG, '');
});

test('setting the primary image and adding a gallery image retain their order through the actual listing merge', () => {
  const original = Array.from({ length: 9 }, (_, index) => `https://cdn.example.test/image-${index}.jpg`);
  const added = 'https://cdn.example.test/added.jpg';
  const images = [original[4], ...original.filter(image => image !== original[4]), added];
  const variant = { sku: 'sku', image: images[0], images, sourceVariant: { images: original } };
  const saved = saveContentDraftForTest([variant], { sku: 'sku', productImageList: images });
  const reopened = appModule.collectEditVariantRows({ item: { sku: 'sku', listingDraft: saved, variants: saved.variants }, sku: 'sku' })[0];
  const submitted = buildCollectBoxListingItems({ sku: 'sku', listingDraft: { ...saved, variants: [reopened] } });
  assert.deepEqual(submitted[0].images, images);
  assert.equal(reopened.image, original[4]);
});

test('source-only fields remain read-only and unsupported creation or image deletion controls are absent', () => {
  const source = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  const editor = source.slice(source.indexOf('function CollectEditSkuMedia('), source.indexOf('export { CollectEditPage }'));
  for (const label of ['来源 SKU', '采集规格', '采集条形码', 'SKU 原采集富内容 JSON', '主商品来源 SKU']) {
    const labelStart = editor.indexOf(`label="${label}"`);
    assert.ok(labelStart >= 0, `missing ${label}`);
    const field = editor.slice(labelStart, editor.indexOf('</Form.Item>', labelStart));
    assert.match(field, /readOnly/);
    assert.doesNotMatch(field, /onChange=/);
  }
  assert.doesNotMatch(editor, /添加规格|复制为新规格|移除第.*张图片|AI 一键生成俄文文案|AI 优化已接入/);
});

test('incomplete edited SKU packaging blocks preview before saving or normalizer fallback', async () => {
  const source = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  const start = source.indexOf('  const runListingRequest = async function');
  const finish = source.indexOf('  const anchorVariant =', start);
  const messages = [];
  let expanded;
  let scrolled;
  const context = {
    listingResult: null, itemScopeCurrent: true, preparationModel: { listingBlocked: false },
    requireCategoryReadiness: () => {}, categoryReadinessInput: {}, listingRequiredMissingFields: [],
    hasPackageDimensions: true, variantPackageMissingRows: [{ key: 'row-20', sku: '3057305633' }],
    setExpandedVariantKeys: value => { expanded = value; }, message: { warning: value => messages.push(value) },
    document: { getElementById: id => ({ scrollIntoView: () => { scrolled = id; } }) },
  };
  const run = new Function(...Object.keys(context), source.slice(start, finish) + 'return runListingRequest;')(...Object.values(context));
  await run({ dryRun: true });
  assert.deepEqual(expanded, ['row-20']);
  assert.equal(scrolled, 'SKU 与图片');
  assert.match(messages[0], /3057305633.*包装重量和尺寸/);
});

test('packaging guard applies only to explicit manual overrides, including after reopening', () => {
  const source = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  const start = source.indexOf('  const variantPackageMissingRows =');
  const finish = source.indexOf('  const activeCurrencyCode =', start);
  const rows = [
    { sku: 'legacy-empty', packageWeight: '' },
    { sku: 'manual-empty', packageWeight: '', packageEditedFields: ['packageWeight'] },
    { sku: 'manual-valid', packageWeight: '120', packageEditedFields: ['packageWeight'] },
    { sku: 'legacy-other-empty', packageWeight: '120', packageLength: '', packageEditedFields: ['packageWeight'] },
  ];
  const missing = new Function('variantRows', 'sku', 'numberFromMoney', source.slice(start, finish) + 'return variantPackageMissingRows;')(rows, 'parent', Number);
  assert.deepEqual(missing.map(row => row.sku), ['manual-empty']);
});
