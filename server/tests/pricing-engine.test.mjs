import assert from "node:assert/strict";
import { calculatePricing, validatePricingConfig } from "../pricing-engine.mjs";
import { DEFAULT_PRICING_CONFIG } from "../pricing-config-service.mjs";

const config = structuredClone(DEFAULT_PRICING_CONFIG);

const profit = calculatePricing(config, {
  mode: "profit",
  categoryId: "*",
  fulfillmentType: "RFBS",
  sellingPriceCny: 200,
  purchaseCostCny: 100,
  weightG: 500,
  logisticsProvider: "XY",
  exchangeRate: 11.97,
  adRate: 0,
  withdrawalRate: 3,
  returnLossRate: 2,
});

assert.equal(profit.commissionRate, 14, "200 CNY should fall into the middle RUB commission band");
assert.equal(profit.logistics.amount, 3);
assert.equal(profit.netProfitCny, 59);
assert.equal(profit.profitMarginRate, 29.5);

const pricing = calculatePricing(config, {
  mode: "pricing",
  categoryId: "*",
  fulfillmentType: "RFBS",
  purchaseCostCny: 100,
  weightG: 500,
  logisticsProvider: "XY",
  targetMarginRate: 20,
  frontendDiscountRate: 50,
  adRate: 0,
  withdrawalRate: 3,
  returnLossRate: 2,
});

assert.equal(pricing.commissionRate, 14);
assert.equal(pricing.sellingPriceCny, 168.87);
assert.equal(pricing.originalPriceCny, 337.74);
assert.equal(pricing.profitMarginRate, 20);
assert.equal(pricing.currencyCode, "CNY");
assert.equal(pricing.moneyMinor.CNY.sellingPrice, "16887");
assert.equal(pricing.moneyMinor.CNY.netProfit, "3378");
assert.equal(pricing.moneyMinor.RUB.sellingPrice, "202137");

const volumeConfig = structuredClone(config);
volumeConfig.logisticsRules = [{
  id: "volume",
  provider: "VOLUME",
  warehouseId: "*",
  minWeightG: 0,
  maxWeightG: 100000,
  baseFeeCny: 2,
  feePerKgCny: 10,
  minimumFeeCny: 0,
  useVolumeWeight: true,
  volumeDivisor: 6000,
  priority: 1,
}];
const volume = calculatePricing(volumeConfig, {
  mode: "profit",
  categoryId: "*",
  fulfillmentType: "RFBS",
  sellingPriceCny: 200,
  purchaseCostCny: 50,
  weightG: 1000,
  lengthCm: 60,
  widthCm: 40,
  heightCm: 30,
  logisticsProvider: "VOLUME",
});
assert.equal(volume.logistics.billableWeightG, 12000);
assert.equal(volume.logistics.amount, 122);

assert.equal(
  validatePricingConfig(config).valid,
  false,
  "built-in example rules must remain unusable until an administrator confirms their sources",
);
const confirmed = structuredClone(config);
confirmed.ruleConfirmationStatus = "CONFIRMED";
assert.equal(validatePricingConfig(confirmed).valid, true);
const invalid = structuredClone(confirmed);
invalid.exchangeRate.rate = 0;
assert.equal(validatePricingConfig(invalid).valid, false);

console.log("pricing-engine tests passed");
