import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import process from "node:process";
import {
  assertCaptureOnlyFileSet,
  assertCaptureOnlyPermissionPolicy,
  assertCaptureOnlyServiceWorker,
  assertPopupWebLoginGuidance,
} from "./extension-capture-only-policy.mjs";

const rootDir = process.cwd();
const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(await readFile(path.join(rootDir, "extension", "manifest.json"), "utf8"));
const fileName = `sonli-extension-${manifest.version}.zip`;
const zipPaths = [
  path.join(rootDir, "app", "public", fileName),
  path.join(rootDir, "app", "dist", fileName),
];

let failed = false;

async function listFiles(dir, prefix = "") {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await listFiles(path.join(dir, entry.name), rel));
    else if (entry.isFile()) files.push(rel);
  }
  return files.sort();
}

for (const zipPath of zipPaths) {
  const label = path.relative(rootDir, zipPath);
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "sonli-extension-zip-"));
  try {
    const unzip = spawnSync("unzip", ["-q", zipPath, "-d", tmpDir], {
      stdio: "inherit",
      shell: false,
    });
    if (unzip.status !== 0) {
      failed = true;
      console.error(`${label} unzip failed`);
      continue;
    }

    const packagedFiles = await listFiles(tmpDir);
    const packagedManifest = JSON.parse(
      await readFile(path.join(tmpDir, "manifest.json"), "utf8"),
    );
    assertCaptureOnlyFileSet(packagedFiles);
    assertCaptureOnlyPermissionPolicy(packagedManifest, packagedManifest);
    assertCaptureOnlyServiceWorker(
      await readFile(path.join(tmpDir, "background", "service-worker.js"), "utf8"),
    );
    assertPopupWebLoginGuidance(
      await readFile(path.join(tmpDir, "popup", "popup.html"), "utf8"),
      await readFile(path.join(tmpDir, "popup", "popup.js"), "utf8"),
    );

    const tests = [
      ["collector service-worker startup", path.join(scriptsDir, "check-packaged-collector-runtime.mjs"), tmpDir],
      ["collector session runtime", path.join(tmpDir, "tests", "collector-session.test.js")],
      ["capture-only behavior", path.join(tmpDir, "tests", "sync-capability-removed.test.js")],
      ["bridge smoke", path.join(tmpDir, "tests", "jizhangerp-bridge-follow-sell.test.js")],
      ["dryRun route guard", path.join(tmpDir, "background", "__tests__", "follow-sell-dry-run-route.test.js")],
    ];
    for (const [name, testPath, ...args] of tests) {
      const smoke = spawnSync(process.execPath, [testPath, ...args], {
        cwd: tmpDir,
        stdio: "inherit",
        shell: false,
      });
      if (smoke.status !== 0) {
        failed = true;
        console.error(`${label} ${name} failed`);
        break;
      }
    }
    if (!failed) console.log(`${label} packaged smoke tests passed`);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

if (failed) process.exit(1);
