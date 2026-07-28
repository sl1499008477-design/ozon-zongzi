import assert from "node:assert/strict";
import { computeRobustExchangeRate } from "../pricing-fx-service.mjs";

const robust = computeRobustExchangeRate([
  { sku: "100000001", rubPrice: 1200, cnyPrice: 100 },
  { sku: "100000002", rubPrice: 1210, cnyPrice: 100 },
  { sku: "100000003", rubPrice: 2000, cnyPrice: 100 },
]);
assert.equal(robust.accepted.length, 2);
assert.equal(robust.rejected.length, 1);
assert.equal(robust.rate, 12.05);
assert.equal(robust.confidence, "MEDIUM");

const single = computeRobustExchangeRate([
  { sku: "100000004", rubPrice: 1197, cnyPrice: 100 },
]);
assert.equal(single.rate, 11.97);
assert.equal(single.confidence, "LOW");

const conflictingWithoutHistory = computeRobustExchangeRate([
  { sku: "100000005", rubPrice: 1000, cnyPrice: 100 },
  { sku: "100000006", rubPrice: 1500, cnyPrice: 100 },
]);
assert.equal(conflictingWithoutHistory.rate, 0);
assert.equal(conflictingWithoutHistory.accepted.length, 0);

const conflictingWithHistory = computeRobustExchangeRate([
  { sku: "100000007", rubPrice: 1000, cnyPrice: 100 },
  { sku: "100000008", rubPrice: 1500, cnyPrice: 100 },
], 10.2);
assert.equal(conflictingWithHistory.rate, 10);
assert.equal(conflictingWithHistory.accepted.length, 1);

const invalid = computeRobustExchangeRate([
  { sku: "100000009", rubPrice: 1, cnyPrice: 100 },
]);
assert.equal(invalid.rate, 0);
assert.match(invalid.rejected[0].rejectReason, /超出/);

console.log("pricing fx service tests passed");
