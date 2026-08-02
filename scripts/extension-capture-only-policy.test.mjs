import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  REQUIRED_CAPTURE_ONLY_FILES,
  assertCaptureOnlyFileSet,
  assertCaptureOnlyPermissionPolicy,
  assertCaptureOnlyServiceWorker,
  assertPopupWebLoginGuidance,
  chromeMatchPatternCovers,
} from "./extension-capture-only-policy.mjs";

const popupHtml = readFileSync(new URL("../extension/popup/popup.html", import.meta.url), "utf8");
const popupJs = readFileSync(new URL("../extension/popup/popup.js", import.meta.url), "utf8");
const serviceWorker = readFileSync(
  new URL("../extension/background/service-worker.js", import.meta.url),
  "utf8",
);

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
  assert.equal(
    chromeMatchPatternCovers(
      "https://api-seller.ozon.ru:8443/harmless-only",
      "https://api-seller.ozon.ru/v3/product/info/list",
    ),
    true,
    "Chrome host permissions do not use ports as an origin boundary",
  );
  assert.equal(
    chromeMatchPatternCovers(
      "http://127.0.0.1:3000/*",
      "http://127.0.0.1:4173/login",
    ),
    true,
    "an approved localhost host permission covers equivalent ports",
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
    "background/collector-ozon-enrichment-agent.js",
    "background/collector-ozon-enrichment-client.js",
    "background/service-worker.js",
    "lib/collector-session.js",
    "lib/ozon-enrichment-contract.js",
    "popup/popup.html",
    "popup/popup.js",
    "tests/collector-ozon-enrichment-client.test.js",
    "tests/collector-session.test.js",
    "tests/ozon-enrichment-contract.test.js",
    "tests/sync-capability-removed.test.js",
  ];
  for (const file of requiredFiles) {
    assert.equal(REQUIRED_CAPTURE_ONLY_FILES.includes(file), true, file);
  }
  assert.doesNotThrow(() => assertCaptureOnlyFileSet(requiredFiles));
  assert.throws(
    () => assertCaptureOnlyFileSet(
      requiredFiles.filter((file) => file !== "background/collector-ozon-enrichment-agent.js"),
    ),
    /required capture-only file missing/,
  );
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
    assertCaptureOnlyServiceWorker(serviceWorker));
  assert.match(
    serviceWorker,
    /'\.\.\/lib\/frontend-tab-opener\.js'/,
    "service worker must import the frontend tab opener",
  );
  assert.match(
    serviceWorker,
    /JzFrontendTabOpener\.createFrontendTabOpener/,
    "service worker must construct the frontend tab opener",
  );
  assert.match(
    serviceWorker,
    /data: await openFrontendTab\(\{ url \}\)/,
    "openFrontend must delegate the trusted URL to the frontend tab opener",
  );

  assert.doesNotThrow(() =>
    assertPopupWebLoginGuidance(
      popupHtml,
      `${popupJs}\nconst routedWebLoginUrl = "http://127.0.0.1:3000/login";`,
    ));
  assert.match(
    popupJs,
    /await sendMessage\(\{ action: "openFrontend", path: "\/login" \}\);/,
    "popup Web login guidance must route through openFrontend",
  );
  assert.doesNotMatch(
    popupJs,
    /chrome\.tabs\.create\(\{ url: "http:\/\/127\.0\.0\.1:3000\/login" \}\);/,
    "popup must not create the Web login tab directly",
  );
  assert.throws(
    () => assertPopupWebLoginGuidance("账号登录", "getStores()"),
    /Web login guidance/,
  );
  assert.throws(
    () =>
      assertCaptureOnlyServiceWorker(
        "importScripts('../lib/collector-session.js', '../lib/ozon-enrichment-contract.js', 'collector-client.js', 'collector-ozon-enrichment-agent.js');",
      ),
    /Collector Ozon client dependency/,
  );
  assert.throws(
    () =>
      assertCaptureOnlyServiceWorker(
        "importScripts('../lib/collector-session.js', '../lib/ozon-enrichment-contract.js', 'collector-client.js', 'collector-ozon-enrichment-agent.js', 'collector-ozon-enrichment-client.js', 'sync/sync-engine.js');",
      ),
    /capture-only/,
  );
});
