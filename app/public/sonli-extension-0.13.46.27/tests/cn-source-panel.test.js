const assert = require("assert");
const fs = require("fs");
const path = require("path");

function loadPlaywright() {
  try {
    return require("playwright");
  } catch {}

  return require(path.join(__dirname, "..", "..", "backend", "node_modules", "playwright"));
}

const { chromium } = loadPlaywright();

const scraperHelperPath = path.join(__dirname, "..", "lib", "cn-source-scraper.js");
const panelPath = path.join(__dirname, "..", "lib", "cn-source-panel.js");
const productPath = path.join(__dirname, "..", "content", "cn-source-product.js");
const manifestPath = path.join(__dirname, "..", "manifest.json");
const debugBridgePagePath = path.join(__dirname, "..", "lib", "cn-source-debug-page.js");

async function withJdPage(fn) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const captured = [];

  await page.route("https://item.jd.com/100285845266.html", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: `
        <!doctype html>
        <html>
          <head>
            <title>百岁山348ml*24瓶 - 京东</title>
            <meta property="og:image" content="https://img10.360buyimg.com/n1/jfs/main.jpg">
            <script type="application/ld+json">
              {
                "@type": "Product",
                "name": "百岁山348ml*24瓶",
                "image": [
                  "https://img10.360buyimg.com/n1/jfs/main.jpg",
                  "https://img10.360buyimg.com/n1/jfs/side.jpg"
                ],
                "offers": { "price": "34" }
              }
            </script>
            <script>
              window.__JZ_TEST_DETAIL__ = {
                productId: "100285845266",
                title: "百岁山348ml*24瓶",
                images: [
                  "https://img10.360buyimg.com/n1/jfs/main.jpg",
                  "https://img10.360buyimg.com/n1/jfs/side.jpg"
                ],
                videoUrl: "https://vod.300hu.com/jd.mp4",
                videoCover: "https://img10.360buyimg.com/n1/jfs/video.jpg",
                seller: { name: "饮品折扣京东自营专区", shopUrl: "https://mall.jd.com/index-100.html" },
                variants: [
                  {
                    sku: "100285845266-348",
                    name: "百岁山348ml*24瓶",
                    price: "34",
                    image: "https://img10.360buyimg.com/n1/jfs/main.jpg",
                    aspectValues: { 规格: "百岁山348ml*24瓶" }
                  }
                ]
              };
            </script>
          </head>
          <body>
            <h1 class="sku-name">百岁山348ml*24瓶</h1>
            <span class="p-price"><span>￥</span><span class="price">34</span></span>
            <div id="spec-list">
              <img src="https://img10.360buyimg.com/n1/jfs/main.jpg">
              <img src="https://img10.360buyimg.com/n1/jfs/side.jpg">
            </div>
            <div class="item ellipsis selected" data-sku="100285845266-348">百岁山348ml*24瓶</div>
            <a class="name" href="https://mall.jd.com/index-100.html">饮品折扣京东自营专区</a>
          </body>
        </html>
      `,
    });
  });

  await page.exposeFunction("__captureJzcMessage", (message) => {
    captured.push(message);
    return { ok: true, data: { result: { id: "jd-collect-id", action: "created" } } };
  });

  await page.goto("https://item.jd.com/100285845266.html");
  await page.evaluate(() => {
    window.chrome = {
      runtime: {
        lastError: null,
        sendMessage(message, cb) {
          window.__captureJzcMessage(message).then((resp) => cb(resp));
        },
      },
    };
  });

  await page.addScriptTag({ path: scraperHelperPath });
  await page.addScriptTag({ path: panelPath });
  await page.addScriptTag({ path: productPath });
  await page.waitForSelector('[data-action="collect-product"]', { timeout: 5000 });

  try {
    await fn(page, captured);
  } finally {
    await browser.close();
  }
}

async function withJdRenderedNoisePage(fn) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const captured = [];

  const title = "\u666f\u7530\u767e\u5c81\u5c71\uff08ganten\uff09\u996e\u7528\u5929\u7136\u77ff\u6cc9\u6c34 348ml*24\u74f6 \u6574\u7bb1\u88c5";
  const badTitle = "\u6700\u5c0f\u5355\u4ef7\u8ba1\u7b97\u5668";
  const sellerName = "\u996e\u54c1\u6298\u6263\u4eac\u4e1c\u81ea\u8425\u4e13\u533a";
  const mainImage = "https://img10.360buyimg.com/n1/jfs/ganten-main.jpg";
  const logoImage = "https://img10.360buyimg.com/imgzone/jd-logo.png";

  await page.route("https://item.jd.com/100285845266.html", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: `
        <!doctype html>
        <html>
          <head>
            <title>${title} - 京东</title>
            <script>
              window.__JZ_TEST_DETAIL__ = {
                productId: "100285845266",
                name: "${badTitle}",
                image: ["${logoImage}"]
              };
            </script>
          </head>
          <body>
            <header>
              <img class="shop-logo" src="${logoImage}">
            </header>
            <main>
              <h1 class="sku-name">${title}</h1>
              <div class="p-price"><span class="price">34</span></div>
              <div id="spec-list">
                <img src="${mainImage}">
                <img src="https://img10.360buyimg.com/n1/jfs/ganten-side.jpg">
              </div>
              <div class="calculator-title">${badTitle}</div>
              <a class="name" href="https://mall.jd.com/index-100.html">${sellerName}</a>
            </main>
          </body>
        </html>
      `,
    });
  });

  await page.exposeFunction("__captureJzcMessage", (message) => {
    captured.push(message);
    return { ok: true, data: { result: { id: "jd-noise-collect-id", action: "created" } } };
  });

  await page.goto("https://item.jd.com/100285845266.html");
  await page.evaluate(() => {
    window.chrome = {
      runtime: {
        lastError: null,
        sendMessage(message, cb) {
          window.__captureJzcMessage(message).then((resp) => cb(resp));
        },
      },
    };
  });

  await page.addScriptTag({ path: scraperHelperPath });
  await page.addScriptTag({ path: panelPath });
  await page.addScriptTag({ path: productPath });
  await page.waitForSelector('[data-action="collect-product"]');

  try {
    await fn(page, captured, { title, badTitle, sellerName, mainImage, logoImage });
  } finally {
    await browser.close();
  }
}

async function withPifaPage(fn, options = {}) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const captured = [];
  const consoleMessages = [];
  const runtimeResponse = options.runtimeResponse || {
    ok: true,
    data: { result: { id: "pifa-collect-id", action: "created" } },
  };
  const runtimeLastErrorMessage = options.runtimeLastErrorMessage || "";

  page.on("console", (message) => {
    consoleMessages.push(message.text());
  });

  await page.route("https://pifa.pinduoduo.com/goods.html?goods_id=722497925613", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: `
        <!doctype html>
        <html>
          <head>
            <title>拼多多批发测试商品</title>
            <script>
              window.__JZ_TEST_DETAIL__ = {
                goodsId: "722497925613",
                title: "拼多多批发测试商品",
                price: "19.9",
                images: [
                  "https://img.pddpic.com/mms-material-img/main.jpeg",
                  "https://img.pddpic.com/mms-material-img/side.jpeg"
                ],
                seller: { name: "拼多多批发店铺" },
                variants: [
                  {
                    sku: "722497925613-red",
                    name: "红色",
                    price: "19.9",
                    image: "https://img.pddpic.com/mms-material-img/red.jpeg",
                    aspectValues: { 颜色: "红色" }
                  }
                ]
              };
            </script>
          </head>
          <body>
            <h1>拼多多批发测试商品</h1>
            <div class="price">¥19.9</div>
            <img src="https://img.pddpic.com/mms-material-img/main.jpeg">
            <div class="shop-name">拼多多批发店铺</div>
          </body>
        </html>
      `,
    });
  });

  await page.exposeFunction("__captureJzcMessage", (message) => {
    captured.push(message);
    return typeof runtimeResponse === "function" ? runtimeResponse(message) : runtimeResponse;
  });

  await page.goto("https://pifa.pinduoduo.com/goods.html?goods_id=722497925613");
  await page.evaluate((lastErrorMessage) => {
    const runtime = {
      lastError: null,
      sendMessage(message, cb) {
        if (lastErrorMessage) {
          runtime.lastError = { message: lastErrorMessage };
          cb(undefined);
          runtime.lastError = null;
          return;
        }
        window.__captureJzcMessage(message).then((resp) => cb(resp));
      },
    };
    window.chrome = { runtime };
  }, runtimeLastErrorMessage);

  await page.addScriptTag({ path: scraperHelperPath });
  await page.addScriptTag({ path: panelPath });
  await page.addScriptTag({ path: productPath });
  await page.waitForSelector('[data-action="collect-product"]');

  try {
    await fn(page, captured, consoleMessages);
  } finally {
    await browser.close();
  }
}

async function withPifaRenderedPage(fn) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const captured = [];

  await page.route("https://pifa.pinduoduo.com/detail/722497925613", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: `
        <!doctype html>
        <html>
          <head>
            <title>长条纸箱快递箱批发定做雨伞花卉水杯鱼竿包装盒三角形打包纸盒盒子</title>
          </head>
          <body>
            <header>购物车(0)</header>
            <main>
              <section>
                <div><span>品牌</span><strong>长条纸箱快递箱批发定做雨伞花卉水杯鱼竿包装盒三角形打包纸盒盒子</strong></div>
                <div><span>批发价</span><em>¥22.28 - 122.64</em></div>
                <div style="background-image:url('https://img.pddpic.com/mms-material-img/cardboard-main.jpeg')"></div>
                <div style="background-image:url('//img.pddpic.com/mms-material-img/cardboard-side.jpeg')"></div>
                <button>1号:6.5x25cm 大包360个</button>
                <button>三层特硬加强B瓦</button>
                <div>疯子包装旗舰店</div>
              </section>
            </main>
          </body>
        </html>
      `,
    });
  });

  await page.exposeFunction("__captureJzcMessage", (message) => {
    captured.push(message);
    return { ok: true, data: { result: { id: "pifa-rendered-collect-id", action: "created" } } };
  });

  await page.goto("https://pifa.pinduoduo.com/detail/722497925613");
  await page.evaluate(() => {
    window.chrome = {
      runtime: {
        lastError: null,
        sendMessage(message, cb) {
          window.__captureJzcMessage(message).then((resp) => cb(resp));
        },
      },
    };
  });

  await page.addScriptTag({ path: scraperHelperPath });
  await page.addScriptTag({ path: panelPath });
  await page.addScriptTag({ path: productPath });
  await page.waitForSelector('[data-action="collect-product"]');

  try {
    await fn(page, captured);
  } finally {
    await browser.close();
  }
}

async function withPifaGoodsDetailPage(fn) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const captured = [];

  const url = "https://pifa.pinduoduo.com/goods/detail/?gid=458592806&sn=64658.3319664.0.458592806&refer_page_id=64658_1782270720379_0c006e8eb";
  await page.route(url, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: `
        <!doctype html>
        <html>
          <head>
            <title>拼多多批发 - 拼多多官方采购批发平台，多多批发</title>
          </head>
          <body>
            <main>
              <h2 class="goods-name">长条纸箱快递箱批发定做雨伞花卉水杯鱼竿包装盒三角形打包纸盒子<span>分享商品</span></h2>
              <span class="current-price-unit">￥</span>
              <span class="current-price">22.28 - 122.64</span>
              <span class="origin-price">¥23.20 - 125.14</span>
              <img class="goods-img" src="https://img.pddpic.com/mms-material-img/2020-07-18/8f9dda01.jpg.a.jpeg?imageMogr2/quality/90/format/webp">
              <img class="goods-img" src="https://img.pddpic.com/mms-material-img/2021-12-10/2beebbf3.jpeg.a.jpeg?imageMogr2/quality/90/format/webp">
              <div style="background-image:url('https://video3.yangkeduo.com/i1/2021-07-25/video.mp4.pdd.000001.jpeg?imageMogr2/quality/90/format/webp')"></div>
              <div class="shop-name">疯子包装旗舰店</div>
            </main>
          </body>
        </html>
      `,
    });
  });

  await page.exposeFunction("__captureJzcMessage", (message) => {
    captured.push(message);
    return { ok: true, data: { result: { id: "pifa-goods-detail-collect-id", action: "created" } } };
  });

  await page.goto(url);
  await page.evaluate(() => {
    window.chrome = {
      runtime: {
        lastError: null,
        sendMessage(message, cb) {
          window.__captureJzcMessage(message).then((resp) => cb(resp));
        },
      },
    };
  });

  await page.addScriptTag({ path: scraperHelperPath });
  await page.addScriptTag({ path: panelPath });
  await page.addScriptTag({ path: productPath });
  await page.waitForSelector('[data-action="collect-product"]');

  try {
    await fn(page, captured);
  } finally {
    await browser.close();
  }
}

async function withTaobaoRenderedPage(fn) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const captured = [];

  const title = "\u5305\u90ae\u6cf0\u56fd\u559c\u51c0hygiene\u6d17\u8863\u6db2\u53bb\u6c61\u5976\u9999\u6d77\u6d0b\u9999\u5b66\u751f\u5bb6\u7528";
  const reviewTitle = "\u7528\u6237\u8bc4\u4ef7\u00b78000+";
  const openShopText = "\u514d\u8d39\u5f00\u5e97";
  const shopName = "\u559c\u51c0\u6d77\u5916\u5e97";
  const mainImage = "https://img.alicdn.com/imgextra/i4/220123/O1CN01hygiene-main.jpg";
  const sideImage = "https://img.alicdn.com/imgextra/i2/220123/O1CN01hygiene-side.jpg";
  const url = "https://item.taobao.com/item.htm?id=980680602229";

  await page.route(url, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: `
        <!doctype html>
        <html>
          <head>
            <title>${title}-淘宝网</title>
          </head>
          <body>
            <header>
              <a class="site-nav-menu-hd" href="https://ishop.taobao.com/openshop/tb_open_shop_landing.htm">${openShopText}</a>
              <img src="https://img.alicdn.com/tfs/TB1placeholder.gif" alt="placeholder">
            </header>
            <main>
              <section class="Tabs--container">
                <div class="tab-title">${reviewTitle}</div>
              </section>
              <section class="BasicContent--root">
                <div class="Title--main">${title}</div>
                <div class="Price--content">¥2.09</div>
                <div class="PicGallery--root">
                  <img class="PicGallery--mainPic" src="${mainImage}">
                  <img class="PicGallery--thumb" data-src="${sideImage}">
                </div>
                <a class="ShopHeader--shopName" href="https://shop123456.taobao.com/">${shopName}</a>
              </section>
            </main>
          </body>
        </html>
      `,
    });
  });

  await page.exposeFunction("__captureJzcMessage", (message) => {
    captured.push(message);
    return { ok: true, data: { result: { id: "taobao-collect-id", action: "created" } } };
  });

  await page.goto(url);
  await page.evaluate(() => {
    window.chrome = {
      runtime: {
        lastError: null,
        sendMessage(message, cb) {
          window.__captureJzcMessage(message).then((resp) => cb(resp));
        },
      },
    };
  });

  await page.addScriptTag({ path: scraperHelperPath });
  await page.addScriptTag({ path: panelPath });
  await page.addScriptTag({ path: productPath });
  await page.waitForSelector('[data-action="collect-product"]');

  try {
    await fn(page, captured, { title, reviewTitle, openShopText, shopName, mainImage, sideImage });
  } finally {
    await browser.close();
  }
}

