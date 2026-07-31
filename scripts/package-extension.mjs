import { spawnSync } from "node:child_process";
import { cp, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const rootDir = process.cwd();
const extensionDir = path.join(rootDir, "extension");
const manifest = JSON.parse(await readFile(path.join(extensionDir, "manifest.json"), "utf8"));
const fileName = `sonli-extension-${manifest.version}.zip`;
const targets = [
  path.join(rootDir, "app", "public", fileName),
  path.join(rootDir, "app", "dist", fileName),
];
const unpackedTarget = path.join(rootDir, "app", "public", `sonli-extension-${manifest.version}`);
const collectorRuntimeFiles = [
  "background/collector-client.js",
  "background/collector-ozon-enrichment-agent.js",
  "background/collector-ozon-enrichment-client.js",
  "background/service-worker.js",
  "content/seller-company-context-hook.js",
  "lib/collector-session.js",
  "lib/ozon-collect-coordinator.js",
  "lib/ozon-enrichment-contract.js",
  "lib/seller-company-context.js",
  "lib/seller-company-context-runtime.js",
  "tests/collector-session.test.js",
  "tests/collector-ozon-enrichment-client.test.js",
  "tests/ozon-collect-coordinator.test.js",
  "tests/ozon-enrichment-contract.test.js",
  "tests/ozon-search-complete-collection.test.js",
  "tests/seller-company-context-contract.test.js",
  "tests/seller-company-context.test.js",
  "tests/sync-capability-removed.test.js",
];

for (const relativePath of collectorRuntimeFiles) {
  await readFile(path.join(extensionDir, relativePath));
}

await rm(unpackedTarget, { recursive: true, force: true });
await cp(extensionDir, unpackedTarget, { recursive: true, force: true });
for (const relativePath of collectorRuntimeFiles) {
  await readFile(path.join(unpackedTarget, relativePath));
}
console.log(`packaged ${path.relative(rootDir, unpackedTarget)}`);

for (const target of targets) {
  await mkdir(path.dirname(target), { recursive: true });
  await rm(target, { force: true });
  const result = spawnSync("zip", ["-qr", target, "."], {
    cwd: extensionDir,
    stdio: "inherit",
    shell: false,
  });
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
  console.log(`packaged ${path.relative(rootDir, target)}`);
}
