const num = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const roundDivide = (numerator, denominator) => {
  if (denominator === 0n) throw new Error("除数不能为 0");
  const negative = (numerator < 0n) !== (denominator < 0n);
  const left = numerator < 0n ? -numerator : numerator;
  const right = denominator < 0n ? -denominator : denominator;
  const rounded = (left + right / 2n) / right;
  return negative ? -rounded : rounded;
};

const ceilDivide = (numerator, denominator) => {
  if (numerator < 0n || denominator <= 0n) {
    throw new Error("向上取整除法只接受非负被除数和正除数");
  }
  return (numerator + denominator - 1n) / denominator;
};

const scaledInteger = (value, scale = 2) => {
  const text = String(value ?? "").trim().replace(",", ".");
  const match = text.match(/^([+-]?)(\d+)(?:\.(\d*))?$/);
  if (!match) return 0n;
  const sign = match[1] === "-" ? -1n : 1n;
  const factor = 10n ** BigInt(scale);
  const fraction = match[3] || "";
  const kept = fraction.slice(0, scale).padEnd(scale, "0");
  const roundingDigit = Number(fraction[scale] || "0");
  return sign * (
    BigInt(match[2]) * factor
    + BigInt(kept || "0")
    + (roundingDigit >= 5 ? 1n : 0n)
  );
};

const minorNumber = (value) => Number(value) / 100;
const moneyMinor = (value) => scaledInteger(value, 2);
const money = (value) => minorNumber(moneyMinor(value));
const rateBps = (value) => scaledInteger(value, 2);
const feeMinor = (amountMinor, percentage) =>
  roundDivide(amountMinor * rateBps(percentage), 10_000n);
const exchangeMinor = (cnyMinor, exchangeRate) =>
  roundDivide(cnyMinor * scaledInteger(exchangeRate, 6), 1_000_000n);

function ruleMatches(rule, input) {
  const category = String(input.categoryId || "*");
  const fulfillment = String(input.fulfillmentType || "RFBS").toUpperCase();
  return ["*", category].includes(String(rule.ozonCategoryId || "*")) &&
    ["*", "ALL", fulfillment].includes(String(rule.fulfillmentType || "RFBS").toUpperCase());
}

function matchingCommissionRules(config, input) {
  const rules = (config.commissionRules || []).filter((rule) => ruleMatches(rule, input));
  return rules.sort((left, right) => {
    const leftExact = String(left.ozonCategoryId || "*") === String(input.categoryId || "*") ? 0 : 1;
    const rightExact = String(right.ozonCategoryId || "*") === String(input.categoryId || "*") ? 0 : 1;
    return leftExact - rightExact || num(left.priority, 100) - num(right.priority, 100) || num(left.minPriceRub) - num(right.minPriceRub);
  });
}

function commissionForRub(config, input, priceRubMinor) {
  const rules = matchingCommissionRules(config, input);
  const found = rules.find((rule) => {
    const min = moneyMinor(rule.minPriceRub);
    const max = rule.maxPriceRub === null || rule.maxPriceRub === undefined || rule.maxPriceRub === ""
      ? null
      : moneyMinor(rule.maxPriceRub);
    return priceRubMinor >= min && (max === null || priceRubMinor <= max);
  });
  if (!found) {
    throw new Error(
      `没有匹配的佣金规则：类目 ${input.categoryId || "*"} / ${input.fulfillmentType || "RFBS"} / ₽${minorNumber(priceRubMinor)}`,
    );
  }
  return { rule: found, commissionRate: num(found.commissionRate) };
}

function dimensionsValid(rule, input) {
  const length = num(input.lengthCm);
  const width = num(input.widthCm);
  const height = num(input.heightCm);
  const longest = Math.max(length, width, height);
  const sum = length + width + height;
  if (num(rule.maxLengthCm) > 0 && longest > num(rule.maxLengthCm)) return false;
  if (num(rule.maxDimensionSumCm) > 0 && sum > num(rule.maxDimensionSumCm)) return false;
  return true;
}

