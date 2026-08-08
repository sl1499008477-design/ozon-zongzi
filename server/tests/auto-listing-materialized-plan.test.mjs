import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { buildSourceAssetObjectKey } from "../auto-listing-source-asset-store.mjs";
import { buildSourceMaterializationInput } from "../auto-listing-source-materializer.mjs";

const moduleUnderTest = () => import(`../auto-listing-materialized-plan.mjs?test=${Date.now()}-${Math.random()}`);
const H = (value) => value.repeat(64);
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort(compareText).map((key) => [key, canonical(value[key])])) : value;
const compareText = (left, right) => Buffer.from(String(left), "utf8").compare(Buffer.from(String(right), "utf8"));
const hash = (value) => crypto.createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");

const scope = Object.freeze({
  accountId: "account-a", jobId: "job-a", itemId: "item-a", parentPlanId: "plan-parent", expectedStatusVersion: 7,
});

function source(assetId, suffix) {
  return { assetId, sourceRefHash: crypto.createHash("sha256").update(`https://cdn.example.test/${suffix}.png?signature=private`).digest("hex"), contentHash: null, sourceRef: null, evidenceKind: "SOURCE_REF_HASH" };
}

function content(assetId, digit) {
  return { assetId, sourceRefHash: null, contentHash: H(digit), sourceRef: null, evidenceKind: "CONTENT_HASH" };
}

function parentPlan() {
  const sourceA = source("source-url-a", "a");
  const sourceB = source("source-url-b", "b");
  const groups = [
    {
      visualGroupKey: "group-a", sourceSkus: ["sku-a"], variantIds: ["variant-a"],
      referenceImages: [sourceA, content("source-content-a", "8")],
      factEvidence: [{ factId: "fact.color", kind: "COLOR", value: "красный" }],
      reasonCodes: ["COMPLETE_APPEARANCE_EVIDENCE"],
    },
    {
      visualGroupKey: "group-b", sourceSkus: ["sku-b"], variantIds: ["variant-b"],
      referenceImages: [sourceB],
      factEvidence: [{ factId: "fact.material", kind: "MATERIAL", value: "сталь" }],
      reasonCodes: ["VISIBLE_APPEARANCE_DIFFERENCE"],
    },
  ];
  const visualBase = { sourceHash: H("a"), groups, reasonCodes: ["COMPLETE_APPEARANCE_EVIDENCE", "VISIBLE_APPEARANCE_DIFFERENCE"] };
  const visualGroups = { ...visualBase, visualGroupsHash: hash(visualBase) };
  const plan = {
    version: 1, language: "ru",
    slots: [
      { slotKey: "group-a:main:01", visualGroupKey: "group-a", role: "MAIN", order: 1, textDensity: "NONE", claims: [], sourceFactIds: ["fact.color"], referenceAssetIds: ["source-url-a", "source-content-a"], preserve: ["красный"], prohibitedClaims: [] },
      { slotKey: "group-b:main:01", visualGroupKey: "group-b", role: "MAIN", order: 1, textDensity: "NONE", claims: [], sourceFactIds: ["fact.material"], referenceAssetIds: ["source-url-b"], preserve: ["сталь"], prohibitedClaims: [] },
    ],
  };
  return {
    id: scope.parentPlanId, sourceAccountId: scope.accountId, jobId: scope.jobId, itemId: scope.itemId,
    sourceSnapshotId: "snapshot-a", strategyVersionId: "strategy-v1", profileId: "profile-a",
    strategyHash: H("b"), configHash: H("c"), sourceHash: H("a"), inputHash: H("d"),
    plannerModel: "planner-model", profileVersion: 3, promptTemplateVersion: "planner-v1",
    plan, planHash: hash(plan), visualGroupsHash: visualGroups.visualGroupsHash, visualGroups,
    factRegistry: [
      { factId: "fact.color", field: "variant.color", kind: "COLOR", value: "красный", numericValue: null, unit: null, sourcePath: "variants[0].color", visualGroupKeys: ["group-a"] },
      { factId: "fact.material", field: "attributes.material", kind: "MATERIAL", value: "сталь", numericValue: null, unit: null, sourcePath: "attributes.material", visualGroupKeys: ["group-b"] },
    ],
    regeneration: null, gatewayRequestId: "gateway-request-a",
  };
}

