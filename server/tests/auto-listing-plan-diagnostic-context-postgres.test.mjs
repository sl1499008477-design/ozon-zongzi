import assert from "node:assert/strict";
import test from "node:test";

import {
  autoListingPlanDiagnosticRequestHash,
  createPostgresAutoListingPlanDiagnosticContextRepository,
} from "../auto-listing-plan-diagnostic-context-postgres.mjs";

const command = Object.freeze({
  accountId: "account-a", actorAccountId: "account-a", jobId: "job-a", itemId: "item-a",
  sourceSnapshotId: "snapshot-a", expectedStatusVersion: 9, costConfirmed: true,
  idempotencyKey: "diagnostic-once-a", correlationId: "corr-a",
});

const prepared = Object.freeze({
  planningContract: "LEGACY_FULL_PLAN_V3", inputHash: "a".repeat(64), skeletonHash: null,
  profileId: "profile-a", profileVersion: 3, gatewayProfile: Object.freeze({ id: "profile-a" }),
  model: "text-model-a", templateVersion: "AUTO_LISTING_CONTENT_PLAN_V3",
  requestKey: "diagnostic-request-a", correlationId: "corr-a",
  request: Object.freeze({ schema: Object.freeze({}), text: "safe frozen facts" }),
  validationContext: Object.freeze({ marker: "frozen" }),
});

function harness({ existing = null, boundary = null, now = () => Date.parse("2026-08-14T02:00:00.000Z") } = {}) {
  const calls = [];
  const row = boundary ?? {
    account_id: "account-a", job_id: "job-a", item_id: "item-a", snapshot_id: "snapshot-a",
    status: "BLOCKED", status_version: 9, failure_code: "AUTO_LISTING_CONTENT_PLAN_INVALID",
  };
  const client = {
    async query(sql, values = []) {
      calls.push({ sql, values });
      if (/FROM auto_listing_content_plan_diagnostic_runs[\s\S]*idempotency_key/iu.test(sql)) {
        return existing ? { rowCount: 1, rows: [existing] } : { rowCount: 0, rows: [] };
      }
      if (/FROM auto_listing_job_items AS item/iu.test(sql)) return row ? { rowCount: 1, rows: [row] } : { rowCount: 0, rows: [] };
      if (/INSERT INTO auto_listing_content_plan_diagnostic_runs/iu.test(sql)) return { rowCount: 1, rows: [{
        id: "diagnostic-a", account_id: "account-a", job_id: "job-a", item_id: "item-a",
        source_snapshot_id: "snapshot-a", status: "RUNNING",
      }] };
      if (/UPDATE auto_listing_content_plan_diagnostic_runs/iu.test(sql)) return { rowCount: 1, rows: [{
        id: "diagnostic-a", account_id: "account-a", status: values[2],
      }] };
      return { rowCount: 0, rows: [] };
    },
    release() { calls.push({ sql: "RELEASE", values: [] }); },
  };
  return {
    calls,
    repository: createPostgresAutoListingPlanDiagnosticContextRepository({
      pool: { async connect() { calls.push({ sql: "CONNECT", values: [] }); return client; } },
      id: () => "diagnostic-a",
      now,
      async buildFrozenDiagnostic(input) { calls.push({ sql: "BUILD", values: [input] }); return prepared; },
    }),
  };
}

test("reserves one RUNNING diagnostic from the exact frozen failed item before any paid call", async () => {
  const h = harness();
  const result = await h.repository.reserve(command);
  assert.equal(result.status, "RESERVED");
  assert.equal(result.runId, "diagnostic-a");
  assert.equal(result.inputHash, "a".repeat(64));
  const boundary = h.calls.find(({ sql }) => /FROM auto_listing_job_items AS item/iu.test(sql));
  assert.match(boundary.sql, /FOR UPDATE OF item/iu);
  assert.deepEqual(boundary.values, ["account-a", "job-a", "item-a", "snapshot-a"]);
  assert.ok(h.calls.find(({ sql }) => /INSERT INTO auto_listing_content_plan_diagnostic_runs/iu.test(sql)));
  assert.ok(h.calls.find(({ sql }) => sql === "COMMIT"));
});

