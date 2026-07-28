import assert from "node:assert/strict";
import { createCollectorHttpHandler } from "../collector-routes.mjs";

const calls = [];
const responses = {
  collectorDesktopHealth: { ok: true, taskCount: 1 },
  listCollectorDevices: [{ id: "device-list" }],
  registerCollectorDevice: { id: "device-new" },
  revokeCollectorDevice: true,
  listCollectorTasksPageForAccount: { tasks: [{ id: "task-list" }], total: 1, page: 2, pageSize: 25 },
  createCollectorTask: { id: "task-new" },
  getCollectorTaskForAccount: { id: "task-get" },
  updateCollectorTask: { id: "task-updated" },
  softDeleteCollectorTask: true,
  listCollectorRunsForTask: [{ id: "run-list" }],
  queueCollectorTaskRun: { duplicate: false, run: { id: "run-new" } },
  getCollectorRunForAccount: { id: "run-get" },
  claimCollectorRun: { run: { id: "run-claim" }, leaseToken: "lease-new", reclaimed: false },
  heartbeatCollectorRun: { run: { id: "run-heartbeat" }, cancelRequested: false },
  requestCollectorRunCancellation: { id: "run-cancel-request" },
  completeCollectorRun: { id: "run-complete", status: "COMPLETED" },
  failCollectorRun: { id: "run-fail", status: "FAILED" },
  cancelCollectorRun: { id: "run-cancel", status: "CANCELLED" },
  listCollectorRunItems: [{ id: "item-list" }],
  upsertCollectorRunItem: ({ item }) => ({ item: { id: item.sourceKey }, created: true }),
  listCollectorRunEvents: [{ id: 1 }],
  appendCollectorRunEvent: { id: 2 },
  listCollectorExportsForRun: [{ id: "export-list" }],
  createCollectorExport: { id: "export-new" },
  getCollectorExportForAccount: { id: "export-get" },
  listCollectorMarketSnapshots: [{ id: "snapshot-list" }],
  upsertCollectorMarketSnapshot: { id: "snapshot-new" },
  listCollectorCategoryMappings: [{ id: "mapping-list" }],
  upsertCollectorCategoryMapping: { id: "mapping-new" },
};

const service = new Proxy({}, {
  get(_target, property) {
    return async (...args) => {
      calls.push({ name: String(property), args });
      const response = responses[property];
      return typeof response === "function" ? response(...args) : structuredClone(response);
    };
  },
});

let authenticateCount = 0;
const handler = createCollectorHttpHandler({
  authenticate: async () => {
    authenticateCount += 1;
    return { id: "account-auth", role: "user" };
  },
  service,
});

function lastCall(name) {
  const call = calls.findLast((item) => item.name === name);
  assert.ok(call, `${name} should have been called`);
  return call;
}

async function invoke(method, url, body = undefined, targetHandler = handler) {
  const req = { method, url, headers: {}, ...(body === undefined ? {} : { body }) };
  const res = {
    statusCode: 0,
    headers: {},
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = headers;
    },
    end(value) {
      this.rawBody = value;
      this.body = value ? JSON.parse(value) : null;
    },
  };
  const hit = await targetHandler(req, res);
  return { hit, req, res };
}

const authBeforeUnknown = authenticateCount;
const unknown = await invoke("GET", "/not-collector");
assert.equal(unknown.hit, false);
assert.equal(authenticateCount, authBeforeUnknown, "未命中路由时不能执行认证");

const authBeforeWrongMethod = authenticateCount;
const wrongMethod = await invoke("OPTIONS", "/collector/tasks");
assert.equal(wrongMethod.hit, true);
assert.equal(wrongMethod.res.statusCode, 405);
assert.equal(wrongMethod.res.body.code, "COLLECTOR_METHOD_NOT_ALLOWED");
assert.match(wrongMethod.res.headers.allow, /GET/);
assert.equal(authenticateCount, authBeforeWrongMethod, "错误方法不能进入业务认证");

const health = await invoke("GET", "/collector/health");
assert.equal(health.res.statusCode, 200);
assert.deepEqual(health.res.body, { ok: true, health: { ok: true, taskCount: 1 } });

const registered = await invoke("POST", "/collector/devices", {
  accountId: "account-evil",
  deviceId: "desktop-device",
  platform: "darwin",
});
assert.equal(registered.res.statusCode, 201);
assert.equal(registered.res.body.device.id, "device-new");
assert.equal(lastCall("registerCollectorDevice").args[0], "account-auth");
assert.equal(lastCall("registerCollectorDevice").args[1].accountId, undefined);