function calculateLogistics(config, input) {
  if (input.logisticsCostCny !== undefined && input.logisticsCostCny !== null && input.logisticsCostCny !== "") {
    const amountMinor = moneyMinor(input.logisticsCostCny);
    return {
      amount: minorNumber(amountMinor),
      amountMinor: String(amountMinor),
      currencyCode: "CNY",
      source: "manual",
      rule: null,
      actualWeightG: num(input.weightG),
      billableWeightG: num(input.weightG),
    };
  }
  const provider = String(input.logisticsProvider || "XY").toUpperCase();
  const route = String(input.routeCode || "");
  const warehouseId = String(input.warehouseId || "");
  const actualWeightG = Math.max(0, num(input.weightG));
  const candidates = (config.logisticsRules || []).filter((rule) => {
    if (String(rule.provider || "").toUpperCase() !== provider) return false;
    if (rule.routeCode && String(rule.routeCode) !== route) return false;
    if (rule.warehouseId && !["*", warehouseId].includes(String(rule.warehouseId))) return false;
    if (!dimensionsValid(rule, input)) return false;
    return true;
  }).sort((a, b) => num(a.priority, 100) - num(b.priority, 100) || num(a.minWeightG) - num(b.minWeightG));

  const volumeDivisor = num(candidates[0]?.volumeDivisor, 6000);
  const volumeWeightG = num(input.lengthCm) > 0 && num(input.widthCm) > 0 && num(input.heightCm) > 0
    ? (num(input.lengthCm) * num(input.widthCm) * num(input.heightCm) / volumeDivisor) * 1000
    : 0;
  const provisionalWeight = Math.max(actualWeightG, volumeWeightG);
  const selected = candidates.find((rule) => {
    const billable = rule.useVolumeWeight ? provisionalWeight : actualWeightG;
    const min = num(rule.minWeightG);
    const max = rule.maxWeightG === null || rule.maxWeightG === undefined || rule.maxWeightG === ""
      ? Number.POSITIVE_INFINITY
      : num(rule.maxWeightG);
    return billable >= min && billable <= max;
  });
  if (!selected) throw new Error(`没有匹配的物流规则：${provider} / ${actualWeightG}g`);
  const billableWeightG = selected.useVolumeWeight ? provisionalWeight : actualWeightG;
  const baseMinor = moneyMinor(selected.baseFeeCny);
  const feePerKgMinor = moneyMinor(selected.feePerKgCny);
  const billableMilliGram = scaledInteger(billableWeightG, 3);
  const variableMinor = roundDivide(feePerKgMinor * billableMilliGram, 1_000_000n);
  const minimumMinor = moneyMinor(selected.minimumFeeCny);
  const beforeSurchargeMinor = baseMinor + variableMinor > minimumMinor
    ? baseMinor + variableMinor
    : minimumMinor;
  const amountMinor = beforeSurchargeMinor + feeMinor(beforeSurchargeMinor, selected.surchargeRate);
  return {
    amount: minorNumber(amountMinor),
    amountMinor: String(amountMinor),
    currencyCode: "CNY",
    source: "rule",
    rule: selected,
    actualWeightG: money(actualWeightG),
    volumeWeightG: money(volumeWeightG),
    billableWeightG: money(billableWeightG),
  };
}

