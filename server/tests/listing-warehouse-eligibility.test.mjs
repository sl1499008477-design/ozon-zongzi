import assert from "node:assert/strict";
import test from "node:test";
import {
  assertListingWarehouseEligible,
  listingWarehouseEligibility,
} from "../listing-warehouse-eligibility.mjs";

const activeFbs = (overrides = {}) => ({
  accountId: "acct-a",
  storeId: "store-a",
  warehouse_id: "1020003087687000",
  warehouse_type: "FBS",
  status: "active",
  is_active: true,
  is_archived: false,
  ...overrides,
});

const currentProduct = (overrides = {}) => ({
  accountId: "acct-a",
  storeId: "store-a",
  is_archived: false,
  warehouse_stocks: [{
    warehouse_id: "1020003087687000",
    source: "fbs",
    present: 0,
    reserved: 0,
  }],
  ...overrides,
});

const evaluate = ({ warehouse = activeFbs(), products = [currentProduct()], ...rest } = {}) =>
  listingWarehouseEligibility({
    warehouse,
    products,
    targetStoreId: "store-a",
    accountId: "acct-a",
    ...rest,
  });

test("an active FBS association stays eligible when current stock is zero", () => {
  assert.deepEqual(evaluate(), {
    eligible: true,
    code: "ELIGIBLE_ACTIVE_FBS",
    fulfillmentType: "FBS",
    evidenceRequired: false,
  });
});

test("a current product association wins when an archived product also uses the warehouse", () => {
  assert.deepEqual(evaluate({
    products: [
      currentProduct({ is_archived: true, visibilityFilter: "ARCHIVED" }),
      currentProduct({ warehouseStocks: currentProduct().warehouse_stocks, warehouse_stocks: undefined }),
    ],
  }), {
    eligible: true,
    code: "ELIGIBLE_ACTIVE_FBS",
    fulfillmentType: "FBS",
    evidenceRequired: false,
  });
});

test("only archived products do not make an FBS warehouse active", () => {
  assert.deepEqual(evaluate({
    products: [currentProduct({ is_archived: true, status: "ARCHIVED" })],
  }), {
    eligible: false,
    code: "NO_ACTIVE_PRODUCT_ASSOCIATION",
    fulfillmentType: "FBS",
    evidenceRequired: false,
  });
});

test("FBO and FBP are rejected as unsupported fulfillment types", () => {
  for (const warehouseType of ["FBO", "fbp"]) {
    assert.deepEqual(evaluate({ warehouse: activeFbs({ warehouse_type: warehouseType }) }), {
      eligible: false,
      code: "UNSUPPORTED_FULFILLMENT_TYPE",
      fulfillmentType: warehouseType.toUpperCase(),
      evidenceRequired: false,
    });
  }
});

test("RFBS requires validation evidence before it is eligible", () => {
  assert.deepEqual(evaluate({
    warehouse: activeFbs({
      accountId: "account-a",
      warehouse_id: "1001",
      warehouse_type: "rFBS",
    }),
    products: [],
    targetStoreId: "store-a",
    accountId: "account-a",
  }), {
    eligible: false,
    code: "RFBS_VALIDATION_REQUIRED",
    fulfillmentType: "RFBS",
    evidenceRequired: true,
  });
});

test("RFBS accepts only current evidence bound to its account, store, and warehouse", () => {
  const warehouse = activeFbs({
    accountId: "account-a",
    warehouse_id: "1001",
    warehouse_type: "rFBS",
  });
  const evidence = {
    outcome: "PASSED",
    accountId: "account-a",
    storeId: "store-a",
    warehouseRecordId: "warehouse-a",
    platformWarehouseId: "1001",
    fulfillmentType: "RFBS",
    expiresAt: "2026-08-11T12:10:00.000Z",
  };
  const input = {
    warehouse: { ...warehouse, id: "warehouse-a" },
    products: [],
    targetStoreId: "store-a",
    accountId: "account-a",
    now: "2026-08-11T12:00:00.000Z",
  };

  assert.deepEqual(evaluate({ ...input, validationEvidence: evidence }), {
    eligible: true,
    code: "ELIGIBLE_ACTIVE_RFBS",
    fulfillmentType: "RFBS",
    evidenceRequired: true,
  });

  const { id: _warehouseRecordId, ...warehouseWithoutRecordId } = input.warehouse;
  for (const invalidInput of [
    {
      ...input,
      accountId: "",
      warehouse: { ...input.warehouse, accountId: "" },
      validationEvidence: { ...evidence, accountId: "" },
    },
    {
      ...input,
      warehouse: { ...input.warehouse, accountId: "" },
      validationEvidence: evidence,
    },
    {
      ...input,
      warehouse: warehouseWithoutRecordId,
      validationEvidence: { ...evidence, warehouseRecordId: "" },
    },
    { ...input, validationEvidence: { ...evidence, accountId: "" } },
    { ...input, validationEvidence: { ...evidence, warehouseRecordId: "" } },
    { ...input, validationEvidence: { ...evidence, storeId: "" } },
    { ...input, validationEvidence: { ...evidence, platformWarehouseId: "" } },
  ]) {
    assert.deepEqual(evaluate(invalidInput), {
      eligible: false,
      code: "RFBS_VALIDATION_REQUIRED",
      fulfillmentType: "RFBS",
      evidenceRequired: true,
    });
  }

  for (const validationEvidence of [
    { ...evidence, accountId: "account-b" },
    { ...evidence, storeId: "store-b" },
    { ...evidence, warehouseRecordId: "warehouse-b" },
    { ...evidence, platformWarehouseId: "1002" },
    { ...evidence, expiresAt: "2026-08-11T12:00:00.000Z" },
  ]) {
    assert.deepEqual(evaluate({ ...input, validationEvidence }), {
      eligible: false,
      code: "RFBS_VALIDATION_REQUIRED",
      fulfillmentType: "RFBS",
      evidenceRequired: true,
    });
  }

  assert.deepEqual(evaluate({
    ...input,
    warehouse: { ...input.warehouse, is_active: false },
    validationEvidence: evidence,
  }), {
    eligible: false,
    code: "WAREHOUSE_DISABLED",
    fulfillmentType: "RFBS",
    evidenceRequired: true,
  });
});

