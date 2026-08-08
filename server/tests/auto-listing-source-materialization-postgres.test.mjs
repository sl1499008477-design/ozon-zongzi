import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSourceMaterializationObjectKey,
  createPostgresSourceMaterializationRepository,
} from "../auto-listing-source-materialization-repository.mjs";

const scope = Object.freeze({
  accountId: "account-a", jobId: "job-a", itemId: "item-a", parentPlanId: "plan-a", sourceAssetId: "source-a",
  sourceRefHash: "a".repeat(64), inputHash: "b".repeat(64), expectedStatusVersion: 4,
});
const reservation = Object.freeze({ ...scope, maxAttempts: 3 });
const content = Object.freeze({ contentHash: "c".repeat(64), contentType: "image/png", width: 900, height: 1200, sizeBytes: 1234 });

function row(overrides = {}) {
  return {
    id: "materialization-a", account_id: scope.accountId, job_id: scope.jobId, item_id: scope.itemId,
    parent_plan_id: scope.parentPlanId, source_asset_id: scope.sourceAssetId, source_ref_hash: scope.sourceRefHash,
    input_hash: scope.inputHash, expected_status_version: scope.expectedStatusVersion, attempt_no: 1,
    status: "MATERIALIZING", lease_owner: "source-materializer", lease_token: "nonce-a:1",
    lease_expires_at: new Date("2026-08-04T00:01:00Z"), object_key_version: null, object_key: null,
    content_hash: null, content_type: null, width: null, height: null, size_bytes: null,
    accepted_at: null, error_code: null, error_retryable: null,
    created_at: new Date("2026-08-04T00:00:00Z"), updated_at: new Date("2026-08-04T00:00:00Z"),
    ...overrides,
  };
}
function storedRow(overrides = {}) {
  const value = { ...scope, attemptNo: 1, ...content };
  return row({
    status: "STORED", object_key_version: "SOURCE_V1", object_key: buildSourceMaterializationObjectKey(value),
    content_hash: content.contentHash, content_type: content.contentType, width: content.width,
    height: content.height, size_bytes: content.sizeBytes, ...overrides,
  });
}
function transactionalPool(handler) {
  const calls = [];
  const client = {
    async query(sql, parameters) {
      calls.push({ sql, parameters });
      if (/^(BEGIN|COMMIT|ROLLBACK)$/u.test(sql)) return { rows: [], rowCount: 0 };
      return handler(sql, parameters, calls);
    },
    async release() {},
  };
  return { calls, async connect() { return client; } };
}

test("PostgreSQL reserve locks the exact item/parent plan, uses database time and inserts one fenced attempt", async () => {
  const pool = transactionalPool((sql) => {
    if (/SELECT item\.status,item\.status_version/u.test(sql)) return { rows: [{ status: "PLANNING", status_version: 4 }], rowCount: 1 };
    if (/status='ACCEPTED'/u.test(sql)) return { rows: [], rowCount: 0 };
    if (/status IN \('MATERIALIZING','STORED'\).*lease_expires_at > NOW\(\)/su.test(sql)) return { rows: [], rowCount: 0 };
    if (/SET lease_owner=\$9/u.test(sql)) return { rows: [], rowCount: 0 };
    if (/SET status='FAILED'/u.test(sql)) return { rows: [], rowCount: 0 };
    if (/COALESCE\(MAX\(attempt_no\),0\)/u.test(sql)) return { rows: [{ attempt_no: 0 }], rowCount: 1 };
    if (/INSERT INTO auto_listing_source_materialization_attempts/u.test(sql)) return { rows: [row()], rowCount: 1 };
    throw new Error(`unexpected SQL: ${sql}`);
  });
  const repository = createPostgresSourceMaterializationRepository({ pool, token: () => "nonce-a", id: () => "materialization-a" });
  const result = await repository.reserveSourceMaterialization(reservation);
  assert.equal(result.status, "RESERVED");
  assert.equal(result.attemptId, "materialization-a");
  const sql = pool.calls.map((call) => call.sql).join("\n");
  assert.match(sql, /JOIN ai_content_plans AS plan[\s\S]*?FOR UPDATE OF item/i);
  assert.match(sql, /item\.account_id=\$1 AND item\.job_id=\$2 AND item\.id=\$3/i);
  assert.match(sql, /lease_expires_at > NOW\(\)/i);
  assert.match(sql, /NOW\(\)\+\(\$13::INTEGER \* INTERVAL '1 millisecond'\)/i);
  assert.match(sql, /expected_status_version=\$8/i);
  assert.doesNotMatch(JSON.stringify(pool.calls), /https?:|sourceUrl|redirect|responseBody|secret/i);
});

