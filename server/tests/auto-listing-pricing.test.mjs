import assert from "node:assert/strict";
import test from "node:test";
import { calculateAutoListingPrice } from "../auto-listing-pricing.mjs";

const expectPriceError = (input, code) => {
  assert.throws(
    () => calculateAutoListingPrice(input),
    (error) => error?.code === code,
  );
};

test("calculates and preserves evidence for a high-branch discounted price", () => {
  assert.deepEqual(calculateAutoListingPrice({
    blackKopecks: "10000",
    greenKopecks: "8000",
    adjustmentKopecks: "-500",
    currency: "RUB",
  }), {
    currency: "RUB",
    branch: "BLACK_GTE_80",
    blackKopecks: "10000",
    greenKopecks: "8000",
    realPriceKopecks: "14500",
    adjustmentKopecks: "-500",
    finalPriceKopecks: "14000",
  });
});

test("uses the below-80 formula at 79.99 RUB and the discount formula at 80 RUB", () => {
  assert.deepEqual(calculateAutoListingPrice({
    blackKopecks: "7999",
    adjustmentKopecks: "0",
    currency: "RUB",
  }), {
    currency: "RUB",
    branch: "BLACK_LT_80",
    blackKopecks: "7999",
    realPriceKopecks: "7465",
    adjustmentKopecks: "0",
    finalPriceKopecks: "7465",
  });

  assert.deepEqual(calculateAutoListingPrice({
    blackKopecks: "8000",
    greenKopecks: "7000",
    currency: "RUB",
  }), {
    currency: "RUB",
    branch: "BLACK_GTE_80",
    blackKopecks: "8000",
    greenKopecks: "7000",
    realPriceKopecks: "10250",
    adjustmentKopecks: "0",
    finalPriceKopecks: "10250",
  });
});

test("rounds a half kopeck upward using exact integer arithmetic", () => {
  assert.deepEqual(calculateAutoListingPrice({
    blackKopecks: "8002",
    greenKopecks: "8000",
    currency: "RUB",
  }), {
    currency: "RUB",
    branch: "BLACK_GTE_80",
    blackKopecks: "8002",
    greenKopecks: "8000",
    realPriceKopecks: "8007",
    adjustmentKopecks: "0",
    finalPriceKopecks: "8007",
  });
});

test("rejects a non-RUB currency and a missing high-branch green price", () => {
  expectPriceError({
    blackKopecks: "10000",
    greenKopecks: "8000",
    currency: "CNY",
  }, "PRICE_CURRENCY_NOT_RUB");

  expectPriceError({
    blackKopecks: "8000",
    currency: "RUB",
  }, "PRICE_INPUT_MISSING");
});

test("rejects missing, malformed, and nonpositive source prices", () => {
  expectPriceError({ currency: "RUB" }, "PRICE_INPUT_MISSING");
  expectPriceError({
    blackKopecks: 8_000,
    greenKopecks: "7000",
    currency: "RUB",
  }, "PRICE_INPUT_INVALID");
  expectPriceError({
    blackKopecks: "80.00",
    currency: "RUB",
  }, "PRICE_INPUT_INVALID");
  expectPriceError({
    blackKopecks: "0",
    currency: "RUB",
  }, "PRICE_INPUT_INVALID");
  expectPriceError({
    blackKopecks: "8000",
    greenKopecks: "0",
    currency: "RUB",
  }, "PRICE_INPUT_INVALID");
});

test("rejects malformed adjustments and nonpositive final prices", () => {
  expectPriceError({
    blackKopecks: "7999",
    adjustmentKopecks: "one-ruble",
    currency: "RUB",
  }, "PRICE_INPUT_INVALID");
  expectPriceError({
    blackKopecks: "7999",
    adjustmentKopecks: "-7465",
    currency: "RUB",
  }, "PRICE_FINAL_NOT_POSITIVE");
});
