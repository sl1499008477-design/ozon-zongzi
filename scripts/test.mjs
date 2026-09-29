import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { activeTestFiles } from "./test-manifest.mjs";
import { isolatedTestEnvironment } from "./test-environment.mjs";
import { UPSTREAM_PARITY_NOTICE } from "./extension-upstream-config.mjs";

console.log(UPSTREAM_PARITY_NOTICE);
const dataDir = mkdtempSync(path.join(os.tmpdir(), "sonli-tests-"));
try {
  const selection = process.argv.slice(2);
  const files = selection.filter((arg) => !arg.startsWith("-"));
  if (files.some((file) => !/\.[cm]?js$/.test(file))) {
    console.error("请传入明确的 JS 测试文件；带值选项请使用 --选项=值，例如 --test-reporter=spec。");
    process.exitCode = 1;
  } else {
    const result = spawnSync(process.execPath, [
      "--test", "--test-concurrency=1", ...selection, ...(files.length ? [] : activeTestFiles),
    ], { stdio: "inherit", env: isolatedTestEnvironment(process.env, dataDir) });
    if (result.error) console.error(`测试进程未能启动：${result.error.code || "UNKNOWN"}`);
    process.exitCode = result.status ?? 1;
  }
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}
