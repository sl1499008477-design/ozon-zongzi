import assert from "node:assert/strict";
import { test } from "node:test";
import {
  dataScreenModel,
  profitTrendModel,
} from "../src/order-analytics.js";

const now = new Date("2026-07-27T12:00:00+08:00");
const postings = [
  {
    posting_number: "rub-order",
    in_process_at: "2026-07-27T10:00:00+08:00",
    currency_code: "RUB",
    status: "delivered",
    order_price: "0.10",
  },
  {
    posting_number: "rub-order-2",
    in_process_at: "2026-07-27T11:00:00+08:00",
    currency_code: "RUB",
    status: "delivered",
    order_price: "0.20",
  },
];

test("order analytics aggregates integer minor units", () => {
  const screen = dataScreenModel(postings, "7天", now);
  assert.equal(screen.rangeMoney.RUB, "30");
  assert.equal(screen.days.at(-1).amountMinor, 30);
  const trend = profitTrendModel(postings, "7 天", now);
  assert.equal(trend.totalByCurrency.RUB, "30");
  assert.equal(trend.totalAmountMinor, 30);
});

test("mixed currencies disable direct monetary comparison", () => {
  const mixed = dataScreenModel([
    ...postings,
    {
      posting_number: "cny-order",
      in_process_at: "2026-07-27T09:00:00+08:00",
      currency_code: "CNY",
      order_price: "1.00",
    },
  ], "7天", now);
  assert.equal(mixed.moneyComparable, false);
  assert.deepEqual(mixed.rangeMoney, { RUB: "30", CNY: "100" });
});
