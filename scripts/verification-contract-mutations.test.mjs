import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function run(script, cwd) {
  return spawnSync(process.execPath, [script], {
    cwd,
    env: process.env,
    encoding: "utf8",
    shell: false,
  });
}

async function copyFile(relativePath, targetRoot) {
  const target = path.join(targetRoot, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await cp(path.join(root, relativePath), target);
  return target;
}

test("collect edit gate accepts the current shared-category column and rejects losing its saved summary", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "collect-edit-gate-"));
  try {
    const app = await copyFile("app/src/App.jsx", fixture);
    await copyFile("app/src/collect-box-target-store.js", fixture);
    await copyFile("extension/content/ozon-product.js", fixture);
    const gate = path.join(root, "scripts/check-collect-edit-listing-contract.mjs");
    const baseline = run(gate, fixture);
    assert.equal(baseline.status, 0, `${baseline.stdout}${baseline.stderr}`);

    const source = await readFile(app, "utf8");
    await writeFile(app, source.replace(
      'const view = row._categoryResolutionView;',
      'const view = row._enrichmentView;',
    ));
    const mutation = run(gate, fixture);
    assert.notEqual(mutation.status, 0, "gate accepted enrichment in place of saved category summary");
    assert.match(`${mutation.stdout}${mutation.stderr}`,
      /collect box must render the saved category summary separately from collection enrichment/);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("store isolation gate accepts the current warehouse projector and rejects unscoped hydration", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "store-isolation-gate-"));
  try {
    const gate = await copyFile("scripts/check-store-data-isolation.mjs", fixture);
    await copyFile("app/src/App.jsx", fixture);
    await copyFile("server/index.mjs", fixture);
    await copyFile("server/store-cache-scope.mjs", fixture);
    await copyFile("server/ozon-sync-service.mjs", fixture);
    const formal = await copyFile("server/formal-persistence.mjs", fixture);
    await copyFile("server/persistence.mjs", fixture);
    const baseline = run(gate, fixture);
    assert.equal(baseline.status, 0, `${baseline.stdout}${baseline.stderr}`);

    const source = await readFile(formal, "utf8");
    await writeFile(formal, source.replace(
      "state.caches.warehouses = warehouses.rows.map(formalWarehouseCacheRow);",
      "state.caches.warehouses = warehouses.rows;",
    ));
    const mutation = run(gate, fixture);
    assert.notEqual(mutation.status, 0, "gate accepted unprojected relational warehouse rows");
    assert.match(`${mutation.stdout}${mutation.stderr}`,
      /formal PostgreSQL products and warehouses must hydrate the store-scoped frontend cache/);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
