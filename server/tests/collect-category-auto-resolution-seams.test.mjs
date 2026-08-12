import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const worker = path.join(repositoryRoot, "server/tests/support/collect-category-auto-resolution-seams.worker.mjs");
const databaseSentinels = Object.freeze({
  DATABASE_URL: "postgresql://database-sentinel.invalid/never-connect",
  POSTGRES_HOST: "postgres-sentinel.invalid",
  POSTGRES_PASSWORD: "sentinel-password-never-use",
});

function runWorker(mode, dataDir) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [worker, mode], {
      cwd: repositoryRoot,
      env: { ...process.env, ...databaseSentinels, E2E_TEMP_DATA_DIR: dataDir },
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

test("fast collection delegates account-shared evidence inside the injected ingestion transaction", async (t) => {
  await assertWorker(t, "fast-collect", { status: 200, evidencePortCalls: 1, storeResolverCalls: 0 });
});

test("PATCHing a collection draft cannot create category authority", async (t) => {
  await assertWorker(t, "fast-patch", { status: 200, draftUpdates: 1, evidencePortCalls: 0 });
});

test("dedicated category confirmation authenticates before reading an ordinary user's body", async (t) => {
  await assertWorker(t, "confirmation-auth", { status: 403, code: "PERMISSION_FORBIDDEN", bodyReads: 0 });
});

test("account-shared composition rejects invalid overrides and exposes no store wake/timer API", async (t) => {
  await assertWorker(t, "override-validation", { invalidOverrides: 3, hasStoreWake: false, hasTimer: false });
});
