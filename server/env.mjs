import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const envFile = path.resolve(process.env.SONLI_ENV_FILE || path.join(rootDir, ".env"));

function unquote(value) {
  const trimmed = String(value || "").trim();
  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\"")) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).replace(/\\n/g, "\n").replace(/\\"/g, "\"");
  }
  const hashIndex = trimmed.indexOf(" #");
  return hashIndex >= 0 ? trimmed.slice(0, hashIndex).trim() : trimmed;
}

const shouldLoadDotenv =
  process.env.QH_LOCAL_NO_DOTENV !== "1" &&
  process.env.QH_LOCAL_NO_LISTEN !== "1";

if (shouldLoadDotenv) {
  try {
    const raw = readFileSync(envFile, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!match) continue;
      const [, key, value] = match;
      if (process.env[key] === undefined) process.env[key] = unquote(value);
    }
    const keyFile = process.env.AUTO_LISTING_CREDENTIAL_MASTER_KEY_FILE;
    if (keyFile) process.env.AUTO_LISTING_CREDENTIAL_MASTER_KEY_FILE = path.resolve(path.dirname(envFile), keyFile);
  } catch (error) {
    if (error?.code !== "ENOENT" || process.env.SONLI_ENV_FILE) {
      throw new Error("无法读取运行配置，请检查 SONLI_ENV_FILE 指定的 .env 文件及权限。", { cause: error });
    }
  }
}
