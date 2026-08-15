import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import {
  assertCaptureOnlyFileSet,
  assertCaptureOnlyPermissionPolicy,
  assertCaptureOnlyServiceWorker,
  assertPopupWebLoginGuidance,
} from "./extension-capture-only-policy.mjs";
import {
  assertCompatibleExtensionVersions,
  requireExtensionUpstreamDir,
} from "./extension-upstream-config.mjs";

const sourceDir = requireExtensionUpstreamDir("scripts/check-extension-source-parity.mjs");
if (!sourceDir) process.exit(2);
const localDir = process.env.QH_LOCAL_EXTENSION_DIR || "extension";

const allowedDiffs = new Set([
  "background/service-worker.js",
  "batch-upload/index.html",
  "batch-upload/index.js",
  "content/alibaba-1688.js",
  "content/1688-ai-wizard.js",
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
  "lib/cn-source-scraper.js",
  "lib/store-picker.js",
  "manifest.json",
  "popup/popup.html",
  "popup/popup.css",
  "popup/popup.js",
  "tests/fleet-collect-attrs-merge.test.js",
]);

const allowedLocalOnly = new Set([
  "background/__tests__/fx-probe.smoke.test.js",
  "background/__tests__/follow-sell-dry-run-route.test.js",
  // Task 4 reviewed follow-sell removal boundary coverage and route module.
  "background/__tests__/follow-sell-watermark-boundary.test.js",
  "background/follow-sell-request.js",
  "background/collector-client.js",
  "background/collector-ozon-enrichment-agent.js",
  "background/collector-ozon-enrichment-client.js",
  "content/seller-company-context-hook.js",
  "icons/ozon-zongzi-logo-dark.svg",
  "icons/ozon-zongzi-logo-mono.svg",
  "icons/ozon-zongzi-logo-primary.svg",
  "icons/ozon-zongzi-logo-white.svg",
  "icons/ozon-zongzi-symbol.svg",
  "icons/sonli-logo.png",
  "lib/category-readiness.js",
  "lib/category-strategy-handoff.js",
  "lib/category-strategy-sampling.js",
  "lib/chrome-storage-promises.js",
  "lib/collector-auth-flow.js",
  "lib/collector-capture-deadline.js",
  "lib/collector-session.js",
  "lib/frontend-tab-opener.js",
  "lib/ozon-collect-coordinator.js",
  "lib/ozon-enrichment-contract.js",
  "lib/fx-probe.js",
  "lib/fx-observation-replay.js",
  "lib/portal-bridge-policy.js",
  "lib/pricing-config-cache.js",
  "lib/seller-identity-policy.js",
  "lib/seller-company-context.js",
  "lib/seller-company-context-runtime.js",
  "lib/seller-recovery-tab.js",
  "lib/seller-context-status-controller.js",
  "lib/seller-context-ui-message-policy.js",
  "lib/web-bridge-policy.js",
  "package.json",
  "popup/__tests__/popup-routing.smoke.test.js",
  "popup/__tests__/popup-collector-session.runtime.test.js",
  "tests/category-readiness.test.js",
  "tests/category-strategy-handoff.test.js",
  "tests/category-strategy-sampling.test.js",
  "tests/chrome-storage-promises.test.js",
  "tests/collector-auth-flow.test.js",
  "tests/collector-capture-deadline.test.js",
  "tests/collector-session.test.js",
  "tests/collector-ozon-enrichment-client.test.js",
  "tests/ozon-collect-coordinator.test.js",
  "tests/collector-removed.test.js",
  "tests/data-panel-logistics.test.js",
  "tests/data-panel-visual-browser.test.js",
  "tests/fixtures/data-panel-visual-browser.fixture.html",
  "tests/frontend-tab-opener.test.js",
  "tests/fx-observation-replay.test.js",
  "tests/jizhangerp-bridge-follow-sell.test.js",
  "tests/manifest-security-contract.test.js",
  "tests/brand-contract.test.js",
  "tests/brand-fallback-runtime.test.js",
  "tests/market-item-normalization.test.js",
  "tests/no-unreachable-local-functions.test.js",
  "tests/ozon-enrichment-contract.test.js",
  "tests/ozon-product-panel-boundary.test.js",
  "tests/ozon-product-complete-collection.test.js",
  "tests/ozon-search-complete-collection.test.js",
  "tests/helpers/chrome-match-pattern.js",
  "tests/portal-bridge-policy.test.js",
  "tests/pricing-config-cache-policy.test.js",
  "tests/seller-identity-policy.test.js",
  "tests/seller-company-context-contract.test.js",
  "tests/seller-company-context.test.js",
  "tests/seller-context-status-controller.test.js",
  "tests/seller-context-ui-message-policy.test.js",
  "tests/sync-auth-runtime.test.js",
  "tests/sync-capability-removed.test.js",
  "tests/removed-selection-watermark-contract.test.js",
  "tests/ui-parity-exception-gate.test.js",
  "tests/web-bridge-policy.test.js",
]);

