import assert from "node:assert/strict";
import test from "node:test";

import { createCategoryStrategyExtensionBridge } from "../src/category-strategy-extension-bridge.js";

const BROWSER_URL = "https://www.ozon.ru/category/nabory-skladnoy-mebeli-11504/"
  + "?zongziCategoryStrategySession=session-a";
const LEGACY_PRODUCT_URL = "https://www.ozon.ru/product/"
  + "mqouo-shkaf-skladnoy-turisticheskiy-1941181573/"
  + "?zongziCategoryStrategySession=session-a";

function fakeWindow() {
  const listeners = new Set();
  const posted = [];
  const windowObject = {
    location: { origin: "http://127.0.0.1:3000" },
    addEventListener(type, listener) {
      if (type === "message") listeners.add(listener);
    },
    removeEventListener(type, listener) {
      if (type === "message") listeners.delete(listener);
    },
    postMessage(message, origin) { posted.push({ message, origin }); },
  };
  return {
    windowObject,
    posted,
    listenerCount: () => listeners.size,
    dispatch(data, { source = windowObject, origin = windowObject.location.origin } = {}) {
      for (const listener of [...listeners]) listener({ source, origin, data });
    },
  };
}

test("readiness and open requests use exact same-origin messages and close their listeners", async () => {
  const h = fakeWindow();
  const bridge = createCategoryStrategyExtensionBridge({ windowObject: h.windowObject, timeoutMs: 50 });

  const readiness = bridge.ready();
  assert.equal(h.listenerCount(), 1);
  assert.deepEqual(h.posted[0], { origin: "http://127.0.0.1:3000", message: {
    __jz: "v1", kind: "category-strategy.readiness.request",
    reqId: h.posted[0].message.reqId,
  } });
  h.dispatch({
    __jz: "v1", kind: "category-strategy.readiness.response",
    reqId: h.posted[0].message.reqId, ok: true, ready: true, version: "0.13.46.3",
  });
  assert.deepEqual(await readiness, { ready: true, version: "0.13.46.3" });
  assert.equal(h.listenerCount(), 0);

  const opening = bridge.open(BROWSER_URL);
  assert.deepEqual(h.posted[1], { origin: "http://127.0.0.1:3000", message: {
    __jz: "v1", kind: "category-strategy.open.request",
    reqId: h.posted[1].message.reqId, browserUrl: BROWSER_URL,
  } });
  h.dispatch({
    __jz: "v1", kind: "category-strategy.open.response",
    reqId: h.posted[1].message.reqId, ok: true, opened: true,
  });
  assert.deepEqual(await opening, { opened: true });
  assert.equal(h.listenerCount(), 0);
});

test("default bridge accepts a valid readiness response after the legacy 1.5 second limit", async () => {
  const h = fakeWindow();
  const bridge = createCategoryStrategyExtensionBridge({ windowObject: h.windowObject });
  const observed = bridge.ready().then(
    (value) => ({ value }),
    (error) => ({ error }),
  );

  await new Promise((resolve) => setTimeout(resolve, 1_800));
  h.dispatch({
    __jz: "v1", kind: "category-strategy.readiness.response",
    reqId: h.posted[0].message.reqId, ok: true, ready: true, version: "0.13.46.13",
  });

  assert.deepEqual(await observed, { value: { ready: true, version: "0.13.46.13" } });
  assert.equal(h.listenerCount(), 0);
});

test("foreign and open readiness responses are ignored until a closed response arrives", async () => {
  const h = fakeWindow();
  const bridge = createCategoryStrategyExtensionBridge({ windowObject: h.windowObject, timeoutMs: 50 });
  const readiness = bridge.ready();
  const reqId = h.posted[0].message.reqId;

  h.dispatch({ __jz: "v1", kind: "category-strategy.readiness.response",
    reqId, ok: true, ready: true, version: "0.13.46.3" }, { source: {} });
  h.dispatch({ __jz: "v1", kind: "category-strategy.readiness.response",
    reqId, ok: true, ready: true, version: "0.13.46.3" }, { origin: "https://attacker.test" });
  h.dispatch({ __jz: "v1", kind: "category-strategy.readiness.response",
    reqId, ok: true, ready: true, version: "0.13.46.3", accountId: "must-not-enter" });
  assert.equal(h.listenerCount(), 1);

  h.dispatch({ __jz: "v1", kind: "category-strategy.readiness.response",
    reqId, ok: true, ready: true, version: "0.13.46.3" });
  assert.deepEqual(await readiness, { ready: true, version: "0.13.46.3" });
});

test("missing extension and failed open return stable errors without leaking listeners", async () => {
  const missing = fakeWindow();
  const missingBridge = createCategoryStrategyExtensionBridge({
    windowObject: missing.windowObject, timeoutMs: 5,
  });
  await assert.rejects(missingBridge.ready(), {
    code: "AUTO_LISTING_CATEGORY_STRATEGY_SESSION_HANDOFF_NOT_READY",
  });
  assert.equal(missing.listenerCount(), 0);

  const failed = fakeWindow();
  const failedBridge = createCategoryStrategyExtensionBridge({ windowObject: failed.windowObject, timeoutMs: 50 });
  const opening = failedBridge.open(BROWSER_URL);
  failed.dispatch({
    __jz: "v1", kind: "category-strategy.open.response",
    reqId: failed.posted[0].message.reqId, ok: false, opened: false,
  });
  await assert.rejects(opening, {
    code: "AUTO_LISTING_CATEGORY_STRATEGY_BROWSER_OPEN_FAILED",
  });
  assert.equal(failed.listenerCount(), 0);
});

test("unsafe sampling URLs fail before any extension message", async () => {
  for (const browserUrl of [
    "https://attacker.test/category/nabory-skladnoy-mebeli-11504/?zongziCategoryStrategySession=session-a",
    "https://www.ozon.ru/category/17028922/?zongziCategoryStrategySession=session-a",
    "https://www.ozon.ru/product/17028922/?zongziCategoryStrategySession=session-a",
    "https://www.ozon.ru/category/nabory-skladnoy-mebeli-11504/?zongziCategoryStrategySession=session-a&secret=x",
    "https://www.ozon.ru/category/nabory-skladnoy-mebeli-11504/#zongziCategoryStrategySession=session-a",
  ]) {
    const h = fakeWindow();
    const bridge = createCategoryStrategyExtensionBridge({ windowObject: h.windowObject, timeoutMs: 50 });
    await assert.rejects(bridge.open(browserUrl), {
      code: "AUTO_LISTING_CATEGORY_STRATEGY_BROWSER_OPEN_FAILED",
    });
    assert.equal(h.posted.length, 0, browserUrl);
    assert.equal(h.listenerCount(), 0, browserUrl);
  }
});

test("historical anchored product URLs cross the Web bridge without broadening the host or query", async () => {
  const h = fakeWindow();
  const bridge = createCategoryStrategyExtensionBridge({ windowObject: h.windowObject, timeoutMs: 50 });
  const opening = bridge.open(LEGACY_PRODUCT_URL);
  assert.equal(h.posted[0].message.browserUrl, LEGACY_PRODUCT_URL);
  h.dispatch({
    __jz: "v1", kind: "category-strategy.open.response",
    reqId: h.posted[0].message.reqId, ok: true, opened: true,
  });
  assert.deepEqual(await opening, { opened: true });
});
