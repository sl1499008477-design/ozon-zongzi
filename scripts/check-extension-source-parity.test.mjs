import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

test("source parity rejects an unknown local-only file with a safe diagnostic", () => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), "extension-source-parity-"));
  const upstreamDir = path.join(fixtureRoot, "upstream");
  const localDir = path.join(fixtureRoot, "local");
  cpSync(localExtensionDir, upstreamDir, { recursive: true });
  cpSync(localExtensionDir, localDir, { recursive: true });
  const unexpectedFile = `tests/unreviewed-${randomUUID()}.js`;
  const privateFixtureBody = "fixture body must stay private";
  writeFileSync(path.join(localDir, unexpectedFile), privateFixtureBody);

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
          QH_LOCAL_EXTENSION_DIR: localDir,
          QH_DISTRIBUTED_EXTENSION_DIR: localDir,
        },
      },
    );
    const output = `${result.stdout}\n${result.stderr}`;

    assert.notEqual(result.status, 0, output);
    assert.match(output, /unexpected local-only file/);
    assert.match(output, new RegExp(unexpectedFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(output, new RegExp(privateFixtureBody));
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
