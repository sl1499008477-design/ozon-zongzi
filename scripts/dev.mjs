import { spawn } from "node:child_process";
import process from "node:process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const commands = Object.freeze([
  ["server", "node", ["server/index.mjs"]],
  ["worker", "node", ["server/listing-worker.mjs"]],
  ["ai-worker", "node", ["server/ai-listing-worker.mjs"]],
  ["ego-proxy", "node", ["server/ego-proxy.mjs"]],
  ["frontend-compat-proxy", "node", ["scripts/frontend-compat-proxy.mjs"]],
  ["app", "node", ["app/node_modules/vite/bin/vite.js", "app", "--host", "127.0.0.1", "--port", "5173", "--strictPort"]],
]);

export function startDevelopmentServices({
  spawnProcess = spawn,
  processRef = process,
  logger = console,
} = {}) {
  if (typeof spawnProcess !== "function" || typeof processRef?.on !== "function"
    || typeof logger?.log !== "function" || typeof logger?.error !== "function") {
    throw new TypeError("本地开发进程配置无效");
  }

  const children = new Map();
  const childEnv = processRef.env.SONLI_ENV_FILE
    ? { ...processRef.env, SONLI_ENV_FILE: path.resolve(processRef.cwd(), processRef.env.SONLI_ENV_FILE) }
    : processRef.env;
  let closing = false;

  const shutdown = () => {
    if (closing) return;
    closing = true;
    for (const child of children.values()) {
      if (!child.killed) child.kill("SIGTERM");
    }
  };

  const start = ([name, command, args]) => {
    if (closing) return;
    if ((name === "worker" || name === "ai-worker") && processRef.env.LISTING_PIPELINE_V3 === "0") {
      logger.log(`[${name}] disabled by configuration`);
      return;
    }
    const child = spawnProcess(command, args, {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      stdio: ["ignore", "pipe", "pipe"],
      env: childEnv,
    });
    children.set(name, child);
    const prefix = `[${name}]`;
    child.stdout.on("data", (chunk) => processRef.stdout.write(`${prefix} ${chunk}`));
    child.stderr.on("data", (chunk) => processRef.stderr.write(`${prefix} ${chunk}`));
    child.on("error", (error) => {
      if (closing || children.get(name) !== child) return;
      logger.error(`${prefix} failed to start: ${error?.code || "UNKNOWN"}`);
      processRef.exitCode = 1;
      shutdown();
    });
    child.on("exit", (code, signal) => {
      if (children.get(name) !== child || closing) return;
      children.delete(name);
      logger.error(`${prefix} unexpectedly stopped${signal ? ` by ${signal}` : ` with code ${code}`}; stopping the partial application`);
      processRef.exitCode = 1;
      shutdown();
    });
    return child;
  };

  for (const command of commands) start(command);
  processRef.on("SIGINT", shutdown);
  processRef.on("SIGTERM", shutdown);
  return Object.freeze({ shutdown, isClosing: () => closing });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await import("../server/env.mjs");
  startDevelopmentServices();
}
