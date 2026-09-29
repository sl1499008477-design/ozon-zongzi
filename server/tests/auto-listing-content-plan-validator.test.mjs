import assert from "node:assert/strict";
import test from "node:test";

import { diagnoseContentPlan, validateContentPlan } from "../auto-listing-content-planner.mjs";

const PROHIBITED = ["CERTIFICATION", "MEDICAL_BENEFIT", "UNLISTED_ACCESSORIES", "WARRANTY"];
const roles = {
  MAIN: 1, SELLING_POINT: 1, INFOGRAPHIC: 1, SCENE: 1, DETAIL: 1, SPECIFICATION: 1,
};
const densities = {
  MAIN: "NONE", SELLING_POINT: "LIGHT", DETAIL: "LIGHT", SCENE: "LIGHT",
  SPECIFICATION: "MEDIUM", INFOGRAPHIC: "LIGHT",
};
const facts = [
  { factId: "fact-name", kind: "IDENTITY_NAME", value: "商品 A", visualGroupKeys: [] },
  { factId: "fact-color", kind: "COLOR", value: "Красный", visualGroupKeys: ["group-a"] },
  { factId: "fact-height", kind: "DIMENSION_HEIGHT", value: "10 cm", visualGroupKeys: ["group-a"] },
];
const plannerContext = {
  plannerInput: {
    contractVersion: "AUTO_LISTING_CONTENT_PLAN_INPUT_V1",
    factRegistry: facts,
    strategy: {},
    textDensityByRole: densities,
    requestedRoleCounts: roles,
    imagesPerVisualGroup: 6,
    visualGroups: [{
      visualGroupKey: "group-a",
      requiredPreserve: ["商品 A"],
      referenceImages: [{ assetId: "asset-a" }],
      factEvidence: facts,
    }],
    language: "ru", ratio: "3:4", resolution: "1K", quality: "Medium",
    prohibitedClaims: PROHIBITED,
    profile: { id: "profile-a", configVersion: 1 },
    plannerModel: "planner-model", promptTemplateVersion: "planner-v1", regeneration: null,
  },
};

function slot(role, order, occurrence, claims = []) {
  return {
    slotKey: `group-a:${role.toLowerCase().replaceAll("_", "-")}:${String(occurrence).padStart(2, "0")}`,
    visualGroupKey: "group-a", role, order, textDensity: densities[role], claims,
    sourceFactIds: ["fact-name", "fact-color", "fact-height"],
    referenceAssetIds: ["asset-a"], preserve: ["商品 A"], prohibitedClaims: PROHIBITED,
  };
}

function validPlan() {
  return {
    version: 1, language: "ru", slots: [
      slot("MAIN", 1, 1),
      slot("SELLING_POINT", 2, 1, [{ text: "Красный", claimType: "COLOR", sourceFactIds: ["fact-color"] }]),
      slot("DETAIL", 3, 1),
      slot("SCENE", 4, 1),
      slot("SPECIFICATION", 5, 1),
      slot("INFOGRAPHIC", 6, 1, [{ text: "Высота 10 см", claimType: "DIMENSION_HEIGHT", sourceFactIds: ["fact-height"] }]),
    ],
  };
}

test("validator accepts both historical V1 slots and closed V2 role metadata", () => {
  assert.doesNotThrow(() => validateContentPlan({ plan: validPlan(), plannerContext }));
  const plan = validPlan();
  plan.version = 2;
  plan.slots = plan.slots.map((entry) => ({
    ...entry,
    requestedRole: entry.role,
    substitutionReasonCode: null,
  }));
  assert.doesNotThrow(() => validateContentPlan({ plan, plannerContext }));
});

