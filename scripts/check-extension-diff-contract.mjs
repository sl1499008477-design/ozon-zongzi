import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import {
  assertCaptureOnlyFileSet,
  assertCaptureOnlyPermissionPolicy,
  assertCaptureOnlyServiceWorker,
  assertPopupWebLoginGuidance,
} from "./extension-capture-only-policy.mjs";
import { requireExtensionUpstreamDir } from "./extension-upstream-config.mjs";

const sourceDir = requireExtensionUpstreamDir("scripts/check-extension-diff-contract.mjs");
if (!sourceDir) process.exit(2);
const localDir = "extension";

const reviewedChangedFiles = new Set([
  "background/agent/listing-actions.js",
  "background/service-worker.js",
  "batch-upload/index.html",
  "batch-upload/index.js",
  "content/1688-ai-wizard.js",
  "content/alibaba-1688.js",
  // Retires the stale ozon-bestsellers-hook protocol reference in a comment.
  "content/ozon-bff-interceptor.js",
  "content/jizhangerp-bridge.js",
  "content/jzc-calc.js",
  "content/ozon-data-panel.js",
  "content/ozon-premium-hook.js",
  "content/ozon-product.css",
  "content/ozon-product.js",
  "content/ozon-search.css",
  "content/ozon-search.js",
  "content/ozon-seller-bridge.js",
  "content/shared-utils.js",
  "content/sync-auth.js",
  "icons/icon128.png",
  "icons/icon16.png",
  "icons/icon48.png",
  "lib/cn-source-panel.js",
  "lib/store-picker.js",
  "manifest.json",
  "popup/popup.css",
  "popup/popup.html",
  "popup/popup.js",
  "tests/fleet-collect-attrs-merge.test.js",
]);

const walk = (root, current = "") => {
  const abs = path.join(root, current);
  const files = [];
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    const rel = path.join(current, entry.name).split(path.sep).join("/");
    if (entry.isDirectory()) files.push(...walk(root, rel));
    else if (entry.isFile()) files.push(rel);
  }
  return files.sort();
};

const hashFile = (file) =>
  createHash("sha256").update(readFileSync(file)).digest("hex");

if (!existsSync(sourceDir) || !statSync(sourceDir).isDirectory()) {
  console.error(`extension diff contract blocked: ${sourceDir} not found`);
  process.exit(2);
}

const sourceFiles = new Set(walk(sourceDir));
const localFiles = new Set(walk(localDir));
assert.ok(
  localFiles.has("background/__tests__/follow-sell-watermark-boundary.test.js"),
  "reviewed follow-sell removal boundary test missing",
);
assert.ok(
  localFiles.has("background/follow-sell-request.js"),
  "reviewed follow-sell request module missing",
);
const changedSharedFiles = [...sourceFiles].filter(
  (rel) =>
    localFiles.has(rel)
    && hashFile(path.join(sourceDir, rel)) !== hashFile(path.join(localDir, rel)),
);
const unreviewedChanges = changedSharedFiles.filter(
  (rel) => !reviewedChangedFiles.has(rel),
);
assert.deepEqual(
  unreviewedChanges,
  [],
  "extension contains a shared-file change outside the reviewed integration surface",
);

for (const rel of [
  "background/service-worker.js",
  "content/ozon-bff-interceptor.js",
  "manifest.json",
  "popup/popup.html",
  "popup/popup.js",
]) {
  assert.ok(
    changedSharedFiles.includes(rel),
    `capture-only integration must remain explicit in ${rel}`,
  );
}

assert.doesNotMatch(
  readFileSync(path.join(localDir, "content/ozon-bff-interceptor.js"), "utf8"),
  /ozon-bestsellers-hook/,
  "retired bestsellers hook reference must not remain in the BFF protocol comment",
);

const localManifest = JSON.parse(
  readFileSync(path.join(localDir, "manifest.json"), "utf8"),
);
const sourceManifest = JSON.parse(
  readFileSync(path.join(sourceDir, "manifest.json"), "utf8"),
);
assert.equal(localManifest.version, sourceManifest.version);
assertCaptureOnlyPermissionPolicy(localManifest, sourceManifest);
assertCaptureOnlyFileSet(localFiles);
assertCaptureOnlyServiceWorker(
  readFileSync(path.join(localDir, "background/service-worker.js"), "utf8"),
);
assertPopupWebLoginGuidance(
  readFileSync(path.join(localDir, "popup/popup.html"), "utf8"),
  readFileSync(path.join(localDir, "popup/popup.js"), "utf8"),
);

assert.equal(localManifest.name, "sonli");
assert.equal(localManifest.description, "sonli");
assert.equal(localManifest.update_url, undefined);
assert.equal(localManifest.action?.default_title, "sonli");

const bridgeSource = readFileSync(
  path.join(localDir, "content/jizhangerp-bridge.js"),
  "utf8",
);
for (const pattern of [
  /follow-sell\.request/,
  /dryRun:\s*!!payload\?\.dryRun/,
  /followSell:\s*true/,
  /dryRunPreview:\s*true/,
  /localListingBridge:\s*true/,
]) {
  assert.match(bridgeSource, pattern);
}

console.log(`extension capture-only diff contract ok against ${sourceDir}`);
