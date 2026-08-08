import assert from "node:assert/strict";
import test from "node:test";
import { buildGeneratedAssetObjectKey } from "../auto-listing-asset-store.mjs";
import { createPostgresGenerationAttemptRepository } from "../auto-listing-generation-attempt-postgres.mjs";

const scope = Object.freeze({
  accountId: "account-a", jobId: "job-a", itemId: "item-a", planId: "plan-a",
  visualGroupKey: "group-a", slotKey: "main", expectedStatusVersion: 7,
});
const attemptIdentityHash = "a".repeat(64);
const inputHash = "b".repeat(64);
const contentHash = "c".repeat(64);
const generationSize = "768x1024";
const itemRow = Object.freeze({
  status: "GENERATING", status_version: 7, active_content_plan_id: "plan-a",
  profile_id: "profile-a", profile_version: 1, image_model: "image-a", role: "MAIN",
});

function reservedRow(overrides = {}) {
  return {
    id: "generation-a", account_id: scope.accountId, job_id: scope.jobId, item_id: scope.itemId,
    plan_id: scope.planId, profile_id: "profile-a", visual_group_key: scope.visualGroupKey,
    slot_key: scope.slotKey, role: "MAIN", input_hash: attemptIdentityHash,
    attempt_no: 1, status: "GENERATING", gateway_request_id: null,
    checker_request_id: null, model_name: "image-a", profile_version: 1,
    prompt_hash: attemptIdentityHash, object_key_version: null, object_key: null,
    content_hash: null, content_type: null, width: null, height: null, size_bytes: null,
    checker_result: {}, error_code: null, error_retryable: null, accepted_at: null,
    plan_hash: null, source_hash: null, strategy_hash: null, config_hash: null,
    visual_groups_hash: null, prompt_template_version: null, source_asset_evidence: null,
    model_evidence: null, regeneration: null, lease_token: "lease-a:1",
    lease_expires_at: new Date("2026-08-04T00:01:00.000Z"),
    attempt_identity_hash: attemptIdentityHash, generation_size: generationSize,
    final_input_bound_at: null, expected_status_version: scope.expectedStatusVersion,
    created_at: new Date("2026-08-04T00:00:00.000Z"), updated_at: new Date("2026-08-04T00:00:00.000Z"),
    ...overrides,
  };
}

function fakePool(handler) {
  const queries = [];
  const client = {
    async query(text, parameters = []) {
      queries.push({ text, parameters });
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(text)) return { rows: [], rowCount: 0 };
      return handler(text, parameters, queries);
    },
    release() {},
  };
  return { queries, pool: { async connect() { return client; }, query: client.query.bind(client) } };
}

