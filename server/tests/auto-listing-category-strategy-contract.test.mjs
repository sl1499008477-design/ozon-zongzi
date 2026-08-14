import assert from "node:assert/strict";
import test from "node:test";
import {
  CATEGORY_STRATEGY_DRAFT_STATES,
  projectCategoryStrategyDraft,
  projectCategoryStrategyGuidanceV2,
  projectCategoryStrategyScope,
  validateCategoryStrategySamples,
} from "../auto-listing-category-strategy-contract.mjs";

const scope = Object.freeze({
  accountId: "account-a",
  taxonomyScope: "OZON:DEFAULT",
  descriptionCategoryId: 17028922,
  typeId: 91542,
});

function makeSamples(count, overrides = {}) {
  return Array.from({ length: count }, (_, index) => ({
    sku: `sku-${index + 1}`,
    images: [{ imageId: `image-${index + 1}-1` }],
    ...overrides,
  }));
}

function draft(status, previousStatus = null) {
  return {
    draftId: "draft-a",
    scope,
    draftVersion: 1,
    status,
    previousStatus,
    sampleCount: status === "COLLECTING" ? 0 : 5,
    guidance: status === "DRAFT_READY" || status === "PUBLISHED" ? guidance() : null,
  };
}

function guidance() {
  return {
    overallStyle: "Clean editorial product photography",
    prohibitedPatterns: ["competitor branding"],
    roles: Object.fromEntries([
      ["MAIN", "centered product hero"],
      ["SELLING_POINT", "single product benefit"],
      ["DETAIL", "close material detail"],
      ["SCENE", "credible use context"],
      ["SPECIFICATION", "clear dimensions"],
      ["INFOGRAPHIC", "scannable facts"],
    ].map(([role, composition]) => [role, {
      composition,
      background: "clean neutral background",
      textDensity: role === "MAIN" ? "NONE" : "LIGHT",
      layout: "product remains the visual focus",
    }])),
  };
}

test("scope requires the exact four-key account category identity", () => {
  assert.deepEqual(projectCategoryStrategyScope(scope), scope);
  assert.throws(() => projectCategoryStrategyScope({
    accountId: "account-a", taxonomyScope: "OZON:DEFAULT", descriptionCategoryId: 17028922,
  }), { code: "AUTO_LISTING_CATEGORY_STRATEGY_CONTRACT_INVALID" });
});

test("sample set accepts 5 to 20 unique sku and at most six images each", () => {
  assert.throws(() => validateCategoryStrategySamples(makeSamples(4)), {
    code: "AUTO_LISTING_CATEGORY_STRATEGY_SAMPLE_COUNT_INVALID",
  });
  assert.equal(validateCategoryStrategySamples(makeSamples(5)).length, 5);
  assert.throws(() => validateCategoryStrategySamples(makeSamples(5, { sku: "same" })), {
    code: "AUTO_LISTING_CATEGORY_STRATEGY_CONTRACT_INVALID",
  });
  assert.throws(() => validateCategoryStrategySamples(makeSamples(5, {
    images: Array.from({ length: 7 }, (_, index) => ({ imageId: `image-${index}` })),
  })), { code: "AUTO_LISTING_CATEGORY_STRATEGY_CONTRACT_INVALID" });
});

test("draft state machine permits only the closed happy path and safe review boundary", () => {
  assert.deepEqual(CATEGORY_STRATEGY_DRAFT_STATES, [
    "COLLECTING", "SAMPLES_READY", "ANALYZING", "DRAFT_READY", "PUBLISHED", "NEEDS_REVIEW",
  ]);
  const path = ["COLLECTING", "SAMPLES_READY", "ANALYZING", "DRAFT_READY", "PUBLISHED"];
  for (let index = 0; index < path.length; index += 1) {
    const projected = projectCategoryStrategyDraft(draft(path[index], path[index - 1] ?? null));
    assert.equal(projected.status, path[index]);
    assert.equal(Object.hasOwn(projected, "previousStatus"), false);
  }
  for (const status of path.slice(0, -1)) {
    assert.equal(projectCategoryStrategyDraft(draft("NEEDS_REVIEW", status)).status, "NEEDS_REVIEW");
  }
  assert.throws(() => projectCategoryStrategyDraft(draft("COLLECTING", "PUBLISHED")), {
    code: "AUTO_LISTING_CATEGORY_STRATEGY_CONTRACT_INVALID",
  });
});

test("guidance defines every role without image-count controls", () => {
  const projected = projectCategoryStrategyGuidanceV2(guidance());
  assert.deepEqual(Object.keys(projected.roles), [
    "MAIN", "SELLING_POINT", "DETAIL", "SCENE", "SPECIFICATION", "INFOGRAPHIC",
  ]);
  for (const role of Object.values(projected.roles)) {
    assert.deepEqual(Object.keys(role), ["composition", "background", "textDensity", "layout"]);
  }
  assert.throws(() => projectCategoryStrategyGuidanceV2({ ...guidance(), roles: {
    ...guidance().roles, MAIN: { ...guidance().roles.MAIN, imageCount: 1 },
  } }), { code: "AUTO_LISTING_CATEGORY_STRATEGY_CONTRACT_INVALID" });
});

test("public projectors freeze outputs and reject hostile carriers before user code runs", () => {
  let getterReads = 0;
  const getter = {};
  Object.defineProperty(getter, "accountId", { enumerable: true, get() { getterReads += 1; return "account-a"; } });
  let proxyTraps = 0;
  const trappedProxy = new Proxy(scope, {
    getOwnPropertyDescriptor() { proxyTraps += 1; return undefined; },
    ownKeys() { proxyTraps += 1; return []; },
  });
  for (const input of [
    new Proxy(scope, {}),
    trappedProxy,
    getter,
    Object.assign(Object.create({}), scope),
    { ...scope, __proto__: { polluted: true } },
    { ...scope, extra: "no" },
  ]) assert.throws(() => projectCategoryStrategyScope(input), {
    code: "AUTO_LISTING_CATEGORY_STRATEGY_CONTRACT_INVALID",
  });
  assert.equal(getterReads, 0);
  assert.equal(proxyTraps, 0);
  const projected = validateCategoryStrategySamples(makeSamples(5));
  assert.equal(Object.isFrozen(projected), true);
  assert.equal(Object.isFrozen(projected[0]), true);
});

test("unsafe depth, size, symbols, and revoked proxy remain closed contract errors", () => {
  const revoked = Proxy.revocable(scope, {});
  revoked.revoke();
  const tooDeep = { ...scope };
  let cursor = tooDeep;
  for (let index = 0; index < 65; index += 1) {
    cursor.next = {};
    cursor = cursor.next;
  }
  for (const input of [
    revoked.proxy,
    { ...scope, [Symbol("x")]: true },
    { ...scope, accountId: "a".repeat(2_001) },
    tooDeep,
  ]) assert.throws(() => projectCategoryStrategyScope(input), {
    code: "AUTO_LISTING_CATEGORY_STRATEGY_CONTRACT_INVALID",
  });
});
