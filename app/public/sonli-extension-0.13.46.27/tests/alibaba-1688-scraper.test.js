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

const scraperPath = path.join(__dirname, "..", "content", "alibaba-1688.js");
const pageDataHookPath = path.join(__dirname, "..", "content", "1688-page-data-hook.js");
const manifestPath = path.join(__dirname, "..", "manifest.json");

async function waitForCapturedAction(captured, action, timeoutMs = 1000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const message = captured.find((m) => m.action === action);
    if (message) return message;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return null;
}

async function with1688Page(fn, options = {}) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const captured = [];
  const consoleMessages = [];
  page.on("console", (msg) => consoleMessages.push(msg.text()));
  page.on("pageerror", (err) => consoleMessages.push(err.message));

  await page.route("https://detail.1688.com/offer/663133463590.html", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: options.html || `
        <!doctype html>
        <html>
          <head>
            <title>多规格测试商品 - 阿里巴巴</title>
            <meta property="og:image" content="https://cbu01.alicdn.com/img/ibank/main-01.jpg_.webp">
            <script>
              window.__INIT_DATA__ = {
                product: {
                  offerId: "663133463590",
                  title: "多规格测试商品",
                  imageList: [
                    "https://cbu01.alicdn.com/img/ibank/main-01.jpg_.webp",
                    "https://cbu01.alicdn.com/img/ibank/main-02.jpg_.webp",
                    "https://cbu01.alicdn.com/img/ibank/detail-01.jpg_.webp",
                    "https://cbu01.alicdn.com/img/ibank/detail-02.jpg_.webp"
                  ],
                  videoUrl: "https://cloud.video.taobao.com/play/u/1/p/1/e/6/t/1/abc.mp4",
                  videoCover: "https://cbu01.alicdn.com/img/ibank/video-cover.jpg_.webp",
                  skuModel: {
                    skuProps: [
                      {
                        prop: "颜色",
                        value: [
                          { name: "红色", imageUrl: "https://cbu01.alicdn.com/img/ibank/red.jpg_.webp" },
                          { name: "蓝色", imageUrl: "https://cbu01.alicdn.com/img/ibank/blue.jpg_.webp" }
                        ]
                      },
                      {
                        prop: "尺码",
                        value: [
                          { name: "S" },
                          { name: "M" },
                          { name: "L" }
                        ]
                      }
                    ],
                    skuMap: {
                      "颜色:红色;尺码:S": { skuId: "sku-red-s", price: "11.10", stock: 2 },
                      "颜色:红色;尺码:M": { skuId: "sku-red-m", price: "12.20", stock: 3 },
                      "颜色:红色;尺码:L": { skuId: "sku-red-l", price: "13.30", stock: 4 },
                      "颜色:蓝色;尺码:S": { skuId: "sku-blue-s", price: "14.40", stock: 5 },
                      "颜色:蓝色;尺码:M": { skuId: "sku-blue-m", price: "15.50", stock: 6 },
                      "颜色:蓝色;尺码:L": { skuId: "sku-blue-l", price: "16.60", stock: 7 }
                    }
                  }
                }
              };
            </script>
          </head>
          <body>
            <div class="title-content">多规格测试商品</div>
            <div class="module-od-main-price">¥ 11.10</div>
            <div class="package-panel">包装重量：350g　包装尺寸：20cm × 10cm × 5cm</div>
            <div class="preview-list">
              <img src="https://cbu01.alicdn.com/img/ibank/main-01.jpg_.webp">
            </div>
            <div class="module-od-sku-selection">
              <div class="feature-item">
                <div class="feature-title">颜色</div>
                <div class="expand-view-list">
                  <div class="expand-view-item"><img src="https://cbu01.alicdn.com/img/ibank/red.jpg_.webp"><span>红色</span></div>
                  <div class="expand-view-item"><img src="https://cbu01.alicdn.com/img/ibank/blue.jpg_.webp"><span>蓝色</span></div>
                </div>
              </div>
              <div class="feature-item">
                <div class="feature-title">尺码</div>
                <div class="expand-view-list">
                  <div class="expand-view-item"><span>S</span></div>
                  <div class="expand-view-item"><span>M</span></div>
                  <div class="expand-view-item"><span>L</span></div>
                </div>
              </div>
            </div>
          </body>
        </html>
      `,
    });
  });

  await page.exposeFunction("__capture1688Message", (message) => {
    captured.push(message);
    return { ok: true, data: { result: { id: "collect-id", action: "created" } } };
  });

  await page.goto("https://detail.1688.com/offer/663133463590.html");
  await page.evaluate(() => {
    window.addEventListener("message", (event) => {
      const data = event.data || {};
      if (data.source !== "jzc-test-1688-capture") return;
      window.__capture1688Message(data.message);
    });
  });
  if (fs.existsSync(pageDataHookPath)) {
    await page.addScriptTag({ path: pageDataHookPath });
  }

  const client = await page.context().newCDPSession(page);
  const { frameTree } = await client.send("Page.getFrameTree");
  const frameId = frameTree.frame.id;
  const { executionContextId } = await client.send("Page.createIsolatedWorld", {
    frameId,
    worldName: "jzc-1688-test-isolated",
    grantUniveralAccess: true,
  });

  await client.send("Runtime.evaluate", {
    contextId: executionContextId,
    expression: `
    window.chrome = {
      runtime: {
        lastError: null,
        sendMessage(message, cb) {
          window.postMessage({ source: "jzc-test-1688-capture", message }, "*");
          cb({ ok: true, data: { result: { id: "collect-id", action: "created" } } });
        },
      },
    };
    `,
  });
  const scraperSource = fs.readFileSync(scraperPath, "utf8");
  await client.send("Runtime.evaluate", {
    contextId: executionContextId,
    expression: `${scraperSource}\n//# sourceURL=alibaba-1688-isolated.js`,
  });
  await page.waitForSelector('[data-action="collect-product"]');

  try {
    await fn(page, captured);
  } finally {
    if (options.debugOnFailure && consoleMessages.length) {
      console.error(consoleMessages.join("\n"));
    }
    await browser.close();
  }
}

