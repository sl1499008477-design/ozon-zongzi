import assert from "node:assert/strict";
import crypto from "node:crypto";
import sharp from "sharp";
import test from "node:test";

import {
  checkImageGroup,
  evaluateImageGroupEvidence,
} from "../auto-listing-image-group-checker.mjs";
import { createMemoryImageGroupCheckRepository } from "../auto-listing-image-group-check-repository.mjs";
import { SOURCE_IMAGE_INTELLIGENCE_CONTRACT_VERSION } from "../auto-listing-source-image-intelligence-contract.mjs";

const canonical = (value) => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
    : value;
const digest = (value) => crypto.createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");

const roles = ["MAIN", "SELLING_POINT", "INFOGRAPHIC", "SCENE", "DETAIL", "SPECIFICATION"];
const slotKeys = ["main-1", "selling-1", "infographic-1", "scene-1", "detail-1", "specification-1"];

function intelligence(views) {
  const coverageMap = Object.fromEntries(views.map((view) => [view, {
    assetIds: [`source-${view.toLowerCase()}`], preciseViewpoints: [view], tentativeAssetIds: [],
  }]));
  const completeViews = ["FRONT", "BACK", "LEFT", "RIGHT", "TOP", "BOTTOM", "INTERIOR"];
  coverageMap.COMPLETE_PRODUCT = {
    confirmedFamilyCount: views.length,
    confirmedFamilies: [...views],
    requiredFamilyCount: Math.min(views.length, 3),
    prohibitedViews: completeViews.filter((view) => !views.includes(view)),
  };
  const value = {
    contractVersion: SOURCE_IMAGE_INTELLIGENCE_CONTRACT_VERSION,
    coverageMap,
    factCandidates: [],
    markingDecisions: [],
    eligibleAssetIds: views.map((view) => `source-${view.toLowerCase()}`),
    excludedAssetIds: [],
    requiredConfirmations: [],
    symmetryClass: "ASYMMETRIC",
    reasonCodes: [],
  };
  return { ...value, summaryHash: digest(value) };
}

function planWithTargets(targets = ["FRONT", "BACK", "RIGHT", "FRONT", "BACK", "RIGHT"]) {
  const slots = slotKeys.map((slotKey, index) => ({
    slotKey,
    visualGroupKey: "group-a",
    role: roles[index],
    order: index + 1,
    targetView: targets[index],
    evidenceMode: "DIRECT",
    referenceAssetIds: [`source-${targets[index].toLowerCase()}`],
    sourceFactIds: [],
    prohibitedViews: [],
    identityAssetId: "source-front",
    selectionReasonCodes: ["TARGET_VIEW_CONFIRMED"],
  }));
  return {
    id: "plan-a",
    sourceAccountId: "account-a",
    jobId: "job-a",
    itemId: "item-a",
    sourceImageAnalysisRunId: "run-a",
    sourceImageIntelligenceHash: "1".repeat(64),
    planHash: "2".repeat(64),
    plan: { version: 3, slots },
    visualGroups: { groups: [{ visualGroupKey: "group-a" }] },
  };
}

function acceptedAssets(plan = planWithTargets()) {
  return plan.plan.slots.map((slot, index) => {
    const bytes = Buffer.from(`generated-${slot.slotKey}`);
    return ({
    id: `asset-${index + 1}`,
    status: "ACCEPTED",
    accountId: "account-a",
    jobId: "job-a",
    itemId: "item-a",
    planId: "plan-a",
    visualGroupKey: slot.visualGroupKey,
    slotKey: slot.slotKey,
    role: slot.role,
    contentHash: crypto.createHash("sha256").update(bytes).digest("hex"),
    contentType: "image/png",
    width: 768,
    height: 1024,
    size: bytes.length,
    bytes,
    checkerEvidence: {
      generatedHash: crypto.createHash("sha256").update(bytes).digest("hex"),
      checkerResult: { evidence: {
        targetViewMatched: true,
        prohibitedViewVisible: false,
        intrinsicMarkingsPreserved: true,
        externalOverlayDetected: false,
        unsupportedFactIds: [],
      } },
    },
    });
  });
}

function acceptedAssetsWithBytes(plan, bytes, {
  contentType = "image/png", width = 1_400, height = 1_400,
} = {}) {
  const contentHash = crypto.createHash("sha256").update(bytes).digest("hex");
  return acceptedAssets(plan).map((asset) => ({
    ...asset,
    bytes,
    contentHash,
    contentType,
    width,
    height,
    size: bytes.length,
    checkerEvidence: { ...asset.checkerEvidence, generatedHash: contentHash },
  }));
}

function groupEvidence(overrides = {}) {
  const problems = new Set([
    ...(overrides.duplicateSlotKeys || []),
    ...(overrides.viewMismatchSlotKeys || []),
    ...(overrides.identityMismatchSlotKeys || []),
  ]);
  return {
    acceptedSlotKeys: slotKeys.filter((slotKey) => !problems.has(slotKey)),
    duplicateSlotKeys: [],
    viewMismatchSlotKeys: [],
    identityMismatchSlotKeys: [],
    reasonCodes: [],
    ...overrides,
  };
}

