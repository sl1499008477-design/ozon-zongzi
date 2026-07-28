import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

const dataDir = await mkdtemp(path.join(os.tmpdir(), "sonli-browser-agent-isolation-"));

process.env.QH_LOCAL_DATA_DIR = dataDir;
process.env.QH_LOCAL_NO_LISTEN = "1";
process.env.QH_LOCAL_NO_DOTENV = "1";
delete process.env.DATABASE_URL;
delete process.env.POSTGRES_HOST;

async function requestJson(handle, method, pathname, body, token, storeId = "") {
  const payload = body === undefined ? "" : JSON.stringify(body);
  const req = Readable.from(payload ? [Buffer.from(payload)] : []);
  req.method = method;
  req.url = pathname;
  req.headers = { "content-type": "application/json" };
  if (token) req.headers.authorization = `Bearer ${token}`;
  if (storeId) req.headers["x-ozon-store-id"] = storeId;
  const res = {
    status: 0,
    headers: {},
    body: "",
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers || {};
    },
    end(text = "") {
      this.body = String(text || "");
    },
  };
  try {
    await handle(req, res);
  } catch (error) {
    res.writeHead(Number(error?.status || 500), { "content-type": "application/json" });
    res.end(JSON.stringify({
      ok: false,
      code: error?.code || "LOCAL_ERROR",
      message: error?.message || "本地服务异常",
    }));
  }
  return { status: res.status, body: JSON.parse(res.body || "{}") };
}

const fixture = {
  token: "",
  currentAccountId: "",
  sessionIssuedAt: "",
  sessions: {
    token_a: { token: "token_a", accountId: "acct_a", issuedAt: "2026-07-27T00:00:00.000Z" },
    token_b: { token: "token_b", accountId: "acct_b", issuedAt: "2026-07-27T00:00:00.000Z" },
  },
  accounts: [
    { id: "acct_a", username: "a", displayName: "A", role: "admin", status: "active" },
    { id: "acct_b", username: "b", displayName: "B", role: "user", status: "active" },
  ],
  currentStoreId: "",
  currentStoreIdsByAccount: { acct_a: "store_a", acct_b: "store_b" },
  stores: [
    { id: "store_a", ownerAccountId: "acct_a", clientId: "client_a", label: "A store" },
    { id: "store_b", ownerAccountId: "acct_b", clientId: "client_b", label: "B store" },
  ],
  currentDataCollectionStoreId: "",
  currentDataCollectionStoreIdsByAccount: {},
  dataCollectionStores: [],
  caches: {
    products: [],
    postings: [],
    warehouses: [],
    collectBox: [],
    favorites: [],
    promotions: [],
    returns: [],
    refunds: [],
    announcements: [],
    messageTemplates: [],
    messageHistory: [],
    productTemplates: [],
    watermarkTemplates: [],
    files: [],
  },
  hashes: {},
  leases: {},
  browserAgents: {},
  jobs: {},
  reports: [],
  updatedAt: "2026-07-27T00:00:00.000Z",
};