async function testStructuredSkuMapIsCollectedAsCombinations() {
  await with1688Page(async (page, captured) => {
    await page.click('[data-action="collect-product"]');
    await page.waitForFunction(() => document.querySelector('[data-action="collect-product"]')?.disabled === false);

    const message = await waitForCapturedAction(captured, "pushSourceCollect");
    assert(message, "expected pushSourceCollect message");
    const raw = message.raw;

    assert.strictEqual(raw.variants.length, 6);
    assert.deepStrictEqual(
      raw.variants.map((v) => v.sku),
      ["sku-red-s", "sku-red-m", "sku-red-l", "sku-blue-s", "sku-blue-m", "sku-blue-l"],
    );
    assert.deepStrictEqual(raw.variants[0].aspectValues, { 颜色: "红色", 尺码: "S" });
    assert.strictEqual(raw.variants[5].price, "16.60");
    assert.strictEqual(raw.variants[5].stock, 7);
    assert.ok(raw.variants[3].image.includes("blue.jpg"));
    assert.deepStrictEqual(raw.packaging, {
      lengthCm: 20,
      widthCm: 10,
      heightCm: 5,
      weightG: 350,
    });

    assert.strictEqual(raw.mainImages.length, 6);
    assert.ok(raw.mainImages.some((url) => url.includes("detail-02.jpg")));
    assert.strictEqual(raw.videoUrl, "https://cloud.video.taobao.com/play/u/1/p/1/e/6/t/1/abc.mp4");
    assert.ok(raw.videoCover.includes("video-cover.jpg"));
  });
}