function directV1RequestInput(plan, assets, summary) {
  const assetsBySlot = new Map(assets.map((asset) => [asset.slotKey, asset]));
  return {
    contractVersion: "AUTO_LISTING_IMAGE_GROUP_CHECK_V1",
    planId: plan.id,
    planHash: plan.planHash,
    visualGroupKey: "group-a",
    sourceImageAnalysisRunId: plan.sourceImageAnalysisRunId,
    sourceImageIntelligenceHash: summary.summaryHash,
    sourceCoverage: {
      confirmedFamilies: [...summary.coverageMap.COMPLETE_PRODUCT.confirmedFamilies],
      confirmedFamilyCount: summary.coverageMap.COMPLETE_PRODUCT.confirmedFamilyCount,
      requiredFamilyCount: summary.coverageMap.COMPLETE_PRODUCT.requiredFamilyCount,
      prohibitedViews: [...summary.coverageMap.COMPLETE_PRODUCT.prohibitedViews],
    },
    slots: plan.plan.slots.map((slot, index) => {
      const asset = assetsBySlot.get(slot.slotKey);
      const evidence = asset.checkerEvidence.checkerResult.evidence;
      return {
        imageOrdinal: index + 1,
        slotKey: slot.slotKey,
        role: slot.role,
        targetView: slot.targetView,
        evidenceMode: slot.evidenceMode,
        referenceAssetIds: [...slot.referenceAssetIds],
        sourceFactIds: [...slot.sourceFactIds],
        prohibitedViews: [...slot.prohibitedViews],
        identityAssetId: slot.identityAssetId,
        selectionReasonCodes: [...slot.selectionReasonCodes],
        acceptedAsset: {
          contentHash: asset.contentHash,
          contentType: asset.contentType,
          width: asset.width,
          height: asset.height,
          size: asset.size,
        },
        singleImageEvidence: {
          targetViewMatched: evidence.targetViewMatched,
          prohibitedViewVisible: evidence.prohibitedViewVisible,
          intrinsicMarkingsPreserved: evidence.intrinsicMarkingsPreserved,
          externalOverlayDetected: evidence.externalOverlayDetected,
          unsupportedFactIds: [...evidence.unsupportedFactIds].sort(),
        },
      };
    }),
  };
}

test("three-view evidence retries only duplicate or view-mismatched slots", () => {
  const plan = planWithTargets();
  const summary = intelligence(["FRONT", "BACK", "RIGHT"]);
  plan.sourceImageIntelligenceHash = summary.summaryHash;
  const result = evaluateImageGroupEvidence({
    plan,
    generatedAssets: acceptedAssets(plan),
    sourceImageIntelligence: summary,
    checkerEvidence: groupEvidence({
      duplicateSlotKeys: ["selling-1"],
      viewMismatchSlotKeys: ["infographic-1"],
      reasonCodes: ["IMAGE_GROUP_DUPLICATE_VIEW", "IMAGE_GROUP_VIEW_MISMATCH"],
    }),
  });

  assert.deepEqual(result.acceptedSlotKeys, ["detail-1", "main-1", "scene-1", "specification-1"]);
  assert.deepEqual(result.retrySlotKeys, ["infographic-1", "selling-1"]);
  assert.equal(result.accepted, false);
  assert.deepEqual(Object.keys(result).sort(), [
    "accepted", "acceptedSlotKeys", "duplicateSlotKeys", "identityMismatchSlotKeys",
    "reasonCodes", "retrySlotKeys", "viewMismatchSlotKeys",
  ].sort());
});

test("one slot may carry multiple group issues but appears only once in retrySlotKeys", () => {
  const plan = planWithTargets();
  const summary = intelligence(["FRONT", "BACK", "RIGHT"]);
  plan.sourceImageIntelligenceHash = summary.summaryHash;

  const result = evaluateImageGroupEvidence({
    plan,
    generatedAssets: acceptedAssets(plan),
    sourceImageIntelligence: summary,
    checkerEvidence: groupEvidence({
      duplicateSlotKeys: ["selling-1"],
      viewMismatchSlotKeys: ["selling-1"],
      identityMismatchSlotKeys: ["selling-1"],
      reasonCodes: [
        "IMAGE_GROUP_DUPLICATE_VIEW",
        "IMAGE_GROUP_VIEW_MISMATCH",
        "IMAGE_GROUP_IDENTITY_MISMATCH",
      ],
    }),
  });

  assert.deepEqual(result.retrySlotKeys, ["selling-1"]);
  assert.deepEqual(result.duplicateSlotKeys, ["selling-1"]);
  assert.deepEqual(result.viewMismatchSlotKeys, ["selling-1"]);
  assert.deepEqual(result.identityMismatchSlotKeys, ["selling-1"]);
});

