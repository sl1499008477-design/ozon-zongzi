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
const wizardPath = path.join(__dirname, "..", "content", "1688-ai-wizard.js");

async function waitUntil(predicate, message, timeoutMs = 3000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(message);
}

function defaultRaw() {
  return {
    offerId: "agent1-1688-offer",
    title: "多功能家用剪刀省力舒适手柄不锈钢剪刀",
    price: "10",
    mainImages: ["https://example.test/scissors.jpg"],
    specs: { 用途: "家用", 材质: "不锈钢" },
  };
}

function defaultCategoryTree() {
  return [
    {
      title: "住宅和花园",
      description_category_id: 9001,
      children: [
        {
          title: "厨房用品",
          children: [{ title: "厨房剪刀", type_id: 701 }],
        },
      ],
    },
  ];
}

async function withWizardPage(fn, options = {}) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const messages = [];

  await page.goto("about:blank");
  await page.exposeFunction("__jzcAiWizardMessage", async (message) => {
    messages.push(message);

    if (message.action === "getStores") {
      return {
        ok: true,
        data: [{ id: "store-a", label: "baibai", companyCurrency: "CNY" }],
      };
    }

    if (message.action === "getAuth") {
      return { ok: true, data: { storeId: "store-a" } };
    }

    if (message.action === "getWarehouses") {
      return { ok: true, data: { data: { warehouses: [{ warehouse_id: 101, name: "cel" }] } } };
    }

    if (message.action === "getCategoryTree") {
      return { ok: true, data: { result: options.categoryTree || defaultCategoryTree() } };
    }

    if (message.action === "suggestCategory") {
      return {
        ok: true,
        data: {
          selected: {
            typeId: 701,
            descCatId: 9001,
            path: "住宅和花园 / 厨房用品 / 厨房剪刀",
            confidence: 0.9,
          },
          candidates: [],
          visualTags: ["剪刀", "不锈钢"],
          visualConfidence: 0.92,
        },
      };
    }

    if (message.action === "verifyCategory") {
      return { ok: true, data: { ok: true } };
    }

    if (message.action === "getCategoryAttributes") {
      return { ok: true, data: options.attributesResponse || [] };
    }

    if (message.action === "getFxRate") {
      return { ok: true, data: { rate: 12 } };
    }

    if (message.action === "getAiQuota") {
      return { ok: true, data: {} };
    }

    if (message.action === "pushSourceCollect") {
      return { ok: true, data: { result: { id: "collect-1" } } };
    }

    if (message.action === "aiOptimizeForRating") {
      if (typeof options.aiOptimizeForRating === "function") {
        return options.aiOptimizeForRating(message);
      }
      return { ok: true, data: { modules: { attrs: { filled: [], skipped: [] } }, errors: [] } };
    }

    if (message.action === "followSell") {
      return { ok: true, data: { result: { task_id: "task-agent1" } } };
    }

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
  await page.evaluate((raw) => window.__JZC_OPEN_AI_WIZARD__(raw), options.raw || defaultRaw());

  try {
    await fn(page, messages);
  } finally {
    await browser.close();
  }
}

async function testRatingButtonIsRatingOnlyAndKeepsRequiredAttrsUntouched() {
  await withWizardPage(async (page, messages) => {
    await page.waitForSelector("#aiw-fill-rating");
    await page.click("#aiw-fill-rating");

    await waitUntil(
      () => messages.some((m) => m.action === "aiOptimizeForRating" && m.body.attrScope === "rating"),
      "rating button did not send attrScope=rating",
    );

    await page.waitForSelector(".aiw-rating-val");
    const requiredValue = await page.$eval(".aiw-attr-val", (input) => input.value);
    const ratingValue = await page.$eval(".aiw-rating-val", (input) => input.value);
    const logText = await page.$eval("#aiw-log", (node) => node.textContent || "");

    assert.strictEqual(requiredValue, "", "rating-only response must not mutate required attrs");
    assert.strictEqual(ratingValue, "Summer");
    assert(logText.includes("AI 填充内容评级属性"), "rating button should show a shared AI output log");
  }, {
    attributesResponse: [
      { id: 85, name: "Brand", type: "String", is_required: true, dictionary_id: 0 },
      { id: 999, name: "Season", type: "String", is_required: false, dictionary_id: 0 },
    ],
    aiOptimizeForRating() {
      return {
        ok: true,
        data: {
          modules: {
            attrs: {
              filled: [
                { id: 85, name: "Brand", source: "text", status: "filled", resolvedDictValue: "Wrong Brand" },
                { id: 999, name: "Season", source: "text", status: "filled", resolvedDictValue: "Summer" },
              ],
              skipped: [],
            },
          },
          errors: [],
        },
      };
    },
  });
}

async function testRequiredButtonKeepsOptionalAttrsOutOfRequiredModule() {
  await withWizardPage(async (page, messages) => {
    await page.waitForSelector("#aiw-fill-attrs");
    await page.click("#aiw-fill-attrs");

    await waitUntil(
      () => messages.some((m) => m.action === "aiOptimizeForRating" && m.body.attrScope === "required"),
      "required attrs button did not request attrScope=required",
    );

    const requiredRows = await page.$$eval(".aiw-attr-val", (inputs) => inputs.map((input) => input.value));
    const ratingRows = await page.$$eval(".aiw-rating-val", (inputs) => inputs.map((input) => input.value));
    const requiredText = await page.$eval(".aiw-card", (node) => node.textContent || "");

    assert.strictEqual(requiredRows.length, 1, "button2 must show only schema-required attrs");
    assert.strictEqual(requiredRows[0], "Required value");
    assert.deepStrictEqual(ratingRows, [], "button2 must not surface optional/rating attrs");
    assert(!requiredText.includes("Optional One"), "optional attrs must not be rendered in the required module");
  }, {
    attributesResponse: [
      { id: 85, name: "Required One", type: "String", is_required: true, dictionary_id: 0 },
      { id: 999, name: "Optional One", type: "String", is_required: "false", dictionary_id: 0 },
    ],
    aiOptimizeForRating() {
      return {
        ok: true,
        data: {
          modules: {
            attrs: {
              filled: [
                { id: 85, name: "Required One", source: "text", status: "filled", resolvedDictValue: "Required value" },
                { id: 999, name: "Optional One", source: "text", status: "filled", resolvedDictValue: "Optional value" },
              ],
              skipped: [],
            },
          },
          errors: [],
        },
      };
    },
  });
}

async function testRewriteOnlyAndPublishOnlyAreIndependentFromFullPipeline() {
  await withWizardPage(async (page, messages) => {
    await page.waitForSelector("#aiw-rewrite-only");
    await page.fill(".aiw-attr-val", "Manual Material");
    await page.click("#aiw-rewrite-only");

    await page.waitForSelector("#aiw-content-preview");
    await waitUntil(
      () => (messages.filter((m) => m.action === "aiOptimizeForRating" && (m.body.modules || []).includes("title")).length >= 1),
      "rewrite-only button did not call title/description/hashtags module",
    );

    const preview = await page.$eval("#aiw-content-preview", (node) => node.textContent || "");
    assert(preview.includes("Rewritten scissors title"), "rewrite preview should show generated title");

    await page.click("#aiw-publish-only");
    await waitUntil(
      () => messages.some((m) => m.action === "followSell"),
      "publish-only button did not submit followSell",
    );

    assert(!messages.some((m) => m.action === "pushSourceCollect"), "publish-only must not run collect-box stage");
    const followSell = messages.find((m) => m.action === "followSell");
    assert.strictEqual(followSell.items[0].name, "Rewritten scissors title");
    assert.deepStrictEqual(followSell.items[0].attributes, [
      {
        complex_id: 0,
        id: 85,
        values: [{ dictionary_value_id: 0, value: "Manual Material" }],
      },
    ]);
  }, {
    attributesResponse: [
      { id: 85, name: "Material", type: "String", is_required: true, dictionary_id: 0 },
    ],
    aiOptimizeForRating(message) {
      if ((message.body.modules || []).includes("title")) {
        return {
          ok: true,
          data: {
            modules: {
              title: { value: "Rewritten scissors title" },
              description: { value: "Rewritten scissors description" },
              hashtags: { value: ["#scissors", "#kitchen"] },
            },
            errors: [],
          },
        };
      }
      return { ok: true, data: { modules: { attrs: { filled: [], skipped: [] } }, errors: [] } };
    },
  });
}

async function testNoBrandDictMissKeepsManualSuggestionWithoutTechnicalCopy() {
  await withWizardPage(async (page) => {
    await page.waitForSelector("#aiw-fill-attrs");
    await page.click("#aiw-fill-attrs");

    await page.waitForSelector(".aiw-manual-hint");
    const hint = await page.$eval(".aiw-manual-hint", (node) => node.textContent || "");

    assert(hint.includes("需手动确认：AI 建议「无品牌」"), "no-brand hint should keep the manual AI suggestion");
    assert(!hint.includes("no_brand_dict_value_not_found"), "manual hint should hide no-brand backend reason");
    assert(!hint.includes("未匹配到 Ozon 字典值"), "manual hint should hide noisy dict warning");
  }, {
    attributesResponse: [
      { id: 85, name: "Brand", type: "String", is_required: true, dictionary_id: 123 },
    ],
    aiOptimizeForRating() {
      return {
        ok: true,
        data: {
          modules: {
            attrs: {
              filled: [
                {
                  id: 85,
                  name: "Brand",
                  source: "dict-match",
                  status: "needs_manual",
                  reason: "no_brand_dict_value_not_found",
                  suggestedLabel: "无品牌",
                  resolvedDictValueId: null,
                  resolvedDictValue: null,
                },
              ],
              skipped: [],
            },
          },
          errors: [],
        },
      };
    },
  });
}

async function testNoBrandRequiredAttrDoesNotBlockPublish() {
  await withWizardPage(async (page, messages) => {
    await page.waitForSelector("#aiw-fill-attrs");
    await page.click("#aiw-fill-attrs");
    await page.waitForSelector(".aiw-manual-hint");

    await page.click("#aiw-publish-only");
    await waitUntil(
      () => messages.some((m) => m.action === "followSell"),
      "no-brand required attr should not block publish",
      5000,
    );

    const followSell = messages.find((m) => m.action === "followSell");
    assert.strictEqual(followSell.items[0].scraped_brand, "no_brand");
    const brandAttr = followSell.items[0].attributes.find((attr) => attr.id === 85);
    assert(brandAttr, "no-brand required attr should be sent as a backend-normalizable placeholder");
    assert.deepStrictEqual(brandAttr.values, [
      { dictionary_value_id: 0, value: "无品牌" },
    ]);
  }, {
    attributesResponse: [
      { id: 85, name: "Brand", type: "String", is_required: true, dictionary_id: 123 },
    ],
    aiOptimizeForRating(message) {
      if ((message.body.modules || []).includes("title")) {
        return { ok: true, data: { modules: {}, errors: [] } };
      }
      return {
        ok: true,
        data: {
          modules: {
            attrs: {
              filled: [
                {
                  id: 85,
                  name: "Brand",
                  source: "dict-match",
                  status: "needs_manual",
                  reason: "dict_lookup_timeout",
                  suggestedLabel: "无品牌",
                  resolvedDictValueId: null,
                  resolvedDictValue: null,
                },
              ],
              skipped: [],
            },
          },
          errors: [],
        },
      };
    },
  });
}

async function testManualDictionaryAttrSubmitsAsBackendPlaceholder() {
  await withWizardPage(async (page, messages) => {
    await page.waitForSelector(".aiw-attr-val");
    await page.fill(".aiw-attr-val", "ManualBrand");

    await page.click("#aiw-publish-only");
    await waitUntil(
      () => messages.some((m) => m.action === "followSell"),
      "manual dictionary attr should unblock publish",
      5000,
    );

    const followSell = messages.find((m) => m.action === "followSell");
    const brandAttr = followSell.items[0].attributes.find((attr) => attr.id === 85);
    assert(brandAttr, "manual dictionary attr should be included in import attributes");
    assert.deepStrictEqual(brandAttr.values, [
      { dictionary_value_id: 0, value: "ManualBrand" },
    ]);
  }, {
    attributesResponse: [
      { id: 85, name: "Brand", type: "String", is_required: true, dictionary_id: 123 },
    ],
  });
}

async function testAiSuggestedManualDictionaryAttrCanPublishAsPlaceholder() {
  await withWizardPage(async (page, messages) => {
    await page.waitForSelector("#aiw-fill-attrs");
    await page.click("#aiw-fill-attrs");
    await page.waitForSelector(".aiw-manual-hint");

    await page.click("#aiw-publish-only");
    await waitUntil(
      () => messages.some((m) => m.action === "followSell"),
      "AI suggested manual dictionary attr should unblock publish-only submit",
      5000,
    );

    const followSell = messages.find((m) => m.action === "followSell");
    const originAttr = followSell.items[0].attributes.find((attr) => attr.id === 4389);
    assert(originAttr, "AI suggested manual dictionary attr should be included in import attributes");
    assert.deepStrictEqual(originAttr.values, [
      { dictionary_value_id: 0, value: "Китай" },
    ]);
  }, {
    attributesResponse: [
      { id: 4389, name: "原产国", type: "String", is_required: true, dictionary_id: 321 },
    ],
    aiOptimizeForRating() {
      return {
        ok: true,
        data: {
          modules: {
            attrs: {
              filled: [
                {
                  id: 4389,
                  name: "原产国",
                  source: "dict-match",
                  status: "needs_manual",
                  reason: "dict_value_not_found",
                  suggestedLabel: "Китай",
                  resolvedDictValueId: null,
                  resolvedDictValue: null,
                },
              ],
              skipped: [],
            },
          },
          errors: [],
        },
      };
    },
  });
}

async function testLaunchStopsForNonBrandManualSuggestionBeforeDirectSubmit() {
  await withWizardPage(async (page, messages) => {
    await page.waitForSelector("#aiw-launch");
    await page.click("#aiw-launch");

    await page.waitForFunction(() =>
      (document.querySelector("#aiw-log")?.textContent || "").includes("请确认必填属性，确认无误请单击提交"),
    );

    assert(
      !messages.some((m) => m.action === "followSell"),
      "launch should not auto-submit when non-brand required attrs still need human confirmation",
    );
  }, {
    attributesResponse: [
      { id: 4389, name: "原产国", type: "String", is_required: true, dictionary_id: 321 },
    ],
    aiOptimizeForRating(message) {
      if ((message.body.modules || []).includes("title")) {
        return {
          ok: true,
          data: {
            modules: {
              title: { value: "Launch manual-confirm title" },
              description: { value: "Launch manual-confirm description" },
              hashtags: { value: ["#manual_confirm"] },
            },
            errors: [],
          },
        };
      }
      return {
        ok: true,
        data: {
          modules: {
            attrs: {
              filled: [
                {
                  id: 4389,
                  name: "原产国",
                  source: "dict-match",
                  status: "needs_manual",
                  reason: "dict_value_not_found",
                  suggestedLabel: "Китай",
                  resolvedDictValueId: null,
                  resolvedDictValue: null,
                },
              ],
              skipped: [],
            },
          },
          errors: [],
        },
      };
    },
  });
}

async function testLaunchAutoSubmitsWhenOnlyNoBrandNeedsManual() {
  await withWizardPage(async (page, messages) => {
    await page.waitForSelector("#aiw-launch");
    await page.click("#aiw-launch");

    await waitUntil(
      () => messages.some((m) => m.action === "followSell"),
      "launch should submit when the only manual required attr is no-brand",
      5000,
    );

    const followSell = messages.find((m) => m.action === "followSell");
    const brandAttr = followSell.items[0].attributes.find((attr) => attr.id === 85);
    assert(brandAttr, "no-brand should still be included as a backend-normalizable placeholder");
    assert.deepStrictEqual(brandAttr.values, [
      { dictionary_value_id: 0, value: "无品牌" },
    ]);
  }, {
    attributesResponse: [
      { id: 85, name: "Brand", type: "String", is_required: true, dictionary_id: 123 },
    ],
    aiOptimizeForRating(message) {
      if ((message.body.modules || []).includes("title")) {
        return {
          ok: true,
          data: {
            modules: {
              title: { value: "Launch no-brand title" },
              description: { value: "Launch no-brand description" },
              hashtags: { value: ["#no_brand"] },
            },
            errors: [],
          },
        };
      }
      return {
        ok: true,
        data: {
          modules: {
            attrs: {
              filled: [
                {
                  id: 85,
                  name: "Brand",
                  source: "dict-match",
                  status: "needs_manual",
                  reason: "no_brand_dict_value_not_found",
                  suggestedLabel: "无品牌",
                  resolvedDictValueId: null,
                  resolvedDictValue: null,
                },
              ],
              skipped: [],
            },
          },
          errors: [],
        },
      };
    },
  });
}

async function testSkuListRendersAndPublishesGroupedVariantRows() {
  await withWizardPage(async (page, messages) => {
    await page.waitForSelector("#aiw-rows tr");
    const rows = await page.$$eval("#aiw-rows tr", (nodes) => nodes.map((node) => node.textContent || ""));

    assert.strictEqual(rows.length, 2, "skuList should render as separate wizard rows");
    assert(rows[0].includes("Blue Variant"), "first row should show first variant name");
    assert(rows[1].includes("Purple Variant"), "second row should show second variant name");

    await page.click("#aiw-publish-only");
    await waitUntil(
      () => messages.some((m) => m.action === "followSell"),
      "variant rows should publish",
      5000,
    );

    const followSell = messages.find((m) => m.action === "followSell");
    assert.strictEqual(followSell.items.length, 2, "selected variant rows should submit as Ozon variant items");
    assert.notStrictEqual(followSell.items[0].offer_id, followSell.items[1].offer_id);
    assert.strictEqual(followSell.items[0].scraped_model_name, "AIW-variant-offer");
    assert.strictEqual(followSell.items[1].scraped_model_name, "AIW-variant-offer");
    const modelValues = followSell.items.map((item) => {
      const attr = item.attributes.find((a) => Number(a.id) === 9048);
      return attr?.values?.[0]?.value;
    });
    assert.deepStrictEqual(modelValues, ["AIW-variant-offer", "AIW-variant-offer"]);
    assert(!followSell.items[0].name.includes("Blue Variant"), "card-level name should not include first variant label");
    assert(!followSell.items[1].name.includes("Purple Variant"), "card-level name should not include second variant label");
    assert(followSell.items[0].images[0].includes("blue.jpg"));
    assert(followSell.items[1].images[0].includes("purple.jpg"));
  }, {
    raw: {
      offerId: "variant-offer",
      title: "Grouped variant card",
      price: "1.6",
      mainImages: ["https://example.test/main.jpg"],
      specs: { material: "glass" },
      skuList: [
        { sku: "blue-cup", name: "Blue Variant", price: "1.60", image: "https://example.test/blue.jpg" },
        { sku: "purple-cup", name: "Purple Variant", price: "1.70", image: "https://example.test/purple.jpg" },
      ],
    },
    attributesResponse: [],
  });
}

async function testBatchPriceSupportsSetAddAndMultiplyModes() {
  await withWizardPage(async (page) => {
    await page.waitForSelector("#aiw-rows tr");

    await page.click("#aiw-batch-price");
    await page.waitForSelector("#aiw-batch-price-dialog");
    await page.selectOption("#aiw-batch-mode", "add");
    await page.fill("#aiw-batch-value", "2.50");
    await page.click("#aiw-batch-apply");
    await page.waitForFunction(() =>
      Array.from(document.querySelectorAll(".aiw-price")).map((input) => input.value).join(",") === "12.50,22.50",
    );

    await page.click("#aiw-batch-price");
    await page.waitForSelector("#aiw-batch-price-dialog");
    await page.selectOption("#aiw-batch-mode", "multiply");
    await page.fill("#aiw-batch-value", "2");
    await page.click("#aiw-batch-apply");
    await page.waitForFunction(() =>
      Array.from(document.querySelectorAll(".aiw-price")).map((input) => input.value).join(",") === "25.00,45.00",
    );

    await page.click("#aiw-batch-price");
    await page.waitForSelector("#aiw-batch-price-dialog");
    await page.selectOption("#aiw-batch-mode", "set");
    await page.fill("#aiw-batch-value", "9.99");
    await page.click("#aiw-batch-apply");

    const prices = await page.$$eval(".aiw-price", (inputs) => inputs.map((input) => input.value));
    assert.deepStrictEqual(prices, ["9.99", "9.99"]);
  }, {
    raw: {
      offerId: "batch-price-offer",
      title: "批量价格测试商品",
      price: "10",
      mainImages: ["https://example.test/main.jpg"],
      skuList: [
        { sku: "sku-a", name: "Variant A", price: "10.00", image: "https://example.test/a.jpg" },
        { sku: "sku-b", name: "Variant B", price: "20.00", image: "https://example.test/b.jpg" },
      ],
    },
    attributesResponse: [],
  });
}

async function testPackageFieldsRenderAndSubmitTopLevelDimensions() {
  await withWizardPage(async (page, messages) => {
    await page.waitForSelector("#aiw-publish-only");
    assert.strictEqual(await page.locator("#aiw-package-weight").count(), 0, "package weight should not be a foreground workflow field");
    assert.strictEqual(await page.locator("#aiw-package-length").count(), 0, "package dimensions should not be foreground workflow fields");

    await page.click("#aiw-publish-only");
    await waitUntil(
      () => messages.some((m) => m.action === "followSell"),
      "package fields should submit",
      5000,
    );

    const item = messages.find((m) => m.action === "followSell").items[0];
    assert.strictEqual(item.weight, 350);
    assert.strictEqual(item.depth, 120);
    assert.strictEqual(item.width, 80);
    assert.strictEqual(item.height, 30);
  }, {
    raw: {
      offerId: "package-offer",
      title: "包装字段测试商品",
      price: "10",
      mainImages: ["https://example.test/package.jpg"],
      specs: { 材质: "塑料" },
      packaging: { weightG: 350, lengthCm: 12, widthCm: 8, heightCm: 3 },
    },
    attributesResponse: [],
  });
}

async function testManualWarningHidesTechnicalReasonCodes() {
  await withWizardPage(async (page) => {
    await page.waitForSelector("#aiw-fill-attrs");
    await page.click("#aiw-fill-attrs");

    await page.waitForSelector(".aiw-manual-hint");
    const hint = await page.$eval(".aiw-manual-hint", (node) => node.textContent || "");
    const pageText = await page.$eval("body", (node) => node.textContent || "");

    assert(hint.includes("需手动确认：AI 建议「No brand」"), "manual warning should keep the AI suggestion");
    assert(!hint.includes("dict_lookup_timeout"), "manual warning should hide lookup timeout reason");
    assert(!hint.includes("未匹配到 Ozon 字典值"), "manual warning should hide Ozon dictionary internals");
    assert(!pageText.includes("Ozon 字典值"), "wizard copy should not expose Ozon dictionary internals");
  }, {
    attributesResponse: [
      { id: 85, name: "Brand", type: "String", is_required: true, dictionary_id: 123 },
    ],
    aiOptimizeForRating() {
      return {
        ok: true,
        data: {
          modules: {
            attrs: {
              filled: [
                {
                  id: 85,
                  name: "Brand",
                  source: "dict-match",
                  status: "needs_manual",
                  reason: "dict_lookup_timeout",
                  suggestedLabel: "No brand",
                  resolvedDictValueId: null,
                  resolvedDictValue: null,
                },
              ],
              skipped: [],
            },
          },
          errors: [],
        },
      };
    },
  });
}

async function testRatingEmptyStateHidesCombinedRequiredCopy() {
  await withWizardPage(async (page) => {
    await page.waitForSelector("#aiw-fill-rating");

    const text = await page.$eval("#aiw-fill-rating", (button) => button.closest(".aiw-card").textContent || "");

    assert(text.includes("AI 填充内容评级属性"), "rating module should still explain the rating action");
    assert(!text.includes("与必填属性一次填完"), "rating empty state should not mention required attrs");
  }, {
    attributesResponse: [],
  });
}

async function testRatingButtonMergesReturnedRowsWithExistingValues() {
  let calls = 0;
  await withWizardPage(async (page) => {
    await page.waitForSelector("#aiw-fill-rating");
    await page.click("#aiw-fill-rating");
    await page.waitForSelector(".aiw-rating-val");

    await page.fill(".aiw-rating-val", "Manual Season");
    await page.click("#aiw-fill-rating");
    await page.waitForFunction(() => {
      const values = Array.from(document.querySelectorAll(".aiw-rating-val")).map((input) => input.value);
      return values.includes("Winter");
    });

    const values = await page.$$eval(".aiw-rating-val", (inputs) => inputs.map((input) => input.value));
    assert(values.includes("Manual Season"), "existing user-filled rating value should survive a later rating fill");
    assert(values.includes("Winter"), "newly returned rating value should be appended");
  }, {
    attributesResponse: [
      { id: 999, name: "Season", type: "String", is_required: false, dictionary_id: 0 },
      { id: 1000, name: "Style", type: "String", is_required: false, dictionary_id: 0 },
    ],
    aiOptimizeForRating() {
      calls++;
      const row = calls === 1
        ? { id: 999, name: "Season", source: "text", status: "filled", resolvedDictValue: "Summer" }
        : { id: 1000, name: "Style", source: "text", status: "filled", resolvedDictValue: "Winter" };
      return {
        ok: true,
        data: { modules: { attrs: { filled: [row], skipped: [] } }, errors: [] },
      };
    },
  });
}

async function testLaunchFillsMissingRequiredAttrsAfterRatingOnlyWasUsed() {
  await withWizardPage(async (page, messages) => {
    await page.waitForSelector("#aiw-fill-rating");
    await page.click("#aiw-fill-rating");

    await waitUntil(
      () => messages.some((m) => m.action === "aiOptimizeForRating" && m.body.attrScope === "rating"),
      "rating-only fill did not run before launch",
    );
    await page.waitForSelector(".aiw-rating-val");

    await page.click("#aiw-launch");
    await waitUntil(
      () => messages.some((m) => m.action === "aiOptimizeForRating" && m.body.attrScope === "required-and-rating"),
      "launch should fill missing required attrs even when rating attrs already exist",
      5000,
    );
    await waitUntil(
      () => messages.some((m) => m.action === "followSell"),
      "launch should submit after missing required attrs are filled",
      5000,
    );

    const followSell = messages.find((m) => m.action === "followSell");
    assert(
      followSell.items[0].attributes.some((attr) => attr.id === 85 && attr.values[0].value === "Manual-safe Brand"),
      "launch should submit the required attr filled during required-and-rating stage",
    );
  }, {
    attributesResponse: [
      { id: 85, name: "Brand", type: "String", is_required: true, dictionary_id: 0 },
      { id: 999, name: "Season", type: "String", is_required: false, dictionary_id: 0 },
    ],
    aiOptimizeForRating(message) {
      const modules = message.body.modules || [];
      if (modules.includes("title")) {
        return {
          ok: true,
          data: {
            modules: {
              title: { value: "Launch rewritten title" },
              description: { value: "Launch rewritten description" },
              hashtags: { value: ["#launch"] },
            },
            errors: [],
          },
        };
      }
      if (message.body.attrScope === "rating") {
        return {
          ok: true,
          data: {
            modules: {
              attrs: {
                filled: [{ id: 999, name: "Season", source: "text", status: "filled", resolvedDictValue: "Summer" }],
                skipped: [],
              },
            },
            errors: [],
          },
        };
      }
      if (message.body.attrScope === "required-and-rating") {
        return {
          ok: true,
          data: {
            modules: {
              attrs: {
                filled: [{ id: 85, name: "Brand", source: "text", status: "filled", resolvedDictValue: "Manual-safe Brand" }],
                skipped: [],
              },
            },
            errors: [],
          },
        };
      }
      return { ok: true, data: { modules: { attrs: { filled: [], skipped: [] } }, errors: [] } };
    },
  });
}

async function testUnresolvedDictionaryAttrsAreNotSentAsCurrentAttrs() {
  await withWizardPage(async (page, messages) => {
    await page.waitForSelector("#aiw-fill-attrs");
    await page.click("#aiw-fill-attrs");
    await page.waitForSelector(".aiw-manual-hint");

    await page.click("#aiw-fill-attrs");
    await waitUntil(
      () => messages.filter((m) => m.action === "aiOptimizeForRating" && m.body.attrScope === "required").length >= 2,
      "second required fill did not run",
    );

    const requiredCalls = messages.filter((m) => m.action === "aiOptimizeForRating" && m.body.attrScope === "required");
    const second = requiredCalls[1];
    assert.deepStrictEqual(
      second.body.currentAttrs || [],
      [],
      "unresolved dictionary suggestions without dictValueId must not be protected as current attrs",
    );
  }, {
    attributesResponse: [
      { id: 85, name: "Brand", type: "String", is_required: true, dictionary_id: 123 },
    ],
    aiOptimizeForRating() {
      return {
        ok: true,
        data: {
          modules: {
            attrs: {
              filled: [
                {
                  id: 85,
                  name: "Brand",
                  source: "dict-match",
                  status: "needs_manual",
                  reason: "dict_value_not_found",
                  suggestedLabel: "No brand",
                  resolvedDictValueId: null,
                  resolvedDictValue: null,
                },
              ],
              skipped: [],
            },
          },
          errors: [],
        },
      };
    },
  });
}

async function testLaunchRewriteUsesCurrentAttrsAndVisualTags() {
  await withWizardPage(async (page, messages) => {
    await page.waitForSelector(".aiw-attr-val");
    await page.fill(".aiw-attr-val", "Manual Material");

    await page.click("#aiw-launch");
    await waitUntil(
      () => messages.some((m) => m.action === "aiOptimizeForRating" && (m.body.modules || []).includes("title")),
      "launch rewrite request did not run",
      5000,
    );

    const rewrite = messages.find((m) => m.action === "aiOptimizeForRating" && (m.body.modules || []).includes("title"));
    assert.deepStrictEqual(
      rewrite.body.currentAttrs,
      [{ id: 85, values: [{ value: "Manual Material" }] }],
      "launch rewrite should carry the same currentAttrs context as rewrite-only",
    );
    assert(
      Array.isArray(rewrite.body.visualTags) && rewrite.body.visualTags.includes("剪刀"),
      "launch rewrite should carry category visual tags for consistent AI context",
    );
  }, {
    attributesResponse: [
      { id: 85, name: "Material", type: "String", is_required: true, dictionary_id: 0 },
    ],
    aiOptimizeForRating(message) {
      if ((message.body.modules || []).includes("title")) {
        return {
          ok: true,
          data: {
            modules: {
              title: { value: "Launch context title" },
              description: { value: "Launch context description" },
              hashtags: { value: ["#context"] },
            },
            errors: [],
          },
        };
      }
      return { ok: true, data: { modules: { attrs: { filled: [], skipped: [] } }, errors: [] } };
    },
  });
}

async function testLaunchGeneratedContentUpdatesActionPreview() {
  await withWizardPage(async (page, messages) => {
    await page.waitForSelector("#aiw-launch");
    await page.waitForSelector("#aiw-content-preview");
    await page.click("#aiw-launch");

    await waitUntil(
      () => messages.some((m) => m.action === "aiOptimizeForRating" && (m.body.modules || []).includes("title")),
      "launch rewrite request did not run",
      5000,
    );

    await page.waitForFunction(() =>
      (document.querySelector("#aiw-content-preview")?.textContent || "").includes("Launch preview title"),
    );

    const preview = await page.$eval("#aiw-content-preview", (node) => node.textContent || "");
    assert(preview.includes("Launch preview title"), "launch rewrite should update AI action preview title");
    assert(preview.includes("Launch preview description"), "launch rewrite should update AI action preview description");
    assert(preview.includes("#launch_preview"), "launch rewrite should update AI action preview hashtags");
  }, {
    attributesResponse: [],
    aiOptimizeForRating(message) {
      if ((message.body.modules || []).includes("title")) {
        return {
          ok: true,
          data: {
            modules: {
              title: { value: "Launch preview title" },
              description: { value: "Launch preview description" },
              hashtags: { value: ["#launch_preview"] },
            },
            errors: [],
          },
        };
      }
      return { ok: true, data: { modules: { attrs: { filled: [], skipped: [] } }, errors: [] } };
    },
  });
}

function testFmtMoneyHasSingleDefinition() {
  const source = fs.readFileSync(wizardPath, "utf8");
  const matches = source.match(/function\s+fmtMoney\s*\(/g) || [];
  assert.strictEqual(matches.length, 1, "1688 AI wizard should keep exactly one fmtMoney implementation");
}

async function testGeneratedContentRestoresAfterPanelReopen() {
  await withWizardPage(async (page, messages) => {
    await page.waitForSelector("#aiw-rewrite-only");
    await page.click("#aiw-rewrite-only");
    await page.waitForFunction(() =>
      (document.querySelector("#aiw-content-preview")?.textContent || "").includes("Cached title"),
    );

    const rewriteCount = messages.filter((m) =>
      m.action === "aiOptimizeForRating" && (m.body.modules || []).includes("title")
    ).length;

    await page.evaluate(() => document.getElementById("jzc-aiw-mask").click());
    await page.evaluate((raw) => window.__JZC_OPEN_AI_WIZARD__(raw), defaultRaw());
    await page.waitForFunction(() =>
      (document.querySelector("#aiw-content-preview")?.textContent || "").includes("Cached title"),
    );

    assert.strictEqual(
      messages.filter((m) => m.action === "aiOptimizeForRating" && (m.body.modules || []).includes("title")).length,
      rewriteCount,
      "reopening same page should restore generated content without rerunning rewrite",
    );
  }, {
    attributesResponse: [],
    aiOptimizeForRating() {
      return {
        ok: true,
        data: {
          modules: {
            title: { value: "Cached title" },
            description: { value: "Cached description" },
            hashtags: { value: ["#cached"] },
          },
          errors: [],
        },
      };
    },
  });
}

(async () => {
  testFmtMoneyHasSingleDefinition();
  await testRatingButtonIsRatingOnlyAndKeepsRequiredAttrsUntouched();
  await testRequiredButtonKeepsOptionalAttrsOutOfRequiredModule();
  await testRewriteOnlyAndPublishOnlyAreIndependentFromFullPipeline();
  await testNoBrandDictMissKeepsManualSuggestionWithoutTechnicalCopy();
  await testNoBrandRequiredAttrDoesNotBlockPublish();
  await testManualDictionaryAttrSubmitsAsBackendPlaceholder();
  await testAiSuggestedManualDictionaryAttrCanPublishAsPlaceholder();
  await testLaunchStopsForNonBrandManualSuggestionBeforeDirectSubmit();
  await testLaunchAutoSubmitsWhenOnlyNoBrandNeedsManual();
  await testSkuListRendersAndPublishesGroupedVariantRows();
  await testBatchPriceSupportsSetAddAndMultiplyModes();
  await testPackageFieldsRenderAndSubmitTopLevelDimensions();
  await testManualWarningHidesTechnicalReasonCodes();
  await testRatingEmptyStateHidesCombinedRequiredCopy();
  await testRatingButtonMergesReturnedRowsWithExistingValues();
  await testLaunchFillsMissingRequiredAttrsAfterRatingOnlyWasUsed();
  await testUnresolvedDictionaryAttrsAreNotSentAsCurrentAttrs();
  await testLaunchRewriteUsesCurrentAttrsAndVisualTags();
  await testLaunchGeneratedContentUpdatesActionPreview();
  await testGeneratedContentRestoresAfterPanelReopen();
  console.log("ai wizard Agent1 action tests passed");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
