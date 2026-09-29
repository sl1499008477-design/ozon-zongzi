import assert from "node:assert/strict";
import test from "node:test";

import { normalizeCollectEditVariantRow } from "../src/collect-edit-variant-row.js";
import * as priceHelpers from "../src/collect-edit-variant-row.js";

test("normalizes a persisted source variant into the edit-table commercial fields", () => {
  const row = normalizeCollectEditVariantRow({
    variant: {
      sku: "2757409016",
      name: "Подсачек, длина: 170 см",
      price: "30.84",
    },
    index: 0,
    rowCount: 2,
    offerPrefix: "jz-",
  });

  assert.deepEqual(row, {
    sku: "2757409016",
    offerId: "jz-2757409016-01",
    name: "Подсачек, длина: 170 см",
    sellPrice: "30.84",
    oldPrice: "38.55",
    stock: "0",
  });
});

test("preserves commercial fields already edited in a persisted draft row", () => {
  const row = normalizeCollectEditVariantRow({
    variant: {
      sku: "2757419612",
      offerId: "custom-offer-210",
      name: "人工修改后的名称",
      price: "29.06",
      sellPrice: "88.00",
      oldPrice: "99.00",
      stock: "7",
    },
    index: 1,
    rowCount: 2,
    fallbackTitle: "来源名称",
    fallbackPrice: "20.00",
    offerPrefix: "jz-",
  });

  assert.deepEqual(row, {
    sku: "2757419612",
    offerId: "custom-offer-210",
    name: "人工修改后的名称",
    sellPrice: "88.00",
    oldPrice: "99.00",
    stock: "7",
  });
});

test("appends a variant aspect to the name only once", () => {
  const first = normalizeCollectEditVariantRow({
    variant: {
      sku: "2757419612",
      name: "Подсачек",
      price: { price: "29.06", old_price: "40.00" },
      quantity: 4,
    },
    aspectName: "длина: 210 см",
  });
  const restored = normalizeCollectEditVariantRow({
    variant: {
      sku: "2757419612",
      name: "Подсачек / длина: 210 см",
      sellPrice: "29.06",
    },
    aspectName: "длина: 210 см",
  });

  assert.equal(first.name, "Подсачек / длина: 210 см");
  assert.equal(first.sellPrice, "29.06");
  assert.equal(first.oldPrice, "40.00");
  assert.equal(first.stock, "4");
  assert.equal(restored.name, "Подсачек / длина: 210 см");
});

test("a RUB collection price cannot seed a CNY listing price or old price", () => {
  const row = normalizeCollectEditVariantRow({
    variant: { sku: "2157503620", price: "555.35", currencyCode: "RUB", stock: 1627 },
    targetCurrencyCode: "CNY",
  });
  assert.equal(row.sellPrice, "");
  assert.equal(row.oldPrice, "");
  assert.equal(row.stock, "1627", "pricing changes do not change source inventory");
});

test("known same-currency source prices retain their amounts", () => {
  for (const variant of [
    { price: "555.35", currencyCode: "RUB" },
    { price: { price: "555.35", currency_code: "rub" } },
  ]) {
    const row = normalizeCollectEditVariantRow({ variant, targetCurrencyCode: "RUB" });
    assert.equal(row.sellPrice, "555.35");
    assert.equal(row.oldPrice, "694.19");
  }
});

test("a saved quote in the target currency takes precedence over the source quote", () => {
  const row = normalizeCollectEditVariantRow({
    variant: { sku: "2157503620", price: "555.35", currencyCode: "RUB" },
    draftVariant: { sellPrice: "70.00", oldPrice: "85.00" },
    draftCurrencyCode: "CNY",
    targetCurrencyCode: "CNY",
  });
  assert.equal(row.sellPrice, "70.00");
  assert.equal(row.oldPrice, "85.00");
});

test("an explicitly cleared saved quote does not recover a source amount", () => {
  const row = normalizeCollectEditVariantRow({
    variant: { price: "555.35", currencyCode: "CNY" },
    draftVariant: { sellPrice: "", price: "555.35", oldPrice: "694.19" },
    draftCurrencyCode: "CNY",
    targetCurrencyCode: "CNY",
  });
  assert.equal(row.sellPrice, "");
  assert.equal(row.oldPrice, "");
});

test("unknown source currency and another SKU's fallback amount cannot seed target pricing", () => {
  const unknown = normalizeCollectEditVariantRow({
    variant: { price: "555.35" }, targetCurrencyCode: "CNY",
  });
  const sibling = normalizeCollectEditVariantRow({
    variant: { sku: "2157503621", currencyCode: "CNY" },
    fallbackPrice: "70.00", targetCurrencyCode: "CNY",
  });
  assert.equal(unknown.sellPrice, "");
  assert.equal(sibling.sellPrice, "");
});

test("changing target currency reuses only a quote belonging to the new currency", () => {
  const input = {
    variant: { price: "555.35", currencyCode: "RUB" },
    draftVariant: { sellPrice: "70.00", oldPrice: "85.00", currencyCode: "CNY" },
  };
  assert.equal(normalizeCollectEditVariantRow({ ...input, targetCurrencyCode: "CNY" }).sellPrice, "70.00");
  assert.equal(normalizeCollectEditVariantRow({ ...input, targetCurrencyCode: "USD" }).sellPrice, "");
  assert.equal(normalizeCollectEditVariantRow({ ...input, targetCurrencyCode: "RUB" }).sellPrice, "555.35");
});

test("collection price labels retain explicit currency aliases and identify missing currency", () => {
  assert.equal(typeof priceHelpers.formatCollectSourcePrice, "function");
  assert.equal(priceHelpers.formatCollectSourcePrice({ price: "555.35", currencyCode: "RUB" }), "555.35 RUB");
  assert.equal(priceHelpers.formatCollectSourcePrice({ price: { price: "35.00", currency_code: "cny" } }), "35.00 CNY");
  assert.equal(priceHelpers.formatCollectSourcePrice({ price: "555.35", currency_code: "RUB" }, { currencyCode: "CNY" }), "555.35 RUB");
  assert.equal(priceHelpers.formatCollectSourcePrice({ price: "555.35" }, { currencyCode: "RUB" }), "555.35 RUB");
  assert.equal(priceHelpers.formatCollectSourcePrice({ price: "555.35" }), "555.35（币种未知）");
});
