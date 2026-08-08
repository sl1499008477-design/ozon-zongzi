import assert from "node:assert/strict";
import test from "node:test";
import { orchestrateAutoListingAiPhase } from "../auto-listing-ai-orchestrator.mjs";

const H = (digit = "a") => digit.repeat(64);
const services = (overrides = {}) => ({
  planContent: async () => ({ id: "plan-parent", accountId: "account-a", jobId: "job-a", itemId: "item-a" }),
  materializeSourceAsset: async () => ({
    status: "ACCEPTED", accountId: "account-a", jobId: "job-a", itemId: "item-a",
    parentPlanId: "plan-parent", sourceAssetId: "source-a",
  }),
  finalizeMaterializedPlan: async () => derivedPlan(),
  generateImageSlot: async () => ({
    status: "ACCEPTED", accountId: "account-a", jobId: "job-a", itemId: "item-a",
    planId: "plan-derived", slotKey: "main-1", role: "MAIN",
  }),
  generateRichContent: async () => ({
    status: "ACCEPTED", accountId: "account-a", jobId: "job-a", itemId: "item-a", planId: "plan-derived",
  }),
  ...overrides,
});

function message(phase, overrides = {}) {
  return {
    contractVersion: "V1",
    accountId: "account-a",
    itemId: "item-a",
    phase,
    expectedStatusVersion: 7,
    correlationId: "correlation-a",
    ...(phase === "MATERIALIZE_SOURCE_ASSET" ? { sourceAssetId: "source-a" } : {}),
    ...(phase === "GENERATE_IMAGE_SLOT" ? { slotKey: "main-1" } : {}),
    ...overrides,
  };
}

const slot = (slotKey = "main-1", role = "MAIN", order = 1) => ({
  slotKey, visualGroupKey: "group-a", role, order,
});

function parentPlan() {
  return {
    id: "plan-parent", sourceAccountId: "account-a", jobId: "job-a", itemId: "item-a",
  };
}

function derivedPlan() {
  const slots = [
    slot(), slot("selling-1", "SELLING_POINT", 2), slot("selling-2", "SELLING_POINT", 3),
    slot("detail-1", "DETAIL", 4), slot("scene-1", "SCENE", 5), slot("info-1", "INFOGRAPHIC", 6),
  ];
  return {
    id: "plan-derived", sourceAccountId: "account-a", jobId: "job-a", itemId: "item-a",
    parentPlanId: "plan-parent", derivationKind: "SOURCE_MATERIALIZATION", materializationSetHash: H("b"),
    planHash: H("e"), sourceHash: H("f"),
    plan: { slots },
    visualGroups: {
      groups: [{
        visualGroupKey: "group-a",
        referenceImages: [{
          assetId: "source-a", evidenceKind: "CONTENT_HASH", contentHash: H("c"), sourceRefHash: H("d"), sourceRef: null,
        }],
      }],
    },
  };
}

function acceptedAssets() {
  return derivedPlan().plan.slots.map((entry, index) => ({
    id: `asset-${index + 1}`, status: "ACCEPTED",
    accountId: "account-a", jobId: "job-a", itemId: "item-a", planId: "plan-derived",
    slotKey: entry.slotKey, visualGroupKey: entry.visualGroupKey, role: entry.role,
  }));
}

function phaseInput(phase) {
  const parent = parentPlan();
  const plan = derivedPlan();
  const inert = Object.freeze({});
  if (phase === "PLAN_CONTENT") return {
    sourceSnapshotId: "snapshot-a", gatewayProfile: inert, gateway: inert, repository: inert,
    sourceCapture: inert, strategyCapture: inert, configCapture: inert, visualGroupsCapture: inert,
    promptTemplateVersion: "planner-v1", prohibitedClaims: [], regeneration: null,
  };
  if (phase === "MATERIALIZE_SOURCE_ASSET") return {
    parentPlan: parent, sourceSnapshot: inert, policy: undefined, repository: inert,
    downloader: inert, storage: inert, logger: null,
  };
  if (phase === "FINALIZE_MATERIALIZED_PLAN") return { parentPlan: parent, repository: inert };
  if (phase === "GENERATE_IMAGE_SLOT") return {
    plan, slot: plan.plan.slots[0], sourceAssetLoader: inert, repository: inert, gateway: inert,
    profile: inert, imageModel: "image-model", ratio: "3:4", resolution: "1K", size: "768x1024",
    quality: "medium", templateVersion: "image-v1", regeneration: null, storage: inert, logger: null, maxAttempts: 3,
  };
  return {
    plan, profile: inert, gateway: inert, repository: inert, factRegistry: [], acceptedAssets: acceptedAssets(),
    planHash: H("e"), sourceHash: H("f"), promptTemplateVersion: "rich-v1", maxAttempts: 3,
    leaseOwner: "rich-worker",
  };
}

