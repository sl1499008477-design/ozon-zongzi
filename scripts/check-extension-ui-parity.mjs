import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const sourceDir = process.env.QH_SOURCE_EXTENSION_DIR || "/Users/songliang/Desktop/0.13.46.1";
const localDir = "extension";

const exactUiFiles = [
  "popup/popup.html",
  "popup/popup.css",
  "icons/icon16.png",
  "icons/icon48.png",
  "icons/icon128.png",
  "batch-upload/index.html",
  "batch-upload/index.css",
  "batch-upload/index.js",
  "content/jzc-calc.css",
  "content/ozon-product.css",
  "content/ozon-search.css",
  "content/collector/panel.css",
  "lib/store-picker.css",
];

const hashFile = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

const requireExistingSource = () => {
  if (!existsSync(sourceDir) || !statSync(sourceDir).isDirectory()) {
    console.log(`extension ui parity skipped: ${sourceDir} not found`);
    process.exit(0);
  }
};

const assertSameFile = (rel) => {
  const source = path.join(sourceDir, rel);
  const local = path.join(localDir, rel);
  assert.ok(existsSync(source), `source UI file missing: ${rel}`);
  assert.ok(existsSync(local), `local UI file missing: ${rel}`);
  assert.equal(hashFile(local), hashFile(source), `extension UI file must match source exactly: ${rel}`);
};

const normalizePopupJs = (source) =>
  source
    .replace(
      '  const LOCAL_FRONTEND_BASE_URL = "http://127.0.0.1:5173";\n' +
        '  const isLocalBackendUrl = (value) => /^(?:http:\\/\\/)?(?:localhost|127\\.0\\.0\\.1):3001\\b/.test(String(value || ""));\n',
      "",
    )
    .replace(
      '  let FRONTEND_BASE_URL = LOCAL_FRONTEND_BASE_URL;',
      '  let FRONTEND_BASE_URL = "https://" + BRAND_WEB_HOST;',
    )
    .replace(
      '      auth.backendUrl && isLocalBackendUrl(auth.backendUrl)\n' +
        "        ? LOCAL_FRONTEND_BASE_URL",
      '      auth.backendUrl && auth.backendUrl.includes("localhost")\n' +
        '        ? "http://store.localhost:3000"',
    )
    .replace(
      "    chrome.tabs.create({ url: `${FRONTEND_BASE_URL}/ozon/dashboard/` });",
      "    chrome.tabs.create({ url: `${FRONTEND_BASE_URL}/login` });",
    );

requireExistingSource();

for (const rel of exactUiFiles) assertSameFile(rel);

const sourcePopup = readFileSync(path.join(sourceDir, "popup/popup.js"), "utf8");
const localPopup = readFileSync(path.join(localDir, "popup/popup.js"), "utf8");
assert.equal(
  normalizePopupJs(localPopup),
  sourcePopup,
  "popup.js must only differ by local frontend/backend routing substitutions",
);

console.log(`extension ui parity ok against ${sourceDir}`);
