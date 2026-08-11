import assert from "node:assert/strict";
import test from "node:test";

import { createListingRfbsWriteAuthorizationRuntime } from "../listing-rfbs-write-authorization-runtime.mjs";

function work(overrides = {}) {
  return {
    id: "submission-job-1",
    type: "AUTO_LISTING",
    account_id: "account-1",
    snapshot_id: "submission-snapshot-1",
    store_id: "store-1",
    correlation_id: "submission-correlation-1",
    rfbs_authorization_required: true,
    rfbs_handoff_id: "rfbs-handoff-1",
    rfbs_account_id: "account-1",
    rfbs_store_id: "store-1",
    rfbs_local_warehouse_id: "warehouse-local-1",
    rfbs_platform_warehouse_id: "warehouse-platform-1",
    rfbs_fulfillment_type: "RFBS",
    rfbs_link_identity_evidence_id: "identity-evidence-1",
    rfbs_attempt_authorization_evidence_id: "attempt-evidence-1",
    rfbs_reserved_attempt_id: "reserved-attempt-1",
    rfbs_submission_link_id: "submission-link-1",
    rfbs_business_idempotency_key: "business-idempotency-1",
    rfbs_handoff_materialization_required: false,
    rfbs_current_warehouse_type: "RFBS",
    rfbs_current_warehouse_status: "active",
    rfbs_current_warehouse_active: true,
    rfbs_current_warehouse_archived: false,
    ...overrides,
  };
}

function harness(overrides = {}) {
  const calls = [];
  const runtime = createListingRfbsWriteAuthorizationRuntime({
    async readStoreCredential(storeId, accountId) {
      calls.push(["credential", storeId, accountId]);
      return { id: storeId, clientId: "client-1", apiKey: "secret-never-returned" };
    },
    async callOzonSellerApi(credential, path, body) {
      calls.push(["ozon", credential.clientId, path, body]);
      return { result: { warehouses: [{ warehouse_id: "warehouse-platform-1",
        warehouse_type: "RFBS", status: "active", is_active: true, is_archived: false }] } };
    },
    async authorizeSubmissionRfbsWrite(input) {
      calls.push(["authorize", input]);
      return { required: true, authorizationId: "phase-authorization-1", phase: input.phase };
    },
    ...overrides,
  });
  return { runtime, calls };
}

test("FBS and legacy work bypass RFBS verifier and authorization ports", async () => {
  const { runtime, calls } = harness();
  const result = await runtime.authorizePhase(work({
    rfbs_authorization_required: false,
    rfbs_handoff_id: null,
    rfbs_account_id: null,
    rfbs_store_id: null,
    rfbs_local_warehouse_id: null,
    rfbs_platform_warehouse_id: null,
    rfbs_fulfillment_type: null,
    rfbs_link_identity_evidence_id: null,
    rfbs_attempt_authorization_evidence_id: null,
    rfbs_reserved_attempt_id: null,
    rfbs_submission_link_id: null,
    rfbs_business_idempotency_key: null,
    rfbs_handoff_materialization_required: false,
    rfbs_current_warehouse_type: null,
    rfbs_current_warehouse_status: null,
    rfbs_current_warehouse_active: null,
    rfbs_current_warehouse_archived: null,
  }), "PRE_IMPORT");
  assert.deepEqual(result, { required: false, phase: "PRE_IMPORT" });
  assert.deepEqual(calls, []);
});

test("RFBS phase authorization performs one closed read-only verification and binds exact job phase", async () => {
  const { runtime, calls } = harness();
  const result = await runtime.authorizePhase(work(), "PRE_STOCK");
  assert.deepEqual(result, {
    required: true, authorizationId: "phase-authorization-1", phase: "PRE_STOCK",
  });
  assert.deepEqual(calls.map(([kind]) => kind), ["credential", "ozon", "authorize"]);
  assert.deepEqual(calls[0], ["credential", "store-1", "account-1"]);
  assert.equal(calls[1][2], "/v2/warehouse/list");
  assert.deepEqual(calls[2][1], {
    submissionJobId: "submission-job-1",
    phase: "PRE_STOCK",
    warehouseValidation: calls[2][1].warehouseValidation,
  });
  assert.equal(calls[2][1].warehouseValidation.accountId, "account-1");
  assert.equal(calls[2][1].warehouseValidation.storeId, "store-1");
  assert.equal(calls[2][1].warehouseValidation.warehouseRecordId, "warehouse-local-1");
  assert.equal(calls[2][1].warehouseValidation.platformWarehouseId, "warehouse-platform-1");
  assert.doesNotMatch(JSON.stringify(result), /secret-never-returned/u);
});

test("a rolling historical candidate can verify without a handoff and a missing row remains retryable", async () => {
  const lazy = harness();
  const result = await lazy.runtime.authorizePhase(work({
    rfbs_handoff_id: null,
    rfbs_handoff_materialization_required: true,
  }), "PRE_IMPORT");
  assert.equal(result.required, true);
  assert.deepEqual(lazy.calls.map(([kind]) => kind), ["credential", "ozon", "authorize"]);

  const missing = harness();
  await assert.rejects(missing.runtime.authorizePhase(work({
    rfbs_handoff_id: null,
    rfbs_handoff_materialization_required: true,
    rfbs_current_warehouse_type: null,
    rfbs_current_warehouse_status: null,
    rfbs_current_warehouse_active: null,
    rfbs_current_warehouse_archived: null,
  }), "PRE_IMPORT"), (error) => error?.code === "LISTING_RFBS_PHASE_VALIDATION_REQUIRED"
    && error?.retryable === true);
  assert.deepEqual(missing.calls, []);
});

test("scope mismatch and verifier response loss fail with stable non-sensitive errors", async () => {
  let calls = 0;
  const malformed = harness({
    async callOzonSellerApi() { calls += 1; throw new Error("raw-api-key-and-upstream-body"); },
  }).runtime;
  await assert.rejects(malformed.authorizePhase(work({ rfbs_account_id: "other-account" }), "PRE_IMPORT"),
    (error) => error?.code === "LISTING_RFBS_PHASE_SCOPE_INVALID"
      && !/other-account|raw-api-key/u.test(error?.message || ""));
  assert.equal(calls, 0);

  const lost = harness({
    async callOzonSellerApi() { throw new Error("raw-api-key-and-upstream-body"); },
  }).runtime;
  await assert.rejects(lost.authorizePhase(work(), "PRE_IMPORT"),
    (error) => error?.code === "LISTING_RFBS_PHASE_VALIDATION_REQUIRED"
      && error?.retryable === true
      && !/raw-api-key|upstream-body/u.test(error?.message || ""));
});
