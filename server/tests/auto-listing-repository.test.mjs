import assert from "node:assert/strict";
import test from "node:test";
import { createAutoListingRepository } from "../auto-listing-repository.mjs";

function transitionFixture({
  status, recoveryPoint = null, failureCode = "AUTO_LISTING_TRANSIENT", legacyEvent = null, insertError = null,
} = {}) {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql)) return { rows: [] };
      if (/FROM auto_listing_job_items/.test(sql) && /FOR UPDATE/.test(sql)) {
        const row = { id: "item-a", job_id: "job-a", status, status_version: 3,
          recovery_point: recoveryPoint, failure_code: failureCode };
        if (!/failure_code/.test(sql)) delete row.failure_code;
        return { rows: [row] };
      }
      if (/FROM auto_listing_events e/.test(sql) && /ORDER BY e\.created_at DESC,e\.id DESC LIMIT 1/.test(sql)) {
        return { rows: legacyEvent ? [legacyEvent] : [] };
      }
      if (/UPDATE auto_listing_job_items/.test(sql)) return { rows: [{ id: "item-a", status: "PLANNING", status_version: 4 }] };
      if (/INSERT INTO auto_listing_events/.test(sql)) {
        if (insertError) throw insertError;
        return { rows: [] };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
    release() { calls.push({ sql: "RELEASE" }); },
  };
  return { calls, repository: createAutoListingRepository({ pool: { connect: async () => client, query: async () => ({ rows: [] }) } }) };
}

async function update(repository, eventType, details = {}) {
  return repository.updateItemStatus({
    accountId: "account-a", itemId: "item-a", expectedStatusVersion: 3,
    eventType, actorAccountId: "account-a", correlationId: "corr-a", details,
  });
}

test("retryable failure derives and atomically persists the locked recovery point", async () => {
  const { repository, calls } = transitionFixture({ status: "GENERATING" });
  await update(repository, "RETRYABLE_FAILURE", { failureCode: "AUTO_LISTING_TRANSIENT" });
  const updateCall = calls.find(({ sql }) => /UPDATE auto_listing_job_items/.test(sql));
  const eventCall = calls.find(({ sql }) => /INSERT INTO auto_listing_events/.test(sql));

  assert.equal(updateCall.params[1], "AUTO_LISTING_TRANSIENT");
  assert.equal(updateCall.params[2], "GENERATION");
  assert.deepEqual(JSON.parse(eventCall.params.at(-1)), {
    failureCode: "AUTO_LISTING_TRANSIENT", recoveryPoint: "GENERATION",
  });
});

test("a mismatched caller recovery point is rejected before item or event writes", async () => {
  const { repository, calls } = transitionFixture({ status: "GENERATING" });
  await assert.rejects(
    update(repository, "RETRYABLE_FAILURE", {
      failureCode: "AUTO_LISTING_TRANSIENT", recoveryPoint: "PLANNING",
    }),
    (error) => error?.code === "AUTO_LISTING_RECOVERY_POINT_MISMATCH",
  );
  assert.equal(calls.some(({ sql }) => /UPDATE auto_listing_job_items|INSERT INTO auto_listing_events/.test(sql)), false);
});

test("wrong retry leaves the locked item and audit log untouched", async () => {
  const { repository, calls } = transitionFixture({ status: "RETRYABLE_ERROR", recoveryPoint: "PLANNING" });
  await assert.rejects(
    update(repository, "RETRY_GENERATION"),
    (error) => error?.code === "AUTO_LISTING_TRANSITION_FORBIDDEN",
  );
  assert.equal(calls.some(({ sql }) => /UPDATE auto_listing_job_items|INSERT INTO auto_listing_events/.test(sql)), false);
  assert.equal(calls.some(({ sql }) => sql === "ROLLBACK"), true);
});

