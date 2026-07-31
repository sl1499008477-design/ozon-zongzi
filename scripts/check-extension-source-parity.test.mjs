import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const rootDir = fileURLToPath(new URL("..", import.meta.url));
const localExtensionDir = path.join(rootDir, "extension");

test("source parity accepts the reviewed Task 8 product collection contract as local-only", () => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), "extension-source-parity-"));
  const upstreamDir = path.join(fixtureRoot, "upstream");
  cpSync(localExtensionDir, upstreamDir, { recursive: true });
  rmSync(path.join(upstreamDir, "tests", "ozon-product-complete-collection.test.js"));

  try {
    const result = spawnSync(
      process.execPath,
      [path.join(rootDir, "scripts", "check-extension-source-parity.mjs")],
      {
        cwd: rootDir,
        encoding: "utf8",
        env: {
          ...process.env,
          QH_SOURCE_EXTENSION_DIR: upstreamDir,
          QH_LOCAL_EXTENSION_DIR: localExtensionDir,
          QH_DISTRIBUTED_EXTENSION_DIR: localExtensionDir,
        },
      },
    );

    assert.equal(
      result.status,
      0,
      `${result.stdout}\n${result.stderr}`,
    );
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
