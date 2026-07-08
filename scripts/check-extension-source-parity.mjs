import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";

const sourceDir = process.env.QH_SOURCE_EXTENSION_DIR || "/Users/songliang/Desktop/0.13.46.1";
const localDir = "extension";

const allowedDiffs = new Set([
  "background/service-worker.js",
  "background/sync/sync-engine.js",
  "batch-upload/index.html",
  "batch-upload/index.js",
  "content/alibaba-1688.js",
  "content/collector/db.js",
  "content/jizhangerp-bridge.js",
  "content/jzc-calc.js",
  "content/ozon-data-panel.js",
  "content/ozon-premium-hook.js",
  "content/ozon-product.js",
  "content/ozon-search.js",
  "content/shared-utils.js",
  "icons/icon128.png",
  "icons/icon16.png",
  "icons/icon48.png",
  "lib/cn-source-panel.js",
  "manifest.json",
  "popup/popup.html",
  "popup/popup.js",
]);

const allowedLocalOnly = new Set([
  "background/__tests__/follow-sell-dry-run-route.test.js",
  "icons/sonli-logo.png",
  "package.json",
  "popup/__tests__/popup-routing.smoke.test.js",
  "tests/jizhangerp-bridge-follow-sell.test.js",
]);

const walk = (root, current = "") => {
  const abs = path.join(root, current);
  const entries = readdirSync(abs, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const rel = path.join(current, entry.name).split(path.sep).join("/");
    if (entry.isDirectory()) {
      files.push(...walk(root, rel));
    } else if (entry.isFile()) {
      files.push(rel);
    }
  }
  return files.sort();
};

const hashFile = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

if (!existsSync(sourceDir) || !statSync(sourceDir).isDirectory()) {
  console.log(`source extension parity skipped: ${sourceDir} not found`);
  process.exit(0);
}

const sourceFiles = new Set(walk(sourceDir));
const localFiles = new Set(walk(localDir));
const problems = [];

for (const rel of sourceFiles) {
  if (!localFiles.has(rel)) {
    problems.push(`missing local file: ${rel}`);
    continue;
  }
  if (hashFile(path.join(sourceDir, rel)) !== hashFile(path.join(localDir, rel)) && !allowedDiffs.has(rel)) {
    problems.push(`unexpected file difference: ${rel}`);
  }
}

for (const rel of localFiles) {
  if (!sourceFiles.has(rel) && !allowedLocalOnly.has(rel)) {
    problems.push(`unexpected local-only file: ${rel}`);
  }
}

if (problems.length) {
  throw new Error(`extension source parity failed:\n${problems.join("\n")}`);
}

const sourceManifest = JSON.parse(readFileSync(path.join(sourceDir, "manifest.json"), "utf8"));
const localManifest = JSON.parse(readFileSync(path.join(localDir, "manifest.json"), "utf8"));
assert.equal(localManifest.name, "sonli");
assert.equal(localManifest.description, "sonli");
assert.equal(localManifest.version, sourceManifest.version);
assert.deepEqual(localManifest.permissions, sourceManifest.permissions);
assert.equal(localManifest.update_url, undefined);
assert.equal(localManifest.action?.default_title, "sonli");
assert.ok(localManifest.host_permissions.includes("http://localhost:3000/*"));
assert.ok(localManifest.host_permissions.includes("http://store.localhost:3000/*"));
assert.ok(localManifest.host_permissions.includes("http://127.0.0.1:5173/*"));
assert.ok(localManifest.host_permissions.includes("http://127.0.0.1:3001/*"));
assert.equal(localManifest.content_scripts.length, sourceManifest.content_scripts.length);

const bridgeScript = localManifest.content_scripts.find((script) =>
  script.matches?.includes("http://127.0.0.1:5173/*") && script.js?.includes("content/jizhangerp-bridge.js"),
);
assert.ok(bridgeScript, "local sonli bridge content script missing");
assert.ok(bridgeScript.matches.includes("http://localhost:3000/*"));
assert.ok(bridgeScript.matches.includes("http://store.localhost:3000/*"));
assert.deepEqual(bridgeScript.js, [
  "lib/follow-sell-content-copy.js",
  "lib/v3-payload.js",
  "lib/sku-collect.js",
  "content/jizhangerp-bridge.js",
]);

const bridgeSource = readFileSync(path.join(localDir, "content/jizhangerp-bridge.js"), "utf8");
assert.match(bridgeSource, /follow-sell\.request/);
assert.match(bridgeSource, /dryRun:\s*!!payload\?\.dryRun/);
assert.match(bridgeSource, /localListingBridge:\s*true/);
assert.match(bridgeSource, /dryRunPreview:\s*true/);

console.log(`extension source parity ok against ${sourceDir}`);
