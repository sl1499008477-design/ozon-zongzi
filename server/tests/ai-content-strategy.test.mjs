import assert from "node:assert/strict";
import test from "node:test";
import { resolveAiContentStrategy } from "../ai-content-strategy.mjs";

const strategyVersion = {
  strategyId: "strategy-home-goods",
  strategyVersionId: "strategy-home-goods-v3",
};

const densities = {
  light: { main: "NONE", sellingPoint: "LIGHT" },
  medium: { main: "LIGHT", sellingPoint: "MEDIUM" },
  heavy: { main: "LIGHT", sellingPoint: "HEAVY" },
};

const rule = (overrides) => ({
  ruleId: "rule-default",
  ruleOrder: 10,
  matchType: "EXACT_CATEGORY",
  categoryId: "category-target",
  style: "VISUAL_FIRST",
  textDensityByRole: densities.light,
  ...overrides,
});

const v2Role = (role) => ({
  composition: `${role} centered composition`,
  background: "clean neutral background",
  textDensity: role === "MAIN" ? "NONE" : "LIGHT",
  layout: "clear hierarchy",
});

const v2Rule = (overrides = {}) => ({
  ruleId: "exact-v2-rule",
  ruleOrder: 50,
  matchType: "EXACT_CATEGORY_TYPE_V2",
  scope: {
    taxonomyScope: "OZON:DEFAULT",
    descriptionCategoryId: 170,
    typeId: 99,
  },
  overallStyle: "clean commercial catalogue",
  prohibitedPatterns: ["do not copy competitor brands"],
  roleGuidance: Object.fromEntries([
    "MAIN", "SELLING_POINT", "DETAIL", "SCENE", "SPECIFICATION", "INFOGRAPHIC",
  ].map((roleName) => [roleName, v2Role(roleName)])),
  sampleSetHash: "a".repeat(64),
  analysisAttemptId: "analysis-attempt-v2",
  analysisResultId: "analysis-result-v2",
  ...overrides,
});

const resolve = (overrides = {}) => resolveAiContentStrategy({
  strategyVersion,
  rules: [],
  product: {
    descriptionCategoryId: "category-target",
    categoryAncestors: [
      { categoryId: "category-parent", distance: 1 },
      { categoryId: "category-root", distance: 2 },
    ],
    productStyle: "TOOL",
  },
  ...overrides,
});

test("selects an exact category rule before ancestor and product-style rules", () => {
  const result = resolve({
    rules: [
      rule({
        ruleId: "style-rule",
        matchType: "PRODUCT_STYLE",
        productStyle: "TOOL",
        style: "PARAMETER_FIRST",
        textDensityByRole: densities.heavy,
      }),
      rule({
        ruleId: "ancestor-rule",
        matchType: "ANCESTOR_CATEGORY",
        categoryId: "category-parent",
        style: "DEMONSTRATION_FIRST",
        textDensityByRole: densities.medium,
      }),
      rule({ ruleId: "exact-rule", ruleOrder: 3 }),
    ],
  });

  assert.deepEqual(result, {
    strategyId: "strategy-home-goods",
    strategyVersionId: "strategy-home-goods-v3",
    ruleId: "exact-rule",
    matchedBy: "EXACT_CATEGORY",
    style: "VISUAL_FIRST",
    textDensityByRole: densities.light,
    evidence: {
      targetDescriptionCategoryId: "category-target",
      matchedValue: "category-target",
      ruleOrder: 3,
    },
  });
});

test("exact category type V2 wins before V1 and freezes immutable publication lineage", () => {
  const result = resolve({
    product: {
      taxonomyScope: "OZON:DEFAULT",
      descriptionCategoryId: "170",
      typeId: "99",
      categoryAncestors: [{ categoryId: "category-parent", distance: 1 }],
      productStyle: "TOOL",
    },
    rules: [
      rule({ ruleId: "v1-exact", categoryId: "170", ruleOrder: 1 }),
      v2Rule(),
    ],
  });

  assert.equal(result.matchedBy, "EXACT_CATEGORY_TYPE_V2");
  assert.equal(result.ruleId, "exact-v2-rule");
  assert.equal(result.strategyVersionId, "strategy-home-goods-v3");
  assert.deepEqual(result.scope, {
    taxonomyScope: "OZON:DEFAULT", descriptionCategoryId: 170, typeId: 99,
  });
  assert.equal(result.sampleSetHash, "a".repeat(64));
  assert.equal(result.analysisAttemptId, "analysis-attempt-v2");
  assert.equal(result.analysisResultId, "analysis-result-v2");
  assert.deepEqual(result.roleGuidance.MAIN, v2Role("MAIN"));
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.scope), true);
  assert.equal(Object.isFrozen(result.roleGuidance.MAIN), true);
  assert.throws(() => { result.roleGuidance.MAIN.layout = "changed"; }, TypeError);
});

