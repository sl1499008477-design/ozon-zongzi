import assert from "node:assert/strict";
import test from "node:test";
import { updateCollectItemDraftWithClientV4 } from "../listing-pipeline.mjs";

test("the real PostgreSQL draft boundary passes private account context while keeping the item redacted", async () => {
  const transactionClient = {
    queries: [],
    async query(sql, params) {
      this.queries.push({ sql: String(sql), params });
      assert.match(String(sql), /FROM collect_items c/);
      assert.deepEqual(params, ["collect-manual-boundary", "account-a"]);
      return {
        rows: [{
          id: "collect-manual-boundary",
          account_id: "account-a",
          store_id: "store-a",
          data_collection_store_id: "",
          source_sku: "sku-a",
          source_url: "https://www.ozon.ru/product/sku-a/",
          source: "ozon",
          identity_key: "identity-a",
          status: "COMPLETE",
          summary: {},
          raw_payload: { normalized: { sku: "sku-a" } },
          draft_data: {},
          draft_version: 1,
        }],
      };
    },
  };
  const stopBeforeCommit = Object.assign(new Error("controlled rollback"), {
    code: "CONTROLLED_ROLLBACK",
  });

  await assert.rejects(
    updateCollectItemDraftWithClientV4(transactionClient, {
      collectItemId: "collect-manual-boundary",
      accountId: "account-a",
      patch: {
        listingDraft: {
          categoryResolution: {
            status: "MATCHED",
            method: "MANUAL",
            target: {
              storeId: "store-a",
              descriptionCategoryId: 17_028_702,
              typeId: 94_405,
            },
          },
        },
      },
      beforeCommit: async ({ client, item, accountId }) => {
        assert.equal(client, transactionClient);
        assert.equal(accountId, "account-a");
        assert.equal(item.id, "collect-manual-boundary");
        assert.equal(Object.hasOwn(item, "accountId"), false);
        throw stopBeforeCommit;
      },
    }),
    (error) => error === stopBeforeCommit,
  );

  assert.equal(transactionClient.queries.length, 1,
    "a canonical/audit failure must stop before the draft mirror is written");
});
