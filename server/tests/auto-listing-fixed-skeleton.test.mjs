import assert from "node:assert/strict";
import test from "node:test";

import {
  buildContentPlanFillSchema,
  buildFixedSkeleton,
  mergeContentPlanFill,
} from "../auto-listing-fixed-skeleton.mjs";

const roles = Object.freeze({
  six: { MAIN: 1, SELLING_POINT: 2, DETAIL: 1, SCENE: 1, SPECIFICATION: 0, INFOGRAPHIC: 1 },
  eight: { MAIN: 1, SELLING_POINT: 3, DETAIL: 1, SCENE: 1, SPECIFICATION: 1, INFOGRAPHIC: 1 },
  thirteen: { MAIN: 1, SELLING_POINT: 5, DETAIL: 2, SCENE: 2, SPECIFICATION: 1, INFOGRAPHIC: 2 },
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
      textDensityByRole: densities,
      prohibitedClaims: ["CERTIFICATION", "MEDICAL_BENEFIT", "UNLISTED_ACCESSORIES", "WARRANTY"],
      language: "ru", ratio: "3:4", resolution: "1K", quality: "Medium",
    },
  };
}

for (const [name, requestedRoleCounts] of Object.entries(roles)) {
  test(`${name} configured images create one deterministic ordered skeleton`, () => {
    const first = buildFixedSkeleton({ plannerContext: context(requestedRoleCounts) });
    const second = buildFixedSkeleton({ plannerContext: context(requestedRoleCounts) });
    assert.equal(first.plan.slots.length, Object.values(requestedRoleCounts).reduce((sum, value) => sum + value, 0));
    assert.equal(first.skeletonHash, second.skeletonHash);
    assert.deepEqual(first, second);
    assert.deepEqual(first.plan.slots.map(({ role }) => role), Object.entries(requestedRoleCounts)
      .flatMap(([role, count]) => Array.from({ length: count }, () => role)));
    assert.deepEqual(first.plan.slots.map(({ order }) => order), Array.from({ length: first.plan.slots.length }, (_, index) => index + 1));
  });
}

test("fixed skeleton rejects zero or multiple visual groups and missing dimension evidence before AI", () => {
  assert.throws(() => buildFixedSkeleton({ plannerContext: context(roles.eight, { visualGroups: [] }) }), {
    code: "AUTO_LISTING_FIXED_SKELETON_VISUAL_GROUP_UNSUPPORTED",
  });
  const two = context().plannerInput.visualGroups;
  assert.throws(() => buildFixedSkeleton({ plannerContext: context(roles.eight, { visualGroups: [...two, { ...two[0], visualGroupKey: "visual-group-b" }] }) }), {
    code: "AUTO_LISTING_FIXED_SKELETON_VISUAL_GROUP_UNSUPPORTED",
  });
  const facts = context().plannerInput.factRegistry.filter((fact) => !fact.kind.startsWith("DIMENSION_"));
  assert.throws(() => buildFixedSkeleton({ plannerContext: context(roles.eight, { factRegistry: facts }) }), {
    code: "AUTO_LISTING_FIXED_SKELETON_DIMENSION_REQUIRED",
  });
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
});

function validFill(skeleton) {
  const fills = {};
  for (const slot of skeleton.plan.slots) {
    const allowed = skeleton.allowedClaimsBySlot[slot.slotKey];
    fills[slot.slotKey] = { claims: slot.role === "MAIN" ? [] : [{
      text: allowed[0].value,
      claimType: allowed[0].kind,
      sourceFactIds: [allowed[0].factId],
    }] };
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
  foreign.fills[skeleton.plan.slots[1].slotKey].claims[0].sourceFactIds = ["fact.foreign"];
  cases.push(foreign);
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
