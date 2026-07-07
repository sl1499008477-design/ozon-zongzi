import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";

const rootDir = process.cwd();
const manifest = JSON.parse(await readFile(path.join(rootDir, "extension", "manifest.json"), "utf8"));
const fileName = `qh-extension-${manifest.version}.zip`;
const zipPaths = [
  path.join(rootDir, "app", "public", fileName),
  path.join(rootDir, "app", "dist", fileName),
];

let failed = false;

for (const zipPath of zipPaths) {
  const label = path.relative(rootDir, zipPath);
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "qh-extension-zip-"));
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

    const tests = [
      ["bridge smoke", path.join(tmpDir, "tests", "jizhangerp-bridge-follow-sell.test.js")],
      ["dryRun route guard", path.join(tmpDir, "background", "__tests__", "follow-sell-dry-run-route.test.js")],
    ];
    for (const [name, testPath] of tests) {
      const smoke = spawnSync("node", [testPath], {
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
