import { spawn } from "node:child_process";
import process from "node:process";
import { pathToFileURL } from "node:url";

const commands = Object.freeze([
  ["server", "node", ["server/index.mjs"]],
  ["worker", "node", ["server/listing-worker.mjs"]],
  ["auto-listing-ai-worker", "node", ["server/auto-listing-ai-worker.mjs"]],
  ["frontend-compat-proxy", "node", ["scripts/frontend-compat-proxy.mjs"]],
  ["app", "pnpm", ["--dir", "app", "dev"]],
]);

export function startDevelopmentServices({
  spawnProcess = spawn,
  processRef = process,
  logger = console,
  restartDelayMs = 1_000,
} = {}) {
  if (typeof spawnProcess !== "function" || typeof processRef?.on !== "function"
    || typeof logger?.log !== "function" || typeof logger?.error !== "function"
    || !Number.isInteger(restartDelayMs) || restartDelayMs < 1 || restartDelayMs > 60_000) {
    throw new TypeError("本地开发进程配置无效");
  }

  const children = new Map();
  let closing = false;
  let workerRestartTimer = null;

  const shutdown = () => {
    if (closing) return;
    closing = true;
    if (workerRestartTimer !== null) clearTimeout(workerRestartTimer);
    workerRestartTimer = null;
    for (const child of children.values()) {
      if (!child.killed) child.kill("SIGTERM");
    }
  };

  const start = ([name, command, args]) => {
    const child = spawnProcess(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: processRef.env,
    });
    children.set(name, child);
    const prefix = `[${name}]`;
    child.stdout.on("data", (chunk) => processRef.stdout.write(`${prefix} ${chunk}`));
    child.stderr.on("data", (chunk) => processRef.stderr.write(`${prefix} ${chunk}`));
    child.on("error", (error) => {
      logger.error(`${prefix} failed to start: ${error?.code || "UNKNOWN"}`);
    });
    child.on("exit", (code, signal) => {
      if (children.get(name) !== child || closing) return;
      children.delete(name);
      if (name === "auto-listing-ai-worker") {
        logger.error(`${prefix} unexpectedly stopped${signal ? ` by ${signal}` : ` with code ${code}`}; restarting`);
        workerRestartTimer = setTimeout(() => {
          workerRestartTimer = null;
          if (!closing) start(commands.find(([candidate]) => candidate === name));
        }, restartDelayMs);
        return;
      }
      if (signal) logger.log(`${prefix} stopped by ${signal}`);
      else if (code !== 0) {
        logger.error(`${prefix} exited with code ${code}`);
        shutdown();
      }
    });
    return child;
  };

  for (const command of commands) start(command);
  processRef.on("SIGINT", shutdown);
  processRef.on("SIGTERM", shutdown);
  return Object.freeze({ shutdown, isClosing: () => closing });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startDevelopmentServices();
}