test("bounded synthetic targets can satisfy three-angle coverage without demanding a hidden back view", () => {
  const plan = planWithTargets([
    "FRONT", "FRONT_LEFT_3_4", "FRONT_RIGHT_3_4", "FRONT", "DETAIL", "FRONT_LEFT_3_4",
  ]);
  const summary = intelligence(["FRONT"]);
  plan.sourceImageIntelligenceHash = summary.summaryHash;
  plan.plan.slots.forEach((slot, index) => {
    slot.evidenceMode = index === 0 ? "DIRECT" : index === 4 ? "SUBSTITUTED" : "SYNTHESIZED_SAFE";
    slot.prohibitedViews = ["BACK", "TOP", "BOTTOM", "INTERIOR", "HIDDEN_PORTS"];
  });
  const result = evaluateImageGroupEvidence({
    plan,
    generatedAssets: acceptedAssets(plan),
    sourceImageIntelligence: summary,
    checkerEvidence: groupEvidence(),
  });

  assert.equal(result.accepted, true);
  assert.deepEqual(result.retrySlotKeys, []);
  assert.equal(result.reasonCodes.includes("BACK_VIEW_MISSING"), false);
});

test("an optional skipped plan slot is excluded from the accepted group contract", () => {
  const plan = planWithTargets();
  plan.plan.slots.push({
    ...plan.plan.slots.at(-1),
    slotKey: "optional-detail-2",
    order: 7,
  });
  const summary = intelligence(["FRONT", "BACK", "RIGHT"]);
  plan.sourceImageIntelligenceHash = summary.summaryHash;

  const result = evaluateImageGroupEvidence({
    plan,
    generatedAssets: acceptedAssets(plan).filter(({ slotKey }) => slotKey !== "optional-detail-2"),
    sourceImageIntelligence: summary,
    checkerEvidence: groupEvidence(),
  });

  assert.equal(result.accepted, true);
  assert.deepEqual(result.acceptedSlotKeys, [...slotKeys].sort());
});

test("group input rejects cross-account assets and unbound single-image evidence", () => {
  const plan = planWithTargets();
  const summary = intelligence(["FRONT", "BACK", "RIGHT"]);
  plan.sourceImageIntelligenceHash = summary.summaryHash;
  for (const mutate of [
    (assets) => { assets[0].accountId = "account-b"; },
    (assets) => { assets[0].checkerEvidence.generatedHash = "f".repeat(64); },
    (assets) => { assets[0].checkerEvidence.checkerResult.evidence.targetViewMatched = "yes"; },
  ]) {
    const assets = acceptedAssets(plan);
    mutate(assets);
    assert.throws(() => evaluateImageGroupEvidence({
      plan,
      generatedAssets: assets,
      sourceImageIntelligence: summary,
      checkerEvidence: groupEvidence(),
    }), { code: "AUTO_LISTING_IMAGE_GROUP_CHECK_INPUT_INVALID", retryable: false });
  }
});

test("group reason codes are complete, issue-bound, and absent for an accepted group", () => {
  const plan = planWithTargets();
  const summary = intelligence(["FRONT", "BACK", "RIGHT"]);
  plan.sourceImageIntelligenceHash = summary.summaryHash;
  const input = {
    plan,
    generatedAssets: acceptedAssets(plan),
    sourceImageIntelligence: summary,
  };
  for (const checkerEvidence of [
    groupEvidence({ reasonCodes: ["IMAGE_GROUP_DUPLICATE_VIEW"] }),
    groupEvidence({ duplicateSlotKeys: ["selling-1"] }),
    groupEvidence({
      duplicateSlotKeys: ["selling-1"],
      reasonCodes: ["IMAGE_GROUP_IDENTITY_MISMATCH"],
    }),
  ]) {
    assert.throws(() => evaluateImageGroupEvidence({ ...input, checkerEvidence }), {
      code: "AUTO_LISTING_IMAGE_GROUP_CHECK_INPUT_INVALID",
    });
  }

  const identityResult = evaluateImageGroupEvidence({
    ...input,
    checkerEvidence: groupEvidence({
      identityMismatchSlotKeys: ["detail-1"],
      reasonCodes: ["IMAGE_GROUP_UNSUPPORTED_STRUCTURE"],
    }),
  });
  assert.deepEqual(identityResult.retrySlotKeys, ["detail-1"]);
});

