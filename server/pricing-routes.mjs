import {
  calculateWithActivePricing,
  getActivePricingConfig,
  getPricingVersion,
} from "./pricing-config-service.mjs";

const SCHEMA_VERSION = "collector-pricing/v1";
const LEGACY_GOODS_FILTER2_PATH = "/api/auto/filterGoods/goodsFilter2";
const COLLECTOR_CALCULATE_PATHS = new Set([
  "/pricing/collector/calculate",
  "/pricing/collector/goods-filter2",
]);

export const PRICING_COLLECTOR_COMPATIBILITY_GAPS = Object.freeze([
  Object.freeze({
    code: "END_DELIVERY_FEE_RULE_MISSING",
    field: "endDeliveryFee",
    status: "unsupported",
    message: "原服务的尾程派送费公式尚无唯一实现；适配层不会把其他费用静默冒充为尾程派送费。",
  }),
  Object.freeze({
    code: "GOLDEN_SAMPLE_VALIDATION_PENDING",
    field: "pricingResult",
    status: "pending",
    message: "尚缺原服务脱敏输入/输出黄金样例，当前只能验证本地契约与公式，不能声明逐分一致。",
  }),
]);

const hasValue = (value) => value !== undefined && value !== null && value !== "";

function firstValue(...values) {
  return values.find(hasValue);
}