test("correct retry clears failure and recovery point in one CAS update", async () => {
  const { repository, calls } = transitionFixture({ status: "RETRYABLE_ERROR", recoveryPoint: "PLANNING" });
  await update(repository, "RETRY_PLANNING", { attempt: 2 });
  const updateCall = calls.find(({ sql }) => /UPDATE auto_listing_job_items/.test(sql));
  const eventCall = calls.find(({ sql }) => /INSERT INTO auto_listing_events/.test(sql));

  assert.equal(updateCall.params[1], null);
  assert.equal(updateCall.params[2], null);
  assert.deepEqual(JSON.parse(eventCall.params.at(-1)), { attempt: 2 });
});

test("cancelling a retryable item clears failure and recovery point in one CAS update", async () => {
  const { repository, calls } = transitionFixture({ status: "RETRYABLE_ERROR", recoveryPoint: "UPLOAD" });
  await update(repository, "CANCEL");
  const updateCall = calls.find(({ sql }) => /UPDATE auto_listing_job_items/.test(sql));

  assert.equal(updateCall.params[1], null);
  assert.equal(updateCall.params[2], null);
});

test("missing persisted recovery point fails closed before any update or event", async () => {
  const { repository, calls } = transitionFixture({ status: "RETRYABLE_ERROR" });
  await assert.rejects(
    update(repository, "RETRY_PLANNING"),
    (error) => error?.code === "AUTO_LISTING_RECOVERY_POINT_INVALID",
  );
  assert.equal(calls.some(({ sql }) => /UPDATE auto_listing_job_items|INSERT INTO auto_listing_events/.test(sql)), false);
});

test("a legacy retry uses only its latest complete failure event as recovery evidence", async () => {
  const { repository, calls } = transitionFixture({
    status: "RETRYABLE_ERROR",
    legacyEvent: {
      account_id: "account-a", job_id: "job-a", item_id: "item-a", event_type: "RETRYABLE_FAILURE",
      from_status: "UPLOADING", to_status: "RETRYABLE_ERROR",
      details: { failureCode: "AUTO_LISTING_TRANSIENT", recoveryPoint: "UPLOAD" },
    },
  });
  await update(repository, "RETRY_UPLOAD");
  assert.equal(calls.some(({ sql }) => /UPDATE auto_listing_job_items/.test(sql)), true);
});

test("legacy recovery rejects stale, cross-boundary, and incomplete latest-event evidence before writes", async () => {
  const base = {
    account_id: "account-a", job_id: "job-a", item_id: "item-a", event_type: "RETRYABLE_FAILURE",
    from_status: "PLANNING", to_status: "RETRYABLE_ERROR",
    details: { failureCode: "AUTO_LISTING_TRANSIENT", recoveryPoint: "PLANNING" },
  };
  for (const legacyEvent of [
    { ...base, event_type: "START_PLANNING" },
    { ...base, job_id: "other-job" },
    { ...base, account_id: "other-account" },
    { ...base, item_id: "other-item" },
    { ...base, to_status: "PLANNING" },
    { ...base, details: { failureCode: "AUTO_LISTING_TRANSIENT", recoveryPoint: "UPLOAD" } },
    { ...base, details: { failureCode: "OTHER_FAILURE", recoveryPoint: "PLANNING" } },
  ]) {
    const { repository, calls } = transitionFixture({ status: "RETRYABLE_ERROR", legacyEvent });
    await assert.rejects(
      update(repository, "RETRY_PLANNING"),
      (error) => error?.code === "AUTO_LISTING_RECOVERY_POINT_INVALID",
    );
    assert.equal(calls.some(({ sql }) => /UPDATE auto_listing_job_items|INSERT INTO auto_listing_events/.test(sql)), false);
  }
});

test("event insertion failure rolls back the status and recovery-point write", async () => {
  const failure = new Error("forced event insert failure");
  const { repository, calls } = transitionFixture({ status: "PLANNING", insertError: failure });
  await assert.rejects(
    update(repository, "RETRYABLE_FAILURE", { failureCode: "AUTO_LISTING_TRANSIENT" }),
    (error) => error === failure,
  );
  assert.equal(calls.some(({ sql }) => /UPDATE auto_listing_job_items/.test(sql)), true);
  assert.equal(calls.some(({ sql }) => sql === "ROLLBACK"), true);
  assert.equal(calls.some(({ sql }) => sql === "COMMIT"), false);
});
