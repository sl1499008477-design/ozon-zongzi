import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const envFile = path.join(rootDir, ".env");

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

try {
  if (!shouldLoadDotenv) throw Object.assign(new Error("dotenv disabled"), { code: "ENOENT" });
  const raw = readFileSync(envFile, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    const [, key, value] = match;
    if (process.env[key] === undefined) process.env[key] = unquote(value);
  }
} catch (error) {
  if (error?.code !== "ENOENT") {
    console.warn(`读取 .env 失败: ${error.message}`);
  }
}
