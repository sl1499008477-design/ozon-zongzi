import assert from "node:assert/strict";
import { addSelectedCollectorItemsToCollectBox } from "../collector-selection-service.mjs";

const ingested = [];
const linked = [];
const dependencies = {
  getCollectorRunForAccount: async (accountId, runId) => ({
    id: runId,
    accountId,
    operatingStoreId: "store-a",
    dataCollectionStoreId: "data-a",
  }),
  listCollectorRunItems: async ({ accountId, runId, status }) => {
    assert.equal(accountId, "acct-a");
    assert.equal(runId, "run-a");
    assert.equal(status, "QUALIFIED");
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

console.log("collector selection service tests passed");