function context(phase, overrides = {}) {
  return {
    accountId: "account-a", jobId: "job-a", itemId: "item-a",
    status: ["GENERATE_IMAGE_SLOT", "GENERATE_RICH_CONTENT"].includes(phase) ? "GENERATING" : "PLANNING",
    statusVersion: 7,
    activeContentPlanId: phase === "PLAN_CONTENT" ? null
      : ["MATERIALIZE_SOURCE_ASSET", "FINALIZE_MATERIALIZED_PLAN"].includes(phase) ? "plan-parent" : "plan-derived",
    phaseInput: phaseInput(phase),
    ...overrides,
  };
}

test("ACKs a stale closed V1 message without reading phase input or calling a phase service", async () => {
  let calls = 0;
  const outcome = await orchestrateAutoListingAiPhase({
    message: {
      contractVersion: "V1",
      accountId: "account-a",
      itemId: "item-a",
      phase: "PLAN_CONTENT",
      expectedStatusVersion: 7,
      correlationId: "correlation-a",
    },
    context: {
      accountId: "account-a",
      jobId: "job-a",
      itemId: "item-a",
      status: "PLANNING",
      statusVersion: 8,
      activeContentPlanId: null,
      get phaseInput() { throw new Error("phase input must not be read"); },
    },
  }, {
    planContent: async () => { calls += 1; },
    materializeSourceAsset: async () => { calls += 1; },
    finalizeMaterializedPlan: async () => { calls += 1; },
    generateImageSlot: async () => { calls += 1; },
    generateRichContent: async () => { calls += 1; },
  });

  assert.equal(calls, 0);
  assert.deepEqual(outcome, {
    contractVersion: "V1",
    disposition: "ACK",
    phase: "PLAN_CONTENT",
    outcome: "STALE",
    retryable: false,
    failureCode: "AUTO_LISTING_AI_STATUS_STALE",
    correlationId: "correlation-a",
  });
  assert.ok(Object.isFrozen(outcome));
});

test("ACKs CANCELLED and a phase/status mismatch before reading phase input or dependencies", async () => {
  for (const status of ["CANCELLED", "READY_FOR_REVIEW"]) {
    const input = {
      message: message("GENERATE_RICH_CONTENT"),
      context: {
        accountId: "account-a", jobId: "job-a", itemId: "item-a", status,
        statusVersion: 7, activeContentPlanId: "plan-derived",
        get phaseInput() { throw new Error("phase input must not be read"); },
      },
    };
    const outcome = await orchestrateAutoListingAiPhase(input, new Proxy({}, {
      ownKeys() { throw new Error("dependencies must not be read"); },
    }));
    assert.equal(outcome.disposition, "ACK");
    assert.equal(outcome.outcome, status === "CANCELLED" ? "CANCELLED" : "STALE");
    assert.equal(outcome.failureCode, status === "CANCELLED"
      ? "AUTO_LISTING_AI_ITEM_CANCELLED" : "AUTO_LISTING_AI_STATUS_STALE");
  }
});

