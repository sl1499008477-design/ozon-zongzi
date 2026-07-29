import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { requireExtensionUpstreamDir } from "./extension-upstream-config.mjs";

const sourceDir = requireExtensionUpstreamDir("scripts/check-extension-source-parity.mjs");
if (!sourceDir) process.exit(2);
const localDir = process.env.QH_LOCAL_EXTENSION_DIR || "extension";

const allowedDiffs = new Set([
  "background/__tests__/dedupe.smoke.test.js",
  "background/service-worker.js",
  "background/sync/backend-client.js",
  "background/sync/sync-engine.js",
  "batch-upload/index.html",
  "batch-upload/index.js",
  "content/alibaba-1688.js",
  "content/1688-ai-wizard.js",
  "content/jizhangerp-bridge.js",
  "content/jzc-calc.js",
  "content/ozon-data-panel.js",
  "content/ozon-premium-hook.js",
  "content/ozon-product.js",
  "content/ozon-search.js",
  "content/shared-utils.js",
  "content/sync-auth.js",
  "icons/icon128.png",
  "icons/icon16.png",
  "icons/icon48.png",
  "lib/cn-source-panel.js",
  "manifest.json",
  "popup/popup.html",
  "popup/popup.css",
  "popup/popup.js",
  "tests/fleet-collect-attrs-merge.test.js",
]);

const allowedLocalOnly = new Set([
  "background/__tests__/fx-probe.smoke.test.js",
  "background/__tests__/follow-sell-dry-run-route.test.js",
  "icons/sonli-logo.png",
  "lib/category-readiness.js",
  "lib/chrome-storage-promises.js",
  "lib/collector-session.js",
  "lib/fx-probe.js",
  "lib/fx-observation-replay.js",
  "lib/portal-bridge-policy.js",
  "lib/pricing-config-cache.js",
  "lib/seller-identity-policy.js",
  "lib/web-bridge-policy.js",
  "package.json",
  "popup/__tests__/popup-routing.smoke.test.js",
  "tests/category-readiness.test.js",
  "tests/chrome-storage-promises.test.js",
  "tests/collector-session.test.js",
  "tests/collector-removed.test.js",
  "tests/fx-observation-replay.test.js",
  "tests/jizhangerp-bridge-follow-sell.test.js",
  "tests/manifest-security-contract.test.js",
  "tests/portal-bridge-policy.test.js",
  "tests/pricing-config-cache-policy.test.js",
  "tests/seller-identity-policy.test.js",
  "tests/web-bridge-policy.test.js",
]);

const removedCollectorFiles = new Set([
  "content/collector/anti-ban.js",
  "content/collector/auto-scroller.js",
  "content/collector/db.js",
  "content/collector/keyword-pilot.js",
  "content/collector/panel.css",
  "content/collector/panel.js",
  "tests/collector-manual-start.test.js",
  "tests/keyword-pilot-ownership.test.js",
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

const localFiles = new Set(walk(localDir));
const localManifest = JSON.parse(readFileSync(path.join(localDir, "manifest.json"), "utf8"));
assert.equal(localManifest.name, "sonli");
assert.equal(localManifest.description, "sonli");
assert.equal(localManifest.update_url, undefined);
assert.equal(localManifest.action?.default_title, "sonli");
assert.ok(localManifest.host_permissions.includes("http://localhost:3000/*"));
assert.ok(localManifest.host_permissions.includes("http://store.localhost:3000/*"));
assert.ok(localManifest.host_permissions.includes("http://127.0.0.1:3000/*"));
assert.ok(!localManifest.host_permissions.some((pattern) => pattern.includes(":5173")));
assert.ok(!localManifest.host_permissions.some((pattern) => pattern.includes(":3001")));

const bridgeScript = localManifest.content_scripts.find((script) =>
  script.matches?.includes("http://127.0.0.1:3000/*") && script.js?.includes("content/jizhangerp-bridge.js"),
);
assert.ok(bridgeScript, "local sonli bridge content script missing");
assert.ok(bridgeScript.matches.includes("http://localhost:3000/*"));
assert.ok(bridgeScript.matches.includes("http://store.localhost:3000/*"));
assert.deepEqual(bridgeScript.js, [
  "lib/follow-sell-content-copy.js",
  "lib/v3-payload.js",
  "lib/sku-collect.js",
  "lib/portal-bridge-policy.js",
  "content/jizhangerp-bridge.js",
]);

const bridgeSource = readFileSync(path.join(localDir, "content/jizhangerp-bridge.js"), "utf8");
assert.match(bridgeSource, /follow-sell\.request/);
assert.match(bridgeSource, /dryRun:\s*!!payload\?\.dryRun/);
assert.match(bridgeSource, /localListingBridge:\s*true/);
assert.match(bridgeSource, /dryRunPreview:\s*true/);

const upstreamAvailable = existsSync(sourceDir) && statSync(sourceDir).isDirectory();
if (!upstreamAvailable) {
  console.error(`upstream extension parity blocked: ${sourceDir} not found`);
} else {
  const sourceFiles = new Set(walk(sourceDir));
  const problems = [];

  for (const rel of sourceFiles) {
    if (removedCollectorFiles.has(rel)) continue;
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
    throw new Error(`extension upstream parity failed:\n${problems.join("\n")}`);
  }

  const sourceManifest = JSON.parse(readFileSync(path.join(sourceDir, "manifest.json"), "utf8"));
  assert.equal(localManifest.version, sourceManifest.version);
  assert.deepEqual(localManifest.permissions, sourceManifest.permissions);
  assert.equal(localManifest.content_scripts.length, sourceManifest.content_scripts.length);
  console.log(`extension upstream parity ok against ${sourceDir}`);
}

const distributionDir =
  process.env.QH_DISTRIBUTED_EXTENSION_DIR
  || path.join("app", "public", `sonli-extension-${localManifest.version}`);
assert.ok(
  existsSync(distributionDir) && statSync(distributionDir).isDirectory(),
  `unpacked extension distribution missing: ${distributionDir}`,
);

const distributionFiles = new Set(walk(distributionDir));
const distributionProblems = [];
for (const rel of localFiles) {
  if (!distributionFiles.has(rel)) {
    distributionProblems.push(`missing distribution file: ${rel}`);
  } else if (hashFile(path.join(localDir, rel)) !== hashFile(path.join(distributionDir, rel))) {
    distributionProblems.push(`stale distribution file: ${rel}`);
  }
}
for (const rel of distributionFiles) {
  if (!localFiles.has(rel)) distributionProblems.push(`unexpected distribution file: ${rel}`);
}

if (distributionProblems.length) {
  throw new Error(`extension distribution parity failed:\n${distributionProblems.join("\n")}`);
}

console.log(`extension distribution parity ok against ${distributionDir}`);
if (!upstreamAvailable) process.exitCode = 2;
