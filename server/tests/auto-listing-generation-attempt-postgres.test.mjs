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
  return (sql, parameters) => {
    if (/FROM auto_listing_job_items AS item/i.test(sql)) return { rows: state ? [state] : [], rowCount: state ? 1 : 0 };
    if (/status='ACCEPTED'/i.test(sql) && /^\s*SELECT/iu.test(sql)) return { rows: [], rowCount: 0 };
    if (/status='GENERATING'.*lease_expires_at > NOW\(\)/isu.test(sql) && /^\s*SELECT/iu.test(sql)) return { rows: [], rowCount: 0 };
    if (/SET status='FAILED'.*LEASE_EXPIRED/isu.test(sql)) return { rows: [], rowCount: 0 };
    if (/lease_token='AUTO_LISTING_IMAGE_CHANNEL_RELEASED'/iu.test(sql) && /^\s*SELECT/iu.test(sql)) return { rows: [], rowCount: 0 };
    if (/COALESCE\(MAX\(attempt_no\)/i.test(sql)) return { rows: [{ attempt_no: 0 }], rowCount: 1 };
    if (/INSERT INTO ai_generation_assets/i.test(sql)) return {
      rows: [reservedRow({
        gateway_connection_id: parameters.at(-2) ?? null,
        gateway_connection_version: parameters.at(-1) ?? null,
      })],
      rowCount: 1,
    };
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
    gatewayConnectionId: "connection-b", gatewayConnectionVersion: 9,
  });
  assert.deepEqual(result, {
    status: "RESERVED", attemptNo: 1, leaseToken: "lease-a:1", generationSize,
    leaseExpiresAt: "2026-08-04T00:01:00.000Z",
    gatewayConnectionId: "connection-b", gatewayConnectionVersion: 9,
  });
  const itemQuery = db.queries.find(({ text }) => /FROM auto_listing_job_items AS item/i.test(text));
  assert.match(itemQuery.text, /item\.active_content_plan_id/i);
  assert.match(itemQuery.text, /plan\.id=\$4/i);
  assert.match(itemQuery.text, /jsonb_array_elements/i);
  assert.match(itemQuery.text, /FOR UPDATE OF item/i);
  const insert = db.queries.find(({ text }) => /INSERT INTO ai_generation_assets/i.test(text));
  assert.match(insert.text, /expected_status_version/i);
  assert.match(insert.text, /gateway_connection_id.*gateway_connection_version/is);
  assert.equal(insert.parameters.includes("connection-b"), true);
  assert.equal(insert.parameters.includes(9), true);
  assert.match(insert.text, /NOW\(\)\+\(/i);
});

test("reservation checks a compatible legacy identity while inserting only the current identity", async () => {
  const legacyAttemptIdentityHash = "9".repeat(64);
  const db = fakePool(reserveHandler());
  const repository = createPostgresGenerationAttemptRepository({
    pool: db.pool, token: () => "lease-a", id: () => "generation-a", leaseMs: 60_000,
  });

  await repository.reserveGenerationAttempt({
    ...scope, attemptIdentityHash, legacyAttemptIdentityHash, generationSize, maxAttempts: 3,
  });

  const accepted = db.queries.find(({ text }) => /status='ACCEPTED'/iu.test(text) && /^\s*SELECT/iu.test(text));
  assert.match(accepted.text, /attempt_identity_hash=ANY\(\$9::TEXT\[\]\)/iu);
  assert.deepEqual(accepted.parameters, [
    ...Object.values(scope),
    generationSize,
    [attemptIdentityHash, legacyAttemptIdentityHash],
  ]);
  const insert = db.queries.find(({ text }) => /INSERT INTO ai_generation_assets/iu.test(text));
  assert.equal(insert.parameters[7], attemptIdentityHash);
});

