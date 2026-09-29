import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

const H = (digit) => digit.repeat(64);
const canonical = (value) => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const digest = (value) => crypto.createHash("sha256")
  .update(JSON.stringify(canonical(value))).digest("hex");

function scope(overrides = {}) {
  return {
    accountId: "account-a", jobId: "job-a", itemId: "item-a", planId: "plan-a",
    sourceImageAnalysisRunId: "run-a", expectedStatusVersion: 7,
    visualGroupKey: "group-a", inputHash: H("1"),
    ...overrides,
  };
}

function result(overrides = {}) {
  return {
    accepted: true,
    acceptedSlotKeys: ["main-1", "selling-1", "infographic-1", "scene-1", "detail-1", "specification-1"],
    duplicateSlotKeys: [],
    viewMismatchSlotKeys: [],
    identityMismatchSlotKeys: [],
    retrySlotKeys: [],
    reasonCodes: [],
    ...overrides,
  };
}

function recordInput(overrides = {}) {
  const storedResult = overrides.result ?? result();
  return {
    ...scope(),
    result: storedResult,
    resultHash: digest(storedResult),
    gatewayRequestId: "gateway-request-a",
    modelEvidence: {
      requestedTextModel: "checker-model",
      gatewayReportedTextModel: "checker-model",
      gatewayReportedTextModelPresent: true,
    },
    gatewayConnectionId: "connection-a",
    gatewayConnectionVersion: 3,
    ...overrides,
  };
}

async function moduleUnderTest() {
  return import(`../auto-listing-image-group-check-repository.mjs?test=${Date.now()}-${Math.random()}`);
}

test("memory group-check outcomes are idempotent by exact scoped input and preserve call evidence", async () => {
  const { createMemoryImageGroupCheckRepository } = await moduleUnderTest();
  const repository = createMemoryImageGroupCheckRepository({
    id: () => "image-group-check-a",
    now: () => new Date("2026-08-30T00:00:00.000Z"),
  });

  const first = await repository.recordOutcome(recordInput());
  const replay = await repository.recordOutcome(recordInput());

  assert.deepEqual(replay, first);
  assert.equal(first.status, "ACCEPTED");
  assert.equal(first.inputHash, H("1"));
  assert.equal(first.resultHash, digest(result()));
  assert.equal(first.gatewayRequestId, "gateway-request-a");
  assert.deepEqual(first.gatewayConnection, { id: "connection-a", version: 3 });
  assert.deepEqual(await repository.loadOutcome(scope()), first);
});

test("repository rejects cross-scope replay and a different result for one input", async () => {
  const { createMemoryImageGroupCheckRepository } = await moduleUnderTest();
  const repository = createMemoryImageGroupCheckRepository({
    id: () => "image-group-check-a",
    now: () => new Date("2026-08-30T00:00:00.000Z"),
  });
  await repository.recordOutcome(recordInput());

  assert.equal(await repository.loadOutcome(scope({ accountId: "account-b" })), null);
  await assert.rejects(repository.recordOutcome(recordInput({
    result: result({
      accepted: false,
      acceptedSlotKeys: [],
      duplicateSlotKeys: ["main-1"],
      retrySlotKeys: ["main-1"],
      reasonCodes: ["IMAGE_GROUP_DUPLICATE_VIEW"],
    }),
  })), { code: "AUTO_LISTING_IMAGE_GROUP_CHECK_CONFLICT" });

  await assert.rejects(repository.recordOutcome(recordInput({
    ...scope({ inputHash: H("4") }),
    result: result({ duplicateSlotKeys: ["main-1"] }),
  })), { code: "AUTO_LISTING_IMAGE_GROUP_CHECK_INPUT_INVALID" });
});

test("repository rejects a caller-forged result hash", async () => {
  const { createMemoryImageGroupCheckRepository } = await moduleUnderTest();
  const repository = createMemoryImageGroupCheckRepository();

  await assert.rejects(repository.recordOutcome(recordInput({ resultHash: H("2") })), {
    code: "AUTO_LISTING_IMAGE_GROUP_CHECK_INPUT_INVALID",
  });
});

test("repository rejects missing or dangling group-check reason codes", async () => {
  const { createMemoryImageGroupCheckRepository } = await moduleUnderTest();
  const repository = createMemoryImageGroupCheckRepository();
  for (const invalidResult of [
    result({ reasonCodes: ["IMAGE_GROUP_DUPLICATE_VIEW"] }),
    result({
      accepted: false,
      acceptedSlotKeys: ["main-1", "infographic-1", "scene-1", "detail-1", "specification-1"],
      duplicateSlotKeys: ["selling-1"],
      retrySlotKeys: ["selling-1"],
    }),
  ]) {
    await assert.rejects(repository.recordOutcome(recordInput({ result: invalidResult })), {
      code: "AUTO_LISTING_IMAGE_GROUP_CHECK_INPUT_INVALID",
    });
  }
});

