const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const productSource = fs.readFileSync(path.join(root, "content", "ozon-product.js"), "utf8");
const serviceWorkerSource = fs.readFileSync(path.join(root, "background", "service-worker.js"), "utf8");
const imageSearchMainSource = fs.readFileSync(path.join(root, "content", "1688-image-search-main.js"), "utf8");

function hasMatch(patterns, expected) {
  return patterns.some((pattern) => pattern === expected);
}

function testImageSearchScriptInjectsOn1688Pages() {
  const entry = (manifest.content_scripts || []).find((item) =>
    (item.js || []).includes("content/1688-image-search.js"),
  );

  assert(entry, "expected manifest to inject content/1688-image-search.js");
  assert(
    hasMatch(entry.matches || [], "https://*.1688.com/*") ||
      hasMatch(entry.matches || [], "https://s.1688.com/*") ||
      hasMatch(entry.matches || [], "https://air.1688.com/*"),
    "1688 image search content script must run on 1688 transition and redirect pages",
  );
}

function testImageSearchMainBridgeDoesNotPatchWindowOpen() {
  const mainWorldEntry = (manifest.content_scripts || []).find((item) =>
    (item.js || []).includes("content/1688-image-search-main.js"),
  );

  assert(mainWorldEntry, "expected manifest to inject content/1688-image-search-main.js");
  assert.strictEqual(mainWorldEntry.world, "MAIN", "1688 imageId bridge must run in the page MAIN world");
  assert(
    imageSearchMainSource.includes("JZC_1688_UPLOAD_IMAGE_ID") &&
      imageSearchMainSource.includes("imageBase64ToImageId") &&
      imageSearchMainSource.includes("getRequestCandidates"),
    "MAIN bridge should expose imageId upload and try multiple page request candidates",
  );
  assert(
    !/window\.open\s*=|HTMLAnchorElement\.prototype|Location\.prototype|history\.pushState|location\.href\s*=/.test(imageSearchMainSource),
    "1688 MAIN bridge must not hook window.open or navigation because it recurses with 1688/AWSC wrappers",
  );
}

function testOzonChinaCdnImageHostIsAllowed() {
  assert(
    hasMatch(manifest.host_permissions || [], "https://*.ozonru.cn/*"),
    "proxyImageFetch must be allowed to fetch ir-*.ozonru.cn Ozon image URLs",
  );
}

function testProductAndContextMenuOpenHistorical1688ImageSearchEntry() {
  const historicalImageSearchPath = "https://s.1688.com/youyuan/index.htm";

  assert(
    productSource.includes(historicalImageSearchPath),
    "Ozon product page source button should open the historical 1688 image-search entry",
  );
  assert(
    serviceWorkerSource.includes(historicalImageSearchPath),
    "context menu image search should open the historical 1688 image-search entry",
  );
  assert(
    productSource.includes("__jzcOzonImg") && serviceWorkerSource.includes("__jzcOzonImg"),
    "1688 image search entry should still carry the proxied Ozon image parameter",
  );
}

function testBackgroundCollapses1688ResultPopupIntoTransitionTab() {
  assert(
    serviceWorkerSource.includes("collapse1688ImageSearchResultTab"),
    "background should collapse 1688 result popups into the original transition tab",
  );
  assert(
    serviceWorkerSource.includes("chrome.tabs.onCreated.addListener"),
    "background should observe newly created 1688 result tabs",
  );
  assert(
    serviceWorkerSource.includes("__jzcOzonImg") && serviceWorkerSource.includes("imageId"),
    "background collapse should only target __jzcOzonImg transition tabs and imageId result URLs",
  );
  assert(
    serviceWorkerSource.includes("chrome.tabs.update") && serviceWorkerSource.includes("chrome.tabs.remove"),
    "background collapse should navigate the opener tab to the result URL and close the extra tab",
  );
}

testImageSearchScriptInjectsOn1688Pages();
testImageSearchMainBridgeDoesNotPatchWindowOpen();
testOzonChinaCdnImageHostIsAllowed();
testProductAndContextMenuOpenHistorical1688ImageSearchEntry();
testBackgroundCollapses1688ResultPopupIntoTransitionTab();

console.log("1688 image search routing tests passed");
