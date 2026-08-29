import assert from "node:assert/strict";
import test from "node:test";
import Ajv from "ajv";

import {
  buildContentPlanFillSchema,
  buildFixedSkeleton,
  mergeContentPlanFill,
} from "../auto-listing-fixed-skeleton.mjs";

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
  assert.equal(schema.minItems, 4);
  assert.equal(schema.maxItems, 4);
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
      text: candidate.value,
      claimType: candidate.kind,
      sourceFactIds: [candidate.factId],
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

test("merge derives redundant claim type from the exact cited fact identity and text", () => {
  const plannerContext = context(roles.six);
  const skeleton = buildFixedSkeleton({ plannerContext });
  const fill = validFill(skeleton);
  const sellingPoint = skeleton.plan.slots.find((slot) => slot.role === "SELLING_POINT");
  const candidates = skeleton.allowedClaimsBySlot[sellingPoint.slotKey];
  const claim = fill.fills[sellingPoint.slotKey].claims[0];
  const wrongKind = candidates.find((candidate) => candidate.kind !== claim.claimType)?.kind;
  assert.ok(wrongKind);
  claim.claimType = wrongKind;

  const merged = mergeContentPlanFill({ skeleton, fill, plannerContext });
  const mergedClaim = merged.slots.find((slot) => slot.slotKey === sellingPoint.slotKey).claims[0];
  assert.equal(mergedClaim.claimType, candidates.find((candidate) => candidate.factId === claim.sourceFactIds[0]).kind);
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