function reserveHandler(state = itemRow) {
  return (sql) => {
    if (/FROM auto_listing_job_items AS item/i.test(sql)) return { rows: state ? [state] : [], rowCount: state ? 1 : 0 };
    if (/status='ACCEPTED'/i.test(sql) && /^\s*SELECT/iu.test(sql)) return { rows: [], rowCount: 0 };
    if (/status='GENERATING'.*lease_expires_at > NOW\(\)/isu.test(sql) && /^\s*SELECT/iu.test(sql)) return { rows: [], rowCount: 0 };
    if (/SET status='FAILED'.*LEASE_EXPIRED/isu.test(sql)) return { rows: [], rowCount: 0 };
    if (/COALESCE\(MAX\(attempt_no\)/i.test(sql)) return { rows: [{ attempt_no: 0 }], rowCount: 1 };
    if (/INSERT INTO ai_generation_assets/i.test(sql)) return { rows: [reservedRow()], rowCount: 1 };
    throw new Error(`unexpected SQL: ${sql}`);
  };
}

test("reservation locks the exact active plan and version before creating a database-time lease", async () => {
  const db = fakePool(reserveHandler());
  const repository = createPostgresGenerationAttemptRepository({
    pool: db.pool, token: () => "lease-a", id: () => "generation-a", leaseMs: 60_000,
  });
  const result = await repository.reserveGenerationAttempt({
    ...scope, attemptIdentityHash, generationSize, maxAttempts: 3,
  });
  assert.deepEqual(result, {
    status: "RESERVED", attemptNo: 1, leaseToken: "lease-a:1", generationSize,
    leaseExpiresAt: "2026-08-04T00:01:00.000Z",
  });
  const itemQuery = db.queries.find(({ text }) => /FROM auto_listing_job_items AS item/i.test(text));
  assert.match(itemQuery.text, /item\.active_content_plan_id/i);
  assert.match(itemQuery.text, /plan\.id=\$4/i);
  assert.match(itemQuery.text, /jsonb_array_elements/i);
  assert.match(itemQuery.text, /FOR UPDATE OF item/i);
  const insert = db.queries.find(({ text }) => /INSERT INTO ai_generation_assets/i.test(text));
  assert.match(insert.text, /expected_status_version/i);
  assert.match(insert.text, /NOW\(\)\+\(/i);
});

test("cancelled, stale, and non-active plans stop before any generation-attempt read or write", async () => {
  for (const [state, expected] of [
    [{ ...itemRow, status: "CANCELLED" }, "CANCELLED"],
    [{ ...itemRow, status_version: 8 }, "STALE"],
    [{ ...itemRow, active_content_plan_id: "plan-b" }, "STALE"],
  ]) {
    const db = fakePool(reserveHandler(state));
    const repository = createPostgresGenerationAttemptRepository({ pool: db.pool, token: () => "lease-a", id: () => "generation-a" });
    assert.deepEqual(await repository.reserveGenerationAttempt({
      ...scope, attemptIdentityHash, generationSize, maxAttempts: 3,
    }), { status: expected });
    assert.equal(db.queries.some(({ text }) => /ai_generation_assets/i.test(text)), false);
  }
});

test("reservation expires old leases with database time and never reuses the stale token", async () => {
  const db = fakePool((sql) => {
    if (/FROM auto_listing_job_items AS item/i.test(sql)) return { rows: [itemRow], rowCount: 1 };
    if (/status='ACCEPTED'/i.test(sql) && /^\s*SELECT/iu.test(sql)) return { rows: [], rowCount: 0 };
    if (/status='GENERATING'.*lease_expires_at > NOW\(\)/isu.test(sql) && /^\s*SELECT/iu.test(sql)) return { rows: [], rowCount: 0 };
    if (/SET status='FAILED'.*LEASE_EXPIRED/isu.test(sql)) return { rows: [reservedRow({ status: "FAILED" })], rowCount: 1 };
    if (/COALESCE\(MAX\(attempt_no\)/i.test(sql)) return { rows: [{ attempt_no: 1 }], rowCount: 1 };
    if (/INSERT INTO ai_generation_assets/i.test(sql)) return { rows: [reservedRow({ id: "generation-b", attempt_no: 2, lease_token: "lease-new:2" })], rowCount: 1 };
    throw new Error(`unexpected SQL: ${sql}`);
  });
  const repository = createPostgresGenerationAttemptRepository({ pool: db.pool, token: () => "lease-new", id: () => "generation-b" });
  const result = await repository.reserveGenerationAttempt({ ...scope, attemptIdentityHash, generationSize, maxAttempts: 3 });
  assert.equal(result.attemptNo, 2);
  assert.equal(result.leaseToken, "lease-new:2");
  const expiry = db.queries.find(({ text }) => /LEASE_EXPIRED/i.test(text));
  assert.match(expiry.text, /lease_expires_at <= NOW\(\)/i);
});

test("the PostgreSQL adapter honors the image-generator retry limit from one through three", async () => {
  for (const maxAttempts of [1, 2, 3]) {
    const db = fakePool(reserveHandler());
    const repository = createPostgresGenerationAttemptRepository({
      pool: db.pool, token: () => "lease-a", id: () => "generation-a",
    });
    const result = await repository.reserveGenerationAttempt({
      ...scope, attemptIdentityHash, generationSize, maxAttempts,
    });
    assert.equal(result.status, "RESERVED");
  }
});

test("owner transitions carry the full scope, active-plan, version, lease-token and unexpired-lease CAS", async () => {
  const completedRow = reservedRow({
    input_hash: inputHash, status: "ACCEPTED", final_input_bound_at: new Date("2026-08-04T00:00:10.000Z"),
    lease_token: null, lease_expires_at: null, accepted_at: new Date("2026-08-04T00:00:20.000Z"),
    object_key_version: "ATTEMPT_V2", content_hash: contentHash, content_type: "image/png",
    width: 768, height: 1024, size_bytes: 123, gateway_request_id: "gateway-1",
    checker_request_id: "checker-1", prompt_hash: "d".repeat(64), plan_hash: "e".repeat(64),
    source_hash: "f".repeat(64), strategy_hash: "1".repeat(64), config_hash: "2".repeat(64),
    visual_groups_hash: "3".repeat(64), prompt_template_version: "image-v1",
    source_asset_evidence: [{ assetId: "source-a", contentHash: "4".repeat(64), contentType: "image/png", width: 10, height: 20, size: 30 }],
    checker_result: { accepted: true }, model_evidence: { requestedImageModel: "image-a" }, regeneration: null,
  });
  completedRow.object_key = buildGeneratedAssetObjectKey({
    ...scope, attemptIdentityHash, inputHash, attemptNo: 1, contentHash,
  });
  const db = fakePool((sql) => {
    if (/SET status='ACCEPTED'/i.test(sql)) return { rows: [completedRow], rowCount: 1 };
    throw new Error(`unexpected SQL: ${sql}`);
  });
  const repository = createPostgresGenerationAttemptRepository({ pool: db.pool });
  const result = await repository.completeGenerationAttempt({
    ...scope, attemptIdentityHash, inputHash, generationSize, attemptNo: 1, leaseToken: "lease-a:1",
    role: "MAIN", objectKeyVersion: "ATTEMPT_V2", objectKey: completedRow.object_key,
    contentHash, contentType: "image/png", width: 768, height: 1024, size: 123,
    checkerEvidence: { accepted: true }, gatewayRequestId: "gateway-1", checkerRequestId: "checker-1",
    modelEvidence: { requestedImageModel: "image-a" }, profileId: "profile-a", profileVersion: 1,
    modelName: "image-a", promptHash: "d".repeat(64), planHash: "e".repeat(64),
    sourceHash: "f".repeat(64), strategyHash: "1".repeat(64), configHash: "2".repeat(64),
    visualGroupsHash: "3".repeat(64), promptTemplateVersion: "image-v1",
    sourceAssetEvidence: completedRow.source_asset_evidence, regeneration: null,
  });
  assert.equal(result.status, "ACCEPTED");
  assert.equal(result.size, 123);
  assert.deepEqual(result.checkerEvidence, { accepted: true });
  const transition = db.queries.find(({ text }) => /SET status='ACCEPTED'/i.test(text));
  for (const pattern of [
    /attempt\.account_id=\$1/i, /attempt\.job_id=\$2/i, /attempt\.item_id=\$3/i,
    /attempt\.plan_id=\$4/i, /attempt\.visual_group_key=\$5/i, /attempt\.slot_key=\$6/i,
    /attempt\.expected_status_version=\$7/i, /attempt\.lease_token=\$12/i,
    /attempt\.lease_expires_at > NOW\(\)/i, /item\.active_content_plan_id=attempt\.plan_id/i,
    /item\.status_version=attempt\.expected_status_version/i,
  ]) assert.match(transition.text, pattern);
});

test("a stale owner transition fails with a safe retryable claim error", async () => {
  const db = fakePool(() => ({ rows: [], rowCount: 0 }));
  const repository = createPostgresGenerationAttemptRepository({ pool: db.pool });
  await assert.rejects(repository.failGenerationAttempt({
    ...scope, attemptIdentityHash, inputHash: attemptIdentityHash, generationSize,
    attemptNo: 1, leaseToken: "stale:1", role: "MAIN",
    code: "AUTO_LISTING_IMAGE_GATEWAY_INVALID", retryable: true,
    gatewayRequestId: null, checkerRequestId: null,
  }), (error) => error?.code === "AUTO_LISTING_IMAGE_ATTEMPT_CLAIM_REJECTED"
    && error.retryable === true && !error.message.includes("stale:1"));
});

test("the PostgreSQL adapter rejects unknown request fields before touching the database", async () => {
  const db = fakePool(() => { throw new Error("must not query"); });
  const repository = createPostgresGenerationAttemptRepository({ pool: db.pool });
  await assert.rejects(repository.reserveGenerationAttempt({
    ...scope, attemptIdentityHash, generationSize, maxAttempts: 3, unexpected: true,
  }), (error) => error?.code === "AUTO_LISTING_IMAGE_ATTEMPT_INVALID" && error.retryable === false);
  assert.equal(db.queries.length, 0);
});