test("a stale RUNNING replay is marked response-unknown and never calls the paid port again", async () => {
  const existing = {
    id: "diagnostic-a", account_id: "account-a", job_id: "job-a", item_id: "item-a",
    source_snapshot_id: "snapshot-a", expected_status_version: 9, idempotency_key: "diagnostic-once-a",
    correlation_id: "corr-a", actor_account_id: "account-a", cost_confirmed: true,
    status: "RUNNING", request_hash: autoListingPlanDiagnosticRequestHash(command),
    updated_at: new Date("2026-08-14T01:55:00.000Z"),
  };
  const h = harness({ existing });
  await assert.rejects(h.repository.reserve(command), {
    code: "AUTO_LISTING_PLAN_DIAGNOSTIC_RESPONSE_UNKNOWN",
  });
  const update = h.calls.find(({ sql }) => /AUTO_LISTING_PLAN_DIAGNOSTIC_RESPONSE_UNKNOWN/iu.test(sql));
  assert.ok(update);
  const updateIndex = h.calls.indexOf(update);
  const commitIndexes = h.calls.flatMap(({ sql }, index) => sql === "COMMIT" ? [index] : []);
  assert.deepEqual(commitIndexes.length, 1);
  assert.ok(updateIndex < commitIndexes[0], "the stale-state update must remain inside the locked transaction");
  assert.equal(h.calls.some(({ sql }) => sql === "BUILD"), false);
});

test("same terminal idempotency record replays while conflict and noneligible scopes write nothing", async () => {
  const existing = {
    id: "diagnostic-a", account_id: "account-a", job_id: "job-a", item_id: "item-a",
    source_snapshot_id: "snapshot-a", expected_status_version: 9, idempotency_key: "diagnostic-once-a",
    correlation_id: "corr-a", actor_account_id: "account-a", cost_confirmed: true,
    status: "REJECTED", request_hash: null,
  };
  const replay = harness({ existing });
  existing.request_hash = autoListingPlanDiagnosticRequestHash(command);
  assert.deepEqual(await replay.repository.reserve(command), { status: "EXISTING", runId: "diagnostic-a" });
  assert.equal(replay.calls.some(({ sql }) => /INSERT INTO/iu.test(sql)), false);

  const conflict = harness({ existing: { ...existing, request_hash: "f".repeat(64) } });
  await assert.rejects(conflict.repository.reserve(command), {
    code: "AUTO_LISTING_PLAN_DIAGNOSTIC_IDEMPOTENCY_CONFLICT",
  });
  const stale = harness({ boundary: {
    account_id: "account-a", job_id: "job-a", item_id: "item-a", snapshot_id: "snapshot-a",
    status: "PLANNING", status_version: 9, failure_code: null,
  } });
  await assert.rejects(stale.repository.reserve(command));

  let connects = 0;
  const invalid = createPostgresAutoListingPlanDiagnosticContextRepository({
    pool: { async connect() { connects += 1; } }, buildFrozenDiagnostic: async () => prepared,
  });
  await assert.rejects(invalid.reserve({ ...command, extra: true }));
  assert.equal(connects, 0);
});

test("terminalizes only the exact RUNNING diagnostic and makes exact replay idempotent", async () => {
  const h = harness();
  assert.deepEqual(await h.repository.complete({
    accountId: "account-a", runId: "diagnostic-a", status: "REJECTED", failureCode: null,
  }), { status: "REJECTED" });
  const update = h.calls.find(({ sql }) => /UPDATE auto_listing_content_plan_diagnostic_runs/iu.test(sql));
  assert.match(update.sql, /status='RUNNING'/iu);
  assert.deepEqual(update.values.slice(0, 3), ["account-a", "diagnostic-a", "REJECTED"]);
});
