import assert from "node:assert/strict";
import test from "node:test";
import {
  assertCaptureOnlyFileSet,
  assertCaptureOnlyPermissionPolicy,
  assertCaptureOnlyServiceWorker,
  assertPopupWebLoginGuidance,
  chromeMatchPatternCovers,
} from "./extension-capture-only-policy.mjs";

test("Chrome match semantics treat wildcard subdomains as covering Seller API", () => {
  assert.equal(
    chromeMatchPatternCovers(
      "https://*.ozon.ru/*",
      "https://api-seller.ozon.ru/v3/product/info/list",
    ),
    true,
  );
  assert.equal(
    chromeMatchPatternCovers(
      "https://seller.ozon.ru/*",
      "https://api-seller.ozon.ru/v3/product/info/list",
    ),
    false,
  );
  assert.equal(
    chromeMatchPatternCovers(
      "https://api-seller.ozon.ru/v4/*",
      "https://api-seller.ozon.ru/v3/product/info/list",
    ),
    true,
    "Chrome host permissions grant the matched origin regardless of path",
  );
});

test("capture-only permissions may remove upstream permissions but never add one", () => {
  const upstream = {
    permissions: ["storage", "alarms", "cookies"],
    host_permissions: [
      "https://seller.ozon.ru/*",
      "https://api-seller.ozon.ru/*",
    ],
  };
  assert.doesNotThrow(() =>
    assertCaptureOnlyPermissionPolicy(
      {
        permissions: ["storage", "cookies"],
        host_permissions: ["https://seller.ozon.ru/*"],
      },
      upstream,
    ));
  assert.throws(
    () =>
      assertCaptureOnlyPermissionPolicy(
        {
          permissions: ["storage", "tabs"],
          host_permissions: ["https://seller.ozon.ru/*"],
        },
        upstream,
      ),
    /unreviewed extension permission: tabs/,
  );
  assert.throws(
    () =>
      assertCaptureOnlyPermissionPolicy(
        {
          permissions: ["storage"],
          host_permissions: ["https://*.ozon.ru/*"],
        },
        upstream,
      ),
    /Seller API/,
  );
  assert.throws(
    () =>
      assertCaptureOnlyPermissionPolicy(
        {
          permissions: ["storage"],
          host_permissions: ["https://seller.ozon.ru/*"],
          optional_permissions: ["tabs"],
        },
        upstream,
      ),
    /unreviewed optional extension permission: tabs/,
  );
  assert.throws(
    () =>
      assertCaptureOnlyPermissionPolicy(
        {
          permissions: ["storage"],
          host_permissions: ["https://seller.ozon.ru/*"],
          optional_host_permissions: ["https://api-seller.ozon.ru/v4/*"],
        },
        {
          ...upstream,
          optional_host_permissions: ["https://api-seller.ozon.ru/v4/*"],
        },
      ),
    /Seller API/,
  );
});

test("capture-only package requires Collector dependencies and rejects retired sync modules", () => {
  const requiredFiles = [
    "background/collector-client.js",
    "background/service-worker.js",
    "lib/collector-session.js",
    "popup/popup.html",
    "popup/popup.js",
    "tests/collector-session.test.js",
    "tests/sync-capability-removed.test.js",
  ];
  assert.doesNotThrow(() => assertCaptureOnlyFileSet(requiredFiles));
  assert.throws(
    () =>
      assertCaptureOnlyFileSet([
        ...requiredFiles,
        "background/sync/sync-engine.js",
      ]),
    /retired sync module/,
  );
});

test("popup and service worker expose only the Web-login capture flow", () => {
  assert.doesNotThrow(() =>
    assertPopupWebLoginGuidance(
      [
        "请先登录 Web 管理后台，再使用采集功能",
        "前往登录",
        "重新检查",
      ].join("\n"),
      'chrome.tabs.create({ url: "http://127.0.0.1:3000/login" });',
    ));
  assert.throws(
    () => assertPopupWebLoginGuidance("账号登录", "getStores()"),
    /Web login guidance/,
  );

  assert.doesNotThrow(() =>
    assertCaptureOnlyServiceWorker(
      "importScripts('../lib/collector-session.js', 'collector-client.js');",
    ));
  assert.throws(
    () =>
      assertCaptureOnlyServiceWorker(
        "importScripts('../lib/collector-session.js', 'sync/sync-engine.js');",
      ),
    /Collector client dependency/,
  );
});