test("PostgreSQL reserve returns CANCELLED or STALE before touching attempts", async () => {
  for (const [item, expected] of [[{ status: "CANCELLED", status_version: 4 }, "CANCELLED"], [{ status: "PLANNING", status_version: 5 }, "STALE"]]) {
    const pool = transactionalPool((sql) => {
      if (/SELECT item\.status,item\.status_version/u.test(sql)) return { rows: [item], rowCount: 1 };
      throw new Error("attempt table must not be touched");
    });
    const result = await createPostgresSourceMaterializationRepository({ pool, token: () => "nonce-a", id: () => "materialization-a" })
      .reserveSourceMaterialization(reservation);
    assert.deepEqual(result, { status: expected });
    assert.equal(pool.calls.filter((call) => /auto_listing_source_materialization_attempts/u.test(call.sql)).length, 0);
  }
});

test("PostgreSQL reclaims exact expired STORED evidence with a new ABA token instead of inserting or downloading", async () => {
  const resumed = storedRow({ lease_token: "nonce-b:1", lease_expires_at: new Date("2026-08-04T00:02:00Z") });
  const pool = transactionalPool((sql) => {
    if (/SELECT item\.status,item\.status_version/u.test(sql)) return { rows: [{ status: "PLANNING", status_version: 4 }], rowCount: 1 };
    if (/status='ACCEPTED'/u.test(sql)) return { rows: [], rowCount: 0 };
    if (/status IN \('MATERIALIZING','STORED'\).*lease_expires_at > NOW\(\)/su.test(sql)) return { rows: [], rowCount: 0 };
    if (/SET lease_owner=\$9/u.test(sql)) return { rows: [resumed], rowCount: 1 };
    throw new Error(`unexpected SQL: ${sql}`);
  });
  const result = await createPostgresSourceMaterializationRepository({ pool, token: () => "nonce-b", id: () => "unused" })
    .reserveSourceMaterialization(reservation);
  assert.deepEqual(Object.keys(result).sort(), ["record", "status"]);
  assert.equal(result.status, "RESERVED_STORED");
  assert.equal(result.record.attemptId, "materialization-a");
  assert.equal(result.record.leaseToken, "nonce-b:1");
  assert.equal(pool.calls.some((call) => /INSERT INTO auto_listing_source_materialization_attempts/u.test(call.sql)), false);
});