test("V2 ignores count and extra-role instructions, fills a missing requested role safely, and reports fixed diagnostics", () => {
  const published = v2Rule({ imageCount: 99, requestedRoleCounts: { MAIN: 12 } });
  delete published.roleGuidance.SCENE;
  published.roleGuidance.VIDEO = {
    ...v2Role("VIDEO"), slotCount: 4,
  };
  published.roleGuidance.MAIN = { ...published.roleGuidance.MAIN, count: 7 };
  const result = resolve({
    product: {
      taxonomyScope: "OZON:DEFAULT", descriptionCategoryId: "170", typeId: "99",
      categoryAncestors: [], productStyle: "UNKNOWN",
    },
    rules: [published],
  });

  assert.deepEqual(Object.keys(result.roleGuidance), [
    "MAIN", "SELLING_POINT", "DETAIL", "SCENE", "SPECIFICATION", "INFOGRAPHIC",
  ]);
  assert.deepEqual(result.roleGuidance.SCENE, {
    composition: "keep the complete product clearly visible",
    background: "use a neutral background that does not obscure the product",
    textDensity: "LIGHT",
    layout: "use a simple stable hierarchy",
  });
  assert.deepEqual(result.diagnostics, [
    "CATEGORY_STRATEGY_COUNT_INSTRUCTION_IGNORED",
    "CATEGORY_STRATEGY_EXTRA_ROLE_GUIDANCE_IGNORED",
    "CATEGORY_STRATEGY_ROLE_GUIDANCE_FALLBACK",
  ]);
  assert.equal(Object.hasOwn(result, "imageCount"), false);
  assert.equal(Object.hasOwn(result, "requestedRoleCounts"), false);
  assert.equal(Object.hasOwn(result.roleGuidance, "VIDEO"), false);
});

test("V2 exact matching requires taxonomy, category and type while V1 behavior remains unchanged", () => {
  const legacy = rule({ ruleId: "legacy-exact", categoryId: "170", ruleOrder: 1 });
  for (const product of [
    { taxonomyScope: "OZON:OTHER", descriptionCategoryId: "170", typeId: "99" },
    { taxonomyScope: "OZON:DEFAULT", descriptionCategoryId: "171", typeId: "99" },
    { taxonomyScope: "OZON:DEFAULT", descriptionCategoryId: "170", typeId: "100" },
  ]) {
    const result = resolve({
      product: { ...product, categoryAncestors: [], productStyle: "UNKNOWN" },
      rules: [v2Rule(), legacy],
    });
    assert.equal(result.matchedBy, product.descriptionCategoryId === "170" ? "EXACT_CATEGORY" : "DEFAULT");
  }
  const legacyDefaultProduct = rule({ ruleId: "legacy-exact", ruleOrder: 1 });
  assert.deepEqual(resolve({ rules: [legacyDefaultProduct] }), {
    strategyId: "strategy-home-goods",
    strategyVersionId: "strategy-home-goods-v3",
    ruleId: "legacy-exact",
    matchedBy: "EXACT_CATEGORY",
    style: "VISUAL_FIRST",
    textDensityByRole: densities.light,
    evidence: {
      targetDescriptionCategoryId: "category-target",
      matchedValue: "category-target",
      ruleOrder: 1,
    },
  });

  const padded = resolve({
    strategyVersion: { strategyId: " strategy-home-goods ", strategyVersionId: " v3 " },
    product: { descriptionCategoryId: " category-target ", categoryAncestors: [], productStyle: "UNKNOWN" },
    rules: [rule({ ruleId: " padded-rule ", categoryId: " category-target " })],
  });
  assert.equal(padded.strategyId, " strategy-home-goods ");
  assert.equal(padded.strategyVersionId, " v3 ");
  assert.equal(padded.ruleId, " padded-rule ");
  assert.equal(padded.matchedBy, "EXACT_CATEGORY");
});

