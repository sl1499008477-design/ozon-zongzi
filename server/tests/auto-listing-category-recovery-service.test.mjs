import assert from "node:assert/strict";
import test from "node:test";
import { createAutoListingCategoryRecoveryService } from "../auto-listing-category-recovery-service.mjs";

function sharedCategory(overrides = {}) {
  return Object.freeze({
    accountId: "account-a", sourceDescriptionCategoryId: 10, sourceTypeId: 20,
    taxonomyScope: "OZON:DEFAULT", currentDescriptionCategoryId: 10, currentTypeId: 20,
    status: "ACTIVE", source: "SOURCE_DIRECT", taxonomyFingerprint: null,
    version: 4, evidenceId: "source-a", validatedAt: null, ...overrides,
  });
}

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
    sharedCategory: sharedCategory(),
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
  const savedMatches = [];
  let shared = sharedCategory();
  const { repository: repositoryOverrides = {}, ...serviceOverrides } = overrides;
  const repository = {
    loadCategoryRecoveryBasis: async (input) => { calls.push("load"); return basis(); },
    claimCategoryRecovery: async () => { calls.push("claim"); return { attemptId: "attempt-a", status: "CLAIMED", claimed: true }; },
    saveCategoryRecoveryMatch: async (input) => { calls.push("save-match"); savedMatches.push(input); return {
      attemptId: "attempt-a", status: "MATCHED",
      replacementSharedCategoryId: input.replacementSharedCategoryId,
      replacementSharedCategoryVersion: input.replacementSharedCategoryVersion,
      correctedItemsHash: input.correctedItemsHash,
    }; },
    markCategoryRecoveryRetryPending: async () => { calls.push("retry-pending"); return { attemptId: "attempt-a", status: "RETRY_PENDING" }; },
    requireCategoryRecoveryReview: async () => { calls.push("review"); return { attemptId: "attempt-a", status: "NEEDS_REVIEW" }; },
    ...repositoryOverrides,
  };
  const service = createAutoListingCategoryRecoveryService({
    repository,
    loadOperatingStoreAccess: async () => { calls.push("access"); return { clientId: "client", apiKey: "key" }; },
    confirmOfferAbsent: async () => { calls.push("absence"); return {
      status: "ABSENT", code: "OZON_OFFERS_CONFIRMED_ABSENT",
    }; },
    invalidateSharedCategory: async () => {
      calls.push("invalidate");
      shared = sharedCategory({ ...shared, status: "INVALIDATED", version: shared.version + 1 });
      return shared;
    },
    refreshCategory: async () => { calls.push("refresh"); return {
      kind: "UNIQUE_MATCH", descriptionCategoryId: 30, typeId: 40,
      taxonomyFingerprint: "a".repeat(64), metadata: {
        descriptionCategoryId: 30,
        typeId: 40,
        attributes: [
          { id: 1, complexId: 0, required: false, dictionaryId: null, dictionaryValues: [] },
        ],
      },
    }; },
    rebuildItems: async ({ originalItems }) => { calls.push("rebuild"); return originalItems.map((item) => ({
      ...item, description_category_id: 30, type_id: 40, attributes: [],
    })); },
    activateRefreshedCategory: async (input) => {
      calls.push("activate");
      shared = sharedCategory({ ...shared, currentDescriptionCategoryId: input.currentDescriptionCategoryId,
        currentTypeId: input.currentTypeId, status: "ACTIVE", source: "OZON_REFRESH",
        taxonomyFingerprint: input.taxonomyFingerprint, version: shared.version + 1,
        validatedAt: input.validatedAt });
      return shared;
    },
    markSharedNeedsReview: async () => {
      calls.push("shared-review");
      shared = sharedCategory({ ...shared, status: "NEEDS_REVIEW", version: shared.version + 1 });
      return shared;
    },
    scheduleRetry: async () => { calls.push("schedule"); return { scheduled: true }; },
    now: () => "2026-08-13T00:00:00.000Z",
    ...serviceOverrides,
  });
  return { service, calls, savedMatches };
}

const request = Object.freeze({
  accountId: "account-a", jobId: "job-a", evidenceId: "error-a", correlationId: "correlation-a",
});

