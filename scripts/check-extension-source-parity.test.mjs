import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { assertCompatibleExtensionVersions } from "./extension-upstream-config.mjs";

const rootDir = fileURLToPath(new URL("..", import.meta.url));
const localExtensionDir = path.join(rootDir, "extension");

test("upstream parity accepts a newer local patch but rejects older or cross-line versions", () => {
  assert.doesNotThrow(() => assertCompatibleExtensionVersions("0.13.46.12", "0.13.46.6"));
  assert.doesNotThrow(() => assertCompatibleExtensionVersions("0.13.46.12", "0.13.46.12"));
  assert.throws(() => assertCompatibleExtensionVersions("0.13.46.11", "0.13.46.12"), /older than upstream/);
  assert.throws(() => assertCompatibleExtensionVersions("0.14.0", "0.13.46.1"), /release line/);
});

test("source parity accepts the reviewed category strategy sampling and handoff modules as local-only", () => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), "extension-source-parity-"));
  const upstreamDir = path.join(fixtureRoot, "upstream");
  cpSync(localExtensionDir, upstreamDir, { recursive: true });
  for (const relativePath of [
    "lib/category-strategy-sampling.js",
    "lib/category-strategy-handoff.js",
    "tests/category-strategy-sampling.test.js",
    "tests/category-strategy-handoff.test.js",
  ]) rmSync(path.join(upstreamDir, relativePath));
  try {
    const result = spawnSync(process.execPath,
      [path.join(rootDir, "scripts", "check-extension-source-parity.mjs")], {
        cwd: rootDir, encoding: "utf8", env: { ...process.env,
          QH_SOURCE_EXTENSION_DIR: upstreamDir,
          QH_LOCAL_EXTENSION_DIR: localExtensionDir,
          QH_DISTRIBUTED_EXTENSION_DIR: localExtensionDir },
      });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("source parity accepts exactly the reviewed Collector auth opener files absent upstream", () => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), "extension-source-parity-"));
  const upstreamDir = path.join(fixtureRoot, "upstream");
  cpSync(localExtensionDir, upstreamDir, { recursive: true });
  const reviewedLocalOnly = [
    "lib/collector-auth-coordinator.js",
    "lib/collector-auth-flow.js",
    "lib/frontend-tab-opener.js",
    "tests/collector-auth-acceptance.test.js",
    "tests/collector-auth-coordinator.test.js",
    "tests/collector-auth-flow.test.js",
    "tests/frontend-tab-opener.test.js",
    "tests/service-worker-collector-auth.test.js",
  ];
  for (const relativePath of reviewedLocalOnly) rmSync(path.join(upstreamDir, relativePath));

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
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("source parity accepts the reviewed Task 6 helper when the real upstream lacks it", () => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), "extension-source-parity-"));
  const upstreamDir = path.join(fixtureRoot, "upstream");
  cpSync(localExtensionDir, upstreamDir, { recursive: true });
  const helperRelativePath = path.join("lib", "seller-recovery-tab.js");
  rmSync(path.join(upstreamDir, helperRelativePath));
  assert.equal(existsSync(path.join(upstreamDir, helperRelativePath)), false);
  assert.equal(existsSync(path.join(localExtensionDir, helperRelativePath)), true);

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
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("source parity accepts exactly the four reviewed Seller context UI files absent upstream", () => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), "extension-source-parity-"));
  const upstreamDir = path.join(fixtureRoot, "upstream");
  cpSync(localExtensionDir, upstreamDir, { recursive: true });
  const reviewedLocalOnly = [
    "lib/seller-context-status-controller.js",
    "lib/seller-context-ui-message-policy.js",
    "tests/seller-context-status-controller.test.js",
    "tests/seller-context-ui-message-policy.test.js",
  ];
  for (const relativePath of reviewedLocalOnly) rmSync(path.join(upstreamDir, relativePath));

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
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
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
