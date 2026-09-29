import assert from "node:assert/strict";
import test from "node:test";

import {
  createOzonSkuCollectionService,
} from "../ozon-sku-collection-service.mjs";

const NOW = "2026-08-04T12:00:00.000Z";

function createHarness({ detail, scrapeError, existing } = {}) {
  const calls = { scrape: [], save: [], normalize: [] };
  const service = createOzonSkuCollectionService({
    now: () => NOW,
    findExisting: async () => existing || null,
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
    sourceCharacteristics: [
      { name: "Материал корпуса", value: "Сталь" },
      { name: "Объем", value: "1 л" },
    ],
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
    ozonProductId: 123,
    productUrl: detail.url,
    name: detail.title,
    price: detail.price,
    priceText: detail.priceText,
    image: detail.primaryImage,
    images: detail.images,
    variants: detail.variants,
    variantData: { variants: detail.variants },
    sourceCharacteristics: detail.sourceCharacteristics,
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

test("does not reinterpret a seller offer id as a public Ozon product id", async () => {
  const { service, calls } = createHarness({
    detail: { title: "Термос", url: "https://www.ozon.ru/product/termos/" },
  });

  await service.collectOzonSkuForAccount({
    account: { id: "account-a" },
    sku: "offer-123",
  });

  assert.equal(calls.normalize[0].sku, "offer-123");
  assert.equal(Object.hasOwn(calls.normalize[0], "ozonProductId"), false);
});

test("passes the Excel task target store to persistence without exposing it as product data", async () => {
  const { service, calls } = createHarness({
    detail: { title: "Термос", url: "https://www.ozon.ru/product/termos-123/" },
  });

  await service.collectOzonSkuForAccount({
    account: { id: "account-a" },
    sku: "123",
    targetStoreId: "store-a",
  });

  assert.deepEqual(calls.save[0].scope, {
    account: { id: "account-a" },
    targetStoreId: "store-a",
  });
  assert.equal(Object.hasOwn(calls.normalize[0], "targetStoreId"), false);
});

test("keeps the public PDP type label as exact category evidence", async () => {
  const { service, calls } = createHarness({
    detail: {
      title: "Губки",
      sourceCharacteristics: [
        { name: "Материал", value: "Пенополиуретан" },
        { name: " Тип ", value: "  Губка  " },
      ],
    },
  });

  await service.collectOzonSkuForAccount({ account: { id: "account-a" }, sku: "5237177559" });

  assert.deepEqual(calls.normalize[0].sourceCategory, { typeName: "Губка" });
});

test("normalizes localized variant prices and reference images at the scrape boundary", async () => {
  const { service, calls } = createHarness({
    detail: {
      title: "Набор щеток",
      variants: [
        {
          sku: "5601467220",
          title: "Красный",
          price: "106,39\u2009¥",
          image: "https://cdn.example/red.jpg",
          coverImage: "https://cdn.example/red.jpg",
          active: true,
          aspectValues: { Цвет: "Красный" },
        },
        {
          sku: "5601503879",
          title: "Синий",
          price: "1 218,77 ₽",
          coverImage: "https://cdn.example/blue.jpg",
          active: false,
          aspectValues: { Цвет: "Синий" },
        },
      ],
    },
  });

  await service.collectOzonSkuForAccount({ account: { id: "account-a" }, sku: "5601467220" });

  assert.deepEqual(calls.normalize[0].variants, [
    {
      sku: "5601467220",
      title: "Красный",
      price: "106.39",
      priceText: "106,39\u2009¥",
      currency: "CNY",
      image: "https://cdn.example/red.jpg",
      coverImage: "https://cdn.example/red.jpg",
      images: ["https://cdn.example/red.jpg"],
      active: true,
      aspectValues: { Цвет: "Красный" },
    },
    {
      sku: "5601503879",
      title: "Синий",
      price: "1218.77",
      priceText: "1 218,77 ₽",
      currency: "RUB",
      coverImage: "https://cdn.example/blue.jpg",
      images: ["https://cdn.example/blue.jpg"],
      active: false,
      aspectValues: { Цвет: "Синий" },
    },
  ]);
  assert.deepEqual(calls.normalize[0].variantData, { variants: calls.normalize[0].variants });
});

test("an empty scrape reports failure without persisting an empty product", async () => {
  for (const detail of [null, { title: "" }]) {
    const { service, calls } = createHarness({ detail });
    await assert.rejects(service.collectOzonSkuForAccount({
      account: { id: "account-a" }, sku: "7003",
    }), { code: "ZONGZI_SKU_SCRAPE_EMPTY" });
    assert.deepEqual(calls.normalize, []);
    assert.deepEqual(calls.save, []);
  }
});

test("rejects missing account and invalid SKU before scraping or persistence", async () => {
  const { service, calls } = createHarness({ detail: { title: "unused" } });

  await assert.rejects(
    service.collectOzonSkuForAccount({ account: {}, sku: "123" }),
    { code: "ZONGZI_SKU_ACCOUNT_REQUIRED" },
  );
  await assert.rejects(
    service.collectOzonSkuForAccount({ account: { id: "account-a" }, sku: " \n " }),
    { code: "ZONGZI_SKU_INVALID" },
  );
  await assert.rejects(
    service.collectOzonSkuForAccount({ account: { id: "account-a" }, sku: "x".repeat(161) }),
    { code: "ZONGZI_SKU_INVALID" },
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
      assert.equal(error.code, "ZONGZI_SKU_COLLECTION_FAILED");
      assert.equal(error.message, "ZONGZI_SKU_COLLECTION_FAILED");
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
    { code: "ZONGZI_SKU_COLLECTION_FAILED" },
  );
});

test("a failed placeholder is not a successful duplicate and is never silently overwritten", async () => {
  const existing = {id:"7003",sku:"7003",raw:{error:"scrape_failed"},listingDraft:{images:[],price:"12",packageWeight:"100"}};
  for (const detail of [null,{title:"Товар",images:["https://cdn.example/main.jpg"]}]) {
    const {service,calls} = createHarness({existing,detail});
    await assert.rejects(service.collectOzonSkuForAccount({account:{id:"account-a"},sku:"7003"}),{code:"ZONGZI_SKU_SCRAPE_EMPTY"});
    assert.deepEqual(calls.scrape,[]);
    assert.deepEqual(calls.save,[]);
  }
});