function domesticFees(config, input) {
  const warehouseId = String(input.warehouseId || "");
  const rule = (config.domesticFeeRules || [])
    .filter((item) => ["*", warehouseId].includes(String(item.warehouseId || "*")))
    .sort((a, b) => (String(a.warehouseId) === warehouseId ? 0 : 1) - (String(b.warehouseId) === warehouseId ? 0 : 1) || num(a.priority, 100) - num(b.priority, 100))[0] || {};
  const amounts = {
    domesticShippingCny: moneyMinor(input.domesticShippingCny ?? rule.domesticShippingCny),
    labelingFeeCny: moneyMinor(input.labelingFeeCny ?? rule.labelingFeeCny),
    packagingFeeCny: moneyMinor(input.packagingFeeCny ?? rule.packagingFeeCny),
    operationFeeCny: moneyMinor(input.operationFeeCny ?? rule.operationFeeCny),
  };
  return {
    rule,
    currencyCode: "CNY",
    domesticShippingCny: minorNumber(amounts.domesticShippingCny),
    domesticShippingCnyMinor: String(amounts.domesticShippingCny),
    labelingFeeCny: minorNumber(amounts.labelingFeeCny),
    labelingFeeCnyMinor: String(amounts.labelingFeeCny),
    packagingFeeCny: minorNumber(amounts.packagingFeeCny),
    packagingFeeCnyMinor: String(amounts.packagingFeeCny),
    operationFeeCny: minorNumber(amounts.operationFeeCny),
    operationFeeCnyMinor: String(amounts.operationFeeCny),
  };
}

function effectiveDefaults(config, input) {
  const defaults = config.defaults || {};
  return {
    adRate: num(input.adRate ?? defaults.adRate),
    withdrawalRate: num(input.withdrawalRate ?? defaults.withdrawalRate, 3),
    returnLossRate: num(input.returnLossRate ?? defaults.returnLossRate, 2),
    targetMarginRate: num(input.targetMarginRate ?? defaults.targetMarginRate, 20),
    frontendDiscountRate: num(input.frontendDiscountRate ?? defaults.frontendDiscountRate, 50),
    otherFixedFeeCny: money(input.otherFixedFeeCny ?? defaults.otherFixedFeeCny),
    otherFixedFeeCnyMinor: String(moneyMinor(input.otherFixedFeeCny ?? defaults.otherFixedFeeCny)),
    otherVariableRate: num(input.otherVariableRate ?? input.otherFeeRate),
  };
}

function reverseCommission(config, input, fixedCostMinor, rates, exchangeRate) {
  for (const rule of rates) {
    const denominatorBps = 10_000n
      - rateBps(rule.commissionRate)
      - rateBps(input.adRate)
      - rateBps(input.withdrawalRate)
      - rateBps(input.returnLossRate)
      - rateBps(input.otherVariableRate)
      - rateBps(input.targetMarginRate);
    if (denominatorBps <= 100n) continue;
    // 建议售价必须向上取到最小货币单位，否则四舍五入可能让实际利润率低于目标值。
    let candidateMinor = ceilDivide(fixedCostMinor * 10_000n, denominatorBps);
    const targetMarginBps = rateBps(input.targetMarginRate);
    const variableRates = [
      rule.commissionRate,
      input.adRate,
      input.withdrawalRate,
      input.returnLossRate,
      input.otherVariableRate,
    ];
    while (
      (
        candidateMinor
        - fixedCostMinor
        - variableRates.reduce((sum, percentage) => sum + feeMinor(candidateMinor, percentage), 0n)
      ) * 10_000n < candidateMinor * targetMarginBps
    ) {
      candidateMinor += 1n;
    }
    const rubMinor = exchangeMinor(candidateMinor, exchangeRate);
    const minMinor = moneyMinor(rule.minPriceRub);
    const maxMinor = rule.maxPriceRub === null || rule.maxPriceRub === undefined || rule.maxPriceRub === ""
      ? null
      : moneyMinor(rule.maxPriceRub);
    if (rubMinor >= minMinor && (maxMinor === null || rubMinor <= maxMinor)) {
      return { rule, commissionRate: num(rule.commissionRate), sellingPriceMinor: candidateMinor };
    }
  }
  throw new Error("佣金、扣费和目标利润无法得到自洽售价，请检查费率是否过高或规则是否缺失");
}