async function testIndustrySkuTableIsCollectedAsRows() {
  await with1688Page(async (page, captured) => {
    await page.click('[data-action="collect-product"]');
    await page.waitForFunction(() => document.querySelector('[data-action="collect-product"]')?.disabled === false);

    const message = await waitForCapturedAction(captured, "pushSourceCollect");
    assert(message, `expected pushSourceCollect message, got ${JSON.stringify(captured)}`);
    const raw = message.raw;

    assert.strictEqual(raw.variants.length, 4, "industry table rows should be collected as separate variants");
    assert.deepStrictEqual(
      raw.variants.map((v) => v.name),
      ["摘果剪红色", "摘果剪-橙色", "摘果剪-绿色", "摘果剪-红色塑料"],
    );
    assert.deepStrictEqual(
      raw.variants.map((v) => v.price),
      ["5.20", "5.20", "4.20", "4.20"],
    );
    assert.deepStrictEqual(
      raw.variants.map((v) => v.stock),
      [999440, 99895, 99989, 99569],
    );
    assert.ok(raw.variants[0].image.includes("row-red.jpg"));
    assert.ok(raw.variants[2].image.includes("row-green.jpg"));
    assert.strictEqual(raw.variants[0].aspectValues["产品规格"], "摘果剪红色");
    assert.strictEqual(raw.variants[0].aspectValues["刀头材质"], "3CR13不锈钢");
    assert.strictEqual(raw.variants[0].aspectValues["最大长度(m)"], "20");
  }, {
    html: `
      <!doctype html>
      <html>
        <head>
          <title>强力摘果剪园林省力修枝剪 - 阿里巴巴</title>
          <meta property="og:image" content="https://cbu01.alicdn.com/img/ibank/main-pruning.jpg_.webp">
        </head>
        <body>
          <div class="title-content">强力摘果剪园林省力修枝剪多功能便捷树枝剪不锈钢家用花艺专用剪</div>
          <div class="module-od-main-price">¥ 4.20</div>
          <div class="module-od-industry-pro-sku-selection">
            <div class="ant-table">
              <table>
                <thead class="ant-table-thead">
                  <tr>
                    <th>产品规格</th>
                    <th>刀头材质</th>
                    <th>最大长度(m)</th>
                    <th>价格 | 库存(把)</th>
                    <th>进货数量</th>
                  </tr>
                </thead>
                <tbody class="ant-table-tbody">
                  <tr class="ant-table-row" data-row-key="row-red">
                    <td><div class="gyp-pro-table-title"><img src="https://cbu01.alicdn.com/img/ibank/row-red.jpg_sum.jpg"><span>摘果剪红色</span></div></td>
                    <td>3CR13不锈钢</td>
                    <td>20</td>
                    <td><div class="gyp-pro-table-price"><span>¥5.2</span><span>999440</span></div></td>
                    <td></td>
                  </tr>
                  <tr class="ant-table-row" data-row-key="row-orange">
                    <td><div class="gyp-pro-table-title"><img src="https://cbu01.alicdn.com/img/ibank/row-orange.jpg_sum.jpg"><span>摘果剪-橙色</span></div></td>
                    <td>3CR13不锈钢</td>
                    <td>20</td>
                    <td><div class="gyp-pro-table-price"><span>¥5.2</span><span>99895</span></div></td>
                    <td></td>
                  </tr>
                  <tr class="ant-table-row" data-row-key="row-green">
                    <td><div class="gyp-pro-table-title"><img src="https://cbu01.alicdn.com/img/ibank/row-green.jpg_sum.jpg"><span>摘果剪-绿色</span></div></td>
                    <td>3CR13不锈钢</td>
                    <td>19</td>
                    <td><div class="gyp-pro-table-price"><span>¥4.2</span><span>99989</span></div></td>
                    <td></td>
                  </tr>
                  <tr class="ant-table-row" data-row-key="row-red-plastic">
                    <td><div class="gyp-pro-table-title"><img src="https://cbu01.alicdn.com/img/ibank/row-red-plastic.jpg_sum.jpg"><span>摘果剪-红色塑料</span></div></td>
                    <td>3CR13不锈钢</td>
                    <td>19</td>
                    <td><div class="gyp-pro-table-price"><span>¥4.2</span><span>99569</span></div></td>
                    <td></td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </body>
      </html>
    `,
  });
}

