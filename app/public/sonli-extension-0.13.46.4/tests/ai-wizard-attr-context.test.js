const assert = require("assert");
const path = require("path");

function loadPlaywright() {
  try {
    return require("playwright");
  } catch {}

  return require(path.join(__dirname, "..", "..", "backend", "node_modules", "playwright"));
}

const { chromium } = loadPlaywright();
const wizardPath = path.join(__dirname, "..", "content", "1688-ai-wizard.js");

async function waitUntil(predicate, message, timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(message);
}

function socksRaw() {
  return {
    offerId: "sock-offer",
    title: "诸暨袜子批发男士春夏款中筒袜吸汗透气商务中筒男袜纯色防臭",
    price: "0.59",
    mainImages: ["https://example.test/socks.jpg"],
    specs: { 颜色: "黑色中筒", 尺码: "均码裸袜" },
    skuList: [
      { sku: "sock-one", name: "均码裸袜", price: "0.59", image: "https://example.test/socks-variant.jpg" },
    ],
  };
}

async function withWizardPage(fn) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const messages = [];

  await page.goto("about:blank");
  await page.exposeFunction("__jzcAiWizardMessage", async (message) => {
    messages.push(message);

    if (message.action === "getStores") {
      return { ok: true, data: [{ id: "store-a", label: "baibai", companyCurrency: "CNY" }] };
    }
    if (message.action === "getAuth") return { ok: true, data: { storeId: "store-a" } };
    if (message.action === "getWarehouses") {
      return { ok: true, data: { data: { warehouses: [{ warehouse_id: 101, name: "cel" }] } } };
    }
    if (message.action === "getCategoryTree") {
      return {
        ok: true,
        data: {
          result: [
            {
              title: "服装",
              description_category_id: 9001,
              children: [{ title: "内衣", children: [{ title: "袜子", type_id: 701 }] }],
            },
          ],
        },
      };
    }
    if (message.action === "suggestCategory") {
      return {
        ok: true,
        data: {
          selected: {
            typeId: 701,
            descCatId: 9001,
            path: "服装 / 内衣 / 袜子",
            confidence: 0.9,
          },
          candidates: [],
          visualTags: ["袜子", "socks"],
          visualConfidence: 0.92,
        },
      };
    }
    if (message.action === "verifyCategory") return { ok: true, data: { ok: true } };
    if (message.action === "getCategoryAttributes") {
      return {
        ok: true,
        data: [{ id: 85, name: "Material", type: "String", is_required: true, dictionary_id: 0 }],
      };
    }
    if (message.action === "getFxRate") return { ok: true, data: { rate: 12 } };
    if (message.action === "getAiQuota") return { ok: true, data: {} };
    if (message.action === "pushSourceCollect") {
      return { ok: true, data: { result: { id: "collect-1" } } };
    }
    if (message.action === "aiOptimizeForRating") {
      if ((message.body.modules || []).includes("title")) {
        return {
          ok: true,
          data: {
            modules: {
              title: { value: "Rewritten socks title" },
              description: { value: "Rewritten socks description" },
              hashtags: { value: ["#socks"] },
            },
            errors: [],
          },
        };
      }
      return { ok: true, data: { modules: { attrs: { filled: [], skipped: [] } }, errors: [] } };
    }
    if (message.action === "followSell") return { ok: true, data: { result: { task_id: "task-1" } } };
    return { ok: true, data: {} };
  });

  await page.evaluate(() => {
    window.chrome = {
      runtime: {
        lastError: null,
        sendMessage(message, cb) {
          window.__jzcAiWizardMessage(message).then((resp) => cb(resp));
        },
      },
    };
  });

  await page.addScriptTag({ path: wizardPath });
  await page.evaluate((raw) => window.__JZC_OPEN_AI_WIZARD__(raw), socksRaw());

  try {
    await fn(page, messages);
  } finally {
    await browser.close();
  }
}

function assertAttrContext(message, scope) {
  const raw = socksRaw();
  assert(message, `${scope} fill request should exist`);
  assert.strictEqual(message.body.title, raw.title, `${scope} should send the full source product title`);
  assert.notStrictEqual(message.body.title, "均码裸袜", `${scope} must not replace title with short SKU name`);
  assert(
    message.body.description.includes("SKU名称：均码裸袜"),
    `${scope} should keep the selected SKU as additional attribute context`,
  );
}

async function testRequiredButtonSendsFullTitleAndSkuContext() {
  await withWizardPage(async (page, messages) => {
    await page.waitForSelector("#aiw-fill-attrs");
    await page.click("#aiw-fill-attrs");

    await waitUntil(
      () => messages.some((m) => m.action === "aiOptimizeForRating" && m.body.attrScope === "required"),
      "required attrs button did not request AI fill",
    );

    assertAttrContext(
      messages.find((m) => m.action === "aiOptimizeForRating" && m.body.attrScope === "required"),
      "required",
    );
  });
}

async function testLaunchSendsSameFullTitleAndSkuContext() {
  await withWizardPage(async (page, messages) => {
    await page.waitForSelector("#aiw-launch");
    await page.click("#aiw-launch");

    await waitUntil(
      () => messages.some((m) => m.action === "aiOptimizeForRating" && m.body.attrScope === "required-and-rating"),
      "launch did not request required-and-rating AI fill",
    );

    assertAttrContext(
      messages.find((m) => m.action === "aiOptimizeForRating" && m.body.attrScope === "required-and-rating"),
      "launch",
    );
  });
}

(async () => {
  await testRequiredButtonSendsFullTitleAndSkuContext();
  await testLaunchSendsSameFullTitleAndSkuContext();
  console.log("ai wizard attr context tests passed");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