test("a persisted accepted input replays without another paid group-check call", async (t) => {
  const plan = planWithTargets();
  const summary = intelligence(["FRONT", "BACK", "RIGHT"]);
  plan.sourceImageIntelligenceHash = summary.summaryHash;
  const generatedAssets = acceptedAssets(plan);
  const repository = createMemoryImageGroupCheckRepository({
    id: () => "image-group-check-a",
    now: () => new Date("2026-08-30T00:00:00.000Z"),
  });
  let gatewayCalls = 0;
  let checkerSchema = null;
  const gateway = {
    async inspectImage(request) {
      gatewayCalls += 1;
      checkerSchema = request.jsonSchema;
      assert.equal(request.sourceImages.length, 5);
      assert.equal(request.image.bytes.equals(Buffer.from("generated-main-1")), true);
      assert.equal(request.sourceImages[0].bytes.equals(Buffer.from("generated-selling-1")), true);
      assert.match(request.prompt, /"imageOrdinal":1/u);
      assert.match(request.prompt, /相同商品姿态.*仍然属于重复/u);
      assert.match(request.prompt, /至少包含 3 种不同的完整商品视角/u);
      assert.match(request.prompt, /完整外轮廓和全部主要部件.*局部裁切.*不能计入/u);
      assert.match(request.prompt, /商品自身正面为基准.*FRONT_LEFT_3_4.*正面与左侧面.*FRONT_RIGHT_3_4.*正面与右侧面/u);
      assert.match(request.prompt, /背景、文案、裁切或标签布局.*不能算作新视角/u);
      assert.match(request.prompt, /只列出必须重做的最小槽位集合/u);
      assert.match(request.prompt, /保留 MAIN 和最符合 targetView 的 DIRECT 代表/u);
      assert.doesNotMatch(request.prompt, /objectKey|raw OCR|https?:/iu);
      return {
        requestId: "group-check-request-a",
        modelEvidence: {
          requestedTextModel: "checker-model",
          gatewayReportedTextModel: "checker-model",
          gatewayReportedTextModelPresent: true,
        },
        value: groupEvidence(),
      };
    },
  };
  const input = {
    scope: {
      accountId: "account-a", jobId: "job-a", itemId: "item-a", planId: "plan-a",
      visualGroupKey: "group-a", expectedStatusVersion: 7,
    },
    plan,
    generatedAssets,
    sourceImageIntelligence: summary,
    repository,
    gateway,
    profile: {
      id: "profile-a", accountId: "account-a", configVersion: 3,
      baseUrl: "https://gateway.invalid/v1", apiKeyEnvName: "ACCOUNT_A_AI_KEY",
      textProtocol: "SUB2API_RESPONSES", imageProtocol: "SUB2API_RESPONSES_IMAGE_TOOL",
      textModel: "checker-model", imageModel: "image-model", enabled: true,
      connectionId: "connection-a", connectionVersion: 4,
    },
    gatewayExecution: {
      channelId: "channel-a", connectionId: "connection-a", connectionVersion: 4, idleTimeoutMs: 300_000,
    },
    assertLeaseActive() {},
  };

  const first = await checkImageGroup(input);
  const replay = await checkImageGroup(input);

  assert.equal(first.status, "ACCEPTED");
  assert.deepEqual(replay, first);
  assert.equal(gatewayCalls, 1);
  assert.doesNotMatch(JSON.stringify(checkerSchema), /"uniqueItems"|"oneOf"|"allOf"/u);
  for (const key of [
    "acceptedSlotKeys", "duplicateSlotKeys", "viewMismatchSlotKeys", "identityMismatchSlotKeys",
  ]) {
    assert.deepEqual(checkerSchema.properties[key].items.enum, slotKeys);
  }
  await assert.rejects(checkImageGroup({
    ...input,
    profile: { ...input.profile, accountId: "account-b" },
  }), { code: "AUTO_LISTING_IMAGE_GROUP_CHECK_INPUT_INVALID", retryable: false });
  assert.equal(gatewayCalls, 1, "a cross-account profile must fail before a paid call");
  const persisted = await repository.loadOutcome({
    ...input.scope,
    sourceImageAnalysisRunId: "run-a",
    inputHash: first.inputHash,
  });
  assert.equal(persisted.gatewayRequestId, "group-check-request-a");
  assert.deepEqual(persisted.gatewayConnection, { id: "connection-a", version: 4 });

  const corruptions = [
    ["incomplete accepted/retry slot coverage", (record) => {
      record.result = {
        ...record.result,
        acceptedSlotKeys: ["main-1"],
      };
      record.resultHash = digest(record.result);
    }],
    ["forged result hash", (record) => { record.resultHash = "f".repeat(64); }],
    ["different model evidence", (record) => {
      record.modelEvidence = {
        requestedTextModel: "other-model",
        gatewayReportedTextModel: "other-model",
        gatewayReportedTextModelPresent: true,
      };
    }],
    ["different gateway connection", (record) => {
      record.gatewayConnection = { id: "connection-b", version: 5 };
    }],
  ];
  for (const [name, mutate] of corruptions) {
    await t.test(`rejects replay with ${name}`, async () => {
      const corrupted = structuredClone(persisted);
      mutate(corrupted);
      const repositoryReturningCorruptReplay = {
        async loadOutcome() { return corrupted; },
        async recordOutcome() { assert.fail("a corrupt replay must not produce a new write"); },
      };
      await assert.rejects(checkImageGroup({
        ...input,
        repository: repositoryReturningCorruptReplay,
      }), { code: "AUTO_LISTING_IMAGE_GROUP_CHECK_INPUT_INVALID", retryable: false });
      assert.equal(gatewayCalls, 1, "a corrupt replay must fail before another paid call");
    });
  }
});

