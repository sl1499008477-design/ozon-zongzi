import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = process.cwd();
const extension = path.join(root, "extension");
const run = (script, args = [], env = {}) => spawnSync(process.execPath, [script, ...args], {
  cwd: root, encoding: "utf8", timeout: 30_000,
  env: { ...process.env, QH_SOURCE_EXTENSION_DIR: "", ...env },
});

test("local source verification runs without an original package and still rejects stale distribution", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "extension-local-distribution-"));
  try {
    const distribution = path.join(fixture, "distribution");
    await cp(extension, distribution, { recursive: true });
    const env = { QH_DISTRIBUTED_EXTENSION_DIR: distribution };
    const baseline = run("scripts/check-extension-source-parity.mjs", ["--local-only"], env);
    assert.equal(baseline.status, 0, `${baseline.stdout}${baseline.stderr}`);
    await writeFile(path.join(distribution, "tests/ui-parity-exception-gate.test.js"), "/* not a shipped runtime file */");
    const testsOnly = run("scripts/check-extension-source-parity.mjs", ["--local-only"], env);
    assert.equal(testsOnly.status, 0, `${testsOnly.stdout}${testsOnly.stderr}`);
    await writeFile(path.join(distribution, "popup/popup.js"), "/* stale runtime */");
    const stale = run("scripts/check-extension-source-parity.mjs", ["--local-only"], env);
    assert.equal(stale.status, 1);
    assert.match(stale.stderr, /stale distribution file: popup\/popup\.js/);
  } finally { await rm(fixture, { recursive: true, force: true }); }
});

test("local source verification retains the reviewed permission boundary without upstream", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "extension-local-permissions-"));
  try {
    await cp(extension, fixture, { recursive: true });
    const manifestPath = path.join(fixture, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.optional_host_permissions = ["https://evil.example/*"];
    await writeFile(manifestPath, JSON.stringify(manifest));
    const result = run("scripts/check-extension-source-parity.mjs", ["--local-only"], {
      QH_LOCAL_EXTENSION_DIR: fixture, QH_DISTRIBUTED_EXTENSION_DIR: fixture,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /unreviewed optional extension host permission/);
  } finally { await rm(fixture, { recursive: true, force: true }); }
});

test("the independent upstream command reports missing inputs as unverified, never passed", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));
  assert.ok(packageJson.scripts["verify:extension-upstream"], "independent upstream verification command is missing");
  const result = run("scripts/verify-extension-upstream.mjs");
  assert.equal(result.status, 2);
  assert.match(`${result.stdout}${result.stderr}`, /未验证.*原版扩展/);
  assert.doesNotMatch(result.stdout, /对照.*通过/);
});

test("an explicitly supplied non-original directory cannot make upstream verification pass", () => {
  // Deliberately wrong input: today's local source is not evidence of the original upstream.
  const result = run("scripts/verify-extension-upstream.mjs", [], { QH_SOURCE_EXTENSION_DIR: extension });
  assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
  assert.match(result.stderr, /reviewed upstream UI fingerprint mismatch/);
  assert.match(result.stderr, /原版扩展对照未通过/);
  assert.doesNotMatch(result.stdout, /原版扩展对照全部通过/);
});
