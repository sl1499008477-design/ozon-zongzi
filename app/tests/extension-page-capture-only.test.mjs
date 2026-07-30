import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const rootDir = path.resolve(import.meta.dirname, "../..");
const appSource = readFileSync(path.join(rootDir, "app/src/App.jsx"), "utf8");
const contractPath = path.join(
  rootDir,
  "app/src/extension-page-contract.mjs",
);
const manifest = JSON.parse(
  readFileSync(path.join(rootDir, "extension/manifest.json"), "utf8"),
);

test("extension page contract points at the packaged capture-only popup", async () => {
  assert.ok(
    existsSync(contractPath),
    "extension page must own a canonical packaged-preview contract",
  );
  const contract = await import(pathToFileURL(contractPath));
  assert.equal(contract.EXTENSION_VERSION, manifest.version);
  assert.equal(
    contract.EXTENSION_DOWNLOAD_PATH,
    `/sonli-extension-${manifest.version}.zip`,
  );
  assert.equal(
    contract.EXTENSION_POPUP_PREVIEW_PATH,
    `/sonli-extension-${manifest.version}/popup/popup.html`,
  );

  const previewFile = path.join(
    rootDir,
    "app/public",
    contract.EXTENSION_POPUP_PREVIEW_PATH,
  );
  const previewHtml = readFileSync(previewFile, "utf8");
  assert.match(previewHtml, /请先登录 Web 管理后台，再使用采集功能/);
  assert.doesNotMatch(
    previewHtml,
    /type="password"|sms-phone|sms-code|短信登录|账号登录/,
  );
});

test("extension page capability labels describe capture and auth bridge duties", async () => {
  assert.ok(existsSync(contractPath));
  const { EXTENSION_CAPABILITIES } = await import(pathToFileURL(contractPath));
  assert.equal(Object.isFrozen(EXTENSION_CAPABILITIES), true);
  assert.deepEqual(
    EXTENSION_CAPABILITIES.filter(([, file]) =>
      [
        "content/ozon-seller-bridge.js",
        "background/service-worker.js",
      ].includes(file)),
    [
      ["Seller 页面采集桥", "content/ozon-seller-bridge.js"],
      ["采集会话与上传调度", "background/service-worker.js"],
    ],
  );
  for (const [label] of EXTENSION_CAPABILITIES) {
    assert.doesNotMatch(label, /同步|Cookie/i);
  }
});

test("Web application has no stale popup route or duplicate public plugin surface", () => {
  assert.doesNotMatch(
    appSource,
    /\/plugin\/popup\.html|Seller Cookie 同步|后台同步引擎/,
  );
  assert.match(appSource, /EXTENSION_POPUP_PREVIEW_PATH/);
  assert.match(appSource, /EXTENSION_CAPABILITIES/);
  assert.equal(
    existsSync(path.join(rootDir, "app/public/plugin")),
    false,
    "stale app/public/plugin must not remain deployable",
  );
});