test("repository persists one retry slot with multiple issue classifications", async () => {
  const { createMemoryImageGroupCheckRepository } = await moduleUnderTest();
  const repository = createMemoryImageGroupCheckRepository();
  const compound = result({
    accepted: false,
    acceptedSlotKeys: ["main-1", "infographic-1", "scene-1", "detail-1", "specification-1"],
    duplicateSlotKeys: ["selling-1"],
    viewMismatchSlotKeys: ["selling-1"],
    identityMismatchSlotKeys: ["selling-1"],
    retrySlotKeys: ["selling-1"],
    reasonCodes: [
      "IMAGE_GROUP_DUPLICATE_VIEW",
      "IMAGE_GROUP_VIEW_MISMATCH",
      "IMAGE_GROUP_IDENTITY_MISMATCH",
    ],
  });

  const stored = await repository.recordOutcome(recordInput({ result: compound }));

  assert.equal(stored.status, "REJECTED");
  assert.deepEqual(stored.result, compound);
});

test("repository accepts the full settings MODEL_ID grammar in model evidence", async () => {
  const { createMemoryImageGroupCheckRepository } = await moduleUnderTest();
  const repository = createMemoryImageGroupCheckRepository();
  for (const model of ["openai/gpt-5.4+stable", `a${"b".repeat(299)}`]) {
    const stored = await repository.recordOutcome(recordInput({
      ...scope({ inputHash: digest(model) }),
      modelEvidence: {
        requestedTextModel: model,
        gatewayReportedTextModel: model,
        gatewayReportedTextModelPresent: true,
      },
    }));
    assert.equal(stored.modelEvidence.requestedTextModel, model);
    assert.equal(stored.modelEvidence.gatewayReportedTextModel, model);
  }
});

test("postgres repository stores and reloads hashes plus gateway model and connection evidence", async () => {
  const { createPostgresImageGroupCheckRepository } = await moduleUnderTest();
  const calls = [];
  const row = {
    id: "image-group-check-a", account_id: "account-a", job_id: "job-a", item_id: "item-a",
    plan_id: "plan-a", source_image_analysis_run_id: "run-a", expected_status_version: 7,
    visual_group_key: "group-a", input_hash: H("1"), result_hash: digest(result()), status: "ACCEPTED",
    result: result(), error_code: null, gateway_request_id: "gateway-request-a",
    model_evidence: recordInput().modelEvidence, gateway_connection_id: "connection-a",
    gateway_connection_version: 3, created_at: "2026-08-30T00:00:00.000Z",
    completed_at: "2026-08-30T00:00:00.000Z",
  };
  const pool = {
    async query(sql, values) {
      calls.push({ sql, values });
      return /INSERT INTO auto_listing_image_group_checks/iu.test(sql)
        ? { rowCount: 1, rows: [row] }
        : { rowCount: 1, rows: [row] };
    },
  };
  const repository = createPostgresImageGroupCheckRepository({ pool, id: () => "image-group-check-a" });

  const stored = await repository.recordOutcome(recordInput());
  const loaded = await repository.loadOutcome(scope());

  assert.deepEqual(loaded, stored);
  assert.match(calls[0].sql, /gateway_request_id[\s\S]*model_evidence[\s\S]*gateway_connection_id[\s\S]*gateway_connection_version/iu);
  assert.deepEqual(calls[0].values.slice(-4), [
    "gateway-request-a", JSON.stringify(recordInput().modelEvidence), "connection-a", 3,
  ]);
  assert.match(calls[1].sql, /account_id=\$1[\s\S]*job_id=\$2[\s\S]*item_id=\$3[\s\S]*plan_id=\$4[\s\S]*input_hash=\$8/iu);
});

test("postgres repository rejects a stored row whose result hash does not match its result", async () => {
  const { createPostgresImageGroupCheckRepository } = await moduleUnderTest();
  const row = {
    id: "image-group-check-a", account_id: "account-a", job_id: "job-a", item_id: "item-a",
    plan_id: "plan-a", source_image_analysis_run_id: "run-a", expected_status_version: 7,
    visual_group_key: "group-a", input_hash: H("1"), result_hash: H("2"), status: "ACCEPTED",
    result: result(), error_code: null, gateway_request_id: "gateway-request-a",
    model_evidence: recordInput().modelEvidence, gateway_connection_id: "connection-a",
    gateway_connection_version: 3, created_at: "2026-08-30T00:00:00.000Z",
    completed_at: "2026-08-30T00:00:00.000Z",
  };
  const repository = createPostgresImageGroupCheckRepository({
    pool: { async query() { return { rowCount: 1, rows: [row] }; } },
  });

  await assert.rejects(repository.loadOutcome(scope()), {
    code: "AUTO_LISTING_IMAGE_GROUP_CHECK_INPUT_INVALID",
  });
});
