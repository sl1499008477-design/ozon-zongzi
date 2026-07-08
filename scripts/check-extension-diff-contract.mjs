import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const sourceDir = process.env.QH_SOURCE_EXTENSION_DIR || "/Users/songliang/Desktop/0.13.46.1";
const localDir = "extension";

const diffContract = {
  "background/service-worker.js": { hunks: 11, added: 60, removed: 22 },
  "background/sync/sync-engine.js": { hunks: 1, added: 6, removed: 1 },
  "batch-upload/index.html": { hunks: 4, added: 4, removed: 4 },
  "batch-upload/index.js": { hunks: 4, added: 5, removed: 5 },
  "content/alibaba-1688.js": { hunks: 3, added: 3, removed: 7 },
  "content/collector/db.js": { hunks: 1, added: 1, removed: 1 },
  "content/jizhangerp-bridge.js": { hunks: 4, added: 93, removed: 3 },
  "content/jzc-calc.js": { hunks: 3, added: 7, removed: 13 },
  "content/ozon-data-panel.js": { hunks: 1, added: 1, removed: 3 },
  "content/ozon-premium-hook.js": { hunks: 2, added: 2, removed: 2 },
  "content/ozon-product.js": { hunks: 4, added: 3, removed: 6 },
  "content/ozon-search.js": { hunks: 1, added: 1, removed: 4 },
  "content/shared-utils.js": { hunks: 5, added: 7, removed: 11 },
  "icons/icon128.png": { hunks: 0, added: 0, removed: 0 },
  "icons/icon16.png": { hunks: 0, added: 0, removed: 0 },
  "icons/icon48.png": { hunks: 0, added: 0, removed: 0 },
  "lib/cn-source-panel.js": { hunks: 6, added: 6, removed: 10 },
  "manifest.json": { hunks: 8, added: 15, removed: 6 },
  "popup/popup.html": { hunks: 10, added: 14, removed: 14 },
  "popup/popup.js": { hunks: 9, added: 14, removed: 8 },
};

const requiredPatterns = {
  "background/service-worker.js": [
    /displayName":"sonli"/,
    /const BACKEND_URLS = \['http:\/\/localhost:3001', 'http:\/\/127\.0\.0\.1:3001'\]/,
    /const LOCAL_FRONTEND_BASE_URL = 'http:\/\/127\.0\.0\.1:5173'/,
    /dictionary_value_id: descriptionTypeDictValue/,
    /const deepestCategory = categories\.reduce/,
    /\/ozon\/products\/import\/preview/,
    /if \(importMessage\.dryRun\)/,
  ],
  "background/sync/sync-engine.js": [/JzLeaseClient\.acquire\([\s\S]*LEASE_TTL_SECONDS\[type\]/],
  "batch-upload/index.html": [/<title>sonli 批量上架<\/title>/, /未登录 sonli/, /sonli ERP/],
  "batch-upload/index.js": [/DEFAULT_BRAND_DISPLAY_NAME[\s\S]*"sonli"/, /document\.title\.includes\("sonli"\)/],
  "content/alibaba-1688.js": [/displayNameFallback = \/__BRAND\/\.test\("sonli"\)/, /const frontendUrl = 'http:\/\/127\.0\.0\.1:5173'/],
  "content/collector/db.js": [/displayName \|\| 'sonli'/],
  "content/jizhangerp-bridge.js": [
    /async function handleFollowSell/,
    /action: "followSell"/,
    /dryRun: !!payload\?\.dryRun/,
    /followSell: true/,
    /dryRunPreview: true/,
    /localListingBridge: true/,
  ],
  "content/jzc-calc.js": [
    /DEFAULT_BRAND_DISPLAY_NAME = \/__BRAND\/\.test\('sonli'\)/,
    /const MAIN_EXT_UPDATE_URL = 'http:\/\/127\.0\.0\.1:3001\/extension\/latest'/,
    /const MAIN_EXT_INSTALL_URL_FALLBACK = 'http:\/\/127\.0\.0\.1:5173\/extension'/,
  ],
  "content/ozon-data-panel.js": [/const frontendUrl = "http:\/\/127\.0\.0\.1:5173"/],
  "content/ozon-premium-hook.js": [/apiHost":"localhost:3001"/, /webHost":"127\.0\.0\.1:5173"/],
  "content/ozon-product.js": [
    /window\.open\('http:\/\/127\.0\.0\.1:5173\/ozon\/dashboard\/', '_blank'\)/,
    /const frontendUrl = 'http:\/\/127\.0\.0\.1:5173'/,
  ],
  "content/ozon-search.js": [/const frontendUrl = 'http:\/\/127\.0\.0\.1:5173'/],
  "content/shared-utils.js": [/displayName":"sonli"/, /apiHost":"localhost:3001"/, /webHost":"127\.0\.0\.1:5173"/],
  "lib/cn-source-panel.js": [/runtime\.displayName \|\| \(\/__BRAND\/\.test\("sonli"\)/, /const frontendUrl = "http:\/\/127\.0\.0\.1:5173"/],
  "manifest.json": [
    /"name": "sonli"/,
    /"description": "sonli"/,
    /"http:\/\/127\.0\.0\.1:5173\/\*"/,
    /"http:\/\/127\.0\.0\.1:3001\/\*"/,
    /"default_title": "sonli"/,
    /"lib\/follow-sell-content-copy\.js"/,
    /"lib\/v3-payload\.js"/,
  ],
  "popup/popup.html": [/<title>sonli<\/title>/, /账号登录/, /打开 sonli ERP/],
  "popup/popup.js": [
    /const LOCAL_FRONTEND_BASE_URL = "http:\/\/127\.0\.0\.1:5173"/,
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
  console.log(`extension diff contract skipped: ${sourceDir} not found`);
  process.exit(0);
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
