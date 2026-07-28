import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const appDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryDirectory = path.resolve(appDirectory, "..");

async function source(relativePath) {
  return readFile(path.join(repositoryDirectory, relativePath), "utf8");
}

test("the app dev server and compatibility proxy use distinct fixed ports", async () => {
  const packageJson = JSON.parse(await readFile(path.join(appDirectory, "package.json"), "utf8"));
  const viteConfig = await source("app/vite.config.mjs");
  const compatibilityProxy = await source("scripts/frontend-compat-proxy.mjs");
  const devScript = await source("scripts/dev.mjs");

  assert.equal(packageJson.scripts.dev, "vite --host 127.0.0.1 --port 5173 --strictPort");
  assert.match(viteConfig, /host:\s*["']127\.0\.0\.1["']/);
  assert.match(viteConfig, /port:\s*5173/);
  assert.match(viteConfig, /strictPort:\s*true/);
  assert.match(compatibilityProxy, /const host = "127\.0\.0\.1"/);
  assert.match(compatibilityProxy, /const port = 3000/);
  assert.match(compatibilityProxy, /const target = "http:\/\/127\.0\.0\.1:5173"/);
  assert.match(devScript, /\["frontend-compat-proxy", "node", \["scripts\/frontend-compat-proxy\.mjs"\]\]/);
  assert.match(devScript, /\["app", "pnpm", \["--dir", "app", "dev"\]\]/);
});