function accepted(parent, assetId, digit, attemptNo = 1) {
  const materializationInput = buildSourceMaterializationInput({
    scope: { ...scope, sourceAssetId: assetId },
    parentPlan: parent,
  });
  const record = {
    accountId: scope.accountId, jobId: scope.jobId, itemId: scope.itemId, parentPlanId: scope.parentPlanId,
    sourceAssetId: assetId, sourceRefHash: materializationInput.sourceRefHash, inputHash: materializationInput.inputHash,
    expectedStatusVersion: scope.expectedStatusVersion, attemptId: `attempt-${assetId}`, attemptNo,
    status: "ACCEPTED", leaseOwner: null, leaseToken: null, leaseExpiresAt: null,
    objectKeyVersion: "SOURCE_V1", objectKey: "", contentHash: H(digit), contentType: "image/png",
    width: 900, height: 1200, sizeBytes: 1234, acceptedAt: "2026-08-04T00:00:00.000Z",
    errorCode: null, errorRetryable: null, createdAt: "2026-08-04T00:00:00.000Z", updatedAt: "2026-08-04T00:00:00.000Z",
  };
  record.objectKey = buildSourceAssetObjectKey(record);
  return record;
}

function records(parent = parentPlan()) {
  return [accepted(parent, "source-url-b", "2"), accepted(parent, "source-url-a", "1")];
}

test("builds one deterministic immutable derived plan and changes only materialized source evidence and derivation identities", async () => {
  const { buildMaterializedPlan } = await moduleUnderTest();
  const parent = parentPlan();
  const before = structuredClone(parent);
  const first = buildMaterializedPlan({ scope, parentPlan: parent, acceptedMaterializations: records(parent) });
  const second = buildMaterializedPlan({ scope: { ...scope }, parentPlan: structuredClone(parent), acceptedMaterializations: records(parent).reverse() });
  assert.deepEqual(first, second, "repository row order must not alter the derived identity");
  assert.deepEqual(parent, before, "the parent must remain byte-for-byte unchanged");
  assert.equal(first.parentPlanId, parent.id);
  assert.equal(first.derivationKind, "SOURCE_MATERIALIZATION");
  assert.match(first.id, /^auto-listing-materialized-[a-f0-9]{40}$/u);
  for (const field of ["sourceSnapshotId", "strategyVersionId", "profileId", "strategyHash", "configHash", "sourceHash", "plannerModel", "profileVersion", "promptTemplateVersion", "plan", "planHash", "factRegistry", "regeneration", "gatewayRequestId"]) {
    assert.deepEqual(first[field], parent[field], field);
  }
  assert.equal(first.visualGroups.groups[0].referenceImages[1].contentHash, H("8"), "existing CONTENT_HASH evidence must not change");
  assert.equal(first.visualGroups.groups.flatMap((group) => group.referenceImages).some((entry) => entry.evidenceKind === "SOURCE_REF_HASH"), false);
  for (const entry of first.visualGroups.groups.flatMap((group) => group.referenceImages)) {
    assert.deepEqual(Object.keys(entry).sort(), ["assetId", "sourceRefHash", "contentHash", "evidenceKind", "sourceRef"].sort());
    assert.equal(entry.evidenceKind, "CONTENT_HASH");
    assert.equal(entry.sourceRef, null);
  }
  assert.match(first.visualGroups.groups[0].referenceImages[0].sourceRefHash, /^[a-f0-9]{64}$/u);
  assert.equal(first.visualGroups.groups[0].referenceImages[1].sourceRefHash, null);
  assert.equal(first.planHash, parent.planHash);
  assert.deepEqual(first.plan.slots, parent.plan.slots);
  assert.deepEqual(first.visualGroups.groups.map((group) => ({ key: group.visualGroupKey, facts: group.factEvidence, assets: group.referenceImages.map((asset) => asset.assetId) })),
    parent.visualGroups.groups.map((group) => ({ key: group.visualGroupKey, facts: group.factEvidence, assets: group.referenceImages.map((asset) => asset.assetId) })));
  for (const field of ["visualGroupsHash", "materializationSetHash", "inputHash"]) assert.match(first[field], /^[a-f0-9]{64}$/u);
  assert.notEqual(first.visualGroupsHash, parent.visualGroupsHash);
  assert.notEqual(first.inputHash, parent.inputHash);
});

test("requires exactly one complete ACCEPTED SOURCE_V1 record per unique SOURCE_REF_HASH and rejects missing, extra and duplicate evidence", async () => {
  const { buildMaterializedPlan } = await moduleUnderTest();
  const parent = parentPlan();
  const complete = records(parent);
  for (const candidate of [
    complete.slice(0, 1),
    [...complete, { ...accepted(parent, "source-url-a", "1"), attemptId: "attempt-duplicate" }],
    [...complete, { ...complete[0], sourceAssetId: "source-extra", attemptId: "attempt-extra" }],
    complete.map((record, index) => index ? record : { ...record, status: "STORED" }),
    complete.map((record, index) => index ? record : { ...record, objectKeyVersion: "LEGACY_V1" }),
  ]) {
    assert.throws(() => buildMaterializedPlan({ scope, parentPlan: parent, acceptedMaterializations: candidate }), { code: "AUTO_LISTING_MATERIALIZED_PLAN_EVIDENCE_INVALID" });
  }
});