async function withTaobaoSkuNoisePage(fn) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const captured = [];

  const title = "\u6cf0\u56fd\u8fdb\u53e3hygiene\u559c\u51c0\u67d4\u987a\u5242\u8863\u7269\u62a4\u7406\u67d4\u8f6f\u9632\u9759\u7535\u6301\u4e45\u7559\u9999";
  const badTitle = "\u6301\u4e45\u7559\u9999";
  const badSeller = "\u5f00\u76f4\u64ad\u5e97";
  const sellerName = "\u559c\u51c0\u6d77\u5916\u65d7\u8230\u5e97";
  const mainImage = "https://img.alicdn.com/imgextra/i4/220123/O1CN01hygiene-softener-main.jpg";
  const badImage = "https://img.alicdn.com/imgextra/i4/220123/O1CN01live-tag.jpg";
  const url = "https://item.taobao.com/item.htm?id=908658719203";

  await page.route(url, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: `
        <!doctype html>
        <html>
          <head>
            <title>${title}-淘宝网</title>
            <script>
              window.__JZ_TEST_DETAIL__ = {
                itemId: "908658719203",
                title: "${badTitle}",
                image: ["${badImage}"],
                seller: {
                  name: "${badSeller}",
                  shopUrl: "https://web.m.taobao.com/app/tblive-app/live-home/pages/index"
                }
              };
            </script>
          </head>
          <body>
            <header>
              <a href="https://web.m.taobao.com/app/tblive-app/live-home/pages/index">${badSeller}</a>
            </header>
            <main>
              <section class="SkuContent--root">
                <div class="Title--label">${badTitle}</div>
              </section>
              <section class="ItemHeader--root">
                <h1 class="ItemHeader--title">${title}</h1>
                <div class="Price--content">¥2.09</div>
              </section>
              <section class="galleryRoot--real">
                <img class="mainPic--real" src="${mainImage}">
                <img class="PicGallery--thumb" src="https://img.alicdn.com/imgextra/i2/220123/O1CN01hygiene-softener-side.jpg">
              </section>
              <a class="ShopHeader--shopName" href="https://shop987654.taobao.com/">${sellerName}</a>
            </main>
          </body>
        </html>
      `,
    });
  });

  await page.exposeFunction("__captureJzcMessage", (message) => {
    captured.push(message);
    return { ok: true, data: { result: { id: "taobao-noise-collect-id", action: "created" } } };
  });

  await page.goto(url);
  await page.evaluate(() => {
    window.chrome = {
      runtime: {
        lastError: null,
        sendMessage(message, cb) {
          window.__captureJzcMessage(message).then((resp) => cb(resp));
        },
      },
    };
  });

  await page.addScriptTag({ path: scraperHelperPath });
  await page.addScriptTag({ path: panelPath });
  await page.addScriptTag({ path: productPath });
  await page.waitForSelector('[data-action="collect-product"]');

  try {
    await fn(page, captured, { title, badTitle, badSeller, sellerName, mainImage, badImage });
  } finally {
    await browser.close();
  }
}

async function withTaobaoAliImageSuffixPage(fn) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const captured = [];

  const title = "\u5e3d\u5b50\u9632\u98ce\u7ef3\u4e13\u7528\u7ef3\u5e26\u9632\u6389\u795e\u5668\u592a\u9633\u5e3d\u56fa\u5b9a\u5e26\u5b50\u53ef\u8c03\u8282\u914d\u4ef6\u591a\u529f\u80fd";
  const rawMainImage = "https://img.alicdn.com/imgextra/i4/3505758707/O1CN019COSaE2EBrgNCeDPB_!!3505758707.jpg_760x760q30.jpg_.webp";
  const normalizedMainImage = "https://img.alicdn.com/imgextra/i4/3505758707/O1CN019COSaE2EBrgNCeDPB_!!3505758707.jpg";
  const url = "https://item.taobao.com/item.htm?id=3505758707";

  await page.route(url, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: `
        <!doctype html>
        <html>
          <head><title>${title}-淘宝网</title></head>
          <body>
            <main>
              <h1 class="ItemHeader--title">${title}</h1>
              <div class="Price--content">¥1.51</div>
              <section class="PicGallery--root">
                <img class="mainPic--real" src="${rawMainImage}">
              </section>
              <a class="ShopHeader--shopName" href="https://shop3505758707.taobao.com/">配件小店</a>
            </main>
          </body>
        </html>
      `,
    });
  });

  await page.exposeFunction("__captureJzcMessage", (message) => {
    captured.push(message);
    return { ok: true, data: { result: { id: "taobao-image-suffix-collect-id", action: "created" } } };
  });

  await page.goto(url);
  await page.evaluate(() => {
    window.chrome = {
      runtime: {
        lastError: null,
        sendMessage(message, cb) {
          window.__captureJzcMessage(message).then((resp) => cb(resp));
        },
      },
    };
  });

  await page.addScriptTag({ path: scraperHelperPath });
  await page.addScriptTag({ path: panelPath });
  await page.addScriptTag({ path: productPath });
  await page.waitForSelector('[data-action="collect-product"]');

  try {
    await fn(page, captured, { title, rawMainImage, normalizedMainImage });
  } finally {
    await browser.close();
  }
}

async function withTaobaoDomVariantPage(fn) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const captured = [];

  const title = "\u65d7\u8230\u6b3e\u84dd\u7259\u8033\u673a\u4e3b\u52a8\u964d\u566a\u957f\u7eed\u822a\u9002\u7528\u5b66\u751f\u901a\u52e4";
  const skuLabel = "8h\uff08\u5355\u6b21\u7eed\u822a\uff09 36\uff08\u603b\u7eed\u822a\uff09";
  const aggregateColorLabel = "\u9ed1\u8272\u5343\u4eba\u52a0\u8d2d\u767d\u8272";
  const colorImage = "https://img.alicdn.com/imgextra/i4/3505758707/O1CN01blue_!!3505758707.jpg_760x760q30.jpg_.webp";
  const url = "https://detail.tmall.com/item.htm?id=971785515390";

  await page.route(url, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: `
        <!doctype html>
        <html>
          <head>
            <title>${title}-tmall.com天猫</title>
            <script>
              window.__JZ_TEST_DETAIL__ = {
                itemId: "971785515390",
                title: "${skuLabel}",
                images: ["https://img.alicdn.com/imgextra/i4/3505758707/O1CN01main_!!3505758707.jpg_760x760q30.jpg_.webp"]
              };
            </script>
          </head>
          <body>
            <main>
              <section class="SkuContent--root">
                <div class="SkuItem--group">
                  <div class="SkuItem--label">续航版本</div>
                  <button class="SkuValue--item">${skuLabel}</button>
                  <button class="SkuValue--item">12h（单次续航） 48（总续航）</button>
                </div>
                <div class="SkuItem--group">
                  <div class="SkuItem--label">颜色分类</div>
                  <div class="skuValueWrap--real">${aggregateColorLabel}
                    <button class="SkuValue--item"><img src="${colorImage}">黑色千人加购</button>
                    <button class="SkuValue--item">白色</button>
                  </div>
                </div>
              </section>
              <img class="mainPic--real" src="https://img.alicdn.com/imgextra/i4/3505758707/O1CN01main_!!3505758707.jpg_760x760q30.jpg_.webp">
              <a class="ShopHeader--shopName" href="https://shop124254257.taobao.com/">旗舰店</a>
            </main>
          </body>
        </html>
      `,
    });
  });

  await page.exposeFunction("__captureJzcMessage", (message) => {
    captured.push(message);
    return { ok: true, data: { result: { id: "taobao-dom-variant-collect-id", action: "created" } } };
  });

  await page.goto(url);
  await page.evaluate(() => {
    window.chrome = {
      runtime: {
        lastError: null,
        sendMessage(message, cb) {
          window.__captureJzcMessage(message).then((resp) => cb(resp));
        },
      },
    };
  });

  await page.addScriptTag({ path: scraperHelperPath });
  await page.addScriptTag({ path: panelPath });
  await page.addScriptTag({ path: productPath });
  await page.waitForSelector('[data-action="collect-product"]');

  try {
    await fn(page, captured, { title, skuLabel, colorImage, aggregateColorLabel });
  } finally {
    await browser.close();
  }
}

async function withJdDomVariantPage(fn) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const captured = [];

  const title = "真维斯（Jeanswest）三本针260g纯棉重磅短袖t恤男款夏季薄款宽松圆领";
  const sellerName = "真维斯男装旗舰店";
  const url = "https://item.jd.com/10097174173489.html";

  await page.route(url, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: `
        <!doctype html>
        <html>
          <head><title>${title} - 京东</title></head>
          <body>
            <main>
              <h1 class="sku-name">${title}</h1>
              <div class="p-price"><span class="price">99</span></div>
              <div class="ShopHeader--bar">
                <a class="ShopHeader--name" href="https://mall.jd.com/index-100971.html">${sellerName}</a>
              </div>
              <div class="skuColor--row">
                <span class="skuLabel--text">颜色</span>
                <button class="skuOption--card"><img src="https://img10.360buyimg.com/n1/jfs/jd-navy.jpg">藏青</button>
                <button class="skuOption--card">白色</button>
              </div>
              <div class="skuSize--row">
                <span class="skuLabel--text">尺码</span>
                <button class="skuOption--card">M</button>
                <button class="skuOption--card">L</button>
              </div>
              <div id="spec-list"><img src="https://img10.360buyimg.com/n1/jfs/jd-main.jpg"></div>
            </main>
          </body>
        </html>
      `,
    });
  });

  await page.exposeFunction("__captureJzcMessage", (message) => {
    captured.push(message);
    return { ok: true, data: { result: { id: "jd-dom-variant-collect-id", action: "created" } } };
  });

  await page.goto(url);
  await page.evaluate(() => {
    window.chrome = {
      runtime: {
        lastError: null,
        sendMessage(message, cb) {
          window.__captureJzcMessage(message).then((resp) => cb(resp));
        },
      },
    };
  });

  await page.addScriptTag({ path: scraperHelperPath });
  await page.addScriptTag({ path: panelPath });
  await page.addScriptTag({ path: productPath });
  await page.waitForSelector('[data-action="collect-product"]');

  try {
    await fn(page, captured, { title, sellerName });
  } finally {
    await browser.close();
  }
}

async function withPifaSpecPanelVariantPage(fn) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const captured = [];

  const title = "注音版儿童励志成长故事书小学生6-12岁一二三四五年级课外书籍";
  const url = "https://pifa.pinduoduo.com/goods.html?goods_id=6930774258";

  await page.route(url, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: `
        <!doctype html>
        <html>
          <head><title>${title}</title></head>
          <body>
            <main>
              <h1 class="goods-name">${title}</h1>
              <div class="current-price">69.52</div>
              <div class="SpecPanel--root">
                <div class="SpecItem--row">
                  <span class="SpecLabel--text">版本</span>
                  <button class="SpecValue--card">注音版</button>
                  <button class="SpecValue--card">无注音版</button>
                </div>
                <div class="SpecItem--row">
                  <span class="SpecLabel--text">册数</span>
                  <button class="SpecValue--card">全套19册</button>
                  <button class="SpecValue--card">精选10册</button>
                </div>
              </div>
              <img class="goods-img" src="https://img.pddpic.com/mms-material-img/pifa-book.jpeg">
              <div class="shop-name">童书批发店</div>
            </main>
          </body>
        </html>
      `,
    });
  });

  await page.exposeFunction("__captureJzcMessage", (message) => {
    captured.push(message);
    return { ok: true, data: { result: { id: "pifa-spec-panel-collect-id", action: "created" } } };
  });

  await page.goto(url);
  await page.evaluate(() => {
    window.chrome = {
      runtime: {
        lastError: null,
        sendMessage(message, cb) {
          window.__captureJzcMessage(message).then((resp) => cb(resp));
        },
      },
    };
  });

  await page.addScriptTag({ path: scraperHelperPath });
  await page.addScriptTag({ path: panelPath });
  await page.addScriptTag({ path: productPath });
  await page.waitForSelector('[data-action="collect-product"]');

  try {
    await fn(page, captured, { title });
  } finally {
    await browser.close();
  }
}

async function withPifaSkuListVariantPage(fn) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const captured = [];

  const title = "猫砂除臭20斤装40斤10斤结团猫沙膨润土活性炭大袋猫砂防臭清仓";
  const url = "https://pifa.pinduoduo.com/goods/detail/?gid=407915951684";

  await page.route(url, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: `
        <!doctype html>
        <html>
          <head><title>拼多多批发 - 拼多多官方采购批发平台，多多批发</title></head>
          <body>
            <main>
              <div class="goodsHeadInfoL">
                <a class="goods-link" href="https://pifa.pinduoduo.com/mall?mid=pet-shop">
                  <div class="store-name">淘到鱼宠物用品专营店</div>
                </a>
              </div>
              <h2 class="goods-name"><span class="goods-n-title">${title}</span><span>分享商品</span></h2>
              <div class="current-price">￥7.83 - 38.52</div>
              <div class="sku-select-row">
                <div class="sku-select-row-label">重量</div>
                <div class="sku-select-row-all">全部</div>
                <div class="sku-select-row-list">
                  <div class="sku-select-row-item">40斤原味</div>
                  <div class="sku-select-row-item">40斤柠檬味</div>
                  <div class="sku-select-row-item">20斤活性炭</div>
                </div>
              </div>
              <div class="sku-list">
                <div class="sku-list-row">
                  <img class="sku-image-inner" src="https://img.pddpic.com/mms-material-img/cat-litter-40-original.jpeg">
                  <div class="sku-title">40斤原味</div>
                  <div class="sku-price">¥31.19</div>
                </div>
                <div class="sku-list-row">
                  <img class="sku-image-inner" src="https://img.pddpic.com/mms-material-img/cat-litter-40-lemon.jpeg">
                  <div class="sku-title">40斤柠檬味</div>
                  <div class="sku-price">¥33.17</div>
                </div>
                <div class="sku-list-row">
                  <img class="sku-image-inner" src="https://img.pddpic.com/mms-material-img/cat-litter-20-carbon.jpeg">
                  <div class="sku-title">20斤活性炭</div>
                  <div class="sku-price">¥19.61</div>
                </div>
              </div>
              <img class="goods-img" src="https://img.pddpic.com/mms-material-img/pifa-cat-main.jpeg">
            </main>
          </body>
        </html>
      `,
    });
  });

  await page.exposeFunction("__captureJzcMessage", (message) => {
    captured.push(message);
    return { ok: true, data: { result: { id: "pifa-sku-list-collect-id", action: "created" } } };
  });

  await page.goto(url);
  await page.evaluate(() => {
    window.chrome = {
      runtime: {
        lastError: null,
        sendMessage(message, cb) {
          window.__captureJzcMessage(message).then((resp) => cb(resp));
        },
      },
    };
  });

  await page.addScriptTag({ path: scraperHelperPath });
  await page.addScriptTag({ path: panelPath });
  await page.addScriptTag({ path: productPath });
  await page.waitForSelector('[data-action="collect-product"]');

  try {
    await fn(page, captured, { title });
  } finally {
    await browser.close();
  }
}

async function withPifaDomVariantPage(fn) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const captured = [];

  const title = "\u62fc\u591a\u591a\u6279\u53d1\u7eb8\u76d2\u591a\u89c4\u683c\u6d4b\u8bd5\u5546\u54c1";
  const url = "https://pifa.pinduoduo.com/goods.html?goods_id=722497925613";

  await page.route(url, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: `
        <!doctype html>
        <html>
          <head><title>${title}</title></head>
          <body>
            <main>
              <h1 class="goods-name">${title}</h1>
              <div class="current-price">19.9</div>
              <div class="sku-panel">
                <div class="spec-group">
                  <div class="spec-label">规格</div>
                  <button class="spec-option">小号</button>
                  <button class="spec-option">大号</button>
                </div>
                <div class="spec-group">
                  <div class="spec-label">颜色</div>
                  <button class="spec-option">白色</button>
                  <button class="spec-option">牛皮色</button>
                </div>
              </div>
              <img class="goods-img" src="https://img.pddpic.com/mms-material-img/pifa-main.jpeg">
              <div class="shop-name">批发店铺</div>
            </main>
          </body>
        </html>
      `,
    });
  });

  await page.exposeFunction("__captureJzcMessage", (message) => {
    captured.push(message);
    return { ok: true, data: { result: { id: "pifa-dom-variant-collect-id", action: "created" } } };
  });

  await page.goto(url);
  await page.evaluate(() => {
    window.chrome = {
      runtime: {
        lastError: null,
        sendMessage(message, cb) {
          window.__captureJzcMessage(message).then((resp) => cb(resp));
        },
      },
    };
  });

  await page.addScriptTag({ path: scraperHelperPath });
  await page.addScriptTag({ path: panelPath });
  await page.addScriptTag({ path: productPath });
  await page.waitForSelector('[data-action="collect-product"]');

  try {
    await fn(page, captured, { title });
  } finally {
    await browser.close();
  }
}

async function withGlobalSourcePage({ url, html, collectId }, fn) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const captured = [];

  await page.route(url, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: html,
    });
  });

  await page.exposeFunction("__captureJzcMessage", (message) => {
    captured.push(message);
    return { ok: true, data: { result: { id: collectId, action: "created" } } };
  });

  await page.goto(url);
  await page.evaluate(() => {
    window.chrome = {
      runtime: {
        lastError: null,
        sendMessage(message, cb) {
          window.__captureJzcMessage(message).then((resp) => cb(resp));
        },
      },
    };
  });

  await page.addScriptTag({ path: scraperHelperPath });
  await page.addScriptTag({ path: panelPath });
  await page.addScriptTag({ path: productPath });
  await page.waitForSelector('[data-action="collect-product"]');

  try {
    await fn(page, captured);
  } finally {
    await browser.close();
  }
}