test("V1 retains the previously accepted large and deep finite JSON success domain while V2 remains bounded", () => {
  const deep = {};
  let cursor = deep;
  for (let depth = 0; depth < 70; depth += 1) {
    cursor.next = {};
    cursor = cursor.next;
  }
  const cases = [
    { main: "x".repeat(100_001) },
    { main: Array.from({ length: 10_001 }, (_, index) => index) },
    { main: deep },
  ];
  for (const textDensityByRole of cases) {
    const result = resolve({ rules: [rule({ textDensityByRole })] });
    assert.deepEqual(result.textDensityByRole, textDensityByRole);
  }

  assert.throws(() => resolve({
    product: {
      taxonomyScope: "OZON:DEFAULT", descriptionCategoryId: "170", typeId: "99",
      categoryAncestors: [], productStyle: "UNKNOWN",
    },
    rules: [v2Rule({ slots: Array.from({ length: 10_001 }, (_, index) => index) })],
  }), { code: "AI_CONTENT_STRATEGY_INVALID" });
});

test("V2 rejects hostile carriers without invoking getters or proxy traps", () => {
  let getterReads = 0;
  const accessor = v2Rule();
  Object.defineProperty(accessor, "sampleSetHash", {
    enumerable: true,
    get() { getterReads += 1; return "a".repeat(64); },
  });
  assert.throws(() => resolve({
    product: { taxonomyScope: "OZON:DEFAULT", descriptionCategoryId: "170", typeId: "99" },
    rules: [accessor],
  }), { code: "AI_CONTENT_STRATEGY_INVALID" });
  assert.equal(getterReads, 0);

  let traps = 0;
  const proxied = new Proxy(v2Rule(), { get() { traps += 1; throw new Error("trap"); } });
  assert.throws(() => resolve({
    product: { taxonomyScope: "OZON:DEFAULT", descriptionCategoryId: "170", typeId: "99" },
    rules: [proxied],
  }), { code: "AI_CONTENT_STRATEGY_INVALID" });
  assert.equal(traps, 0);
});

test("selects the nearest ancestor regardless of rule-array order", () => {
  const result = resolve({
    rules: [
      rule({
        ruleId: "root-rule",
        matchType: "ANCESTOR_CATEGORY",
        categoryId: "category-root",
        ruleOrder: 1,
        style: "PARAMETER_FIRST",
        textDensityByRole: densities.heavy,
      }),
      rule({
        ruleId: "parent-rule",
        matchType: "ANCESTOR_CATEGORY",
        categoryId: "category-parent",
        ruleOrder: 99,
        style: "DEMONSTRATION_FIRST",
        textDensityByRole: densities.medium,
      }),
    ],
  });

  assert.deepEqual(result, {
    strategyId: "strategy-home-goods",
    strategyVersionId: "strategy-home-goods-v3",
    ruleId: "parent-rule",
    matchedBy: "ANCESTOR_CATEGORY",
    style: "DEMONSTRATION_FIRST",
    textDensityByRole: densities.medium,
    evidence: {
      targetDescriptionCategoryId: "category-target",
      matchedValue: "category-parent",
      ancestorDistance: 1,
      ruleOrder: 99,
    },
  });
});

test("breaks equal-priority candidates by numeric ruleOrder and stable rule ID", () => {
  const result = resolve({
    rules: [
      rule({
        ruleId: "z-rule",
        matchType: "ANCESTOR_CATEGORY",
        categoryId: "category-parent",
        ruleOrder: 2,
        style: "PARAMETER_FIRST",
      }),
      rule({
        ruleId: "a-rule",
        matchType: "ANCESTOR_CATEGORY",
        categoryId: "category-parent",
        ruleOrder: 2,
        style: "SPECIFICATION_FIRST",
      }),
      rule({
        ruleId: "later-rule",
        matchType: "ANCESTOR_CATEGORY",
        categoryId: "category-parent",
        ruleOrder: 3,
        style: "DEMONSTRATION_FIRST",
      }),
    ],
  });

  assert.equal(result.ruleId, "a-rule");
  assert.equal(result.style, "SPECIFICATION_FIRST");
});

test("falls back to product style before the balanced default", () => {
  const styleResult = resolve({
    rules: [rule({
      ruleId: "style-rule",
      matchType: "PRODUCT_STYLE",
      productStyle: "TOOL",
      ruleOrder: 5,
      style: "PARAMETER_FIRST",
      textDensityByRole: densities.heavy,
    })],
  });

  assert.deepEqual(styleResult, {
    strategyId: "strategy-home-goods",
    strategyVersionId: "strategy-home-goods-v3",
    ruleId: "style-rule",
    matchedBy: "PRODUCT_STYLE",
    style: "PARAMETER_FIRST",
    textDensityByRole: densities.heavy,
    evidence: {
      targetDescriptionCategoryId: "category-target",
      matchedValue: "TOOL",
      ruleOrder: 5,
    },
  });

  const defaultResult = resolve({
    product: { descriptionCategoryId: "unknown-category", productStyle: "UNKNOWN" },
  });
  assert.deepEqual(defaultResult, {
    strategyId: "strategy-home-goods",
    strategyVersionId: "strategy-home-goods-v3",
    ruleId: null,
    matchedBy: "DEFAULT",
    style: "BALANCED_DEFAULT",
    textDensityByRole: {},
    evidence: {
      targetDescriptionCategoryId: "unknown-category",
      matchedValue: "BALANCED_DEFAULT",
    },
  });
});

