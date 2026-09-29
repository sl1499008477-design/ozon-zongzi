import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import Ajv from "ajv";

import {
  buildContentPlanFillSchema,
  buildFixedSkeleton,
  mergeContentPlanFill,
} from "../auto-listing-fixed-skeleton.mjs";
import { SOURCE_IMAGE_INTELLIGENCE_CONTRACT_VERSION } from "../auto-listing-source-image-intelligence-contract.mjs";

const roles = Object.freeze({
  six: { MAIN: 1, SELLING_POINT: 1, INFOGRAPHIC: 1, SCENE: 1, DETAIL: 1, SPECIFICATION: 1 },
  eight: { MAIN: 1, SELLING_POINT: 3, DETAIL: 1, SCENE: 1, SPECIFICATION: 1, INFOGRAPHIC: 1 },
  thirteen: { MAIN: 1, SELLING_POINT: 5, DETAIL: 2, SCENE: 2, SPECIFICATION: 1, INFOGRAPHIC: 2 },
});
const approvedRoleOrder = Object.freeze([
  "MAIN", "SELLING_POINT", "INFOGRAPHIC", "SCENE", "DETAIL", "SPECIFICATION",
]);

test("the approved six-image baseline follows the conversion-impact sequence", () => {
  const skeleton = buildFixedSkeleton({ plannerContext: context(roles.six) });

  assert.deepEqual(skeleton.plan.slots.map(({ role }) => role), approvedRoleOrder);
});

const densities = Object.freeze({
  MAIN: "NONE", SELLING_POINT: "MEDIUM", DETAIL: "LIGHT", SCENE: "LIGHT",
  SPECIFICATION: "HEAVY", INFOGRAPHIC: "MEDIUM",
});

function context(requestedRoleCounts = roles.eight, overrides = {}) {
  const visualGroup = {
    visualGroupKey: "visual-group-a",
    referenceImages: [{ assetId: "source-image-a", sourceRefHash: null, contentHash: "a".repeat(64), evidenceKind: "CONTENT_HASH" }],
    factEvidence: [
      { factId: "fact.color.red", kind: "COLOR", value: "красный" },
      { factId: "fact.material.steel", kind: "MATERIAL", value: "сталь" },
    ],
    requiredPreserve: ["красный", "сталь"],
    reasonCodes: ["COMPLETE_APPEARANCE_EVIDENCE"],
  };
  const factRegistry = [
    { factId: "fact.identity.name", kind: "IDENTITY_NAME", value: "Термокружка", sourcePath: "identity.primaryName", visualGroupKeys: [] },
    { factId: "fact.identity.brand", kind: "IDENTITY_BRAND", value: "Brand 500", sourcePath: "identity.brand", visualGroupKeys: [] },
    { factId: "fact.product.heightCm", kind: "DIMENSION_HEIGHT", value: "22 cm", sourcePath: "productMeasurements.heightCm", visualGroupKeys: [] },
    { factId: "fact.color.red", kind: "COLOR", value: "красный", sourcePath: "variants.evidence.color", visualGroupKeys: ["visual-group-a"] },
    { factId: "fact.material.steel", kind: "MATERIAL", value: "сталь", sourcePath: "variants.evidence.material", visualGroupKeys: ["visual-group-a"] },
  ];
  return {
    plannerInput: {
      requestedRoleCounts,
      imagesPerVisualGroup: Object.values(requestedRoleCounts).reduce((sum, value) => sum + value, 0),
      visualGroups: overrides.visualGroups || [visualGroup],
      factRegistry: overrides.factRegistry || factRegistry,
      roleSubstitutions: overrides.roleSubstitutions || [],
      textDensityByRole: densities,
      prohibitedClaims: ["CERTIFICATION", "MEDICAL_BENEFIT", "UNLISTED_ACCESSORIES", "WARRANTY"],
      language: "ru", ratio: "3:4", resolution: "1K", quality: "Medium",
    },
  };
}

const canonical = (value) => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const digest = (value) => crypto.createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");

function intelligenceForViews(views, { symmetryClass = "ASYMMETRIC" } = {}) {
  const families = symmetryClass === "ROTATIONAL" ? ["ROTATIONAL"] : views;
  const assets = views.map((view) => `${view.toLocaleLowerCase("en-US")}-asset`);
  const coverageMap = Object.fromEntries(families.map((family, index) => [family, {
    assetIds: symmetryClass === "ROTATIONAL" ? assets : [assets[index]],
    preciseViewpoints: symmetryClass === "ROTATIONAL" ? views : [views[index]],
    tentativeAssetIds: [],
  }]));
  const completeViews = ["FRONT", "BACK", "LEFT", "RIGHT", "TOP", "BOTTOM", "INTERIOR"];
  const present = new Set(symmetryClass === "ROTATIONAL" ? ["FRONT"] : families);
  coverageMap.COMPLETE_PRODUCT = {
    confirmedFamilyCount: families.length,
    confirmedFamilies: families,
    requiredFamilyCount: Math.min(families.length, 3),
    prohibitedViews: completeViews.filter((view) => !present.has(view)),
  };
  const value = {
    contractVersion: SOURCE_IMAGE_INTELLIGENCE_CONTRACT_VERSION,
    coverageMap, factCandidates: [], markingDecisions: [], eligibleAssetIds: assets,
    excludedAssetIds: [], requiredConfirmations: [], symmetryClass, reasonCodes: [],
  };
  return { ...value, summaryHash: digest(value) };
}

function contextWithViews(views, options = {}) {
  const sourceImageIntelligence = intelligenceForViews(views, options);
  const visualGroup = {
    ...context(roles.six).plannerInput.visualGroups[0],
    referenceImages: sourceImageIntelligence.eligibleAssetIds.map((assetId, index) => ({
      assetId, sourceRefHash: null, contentHash: String(index + 1).repeat(64), evidenceKind: "CONTENT_HASH",
    })),
  };
  const plannerContext = context(roles.six, { visualGroups: [visualGroup] });
  plannerContext.plannerInput.sourceImageIntelligence = sourceImageIntelligence;
  return plannerContext;
}

function contextWithDetailEvidence() {
  const plannerContext = contextWithViews(["FRONT"]);
  const intelligence = structuredClone(plannerContext.plannerInput.sourceImageIntelligence);
  intelligence.coverageMap.DETAIL = {
    assetIds: ["detail-asset"], preciseViewpoints: ["DETAIL"], tentativeAssetIds: [],
  };
  intelligence.eligibleAssetIds.push("detail-asset");
  intelligence.summaryHash = digest(Object.fromEntries(
    Object.entries(intelligence).filter(([key]) => key !== "summaryHash"),
  ));
  plannerContext.plannerInput.sourceImageIntelligence = intelligence;
  plannerContext.plannerInput.visualGroups[0].referenceImages.push({
    assetId: "detail-asset", sourceRefHash: null, contentHash: "d".repeat(64), evidenceKind: "CONTENT_HASH",
  });
  return plannerContext;
}