test("rejects cross-account, cross-job, cross-item and cross-parent materializations", async () => {
  const { buildMaterializedPlan } = await moduleUnderTest();
  const parent = parentPlan();
  for (const mutation of [
    { accountId: "account-b" }, { jobId: "job-b" }, { itemId: "item-b" }, { parentPlanId: "plan-b" },
  ]) {
    const candidate = records(parent);
    Object.assign(candidate[0], mutation);
    assert.throws(() => buildMaterializedPlan({ scope, parentPlan: parent, acceptedMaterializations: candidate }), { code: "AUTO_LISTING_MATERIALIZED_PLAN_EVIDENCE_INVALID" });
  }
});

test("binds sourceRefHash, content hash, dimensions, MIME and exact SOURCE_V1 object key", async () => {
  const { buildMaterializedPlan } = await moduleUnderTest();
  const parent = parentPlan();
  const mutations = [
    (record) => { record.sourceRefHash = H("f"); },
    (record) => { record.contentHash = H("f"); },
    (record) => { record.objectKey += "?secret=x"; },
    (record) => { record.contentType = "image/gif"; },
    (record) => { record.width = 0; },
    (record) => { record.sizeBytes = 8 * 1024 * 1024 + 1; },
    (record) => { record.acceptedAt = null; },
    (record) => { record.errorCode = "RAW_DATABASE_ERROR"; },
    (record) => { record.unexpected = true; },
  ];
  for (const mutate of mutations) {
    const candidate = records(parent); mutate(candidate[0]);
    assert.throws(() => buildMaterializedPlan({ scope, parentPlan: parent, acceptedMaterializations: candidate }), { code: "AUTO_LISTING_MATERIALIZED_PLAN_EVIDENCE_INVALID" });
  }
});

test("rejects a SOURCE_V1 record whose input hash does not bind the exact parent, source, policy and status version", async () => {
  const { buildMaterializedPlan } = await moduleUnderTest();
  const parent = parentPlan();
  const candidate = records(parent);
  candidate[0].inputHash = H("e");
  candidate[0].objectKey = buildSourceAssetObjectKey(candidate[0]);
  assert.throws(
    () => buildMaterializedPlan({ scope, parentPlan: parent, acceptedMaterializations: candidate }),
    { code: "AUTO_LISTING_MATERIALIZED_PLAN_EVIDENCE_INVALID" },
  );
});

test("rejects malformed, already-derived, cross-scope or forged parent plans and closed-scope extras", async () => {
  const { buildMaterializedPlan } = await moduleUnderTest();
  const base = parentPlan();
  const mutations = [
    (parent) => { parent.sourceAccountId = "account-b"; },
    (parent) => { parent.planHash = H("f"); },
    (parent) => { parent.plan.extra = true; parent.planHash = hash(parent.plan); },
    (parent) => { parent.plan.slots[0].extra = true; parent.planHash = hash(parent.plan); },
    (parent) => { parent.visualGroupsHash = H("f"); },
    (parent) => { parent.visualGroups.groups[0].referenceImages[0].assetId = "other"; },
    (parent) => { parent.factRegistry[0].apiKey = "forbidden"; },
    (parent) => { parent.parentPlanId = "prior"; },
    (parent) => { parent.extra = true; },
  ];
  for (const mutate of mutations) {
    const parent = structuredClone(base); mutate(parent);
    assert.throws(() => buildMaterializedPlan({ scope, parentPlan: parent, acceptedMaterializations: records(base) }), { code: "AUTO_LISTING_MATERIALIZED_PLAN_INPUT_INVALID" });
  }
  assert.throws(() => buildMaterializedPlan({ scope: { ...scope, extra: true }, parentPlan: base, acceptedMaterializations: records(base) }), { code: "AUTO_LISTING_MATERIALIZED_PLAN_INPUT_INVALID" });
});

test("rejects a parent whose asset id carries conflicting SOURCE_REF_HASH and CONTENT_HASH evidence", async () => {
  const { buildMaterializedPlan } = await moduleUnderTest();
  const parent = parentPlan();
  const duplicateId = parent.visualGroups.groups[0].referenceImages[1].assetId;
  parent.visualGroups.groups[1].referenceImages[0].assetId = duplicateId;
  parent.plan.slots[1].referenceAssetIds = [duplicateId];
  const visualBase = {
    sourceHash: parent.visualGroups.sourceHash,
    groups: parent.visualGroups.groups,
    reasonCodes: parent.visualGroups.reasonCodes,
  };
  parent.visualGroups.visualGroupsHash = hash(visualBase);
  parent.visualGroupsHash = parent.visualGroups.visualGroupsHash;
  parent.planHash = hash(parent.plan);
  assert.throws(
    () => buildMaterializedPlan({ scope, parentPlan: parent, acceptedMaterializations: [] }),
    { code: "AUTO_LISTING_MATERIALIZED_PLAN_INPUT_INVALID" },
  );
});

