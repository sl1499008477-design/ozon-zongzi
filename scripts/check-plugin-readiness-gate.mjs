import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import assert from "node:assert/strict";
import path from "node:path";
import process from "node:process";
import {
  assertCaptureOnlyFileSet,
  assertCaptureOnlyServiceWorker,
  assertPopupWebLoginGuidance,
  assertReviewedCaptureOnlyPermissionPolicy,
} from "./extension-capture-only-policy.mjs";

const walk = (root, current = "") => {
  const files = [];
  for (const entry of readdirSync(path.join(root, current), { withFileTypes: true })) {
    const rel = path.join(current, entry.name).split(path.sep).join("/");
    if (entry.isDirectory()) files.push(...walk(root, rel));
    else if (entry.isFile()) files.push(rel);
  }
  return files;
};

const extensionDir = path.resolve(
  process.env.QH_LOCAL_EXTENSION_DIR || "extension",
);
const appSource = readFileSync("app/src/App.jsx", "utf8");
const bridgeSource = readFileSync(
  path.join(extensionDir, "content/jizhangerp-bridge.js"),
  "utf8",
);
const manifest = JSON.parse(
  readFileSync(path.join(extensionDir, "manifest.json"), "utf8"),
);
assertReviewedCaptureOnlyPermissionPolicy(manifest);
assertCaptureOnlyFileSet(walk(extensionDir));
assertCaptureOnlyServiceWorker(
  readFileSync(path.join(extensionDir, "background/service-worker.js"), "utf8"),
);
assertPopupWebLoginGuidance(
  readFileSync(path.join(extensionDir, "popup/popup.html"), "utf8"),
  readFileSync(path.join(extensionDir, "popup/popup.js"), "utf8"),
);

const requirePattern = (source, pattern, message) => {
  assert.match(source, pattern, message);
};

requirePattern(bridgeSource, /capabilities:\s*\{[\s\S]*followSell:\s*true[\s\S]*dryRunPreview:\s*true[\s\S]*localListingBridge:\s*true[\s\S]*\}/, "bridge ping must advertise local listing capabilities");

requirePattern(appSource, /const extensionSupportsLocalListing = \(response = \{\}\) =>[\s\S]*response\?\.capabilities\?\.followSell === true[\s\S]*response\?\.capabilities\?\.dryRunPreview === true[\s\S]*response\?\.capabilities\?\.localListingBridge === true/, "frontend must require all local listing capabilities");
requirePattern(appSource, /status:\s*"partial"[\s\S]*缺少本地 follow-sell 上架桥能力/, "frontend must distinguish source-plugin ping from local follow-sell readiness");
requirePattern(appSource, /const requestExtensionPrefetch = async/, "frontend must expose source-plugin prefetch compatibility path");
requirePattern(appSource, /const requestSourcePluginListing = async[\s\S]*requestExtensionPrefetch[\s\S]*\/ozon\/products\/import\/preview[\s\S]*\/ozon\/products\/import/, "source-plugin fallback must use prefetch and local import endpoints");
requirePattern(appSource, /插件只负责前置采集入库；当前页面保存草稿后，预检和上架都会使用数据库中的最新草稿，不会重新通过插件采集商品数据。/, "collect edit must explain the plugin acquisition and persisted-draft listing boundary");
requirePattern(appSource, /await saveListingDraft\(\{ silent: true, onlyIfChanged: true \}\);[\s\S]*\/ozon\/collect-box\/\$\{encodeURIComponent\(item\.id\)\}\/listing\//, "formal listing must persist changed drafts and submit the database draft without invoking the extension");
requirePattern(appSource, /const listingSubmitDisabled = loading \|\| Boolean\(listingRequiredMissingFields\.length\)/, "submit button must be gated by loading and required-field completion, not extension availability");
requirePattern(appSource, /disabled=\{listingSubmitDisabled\}[\s\S]*提交上架到 Ozon/, "submit button must use the persisted-draft readiness gate");
requirePattern(appSource, /源插件兼容采集模式/, "plugin page must explain source-plugin compatibility mode");
requirePattern(appSource, /const \[listingResult, setListingResult\] = useState\(null\)/, "collect edit page must keep listing result in visible state");
requirePattern(appSource, /className="collect-listing-result"[\s\S]*listingResult\.title[\s\S]*listingResult\.detail/, "collect edit page must render persistent listing result details");

const captureOnlyBehavior = spawnSync(
  process.execPath,
  [
    "--test",
    path.join(extensionDir, "tests/sync-capability-removed.test.js"),
  ],
  {
    stdio: "inherit",
    shell: false,
    env: {
      ...process.env,
      SONLI_EXTENSION_ROOT: extensionDir,
    },
  },
);
assert.equal(
  captureOnlyBehavior.status,
  0,
  "plugin readiness requires passing capture-only extension behavior",
);

console.log("plugin readiness gate ok");
