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

await rm(unpackedTarget, { recursive: true, force: true });
await cp(extensionDir, unpackedTarget, { recursive: true, force: true });
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
