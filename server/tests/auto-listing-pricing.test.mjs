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

test("rejects inverted high-branch price evidence while allowing no discount", () => {
  assert.deepEqual(calculateAutoListingPrice({
    blackKopecks: "8000",
    greenKopecks: "8000",
    currency: "RUB",
  }), {
    currency: "RUB",
    branch: "BLACK_GTE_80",
    blackKopecks: "8000",
    greenKopecks: "8000",
    realPriceKopecks: "8000",
    adjustmentKopecks: "0",
    finalPriceKopecks: "8000",
  });
  expectPriceError({
    blackKopecks: "8000",
    greenKopecks: "9000",
    currency: "RUB",
  }, "PRICE_INPUT_INVALID");
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

test("calculates CNY in native minor units and rejects unsupported currencies", () => {
  assert.deepEqual(calculateAutoListingPrice({
    blackKopecks: "10000",
    greenKopecks: "8000",
    adjustmentKopecks: "-500",
    currency: "CNY",
  }), {
    currency: "CNY",
    branch: "BLACK_GTE_80",
    blackKopecks: "10000",
    greenKopecks: "8000",
    realPriceKopecks: "14500",
    adjustmentKopecks: "-500",
    finalPriceKopecks: "14000",
  });
  expectPriceError({
    blackKopecks: "10000",
    greenKopecks: "8000",
    currency: "USD",
  }, "PRICE_CURRENCY_UNSUPPORTED");
});

test("rejects a missing high-branch green price", () => {
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

test("rejects invalid input containers while preserving empty-object missing-field semantics", () => {
  expectPriceError(null, "PRICE_INPUT_INVALID");
  expectPriceError([], "PRICE_INPUT_INVALID");
  expectPriceError("price", "PRICE_INPUT_INVALID");
  expectPriceError({}, "PRICE_INPUT_MISSING");
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

test("bounds every externally parsed kopeck integer to PostgreSQL signed BIGINT before BigInt conversion", () => {
  assert.equal(calculateAutoListingPrice({
    blackKopecks: "9223372036854775807", greenKopecks: "1",
    adjustmentKopecks: "-9223372036854775808", currency: "RUB",
  }).adjustmentKopecks, "-9223372036854775808");
  for (const input of [
    { blackKopecks: "9223372036854775808", greenKopecks: "1", currency: "RUB" },
    { blackKopecks: "8000", greenKopecks: "9223372036854775808", currency: "RUB" },
    { blackKopecks: "8000", greenKopecks: "1", adjustmentKopecks: "9223372036854775808", currency: "RUB" },
    { blackKopecks: `1${"0".repeat(10_000)}`, currency: "RUB" },
  ]) {
    expectPriceError(input, "PRICE_INPUT_INVALID");
  }
});
