import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const scriptTemplate = readFileSync(new URL("../scrape-script.js", import.meta.url), "utf8");

function stateElement({ id = "", state }) {
  return {
    id,
    getAttribute(name) {
      if (name === "id") return id;
      if (name === "data-state") return JSON.stringify(state);
      if (name === "data-widget") return "";
      return null;
    },
  };
}

test("Excel SKU scraping keeps the complete Ozon gallery when JSON-LD exposes only the cover", async () => {
  const sku = "3132435891";
  const images = [
    "https://ir-20.ozone.ru/s3/multimedia-1-l/12129305133.jpg",
    "https://ir-20.ozone.ru/s3/multimedia-1-2/9060491702.jpg",
    "https://ir-20.ozone.ru/s3/multimedia-1-p/9060491581.jpg",
  ];
  const gallery = stateElement({
    id: "state-webGallery-3311626-default-1",
    state: { sku, coverImage: images[0], images },
  });
  const jsonLd = {
    textContent: JSON.stringify({
      "@type": "Product",
      name: "Термометр",
      image: images[0],
      offers: { price: "1000", priceCurrency: "RUB" },
    }),
  };
  const document = {
    querySelector(selector) {
      if (selector === "h1") return { textContent: "Термометр" };
      return null;
    },
    querySelectorAll(selector) {
      if (selector === 'script[type="application/ld+json"]') return [jsonLd];
      if (selector === "[data-state]") return [gallery];
      if (selector.includes("webGallery") || selector.includes("state-webGallery")) return [gallery];
      return [];
    },
  };
  const location = {
    origin: "https://www.ozon.ru",
    href: `https://www.ozon.ru/product/termometr-${sku}/`,
    pathname: `/product/termometr-${sku}/`,
  };
  const logs = [];
  const source = scriptTemplate.replace("SKU_PLACEHOLDER", JSON.stringify(sku));
  await vm.runInNewContext(`(async () => { ${source} })()`, {
    URL,
    console,
    cliLog(value) { logs.push(value); },
    document,
    location,
    listTabs: async () => [{ url: location.href }],
    openOrReuseTab: async () => {},
    setTimeout(callback) { callback(); },
    useOrCreateTaskSpace: async () => ({ id: 1 }),
    window: { location },
    js: async (expression) => {
      if (expression.includes("window.location.href =")) return undefined;
      return vm.runInNewContext(expression, { URL, document, location, window: { location } });
    },
  });

  assert.equal(logs.length, 1);
  const product = JSON.parse(logs[0]);
  assert.equal(product.primaryImage, images[0]);
  assert.deepEqual(product.images, images);
});

test("Excel SKU scraping falls back to Ozon composer data when the PDP is a connection-error page", async () => {
  const sku = "4873048125";
  const images = [
    "https://ir-20.ozone.ru/s3/multimedia-1-5/11929550261.jpg",
    "https://ir-20.ozone.ru/s3/multimedia-1-l/9940984221.jpg",
  ];
  const composer = {
    widgetStates: {
      "webProductHeading-1": JSON.stringify({ title: "Мячик для собак" }),
      "webGallery-1": JSON.stringify({
        sku,
        coverImage: images[0],
        images: images.map((src) => ({ src })),
      }),
      "webPrice-1": JSON.stringify({ price: "28,77 ¥", cardPrice: "25,82 ¥" }),
      "webShortCharacteristics-1": JSON.stringify({
        characteristics: [{
          title: { textRs: [{ content: "Тип" }] },
          values: [{ text: "Игрушка для животных" }],
        }],
      }),
      "webProductMainWidget-1": JSON.stringify({
        sku,
        url: `/product/myachik-dlya-sobak-${sku}/`,
      }),
    },
    layoutTrackingInfo: JSON.stringify({
      categoryId: 12308,
      hierarchy: "Товары для животных/Для собак/Игрушки",
    }),
  };
  const document = {
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
  const location = {
    origin: "https://www.ozon.ru",
    href: `https://www.ozon.ru/product/${sku}/`,
    pathname: `/product/${sku}/`,
  };
  const logs = [];
  const source = scriptTemplate.replace("SKU_PLACEHOLDER", JSON.stringify(sku));
  const pageContext = {
    URL,
    document,
    location,
    window: { location },
    fetch: async () => ({
      ok: true,
      async json() { return composer; },
    }),
  };

  await vm.runInNewContext(`(async () => { ${source} })()`, {
    URL,
    console,
    cliLog(value) { logs.push(value); },
    document,
    location,
    listTabs: async () => [{ url: location.href }],
    openOrReuseTab: async () => {},
    setTimeout(callback) { callback(); },
    useOrCreateTaskSpace: async () => ({ id: 1 }),
    window: { location },
    js: async (expression) => {
      if (expression.includes("window.location.href =")) return undefined;
      return vm.runInNewContext(expression, pageContext);
    },
  });

  assert.equal(logs.length, 1);
  const product = JSON.parse(logs[0]);
  assert.equal(product.title, "Мячик для собак");
  assert.equal(product.price, "28,77 ¥");
  assert.equal(product.primaryImage, images[0]);
  assert.deepEqual(product.images, images);
  assert.deepEqual(product.categories, ["Товары для животных", "Для собак", "Игрушки"]);
  assert.deepEqual(product.sourceCharacteristics, [{
    name: "Тип",
    value: "Игрушка для животных",
  }]);
});