test("routes every phase exactly once with only server-loaded scope and returns stable safe outcomes", async () => {
  const cases = [
    ["PLAN_CONTENT", "planContent", "PLAN_READY"],
    ["MATERIALIZE_SOURCE_ASSET", "materializeSourceAsset", "SOURCE_ASSET_ACCEPTED"],
    ["FINALIZE_MATERIALIZED_PLAN", "finalizeMaterializedPlan", "MATERIALIZED_PLAN_READY"],
    ["GENERATE_IMAGE_SLOT", "generateImageSlot", "IMAGE_SLOT_ACCEPTED"],
    ["GENERATE_RICH_CONTENT", "generateRichContent", "CONTENT_READY_FOR_REVIEW"],
  ];
  for (const [phase, serviceName, expectedOutcome] of cases) {
    const calls = [];
    const configured = services({
      [serviceName]: async (value) => {
        calls.push(value);
        if (phase === "PLAN_CONTENT") return { id: "plan-parent", accountId: "account-a", jobId: "job-a", itemId: "item-a", prompt: "must-not-leak" };
        if (phase === "MATERIALIZE_SOURCE_ASSET") return { status: "ACCEPTED", accountId: "account-a", jobId: "job-a", itemId: "item-a", parentPlanId: "plan-parent", sourceAssetId: "source-a", objectKey: "must-not-leak" };
        if (phase === "FINALIZE_MATERIALIZED_PLAN") return { ...derivedPlan(), sourceRef: "https://must-not-leak.invalid" };
        if (phase === "GENERATE_IMAGE_SLOT") return { status: "ACCEPTED", accountId: "account-a", jobId: "job-a", itemId: "item-a", planId: "plan-derived", slotKey: "main-1", role: "MAIN", objectKey: "must-not-leak" };
        return { status: "ACCEPTED", accountId: "account-a", jobId: "job-a", itemId: "item-a", planId: "plan-derived", rawResponse: "must-not-leak" };
      },
    });
    const outcome = await orchestrateAutoListingAiPhase({ message: message(phase), context: context(phase) }, configured);
    assert.equal(calls.length, 1);
    assert.equal(outcome.outcome, expectedOutcome);
    assert.equal(outcome.disposition, "ACK");
    assert.equal(outcome.failureCode, null);
    assert.ok(Object.isFrozen(outcome));
    assert.doesNotMatch(JSON.stringify(outcome), /must-not-leak|https?:|prompt|objectKey|rawResponse/u);

    const forwarded = calls[0];
    if (phase === "PLAN_CONTENT") {
      assert.equal(forwarded.accountId, "account-a");
      assert.equal(forwarded.jobId, "job-a");
      assert.equal(forwarded.itemId, "item-a");
      assert.equal(forwarded.expectedStatusVersion, 7);
      assert.equal(forwarded.correlationId, "correlation-a");
    } else if (["MATERIALIZE_SOURCE_ASSET", "FINALIZE_MATERIALIZED_PLAN"].includes(phase)) {
      assert.deepEqual(forwarded.scope, {
        accountId: "account-a", jobId: "job-a", itemId: "item-a", parentPlanId: "plan-parent",
        ...(phase === "MATERIALIZE_SOURCE_ASSET" ? { sourceAssetId: "source-a" } : {}),
        expectedStatusVersion: 7,
      });
    } else if (phase === "GENERATE_IMAGE_SLOT") {
      assert.deepEqual(forwarded.scope, {
        accountId: "account-a", jobId: "job-a", itemId: "item-a", planId: "plan-derived",
        visualGroupKey: "group-a", slotKey: "main-1", expectedStatusVersion: 7,
      });
      assert.equal(forwarded.correlationId, "correlation-a");
    } else {
      assert.equal(forwarded.accountId, "account-a");
      assert.equal(forwarded.jobId, "job-a");
      assert.equal(forwarded.itemId, "item-a");
      assert.equal(forwarded.planId, "plan-derived");
      assert.equal(forwarded.correlationId, "correlation-a");
    }
  }
});

