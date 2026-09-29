import assert from "node:assert/strict";
import test from "node:test";
import { assertListingStocksBelongToTarget } from "../listing-pipeline.mjs";

const warehouseRecord = (overrides = {}) => ({
  id: "warehouse-db-a",
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

const validate = (client, warehouseId = "1020003087687000", warehouseValidationEvidenceId) =>
  assertListingStocksBelongToTarget({
    accountId: "acct-a",
    storeId: "store-a",
    stocks: [{ warehouse_id: warehouseId, stock: 0 }],
    warehouseValidationEvidenceId,
    warehouseFulfillmentType: warehouseValidationEvidenceId ? "RFBS" : null,
    submissionIdempotencyKey: "auto-listing:item-a:result-a",
    client,
  });

test("PostgreSQL boundary accepts an associated active FBS warehouse even at zero stock", async () => {
  const client = clientReturning([warehouseRecord()]);
  assert.equal(await validate(client), true);
  assert.equal(client.calls.length, 1);
  const [{ sql, params }] = client.calls;
  assert.deepEqual(params, ["acct-a", "store-a", ["1020003087687000"], null,
    "auto-listing:item-a:result-a"]);
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

test("PostgreSQL boundary accepts RFBS only with exact fresh evidence already bound to its submission link", async () => {
  const client = clientReturning([{ ...warehouseRecord({ warehouse_type: "RFBS",
    has_active_product_association: false }), evidence_id: "evidence-a", evidence_outcome: "PASSED",
    evidence_fulfillment_type: "RFBS", evidence_expires_at: "2099-01-01T00:00:00.000Z",
    evidence_account_id: "acct-a", evidence_store_id: "store-a",
    evidence_warehouse_record_id: "warehouse-db-a",
    evidence_platform_warehouse_id: "1020003087687000", evidence_link_id: "link-a",
    evidence_attempt_id: "attempt-reserved-a",
    evidence_link_idempotency_key: "auto-listing:item-a:result-a" }]);
  assert.equal(await validate(client, "1020003087687000", "evidence-a"), true);
  assert.deepEqual(client.calls[0].params, ["acct-a", "store-a", ["1020003087687000"], "evidence-a",
    "auto-listing:item-a:result-a"]);
  assert.match(client.calls[0].sql, /auto_listing_rfbs_warehouse_evidence/);
  assert.match(client.calls[0].sql, /auto_listing_submission_links/);
  assert.match(client.calls[0].sql, /auto_listing_upload_attempts/);
});

test("RFBS evidence from another account, store, warehouse, link, or expired observation is rejected", async () => {
  const cases = [
    { evidence_account_id: "acct-b" }, { evidence_store_id: "store-b" },
    { evidence_platform_warehouse_id: "1020003087687999" }, { evidence_link_id: null },
    { evidence_attempt_id: null },
    { evidence_expires_at: "2000-01-01T00:00:00.000Z" },
  ];
  for (const mutation of cases) {
    const client = clientReturning([{ ...warehouseRecord({ warehouse_type: "RFBS",
      has_active_product_association: false }), evidence_id: "evidence-a", evidence_outcome: "PASSED",
      evidence_fulfillment_type: "RFBS", evidence_expires_at: "2099-01-01T00:00:00.000Z",
      evidence_account_id: "acct-a", evidence_store_id: "store-a",
      evidence_warehouse_record_id: "warehouse-db-a",
      evidence_platform_warehouse_id: "1020003087687000", evidence_link_id: "link-a",
      evidence_attempt_id: "attempt-reserved-a", ...mutation }]);
    await assert.rejects(validate(client, "1020003087687000", "evidence-a"),
      (error) => error?.body?.reason === "RFBS_VALIDATION_REQUIRED");
  }
});

test("RFBS evidence bound to another submission idempotency key cannot authorize this stock snapshot", async () => {
  const client = clientReturning([{ ...warehouseRecord({ warehouse_type: "RFBS",
    has_active_product_association: false }), evidence_id: "evidence-a", evidence_outcome: "PASSED",
    evidence_fulfillment_type: "RFBS", evidence_expires_at: "2099-01-01T00:00:00.000Z",
    evidence_account_id: "acct-a", evidence_store_id: "store-a",
    evidence_warehouse_record_id: "warehouse-db-a",
    evidence_platform_warehouse_id: "1020003087687000", evidence_link_id: "link-other",
    evidence_attempt_id: "attempt-reserved-other",
    evidence_link_idempotency_key: "auto-listing:item-other:result-other" }]);
  await assert.rejects(validate(client, "1020003087687000", "evidence-a"),
    (error) => error?.body?.reason === "RFBS_VALIDATION_REQUIRED");
});

test("a frozen RFBS submission cannot fall through to FBS association after a type change", async () => {
  const client = clientReturning([{ ...warehouseRecord({ warehouse_type: "FBS",
    has_active_product_association: true }), evidence_id: "evidence-a", evidence_outcome: "PASSED",
    evidence_fulfillment_type: "RFBS", evidence_expires_at: "2099-01-01T00:00:00.000Z",
    evidence_account_id: "acct-a", evidence_store_id: "store-a",
    evidence_warehouse_record_id: "warehouse-db-a",
    evidence_platform_warehouse_id: "1020003087687000", evidence_link_id: "link-a",
    evidence_attempt_id: "attempt-reserved-a",
    evidence_link_idempotency_key: "auto-listing:item-a:result-a" }]);
  await assert.rejects(validate(client, "1020003087687000", "evidence-a"),
    (error) => error?.body?.reason === "RFBS_VALIDATION_REQUIRED");
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

test('direct V3 accepts fresh official RFBS evidence without retired auto-listing links',async()=>{
 const warehouse=warehouseRecord({warehouse_type:'rfbs'});
 const evidence={accountId:'acct-a',storeId:'store-a',warehouseRecordId:warehouse.id,platformWarehouseId:warehouse.warehouse_id,fulfillmentType:'RFBS',outcome:'PASSED',expiresAt:new Date(Date.now()+60000).toISOString()};
 const input={accountId:'acct-a',storeId:'store-a',stocks:[{warehouse_id:warehouse.warehouse_id,stock:0}],directRfbsEvidence:[evidence],client:clientReturning([warehouse])};
 assert.equal(await assertListingStocksBelongToTarget(input),true);
 for(const patch of [{accountId:'other'},{storeId:'other'},{warehouseRecordId:'other'},{platformWarehouseId:'other'},{expiresAt:new Date(0).toISOString()}])
  await assert.rejects(assertListingStocksBelongToTarget({...input,directRfbsEvidence:[{...evidence,...patch}]}),error=>error.code==='LISTING_WAREHOUSE_NOT_ELIGIBLE');
});
