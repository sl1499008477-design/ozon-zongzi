import assert from "node:assert/strict";
import test from "node:test";
import { createAutoListingCategoryRecoveryService } from "../auto-listing-category-recovery-service.mjs";

function basis() {
  return Object.freeze({
    accountId: "account-a", jobId: "job-a", snapshotId: "snapshot-a", evidenceId: "error-a",
    policyVersion: "ozon-category-policy.v2", classification: "EXPLICIT_CATEGORY_FAILURE",
    productId: null, originalOzonTaskId: "task-original", sourceEvidenceId: "source-a",
    oldSharedCategoryId: "shared-a", oldSharedCategoryVersion: 4,
    safeEvidence: Object.freeze({
      schemaVersion: "OZON_CATEGORY_IMPORT_ERROR_EVIDENCE_V1",
      policyVersion: "ozon-category-policy.v2", errorCode: "CATEGORY_INVALID",
      field: "description_category_id", attributeId: null, state: "FAILED",
      offerId: "offer-a", productId: null, classification: "EXPLICIT_CATEGORY_FAILURE",
    }),
    existingAttempt: null,
    offers: Object.freeze([Object.freeze({ offerId: "offer-a", sku: "sku-a" })]),
    frozenItems: Object.freeze([Object.freeze({
      offer_id: "offer-a", sku: "sku-a", description_category_id: 10, type_id: 20,
      attributes: Object.freeze([{ id: 1, values: Object.freeze([{ value: "old" }]) }]),
      name: "name", description: "description", images: Object.freeze(["https://image.invalid/a"]),
      price: "12.34", currency_code: "RUB", vat: "0.2", depth: 1, width: 2, height: 3,
      dimension_unit: "mm", weight: 4, weight_unit: "g", barcode: "barcode-a",
      warehouse_id: "warehouse-a", stock: 7,
    })]),
  });
}

function harness(overrides = {}) {
  const calls = [];
  const { repository: repositoryOverrides = {}, ...serviceOverrides } = overrides;
  const repository = {
    loadCategoryRecoveryBasis: async (input) => { calls.push("load"); return basis(); },
    claimCategoryRecovery: async () => { calls.push("claim"); return { attemptId: "attempt-a", status: "CLAIMED", claimed: true }; },
    saveCategoryRecoveryMatch: async () => { calls.push("save-match"); return { attemptId: "attempt-a", status: "MATCHED" }; },
    markCategoryRecoveryRetryPending: async () => { calls.push("retry-pending"); return { attemptId: "attempt-a", status: "RETRY_PENDING" }; },
    requireCategoryRecoveryReview: async () => { calls.push("review"); return { attemptId: "attempt-a", status: "NEEDS_REVIEW" }; },
    ...repositoryOverrides,
  };
  const service = createAutoListingCategoryRecoveryService({
    repository,
    loadOperatingStoreAccess: async () => { calls.push("access"); return { clientId: "client", apiKey: "key" }; },
    confirmOfferAbsent: async () => { calls.push("absence"); return { status: "ABSENT", code: "ABSENT" }; },
    invalidateSharedCategory: async () => { calls.push("invalidate"); return { status: "INVALIDATED", version: 5 }; },
    refreshCategory: async () => { calls.push("refresh"); return {
      kind: "UNIQUE_MATCH", descriptionCategoryId: 30, typeId: 40,
      taxonomyFingerprint: "a".repeat(64), metadata: { attributes: [] },
    }; },
    rebuildItems: async ({ originalItems }) => { calls.push("rebuild"); return originalItems.map((item) => ({
      ...item, description_category_id: 30, type_id: 40, attributes: [],
    })); },
    activateRefreshedCategory: async () => { calls.push("activate"); return { id: "shared-a", version: 6, status: "ACTIVE" }; },
    markSharedNeedsReview: async () => { calls.push("shared-review"); return { status: "NEEDS_REVIEW" }; },
    scheduleRetry: async () => { calls.push("schedule"); return { scheduled: true }; },
    now: () => "2026-08-13T00:00:00.000Z",
    ...serviceOverrides,
  });
  return { service, calls };
}

const request = Object.freeze({
  accountId: "account-a", jobId: "job-a", evidenceId: "error-a", correlationId: "correlation-a",
});

test("recovery uses the exact safe order and commits corrected items before one retry schedule", async () => {
  const { service, calls } = harness();
  const result = await service.recover(request);
  assert.deepEqual(calls, [
    "load", "access", "absence", "claim", "invalidate", "refresh", "rebuild", "activate",
    "save-match", "retry-pending", "schedule",
  ]);
  assert.deepEqual(result, { attemptId: "attempt-a", status: "RETRY_PENDING" });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(basis().frozenItems[0].description_category_id, 10);
});