test("fails closed on extra context, phase-input or dependency keys and on cross-scope identities", async () => {
  let calls = 0;
  const configured = services({ planContent: async () => { calls += 1; } });
  const candidates = [
    [{ message: message("PLAN_CONTENT"), context: { ...context("PLAN_CONTENT"), latestPlan: "plan-latest" } }, configured],
    [{ message: message("PLAN_CONTENT"), context: { ...context("PLAN_CONTENT"), phaseInput: { ...phaseInput("PLAN_CONTENT"), rawPrompt: "hidden" } } }, configured],
    [{ message: message("PLAN_CONTENT"), context: context("PLAN_CONTENT"), extra: true }, configured],
    [{ message: message("PLAN_CONTENT"), context: { ...context("PLAN_CONTENT"), accountId: "account-b" } }, configured],
    [{ message: message("PLAN_CONTENT"), context: context("PLAN_CONTENT") }, { ...configured, latestPlanLoader: async () => null }],
  ];
  for (const [input, dependencies] of candidates) {
    await assert.rejects(
      orchestrateAutoListingAiPhase(input, dependencies),
      (error) => error?.code === "AUTO_LISTING_AI_ORCHESTRATOR_INPUT_INVALID"
        && error?.retryable === false && !/hidden|rawPrompt/u.test(error?.message || ""),
    );
  }
  assert.equal(calls, 0);
});

test("rejects active phase-input accessors and non-enumerable service fields without invoking them", async () => {
  let reads = 0;
  let calls = 0;
  const accessorInput = phaseInput("PLAN_CONTENT");
  Object.defineProperty(accessorInput, "gateway", {
    enumerable: true,
    get() { reads += 1; return {}; },
  });
  await assert.rejects(orchestrateAutoListingAiPhase({
    message: message("PLAN_CONTENT"),
    context: context("PLAN_CONTENT", { phaseInput: accessorInput }),
  }, services({ planContent: async () => { calls += 1; } })), { code: "AUTO_LISTING_AI_ORCHESTRATOR_INPUT_INVALID" });

  const hiddenServices = services({ planContent: async () => { calls += 1; } });
  Object.defineProperty(hiddenServices, "planContent", {
    enumerable: false,
    value: hiddenServices.planContent,
  });
  await assert.rejects(orchestrateAutoListingAiPhase({
    message: message("PLAN_CONTENT"), context: context("PLAN_CONTENT"),
  }, hiddenServices), { code: "AUTO_LISTING_AI_ORCHESTRATOR_INPUT_INVALID" });
  assert.equal(reads, 0);
  assert.equal(calls, 0);
});

test("uses only activeContentPlanId and rejects parent/latest or non-materialized plans before service calls", async () => {
  let calls = 0;
  const configured = services({ generateImageSlot: async () => { calls += 1; } });
  const wrongActive = context("GENERATE_IMAGE_SLOT", { activeContentPlanId: "plan-other" });
  const parentOnly = context("GENERATE_IMAGE_SLOT", {
    activeContentPlanId: "plan-parent",
    phaseInput: { ...phaseInput("GENERATE_IMAGE_SLOT"), plan: parentPlan() },
  });
  const sourceUrlPlan = derivedPlan();
  sourceUrlPlan.visualGroups.groups[0].referenceImages[0] = {
    assetId: "source-a", evidenceKind: "SOURCE_REF_HASH", sourceRefHash: H("d"), contentHash: null, sourceRef: null,
  };
  const notFullyMaterialized = context("GENERATE_IMAGE_SLOT", {
    phaseInput: { ...phaseInput("GENERATE_IMAGE_SLOT"), plan: sourceUrlPlan },
  });
  for (const current of [wrongActive, parentOnly, notFullyMaterialized]) {
    await assert.rejects(
      orchestrateAutoListingAiPhase({ message: message("GENERATE_IMAGE_SLOT"), context: current }, configured),
      { code: "AUTO_LISTING_AI_ORCHESTRATOR_INPUT_INVALID" },
    );
  }
  assert.equal(calls, 0);
});