function finiteNumber(value, field, { required = false, minimum = null } = {}) {
  if (!hasValue(value)) {
    if (required) throw badRequest(`${field} 不能为空`, "PRICING_INPUT_REQUIRED", { field });
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw badRequest(`${field} 必须是有效数字`, "PRICING_INPUT_INVALID", { field, value });
  if (minimum !== null && parsed < minimum) {
    throw badRequest(`${field} 不能小于 ${minimum}`, "PRICING_INPUT_OUT_OF_RANGE", { field, value: parsed, minimum });
  }
  return parsed;
}

function badRequest(message, code = "PRICING_COLLECTOR_INVALID_REQUEST", details = {}) {
  return Object.assign(new Error(message), { status: 400, code, details });
}

function mergeDefined(...objects) {
  const merged = {};
  for (const object of objects) {
    if (!object || typeof object !== "object" || Array.isArray(object)) continue;
    for (const [key, value] of Object.entries(object)) {
      if (hasValue(value)) merged[key] = value;
    }
  }
  return merged;
}

function normalizeMode(value) {
  const normalized = String(value || "profit").trim().toLowerCase();
  if (!["profit", "pricing"].includes(normalized)) {
    throw badRequest("mode 仅支持 profit 或 pricing", "PRICING_MODE_UNSUPPORTED", { mode: value });
  }
  return normalized;
}

function normalizeDimensionCm(source, axis) {
  const capitalized = `${axis[0].toUpperCase()}${axis.slice(1)}`;
  const explicitCm = firstValue(
    source[`${axis}Cm`],
    source[`package${capitalized}Cm`],
    source[`package_${axis}_cm`],
  );
  if (hasValue(explicitCm)) return finiteNumber(explicitCm, `${axis}Cm`, { minimum: 0 });

  // 源采集程序的 length / width / height 与 Excel 契约均为毫米。
  const legacyMm = firstValue(
    source[`${axis}Mm`],
    source[`package${capitalized}Mm`],
    source[`package_${axis}_mm`],
    source[`package${capitalized}`],
    source[axis],
  );
  const millimeters = finiteNumber(legacyMm, `${axis}Mm`, { minimum: 0 });
  return millimeters === undefined ? undefined : millimeters / 10;
}

function normalizeFulfillment(value) {
  const normalized = String(value || "RFBS").trim().toUpperCase();
  return normalized || "RFBS";
}

/**
 * Converts the desktop collector field contract into pricing-engine input.
 * Plain length/width/height are intentionally interpreted as millimetres.
 */
export function normalizeCollectorPricingInput(rawInput = {}, task = {}) {
  const nestedInput = rawInput?.input && typeof rawInput.input === "object" ? rawInput.input : {};
  const nestedItem = rawInput?.item && typeof rawInput.item === "object" ? rawInput.item : {};
  const source = mergeDefined(task, rawInput, nestedItem, nestedInput);
  const mode = normalizeMode(firstValue(nestedInput.mode, rawInput.mode, task.mode));

  const normalized = {
    mode,
    configVersionId: firstValue(source.configVersionId, source.pricingConfigVersionId),
    categoryId: String(firstValue(source.categoryId, source.ozonCategoryId, source.category_id, "*") || "*"),
    marketplaceCategoryNameRu: String(firstValue(source.marketplaceCategoryNameRu, source.marketplace_category_ru, source.marketplaceCategoryRu, "") || ""),
    descriptiveTypeNameRu: String(firstValue(source.descriptiveTypeNameRu, source.descriptive_type_ru, source.productTypeNameRu, source.typeNameRu, source.typeName, "") || ""),
    brandName: String(firstValue(source.brandName, source.brand_name, source.brand, "") || ""),
    fulfillmentType: normalizeFulfillment(firstValue(source.fulfillmentType, source.fulfillment_type)),
    warehouseId: String(firstValue(source.warehouseId, source.warehouse_id, "") || ""),
    logisticsProvider: String(firstValue(source.logisticsProvider, source.internalExpress, "XY") || "XY").toUpperCase(),
    routeCode: String(firstValue(source.routeCode, source.logisticsRouteCode, "") || ""),
    purchaseCostCny: finiteNumber(firstValue(source.purchaseCostCny, source.sourcePrice, source.purchasePrice), "purchaseCostCny", { minimum: 0 }) ?? 0,
    sellingPriceCny: finiteNumber(firstValue(source.sellingPriceCny, source.resMoney), "sellingPriceCny", { minimum: 0 }),
    logisticsCostCny: finiteNumber(firstValue(source.logisticsCostCny, source.logisticsMoney), "logisticsCostCny", { minimum: 0 }),
    domesticShippingCny: finiteNumber(firstValue(source.domesticShippingCny, source.rubExpressPrice), "domesticShippingCny", { minimum: 0 }),
    labelingFeeCny: finiteNumber(source.labelingFeeCny, "labelingFeeCny", { minimum: 0 }),
    packagingFeeCny: finiteNumber(source.packagingFeeCny, "packagingFeeCny", { minimum: 0 }),
    operationFeeCny: finiteNumber(source.operationFeeCny, "operationFeeCny", { minimum: 0 }),
    otherFixedFeeCny: finiteNumber(source.otherFixedFeeCny, "otherFixedFeeCny", { minimum: 0 }),
    otherVariableRate: finiteNumber(firstValue(source.otherVariableRate, source.otherFeeRate, source.elsePercent), "otherVariableRate"),
    adRate: finiteNumber(source.adRate, "adRate"),
    withdrawalRate: finiteNumber(source.withdrawalRate, "withdrawalRate"),
    returnLossRate: finiteNumber(source.returnLossRate, "returnLossRate"),
    targetMarginRate: finiteNumber(firstValue(source.targetMarginRate, source.myProfitPercent), "targetMarginRate"),
    frontendDiscountRate: finiteNumber(source.frontendDiscountRate, "frontendDiscountRate"),
    exchangeRate: finiteNumber(source.exchangeRate, "exchangeRate", { minimum: 0 }),
    weightG: finiteNumber(firstValue(source.weightG, source.packageWeightG, source.package_weight_g, source.weight), "weightG", { minimum: 0 }) ?? 0,
    lengthCm: normalizeDimensionCm(source, "length"),
    widthCm: normalizeDimensionCm(source, "width"),
    heightCm: normalizeDimensionCm(source, "height"),
  };

  return Object.fromEntries(Object.entries(normalized).filter(([, value]) => value !== undefined));
}

function normalizeAdjustment(task = {}, item = {}, raw = {}) {
  const basePriceType = String(firstValue(raw.basePriceType, task.basePriceType, item.basePriceType, "originSale"));
  if (!["originSale", "followMin"].includes(basePriceType)) {
    throw badRequest("basePriceType 仅支持 originSale 或 followMin", "PRICING_BASE_PRICE_UNSUPPORTED", { basePriceType });
  }

  const adjustmentTypeInput = String(firstValue(raw.rejustType, task.rejustType, item.rejustType, "fixed"));
  const adjustmentType = adjustmentTypeInput === "percent" ? "precent" : adjustmentTypeInput;
  if (!["fixed", "precent"].includes(adjustmentType)) {
    throw badRequest("rejustType 仅支持 fixed 或 precent", "PRICING_ADJUSTMENT_UNSUPPORTED", { rejustType: adjustmentTypeInput });
  }

  const baseCandidate = basePriceType === "originSale"
    ? firstValue(item.originSaleRub, item.sellingPriceRub, item.price, item.price1, raw.originSaleRub)
    : firstValue(item.followMinPrice, item.followSellMinPrice, item.lowestFollowerPrice, item.followMinPrice1, raw.followMinPrice);
  const basePriceRub = finiteNumber(baseCandidate, basePriceType, { required: true, minimum: 0 });
  if (!(basePriceRub > 0)) {
    throw badRequest("定价基准必须大于 0 卢布", "PRICING_BASE_PRICE_INVALID", { basePriceType, basePriceRub });
  }
  const adjustmentValue = finiteNumber(firstValue(raw.rejustValue, task.rejustValue, item.rejustValue, 0), "rejustValue", { required: true });
  const attemptedPriceRub = adjustmentType === "fixed"
    ? basePriceRub + adjustmentValue
    : basePriceRub * (1 + adjustmentValue / 100);
  const fallbackToBase = attemptedPriceRub <= 0;
  const adjustedPriceRub = fallbackToBase ? basePriceRub : attemptedPriceRub;

  return {
    basePriceType,
    basePriceRub,
    adjustmentType,
    adjustmentTypeInput,
    adjustmentValue,
    attemptedPriceRub,
    adjustedPriceRub,
    fallbackToBase,
  };
}

function configSummary(config = {}) {
  return {
    id: config.id,
    versionNo: config.versionNo,
    configHash: config.configHash,
    scopeType: config.scopeType,
    scopeId: config.scopeId,
    effectiveFrom: config.effectiveFrom,
    effectiveTo: config.effectiveTo,
    exchangeRate: config.exchangeRate ? {
      baseCurrency: config.exchangeRate.baseCurrency,
      quoteCurrency: config.exchangeRate.quoteCurrency,
      rate: Number(config.exchangeRate.rate),
      source: config.exchangeRate.source,
      quotedAt: config.exchangeRate.quotedAt,
    } : null,
  };
}

function otherFees(result) {
  return Number(result.adFeeCny || 0) +
    Number(result.withdrawalFeeCny || 0) +
    Number(result.returnLossCny || 0) +
    Number(result.otherVariableFeeCny || 0);
}

function roundMoney(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

function legacyFields(sourceItem, result, adjustment, comparisonResult = null) {
  return {
    ...sourceItem,
    fbsPrice: result.commissionFeeCny,
    logisticsMoney: result.logistics?.amount ?? null,
    // Deliberately null until the original tail-mile formula is recovered.
    endDeliveryFee: null,
    elsePrice: roundMoney(otherFees(result)),
    resMoney: result.sellingPriceCny,
    estimateMoney: result.sellingPriceCny,
    estimateMoneyRub: result.sellingPriceRub,
    myActualProfitPercent: result.profitMarginRate,
    myProfitMargin: result.profitMarginRate,
    myProfit: result.netProfitCny,
    price1: firstValue(sourceItem.price1, sourceItem.price),
    oPrice1: firstValue(sourceItem.oPrice1, sourceItem.oPrice),
    followMinPrice1: firstValue(sourceItem.followMinPrice1, sourceItem.followMinPrice),
    otherProfitPercent: firstValue(sourceItem.otherProfitPercent, comparisonResult?.profitMarginRate),
    otherProfit: firstValue(sourceItem.otherProfit, comparisonResult?.netProfitCny),
    pricingConfigVersionId: result.configVersionId,
    pricingMode: result.mode,
    pricingAdjustment: adjustment,
  };
}

async function resolveAuthoritativeConfig(input, context, dependencies) {
  const config = input.configVersionId
    ? await dependencies.getPricingVersion(input.configVersionId)
    : await dependencies.getActivePricingConfig(context);
  if (!config) {
    throw Object.assign(new Error("算价配置版本不存在"), {
      status: 404,
      code: "PRICING_CONFIG_NOT_FOUND",
      details: { configVersionId: input.configVersionId || null },
    });
  }
  return config;
}

/**
 * Service facade used by collector HTTP routes and desktop execution code.
 * Config selection and calculation are delegated to pricing-config-service.
 */
export function createCollectorPricingService(overrides = {}) {
  const dependencies = {
    calculateWithActivePricing,
    getActivePricingConfig,
    getPricingVersion,
    ...overrides,
  };

  async function calculateOne(raw = {}, context = {}, options = {}) {
    const task = options.task || raw.task || {};
    const sourceItem = options.item || raw.item || raw;
    const operation = options.operation || raw.operation || sourceItem.operation ||
      (raw.basePriceType || sourceItem.basePriceType || task.basePriceType ? "goodsFilter2" : undefined);
    let normalizedInput = normalizeCollectorPricingInput({ ...raw, item: sourceItem }, task);
    let adjustment = null;
    if (operation === "goodsFilter" || operation === "pricing") {
      normalizedInput = { ...normalizedInput, mode: "pricing" };
    }

    if (operation === "goodsFilter2") {
      adjustment = normalizeAdjustment(task, sourceItem, raw);
      const config = await resolveAuthoritativeConfig(normalizedInput, context, dependencies);
      const exchangeRate = finiteNumber(
        firstValue(normalizedInput.exchangeRate, config.exchangeRate?.rate),
        "exchangeRate",
        { required: true, minimum: 0 },
      );
      if (!(exchangeRate > 0)) throw badRequest("汇率必须大于 0", "PRICING_EXCHANGE_RATE_INVALID");
      normalizedInput = {
        ...normalizedInput,
        mode: "profit",
        exchangeRate,
        sellingPriceCny: adjustment.adjustedPriceRub / exchangeRate,
        configVersionId: config.id,
      };
    }

    const { config, result } = await dependencies.calculateWithActivePricing(normalizedInput, context);
    let comparisonResult = null;
    if (operation === "goodsFilter2") {
      const comparisonPriceRub = finiteNumber(
        firstValue(sourceItem.price1, sourceItem.price, sourceItem.originSaleRub),
        "comparisonPriceRub",
        { minimum: 0 },
      );
      if (comparisonPriceRub > 0) {
        const comparison = await dependencies.calculateWithActivePricing({
          ...normalizedInput,
          mode: "profit",
          configVersionId: config.id,
          sellingPriceCny: comparisonPriceRub / result.exchangeRate,
        }, context);
        comparisonResult = comparison.result;
      }
    }
    const compatibility = legacyFields(sourceItem, result, adjustment, comparisonResult);
    return {
      schemaVersion: SCHEMA_VERSION,
      operation: operation || result.mode,
      input: normalizedInput,
      adjustment,
      result,
      config: configSummary(config),
      compatibility,
      compatibilityGaps: PRICING_COLLECTOR_COMPATIBILITY_GAPS,
    };
  }

  async function calculateRequest(body = {}, context = {}, options = {}) {
    const task = options.task || body.task || {};
    const items = Array.isArray(body.reqDatas)
      ? body.reqDatas
      : Array.isArray(body.items)
        ? body.items
        : [body.item || body.input || body];
    const operation = options.operation || body.operation || (options.legacyGoodsFilter2 ? "goodsFilter2" : undefined);
    return Promise.all(items.map((item) => calculateOne(body, context, { task, item, operation })));
  }

  return Object.freeze({ calculateOne, calculateRequest });
}

export const collectorPricingService = createCollectorPricingService();

function routePath(url) {
  if (typeof url === "string") return new URL(url, "http://localhost").pathname;
  return url?.pathname || "";
}

function sendRouteError(sendJson, res, error, legacy) {
  const status = Number(error?.status || 400);
  const payload = legacy
    ? { code: status, message: error?.message || "算价失败", data: [], errorCode: error?.code || "PRICING_COLLECTOR_ERROR", details: error?.details || {} }
    : { ok: false, message: error?.message || "算价失败", code: error?.code || "PRICING_COLLECTOR_ERROR", details: error?.details || {} };
  sendJson(res, status, payload);
}

/**
 * Drop-in handler for server/index.mjs. It intentionally receives HTTP helpers
 * as dependencies so this module does not import the monolithic server entry.
 * Returns true only when the request path belongs to this adapter.
 */
export async function handleCollectorPricingRoute(req, res, url, options = {}) {
  const pathname = routePath(url);
  const legacy = pathname === LEGACY_GOODS_FILTER2_PATH;
  if (!legacy && !COLLECTOR_CALCULATE_PATHS.has(pathname)) return false;

  const { requireAuth, readBody, sendJson, state, resolveTask } = options;
  const service = options.service || collectorPricingService;
  if (typeof requireAuth !== "function" || typeof readBody !== "function" || typeof sendJson !== "function") {
    throw new TypeError("handleCollectorPricingRoute 缺少 requireAuth/readBody/sendJson 依赖");
  }
  if (req.method !== "POST") {
    sendJson(res, 405, legacy
      ? { code: 405, message: "仅支持 POST", data: [] }
      : { ok: false, code: "METHOD_NOT_ALLOWED", message: "仅支持 POST" });
    return true;
  }

  try {
    const account = await requireAuth(req, state);
    const body = await readBody(req);
    let task = body.task || null;
    if (!task && body.taskId && typeof resolveTask === "function") {
      task = await resolveTask(body.taskId, { account, state, req });
    }
    if (legacy && body.taskId && !task) {
      throw badRequest("goodsFilter2 需要可解析的 taskId 或内嵌 task", "PRICING_TASK_NOT_FOUND", { taskId: body.taskId });
    }
    const requestedStoreId = String(
      body.operatingStoreId
      || task?.operatingStoreId
      || body.storeId
      || task?.storeId
      || state?.currentStoreId
      || "",
    );
    const storeId = typeof options.resolveStoreId === "function"
      ? await options.resolveStoreId(requestedStoreId, { account, state, req, body })
      : requestedStoreId;
    const context = { accountId: account?.id || "", storeId };
    const calculated = await service.calculateRequest(body, context, {
      task: task || {},
      legacyGoodsFilter2: legacy || pathname.endsWith("/goods-filter2"),
    });

    if (legacy) {
      sendJson(res, 200, {
        code: 0,
        message: "success",
        data: calculated.map((entry) => entry.compatibility),
        pricing: calculated,
      });
    } else {
      sendJson(res, 200, {
        ok: true,
        data: calculated,
        result: calculated.length === 1 ? calculated[0] : undefined,
      });
    }
  } catch (error) {
    sendRouteError(sendJson, res, error, legacy);
  }
  return true;
}
