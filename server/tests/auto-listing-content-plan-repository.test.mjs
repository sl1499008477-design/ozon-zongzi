import assert from "node:assert/strict";
import test from "node:test";

import { createPostgresContentPlanRepository } from "../auto-listing-content-plan-repository.mjs";

const HASH = "a".repeat(64);

function sourceReferenceVisualGroups() {
  return {
    sourceHash: "1".repeat(64),
    groups: [{
      visualGroupKey: "group-a",
      sourceSkus: ["sku-a"],
      variantIds: ["variant-a"],
      referenceImages: [{
        assetId: "source-url-a",
        sourceRefHash: "9".repeat(64),
        sourceRef: null,
        contentHash: null,
        evidenceKind: "SOURCE_REF_HASH",
      }],
      factEvidence: [],
      reasonCodes: [],
    }],
    reasonCodes: [],
    visualGroupsHash: "4".repeat(64),
  };
}

function materializedVisualGroups() {
  const capture = structuredClone(sourceReferenceVisualGroups());
  capture.visualGroupsHash = "7".repeat(64);
  capture.groups[0].referenceImages[0] = {
    assetId: "source-url-a",
    sourceRefHash: "9".repeat(64),
    sourceRef: null,
    contentHash: "8".repeat(64),
    evidenceKind: "CONTENT_HASH",
  };
  return capture;
}

function reservation(overrides = {}) {
  return {
    accountId: "account-a",
    jobId: "job-a",
    itemId: "item-a",
    sourceSnapshotId: "snapshot-a",
    planningContract: "LEGACY_FULL_PLAN_V3",
    profileId: "profile-a",
    profileVersion: 3,
    inputHash: HASH,
    expectedStatusVersion: 7,
    requestKey: `auto-listing-plan-${"b".repeat(64)}`,
    ...overrides,
  };
}

function storedPlan(overrides = {}) {
  return {
    ...reservation(),
    reservationToken: "lease-a",
    strategyVersionId: "strategy-a",
    sourceHash: "1".repeat(64),
    strategyHash: "2".repeat(64),
    configHash: "3".repeat(64),
    visualGroupsHash: "4".repeat(64),
    visualGroups: sourceReferenceVisualGroups(),
    factRegistryHash: "598dcbca50857111ad0dc35fa8310ebfd035f5591968baacf2cae6465b3aa54e",
    factRegistry: [{ factId: "fact-a", kind: "IDENTITY_NAME", sourcePath: "identity.name", value: "Товар", visualGroupKeys: [] }],
    plannerModel: "vendor/planner-model",
    promptTemplateVersion: "planner-v1",
    regeneration: null,
    gatewayRequestId: "gateway-request-a",
    plan: { version: 1, language: "ru", slots: [] },
    planHash: "c86329aebeef4e5e13ae4e152f93a2200093c7ab709aadeb32711c88fd4e99a6",
    ...overrides,
  };
}

function derivedPlan(overrides = {}) {
  const base = storedPlan();
  return {
    id: "plan-derived",
    sourceAccountId: base.accountId,
    jobId: base.jobId,
    itemId: base.itemId,
    sourceSnapshotId: base.sourceSnapshotId,
    strategyVersionId: base.strategyVersionId,
    profileId: base.profileId,
    strategyHash: base.strategyHash,
    configHash: base.configHash,
    sourceHash: base.sourceHash,
    inputHash: "6".repeat(64),
    plannerModel: base.plannerModel,
    profileVersion: base.profileVersion,
    promptTemplateVersion: base.promptTemplateVersion,
    plan: base.plan,
    planHash: base.planHash,
    visualGroupsHash: "7".repeat(64),
    visualGroups: materializedVisualGroups(),
    factRegistry: base.factRegistry,
    regeneration: base.regeneration,
    gatewayRequestId: base.gatewayRequestId,
    parentPlanId: "plan-parent",
    derivationKind: "SOURCE_MATERIALIZATION",
    materializationSetHash: "8".repeat(64),
    ...overrides,
  };
}