test("V6 uses its fixed image order without changing historical planner order", () => {
  const context = structuredClone(plannerContext);
  context.plannerInput.promptTemplateVersion = "AUTO_LISTING_CONTENT_PLAN_FILL_V6";
  const plan = validPlan();
  const order = ["MAIN", "SELLING_POINT", "INFOGRAPHIC", "SCENE", "DETAIL", "SPECIFICATION"];
  plan.slots = order.map((role, index) => ({
    ...plan.slots.find((entry) => entry.role === role), order: index + 1,
  }));
  assert.equal(diagnoseContentPlan({ plan, plannerContext: context }).status, "ACCEPTED");
  assert.equal(diagnoseContentPlan({ plan, plannerContext }).status, "REJECTED");
});

const mutated = (change) => {
  const plan = structuredClone(validPlan());
  change(plan);
  return plan;
};

test("diagnosis identifies the exact slot, claim, field, and business-rule family", () => {
  const cases = [
    [mutated((plan) => plan.slots.pop()), "SLOT_COUNT_MISMATCH", null, "slots"],
    [mutated((plan) => { plan.slots[1].order = 99; }), "SLOT_ORDER_MISMATCH", "group-a:selling-point:01", "order"],
    [mutated((plan) => { plan.slots[1].role = "DETAIL"; }), "ROLE_COUNT_MISMATCH", "group-a:selling-point:01", "role"],
    [mutated((plan) => { plan.slots[1].referenceAssetIds = ["foreign"]; }), "REFERENCE_ASSET_OUT_OF_SCOPE", "group-a:selling-point:01", "referenceAssetIds"],
    [mutated((plan) => { plan.slots[1].claims[0].sourceFactIds = ["missing"]; }), "SOURCE_FACT_NOT_FOUND", "group-a:selling-point:01", "claims[0].sourceFactIds"],
    [mutated((plan) => { plan.slots[5].claims[0].text = "Высота 999 см"; }), "NUMERIC_EVIDENCE_MISMATCH", "group-a:infographic:01", "claims[0].text"],
    [mutated((plan) => { plan.slots[5].claims[0].text = "Высота 10 кг"; }), "NUMERIC_EVIDENCE_MISMATCH", "group-a:infographic:01", "claims[0].text"],
    [mutated((plan) => { plan.slots[1].claims[0].text = "Гарантия 10 лет"; }), "PROHIBITED_CLAIM", "group-a:selling-point:01", "claims[0].text"],
    [mutated((plan) => { plan.slots[1].claims[0].text = "Best red"; }), "RUSSIAN_TEXT_REQUIRED", "group-a:selling-point:01", "claims[0].text"],
  ];
  for (const [plan, code, slotKey, field] of cases) {
    const result = diagnoseContentPlan({ plan, plannerContext });
    assert.equal(result.status, "REJECTED");
    assert.equal(result.validatorVersion, "AUTO_LISTING_CONTENT_PLAN_VALIDATOR_V1");
    assert.ok(result.issues.some((issue) => issue.code === code
      && (slotKey === null || issue.slotKey === slotKey) && issue.field === field), code);
    assert.throws(() => validateContentPlan({ plan, plannerContext }), {
      code: "AUTO_LISTING_CONTENT_PLAN_INVALID",
    });
  }
});

test("accepted diagnosis returns a detached recursively frozen normalized plan", () => {
  const plan = validPlan();
  const result = diagnoseContentPlan({ plan, plannerContext });
  assert.equal(result.status, "ACCEPTED");
  assert.deepEqual(result.issues, []);
  assert.notEqual(result.plan, plan);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.plan));
  assert.ok(Object.isFrozen(result.plan.slots[0]));
  assert.equal(Object.isFrozen(plan), false);
});

