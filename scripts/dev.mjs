import { spawn } from "node:child_process";
import process from "node:process";

const commands = [
  ["server", "node", ["server/index.mjs"]],
  ["worker", "node", ["server/listing-worker.mjs"]],
  ["auto-listing-ai-worker", "node", ["server/auto-listing-ai-worker.mjs"]],
  ["frontend-compat-proxy", "node", ["scripts/frontend-compat-proxy.mjs"]],
  ["app", "pnpm", ["--dir", "app", "dev"]],
];

const children = commands.map(([name, cmd, args]) => {
  const child = spawn(cmd, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  const prefix = `[${name}]`;
  child.stdout.on("data", (chunk) => process.stdout.write(`${prefix} ${chunk}`));
  child.stderr.on("data", (chunk) => process.stderr.write(`${prefix} ${chunk}`));
  child.on("exit", (code, signal) => {
    if (signal) {
      console.log(`${prefix} stopped by ${signal}`);
    } else if (code !== 0) {
      console.error(`${prefix} exited with code ${code}`);
      shutdown();
    }
  });
  return child;
});

let closing = false;
function shutdown() {
  if (closing) return;
  closing = true;
  for (const child of children) {
    if (!child.killed) child.kill("SIGTERM");
  }
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
