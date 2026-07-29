import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPrepareListingBody,
  eligibleTargetStores,
  targetStoreSelection,
} from "../src/collect-box-target-store.js";

test("eligible target stores are active account-visible stores with saved credentials", () => {
  const eligible = eligibleTargetStores({
    stores: [
      { id: "store-active", status: "active", credentialsSaved: true },
      { id: "store-legacy-active", status: "", credentialsSaved: true },
      { id: "store-disabled", status: "disabled", credentialsSaved: true },
      { id: "store-no-credential", status: "active", credentialsSaved: false },
      null,
    ],
  });

  assert.deepEqual(eligible.map((store) => store.id), ["store-active", "store-legacy-active"]);
});

test("prepare listing body requires explicit item and target IDs", () => {
  assert.throws(
    () => buildPrepareListingBody({
      collectItemId: "",
      targetStoreId: "store-a",
      requestId: "request-a",
    }),
    /COLLECT_ITEM_REQUIRED/,
  );
  assert.throws(
    () => buildPrepareListingBody({
      collectItemId: "collect-a",
      targetStoreId: "",
      requestId: "request-a",
    }),
    /TARGET_STORE_REQUIRED/,
  );
});

test("prepare listing body trims IDs and preserves the caller idempotency key", () => {
  assert.deepEqual(buildPrepareListingBody({
    collectItemId: " collect-a ",
    targetStoreId: " store-a ",
    requestId: "request-a",
  }), {
    collectItemId: "collect-a",
    targetStoreId: "store-a",
    idempotencyKey: "request-a",
  });
});

test("target store selection keeps an eligible choice and otherwise preselects current eligible", () => {
  const localData = {
    stores: [
      { id: "store-a", label: "Store A", clientId: "client-a", status: "active", credentialsSaved: true },
      { id: "store-b", label: "Store B", clientId: "client-b", status: "active", credentialsSaved: true },
    ],
  };
  assert.deepEqual(targetStoreSelection(localData, "store-b", ""), {
    stores: localData.stores,
    options: [
      { value: "store-a", label: "Store A" },
      { value: "store-b", label: "Store B" },
    ],
    selectedStoreId: "store-b",
  });
  assert.equal(targetStoreSelection(localData, "store-a", "store-b").selectedStoreId, "store-b");
});
