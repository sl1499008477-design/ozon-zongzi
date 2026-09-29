import assert from "node:assert/strict";
import { addSelectedCollectorItemsToCollectBox } from "../collector-selection-service.mjs";
import { buildCollectItemDraftV4 } from "../listing-pipeline.mjs";
import { prepareCollectRequestV4 } from "../collection-pipeline.mjs";

const ingested = [];
const linked = [];
const dependencies = {
  getCollectorRunForAccount: async (accountId, runId) => ({
    id: runId,
    accountId,
    operatingStoreId: "store-a",
    dataCollectionStoreId: "data-a",
  }),
  listCollectorRunItems: async ({ accountId, runId, status, itemIds }) => {
    assert.equal(accountId, "acct-a");
    assert.equal(runId, "run-a");
    assert.equal(status, "QUALIFIED");
    assert.ok(itemIds.includes("item-a"), "only load selected rows before reading large payloads");
    return [
      {
        id: "item-a",
        taskId: "task-a",
        runId,
        source: "ozon",
        sourceKey: "sku-a",
        sourceSku: "sku-a",
        rawPayload: {
          sku: "sku-a",
          title: "raw title",
          price: 100,
          photo: "https://ir-20.ozonstatic.cn/s3/multimedia-1-d/10110544429.jpg",
          href: "https://www.ozon.ru/product/2581899751/",
          sellerNumber: 1,
          lowerPrice: 98.5,
          // Ozon's public seller widget uses "credentials" for business details.
          sellers: { sellers: [{ name: "Public seller", credentials: ["Company registration"] }] },
          operatingStoreId: "legacy-operating",
          dataCollectionStoreId: "legacy-data",
          sellerCompanyId: "legacy-company",
          nested: {
            Client_Id: "nested-client",
            dataCollectionStore: { id: "nested-data-store" },
            currentDataCollectionStoreId: "nested-current-data-store",
            CURRENT_DATA_COLLECTION_STORE_IDS_BY_ACCOUNT: { forged: "nested-current-map" },
            keep: true,
          },
          nestedArray: [{
            SELLER_COMPANY: "nested-seller",
            data_collection_store_ids: ["nested-data-store"],
            legacy_scope: { arbitrary: "forged" },
            keep: "array-value",
          }],
        },
        exportData: {
          nameLabel: "export title",
          price: 120,
          pricingError: "算价规则依据尚未确认",
          nested: { operating_store_id: "export-operating", keep: "export-value" },
        },
        analytics: {
          sold: 10,
          nested: { data_collection_store_id: "analytics-data", keep: "analytics-value" },
        },
      },
      { id: "item-b", sourceKey: "sku-b", sourceSku: "sku-b", source: "ozon" },
    ];
  },
  ingestCollectRequestV4: async (input) => {
    ingested.push(input);
    return { collectItemId: "collect-a", requestId: "request-a", duplicate: false };
  },
  linkCollectorItem: async (...args) => linked.push(args),
};

const selected = await addSelectedCollectorItemsToCollectBox({
  accountId: "acct-a",
  runId: "run-a",
  itemIds: ["item-a", "not-qualified"],
}, dependencies);
assert.equal(selected.ok, false);
assert.equal(selected.added, 1);
assert.deepEqual(selected.missing, ["not-qualified"]);
assert.deepEqual(ingested[0].authenticatedAccount, { id: "acct-a" });
assert.equal(ingested[0].input.source, "ozon");
assert.equal(ingested[0].input.sourceSku, "sku-a");
assert.equal(ingested[0].input.requestId, "collector-select:run-a:item-a");
assert.equal(ingested[0].input.payload.name, "export title");
assert.equal(ingested[0].input.payload.price, 120);
const desktopDraft = buildCollectItemDraftV4(ingested[0].input.payload);
assert.equal(desktopDraft.currencyCode, "RUB", "legacy Ozon desktop sale prices are roubles");
assert.equal(desktopDraft.image, "https://ir-20.ozonstatic.cn/s3/multimedia-1-d/10110544429.jpg");
assert.deepEqual(desktopDraft.images, [desktopDraft.image]);
assert.equal(desktopDraft.sourceLink, "https://www.ozon.ru/product/2581899751/");
assert.equal(ingested[0].input.payload.pricingError, "算价规则依据尚未确认");
assert.doesNotThrow(() => prepareCollectRequestV4(ingested[0]), "desktop public results can enter the existing collection boundary");
assert.equal("sellers" in ingested[0].input.payload, false, "the unused storefront widget is not part of the collect-box contract");
assert.equal(ingested[0].input.payload.sellerNumber, 1);
assert.equal(ingested[0].input.payload.lowerPrice, 98.5);
assert.deepEqual(ingested[0].input.payload.nested, { keep: "export-value" });
assert.deepEqual(ingested[0].input.payload.nestedArray, [{ keep: "array-value" }]);
assert.deepEqual(ingested[0].input.payload.analytics.nested, { keep: "analytics-value" });
for (const field of [
  "accountId",
  "storeId",
  "operatingStoreId",
  "dataCollectionStoreId",
  "sellerCompanyId",
]) {
  assert.equal(field in ingested[0].input, false);
  assert.equal(field in ingested[0].input.payload, false);
}
assert.deepEqual(linked[0], ["acct-a", "run-a", "item-a", "collect-a"]);