test("the default image lease outlives the 13 minute worker budget", async () => {
  const db = fakePool(reserveHandler());
  const repository = createPostgresGenerationAttemptRepository({
    pool: db.pool, token: () => "lease-a", id: () => "generation-a",
  });
  await repository.reserveGenerationAttempt({
    ...scope, attemptIdentityHash, generationSize, maxAttempts: 3,
  });

  const insert = db.queries.find(({ text }) => /INSERT INTO ai_generation_assets/i.test(text));
  assert.ok(insert.parameters[16] > 780_000);
  assert.equal(insert.parameters[16], 840_000);
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
    if (/lease_token='AUTO_LISTING_IMAGE_CHANNEL_RELEASED'/iu.test(sql) && /^\s*SELECT/iu.test(sql)) return { rows: [], rowCount: 0 };
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

test("the PostgreSQL adapter counts accepted images for the exact active plan", async () => {
  const db = fakePool((sql, values) => {
    assert.match(sql, /FROM ai_generation_assets AS attempt/iu);
    assert.match(sql, /attempt\.status='ACCEPTED'/iu);
    assert.match(sql, /item\.active_content_plan_id=attempt\.plan_id/iu);
    assert.deepEqual(values, [scope.accountId, scope.jobId, scope.itemId, scope.planId]);
    return { rows: [{ accepted_count: 6 }], rowCount: 1 };
  });
  const repository = createPostgresGenerationAttemptRepository({ pool: db.pool });

  assert.equal(await repository.countAcceptedAssets({
    accountId: scope.accountId,
    jobId: scope.jobId,
    itemId: scope.itemId,
    planId: scope.planId,
  }), 6);
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
    gatewayConnectionId: null, gatewayConnectionVersion: null,
    checkerConnectionId: "connection-b", checkerConnectionVersion: 9,
  });
  assert.equal(result.status, "ACCEPTED");
  const completed = db.queries.find(({ text }) => /SET status='ACCEPTED'/i.test(text));
  assert.match(completed.text, /gateway_connection_id IS NOT DISTINCT FROM \$\d+/i);
  assert.match(completed.text, /checker_connection_id=\$\d+.*checker_connection_version=\$\d+/is);
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

test("a checker contract failure persists its generated image, request id, and safe diagnostic for retry", async () => {
  const objectKey = buildGeneratedAssetObjectKey({
    ...scope, attemptIdentityHash, inputHash, attemptNo: 1, contentHash,
  });
  const checkerEvidence = {
    version: "CHECKER_FAILURE_V1",
    failureCode: "CHECKER_RESPONSE_INVALID",
    detailCode: "STRUCTURED_RESPONSE_INVALID",
    failureField: "/evidence/claims/0/unit",
    requestIds: ["checker-1", "checker-2"],
    callCount: 2,
  };
  const failedRow = reservedRow({
    input_hash: inputHash, status: "FAILED", final_input_bound_at: new Date("2026-08-04T00:00:10.000Z"),
    lease_token: null, lease_expires_at: null, error_code: "CHECKER_RESPONSE_INVALID", error_retryable: true,
    object_key_version: "ATTEMPT_V2", object_key: objectKey, content_hash: contentHash,
    content_type: "image/png", width: 768, height: 1024, size_bytes: 123,
    gateway_request_id: "gateway-1", checker_request_id: "checker-2",
    model_evidence: { requestedImageModel: "image-a" }, checker_result: checkerEvidence,
  });
  const db = fakePool((sql) => {
    if (/SET status='FAILED'/iu.test(sql)) return { rows: [failedRow], rowCount: 1 };
    throw new Error(`unexpected SQL: ${sql}`);
  });
  const repository = createPostgresGenerationAttemptRepository({ pool: db.pool });

  const result = await repository.failGenerationAttempt({
    ...scope, attemptIdentityHash, inputHash, generationSize, attemptNo: 1, leaseToken: "lease-a:1",
    role: "MAIN", code: "CHECKER_RESPONSE_INVALID", retryable: true,
    gatewayRequestId: "gateway-1", checkerRequestId: "checker-2",
    objectKeyVersion: "ATTEMPT_V2", objectKey, contentHash, contentType: "image/png",
    width: 768, height: 1024, size: 123,
    modelEvidence: { requestedImageModel: "image-a" }, checkerEvidence,
  });

  assert.equal(result.errorCode, "CHECKER_RESPONSE_INVALID");
  assert.deepEqual(result.checkerEvidence, checkerEvidence);
  const transition = db.queries.find(({ text }) => /SET status='FAILED'/iu.test(text));
  assert.match(transition.text, /checker_result=COALESCE\(\$26::JSONB,attempt\.checker_result\)/iu);
  assert.deepEqual(JSON.parse(transition.parameters[25]), checkerEvidence);
});

test("binding a later PostgreSQL attempt recovers a specific checker-contract failure", async () => {
  const objectKey = buildGeneratedAssetObjectKey({
    ...scope, attemptIdentityHash, inputHash, attemptNo: 1, contentHash,
  });
  const ownedRow = reservedRow({
    id: "generation-b", input_hash: inputHash, attempt_no: 2, lease_token: "lease-b:2",
    final_input_bound_at: new Date("2026-08-04T00:00:30.000Z"),
  });
  const recoveryRow = reservedRow({
    id: "generation-a", input_hash: inputHash, status: "FAILED", attempt_no: 1,
    lease_token: null, lease_expires_at: null, final_input_bound_at: new Date("2026-08-04T00:00:10.000Z"),
    error_code: "CHECKER_EVIDENCE_INVALID", error_retryable: true,
    object_key_version: "ATTEMPT_V2", object_key: objectKey, content_hash: contentHash,
    content_type: "image/png", width: 768, height: 1024, size_bytes: 123,
    gateway_request_id: "gateway-1", checker_request_id: "checker-2",
    model_evidence: { requestedImageModel: "image-a" },
    checker_result: { version: "CHECKER_FAILURE_V1", failureCode: "CHECKER_EVIDENCE_INVALID" },
  });
  const db = fakePool((sql) => {
    if (/FROM auto_listing_job_items AS item/iu.test(sql)) return { rows: [itemRow], rowCount: 1 };
    if (/lease_token=\$12.*status='GENERATING'/isu.test(sql) && /^\s*SELECT/iu.test(sql)) {
      return { rows: [ownedRow], rowCount: 1 };
    }
    if (/id<>\$10/iu.test(sql)) return { rows: [recoveryRow], rowCount: 1 };
    throw new Error(`unexpected SQL: ${sql}`);
  });
  const repository = createPostgresGenerationAttemptRepository({ pool: db.pool });

  const result = await repository.bindGenerationAttemptInput({
    ...scope, attemptIdentityHash, inputHash, generationSize, attemptNo: 2, leaseToken: "lease-b:2",
  });

  assert.equal(result.status, "BOUND");
  assert.equal(result.recoveryRecord.errorCode, "CHECKER_EVIDENCE_INVALID");
  assert.equal(result.recoveryRecord.objectKey, objectKey);
  const recoveryQuery = db.queries.find(({ text }) => /id<>\$10/iu.test(text));
  assert.match(recoveryQuery.text, /CHECKER_RESPONSE_INVALID/iu);
  assert.match(recoveryQuery.text, /CHECKER_EVIDENCE_INVALID/iu);
});

test("channel release keeps stored image evidence while clearing the exact owned lease", async () => {
  const objectKey = buildGeneratedAssetObjectKey({
    ...scope, attemptIdentityHash, inputHash, attemptNo: 1, contentHash,
  });
  const releasedRow = reservedRow({
    input_hash: inputHash, status: "GENERATING", final_input_bound_at: new Date("2026-08-04T00:00:10.000Z"),
    lease_token: "AUTO_LISTING_IMAGE_CHANNEL_RELEASED", lease_expires_at: new Date("2026-08-04T00:00:20.000Z"),
    error_code: null, error_retryable: null,
    object_key_version: "ATTEMPT_V2", object_key: objectKey, content_hash: contentHash,
    content_type: "image/png", width: 768, height: 1024, size_bytes: 123,
    gateway_request_id: "gateway-1", model_evidence: { requestedImageModel: "image-a" },
  });
  const db = fakePool((sql) => {
    if (/AUTO_LISTING_IMAGE_CHANNEL_RELEASED/iu.test(sql)) return { rows: [releasedRow], rowCount: 1 };
    throw new Error(`unexpected SQL: ${sql}`);
  });
  const repository = createPostgresGenerationAttemptRepository({ pool: db.pool });

  const released = await repository.releaseGenerationLease({
    ...scope, attemptIdentityHash, inputHash, generationSize, attemptNo: 1, leaseToken: "lease-a:1",
    errorCode: "AUTO_LISTING_IMAGE_CHANNEL_RELEASED", role: "MAIN",
    profileId: "profile-a", profileVersion: 1, modelName: "image-a", gatewayRequestId: "gateway-1",
    checkerRequestId: null, modelEvidence: { requestedImageModel: "image-a" },
  });

  assert.equal(released.status, "GENERATING");
  assert.equal(released.attemptNo, 1);
  assert.equal(released.leaseToken, "AUTO_LISTING_IMAGE_CHANNEL_RELEASED");
  assert.equal(released.objectKey, objectKey);
  const transition = db.queries.find(({ text }) => /AUTO_LISTING_IMAGE_CHANNEL_RELEASED/iu.test(text));
  assert.match(transition.text, /account_id=\$1.*item_id=\$3.*attempt_no=\$11.*lease_token=\$12/isu);
  assert.match(transition.text, /gateway_request_id=COALESCE/iu);
  assert.match(transition.text, /model_evidence=COALESCE/iu);
});

test("stored-evidence compensation clears only the exact generating owner before object cleanup", async () => {
  const objectKey = buildGeneratedAssetObjectKey({
    ...scope, attemptIdentityHash, inputHash, attemptNo: 1, contentHash,
  });
  const clearedRow = reservedRow({
    input_hash: inputHash, final_input_bound_at: new Date("2026-08-04T00:00:10.000Z"),
    object_key_version: null, object_key: null, content_hash: null, content_type: null,
    width: null, height: null, size_bytes: null,
  });
  const db = fakePool((sql) => {
    if (/WITH reverted AS/iu.test(sql)) return { rows: [{ disposition: "REVERTED", ...clearedRow }], rowCount: 1 };
    throw new Error(`unexpected SQL: ${sql}`);
  });
  const repository = createPostgresGenerationAttemptRepository({ pool: db.pool });
  const result = await repository.revertStoredGenerationAsset({
    ...scope, attemptIdentityHash, inputHash, generationSize, attemptNo: 1, leaseToken: "lease-a:1",
    objectKeyVersion: "ATTEMPT_V2", objectKey, contentHash, contentType: "image/png",
    width: 768, height: 1024, size: 123,
  });

  assert.deepEqual(result, { disposition: "REVERTED" });
  const query = db.queries[0];
  assert.match(query.text, /object_key_version=NULL.*object_key=NULL.*content_hash=NULL/isu);
  assert.match(query.text, /attempt_no=\$11.*lease_token=\$12.*status='GENERATING'/isu);
  assert.match(query.text, /object_key_version=\$13.*object_key=\$14.*content_hash=\$15/isu);
  assert.match(query.text, /item\.status='GENERATING'.*active_content_plan_id=attempt\.plan_id/isu);
});

test("reservation reclaims a channel-released row at the same attempt with a fresh token", async () => {
  const releasedRow = reservedRow({
    input_hash: inputHash, status: "GENERATING", final_input_bound_at: new Date("2026-08-04T00:00:10.000Z"),
    lease_token: "AUTO_LISTING_IMAGE_CHANNEL_RELEASED", lease_expires_at: new Date("2026-08-04T00:00:20.000Z"),
    error_code: null, error_retryable: null,
  });
  const reclaimedRow = reservedRow({
    input_hash: inputHash, final_input_bound_at: new Date("2026-08-04T00:00:10.000Z"),
    lease_token: "lease-new:1", attempt_no: 1,
    gateway_connection_id: "connection-b", gateway_connection_version: 9,
  });
  const db = fakePool((sql) => {
    if (/FROM auto_listing_job_items AS item/iu.test(sql)) return { rows: [itemRow], rowCount: 1 };
    if (/status='ACCEPTED'/iu.test(sql) && /^\s*SELECT/iu.test(sql)) return { rows: [], rowCount: 0 };
    if (/status='GENERATING'.*lease_expires_at > NOW\(\)/isu.test(sql) && /^\s*SELECT/iu.test(sql)) return { rows: [], rowCount: 0 };
    if (/SET status='FAILED'.*LEASE_EXPIRED/isu.test(sql)) return { rows: [], rowCount: 0 };
    if (/lease_token='AUTO_LISTING_IMAGE_CHANNEL_RELEASED'/iu.test(sql) && /^\s*SELECT/iu.test(sql)) {
      return { rows: [releasedRow], rowCount: 1 };
    }
    if (/SET status='GENERATING'.*lease_token/isu.test(sql)) return { rows: [reclaimedRow], rowCount: 1 };
    throw new Error(`unexpected SQL: ${sql}`);
  });
  const repository = createPostgresGenerationAttemptRepository({
    pool: db.pool, token: () => "lease-new", id: () => "unused-generation",
  });

  const reclaimed = await repository.reserveGenerationAttempt({
    ...scope, attemptIdentityHash, generationSize, maxAttempts: 3,
    gatewayConnectionId: "connection-b", gatewayConnectionVersion: 9,
  });

  assert.equal(reclaimed.status, "RESERVED");
  assert.equal(reclaimed.attemptNo, 1);
  assert.equal(reclaimed.leaseToken, "lease-new:1");
  assert.equal(reclaimed.gatewayConnectionId, "connection-b");
  assert.equal(reclaimed.gatewayConnectionVersion, 9);
  assert.equal(db.queries.some(({ text }) => /INSERT INTO ai_generation_assets/iu.test(text)), false);
  assert.equal(db.queries.some(({ text }) => /COALESCE\(MAX\(attempt_no\)/iu.test(text)), false);
});

test("PostgreSQL reclaim keeps producer A when connection B reuses A's stored paid image", async () => {
  const objectKey = buildGeneratedAssetObjectKey({ ...scope, attemptIdentityHash, inputHash, attemptNo: 1, contentHash });
  const releasedRow = reservedRow({
    input_hash: inputHash, final_input_bound_at: new Date("2026-08-04T00:00:10.000Z"),
    lease_token: "AUTO_LISTING_IMAGE_CHANNEL_RELEASED", lease_expires_at: new Date("2026-08-04T00:00:20.000Z"),
    gateway_connection_id: "connection-a", gateway_connection_version: 4,
    gateway_request_id: "gateway-a", model_evidence: { requestedImageModel: "image-a" },
    object_key_version: "ATTEMPT_V2", object_key: objectKey, content_hash: contentHash,
    content_type: "image/png", width: 768, height: 1024, size_bytes: 123,
  });
  const reclaimedRow = { ...releasedRow, lease_token: "lease-b:1", lease_expires_at: new Date("2026-08-04T00:01:00.000Z") };
  const db = fakePool((sql) => {
    if (/FROM auto_listing_job_items AS item/iu.test(sql)) return { rows: [itemRow], rowCount: 1 };
    if (/status='ACCEPTED'/iu.test(sql) && /^\s*SELECT/iu.test(sql)) return { rows: [], rowCount: 0 };
    if (/status='GENERATING'.*lease_expires_at > NOW\(\)/isu.test(sql) && /^\s*SELECT/iu.test(sql)) return { rows: [], rowCount: 0 };
    if (/SET status='FAILED'.*LEASE_EXPIRED/isu.test(sql)) return { rows: [], rowCount: 0 };
    if (/lease_token='AUTO_LISTING_IMAGE_CHANNEL_RELEASED'/iu.test(sql) && /^\s*SELECT/iu.test(sql)) return { rows: [releasedRow], rowCount: 1 };
    if (/SET status='GENERATING'.*lease_token/isu.test(sql)) return { rows: [reclaimedRow], rowCount: 1 };
    throw new Error(`unexpected SQL: ${sql}`);
  });
  const repository = createPostgresGenerationAttemptRepository({ pool: db.pool, token: () => "lease-b" });
  const result = await repository.reserveGenerationAttempt({
    ...scope, attemptIdentityHash, generationSize, maxAttempts: 3,
    gatewayConnectionId: "connection-b", gatewayConnectionVersion: 9,
  });

  assert.equal(result.gatewayConnectionId, "connection-a");
  assert.equal(result.gatewayConnectionVersion, 4);
  const reclaim = db.queries.find(({ text }) => /SET status='GENERATING'.*lease_token/isu.test(text));
  assert.match(reclaim.text, /gateway_connection_id=CASE WHEN \$6 THEN gateway_connection_id ELSE \$4 END/iu);
  assert.equal(reclaim.parameters.at(-1), true);
});

test("PostgreSQL reclaim assigns producer B when A's stored image evidence is not reusable", async () => {
  const releasedRow = reservedRow({
    input_hash: inputHash, final_input_bound_at: new Date("2026-08-04T00:00:10.000Z"),
    lease_token: "AUTO_LISTING_IMAGE_CHANNEL_RELEASED", lease_expires_at: new Date("2026-08-04T00:00:20.000Z"),
    gateway_connection_id: "connection-a", gateway_connection_version: 4,
    gateway_request_id: "gateway-a", model_evidence: { requestedImageModel: "image-a" },
    object_key_version: "ATTEMPT_V2", object_key: "invalid/object/key", content_hash: contentHash,
    content_type: "image/png", width: 768, height: 1024, size_bytes: 123,
  });
  const reclaimedRow = {
    ...releasedRow, lease_token: "lease-b:1", lease_expires_at: new Date("2026-08-04T00:01:00.000Z"),
    gateway_connection_id: "connection-b", gateway_connection_version: 9,
  };
  const db = fakePool((sql) => {
    if (/FROM auto_listing_job_items AS item/iu.test(sql)) return { rows: [itemRow], rowCount: 1 };
    if (/status='ACCEPTED'/iu.test(sql) && /^\s*SELECT/iu.test(sql)) return { rows: [], rowCount: 0 };
    if (/status='GENERATING'.*lease_expires_at > NOW\(\)/isu.test(sql) && /^\s*SELECT/iu.test(sql)) return { rows: [], rowCount: 0 };
    if (/SET status='FAILED'.*LEASE_EXPIRED/isu.test(sql)) return { rows: [], rowCount: 0 };
    if (/lease_token='AUTO_LISTING_IMAGE_CHANNEL_RELEASED'/iu.test(sql) && /^\s*SELECT/iu.test(sql)) return { rows: [releasedRow], rowCount: 1 };
    if (/SET status='GENERATING'.*lease_token/isu.test(sql)) return { rows: [reclaimedRow], rowCount: 1 };
    throw new Error(`unexpected SQL: ${sql}`);
  });
  const repository = createPostgresGenerationAttemptRepository({ pool: db.pool, token: () => "lease-b" });

  const result = await repository.reserveGenerationAttempt({
    ...scope, attemptIdentityHash, generationSize, maxAttempts: 3,
    gatewayConnectionId: "connection-b", gatewayConnectionVersion: 9,
  });

  assert.equal(result.gatewayConnectionId, "connection-b");
  assert.equal(result.gatewayConnectionVersion, 9);
  const reclaim = db.queries.find(({ text }) => /SET status='GENERATING'.*lease_token/isu.test(text));
  assert.equal(reclaim.parameters.at(-1), false);
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