async function withAmazonPage(fn) {
  const url = "https://www.amazon.com/dp/B0TESTASN1";
  const title = "Amazon sample backpack";
  await withGlobalSourcePage({
    url,
    collectId: "amazon-collect-id",
    html: `
      <!doctype html>
      <html>
        <head>
          <title>${title}: Amazon.com</title>
          <meta property="og:image" content="https://m.media-amazon.com/images/I/71main._AC_SX679_.jpg">
          <script type="application/ld+json">
            {
              "@type": "Product",
              "name": "${title}",
              "image": ["https://m.media-amazon.com/images/I/71main._AC_SX679_.jpg"],
              "offers": { "price": "29.99" }
            }
          </script>
        </head>
        <body>
          <h1 id="title"><span id="productTitle">${title}</span></h1>
          <div id="bylineInfo">Visit the Amazon Sample Store</div>
          <a id="sellerProfileTriggerId" href="/sp?seller=A1SELLER">Amazon Sample Store</a>
          <span class="a-price"><span class="a-offscreen">$29.99</span></span>
          <div id="imgTagWrapperId">
            <img id="landingImage" src="https://m.media-amazon.com/images/I/71main._AC_SX679_.jpg">
          </div>
          <div id="variation_color_name">
            <label>Color</label>
            <li class="swatchSelect"><img src="https://m.media-amazon.com/images/I/71black.jpg" alt="Black"></li>
            <li><img src="https://m.media-amazon.com/images/I/71blue.jpg" alt="Blue"></li>
          </div>
          <select id="native_dropdown_selected_size_name">
            <option selected>M</option>
            <option>L</option>
          </select>
        </body>
      </html>
    `,
  }, async (page, captured) => fn(page, captured, { title }));
}

async function withAmazonTwisterAggregatePage(fn) {
  const url = "https://www.amazon.com/Acer-Aspire-Go-Laptop/dp/B0FN9JLD28?th=1";
  const title = "Acer Aspire Go 15 AI Ready Laptop";
  await withGlobalSourcePage({
    url,
    collectId: "amazon-twister-collect-id",
    html: `
      <!doctype html>
      <html>
        <head>
          <title>Amazon.com: ${title}</title>
          <meta property="og:image" content="https://m.media-amazon.com/images/I/71acer._AC_SX679_.jpg">
        </head>
        <body>
          <h1 id="title"><span id="productTitle">${title}</span></h1>
          <div id="bylineInfo">Visit the Acer Store</div>
          <span class="a-price"><span class="a-offscreen">$279.99</span></span>
          <div id="imgTagWrapperId">
            <img id="landingImage" src="https://m.media-amazon.com/images/I/71acer._AC_SX679_.jpg">
          </div>
          <div id="twister_feature_div">
            <div id="variation_style_name">
              <label>Style</label>
              <ul>
                <li>
                  <button title="R7 7730u">
                    <img src="https://m.media-amazon.com/images/I/71r7.jpg" alt="R7 7730u">
                    <span>R7 7730u</span>
                    <span>2 options from $549.99</span>
                  </button>
                </li>
                <li>
                  <button title="R3 7320u">
                    <img src="https://m.media-amazon.com/images/I/71r3.jpg" alt="R3 7320u">
                    <span>R3 7320u</span>
                    <span>2 options from $279.99</span>
                  </button>
                </li>
              </ul>
            </div>
            <div id="variation_color_name">
              <label>Color</label>
              <ul>
                <li><button title="Pure Silver"><img src="https://m.media-amazon.com/images/I/71silver.jpg" alt="Pure Silver"></button></li>
                <li><button title="Steel Gray"><img src="https://m.media-amazon.com/images/I/71gray.jpg" alt="Steel Gray"></button></li>
              </ul>
            </div>
            <select id="native_dropdown_selected_size_name">
              <option selected>8GB RAM / 128GB SSD</option>
              <option>16GB RAM / 512GB SSD</option>
            </select>
          </div>
        </body>
      </html>
    `,
  }, async (page, captured) => fn(page, captured, { title }));
}

async function withAmazonJsonTwisterPage(fn) {
  const url = "https://www.amazon.com/Acer-Aspire-Go-Laptop/dp/B0FN9JLD28?th=1";
  const title = "Acer Aspire Go 15 AI Ready Laptop";
  await withGlobalSourcePage({
    url,
    collectId: "amazon-json-twister-collect-id",
    html: `
      <!doctype html>
      <html>
        <head>
          <title>Amazon.com: ${title} : Electronics</title>
          <meta property="og:image" content="https://m.media-amazon.com/images/I/71acer._AC_SX679_.jpg">
        </head>
        <body>
          <h1 id="title"><span id="productTitle">${title}</span></h1>
          <a id="visitStoreDesktopUrl" href="https://www.amazon.com/stores/Acer/page/0074ABD9-06D1-469D-B509-C3134D6FFFF2">Visit the Acer Store</a>
          <span class="a-price"><span class="a-offscreen">$279.99</span></span>
          <div id="imgTagWrapperId">
            <img id="landingImage" src="https://m.media-amazon.com/images/I/71acer._AC_SX679_.jpg">
          </div>
          <div id="twister_feature_div">
            <script>
              P.register('twister-js-init-dpx-data', function() {
                var dataToReturn = {
                  "currentAsin": "B0FN9JLD28",
                  "dimensionToAsinMap": {
                    "0": "B0FN9JLD28",
                    "1": "B0DTB4R3VP",
                    "2": "B0FT3NRVL6"
                  },
                  "variationValues": {
                    "processor_description": ["R3 7320u", "R7 5825U", "R7 7730u"]
                  },
                  "dimensionValuesDisplayData": {
                    "B0FN9JLD28": ["R3 7320u"],
                    "B0DTB4R3VP": ["R7 5825U"],
                    "B0FT3NRVL6": ["R7 7730u"]
                  },
                  "variationDisplayLabels": {
                    "processor_description": "CPU"
                  }
                };
                return dataToReturn;
              });
            </script>
          </div>
        </body>
      </html>
    `,
  }, async (page, captured) => fn(page, captured, { title }));
}

async function withAmazonBrandBylinePage(fn) {
  const url = "https://www.amazon.co.jp/dp/B0F99W6NQ6";
  const title = "Kirei Kirei medicated foam hand soap refill";
  await withGlobalSourcePage({
    url,
    collectId: "amazon-brand-byline-collect-id",
    html: `
      <!doctype html>
      <html>
        <head>
          <title>Amazon.co.jp: ${title}</title>
          <meta property="og:image" content="https://m.media-amazon.com/images/I/71soap._AC_SX679_.jpg">
        </head>
        <body>
          <h1 id="title"><span id="productTitle">${title}</span></h1>
          <a id="bylineInfo" href="https://www.amazon.co.jp/-/zh/s/ref=bl_dp_s_web_0?field-brandtextbin=%E3%83%8E%E3%83%BC%E3%83%96%E3%83%A9%E3%83%B3%E3%83%89%E5%93%81">品牌： ノーブランド品</a>
          <span class="a-price"><span class="a-offscreen">￥666</span></span>
          <div id="imgTagWrapperId">
            <img id="landingImage" src="https://m.media-amazon.com/images/I/71soap._AC_SX679_.jpg">
          </div>
        </body>
      </html>
    `,
  }, async (page, captured) => fn(page, captured, { title }));
}

async function withWbPage(fn) {
  const url = "https://www.wildberries.ru/catalog/211234567/detail.aspx";
  const title = "WB sample sneakers";
  await withGlobalSourcePage({
    url,
    collectId: "wb-collect-id",
    html: `
      <!doctype html>
      <html>
        <head>
          <title>${title} / Wildberries</title>
          <meta property="og:image" content="https://basket-12.wbbasket.ru/vol2112/part211234/211234567/images/big/1.webp">
        </head>
        <body>
          <h1 class="product-page__title">${title}</h1>
          <span class="price-block__final-price">2 499 ₽</span>
          <a class="seller-info__name" href="https://www.wildberries.ru/seller/12345">WB sample seller</a>
          <img class="slide__content" src="https://basket-12.wbbasket.ru/vol2112/part211234/211234567/images/big/1.webp">
          <div class="colors">
            <span class="product-page__btn-color">Black</span>
            <span class="product-page__btn-color">White</span>
          </div>
          <div class="sizes-list">
            <button class="sizes-list__button">42</button>
            <button class="sizes-list__button">43</button>
          </div>
        </body>
      </html>
    `,
  }, async (page, captured) => fn(page, captured, { title }));
}

async function withWbModernRenderedPage(fn) {
  const url = "https://www.wildberries.ru/catalog/246443845/detail.aspx";
  const title = "WB modern shower gel";
  await withGlobalSourcePage({
    url,
    collectId: "wb-modern-collect-id",
    html: `
      <!doctype html>
      <html>
        <head>
          <title>${title} 246443845 купить за 1 092 ₽ в интернет-магазине Wildberries</title>
          <meta property="og:image" content="//static-basket-01.wbbasket.ru/vol2/site/i/wb-og-win.jpg">
        </head>
        <body>
          <main>
            <h2 class="mo-typography productTitle--lfc4o">${title}</h2>
            <div class="productLinePrice--iO2mC">
              <span class="productLinePriceWallet--EINuG">1 070 ₽</span>
              <span class="productLinePriceNow--mPBDF wallet--K8OIg">1 092 ₽</span>
              <span class="productLinePriceOld--M0lnS wallet--K8OIg">4 011 ₽</span>
            </div>
            <a class="seller-info__name" href="https://www.wildberries.ru/seller/12345">WB modern seller</a>
            <img src="https://basket-16.wbbasket.ru/vol2464/part246443/246443845/images/tm/1.webp">
            <img src="https://basket-16.wbbasket.ru/vol2464/part246443/246443845/images/c246x328/2.webp">
            <img class="poster--giHVN" src="https://basket-16.wbbasket.ru/vol2464/part246443/246443845/images/big/1.webp">
            <a class="priceAndTitle--BOK03" href="https://www.wildberries.ru/catalog/280088203/detail.aspx">
              <img class="productImage--lSGuQ" src="https://basket-17.wbcontent.net/vol2800/part280088/280088203/images/c246x328/1.webp">
              833 ₽851 ₽Recommended product
            </a>
          </main>
        </body>
      </html>
    `,
  }, async (page, captured) => fn(page, captured, { title }));
}

async function withWbGenericShellPage(fn) {
  const url = "https://www.wildberries.ru/catalog/142044104/detail.aspx?targetUrl=MI";
  await withGlobalSourcePage({
    url,
    collectId: "wb-generic-shell-collect-id",
    html: `
      <!doctype html>
      <html>
        <head>
          <title>Интернет-магазин Wildberries: широкий ассортимент товаров - скидки каждый день!</title>
          <meta property="og:image" content="https://static-basket-01.wbbasket.ru/vol2/site/i/wb-og-win.jpg">
        </head>
        <body>
          <main>
            <img src="https://static-basket-01.wbbasket.ru/vol2/site/i/wb-og-win.jpg">
            <a href="https://www.wildberries.ru/seller/nahodki-iz-kitaya">Находки из Китая</a>
            <div class="price-block__final-price">540 ₽</div>
            <button>552 ₽</button>
            <button>Купить сейчас</button>
            <button>В корзину</button>
            <div class="colors">
              <span>OpacityOpaqueSemi-Transparent</span>
              <span>OpacityOpaqueSemi-TransparentTransparent</span>
            </div>
          </main>
        </body>
      </html>
    `,
  }, async (page, captured) => fn(page, captured));
}

async function withTemuPage(fn) {
  const url = "https://www.temu.com/goods.html?goods_id=601099512345678";
  const title = "Temu sample storage box";
  await withGlobalSourcePage({
    url,
    collectId: "temu-collect-id",
    html: `
      <!doctype html>
      <html>
        <head>
          <title>${title} | Temu</title>
          <meta property="og:image" content="https://img.kwcdn.com/product/FancyAlgo/temu-main.jpeg">
        </head>
        <body>
          <main>
            <h1 class="goods-title">${title}</h1>
            <div class="price-current">$12.48</div>
            <a class="shop-name" href="/mall.html?mall_id=123">Temu shop</a>
            <img class="goods-img" src="https://img.kwcdn.com/product/FancyAlgo/temu-main.jpeg">
            <div class="sku-panel">
              <div class="sku-row">
                <div class="sku-label">Color</div>
                <button class="sku-chip"><img src="https://img.kwcdn.com/product/FancyAlgo/temu-blue.jpeg">Blue</button>
                <button class="sku-chip">Green</button>
              </div>
              <div class="sku-row">
                <div class="sku-label">Size</div>
                <button class="sku-chip">Large</button>
                <button class="sku-chip">Small</button>
              </div>
            </div>
          </main>
        </body>
      </html>
    `,
  }, async (page, captured) => fn(page, captured, { title }));
}

async function withTemuNoisyJapanPage(fn) {
  const url = "https://www.temu.com/jp-zh-Hans/sample-mask.html?goods_id=606283956597557";
  const title = "防晒面罩遮脸护颈一体防紫外线男女士全脸冰丝防晒口罩骑行围脖";
  await withGlobalSourcePage({
    url,
    collectId: "temu-noisy-japan-collect-id",
    html: `
      <!doctype html>
      <html>
        <head>
          <title>${title} | temu Temu Japan</title>
          <meta property="og:image" content="https://img.kwcdn.com/product/FancyAlgo/temu-mask-main.jpeg">
        </head>
        <body>
          <main>
            <h1>${title} | temu Temu Japan</h1>
            <a class="shop-name" href="https://www.temu.com/mall.html">temu Temu Japan</a>
            <img class="goods-img" src="https://img.kwcdn.com/product/FancyAlgo/temu-mask-main.jpeg">
            <div>商品ID 606283956597557 推荐编号 123456789</div>
          </main>
        </body>
      </html>
    `,
  }, async (page, captured) => fn(page, captured, { title }));
}

async function withTemuRenderedChineseProductPage(fn) {
  const url = "https://www.temu.com/jp-zh-Hans/sample-mask-g-606283956597557.html";
  const title = "防晒面罩遮脸护颈一体防紫外线男女士全脸冰丝防晒口罩骑行围脖";
  await withGlobalSourcePage({
    url,
    collectId: "temu-rendered-cn-collect-id",
    html: `
      <!doctype html>
      <html>
        <head>
          <title>${title} | temu Temu Japan</title>
          <meta property="og:image" content="https://img.kwcdn.com/product/open/0d5e64bfe73b4938b337ec1d70f4025c-goods.jpeg">
        </head>
        <body>
          <main>
            <div class="breadcrumb-title">首页 运动与户外 运动及户外配件 ${title}</div>
            <div class="main-image-panel">
              <img src="https://img.kwcdn.com/product/open/0d5e64bfe73b4938b337ec1d70f4025c-goods.jpeg?imageView2/2/w/800/q/80/format/webp">
            </div>
            <section class="detail-card">
              <h1 class="product-title-text">本地仓库 ${title}</h1>
              <div class="rating-line">已售 49件 | 售自 3.7</div>
              <div class="current-offer-amount">49円</div>
              <div class="promo-box">
                <div>颜色: 反光尺面罩 深灰色, 数量: 1个</div>
                <label>数量</label>
                <select><option>1</option></select>
              </div>
              <div>由该卖家发货</div>
            </section>
          </main>
        </body>
      </html>
    `,
  }, async (page, captured) => fn(page, captured, { title }));
}

async function withTemuFragmentedPriceNoSellerPage(fn) {
  const url = "https://www.temu.com/jp-zh-Hans/sample-chair-g-605129180831795.html";
  const title = "Temu folding lounge chair";
  await withGlobalSourcePage({
    url,
    collectId: "temu-fragmented-price-collect-id",
    html: `
      <!doctype html>
      <html>
        <head>
          <title>${title} | Temu Japan</title>
          <meta property="og:image" content="https://img.kwcdn.com/product/open/temu-chair-goods.jpeg">
        </head>
        <body>
          <main>
            <h1 class="product-title-text">${title}</h1>
            <div class="offerBox"><span>¥</span><span>49</span></div>
            <img class="goods-img" src="https://img.kwcdn.com/product/open/temu-chair-goods.jpeg">
          </main>
        </body>
      </html>
    `,
  }, async (page, captured) => fn(page, captured, { title }));
}

async function withTemuSellerProfileCardPage(fn) {
  const url = "https://www.temu.com/jp-zh-Hans/sample-jacket-g-601105124897749.html";
  const title = "重磅水洗做旧连帽夹克";
  await withGlobalSourcePage({
    url,
    collectId: "temu-seller-profile-card-collect-id",
    html: `
      <!doctype html>
      <html>
        <head>
          <title>${title} | Temu Japan</title>
          <meta property="og:image" content="https://img.kwcdn.com/product/open/719d22197c95454486c3406fb6d4c047-goods.jpeg">
        </head>
        <body>
          <main>
            <h1 class="product-title-text">${title}</h1>
            <div class="current-offer-amount">2988円</div>
            <img class="goods-img" src="https://img.kwcdn.com/product/open/719d22197c95454486c3406fb6d4c047-goods.jpeg">
            <section class="try-on-card">
              <div>试穿尺码: Asian L(L)</div>
              <div>试穿心得: 舒适</div>
            </section>
            <section class="mall-profile-card">
              <img src="https://img.kwcdn.com/product/open/gogolulu-logo.jpeg">
              <div class="profile-name">GOGOLULU</div>
              <div><b>8</b><span>粉丝</span></div>
              <div><b>3,675</b><span>已售</span></div>
              <div><b>4.4</b><span>评分</span></div>
              <button>关注</button>
              <a href="https://www.temu.com/mall.html?mall_id=881234">所有商品 (154)</a>
            </section>
          </main>
        </body>
      </html>
    `,
  }, async (page, captured) => fn(page, captured, { title }));
}

