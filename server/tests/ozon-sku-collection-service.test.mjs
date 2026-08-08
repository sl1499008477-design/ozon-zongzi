import assert from "node:assert/strict";
import test from "node:test";

import {
  createOzonSkuCollectionService,
} from "../ozon-sku-collection-service.mjs";

const NOW = "2026-08-04T12:00:00.000Z";

function createHarness({ detail, scrapeError } = {}) {
  const calls = { scrape: [], save: [], normalize: [] };
  const service = createOzonSkuCollectionService({
    now: () => NOW,
    async scrapeProductDetail(sku) {
      calls.scrape.push(sku);
      if (scrapeError) throw scrapeError;
      return detail;
    },
    normalizeItem(input) {
      calls.normalize.push(structuredClone(input));
      return { id: `collect-${input.sku}`, ...structuredClone(input) };
    },
    async saveItem(item, scope) {
      calls.save.push({ item: structuredClone(item), scope: structuredClone(scope) });
      return { item: { ...structuredClone(item), accountId: scope.account.id } };
    },
  });
  return { service, calls };
}

test("collects one SKU inside the authenticated account boundary", async () => {
  const detail = {
    title: "Термос",
    url: "https://www.ozon.ru/product/termos-123/",
    price: "899",
    priceText: "899 ₽",
    primaryImage: "https://cdn.example/main.jpg",
    images: ["https://cdn.example/main.jpg", "https://cdn.example/detail.jpg"],
    variants: [{ sku: "123-red" }],
    sellerName: "Продавец",
    sellerLink: "https://www.ozon.ru/seller/1/",
    brand: "Brand",
    categories: ["Дом", "Термосы"],
    rating: 4.8,
    reviewCount: 25,
  };
  const { service, calls } = createHarness({ detail });

  const result = await service.collectOzonSkuForAccount({
    account: { id: "account-a", username: "member" },
    sku: " 123 ",
  });

  assert.equal(result.scraped, true);
  assert.equal(result.item.id, "collect-123");
  assert.equal(result.item.accountId, "account-a");
  assert.deepEqual(calls.scrape, ["123"]);
  assert.equal(calls.normalize.length, 1);
  assert.deepEqual(calls.normalize[0], {
    sku: "123",
    productUrl: detail.url,
    name: detail.title,
    price: detail.price,
    priceText: detail.priceText,
    image: detail.primaryImage,
    images: detail.images,
    variants: detail.variants,
    variantData: { variants: detail.variants },
    seller: detail.sellerName,
    sellerLink: detail.sellerLink,
    brand: detail.brand,
    category: "Дом / Термосы",
    rating: detail.rating,
    reviewCount: detail.reviewCount,
    source: "SKU 抓取",
    status: "已采集",
    raw: { sku: "123", scrapedAt: NOW },
  });
  assert.deepEqual(calls.save[0].scope, { account: { id: "account-a", username: "member" } });
});

test("keeps the existing fallback row when Ozon returns no usable title", async () => {
  const { service, calls } = createHarness({ detail: { title: "" } });

  const result = await service.collectOzonSkuForAccount({
    account: { id: "account-a" },
    sku: "7003",
  });

  assert.equal(result.scraped, false);
  assert.equal(result.code, "OZON_SKU_SCRAPE_EMPTY");
  assert.equal(result.item.name, "SKU 7003");
  assert.equal(result.item.status, "待处理");
  assert.deepEqual(calls.normalize[0].raw, { sku: "7003", error: "scrape_failed" });
  assert.equal(calls.save.length, 1);
});

test("rejects missing account and invalid SKU before scraping or persistence", async () => {
  const { service, calls } = createHarness({ detail: { title: "unused" } });

  await assert.rejects(
    service.collectOzonSkuForAccount({ account: {}, sku: "123" }),
    { code: "OZON_SKU_ACCOUNT_REQUIRED" },
  );
  await assert.rejects(
    service.collectOzonSkuForAccount({ account: { id: "account-a" }, sku: " \n " }),
    { code: "OZON_SKU_INVALID" },
  );
  await assert.rejects(
    service.collectOzonSkuForAccount({ account: { id: "account-a" }, sku: "x".repeat(161) }),
    { code: "OZON_SKU_INVALID" },
  );

  assert.deepEqual(calls.scrape, []);
  assert.deepEqual(calls.save, []);
});

test("normalizes scraper failures to a stable code without persisting a partial row", async () => {
  const { service, calls } = createHarness({
    scrapeError: new Error("cookie=secret; upstream private response"),
  });

  await assert.rejects(
    service.collectOzonSkuForAccount({ account: { id: "account-a" }, sku: "123" }),
    (error) => {
      assert.equal(error.code, "OZON_SKU_COLLECTION_FAILED");
      assert.equal(error.message, "OZON_SKU_COLLECTION_FAILED");
      assert.doesNotMatch(String(error.cause?.message || ""), /secret|cookie/i);
      return true;
    },
  );
  assert.equal(calls.save.length, 0);
});

test("dependency and return contracts fail closed", async () => {
  assert.throws(() => createOzonSkuCollectionService(), TypeError);
  const service = createOzonSkuCollectionService({
    now: () => NOW,
    scrapeProductDetail: async () => ({ title: "Product" }),
    normalizeItem: () => null,
    saveItem: async () => ({ item: {} }),
  });
  await assert.rejects(
    service.collectOzonSkuForAccount({ account: { id: "account-a" }, sku: "1" }),
    { code: "OZON_SKU_COLLECTION_FAILED" },
  );
});