test("recovery uses the exact safe order and commits corrected items before one retry schedule", async () => {
  const { service, calls, savedMatches } = harness();
  const result = await service.recover(request);
  assert.deepEqual(calls, [
    "load", "access", "absence", "claim", "invalidate", "refresh", "rebuild", "activate",
    "save-match", "retry-pending", "schedule",
  ]);
  assert.deepEqual(result, { attemptId: "attempt-a", status: "RETRY_PENDING" });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(basis().frozenItems[0].description_category_id, 10);
  assert.deepEqual(JSON.parse(JSON.stringify(savedMatches[0].replacementCategoryMetadata)), {
    descriptionCategoryId: 30, typeId: 40, attributes: [
      { id: 1, complexId: 0, required: false, dictionaryId: null, dictionaryValues: [] },
    ],
  });
});

test("present or unknown offer state becomes NEEDS_REVIEW with zero category or retry work", async () => {
  for (const status of ["PRESENT", "UNKNOWN"]) {
    const { service, calls } = harness({
      confirmOfferAbsent: async () => { calls.push("absence"); return {
        status, code: status === "PRESENT" ? "OZON_OFFER_PRESENT" : "OZON_OFFER_RECONCILIATION_UNKNOWN",
      }; },
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

test("a failure after activation marks the actual activated version and the exact attempt for review", async () => {
  let sharedReview;
  let attemptReview;
  const { service, calls } = harness({
    repository: {
      saveCategoryRecoveryMatch: async () => { calls.push("save-match"); throw new Error("db-secret"); },
      requireCategoryRecoveryReview: async (input) => {
        calls.push("review");
        attemptReview = input;
        return { attemptId: "attempt-a", status: "NEEDS_REVIEW" };
      },
    },
    markSharedNeedsReview: async (input) => {
      calls.push("shared-review");
      sharedReview = input;
      return sharedCategory({
        currentDescriptionCategoryId: 30, currentTypeId: 40, status: "NEEDS_REVIEW",
        source: "OZON_REFRESH", taxonomyFingerprint: "a".repeat(64), version: 7,
        validatedAt: "2026-08-13T00:00:00.000Z",
      });
    },
  });
  assert.deepEqual(await service.recover(request), { attemptId: "attempt-a", status: "NEEDS_REVIEW" });
  assert.equal(sharedReview.expectedVersion, 6);
  assert.equal(attemptReview.attemptId, "attempt-a");
  assert.equal(attemptReview.sourceEvidenceId, "source-a");
  assert.equal(attemptReview.oldSharedCategoryVersion, 4);
  assert.deepEqual(calls.slice(-3), ["save-match", "shared-review", "review"]);
});

test("a stale activation response cannot masquerade as the activated version", async () => {
  let sharedReview;
  const { service, calls } = harness({
    activateRefreshedCategory: async () => {
      calls.push("activate");
      return sharedCategory({ status: "ACTIVE", version: 5 });
    },
    markSharedNeedsReview: async (input) => {
      calls.push("shared-review");
      sharedReview = input;
      return sharedCategory({ status: "NEEDS_REVIEW", version: 6 });
    },
  });
  assert.deepEqual(await service.recover(request), { attemptId: "attempt-a", status: "NEEDS_REVIEW" });
  assert.equal(sharedReview.expectedVersion, 5);
  assert.equal(calls.includes("save-match"), false);
  assert.equal(calls.at(-1), "review");
});

test("shared review write failure is not swallowed after activation and attempt review is still attempted", async () => {
  const { service, calls } = harness({
    repository: {
      saveCategoryRecoveryMatch: async () => { calls.push("save-match"); throw new Error("db-secret"); },
    },
    markSharedNeedsReview: async () => { calls.push("shared-review"); throw new Error("shared-secret"); },
  });
  await assert.rejects(service.recover(request), (error) => {
    assert.equal(error.code, "AUTO_LISTING_CATEGORY_RECOVERY_INCOMPLETE");
    assert.equal(error.cause, null);
    assert.doesNotMatch(error.message, /secret/u);
    return true;
  });
  assert.deepEqual(calls.slice(-3), ["save-match", "shared-review", "review"]);
});

test("mismatched port result identities fail closed before retry scheduling", async () => {
  const cases = [
    {
      invalidateSharedCategory: async () => sharedCategory({
        status: "INVALIDATED", version: 5, evidenceId: "source-wrong",
      }),
    },
    {
      activateRefreshedCategory: async () => ({
        ...sharedCategory({
          currentDescriptionCategoryId: 30, currentTypeId: 40, status: "ACTIVE",
          source: "OZON_REFRESH", taxonomyFingerprint: "a".repeat(64), version: 6,
          validatedAt: "2026-08-13T00:00:00.000Z",
        }),
        extra: "forged",
      }),
    },
    {
      repository: {
        saveCategoryRecoveryMatch: async () => ({
          attemptId: "attempt-a", status: "MATCHED", replacementSharedCategoryId: "shared-a",
          replacementSharedCategoryVersion: 6, correctedItemsHash: "f".repeat(64),
        }),
      },
    },
    {
      repository: {
        markCategoryRecoveryRetryPending: async () => ({ attemptId: "attempt-wrong", status: "RETRY_PENDING" }),
      },
    },
  ];
  for (const overrides of cases) {
    const { service, calls } = harness(overrides);
    assert.deepEqual(await service.recover(request), { attemptId: "attempt-a", status: "NEEDS_REVIEW" });
    assert.equal(calls.includes("schedule"), false);
    assert.equal(calls.at(-1), "review");
  }
});

test("hostile shared DTOs are not executed and invalid review DTOs expose one fixed failure", async () => {
  let executed = false;
  const hostile = sharedCategory({
    currentDescriptionCategoryId: 30, currentTypeId: 40, status: "ACTIVE",
    source: "OZON_REFRESH", taxonomyFingerprint: "a".repeat(64), version: 6,
    validatedAt: "2026-08-13T00:00:00.000Z",
  });
  const descriptors = Object.getOwnPropertyDescriptors(hostile);
  descriptors.status = { enumerable: true, configurable: true, get() { executed = true; return "ACTIVE"; } };
  const accessorDto = Object.defineProperties({}, descriptors);
  const first = harness({ activateRefreshedCategory: async () => accessorDto });
  assert.deepEqual(await first.service.recover(request), { attemptId: "attempt-a", status: "NEEDS_REVIEW" });
  assert.equal(executed, false);
  assert.equal(first.calls.includes("schedule"), false);

  const second = harness({
    repository: { saveCategoryRecoveryMatch: async () => { throw new Error("raw-secret"); } },
    markSharedNeedsReview: async () => sharedCategory({ status: "NEEDS_REVIEW", version: 999 }),
  });
  await assert.rejects(second.service.recover(request), (error) => {
    assert.equal(error.code, "AUTO_LISTING_CATEGORY_RECOVERY_INCOMPLETE");
    assert.equal(error.cause, null);
    assert.doesNotMatch(error.message, /raw|secret/u);
    return true;
  });
  assert.equal(second.calls.includes("schedule"), false);
  assert.equal(second.calls.at(-1), "review");
});

test("absence, refresh and review ports require exact descriptor-safe DTOs", async () => {
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  let getterRuns = 0;
  const getter = {};
  Object.defineProperty(getter, "status", {
    enumerable: true, get() { getterRuns += 1; throw new Error("port-secret"); },
  });
  for (const absence of [
    { status: "ABSENT", code: "ABSENT" },
    { status: "ABSENT", code: "OZON_OFFERS_CONFIRMED_ABSENT", extra: "secret" },
    getter,
    new Proxy({ status: "ABSENT", code: "OZON_OFFERS_CONFIRMED_ABSENT" }, {}),
    revoked.proxy,
  ]) {
    const { service, calls } = harness({ confirmOfferAbsent: async () => absence });
    assert.deepEqual(await service.recover(request), { attemptId: "attempt-a", status: "NEEDS_REVIEW" });
    assert.equal(calls.includes("claim"), false);
    assert.equal(calls.includes("schedule"), false);
  }
  assert.equal(getterRuns, 0);

  for (const refresh of [
    { kind: "UNIQUE_MATCH", descriptionCategoryId: 30, typeId: 40,
      taxonomyFingerprint: "a".repeat(64), metadata: { attributes: [] }, extra: true },
    new Proxy({ kind: "UNIQUE_MATCH", descriptionCategoryId: 30, typeId: 40,
      taxonomyFingerprint: "a".repeat(64), metadata: { attributes: [] } }, {}),
    { kind: "UNIQUE_MATCH", descriptionCategoryId: 30, typeId: 40,
      taxonomyFingerprint: "a".repeat(64), metadata: {
        descriptionCategoryId: 30, typeId: 40, attributes: [
          { id: 1, complexId: 0, required: false, dictionaryId: null,
            dictionaryValues: [], extra: true },
        ],
      } },
    { kind: "UNIQUE_MATCH", descriptionCategoryId: 30, typeId: 40,
      taxonomyFingerprint: "a".repeat(64), metadata: new Proxy({
        descriptionCategoryId: 30, typeId: 40, attributes: [
          { id: 1, complexId: 0, required: false, dictionaryId: null, dictionaryValues: [] },
        ],
      }, {}) },
    revoked.proxy,
  ]) {
    const { service, calls } = harness({ refreshCategory: async () => refresh });
    assert.deepEqual(await service.recover(request), { attemptId: "attempt-a", status: "NEEDS_REVIEW" });
    assert.equal(calls.includes("rebuild"), false);
    assert.equal(calls.includes("schedule"), false);
  }

  for (const review of [
    { attemptId: "attempt-wrong", status: "NEEDS_REVIEW" },
    { attemptId: "attempt-a", status: "MATCHED" },
    { attemptId: "attempt-a", status: "NEEDS_REVIEW", extra: true },
    new Proxy({ attemptId: "attempt-a", status: "NEEDS_REVIEW" }, {}),
    revoked.proxy,
  ]) {
    const { service, calls } = harness({
      repository: {
        saveCategoryRecoveryMatch: async () => { calls.push("save-match"); throw new Error("raw-secret"); },
        requireCategoryRecoveryReview: async () => { calls.push("review"); return review; },
      },
    });
    await assert.rejects(service.recover(request), (error) => {
      assert.equal(error.code, "AUTO_LISTING_CATEGORY_RECOVERY_INCOMPLETE");
      assert.equal(error.cause, null);
      assert.doesNotMatch(error.message, /raw|secret/u);
      return true;
    });
    assert.equal(calls.includes("schedule"), false);
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

test("correction requires each item to own one descriptor-safe attributes array", async () => {
  let getterRuns = 0;
  const revoked = Proxy.revocable([], {});
  revoked.revoke();
  const cases = [
    (item) => { const { attributes, ...missing } = item; return missing; },
    (item) => ({ ...item, attributes: null }),
    (item) => ({ ...item, attributes: {} }),
    (item) => {
      const next = { ...item };
      Object.defineProperty(next, "attributes", {
        enumerable: true,
        get() { getterRuns += 1; throw new Error("attributes-secret"); },
      });
      return next;
    },
    (item) => ({ ...item, attributes: new Proxy([], {}) }),
    (item) => ({ ...item, attributes: revoked.proxy }),
  ];
  for (const makeItem of cases) {
    const { service, calls } = harness({
      rebuildItems: async ({ originalItems }) => originalItems.map((item) => makeItem({
        ...item, description_category_id: 30, type_id: 40, attributes: [],
      })),
    });
    assert.deepEqual(await service.recover(request), {
      attemptId: "attempt-a", status: "NEEDS_REVIEW",
    });
    assert.equal(calls.includes("save-match"), false);
    assert.equal(calls.includes("schedule"), false);
    assert.equal(calls.at(-1), "review");
  }
  assert.equal(getterRuns, 0);
});

test("correction accepts only the closed production complex-attributes carrier when present", async () => {
  const revoked = Proxy.revocable([], {});
  revoked.revoke();
  const cases = [
    null,
    {},
    [],
    [{}],
    [{ attributes: null }],
    [{ attributes: [] }],
    [{ attributes: [null] }],
    [{ attributes: [{ id: 300, complex_id: 0, values: [{ value: "safe" }] }] }],
    [{ attributes: [{ id: 0, complex_id: 77, values: [{ value: "safe" }] }] }],
    [{ attributes: [{ id: 300, complex_id: 77, values: [] }] }],
    [{ attributes: [{ id: 300, complex_id: 77, values: [{ value: "" }] }] }],
    [{ attributes: [{ id: 300, complex_id: 77, values: [{ value: "safe", extra: true }] }] }],
    [{ attributes: [{ id: 300, complex_id: 77, values: [{ value: "safe" }] }], extra: true }],
    new Proxy([], {}),
    revoked.proxy,
  ];
  for (const complexAttributes of cases) {
    const { service, calls } = harness({
      rebuildItems: async ({ originalItems }) => originalItems.map((item) => ({
        ...item, description_category_id: 30, type_id: 40, attributes: [],
        complex_attributes: complexAttributes,
      })),
    });
    assert.deepEqual(await service.recover(request), {
      attemptId: "attempt-a", status: "NEEDS_REVIEW",
    });
    assert.equal(calls.includes("save-match"), false);
    assert.equal(calls.includes("schedule"), false);
  }
});

test("complex correction is closed against refreshed metadata before any match persistence or retry", async () => {
  const metadataAttributes = [
    { id: 300, complexId: 77, required: true, dictionaryId: 5,
      dictionaryValues: [{ id: 900, value: "canonical" }] },
    { id: 400, complexId: 77, required: false, dictionaryId: null, dictionaryValues: [] },
    { id: 400, complexId: 88, required: false, dictionaryId: null, dictionaryValues: [] },
  ];
  const attribute = (overrides = {}) => ({
    complex_id: 77, id: 300,
    values: [{ value: "canonical", dictionary_value_id: 900 }],
    ...overrides,
  });
  const repeated = Array.from({ length: 1_001 }, (_, index) => ({
    complex_id: 77,
    id: index + 1,
    values: [{ value: "safe" }],
  }));
  const cases = [
    [{ attributes: [attribute(), attribute({ complex_id: 88, id: 400, values: [{ value: "safe" }] })] }],
    [{ attributes: [attribute(), attribute()] }],
    [{ attributes: [attribute()] }, { attributes: [attribute()] }],
    [{ attributes: repeated.slice(0, 1_000) }, { attributes: repeated.slice(1_000) }],
    ...[" ", "\t", "\n", "\u00a0", "\u1680", "\u2007", "\u202f", "\u3000", "\ufeff"]
      .map((value) => [{ attributes: [attribute({ values: [{ value, dictionary_value_id: 900 }] })] }]),
    [{ attributes: [attribute({ id: 999, values: [{ value: "safe" }] })] }],
    [{ attributes: [attribute({ values: [{ value: "canonical", dictionary_value_id: 901 }] })] }],
    [{ attributes: [attribute({ values: [{ value: "wrong", dictionary_value_id: 900 }] })] }],
  ];
  for (const complexAttributes of cases) {
    const { service, calls } = harness({
      refreshCategory: async () => {
        calls.push("refresh");
        return {
          kind: "UNIQUE_MATCH", descriptionCategoryId: 30, typeId: 40,
          taxonomyFingerprint: "a".repeat(64), metadata: {
            descriptionCategoryId: 30, typeId: 40, attributes: metadataAttributes,
          },
        };
      },
      rebuildItems: async ({ originalItems }) => originalItems.map((item) => ({
        ...item, description_category_id: 30, type_id: 40, attributes: [],
        complex_attributes: complexAttributes,
      })),
    });
    assert.deepEqual(await service.recover(request), {
      attemptId: "attempt-a", status: "NEEDS_REVIEW",
    });
    assert.equal(calls.includes("save-match"), false);
    assert.equal(calls.includes("retry-pending"), false);
    assert.equal(calls.includes("schedule"), false);
  }
});

test("simple correction shares the exact refreshed-metadata contract with complex attributes", async () => {
  const metadataAttributes = [
    { id: 1, complexId: 0, required: false, dictionaryId: null, dictionaryValues: [] },
    { id: 2, complexId: 0, required: false, dictionaryId: 5,
      dictionaryValues: [{ id: 900, value: "canonical" }] },
    { id: 300, complexId: 77, required: false, dictionaryId: null, dictionaryValues: [] },
  ];
  const validSimple = { complex_id: 0, id: 1,
    values: [{ value: "safe", dictionary_value_id: 777 }] };
  const cases = [
    [{ id: 1, values: [{ value: "safe" }] }],
    [{ complex_id: 77, id: 1, values: [{ value: "safe" }] }],
    [{ complex_id: 0, id: 999, values: [{ value: "safe" }] }],
    [validSimple, validSimple],
    [{ complex_id: 0, id: 2, values: [{ value: "canonical" }] }],
    [{ complex_id: 0, id: 2, values: [{ value: "canonical", dictionary_value_id: 901 }] }],
    [{ complex_id: 0, id: 2, values: [{ value: "wrong", dictionary_value_id: 900 }] }],
    ...[" ", "\t", "\n", "\u00a0", "\u1680", "\u2007", "\u202f", "\u3000", "\ufeff"]
      .map((value) => [{ complex_id: 0, id: 1, values: [{ value }] }]),
  ];
  for (const attributes of cases) {
    const { service, calls } = harness({
      refreshCategory: async () => {
        calls.push("refresh");
        return { kind: "UNIQUE_MATCH", descriptionCategoryId: 30, typeId: 40,
          taxonomyFingerprint: "a".repeat(64), metadata: {
            descriptionCategoryId: 30, typeId: 40, attributes: metadataAttributes,
          } };
      },
      rebuildItems: async ({ originalItems }) => originalItems.map((item) => ({
        ...item, description_category_id: 30, type_id: 40, attributes,
      })),
    });
    assert.deepEqual(await service.recover(request), {
      attemptId: "attempt-a", status: "NEEDS_REVIEW",
    });
    assert.equal(calls.includes("save-match"), false);
    assert.equal(calls.includes("retry-pending"), false);
    assert.equal(calls.includes("schedule"), false);
  }

  const legal = harness({
    refreshCategory: async () => ({ kind: "UNIQUE_MATCH", descriptionCategoryId: 30, typeId: 40,
      taxonomyFingerprint: "a".repeat(64), metadata: {
        descriptionCategoryId: 30, typeId: 40, attributes: metadataAttributes,
      } }),
    rebuildItems: async ({ originalItems }) => originalItems.map((item) => ({
      ...item, description_category_id: 30, type_id: 40, attributes: [
        validSimple,
        { complex_id: 0, id: 2,
          values: [{ value: "canonical", dictionary_value_id: 900 }] },
      ],
      complex_attributes: [{ attributes: [
        { complex_id: 77, id: 300, values: [{ value: "complex-safe" }] },
      ] }],
    })),
  });
  assert.deepEqual(await legal.service.recover(request), {
    attemptId: "attempt-a", status: "RETRY_PENDING",
  });
});

test("simple and complex correction attributes share one 1000-attribute item limit", async () => {
  const metadataAttributes = Array.from({ length: 1_000 }, (_, index) => ({
    id: index + 1, complexId: index === 999 ? 77 : 0, required: false,
    dictionaryId: null, dictionaryValues: [],
  }));
  const { service, calls } = harness({
    refreshCategory: async () => {
      calls.push("refresh");
      return { kind: "UNIQUE_MATCH", descriptionCategoryId: 30, typeId: 40,
        taxonomyFingerprint: "a".repeat(64), metadata: {
          descriptionCategoryId: 30, typeId: 40, attributes: metadataAttributes,
        } };
    },
    rebuildItems: async ({ originalItems }) => originalItems.map((item) => ({
      ...item, description_category_id: 30, type_id: 40,
      attributes: metadataAttributes.slice(0, 999).map((attribute) => ({
        complex_id: 0, id: attribute.id, values: [{ value: "safe" }],
      })),
      complex_attributes: [{ attributes: [
        { complex_id: 77, id: 1_000, values: [{ value: "safe" }] },
        { complex_id: 77, id: 1_000, values: [{ value: "safe" }] },
      ] }],
    })),
  });
  assert.deepEqual(await service.recover(request), {
    attemptId: "attempt-a", status: "NEEDS_REVIEW",
  });
  assert.equal(calls.includes("save-match"), false);
  assert.equal(calls.includes("schedule"), false);
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
        return { ...basis(), existingAttempt: {
          attemptId: "attempt-a", status: "RETRY_ACCEPTED", correlationId: "correlation-a",
        } };
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