async function testIndustrySkuTableIgnoresFilterRowsWithoutRowPrice() {
  await with1688Page(async (page, captured) => {
    await page.click('[data-action="collect-product"]');
    await page.waitForFunction(() => document.querySelector('[data-action="collect-product"]')?.disabled === false);

    const message = await waitForCapturedAction(captured, "pushSourceCollect");
    assert(message, `expected pushSourceCollect message, got ${JSON.stringify(captured)}`);
    const raw = message.raw;

    assert.strictEqual(raw.variants.length, 5, "only explicitly priced purchasable rows should be collected");
    assert.deepStrictEqual(
      raw.variants.map((v) => v.name),
      ["6寸鱼骨牙剪50-55%", "6寸蓝宝石鱼骨牙剪50-55%", "6寸胖胖剪（单刃）", "6寸胖胖剪（双刃）", "7寸徒手"],
    );
    assert.deepStrictEqual(raw.variants.map((v) => v.price), ["23.00", "24.00", "25.00", "25.00", "27.00"]);
    assert.deepStrictEqual(raw.variants.map((v) => v.stock), [994, 996, 999, 999, 984]);
    assert(!raw.variants.some((v) => v.name === "类型" || v.name === "重量"), "filter/header rows must not become variants");
  }, {
    html: `
      <!doctype html>
      <html>
        <head>
          <title>宠物鱼骨剪 - 阿里巴巴</title>
          <meta property="og:image" content="https://cbu01.alicdn.com/img/ibank/main-scissor.jpg_.webp">
        </head>
        <body>
          <div class="title-content">宠物美容剪刀鱼骨剪牙剪专业修毛打薄剪</div>
          <div class="module-od-main-price">¥ 23.00</div>
          <div class="module-od-industry-pro-sku-selection">
            <div class="ant-table">
              <table>
                <thead class="ant-table-thead">
                  <tr>
                    <th>产品规格</th>
                    <th>类型</th>
                    <th>刀刃表面处理</th>
                    <th>价格 | 库存(支)</th>
                    <th>进货数量</th>
                  </tr>
                </thead>
                <tbody class="ant-table-tbody">
                  <tr class="ant-table-row ant-table-measure-row">
                    <td><div class="gyp-pro-table-title"><img src="https://cbu01.alicdn.com/img/ibank/filter.jpg_sum.jpg"><span>类型</span></div></td>
                    <td></td>
                    <td></td>
                    <td></td>
                    <td></td>
                  </tr>
                  <tr class="ant-table-row ant-table-measure-row">
                    <td><div class="gyp-pro-table-title"><img src="https://cbu01.alicdn.com/img/ibank/filter.jpg_sum.jpg"><span>重量</span></div></td>
                    <td></td>
                    <td></td>
                    <td></td>
                    <td></td>
                  </tr>
                  <tr class="ant-table-row" data-row-key="sku-thin-6">
                    <td><div class="gyp-pro-table-title"><img src="https://cbu01.alicdn.com/img/ibank/thin-6.jpg_sum.jpg"><span>6寸鱼骨牙剪50-55%</span></div></td>
                    <td>锯齿鱼骨</td>
                    <td>亮光工艺</td>
                    <td><div class="gyp-pro-table-price"><span>¥23</span><span>994</span></div></td>
                    <td></td>
                  </tr>
                  <tr class="ant-table-row" data-row-key="sku-blue-6">
                    <td><div class="gyp-pro-table-title"><img src="https://cbu01.alicdn.com/img/ibank/blue-6.jpg_sum.jpg"><span>6寸蓝宝石鱼骨牙剪50-55%</span></div></td>
                    <td>锯齿鱼骨</td>
                    <td>亮光工艺</td>
                    <td><div class="gyp-pro-table-price"><span>¥24</span><span>996</span></div></td>
                    <td></td>
                  </tr>
                  <tr class="ant-table-row" data-row-key="sku-fat-single">
                    <td><div class="gyp-pro-table-title"><img src="https://cbu01.alicdn.com/img/ibank/fat-single.jpg_sum.jpg"><span>6寸胖胖剪（单刃）</span></div></td>
                    <td>胖胖剪</td>
                    <td>亮光工艺</td>
                    <td><div class="gyp-pro-table-price"><span>¥25</span><span>999</span></div></td>
                    <td></td>
                  </tr>
                  <tr class="ant-table-row" data-row-key="sku-fat-double">
                    <td><div class="gyp-pro-table-title"><img src="https://cbu01.alicdn.com/img/ibank/fat-double.jpg_sum.jpg"><span>6寸胖胖剪（双刃）</span></div></td>
                    <td>胖胖剪</td>
                    <td>亮光工艺</td>
                    <td><div class="gyp-pro-table-price"><span>¥25</span><span>999</span></div></td>
                    <td></td>
                  </tr>
                  <tr class="ant-table-row" data-row-key="sku-straight-7">
                    <td><div class="gyp-pro-table-title"><img src="https://cbu01.alicdn.com/img/ibank/straight-7.jpg_sum.jpg"><span>7寸徒手</span></div></td>
                    <td>直剪</td>
                    <td>亮光工艺</td>
                    <td><div class="gyp-pro-table-price"><span>¥27</span><span>984</span></div></td>
                    <td></td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </body>
      </html>
    `,
  });
}