test("a persisted direct V1 accepted outcome replays without provider rendition hash drift", async () => {
  const plan = planWithTargets();
  const summary = intelligence(["FRONT", "BACK", "RIGHT"]);
  plan.sourceImageIntelligenceHash = summary.summaryHash;
  const generatedAssets = acceptedAssets(plan);
  const repository = createMemoryImageGroupCheckRepository({
    id: () => "image-group-check-direct-v1",
    now: () => new Date("2026-08-30T00:00:00.000Z"),
  });
  const scope = {
    accountId: "account-a", jobId: "job-a", itemId: "item-a", planId: "plan-a",
    visualGroupKey: "group-a", expectedStatusVersion: 7,
  };
  const profile = {
    id: "profile-a", accountId: "account-a", configVersion: 3,
    textModel: "checker-model", connectionId: "connection-a", connectionVersion: 4,
  };
  const gatewayExecution = {
    channelId: "channel-a", connectionId: "connection-a", connectionVersion: 4,
    idleTimeoutMs: 300_000,
  };
  const result = {
    accepted: true,
    acceptedSlotKeys: [...slotKeys].sort(),
    duplicateSlotKeys: [],
    viewMismatchSlotKeys: [],
    identityMismatchSlotKeys: [],
    retrySlotKeys: [],
    reasonCodes: [],
  };
  const inputHash = digest({
    scope,
    profile: {
      id: profile.id,
      accountId: profile.accountId,
      configVersion: profile.configVersion,
      textModel: profile.textModel,
    },
    gatewayConnection: { id: "connection-a", version: 4 },
    requestInput: directV1RequestInput(plan, generatedAssets, summary),
  });
  await repository.recordOutcome({
    ...scope,
    sourceImageAnalysisRunId: plan.sourceImageAnalysisRunId,
    inputHash,
    result,
    resultHash: digest(result),
    gatewayRequestId: "eec3fed-direct-v1-request",
    modelEvidence: {
      requestedTextModel: "checker-model",
      gatewayReportedTextModel: "checker-model",
      gatewayReportedTextModelPresent: true,
    },
    gatewayConnectionId: "connection-a",
    gatewayConnectionVersion: 4,
  });
  let gatewayCalls = 0;

  const replay = await checkImageGroup({
    scope,
    plan,
    generatedAssets,
    sourceImageIntelligence: summary,
    repository,
    gateway: {
      async inspectImage() {
        gatewayCalls += 1;
        return {
          requestId: "unexpected-current-direct-request",
          modelEvidence: {
            requestedTextModel: "checker-model",
            gatewayReportedTextModel: "checker-model",
            gatewayReportedTextModelPresent: true,
          },
          value: groupEvidence(),
        };
      },
    },
    profile,
    gatewayExecution,
    assertLeaseActive() {},
  });

  assert.equal(replay.status, "ACCEPTED");
  assert.equal(replay.inputHash, inputHash);
  assert.equal(replay.gatewayRequestId, "eec3fed-direct-v1-request");
  assert.equal(gatewayCalls, 0);
});

test("a gateway group response is conservatively normalized before rejected evidence is persisted", async () => {
  const plan = planWithTargets();
  const summary = intelligence(["FRONT", "BACK", "RIGHT"]);
  plan.sourceImageIntelligenceHash = summary.summaryHash;
  const repository = createMemoryImageGroupCheckRepository({
    id: () => "image-group-check-rejected",
    now: () => new Date("2026-08-30T00:00:00.000Z"),
  });
  const input = {
    scope: {
      accountId: "account-a", jobId: "job-a", itemId: "item-a", planId: "plan-a",
      visualGroupKey: "group-a", expectedStatusVersion: 7,
    },
    plan,
    generatedAssets: acceptedAssets(plan),
    sourceImageIntelligence: summary,
    repository,
    gateway: {
      async inspectImage() {
        return {
          requestId: "group-check-request-rejected",
          modelEvidence: {
            requestedTextModel: "checker-model",
            gatewayReportedTextModel: "checker-model",
            gatewayReportedTextModelPresent: true,
          },
          value: {
            acceptedSlotKeys: ["main-1", "selling-1", "infographic-1", "scene-1", "detail-1"],
            duplicateSlotKeys: ["selling-1", "selling-1"],
            viewMismatchSlotKeys: [],
            identityMismatchSlotKeys: [],
            reasonCodes: ["IMAGE_GROUP_VIEW_MISMATCH"],
          },
        };
      },
    },
    profile: {
      id: "profile-a", accountId: "account-a", configVersion: 3,
      textModel: "checker-model", connectionId: null, connectionVersion: null,
    },
    gatewayExecution: null,
    assertLeaseActive() {},
  };

  const result = await checkImageGroup(input);
  assert.equal(result.status, "RETRY_QUEUED");
  assert.deepEqual(result.retrySlotKeys, ["selling-1", "specification-1"]);
  assert.deepEqual(result.duplicateSlotKeys, ["selling-1"]);
  assert.deepEqual(result.identityMismatchSlotKeys, ["specification-1"]);
  assert.deepEqual(result.reasonCodes, [
    "IMAGE_GROUP_DUPLICATE_VIEW",
    "IMAGE_GROUP_UNSUPPORTED_STRUCTURE",
  ]);
  const persisted = await repository.loadOutcome({
    ...input.scope,
    sourceImageAnalysisRunId: "run-a",
    inputHash: result.inputHash,
  });
  assert.equal(persisted.status, "REJECTED");
  assert.deepEqual(persisted.result.retrySlotKeys, ["selling-1", "specification-1"]);
});