async function withTemuNoisyProductImagesJapanPage(fn) {
  const url = "https://www.temu.com/jp-zh-Hans/sample-mask-g-606283956597557.html";
  const title = "Temu JP mask";
  await withGlobalSourcePage({
    url,
    collectId: "temu-noisy-images-collect-id",
    html: `
      <!doctype html>
      <html>
        <head>
          <title>${title} | temu Temu Japan</title>
          <meta property="og:image" content="https://img.kwcdn.com/product/open/0d5e64bfe73b4938b337ec1d70f4025c-goods.jpeg">
        </head>
        <body>
          <main>
            <h1 class="product-title-text">${title}</h1>
            <div class="current-offer-amount">49円</div>
            <img src="https://aimg.kwcdn.com/upload_aimg/commodity/9aad9159-3b27-4530-95a1-f01a6a3b4ce7.png.slim.png">
            <img src="https://aimg.kwcdn.com/upload_aimg/openingemail/flags/ab025b26-1013-4fe7-a1de-1ab9f4053fa1.png.slim.png">
            <img src="https://commimg.kwcdn.com/upload_commimg/frontpage/415a3faa-d212-4d68-bad3-104ec7cda894.png">
            <img src="https://img.kwcdn.com/product/open/0d5e64bfe73b4938b337ec1d70f4025c-goods.jpeg?imageView2/2/w/800/q/80/format/webp">
            <img src="https://img.kwcdn.com/product/fancy/65c7e030-e732-422b-ad4c-b7243183370b.jpg">
            <div>颜色: Reflective gray, 数量: 1</div>
          </main>
        </body>
      </html>
    `,
  }, async (page, captured) => fn(page, captured, { title }));
}

async function withTemuLocalizedSlugPage(fn) {
  const url = "https://www.temu.com/jp-zh-Hans/sample-summer-mask.html";
  const title = "Temu localized summer mask";
  await withGlobalSourcePage({
    url,
    collectId: "temu-localized-collect-id",
    html: `
      <!doctype html>
      <html>
        <head>
          <title>${title} | Temu</title>
          <meta property="og:image" content="https://img.kwcdn.com/product/FancyAlgo/temu-mask-main.jpeg">
          <script>
            window.__JZ_TEST_DETAIL__ = {
              goodsId: "601099512345678",
              title: "${title}",
              price: "54",
              images: ["https://img.kwcdn.com/product/FancyAlgo/temu-mask-main.jpeg"],
              seller: { name: "Temu mask shop" },
              variants: [
                {
                  sku: "601099512345678-light-gray",
                  name: "Light gray",
                  image: "https://img.kwcdn.com/product/FancyAlgo/temu-mask-gray.jpeg",
                  aspectValues: { Color: "Light gray" }
                },
                {
                  sku: "601099512345678-black",
                  name: "Black",
                  image: "https://img.kwcdn.com/product/FancyAlgo/temu-mask-black.jpeg",
                  aspectValues: { Color: "Black" }
                }
              ]
            };
          </script>
        </head>
        <body>
          <main>
            <h1>${title}</h1>
          </main>
        </body>
      </html>
    `,
  }, async (page, captured) => fn(page, captured, { title }));
}

async function withMercadoLibrePage(fn) {
  const url = "https://articulo.mercadolibre.com.ar/MLA-1234567890-sample-backpack-_JM";
  const title = "Mercado Libre sample backpack";
  await withGlobalSourcePage({
    url,
    collectId: "mercadolibre-collect-id",
    html: `
      <!doctype html>
      <html>
        <head>
          <title>${title} | MercadoLibre</title>
          <meta property="og:image" content="https://http2.mlstatic.com/D_NQ_NP_123456-MLA-main.webp">
          <script type="application/ld+json">
            {
              "@type": "Product",
              "name": "${title}",
              "image": ["https://http2.mlstatic.com/D_NQ_NP_123456-MLA-main.webp"],
              "offers": { "price": "12999" }
            }
          </script>
        </head>
        <body>
          <h1 class="ui-pdp-title">${title}</h1>
          <span class="andes-money-amount__fraction">12.999</span>
          <a class="ui-pdp-seller__link" href="https://perfil.mercadolibre.com.ar/MLSAMPLE">ML sample seller</a>
          <div class="ui-pdp-gallery">
            <img src="https://http2.mlstatic.com/D_NQ_NP_123456-MLA-main.webp?size=640">
          </div>
          <div class="ui-pdp-variations">
            <div class="ui-pdp-variations__picker">
              <span class="ui-pdp-variations__label">Color</span>
              <button class="ui-pdp-thumbnail-selector"><img src="https://http2.mlstatic.com/D_NQ_NP_black-MLA.webp">Black</button>
              <button class="ui-pdp-thumbnail-selector">Blue</button>
            </div>
            <div class="ui-pdp-variations__picker">
              <span class="ui-pdp-variations__label">Size</span>
              <button>M</button>
              <button>L</button>
            </div>
          </div>
        </body>
      </html>
    `,
  }, async (page, captured) => fn(page, captured, { title }));
}

async function withMercadoLibreShippingNoisePage(fn) {
  const url = "https://www.mercadolibre.com.ar/caloventor-liliana-cemfh02-de-2000-w-vertical-y-horizontal-negro/p/MLA69364036";
  const title = "Caloventor Liliana CEMFH02 de 2000 W, Vertical y Horizontal, Negro";
  await withGlobalSourcePage({
    url,
    collectId: "mercadolibre-shipping-noise-collect-id",
    html: `
      <!doctype html>
      <html>
        <head>
          <title>${title} | Envío gratis</title>
          <meta property="og:image" content="https://http2.mlstatic.com/D_Q_NP_2X_938024-MLA111453371743_052026-R.webp">
        </head>
        <body>
          <main>
            <h1 class="ui-pdp-title">${title} | Envío gratis</h1>
            <span class="andes-money-amount__fraction">46.699</span>
            <a class="ui-pdp-seller__link" href="https://perfil.mercadolibre.com.ar/PETENATTIHOGAR">PETENATTI HOGAR</a>
            <div class="ui-pdp-gallery">
              <img src="https://http2.mlstatic.com/D_Q_NP_2X_938024-MLA111453371743_052026-R.webp">
            </div>
            <div class="ui-pdp-variations">
              <div class="ui-pdp-variations__picker">
                <span class="ui-pdp-variations__label">Color</span>
                <button class="ui-pdp-thumbnail-selector" aria-label="Botón 1 de 1, Negro">Botón 1 de 1, Negro</button>
              </div>
              <div class="ui-pdp-variations__picker ui-pdp-variations__picker--duplicate">
                <button class="ui-pdp-thumbnail-selector" aria-label="Botón 1 de 1, Negro">Botón 1 de 1, Negro</button>
              </div>
            </div>
          </main>
        </body>
      </html>
    `,
  }, async (page, captured) => fn(page, captured, { title }));
}

async function withYandexPage(fn) {
  const url = "https://market.yandex.ru/product--sample-speaker/987654321";
  const title = "Yandex sample speaker";
  await withGlobalSourcePage({
    url,
    collectId: "yandex-collect-id",
    html: `
      <!doctype html>
      <html>
        <head>
          <title>${title} - Yandex Market</title>
          <meta property="og:image" content="https://avatars.mds.yandex.net/get-mpic/123456/img_id987654/orig">
        </head>
        <body>
          <h1 data-auto="product-title">${title}</h1>
          <span data-auto="snippet-price-current">4 299 RUB</span>
          <a data-zone-name="shop-name" href="https://market.yandex.ru/business--sample-shop/12345">Yandex sample shop</a>
          <div data-auto="media-viewer">
            <img src="https://avatars.mds.yandex.net/get-mpic/123456/img_id987654/orig">
          </div>
          <div class="ProductOptions">
            <div class="ProductOption">
              <div class="ProductOption__title">Color</div>
              <button class="ProductOption__value">White</button>
              <button class="ProductOption__value">Black</button>
            </div>
          </div>
        </body>
      </html>
    `,
  }, async (page, captured) => fn(page, captured, { title }));
}

async function withYandexRenderedPage(fn) {
  const url = "https://market.yandex.ru/product--voombox-outdoor/10865015";
  const title = "Портативная акустика Divoom Voombox outdoor 15 Вт";
  await withGlobalSourcePage({
    url,
    collectId: "yandex-rendered-collect-id",
    html: `
      <!doctype html>
      <html>
        <head>
          <title>${title} – купить на Яндекс Маркете, undefined</title>
          <meta property="og:image" content="https://avatars.mds.yandex.net/get-mpic/4489193/img_id2157349518272126176.jpeg/9hq">
        </head>
        <body>
          <main>
            <h1 class="ds-text ds-text_group_core ds-text_weight_reg">${title}</h1>
            <span data-auto="snippet-price-current">4 299 ₽</span>
            <img class="_2--D5" src="https://avatars.mds.yandex.net/get-mpic/4489193/img_id2157349518272126176.jpeg/90x120" alt="${title}">
            <a href="https://market.yandex.ru/business--sample-shop/12345">Yandex sample shop</a>
            <section>
              <div data-zone-name="title">Колонка блютуз беспроводная Defender Enjoy 20</div>
              <span data-auto="snippet-title">Колонка блютуз беспроводная Defender Enjoy 20</span>
              <span data-auto="snippet-price-current">418 ₽</span>
            </section>
          </main>
        </body>
      </html>
    `,
  }, async (page, captured) => fn(page, captured, { title }));
}

async function withYandexMerchantFilterShopPage(fn) {
  const url = "https://market.yandex.ru/card/kreslo-meshok-grusha-xl-oksford-lazurnyy/103189793773?do-waremd5=5rYKO5MX9AJIflMPfX-vCw&ogV=-12";
  const title = "Кресло-мешок Пуффбери «Груша», размер XXL средний, Оксфорд Лазурный";
  await withGlobalSourcePage({
    url,
    collectId: "yandex-merchant-filter-shop-collect-id",
    html: `
      <!doctype html>
      <html>
        <head>
          <title>${title}, цвет лазурный - купить в интернет-магазине Пуффбери на Яндекс Маркете, 103189793773</title>
          <meta property="og:image" content="https://avatars.mds.yandex.net/get-mpic/20079782/2a0000019daff7bc781b49686354fb3d2142/orig">
          <script type="application/ld+json">
            {
              "@type": "Product",
              "@context": "https://schema.org",
              "brand": "Пуффбери",
              "name": "${title}",
              "image": "https://avatars.mds.yandex.net/get-mpic/20079782/2a0000019daff7bc781b49686354fb3d2142/orig",
              "offers": { "@type": "Offer", "price": 2913, "priceCurrency": "RUB" }
            }
          </script>
        </head>
        <body>
          <main>
            <h1 class="ds-text ds-text_group_core">${title}</h1>
            <span data-auto="snippet-price-current">2 913 RUB</span>
            <img src="https://avatars.mds.yandex.net/get-mpic/20079782/2a0000019daff7bc781b49686354fb3d2142/orig" alt="${title}">
            <section class="cia-vs cia-cs">
              <a href="https://market.yandex.ru/search?merchant-filter=891208&generalContext=t%3Dmerchant%3Bmrch%3D891208">
                <div class="ds-sins-logo__logo-wrapper"></div>
                <div class="ds-textLine ds-textLine_gap_2 ds-sins-identity__title">Пуффбери</div>
                <span class="ds-sins-identity__subtitle">Магазин</span>
              </a>
            </section>
            <section>
              <div data-zone-name="title">Кресло-мешок PUFON груша размер 4XL</div>
            </section>
          </main>
        </body>
      </html>
    `,
  }, async (page, captured) => fn(page, captured, { title }));
}

async function withSheinPage(fn) {
  const url = "https://www.shein.com/Sample-Dress-p-34567890-cat-1727.html?goods_id=34567890";
  const title = "SHEIN sample dress";
  await withGlobalSourcePage({
    url,
    collectId: "shein-collect-id",
    html: `
      <!doctype html>
      <html>
        <head>
          <title>${title} | SHEIN</title>
          <meta property="og:image" content="https://img.ltwebstatic.com/images3_pi/2026/06/24/shein-main.jpg">
        </head>
        <body>
          <main>
            <h1 class="product-intro__head-name">${title}</h1>
            <div class="from">$15.49</div>
            <a class="store-title" href="https://www.shein.com/store/home">SHEIN</a>
            <div class="product-intro__thumbs">
              <img src="https://img.ltwebstatic.com/images3_pi/2026/06/24/shein-main.jpg?width=800">
            </div>
            <div class="product-intro__size-choose">
              <div class="product-intro__color">
                <span class="product-intro__size-title">Color</span>
                <button class="color-block"><img src="https://img.ltwebstatic.com/images3_pi/2026/06/24/shein-apricot.jpg">Apricot</button>
                <button class="color-block">Black</button>
              </div>
              <div class="product-intro__size">
                <span class="product-intro__size-title">Size</span>
                <button>S</button>
                <button>M</button>
              </div>
            </div>
          </main>
        </body>
      </html>
    `,
  }, async (page, captured) => fn(page, captured, { title }));
}

async function withSheinJapanTitlePage(fn) {
  const url = "https://jp.shein.com/SHEGLAM-Lumi-Eye-Aegyo-Sal-Pen-Duo-Cookie-Dough-p-186365092.html";
  const title = "SHEGLAM Lumi-Eye Aegyo-Sal ペンデュオ-Cookie Dough";
  await withGlobalSourcePage({
    url,
    collectId: "shein-japan-title-collect-id",
    html: `
      <!doctype html>
      <html>
        <head>
          <title>${title} | SHEIN JAPAN</title>
          <meta property="og:image" content="https://img.ltwebstatic.com/v4/j/pi/2025/10/15/8f/1760519032c066f9a1224e0ef21ae9eb214625001a_thumbnail.webp">
          <script type="application/ld+json">
            {
              "@context": "https://schema.org",
              "@type": "Product",
              "name": "${title}",
              "brand": "SHEGLAM",
              "offers": { "@type": "Offer", "price": "455", "priceCurrency": "JPY" }
            }
          </script>
        </head>
        <body>
          <main>
            <h1 class="product-intro__head-name">${title} | SHEIN JAPAN</h1>
            <div class="from">￥455</div>
            <div class="product-intro__thumbs">
              <img src="https://img.ltwebstatic.com/v4/j/pi/2025/10/15/8f/1760519032c066f9a1224e0ef21ae9eb214625001a_thumbnail.webp">
            </div>
          </main>
        </body>
      </html>
    `,
  }, async (page, captured) => fn(page, captured, { title }));
}

async function withSheinMarketplaceSellerPage(fn) {
  const url = "https://jp.shein.com/Women-Blouses-Shirts-p-423724222.html?mallCode=1&detailBusinessFrom=0-2&imgRatio=1-1";
  const title = "Women Blouses Shirts";
  await withGlobalSourcePage({
    url,
    collectId: "shein-marketplace-seller-collect-id",
    html: `
      <!doctype html>
      <html>
        <head>
          <title>${title} | SHEIN JAPAN</title>
          <meta property="og:image" content="https://img.ltwebstatic.com/images3_pi/2026/06/24/shein-marketplace-main.jpg">
        </head>
        <body>
          <main>
            <h1 class="product-intro__head-name">${title}</h1>
            <div class="sale-price">￥2,020</div>
            <img src="https://img.ltwebstatic.com/images3_pi/2026/06/24/shein-marketplace-main.jpg">
            <aside class="delivery-panel">
              <div>Destination Japan</div>
              <div>Free shipping</div>
              <div class="marketplace-line">Marketplace GarnetGI45 sold by</div>
              <div>Ships from GarnetGI45</div>
              <section class="shop-panel">
                <h3>Shop info</h3>
                <div class="seller-row">
                  <img src="https://img.ltwebstatic.com/store/garnet-logo.jpg">
                  <strong>GarnetGI45</strong>
                  <span>Local Seller</span>
                </div>
                <div>n***1 purchased 1 day ago</div>
                <div>1K+ sold recently</div>
                <a href="https://jp.shein.com/store/home?store_code=GarnetGI45">All products</a>
              </section>
            </aside>
          </main>
        </body>
      </html>
    `,
  }, async (page, captured) => fn(page, captured, { title }));
}

