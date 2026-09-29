import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import sharp from "sharp";

import {
  buildSourceMaterializationObjectKey,
  verifySourceMaterializationObjectKey,
} from "../auto-listing-source-materialization-repository.mjs";
import { createActiveMaterializedSourceAssetLoader } from "../auto-listing-materialized-source-loader.mjs";

const H = (value) => value.repeat(64);
const bytes = Buffer.from("verified-source-image-bytes");
const contentHash = crypto.createHash("sha256").update(bytes).digest("hex");
const canonical = (value) => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const digest = (value) => crypto.createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
const request = Object.freeze({
  accountId: "account-a",
  jobId: "job-a",
  itemId: "item-a",
  planId: "plan-derived-a",
  visualGroupKey: "group-a",
  slotKey: "main-1",
  expectedStatusVersion: 7,
  assetId: "source-a",
  sourceRef: null,
  evidenceKind: "CONTENT_HASH",
});

function accepted(overrides = {}) {
  const record = {
    accountId: "account-a",
    jobId: "job-a",
    itemId: "item-a",
    parentPlanId: "plan-parent-a",
    sourceAssetId: "source-a",
    sourceRefHash: H("a"),
    inputHash: H("b"),
    expectedStatusVersion: 7,
    attemptId: "attempt-a",
    attemptNo: 1,
    leaseToken: null,
    objectKeyVersion: "SOURCE_V1",
    contentHash,
    contentType: "image/png",
    width: 900,
    height: 1200,
    sizeBytes: bytes.length,
    status: "ACCEPTED",
    ...overrides,
  };
  record.objectKey = buildSourceMaterializationObjectKey(record);
  return record;
}

test("loader follows only the exact active derived plan and returns verified immutable bytes", async () => {
  const queries = [];
  const lists = [];
  const reads = [];
  const record = accepted({ expectedStatusVersion: 6 });
  const loader = createActiveMaterializedSourceAssetLoader({
    pool: {
      async query(sql, values) {
        queries.push([sql, values]);
        return { rows: [{ parent_plan_id: "plan-parent-a" }], rowCount: 1 };
      },
    },
    repository: {
      async listAcceptedSourceMaterializationsForPlan(input) { lists.push(input); return [record]; },
    },
    storage: {
      async getObjectBuffer(key, options) { reads.push([key, options]); return Buffer.from(bytes); },
    },
  });

  assert.deepEqual(await loader.loadSourceAsset(request), {
    assetId: "source-a",
    sourceRef: null,
    evidenceKind: "CONTENT_HASH",
    bytes,
    contentType: "image/png",
    width: 900,
    height: 1200,
  });
  assert.deepEqual(queries[0][1], ["account-a", "job-a", "item-a", "plan-derived-a", 7]);
  assert.match(queries[0][0], /active_content_plan_id\s*=\s*plan\.id/iu);
  assert.match(queries[0][0], /plan\.derivation_kind\s*=\s*'SOURCE_MATERIALIZATION'/iu);
  assert.deepEqual(lists, [{
    accountId: "account-a", jobId: "job-a", itemId: "item-a",
    parentPlanId: "plan-parent-a",
  }]);
  assert.deepEqual(reads, [[record.objectKey, { maxBytes: 8 * 1024 * 1024 }]]);
});

test("loader follows an intelligent derived plan to its exact accepted source-analysis materialization", async () => {
  const lists = [];
  const record = accepted({ expectedStatusVersion: 5 });
  delete record.parentPlanId;
  record.owner = { kind: "SOURCE_IMAGE_ANALYSIS", id: "analysis-run-a" };
  record.objectKeyVersion = "SOURCE_V2";
  record.objectKey = buildSourceMaterializationObjectKey(record);
  assert.equal(verifySourceMaterializationObjectKey(record), true);
  const responses = [
    {
      rows: [{
        parent_plan_id: "plan-parent-a",
        source_image_analysis_run_id: "analysis-run-a",
      }],
      rowCount: 1,
    },
    { rows: [{ id: "analysis-run-a", expected_status_version: 5 }], rowCount: 1 },
  ];
  const loader = createActiveMaterializedSourceAssetLoader({
    pool: {
      async query() {
        return responses.shift();
      },
    },
    repository: {
      async listAcceptedSourceMaterializationsForPlan(input) {
        lists.push(input);
        return [record];
      },
    },
    storage: { async getObjectBuffer() { return Buffer.from(bytes); } },
  });

  const result = await loader.loadSourceAsset(request);

  assert.equal(result.assetId, "source-a");
  assert.deepEqual(lists, [{
    accountId: "account-a",
    jobId: "job-a",
    itemId: "item-a",
    parentPlanId: "plan-parent-a",
    sourceImageAnalysisRunId: "analysis-run-a",
  }]);
});

