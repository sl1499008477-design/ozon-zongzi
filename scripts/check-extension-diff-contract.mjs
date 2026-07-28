import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { requireExtensionUpstreamDir } from "./extension-upstream-config.mjs";

const sourceDir = requireExtensionUpstreamDir("scripts/check-extension-diff-contract.mjs");
if (!sourceDir) process.exit(2);
const localDir = "extension";

const diffContract = {
  "background/__tests__/dedupe.smoke.test.js": { hunks: 9, added: 42, removed: 5 },
  "background/service-worker.js": { hunks: 51, added: 428, removed: 169 },
  "background/sync/backend-client.js": { hunks: 4, added: 4, removed: 4 },
  "background/sync/sync-engine.js": { hunks: 3, added: 10, removed: 1 },
  "batch-upload/index.html": { hunks: 4, added: 4, removed: 4 },
  "batch-upload/index.js": { hunks: 4, added: 5, removed: 5 },
  "content/alibaba-1688.js": { hunks: 3, added: 3, removed: 7 },
  "content/1688-ai-wizard.js": { hunks: 55, added: 208, removed: 35 },
  "content/jizhangerp-bridge.js": { hunks: 5, added: 111, removed: 3 },
  "content/jzc-calc.js": { hunks: 3, added: 7, removed: 13 },
  "content/ozon-data-panel.js": { hunks: 18, added: 4, removed: 490 },
  "content/ozon-premium-hook.js": { hunks: 2, added: 2, removed: 2 },
  "content/ozon-product.js": { hunks: 43, added: 225, removed: 144 },
  "content/ozon-search.js": { hunks: 22, added: 5, removed: 681 },
  "content/shared-utils.js": { hunks: 7, added: 9, removed: 13 },
  "content/sync-auth.js": { hunks: 4, added: 34, removed: 38 },
  "icons/icon128.png": { hunks: 0, added: 0, removed: 0 },
  "icons/icon16.png": { hunks: 0, added: 0, removed: 0 },
  "icons/icon48.png": { hunks: 0, added: 0, removed: 0 },
  "lib/cn-source-panel.js": { hunks: 6, added: 6, removed: 10 },
  "manifest.json": { hunks: 20, added: 17, removed: 22 },
  "popup/popup.css": { hunks: 285, added: 812, removed: 600 },
  "popup/popup.html": { hunks: 24, added: 118, removed: 110 },
  "popup/popup.js": { hunks: 38, added: 88, removed: 133 },
  "tests/fleet-collect-attrs-merge.test.js": { hunks: 6, added: 80, removed: 31 },
};