async function withSheinBrandShopInfoPage(fn) {
  const url = "https://jp.shein.com/BizChic-Women-s-Knitted-Cardigan-V-Neck-Fitted-Open-Front-Metal-Button-Striped-Old-Money-Style-Minimalist-Office-Date-Vacation-Commute-Independence-Day-Graduation-Season-Music-Festival-Slimming-Elegant-Versatile-June-Festival-Birthday-Party-Gathering-Office-Formal-Summer-p-481621562.html?mallCode=1";
  const title = "BizChic Women's Knitted Cardigan";
  await withGlobalSourcePage({
    url,
    collectId: "shein-brand-shop-info-collect-id",
    html: `
      <!doctype html>
      <html>
        <head>
          <title>${title} | SHEIN JAPAN</title>
          <meta property="og:image" content="https://img.ltwebstatic.com/images3_pi/2026/06/24/shein-bizchic-main.jpg">
        </head>
        <body>
          <main>
            <h1 class="product-intro__head-name">${title}</h1>
            <div class="sale-price">￥2,990</div>
            <img src="https://img.ltwebstatic.com/images3_pi/2026/06/24/shein-bizchic-main.jpg">
            <aside class="delivery-panel">
              <div>Free returns</div>
              <div>Shopping security</div>
              <div class="marketplace-line">SHEIN sold by</div>
              <div>Ships from SHEIN</div>
              <section class="shop-panel">
                <h3>Shop info</h3>
                <div class="seller-row">
                  <img src="https://img.ltwebstatic.com/store/bizchic-logo.jpg">
                  <strong>BizChic</strong>
                  <span>Trend</span>
                </div>
                <div>4.91 rating</div>
                <div>2.4K products</div>
                <div>1.1M followers</div>
                <p>BizChic offers chic office looks.</p>
                <a href="https://jp.shein.com/store/home?store_code=BizChic">All products</a>
              </section>
            </aside>
          </main>
        </body>
      </html>
    `,
  }, async (page, captured) => fn(page, captured, { title }));
}

async function withSheinDataStoreShopInfoPage(fn) {
  const url = "https://jp.shein.com/Franclia-Women-s-Solid-Color-Drawstring-Short-Sleeve-New-Chinese-Style-T-Shirt-Minimalist-Fashion-p-61079413.html?mallCode=1";
  const title = "Franclia レディース 無地 ドローストリング 半袖 新中国風Tシャツ、ミニマルなファッション";
  await withGlobalSourcePage({
    url,
    collectId: "shein-data-store-shop-info-collect-id",
    html: `
      <!doctype html>
      <html>
        <head>
          <title>${title} | SHEIN JAPAN</title>
          <meta property="og:image" content="https://img.ltwebstatic.com/images3_pi/2026/06/24/shein-franclia-main.jpg">
          <script type="application/ld+json">
            {
              "@context": "https://schema.org/",
              "@type": "ProductGroup",
              "name": "${title}",
              "brand": { "@type": "Brand", "name": "Franclia" },
              "offers": { "@type": "Offer", "price": "366", "priceCurrency": "JPY" }
            }
          </script>
        </head>
        <body>
          <main>
            <section class="product-info">
              <h1 class="fsp-element">${title}</h1>
              <div class="sale-price">¥366</div>
              <img src="https://img.ltwebstatic.com/images3_pi/2026/06/24/shein-franclia-main.jpg">
            </section>
            <section class="delivery-panel">
              <div>SHEIN が販売</div>
              <div>SHEIN から発送</div>
            </section>
            <section class="product-meta">
              <button class="common-entry__top" aria-expanded="true">
                <span class="title">&#12471;&#12519;&#12483;&#12503;&#24773;&#22577;</span>
              </button>
              <div class="common-entry__content" aria-label="&#12471;&#12519;&#12483;&#12503;&#24773;&#22577;">
                <div class="shop-entry__storeEntry">
                  <div
                    class="top-level a11y-focus top-link-pointer"
                    data-is-store="true"
                    data-brand-code="8215335601"
                    data-brand-type="store"
                    data-name="Franclia"
                    data-id="8215335601"
                    data-brand_info="ratings_4.82 sold_in_30d_19K followers_1.5M"
                  >
                    <div class="info-box">
                      <div class="name-line">
                        <h3 class="title">Franclia</h3>
                      </div>
                      <div class="metrics">4.82 rating 19K products 1.5M followers</div>
                    </div>
                  </div>
                </div>
              </div>
            </section>
          </main>
        </body>
      </html>
    `,
  }, async (page, captured) => fn(page, captured, { title }));
}

async function withSheinSilkySpellShopInfoPage(fn) {
  const url = "https://jp.shein.com/SilkySpell-Women-Lace-Patchwork-Solid-Color-Sleep-Dress-Pajama-Dress-With-Bowknot-Decoration-Luxeloungewear-p-33203094.html?mallCode=1";
  const title = "SilkySpell Women Lace Patchwork Solid Color Sleep Dress";
  await withGlobalSourcePage({
    url,
    collectId: "shein-silkyspell-shop-info-collect-id",
    html: `
      <!doctype html>
      <html>
        <head>
          <title>${title} | SHEIN JAPAN</title>
          <meta property="og:image" content="https://img.ltwebstatic.com/images3_pi/2026/06/24/shein-silkyspell-main.jpg">
        </head>
        <body>
          <main>
            <section class="delivery-panel">
              <h2>Destination</h2>
              <div>Free shipping</div>
              <div>Shopping security</div>
              <div>SHEIN sold by</div>
              <div>Ships from SHEIN</div>
            </section>
            <section class="product-intro">
              <h1 class="product-intro__head-name">${title}</h1>
              <div class="sale-price">￥1,111</div>
              <img src="https://img.ltwebstatic.com/images3_pi/2026/06/24/shein-silkyspell-main.jpg">
            </section>
            <section class="shop-panel">
              <h3>Shop info</h3>
              <div class="seller-row">
                <img src="https://img.ltwebstatic.com/store/silkyspell-logo.jpg">
                <strong>SilkySpell</strong>
                <span>Trend</span>
              </div>
              <div>999K+ sold recently</div>
              <div>99K+ purchases</div>
              <a href="https://jp.shein.com/store/home?store_code=SilkySpell">All products</a>
              <button>Follow</button>
            </section>
          </main>
        </body>
      </html>
    `,
  }, async (page, captured) => fn(page, captured, { title }));
}

async function withSheinElaminiShopInfoPage(fn) {
  const url = "https://jp.shein.com/Elamini-Polka-Dot-Print-Lapel-Collar-Fitted-Short-Sleeve-Blouse-For-Women-p-88259809.html?mallCode=1";
  const title = "Elamini Polka Dot Print Lapel Collar Fitted Short Sleeve Blouse For Women";
  await withGlobalSourcePage({
    url,
    collectId: "shein-elamini-shop-info-collect-id",
    html: `
      <!doctype html>
      <html>
        <head>
          <title>Women's fashion online shop | SHEIN</title>
          <meta property="og:image" content="https://img.ltwebstatic.com/images3_pi/2026/06/24/shein-elamini-main.jpg">
        </head>
        <body>
          <main>
            <section class="promo-panel">
              <h2 class="campaign-title">Domestic shipping -36% afternoon picnic blouse</h2>
            </section>
            <section class="product-summary">
              <div class="goods-name">${title}</div>
              <div class="sale-price">￥904</div>
              <img src="https://img.ltwebstatic.com/images3_pi/2026/06/24/shein-elamini-main.jpg">
            </section>
            <section class="delivery-panel">
              <div>SHEIN sold by</div>
              <div>Ships from SHEIN</div>
            </section>
            <section class="shop-panel">
              <h3>Shop info</h3>
              <div class="shop-card">
                <img src="https://img.ltwebstatic.com/store/elamini-logo.jpg">
                <strong>Elamini</strong>
                <span>Trend</span>
              </div>
              <div>999K+ sold recently</div>
              <div>500K+ purchases</div>
              <button>All products</button>
              <button>Follow</button>
            </section>
          </main>
        </body>
      </html>
    `,
  }, async (page, captured) => fn(page, captured, { title }));
}

async function withSheinBreadcrumbOnlyTitlePage(fn) {
  const url = "https://jp.shein.com/FRIFUL-Women-s-Wave-Stripe-Loose-Knit-Short-Sleeve-Shirt-Summer-Casual-Top-p-3296917895459.html?mallCode=1";
  const title = "FRIFUL Women s Wave Stripe Loose Knit Short Sleeve Shirt Summer Casual Top";
  await withGlobalSourcePage({
    url,
    collectId: "shein-breadcrumb-title-collect-id",
    html: `
      <!doctype html>
      <html>
        <head>
          <title>Women's fashion online shop | SHEIN</title>
          <meta property="og:image" content="https://img.ltwebstatic.com/images3_pi/2026/06/24/shein-friful-main.jpg">
        </head>
        <body>
          <main>
            <nav class="breadcrumb-title">Home / Women Apparel / Women Fashion / Women Tops & Blouses / FRIFUL Women s Wave Stripe Loose Knit Short Sleeve Shirt Summer Casual Top</nav>
            <section class="product-summary">
              <div class="sale-price">￥926</div>
              <img src="https://img.ltwebstatic.com/images3_pi/2026/06/24/shein-friful-main.jpg">
            </section>
            <section class="shop-panel">
              <h3>Shop info</h3>
              <div class="shop-card">
                <strong>FRIFUL</strong>
                <span>Trend</span>
              </div>
              <div>999K+ sold recently</div>
              <button>All products</button>
              <button>Follow</button>
            </section>
          </main>
        </body>
      </html>
    `,
  }, async (page, captured) => fn(page, captured, { title }));
}

async function withSheinJapaneseProductIntroPage(fn) {
  const url = "https://jp.shein.com/Women-s-Fashion-Lace-Camisole-Top-Casual-White-Summer-p-9709774.html?mallCode=1";
  const title = "レース キャミソール トップス カジュアル ホワイト 夏用 レディース";
  await withGlobalSourcePage({
    url,
    collectId: "shein-japanese-product-intro-collect-id",
    html: `
      <!doctype html>
      <html>
        <head>
          <title>${title} | SHEIN JAPAN</title>
          <meta property="og:image" content="https://img.ltwebstatic.com/images3_pi/2026/06/24/shein-camisole-main.jpg">
          <script type="application/ld+json">
            {
              "@context": "https://schema.org",
              "@type": "Product",
              "name": "${title}",
              "brand": { "@type": "Brand", "name": "SHEIN" },
              "offers": { "@type": "Offer", "price": "694", "priceCurrency": "JPY" }
            }
          </script>
        </head>
        <body>
          <main>
            <section class="bread-crumb">
              <ol class="bread-crumb__inner">
                <li class="bread-crumb__item">ホーム/</li>
                <li class="bread-crumb__item">レディース アパレル/</li>
                <li class="bread-crumb__item">レディース タンクトップ＆キャミソール/</li>
                <li class="bread-crumb__item"><span class="bread-crumb__item-link over-hidden">${title}</span></li>
              </ol>
            </section>
            <section class="product-info">
              <div class="product-intro__head j-expose__product-intro__head">
                <span class="title-line-camp product-intro__head-name"><h1 class="fsp-element">${title}</h1></span>
                <div class="product-intro__head-sku-ctn">SKU: sw2112292250168089 (1000+ レビュー)</div>
              </div>
              <div id="productPriceId" class="productPrice"><div id="productMainPriceId" class="productPrice__main">￥694</div><div class="productDiscountInfo">￥867-20%</div></div>
              <img src="https://img.ltwebstatic.com/images3_pi/2026/06/24/shein-camisole-main.jpg">
            </section>
            <section class="common-entry__container shop-entry__entryBox">
              <a class="shop-entry__storeEntry" href="https://jp.shein.com/store/home?store_code=URUW">
                <div class="info-box">
                  <h3 class="title">URUW</h3>
                  <span>4.86 評価</span>
                  <span>1K 商品</span>
                  <span>40K フォロワー</span>
                </div>
              </a>
            </section>
            <section class="transport-info">
              <span class="productShippingTitle__textBold">お届け先</span>
              <div class="soldbybox-header__title-text">SHEIN が販売</div>
              <div class="soldbybox-header__sub-title">SHEIN から発送</div>
            </section>
          </main>
        </body>
      </html>
    `,
  }, async (page, captured) => fn(page, captured, { title }));
}

async function withSheinLabelPrefixedProductTitlePage(fn) {
  const url = "https://jp.shein.com/Allurite-Women-s-Elegant-French-Floral-Embroidered-Fishbone-Sheer-Sexy-Bandeau-Top-p-507838584.html?mallCode=1";
  const title = "Allurite レディース エレガント フレンチ フローラル刺繍 フィッシュボーン シアー セクシー バンドゥトップ";
  await withGlobalSourcePage({
    url,
    collectId: "shein-label-prefixed-title-collect-id",
    html: `
      <!doctype html>
      <html>
        <head>
          <title>Women's fashion online shop | SHEIN</title>
          <meta property="og:image" content="https://img.ltwebstatic.com/v4/j/pi/2026/06/23/fe/allurite-main_thumbnail_900x.webp">
          <script type="application/ld+json">
            {
              "@context": "https://schema.org",
              "@type": "BreadcrumbList",
              "itemListElement": [
                { "@type": "ListItem", "position": 1, "name": "レディース トップス" },
                { "@type": "ListItem", "position": 2, "name": "${title}" }
              ]
            }
          </script>
        </head>
        <body>
          <main>
            <section class="product-intro__head j-expose__product-intro__head">
              <span class="product-intro__head-name title-line-camp product-intro__head-name_expandable">
                <div class="product-intro__goodsname-label"><span class="new-label new-tag label-common">新品</span><span class="trend-label">トレンド</span></div>
                ${title}
              </span>
              <div class="product-intro__head-sku-ctn">SKU: sz260511015239452940189</div>
            </section>
            <div id="productMainPriceId" class="productPrice__main">¥1,796</div>
            <img src="https://img.ltwebstatic.com/v4/j/pi/2026/06/23/fe/allurite-main_thumbnail_900x.webp">
            <section class="store-quality-tags"><span class="tags-text">販売数急増 36%</span></section>
          </main>
        </body>
      </html>
    `,
  }, async (page, captured) => fn(page, captured, { title }));
}

async function withSheinSkuSlugPage(fn) {
  const url = "https://us.shein.com/Sample-Dress-p-sw240624123456-cat-1727.html";
  const title = "SHEIN sku slug sample dress";
  await withGlobalSourcePage({
    url,
    collectId: "shein-sku-slug-collect-id",
    html: `
      <!doctype html>
      <html>
        <head>
          <title>${title} | SHEIN</title>
          <meta property="og:image" content="https://img.ltwebstatic.com/images3_pi/2026/06/24/shein-sku-main.jpg">
          <script>
            window.__JZ_TEST_DETAIL__ = {
              goodsSn: "sw240624123456",
              title: "${title}",
              price: "$15.49",
              images: ["https://img.ltwebstatic.com/images3_pi/2026/06/24/shein-sku-main.jpg"],
              seller: { name: "SHEIN" },
              variants: [
                {
                  sku: "sw240624123456-apricot-s",
                  name: "Apricot / S",
                  image: "https://img.ltwebstatic.com/images3_pi/2026/06/24/shein-apricot.jpg",
                  aspectValues: { Color: "Apricot", Size: "S" }
                }
              ]
            };
          </script>
        </head>
        <body>
          <main>
            <h1 class="product-intro__head-name">${title}</h1>
          </main>
        </body>
      </html>
    `,
  }, async (page, captured) => fn(page, captured, { title }));
}

async function testJdCollectsThroughSharedPanel() {
  await withJdPage(async (page, captured) => {
    await page.click('[data-action="collect-product"]');
    await page.waitForFunction(() => document.querySelector('[data-action="collect-product"]')?.disabled === false);

    const message = captured.find((m) => m.action === "pushSourceCollect");
    assert(message, "expected pushSourceCollect message");
    assert.strictEqual(message.sourceId, "jd");
    assert.strictEqual(message.raw.productId, "100285845266");
    assert.strictEqual(message.raw.title, "百岁山348ml*24瓶");
    assert.strictEqual(message.raw.price, "34");
    assert.strictEqual(message.raw.images.length, 2);
    assert.strictEqual(message.raw.videoUrl, "https://vod.300hu.com/jd.mp4");
    assert.strictEqual(message.raw.seller.name, "饮品折扣京东自营专区");
    assert.strictEqual(message.raw.variants[0].sku, "100285845266-348");
  });
}