test("PostgreSQL stored, complete and fail transitions use the full unexpired item-version CAS", async () => {
  const stored = storedRow();
  const accepted = storedRow({ status: "ACCEPTED", lease_owner: null, lease_token: null, lease_expires_at: null, accepted_at: new Date() });
  const failed = row({ status: "FAILED", lease_owner: null, lease_token: null, lease_expires_at: null,
    error_code: "AUTO_LISTING_SOURCE_DOWNLOAD_FAILED", error_retryable: true });
  const replies = [stored, accepted, failed]; const calls = [];
  const pool = { async query(sql, parameters) { calls.push({ sql, parameters }); return { rows: [replies.shift()], rowCount: 1 }; } };
  const repository = createPostgresSourceMaterializationRepository({ pool });
  const lease = { attemptId: "materialization-a", attemptNo: 1, leaseToken: "nonce-a:1" };
  const evidence = { ...scope, ...lease, objectKeyVersion: "SOURCE_V1", objectKey: stored.object_key, ...content };
  assert.equal((await repository.recordStoredSourceMaterialization(evidence)).status, "STORED");
  assert.equal((await repository.completeSourceMaterialization(evidence)).status, "ACCEPTED");
  assert.equal((await repository.failSourceMaterialization({ ...scope, ...lease,
    errorCode: "AUTO_LISTING_SOURCE_DOWNLOAD_FAILED", errorRetryable: true })).status, "FAILED");
  for (const call of calls) {
    assert.match(call.sql, /attempt\.account_id=\$1[\s\S]*?attempt\.job_id=\$2[\s\S]*?attempt\.item_id=\$3/i);
    assert.match(call.sql, /attempt\.parent_plan_id=\$4[\s\S]*?source_asset_id=\$5[\s\S]*?source_ref_hash=\$6[\s\S]*?input_hash=\$7/i);
    assert.match(call.sql, /expected_status_version=\$8[\s\S]*?attempt\.id=\$9[\s\S]*?attempt_no=\$10[\s\S]*?lease_token=\$11/i);
    assert.match(call.sql, /lease_expires_at > NOW\(\)[\s\S]*?item\.status <> 'CANCELLED'[\s\S]*?item\.status_version=attempt\.expected_status_version/i);
  }
});

test("PostgreSQL list is exact-scope, deterministically ordered and bounded at the repository", async () => {
  const accepted = storedRow({ status: "ACCEPTED", lease_owner: null, lease_token: null, lease_expires_at: null, accepted_at: new Date() });
  const calls = [];
  const pool = { async query(sql, parameters) { calls.push({ sql, parameters }); return { rows: [accepted], rowCount: 1 }; } };
  const rows = await createPostgresSourceMaterializationRepository({ pool, maxRows: 7 })
    .listAcceptedSourceMaterializations({ accountId: "account-a", jobId: "job-a", itemId: "item-a", parentPlanId: "plan-a", expectedStatusVersion: 4 });
  assert.equal(rows[0].attemptId, "materialization-a");
  assert.match(calls[0].sql, /WHERE account_id=\$1 AND job_id=\$2 AND item_id=\$3 AND parent_plan_id=\$4[\s\S]*expected_status_version=\$5 AND status='ACCEPTED'/i);
  assert.match(calls[0].sql, /ORDER BY source_asset_id,attempt_no LIMIT \$6/i);
  assert.deepEqual(calls[0].parameters.slice(4), [4, 8]);
});

test("PostgreSQL errors and internal generator failures are normalized without raw database or URL text", async () => {
  for (const repository of [
    createPostgresSourceMaterializationRepository({
      pool: { async connect() { throw new Error("password=secret host=production.invalid"); } },
    }),
    createPostgresSourceMaterializationRepository({
      pool: { async connect() { throw new Error("must not connect"); } },
      token: () => { throw new Error("https://private.invalid/?apiKey=secret"); },
    }),
  ]) {
    await assert.rejects(repository.reserveSourceMaterialization(reservation), (error) =>
      error.code === "AUTO_LISTING_SOURCE_MATERIALIZATION_REPOSITORY_FAILED" && error.retryable === true
      && !/password|secret|production|https?:|apiKey/i.test(error.message));
  }
});

test("PostgreSQL public and factory inputs are closed before any query", async () => {
  const calls = [];
  const pool = { async query(...args) { calls.push(args); return { rows: [] }; } };
  const repository = createPostgresSourceMaterializationRepository({ pool });
  await assert.rejects(repository.listAcceptedSourceMaterializations({
    accountId: "account-a", jobId: "job-a", itemId: "item-a", parentPlanId: "plan-a", expectedStatusVersion: 4, unexpected: true,
  }), { code: "AUTO_LISTING_SOURCE_MATERIALIZATION_INVALID" });
  assert.equal(calls.length, 0);
  assert.throws(() => createPostgresSourceMaterializationRepository({ pool, unexpected: true }), {
    code: "AUTO_LISTING_SOURCE_MATERIALIZATION_INVALID",
  });
});

