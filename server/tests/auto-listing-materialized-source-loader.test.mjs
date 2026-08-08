import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { buildSourceMaterializationObjectKey } from "../auto-listing-source-materialization-repository.mjs";
import { createActiveMaterializedSourceAssetLoader } from "../auto-listing-materialized-source-loader.mjs";

const H = (value) => value.repeat(64);
const bytes = Buffer.from("verified-source-image-bytes");
const contentHash = crypto.createHash("sha256").update(bytes).digest("hex");
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
  const record = accepted();
  const loader = createActiveMaterializedSourceAssetLoader({
    pool: {
      async query(sql, values) {
        queries.push([sql, values]);
        return { rows: [{ parent_plan_id: "plan-parent-a" }], rowCount: 1 };
      },
    },
    repository: {
      async listAcceptedSourceMaterializations(input) { lists.push(input); return [record]; },
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
    parentPlanId: "plan-parent-a", expectedStatusVersion: 7,
  }]);
  assert.deepEqual(reads, [[record.objectKey, { maxBytes: 8 * 1024 * 1024 }]]);
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
      repository: { async listAcceptedSourceMaterializations() { effects += 1; } },
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
      repository: { async listAcceptedSourceMaterializations() { return candidate.records; } },
      storage: { async getObjectBuffer() { return Buffer.from(candidate.stored); } },
    });
    await assert.rejects(
      loader.loadSourceAsset(request),
      (error) => error?.code === "AUTO_LISTING_SOURCE_ASSET_LOADER_UNAVAILABLE"
        && error?.retryable === true && !/source\.invalid|changed/iu.test(error.message),
    );
  }
});
