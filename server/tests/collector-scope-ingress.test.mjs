import assert from "node:assert/strict";
import test from "node:test";
import {
  assertCollectorScopeFieldsAbsentV4,
  prepareCollectRequestV4,
} from "../collection-pipeline.mjs";

const retiredKeys = [
  "account-id",
  "created_by",
  "Client_Id",
  "store_id",
  "LOCAL-STORE-ID",
  "operating_store_id",
  "data-collection-store-id",
  "Data_Collection_Stores",
  "data_collection_store_ids",
  "current-data-collection-store-id",
  "CURRENT_DATA_COLLECTION_STORE_IDS_BY_ACCOUNT",
  "seller-company-id",
  "Seller_Company",
  "legacy-scope",
];

test("V4 ingress rejects every canonical retired scope key at nested array/object depth", () => {
  for (const key of retiredKeys) {
    const input = {
      source: "ozon",
      sourceSku: `sku-${key}`,
      requestId: `request-${key}`,
      payload: {
        keep: true,
        nested: [{ deeper: { [key]: "attacker-controlled" } }],
      },
    };
    assert.throws(
      () => assertCollectorScopeFieldsAbsentV4(input),
      (error) => error?.status === 400 && error?.code === "COLLECTOR_SCOPE_FIELD_FORBIDDEN",
      key,
    );
    assert.throws(
      () => prepareCollectRequestV4({
        authenticatedAccount: { id: "account-authoritative" },
        input,
      }),
      (error) => error?.status === 400 && error?.code === "COLLECTOR_SCOPE_FIELD_FORBIDDEN",
      key,
    );
  }
});

test("V4 ingress accepts a store-neutral nested payload", () => {
  const prepared = prepareCollectRequestV4({
    authenticatedAccount: { id: "account-authoritative" },
    input: {
      source: "ozon",
      sourceSku: "sku-safe",
      requestId: "request-safe",
      payload: { nested: [{ keep: "safe" }] },
    },
  });
  assert.equal(prepared.identity.accountId, "account-authoritative");
  assert.deepEqual(prepared.normalizedItem.nested, [{ keep: "safe" }]);
});
