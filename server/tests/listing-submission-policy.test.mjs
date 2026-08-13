import assert from "node:assert/strict";
import test from "node:test";
import {
  assertCategoryRecoverySubmissionTransition,
  assertListingPreparationInput,
  resolveLocalListingTarget,
  resolveListingPreparationReplay,
  resolveSubmissionFailureDisposition,
  validateTargetStoreRecord,
} from "../listing-submission-policy.mjs";

test("only the dedicated category transaction admits the amended two-stage retry lattice", () => {
  assert.equal(assertCategoryRecoverySubmissionTransition({
    fromStatus: "CHECKING", toStatus: "FAILED", categoryRecoveryTransaction: true,
  }), true);
  assert.equal(assertCategoryRecoverySubmissionTransition({
    fromStatus: "FAILED", toStatus: "RETRY_PENDING", categoryRecoveryTransaction: true,
  }), true);
  for (const input of [
    { fromStatus: "CHECKING", toStatus: "RETRY_PENDING", categoryRecoveryTransaction: true },
    { fromStatus: "FAILED", toStatus: "RETRY_PENDING", categoryRecoveryTransaction: false },
    { fromStatus: "CHECKING", toStatus: "FAILED", categoryRecoveryTransaction: false },
  ]) {
    assert.throws(() => assertCategoryRecoverySubmissionTransition(input), {
      code: "LISTING_CATEGORY_RECOVERY_TRANSITION_FORBIDDEN",
    });
  }
});

test("submission uncertainty is reconciled instead of retried", () => {
  assert.equal(resolveSubmissionFailureDisposition({ status: 503 }), "RECONCILING");
  assert.equal(resolveSubmissionFailureDisposition({ body: { network: true } }), "RECONCILING");
});

test("submission retries only an explicitly safe pre-submit failure", () => {
  assert.equal(resolveSubmissionFailureDisposition({ code: "SUBMISSION_NOT_SENT" }), "RETRY_PENDING");
});

test("listing preparation requires an explicit target store and idempotency key", () => {
  assert.throws(
    () => assertListingPreparationInput({
      accountId: "acct-a",
      collectItemId: "collect-a",
      targetStoreId: " ",
      idempotencyKey: "request-a",
    }),
    (error) => error?.status === 422 && error?.code === "TARGET_STORE_REQUIRED",
  );
  assert.throws(
    () => assertListingPreparationInput({
      accountId: "acct-a",
      collectItemId: "collect-a",
      targetStoreId: "store-a",
      idempotencyKey: "",
    }),
    (error) => error?.status === 422 && error?.code === "IDEMPOTENCY_KEY_REQUIRED",
  );
});

test("missing and foreign target stores share the same non-disclosing error", () => {
  for (const record of [null, {
    id: "store-b",
    ownerAccountId: "acct-b",
    label: "Foreign Secret Store",
    clientId: "foreign-client",
    status: "active",
    credentialsSaved: true,
  }]) {
    assert.throws(
      () => validateTargetStoreRecord({
        accountId: "acct-a",
        targetStoreId: "store-b",
        store: record,
        validatedAt: "2026-07-29T00:00:00.000Z",
      }),
      (error) => {
        assert.equal(error?.status, 404);
        assert.equal(error?.code, "TARGET_STORE_NOT_FOUND");
        assert.doesNotMatch(error?.message || "", /Foreign Secret Store|foreign-client/);
        return true;
      },
    );
  }
});

test("disabled target stores and missing credentials have stable validation errors", () => {
  assert.throws(
    () => validateTargetStoreRecord({
      accountId: "acct-a",
      targetStoreId: "store-a",
      store: {
        id: "store-a",
        ownerAccountId: "acct-a",
        status: "disabled",
        clientId: "client-a",
        credentialsSaved: true,
      },
    }),
    (error) => error?.status === 409 && error?.code === "TARGET_STORE_DISABLED",
  );
  assert.throws(
    () => validateTargetStoreRecord({
      accountId: "acct-a",
      targetStoreId: "store-a",
      store: {
        id: "store-a",
        ownerAccountId: "acct-a",
        status: "active",
        clientId: "client-a",
        credentialsSaved: false,
      },
    }),
    (error) => error?.status === 409 && error?.code === "TARGET_STORE_CREDENTIALS_REQUIRED",
  );
});

test("validated target metadata excludes every credential field", () => {
  const target = validateTargetStoreRecord({
    accountId: "acct-a",
    targetStoreId: "store-a",
    validatedAt: "2026-07-29T00:00:00.000Z",
    store: {
      id: "store-a",
      ownerAccountId: "acct-a",
      label: "Store A",
      clientId: "client-a",
      currencyCode: "RUB",
      status: "active",
      credentialsSaved: true,
      apiKey: "plain-secret",
      encryptedApiKey: "ciphertext",
      encrypted_api_key: "ciphertext",
      iv: "iv",
      authTag: "tag",
    },
  });

  assert.deepEqual(target, {
    id: "store-a",
    label: "Store A",
    clientId: "client-a",
    currencyCode: "RUB",
    validatedAt: "2026-07-29T00:00:00.000Z",
  });
  assert.doesNotMatch(JSON.stringify(target), /plain-secret|ciphertext|apiKey|credential|authTag|iv/);
});

test("frozen replay conflicts preserve the existing listing state", () => {
  const existing = {
    id: "job-a",
    collect_item_id: "collect-a",
    store_id: "store-a",
  };
  assert.equal(resolveListingPreparationReplay({
    existing,
    collectItemId: "collect-a",
    targetStoreId: "store-a",
  }), existing);
  assert.throws(
    () => resolveListingPreparationReplay({
      existing,
      collectItemId: "collect-a",
      targetStoreId: "store-b",
    }),
    (error) => error?.status === 409
      && error?.code === "LISTING_TARGET_STORE_CONFLICT"
      && error?.preserveExistingListing === true,
  );
  assert.throws(
    () => resolveListingPreparationReplay({
      existing,
      collectItemId: "collect-b",
      targetStoreId: "store-a",
    }),
    (error) => error?.status === 409
      && error?.code === "LISTING_IDEMPOTENCY_CONFLICT"
      && error?.preserveExistingListing === true,
  );
});

test("local listing target resolution returns the full store separately from safe metadata", () => {
  const store = {
    id: "store-a",
    ownerAccountId: "acct-a",
    label: "Store A",
    clientId: "client-a",
    currencyCode: "RUB",
    status: "active",
    apiKey: "plain-secret",
  };
  const resolved = resolveLocalListingTarget({
    accountId: "acct-a",
    collectItemId: "collect-a",
    targetStoreId: "store-a",
    idempotencyKey: "request-a",
    findStore: () => store,
    validatedAt: "2026-07-29T00:00:00.000Z",
  });
  assert.equal(resolved.store, store);
  assert.deepEqual(resolved.target, {
    id: "store-a",
    label: "Store A",
    clientId: "client-a",
    currencyCode: "RUB",
    validatedAt: "2026-07-29T00:00:00.000Z",
  });
  assert.doesNotMatch(JSON.stringify(resolved.target), /plain-secret|apiKey/);
});
