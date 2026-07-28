import assert from "node:assert/strict";
import {
  parseMinorUnits,
  summarizeOrderMoney,
} from "../order-money-summary.mjs";

assert.equal(parseMinorUnits("0.1"), 10n);
assert.equal(parseMinorUnits("0.20"), 20n);
assert.equal(parseMinorUnits("12.345"), 1235n);
assert.equal(parseMinorUnits("-1.005"), -101n);

const summary = summarizeOrderMoney([
  {
    id: "rub-1",
    created_at: "2026-07-27T01:00:00.000Z",
    currency_code: "RUB",
    financial_data: { products: [{ price: "0.10" }, { price: "0.20" }] },
  },
  {
    id: "rub-2",
    created_at: "2026-07-26T01:00:00.000Z",
    currency_code: "RUB",
    total_price: "100.00",
  },
  {
    id: "cny-1",
    created_at: "2026-07-27T01:00:00.000Z",
    currency_code: "CNY",
    total_price: "8.88",
  },
], {
  dateKey: (value) => String(value).slice(0, 10),
  todayKey: "2026-07-27",
  weekKeys: new Set(["2026-07-27", "2026-07-26"]),
});

assert.deepEqual(summary.currencyCodes, ["CNY", "RUB"]);
assert.equal(summary.mixedCurrencies, true);
assert.equal(summary.totalGmv, null, "different currencies must never be added together");
assert.equal(summary.todayGmv, null, "mixed-currency daily totals must not become one number");
assert.deepEqual(summary.gmvByCurrency.CNY, {
  currencyCode: "CNY",
  totalMinor: "888",
  total: "8.88",
  todayMinor: "888",
  today: "8.88",
  weekMinor: "888",
  week: "8.88",
});
assert.deepEqual(summary.gmvByCurrency.RUB, {
  currencyCode: "RUB",
  totalMinor: "10030",
  total: "100.30",
  todayMinor: "30",
  today: "0.30",
  weekMinor: "10030",
  week: "100.30",
});

const single = summarizeOrderMoney([
  { created_at: "2026-07-27", currency_code: "RUB", total_price: "1.10" },
  { created_at: "2026-07-27", currency_code: "RUB", total_price: "2.20" },
], {
  dateKey: (value) => String(value).slice(0, 10),
  todayKey: "2026-07-27",
  weekKeys: new Set(["2026-07-27"]),
});
assert.equal(single.currencyCode, "RUB");
assert.equal(single.totalGmv, "3.30");
assert.equal(single.todayGmv, "3.30");
assert.equal(single.weekGmv, "3.30");

console.log("order money summary test passed");