test("rejects malformed strategy data and unsupported selected styles with a stable code", () => {
  for (const input of [
    {},
    { strategyVersion, rules: {}, product: {} },
    { strategyVersion: { strategyId: "strategy" }, rules: [], product: {} },
    { strategyVersion, rules: [rule({ style: "MANUAL_OVERRIDE" })], product: {} },
    { strategyVersion, rules: [rule({ ruleOrder: "1" })], product: {} },
    { strategyVersion, rules: [rule({ ruleOrder: 0 })], product: {} },
    { strategyVersion, rules: [rule({ matchType: "ANY" })], product: {} },
    { strategyVersion, rules: [rule({ matchType: "PRODUCT_STYLE", productStyle: "" })], product: {} },
    { strategyVersion, rules: [rule({ textDensityByRole: { main: undefined } })], product: {} },
  ]) {
    assert.throws(
      () => resolveAiContentStrategy(input),
      (error) => error?.code === "AI_CONTENT_STRATEGY_INVALID",
    );
  }
});

test("rejects duplicate rule IDs regardless of candidate order", () => {
  const duplicateRules = [
    rule({ ruleId: "duplicate-rule", ruleOrder: 1, style: "VISUAL_FIRST" }),
    rule({ ruleId: "duplicate-rule", ruleOrder: 1, style: "PARAMETER_FIRST" }),
  ];

  for (const rules of [duplicateRules, [...duplicateRules].reverse()]) {
    assert.throws(
      () => resolve({ rules }),
      (error) => error?.code === "AI_CONTENT_STRATEGY_INVALID",
    );
  }
});

test("rejects cyclic density objects and arrays while accepting shared references", () => {
  const cyclicObject = {};
  cyclicObject.self = cyclicObject;
  const cyclicArray = [];
  cyclicArray.push(cyclicArray);

  for (const textDensityByRole of [
    { main: cyclicObject },
    { main: cyclicArray },
  ]) {
    assert.throws(
      () => resolve({ rules: [rule({ textDensityByRole })] }),
      (error) => error?.code === "AI_CONTENT_STRATEGY_INVALID",
    );
  }

  const sharedDensity = { level: "LIGHT" };
  assert.deepEqual(resolve({ rules: [rule({
    textDensityByRole: { main: sharedDensity, sellingPoint: sharedDensity },
  })] }).textDensityByRole, {
    main: { level: "LIGHT" },
    sellingPoint: { level: "LIGHT" },
  });
});

test("rejects dangerous JSON density keys without changing its prototype", () => {
  const textDensityByRole = JSON.parse(
    '{"__proto__":{"polluted":"yes"},"constructor":{"polluted":"yes"},"prototype":{"polluted":"yes"}}',
  );

  assert.throws(
    () => resolve({ rules: [rule({ textDensityByRole })] }),
    (error) => error?.code === "AI_CONTENT_STRATEGY_INVALID",
  );
  assert.equal(Object.getPrototypeOf(textDensityByRole), Object.prototype);
});

test("does not mutate inputs or alias returned nested JSON", () => {
  const input = {
    strategyVersion: { ...strategyVersion },
    rules: [rule({ textDensityByRole: { main: { level: "LIGHT" } } })],
    product: {
      descriptionCategoryId: "category-target",
      categoryAncestors: [],
      productStyle: "TOOL",
    },
  };
  const before = structuredClone(input);

  const result = resolveAiContentStrategy(input);
  result.textDensityByRole.main.level = "HEAVY";
  result.evidence.matchedValue = "changed";

  assert.deepEqual(input, before);
  assert.equal(input.rules[0].textDensityByRole.main.level, "LIGHT");
  assert.equal(result.evidence.matchedValue, "changed");
});

test("remains pure and imports no application or third-party modules", async () => {
  const source = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("../ai-content-strategy.mjs", import.meta.url), "utf8"),
  );
  assert.doesNotMatch(source, /^\s*import\s+.*from\s+["'](?!node:)/m);
});
