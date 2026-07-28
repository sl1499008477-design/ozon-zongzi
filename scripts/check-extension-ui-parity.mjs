import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { requireExtensionUpstreamDir } from "./extension-upstream-config.mjs";

const sourceDir = requireExtensionUpstreamDir("scripts/check-extension-ui-parity.mjs");
if (!sourceDir) process.exit(2);
const localDir = "extension";

const exactUiFiles = [
  "batch-upload/index.css",
  "content/jzc-calc.css",
  "content/ozon-product.css",
  "content/ozon-search.css",
  "lib/store-picker.css",
];

const hashFile = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

const requireExistingSource = () => {
  if (!existsSync(sourceDir) || !statSync(sourceDir).isDirectory()) {
    console.error(`extension ui parity blocked: ${sourceDir} not found`);
    process.exit(2);
  }
};

const assertSameFile = (rel) => {
  const source = path.join(sourceDir, rel);
  const local = path.join(localDir, rel);
  assert.ok(existsSync(source), `source UI file missing: ${rel}`);
  assert.ok(existsSync(local), `local UI file missing: ${rel}`);
  assert.equal(hashFile(local), hashFile(source), `extension UI file must match source exactly: ${rel}`);
};

const assertPng = (rel, width, height) => {
  const file = path.join(localDir, rel);
  assert.ok(existsSync(file), `local PNG missing: ${rel}`);
  const bytes = readFileSync(file);
  assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", `invalid PNG signature: ${rel}`);
  assert.equal(bytes.readUInt32BE(16), width, `unexpected PNG width: ${rel}`);
  assert.equal(bytes.readUInt32BE(20), height, `unexpected PNG height: ${rel}`);
};

const normalizeBatchUploadHtml = (source) => source.split("sonli").join("QH");

const normalizeBatchUploadJs = (source) =>
  source
    .split("sonli")
    .join("QH")
    .replace("document.title：brand 占位符", "document.title：QH 占位符");

const normalizePopupHtml = (source) =>
  source
    .split("sonli")
    .join("QH")
    .replace(
      '<div class="login-tabs" style="display:none;">\n' +
        '            <button class="tab-btn" data-tab="sms">短信登录</button>\n' +
        '            <button class="tab-btn active" data-tab="password">账号登录</button>\n' +
        "          </div>",
      '<div class="login-tabs">\n' +
        '            <button class="tab-btn active" data-tab="sms">短信登录</button>\n' +
        '            <button class="tab-btn" data-tab="password">密码登录</button>\n' +
        "          </div>",
    )
    .replace('<div class="tab-panel" id="tab-sms">', '<div class="tab-panel active" id="tab-sms">')
    .replace('<div class="tab-panel active" id="tab-password">', '<div class="tab-panel" id="tab-password">')
    .replace(
      '<span>账号</span>\n' +
        '              <input type="text" id="login-phone" placeholder="请输入管理员分配的账号" autocomplete="username" />',
      '<span>手机号</span>\n' +
        '              <input type="tel" id="login-phone" placeholder="请输入手机号" autocomplete="tel" />',
    );

const normalizePopupJs = (source) =>
  source
    .replace("(store.jizhangerp.com / sonli)", "(store.jizhangerp.com / 极掌)")
    .replace(
      '  const BRAND_DISPLAY_NAME = _brandFallback("sonli", "sonli");\n',
      '  const BRAND_DISPLAY_NAME = _brandFallback("QH", "极掌");\n',
    )
    .replace("popup.html 里的 brand 静态占位符", "popup.html 里的 QH 静态占位符")
    .replace(
      '  const LOCAL_FRONTEND_BASE_URL = "http://127.0.0.1:3000";\n' +
        '  const isLocalBackendUrl = (value) => /^http:\\/\\/127\\.0\\.0\\.1:3000\\/api\\b/.test(String(value || ""));\n',
      "",
    )
    .replace('      showTip("请输入账号");', '      showTip("请输入手机号");')
    .replace('        err.includes("[403]") ||\n', "")
    .replace('        err.includes("未登录") ||\n', "")
    .replace('        err.includes("过期") ||\n', "")
    .replace('        err.includes("停用") ||\n', "")
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

assertPng("icons/icon16.png", 16, 16);
assertPng("icons/icon48.png", 48, 48);
assertPng("icons/icon128.png", 128, 128);
assertPng("icons/sonli-logo.png", 1254, 1254);

const popupHtml = readFileSync(path.join(localDir, "popup/popup.html"), "utf8");
const popupJs = readFileSync(path.join(localDir, "popup/popup.js"), "utf8");
const popupCss = readFileSync(path.join(localDir, "popup/popup.css"), "utf8");
assert.match(popupHtml, /打开 sonli ERP/);
assert.doesNotMatch(popupHtml, /sonli 采集器|采集器实时状态/);
assert.doesNotMatch(popupJs, /toggleCollector|collectorGetState/);
assert.doesNotMatch(popupCss, /\.collector-mon/);

assert.equal(
  normalizeBatchUploadHtml(readFileSync(path.join(localDir, "batch-upload/index.html"), "utf8")),
  readFileSync(path.join(sourceDir, "batch-upload/index.html"), "utf8"),
  "batch-upload/index.html must only differ by sonli branding substitutions",
);

assert.equal(
  normalizeBatchUploadJs(readFileSync(path.join(localDir, "batch-upload/index.js"), "utf8")),
  readFileSync(path.join(sourceDir, "batch-upload/index.js"), "utf8"),
  "batch-upload/index.js must only differ by sonli branding substitutions",
);

assert.match(popupJs, /LOCAL_FRONTEND_BASE_URL = "http:\/\/127\.0\.0\.1:3000"/);

console.log(`extension ui parity ok against ${sourceDir}`);