async function testSkuFilterButtonsAreCollectedAsDomAxis() {
  await with1688Page(async (page, captured) => {
    await page.click('[data-action="collect-product"]');
    await page.waitForFunction(() => document.querySelector('[data-action="collect-product"]')?.disabled === false);

    const message = await waitForCapturedAction(captured, "pushSourceCollect");
    assert(message, `expected pushSourceCollect message, got ${JSON.stringify(captured)}`);
    const raw = message.raw;

    assert.strictEqual(raw.variants.length, 8, "sku-filter-button color options should expand with the size axis");
    assert.deepStrictEqual(
      raw.variants.map((v) => v.aspectValues["颜色"]),
      ["黑色", "白色", "灰色", "黑色中筒", "白色中筒", "浅灰中筒", "深灰中筒", "藏青中筒"],
    );
    assert(raw.variants.every((v) => v.aspectValues["尺码"] === "均码裸袜"));
    assert.strictEqual(raw.variants[0].name, "黑色 均码裸袜");
    assert.strictEqual(raw.variants[7].name, "藏青中筒 均码裸袜");
    assert.ok(raw.variants[0].image.includes("black.jpg"));
    assert.strictEqual(raw.variants[0].price, "2.80");
  }, {
    html: `
      <!doctype html>
      <html>
        <head>
          <title>男士中筒袜 - 阿里巴巴</title>
          <meta property="og:image" content="https://cbu01.alicdn.com/img/ibank/socks-main.jpg_.webp">
        </head>
        <body>
          <div class="title-content">男士秋冬中筒袜纯色商务袜</div>
          <div class="module-od-main-price">¥ 2.80</div>
          <div class="module-od-sku-selection">
            <div class="feature-item">
              <div class="feature-title">颜色</div>
              <div class="sku-filter-list">
                <div class="sku-filter-button v-flex"><img src="https://cbu01.alicdn.com/img/ibank/black.jpg_.webp"><span>黑色</span></div>
                <div class="sku-filter-button v-flex"><span>白色</span></div>
                <div class="sku-filter-button v-flex"><span>灰色</span></div>
                <div class="sku-filter-button v-flex"><span>黑色中筒</span></div>
                <div class="sku-filter-button v-flex"><span>白色中筒</span></div>
                <div class="sku-filter-button v-flex"><span>浅灰中筒</span></div>
                <div class="sku-filter-button v-flex"><span>深灰中筒</span></div>
                <div class="sku-filter-button v-flex"><span>藏青中筒</span></div>
              </div>
            </div>
            <div class="feature-item">
              <div class="feature-title">尺码</div>
              <div class="expand-view-list">
                <div class="expand-view-item v-flex"><span>均码裸袜</span></div>
              </div>
            </div>
          </div>
        </body>
      </html>
    `,
  });
}

function testManifestInjectsPageDataHookInMainWorld() {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const scripts = manifest.content_scripts || [];
  const hookIndex = scripts.findIndex((entry) => (entry.js || []).includes("content/1688-page-data-hook.js"));
  const scraperIndex = scripts.findIndex((entry) => (entry.js || []).includes("content/alibaba-1688.js"));

  assert(hookIndex >= 0, "expected manifest to inject 1688 page data hook");
  assert(scraperIndex >= 0, "expected manifest to inject 1688 scraper");
  assert.strictEqual(scripts[hookIndex].world, "MAIN");
  assert(hookIndex < scraperIndex, "page data hook should be declared before isolated scraper");
}

(async () => {
  testManifestInjectsPageDataHookInMainWorld();
  await testStructuredSkuMapIsCollectedAsCombinations();
  await testIndustrySkuTableIsCollectedAsRows();
  await testIndustrySkuTableIgnoresFilterRowsWithoutRowPrice();
  await testSkuFilterButtonsAreCollectedAsDomAxis();
  console.log("alibaba-1688 scraper tests passed");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