export function calculatePricing(config, rawInput = {}) {
  if (!config?.id) throw new Error("缺少有效算价配置");
  const input = { ...rawInput };
  const exchangeRate = num(input.exchangeRate ?? config.exchangeRate?.rate, 11.97);
  if (!(exchangeRate > 0)) throw new Error("汇率必须大于 0");
  const logistics = calculateLogistics(config, input);
  const domestic = domesticFees(config, input);
  const defaults = effectiveDefaults(config, input);
  const purchaseCostMinor = moneyMinor(input.purchaseCostCny);
  const fixedCostMinor = purchaseCostMinor
    + BigInt(logistics.amountMinor)
    + BigInt(domestic.domesticShippingCnyMinor)
    + BigInt(domestic.labelingFeeCnyMinor)
    + BigInt(domestic.packagingFeeCnyMinor)
    + BigInt(domestic.operationFeeCnyMinor)
    + BigInt(defaults.otherFixedFeeCnyMinor);
  const mode = input.mode === "pricing" ? "pricing" : "profit";
  const commissionRules = matchingCommissionRules(config, input);
  if (!commissionRules.length) throw new Error("当前类目和履约方式没有佣金规则");

  let sellingPriceMinor;
  let commission;
  if (mode === "pricing") {
    const resolved = reverseCommission(config, { ...input, ...defaults }, fixedCostMinor, commissionRules, exchangeRate);
    sellingPriceMinor = resolved.sellingPriceMinor;
    commission = resolved;
  } else {
    sellingPriceMinor = moneyMinor(input.sellingPriceCny);
    if (sellingPriceMinor <= 0n) throw new Error("售价必须大于 0");
    commission = commissionForRub(config, input, exchangeMinor(sellingPriceMinor, exchangeRate));
  }

  const commissionFeeMinor = feeMinor(sellingPriceMinor, commission.commissionRate);
  const adFeeMinor = feeMinor(sellingPriceMinor, defaults.adRate);
  const withdrawalFeeMinor = feeMinor(sellingPriceMinor, defaults.withdrawalRate);
  const returnLossMinor = feeMinor(sellingPriceMinor, defaults.returnLossRate);
  const otherVariableFeeMinor = feeMinor(sellingPriceMinor, defaults.otherVariableRate);
  const netProfitMinor = sellingPriceMinor
    - fixedCostMinor
    - commissionFeeMinor
    - adFeeMinor
    - withdrawalFeeMinor
    - returnLossMinor
    - otherVariableFeeMinor;
  const profitMarginBps = sellingPriceMinor > 0n
    ? roundDivide(netProfitMinor * 10_000n, sellingPriceMinor)
    : 0n;
  const discountBps = rateBps(defaults.frontendDiscountRate);
  const originalPriceMinor = discountBps > 0n && discountBps <= 10_000n
    ? roundDivide(sellingPriceMinor * 10_000n, discountBps)
    : sellingPriceMinor;
  const sellingPriceRubMinor = exchangeMinor(sellingPriceMinor, exchangeRate);
  const originalPriceRubMinor = exchangeMinor(originalPriceMinor, exchangeRate);

  return {
    mode,
    configVersionId: config.id,
    configVersionNo: config.versionNo,
    exchangeRate,
    currencyCode: "CNY",
    sellingPriceCny: minorNumber(sellingPriceMinor),
    originalPriceCny: minorNumber(originalPriceMinor),
    sellingPriceRub: minorNumber(sellingPriceRubMinor),
    originalPriceRub: minorNumber(originalPriceRubMinor),
    purchaseCostCny: minorNumber(purchaseCostMinor),
    fixedCostCny: minorNumber(fixedCostMinor),
    moneyMinor: {
      CNY: {
        sellingPrice: String(sellingPriceMinor),
        originalPrice: String(originalPriceMinor),
        purchaseCost: String(purchaseCostMinor),
        fixedCost: String(fixedCostMinor),
        commissionFee: String(commissionFeeMinor),
        adFee: String(adFeeMinor),
        withdrawalFee: String(withdrawalFeeMinor),
        returnLoss: String(returnLossMinor),
        otherVariableFee: String(otherVariableFeeMinor),
        netProfit: String(netProfitMinor),
      },
      RUB: {
        sellingPrice: String(sellingPriceRubMinor),
        originalPrice: String(originalPriceRubMinor),
      },
    },
    logistics,
    domestic,
    commissionRule: commission.rule,
    commissionRate: commission.commissionRate,
    commissionFeeCny: minorNumber(commissionFeeMinor),
    adRate: defaults.adRate,
    adFeeCny: minorNumber(adFeeMinor),
    withdrawalRate: defaults.withdrawalRate,
    withdrawalFeeCny: minorNumber(withdrawalFeeMinor),
    returnLossRate: defaults.returnLossRate,
    returnLossCny: minorNumber(returnLossMinor),
    otherVariableRate: defaults.otherVariableRate,
    otherVariableFeeCny: minorNumber(otherVariableFeeMinor),
    targetMarginRate: defaults.targetMarginRate,
    frontendDiscountRate: defaults.frontendDiscountRate,
    netProfitCny: minorNumber(netProfitMinor),
    profitMarginRate: Number(profitMarginBps) / 100,
    calculatedAt: new Date().toISOString(),
  };
}

