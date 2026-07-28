import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

const dataDir = await mkdtemp(path.join(os.tmpdir(), "sonli-audit-route-"));
const dataFile = path.join(dataDir, "local-state.json");
const token = "audit-token";

process.env.QH_LOCAL_DATA_DIR = dataDir;
process.env.QH_LOCAL_NO_LISTEN = "1";
process.env.QH_LOCAL_NO_DOTENV = "1";
delete process.env.DATABASE_URL;
delete process.env.POSTGRES_HOST;

async function requestJson(handle, method, pathname, body) {
  const payload = body === undefined ? "" : JSON.stringify(body);
  const req = Readable.from(payload ? [Buffer.from(payload)] : []);
  req.method = method;
  req.url = pathname;
  req.headers = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "x-device-fingerprint": "device-audit",
  };
  const res = {
    status: 0,
    body: "",
    writeHead(status) {
      this.status = status;
    },
    end(text = "") {
      this.body = String(text || "");
    },
  };
  await handle(req, res);
  return { status: res.status, body: JSON.parse(res.body || "{}") };
}

await writeFile(dataFile, JSON.stringify({
  token,
  currentAccountId: "account-audit",
  sessionIssuedAt: "2026-07-27T00:00:00.000Z",
  sessions: {
    [token]: { token, accountId: "account-audit", issuedAt: "2026-07-27T00:00:00.000Z" },
  },
  accounts: [{ id: "account-audit", username: "audit", role: "admin", status: "active" }],
  currentStoreId: "store-audit",
  currentStoreIdsByAccount: { "account-audit": "store-audit" },
  stores: [{
    id: "store-audit",
    ownerAccountId: "account-audit",
    clientId: "client-audit",
    apiKey: "api-key-must-not-enter-audit",
  }],
  caches: {},
  hashes: {},
  leases: {},
  browserAgents: {},
  jobs: {},
  reports: [],
  auditEvents: [],
}), "utf8");

try {
  const { handle } = await import("../index.mjs");
  assert.equal((await requestJson(
    handle,
    "POST",
    "/usage/track",
    { featureKey: "pricing", apiKey: "body-secret" },
  )).status, 200);
  assert.equal((await requestJson(
    handle,
    "GET",
    "/ozon/stores/store-audit/sync-credentials",
  )).status, 200);
  assert.equal((await requestJson(
    handle,
    "POST",
    "/ozon/sync/client-report",
    {
      clientJobId: "job-audit",
      storeId: "store-audit",
      deviceId: "body-device-must-not-win",
      type: "PRODUCTS",
      status: "SUCCESS",
      fetchedCount: 3,
      apiKey: "body-secret",
    },
  )).status, 200);

  const persisted = JSON.parse(await readFile(dataFile, "utf8"));
  const actions = persisted.auditEvents.map((event) => event.action);
  assert.ok(actions.includes("USAGE_TRACK"));
  assert.ok(actions.includes("SYNC_CREDENTIALS_READ"));
  assert.ok(actions.includes("SYNC_CLIENT_REPORT"));
  for (const event of persisted.auditEvents) {
    assert.equal(event.accountId, "account-audit");
    assert.equal(event.storeId, "store-audit");
    assert.equal(event.deviceId, "device-audit");
    assert.equal(event.source, "extension");
  }
  const auditJson = JSON.stringify(persisted.auditEvents);
  assert.doesNotMatch(auditJson, /api-key-must-not-enter-audit|body-secret/);
  console.log("audit route integration test passed");
} finally {
  await rm(dataDir, { recursive: true });
}