function scriptedPool(handler) {
  const queries = [];
  let releases = 0;
  const client = {
    async query(text, values = []) {
      queries.push({ text, values });
      return handler(text, values, queries);
    },
    release() { releases += 1; },
  };
  return {
    pool: { async connect() { return client; } },
    queries,
    releases: () => releases,
  };
}

test("repository rejects open, missing, cross-scope, URL-like, and secret-like reservation contracts before SQL", async () => {
  const db = scriptedPool(() => { throw new Error("must not query"); });
  const repository = createPostgresContentPlanRepository({ pool: db.pool });
  for (const input of [
    { ...reservation(), extra: true },
    { ...reservation(), sourceSnapshotId: "" },
    { ...reservation(), requestKey: "https://example.test/secret" },
    { ...reservation(), profileId: "api-key" },
    { ...reservation(), expectedStatusVersion: 0 },
  ]) {
    await assert.rejects(
      repository.reserveContentPlan(input),
      (error) => error?.code === "AUTO_LISTING_CONTENT_PLAN_REPOSITORY_INVALID"
        && error?.message === "图片规划仓储请求无效" && error?.retryable === false,
    );
  }
  assert.equal(db.queries.length, 0);
});

test("save accepts only closed persisted image evidence and rejects SOURCE_URL or URL-like text before SQL", async () => {
  const db = scriptedPool(() => { throw new Error("must not query"); });
  const repository = createPostgresContentPlanRepository({ pool: db.pool });
  const unsafeSourceUrl = structuredClone(storedPlan());
  unsafeSourceUrl.visualGroups.groups[0].referenceImages[0] = {
    assetId: "source-url-a",
    sourceRefHash: null,
    sourceRef: "https://cdn.example.test/product.jpg",
    contentHash: null,
    evidenceKind: "SOURCE_URL",
  };
  const unsafeNestedText = structuredClone(storedPlan());
  unsafeNestedText.visualGroups.groups[0].reasonCodes = ["https://cdn.example.test/product.jpg"];
  const openReference = structuredClone(storedPlan());
  openReference.visualGroups.groups[0].referenceImages[0].extra = true;

  for (const input of [unsafeSourceUrl, unsafeNestedText, openReference]) {
    await assert.rejects(
      repository.saveContentPlan(input),
      (error) => error?.code === "AUTO_LISTING_CONTENT_PLAN_EVIDENCE_CONFLICT"
        && error?.message === "图片规划持久化证据不一致" && error?.retryable === false,
    );
  }
  assert.equal(db.queries.length, 0);
});

