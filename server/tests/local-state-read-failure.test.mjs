import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test, { after } from "node:test";

// Set the boundary before importing the application, even when run directly.
for (const key of Object.keys(process.env)) {
  if (/^(DATABASE_URL|POSTGRES_|PG|AUTO_LISTING_|MINIO_|SONLI_|APP_ENCRYPTION_)/.test(key)) delete process.env[key];
}
process.env.QH_LOCAL_NO_DOTENV = "1";
process.env.QH_LOCAL_NO_LISTEN = "1";
process.env.LISTING_PIPELINE_V3 = "0";
process.env.SONLI_ADMIN_PASSWORD = "synthetic-state-test-password";
const dataDir = await mkdtemp(path.join(os.tmpdir(), "sonli-state-read-regression-"));
process.env.QH_LOCAL_DATA_DIR = dataDir;
const dataFile = path.join(dataDir, "local-state.json");
const { handle } = await import("../index.mjs");
after(() => rm(dataDir, { recursive: true, force: true }));

function login() {
  const req = Readable.from([Buffer.from(JSON.stringify({ username: "admin", password: process.env.SONLI_ADMIN_PASSWORD }))]);
  Object.assign(req, { method: "POST", url: "/local/accounts/login", headers: { "content-type": "application/json" } });
  const response = { status: 0, writeHead(status) { this.status = status; }, end() {} };
  return handle(req, response).then(() => response.status);
}

for (const original of ['{"privateFixture":"do-not-expose-this-value",', "null", "[]", "false"]) {
  test(`login preserves unreadable existing state: ${original[0]}`, async () => {
    await writeFile(dataFile, original);
    await assert.rejects(login(), (error) => {
      assert.equal(error.code, "LOCAL_STATE_READ_FAILED");
      assert.equal(error.status, 503);
      assert.doesNotMatch(error.message, /do-not-expose-this-value/);
      return true;
    });
    assert.equal(await readFile(dataFile, "utf8"), original);
  });
}

test("a wrong encryption key cannot replace an existing state file", async () => {
  const { protectStateForStorage } = await import("../crypto-secrets.mjs");
  process.env.APP_ENCRYPTION_KEY = "synthetic-original-key";
  const original = JSON.stringify(protectStateForStorage({ stores: [{ id: "fixture-store", apiKey: "synthetic-store-credential" }] }));
  await writeFile(dataFile, original);
  process.env.APP_ENCRYPTION_KEY = "synthetic-wrong-key";
  try {
    await assert.rejects(login(), { code: "LOCAL_STATE_READ_FAILED", status: 503 });
    assert.equal(await readFile(dataFile, "utf8"), original);
  } finally {
    delete process.env.APP_ENCRYPTION_KEY;
  }
});

test("unreadable state is preserved instead of initialized", async () => {
  const original = '{"stores":[]}';
  await writeFile(dataFile, original);
  await chmod(dataFile, 0);
  try {
    await assert.rejects(login(), { code: "LOCAL_STATE_READ_FAILED", status: 503 });
  } finally {
    await chmod(dataFile, 0o600);
  }
  assert.equal(await readFile(dataFile, "utf8"), original);
});

test("a missing state file can still initialize the first administrator", async () => {
  await rm(dataFile, { force: true });
  assert.equal(await login(), 200);
  assert.equal(JSON.parse(await readFile(dataFile, "utf8")).accounts.length, 1);
});

test("liveness stays available without reading broken business state", async () => {
  const original = "broken-state-for-liveness-test";
  await writeFile(dataFile, original);
  const req = Object.assign(Readable.from([]), { method: "GET", url: "/health", headers: {} });
  const res = { status: 0, writeHead(status) { this.status = status; }, end() {} };
  await handle(req, res);
  assert.equal(res.status, 200);
  assert.equal(await readFile(dataFile, "utf8"), original);
});

test("readiness reports unreadable JSON without normalizing or overwriting it", async () => {
  const original = "broken-state-for-readiness-test";
  await writeFile(dataFile, original);
  const req = Object.assign(Readable.from([]), { method: "GET", url: "/local/storage/health", headers: {} });
  const res = { status: 0, body: null, writeHead(status) { this.status = status; }, end(body) { this.body = JSON.parse(body); } };
  await handle(req, res);
  assert.equal(res.status, 503);
  assert.equal(res.body.persistence.ok, false);
  assert.equal(await readFile(dataFile, "utf8"), original);
});