function contextWithSupplementalEvidenceOnly() {
  const coverageMap = {
    SCENE: {
      assetIds: ["scene-asset"], preciseViewpoints: ["SCENE"], tentativeAssetIds: [],
    },
    PACKAGE: {
      assetIds: ["package-asset"], preciseViewpoints: ["PACKAGE"], tentativeAssetIds: [],
    },
    COMPLETE_PRODUCT: {
      confirmedFamilyCount: 0,
      confirmedFamilies: [],
      requiredFamilyCount: 0,
      prohibitedViews: ["FRONT", "BACK", "LEFT", "RIGHT", "TOP", "BOTTOM", "INTERIOR"],
    },
  };
  const value = {
    contractVersion: SOURCE_IMAGE_INTELLIGENCE_CONTRACT_VERSION,
    coverageMap,
    factCandidates: [],
    markingDecisions: [],
    eligibleAssetIds: ["scene-asset", "package-asset"],
    excludedAssetIds: ["watermarked-front"],
    requiredConfirmations: [],
    symmetryClass: "ASYMMETRIC",
    reasonCodes: ["AUTO_LISTING_SOURCE_IMAGE_UNSAFE_OVERLAY_EXCLUDED"],
  };
  const sourceImageIntelligence = { ...value, summaryHash: digest(value) };
  const visualGroup = {
    ...context(roles.six).plannerInput.visualGroups[0],
    referenceImages: sourceImageIntelligence.eligibleAssetIds.map((assetId, index) => ({
      assetId,
      sourceRefHash: null,
      contentHash: String(index + 1).repeat(64),
      evidenceKind: "CONTENT_HASH",
    })),
  };
  const plannerContext = context(roles.six, { visualGroups: [visualGroup] });
  plannerContext.plannerInput.sourceImageIntelligence = sourceImageIntelligence;
  return plannerContext;
}

function contextWithDetailEvidenceOnly() {
  const coverageMap = {
    DETAIL: {
      assetIds: ["detail-asset"], preciseViewpoints: ["DETAIL"], tentativeAssetIds: [],
    },
    COMPLETE_PRODUCT: {
      confirmedFamilyCount: 0,
      confirmedFamilies: [],
      requiredFamilyCount: 0,
      prohibitedViews: ["FRONT", "BACK", "LEFT", "RIGHT", "TOP", "BOTTOM", "INTERIOR"],
    },
  };
  const value = {
    contractVersion: SOURCE_IMAGE_INTELLIGENCE_CONTRACT_VERSION,
    coverageMap,
    factCandidates: [],
    markingDecisions: [],
    eligibleAssetIds: ["detail-asset"],
    excludedAssetIds: [],
    requiredConfirmations: [],
    symmetryClass: "ASYMMETRIC",
    reasonCodes: [],
  };
  const sourceImageIntelligence = { ...value, summaryHash: digest(value) };
  const visualGroup = {
    ...context(roles.six).plannerInput.visualGroups[0],
    referenceImages: [{
      assetId: "detail-asset", sourceRefHash: null, contentHash: "d".repeat(64), evidenceKind: "CONTENT_HASH",
    }],
  };
  const plannerContext = context(roles.six, { visualGroups: [visualGroup] });
  plannerContext.plannerInput.sourceImageIntelligence = sourceImageIntelligence;
  return plannerContext;
}

test("three confirmed view families produce at least three target families without a global first-image anchor", () => {
  const plan = buildFixedSkeleton({ plannerContext: contextWithViews(["FRONT", "BACK", "RIGHT"]) }).plan;
  const completeViews = new Set(["FRONT", "BACK", "LEFT", "RIGHT", "TOP", "BOTTOM", "INTERIOR"]);
  assert.ok(new Set(plan.slots.map((slot) => slot.targetView).filter((view) => completeViews.has(view))).size >= 3);
  assert.ok(plan.slots.every((slot) => slot.referenceAssetIds.length >= 1 && slot.referenceAssetIds.length <= 3));
  assert.ok(plan.slots.some((slot) => !slot.referenceAssetIds.includes("front-asset")));
});

test("one confirmed view schedules bounded synthetic exterior angles and still prohibits hidden structures", () => {
  const plan = buildFixedSkeleton({ plannerContext: contextWithViews(["FRONT"]) }).plan;
  const fullProductSlots = plan.slots.filter(({ role }) => role !== "DETAIL");
  const safeSyntheticViews = new Set(["FRONT", "LEFT", "RIGHT", "FRONT_LEFT_3_4", "FRONT_RIGHT_3_4"]);

  assert.ok(new Set(fullProductSlots.map(({ targetView }) => targetView)).size >= 3);
  assert.ok(fullProductSlots.some(({ evidenceMode }) => evidenceMode === "SYNTHESIZED_SAFE"));
  assert.ok(fullProductSlots.filter(({ evidenceMode }) => evidenceMode === "SYNTHESIZED_SAFE")
    .every(({ targetView, referenceAssetIds }) => safeSyntheticViews.has(targetView)
      && referenceAssetIds.includes("front-asset")));
  assert.ok(plan.slots.every((slot) => ["BACK", "BOTTOM", "INTERIOR", "HIDDEN_PORTS"]
    .every((view) => slot.prohibitedViews.includes(view))));
});

test("two confirmed full views both appear and a bounded third angle is synthesized", () => {
  const two = buildFixedSkeleton({ plannerContext: contextWithViews(["FRONT", "RIGHT"]) }).plan;
  assert.ok(["FRONT", "RIGHT"].every((view) => two.slots.some((slot) => slot.targetView === view)));
  assert.ok(new Set(two.slots.filter(({ role }) => role !== "DETAIL").map(({ targetView }) => targetView)).size >= 3);
  assert.ok(two.slots.some(({ evidenceMode }) => evidenceMode === "SYNTHESIZED_SAFE"));
  assert.ok(two.slots.filter(({ evidenceMode }) => evidenceMode === "SYNTHESIZED_SAFE")
    .every(({ targetView }) => !["BACK", "TOP", "BOTTOM", "INTERIOR"].includes(targetView)));
});

test("one diagonal source image is one direct angle rather than fake FRONT and RIGHT coverage", () => {
  const plannerContext = contextWithViews(["FRONT"]);
  const intelligence = plannerContext.plannerInput.sourceImageIntelligence;
  intelligence.coverageMap = {
    FRONT: {
      assetIds: ["diagonal-asset"], preciseViewpoints: ["FRONT_RIGHT_3_4"], tentativeAssetIds: [],
    },
    RIGHT: {
      assetIds: ["diagonal-asset"], preciseViewpoints: ["FRONT_RIGHT_3_4"], tentativeAssetIds: [],
    },
    COMPLETE_PRODUCT: {
      confirmedFamilyCount: 2,
      confirmedFamilies: ["FRONT", "RIGHT"],
      requiredFamilyCount: 2,
      prohibitedViews: ["BACK", "LEFT", "TOP", "BOTTOM", "INTERIOR"],
    },
  };
  intelligence.eligibleAssetIds = ["diagonal-asset"];
  intelligence.summaryHash = digest(Object.fromEntries(
    Object.entries(intelligence).filter(([key]) => key !== "summaryHash"),
  ));
  plannerContext.plannerInput.visualGroups[0].referenceImages = [{
    assetId: "diagonal-asset", sourceRefHash: null, contentHash: "d".repeat(64), evidenceKind: "CONTENT_HASH",
  }];

  const plan = buildFixedSkeleton({ plannerContext }).plan;
  const directFullViews = plan.slots
    .filter(({ role, evidenceMode }) => role !== "DETAIL" && evidenceMode === "DIRECT")
    .map(({ targetView }) => targetView);

  assert.deepEqual([...new Set(directFullViews)], ["FRONT_RIGHT_3_4"]);
  assert.ok(plan.slots.some(({ evidenceMode }) => evidenceMode === "SYNTHESIZED_SAFE"));
});

