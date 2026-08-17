/**
 * jizhangerp bridge follow-sell smoke.
 *
 * Run with:
 *   node extension/tests/jizhangerp-bridge-follow-sell.test.js
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const categoryStrategyHandoff = require("../lib/category-strategy-handoff.js");

const extensionRoot = path.resolve(__dirname, "..");
const bridgeSource = fs.readFileSync(
  path.join(extensionRoot, "content/jizhangerp-bridge.js"),
  "utf8",
);
const manifest = JSON.parse(
  fs.readFileSync(path.join(extensionRoot, "manifest.json"), "utf8"),
);

const plain = (value) => JSON.parse(JSON.stringify(value));
const nextTick = () => new Promise((resolve) => setImmediate(resolve));

function createHarness(overrides = {}) {
  const origin = "http://127.0.0.1:3000";
  const listeners = [];
  const posted = [];
  const sentToSw = [];
  const window = {
    location: { origin },
    addEventListener(type, handler) {
      if (type === "message") listeners.push(handler);
    },
    postMessage(message, targetOrigin) {
      posted.push({ message, targetOrigin });
    },
    JZSkuCollect: {
      collectBySkus: async (skus) => ({
        sourceMap: new Map([
          [
            skus[0],
            {
              name: "Тестовый товар",
              images: ["https://cdn.example.test/image.jpg"],
              _sourceVariant: { attributes: [] },
            },
          ],
        ]),
        failed: [],
      }),
    },
    JZV3Payload: {
      buildV3Item(row, distilled, opts) {
        assert.strictEqual(row.sku, "3278119665");
        assert.strictEqual(row.price, 383.66);
        assert.strictEqual(opts.currencyCode, "RUB");
        assert.ok(distilled?._sourceVariant, "distilled source variant should be passed to V3 builder");
        return {
          ok: true,
          item: {
            offer_id: "jz-test-3278119665",
            name: distilled.name,
            price: row.price.toFixed(2),
            currency_code: opts.currencyCode,
            images: [{ file_name: distilled.images[0], default: true }],
          },
        };
      },
    },
    JzCategoryStrategyHandoff: categoryStrategyHandoff,
    ...overrides.window,
  };
  const chrome = {
    runtime: {
      lastError: null,
      getManifest: () => ({ version: "0.13.46.9" }),
      sendMessage(message, callback) {
        sentToSw.push(message);
        if (message.action === "CATEGORY_STRATEGY_READINESS") {
          callback({ ok: true, data: { ready: true, minimumExtensionVersion: "0.13.46.9" } });
          return;
        }
        if (message.action === "CATEGORY_STRATEGY_BROWSER_OPEN") {
          callback({ ok: true, data: { opened: true } });
          return;
        }
        callback({ ok: true, data: { result: { task_id: 778899 } } });
      },
    },
    ...overrides.chrome,
  };
  const context = {
    console,
    chrome,
    window,
    self: window,
    Map,
    Promise,
    String,
    Number,
    Date,
    JzPortalBridgePolicy: {
      sanitizePortalBridgeResponse: (response) => response,
    },
  };
  vm.runInNewContext(bridgeSource, context, { filename: "jizhangerp-bridge.js" });

  async function dispatch(data, source = window, eventOrigin = origin) {
    for (const handler of listeners) {
      await handler({ source, origin: eventOrigin, data });
    }
  }

  return { origin, listeners, posted, sentToSw, window, chrome, dispatch };
}

(async () => {
  const qhScriptGroup = manifest.content_scripts.find((group) =>
    (group.js || []).includes("content/jizhangerp-bridge.js"),
  );
  assert.ok(qhScriptGroup, "manifest should inject jizhangerp bridge on sonli pages");
  assert.deepStrictEqual(
    qhScriptGroup.js,
    [
      "lib/category-strategy-handoff.js",
      "lib/follow-sell-content-copy.js",
      "lib/v3-payload.js",
      "lib/sku-collect.js",
      "lib/portal-bridge-policy.js",
      "content/jizhangerp-bridge.js",
    ],
    "sonli bridge dependencies must load before the bridge",
  );

  const harness = createHarness();
  assert.strictEqual(harness.listeners.length, 1, "bridge should register one message listener");

  await harness.dispatch({ __jz: "v1", kind: "ping.request", reqId: "ping-1" });
  assert.deepStrictEqual(plain(harness.posted[0]), {
    targetOrigin: harness.origin,
    message: {
      __jz: "v1",
      kind: "ping.response",
      reqId: "ping-1",
      ok: true,
      version: "0.13.46.9",
      capabilities: {
        followSell: true,
        dryRunPreview: true,
        localListingBridge: true,
        categoryStrategyHandoff: true,
      },
    },
  });

  await harness.dispatch({
    __jz: "v1", kind: "category-strategy.readiness.request", reqId: "strategy-ready-1",
  });
  await nextTick();
  assert.deepStrictEqual(plain(harness.sentToSw[0]), {
    action: "CATEGORY_STRATEGY_READINESS",
  });
  assert.deepStrictEqual(plain(harness.posted[1]), {
    targetOrigin: harness.origin,
    message: {
      __jz: "v1", kind: "category-strategy.readiness.response", reqId: "strategy-ready-1",
      ok: true, ready: true, version: "0.13.46.9",
    },
  });

  const browserUrl = "https://www.ozon.ru/category/nabory-skladnoy-mebeli-11504/"
    + "?zongziCategoryStrategySession=session-a";
  await harness.dispatch({
    __jz: "v1", kind: "category-strategy.open.request", reqId: "strategy-open-1", browserUrl,
  });
  await nextTick();
  assert.deepStrictEqual(plain(harness.sentToSw[1]), {
    action: "CATEGORY_STRATEGY_BROWSER_OPEN", browserUrl,
  });
  assert.deepStrictEqual(plain(harness.posted[2]), {
    targetOrigin: harness.origin,
    message: {
      __jz: "v1", kind: "category-strategy.open.response", reqId: "strategy-open-1",
      ok: true, opened: true,
    },
  });

  await harness.dispatch({
    __jz: "v1",
    kind: "follow-sell.request",
    reqId: "follow-1",
    storeId: "local_test_store",
    sku: "3278119665",
    price: 383.66,
    currencyCode: "RUB",
  });
  await nextTick();
  assert.strictEqual(harness.sentToSw.length, 3, "follow-sell should call service worker once after handoff probes");
  assert.deepStrictEqual(plain(harness.sentToSw[2]), {
    action: "followSell",
    portalProtocol: "JZ_ERP",
    storeId: "local_test_store",
    items: [
      {
        offer_id: "jz-test-3278119665",
        name: "Тестовый товар",
        price: "383.66",
        currency_code: "RUB",
        images: [{ file_name: "https://cdn.example.test/image.jpg", default: true }],
      },
    ],
    strictTypeMatch: true,
    dryRun: false,
    applyPoster: false,
    applyAiRewrite: false,
  });
  assert.deepStrictEqual(plain(harness.posted[3]), {
    targetOrigin: harness.origin,
    message: {
      __jz: "v1",
      kind: "follow-sell.response",
      reqId: "follow-1",
      ok: true,
      data: { result: { task_id: 778899 } },
      taskId: 778899,
    },
  });

  await harness.dispatch({
    __jz: "v1",
    kind: "follow-sell.request",
    reqId: "follow-preview",
    storeId: "local_test_store",
    sku: "3278119665",
    price: 383.66,
    currencyCode: "RUB",
    dryRun: true,
  });
  await nextTick();
  assert.strictEqual(harness.sentToSw.length, 4, "preview follow-sell should also call service worker");
  assert.strictEqual(harness.sentToSw[3].dryRun, true, "dryRun should pass through to service worker");

  const missingDeps = createHarness({ window: { JZV3Payload: null } });
  await missingDeps.dispatch({
    __jz: "v1",
    kind: "follow-sell.request",
    reqId: "follow-missing",
    storeId: "local_test_store",
    sku: "3278119665",
    price: 383.66,
  });
  await nextTick();
  assert.strictEqual(missingDeps.sentToSw.length, 0, "missing V3 builder must not call service worker");
  assert.strictEqual(missingDeps.posted[0].message.ok, false);
  assert.match(missingDeps.posted[0].message.error, /依赖未加载/);

  console.log("jizhangerp bridge follow-sell smoke passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