async function testJdIgnoresCalculatorStructuredNoise() {
  await withJdRenderedNoisePage(async (page, captured, expected) => {
    await page.click('[data-action="collect-product"]');
    await page.waitForFunction(() => document.querySelector('[data-action="collect-product"]')?.disabled === false);

    const message = captured.find((m) => m.action === "pushSourceCollect");
    assert(message, "expected pushSourceCollect message from JD noisy rendered page");
    assert.strictEqual(message.sourceId, "jd");
    assert.strictEqual(message.raw.productId, "100285845266");
    assert.strictEqual(message.raw.title, expected.title);
    assert.strictEqual(message.raw.images[0], expected.mainImage);
    assert.strictEqual(message.raw.seller.name, expected.sellerName);
  });
}

async function testJdExpandsDomVariants() {
  await withJdDomVariantPage(async (page, captured, expected) => {
    await page.click('[data-action="collect-product"]');
    await page.waitForFunction(() => document.querySelector('[data-action="collect-product"]')?.disabled === false);

    const message = captured.find((m) => m.action === "pushSourceCollect");
    assert(message, "expected pushSourceCollect message from JD DOM variants page");
    assert.strictEqual(message.sourceId, "jd");
    assert.strictEqual(message.raw.title, expected.title);
    assert.strictEqual(message.raw.seller.name, expected.sellerName);
    assert.strictEqual(message.raw.variants.length, 4);
    assert.deepStrictEqual(message.raw.variants[0].aspectValues, { 颜色: "藏青", 尺码: "M" });
    assert.strictEqual(message.raw.variants[3].name, "白色 / L");
  });
}

async function testPifaCollectsThroughSharedPanel() {
  await withPifaPage(async (page, captured) => {
    await page.click('[data-action="collect-product"]');
    await page.waitForFunction(() => document.querySelector('[data-action="collect-product"]')?.disabled === false);

    const message = captured.find((m) => m.action === "pushSourceCollect");
    assert(message, "expected pushSourceCollect message");
    assert.strictEqual(message.sourceId, "pdd");
    assert.strictEqual(message.raw.goodsId, "722497925613");
    assert.strictEqual(message.raw.title, "拼多多批发测试商品");
    assert.strictEqual(message.raw.price, "19.9");
    assert.strictEqual(message.raw.images.length, 2);
    assert.strictEqual(message.raw.seller.name, "拼多多批发店铺");
    assert.strictEqual(message.raw.variants[0].sku, "722497925613-red");
  });
}

async function testPifaExpandsDomVariants() {
  await withPifaDomVariantPage(async (page, captured, expected) => {
    await page.click('[data-action="collect-product"]');
    await page.waitForFunction(() => document.querySelector('[data-action="collect-product"]')?.disabled === false);

    const message = captured.find((m) => m.action === "pushSourceCollect");
    assert(message, "expected pushSourceCollect message from Pifa DOM variants page");
    assert.strictEqual(message.sourceId, "pdd");
    assert.strictEqual(message.raw.title, expected.title);
    assert.strictEqual(message.raw.variants.length, 4);
    assert.deepStrictEqual(message.raw.variants[2].aspectValues, { 规格: "大号", 颜色: "白色" });
  });
}

async function testPifaExpandsSpecPanelVariants() {
  await withPifaSpecPanelVariantPage(async (page, captured, expected) => {
    await page.click('[data-action="collect-product"]');
    await page.waitForFunction(() => document.querySelector('[data-action="collect-product"]')?.disabled === false);

    const message = captured.find((m) => m.action === "pushSourceCollect");
    assert(message, "expected pushSourceCollect message from Pifa SpecPanel variants page");
    assert.strictEqual(message.sourceId, "pdd");
    assert.strictEqual(message.raw.title, expected.title);
    assert.strictEqual(message.raw.variants.length, 4);
    assert.deepStrictEqual(message.raw.variants[1].aspectValues, { 版本: "注音版", 册数: "精选10册" });
  });
}

async function testPifaExpandsSkuListRows() {
  await withPifaSkuListVariantPage(async (page, captured, expected) => {
    await page.click('[data-action="collect-product"]');
    await page.waitForFunction(() => document.querySelector('[data-action="collect-product"]')?.disabled === false);

    const message = captured.find((m) => m.action === "pushSourceCollect");
    assert(message, "expected pushSourceCollect message from Pifa sku-list-row variants page");
    assert.strictEqual(message.sourceId, "pdd");
    assert.strictEqual(message.raw.title, expected.title);
    assert.strictEqual(message.raw.seller.name, "淘到鱼宠物用品专营店");
    assert.strictEqual(message.raw.variants.length, 3);
    assert.deepStrictEqual(message.raw.variants[0].aspectValues, { 重量: "40斤原味" });
    assert.strictEqual(message.raw.variants[0].price, "31.19");
    assert.strictEqual(message.raw.variants[2].name, "20斤活性炭");
  });
}

async function testPifaCollectDiagnosticsMirror1688() {
  await withPifaPage(async (page, captured, consoleMessages) => {
    const debug = await page.evaluate(() => window.__JZC_CN_SOURCE_DEBUG__?.());
    assert(debug, "expected debug helper on cn source pages");
    assert.strictEqual(debug.platform.sourceId, "pdd");
    assert.strictEqual(debug.raw.goodsId, "722497925613");

    await page.click('[data-action="collect-product"]');
    await page.waitForSelector("#jzc-cn-source-toast");
    const toastText = await page.textContent("#jzc-cn-source-toast");

    assert(captured.find((m) => m.action === "pushSourceCollect"), "expected collect message despite backend error");
    assert(toastText.includes("source pdd is registered but not yet enabled"));
    assert(consoleMessages.some((text) => text.includes("[jzc-cn-source] payload:")), "expected payload log");
    assert(consoleMessages.some((text) => text.includes("[jzc-cn-source] resp:")), "expected response log");
  }, {
    runtimeResponse: { ok: false, error: "source pdd is registered but not yet enabled" },
  });
}

async function testPifaManualListingMirrors1688OpenEditor() {
  await withPifaPage(async (page, captured) => {
    await page.click('[data-action="manual-listing"]');
    await page.waitForFunction(() => document.querySelector('[data-action="manual-listing"]')?.disabled === false);

    const collectMessage = captured.find((m) => m.action === "pushSourceCollect");
    assert(collectMessage, "expected manual listing to collect before opening editor");
    assert.strictEqual(collectMessage.sourceId, "pdd");
    assert.strictEqual(collectMessage.forceResubmit, true);
    assert.strictEqual(collectMessage.resetDraft, true);

    const openMessage = captured.find((m) => m.action === "openFrontend");
    assert(openMessage, "expected manual listing to open collect editor");
    assert.strictEqual(openMessage.path, "/ozon/products/collect/edit?id=pifa-collect-id");
  }, {
    runtimeResponse(message) {
      if (message.action === "openFrontend") return { ok: true, data: { opened: true } };
      return { ok: true, data: { result: { id: "pifa-collect-id", action: "created" } } };
    },
  });
}

async function testManualListingRuntimeInvalidatedShowsRefreshGuidance() {
  await withPifaPage(async (page, captured) => {
    await page.click('[data-action="manual-listing"]');
    await page.waitForSelector("#jzc-cn-source-toast");
    const toastText = await page.textContent("#jzc-cn-source-toast");

    assert.strictEqual(captured.length, 0);
    assert(
      toastText.includes("扩展已重新加载") || toastText.includes("刷新当前商品页"),
      `expected refresh guidance, got: ${toastText}`,
    );
  }, {
    runtimeLastErrorMessage: "Extension context invalidated.",
  });
}

async function testPifaRenderedDomCollectsThroughSharedPanel() {
  await withPifaRenderedPage(async (page, captured) => {
    await page.click('[data-action="collect-product"]');
    await page.waitForFunction(() => document.querySelector('[data-action="collect-product"]')?.disabled === false);

    const message = captured.find((m) => m.action === "pushSourceCollect");
    assert(message, "expected pushSourceCollect message from rendered Pifa DOM");
    assert.strictEqual(message.sourceId, "pdd");
    assert.strictEqual(message.raw.goodsId, "722497925613");
    assert.strictEqual(
      message.raw.title,
      "长条纸箱快递箱批发定做雨伞花卉水杯鱼竿包装盒三角形打包纸盒盒子",
    );
    assert.strictEqual(message.raw.price, "22.28");
    assert.strictEqual(message.raw.images.length, 2);
    assert.ok(message.raw.images[0].includes("cardboard-main.jpeg"));
  });
}

async function testPifaGoodsDetailPageCollectsRealShape() {
  await withPifaGoodsDetailPage(async (page, captured) => {
    await page.click('[data-action="collect-product"]');
    await page.waitForFunction(() => document.querySelector('[data-action="collect-product"]')?.disabled === false);

    const message = captured.find((m) => m.action === "pushSourceCollect");
    assert(message, "expected pushSourceCollect message from Pifa goods/detail URL");
    assert.strictEqual(message.sourceId, "pdd");
    assert.strictEqual(message.raw.goodsId, "458592806");
    assert.strictEqual(message.raw.title, "长条纸箱快递箱批发定做雨伞花卉水杯鱼竿包装盒三角形打包纸盒子");
    assert.strictEqual(message.raw.price, "22.28");
    assert.strictEqual(message.raw.images.length, 2);
    assert.ok(message.raw.images[0].includes("8f9dda01"));
    assert.strictEqual(message.raw.seller.name, "疯子包装旗舰店");
  });
}

async function testTaobaoCollectsProductInfoFromRenderedDom() {
  await withTaobaoRenderedPage(async (page, captured, expected) => {
    await page.click('[data-action="collect-product"]');
    await page.waitForFunction(() => document.querySelector('[data-action="collect-product"]')?.disabled === false);

    const message = captured.find((m) => m.action === "pushSourceCollect");
    assert(message, "expected pushSourceCollect message from Taobao item URL");
    assert.strictEqual(message.sourceId, "taobao");
    assert.strictEqual(message.raw.itemId, "980680602229");
    assert.strictEqual(message.raw.title, expected.title);
    assert.strictEqual(message.raw.price, "2.09");
    assert.strictEqual(message.raw.images[0], expected.mainImage);
    assert.strictEqual(message.raw.seller.name, expected.shopName);
  });
}

async function testTaobaoIgnoresSkuLabelStructuredNoise() {
  await withTaobaoSkuNoisePage(async (page, captured, expected) => {
    await page.click('[data-action="collect-product"]');
    await page.waitForFunction(() => document.querySelector('[data-action="collect-product"]')?.disabled === false);

    const message = captured.find((m) => m.action === "pushSourceCollect");
    assert(message, "expected pushSourceCollect message from Taobao noisy rendered page");
    assert.strictEqual(message.sourceId, "taobao");
    assert.strictEqual(message.raw.itemId, "908658719203");
    assert.strictEqual(message.raw.title, expected.title);
    assert.strictEqual(message.raw.images[0], expected.mainImage);
    assert.strictEqual(message.raw.seller.name, expected.sellerName);
  });
}

async function testTaobaoKeepsAliImageSellerSuffix() {
  await withTaobaoAliImageSuffixPage(async (page, captured, expected) => {
    await page.click('[data-action="collect-product"]');
    await page.waitForFunction(() => document.querySelector('[data-action="collect-product"]')?.disabled === false);

    const message = captured.find((m) => m.action === "pushSourceCollect");
    assert(message, "expected pushSourceCollect message from Taobao ali image suffix page");
    assert.strictEqual(message.sourceId, "taobao");
    assert.strictEqual(message.raw.title, expected.title);
    assert.strictEqual(message.raw.images[0], expected.normalizedMainImage);
    assert.ok(/\.jpg$/.test(message.raw.images[0]), "expected normalized image URL to keep a real file extension");
    assert(!message.raw.images[0].endsWith("_"), "expected normalized image URL not to be truncated before _!! suffix");
  });
}

async function testTaobaoPrefersDocumentTitleAndExpandsDomVariants() {
  await withTaobaoDomVariantPage(async (page, captured, expected) => {
    await page.click('[data-action="collect-product"]');
    await page.waitForFunction(() => document.querySelector('[data-action="collect-product"]')?.disabled === false);

    const message = captured.find((m) => m.action === "pushSourceCollect");
    assert(message, "expected pushSourceCollect message from Taobao DOM variants page");
    assert.strictEqual(message.sourceId, "taobao");
    assert.strictEqual(message.raw.itemId, "971785515390");
    assert.strictEqual(message.raw.title, expected.title);
    assert.notStrictEqual(message.raw.title, expected.skuLabel);
    assert.strictEqual(message.raw.variants.length, 4);
    assert(!message.raw.variants.some((variant) => variant.name.includes(expected.aggregateColorLabel)));
    assert.deepStrictEqual(message.raw.variants[0].aspectValues, {
      续航版本: expected.skuLabel,
      颜色分类: "黑色",
    });
    assert.strictEqual(
      message.raw.variants[0].image,
      "https://img.alicdn.com/imgextra/i4/3505758707/O1CN01blue_!!3505758707.jpg",
    );
  });
}

async function testAmazonCollectsThroughSharedPanel() {
  await withAmazonPage(async (page, captured, expected) => {
    await page.click('[data-action="collect-product"]');
    await page.waitForFunction(() => document.querySelector('[data-action="collect-product"]')?.disabled === false);

    const message = captured.find((m) => m.action === "pushSourceCollect");
    assert(message, "expected pushSourceCollect message from Amazon page");
    assert.strictEqual(message.sourceId, "amazon");
    assert.strictEqual(message.raw.asin, "B0TESTASN1");
    assert.strictEqual(message.raw.title, expected.title);
    assert.strictEqual(message.raw.price, "29.99");
    assert.strictEqual(message.raw.images[0], "https://m.media-amazon.com/images/I/71main.jpg");
    assert.strictEqual(message.raw.seller.name, "Amazon Sample Store");
    assert(message.raw.variants.length >= 2, "expected Amazon variation options");
    assert.strictEqual(message.raw.variants[0].aspectValues.Color, "Black");
  });
}

async function testAmazonTwisterDoesNotExplodeAggregateGroups() {
  await withAmazonTwisterAggregatePage(async (page, captured, expected) => {
    await page.click('[data-action="collect-product"]');
    await page.waitForFunction(() => document.querySelector('[data-action="collect-product"]')?.disabled === false);

    const message = captured.find((m) => m.action === "pushSourceCollect");
    assert(message, "expected pushSourceCollect message from Amazon twister page");
    assert.strictEqual(message.sourceId, "amazon");
    assert.strictEqual(message.raw.asin, "B0FN9JLD28");
    assert.strictEqual(message.raw.title, expected.title);
    assert.strictEqual(message.raw.seller.name, "Acer Store");
    assert.strictEqual(message.raw.variants.length, 8, "expected 2 style x 2 color x 2 size variants only");
    assert(!message.raw.variants.some((variant) => /options from/i.test(variant.name)), "expected Amazon option names to strip price helper text");
    assert.deepStrictEqual(message.raw.variants[0].aspectValues, {
      Style: "R7 7730u",
      Color: "Pure Silver",
      Size: "8GB RAM / 128GB SSD",
    });
  });
}

async function testAmazonJsonTwisterExtractsStoreAndVariants() {
  await withAmazonJsonTwisterPage(async (page, captured, expected) => {
    await page.click('[data-action="collect-product"]');
    await page.waitForFunction(() => document.querySelector('[data-action="collect-product"]')?.disabled === false);

    const message = captured.find((m) => m.action === "pushSourceCollect");
    assert(message, "expected pushSourceCollect message from Amazon JSON twister page");
    assert.strictEqual(message.sourceId, "amazon");
    assert.strictEqual(message.raw.asin, "B0FN9JLD28");
    assert.strictEqual(message.raw.title, expected.title);
    assert.strictEqual(message.raw.seller.name, "Acer Store");
    assert(message.raw.seller.shopUrl.includes("/stores/Acer/"), "expected Amazon store URL from byline store link");
    assert.strictEqual(message.raw.variants.length, 3);
    assert.deepStrictEqual(message.raw.variants.map((variant) => variant.sku), [
      "B0FN9JLD28",
      "B0DTB4R3VP",
      "B0FT3NRVL6",
    ]);
    assert.deepStrictEqual(message.raw.variants[0].aspectValues, { CPU: "R3 7320u" });
    assert.strictEqual(message.raw.variants[1].name, "R7 5825U");
  });
}

async function testAmazonBrandBylineDoesNotBecomeSeller() {
  await withAmazonBrandBylinePage(async (page, captured, expected) => {
    await page.click('[data-action="collect-product"]');
    await page.waitForFunction(() => document.querySelector('[data-action="collect-product"]')?.disabled === false);

    const message = captured.find((m) => m.action === "pushSourceCollect");
    assert(message, "expected pushSourceCollect message from Amazon brand byline page");
    assert.strictEqual(message.sourceId, "amazon");
    assert.strictEqual(message.raw.title, expected.title);
    assert.strictEqual(message.raw.seller, null, "expected Amazon brand search byline not to be stored as seller");
  });
}

