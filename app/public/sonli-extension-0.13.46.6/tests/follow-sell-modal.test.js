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

const sharedUtilsPath = path.join(__dirname, "..", "content", "shared-utils.js");
const extensionContentDir = path.join(__dirname, "..", "content");

async function withPage(fn) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  try {
    await page.setContent(`
      <!doctype html>
      <html>
        <head>
          <style>
            body { margin: 0; font-family: Arial, sans-serif; }
            #root { padding: 80px; }
            #anchor { width: 120px; height: 64px; }
          </style>
        </head>
        <body>
          <div id="root">
            <button id="anchor" data-click-action="show-followsell-modal">Follow</button>
          </div>
        </body>
      </html>
    `);
    await page.addScriptTag({ path: sharedUtilsPath });
    await page.evaluate(() => {
      window.formatNumber = (n) => String(n);
      window.jzFetchPublicFollowSell = async () => ({
        count: 2,
        sellers: [
          { name: "Alpha", price: "100 ₽", sku: "111", deliveryText: "Tomorrow", deliveryRank: 1 },
          { name: "Beta", price: "90 ₽", sku: "222", deliveryText: "Today", deliveryRank: 0 },
        ],
      });
    });
    await fn(page);
  } finally {
    await browser.close();
  }
}

async function testSharedModalRendersSellers() {
  await withPage(async (page) => {
    const type = await page.evaluate(() => typeof window.jzShowFollowSellListModal);
    assert.strictEqual(type, "function");

    await page.evaluate(() =>
      window.jzShowFollowSellListModal(
        document.getElementById("anchor"),
        { sku: "3391766685", followSellCount: 2 },
        { trigger: "click" },
      ),
    );

    await page.waitForSelector(".ozon-helper-follow-modal");
    await page.waitForSelector(".oh-seller-row:not(.oh-seller-row-skeleton)");
    const rows = await page.locator(".oh-seller-row:not(.oh-seller-row-skeleton)").count();
    assert.strictEqual(rows, 2);
  });
}

async function testHoverDoesNotOpenSellerModal() {
  await withPage(async (page) => {
    const type = await page.evaluate(() => typeof window.jzBindFollowSellHover);
    assert.strictEqual(type, "function");

    await page.evaluate(() => {
      window.jzBindFollowSellHover(document.getElementById("root"), () => ({
        sku: "3391766685",
        followSellCount: 2,
      }));
    });

    const anchorBox = await page.locator("#anchor").boundingBox();
    assert.ok(anchorBox, "anchor should have a bounding box");
    await page.mouse.move(anchorBox.x + anchorBox.width / 2, anchorBox.y + anchorBox.height / 2);
    await page.waitForTimeout(260);
    assert.strictEqual(await page.locator(".ozon-helper-follow-modal").count(), 0);
  });
}

function testSourceDoesNotBindSellerModalOnHover() {
  const files = [
    "ozon-product.js",
    "ozon-search.js",
    "ozon-data-panel.js",
    "shared-utils.js",
  ];
  const offenders = [];
  for (const file of files) {
    const source = fs.readFileSync(path.join(extensionContentDir, file), "utf8");
    if (source.includes("jzBindFollowSellHover?.(")) {
      offenders.push(`${file}: jzBindFollowSellHover callsite`);
    }
    if (source.includes("悬浮或点击") || source.includes("\\u60ac\\u6d6e\\u6216\\u70b9\\u51fb")) {
      offenders.push(`${file}: hover-or-click tooltip`);
    }
  }
  assert.deepStrictEqual(offenders, []);
}

(async () => {
  testSourceDoesNotBindSellerModalOnHover();
  await testSharedModalRendersSellers();
  await testHoverDoesNotOpenSellerModal();
  console.log("follow-sell modal tests passed");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