const requiredPatterns = {
  "background/__tests__/dedupe.smoke.test.js": [
    /jz-collect-recent-v2/,
    /不同登录账号的同一 SKU 不去重/,
    /不同数据采集店铺的同一 SKU 不去重/,
  ],
  "background/service-worker.js": [
    /displayName":"sonli"/,
    /const BACKEND_URLS = \['http:\/\/127\.0\.0\.1:3000\/api'\]/,
    /const LOCAL_FRONTEND_BASE_URL = 'http:\/\/127\.0\.0\.1:3000'/,
    /dictionary_value_id: descriptionTypeDictValue/,
    /const deepestCategory = categories\.reduce/,
    /\/ozon\/products\/import\/preview/,
    /if \(importMessage\.dryRun\)/,
    /\/local\/data-collection-stores\/verify/,
    /sellerCompanyIds: sellerLogin\.sellerCompanyIds \|\| \[\]/,
    /case 'getPricingConfig'/,
    /case 'calculatePricing'/,
    /case 'savePricingSnapshot'/,
    /const FX_REFRESH_INTERVAL_MINUTES = 2 \* 60/,
    /'\.\.\/lib\/fx-probe\.js'/,
    /ozon_buyer_bff_variant_frontend/,
    /\/pricing\/fx\/probes\/active/,
    /\/pricing\/fx\/observations/,
    /case 'refreshFxProbes'/,
    /'\.\.\/lib\/web-bridge-policy\.js'/,
    /'\.\.\/lib\/seller-identity-policy\.js'/,
    /'\.\.\/lib\/portal-bridge-policy\.js'/,
    /'\.\.\/lib\/chrome-storage-promises\.js'/,
    /'\.\.\/lib\/fx-observation-replay\.js'/,
    /portalRoute === 'SONLI_WEB_CONTROL'/,
  ],
  "background/sync/backend-client.js": [
    /importPostings\(\{ storeId, leaseId, deviceId, items \}\)/,
    /type: "POSTINGS", leaseId, deviceId, items/,
    /importWarehouses\(\{ storeId, leaseId, deviceId, items \}\)/,
    /type: "WAREHOUSES", leaseId, deviceId, items/,
  ],
  "background/sync/sync-engine.js": [/JzLeaseClient\.acquire\([\s\S]*LEASE_TTL_SECONDS\[type\]/],
  "batch-upload/index.html": [/<title>sonli 批量上架<\/title>/, /未登录 sonli/, /sonli ERP/],
  "batch-upload/index.js": [/DEFAULT_BRAND_DISPLAY_NAME[\s\S]*"sonli"/, /document\.title\.includes\("sonli"\)/],
  "content/alibaba-1688.js": [/displayNameFallback = \/__BRAND\/\.test\("sonli"\)/, /const frontendUrl = 'http:\/\/127\.0\.0\.1:3000'/],
  "content/jizhangerp-bridge.js": [
    /async function handleFollowSell/,
    /action: "followSell"/,
    /dryRun: !!payload\?\.dryRun/,
    /followSell: true/,
    /dryRunPreview: true/,
    /localListingBridge: true/,
    /portalProtocol: "JZ_ERP"/,
  ],
  "content/jzc-calc.js": [
    /DEFAULT_BRAND_DISPLAY_NAME = \/__BRAND\/\.test\('sonli'\)/,
    /const MAIN_EXT_UPDATE_URL = 'http:\/\/127\.0\.0\.1:3000\/api\/extension\/latest'/,
    /const MAIN_EXT_INSTALL_URL_FALLBACK = 'http:\/\/127\.0\.0\.1:3000\/extension'/,
  ],
  "content/ozon-data-panel.js": [/const frontendUrl = "http:\/\/127\.0\.0\.1:3000"/],
  "content/ozon-premium-hook.js": [/apiHost":"127\.0\.0\.1:3000\/api"/, /webHost":"127\.0\.0\.1:3000"/],
  "content/ozon-product.js": [
    /window\.open\('http:\/\/127\.0\.0\.1:3000\/ozon\/dashboard\/', '_blank'\)/,
    /const frontendUrl = 'http:\/\/127\.0\.0\.1:3000'/,
    /sourceVariant: r\.sourceVariant/,
    /sendMessage\('getPricingConfig'/,
    /sendMessage\('calculatePricing'/,
    /panel\.__sonliPricingConfig/,
  ],
  "content/ozon-search.js": [/const frontendUrl = 'http:\/\/127\.0\.0\.1:3000'/],
  "content/shared-utils.js": [/displayName":"sonli"/, /apiHost":"127\.0\.0\.1:3000\/api"/, /webHost":"127\.0\.0\.1:3000"/],
  "content/sync-auth.js": [
    /扩展已重新加载，请刷新当前页面/,
    /if \(!chrome\?\.runtime\?\.id\)/,
    /portalProtocol: 'SONLI_WEB_CONTROL'/,
  ],
  "lib/cn-source-panel.js": [/runtime\.displayName \|\| \(\/__BRAND\/\.test\("sonli"\)/, /const frontendUrl = "http:\/\/127\.0\.0\.1:3000"/],
  "manifest.json": [
    /"name": "sonli"/,
    /"description": "sonli"/,
    /"http:\/\/127\.0\.0\.1:3000\/\*"/,
    /"default_title": "sonli"/,
    /"lib\/follow-sell-content-copy\.js"/,
    /"lib\/v3-payload\.js"/,
    /"lib\/portal-bridge-policy\.js"/,
    /"lib\/web-bridge-policy\.js"/,
    /"lib\/pricing-config-cache\.js"/,
    /"lib\/category-readiness\.js",\s*"content\/1688-ai-wizard\.js"/,
  ],
  "popup/popup.html": [/<title>sonli<\/title>/, /账号登录/, /打开 sonli ERP/],
  "popup/popup.js": [
    /const LOCAL_FRONTEND_BASE_URL = "http:\/\/127\.0\.0\.1:3000"/,
    /const isLocalBackendUrl = \(value\)/,
    /chrome\.tabs\.create\(\{ url: `\$\{FRONTEND_BASE_URL\}\/ozon\/dashboard\/` \}\)/,
  ],
};

const hashFile = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

const walk = (root, current = "") => {
  const abs = path.join(root, current);
  const entries = statSync(abs).isDirectory() ? Array.from(new Set(readdirSync(abs))).sort() : [];
  const files = [];
  for (const name of entries) {
    const rel = path.join(current, name).split(path.sep).join("/");
    const full = path.join(root, rel);
    const stat = statSync(full);
    if (stat.isDirectory()) files.push(...walk(root, rel));
    else if (stat.isFile()) files.push(rel);
  }
  return files;
};

const diffStats = (rel) => {
  const result = spawnSync("diff", ["-U0", path.join(sourceDir, rel), path.join(localDir, rel)], {
    encoding: "utf8",
    shell: false,
  });
  const output = `${result.stdout || ""}${result.stderr || ""}`;
  if (result.status === 0) return { hunks: 0, added: 0, removed: 0, output };
  if (result.status !== 1) throw new Error(`diff failed for ${rel}:\n${output}`);
  let hunks = 0;
  let added = 0;
  let removed = 0;
  for (const line of output.split("\n")) {
    if (line.startsWith("@@")) hunks += 1;
    else if (line.startsWith("+") && !line.startsWith("+++")) added += 1;
    else if (line.startsWith("-") && !line.startsWith("---")) removed += 1;
  }
  return { hunks, added, removed, output };
};

if (!existsSync(sourceDir) || !statSync(sourceDir).isDirectory()) {
  console.error(`extension diff contract blocked: ${sourceDir} not found`);
  process.exit(2);
}

const sourceFiles = new Set(walk(sourceDir));
const localFiles = new Set(walk(localDir));
const changed = [];
for (const rel of sourceFiles) {
  if (!localFiles.has(rel)) continue;
  if (hashFile(path.join(sourceDir, rel)) !== hashFile(path.join(localDir, rel))) changed.push(rel);
}

assert.deepEqual(
  changed.sort(),
  Object.keys(diffContract).sort(),
  "extension changed-file set must match the audited local integration contract",
);

for (const [rel, expected] of Object.entries(diffContract)) {
  const actual = diffStats(rel);
  assert.deepEqual(
    { hunks: actual.hunks, added: actual.added, removed: actual.removed },
    expected,
    `unexpected source/local diff shape for ${rel}`,
  );
  const localSource = readFileSync(path.join(localDir, rel), "utf8");
  for (const pattern of requiredPatterns[rel] || []) {
    assert.match(localSource, pattern, `required local integration pattern missing in ${rel}: ${pattern}`);
  }
}

console.log(`extension diff contract ok against ${sourceDir}`);