const intentionallyRetiredFiles = new Set([
  "background/__tests__/dedupe.smoke.test.js",
  "background/__tests__/agent-actions.smoke.test.js",
  "background/agent/actions.js",
  "background/agent/agent-runtime.js",
  "background/agent/collect-actions.js",
  "background/agent/listing-actions.js",
  "background/sync/backend-client.js",
  "background/sync/diff-index.js",
  "background/sync/lease-client.js",
  "background/sync/opi-client.js",
  "background/sync/sync-engine.js",
  "background/sync/sync-state.js",
  "content/collector/anti-ban.js",
  "content/collector/auto-scroller.js",
  "content/collector/db.js",
  "content/collector/keyword-pilot.js",
  "content/collector/panel.css",
  "content/collector/panel.js",
  "content/ozon-bestsellers-hook.js",
  "lib/watermark-templates.js",
  "popup/__tests__/browser-agent-popup.smoke.test.js",
  "tests/collector-manual-start.test.js",
  "tests/keyword-pilot-ownership.test.js",
  "tests/postings-manual-sync-window.test.js",
  "tests/sync-state-watermark.test.js",
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
assertCaptureOnlyFileSet(localFiles);
assert.ok(
  localFiles.has("background/__tests__/follow-sell-watermark-boundary.test.js"),
  "reviewed follow-sell removal boundary test missing",
);
assert.ok(
  localFiles.has("background/follow-sell-request.js"),
  "reviewed follow-sell request module missing",
);
assert.doesNotMatch(
  readFileSync(path.join(localDir, "content/ozon-bff-interceptor.js"), "utf8"),
  /ozon-bestsellers-hook/,
  "retired bestsellers hook reference must not remain in the BFF protocol comment",
);
const localManifest = JSON.parse(readFileSync(path.join(localDir, "manifest.json"), "utf8"));
assert.equal(localManifest.name, "ozon 粽子");
assert.equal(localManifest.description, "ozon 粽子 · Ozon 选品采集与运营助手");
assert.equal(localManifest.update_url, undefined);
assert.equal(localManifest.action?.default_title, "ozon 粽子");
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
  "lib/category-strategy-handoff.js",
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
assertCaptureOnlyServiceWorker(
  readFileSync(path.join(localDir, "background/service-worker.js"), "utf8"),
);
assertPopupWebLoginGuidance(
  readFileSync(path.join(localDir, "popup/popup.html"), "utf8"),
  readFileSync(path.join(localDir, "popup/popup.js"), "utf8"),
  readFileSync(path.join(localDir, "background/service-worker.js"), "utf8"),
);

const upstreamAvailable = existsSync(sourceDir) && statSync(sourceDir).isDirectory();
if (!upstreamAvailable) {
  console.error(`upstream extension parity blocked: ${sourceDir} not found`);
} else {
  const sourceFiles = new Set(walk(sourceDir));
  const problems = [];

  for (const rel of sourceFiles) {
    if (intentionallyRetiredFiles.has(rel)) continue;
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
  assertCompatibleExtensionVersions(localManifest.version, sourceManifest.version);
  assertCaptureOnlyPermissionPolicy(localManifest, sourceManifest);
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