test("requires rich content to use one final materialized plan and a complete accepted set with MAIN and at least six slots", async () => {
  let calls = 0;
  const configured = services({ generateRichContent: async () => { calls += 1; } });
  const base = phaseInput("GENERATE_RICH_CONTENT");
  const candidates = [
    { ...base, acceptedAssets: base.acceptedAssets.slice(0, 5) },
    { ...base, acceptedAssets: base.acceptedAssets.map((asset) => asset.role === "MAIN" ? { ...asset, role: "DETAIL" } : asset) },
    { ...base, acceptedAssets: base.acceptedAssets.map((asset, index) => index ? asset : { ...asset, status: "FAILED" }) },
    { ...base, acceptedAssets: base.acceptedAssets.map((asset, index) => index ? asset : { ...asset, planId: "plan-other" }) },
  ];
  for (const invalid of candidates) {
    await assert.rejects(orchestrateAutoListingAiPhase({
      message: message("GENERATE_RICH_CONTENT"),
      context: context("GENERATE_RICH_CONTENT", { phaseInput: invalid }),
    }, configured), { code: "AUTO_LISTING_AI_ORCHESTRATOR_INPUT_INVALID" });
  }
  assert.equal(calls, 0);
});

test("generates one independently scoped rich-content document per visual group", async () => {
  const plan = derivedPlan();
  const secondSlots = [
    slot("group-b-main", "MAIN", 7), slot("group-b-selling-1", "SELLING_POINT", 8),
    slot("group-b-selling-2", "SELLING_POINT", 9), slot("group-b-detail", "DETAIL", 10),
    slot("group-b-scene", "SCENE", 11), slot("group-b-info", "INFOGRAPHIC", 12),
  ].map((entry) => ({ ...entry, visualGroupKey: "group-b" }));
  plan.plan.slots.push(...secondSlots);
  plan.visualGroups.groups.push({
    visualGroupKey: "group-b",
    referenceImages: [{
      assetId: "source-b", evidenceKind: "CONTENT_HASH", contentHash: H("7"), sourceRefHash: H("8"), sourceRef: null,
    }],
  });
  const assets = plan.plan.slots.map((entry, index) => ({
    id: `multi-asset-${index}`, status: "ACCEPTED",
    accountId: "account-a", jobId: "job-a", itemId: "item-a", planId: "plan-derived",
    slotKey: entry.slotKey, visualGroupKey: entry.visualGroupKey, role: entry.role,
  }));
  const calls = [];
  const result = await orchestrateAutoListingAiPhase({
    message: message("GENERATE_RICH_CONTENT"),
    context: context("GENERATE_RICH_CONTENT", {
      phaseInput: { ...phaseInput("GENERATE_RICH_CONTENT"), plan, acceptedAssets: assets },
    }),
  }, services({ generateRichContent: async (input) => {
    calls.push(input);
    assert.equal(new Set(input.acceptedAssets.map((asset) => asset.visualGroupKey)).size, 1);
    return {
      status: "ACCEPTED", accountId: input.accountId, jobId: input.jobId, itemId: input.itemId,
      planId: input.planId,
    };
  } }));
  assert.equal(result.outcome, "CONTENT_READY_FOR_REVIEW");
  assert.deepEqual(calls.map((call) => call.visualGroupKey).sort(), ["group-a", "group-b"]);
  assert.deepEqual(calls.map((call) => call.acceptedAssets.length), [6, 6]);
});

test("maps final MAIN and minimum-six outcomes without touching accepted siblings or adding a checker phase", async () => {
  const cases = [
    ["BLOCKED", "FAIL", "BLOCKED", "AUTO_LISTING_MAIN_IMAGE_REQUIRED"],
    ["CONTINUE_WITHOUT_SLOT", "ACK", "IMAGE_SLOT_SKIPPED", "AUTO_LISTING_IMAGE_POLICY_REJECTED"],
    ["ITEM_INCOMPLETE", "FAIL", "ITEM_INCOMPLETE", "AUTO_LISTING_MINIMUM_IMAGE_COUNT_NOT_MET"],
  ];
  for (const [itemOutcome, disposition, expectedOutcome, expectedCode] of cases) {
    const error = new Error("raw https://gateway.invalid response with secret");
    error.code = "AUTO_LISTING_IMAGE_POLICY_REJECTED";
    error.retryable = false;
    error.itemOutcome = itemOutcome;
    let calls = 0;
    const outcome = await orchestrateAutoListingAiPhase({
      message: message("GENERATE_IMAGE_SLOT"), context: context("GENERATE_IMAGE_SLOT"),
    }, services({ generateImageSlot: async (input) => {
      calls += 1;
      assert.equal(input.slot.slotKey, "main-1");
      throw error;
    } }));
    assert.equal(calls, 1, "only the target slot service may run");
    assert.equal(outcome.disposition, disposition);
    assert.equal(outcome.outcome, expectedOutcome);
    assert.equal(outcome.failureCode, expectedCode);
    assert.doesNotMatch(JSON.stringify(outcome), /gateway|secret|https?:/u);
  }
});

