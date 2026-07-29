import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { assertPopupWebLoginGuidance } from "./extension-capture-only-policy.mjs";
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

requireExistingSource();

for (const rel of exactUiFiles) assertSameFile(rel);

assertPng("icons/icon16.png", 16, 16);
assertPng("icons/icon48.png", 48, 48);
assertPng("icons/icon128.png", 128, 128);
assertPng("icons/sonli-logo.png", 1254, 1254);

const popupHtml = readFileSync(path.join(localDir, "popup/popup.html"), "utf8");
const popupJs = readFileSync(path.join(localDir, "popup/popup.js"), "utf8");
const popupCss = readFileSync(path.join(localDir, "popup/popup.css"), "utf8");
assertPopupWebLoginGuidance(popupHtml, popupJs);
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

console.log(`extension ui parity ok against ${sourceDir}`);