test("rotational symmetry does not create front-back fiction", () => {
  const symmetric = buildFixedSkeleton({ plannerContext: contextWithViews(["FRONT", "BACK"], { symmetryClass: "ROTATIONAL" }) }).plan;
  assert.ok(!symmetric.slots.some((slot) => slot.targetView === "BACK"));
});

test("a detail target carries a complete-product identity reference without restoring a global first-image anchor", () => {
  const plan = buildFixedSkeleton({ plannerContext: contextWithDetailEvidence() }).plan;
  const detail = plan.slots.find((slot) => slot.role === "DETAIL");
  assert.equal(detail.targetView, "DETAIL");
  assert.equal(detail.identityAssetId, "front-asset");
  assert.deepEqual(new Set(detail.referenceAssetIds), new Set(["detail-asset", "front-asset"]));
});

test("an INTERIOR product-detail view is direct DETAIL evidence before a BACK substitution", () => {
  const plan = buildFixedSkeleton({ plannerContext: contextWithViews(["BACK", "INTERIOR"]) }).plan;
  const detail = plan.slots.find((slot) => slot.role === "DETAIL");

  assert.equal(detail.targetView, "INTERIOR");
  assert.equal(detail.evidenceMode, "DIRECT");
  assert.equal(detail.referenceAssetIds[0], "interior-asset");
  assert.ok(detail.referenceAssetIds.includes("back-asset"));
  assert.ok(!detail.selectionReasonCodes.includes("ROLE_EVIDENCE_SUBSTITUTED"));
});

test("scene and package evidence remain safely plannable when a watermarked only full view is excluded", () => {
  const plan = buildFixedSkeleton({ plannerContext: contextWithSupplementalEvidenceOnly() }).plan;
  const eligible = new Set(["scene-asset", "package-asset"]);
  const unsupportedCameraViews = ["FRONT", "BACK", "LEFT", "RIGHT", "TOP", "BOTTOM", "INTERIOR"];

  assert.equal(plan.slots.length, 6);
  assert.ok(plan.slots.every(({ role, targetView }) => role === "DETAIL"
    ? targetView === "DETAIL"
    : ["SCENE", "PACKAGE"].includes(targetView)));
  assert.ok(plan.slots.every(({ referenceAssetIds }) => referenceAssetIds.every((assetId) => eligible.has(assetId))));
  assert.ok(plan.slots.every(({ identityAssetId }) => identityAssetId === "scene-asset"));
  assert.ok(plan.slots.filter(({ targetView }) => ["SCENE", "PACKAGE"].includes(targetView))
    .every(({ prohibitedViews }) => prohibitedViews.includes("HIDDEN_PORTS")
      && unsupportedCameraViews.every((view) => !prohibitedViews.includes(view))));
  assert.ok(plan.slots.filter(({ targetView }) => targetView === "DETAIL")
    .every(({ prohibitedViews }) => ["HIDDEN_PORTS", ...unsupportedCameraViews]
      .every((view) => prohibitedViews.includes(view))));
  assert.deepEqual(
    plan.slots.filter(({ role }) => ["SCENE", "SPECIFICATION"].includes(role))
      .map(({ role, targetView, evidenceMode }) => ({ role, targetView, evidenceMode })),
    [
      { role: "SCENE", targetView: "SCENE", evidenceMode: "DIRECT" },
      { role: "SPECIFICATION", targetView: "PACKAGE", evidenceMode: "DIRECT" },
    ],
  );
  assert.deepEqual(
    (({ targetView, evidenceMode }) => ({ targetView, evidenceMode }))(
      plan.slots.find(({ role }) => role === "DETAIL"),
    ),
    { targetView: "DETAIL", evidenceMode: "SUBSTITUTED" },
  );
});

test("detail-only evidence falls back to a source-bound composition without inventing a camera angle", () => {
  const plan = buildFixedSkeleton({ plannerContext: contextWithDetailEvidenceOnly() }).plan;
  const main = plan.slots.find(({ role }) => role === "MAIN");

  assert.equal(plan.slots.length, 6);
  assert.equal(main.targetView, "DETAIL");
  assert.equal(main.evidenceMode, "COMPOSITION_ONLY");
  assert.equal(main.identityAssetId, "detail-asset");
  assert.deepEqual(main.referenceAssetIds, ["detail-asset"]);
  assert.ok(["BACK", "BOTTOM", "INTERIOR", "HIDDEN_PORTS"]
    .every((view) => main.prohibitedViews.includes(view)));
  assert.ok(!plan.slots.some(({ evidenceMode }) => evidenceMode === "SYNTHESIZED_SAFE"));
});

test("confirmed product markings are the frozen identity reference for every protected V3 slot", () => {
  const plannerContext = contextWithViews(["FRONT", "BACK"]);
  const intelligence = plannerContext.plannerInput.sourceImageIntelligence;
  intelligence.markingDecisions = [{
    sourceAssetId: "back-asset", kind: "PRODUCT_MARKING", regions: [],
    decisionMethod: "OBSERVED_PRODUCT_MARKING", reasonCodes: ["PRODUCT_MARKING_PROTECTED"],
  }];
  intelligence.summaryHash = digest(Object.fromEntries(
    Object.entries(intelligence).filter(([key]) => key !== "summaryHash"),
  ));

  const plan = buildFixedSkeleton({ plannerContext }).plan;

  assert.ok(plan.slots.every(({ identityAssetId }) => identityAssetId === "back-asset"));
  assert.ok(plan.slots.every(({ referenceAssetIds }) => referenceAssetIds.includes("back-asset")));
});

test("package-only markings cannot replace a complete-product identity reference", () => {
  const plannerContext = contextWithViews(["BACK"]);
  const intelligence = plannerContext.plannerInput.sourceImageIntelligence;
  intelligence.coverageMap.PACKAGE = {
    assetIds: ["a-package-asset"], preciseViewpoints: ["PACKAGE"], tentativeAssetIds: [],
  };
  intelligence.eligibleAssetIds.push("a-package-asset");
  intelligence.markingDecisions = [
    { sourceAssetId: "a-package-asset", kind: "PRODUCT_MARKING", regions: [],
      decisionMethod: "OBSERVED_PRODUCT_MARKING", reasonCodes: ["PRODUCT_MARKING_PROTECTED"] },
    { sourceAssetId: "back-asset", kind: "PRODUCT_MARKING", regions: [],
      decisionMethod: "OBSERVED_PRODUCT_MARKING", reasonCodes: ["PRODUCT_MARKING_PROTECTED"] },
  ];
  intelligence.summaryHash = digest(Object.fromEntries(
    Object.entries(intelligence).filter(([key]) => key !== "summaryHash"),
  ));
  plannerContext.plannerInput.visualGroups[0].referenceImages.push({
    assetId: "a-package-asset", sourceRefHash: null,
    contentHash: "9".repeat(64), evidenceKind: "CONTENT_HASH",
  });

  const plan = buildFixedSkeleton({ plannerContext }).plan;
  const main = plan.slots.find(({ role }) => role === "MAIN");

  assert.equal(main.targetView, "BACK");
  assert.equal(main.identityAssetId, "back-asset");
  assert.deepEqual(main.referenceAssetIds, ["back-asset"]);
});

