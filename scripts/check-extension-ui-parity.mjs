import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { assertPopupWebLoginGuidance } from "./extension-capture-only-policy.mjs";
import { requireExtensionUpstreamDir } from "./extension-upstream-config.mjs";

const localOnly = process.argv.includes("--local-only");
const sourceDir = localOnly ? null : requireExtensionUpstreamDir("scripts/check-extension-ui-parity.mjs");
if (!localOnly && !sourceDir) process.exit(2);
const localDir = process.env.QH_LOCAL_EXTENSION_DIR || "extension";
const localBaseline = JSON.parse(readFileSync(new URL("./extension-local-ui-baseline.json", import.meta.url), "utf8"));

const exactUiFiles = [
  "batch-upload/index.css",
  "content/jzc-calc.css",
  "lib/store-picker.css",
];

// Preserve original upstream evidence for the independent historical check.
// Local fingerprints have one authority: extension-local-ui-baseline.json.
const reviewedUiFingerprints = new Map([
  [
    "batch-upload/index.html",
    {
      upstream: "cc6d244da650e31d24e38484f9c7ea3d1777f91acfb58d8817efb33117d05a03",
    },
  ],
  [
    "batch-upload/index.js",
    {
      upstream: "d6a6cba6639fecd68965f0a782d4289821b833d2d913e5e59a72bc82193e075e",
    },
  ],
  [
    "content/ozon-product.css",
    {
      upstream: "d10a9c8b0982d0f9637c7a907c665a5c2c070cc289b921d5a9357edbd41c3a44",
    },
  ],
  [
    "content/ozon-search.css",
    {
      // Task 6 replaces the retired generic selection controls with the
      // category-strategy-only sampling, validation/error, and action states.
      upstream: "510c3f330ce5c227733cc8da60499b17c766871408e8380af1078d5ef55a5aba",
    },
  ],
]);

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

const assertReviewedUiDifference = (rel, expected) => {
  const source = path.join(sourceDir, rel);
  const local = path.join(localDir, rel);
  assert.ok(existsSync(source), `source UI file missing: ${rel}`);
  assert.ok(existsSync(local), `local UI file missing: ${rel}`);
  const upstreamHash = hashFile(source);
  const localHash = hashFile(local);
  assert.equal(
    upstreamHash,
    expected.upstream,
    `reviewed upstream UI fingerprint mismatch: ${rel} (upstream full-file hash); review the complete diff before updating`,
  );
  assert.notEqual(
    localHash,
    upstreamHash,
    `reviewed UI exception must remain an explicit full-file difference: ${rel}`,
  );
};

const assertPng = (rel, width, height) => {
  const file = path.join(localDir, rel);
  assert.ok(existsSync(file), `local PNG missing: ${rel}`);
  const bytes = readFileSync(file);
  assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", `invalid PNG signature: ${rel}`);
  assert.equal(bytes.readUInt32BE(16), width, `unexpected PNG width: ${rel}`);
  assert.equal(bytes.readUInt32BE(20), height, `unexpected PNG height: ${rel}`);
};

for (const [rel, expected] of Object.entries(localBaseline.files)) {
  assert.equal(hashFile(path.join(localDir, rel)), expected,
    `reviewed local UI fingerprint mismatch: ${rel} (local full-file hash); review the complete diff before updating`);
}
if (!localOnly) {
  requireExistingSource();
  for (const rel of exactUiFiles) assertSameFile(rel);
  for (const [rel, expected] of reviewedUiFingerprints) assertReviewedUiDifference(rel, expected);
}

assertPng("icons/icon16.png", 16, 16);
assertPng("icons/icon48.png", 48, 48);
assertPng("icons/icon128.png", 128, 128);
assertPng("icons/sonli-logo.png", 1254, 1254);
for (const rel of [
  "icons/ozon-zongzi-logo-primary.svg",
  "icons/ozon-zongzi-symbol.svg",
]) {
  assert.ok(existsSync(path.join(localDir, rel)), `brand SVG missing: ${rel}`);
}

const popupHtml = readFileSync(path.join(localDir, "popup/popup.html"), "utf8");
const popupJs = readFileSync(path.join(localDir, "popup/popup.js"), "utf8");
const popupCss = readFileSync(path.join(localDir, "popup/popup.css"), "utf8");
assertPopupWebLoginGuidance(
  popupHtml,
  popupJs,
  readFileSync(path.join(localDir, "background/service-worker.js"), "utf8"),
);
assert.doesNotMatch(popupHtml, /sonli 采集器|采集器实时状态/);
assert.doesNotMatch(popupJs, /toggleCollector|collectorGetState/);
assert.doesNotMatch(popupCss, /\.collector-mon/);

const productCss = readFileSync(path.join(localDir, "content/ozon-product.css"), "utf8");
const searchCss = readFileSync(path.join(localDir, "content/ozon-search.css"), "utf8");
const batchHtml = readFileSync(path.join(localDir, "batch-upload/index.html"), "utf8");
const batchJs = readFileSync(path.join(localDir, "batch-upload/index.js"), "utf8");

for (const source of [productCss, searchCss, batchHtml, batchJs]) {
  assert.doesNotMatch(
    source,
    /watermark|水印|边框模板|未绑水印|已绑水印/i,
    "retired watermark UI token must not remain",
  );
}
assert.doesNotMatch(
  productCss,
  /选品推荐|recommendation-panel|getRecommendations|fetchBestsellers|reportCategoryMapping|JZC_BESTSELLERS_REPORT/,
  "retired selection UI token must not remain in product styles",
);
assert.doesNotMatch(searchCss, /选品模式/, "retired selection UI token must not remain in search styles");

assert.match(productCss, /ozon-helper-ai-section/);
assert.match(productCss, /is-collected/);
assert.match(searchCss, /「采集」/);
assert.match(batchHtml, /AI 大模型改图/);
assert.match(batchHtml, /SEO/);
assert.match(batchJs, /cfg-ai-poster/);
assert.match(batchJs, /cfg-ai-rewrite/);

console.log(localOnly ? `extension local UI baseline ok: ${localBaseline.id}` : `extension ui parity ok against ${sourceDir}`);