test("gateway-only target disagreement and scene duplication do not override accepted single-image evidence", async () => {
  const plan = planWithTargets([
    "FRONT_LEFT_3_4", "FRONT", "FRONT_RIGHT_3_4", "FRONT_LEFT_3_4", "DETAIL", "FRONT",
  ]);
  const summary = intelligence(["FRONT", "LEFT"]);
  plan.sourceImageIntelligenceHash = summary.summaryHash;
  const repository = createMemoryImageGroupCheckRepository({
    id: () => "image-group-check-policy",
    now: () => new Date("2026-09-02T00:00:00.000Z"),
  });

  const result = await checkImageGroup({
    scope: {
      accountId: "account-a", jobId: "job-a", itemId: "item-a", planId: "plan-a",
      visualGroupKey: "group-a", expectedStatusVersion: 7,
    },
    plan,
    generatedAssets: acceptedAssets(plan),
    sourceImageIntelligence: summary,
    repository,
    gateway: {
      async inspectImage() {
        return {
          requestId: "group-check-request-policy",
          modelEvidence: {
            requestedTextModel: "checker-model",
            gatewayReportedTextModel: "checker-model",
            gatewayReportedTextModelPresent: true,
          },
          value: groupEvidence({
            duplicateSlotKeys: ["scene-1"],
            viewMismatchSlotKeys: ["infographic-1"],
            reasonCodes: ["IMAGE_GROUP_DUPLICATE_VIEW", "IMAGE_GROUP_VIEW_MISMATCH"],
          }),
        };
      },
    },
    profile: {
      id: "profile-a", accountId: "account-a", configVersion: 3,
      textModel: "checker-model", connectionId: null, connectionVersion: null,
    },
    gatewayExecution: null,
    assertLeaseActive() {},
  });

  assert.equal(result.status, "ACCEPTED");
  assert.equal(result.accepted, true);
  assert.deepEqual(result.acceptedSlotKeys, [...slotKeys].sort());
  assert.deepEqual(result.retrySlotKeys, []);
  assert.deepEqual(result.reasonCodes, []);
});

test("a recovery group check cannot regress unchanged slots accepted by the previous group check", async () => {
  const plan = planWithTargets();
  const summary = intelligence(["FRONT", "BACK", "RIGHT"]);
  plan.sourceImageIntelligenceHash = summary.summaryHash;
  const repository = createMemoryImageGroupCheckRepository({
    id: () => "image-group-check-frozen-recovery",
    now: () => new Date("2026-09-02T00:00:00.000Z"),
  });
  const frozenAcceptedSlotKeys = ["detail-1", "infographic-1", "main-1", "scene-1", "selling-1"];

  const result = await checkImageGroup({
    scope: {
      accountId: "account-a", jobId: "job-a", itemId: "item-a", planId: "plan-a",
      visualGroupKey: "group-a", expectedStatusVersion: 8,
    },
    plan,
    generatedAssets: acceptedAssets(plan),
    sourceImageIntelligence: summary,
    frozenAcceptedSlotKeys,
    repository,
    gateway: {
      async inspectImage(request) {
        assert.match(request.prompt, /frozenAcceptedSlotKeys/u);
        assert.deepEqual(JSON.parse(request.prompt.split("\n").at(-1)).frozenAcceptedSlotKeys,
          [...frozenAcceptedSlotKeys].sort());
        return {
          requestId: "group-check-request-frozen-recovery",
          modelEvidence: {
            requestedTextModel: "checker-model",
            gatewayReportedTextModel: "checker-model",
            gatewayReportedTextModelPresent: true,
          },
          value: groupEvidence({
            duplicateSlotKeys: ["infographic-1"],
            viewMismatchSlotKeys: ["infographic-1"],
            identityMismatchSlotKeys: ["detail-1"],
            reasonCodes: [
              "IMAGE_GROUP_DUPLICATE_VIEW",
              "IMAGE_GROUP_VIEW_MISMATCH",
              "IMAGE_GROUP_IDENTITY_MISMATCH",
            ],
          }),
        };
      },
    },
    profile: {
      id: "profile-a", accountId: "account-a", configVersion: 3,
      textModel: "checker-model", connectionId: null, connectionVersion: null,
    },
    gatewayExecution: null,
    assertLeaseActive() {},
  });

  assert.equal(result.status, "ACCEPTED");
  assert.equal(result.accepted, true);
  assert.deepEqual(result.acceptedSlotKeys, [...slotKeys].sort());
  assert.deepEqual(result.retrySlotKeys, []);
});

test("group identity opinion cannot override source-backed accepted single-image identity", async () => {
  const plan = planWithTargets();
  const summary = intelligence(["FRONT", "BACK", "RIGHT"]);
  plan.sourceImageIntelligenceHash = summary.summaryHash;
  const repository = createMemoryImageGroupCheckRepository({
    id: () => "image-group-check-source-backed-identity",
    now: () => new Date("2026-09-02T00:00:00.000Z"),
  });

  const result = await checkImageGroup({
    scope: {
      accountId: "account-a", jobId: "job-a", itemId: "item-a", planId: "plan-a",
      visualGroupKey: "group-a", expectedStatusVersion: 7,
    },
    plan,
    generatedAssets: acceptedAssets(plan),
    sourceImageIntelligence: summary,
    frozenAcceptedSlotKeys: [],
    repository,
    gateway: {
      async inspectImage() {
        return {
          requestId: "group-check-request-source-backed-identity",
          modelEvidence: {
            requestedTextModel: "checker-model",
            gatewayReportedTextModel: "checker-model",
            gatewayReportedTextModelPresent: true,
          },
          value: groupEvidence({
            identityMismatchSlotKeys: ["specification-1"],
            reasonCodes: ["IMAGE_GROUP_IDENTITY_MISMATCH"],
          }),
        };
      },
    },
    profile: {
      id: "profile-a", accountId: "account-a", configVersion: 3,
      textModel: "checker-model", connectionId: null, connectionVersion: null,
    },
    gatewayExecution: null,
    assertLeaseActive() {},
  });

  assert.equal(result.status, "ACCEPTED");
  assert.equal(result.accepted, true);
  assert.deepEqual(result.retrySlotKeys, []);
  assert.deepEqual(result.reasonCodes, []);
});

