import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const worker = path.join(
  repositoryRoot,
  "server/tests/support/collect-category-auto-resolution-seams.worker.mjs",
);
const databaseSentinels = Object.freeze({
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

function runWorker(mode, dataDir) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [worker, mode], {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        ...databaseSentinels,
        E2E_TEMP_DATA_DIR: dataDir,
      },
      stdio: ["ignore", "pipe", "pipe"],
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

async function assertWorker(t, mode, expected) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), `sonli-category-seam-${mode}-`));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const child = await runWorker(mode, dataDir);
  assert.equal(child.signal, null, child.stderr);
  assert.equal(child.code, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), expected);
}

test("current-store HTTP events wake only their handler composition", async (t) => {
  await assertWorker(t, "store-wake", {
    firstWakeCount: 1,
    secondWakeCount: 1,
    controlledProfileCalls: 2,
  });
});

test("PostgreSQL-facing collection capture and scheduling use the injected category runtime", async (t) => {
  await assertWorker(t, "fast-collect", {
    status: 200,
    snapshotCalls: 1,
    scheduleCalls: 1,
  });
});

test("production composition overrides are own-property validated and the default path remains usable", async (t) => {
  await assertWorker(t, "override-validation", {
    invalidOverrides: 6,
    defaultHandler: true,
  });
});
