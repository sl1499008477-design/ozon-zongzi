import assert from "node:assert/strict";
import test from "node:test";
import { assertListingStocksBelongToTarget } from "../listing-pipeline.mjs";

const warehouseRecord = (overrides = {}) => ({
  requested_id: "1020003087687000",
  account_id: "acct-a",
  store_id: "store-a",
  warehouse_id: "1020003087687000",
  warehouse_type: "fbs",
  status: "active",
  is_active: true,
  is_archived: false,
  has_active_product_association: true,
  ...overrides,
});

const clientReturning = (rows) => ({
  calls: [],
  async query(sql, params) {
    this.calls.push({ sql, params });
    return { rows, rowCount: rows.length };
  },
});

const validate = (client, warehouseId = "1020003087687000") =>
  assertListingStocksBelongToTarget({
    accountId: "acct-a",
    storeId: "store-a",
    stocks: [{ warehouse_id: warehouseId, stock: 0 }],
    client,
  });

test("PostgreSQL boundary accepts an associated active FBS warehouse even at zero stock", async () => {
  const client = clientReturning([warehouseRecord()]);
  assert.equal(await validate(client), true);
  assert.equal(client.calls.length, 1);
  const [{ sql, params }] = client.calls;
  assert.deepEqual(params, ["acct-a", "store-a", ["1020003087687000"]]);
  assert.match(sql, /w\.warehouse_id=requested\.id/);
  assert.doesNotMatch(sql, /OR w\.id=requested\.id/);
  assert.match(sql, /product_stocks/);
  assert.match(sql, /products/);
  assert.match(sql, /p\.is_archived=FALSE/);
  assert.match(sql, /LOWER\(ps\.source\)='fbs'/);
});

test("PostgreSQL boundary returns the shared eligibility reasons", async () => {
  const cases = [
    { row: warehouseRecord({ warehouse_type: "fbo" }), reason: "UNSUPPORTED_FULFILLMENT_TYPE" },
    { row: warehouseRecord({ is_active: false }), reason: "WAREHOUSE_DISABLED" },
    {
      row: warehouseRecord({ has_active_product_association: false }),
      reason: "NO_ACTIVE_PRODUCT_ASSOCIATION",
    },
  ];
  for (const { row, reason } of cases) {
    await assert.rejects(
      validate(clientReturning([row])),
      (error) => error?.status === 422
        && error?.code === "LISTING_WAREHOUSE_NOT_ELIGIBLE"
        && error?.body?.reason === reason,
    );
  }
});

test("PostgreSQL boundary rejects RFBS stock selections without validation evidence", async () => {
  await assert.rejects(
    validate(clientReturning([warehouseRecord({ warehouse_type: "rFBS" })])),
    (error) => error?.status === 422
      && error?.code === "LISTING_WAREHOUSE_NOT_ELIGIBLE"
      && error?.body?.reason === "RFBS_VALIDATION_REQUIRED",
  );
});

test("unknown, cross-store, and internal warehouse IDs share a non-disclosing scope error", async () => {
  for (const warehouseId of ["1020003087687999", "wh_internal_record"]) {
    await assert.rejects(
      validate(clientReturning([]), warehouseId),
      (error) => {
        assert.equal(error?.status, 422);
        assert.equal(error?.code, "LISTING_WAREHOUSE_NOT_ELIGIBLE");
        assert.equal(error?.body?.reason, "STORE_SCOPE_MISMATCH");
        assert.doesNotMatch(error?.message || "", /1020003087687999|wh_internal_record/);
        return true;
      },
    );
  }
});