test("scene target views are excluded from complete-product duplicate enforcement regardless of slot role", async () => {
  const plan = planWithTargets([
    "SCENE", "SCENE", "SCENE", "SCENE", "DETAIL", "SCENE",
  ]);
  const summary = intelligence(["FRONT"]);
  plan.sourceImageIntelligenceHash = summary.summaryHash;
  const repository = createMemoryImageGroupCheckRepository({
    id: () => "image-group-check-scene-target-policy",
    now: () => new Date("2026-09-02T00:00:00.000Z"),
  });

  const result = await checkImageGroup({
    scope: {
      accountId: "account-a", jobId: "job-a", itemId: "item-a", planId: "plan-a",
      visualGroupKey: "group-a", expectedStatusVersion: 8,
    },
    plan,
    generatedAssets: acceptedAssets(plan),
    sourceImageIntelligence: summary,
    repository,
    gateway: {
      async inspectImage() {
        return {
          requestId: "group-check-request-scene-target-policy",
          modelEvidence: {
            requestedTextModel: "checker-model",
            gatewayReportedTextModel: "checker-model",
            gatewayReportedTextModelPresent: true,
          },
          value: groupEvidence({
            duplicateSlotKeys: ["selling-1", "infographic-1", "specification-1"],
            viewMismatchSlotKeys: ["selling-1", "infographic-1", "specification-1"],
            reasonCodes: ["IMAGE_GROUP_DUPLICATE_VIEW", "IMAGE_GROUP_VIEW_MISMATCH"],
          }),
        };
      },
    },
    profile: {
      id: "profile-a", accountId: "account-a", configVersion: 3,
      textModel: "checker-model", connectionId: null, connectionVersion: null,
    },
    gatewayExecution: null,
    assertLeaseActive() {},
  });

  assert.equal(result.status, "ACCEPTED");
  assert.equal(result.accepted, true);
  assert.deepEqual(result.acceptedSlotKeys, [...slotKeys].sort());
  assert.deepEqual(result.retrySlotKeys, []);
  assert.deepEqual(result.reasonCodes, []);
});

test("group checking accepts the settings MODEL_ID grammar for requested and reported models", async () => {
  const model = "openai/gpt-5.4+stable";
  const plan = planWithTargets();
  const summary = intelligence(["FRONT", "BACK", "RIGHT"]);
  plan.sourceImageIntelligenceHash = summary.summaryHash;
  const repository = createMemoryImageGroupCheckRepository();

  const result = await checkImageGroup({
    scope: {
      accountId: "account-a", jobId: "job-a", itemId: "item-a", planId: "plan-a",
      visualGroupKey: "group-a", expectedStatusVersion: 7,
    },
    plan,
    generatedAssets: acceptedAssets(plan),
    sourceImageIntelligence: summary,
    repository,
    gateway: {
      async inspectImage(request) {
        assert.equal(request.model, model);
        return {
          requestId: "group-check-model-request-a",
          modelEvidence: {
            requestedTextModel: model,
            gatewayReportedTextModel: model,
            gatewayReportedTextModelPresent: true,
          },
          value: groupEvidence(),
        };
      },
    },
    profile: {
      id: "profile-a", accountId: "account-a", configVersion: 3,
      textModel: model, connectionId: null, connectionVersion: null,
    },
    gatewayExecution: null,
    assertLeaseActive() {},
  });

  assert.equal(result.status, "ACCEPTED");
  assert.equal(result.modelEvidence.requestedTextModel, model);
  assert.equal(result.modelEvidence.gatewayReportedTextModel, model);
});

