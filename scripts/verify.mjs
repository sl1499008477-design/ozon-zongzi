import { spawnSync } from "node:child_process";
import process from "node:process";

const checks = [
  ["App build", "pnpm", ["--dir", "app", "build"]],
  ["Extension source parity", "node", ["scripts/check-extension-source-parity.mjs"]],
  ["Extension UI parity", "node", ["scripts/check-extension-ui-parity.mjs"]],
  ["Extension diff contract", "node", ["scripts/check-extension-diff-contract.mjs"]],
  ["Extension zip parity", "node", ["scripts/check-extension-zip.mjs"]],
  ["Extension zip bridge smoke", "node", ["scripts/check-extension-zip-smoke.mjs"]],
  ["Server syntax", "node", ["--check", "server/index.mjs"]],
  ["Frontend compatibility proxy syntax", "node", ["--check", "scripts/frontend-compat-proxy.mjs"]],
  ["Ozon import normalizer smoke", "node", ["server/tests/ozon-import-normalizer.test.mjs"]],
  ["Ozon import preview route smoke", "node", ["server/tests/import-preview-route.test.mjs"]],
  ["Ozon import currency contract smoke", "node", ["server/tests/import-currency-contract.test.mjs"]],
  ["Import history type filter", "node", ["scripts/check-import-history-types.mjs"]],
  ["Plugin readiness gate", "node", ["scripts/check-plugin-readiness-gate.mjs"]],
  ["Collect edit listing contract", "node", ["scripts/check-collect-edit-listing-contract.mjs"]],
  ["Bridge syntax", "node", ["--check", "extension/content/jizhangerp-bridge.js"]],
  ["Manifest JSON", "node", ["-e", "JSON.parse(require('fs').readFileSync('extension/manifest.json','utf8')); console.log('manifest ok')"]],
  ["Bridge follow-sell smoke", "node", ["extension/tests/jizhangerp-bridge-follow-sell.test.js"]],
  ["Service worker dryRun route guard", "node", ["extension/background/__tests__/follow-sell-dry-run-route.test.js"]],
  ["Batch upload price smoke", "node", ["extension/tests/batch-upload-preview-price-align.test.js"]],
  ["Popup browser-agent smoke", "node", ["extension/popup/__tests__/browser-agent-popup.smoke.test.js"]],
  ["Popup routing smoke", "node", ["extension/popup/__tests__/popup-routing.smoke.test.js"]],
  ["Diff whitespace", "git", ["diff", "--check", "--", "app/src/App.jsx", "server/index.mjs", "extension", "app/public"]],
  [
    "Credential literal scan",
    "rg",
    [
      "-n",
      "-i",
      "(api[-_ ]?key|apikey|client[-_ ]?id).{0,80}([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9]{6,})",
      "app/src",
      "server",
      "extension",
      "scripts",
      "README.md",
      "design-qa.md",
      "package.json",
    ],
    { allowExitCode: 1 },
  ],
];

let failed = 0;

for (const [label, command, args, options = {}] of checks) {
  console.log(`\n== ${label} ==`);
  const result = spawnSync(command, args, {
    stdio: "inherit",
    env: process.env,
    shell: false,
  });
  const code = result.status ?? (result.error ? 1 : 0);
  if (code !== 0 && code !== options.allowExitCode) {
    failed += 1;
    console.error(`\n${label} failed with exit code ${code}`);
  }
}

if (failed) {
  console.error(`\n${failed} verification check(s) failed.`);
  process.exit(1);
}

console.log("\nAll verification checks passed.");