test("present or unknown offer state becomes NEEDS_REVIEW with zero category or retry work", async () => {
  for (const status of ["PRESENT", "UNKNOWN"]) {
    const { service, calls } = harness({
      confirmOfferAbsent: async () => { calls.push("absence"); return { status, code: `OFFER_${status}` }; },
    });
    assert.deepEqual(await service.recover(request), { attemptId: "attempt-a", status: "NEEDS_REVIEW" });
    assert.deepEqual(calls, ["load", "access", "absence", "review"]);
  }
});

test("stale/ambiguous/missing-attribute failures stop with review before scheduling", async () => {
  const cases = [
    { invalidateSharedCategory: async () => { throw Object.assign(new Error("raw"), { code: "OZON_CATEGORY_SHARED_VERSION_CONFLICT" }); } },
    { refreshCategory: async () => ({ kind: "NEEDS_REVIEW" }) },
    { rebuildItems: async () => { throw Object.assign(new Error("raw"), { code: "AUTO_LISTING_CATEGORY_ATTRIBUTES_INCOMPLETE" }); } },
  ];
  for (const override of cases) {
    const { service, calls } = harness(override);
    const result = await service.recover(request);
    assert.equal(result.status, "NEEDS_REVIEW");
    assert.equal(calls.includes("schedule"), false);
    assert.equal(calls.at(-1), "review");
  }
});

test("correction cannot alter frozen price/currency/content/media/store/warehouse/stock identity", async () => {
  const { service, calls } = harness({
    rebuildItems: async ({ originalItems }) => originalItems.map((item) => ({ ...item, currency_code: "CNY" })),
  });
  assert.deepEqual(await service.recover(request), { attemptId: "attempt-a", status: "NEEDS_REVIEW" });
  assert.equal(calls.includes("save-match"), false);
  assert.equal(calls.includes("schedule"), false);
  assert.equal(calls.includes("shared-review"), true);
});

test("cross-account or non-explicit/nonzero-product basis fails before store/Ozon access", async () => {
  for (const mutate of [
    (value) => ({ ...value, accountId: "account-b" }),
    (value) => ({ ...value, classification: "OTHER_TERMINAL_FAILURE" }),
    (value) => ({ ...value, productId: "123" }),
  ]) {
    const { service, calls } = harness({
      repository: { loadCategoryRecoveryBasis: async () => { calls.push("load"); return mutate(basis()); } },
    });
    await assert.rejects(service.recover(request), (error) => {
      assert.equal(error.code, "AUTO_LISTING_CATEGORY_RECOVERY_NOT_ELIGIBLE");
      assert.equal(error.cause, null);
      assert.doesNotMatch(error.message, /raw|secret/u);
      return true;
    });
    assert.deepEqual(calls, ["load"]);
  }
});

test("retry scheduling response loss remains durable RETRY_PENDING and never rebuilds again", async () => {
  const { service, calls } = harness({
    scheduleRetry: async () => { calls.push("schedule"); throw new Error("response-secret"); },
  });
  const result = await service.recover(request);
  assert.deepEqual(result, { attemptId: "attempt-a", status: "RETRY_PENDING" });
  assert.deepEqual(calls.slice(-3), ["save-match", "retry-pending", "schedule"]);
  assert.doesNotMatch(JSON.stringify(result), /secret/u);
});

test("an exact already-claimed attempt is returned without repeating category mutation or retry work", async () => {
  const { service, calls } = harness({
    repository: {
      claimCategoryRecovery: async () => {
        calls.push("claim");
        return { attemptId: "attempt-a", status: "RETRY_PENDING", claimed: false };
      },
    },
  });
  assert.deepEqual(await service.recover(request), { attemptId: "attempt-a", status: "RETRY_PENDING" });
  assert.deepEqual(calls, ["load", "access", "absence", "claim"]);
});

test("a persisted existing attempt replays before store access or offer reconciliation", async () => {
  const { service, calls } = harness({
    repository: {
      loadCategoryRecoveryBasis: async () => {
        calls.push("load");
        return { ...basis(), existingAttempt: { attemptId: "attempt-a", status: "RETRY_ACCEPTED" } };
      },
    },
  });
  assert.deepEqual(await service.recover(request), { attemptId: "attempt-a", status: "RETRY_ACCEPTED" });
  assert.deepEqual(calls, ["load"]);
});

test("hostile recovery commands fail safely before repository or external ports", async () => {
  const getter = { ...request };
  Object.defineProperty(getter, "accountId", { enumerable: true, get() { throw new Error("request-secret"); } });
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  for (const candidate of [getter, revoked.proxy, { ...request, extra: "secret" }]) {
    const { service, calls } = harness();
    await assert.rejects(service.recover(candidate), (error) => {
      assert.equal(error.code, "AUTO_LISTING_CATEGORY_RECOVERY_INVALID");
      assert.equal(error.cause, null);
      assert.doesNotMatch(error.message, /secret/u);
      return true;
    });
    assert.deepEqual(calls, []);
  }
});