test("reserve locks the exact account job item, serializes all planner inputs, uses database time, and returns one fenced lease", async () => {
  const db = scriptedPool((sql) => {
    if (sql === "BEGIN" || sql === "COMMIT") return { rows: [], rowCount: 0 };
    if (/FROM auto_listing_job_items/i.test(sql)) return { rows: [{ id: "item-a", snapshot_id: "snapshot-a", status: "PLANNING", status_version: 7, active_content_plan_id: null, planning_contract: "LEGACY_FULL_PLAN_V3" }], rowCount: 1 };
    if (/UPDATE auto_listing_content_plan_attempts/i.test(sql)) return { rows: [], rowCount: 0 };
    if (/status='ACCEPTED'/i.test(sql)) return { rows: [], rowCount: 0 };
    if (/status='PLANNING'/i.test(sql) && /SELECT/i.test(sql)) return { rows: [], rowCount: 0 };
    if (/MAX\(attempt_no\)/i.test(sql)) return { rows: [{ max_attempt_no: 0 }], rowCount: 1 };
    if (/INSERT INTO auto_listing_content_plan_attempts/i.test(sql)) return { rows: [{ id: "attempt-a" }], rowCount: 1 };
    throw new Error(`unexpected SQL: ${sql}`);
  });
  const repository = createPostgresContentPlanRepository({
    pool: db.pool,
    token: () => "lease-a",
    id: () => "attempt-a",
    leaseOwner: "planner-a",
    leaseMs: 90_000,
  });

  assert.deepEqual(await repository.reserveContentPlan(reservation()), {
    status: "RESERVED",
    attemptNo: 1,
    reservationToken: "lease-a",
    inputHash: HASH,
  });
  const sql = db.queries.map((entry) => entry.text).join("\n");
  assert.match(sql, /WHERE account_id=\$1 AND job_id=\$2 AND id=\$3[\s\S]*FOR UPDATE/i);
  assert.match(sql, /lease_expires_at[\s\S]*NOW\(\) \+ \(\$\d+ \* INTERVAL '1 millisecond'\)/i);
  assert.match(sql, /lease_expires_at <= NOW\(\)/i);
  assert.doesNotMatch(sql, /new Date|Date\.now/i);
  const expireQuery = db.queries.find((entry) => /UPDATE auto_listing_content_plan_attempts/i.test(entry.text));
  const activeQuery = db.queries.find((entry) => /SELECT id(?:,input_hash)? FROM auto_listing_content_plan_attempts/i.test(entry.text));
  assert.doesNotMatch(expireQuery.text, /input_hash=/i, "expired leases from a different planner input must not block this item");
  assert.doesNotMatch(activeQuery.text, /input_hash=/i, "only one live planner lease may exist per item across all inputs");
  const attemptInsert = db.queries.find((entry) => /INSERT INTO auto_listing_content_plan_attempts/i.test(entry.text));
  assert.match(attemptInsert.text, /planning_contract/i);
  assert.equal(attemptInsert.values.includes("LEGACY_FULL_PLAN_V3"), true);
  assert.equal(db.releases(), 1);
});

test("reserve rejects a planning contract that differs from the frozen job item", async () => {
  const db = scriptedPool((sql) => {
    if (sql === "BEGIN" || sql === "ROLLBACK") return { rows: [], rowCount: 0 };
    if (/FROM auto_listing_job_items/i.test(sql)) return { rows: [{
      id: "item-a", snapshot_id: "snapshot-a", status: "PLANNING", status_version: 7,
      active_content_plan_id: null, planning_contract: "FIXED_SKELETON_V1",
    }], rowCount: 1 };
    throw new Error(`unexpected SQL: ${sql}`);
  });
  await assert.rejects(
    createPostgresContentPlanRepository({ pool: db.pool }).reserveContentPlan(reservation()),
    { code: "AUTO_LISTING_CONTENT_PLAN_SCOPE_CONFLICT", retryable: false },
  );
  assert.equal(db.queries.some((entry) => /INSERT INTO auto_listing_content_plan_attempts/i.test(entry.text)), false);
});

