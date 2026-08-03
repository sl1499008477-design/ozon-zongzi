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
  });
});

test("only archived products do not make an FBS warehouse active", () => {
  assert.deepEqual(evaluate({
    products: [currentProduct({ is_archived: true, status: "ARCHIVED" })],
  }), {
    eligible: false,
    code: "NO_ACTIVE_PRODUCT_ASSOCIATION",
  });
});

test("FBO, FBP, and rFBS are rejected by strict type", () => {
  for (const warehouseType of ["FBO", "fbp", "rFBS"]) {
    assert.deepEqual(evaluate({ warehouse: activeFbs({ warehouse_type: warehouseType }) }), {
      eligible: false,
      code: "TYPE_NOT_FBS",
    });
  }
});

test("missing and internal-only platform warehouse IDs are rejected", () => {
  for (const warehouseId of ["", "  ", "wh_internal_123"]) {
    assert.deepEqual(evaluate({ warehouse: activeFbs({ warehouse_id: warehouseId }) }), {
      eligible: false,
      code: "WAREHOUSE_ID_MISSING",
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
    });
  }
});

test("warehouse and product associations stay inside account and target-store scope", () => {
  assert.deepEqual(evaluate({ warehouse: activeFbs({ storeId: "store-b" }) }), {
    eligible: false,
    code: "STORE_SCOPE_MISMATCH",
  });
  assert.deepEqual(evaluate({ warehouse: activeFbs({ accountId: "acct-b" }) }), {
    eligible: false,
    code: "STORE_SCOPE_MISMATCH",
  });
  assert.deepEqual(evaluate({ products: [currentProduct({ storeId: "store-b" })] }), {
    eligible: false,
    code: "NO_ACTIVE_PRODUCT_ASSOCIATION",
  });
  assert.deepEqual(evaluate({ products: [currentProduct({ accountId: "acct-b" })] }), {
    eligible: false,
    code: "NO_ACTIVE_PRODUCT_ASSOCIATION",
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
    });
  }
});

test("PostgreSQL evidence uses the same policy and reason codes", () => {
  assert.deepEqual(evaluate({ products: [], hasActiveProductAssociation: true }), {
    eligible: true,
    code: "ELIGIBLE_ACTIVE_FBS",
  });
  assert.deepEqual(evaluate({ products: [currentProduct()], hasActiveProductAssociation: false }), {
    eligible: false,
    code: "NO_ACTIVE_PRODUCT_ASSOCIATION",
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
      assert.deepEqual(error?.body, { reason: "TYPE_NOT_FBS" });
      assert.doesNotMatch(JSON.stringify(error), /Secret warehouse name/);
      return true;
    },
  );
});
