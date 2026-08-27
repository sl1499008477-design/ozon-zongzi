const assert = require("node:assert/strict");
const fs = require("node:fs");

const workerSource = fs.readFileSync("extension/background/service-worker.js", "utf8");
const startToken = "const normalizeMarketItem = (item) => {";
const endToken = "\n\n  // 找/开一个 www.ozon.ru 买家 tab";
const start = workerSource.indexOf(startToken);
const end = workerSource.indexOf(endToken, start);
assert.notEqual(start, -1, "market item normalizer must remain defined");
assert.notEqual(end, -1, "market item normalizer must remain extractable");

const normalizerSource = workerSource.slice(start, end);
const normalizeMarketItem = new Function(`${normalizerSource}\nreturn normalizeMarketItem;`)();

assert.equal(normalizeMarketItem({ nullableRedemptionRate: 92 }).nullableRedemptionRate, 92);
assert.equal(normalizeMarketItem({ NullableRedemptionRate: 91 }).nullableRedemptionRate, 91);
assert.equal(normalizeMarketItem({ nullable_redemption_rate: 90 }).nullableRedemptionRate, 90);
assert.equal(normalizeMarketItem({ redemptionRate: 89 }).nullableRedemptionRate, 89);
assert.equal(normalizeMarketItem({ redemption_rate: 88 }).nullableRedemptionRate, 88);
assert.equal(normalizeMarketItem({ soldCount: 10 }).nullableRedemptionRate, undefined);

console.log("market item return-rate normalization passed");
