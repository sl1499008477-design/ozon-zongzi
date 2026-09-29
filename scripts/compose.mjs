import "../server/env.mjs";
import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectDir = fileURLToPath(new URL("../", import.meta.url));
const envFile = path.resolve(process.env.SONLI_ENV_FILE || path.join(projectDir, ".env"));
const args = process.argv.slice(2);
const keyFile = process.env.AUTO_LISTING_CREDENTIAL_MASTER_KEY_FILE;
const applicationSelected = args.some((arg, index) =>
  ["api", "worker", "auto-listing-ai-worker", "--profile=application"].includes(arg)
  || (arg === "--profile" && args[index + 1] === "application"))
  || String(process.env.COMPOSE_PROFILES || "").split(",").includes("application");
const needsApplicationKey = applicationSelected
  && args.some((arg) => ["up", "create", "run", "start", "restart", "config"].includes(arg));
if (keyFile && needsApplicationKey) {
  try {
    accessSync(keyFile, constants.R_OK);
    if (!statSync(keyFile).isFile()) throw new Error("not a file");
  } catch {
    throw new Error("凭据主密钥文件不存在或不可读。请检查配置文件相对路径；不要重新生成密钥。");
  }
}
const result = spawnSync("docker", [
  "compose", "--project-directory", projectDir, "--file", path.join(projectDir, "docker-compose.yml"),
  "--env-file", existsSync(envFile) ? envFile : "/dev/null", ...args,
], { stdio: "inherit", env: process.env });
if (result.error) console.error(`Docker Compose 未能启动：${result.error.code || "UNKNOWN"}`);
process.exitCode = result.status ?? 1;