test("each visual group derives view coverage only from assets that belong to that group", () => {
  const baseGroup = context(roles.six).plannerInput.visualGroups[0];
  const redGroup = {
    ...structuredClone(baseGroup),
    visualGroupKey: "visual-group-red",
    referenceImages: [{
      assetId: "red-front", sourceRefHash: null, contentHash: "a".repeat(64), evidenceKind: "CONTENT_HASH",
    }],
  };
  const blueGroup = {
    ...structuredClone(baseGroup),
    visualGroupKey: "visual-group-blue",
    referenceImages: [{
      assetId: "blue-back", sourceRefHash: null, contentHash: "b".repeat(64), evidenceKind: "CONTENT_HASH",
    }],
  };
  const plannerContext = context(roles.six, { visualGroups: [redGroup, blueGroup] });
  plannerContext.plannerInput.sourceImageIntelligence = intelligenceForViews(["FRONT", "BACK"]);
  const intelligence = plannerContext.plannerInput.sourceImageIntelligence;
  intelligence.coverageMap.FRONT.assetIds = ["red-front"];
  intelligence.coverageMap.BACK.assetIds = ["blue-back"];
  intelligence.eligibleAssetIds = ["red-front", "blue-back"];
  intelligence.summaryHash = digest(Object.fromEntries(
    Object.entries(intelligence).filter(([key]) => key !== "summaryHash"),
  ));

  const plan = buildFixedSkeleton({ plannerContext }).plan;
  const redSlots = plan.slots.filter(({ visualGroupKey }) => visualGroupKey === "visual-group-red");
  const blueSlots = plan.slots.filter(({ visualGroupKey }) => visualGroupKey === "visual-group-blue");

  assert.ok(redSlots.every(({ referenceAssetIds, prohibitedViews }) =>
    referenceAssetIds.every((assetId) => assetId === "red-front") && prohibitedViews.includes("BACK")));
  assert.ok(new Set(redSlots.filter(({ role }) => role !== "DETAIL").map(({ targetView }) => targetView)).size >= 3);
  assert.ok(redSlots.some(({ evidenceMode }) => evidenceMode === "SYNTHESIZED_SAFE"));
  assert.ok(blueSlots.every(({ role, targetView, referenceAssetIds, prohibitedViews }) =>
    targetView === (role === "DETAIL" ? "DETAIL" : "BACK")
    && referenceAssetIds.every((assetId) => assetId === "blue-back") && prohibitedViews.includes("FRONT")));
});

test("a detail-only variant may borrow one proven sibling structure view while keeping its own identity evidence", () => {
  const baseGroup = context(roles.six).plannerInput.visualGroups[0];
  const frontGroup = {
    ...structuredClone(baseGroup),
    visualGroupKey: "visual-group-front",
    referenceImages: [{
      assetId: "front-asset", sourceRefHash: null, contentHash: "a".repeat(64), evidenceKind: "CONTENT_HASH",
    }],
    factEvidence: [{ factId: "fact.color.red", kind: "COLOR", value: "красный" }],
    requiredPreserve: ["красный"],
  };
  const detailGroup = {
    ...structuredClone(baseGroup),
    visualGroupKey: "visual-group-detail",
    referenceImages: [{
      assetId: "detail-asset", sourceRefHash: null, contentHash: "d".repeat(64), evidenceKind: "CONTENT_HASH",
    }],
    factEvidence: [{ factId: "fact.color.blue", kind: "COLOR", value: "синий" }],
    requiredPreserve: ["синий"],
  };
  const factRegistry = [
    { factId: "fact.identity.name", kind: "IDENTITY_NAME", value: "Термокружка", sourcePath: "identity.primaryName", visualGroupKeys: [] },
    { factId: "fact.color.red", kind: "COLOR", value: "красный", sourcePath: "variants.evidence.color", visualGroupKeys: ["visual-group-front"] },
    { factId: "fact.color.blue", kind: "COLOR", value: "синий", sourcePath: "variants.evidence.color", visualGroupKeys: ["visual-group-detail"] },
  ];
  const plannerContext = context(roles.six, {
    visualGroups: [frontGroup, detailGroup],
    factRegistry,
  });
  const coverageMap = {
    FRONT: { assetIds: ["front-asset"], preciseViewpoints: ["FRONT"], tentativeAssetIds: [] },
    DETAIL: { assetIds: ["detail-asset"], preciseViewpoints: ["DETAIL"], tentativeAssetIds: [] },
    COMPLETE_PRODUCT: {
      confirmedFamilyCount: 1,
      confirmedFamilies: ["FRONT"],
      requiredFamilyCount: 1,
      prohibitedViews: ["BACK", "LEFT", "RIGHT", "TOP", "BOTTOM", "INTERIOR"],
    },
  };
  const value = {
    contractVersion: SOURCE_IMAGE_INTELLIGENCE_CONTRACT_VERSION,
    coverageMap,
    factCandidates: [],
    markingDecisions: [],
    eligibleAssetIds: ["front-asset", "detail-asset"],
    excludedAssetIds: [],
    requiredConfirmations: [],
    symmetryClass: "ASYMMETRIC",
    reasonCodes: [],
  };
  plannerContext.plannerInput.sourceImageIntelligence = { ...value, summaryHash: digest(value) };

  const plan = buildFixedSkeleton({ plannerContext }).plan;
  const borrowedMain = plan.slots.find((slot) =>
    slot.visualGroupKey === "visual-group-detail" && slot.role === "MAIN");

  assert.equal(borrowedMain.targetView, "FRONT");
  assert.equal(borrowedMain.evidenceMode, "SYNTHESIZED_SAFE");
  assert.equal(borrowedMain.identityAssetId, "detail-asset");
  assert.deepEqual(borrowedMain.referenceAssetIds, ["front-asset", "detail-asset"]);
  assert.ok(borrowedMain.selectionReasonCodes.includes("CROSS_VARIANT_STRUCTURE_REFERENCE_SELECTED"));
  assert.ok(plan.slots.filter((slot) => slot.visualGroupKey === "visual-group-front")
    .every((slot) => slot.referenceAssetIds.every((assetId) => assetId === "front-asset")));
});

test("V2 skeleton records which detail slot substituted an unsupported specification", () => {
  const requestedRoleCounts = { ...roles.eight, DETAIL: 2, SPECIFICATION: 0 };
  const plannerContext = context(requestedRoleCounts, {
    roleSubstitutions: [{
      requestedRole: "SPECIFICATION",
      actualRole: "DETAIL",
      count: 1,
      reasonCode: "PRODUCT_DIMENSIONS_UNAVAILABLE",
    }],
  });
  const skeleton = buildFixedSkeleton({ plannerContext });

  assert.equal(skeleton.plan.version, 2);
  assert.equal(skeleton.plan.slots.length, 8);
  assert.equal(skeleton.plan.slots.every((slot) => Object.hasOwn(slot, "requestedRole")
    && Object.hasOwn(slot, "substitutionReasonCode")), true);
  const substituted = skeleton.plan.slots.filter((slot) => slot.requestedRole !== slot.role);
  assert.deepEqual(substituted.map(({ role, requestedRole, substitutionReasonCode }) => ({
    role, requestedRole, substitutionReasonCode,
  })), [{
    role: "DETAIL",
    requestedRole: "SPECIFICATION",
    substitutionReasonCode: "PRODUCT_DIMENSIONS_UNAVAILABLE",
  }]);
});