test("missing and internal-only platform warehouse IDs are rejected", () => {
  for (const warehouseId of ["", "  ", "wh_internal_123"]) {
    assert.deepEqual(evaluate({ warehouse: activeFbs({ warehouse_id: warehouseId }) }), {
      eligible: false,
      code: "WAREHOUSE_ID_MISSING",
      fulfillmentType: "FBS",
      evidenceRequired: false,
    });
  }
});

test("explicit disabled and archived evidence rejects an FBS warehouse", () => {
  const disabledWarehouses = [
    activeFbs({ status: "disabled" }),
    activeFbs({ state: "ARCHIVED", status: undefined }),
    activeFbs({ is_active: false }),
    activeFbs({ is_archived: true }),
    activeFbs({ disabled: true }),
  ];
  for (const warehouse of disabledWarehouses) {
    assert.deepEqual(evaluate({ warehouse }), {
      eligible: false,
      code: "WAREHOUSE_DISABLED",
      fulfillmentType: "FBS",
      evidenceRequired: false,
    });
  }
});

test("warehouse and product associations stay inside account and target-store scope", () => {
  assert.deepEqual(evaluate({ warehouse: activeFbs({ storeId: "store-b" }) }), {
    eligible: false,
    code: "STORE_SCOPE_MISMATCH",
    fulfillmentType: "UNKNOWN",
    evidenceRequired: false,
  });
  assert.deepEqual(evaluate({ warehouse: activeFbs({ accountId: "acct-b" }) }), {
    eligible: false,
    code: "STORE_SCOPE_MISMATCH",
    fulfillmentType: "UNKNOWN",
    evidenceRequired: false,
  });
  assert.deepEqual(evaluate({ products: [currentProduct({ storeId: "store-b" })] }), {
    eligible: false,
    code: "NO_ACTIVE_PRODUCT_ASSOCIATION",
    fulfillmentType: "FBS",
    evidenceRequired: false,
  });
  assert.deepEqual(evaluate({ products: [currentProduct({ accountId: "acct-b" })] }), {
    eligible: false,
    code: "NO_ACTIVE_PRODUCT_ASSOCIATION",
    fulfillmentType: "FBS",
    evidenceRequired: false,
  });
});

test("non-FBS stock evidence and a different platform warehouse ID do not qualify", () => {
  for (const stock of [
    { warehouse_id: "1020003087687000", source: "fbo", present: 10 },
    { warehouse_id: "1020003087725000", source: "fbs", present: 10 },
  ]) {
    assert.deepEqual(evaluate({ products: [currentProduct({ warehouse_stocks: [stock] })] }), {
      eligible: false,
      code: "NO_ACTIVE_PRODUCT_ASSOCIATION",
      fulfillmentType: "FBS",
      evidenceRequired: false,
    });
  }
});

test("PostgreSQL evidence uses the same policy and reason codes", () => {
  assert.deepEqual(evaluate({ products: [], hasActiveProductAssociation: true }), {
    eligible: true,
    code: "ELIGIBLE_ACTIVE_FBS",
    fulfillmentType: "FBS",
    evidenceRequired: false,
  });
  assert.deepEqual(evaluate({ products: [currentProduct()], hasActiveProductAssociation: false }), {
    eligible: false,
    code: "NO_ACTIVE_PRODUCT_ASSOCIATION",
    fulfillmentType: "FBS",
    evidenceRequired: false,
  });
});

test("the backend assertion returns the stable non-sensitive 422 contract", () => {
  assert.throws(
    () => assertListingWarehouseEligible({
      warehouse: activeFbs({ warehouse_type: "FBO", name: "Secret warehouse name" }),
      products: [currentProduct()],
      targetStoreId: "store-a",
      accountId: "acct-a",
    }),
    (error) => {
      assert.equal(error?.status, 422);
      assert.equal(error?.code, "LISTING_WAREHOUSE_NOT_ELIGIBLE");
      assert.equal(error?.message, "请选择当前店铺的活跃 FBS 仓库");
      assert.deepEqual(error?.body, { reason: "UNSUPPORTED_FULFILLMENT_TYPE" });
      assert.doesNotMatch(JSON.stringify(error), /Secret warehouse name/);
      return true;
    },
  );
});