test("a live lease for a different planner input blocks a second gateway charge for the same item", async () => {
  const db = scriptedPool((sql) => {
    if (sql === "BEGIN" || sql === "COMMIT") return { rows: [], rowCount: 0 };
    if (/FROM auto_listing_job_items/i.test(sql)) {
      return { rows: [{ id: "item-a", snapshot_id: "snapshot-a", status: "PLANNING", status_version: 7, active_content_plan_id: null, planning_contract: "LEGACY_FULL_PLAN_V3" }], rowCount: 1 };
    }
    if (/UPDATE auto_listing_content_plan_attempts/i.test(sql)) return { rows: [], rowCount: 0 };
    if (/status='ACCEPTED'/i.test(sql)) return { rows: [], rowCount: 0 };
    if (/SELECT id,input_hash FROM auto_listing_content_plan_attempts/i.test(sql)) {
      return { rows: [{ id: "attempt-other", input_hash: "f".repeat(64) }], rowCount: 1 };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  });
  const repository = createPostgresContentPlanRepository({ pool: db.pool });

  assert.deepEqual(await repository.reserveContentPlan(reservation()), { status: "IN_PROGRESS" });
  assert.equal(db.queries.some((entry) => /MAX\(attempt_no\)|INSERT INTO auto_listing_content_plan_attempts/i.test(entry.text)), false);
  assert.equal(db.queries.at(-1).text, "COMMIT");
});

test("save is one transaction that fences scope/version/token, accepts the attempt, and switches active_content_plan_id without selecting latest", async () => {
  const db = scriptedPool((sql, values) => {
    if (sql === "BEGIN" || sql === "COMMIT") return { rows: [], rowCount: 0 };
    if (/FROM auto_listing_job_items/i.test(sql) && /FOR UPDATE/i.test(sql)) {
      return { rows: [{ id: "item-a", snapshot_id: "snapshot-a", status: "PLANNING", status_version: 7, active_content_plan_id: null, planning_contract: "LEGACY_FULL_PLAN_V3" }], rowCount: 1 };
    }
    if (/FROM auto_listing_content_plan_attempts/i.test(sql) && /FOR UPDATE/i.test(sql)) {
      return { rows: [{ id: "attempt-a", attempt_no: 1, status: "PLANNING", lease_token: "lease-a", lease_expires_at: new Date(Date.now() + 60_000), expected_status_version: 7, request_key: reservation().requestKey }], rowCount: 1 };
    }
    if (/INSERT INTO ai_content_plans/i.test(sql)) {
      return { rows: [{ id: values[0], account_id: "account-a", job_id: "job-a", item_id: "item-a", source_snapshot_id: "snapshot-a", strategy_version_id: "strategy-a", profile_id: "profile-a", input_hash: HASH, source_hash: "1".repeat(64), strategy_hash: "2".repeat(64), config_hash: "3".repeat(64), visual_groups_hash: "4".repeat(64), visual_groups: storedPlan().visualGroups, fact_registry_hash: storedPlan().factRegistryHash, fact_registry: storedPlan().factRegistry, planner_model: "vendor/planner-model", profile_version: 3, prompt_template_version: "planner-v1", regeneration: null, gateway_request_id: "gateway-request-a", plan: storedPlan().plan, plan_hash: "c86329aebeef4e5e13ae4e152f93a2200093c7ab709aadeb32711c88fd4e99a6", parent_plan_id: null, derivation_kind: null, materialization_set_hash: null, planning_contract: "LEGACY_FULL_PLAN_V3" }], rowCount: 1 };
    }
    if (/UPDATE auto_listing_content_plan_attempts/i.test(sql)) return { rows: [{ id: "attempt-a" }], rowCount: 1 };
    if (/UPDATE auto_listing_job_items/i.test(sql)) return { rows: [{ id: "item-a" }], rowCount: 1 };
    throw new Error(`unexpected SQL: ${sql}`);
  });
  const repository = createPostgresContentPlanRepository({ pool: db.pool, planId: () => "plan-a" });
  const result = await repository.saveContentPlan(storedPlan());
  assert.equal(result.id, "plan-a");
  assert.equal(result.accountId, "account-a");
  assert.equal(result.planHash, "c86329aebeef4e5e13ae4e152f93a2200093c7ab709aadeb32711c88fd4e99a6");
  const sql = db.queries.map((entry) => entry.text).join("\n");
  assert.match(sql, /status_version=\$\d+/i);
  assert.match(sql, /lease_token=\$\d+[\s\S]*lease_expires_at > NOW\(\)/i);
  assert.match(sql, /SET active_content_plan_id=\$\d+/i);
  assert.doesNotMatch(sql, /ORDER BY[\s\S]*created_at DESC|MAX\(created_at\)|LIMIT 1[\s\S]*ai_content_plans/i);
  assert.ok(db.queries.findIndex((entry) => /INSERT INTO ai_content_plans/i.test(entry.text))
    < db.queries.findIndex((entry) => /SET active_content_plan_id/i.test(entry.text)));
  assert.equal(db.queries.at(-1).text, "COMMIT");
});

test("a stale lease token cannot save after reclaim and causes rollback with a stable conflict", async () => {
  const db = scriptedPool((sql) => {
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [], rowCount: 0 };
    if (/FROM auto_listing_job_items/i.test(sql)) return { rows: [{ id: "item-a", snapshot_id: "snapshot-a", status: "PLANNING", status_version: 7, active_content_plan_id: null, planning_contract: "LEGACY_FULL_PLAN_V3" }], rowCount: 1 };
    if (/FROM auto_listing_content_plan_attempts/i.test(sql)) return { rows: [], rowCount: 0 };
    throw new Error(`unexpected SQL: ${sql}`);
  });
  const repository = createPostgresContentPlanRepository({ pool: db.pool, planId: () => "plan-a" });
  await assert.rejects(
    repository.saveContentPlan(storedPlan({ reservationToken: "stale-token" })),
    (error) => error?.code === "AUTO_LISTING_CONTENT_PLAN_LEASE_CONFLICT"
      && error?.message === "图片规划租约已失效" && error?.retryable === true,
  );
  assert.equal(db.queries.at(-1).text, "ROLLBACK");
  assert.equal(db.queries.some((entry) => /INSERT INTO ai_content_plans/i.test(entry.text)), false);
});