async function testWbCollectsThroughSharedPanel() {
  await withWbPage(async (page, captured, expected) => {
    await page.click('[data-action="collect-product"]');
    await page.waitForFunction(() => document.querySelector('[data-action="collect-product"]')?.disabled === false);

    const message = captured.find((m) => m.action === "pushSourceCollect");
    assert(message, "expected pushSourceCollect message from WB page");
    assert.strictEqual(message.sourceId, "wb");
    assert.strictEqual(message.raw.nmId, "211234567");
    assert.strictEqual(message.raw.title, expected.title);
    assert.strictEqual(message.raw.price, "2499");
    assert.strictEqual(message.raw.images[0], "https://basket-12.wbbasket.ru/vol2112/part211234/211234567/images/big/1.webp");
    assert.strictEqual(message.raw.seller.name, "WB sample seller");
    assert(message.raw.variants.length >= 2, "expected WB option variants");
  });
}

async function testWbModernRenderedPageKeepsProductImageAndRubCurrency() {
  await withWbModernRenderedPage(async (page, captured, expected) => {
    await page.click('[data-action="collect-product"]');
    await page.waitForFunction(() => document.querySelector('[data-action="collect-product"]')?.disabled === false);

    const message = captured.find((m) => m.action === "pushSourceCollect");
    assert(message, "expected pushSourceCollect message from modern WB page");
    assert.strictEqual(message.sourceId, "wb");
    assert.strictEqual(message.raw.nmId, "246443845");
    assert.strictEqual(message.raw.title, expected.title);
    assert.strictEqual(message.raw.price, "1070");
    assert.strictEqual(message.raw.priceCurrency, "RUB");
    assert.strictEqual(message.raw.images[0], "https://basket-16.wbbasket.ru/vol2464/part246443/246443845/images/big/1.webp");
    assert(!message.raw.images.some((src) => /wb-og-win|280088203/.test(src)), "expected WB images to exclude shell and recommendation assets");
  });
}

async function testWbGenericShellDoesNotBuildProductPayload() {
  await withWbGenericShellPage(async (page, captured) => {
    const raw = await page.evaluate(() => window.JZCnSourceScraper.buildPayload(window.JZCnSourceScraper.detectPlatform()));
    assert.strictEqual(raw, null, "expected generic Wildberries shell page not to build product payload");
    assert.strictEqual(captured.length, 0, "expected no collect request for generic shell page");
  });
}

async function testTemuCollectsThroughSharedPanel() {
  await withTemuPage(async (page, captured, expected) => {
    await page.click('[data-action="collect-product"]');
    await page.waitForFunction(() => document.querySelector('[data-action="collect-product"]')?.disabled === false);

    const message = captured.find((m) => m.action === "pushSourceCollect");
    assert(message, "expected pushSourceCollect message from Temu page");
    assert.strictEqual(message.sourceId, "temu");
    assert.strictEqual(message.raw.goodsId, "601099512345678");
    assert.strictEqual(message.raw.title, expected.title);
    assert.strictEqual(message.raw.price, "12.48");
    assert.strictEqual(message.raw.images[0], "https://img.kwcdn.com/product/FancyAlgo/temu-main.jpeg");
    assert.strictEqual(message.raw.seller.name, "Temu shop");
    assert(message.raw.variants.length >= 2, "expected Temu SKU chip variants");
  });
}

async function testTemuNoisyJapanTitleAndPriceGuard() {
  await withTemuNoisyJapanPage(async (page, captured, expected) => {
    await page.click('[data-action="collect-product"]');
    await page.waitForFunction(() => document.querySelector('[data-action="collect-product"]')?.disabled === false);

    const message = captured.find((m) => m.action === "pushSourceCollect");
    assert(message, "expected pushSourceCollect message from Temu noisy Japan page");
    assert.strictEqual(message.sourceId, "temu");
    assert.strictEqual(message.raw.title, expected.title);
    assert.strictEqual(message.raw.price, null, "expected Temu not to parse product ids or recommendation ids as price");
  });
}

async function testTemuRenderedChineseProductExtractsVisibleOffer() {
  await withTemuRenderedChineseProductPage(async (page, captured, expected) => {
    await page.click('[data-action="collect-product"]');
    await page.waitForFunction(() => document.querySelector('[data-action="collect-product"]')?.disabled === false);

    const message = captured.find((m) => m.action === "pushSourceCollect");
    assert(message, "expected pushSourceCollect message from rendered Temu Chinese page");
    assert.strictEqual(message.sourceId, "temu");
    assert.strictEqual(message.raw.goodsId, "606283956597557");
    assert.strictEqual(message.raw.title, expected.title);
    assert.strictEqual(message.raw.price, "49");
    assert.strictEqual(message.raw.images[0], "https://img.kwcdn.com/product/open/0d5e64bfe73b4938b337ec1d70f4025c-goods.jpeg");
    assert.strictEqual(message.raw.variants.length, 1);
    assert.strictEqual(message.raw.variants[0].name, "反光尺面罩 深灰色");
    assert.deepStrictEqual(message.raw.variants[0].aspectValues, {
      颜色: "反光尺面罩 深灰色",
      数量: "1个",
    });
  });
}

async function testTemuNoisyProductImagesPreferGoodsAssetsAndJpyCurrency() {
  await withTemuNoisyProductImagesJapanPage(async (page, captured, expected) => {
    await page.click('[data-action="collect-product"]');
    await page.waitForFunction(() => document.querySelector('[data-action="collect-product"]')?.disabled === false);

    const message = captured.find((m) => m.action === "pushSourceCollect");
    assert(message, "expected pushSourceCollect message from Temu noisy image page");
    assert.strictEqual(message.sourceId, "temu");
    assert.strictEqual(message.raw.goodsId, "606283956597557");
    assert.strictEqual(message.raw.title, expected.title);
    assert.strictEqual(message.raw.price, "49");
    assert.strictEqual(message.raw.priceCurrency, "JPY");
    assert.strictEqual(message.raw.images[0], "https://img.kwcdn.com/product/open/0d5e64bfe73b4938b337ec1d70f4025c-goods.jpeg");
    assert(message.raw.images.some((src) => /product\/fancy/.test(src)), "expected Temu product gallery image to be retained");
    assert(!message.raw.images.some((src) => /upload_aimg|upload_commimg|openingemail|frontpage/.test(src)), "expected Temu UI and app assets to be filtered out");
  });
}

async function testTemuFragmentedPriceAndDefaultSeller() {
  await withTemuFragmentedPriceNoSellerPage(async (page, captured, expected) => {
    await page.click('[data-action="collect-product"]');
    await page.waitForFunction(() => document.querySelector('[data-action="collect-product"]')?.disabled === false);

    const message = captured.find((m) => m.action === "pushSourceCollect");
    assert(message, "expected pushSourceCollect message from Temu fragmented price page");
    assert.strictEqual(message.sourceId, "temu");
    assert.strictEqual(message.raw.title, expected.title);
    assert.strictEqual(message.raw.price, "49");
    assert.strictEqual(message.raw.priceCurrency, "JPY");
    assert.strictEqual(message.raw.seller.name, "Temu");
  });
}

async function testTemuSellerProfileCardExtractsMerchantName() {
  await withTemuSellerProfileCardPage(async (page, captured, expected) => {
    await page.click('[data-action="collect-product"]');
    await page.waitForFunction(() => document.querySelector('[data-action="collect-product"]')?.disabled === false);

    const message = captured.find((m) => m.action === "pushSourceCollect");
    assert(message, "expected pushSourceCollect message from Temu seller profile card page");
    assert.strictEqual(message.sourceId, "temu");
    assert.strictEqual(message.raw.goodsId, "601105124897749");
    assert.strictEqual(message.raw.title, expected.title);
    assert.strictEqual(message.raw.seller.name, "GOGOLULU");
    assert(message.raw.seller.shopUrl.includes("mall_id=881234"), "expected Temu mall URL from seller profile card");
  });
}

async function testTemuLocalizedSlugUsesStructuredProductData() {
  await withTemuLocalizedSlugPage(async (page, captured, expected) => {
    await page.click('[data-action="collect-product"]');
    await page.waitForFunction(() => document.querySelector('[data-action="collect-product"]')?.disabled === false);

    const message = captured.find((m) => m.action === "pushSourceCollect");
    assert(message, "expected pushSourceCollect message from Temu localized slug page");
    assert.strictEqual(message.sourceId, "temu");
    assert.strictEqual(message.raw.goodsId, "601099512345678");
    assert.strictEqual(message.raw.title, expected.title);
    assert.strictEqual(message.raw.seller.name, "Temu mask shop");
    assert.strictEqual(message.raw.variants.length, 2);
  });
}

async function testMercadoLibreCollectsThroughSharedPanel() {
  await withMercadoLibrePage(async (page, captured, expected) => {
    await page.click('[data-action="collect-product"]');
    await page.waitForFunction(() => document.querySelector('[data-action="collect-product"]')?.disabled === false);

    const message = captured.find((m) => m.action === "pushSourceCollect");
    assert(message, "expected pushSourceCollect message from Mercado Libre page");
    assert.strictEqual(message.sourceId, "mercadolibre");
    assert.strictEqual(message.raw.mlItemId, "MLA-1234567890");
    assert.strictEqual(message.raw.title, expected.title);
    assert.strictEqual(message.raw.price, "12999");
    assert.strictEqual(message.raw.images[0], "https://http2.mlstatic.com/D_NQ_NP_123456-MLA-main.webp");
    assert.strictEqual(message.raw.seller.name, "ML sample seller");
    assert(message.raw.variants.length >= 2, "expected Mercado Libre option variants");
  });
}

async function testMercadoLibreStripsShippingAndButtonVariantNoise() {
  await withMercadoLibreShippingNoisePage(async (page, captured, expected) => {
    await page.click('[data-action="collect-product"]');
    await page.waitForFunction(() => document.querySelector('[data-action="collect-product"]')?.disabled === false);

    const message = captured.find((m) => m.action === "pushSourceCollect");
    assert(message, "expected pushSourceCollect message from Mercado Libre shipping noise page");
    assert.strictEqual(message.sourceId, "mercadolibre");
    assert.strictEqual(message.raw.title, expected.title);
    assert.strictEqual(message.raw.price, "46699");
    assert.strictEqual(message.raw.seller.name, "PETENATTI HOGAR");
    assert.strictEqual(message.raw.variants.length, 1);
    assert.strictEqual(message.raw.variants[0].name, "Negro");
    assert.deepStrictEqual(message.raw.variants[0].aspectValues, { Color: "Negro" });
  });
}

async function testYandexCollectsThroughSharedPanel() {
  await withYandexPage(async (page, captured, expected) => {
    await page.click('[data-action="collect-product"]');
    await page.waitForFunction(() => document.querySelector('[data-action="collect-product"]')?.disabled === false);

    const message = captured.find((m) => m.action === "pushSourceCollect");
    assert(message, "expected pushSourceCollect message from Yandex Market page");
    assert.strictEqual(message.sourceId, "yandex");
    assert.strictEqual(message.raw.yandexSku, "987654321");
    assert.strictEqual(message.raw.title, expected.title);
    assert.strictEqual(message.raw.price, "4299");
    assert.strictEqual(message.raw.images[0], "https://avatars.mds.yandex.net/get-mpic/123456/img_id987654/orig");
    assert.strictEqual(message.raw.seller.name, "Yandex sample shop");
    assert(message.raw.variants.length >= 2, "expected Yandex option variants");
  });
}

async function testYandexRenderedPagePrefersProductH1OverRecommendationNoise() {
  await withYandexRenderedPage(async (page, captured, expected) => {
    await page.click('[data-action="collect-product"]');
    await page.waitForFunction(() => document.querySelector('[data-action="collect-product"]')?.disabled === false);

    const message = captured.find((m) => m.action === "pushSourceCollect");
    assert(message, "expected pushSourceCollect message from rendered Yandex Market page");
    assert.strictEqual(message.sourceId, "yandex");
    assert.strictEqual(message.raw.yandexSku, "10865015");
    assert.strictEqual(message.raw.title, expected.title);
    assert(!message.raw.title.includes("Яндекс Маркете"), "expected Yandex title suffix to be removed");
    assert(!message.raw.title.includes("Defender"), "expected recommendation title not to be used");
    assert.strictEqual(message.raw.images[0], "https://avatars.mds.yandex.net/get-mpic/4489193/img_id2157349518272126176.jpeg/90x120");
  });
}

async function testYandexMerchantFilterShopCardExtractsSellerAndBrand() {
  await withYandexMerchantFilterShopPage(async (page, captured, expected) => {
    await page.click('[data-action="collect-product"]');
    await page.waitForFunction(() => document.querySelector('[data-action="collect-product"]')?.disabled === false);

    const message = captured.find((m) => m.action === "pushSourceCollect");
    assert(message, "expected pushSourceCollect message from Yandex merchant-filter shop page");
    assert.strictEqual(message.sourceId, "yandex");
    assert.strictEqual(message.raw.yandexSku, "103189793773");
    assert.strictEqual(message.raw.title, expected.title);
    assert.strictEqual(message.raw.price, "2913");
    assert.strictEqual(message.raw.priceCurrency, "RUB");
    assert.strictEqual(message.raw.seller.name, "Пуффбери");
    assert(message.raw.seller.shopUrl.includes("merchant-filter=891208"), "expected Yandex merchant-filter shop URL");
    assert.strictEqual(message.raw.brandName, "Пуффбери");
  });
}

async function testSheinCollectsThroughSharedPanel() {
  await withSheinPage(async (page, captured, expected) => {
    await page.click('[data-action="collect-product"]');
    await page.waitForFunction(() => document.querySelector('[data-action="collect-product"]')?.disabled === false);

    const message = captured.find((m) => m.action === "pushSourceCollect");
    assert(message, "expected pushSourceCollect message from SHEIN page");
    assert.strictEqual(message.sourceId, "shein");
    assert.strictEqual(message.raw.goodsSn, "34567890");
    assert.strictEqual(message.raw.title, expected.title);
    assert.strictEqual(message.raw.price, "15.49");
    assert.strictEqual(message.raw.images[0], "https://img.ltwebstatic.com/images3_pi/2026/06/24/shein-main.jpg");
    assert.strictEqual(message.raw.seller.name, "SHEIN");
    assert(message.raw.variants.length >= 2, "expected SHEIN SKU option variants");
  });
}

async function testSheinJapanTitleSuffixIsRemoved() {
  await withSheinJapanTitlePage(async (page, captured, expected) => {
    await page.click('[data-action="collect-product"]');
    await page.waitForFunction(() => document.querySelector('[data-action="collect-product"]')?.disabled === false);

    const message = captured.find((m) => m.action === "pushSourceCollect");
    assert(message, "expected pushSourceCollect message from SHEIN Japan page");
    assert.strictEqual(message.sourceId, "shein");
    assert.strictEqual(message.raw.title, expected.title);
    assert.strictEqual(message.raw.price, "455");
    assert.strictEqual(message.raw.priceCurrency, "JPY");
    assert.strictEqual(message.raw.seller.name, "SHEIN");
    assert.strictEqual(message.raw.seller.shopUrl, "https://jp.shein.com");
    assert.strictEqual(message.raw.brandName, "SHEGLAM");
    assert(!message.raw.title.includes("SHEIN JAPAN"), "expected SHEIN Japan site suffix to be removed");
  });
}

async function testSheinMarketplaceSellerCardExtractsMerchantName() {
  await withSheinMarketplaceSellerPage(async (page, captured, expected) => {
    await page.click('[data-action="collect-product"]');
    await page.waitForFunction(() => document.querySelector('[data-action="collect-product"]')?.disabled === false);

    const message = captured.find((m) => m.action === "pushSourceCollect");
    assert(message, "expected pushSourceCollect message from SHEIN marketplace seller page");
    assert.strictEqual(message.sourceId, "shein");
    assert.strictEqual(message.raw.goodsSn, "423724222");
    assert.strictEqual(message.raw.title, expected.title);
    assert.strictEqual(message.raw.price, "2020");
    assert.strictEqual(message.raw.priceCurrency, "JPY");
    assert.strictEqual(message.raw.seller.name, "GarnetGI45");
    assert(message.raw.seller.shopUrl.includes("store_code=GarnetGI45"), "expected SHEIN store URL from marketplace seller card");
  });
}

