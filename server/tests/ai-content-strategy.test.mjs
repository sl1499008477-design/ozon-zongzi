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

test("remains a pure module without external imports", async () => {
  const source = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("../ai-content-strategy.mjs", import.meta.url), "utf8"),
  );
  assert.doesNotMatch(source, /^\s*import\s/m);
});
