import { spawnSync } from "node:child_process";
import process from "node:process";
import { activeTestFiles } from "./test-manifest.mjs";

const checks = [
  [
    "App build",
    "node",
    ["node_modules/vite/bin/vite.js", "build"],
    { cwd: "app" },
  ],
  ["Extension source parity", "node", ["scripts/check-extension-source-parity.mjs"]],
  ["Extension UI parity", "node", ["scripts/check-extension-ui-parity.mjs"]],
  ["Extension diff contract", "node", ["scripts/check-extension-diff-contract.mjs"]],
  ["Extension zip parity", "node", ["scripts/check-extension-zip.mjs"]],
  ["Extension zip bridge smoke", "node", ["scripts/check-extension-zip-smoke.mjs"]],
  ["Server syntax", "node", ["--check", "server/index.mjs"]],
  ["Test inventory", "node", ["scripts/check-test-inventory.mjs"]],
  [
    "Complete active test suite",
    "node",
    ["--test", "--test-concurrency=1", ...activeTestFiles],
  ],
  ["Docker compose interpolation", "docker", ["compose", "config", "--quiet"]],
  ["Import history type filter", "node", ["scripts/check-import-history-types.mjs"]],
  ["Plugin readiness gate", "node", ["scripts/check-plugin-readiness-gate.mjs"]],
  ["Collect edit listing contract", "node", ["scripts/check-collect-edit-listing-contract.mjs"]],
  ["Collect box delete persistence", "node", ["scripts/check-collect-delete-persistence.mjs"]],
  ["Operating store data isolation", "node", ["scripts/check-store-data-isolation.mjs"]],
  ["Bridge syntax", "node", ["--check", "extension/content/jizhangerp-bridge.js"]],
  ["Manifest JSON", "node", ["-e", "JSON.parse(require('fs').readFileSync('extension/manifest.json','utf8')); console.log('manifest ok')"]],
  ["Diff whitespace", "git", ["diff", "--check", "--", "app/src", "app/tests", "server", "extension", "app/public"]],
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
  const resolvedCommand = command === "node" ? process.execPath : command;
  const result = spawnSync(resolvedCommand, args, {
    stdio: "inherit",
    env: process.env,
    shell: false,
    cwd: options.cwd || process.cwd(),
  });
  if (result.error) {
    failed += 1;
    const kind = result.error.code === "ENOENT" ? "blocked by missing command" : "could not start";
    console.error(`\n${label} ${kind}: ${result.error.message}`);
    continue;
  }
  if (result.signal) {
    failed += 1;
    console.error(`\n${label} terminated by signal ${result.signal}`);
    continue;
  }
  const code = result.status ?? 1;
  if (code !== 0 && code !== options.allowExitCode) {
    failed += 1;
    const kind = code === 2 ? "blocked by environment" : "failed";
    console.error(`\n${label} ${kind} with exit code ${code}`);
  }
}

if (failed) {
  console.error(`\n${failed} verification check(s) failed.`);
  process.exit(1);
}

console.log("\nAll verification checks passed.");
