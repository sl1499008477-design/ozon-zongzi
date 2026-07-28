import assert from "node:assert/strict";
import {
  postingMoneyGroups,
  summarizePostingMoney,
} from "../src/order-money.js";

const decimalPosting = {
  currency_code: "RUB",
  financial_data: {
    products: [{ price: "0.10" }, { price: "0.20" }],
  },
};
assert.deepEqual(postingMoneyGroups(decimalPosting), { RUB: "30" });

const quantityPosting = {
  currency_code: "CNY",
  products: [{ price: "12.345", quantity: 2 }],
};
assert.deepEqual(postingMoneyGroups(quantityPosting), { CNY: "2470" });

const mixed = summarizePostingMoney([
  decimalPosting,
  { currency_code: "CNY", order_price: "1.00" },
]);
assert.deepEqual(mixed.currencyCodes, ["CNY", "RUB"]);
assert.equal(mixed.singleCurrency, false);
assert.deepEqual(mixed.byCurrency, { CNY: "100", RUB: "30" });

console.log("frontend order money test passed");