test("loader resolves a manual-decision plan through the exact same-item analysis lineage to immutable root bytes", async () => {
  const lists = [];
  const queries = [];
  const record = accepted({ expectedStatusVersion: 5 });
  delete record.parentPlanId;
  record.owner = { kind: "SOURCE_IMAGE_ANALYSIS", id: "analysis-run-root" };
  record.objectKeyVersion = "SOURCE_V2";
  record.objectKey = buildSourceMaterializationObjectKey(record);
  const responses = [
    { rows: [{ parent_plan_id: "plan-parent-a", source_image_analysis_run_id: "analysis-run-derived" }], rowCount: 1 },
    { rows: [{ id: "analysis-run-root", expected_status_version: 5 }], rowCount: 1 },
  ];
  const loader = createActiveMaterializedSourceAssetLoader({
    pool: {
      async query(sql, values) {
        queries.push({ sql, values });
        return responses.shift();
      },
    },
    repository: {
      async listAcceptedSourceMaterializationsForPlan(input) {
        lists.push(input);
        return [record];
      },
    },
    storage: { async getObjectBuffer() { return Buffer.from(bytes); } },
  });

  assert.equal((await loader.loadSourceAsset(request)).assetId, "source-a");
  assert.deepEqual(lists, [{
    accountId: "account-a",
    jobId: "job-a",
    itemId: "item-a",
    parentPlanId: "plan-parent-a",
    sourceImageAnalysisRunId: "analysis-run-derived",
    sourceMaterializationAnalysisRunId: "analysis-run-root",
  }]);
  assert.match(queries[1].sql, /WITH RECURSIVE current_run/iu);
  assert.match(queries[1].sql, /parent_run_id IS NULL/iu);
  assert.deepEqual(queries[1].values, ["account-a", "job-a", "item-a", "analysis-run-derived", "source-a"]);
});