await invoke("GET", "/collector/devices");
assert.equal(lastCall("listCollectorDevices").args[0], "account-auth");
await invoke("DELETE", "/collector/devices/device%2Fone");
assert.deepEqual(lastCall("revokeCollectorDevice").args, ["account-auth", "device/one"]);

const createdTask = await invoke("POST", "/collector/tasks", {
  accountId: "account-evil",
  createdBy: "account-evil",
  name: "task",
  taskType: "SELLER_ANALYTICS",
  operatingStoreId: "store-1",
});
assert.equal(createdTask.res.statusCode, 201);
const createTaskInput = lastCall("createCollectorTask").args[0];
assert.equal(createTaskInput.accountId, "account-auth");
assert.equal(createTaskInput.createdBy, "account-auth");

await invoke("GET", "/collector/tasks?page=2&pageSize=25&taskName=phone&status=RUNNING&includeDeleted=true");
assert.deepEqual(lastCall("listCollectorTasksPageForAccount").args[0], {
  accountId: "account-auth",
  status: "RUNNING",
  query: "",
  taskName: "phone",
  operatingStoreId: "",
  dataCollectionStoreId: "",
  includeDeleted: true,
  page: 2,
  pageSize: 25,
});

await invoke("GET", "/collector/tasks/task-1");
assert.deepEqual(lastCall("getCollectorTaskForAccount").args, ["account-auth", "task-1"]);
await invoke("PATCH", "/collector/tasks/task-1", {
  accountId: "account-evil",
  expectedVersion: 7,
  name: "renamed",
});
const updateTaskInput = lastCall("updateCollectorTask").args[0];
assert.equal(updateTaskInput.accountId, "account-auth");
assert.equal(updateTaskInput.expectedVersion, 7);
assert.deepEqual(updateTaskInput.patch, { name: "renamed" });
await invoke("DELETE", "/collector/tasks/task-1");
assert.deepEqual(lastCall("softDeleteCollectorTask").args, ["account-auth", "task-1"]);

await invoke("GET", "/collector/tasks/task-1/runs?limit=20&offset=5");
assert.deepEqual(lastCall("listCollectorRunsForTask").args[0], {
  accountId: "account-auth",
  taskId: "task-1",
  limit: 20,
  offset: 5,
});
const queued = await invoke("POST", "/collector/tasks/task-1/runs", {
  accountId: "account-evil",
  dataCollectionStoreId: "verified-data-store",
  idempotencyKey: "idem-1",
  pricingConfigVersionId: "pricing-1",
});
assert.equal(queued.res.statusCode, 201);
assert.deepEqual(lastCall("queueCollectorTaskRun").args[0], {
  accountId: "account-auth",
  taskId: "task-1",
  dataCollectionStoreId: "verified-data-store",
  idempotencyKey: "idem-1",
  pricingConfigVersionId: "pricing-1",
  requestedBy: "account-auth",
});

await invoke("GET", "/collector/runs/run-1");
assert.deepEqual(lastCall("getCollectorRunForAccount").args, ["account-auth", "run-1"]);
await invoke("POST", "/collector/runs/run-1/claim", {
  accountId: "account-evil",
  deviceId: "device-1",
  leaseSeconds: 120,
});
assert.equal(lastCall("claimCollectorRun").args[0].accountId, "account-auth");
await invoke("POST", "/collector/runs/run-1/heartbeat", {
  accountId: "account-evil",
  deviceId: "device-1",
  leaseToken: "lease-1",
  progress: { processedCount: 3 },
});
assert.equal(lastCall("heartbeatCollectorRun").args[0].accountId, "account-auth");
await invoke("POST", "/collector/runs/run-1/cancel-request", { accountId: "account-evil" });
assert.deepEqual(lastCall("requestCollectorRunCancellation").args[0], {
  accountId: "account-auth",
  runId: "run-1",
  actorId: "account-auth",
});

for (const [action, serviceName] of [
  ["complete", "completeCollectorRun"],
  ["fail", "failCollectorRun"],
  ["cancel", "cancelCollectorRun"],
]) {
  await invoke("POST", `/collector/runs/run-1/${action}`, {
    accountId: "account-evil",
    deviceId: "device-1",
    leaseToken: "lease-1",
    resultSummary: { action },
  });
  const input = lastCall(serviceName).args[0];
  assert.equal(input.accountId, "account-auth");
  assert.equal(input.runId, "run-1");
}