for (const [name, requestedRoleCounts] of Object.entries(roles)) {
  test(`${name} configured images create one deterministic ordered skeleton`, () => {
    const first = buildFixedSkeleton({ plannerContext: context(requestedRoleCounts) });
    const second = buildFixedSkeleton({ plannerContext: context(requestedRoleCounts) });
    assert.equal(first.plan.slots.length, Object.values(requestedRoleCounts).reduce((sum, value) => sum + value, 0));
    assert.equal(first.skeletonHash, second.skeletonHash);
    assert.deepEqual(first, second);
    assert.deepEqual(first.plan.slots.map(({ role }) => role), approvedRoleOrder
      .flatMap((role) => Array.from({ length: requestedRoleCounts[role] }, () => role)));
    assert.deepEqual(first.plan.slots.map(({ order }) => order), Array.from({ length: first.plan.slots.length }, (_, index) => index + 1));
  });
}

test("non-main slots lead with their role-specific source while retaining the product identity anchor", () => {
  const base = context().plannerInput.visualGroups[0];
  const visualGroup = {
    ...base,
    referenceImages: Array.from({ length: 7 }, (_, index) => ({
      assetId: `source-image-${index + 1}`,
      sourceRefHash: null,
      contentHash: String(index + 1).repeat(64),
      evidenceKind: "CONTENT_HASH",
    })),
  };
  const skeleton = buildFixedSkeleton({ plannerContext: context(roles.eight, { visualGroups: [visualGroup] }) });

  assert.deepEqual(skeleton.plan.slots.map(({ referenceAssetIds }) => referenceAssetIds), [
    ["source-image-1"],
    ["source-image-2", "source-image-1"],
    ["source-image-3", "source-image-1"],
    ["source-image-4", "source-image-1"],
    ["source-image-5", "source-image-1"],
    ["source-image-6", "source-image-1"],
    ["source-image-7", "source-image-1"],
    ["source-image-2", "source-image-1"],
  ]);
});

test("fixed skeleton creates a complete independent slot set for every visual group", () => {
  const firstGroup = context().plannerInput.visualGroups[0];
  const secondGroup = {
    ...structuredClone(firstGroup),
    visualGroupKey: "visual-group-b",
    referenceImages: [{
      assetId: "source-image-b", sourceRefHash: null,
      contentHash: "b".repeat(64), evidenceKind: "CONTENT_HASH",
    }],
    requiredPreserve: ["синий", "сталь"],
  };
  const firstFacts = context().plannerInput.factRegistry;
  const plannerContext = context(roles.eight, {
    visualGroups: [firstGroup, secondGroup],
    factRegistry: [
      ...firstFacts,
      { factId: "fact.color.blue", kind: "COLOR", value: "синий", sourcePath: "variants.evidence.color", visualGroupKeys: ["visual-group-b"] },
    ],
  });

  const skeleton = buildFixedSkeleton({ plannerContext });

  assert.equal(skeleton.plan.slots.length, 16);
  assert.deepEqual([...new Set(skeleton.plan.slots.map(({ visualGroupKey }) => visualGroupKey))], [
    "visual-group-a", "visual-group-b",
  ]);
  assert.equal(skeleton.plan.slots.filter(({ visualGroupKey }) => visualGroupKey === "visual-group-a").length, 8);
  assert.equal(skeleton.plan.slots.filter(({ visualGroupKey }) => visualGroupKey === "visual-group-b").length, 8);
  assert.deepEqual(
    skeleton.plan.slots.filter(({ visualGroupKey }) => visualGroupKey === "visual-group-a").map(({ order }) => order),
    [1, 2, 3, 4, 5, 6, 7, 8],
  );
  assert.deepEqual(
    skeleton.plan.slots.filter(({ visualGroupKey }) => visualGroupKey === "visual-group-b").map(({ order }) => order),
    [1, 2, 3, 4, 5, 6, 7, 8],
  );
  assert.equal(skeleton.plan.slots.every((slot) => slot.referenceAssetIds.length === 1
    && slot.referenceAssetIds[0] === (slot.visualGroupKey === "visual-group-a" ? "source-image-a" : "source-image-b")), true);
  const secondSellingPointFacts = skeleton.plan.slots.filter((slot) =>
    slot.visualGroupKey === "visual-group-b" && slot.role === "SELLING_POINT")
    .flatMap((slot) => slot.sourceFactIds);
  assert.equal(secondSellingPointFacts.includes("fact.color.blue"), true);
  assert.equal(secondSellingPointFacts.includes("fact.color.red"), false);
});

test("facts whose copy is prohibited never enter fixed-skeleton claim candidates", () => {
  const baseFacts = context().plannerInput.factRegistry;
  const plannerContext = context(roles.eight, {
    factRegistry: [
      ...baseFacts,
      {
        factId: "fact.attribute.warranty",
        kind: "ATTRIBUTE:warranty",
        value: "Гарантия: 1 год",
        sourcePath: "attributes.10400",
        visualGroupKeys: [],
      },
    ],
  });

  const skeleton = buildFixedSkeleton({ plannerContext });
  const candidates = Object.values(skeleton.allowedClaimsBySlot).flat();

  assert.equal(candidates.some(({ factId }) => factId === "fact.attribute.warranty"), false);
  assert.doesNotMatch(JSON.stringify(buildContentPlanFillSchema(skeleton)), /Гарантия|fact\.attribute\.warranty/iu);
});

test("historical planner contexts cannot expose Ozon listing-only fields as image claims", () => {
  const plannerContext = context(roles.eight, {
    factRegistry: [
      ...context().plannerInput.factRegistry,
      {
        factId: "fact.attribute.9048.0",
        kind: "ATTRIBUTE:internal-model",
        value: "Название модели (для объединения в одну карточку): 019d2e6c74ed7ca59b6e879584910440",
        sourcePath: "attributes[0].values[0]",
        visualGroupKeys: [],
      },
      {
        factId: "fact.attribute.7822.0",
        kind: "ATTRIBUTE:article",
        value: "Артикул: 3726236911",
        sourcePath: "attributes[1].values[0]",
        visualGroupKeys: [],
      },
      {
        factId: "fact.attribute.8145.0",
        kind: "ATTRIBUTE:power",
        value: "Мощность, Вт: 20",
        sourcePath: "attributes[2].values[0]",
        visualGroupKeys: [],
      },
    ],
  });
  plannerContext.plannerInput.promptTemplateVersion = "AUTO_LISTING_CONTENT_PLAN_FILL_V6";
  plannerContext.plannerInput.textDensityByRole = {
    ...plannerContext.plannerInput.textDensityByRole,
    MAIN: "HEAVY",
  };

  const skeleton = buildFixedSkeleton({ plannerContext });
  const claimCandidates = JSON.stringify(skeleton.allowedClaimsBySlot);

  assert.doesNotMatch(claimCandidates, /fact\.attribute\.(?:9048|7822)\.|019d2e6c74ed7ca59b6e879584910440|3726236911/u);
  assert.match(claimCandidates, /fact\.attribute\.8145\.0|Мощность, Вт: 20/u);
});

test("fixed skeleton rejects zero visual groups but keeps a copy-free documentary slot without facts", () => {
  assert.throws(() => buildFixedSkeleton({ plannerContext: context(roles.eight, { visualGroups: [] }) }), {
    code: "AUTO_LISTING_FIXED_SKELETON_VISUAL_GROUP_UNSUPPORTED",
  });
  const facts = context().plannerInput.factRegistry.filter((fact) => !fact.kind.startsWith("DIMENSION_") && !fact.kind.startsWith("ATTRIBUTE:"));
  const skeleton = buildFixedSkeleton({ plannerContext: context(roles.eight, { factRegistry: facts }) });
  const documentary = skeleton.plan.slots.find((slot) => slot.role === "SPECIFICATION");
  assert.equal(documentary.textDensity, "NONE");
  assert.deepEqual(skeleton.allowedClaimsBySlot[documentary.slotKey], []);
});

