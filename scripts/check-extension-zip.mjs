import { spawnSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const rootDir = process.cwd();
const extensionDir = path.join(rootDir, "extension");
const manifest = JSON.parse(await readFile(path.join(extensionDir, "manifest.json"), "utf8"));
const fileName = `sonli-extension-${manifest.version}.zip`;
const zipPaths = [
  path.join(rootDir, "app", "public", fileName),
  path.join(rootDir, "app", "dist", fileName),
];

async function listFiles(dir, prefix = "") {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name === ".DS_Store") continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFiles(full, rel));
    } else if (entry.isFile()) {
      files.push(rel);
    }
  }
  return files.sort();
}

function zipEntries(zipPath) {
  const result = spawnSync("zipinfo", ["-1", zipPath], {
    encoding: "utf8",
    shell: false,
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || `zipinfo failed for ${zipPath}`);
  }
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.endsWith("/") && !line.startsWith("__MACOSX/"))
    .sort();
}

function readZipEntry(zipPath, entry) {
  const result = spawnSync("unzip", ["-p", zipPath, entry], {
    encoding: "buffer",
    shell: false,
  });
  if (result.status !== 0) {
    throw new Error(`unzip failed for ${zipPath}:${entry}`);
  }
  return result.stdout;
}

const expected = await listFiles(extensionDir);
for (const required of [
  "background/collector-client.js",
  "background/service-worker.js",
  "lib/collector-session.js",
  "tests/collector-session.test.js",
  "tests/sync-capability-removed.test.js",
]) {
  if (!expected.includes(required)) {
    throw new Error(`required collector package source missing: ${required}`);
  }
}
let failed = false;

for (const zipPath of zipPaths) {
  const label = path.relative(rootDir, zipPath);
  const entries = zipEntries(zipPath);
  const missing = expected.filter((file) => !entries.includes(file));
  const extra = entries.filter((file) => !expected.includes(file));
  if (missing.length || extra.length) {
    failed = true;
    console.error(`${label} file list mismatch`);
    if (missing.length) console.error(`  missing: ${missing.slice(0, 20).join(", ")}`);
    if (extra.length) console.error(`  extra: ${extra.slice(0, 20).join(", ")}`);
    continue;
  }

  for (const file of expected) {
    const source = await readFile(path.join(extensionDir, file));
    const zipped = readZipEntry(zipPath, file);
    if (!source.equals(zipped)) {
      failed = true;
      console.error(`${label}:${file} differs from extension/${file}`);
      break;
    }
  }
  if (!failed) console.log(`${label} matches extension tree (${expected.length} files)`);
}

if (failed) process.exit(1);