test("accepts an extractive identity phrase with normalized watt spacing but rejects new facts", () => {
  const context = structuredClone(plannerContext);
  context.plannerInput.factRegistry[0].value =
    "Терморегулятор, термостат до 3500Вт Для теплого пола, белый матовый";
  const plan = validPlan();
  plan.slots[1].claims[0] = {
    text: "Терморегулятор до 3500 Вт",
    claimType: "IDENTITY_NAME",
    sourceFactIds: ["fact-name"],
  };

  assert.equal(diagnoseContentPlan({ plan, plannerContext: context }).status, "ACCEPTED");

  for (const unsupported of [
    "Сенсорный терморегулятор до 3500 Вт",
    "Терморегулятор до 3600 Вт",
    "Терморегулятор до 3500 В",
  ]) {
    const invalid = structuredClone(plan);
    invalid.slots[1].claims[0].text = unsupported;
    assert.equal(diagnoseContentPlan({ plan: invalid, plannerContext: context }).status, "REJECTED", unsupported);
  }
});

test("accepts an exact cited alphanumeric model fact but rejects a changed model identifier", () => {
  const context = structuredClone(plannerContext);
  context.plannerInput.factRegistry.push({
    factId: "fact-model",
    kind: "ATTRIBUTE:model",
    value: "Название модели (для объединения в одну карточку): F404020A",
    visualGroupKeys: ["group-a"],
  });
  const plan = validPlan();
  plan.slots[2].sourceFactIds.push("fact-model");
  plan.slots[2].claims = [{
    text: "Название модели (для объединения в одну карточку): F404020A",
    claimType: "ATTRIBUTE:model",
    sourceFactIds: ["fact-model"],
  }];

  assert.equal(diagnoseContentPlan({ plan, plannerContext: context }).status, "ACCEPTED");

  plan.slots[2].claims[0].text = "Название модели (для объединения в одну карточку): F404021A";
  assert.equal(diagnoseContentPlan({ plan, plannerContext: context }).status, "REJECTED");
});

test("hostile carriers fail closed without running getters or proxy traps", () => {
  let getterCalls = 0;
  let trapCalls = 0;
  const accessorPlan = validPlan();
  Object.defineProperty(accessorPlan.slots[0], "role", {
    enumerable: true, get() { getterCalls += 1; return "MAIN"; },
  });
  const proxyPlan = new Proxy(validPlan(), {
    getPrototypeOf() { trapCalls += 1; return Object.prototype; },
    ownKeys() { trapCalls += 1; return []; },
  });
  const revocable = Proxy.revocable(validPlan(), {});
  revocable.revoke();
  const revoked = revocable.proxy;
  const custom = validPlan();
  Object.setPrototypeOf(custom.slots, {});
  const dangerous = validPlan();
  Object.defineProperty(dangerous, "__proto__", { enumerable: true, value: "blocked" });
  const symbolKey = validPlan();
  symbolKey.slots[0][Symbol("hidden")] = true;
  const arrayExtra = validPlan();
  arrayExtra.slots.extra = true;
  const cycle = validPlan();
  cycle.slots[0].claims.push(cycle);
  const oversized = validPlan();
  oversized.slots[1].claims[0].text = "x".repeat(2_000_001);
  for (const plan of [accessorPlan, proxyPlan, revoked, custom, dangerous, symbolKey, arrayExtra, cycle, oversized]) {
    const result = diagnoseContentPlan({ plan, plannerContext });
    assert.equal(result.status, "REJECTED");
    assert.equal(result.issues[0].code, "CONTENT_PLAN_CARRIER_INVALID");
    assert.equal(result.plan, null);
  }
  assert.equal(getterCalls, 0);
  assert.equal(trapCalls, 0);
});

test("issues are bounded and summaries never expose credential-like source values", () => {
  const plan = validPlan();
  plan.slots = Array.from({ length: 150 }, (_, index) => ({
    ...structuredClone(plan.slots[1]),
    slotKey: `slot-${index}`,
    referenceAssetIds: [`sk-proj-secret-${index}`],
  }));
  const result = diagnoseContentPlan({ plan, plannerContext });
  assert.equal(result.status, "REJECTED");
  assert.equal(result.issues.length, 100);
  assert.doesNotMatch(JSON.stringify(result.issues), /sk-proj-secret/iu);
});