export function validatePricingConfig(config = {}) {
  const errors = [];
  if (config.ruleConfirmationStatus !== "CONFIRMED") {
    errors.push("佣金、物流、汇率和费用规则的业务依据尚未确认");
  }
  const commissionRules = config.commissionRules || [];
  if (!(num(config.exchangeRate?.rate) > 0)) errors.push("CNY/RUB 汇率必须大于 0");
  if (!commissionRules.length) errors.push("至少需要一条佣金规则");
  if (!(config.logisticsRules || []).length) errors.push("至少需要一条物流规则");
  for (const rule of commissionRules) {
    if (num(rule.commissionRate) < 0 || num(rule.commissionRate) >= 100) errors.push(`佣金率无效：${rule.ruleName || rule.id}`);
  }
  const official = Boolean(config.officialImports?.length) || commissionRules.some((rule) => /\.xlsx$/i.test(String(rule.sourceName || "")));
  if (official) {
    const requiredFulfillments = ["RFBS", "FBP", "WHD"];
    const presentFulfillments = new Set(commissionRules.map((rule) => String(rule.fulfillmentType || "").toUpperCase()));
    const missingFulfillments = requiredFulfillments.filter((value) => !presentFulfillments.has(value));
    if (missingFulfillments.length) errors.push(`官方佣金规则缺少履约类型：${missingFulfillments.join("、")}`);
    if (commissionRules.some((rule) => ["", "*"].includes(String(rule.ozonCategoryId || "")))) {
      errors.push("官方佣金版本不能包含通用类目规则");
    }
    const groups = new Map();
    for (const rule of commissionRules) {
      const key = `${String(rule.ozonCategoryId || "")}|${String(rule.fulfillmentType || "").toUpperCase()}`;
      groups.set(key, [...(groups.get(key) || []), rule]);
    }
    for (const [key, group] of groups) {
      const sorted = group.sort((left, right) => num(left.minPriceRub) - num(right.minPriceRub));
      const expected = [[0, 1500], [1500.01, 5000], [5000.01, null]];
      if (sorted.length !== expected.length) {
        errors.push(`官方佣金价格档位不完整：${key}`);
        continue;
      }
      expected.forEach(([expectedMin, expectedMax], index) => {
        const actual = sorted[index];
        const actualMax = actual.maxPriceRub === null || actual.maxPriceRub === undefined || actual.maxPriceRub === "" ? null : num(actual.maxPriceRub);
        if (Math.abs(num(actual.minPriceRub) - expectedMin) > 0.0001 || actualMax !== expectedMax) {
          errors.push(`官方佣金价格区间异常：${key}`);
        }
      });
    }
  }
  for (const rule of config.logisticsRules || []) {
    if (!rule.provider) errors.push("物流规则缺少物流商");
    if (num(rule.maxWeightG, Number.POSITIVE_INFINITY) < num(rule.minWeightG)) errors.push(`物流重量区间无效：${rule.provider}`);
  }
  return { valid: errors.length === 0, errors };
}
