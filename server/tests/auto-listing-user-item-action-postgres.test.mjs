import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { createPostgresAutoListingUserItemActionRepository } from "../auto-listing-user-item-action-postgres.mjs";

function command(overrides = {}) {
  return {
    accountId: "account-a", actorAccountId: "account-a", jobId: "job-a", itemId: "item-a",
    expectedStatusVersion: 5, idempotencyKey: "command-a", correlationId: "correlation-a", ...overrides,
  };
}

function requestHash(value, action) {
  return crypto.createHash("sha256").update(JSON.stringify({ ...value, action }), "utf8").digest("hex");
}

function db({ status = "READY_FOR_REVIEW", recoveryPoint = null, failureCode = null, existing = null } = {}) {
  const queries = [];
  const client = {
    async query(sql, values = []) {
      queries.push({ sql, values });
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rows: [], rowCount: 0 };
      if (/set_config\('statement_timeout'/i.test(sql)) return { rows: [{}], rowCount: 1 };
      if (/FROM auto_listing_user_commands[\s\S]*FOR UPDATE/i.test(sql)) {
        return existing ? { rows: [existing], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      if (/FROM auto_listing_job_items AS i[\s\S]*FOR UPDATE OF i/i.test(sql)) {
        return { rows: [{ status, status_version: 5, recovery_point: recoveryPoint,
          failure_code: failureCode }], rowCount: 1 };
      }
      if (/UPDATE auto_listing_job_items/i.test(sql)) {
        const next = values[4];
        return { rows: [{ status: next, status_version: 6 }], rowCount: 1 };
      }
      if (/INSERT INTO auto_listing_user_commands/i.test(sql)) return { rows: [{ id: values[0] }], rowCount: 1 };
      if (/INSERT INTO auto_listing_events/i.test(sql)) return { rows: [{ id: values[0] }], rowCount: 1 };
      if (/INSERT INTO auto_listing_ai_outbox/i.test(sql)) return { rows: [{ id: values[0] }], rowCount: 1 };
      if (/INSERT INTO auto_listing_upload_tasks/i.test(sql)) return { rows: [{ id: values[0] }], rowCount: 1 };
      if (/INSERT INTO auto_listing_upload_task_events/i.test(sql)) return { rows: [{ id: 1 }], rowCount: 1 };
      throw new Error(`unexpected SQL: ${sql}`);
    },
    release() {},
  };
  return { pool: { async connect() { return client; }, async query() {} }, queries };
}

test("regenerate atomically returns to PLANNING, records the command and enqueues one new plan", async () => {
  const harness = db();
  const repository = createPostgresAutoListingUserItemActionRepository({ pool: harness.pool });
  assert.deepEqual(await repository.regenerateItem(command()), {
    status: "PLANNING", statusVersion: 6, action: "REGENERATE", duplicate: false,
  });
  const sql = harness.queries.map((entry) => entry.sql).join("\n");
  assert.match(sql, /active_content_plan_id=CASE WHEN \$5='PLANNING' THEN NULL ELSE active_content_plan_id END/i);
  assert.match(sql, /INSERT INTO auto_listing_ai_outbox/i);
  assert.match(sql, /'PLAN_CONTENT'/i);
  assert.match(sql, /INSERT INTO auto_listing_user_commands/i);
  assert.match(sql, /INSERT INTO auto_listing_events/i);
  assert.ok(harness.queries.findIndex(({ sql: value }) => /UPDATE auto_listing_job_items/i.test(value))
    < harness.queries.findIndex(({ sql: value }) => /INSERT INTO auto_listing_ai_outbox/i.test(value)));
});

test("regenerate replans only retryable planning or generation failures", async () => {
  for (const recoveryPoint of ["PLANNING", "GENERATION"]) {
    const harness = db({ status: "RETRYABLE_ERROR", recoveryPoint });
    const repository = createPostgresAutoListingUserItemActionRepository({ pool: harness.pool });
    assert.deepEqual(await repository.regenerateItem(command({
      idempotencyKey: `regenerate-${recoveryPoint.toLowerCase()}`,
    })), {
      status: "PLANNING", statusVersion: 6, action: "REGENERATE", duplicate: false,
    });
    assert.equal(harness.queries.some(({ sql }) => /INSERT INTO auto_listing_ai_outbox/i.test(sql)), true);
    assert.equal(harness.queries.some(({ sql }) => /INSERT INTO auto_listing_events/i.test(sql)), true);
  }

  const upload = db({ status: "RETRYABLE_ERROR", recoveryPoint: "UPLOAD" });
  await assert.rejects(
    createPostgresAutoListingUserItemActionRepository({ pool: upload.pool }).regenerateItem(command()),
    { code: "AUTO_LISTING_USER_ACTION_NOT_ALLOWED" },
  );
  assert.equal(upload.queries.some(({ sql }) => /UPDATE auto_listing_job_items/i.test(sql)), false);
  assert.equal(upload.queries.some(({ sql }) => /INSERT INTO auto_listing_ai_outbox/i.test(sql)), false);
});

test("cancel atomically closes only a cancellable exact version without queueing AI work", async () => {
  const harness = db({ status: "GENERATING" });
  const repository = createPostgresAutoListingUserItemActionRepository({ pool: harness.pool });
  assert.deepEqual(await repository.cancelItem(command()), {
    status: "CANCELLED", statusVersion: 6, action: "CANCEL", duplicate: false,
  });
  const update = harness.queries.find(({ sql }) => /UPDATE auto_listing_job_items/i.test(sql));
  assert.match(update.sql, /active_content_plan_id=CASE WHEN \$5='PLANNING' THEN NULL ELSE active_content_plan_id END/i);
  assert.equal(harness.queries.some(({ sql }) => /INSERT INTO auto_listing_ai_outbox/i.test(sql)), false);
});

test("cancel closes a content-planning block that cannot have reached Ozon but keeps unsafe blocks terminal", async () => {
  const safe = db({ status: "BLOCKED", failureCode: "AUTO_LISTING_CONTENT_PLAN_INVALID" });
  assert.deepEqual(await createPostgresAutoListingUserItemActionRepository({ pool: safe.pool }).cancelItem(command()), {
    status: "CANCELLED", statusVersion: 6, action: "CANCEL", duplicate: false,
  });
  assert.equal(safe.queries.some(({ sql }) => /INSERT INTO auto_listing_ai_outbox/i.test(sql)), false);

  const unsafe = db({ status: "BLOCKED", failureCode: "AUTO_LISTING_UPLOAD_RESULT_UNCERTAIN" });
  await assert.rejects(
    createPostgresAutoListingUserItemActionRepository({ pool: unsafe.pool }).cancelItem(command()),
    { code: "AUTO_LISTING_USER_ACTION_NOT_ALLOWED" },
  );
  assert.equal(unsafe.queries.some(({ sql }) => /UPDATE auto_listing_job_items/i.test(sql)), false);
});

test("approve atomically queues only the exact reviewed version for upload", async () => {
  const harness = db({ status: "READY_FOR_REVIEW" });
  const repository = createPostgresAutoListingUserItemActionRepository({ pool: harness.pool });
  assert.deepEqual(await repository.approveItem(command()), {
    status: "UPLOAD_QUEUED", statusVersion: 6, action: "APPROVE_UPLOAD", duplicate: false,
  });
  assert.equal(harness.queries.some(({ sql }) => /INSERT INTO auto_listing_ai_outbox/i.test(sql)), false);
  const uploadTask = harness.queries.find(({ sql }) => /INSERT INTO auto_listing_upload_tasks/i.test(sql));
  assert.ok(uploadTask);
  assert.deepEqual(uploadTask.values.slice(1, 7), [
    "account-a", "job-a", "item-a", "account-a", 6, "correlation-a",
  ]);
  assert.equal(harness.queries.some(({ sql }) => /INSERT INTO auto_listing_upload_task_events/i.test(sql)), true);
  const event = harness.queries.find(({ sql }) => /INSERT INTO auto_listing_events/i.test(sql));
  assert.equal(event.values[7], "APPROVE_UPLOAD");
});

test("approve safely requeues only a policy-preflight block that never reached Ozon", async () => {
  for (const failureCode of [
    "AUTO_LISTING_UPLOAD_POLICY_BLOCKED",
    "AUTO_LISTING_UPLOAD_EVIDENCE_INVALID",
    "AUTO_LISTING_DIRECT_UPLOAD_DISABLED",
  ]) {
    const harness = db({ status: "BLOCKED", failureCode });
    const repository = createPostgresAutoListingUserItemActionRepository({ pool: harness.pool });
    assert.deepEqual(await repository.approveItem(command()), {
      status: "UPLOAD_QUEUED", statusVersion: 6, action: "APPROVE_UPLOAD", duplicate: false,
    });
    const uploadTask = harness.queries.find(({ sql }) => /INSERT INTO auto_listing_upload_tasks/i.test(sql));
    assert.ok(uploadTask);
    assert.equal(uploadTask.values[7], "SAFE_RETRY");
  }

  const unsafe = db({ status: "BLOCKED", failureCode: "AUTO_LISTING_UPLOAD_RESULT_UNCERTAIN" });
  await assert.rejects(
    createPostgresAutoListingUserItemActionRepository({ pool: unsafe.pool }).approveItem(command()),
    { code: "AUTO_LISTING_USER_ACTION_NOT_ALLOWED" },
  );
  assert.equal(unsafe.queries.some(({ sql }) => /INSERT INTO auto_listing_upload_tasks/i.test(sql)), false);
});

test("an exact command replay returns the stored result without locking or updating the item", async () => {
  const input = command();
  const existing = {
    account_id: "account-a", job_id: "job-a", item_id: "item-a", actor_account_id: "account-a",
    action: "CANCEL", expected_status_version: 5, idempotency_key: "command-a",
    correlation_id: "correlation-a", result_status: "CANCELLED", result_status_version: 6,
    request_hash: requestHash(input, "CANCEL"),
  };
  const harness = db({ existing });
  const repository = createPostgresAutoListingUserItemActionRepository({ pool: harness.pool });
  assert.deepEqual(await repository.cancelItem(input), {
    status: "CANCELLED", statusVersion: 6, action: "CANCEL", duplicate: true,
  });
  assert.equal(harness.queries.some(({ sql }) => /FROM auto_listing_job_items AS i/i.test(sql)), false);
  assert.equal(harness.queries.some(({ sql }) => /UPDATE auto_listing_job_items/i.test(sql)), false);
});

test("wrong account, stale version, changed replay and terminal cancellation fail closed", async () => {
  const noSql = db();
  const repository = createPostgresAutoListingUserItemActionRepository({ pool: noSql.pool });
  await assert.rejects(repository.cancelItem(command({ actorAccountId: "account-b" })), {
    code: "AUTO_LISTING_USER_ACTION_INVALID",
  });
  assert.equal(noSql.queries.length, 0);

  const terminal = db({ status: "SUCCEEDED" });
  await assert.rejects(createPostgresAutoListingUserItemActionRepository({ pool: terminal.pool }).cancelItem(command()), {
    code: "AUTO_LISTING_USER_ACTION_NOT_ALLOWED",
  });

  const changed = db({ existing: {
    account_id: "account-a", job_id: "other-job", item_id: "item-a", actor_account_id: "account-a",
    action: "CANCEL", expected_status_version: 5, idempotency_key: "command-a",
    correlation_id: "correlation-a", result_status: "CANCELLED", result_status_version: 6,
    request_hash: requestHash(command(), "CANCEL"),
  } });
  await assert.rejects(createPostgresAutoListingUserItemActionRepository({ pool: changed.pool }).cancelItem(command()), {
    code: "AUTO_LISTING_USER_ACTION_CONFLICT",
  });
});