test("loadActiveContentPlan follows the item's explicit active_content_plan_id and never infers latest", async () => {
  const db = scriptedPool((sql) => {
    if (/JOIN ai_content_plans/i.test(sql)) return { rows: [{ id: "plan-active", account_id: "account-a", job_id: "job-a", item_id: "item-a", input_hash: HASH }], rowCount: 1 };
    throw new Error(`unexpected SQL: ${sql}`);
  });
  const repository = createPostgresContentPlanRepository({ pool: db.pool });
  const record = await repository.loadActiveContentPlan({
    accountId: "account-a", jobId: "job-a", itemId: "item-a", expectedStatusVersion: 7,
  });
  assert.equal(record.id, "plan-active");
  const sql = db.queries[0].text;
  assert.match(sql, /p\.id=i\.active_content_plan_id/i);
  assert.doesNotMatch(sql, /ORDER BY|MAX\(|created_at DESC|LIMIT 1/i);
});

test("database failures never expose raw PostgreSQL messages", async () => {
  const db = { pool: { async connect() { throw new Error("password=secret host=production-db"); } } };
  const repository = createPostgresContentPlanRepository({ pool: db.pool });
  await assert.rejects(
    repository.reserveContentPlan(reservation()),
    (error) => error?.code === "AUTO_LISTING_CONTENT_PLAN_REPOSITORY_FAILED"
      && error?.message === "图片规划仓储暂时不可用" && error?.retryable === true
      && !/secret|production-db|password/i.test(error.message),
  );
});

test("createDerivedMaterializedPlan atomically validates the active parent/version and activates the immutable derived plan", async () => {
  const expected = derivedPlan();
  const db = scriptedPool((sql, values) => {
    if (sql === "BEGIN" || sql === "COMMIT") return { rows: [], rowCount: 0 };
    if (/FROM auto_listing_job_items/i.test(sql) && /FOR UPDATE/i.test(sql)) {
      return { rows: [{ id: "item-a", snapshot_id: "snapshot-a", status: "PLANNING", status_version: 7, active_content_plan_id: "plan-parent" }], rowCount: 1 };
    }
    if (/FROM auto_listing_content_plan_derivations/i.test(sql)) return { rows: [], rowCount: 0 };
    if (/FROM ai_content_plans/i.test(sql) && /id=\$4/i.test(sql)) {
      const parent = storedPlan({ id: "plan-parent" });
      return { rows: [{
        ...Object.fromEntries(Object.entries(parent).map(([key, value]) => [key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`), value])),
        fact_registry: parent.factRegistry,
        fact_registry_hash: parent.factRegistryHash,
        parent_plan_id: null,
        derivation_kind: null,
        materialization_set_hash: null,
      }], rowCount: 1 };
    }
    if (/INSERT INTO ai_content_plans/i.test(sql)) {
      return { rows: [{ id: expected.id }], rowCount: 1 };
    }
    if (/INSERT INTO auto_listing_content_plan_derivations/i.test(sql)) return { rows: [{ id: values[0] }], rowCount: 1 };
    if (/UPDATE auto_listing_job_items/i.test(sql)) return { rows: [{ id: "item-a" }], rowCount: 1 };
    throw new Error(`unexpected SQL: ${sql}`);
  });
  const repository = createPostgresContentPlanRepository({ pool: db.pool, derivationId: () => "derivation-a" });
  const result = await repository.createDerivedMaterializedPlan({
    scope: { accountId: "account-a", jobId: "job-a", itemId: "item-a", parentPlanId: "plan-parent", expectedStatusVersion: 7 },
    derivedPlan: expected,
  });
  assert.deepEqual(result, expected);
  const sql = db.queries.map((entry) => entry.text).join("\n");
  assert.match(sql, /active_content_plan_id=\$4/i);
  assert.match(sql, /status_version=\$\d+/i);
  assert.match(sql, /active_content_plan_id=\$\d+/i);
  assert.ok(db.queries.findIndex((entry) => /INSERT INTO ai_content_plans/i.test(entry.text))
    < db.queries.findIndex((entry) => /UPDATE auto_listing_job_items/i.test(entry.text)));
  assert.equal(db.queries.at(-1).text, "COMMIT");
});

test("createDerivedMaterializedPlan rejects stale/cancelled/cross-parent commands before inserting anything", async () => {
  for (const row of [
    { id: "item-a", snapshot_id: "snapshot-a", status: "CANCELLED", status_version: 7, active_content_plan_id: "plan-parent" },
    { id: "item-a", snapshot_id: "snapshot-a", status: "PLANNING", status_version: 8, active_content_plan_id: "plan-parent" },
    { id: "item-a", snapshot_id: "snapshot-a", status: "PLANNING", status_version: 7, active_content_plan_id: "other-parent" },
  ]) {
    const db = scriptedPool((sql) => {
      if (sql === "BEGIN" || sql === "ROLLBACK") return { rows: [], rowCount: 0 };
      if (/FROM auto_listing_job_items/i.test(sql)) return { rows: [row], rowCount: 1 };
      if (/FROM auto_listing_content_plan_derivations/i.test(sql)) return { rows: [], rowCount: 0 };
      throw new Error(`unexpected SQL: ${sql}`);
    });
    const repository = createPostgresContentPlanRepository({ pool: db.pool });
    await assert.rejects(repository.createDerivedMaterializedPlan({
      scope: { accountId: "account-a", jobId: "job-a", itemId: "item-a", parentPlanId: "plan-parent", expectedStatusVersion: 7 },
      derivedPlan: derivedPlan(),
    }), (error) => ["AUTO_LISTING_CONTENT_PLAN_STATUS_VERSION_CONFLICT", "AUTO_LISTING_CONTENT_PLAN_EVIDENCE_CONFLICT"].includes(error?.code));
    assert.equal(db.queries.some((entry) => /INSERT INTO/i.test(entry.text)), false);
  }
});

test("createDerivedMaterializedPlan replays the same active derivation without a second insert", async () => {
  const expected = derivedPlan();
  const db = scriptedPool((sql) => {
    if (sql === "BEGIN" || sql === "COMMIT") return { rows: [], rowCount: 0 };
    if (/FROM auto_listing_job_items/i.test(sql)) {
      return { rows: [{ id: "item-a", snapshot_id: "snapshot-a", status: "PLANNING", status_version: 7, active_content_plan_id: expected.id }], rowCount: 1 };
    }
    if (/FROM auto_listing_content_plan_derivations/i.test(sql)) {
      return { rows: [{
        derived_plan_id: expected.id, id: expected.id, account_id: "account-a", job_id: "job-a", item_id: "item-a",
        source_snapshot_id: expected.sourceSnapshotId, strategy_version_id: expected.strategyVersionId,
        profile_id: expected.profileId, strategy_hash: expected.strategyHash, config_hash: expected.configHash,
        source_hash: expected.sourceHash, input_hash: expected.inputHash, planner_model: expected.plannerModel,
        profile_version: expected.profileVersion, prompt_template_version: expected.promptTemplateVersion,
        plan: expected.plan, plan_hash: expected.planHash, visual_groups_hash: expected.visualGroupsHash,
        visual_groups: expected.visualGroups, fact_registry_hash: storedPlan().factRegistryHash,
        fact_registry: expected.factRegistry, regeneration: expected.regeneration,
        gateway_request_id: expected.gatewayRequestId, parent_plan_id: expected.parentPlanId,
        derivation_kind: expected.derivationKind, materialization_set_hash: expected.materializationSetHash,
      }], rowCount: 1 };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  });
  const repository = createPostgresContentPlanRepository({ pool: db.pool });
  const command = {
    scope: { accountId: "account-a", jobId: "job-a", itemId: "item-a", parentPlanId: "plan-parent", expectedStatusVersion: 7 },
    derivedPlan: expected,
  };
  assert.deepEqual(await repository.createDerivedMaterializedPlan(command), expected);
  assert.equal(db.queries.some((entry) => /INSERT INTO/i.test(entry.text)), false);
  assert.equal(db.queries.at(-1).text, "COMMIT");
});

test("derived replay revalidates the complete immutable row instead of trusting matching identity hashes", async () => {
  const expected = derivedPlan();
  const db = scriptedPool((sql) => {
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [], rowCount: 0 };
    if (/FROM auto_listing_job_items/i.test(sql)) {
      return { rows: [{ id: "item-a", snapshot_id: "snapshot-a", status: "PLANNING", status_version: 7, active_content_plan_id: expected.id }], rowCount: 1 };
    }
    if (/FROM auto_listing_content_plan_derivations/i.test(sql)) {
      return { rows: [{
        derived_plan_id: expected.id,
        id: expected.id,
        account_id: "account-a",
        job_id: "job-a",
        item_id: "item-a",
        source_snapshot_id: expected.sourceSnapshotId,
        strategy_version_id: expected.strategyVersionId,
        profile_id: expected.profileId,
        strategy_hash: expected.strategyHash,
        config_hash: expected.configHash,
        source_hash: expected.sourceHash,
        input_hash: expected.inputHash,
        planner_model: "corrupt-model",
        profile_version: expected.profileVersion,
        prompt_template_version: expected.promptTemplateVersion,
        plan: expected.plan,
        plan_hash: expected.planHash,
        visual_groups_hash: expected.visualGroupsHash,
        visual_groups: expected.visualGroups,
        fact_registry_hash: storedPlan().factRegistryHash,
        fact_registry: expected.factRegistry,
        regeneration: expected.regeneration,
        gateway_request_id: expected.gatewayRequestId,
        parent_plan_id: expected.parentPlanId,
        derivation_kind: expected.derivationKind,
        materialization_set_hash: expected.materializationSetHash,
      }], rowCount: 1 };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  });
  const repository = createPostgresContentPlanRepository({ pool: db.pool });
  await assert.rejects(repository.createDerivedMaterializedPlan({
    scope: { accountId: "account-a", jobId: "job-a", itemId: "item-a", parentPlanId: "plan-parent", expectedStatusVersion: 7 },
    derivedPlan: expected,
  }), (error) => error?.code === "AUTO_LISTING_CONTENT_PLAN_EVIDENCE_CONFLICT");
  assert.equal(db.queries.some((entry) => /INSERT INTO/i.test(entry.text)), false);
});
