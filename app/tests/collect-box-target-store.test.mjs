import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPrepareListingBody,
  collectAddReadiness,
  eligibleTargetStores,
  listingPreparationModel,
  listingSubmissionErrorIsDefinitive,
  listingSubmissionIntent,
  settleListingSubmissionIntent,
  targetStoreSelection,
} from "../src/collect-box-target-store.js";

test("collection add only requires input and an authenticated account, not a bound store", () => {
  assert.deepEqual(collectAddReadiness({
    value: "  https://www.ozon.ru/product/account-owned-7004/  ",
    token: "account-session-token",
    hasStore: false,
  }), {
    ok: true,
    input: "https://www.ozon.ru/product/account-owned-7004/",
    isUrl: true,
  });

  assert.deepEqual(collectAddReadiness({
    value: "7005",
    token: "account-session-token",
    hasStore: false,
  }), {
    ok: true,
    input: "7005",
    isUrl: false,
  });
});

test("collection add rejects missing input or account authentication without asking to bind a store", () => {
  assert.deepEqual(collectAddReadiness({
    value: " ",
    token: "account-session-token",
  }), {
    ok: false,
    reason: "INPUT_REQUIRED",
    message: "请输入 Ozon 商品链接或 SKU",
  });

  assert.deepEqual(collectAddReadiness({
    value: "7006",
    token: "",
  }), {
    ok: false,
    reason: "AUTH_REQUIRED",
    message: "登录已过期，请重新登录",
  });
});

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

test("listing preparation accepts a store-neutral collection item and scopes dependencies to a non-current target", () => {
  const model = listingPreparationModel({
    currentStoreId: "store-a",
    targetStoreId: "store-b",
    collectItem: {
      id: "collect-neutral",
      sku: "sku-neutral",
    },
    localData: {
      currentStoreId: "store-a",
      stores: [
        {
          id: "store-a",
          label: "Current A",
          clientId: "client-a",
          currencyCode: "CNY",
          status: "active",
          credentialsSaved: true,
        },
        {
          id: "store-b",
          label: "Target B",
          clientId: "client-b",
          currencyCode: "RUB",
          status: "active",
          credentialsSaved: true,
        },
      ],
      caches: {
        warehouses: [
          { id: "warehouse-a", storeId: "store-a", clientId: "client-a" },
          { id: "warehouse-b", storeId: "store-b", clientId: "client-b" },
        ],
      },
    },
  });

  assert.deepEqual(model, {
    itemReady: true,
    targetStoreId: "store-b",
    categoryStoreId: "store-b",
    currencyCode: "RUB",
    warehouses: [
      { id: "warehouse-b", storeId: "store-b", clientId: "client-b" },
    ],
  });
});

test("an uncertain retry sends the same listing idempotency key", () => {
  const firstIntent = listingSubmissionIntent(null, {
    collectItemId: "collect-a",
    targetStoreId: "store-a",
    requestId: "request-a",
  });
  const retainedIntent = settleListingSubmissionIntent(firstIntent, { definitive: false });
  const retryIntent = listingSubmissionIntent(retainedIntent, {
    collectItemId: "collect-a",
    targetStoreId: "store-a",
    requestId: "must-not-replace-request-a",
  });

  assert.equal(
    buildPrepareListingBody({
      collectItemId: "collect-a",
      targetStoreId: "store-a",
      requestId: firstIntent.requestId,
    }).idempotencyKey,
    "request-a",
  );
  assert.equal(
    buildPrepareListingBody({
      collectItemId: "collect-a",
      targetStoreId: "store-a",
      requestId: retryIntent.requestId,
    }).idempotencyKey,
    "request-a",
  );
});

test("changing the listing target, including changing back, creates a new submission intent key", () => {
  const firstIntent = listingSubmissionIntent(null, {
    collectItemId: "collect-a",
    targetStoreId: "store-a",
    requestId: "request-a",
  });
  const changedTargetIntent = listingSubmissionIntent(firstIntent, {
    collectItemId: "collect-a",
    targetStoreId: "store-b",
    requestId: "request-b",
  });
  const changedBackIntent = listingSubmissionIntent(changedTargetIntent, {
    collectItemId: "collect-a",
    targetStoreId: "store-a",
    requestId: "request-c",
  });

  assert.deepEqual(changedTargetIntent, {
    collectItemId: "collect-a",
    targetStoreId: "store-b",
    requestId: "request-b",
  });
  assert.equal(changedBackIntent.requestId, "request-c");
});

test("network, timeout, throttling, and server failures retain the listing submission key", () => {
  const firstIntent = listingSubmissionIntent(null, {
    collectItemId: "collect-a",
    targetStoreId: "store-a",
    requestId: "key-a",
  });
  const retainedAfter500 = settleListingSubmissionIntent(firstIntent, {
    definitive: listingSubmissionErrorIsDefinitive({ status: 500, code: "INTERNAL_ERROR" }),
  });
  const retryIntent = listingSubmissionIntent(retainedAfter500, {
    collectItemId: "collect-a",
    targetStoreId: "store-a",
    requestId: "key-b",
  });

  assert.equal(listingSubmissionErrorIsDefinitive(new TypeError("fetch failed")), false);
  assert.equal(listingSubmissionErrorIsDefinitive({ status: 408 }), false);
  assert.equal(listingSubmissionErrorIsDefinitive({ status: 429 }), false);
  assert.equal(listingSubmissionErrorIsDefinitive({ status: 500 }), false);
  assert.equal(listingSubmissionErrorIsDefinitive({ status: 503 }), false);
  assert.equal(retryIntent.requestId, "key-a");
});

test("known client and contract failures clear the listing submission key", () => {
  assert.equal(listingSubmissionErrorIsDefinitive({ status: 400, code: "COLLECT_ITEM_REQUIRED" }), true);
  assert.equal(listingSubmissionErrorIsDefinitive({ status: 409, code: "TARGET_STORE_DISABLED" }), true);
  assert.equal(listingSubmissionErrorIsDefinitive({ status: 422, code: "TARGET_STORE_REQUIRED" }), true);
  assert.equal(settleListingSubmissionIntent({ requestId: "request-a" }, { definitive: true }), null);
});
