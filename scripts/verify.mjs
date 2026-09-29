import { spawnSync } from "node:child_process";
import process from "node:process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { activeTestFiles } from "./test-manifest.mjs";
import { evaluateCheckResult } from "./verify-result-policy.mjs";
import { isolatedTestEnvironment } from "./test-environment.mjs";
import { UPSTREAM_PARITY_NOTICE } from "./extension-upstream-config.mjs";

const checks = [
  [
    "App build",
    "node",
    ["node_modules/vite/bin/vite.js", "build"],
    { cwd: "app" },
  ],
  ["Local development entrypoint", "node", ["scripts/check-local-dev-entrypoint.mjs"]],
  ["Extension local source and distribution", "node", ["scripts/check-extension-source-parity.mjs", "--local-only"]],
  ["Extension local UI baseline", "node", ["scripts/check-extension-ui-parity.mjs", "--local-only"]],
  ["Extension zip parity", "node", ["scripts/check-extension-zip.mjs"]],
  ["Extension zip bridge smoke", "node", ["scripts/check-extension-zip-smoke.mjs"]],
  ["Server syntax", "node", ["--check", "server/index.mjs"]],
  ["Test inventory", "node", ["scripts/check-test-inventory.mjs"]],
  [
    "Complete active test suite",
    "node",
    ["--test", "--test-concurrency=1", ...activeTestFiles],
  ],
  [
    "Docker compose interpolation",
    "docker",
    ["compose", "--env-file", "/dev/null", "--file", "docker-compose.yml", "--profile", "application", "config", "--quiet"],
    // Parse all services without reading business secrets or starting containers.
    { env: {
      POSTGRES_PASSWORD: "synthetic-config-only", POSTGRES_PORT: "5432",
      MINIO_ACCESS_KEY: "synthetic-config-only", MINIO_SECRET_KEY: "synthetic-config-only",
      MINIO_PORT: "9000", MINIO_CONSOLE_PORT: "9001",
      APP_ENCRYPTION_KEY: "synthetic-config-only", SONLI_ADMIN_PASSWORD: "synthetic-config-only",
      WEB_PORT: "3000",
    } },
  ],
  ["Import history type filter", "node", ["scripts/check-import-history-types.mjs"]],
  ["Plugin readiness gate", "node", ["scripts/check-plugin-readiness-gate.mjs"]],
  ["Collect edit listing contract", "node", ["scripts/check-collect-edit-listing-contract.mjs"]],
  ["Collect box delete persistence", "node", ["scripts/check-collect-delete-persistence.mjs"]],
  ["Operating store data isolation", "node", ["scripts/check-store-data-isolation.mjs"]],
  ["Bridge syntax", "node", ["--check", "extension/content/jizhangerp-bridge.js"]],
  ["Manifest JSON", "node", ["-e", "JSON.parse(require('fs').readFileSync('extension/manifest.json','utf8')); console.log('manifest ok')"]],
  ["Diff whitespace", "git", ["diff", "--check", "--", "app/src", "app/tests", "server", "extension", "app/public"]],
  [
    "Personal data and credential scan",
    "node",
    ["scripts/check-personal-data.mjs"],
  ],
];

let failed = 0;
console.log(UPSTREAM_PARITY_NOTICE);
const testDataDir = mkdtempSync(path.join(os.tmpdir(), "sonli-verify-"));
const testEnvironment = isolatedTestEnvironment(process.env, testDataDir);

try {
  for (const [label, command, args, options = {}] of checks) {
    console.log(`\n== ${label} ==`);
    const resolvedCommand = command === "node" ? process.execPath : command;
    const result = spawnSync(resolvedCommand, args, {
      stdio: "inherit",
      env: { ...testEnvironment, ...options.env },
      shell: false,
      cwd: options.cwd || process.cwd(),
    });
    const evaluation = evaluateCheckResult(result, options.expectedExitCode ?? 0);
    if (evaluation.ok) continue;

    failed += 1;
    if (evaluation.kind === "missing-command") {
      console.error(`\n${label} blocked by missing command: ${evaluation.detail}`);
    } else if (evaluation.kind === "spawn-error") {
      console.error(`\n${label} could not start: ${evaluation.detail}`);
    } else if (evaluation.kind === "signal") {
      console.error(`\n${label} terminated by signal ${evaluation.detail}`);
    } else if (evaluation.kind === "missing-status") {
      console.error(`\n${label} failed without an exit status`);
    } else if (evaluation.kind === "environment-blocker") {
      console.error(`\n${label} blocked by environment with exit code ${evaluation.code}`);
    } else {
      console.error(`\n${label} failed with exit code ${evaluation.code}`);
    }
  }
} finally {
  rmSync(testDataDir, { recursive: true, force: true });
}

if (failed) {
  console.error(`\n${failed} verification check(s) failed.`);
  process.exit(1);
}

console.log("\n日常验证检查全部通过。原版扩展对照未纳入本次结果。");