test("loader resolves copied retry assessments to the exact immutable materialization owner", async () => {
  const lists = [];
  const queries = [];
  const record = accepted({ expectedStatusVersion: 5 });
  delete record.parentPlanId;
  record.owner = { kind: "SOURCE_IMAGE_ANALYSIS", id: "analysis-run-root" };
  record.objectKeyVersion = "SOURCE_V2";
  record.objectKey = buildSourceMaterializationObjectKey(record);
  const responses = [
    { rows: [{ parent_plan_id: "plan-parent-a", source_image_analysis_run_id: "analysis-run-retry" }], rowCount: 1 },
    { rows: [{ id: "analysis-run-root", expected_status_version: 5 }], rowCount: 1 },
  ];
  const loader = createActiveMaterializedSourceAssetLoader({
    pool: {
      async query(sql, values) {
        queries.push({ sql, values });
        return responses.shift();
      },
    },
    repository: {
      async listAcceptedSourceMaterializationsForPlan(input) {
        lists.push(input);
        return [record];
      },
    },
    storage: { async getObjectBuffer() { return Buffer.from(bytes); } },
  });

  assert.equal((await loader.loadSourceAsset(request)).assetId, "source-a");
  assert.deepEqual(lists, [{
    accountId: "account-a",
    jobId: "job-a",
    itemId: "item-a",
    parentPlanId: "plan-parent-a",
    sourceImageAnalysisRunId: "analysis-run-retry",
    sourceMaterializationAnalysisRunId: "analysis-run-root",
  }]);
  assert.match(queries[1].sql, /auto_listing_source_image_assessments\s+AS\s+assessment/iu);
  assert.match(queries[1].sql, /assessment\.analysis_run_id=\$4/iu);
  assert.match(queries[1].sql, /attempt\.object_key=assessment\.object_key/iu);
  assert.match(queries[1].sql, /candidate\.source_asset_set_hash=current_run\.source_asset_set_hash/iu);
  assert.match(queries[1].sql,
    /EXISTS\s*\([\s\S]*FROM lineage AS input_owner[\s\S]*input_owner\.input_hash=candidate\.input_hash/iu);
});

test("loader resolves an inherited V2 CLEANED binding to its exact ancestor derivative", async () => {
  const originalBytes = await sharp({
    create: { width: 24, height: 32, channels: 3, background: "#bb2222" },
  }).png().toBuffer();
  const cleanedBytes = await sharp({
    create: { width: 24, height: 32, channels: 3, background: "#cc3333" },
  }).png().toBuffer();
  const originalHash = crypto.createHash("sha256").update(originalBytes).digest("hex");
  const cleanedHash = crypto.createHash("sha256").update(cleanedBytes).digest("hex");
  const cleanupEvidenceHash = H("c");
  const summaryValue = {
    contractVersion: "AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_V2",
    coverageMap: {
      FRONT: { assetIds: ["source-a"], preciseViewpoints: ["FRONT"], tentativeAssetIds: [] },
      COMPLETE_PRODUCT: {
        confirmedFamilyCount: 1, confirmedFamilies: ["FRONT"], requiredFamilyCount: 1,
        prohibitedViews: ["BACK", "LEFT", "RIGHT", "TOP", "BOTTOM", "INTERIOR"],
      },
    },
    factCandidates: [],
    markingDecisions: [{
      sourceAssetId: "source-a", kind: "EXTERNAL_OVERLAY", regions: [],
      decisionMethod: "BACKGROUND_CANVAS_OVERLAY", reasonCodes: ["EXTERNAL_OVERLAY_ASSET_EXCLUDED"],
    }],
    eligibleAssetIds: ["source-a"], excludedAssetIds: [], requiredConfirmations: [],
    symmetryClass: "ASYMMETRIC", reasonCodes: ["AUTO_LISTING_SOURCE_IMAGE_HIDDEN_VIEW_INFERENCE_PROHIBITED"],
    appearanceAssetBindings: [{
      sourceAssetId: "source-a", mode: "CLEANED", effectiveContentHash: cleanedHash,
      derivativeAttemptId: "derivative-a", cleanupEvidenceHash,
    }],
  };
  const summary = { ...summaryValue, summaryHash: digest(summaryValue) };
  const record = accepted({ expectedStatusVersion: 5, contentHash: originalHash, sizeBytes: originalBytes.length });
  delete record.parentPlanId;
  record.owner = { kind: "SOURCE_IMAGE_ANALYSIS", id: "analysis-run-materialized" };
  record.objectKeyVersion = "SOURCE_V2";
  record.objectKey = buildSourceMaterializationObjectKey(record);
  const derivativeAttempt = {
    accountId: "account-a", jobId: "job-a", itemId: "item-a", analysisRunId: "analysis-run-root",
    sourceAssetId: "source-a", expectedStatusVersion: 6, derivativeAttemptId: "derivative-a",
    status: "ACCEPTED", originalContentHash: originalHash,
    generatedObjectKey: "auto-listing/source-derivative/v1/account/job/item/run/source/hash/attempt-1/image.png",
    generatedContentHash: cleanedHash, generatedContentType: "image/png",
    generatedWidth: 24, generatedHeight: 32, generatedSizeBytes: cleanedBytes.length,
    cleanupEvidenceHash,
  };
  const responses = [
    { rows: [{
      parent_plan_id: "plan-parent-a", source_image_analysis_run_id: "analysis-run-derived",
      source_image_intelligence_hash: summary.summaryHash,
      source_image_expected_status_version: 7, source_image_status: "ACCEPTED",
      source_image_summary_hash: summary.summaryHash, source_image_summary: summary,
    }], rowCount: 1 },
    { rows: [{ id: "analysis-run-materialized", expected_status_version: 5 }], rowCount: 1 },
    { rows: [{ id: "analysis-run-root", expected_status_version: 6 }], rowCount: 1 },
  ];
  const loadAttempts = [];
  const queries = [];
  const loader = createActiveMaterializedSourceAssetLoader({
    pool: { async query(sql) { queries.push(sql); return responses.shift(); } },
    repository: { async listAcceptedSourceMaterializationsForPlan() { return [record]; } },
    derivativeRepository: {
      async loadAttempt(input) { loadAttempts.push(input); return derivativeAttempt; },
    },
    storage: { async getObjectBuffer(key) {
      assert.equal(key, derivativeAttempt.generatedObjectKey);
      return Buffer.from(cleanedBytes);
    } },
  });

  const loaded = await loader.loadSourceAsset(request);

  assert.equal(loaded.bytes.equals(cleanedBytes), true);
  assert.equal(loaded.evidenceMode, "CLEANED");
  assert.deepEqual(loadAttempts, [{
    accountId: "account-a", jobId: "job-a", itemId: "item-a", analysisRunId: "analysis-run-root",
    sourceAssetId: "source-a", expectedStatusVersion: 6, derivativeAttemptId: "derivative-a",
  }]);
  assert.match(queries[2], /auto_listing_source_image_derivatives\s+AS\s+derivative/iu);
  assert.match(queries[2], /derivative\.analysis_run_id=lineage\.id/iu);
});

test("loader resolves a V2 CLEANED binding to verified derivative bytes while retaining the logical asset id", async () => {
  const originalBytes = await sharp({
    create: { width: 24, height: 32, channels: 3, background: "#bb2222" },
  }).png().toBuffer();
  const cleanedBytes = await sharp({
    create: { width: 24, height: 32, channels: 3, background: "#cc3333" },
  }).png().toBuffer();
  const originalHash = crypto.createHash("sha256").update(originalBytes).digest("hex");
  const cleanedHash = crypto.createHash("sha256").update(cleanedBytes).digest("hex");
  const cleanupEvidenceHash = H("c");
  const summaryValue = {
    contractVersion: "AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_V2",
    coverageMap: {
      FRONT: { assetIds: ["source-a"], preciseViewpoints: ["FRONT"], tentativeAssetIds: [] },
      COMPLETE_PRODUCT: {
        confirmedFamilyCount: 1, confirmedFamilies: ["FRONT"], requiredFamilyCount: 1,
        prohibitedViews: ["BACK", "LEFT", "RIGHT", "TOP", "BOTTOM", "INTERIOR"],
      },
    },
    factCandidates: [],
    markingDecisions: [{
      sourceAssetId: "source-a", kind: "EXTERNAL_OVERLAY", regions: [],
      decisionMethod: "BACKGROUND_CANVAS_OVERLAY", reasonCodes: ["EXTERNAL_OVERLAY_ASSET_EXCLUDED"],
    }],
    eligibleAssetIds: ["source-a"], excludedAssetIds: [], requiredConfirmations: [],
    symmetryClass: "ASYMMETRIC", reasonCodes: ["AUTO_LISTING_SOURCE_IMAGE_HIDDEN_VIEW_INFERENCE_PROHIBITED"],
    appearanceAssetBindings: [{
      sourceAssetId: "source-a", mode: "CLEANED", effectiveContentHash: cleanedHash,
      derivativeAttemptId: "derivative-a", cleanupEvidenceHash,
    }],
  };
  const summary = { ...summaryValue, summaryHash: digest(summaryValue) };
  const record = accepted({ expectedStatusVersion: 5, contentHash: originalHash, sizeBytes: originalBytes.length });
  delete record.parentPlanId;
  record.owner = { kind: "SOURCE_IMAGE_ANALYSIS", id: "analysis-run-a" };
  record.objectKeyVersion = "SOURCE_V2";
  record.objectKey = buildSourceMaterializationObjectKey(record);
  const derivativeAttempt = {
    accountId: "account-a", jobId: "job-a", itemId: "item-a", analysisRunId: "analysis-run-a",
    sourceAssetId: "source-a", expectedStatusVersion: 5, derivativeAttemptId: "derivative-a",
    status: "ACCEPTED", originalContentHash: originalHash,
    generatedObjectKey: "auto-listing/source-derivative/v1/account/job/item/run/source/hash/attempt-1/image.png",
    generatedContentHash: cleanedHash, generatedContentType: "image/png",
    generatedWidth: 24, generatedHeight: 32, generatedSizeBytes: cleanedBytes.length,
    cleanupEvidenceHash,
  };
  const responses = [
    { rows: [{
      parent_plan_id: "plan-parent-a", source_image_analysis_run_id: "analysis-run-a",
      source_image_intelligence_hash: summary.summaryHash,
      source_image_expected_status_version: 5, source_image_status: "ACCEPTED",
      source_image_summary_hash: summary.summaryHash, source_image_summary: summary,
    }], rowCount: 1 },
    { rows: [{ id: "analysis-run-a", expected_status_version: 5 }], rowCount: 1 },
    { rows: [{ id: "analysis-run-a", expected_status_version: 5 }], rowCount: 1 },
  ];
  const loadAttempts = [];
  const loader = createActiveMaterializedSourceAssetLoader({
    pool: { async query() { return responses.shift(); } },
    repository: { async listAcceptedSourceMaterializationsForPlan() { return [record]; } },
    derivativeRepository: {
      async loadAttempt(input) { loadAttempts.push(input); return derivativeAttempt; },
    },
    storage: { async getObjectBuffer(key) {
      assert.equal(key, derivativeAttempt.generatedObjectKey);
      return Buffer.from(cleanedBytes);
    } },
  });

  const loaded = await loader.loadSourceAsset(request);

  assert.equal(loaded.assetId, "source-a");
  assert.equal(loaded.bytes.equals(cleanedBytes), true);
  assert.equal(loaded.evidenceMode, "CLEANED");
  assert.equal(loaded.derivativeAttemptId, "derivative-a");
  assert.deepEqual(loadAttempts, [{
    accountId: "account-a", jobId: "job-a", itemId: "item-a", analysisRunId: "analysis-run-a",
    sourceAssetId: "source-a", expectedStatusVersion: 5, derivativeAttemptId: "derivative-a",
  }]);
});

test("loader fails closed when CLEANED object bytes differ from the summary binding", async () => {
  const goodBytes = await sharp({
    create: { width: 24, height: 32, channels: 3, background: "#113355" },
  }).png().toBuffer();
  const changedBytes = await sharp({
    create: { width: 24, height: 32, channels: 3, background: "#224466" },
  }).png().toBuffer();
  const goodHash = crypto.createHash("sha256").update(goodBytes).digest("hex");
  const summaryValue = {
    contractVersion: "AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_V2",
    coverageMap: {
      FRONT: { assetIds: ["source-a"], preciseViewpoints: ["FRONT"], tentativeAssetIds: [] },
      COMPLETE_PRODUCT: { confirmedFamilyCount: 1, confirmedFamilies: ["FRONT"], requiredFamilyCount: 1,
        prohibitedViews: ["BACK", "LEFT", "RIGHT", "TOP", "BOTTOM", "INTERIOR"] },
    }, factCandidates: [], markingDecisions: [], eligibleAssetIds: ["source-a"], excludedAssetIds: [],
    requiredConfirmations: [], symmetryClass: "ASYMMETRIC", reasonCodes: [],
    appearanceAssetBindings: [{ sourceAssetId: "source-a", mode: "CLEANED", effectiveContentHash: goodHash,
      derivativeAttemptId: "derivative-a", cleanupEvidenceHash: H("d") }],
  };
  const summary = { ...summaryValue, summaryHash: digest(summaryValue) };
  const record = accepted({ expectedStatusVersion: 5 });
  delete record.parentPlanId;
  record.owner = { kind: "SOURCE_IMAGE_ANALYSIS", id: "analysis-run-a" };
  record.objectKeyVersion = "SOURCE_V2";
  record.objectKey = buildSourceMaterializationObjectKey(record);
  const responses = [
    { rows: [{ parent_plan_id: "plan-parent-a", source_image_analysis_run_id: "analysis-run-a",
      source_image_intelligence_hash: summary.summaryHash, source_image_expected_status_version: 5,
      source_image_status: "ACCEPTED", source_image_summary_hash: summary.summaryHash,
      source_image_summary: summary }], rowCount: 1 },
    { rows: [{ id: "analysis-run-a", expected_status_version: 5 }], rowCount: 1 },
    { rows: [{ id: "analysis-run-a", expected_status_version: 5 }], rowCount: 1 },
  ];
  const loader = createActiveMaterializedSourceAssetLoader({
    pool: { async query() { return responses.shift(); } },
    repository: { async listAcceptedSourceMaterializationsForPlan() { return [record]; } },
    derivativeRepository: { async loadAttempt() { return {
      accountId: "account-a", jobId: "job-a", itemId: "item-a", analysisRunId: "analysis-run-a",
      sourceAssetId: "source-a", expectedStatusVersion: 5, derivativeAttemptId: "derivative-a",
      status: "ACCEPTED", originalContentHash: contentHash,
      generatedObjectKey: "auto-listing/source-derivative/v1/account/job/item/run/source/hash/attempt-1/image.png",
      generatedContentHash: goodHash, generatedContentType: "image/png", generatedWidth: 24,
      generatedHeight: 32, generatedSizeBytes: goodBytes.length, cleanupEvidenceHash: H("d"),
    }; } },
    storage: { async getObjectBuffer() { return Buffer.from(changedBytes); } },
  });

  await assert.rejects(loader.loadSourceAsset(request), {
    code: "AUTO_LISTING_SOURCE_ASSET_LOADER_UNAVAILABLE", retryable: true,
  });
});

test("loader fails closed on cross-scope, stale, duplicate, forged or changed source evidence", async () => {
  const invalidRequests = [
    { ...request, sourceRef: "https://source.invalid/image.png" },
    { ...request, evidenceKind: "SOURCE_URL" },
    { ...request, extra: true },
  ];
  for (const invalidRequest of invalidRequests) {
    let effects = 0;
    const loader = createActiveMaterializedSourceAssetLoader({
      pool: { async query() { effects += 1; } },
      repository: { async listAcceptedSourceMaterializationsForPlan() { effects += 1; } },
      storage: { async getObjectBuffer() { effects += 1; } },
    });
    await assert.rejects(loader.loadSourceAsset(invalidRequest), {
      code: "AUTO_LISTING_SOURCE_ASSET_LOADER_INVALID",
    });
    assert.equal(effects, 0);
  }

  const cases = [
    { rows: [], records: [accepted()], stored: bytes },
    { rows: [{ parent_plan_id: "plan-parent-a" }], records: [accepted(), accepted({ attemptId: "attempt-b" })], stored: bytes },
    { rows: [{ parent_plan_id: "plan-parent-a" }], records: [accepted({ accountId: "account-b" })], stored: bytes },
    { rows: [{ parent_plan_id: "plan-parent-a" }], records: [accepted()], stored: Buffer.from("changed") },
  ];
  for (const candidate of cases) {
    const loader = createActiveMaterializedSourceAssetLoader({
      pool: { async query() { return { rows: candidate.rows, rowCount: candidate.rows.length }; } },
      repository: { async listAcceptedSourceMaterializationsForPlan() { return candidate.records; } },
      storage: { async getObjectBuffer() { return Buffer.from(candidate.stored); } },
    });
    await assert.rejects(
      loader.loadSourceAsset(request),
      (error) => error?.code === "AUTO_LISTING_SOURCE_ASSET_LOADER_UNAVAILABLE"
        && error?.retryable === true && !/source\.invalid|changed/iu.test(error.message),
    );
  }
});
