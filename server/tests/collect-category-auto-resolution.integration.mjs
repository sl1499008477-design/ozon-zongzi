import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const DATABASE_SENTINEL_ENVIRONMENT = Object.freeze({
  DATABASE_URL: "postgresql://database-sentinel.invalid/never-connect",
  POSTGRES_HOST: "postgres-sentinel.invalid",
  POSTGRES_PORT: "6543",
  POSTGRES_DB: "sentinel_db",
  POSTGRES_USER: "sentinel_user",
  POSTGRES_PASSWORD: "sentinel_password_never_use",
  POSTGRES_SSL: "true",
  POSTGRES_STATE_TABLE: "sentinel_state",
  PG_BOSS_SCHEMA: "sentinel_queue",
  PG_BOSS_APPLICATION_NAME: "sentinel_worker",
  PG_BOSS_POOL_SIZE: "99",
});

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function runChild(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: repositoryRoot,
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

test("the E2E worker removes every production database environment key before server imports", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "sonli-category-e2e-env-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const program = `
    import { isolateCollectCategoryE2EEnvironment } from "./server/tests/support/collect-category-e2e-environment.mjs";
    isolateCollectCategoryE2EEnvironment({ dataDir: process.env.E2E_TEMP_DATA_DIR });
    const { postgresEnabled } = await import("./server/db/connection.mjs");
    const remaining = ${JSON.stringify(Object.keys(DATABASE_SENTINEL_ENVIRONMENT))}.filter((key) => process.env[key] !== undefined);
    if (postgresEnabled() || remaining.length) {
      throw new Error(JSON.stringify({ postgresEnabled: postgresEnabled(), remaining }));
    }
    process.stdout.write(JSON.stringify({ persistence: "json", remaining }));
  `;
  const child = await runChild(["--input-type=module", "--eval", program], {
    env: {
      ...process.env,
      ...DATABASE_SENTINEL_ENVIRONMENT,
      E2E_TEMP_DATA_DIR: dataDir,
    },
  });
  assert.equal(child.signal, null, child.stderr);
  assert.equal(child.code, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), { persistence: "json", remaining: [] });
});

test("production-composed account-shared runtime records two source-evidence items and reads them in one batch", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "sonli-category-e2e-worker-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const worker = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "support/collect-category-auto-resolution.worker.mjs",
  );
  const child = await runChild([worker], {
    env: {
      ...process.env,
      ...DATABASE_SENTINEL_ENVIRONMENT,
      E2E_TEMP_DATA_DIR: dataDir,
    },
  });
  assert.equal(child.signal, null, child.stderr);
  assert.equal(child.code, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), {
    persistence: "json",
    items: 2,
    batchReads: 1,
    sharedSelections: 1,
    storeScopedFields: 0,
  });
});

test("the account-shared category E2E remains an explicitly protected active verification gate", async () => {
  const manifest = await import("../../scripts/test-manifest.mjs");
  const file = "server/tests/collect-category-auto-resolution.integration.mjs";
  assert.equal(manifest.requiredActiveTestFiles?.includes(file), true);
  assert.equal(manifest.activeTestFiles.includes(file), true);
});