test("maps known retryable failures and unknown raw failures to fixed safe outcomes", async () => {
  const known = new Error("raw database details");
  known.code = "AUTO_LISTING_RICH_CONTENT_REPOSITORY_FAILED";
  known.retryable = true;
  const unknown = new Error("password=do-not-leak https://private.invalid");
  const forgedStableLooking = new Error("must not select an unregistered code");
  forgedStableLooking.code = "AUTO_LISTING_DATABASE_PASSWORD";
  for (const [error, disposition, failureCode] of [
    [known, "RETRY", "AUTO_LISTING_RICH_CONTENT_REPOSITORY_FAILED"],
    [unknown, "FAIL", "AUTO_LISTING_RICH_CONTENT_FAILED"],
    [forgedStableLooking, "FAIL", "AUTO_LISTING_RICH_CONTENT_FAILED"],
  ]) {
    const outcome = await orchestrateAutoListingAiPhase({
      message: message("GENERATE_RICH_CONTENT"), context: context("GENERATE_RICH_CONTENT"),
    }, services({ generateRichContent: async () => { throw error; } }));
    assert.equal(outcome.disposition, disposition);
    assert.equal(outcome.outcome, "FAILED");
    assert.equal(outcome.failureCode, failureCode);
    assert.doesNotMatch(JSON.stringify(outcome), /password|private|database details|https?:/u);
  }
});

test("maps materializer stale, cancelled and in-progress replays without leaking service data", async () => {
  const cases = [
    ["AUTO_LISTING_SOURCE_MATERIALIZATION_STALE", "ACK", "STALE", false],
    ["AUTO_LISTING_SOURCE_MATERIALIZATION_CANCELLED", "ACK", "CANCELLED", false],
    ["AUTO_LISTING_SOURCE_MATERIALIZATION_IN_PROGRESS", "RETRY", "IN_PROGRESS", true],
  ];
  for (const [reasonCode, disposition, expectedOutcome, retryable] of cases) {
    const outcome = await orchestrateAutoListingAiPhase({
      message: message("MATERIALIZE_SOURCE_ASSET"), context: context("MATERIALIZE_SOURCE_ASSET"),
    }, services({ materializeSourceAsset: async () => ({ status: "SKIPPED", reasonCode, sourceUrl: "https://must-not-leak.invalid" }) }));
    assert.equal(outcome.disposition, disposition);
    assert.equal(outcome.outcome, expectedOutcome);
    assert.equal(outcome.retryable, retryable);
    assert.equal(outcome.failureCode, reasonCode);
    assert.doesNotMatch(JSON.stringify(outcome), /must-not-leak|https?:/u);
  }
});

test("ACKs materialization/finalization duplicates after the active plan was already switched to the derived plan", async () => {
  let calls = 0;
  const configured = services({
    materializeSourceAsset: async () => { calls += 1; },
    finalizeMaterializedPlan: async () => { calls += 1; },
  });
  for (const phase of ["MATERIALIZE_SOURCE_ASSET", "FINALIZE_MATERIALIZED_PLAN"]) {
    const current = context(phase, {
      activeContentPlanId: "plan-derived",
      phaseInput: phase === "MATERIALIZE_SOURCE_ASSET"
        ? { ...phaseInput(phase), parentPlan: derivedPlan() }
        : { ...phaseInput(phase), parentPlan: derivedPlan() },
    });
    const result = await orchestrateAutoListingAiPhase({ message: message(phase), context: current }, configured);
    assert.equal(result.disposition, "ACK");
    assert.equal(result.outcome, phase === "FINALIZE_MATERIALIZED_PLAN" ? "MATERIALIZED_PLAN_READY" : "STALE");
  }
  assert.equal(calls, 0);
});