test("repeated role slots receive distinct product fact sets when enough evidence exists", () => {
  const base = context().plannerInput.factRegistry;
  const attributes = Array.from({ length: 6 }, (_, index) => ({
    factId: `fact.attribute.${index + 1}.0`,
    kind: `ATTRIBUTE:${String(index + 1).padStart(24, "0")}`,
    value: `卖点 ${index + 1}`,
    sourcePath: `attributes[${index}].value[0]`,
    visualGroupKeys: [],
  }));
  const skeleton = buildFixedSkeleton({
    plannerContext: context(roles.eight, { factRegistry: [...base, ...attributes] }),
  });
  const sets = skeleton.plan.slots.filter(({ visualGroupKey, role }) =>
    visualGroupKey === "visual-group-a" && role === "SELLING_POINT")
    .map(({ slotKey }) => skeleton.allowedClaimsBySlot[slotKey].map(({ factId }) => factId));
  assert.equal(new Set(sets.flat()).size, sets.flat().length);
  assert.equal(sets.every((facts, index) => sets.every((other, otherIndex) =>
    index === otherIndex || facts.every((factId) => !other.includes(factId)))), true);
});

test("sparse evidence becomes a copy-free slot instead of repeating a claim", () => {
  const sparseFacts = context().plannerInput.factRegistry.filter((fact) =>
    ["fact.identity.name", "fact.material.steel"].includes(fact.factId));
  const sparseRoles = { ...roles.eight, DETAIL: 2, SPECIFICATION: 0 };
  const skeleton = buildFixedSkeleton({ plannerContext: context(sparseRoles, { factRegistry: sparseFacts }) });
  const sellingSlots = skeleton.plan.slots.filter((slot) => slot.role === "SELLING_POINT");
  const allowedFactIds = sellingSlots.flatMap((slot) =>
    skeleton.allowedClaimsBySlot[slot.slotKey].map((fact) => fact.factId));

  assert.equal(new Set(allowedFactIds).size, allowedFactIds.length);
  assert.equal(sellingSlots.some((slot) => slot.textDensity === "NONE"
    && skeleton.allowedClaimsBySlot[slot.slotKey].length === 0), true);
});

test("copy-free slots produce a JSON schema the AI gateway can compile", () => {
  const sparseFacts = context().plannerInput.factRegistry.filter((fact) =>
    ["fact.identity.name", "fact.material.steel"].includes(fact.factId));
  const sparseRoles = { ...roles.eight, DETAIL: 2, SPECIFICATION: 0 };
  const skeleton = buildFixedSkeleton({ plannerContext: context(sparseRoles, { factRegistry: sparseFacts }) });
  const schema = buildContentPlanFillSchema(skeleton);

  assert.doesNotThrow(() => new Ajv({
    allErrors: true,
    strict: true,
    validateSchema: true,
  }).compile(schema));
});

test("product documentary slots ignore unrelated attributes when size and accessories are unavailable", () => {
  const attribute = {
    factId: "fact.attribute.power.0", kind: `ATTRIBUTE:${"f".repeat(24)}`, value: "Мощность: 80 Вт",
    sourcePath: "attributes[0].values[0]", visualGroupKeys: [],
  };
  const facts = context().plannerInput.factRegistry.filter((fact) => !fact.kind.startsWith("DIMENSION_"));
  const skeleton = buildFixedSkeleton({
    plannerContext: context(roles.eight, { factRegistry: [...facts, attribute] }),
  });
  const slot = skeleton.plan.slots.find(({ visualGroupKey, role }) =>
    visualGroupKey === "visual-group-a" && role === "SPECIFICATION");
  assert.deepEqual(skeleton.allowedClaimsBySlot[slot.slotKey], []);
  assert.equal(slot.textDensity, "NONE");
});

test("role claim ranges keep information layouts dense while detail remains a focused local theme", () => {
  const attributes = Array.from({ length: 8 }, (_, index) => ({
    factId: `fact.attribute.dense.${index}`,
    kind: `ATTRIBUTE:dense-${index}`,
    value: `Проверенный параметр ${index + 1}`,
    sourcePath: `attributes[${index}].values[0]`,
    visualGroupKeys: [],
  }));
  const plannerContext = context(roles.eight, {
    factRegistry: [...context().plannerInput.factRegistry, ...attributes],
  });
  const skeleton = buildFixedSkeleton({ plannerContext });
  const schema = buildContentPlanFillSchema(skeleton);
  const rangeFor = (role) => {
    const slot = skeleton.plan.slots.find((entry) => entry.role === role);
    return schema.properties.fills.properties[slot.slotKey].properties.claims;
  };

  assert.equal(rangeFor("SELLING_POINT").minItems, 2);
  assert.equal(rangeFor("DETAIL").minItems, 1);
  assert.equal(rangeFor("DETAIL").maxItems, 2);
  assert.equal(rangeFor("SPECIFICATION").minItems, 1);
  assert.equal(rangeFor("SPECIFICATION").maxItems, 1);
  assert.equal(rangeFor("INFOGRAPHIC").minItems, 4);
});

test("V6 main image selects four distinct high-value fact groups instead of arbitrary identity facts", () => {
  const factRegistry = [
    ...context().plannerInput.factRegistry,
    { factId: "fact.attribute.load", kind: "ATTRIBUTE:load", value: "Нагрузка: 35 кг", sourcePath: "attributes[0]", visualGroupKeys: [] },
    { factId: "fact.attribute.weight", kind: "ATTRIBUTE:weight", value: "Вес товара: 3,9 кг", sourcePath: "attributes[1]", visualGroupKeys: [] },
    { factId: "fact.attribute.size", kind: "ATTRIBUTE:size", value: "Размер: 104×54×30 см", sourcePath: "attributes[2]", visualGroupKeys: [] },
    { factId: "fact.attribute.color", kind: "ATTRIBUTE:color", value: "Цвет: черный", sourcePath: "attributes[3]", visualGroupKeys: [] },
  ];
  const plannerContext = context(roles.eight, {
    factRegistry,
  });
  plannerContext.plannerInput.promptTemplateVersion = "AUTO_LISTING_CONTENT_PLAN_FILL_V6";
  plannerContext.plannerInput.textDensityByRole = {
    ...plannerContext.plannerInput.textDensityByRole,
    MAIN: "HEAVY",
  };

  const skeleton = buildFixedSkeleton({ plannerContext });
  const main = skeleton.plan.slots.find((slot) => slot.role === "MAIN");
  const allowed = skeleton.allowedClaimsBySlot[main.slotKey];
  const schema = buildContentPlanFillSchema(skeleton)
    .properties.fills.properties[main.slotKey].properties.claims;

  assert.deepEqual(allowed.map(({ factId }) => factId), [
    "fact.attribute.load",
    "fact.material.steel",
    "fact.attribute.size",
    "fact.attribute.weight",
  ]);
  assert.deepEqual(main.sourceFactIds, [
    "fact.identity.name",
    "fact.attribute.load",
    "fact.material.steel",
    "fact.attribute.size",
    "fact.attribute.weight",
  ]);
  assert.equal(schema.minItems, 4);
  assert.equal(schema.maxItems, 4);
});