test("rejects unsafe identifiers, invalid UTF-8 byte limits and unknown top-level keys before repository access", async () => {
  const { finalizeMaterializedPlan } = await moduleUnderTest();
  for (const accountId of ["https://private.test/?token=x", "account-api-key-secret", "密".repeat(81)]) {
    let calls = 0;
    await assert.rejects(finalizeMaterializedPlan({
      scope: { ...scope, accountId }, parentPlan: { ...parentPlan(), sourceAccountId: accountId },
      repository: { async listAcceptedSourceMaterializations() { calls += 1; }, async createDerivedMaterializedPlan() { calls += 1; } },
    }), { code: "AUTO_LISTING_MATERIALIZED_PLAN_INPUT_INVALID" });
    assert.equal(calls, 0);
  }
  await assert.rejects(finalizeMaterializedPlan({ scope, parentPlan: parentPlan(), repository: {}, downloader: {}, gateway: {}, storage: {} }), { code: "AUTO_LISTING_MATERIALIZED_PLAN_INPUT_INVALID" });
});

test("finalizer uses only scoped materialization and idempotent derived-plan repository ports", async () => {
  const { finalizeMaterializedPlan } = await moduleUnderTest();
  const parent = parentPlan();
  let listCalls = 0; let writes = 0; const stored = new Map();
  const repository = {
    async listAcceptedSourceMaterializations(input) {
      listCalls += 1;
      assert.deepEqual(input, {
        accountId: scope.accountId,
        jobId: scope.jobId,
        itemId: scope.itemId,
        parentPlanId: scope.parentPlanId,
        expectedStatusVersion: scope.expectedStatusVersion,
      });
      return records(parent);
    },
    async createDerivedMaterializedPlan(command) {
      assert.deepEqual(command.scope, scope);
      assert.deepEqual(Object.keys(command).sort(), ["derivedPlan", "scope"]);
      const input = command.derivedPlan;
      const existing = stored.get(input.inputHash);
      if (existing) return existing;
      writes += 1; stored.set(input.inputHash, structuredClone(input)); return structuredClone(input);
    },
  };
  const first = await finalizeMaterializedPlan({ scope, parentPlan: parent, repository });
  const second = await finalizeMaterializedPlan({ scope, parentPlan: structuredClone(parent), repository });
  assert.deepEqual(second, first);
  assert.equal(listCalls, 2);
  assert.equal(writes, 1, "repeat delivery must create zero additional plan writes");
});

test("repository failures and forged returns are converted to stable safe errors without raw causes", async () => {
  const { finalizeMaterializedPlan } = await moduleUnderTest();
  const parent = parentPlan();
  const raw = new Error("postgres://user:password@host database secret");
  for (const repository of [
    { async listAcceptedSourceMaterializations() { throw raw; }, async createDerivedMaterializedPlan() {} },
    { async listAcceptedSourceMaterializations() { return records(parent); }, async createDerivedMaterializedPlan() { throw raw; } },
  ]) {
    await assert.rejects(finalizeMaterializedPlan({ scope, parentPlan: parent, repository }), (error) => error?.code === "AUTO_LISTING_MATERIALIZED_PLAN_REPOSITORY_FAILED"
      && error?.retryable === true && !/postgres|password|secret|host/iu.test(error.message) && !error.cause);
  }
  await assert.rejects(finalizeMaterializedPlan({
    scope, parentPlan: parent,
    repository: {
      async listAcceptedSourceMaterializations() { return records(parent); },
      async createDerivedMaterializedPlan(input) { return { ...input, accountId: "account-b" }; },
    },
  }), { code: "AUTO_LISTING_MATERIALIZED_PLAN_REPOSITORY_CONFLICT" });
});

test("pure derivation performs no AI, download or storage work", async () => {
  const { finalizeMaterializedPlan } = await moduleUnderTest();
  const parent = parentPlan(); let forbidden = 0;
  const forbiddenPort = new Proxy({}, { get() { forbidden += 1; throw new Error("external port used"); } });
  const result = await finalizeMaterializedPlan({
    scope, parentPlan: parent,
    repository: {
      async listAcceptedSourceMaterializations() { return records(parent); },
      async createDerivedMaterializedPlan(command) { return structuredClone(command.derivedPlan); },
    },
  });
  void forbiddenPort;
  assert.equal(result.derivationKind, "SOURCE_MATERIALIZATION");
  assert.equal(forbidden, 0);
});