try {
  await writeFile(path.join(dataDir, "local-state.json"), JSON.stringify(fixture), "utf8");
  const { handle } = await import("../index.mjs");

  const created = await requestJson(
    handle,
    "POST",
    "/browser-agents/collection-jobs",
    { sku: "10001", storeId: "store_a", accountId: "acct_b", status: "SUCCESS" },
    "token_a",
    "store_a",
  );
  assert.equal(created.status, 200);
  assert.equal(created.body.accountId, "acct_a", "server must own the job account scope");
  assert.equal(created.body.createdBy, "acct_a", "server must record the authenticated creator");
  assert.equal(created.body.storeId, "store_a", "server must record the validated store scope");
  assert.equal(created.body.status, "PENDING", "request body must not control the initial status");
  assert.equal(created.body.params.accountId, undefined, "spoofed account scope must not be stored in params");
  assert.equal(created.body.params.createdBy, undefined, "spoofed creator must not be stored in params");
  assert.equal(created.body.params.status, undefined, "spoofed status must not be stored in params");
  assert.equal(
    created.body.params.claimedByDeviceId,
    undefined,
    "spoofed device lock must not be stored in params",
  );

  const registerA = await requestJson(
    handle,
    "POST",
    "/browser-agents/register",
    { deviceKey: "shared-key", deviceName: "A device" },
    "token_a",
  );
  assert.equal(registerA.status, 200);
  assert.equal(registerA.body.accountId, "acct_a", "server must bind the device to its authenticated account");

  const takeover = await requestJson(
    handle,
    "POST",
    "/browser-agents/heartbeat",
    { deviceId: registerA.body.id },
    "token_b",
  );
  assert.equal(takeover.status, 404, "another account must not take over an existing device");

  const registerB = await requestJson(
    handle,
    "POST",
    "/browser-agents/register",
    { deviceKey: "device-b", deviceName: "B device" },
    "token_b",
  );
  assert.equal(registerB.status, 200);
  assert.equal(registerB.body.accountId, "acct_b");

  const crossRead = await requestJson(
    handle,
    "GET",
    `/browser-agents/collection-jobs/${created.body.id}`,
    undefined,
    "token_b",
    "store_b",
  );
  assert.equal(crossRead.status, 404, "another account must not discover the job");

  const crossClaim = await requestJson(
    handle,
    "GET",
    `/browser-agents/jobs/next?deviceId=${encodeURIComponent(registerB.body.id)}`,
    undefined,
    "token_b",
  );
  assert.equal(crossClaim.status, 200);
  assert.equal(crossClaim.body.job, null, "another account must not claim the job");
  assert.equal(crossClaim.body.idle, true);

  const crossResult = await requestJson(
    handle,
    "POST",
    `/browser-agents/jobs/${created.body.id}/result`,
    { deviceId: registerB.body.id, result: { ok: true } },
    "token_b",
  );
  assert.equal(crossResult.status, 404, "another account must not update the job");

  const registerA2 = await requestJson(
    handle,
    "POST",
    "/browser-agents/register",
    { deviceKey: "device-a2", deviceName: "A device 2" },
    "token_a",
  );
  assert.equal(registerA2.status, 200);

  const claimA1 = await requestJson(
    handle,
    "GET",
    `/browser-agents/jobs/next?deviceId=${encodeURIComponent(registerA.body.id)}`,
    undefined,
    "token_a",
  );
  assert.equal(claimA1.status, 200);
  assert.equal(claimA1.body.job.id, created.body.id);
  assert.equal(claimA1.body.job.status, "PROCESSING");
  assert.equal(
    claimA1.body.job.claimedByDeviceId,
    registerA.body.id,
    "claim must lock the job to the receiving device",
  );
  assert.equal(claimA1.body.job.claimAttempt, 1);
  assert.ok(Date.parse(claimA1.body.job.claimExpiresAt) > Date.now());

  const wrongDeviceResult = await requestJson(
    handle,
    "POST",
    `/browser-agents/jobs/${created.body.id}/result`,
    { deviceId: registerA2.body.id, result: { ok: true } },
    "token_a",
  );
  assert.equal(wrongDeviceResult.status, 409, "another device must not finish the claimed job");

  const progress = await requestJson(
    handle,
    "POST",
    `/browser-agents/jobs/${created.body.id}/progress`,
    { deviceId: registerA.body.id, stage: "running", percent: 10 },
    "token_a",
  );
  assert.equal(progress.status, 200);
  assert.equal(progress.body.job.status, "RUNNING");

  const success = await requestJson(
    handle,
    "POST",
    `/browser-agents/jobs/${created.body.id}/result`,
    { deviceId: registerA.body.id, result: { ok: true } },
    "token_a",
  );
  assert.equal(success.status, 200);
  assert.equal(success.body.job.status, "SUCCESS");

  const persistedAfterSuccess = JSON.parse(
    await readFile(path.join(dataDir, "local-state.json"), "utf8"),
  );
  const successAudit = persistedAfterSuccess.reports.find(
    (report) => report.type === "BROWSER_AGENT_RESULT" && report.jobId === created.body.id,
  );
  assert.equal(successAudit.accountId, "acct_a", "audit must identify the acting account");
  assert.equal(successAudit.storeId, "store_a", "audit must identify the affected store");
  assert.equal(successAudit.deviceId, registerA.body.id, "audit must identify the executing device");
  assert.equal(successAudit.fromStatus, "RUNNING", "audit must record the prior state");
  assert.equal(successAudit.toStatus, "SUCCESS", "audit must record the resulting state");

  const overwriteTerminal = await requestJson(
    handle,
    "POST",
    `/browser-agents/jobs/${created.body.id}/fail`,
    { deviceId: registerA.body.id, message: "late failure" },
    "token_a",
  );
  assert.equal(overwriteTerminal.status, 409, "terminal jobs must not be overwritten");

  const unknownResult = await requestJson(
    handle,
    "POST",
    "/browser-agents/jobs/unknown-job/result",
    { deviceId: "device_a", result: { ok: true } },
    "token_a",
  );
  assert.equal(unknownResult.status, 404, "a result must not create an unknown job");

  console.log("browser agent account isolation test passed");
} finally {
  await rm(dataDir, { recursive: true, force: true });
}