test("an over-budget group uses deterministic provider renditions and replays without changing originals", async () => {
  const originalBytes = await sharp({
    create: { width: 1_400, height: 1_400, channels: 3, background: "#315a91" },
  }).png({ compressionLevel: 0, adaptiveFiltering: false }).toBuffer();
  assert.ok(originalBytes.length * slotKeys.length > 32 * 1024 * 1024);
  assert.ok(originalBytes.length < 16 * 1024 * 1024);
  const plan = planWithTargets();
  const summary = intelligence(["FRONT", "BACK", "RIGHT"]);
  plan.sourceImageIntelligenceHash = summary.summaryHash;
  const generatedAssets = acceptedAssetsWithBytes(plan, originalBytes);
  const originalEvidence = generatedAssets.map(({ bytes, contentHash, contentType, size }) => ({
    bytes: Buffer.from(bytes), contentHash, contentType, size,
  }));
  const repository = createMemoryImageGroupCheckRepository();
  let gatewayCalls = 0;
  let sentRequestInput = null;
  const gateway = {
    async inspectImage(request) {
      gatewayCalls += 1;
      const providerImages = [request.image, ...request.sourceImages];
      const totalBytes = providerImages.reduce((total, image) => total + image.bytes.length, 0);
      assert.ok(totalBytes <= 32 * 1024 * 1024);
      const requestInput = JSON.parse(request.prompt.slice(request.prompt.lastIndexOf("\n") + 1));
      sentRequestInput = requestInput;
      assert.equal(requestInput.slots.length, slotKeys.length);
      for (let index = 0; index < providerImages.length; index += 1) {
        const provider = providerImages[index];
        const evidence = requestInput.slots[index].providerImage;
        assert.equal(evidence.preparationVersion, "AUTO_LISTING_IMAGE_GROUP_ANALYSIS_RENDITION_V1");
        assert.equal(evidence.transformed, true);
        assert.equal(evidence.contentHash,
          crypto.createHash("sha256").update(provider.bytes).digest("hex"));
        assert.equal(evidence.contentType, provider.contentType);
        assert.equal(evidence.size, provider.bytes.length);
        assert.equal(requestInput.slots[index].acceptedAsset.contentHash,
          generatedAssets[index].contentHash);
      }
      return {
        requestId: "group-check-rendition-request-a",
        modelEvidence: {
          requestedTextModel: "checker-model",
          gatewayReportedTextModel: "checker-model",
          gatewayReportedTextModelPresent: true,
        },
        value: groupEvidence(),
      };
    },
  };
  const input = {
    scope: {
      accountId: "account-a", jobId: "job-a", itemId: "item-a", planId: "plan-a",
      visualGroupKey: "group-a", expectedStatusVersion: 7,
    },
    plan,
    generatedAssets,
    sourceImageIntelligence: summary,
    repository,
    gateway,
    profile: {
      id: "profile-a", accountId: "account-a", configVersion: 3,
      textModel: "checker-model", connectionId: null, connectionVersion: null,
    },
    gatewayExecution: null,
    assertLeaseActive() {},
  };

  const first = await checkImageGroup(input);
  const replay = await checkImageGroup(input);

  assert.equal(first.status, "ACCEPTED");
  assert.deepEqual(replay, first);
  assert.equal(gatewayCalls, 1);
  assert.equal(first.inputHash, digest({
    scope: input.scope,
    profile: {
      id: input.profile.id,
      accountId: input.profile.accountId,
      configVersion: input.profile.configVersion,
      textModel: input.profile.textModel,
    },
    gatewayConnection: null,
    requestInput: sentRequestInput,
  }));
  for (let index = 0; index < generatedAssets.length; index += 1) {
    assert.equal(generatedAssets[index].bytes.equals(originalEvidence[index].bytes), true);
    assert.equal(generatedAssets[index].contentHash, originalEvidence[index].contentHash);
    assert.equal(generatedAssets[index].contentType, originalEvidence[index].contentType);
    assert.equal(generatedAssets[index].size, originalEvidence[index].size);
  }
});

test("an over-budget undecodable group fails before the paid group inspection", async () => {
  const invalidBytes = Buffer.alloc(6 * 1024 * 1024, 0xa5);
  const plan = planWithTargets();
  const summary = intelligence(["FRONT", "BACK", "RIGHT"]);
  plan.sourceImageIntelligenceHash = summary.summaryHash;
  let gatewayCalls = 0;

  await assert.rejects(checkImageGroup({
    scope: {
      accountId: "account-a", jobId: "job-a", itemId: "item-a", planId: "plan-a",
      visualGroupKey: "group-a", expectedStatusVersion: 7,
    },
    plan,
    generatedAssets: acceptedAssetsWithBytes(plan, invalidBytes),
    sourceImageIntelligence: summary,
    repository: createMemoryImageGroupCheckRepository(),
    gateway: {
      async inspectImage() {
        gatewayCalls += 1;
        return {
          requestId: "must-not-be-called",
          modelEvidence: {
            requestedTextModel: "checker-model",
            gatewayReportedTextModel: "checker-model",
            gatewayReportedTextModelPresent: true,
          },
          value: groupEvidence(),
        };
      },
    },
    profile: {
      id: "profile-a", accountId: "account-a", configVersion: 3,
      textModel: "checker-model", connectionId: null, connectionVersion: null,
    },
    gatewayExecution: null,
    assertLeaseActive() {},
  }), { code: "AUTO_LISTING_IMAGE_GROUP_CHECK_INPUT_INVALID", retryable: false });
  assert.equal(gatewayCalls, 0);
});

test("group evidence rejects a missing hidden view that the frozen one-view plan never requested", () => {
  const plan = planWithTargets(["FRONT", "FRONT", "FRONT", "FRONT", "FRONT", "FRONT"]);
  const summary = intelligence(["FRONT"]);
  plan.sourceImageIntelligenceHash = summary.summaryHash;
  plan.plan.slots.forEach((slot) => { slot.evidenceMode = "COMPOSITION_ONLY"; });

  assert.throws(() => evaluateImageGroupEvidence({
    plan,
    generatedAssets: acceptedAssets(plan),
    sourceImageIntelligence: summary,
    checkerEvidence: groupEvidence({ reasonCodes: ["BACK_VIEW_MISSING"] }),
  }), { code: "AUTO_LISTING_IMAGE_GROUP_CHECK_INPUT_INVALID" });
});