test("V6 main fill restores the trusted importance order before image generation", () => {
  const factRegistry = [
    ...context().plannerInput.factRegistry,
    { factId: "fact.attribute.load", kind: "ATTRIBUTE:load", value: "Нагрузка: 35 кг", sourcePath: "attributes[0]", visualGroupKeys: [] },
    { factId: "fact.attribute.weight", kind: "ATTRIBUTE:weight", value: "Вес товара: 3,9 кг", sourcePath: "attributes[1]", visualGroupKeys: [] },
    { factId: "fact.attribute.size", kind: "ATTRIBUTE:size", value: "Размер: 104×54×30 см", sourcePath: "attributes[2]", visualGroupKeys: [] },
  ];
  const plannerContext = context(roles.six, { factRegistry });
  plannerContext.plannerInput.promptTemplateVersion = "AUTO_LISTING_CONTENT_PLAN_FILL_V6";
  plannerContext.plannerInput.textDensityByRole = {
    ...plannerContext.plannerInput.textDensityByRole,
    MAIN: "HEAVY",
  };
  const skeleton = buildFixedSkeleton({ plannerContext });
  const fill = validFill(skeleton);
  const main = skeleton.plan.slots.find((slot) => slot.role === "MAIN");
  fill.fills[main.slotKey].claims.reverse();

  const merged = mergeContentPlanFill({ skeleton, fill, plannerContext });
  const mergedMain = merged.slots.find((slot) => slot.role === "MAIN");

  assert.deepEqual(mergedMain.claims.map((claim) => claim.sourceFactIds[0]),
    skeleton.allowedClaimsBySlot[main.slotKey].map(({ factId }) => factId));
});

test("V6 main image never fills its four-card limit with administrative or identity copy", () => {
  const factRegistry = [
    { factId: "fact.identity.name", kind: "IDENTITY_NAME", value: "Шкаф туристический", sourcePath: "identity.primaryName", visualGroupKeys: [] },
    { factId: "fact.attribute.load", kind: "ATTRIBUTE:load", value: "Макс. нагрузка, кг: 40", sourcePath: "attributes[0]", visualGroupKeys: [] },
    { factId: "fact.attribute.weight", kind: "ATTRIBUTE:weight", value: "Вес, кг: 3.9", sourcePath: "attributes[1]", visualGroupKeys: [] },
    { factId: "fact.product.dimensions", kind: "SIZE", value: "Размер (Д×Ш×В): 104×45×30 см", sourcePath: "attributes#combinedDimensions", visualGroupKeys: [] },
    { factId: "fact.attribute.package-count", kind: "ATTRIBUTE:package-count", value: "Количество заводских упаковок: 1", sourcePath: "attributes[2]", visualGroupKeys: [] },
    { factId: "fact.attribute.seller-code", kind: "ATTRIBUTE:seller-code", value: "Код продавца: NO3-A1751", sourcePath: "attributes[3]", visualGroupKeys: [] },
  ];
  const plannerContext = context(roles.eight, { factRegistry });
  plannerContext.plannerInput.promptTemplateVersion = "AUTO_LISTING_CONTENT_PLAN_FILL_V6";
  plannerContext.plannerInput.textDensityByRole = {
    ...plannerContext.plannerInput.textDensityByRole,
    MAIN: "HEAVY",
  };

  const skeleton = buildFixedSkeleton({ plannerContext });
  const main = skeleton.plan.slots.find((slot) => slot.role === "MAIN");
  const allowed = skeleton.allowedClaimsBySlot[main.slotKey];
  const schema = buildContentPlanFillSchema(skeleton)
    .properties.fills.properties[main.slotKey].properties.claims;

  assert.deepEqual(allowed.map(({ factId }) => factId), [
    "fact.attribute.load",
    "fact.product.dimensions",
    "fact.attribute.weight",
  ]);
  assert.equal(schema.minItems, 3);
  assert.equal(schema.maxItems, 3);
});

test("detail slots exclude dimensions, model, packaging and accessory-list facts", () => {
  const facts = [
    ...context().plannerInput.factRegistry.filter((fact) => !fact.kind.startsWith("DIMENSION_")),
    {
      factId: "fact.attribute.stabilization", kind: "ATTRIBUTE:stabilization",
      value: "Полная стабилизация яркости", sourcePath: "attributes[0].values[0]", visualGroupKeys: [],
    },
    {
      factId: "fact.attribute.protection", kind: "ATTRIBUTE:protection",
      value: "Степень защиты от влаги и пыли: IP55", sourcePath: "attributes[1].values[0]", visualGroupKeys: [],
    },
    {
      factId: "fact.attribute.dimensions", kind: "ATTRIBUTE:dimensions",
      value: "Размер (ДхШхВ), см: 19×14×5", sourcePath: "attributes[2].values[0]", visualGroupKeys: [],
    },
    {
      factId: "fact.attribute.model", kind: "ATTRIBUTE:model",
      value: "Модель: F404020A", sourcePath: "attributes[3].values[0]", visualGroupKeys: [],
    },
    {
      factId: "fact.attribute.product-type", kind: "ATTRIBUTE:product-type",
      value: "Тип: Фонарь ручной", sourcePath: "attributes[3].values[1]", visualGroupKeys: [],
    },
    {
      factId: "fact.attribute.seller-code", kind: "ATTRIBUTE:seller-code",
      value: "Код продавца: F404020A", sourcePath: "attributes[4].values[0]", visualGroupKeys: [],
    },
    {
      factId: "fact.attribute.package-count", kind: "ATTRIBUTE:package-count",
      value: "Количество заводских упаковок: 1", sourcePath: "attributes[5].values[0]", visualGroupKeys: [],
    },
    {
      factId: "fact.attribute.accessories", kind: "ATTRIBUTE:accessories",
      value: "Комплектация: фонарь, зарядное устройство", sourcePath: "attributes[6].values[0]", visualGroupKeys: [],
    },
    {
      factId: "fact.attribute.part-number", kind: "ATTRIBUTE:part-number",
      value: "Партномер: F404020A", sourcePath: "attributes[7].values[0]", visualGroupKeys: [],
    },
  ];
  const skeleton = buildFixedSkeleton({ plannerContext: context(roles.eight, { factRegistry: facts }) });
  const detail = skeleton.plan.slots.find((slot) => slot.role === "DETAIL");
  const allowed = skeleton.allowedClaimsBySlot[detail.slotKey];

  assert.deepEqual(allowed.map(({ factId }) => factId), [
    "fact.attribute.protection",
    "fact.attribute.stabilization",
    "fact.material.steel",
  ]);
  const claims = buildContentPlanFillSchema(skeleton)
    .properties.fills.properties[detail.slotKey].properties.claims;
  assert.equal(claims.maxItems, 2);
});

