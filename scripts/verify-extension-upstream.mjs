import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isolatedTestEnvironment } from "./test-environment.mjs";
import { evaluateCheckResult } from "./verify-result-policy.mjs";

const sourceDir = String(process.env.QH_SOURCE_EXTENSION_DIR || "").trim();
let available = false;
try { available = Boolean(sourceDir) && statSync(sourceDir).isDirectory(); } catch { /* Report an unavailable input, not a passed comparison. */ }
if (!available) {
  console.error("未验证：原版扩展对照缺少可读的原包目录。设置 QH_SOURCE_EXTENSION_DIR 后重新运行；日常验证不需要此目录。");
  process.exitCode = 2;
} else {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "sonli-upstream-check-"));
  try {
    const env = isolatedTestEnvironment(process.env, dataDir);
    env.QH_SOURCE_EXTENSION_DIR = path.resolve(sourceDir);
    for (const script of ["check-extension-source-parity.mjs", "check-extension-ui-parity.mjs", "check-extension-diff-contract.mjs"]) {
      console.log(`\n原版扩展对照：${script}`);
      const result = spawnSync(process.execPath, [`scripts/${script}`], {
        cwd: fileURLToPath(new URL("../", import.meta.url)), stdio: "inherit", env,
      });
      const evaluation = evaluateCheckResult(result);
      if (!evaluation.ok) {
        process.exitCode = evaluation.kind === "environment-blocker" ? 2 : 1;
        console.error(`原版扩展对照未通过：${script}（${evaluation.kind}）。`);
        break;
      }
    }
    if (!process.exitCode) console.log("原版扩展对照全部通过。");
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
}