await invoke("GET", "/collector/runs/run-1/items?status=QUALIFIED&limit=10&offset=2");
assert.equal(lastCall("listCollectorRunItems").args[0].accountId, "account-auth");
const batchItems = await invoke("POST", "/collector/runs/run-1/items", {
  accountId: "account-evil",
  deviceId: "device-1",
  leaseToken: "lease-1",
  items: [
    { accountId: "account-evil", sourceKey: "sku-1" },
    { accountId: "account-evil", sourceKey: "sku-2" },
  ],
});
assert.equal(batchItems.res.body.createdCount, 2);
const itemCalls = calls.filter((call) => call.name === "upsertCollectorRunItem").slice(-2);
assert.equal(itemCalls.length, 2);
for (const call of itemCalls) {
  assert.equal(call.args[0].accountId, "account-auth");
  assert.equal(call.args[0].deviceId, "device-1");
  assert.equal(call.args[0].leaseToken, "lease-1");
  assert.equal(call.args[0].item.accountId, undefined);
}

await invoke("GET", "/collector/runs/run-1/events?afterId=7&limit=8");
assert.equal(lastCall("listCollectorRunEvents").args[0].afterId, 7);
await invoke("POST", "/collector/runs/run-1/events", {
  accountId: "account-evil",
  eventType: "DESKTOP_LOG",
  actorType: "system",
  actorId: "account-evil",
  payload: { line: 1 },
});
assert.equal(lastCall("appendCollectorRunEvent").args[0].accountId, "account-auth");
assert.equal(lastCall("appendCollectorRunEvent").args[0].actorType, "account");
assert.equal(lastCall("appendCollectorRunEvent").args[0].actorId, "account-auth");

await invoke("GET", "/collector/runs/run-1/exports");
assert.equal(lastCall("listCollectorExportsForRun").args[0].accountId, "account-auth");
const pendingExportAttempt = await invoke("POST", "/collector/runs/run-1/export", {
  accountId: "account-evil",
  fileName: "result.xlsx",
});
assert.equal(pendingExportAttempt.res.statusCode, 405);
assert.equal(calls.some((call) => call.name === "createCollectorExport"), false);
await invoke("GET", "/collector/exports/export-1");
assert.deepEqual(lastCall("getCollectorExportForAccount").args, ["account-auth", "export-1"]);
const forbiddenExportPatch = await invoke("PATCH", "/collector/exports/export-1", {
  accountId: "account-evil",
  status: "READY",
});
assert.equal(forbiddenExportPatch.res.statusCode, 405);
assert.equal(calls.some((call) => call.name === "updateCollectorExport"), false);

await invoke("GET", "/collector/market-snapshots?operatingStoreId=store-1&dataCollectionStoreId=data-1&period=MONTHLY");
assert.equal(lastCall("listCollectorMarketSnapshots").args[0].accountId, "account-auth");
await invoke("POST", "/collector/market-snapshots", {
  accountId: "account-evil",
  operatingStoreId: "store-1",
  dataCollectionStoreId: "data-1",
  sellerCompanyId: "123",
  payload: { sku: "1" },
});
const snapshotInput = lastCall("upsertCollectorMarketSnapshot").args[0];
assert.equal(snapshotInput.accountId, "account-auth");

await invoke("GET", "/collector/category-mappings?operatingStoreId=store-1&dataCollectionStoreId=data-1&rootCategoryId=root");
assert.equal(lastCall("listCollectorCategoryMappings").args[0].accountId, "account-auth");
await invoke("POST", "/collector/category-mappings", {
  accountId: "account-evil",
  operatingStoreId: "store-1",
  dataCollectionStoreId: "data-1",
  rootCategoryId: "root",
  leafCategoryId: "leaf",
});
assert.equal(lastCall("upsertCollectorCategoryMapping").args[0].accountId, "account-auth");

const missingService = new Proxy(service, {
  get(target, property) {
    if (property === "getCollectorRunForAccount") return async () => null;
    return target[property];
  },
});
const missingHandler = createCollectorHttpHandler({ authenticate: async () => ({ id: "account-auth" }), service: missingService });
const missing = await invoke("GET", "/collector/runs/missing", undefined, missingHandler);
assert.equal(missing.res.statusCode, 404);
assert.deepEqual(missing.res.body, {
  ok: false,
  error: "任务运行不存在",
  code: "COLLECTOR_RUN_NOT_FOUND",
});

let unauthorizedServiceCalled = false;
const unauthorizedHandler = createCollectorHttpHandler({
  authenticate: async () => {
    throw Object.assign(new Error("登录失效"), { status: 401, code: "AUTH_EXPIRED" });
  },
  service: new Proxy({}, { get: () => async () => { unauthorizedServiceCalled = true; } }),
});
const unauthorized = await invoke("GET", "/collector/tasks", undefined, unauthorizedHandler);
assert.equal(unauthorized.res.statusCode, 401);
assert.equal(unauthorized.res.body.code, "AUTH_EXPIRED");
assert.equal(unauthorizedServiceCalled, false);

console.log("collector routes tests passed");
