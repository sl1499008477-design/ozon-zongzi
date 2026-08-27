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
const serviceWorkerPath = path.join(__dirname, "..", "background", "service-worker.js");

async function waitUntil(predicate, message, timeoutMs = 3000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(message);
}

async function withWizardPage(fn, options = {}) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const messages = [];
  const consoleMessages = [];
  page.on("console", (msg) => consoleMessages.push(msg.text()));

  await page.goto("about:blank");
  await page.exposeFunction("__jzcAiWizardMessage", async (message) => {
    messages.push(message);

    if (message.action === "getStores") {
      return {
        ok: true,
        data: [
          { id: "store-a", label: "baibai", companyCurrency: "CNY" },
          { id: "store-b", label: "baibai2", companyCurrency: "RUB" },
        ],
      };
    }

    if (message.action === "getAuth") {
      return { ok: true, data: { storeId: options.authStoreId || "store-a" } };
    }

    if (message.action === "getWarehouses") {
      if (options.warehouseResponse) return options.warehouseResponse;
      return {
        ok: true,
        data: {
          data: {
            warehouses: [
              { warehouse_id: 101, name: "cel" },
              { warehouseId: 202, label: "backup" },
            ],
          },
        },
      };
    }

    if (message.action === "getCategoryTree") {
      if (options.categoryTree) {
        return { ok: true, data: { result: options.categoryTree } };
      }
      return {
        ok: true,
        data: {
          result: [
            {
              title: "小百货和配饰",
              children: [
                {
                  title: "配饰",
                  children: [
                    {
                      title: "伞",
                      type_id: 94824,
                      description_category_id: 17031663,
                    },
                  ],
                },
              ],
            },
          ],
        },
      };
    }

    if (message.action === "suggestCategory") {
      if (typeof options.suggestCategory === "function") {
        return options.suggestCategory(message);
      }
      if (options.autoCategory) {
        return {
          ok: true,
          data: {
            selected: {
              typeId: 94824,
              descCatId: 17031663,
              path: "default / accessories / umbrella",
              confidence: 0.9,
            },
            candidates: [],
          },
        };
      }
      return { ok: true, data: { selected: null, candidates: [] } };
    }

    if (message.action === "verifyCategory") {
      return { ok: true, data: { ok: true } };
    }

    if (message.action === "getCategoryAttributes") {
      return {
        ok: true,
        data: options.attributesResponse || [],
      };
    }

    if (message.action === "aiOptimizeForRating") {
      if (typeof options.aiOptimizeForRating === "function") {
        return options.aiOptimizeForRating(message);
      }
      return {
        ok: true,
        data: {
          modules: { attrs: { filled: [], skipped: [] } },
          errors: [],
        },
      };
    }

    if (message.action === "getFxRate") {
      if (options.fxRateResponse) return options.fxRateResponse;
      return { ok: true, data: { rate: 12 } };
    }

    if (message.action === "getAiQuota") {
      return { ok: true, data: {} };
    }

    if (message.action === "pushSourceCollect") {
      return { ok: true, data: { result: { id: "collect-1" } } };
    }

    if (message.action === "followSell") {
      return { ok: true, data: { result: { task_id: "task-1" } } };
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
  if (options.debug) {
    await page.evaluate(() => {
      window.__JZC_AI_WIZARD_DEBUG__ = true;
    });
  }
  if (options.raw) {
    await page.evaluate((raw) => {
      window.__JZC_TEST_RAW__ = raw;
    }, options.raw);
  }
  await page.evaluate(() => {
    window.__JZC_OPEN_AI_WIZARD__(window.__JZC_TEST_RAW__ || {
      offerId: "806700856384",
      title: "德国XINAIX双筒望远镜高倍高清",
      price: "3.6",
      mainImages: ["https://example.test/main.jpg"],
      specs: { 颜色: "黑色" },
    });
  });

  try {
    await fn(page, messages, consoleMessages);
  } finally {
    await browser.close();
  }
}

async function testAutoCategoryUsesRichContextAndInheritedDescCatId() {
  const categoryTree = [
    {
      title: "Sports",
      description_category_id: 9000,
      children: [
        {
          title: "Scooters",
          children: [{ title: "Electric scooter", type_id: 100 }],
        },
      ],
    },
  ];

  await withWizardPage(async (page, messages) => {
    await page.waitForFunction(() =>
      [...document.querySelectorAll("#aiw-cat-cascade select")]
        .some((select) => select.textContent.includes("Electric scooter")),
    );

    const suggestRequest = messages.find((m) => m.action === "suggestCategory");
    assert(suggestRequest.body.sourceCategory.includes("1688 sports > scooters"));
    assert.deepStrictEqual(suggestRequest.body.skuNames, [
      "adult long range electric scooter",
      "black 48v model",
    ]);
    assert.strictEqual(suggestRequest.body.mainImageUrl, "https://example.test/scooter.jpg");
    assert.strictEqual(suggestRequest.body.imageCount, 2);

    const selectedText = await page.$eval("#aiw-cat-cascade", (node) => node.textContent || "");
    assert(selectedText.includes("Sports"));
    assert(selectedText.includes("Scooters"));
    assert(selectedText.includes("Electric scooter"));
  }, {
    raw: {
      offerId: "602965849306",
      title: "factory direct vehicle",
      price: "1760",
      category: "1688 sports > scooters",
      mainImages: ["https://example.test/scooter.jpg", "https://example.test/detail.jpg"],
      specs: { range: "long", brake: "disc" },
      skuList: [
        { name: "adult long range electric scooter" },
        { skuName: "black 48v model" },
      ],
    },
    categoryTree,
    suggestCategory(message) {
      assert.strictEqual(message.body.matchMode, "leaf-topk");
      return {
        ok: true,
        data: {
          selected: {
            typeId: 100,
            descCatId: 9000,
            path: "Sports / Scooters / Electric scooter",
            confidence: 0.9,
          },
          candidates: [],
        },
      };
    },
  });
}

async function testAutoCategoryUsesOneLeafCandidateRankRequest() {
  const categoryTree = [
    {
      title: "电子产品",
      children: [
        {
          title: "望远镜和显微镜",
          children: [
            { title: "显微镜", type_id: 111, description_category_id: 1001 },
            { title: "望远镜", type_id: 222, description_category_id: 1002 },
          ],
        },
      ],
    },
    {
      title: "小百货和配饰",
      children: [
        {
          title: "配饰",
          children: [{ title: "伞", type_id: 333, description_category_id: 1003 }],
        },
      ],
    },
  ];

  await withWizardPage(async (page, messages) => {
    await page.waitForFunction(() =>
      [...document.querySelectorAll("#aiw-cat-cascade select")]
        .some((select) => select.textContent.includes("望远镜")),
    );

    const suggestRequests = messages.filter((m) => m.action === "suggestCategory");
    assert.strictEqual(
      suggestRequests.length,
      1,
      "auto category matching should ask the backend v2 matcher once",
    );
    assert.strictEqual(suggestRequests[0].body.matchMode, "leaf-topk");
    assert.strictEqual(suggestRequests[0].body.topK, 20);
    assert.strictEqual(
      suggestRequests[0].body.candidates,
      undefined,
      "frontend should not send the whole tree or local candidate list in v2 mode",
    );

    const selectedText = await page.$eval("#aiw-cat-cascade", (node) => node.textContent);
    assert(selectedText.includes("电子产品"));
    assert(selectedText.includes("望远镜"));
  }, {
    categoryTree,
    suggestCategory(message) {
      assert.strictEqual(message.body.matchMode, "leaf-topk");
      return {
        ok: true,
        data: {
          selected: {
            typeId: 222,
            descCatId: 1002,
            path: "电子产品 / 望远镜和显微镜 / 望远镜",
            confidence: 0.9,
          },
          candidates: [
            { typeId: 222, descCatId: 1002, path: "电子产品 / 望远镜和显微镜 / 望远镜", score: 90 },
            { typeId: 333, descCatId: 1003, path: "小百货和配饰 / 配饰 / 伞", score: 5 },
          ],
        },
      };
    },
  });
}

async function testManualCategoryInheritsDescCatIdFromAnyAncestor() {
  const categoryTree = [
    {
      title: "Root category",
      description_category_id: 9000,
      children: [
        {
          title: "Middle category",
          children: [{ title: "Final leaf", type_id: 100 }],
        },
      ],
    },
  ];

  await withWizardPage(async (page, messages) => {
    await page.waitForFunction(() => document.querySelectorAll("#aiw-cat-cascade select").length >= 1);
    await page.selectOption("#aiw-cat-cascade select:nth-of-type(1)", "0");
    await page.waitForFunction(() => document.querySelectorAll("#aiw-cat-cascade select").length >= 2);
    await page.selectOption("#aiw-cat-cascade select:nth-of-type(2)", "0");
    await page.waitForFunction(() => document.querySelectorAll("#aiw-cat-cascade select").length >= 3);
    await page.selectOption("#aiw-cat-cascade select:nth-of-type(3)", "0");

    await page.click("#aiw-launch");
    await waitUntil(
      () => messages.some((m) => m.action === "aiOptimizeForRating" && (m.body.modules || []).includes("title")),
      "manual category pipeline did not send rewrite request",
      5000,
    );

    const rewrite = messages.find((m) => m.action === "aiOptimizeForRating" && (m.body.modules || []).includes("title"));
    assert.strictEqual(rewrite.body.category.typeId, 100);
    assert.strictEqual(
      rewrite.body.category.descriptionCategoryId,
      9000,
      "manual category selection should inherit descCatId from the nearest ancestor with one",
    );
  }, {
    categoryTree,
    suggestCategory() {
      return { ok: true, data: { selected: null, candidates: [] } };
    },
    attributesResponse: [],
    aiOptimizeForRating(message) {
      if ((message.body.modules || []).includes("title")) {
        return { ok: true, data: { modules: {}, errors: [] } };
      }
      return { ok: true, data: { modules: { attrs: { filled: [], skipped: [] } }, errors: [] } };
    },
  });
}

async function testPipelineWritesSuggestedPriceToUiAndImportPayload() {
  await withWizardPage(async (page, messages) => {
    await page.waitForFunction(() => !!document.querySelector("#aiw-store option[value='store-a']"));
    await page.selectOption("#aiw-store", "store-a");
    await page.waitForFunction(() => {
      const selects = [...document.querySelectorAll("#aiw-cat-cascade select")];
      return !!document.querySelector("#aiw-launch") && selects.length >= 3 && selects.every((select) => select.value);
    });
    await page.click("#aiw-launch");

    await waitUntil(
      () => messages.some((m) => m.action === "followSell"),
      "pipeline did not submit followSell",
      5000,
    );

    const priceValue = await page.$eval(".aiw-price", (input) => input.value);
    assert.strictEqual(priceValue, "4.68", "suggested price should update the visible sale price input");

    const followSell = messages.find((m) => m.action === "followSell");
    assert.strictEqual(followSell.items[0].price, "4.68");
    assert.strictEqual(followSell.items[0].old_price, "5.85");
    assert.deepStrictEqual(followSell.items[0]._pricingSnapshot, {
      costCny: 3.6,
      fxRate: 1,
      targetMargin: 30,
      salePrice: 4.68,
      currency: "CNY",
    });
  }, {
    autoCategory: true,
    attributesResponse: [],
    aiOptimizeForRating(message) {
      if ((message.body.modules || []).includes("title")) {
        return { ok: true, data: { modules: {}, errors: [] } };
      }
      return { ok: true, data: { modules: { attrs: { filled: [], skipped: [] } }, errors: [] } };
    },
  });
}

async function testRubDirectListingStopsWhenFxRateIsMissing() {
  await withWizardPage(async (page, messages) => {
    await page.waitForFunction(() => {
      const selects = [...document.querySelectorAll("#aiw-cat-cascade select")];
      return !!document.querySelector("#aiw-launch") && selects.length >= 3 && selects.every((select) => select.value);
    });
    await page.click("#aiw-launch");

    await page.waitForFunction(() => {
      const log = document.querySelector("#aiw-log")?.textContent || "";
      return log.includes("汇率");
    }, null, { timeout: 5000 });

    assert(
      !messages.some((m) => m.action === "followSell"),
      "direct listing must not submit an import with a zero/unknown RUB price",
    );
    const logText = await page.$eval("#aiw-log", (node) => node.textContent || "");
    assert(logText.includes("汇率"), "pipeline should explain that the FX rate is missing");
  }, {
    authStoreId: "store-b",
    fxRateResponse: { ok: false, error: "rate offline" },
    autoCategory: true,
    attributesResponse: [],
    aiOptimizeForRating(message) {
      if ((message.body.modules || []).includes("title")) {
        return { ok: true, data: { modules: {}, errors: [] } };
      }
      return { ok: true, data: { modules: { attrs: { filled: [], skipped: [] } }, errors: [] } };
    },
  });
}

async function testDirectListingStopsWhenRequiredAttrsMissing() {
  await withWizardPage(async (page, messages) => {
    await page.waitForFunction(() => {
      const selects = [...document.querySelectorAll("#aiw-cat-cascade select")];
      return !!document.querySelector("#aiw-launch") && selects.length >= 3 && selects.every((select) => select.value);
    });
    await page.click("#aiw-launch");

    await waitUntil(
      () => messages.filter((m) => m.action === "aiOptimizeForRating").length >= 2,
      "pipeline did not attempt rewrite and attr fill",
      5000,
    );
    await page.waitForTimeout(300);

    assert(
      !messages.some((m) => m.action === "followSell"),
      "direct listing must not submit import while required attrs are missing",
    );
    const logText = await page.$eval("#aiw-log", (node) => node.textContent || "");
    assert(logText.includes("0/1"), "pipeline log should show missing required attrs");
  }, {
    autoCategory: true,
    attributesResponse: [
      { id: 85, name: "Material", type: "String", is_required: true, dictionary_id: 0 },
    ],
    aiOptimizeForRating(message) {
      if ((message.body.modules || []).includes("title")) {
        return { ok: true, data: { modules: {}, errors: [] } };
      }
      return { ok: true, data: { modules: { attrs: { filled: [], skipped: [] } }, errors: [] } };
    },
  });
}

async function testStoreChangeReloadsScopedCategoryTree() {
  await withWizardPage(async (page, messages) => {
    await page.waitForFunction(() => !!document.querySelector("#aiw-store option[value='store-b']"));
    await page.selectOption("#aiw-store", "store-b");

    await waitUntil(
      () => messages.some((m) => m.action === "getWarehouses" && m.storeId === "store-b"),
      "store change did not request warehouses with the selected storeId",
    );

    assert(
      messages.some((m) => m.action === "getWarehouses" && m.storeId === "store-b"),
      "store change should load warehouses with the selected storeId",
    );
    assert(
      messages.some((m) => m.action === "getCategoryTree" && m.storeId === "store-b"),
      "store change should load category tree with the selected storeId",
    );
  }, { warehouseResponse: { ok: true, data: [{ warehouse_id: 101, name: "cel" }] } });
}

async function testWrappedWarehousesRenderInDropdown() {
  await withWizardPage(async (page) => {
    await page.waitForFunction(() => !!document.querySelector("#aiw-store option[value='store-a']"));
    await page.selectOption("#aiw-store", "store-a");

    await page.waitForFunction(() =>
      [...document.querySelectorAll("#aiw-wh option")].some((option) => option.value === "101"),
    );

    const warehouses = await page.$$eval("#aiw-wh option", (options) =>
      options.map((option) => ({ value: option.value, label: option.textContent.trim() })),
    );
    assert.deepStrictEqual(warehouses.slice(1), [
      { value: "101", label: "cel" },
      { value: "202", label: "backup" },
    ]);
  });
}

async function testAttrButtonsSendScopedFillRequests() {
  await withWizardPage(async (page, messages) => {
    await page.waitForFunction(() => !!document.querySelector("#aiw-store option[value='store-a']"));
    await page.selectOption("#aiw-store", "store-a");
    await page.waitForSelector("#aiw-fill-attrs");
    await page.click("#aiw-fill-attrs");

    await waitUntil(
      () => messages.some((m) => m.action === "aiOptimizeForRating"),
      "required attrs button did not request AI fill",
    );

    const requiredFill = messages.find((m) => m.action === "aiOptimizeForRating");
    assert.strictEqual(requiredFill.body.attrScope, "required");

    await page.click("#aiw-fill-rating");
    await waitUntil(
      () => messages.filter((m) => m.action === "aiOptimizeForRating").length >= 2,
      "rating attrs button did not request AI fill",
    );

    const fillRequests = messages.filter((m) => m.action === "aiOptimizeForRating");
    assert.strictEqual(fillRequests[1].body.attrScope, "rating");
  }, {
    autoCategory: true,
    attributesResponse: [
      { id: 85, name: "Brand", type: "String", is_required: true, dictionary_id: 0 },
      { id: 999, name: "Season", type: "String", is_required: false, dictionary_id: 0 },
    ],
  });
}

async function testRatingButtonDoesNotMutateRequiredAttrs() {
  await withWizardPage(async (page, messages) => {
    await page.waitForSelector("#aiw-fill-rating");
    await page.click("#aiw-fill-rating");

    await waitUntil(
      () => messages.some((m) => m.action === "aiOptimizeForRating"),
      "rating attrs button did not request AI fill",
    );

    const ratingFill = messages.find((m) => m.action === "aiOptimizeForRating");
    assert.strictEqual(ratingFill.body.attrScope, "rating");

    await page.waitForSelector(".aiw-rating-val");
    const requiredValue = await page.$eval(".aiw-attr-val", (input) => input.value);
    assert.strictEqual(requiredValue, "", "rating-only fill must not write required attribute inputs");

    const ratingValue = await page.$eval(".aiw-rating-val", (input) => input.value);
    assert.strictEqual(ratingValue, "Summer");
  }, {
    autoCategory: true,
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

async function testStandaloneAttrButtonsAppendAiLog() {
  await withWizardPage(async (page, messages) => {
    await page.waitForSelector("#aiw-fill-attrs");
    assert.strictEqual(await page.$("#aiw-log"), null, "AI log should start hidden before a standalone action");

    await page.click("#aiw-fill-attrs");
    await waitUntil(
      () => messages.some((m) => m.action === "aiOptimizeForRating" && m.body.attrScope === "required"),
      "required attrs button did not request AI fill",
    );
    await page.waitForSelector("#aiw-log");
    const requiredLog = await page.$eval("#aiw-log", (node) => node.textContent || "");
    assert(requiredLog.includes("AI 填充必填属性"), "required button should append a visible AI output log");

    await page.click("#aiw-fill-rating");
    await waitUntil(
      () => messages.some((m) => m.action === "aiOptimizeForRating" && m.body.attrScope === "rating"),
      "rating attrs button did not request AI fill",
    );
    const ratingLog = await page.$eval("#aiw-log", (node) => node.textContent || "");
    assert(ratingLog.includes("AI 填充内容评级属性"), "rating button should append a visible AI output log");
  }, {
    autoCategory: true,
    attributesResponse: [
      { id: 85, name: "Brand", type: "String", is_required: true, dictionary_id: 0 },
      { id: 999, name: "Season", type: "String", is_required: false, dictionary_id: 0 },
    ],
  });
}

async function testRewriteOnlyButtonCreatesPreviewWithoutPublishing() {
  await withWizardPage(async (page, messages) => {
    await page.waitForSelector("#aiw-rewrite-only");
    await page.click("#aiw-rewrite-only");

    await waitUntil(
      () => messages.some((m) => m.action === "aiOptimizeForRating" && (m.body.modules || []).includes("title")),
      "rewrite-only button did not request AI rewrite",
    );

    assert(
      !messages.some((m) => m.action === "followSell"),
      "rewrite-only button must not submit listing",
    );
    await page.waitForSelector("#aiw-content-preview");
    const preview = await page.$eval("#aiw-content-preview", (node) => node.textContent || "");
    assert(preview.includes("Rewritten title"), "rewrite preview should show the AI title");
    assert(preview.includes("#tag_one"), "rewrite preview should show AI hashtags");

    const log = await page.$eval("#aiw-log", (node) => node.textContent || "");
    assert(log.includes("AI 重写标题/描述/标签"), "rewrite-only button should append a visible AI output log");
  }, {
    autoCategory: true,
    attributesResponse: [],
    aiOptimizeForRating(message) {
      if ((message.body.modules || []).includes("title")) {
        return {
          ok: true,
          data: {
            modules: {
              title: { value: "Rewritten title" },
              description: { value: "Rewritten description" },
              hashtags: { value: ["#tag_one", "#tag_two"] },
            },
            errors: [],
          },
        };
      }
      return { ok: true, data: { modules: { attrs: { filled: [], skipped: [] } }, errors: [] } };
    },
  });
}

async function testPublishOnlyUsesPreparedContentAndAttrsWithoutRunningFullPipeline() {
  await withWizardPage(async (page, messages) => {
    await page.waitForSelector("#aiw-rewrite-only");
    await page.fill(".aiw-attr-val", "Manual Material");

    await page.click("#aiw-rewrite-only");
    await waitUntil(
      () => messages.some((m) => m.action === "aiOptimizeForRating" && (m.body.modules || []).includes("title")),
      "rewrite-only button did not request AI rewrite",
    );

    await page.click("#aiw-publish-only");
    await waitUntil(
      () => messages.some((m) => m.action === "followSell"),
      "publish-only button did not submit followSell",
    );

    assert(
      !messages.some((m) => m.action === "pushSourceCollect"),
      "publish-only button should not run the collect-box stage",
    );
    const followSell = messages.find((m) => m.action === "followSell");
    assert.strictEqual(followSell.items[0].name, "Rewritten title");
    assert.strictEqual(followSell.items[0].attributes[0].id, 85);
    assert.strictEqual(followSell.items[0].attributes[0].values[0].value, "Manual Material");
  }, {
    autoCategory: true,
    attributesResponse: [
      { id: 85, name: "Material", type: "String", is_required: true, dictionary_id: 0 },
    ],
    aiOptimizeForRating(message) {
      if ((message.body.modules || []).includes("title")) {
        return {
          ok: true,
          data: {
            modules: {
              title: { value: "Rewritten title" },
              description: { value: "Rewritten description" },
              hashtags: { value: ["#tag_one"] },
            },
            errors: [],
          },
        };
      }
      return { ok: true, data: { modules: { attrs: { filled: [], skipped: [] } }, errors: [] } };
    },
  });
}

async function testAttrFillSendsCurrentManualValues() {
  await withWizardPage(async (page, messages) => {
    await page.waitForSelector("#aiw-fill-attrs");
    await page.fill(".aiw-attr-val", "Manual Brand");
    await page.click("#aiw-fill-attrs");

    await waitUntil(
      () => messages.some((m) => m.action === "aiOptimizeForRating" && m.body.attrScope === "required"),
      "required attrs button did not request AI fill",
    );

    const requiredFill = messages.find((m) => m.action === "aiOptimizeForRating" && m.body.attrScope === "required");
    assert.deepStrictEqual(requiredFill.body.currentAttrs, [
      { id: 85, values: [{ value: "Manual Brand" }] },
    ]);
  }, {
    autoCategory: true,
    attributesResponse: [
      { id: 85, name: "Brand", type: "String", is_required: true, dictionary_id: 0 },
    ],
  });
}

async function testNeedsManualAttrsRenderManualHint() {
  await withWizardPage(async (page, messages) => {
    await page.waitForSelector("#aiw-fill-attrs");
    await page.click("#aiw-fill-attrs");

    await waitUntil(
      () => messages.some((m) => m.action === "aiOptimizeForRating" && m.body.attrScope === "required"),
      "required attrs button did not request AI fill",
    );
    await page.waitForTimeout(300);

    const manualHint = await page.$eval(".aiw-manual-hint", (node) => node.textContent || "");
    assert(manualHint.includes("Black"), "needs_manual hint should show the AI suggested label");
    assert(
      /manual|手动|确认|匹配/.test(manualHint),
      "needs_manual hint should tell the user this field needs manual confirmation",
    );
  }, {
    autoCategory: true,
    attributesResponse: [
      { id: 85, name: "Color", type: "String", is_required: true, dictionary_id: 123 },
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
                  name: "Color",
                  source: "dict-match",
                  status: "needs_manual",
                  reason: "dict_value_not_found",
                  suggestedLabel: "Black",
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

async function testDictAttrWithoutIdRendersManualHintEvenWhenBackendMarksFilled() {
  await withWizardPage(async (page) => {
    await page.waitForSelector("#aiw-fill-attrs");
    await page.click("#aiw-fill-attrs");

    await page.waitForTimeout(300);

    const manualHint = await page.$eval(".aiw-manual-hint", (node) => node.textContent || "");
    assert(manualHint.includes("No brand"), "bad filled dict response should still show suggested label");
    const attrValue = await page.$eval(".aiw-attr-val", (input) => input.value);
    assert.strictEqual(attrValue, "No brand", "bad filled dict response should populate editable manual value");
  }, {
    autoCategory: true,
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
                  status: "filled",
                  reason: "",
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

async function testNoBrandHintKeepsManualSuggestionWithoutTechnicalCopy() {
  await withWizardPage(async (page) => {
    await page.waitForSelector("#aiw-fill-attrs");
    await page.click("#aiw-fill-attrs");
    await page.waitForSelector(".aiw-manual-hint");

    const manualHint = await page.$eval(".aiw-manual-hint", (node) => node.textContent || "");
    assert(manualHint.includes("需手动确认：AI 建议「无品牌」"), "no-brand hint should keep the manual AI suggestion");
    assert(!manualHint.includes("no_brand_dict_value_not_found"), "no-brand hint should hide the backend reason");
    assert(!manualHint.includes("未匹配到 Ozon 字典值"), "no-brand hint should not show the noisy dict warning");
  }, {
    autoCategory: true,
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

async function testSamePageDraftRestoresAfterCloseAndReopen() {
  const categoryTree = [
    {
      title: "Home",
      description_category_id: 9001,
      children: [
        {
          title: "Kitchen",
          children: [{ title: "Cutting board", type_id: 701 }],
        },
      ],
    },
  ];

  await withWizardPage(async (page, messages) => {
    await page.waitForFunction(() => {
      const selects = [...document.querySelectorAll("#aiw-cat-cascade select")];
      return selects.length >= 3 && selects.every((select) => select.value);
    });
    await page.waitForSelector(".aiw-attr-val");
    await page.waitForFunction(() => !!document.querySelector("#aiw-wh option[value='101']"));

    await page.fill(".aiw-price", "23.40");
    await page.selectOption("#aiw-wh", "101");
    await page.fill(".aiw-attr-val", "hardwood");

    const suggestCountBefore = messages.filter((m) => m.action === "suggestCategory").length;
    assert.strictEqual(suggestCountBefore, 1, "initial auto match should run once before reopening");

    await page.evaluate(() => document.getElementById("jzc-aiw-mask").click());
    await page.evaluate(() => window.__JZC_OPEN_AI_WIZARD__(window.__JZC_TEST_RAW__));
    await page.waitForSelector(".aiw-price");
    await page.waitForTimeout(350);

    assert.strictEqual(
      messages.filter((m) => m.action === "suggestCategory").length,
      suggestCountBefore,
      "reopening the same 1688 page should restore cached category instead of rematching",
    );

    const priceValue = await page.$eval(".aiw-price", (input) => input.value);
    assert.strictEqual(priceValue, "23.40", "cached sale price should be restored");

    const warehouseValue = await page.$eval("#aiw-wh", (select) => select.value);
    assert.strictEqual(warehouseValue, "101", "cached warehouse should be restored");

    const attrValue = await page.$eval(".aiw-attr-val", (input) => input.value);
    assert.strictEqual(attrValue, "hardwood", "cached required attribute value should be restored");

    const selectedText = await page.$eval("#aiw-cat-cascade", (node) => node.textContent || "");
    assert(selectedText.includes("Home"));
    assert(selectedText.includes("Kitchen"));
    assert(selectedText.includes("Cutting board"));
  }, {
    raw: {
      offerId: "999371286976",
      title: "solid wood kitchen cutting board",
      price: "18",
      mainImages: ["https://example.test/cutting-board.jpg"],
      specs: { material: "wood" },
    },
    categoryTree,
    suggestCategory() {
      return {
        ok: true,
        data: {
          selected: {
            typeId: 701,
            descCatId: 9001,
            path: "Home / Kitchen / Cutting board",
            confidence: 0.9,
          },
          candidates: [],
        },
      };
    },
    attributesResponse: [
      { id: 85, name: "Material", type: "String", is_required: true, dictionary_id: 0 },
    ],
  });
}

async function testDebugLogsSanitizedWizardMessages() {
  await withWizardPage(async (page, messages, consoleMessages) => {
    await page.waitForFunction(() => !!document.querySelector("#aiw-store option[value='store-b']"));
    await page.selectOption("#aiw-store", "store-b");

    await waitUntil(
      () => messages.some((m) => m.action === "getWarehouses" && m.storeId === "store-b"),
      "debug test did not request warehouses with the selected storeId",
    );

    const joined = consoleMessages.join("\n");
    assert(
      joined.includes('[jzc-ai-wizard:debug] {"dir":"send","action":"getWarehouses"'),
      "debug mode should log sanitized outgoing wizard messages",
    );
    assert(joined.includes('"storeId":"store-b"'), "debug log should include selected storeId");
    assert(!joined.includes("token"), "debug log must not include auth tokens");
    assert(!joined.includes("https://example.test/main.jpg"), "debug log must not include full image URLs");
  }, { debug: true });
}

function testServiceWorkerHasSanitizedAiWizardDebugLogging() {
  const source = fs.readFileSync(serviceWorkerPath, "utf8");
  assert(
    source.includes("[AIW debug]") && source.includes("sanitizeAiWizardDebugMeta"),
    "service worker should expose sanitized AI wizard request diagnostics",
  );
  assert(
    !/Authorization[\s\S]{0,120}\[AIW debug\]/.test(source),
    "AI wizard debug logs must not include Authorization headers",
  );
  assert(
    !/items:\s*body\.items/.test(source) && !/stocks:\s*body\.stocks/.test(source),
    "AI wizard debug logs must not include full import items or stock payloads",
  );
  assert(
    /itemCount/.test(source) && /stockCount/.test(source),
    "AI wizard debug logs should keep counts for import payload diagnostics",
  );
}

function testServiceWorkerLongAiWizardActionsAvoidDefault50sTimeout() {
  const source = fs.readFileSync(serviceWorkerPath, "utf8");
  assert(
    /AI_WIZARD_LONG_ACTIONS[\s\S]*aiOptimizeForRating/.test(source),
    "service worker should classify aiOptimizeForRating as a long AI wizard action",
  );
  assert(
    /AI_WIZARD_LONG_ACTIONS\.has\(message\?\.action\)[\s\S]*HANDLER_TOTAL_TIMEOUT_MS/.test(source),
    "AI wizard long actions should drive handler total timeout selection",
  );
}

function testServiceWorkerForwardsCategoryTreeStoreId() {
  const source = fs.readFileSync(serviceWorkerPath, "utf8");
  assert(
    /case 'getCategoryTree':[\s\S]*message\.storeId\s*\|\|\s*storeId[\s\S]*\/ozon\/categories\/tree/.test(source),
    "service worker getCategoryTree should prefer message.storeId over the global storeId",
  );
}

(async () => {
  testServiceWorkerForwardsCategoryTreeStoreId();
  testServiceWorkerHasSanitizedAiWizardDebugLogging();
  testServiceWorkerLongAiWizardActionsAvoidDefault50sTimeout();
  await testAutoCategoryUsesRichContextAndInheritedDescCatId();
  await testAutoCategoryUsesOneLeafCandidateRankRequest();
  await testManualCategoryInheritsDescCatIdFromAnyAncestor();
  await testPipelineWritesSuggestedPriceToUiAndImportPayload();
  await testRubDirectListingStopsWhenFxRateIsMissing();
  await testDirectListingStopsWhenRequiredAttrsMissing();
  await testStoreChangeReloadsScopedCategoryTree();
  await testWrappedWarehousesRenderInDropdown();
  await testAttrButtonsSendScopedFillRequests();
  await testRatingButtonDoesNotMutateRequiredAttrs();
  await testStandaloneAttrButtonsAppendAiLog();
  await testRewriteOnlyButtonCreatesPreviewWithoutPublishing();
  await testPublishOnlyUsesPreparedContentAndAttrsWithoutRunningFullPipeline();
  await testAttrFillSendsCurrentManualValues();
  await testNeedsManualAttrsRenderManualHint();
  await testDictAttrWithoutIdRendersManualHintEvenWhenBackendMarksFilled();
  await testNoBrandHintKeepsManualSuggestionWithoutTechnicalCopy();
  await testSamePageDraftRestoresAfterCloseAndReopen();
  await testDebugLogsSanitizedWizardMessages();
  console.log("ai wizard store/category/warehouse tests passed");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