await assert.rejects(
  () => addSelectedCollectorItemsToCollectBox({ accountId: "acct-a", runId: "run-a" }, dependencies),
  (error) => error?.code === "COLLECTOR_SELECTION_EMPTY",
);

await addSelectedCollectorItemsToCollectBox({ accountId: "acct-a", runId: "run-a", itemIds: ["item-a"] }, {
  ...dependencies,
  listCollectorRunItems: async () => [{ id: "item-a", source: "ozon", sourceSku: "2581899751", exportData: {
    currencyCode: "CNY", price: "120.25", cover: "https://example.com/old.jpg",
    image: "https://example.com/main.jpg", images: ["https://example.com/main.jpg", "https://example.com/detail.jpg"],
  } }],
});
const explicit = buildCollectItemDraftV4(ingested[1].input.payload);
assert.equal(explicit.currencyCode, "CNY");
assert.equal(explicit.price, "120.25");
assert.equal(explicit.image, "https://example.com/main.jpg");
assert.deepEqual(explicit.images, ["https://example.com/main.jpg", "https://example.com/detail.jpg"]);

for (const storefrontPrice of [{ amount: "128.91", currencyCode: "CNY", source: "ozon-web-price" }, null]) {
  await addSelectedCollectorItemsToCollectBox({ accountId: "acct-a", runId: "run-a", itemIds: ["item-a"] }, {
    ...dependencies,
    listCollectorRunItems: async () => [{ id: "item-a", source: "ozon", sourceSku: "1508194124", rawPayload: {
      storefrontPrice, price: storefrontPrice?.amount || "", currencyCode: storefrontPrice?.currencyCode || "",
      sellerAnalyticsPriceRub: "1541.268", analyticsCurrency: "RUB", avgPrice: "1541.268",
      photo: "https://ir-20.ozonstatic.cn/s3/multimedia-1-d/10110544429.jpg",
      href: "https://www.ozon.ru/product/1508194124/",
    } }],
  });
  const payload = ingested.at(-1).input.payload;
  const draft = buildCollectItemDraftV4(payload);
  assert.equal(draft.currencyCode, storefrontPrice ? "CNY" : "", "an unavailable new storefront price has no invented currency");
  assert.equal(draft.price, storefrontPrice ? "128.91" : "", "Seller RUB statistics cannot become the frontend price");
  assert.equal(payload.sellerAnalyticsPriceRub, "1541.268");
  assert.deepEqual(payload.storefrontPrice, storefrontPrice);
  assert.doesNotThrow(() => prepareCollectRequestV4(ingested.at(-1)), "missing display price does not discard useful market facts");
}

console.log("collector selection service tests passed");

const groupReceipt = await addSelectedCollectorItemsToCollectBox({accountId: 'acct-a', runId: 'run-a', itemIds: ['group-item']}, {
  ...dependencies,
  listCollectorRunItems: async () => [{ id: 'group-item', source:'ozon', sourceSku:'61001', sourceKey:'group-one',
    rawPayload: { sku:'61001', title:'Светильник', images:['https://example.test/a.jpg'],
      variantData: { variants: ['61001','61002'].map(sku => ({sku,title:'Светильник',images:[`https://example.test/${sku}.jpg`],
        sellers:{sellers:[{credentials:['public business information']}]}})) } } }],
  ingestCollectRequestV4: async input => {
    assert.doesNotThrow(() => prepareCollectRequestV4(input));
    assert.deepEqual(input.input.payload.variantData.variants.map(v => v.images[0]), ['https://example.test/61001.jpg','https://example.test/61002.jpg']);
    assert.ok(input.input.payload.variantData.variants.every(v => !('sellers' in v)));
    return {collectItemId:'col-group'};
  },
});
assert.equal(groupReceipt.added,1);
const listedOnly = await addSelectedCollectorItemsToCollectBox({accountId:'acct-a',runId:'run-a',itemIds:['item-a']}, {
  ...dependencies,
  ingestCollectRequestV4: async () => ({collectItemId:'listed:61001',duplicate:true}),
  linkCollectorItem: async () => assert.fail('a listed-only sentinel must never be written to the collect-item foreign key'),
});
assert.equal(listedOnly.errors.length,0);
assert.equal(listedOnly.results[0].collectItemId,'');
assert.equal(listedOnly.results[0].skipped,true);

const admittedTransfer=await addSelectedCollectorItemsToCollectBox({accountId:'acct-a',runId:'run-a',itemIds:['item-a']},{
  ...dependencies,
  listCollectorRunItems:async()=>[{id:'item-a',source:'ozon',sourceSku:'sku-a',rawPayload:{sku:'sku-a',name:'Товар',
    sourceCategory:{descriptionCategoryId:86539915,typeIdCandidate:91884},
    categoryResolution:{status:'MATCHED',target:{descriptionCategoryId:86539914,typeId:91884}},
    collectionAdmission:{status:'PASSED',taxonomyFingerprint:'a'.repeat(64)},enrichment:{status:'COMPLETE',attemptCount:0}}}],
  ingestCollectRequestV4:async input=>{
    assert.doesNotThrow(()=>prepareCollectRequestV4(input));
    assert.equal(input.input.payload.collectorItemId,'item-a');
    assert.equal(input.input.payload.collectionAdmission,undefined);
    assert.equal(input.input.payload.categoryResolution,undefined);
    return {collectItemId:'collect-a'};
  },
});
assert.equal(admittedTransfer.errors.length,0);