test("a product documentary fill exposes only verified dimensions and accessories", () => {
  const dimension = {
    factId: "fact.attribute.dimensions",
    kind: "ATTRIBUTE:dimensions",
    value: "Размер (ДхШхВ), см: 19×14×5",
    sourcePath: "attributes[20].values[0]",
    visualGroupKeys: [],
  };
  const accessories = {
    factId: "fact.attribute.accessories",
    kind: "ATTRIBUTE:accessories",
    value: "Комплектация: шкаф, чехол",
    sourcePath: "attributes[21].values[0]",
    visualGroupKeys: [],
  };
  const unrelated = {
    factId: "fact.attribute.power",
    kind: "ATTRIBUTE:power",
    value: "Мощность: 80 Вт",
    sourcePath: "attributes[22].values[0]",
    visualGroupKeys: [],
  };
  const plannerContext = context(roles.eight, {
    factRegistry: [
      ...context().plannerInput.factRegistry.filter((fact) => !fact.kind.startsWith("DIMENSION_")),
      dimension,
      accessories,
      unrelated,
    ],
  });
  const skeleton = buildFixedSkeleton({ plannerContext });
  const fill = validFill(skeleton);
  const specification = skeleton.plan.slots.find((slot) => slot.role === "SPECIFICATION");
  assert.deepEqual(skeleton.allowedClaimsBySlot[specification.slotKey].map(({ factId }) => factId), [
    accessories.factId,
    dimension.factId,
  ]);

  const merged = mergeContentPlanFill({ skeleton, fill, plannerContext });
  const mergedSpecification = merged.slots.find((slot) => slot.slotKey === specification.slotKey);
  assert.deepEqual(new Set(mergedSpecification.claims.flatMap(({ sourceFactIds }) => sourceFactIds)),
    new Set([accessories.factId, dimension.factId]));
});

test("dynamic fill schema exposes only exact configured slot keys and claim evidence enums", () => {
  const skeleton = buildFixedSkeleton({ plannerContext: context(roles.six) });
  const schema = buildContentPlanFillSchema(skeleton);
  assert.deepEqual(schema.required, ["version", "language", "fills"]);
  assert.deepEqual(schema.properties.fills.required, skeleton.plan.slots.map((slot) => slot.slotKey));
  assert.deepEqual(Object.keys(schema.properties.fills.properties), schema.properties.fills.required);
  assert.equal(schema.properties.fills.additionalProperties, false);
  assert.doesNotMatch(JSON.stringify(schema), /oneOf|anyOf|uniqueItems|\$ref|patternProperties/u);
  const main = schema.properties.fills.properties[skeleton.plan.slots[0].slotKey];
  assert.equal(main.properties.claims.maxItems, 0);
  const sellingPoint = schema.properties.fills.properties[skeleton.plan.slots[1].slotKey];
  assert.equal(sellingPoint.properties.claims.minItems, 2);
});

test("fixed fill lets AI select only fact identities and rehydrates canonical copy on the server", () => {
  const plannerContext = context(roles.six);
  const skeleton = buildFixedSkeleton({ plannerContext });
  const schema = buildContentPlanFillSchema(skeleton);
  const fills = {};

  for (const slot of skeleton.plan.slots) {
    const claimSchema = schema.properties.fills.properties[slot.slotKey].properties.claims;
    const allowed = skeleton.allowedClaimsBySlot[slot.slotKey];
    assert.deepEqual(Object.keys(claimSchema.items.properties), allowed.length ? ["factId"] : []);
    assert.equal(claimSchema.items.additionalProperties, false);
    fills[slot.slotKey] = {
      claims: allowed.slice(0, claimSchema.minItems).map(({ factId }) => ({ factId })),
    };
  }

  const merged = mergeContentPlanFill({
    skeleton,
    fill: { version: 1, language: "ru", fills },
    plannerContext,
  });

  for (const slot of merged.slots) {
    const allowed = new Map(skeleton.allowedClaimsBySlot[slot.slotKey]
      .map((candidate) => [candidate.factId, candidate]));
    for (const claim of slot.claims) {
      const candidate = allowed.get(claim.sourceFactIds[0]);
      assert.ok(candidate);
      assert.deepEqual(claim, {
        text: candidate.value,
        claimType: candidate.kind,
        sourceFactIds: [candidate.factId],
      });
    }
  }
});

function validFill(skeleton) {
  const schema = buildContentPlanFillSchema(skeleton);
  const fills = {};
  for (const slot of skeleton.plan.slots) {
    const allowed = skeleton.allowedClaimsBySlot[slot.slotKey];
    const minimum = schema.properties.fills.properties[slot.slotKey].properties.claims.minItems;
    const ordered = slot.role === "SPECIFICATION"
      ? [...allowed].sort((left, right) => Number(!/DIMENSION_|размер/iu.test(`${left.kind} ${left.value}`))
        - Number(!/DIMENSION_|размер/iu.test(`${right.kind} ${right.value}`)))
      : allowed;
    fills[slot.slotKey] = { claims: ordered.slice(0, minimum).map((candidate) => ({
      factId: candidate.factId,
    })) };
  }
  return { version: 1, language: "ru", fills };
}

test("merge copies all structure from the skeleton and accepts only claims", () => {
  const plannerContext = context(roles.eight);
  const skeleton = buildFixedSkeleton({ plannerContext });
  const fill = validFill(skeleton);
  const merged = mergeContentPlanFill({ skeleton, fill, plannerContext });
  assert.equal(merged.slots.length, 8);
  for (const [index, slot] of merged.slots.entries()) {
    const structural = structuredClone(slot);
    structural.claims = [];
    assert.deepEqual(structural, skeleton.plan.slots[index]);
  }
  assert.equal(Object.isFrozen(merged), true);
  assert.equal(Object.isFrozen(fill), false);
});

test("merge rejects model-authored copy and derives copy only from the selected fact identity", () => {
  const plannerContext = context(roles.six);
  const skeleton = buildFixedSkeleton({ plannerContext });
  const fill = validFill(skeleton);
  const sellingPoint = skeleton.plan.slots.find((slot) => slot.role === "SELLING_POINT");
  const claim = fill.fills[sellingPoint.slotKey].claims[0];
  claim.text = "Logitech г";
  assert.throws(() => mergeContentPlanFill({ skeleton, fill, plannerContext }), {
    code: "AUTO_LISTING_CONTENT_PLAN_INVALID",
  });
});

test("merge rejects missing, extra, structural, foreign-fact and hostile fills", () => {
  const plannerContext = context(roles.six);
  const skeleton = buildFixedSkeleton({ plannerContext });
  const cases = [];
  const missing = validFill(skeleton);
  delete missing.fills[skeleton.plan.slots[1].slotKey];
  cases.push(missing);
  const extra = validFill(skeleton);
  extra.fills.extra = { claims: [] };
  cases.push(extra);
  const structural = validFill(skeleton);
  structural.fills[skeleton.plan.slots[1].slotKey].role = "MAIN";
  cases.push(structural);
  const foreign = validFill(skeleton);
  foreign.fills[skeleton.plan.slots[1].slotKey].claims[0].factId = "fact.foreign";
  cases.push(foreign);
  const duplicate = validFill(skeleton);
  const duplicateSlot = skeleton.plan.slots.find((slot) => duplicate.fills[slot.slotKey].claims.length > 1);
  duplicate.fills[duplicateSlot.slotKey].claims[1].factId = duplicate.fills[duplicateSlot.slotKey].claims[0].factId;
  cases.push(duplicate);
  const missingRequiredCopy = validFill(skeleton);
  missingRequiredCopy.fills[skeleton.plan.slots[1].slotKey].claims = [];
  cases.push(missingRequiredCopy);
  for (const fill of cases) assert.throws(
    () => mergeContentPlanFill({ skeleton, fill, plannerContext }),
    (error) => error?.code === "AUTO_LISTING_CONTENT_PLAN_INVALID" && Array.isArray(error?.issues),
  );

  let traps = 0;
  const hostile = new Proxy(validFill(skeleton), { ownKeys() { traps += 1; return []; } });
  assert.throws(() => mergeContentPlanFill({ skeleton, fill: hostile, plannerContext }), {
    code: "AUTO_LISTING_CONTENT_PLAN_INVALID",
  });
  assert.equal(traps, 0);
});
