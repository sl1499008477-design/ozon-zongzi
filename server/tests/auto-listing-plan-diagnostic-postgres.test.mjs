import assert from "node:assert/strict";
import test from "node:test";

import { createPostgresAutoListingPlanDiagnosticRepository } from "../auto-listing-plan-diagnostic-postgres.mjs";

function row(overrides = {}) {
  return {
    id: "response-a", account_id: "account-a", job_id: "job-a", item_id: "item-a",
    attempt_id: "attempt-a", diagnostic_run_id: null, planning_contract: "LEGACY_FULL_PLAN_V3",
    model_name: "text-model-a", prompt_template_version: "AUTO_LISTING_CONTENT_PLAN_V3",
    gateway_request_id: "gateway-a", received_at: new Date("2026-08-14T01:02:03.000Z"),
    response: { version: 1, language: "ru", slots: [] }, validation_status: "REJECTED",
    validator_version: "AUTO_LISTING_CONTENT_PLAN_VALIDATOR_V1",
    issues: [{ code: "ROLE_COUNT_MISMATCH", slotKey: null, claimIndex: null,
      field: "role", expected: "SELLING_POINT x 3", actual: "DETAIL x 2" }],
    validated_at: new Date("2026-08-14T01:02:04.000Z"),
    ...overrides,
  };
}

test("loads the deterministically latest validated response inside exact tenant job and item scope", async () => {
  const calls = [];
  const repository = createPostgresAutoListingPlanDiagnosticRepository({ pool: {
    async query(sql, values) {
      calls.push({ sql, values });
      return { rowCount: 1, rows: [values.length === 4
        ? row({ attempt_id: null, diagnostic_run_id: "diagnostic-a" }) : row()] };
    },
  } });
  const result = await repository.loadLatest({ accountId: "account-a", jobId: "job-a", itemId: "item-a" });
  assert.deepEqual(calls[0].values, ["account-a", "job-a", "item-a"]);
  assert.match(calls[0].sql, /response\.account_id=\$1[\s\S]*response\.job_id=\$2[\s\S]*response\.item_id=\$3/iu);
  assert.match(calls[0].sql, /JOIN auto_listing_content_plan_validation_results/iu);
  assert.match(calls[0].sql, /ORDER BY response\.received_at DESC,response\.id DESC[\s\S]*LIMIT 1/iu);
  assert.equal(result.responseId, "response-a");
  assert.equal(result.validation.status, "REJECTED");
  assert.equal(result.receivedAt, "2026-08-14T01:02:03.000Z");

  const exactRun = await repository.loadRun({
    accountId: "account-a", jobId: "job-a", itemId: "item-a", runId: "diagnostic-a",
  });
  assert.deepEqual(calls[1].values, ["account-a", "job-a", "item-a", "diagnostic-a"]);
  assert.match(calls[1].sql, /response\.diagnostic_run_id=\$4/iu);
  assert.doesNotMatch(calls[1].sql, /ORDER BY/iu);
  assert.equal(exactRun.responseId, "response-a");
});

test("invalid scope and malformed or cross-tenant rows fail closed", async () => {
  let queries = 0;
  const pool = { async query() { queries += 1; return { rowCount: 0, rows: [] }; } };
  const repository = createPostgresAutoListingPlanDiagnosticRepository({ pool });
  await assert.rejects(repository.loadLatest({ accountId: "account-a", jobId: "job-a", itemId: "item-a", extra: true }),
    { code: "AUTO_LISTING_PLAN_DIAGNOSTIC_REPOSITORY_INVALID" });
  assert.equal(queries, 0);
  assert.equal(await repository.loadLatest({ accountId: "account-a", jobId: "job-a", itemId: "item-a" }), null);
  const forged = createPostgresAutoListingPlanDiagnosticRepository({ pool: {
    async query() { return { rowCount: 1, rows: [row({ account_id: "account-b" })] }; },
  } });
  await assert.rejects(forged.loadLatest({ accountId: "account-a", jobId: "job-a", itemId: "item-a" }),
    { code: "AUTO_LISTING_PLAN_DIAGNOSTIC_REPOSITORY_FAILED" });

  let getters = 0;
  const hostileIssues = [];
  Object.defineProperty(hostileIssues, "0", {
    enumerable: true,
    configurable: true,
    get() { getters += 1; return {}; },
  });
  hostileIssues.length = 1;
  const hostile = createPostgresAutoListingPlanDiagnosticRepository({ pool: {
    async query() { return { rowCount: 1, rows: [row({ issues: hostileIssues })] }; },
  } });
  await assert.rejects(hostile.loadLatest({ accountId: "account-a", jobId: "job-a", itemId: "item-a" }),
    { code: "AUTO_LISTING_PLAN_DIAGNOSTIC_REPOSITORY_FAILED" });
  assert.equal(getters, 0);
});

test("projects the migration-103 run and hash pair only for intelligent diagnostics", async () => {
  const calls = [];
  const intelligentRow = row({
    attempt_id: null,
    diagnostic_run_id: "diagnostic-a",
    planning_contract: "FIXED_SKELETON_SOURCE_IMAGE_V1",
    source_image_analysis_run_id: "analysis-run-a",
    source_image_intelligence_hash: "c".repeat(64),
    response: { version: 1, language: "ru", fills: {} },
    validation_status: "ACCEPTED",
    issues: [],
  });
  const repository = createPostgresAutoListingPlanDiagnosticRepository({ pool: {
    async query(sql) { calls.push(sql); return { rowCount: 1, rows: [intelligentRow] }; },
  } });
  const projected = await repository.loadLatest({ accountId: "account-a", jobId: "job-a", itemId: "item-a" });
  assert.equal(projected.sourceImageAnalysisRunId, "analysis-run-a");
  assert.equal(projected.sourceImageIntelligenceHash, "c".repeat(64));
  assert.match(calls[0], /response\.source_image_analysis_run_id/u);
  assert.match(calls[0], /response\.source_image_intelligence_hash/u);

  const legacyRepository = createPostgresAutoListingPlanDiagnosticRepository({ pool: {
    async query() { return { rowCount: 1, rows: [row({
      source_image_analysis_run_id: null, source_image_intelligence_hash: null,
    })] }; },
  } });
  const legacy = await legacyRepository.loadLatest({ accountId: "account-a", jobId: "job-a", itemId: "item-a" });
  assert.equal(Object.hasOwn(legacy, "sourceImageAnalysisRunId"), false);
  assert.equal(Object.hasOwn(legacy, "sourceImageIntelligenceHash"), false);
});