test("PostgreSQL cleanup obligation is inserted from the exact account-scoped materialization and replayed safely", async () => {
  const stored = storedRow();
  const cleanup = {
    id: "source-cleanup-a", account_id: scope.accountId, job_id: scope.jobId, item_id: scope.itemId,
    parent_plan_id: scope.parentPlanId, source_asset_id: scope.sourceAssetId,
    materialization_attempt_id: stored.id, source_ref_hash: scope.sourceRefHash, input_hash: scope.inputHash,
    expected_status_version: scope.expectedStatusVersion, attempt_no: 1, lease_token: "nonce-a:1",
    object_key_version: "SOURCE_V1", object_key: stored.object_key, content_hash: stored.content_hash,
    content_type: "image/png", width: 900, height: 1200, size_bytes: 1234,
    reason_code: "AUTO_LISTING_SOURCE_OBJECT_UNREFERENCED",
    original_error_code: "AUTO_LISTING_SOURCE_MATERIALIZATION_CLAIM_REJECTED", status: "PENDING",
    attempt_count: 0, claim_owner: null, claim_token: null, claim_expires_at: null,
    next_retry_at: new Date(), last_error_code: null, created_at: new Date(), updated_at: new Date(),
  };
  const calls = [];
  const pool = { async query(sql, parameters) { calls.push({ sql, parameters }); return { rows: [cleanup], rowCount: 1 }; } };
  const request = {
    accountId: scope.accountId, jobId: scope.jobId, itemId: scope.itemId, parentPlanId: scope.parentPlanId,
    sourceAssetId: scope.sourceAssetId, materializationAttemptId: stored.id,
    sourceRefHash: scope.sourceRefHash, inputHash: scope.inputHash, expectedStatusVersion: scope.expectedStatusVersion,
    attemptNo: 1, leaseToken: "nonce-a:1",
    objectKeyVersion: "SOURCE_V1", objectKey: stored.object_key, contentHash: stored.content_hash,
    contentType: "image/png", width: 900, height: 1200, sizeBytes: 1234,
    reasonCode: "AUTO_LISTING_SOURCE_OBJECT_UNREFERENCED",
    originalErrorCode: "AUTO_LISTING_SOURCE_MATERIALIZATION_CLAIM_REJECTED",
  };
  const result = await createPostgresSourceMaterializationRepository({ pool, id: () => "source-cleanup-a" })
    .recordSourceObjectCleanupRequired(request);
  assert.equal(result.status, "PENDING");
  assert.match(calls[0].sql, /INSERT INTO auto_listing_source_object_cleanup_obligations[\s\S]*?SELECT[\s\S]*?FROM auto_listing_source_materialization_attempts AS attempt/i);
  assert.match(calls[0].sql, /attempt\.account_id=\$2[\s\S]*?attempt\.job_id=\$3[\s\S]*?attempt\.item_id=\$4/i);
  assert.match(calls[0].sql, /attempt\.parent_plan_id=\$5[\s\S]*?attempt\.source_asset_id=\$6[\s\S]*?attempt\.id=\$7/i);
  assert.match(calls[0].sql, /attempt\.source_ref_hash=\$8[\s\S]*?attempt\.input_hash=\$9[\s\S]*?attempt\.expected_status_version=\$10/i);
  assert.match(calls[0].sql, /attempt\.attempt_no=\$11[\s\S]*?attempt\.lease_token=\$12/i);
  assert.match(calls[0].sql, /attempt\.lease_expires_at > NOW\(\)/i);
  assert.doesNotMatch(calls[0].sql, /attempt\.object_key(?:_version)?=|attempt\.content_hash=/i);
  assert.match(calls[0].sql, /ON CONFLICT \(account_id,object_key\)/i);
  assert.equal(calls[0].parameters.length, 21);
  assert.doesNotMatch(calls[0].sql, /\$22\b/u);
});
