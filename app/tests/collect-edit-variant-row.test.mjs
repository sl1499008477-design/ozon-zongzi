import assert from "node:assert/strict";
import test from "node:test";

import { normalizeCollectEditVariantRow } from "../src/collect-edit-variant-row.js";

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
