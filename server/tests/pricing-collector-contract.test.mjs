import assert from "node:assert/strict";
import {
  PRICING_COLLECTOR_COMPATIBILITY_GAPS,
  createCollectorPricingService,
  handleCollectorPricingRoute,
  normalizeCollectorPricingInput,
} from "../pricing-routes.mjs";
import { DEFAULT_PRICING_CONFIG } from "../pricing-config-service.mjs";
import { calculatePricing } from "../pricing-engine.mjs";

const closeTo = (actual, expected, epsilon = 0.01) => {
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} should be within ${epsilon} of ${expected}`);
};

const contractConfig = structuredClone(DEFAULT_PRICING_CONFIG);
const resolveContractConfig = async (versionId) => !versionId || versionId === contractConfig.id
  ? structuredClone(contractConfig)
  : null;
const collectorPricingService = createCollectorPricingService({
  getActivePricingConfig: () => resolveContractConfig(),
  getPricingVersion: resolveContractConfig,
  calculateWithActivePricing: async (input) => {
    const config = await resolveContractConfig(input.configVersionId);
    if (!config) throw Object.assign(new Error("算价配置版本不存在"), { status: 404 });
    return { config, result: calculatePricing(config, input) };
  },
});

const normalized = normalizeCollectorPricingInput({
  mode: "profit",
  sellingPriceCny: 200,
  sourcePrice: 100,
  weight: 750,
  length: 600,
  width: 400,
  height: 300,
  internalExpress: "xy",
  rubExpressPrice: 8,
  elsePercent: 4,
});

assert.deepEqual(
  {
    lengthCm: normalized.lengthCm,
    widthCm: normalized.widthCm,
    heightCm: normalized.heightCm,
    weightG: normalized.weightG,
  },
  { lengthCm: 60, widthCm: 40, heightCm: 30, weightG: 750 },
  "collector millimetres must be converted to engine centimetres",
);
assert.equal(normalized.logisticsProvider, "XY");
assert.equal(normalized.domesticShippingCny, 8);
assert.equal(normalized.otherVariableRate, 4);

const explicitCm = normalizeCollectorPricingInput({
  mode: "profit",
  sellingPriceCny: 100,
  lengthCm: 12,
  length: 999,
});
assert.equal(explicitCm.lengthCm, 12, "explicit centimetres take precedence over legacy millimetres");

const profit = await collectorPricingService.calculateOne({
  mode: "profit",
  sellingPriceCny: 200,
  sourcePrice: 100,
  weight: 500,
  length: 100,
  width: 100,
  height: 100,
  internalExpress: "XY",
}, { accountId: "account_contract", storeId: "store_contract" });

assert.equal(profit.schemaVersion, "collector-pricing/v1");
assert.equal(profit.operation, "profit");
assert.equal(profit.config.id, DEFAULT_PRICING_CONFIG.id);
assert.equal(profit.result.mode, "profit");
assert.equal(profit.result.netProfitCny, 59);
assert.equal(profit.compatibility.fbsPrice, profit.result.commissionFeeCny);
assert.equal(profit.compatibility.endDeliveryFee, null);
assert.deepEqual(
  profit.compatibilityGaps.map((gap) => gap.code),
  ["END_DELIVERY_FEE_RULE_MISSING", "GOLDEN_SAMPLE_VALIDATION_PENDING"],
);

const pricing = await collectorPricingService.calculateOne({
  input: {
    mode: "pricing",
    sourcePrice: 100,
    weight: 500,
    logisticsProvider: "XY",
    targetMarginRate: 20,
  },
}, { accountId: "account_contract", storeId: "store_contract" });

assert.equal(pricing.operation, "pricing");
assert.equal(pricing.result.mode, "pricing");
assert.ok(pricing.result.sellingPriceCny > 0);
closeTo(pricing.result.profitMarginRate, 20);

const goodsFilter = await collectorPricingService.calculateOne({
  operation: "goodsFilter",
  task: {
    myProfitPercent: 25,
    internalExpress: "XY",
  },
  item: {
    id: "ozon_goods_filter",
    sourcePrice: 50,
    weight: 300,
  },
}, { accountId: "account_contract", storeId: "store_contract" });
assert.equal(goodsFilter.result.mode, "pricing");
assert.ok(goodsFilter.result.sellingPriceCny > 0);
closeTo(goodsFilter.result.profitMarginRate, 25);

const originFixed = await collectorPricingService.calculateOne({
  operation: "goodsFilter2",
  task: {
    basePriceType: "originSale",
    rejustType: "fixed",
    rejustValue: -100,
    internalExpress: "XY",
  },
  item: {
    id: "ozon_origin_fixed",
    price: 2400,
    sourcePrice: 80,
    weight: 500,
    length: 200,
    width: 150,
    height: 100,
  },
}, { accountId: "account_contract", storeId: "store_contract" });

assert.equal(originFixed.operation, "goodsFilter2");
assert.equal(originFixed.adjustment.basePriceType, "originSale");
assert.equal(originFixed.adjustment.adjustmentType, "fixed");
assert.equal(originFixed.adjustment.adjustedPriceRub, 2300);
assert.equal(originFixed.adjustment.fallbackToBase, false);
assert.ok(
  Math.abs(originFixed.result.sellingPriceRub - 2300) <= originFixed.result.exchangeRate / 200,
  "RUB 输入换算为 CNY 分后，往返误差不能超过半个 CNY 分对应的 RUB 金额",
);
assert.equal(originFixed.compatibility.id, "ozon_origin_fixed");
assert.equal(originFixed.compatibility.resMoney, originFixed.result.sellingPriceCny);
assert.equal(typeof originFixed.compatibility.otherProfitPercent, "number");
assert.equal(typeof originFixed.compatibility.otherProfit, "number");

const followPercent = await collectorPricingService.calculateOne({
  operation: "goodsFilter2",
  task: {
    basePriceType: "followMin",
    rejustType: "precent",
    rejustValue: 10,
  },
  item: {
    id: "ozon_follow_percent",
    price: 1400,
    followMinPrice: 1000,
    sourcePrice: 30,
    weight: 300,
  },
}, { accountId: "account_contract", storeId: "store_contract" });

assert.equal(followPercent.adjustment.basePriceRub, 1000);
assert.equal(followPercent.adjustment.adjustmentTypeInput, "precent");
assert.equal(followPercent.adjustment.adjustedPriceRub, 1100);
assert.ok(
  Math.abs(followPercent.result.sellingPriceRub - 1100) <= followPercent.result.exchangeRate / 200,
  "RUB 输入换算为 CNY 分后，往返误差不能超过半个 CNY 分对应的 RUB 金额",
);

const normalizedPercent = await collectorPricingService.calculateOne({
  operation: "goodsFilter2",
  task: {
    basePriceType: "followMin",
    rejustType: "percent",
    rejustValue: -10,
  },
  item: {
    followMinPrice: 1000,
    sourcePrice: 30,
    weight: 300,
  },
}, { accountId: "account_contract", storeId: "store_contract" });
assert.equal(normalizedPercent.adjustment.adjustmentType, "precent");
assert.equal(normalizedPercent.adjustment.adjustedPriceRub, 900);

const itemDefinedAdjustment = await collectorPricingService.calculateOne({
  item: {
    basePriceType: "originSale",
    rejustType: "fixed",
    rejustValue: 25,
    price: 1000,
    sourcePrice: 20,
    weight: 200,
  },
}, { accountId: "account_contract", storeId: "store_contract" });
assert.equal(itemDefinedAdjustment.operation, "goodsFilter2");
assert.equal(itemDefinedAdjustment.adjustment.adjustedPriceRub, 1025);

const fallback = await collectorPricingService.calculateOne({
  operation: "goodsFilter2",
  task: {
    basePriceType: "originSale",
    rejustType: "fixed",
    rejustValue: -1001,
  },
  item: {
    price: 1000,
    sourcePrice: 10,
    weight: 200,
  },
}, { accountId: "account_contract", storeId: "store_contract" });
assert.equal(fallback.adjustment.attemptedPriceRub, -1);
assert.equal(fallback.adjustment.adjustedPriceRub, 1000);
assert.equal(fallback.adjustment.fallbackToBase, true);

await assert.rejects(
  () => collectorPricingService.calculateOne({
    operation: "goodsFilter2",
    task: { basePriceType: "followMin", rejustType: "fixed", rejustValue: 0 },
    item: { price: 1000, sourcePrice: 10, weight: 200 },
  }),
  (error) => error?.code === "PRICING_INPUT_REQUIRED" && error?.details?.field === "followMin",
);

const routeState = { currentStoreId: "store_route" };
const routeRequest = { method: "POST" };
let routeResponse = null;
let resolvedTaskContext = null;
let resolvedStoreId = null;
const handledLegacy = await handleCollectorPricingRoute(
  routeRequest,
  {},
  new URL("http://localhost/api/auto/filterGoods/goodsFilter2"),
  {
    state: routeState,
    requireAuth: () => ({ id: "account_route" }),
    readBody: () => ({
      taskId: "task_route",
      reqDatas: [{ id: "ozon_route", price: 1500, sourcePrice: 20, weight: 300 }],
    }),
    resolveTask: (taskId, context) => {
      resolvedTaskContext = { taskId, accountId: context.account.id };
      return {
        operatingStoreId: "store_frozen_task",
        basePriceType: "originSale",
        rejustType: "fixed",
        rejustValue: 100,
      };
    },
    resolveStoreId: (storeId) => {
      resolvedStoreId = storeId;
      return storeId;
    },
    service: collectorPricingService,
    sendJson: (_res, status, payload) => {
      routeResponse = { status, payload };
    },
  },
);

assert.equal(handledLegacy, true);
assert.deepEqual(resolvedTaskContext, { taskId: "task_route", accountId: "account_route" });
assert.equal(resolvedStoreId, "store_frozen_task");
assert.equal(routeResponse.status, 200);
assert.equal(routeResponse.payload.code, 0);
assert.equal(routeResponse.payload.data[0].id, "ozon_route");
assert.equal(routeResponse.payload.pricing[0].adjustment.adjustedPriceRub, 1600);

let canonicalResponse = null;
const handledCanonical = await handleCollectorPricingRoute(
  routeRequest,
  {},
  "/pricing/collector/calculate",
  {
    state: routeState,
    requireAuth: () => ({ id: "account_route" }),
    readBody: () => ({
      input: { mode: "profit", sellingPriceCny: 100, purchaseCostCny: 20, weightG: 300 },
    }),
    service: collectorPricingService,
    sendJson: (_res, status, payload) => {
      canonicalResponse = { status, payload };
    },
  },
);
assert.equal(handledCanonical, true);
assert.equal(canonicalResponse.status, 200);
assert.equal(canonicalResponse.payload.ok, true);
assert.equal(canonicalResponse.payload.result.operation, "profit");

assert.equal(
  await handleCollectorPricingRoute(routeRequest, {}, "/unrelated", {
    requireAuth: () => ({ id: "unused" }),
    readBody: () => ({}),
    sendJson: () => {},
  }),
  false,
  "unrelated routes must fall through",
);

assert.equal(PRICING_COLLECTOR_COMPATIBILITY_GAPS.length, 2);
console.log("pricing collector contract tests passed");