async function testSheinShopInfoPrefersBrandSellerOverSheinDeliverySeller() {
  await withSheinBrandShopInfoPage(async (page, captured, expected) => {
    await page.click('[data-action="collect-product"]');
    await page.waitForFunction(() => document.querySelector('[data-action="collect-product"]')?.disabled === false);

    const message = captured.find((m) => m.action === "pushSourceCollect");
    assert(message, "expected pushSourceCollect message from SHEIN brand shop info page");
    assert.strictEqual(message.sourceId, "shein");
    assert.strictEqual(message.raw.goodsSn, "481621562");
    assert.strictEqual(message.raw.title, expected.title);
    assert.strictEqual(message.raw.seller.name, "BizChic");
    assert(message.raw.seller.shopUrl.includes("store_code=BizChic"), "expected SHEIN shop info store URL");
  });
}

async function testSheinDataStoreShopInfoExtractsBrandMerchant() {
  await withSheinDataStoreShopInfoPage(async (page, captured, expected) => {
    await page.click('[data-action="collect-product"]');
    await page.waitForFunction(() => document.querySelector('[data-action="collect-product"]')?.disabled === false);

    const message = captured.find((m) => m.action === "pushSourceCollect");
    assert(message, "expected pushSourceCollect message from SHEIN data store shop info page");
    assert.strictEqual(message.sourceId, "shein");
    assert.strictEqual(message.raw.goodsSn, "61079413");
    assert.strictEqual(message.raw.title, expected.title);
    assert.strictEqual(message.raw.brandName, "Franclia");
    assert.strictEqual(message.raw.seller.name, "Franclia");
    assert(message.raw.seller.shopUrl.includes("store_code=8215335601"), "expected SHEIN data store URL from shop info card");
  });
}

async function testSheinSilkySpellKeepsProductTitleAndShopName() {
  await withSheinSilkySpellShopInfoPage(async (page, captured, expected) => {
    await page.click('[data-action="collect-product"]');
    await page.waitForFunction(() => document.querySelector('[data-action="collect-product"]')?.disabled === false);

    const message = captured.find((m) => m.action === "pushSourceCollect");
    if (!message) {
      const debug = await page.evaluate(() => window.__JZC_CN_SOURCE_DEBUG__?.());
      assert(message, `expected pushSourceCollect message from SHEIN SilkySpell page; debug=${JSON.stringify(debug)}`);
    }
    assert.strictEqual(message.sourceId, "shein");
    assert.strictEqual(message.raw.goodsSn, "33203094");
    assert.strictEqual(message.raw.title, expected.title);
    assert.notStrictEqual(message.raw.title, "Destination");
    assert.strictEqual(message.raw.seller.name, "SilkySpell");
    assert(message.raw.seller.shopUrl.includes("store_code=SilkySpell"), "expected SHEIN SilkySpell store URL");
  });
}

async function testSheinElaminiKeepsGoodsNameAndShopCardSeller() {
  await withSheinElaminiShopInfoPage(async (page, captured, expected) => {
    await page.click('[data-action="collect-product"]');
    await page.waitForFunction(() => document.querySelector('[data-action="collect-product"]')?.disabled === false);

    const message = captured.find((m) => m.action === "pushSourceCollect");
    if (!message) {
      const debug = await page.evaluate(() => window.__JZC_CN_SOURCE_DEBUG__?.());
      assert(message, `expected pushSourceCollect message from SHEIN Elamini page; debug=${JSON.stringify(debug)}`);
    }
    assert.strictEqual(message.sourceId, "shein");
    assert.strictEqual(message.raw.goodsSn, "88259809");
    assert.strictEqual(message.raw.title, expected.title);
    assert(!/Domestic shipping|afternoon picnic/i.test(message.raw.title), "expected promo title not to be used");
    assert.strictEqual(message.raw.seller.name, "Elamini");
  });
}

async function testSheinBreadcrumbTitleFallsBackToUrlSlug() {
  await withSheinBreadcrumbOnlyTitlePage(async (page, captured, expected) => {
    await page.click('[data-action="collect-product"]');
    await page.waitForFunction(() => document.querySelector('[data-action="collect-product"]')?.disabled === false);

    const message = captured.find((m) => m.action === "pushSourceCollect");
    if (!message) {
      const debug = await page.evaluate(() => window.__JZC_CN_SOURCE_DEBUG__?.());
      assert(message, `expected pushSourceCollect message from SHEIN breadcrumb page; debug=${JSON.stringify(debug)}`);
    }
    assert.strictEqual(message.sourceId, "shein");
    assert.strictEqual(message.raw.goodsSn, "3296917895459");
    assert.strictEqual(message.raw.title, expected.title);
    assert(!message.raw.title.includes("Home /"), "expected breadcrumb path not to be used as title");
    assert.strictEqual(message.raw.price, "926");
    assert.strictEqual(message.raw.priceCurrency, "JPY");
    assert.strictEqual(message.raw.seller.name, "FRIFUL");
  });
}

async function testSheinJapaneseProductIntroBeatsBreadcrumbAndShippingTitle() {
  await withSheinJapaneseProductIntroPage(async (page, captured, expected) => {
    await page.click('[data-action="collect-product"]');
    await page.waitForFunction(() => document.querySelector('[data-action="collect-product"]')?.disabled === false);

    const message = captured.find((m) => m.action === "pushSourceCollect");
    if (!message) {
      const debug = await page.evaluate(() => window.__JZC_CN_SOURCE_DEBUG__?.());
      assert(message, `expected pushSourceCollect message from SHEIN Japanese product intro page; debug=${JSON.stringify(debug)}`);
    }
    assert.strictEqual(message.sourceId, "shein");
    assert.strictEqual(message.raw.goodsSn, "9709774");
    assert.strictEqual(message.raw.title, expected.title);
    assert.notStrictEqual(message.raw.title, "お届け先");
    assert(!message.raw.title.includes("ホーム/"), "expected Japanese breadcrumb path not to be used");
    assert.strictEqual(message.raw.price, "694");
    assert.strictEqual(message.raw.priceCurrency, "JPY");
    assert.strictEqual(message.raw.seller.name, "URUW");
    assert(message.raw.seller.shopUrl.includes("store_code=URUW"), "expected SHEIN shop URL from Japanese shop entry");
    assert.strictEqual(message.raw.brandName, "SHEIN");
  });
}

async function testSheinLabelPrefixedTitleUsesNestedProductNameOnly() {
  await withSheinLabelPrefixedProductTitlePage(async (page, captured, expected) => {
    await page.click('[data-action="collect-product"]');
    await page.waitForFunction(() => document.querySelector('[data-action="collect-product"]')?.disabled === false);

    const message = captured.find((m) => m.action === "pushSourceCollect");
    if (!message) {
      const debug = await page.evaluate(() => window.__JZC_CN_SOURCE_DEBUG__?.());
      assert(message, `expected pushSourceCollect message from SHEIN label-prefixed title page; debug=${JSON.stringify(debug)}`);
    }
    assert.strictEqual(message.sourceId, "shein");
    assert.strictEqual(message.raw.goodsSn, "507838584");
    assert.strictEqual(message.raw.title, expected.title);
    assert(!message.raw.title.includes("新品"), "expected SHEIN product label not to be included in title");
    assert(!message.raw.title.includes("トレンド"), "expected SHEIN trend label not to be included in title");
    assert(!message.raw.title.includes("販売数急増"), "expected SHEIN store quality tag not to be used as title");
  });
}

async function testSheinSkuSlugUsesStructuredProductData() {
  await withSheinSkuSlugPage(async (page, captured, expected) => {
    await page.click('[data-action="collect-product"]');
    await page.waitForFunction(() => document.querySelector('[data-action="collect-product"]')?.disabled === false);

    const message = captured.find((m) => m.action === "pushSourceCollect");
    assert(message, "expected pushSourceCollect message from SHEIN sku slug page");
    assert.strictEqual(message.sourceId, "shein");
    assert.strictEqual(message.raw.goodsSn, "sw240624123456");
    assert.strictEqual(message.raw.title, expected.title);
    assert.strictEqual(message.raw.seller.name, "SHEIN");
    assert.strictEqual(message.raw.variants.length, 1);
  });
}

function getCnSourceManifestEntry(manifest) {
  const scripts = manifest.content_scripts || [];
  return scripts.find((item) => (item.js || []).includes("content/cn-source-product.js"));
}

function assertValidChromePattern(pattern) {
  if (pattern === "<all_urls>") return;
  const match = pattern.match(/^(\*|http|https|file|ftp):\/\/([^/]*)(\/.*)$/);
  assert(match, `invalid Chrome match pattern shape: ${pattern}`);
  const host = match[2];
  if (host === "*") return;
  assert(host, `Chrome match pattern host required: ${pattern}`);
  if (host.startsWith("*.")) {
    assert(!host.slice(2).includes("*"), `Chrome match pattern cannot wildcard TLD: ${pattern}`);
    assert(host.slice(2).includes("."), `Chrome match pattern wildcard host must include a real domain: ${pattern}`);
    return;
  }
  assert(!host.includes("*"), `Chrome match pattern host wildcard must be the whole host or prefix only: ${pattern}`);
}

function globToRegExp(glob) {
  return new RegExp(`^${glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
}

function chromePatternMatches(pattern, targetUrl) {
  const match = pattern.match(/^(\*|http|https|file|ftp):\/\/([^/]*)(\/.*)$/);
  if (!match) return false;
  const [, schemePattern, hostPattern, pathPattern] = match;
  const url = new URL(targetUrl);
  if (schemePattern !== "*" && schemePattern !== url.protocol.slice(0, -1)) return false;
  if (schemePattern === "*" && !["http:", "https:"].includes(url.protocol)) return false;
  const host = url.hostname.toLowerCase();
  const expectedHost = hostPattern.toLowerCase();
  if (expectedHost !== "*") {
    if (expectedHost.startsWith("*.")) {
      const base = expectedHost.slice(2);
      if (host !== base && !host.endsWith(`.${base}`)) return false;
    } else if (host !== expectedHost) {
      return false;
    }
  }
  return globToRegExp(pathPattern).test(`${url.pathname}${url.search}${url.hash}`);
}

function testManifestPatternsAreValidAndCoverRepresentativeUrls() {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const hostPatterns = manifest.host_permissions || [];
  const contentPatterns = (getCnSourceManifestEntry(manifest)?.matches || []);

  [...hostPatterns, ...contentPatterns].forEach(assertValidChromePattern);

  const representativeUrls = [
    "https://www.amazon.com/Sample-Backpack/dp/B0TESTASN1?th=1",
    "https://www.amazon.co.uk/dp/B0TESTASN1",
    "https://www.amazon.de/gp/product/B0TESTASN1",
    "https://wildberries.ru/catalog/211234567/detail.aspx?targetUrl=EX",
    "https://global.wildberries.ru/catalog/211234567/detail.aspx",
    "https://www.temu.com/goods.html?goods_id=601099512345678",
    "https://www.temu.com/product/601099512345678.html",
    "https://www.temu.com/jp-zh-Hans/sample-summer-mask.html",
    "https://articulo.mercadolibre.com.ar/MLA-1234567890-sample-backpack-_JM",
    "https://www.mercadolibre.com.mx/p/MLM12345678",
    "https://market.yandex.ru/product--sample-speaker/987654321",
    "https://market.yandex.ru/card/sample-speaker/987654321?sku=123",
    "https://www.shein.com/Sample-Dress-p-34567890-cat-1727.html?goods_id=34567890",
    "https://us.shein.com/Sample-Dress-p-34567890.html",
    "https://us.shein.com/Sample-Dress-p-sw240624123456-cat-1727.html",
  ];

  for (const url of representativeUrls) {
    assert(
      contentPatterns.some((pattern) => chromePatternMatches(pattern, url)),
      `expected CN source content script to match ${url}`,
    );
  }
}

function testManifestInjectsCnSourcePanel() {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const entry = getCnSourceManifestEntry(manifest);
  assert(entry, "expected CN source product content script");
  assert((entry.js || []).includes("lib/cn-source-scraper.js"), "expected scraper helper before product script");
  assert((entry.js || []).includes("lib/cn-source-panel.js"), "expected shared panel before product script");
  assert(entry.matches.some((match) => match.includes("item.jd.com")), "expected JD match");
  assert(entry.matches.some((match) => match.includes("pifa.pinduoduo.com")), "expected PDD wholesale match");
  assert(entry.matches.some((match) => match.includes("taobao.com")), "expected Taobao match");
  assert(entry.matches.some((match) => match.includes("tmall.com")), "expected Tmall match");
  assert(entry.matches.some((match) => match.includes("amazon.")), "expected Amazon match");
  assert(entry.matches.some((match) => match.includes("wildberries.ru")), "expected WB match");
  assert(entry.matches.some((match) => match.includes("temu.")), "expected Temu match");
  assert(entry.matches.some((match) => match.includes("mercadolibre.")), "expected Mercado Libre match");
  assert(entry.matches.some((match) => match.includes("market.yandex.")), "expected Yandex Market match");
  assert(entry.matches.some((match) => match.includes("shein.")), "expected SHEIN match");
}

function testDebugBridgeUsesExternalWebAccessibleScript() {
  const bridgeSource = fs.readFileSync(debugBridgePagePath, "utf8");
  const panelSource = fs.readFileSync(panelPath, "utf8");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const resources = manifest.web_accessible_resources || [];

  assert(bridgeSource.includes("window.__JZC_CN_SOURCE_DEBUG__"), "expected page debug helper");
  assert(panelSource.includes("getURL") && panelSource.includes("lib/cn-source-debug-page.js"), "expected external debug bridge script");
  assert(!panelSource.includes("script.textContent = `"), "debug bridge must not use inline script under Taobao CSP");
  assert(
    resources.some((item) => (item.resources || []).some((resource) => resource === "lib/*" || resource === "lib/cn-source-debug-page.js")),
    "expected debug bridge to be web accessible",
  );
}

(async () => {
  testManifestPatternsAreValidAndCoverRepresentativeUrls();
  testManifestInjectsCnSourcePanel();
  testDebugBridgeUsesExternalWebAccessibleScript();
  await testJdCollectsThroughSharedPanel();
  await testJdIgnoresCalculatorStructuredNoise();
  await testJdExpandsDomVariants();
  await testPifaCollectsThroughSharedPanel();
  await testPifaExpandsDomVariants();
  await testPifaExpandsSpecPanelVariants();
  await testPifaExpandsSkuListRows();
  await testPifaCollectDiagnosticsMirror1688();
  await testPifaManualListingMirrors1688OpenEditor();
  await testManualListingRuntimeInvalidatedShowsRefreshGuidance();
  await testPifaRenderedDomCollectsThroughSharedPanel();
  await testPifaGoodsDetailPageCollectsRealShape();
  await testTaobaoCollectsProductInfoFromRenderedDom();
  await testTaobaoIgnoresSkuLabelStructuredNoise();
  await testTaobaoKeepsAliImageSellerSuffix();
  await testTaobaoPrefersDocumentTitleAndExpandsDomVariants();
  await testAmazonCollectsThroughSharedPanel();
  await testAmazonTwisterDoesNotExplodeAggregateGroups();
  await testAmazonJsonTwisterExtractsStoreAndVariants();
  await testAmazonBrandBylineDoesNotBecomeSeller();
  await testWbCollectsThroughSharedPanel();
  await testWbModernRenderedPageKeepsProductImageAndRubCurrency();
  await testWbGenericShellDoesNotBuildProductPayload();
  await testTemuCollectsThroughSharedPanel();
  await testTemuNoisyJapanTitleAndPriceGuard();
  await testTemuRenderedChineseProductExtractsVisibleOffer();
  await testTemuNoisyProductImagesPreferGoodsAssetsAndJpyCurrency();
  await testTemuFragmentedPriceAndDefaultSeller();
  await testTemuSellerProfileCardExtractsMerchantName();
  await testTemuLocalizedSlugUsesStructuredProductData();
  await testMercadoLibreCollectsThroughSharedPanel();
  await testMercadoLibreStripsShippingAndButtonVariantNoise();
  await testYandexCollectsThroughSharedPanel();
  await testYandexRenderedPagePrefersProductH1OverRecommendationNoise();
  await testYandexMerchantFilterShopCardExtractsSellerAndBrand();
  await testSheinCollectsThroughSharedPanel();
  await testSheinJapanTitleSuffixIsRemoved();
  await testSheinMarketplaceSellerCardExtractsMerchantName();
  await testSheinShopInfoPrefersBrandSellerOverSheinDeliverySeller();
  await testSheinDataStoreShopInfoExtractsBrandMerchant();
  await testSheinSilkySpellKeepsProductTitleAndShopName();
  await testSheinElaminiKeepsGoodsNameAndShopCardSeller();
  await testSheinBreadcrumbTitleFallsBackToUrlSlug();
  await testSheinJapaneseProductIntroBeatsBreadcrumbAndShippingTitle();
  await testSheinLabelPrefixedTitleUsesNestedProductNameOnly();
  await testSheinSkuSlugUsesStructuredProductData();
  console.log("cn source panel tests passed");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
