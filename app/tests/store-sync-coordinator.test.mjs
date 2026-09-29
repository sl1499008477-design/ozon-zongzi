import assert from "node:assert/strict";
import test from "node:test";
import {
  STORE_SYNC_TYPES,
  runBackendStoreSync,
} from "../src/store-sync-coordinator.js";

const terminalReport = (type, overrides = {}) => ({
  id: `task-${type.toLowerCase()}`,
  taskId: `task-${type.toLowerCase()}`,
  requestId: `request-${type.toLowerCase()}`,
  accountId: "account-a",
  storeId: "store-a",
  type,
  status: "SUCCESS",
  timestamp: "2026-07-29T12:00:00.000Z",
  updatedAt: "2026-07-29T12:00:00.000Z",
  details: {
    fetchedCount: 1,
    profile: { synced: true },
  },
  ...overrides,
});

const statusHistory = (snapshots, type) => snapshots
  .map((snapshot) => snapshot.find((item) => item.type === type)?.status)
  .filter((status, index, values) => status && status !== values[index - 1]);

test("full sync calls each backend type once and emits only its state transitions", async () => {
  const calls = [];
  const snapshots = [];
  const extensionMessages = [];
  const originalWindow = globalThis.window;
  globalThis.window = {
    postMessage(message) {
      extensionMessages.push(message);
    },
  };

  try {
    const states = await runBackendStoreSync({
      storeId: "store-a",
      request: async (path, options) => {
        calls.push({ path, options: structuredClone(options) });
        const type = path.split("/").at(-1);
        return { ok: true, job: terminalReport(type) };
      },
      onState(snapshot) {
        snapshots.push(structuredClone(snapshot));
      },
    });

    assert.deepEqual(STORE_SYNC_TYPES, [
      "WAREHOUSES",
      "PRODUCTS",
    ]);
    assert.deepEqual(
      calls.map((call) => call.path),
      STORE_SYNC_TYPES.map((type) => `/local/sync/${type}`),
    );
    assert.equal(new Set(calls.map((call) => call.path)).size, STORE_SYNC_TYPES.length);
    for (const call of calls) {
      assert.equal(call.options.method, "POST");
      assert.equal(call.options.body.storeId, "store-a");
      assert.match(call.options.body.jobId, /^store-sync-task-/);
      assert.match(call.options.body.requestId, /^store-sync-request-/);
    }
    assert.equal(extensionMessages.length, 0);
    assert.deepEqual(
      states.map(({ type, status }) => [type, status]),
      STORE_SYNC_TYPES.map((type) => [type, "SUCCESS"]),
    );
    for (const type of STORE_SYNC_TYPES) {
      assert.deepEqual(statusHistory(snapshots, type), [
        "PENDING",
        "RUNNING",
        "SUCCESS",
      ]);
    }
  } finally {
    globalThis.window = originalWindow;
  }
});

test("a failed type preserves successful results and reports a sanitized backend error", async () => {
  const calls = [];
  const states = await runBackendStoreSync({
    storeId: "store-a",
    types: ["WAREHOUSES", "PRODUCTS"],
    request: async (path, options) => {
      calls.push(path);
      const type = path.split("/").at(-1);
      if (type !== "PRODUCTS") {
        return {
          ok: true,
          job: terminalReport(type, {
            taskId: options.body.jobId,
            requestId: options.body.requestId,
          }),
        };
      }
      throw Object.assign(new Error("商品同步失败"), {
        status: 502,
        code: "ZONGZI_NETWORK_ERROR",
        body: {
          accountId: "account-a",
          storeId: "store-a",
          type,
          timestamp: "2026-07-29T12:00:01.000Z",
          taskId: options.body.jobId,
          requestId: options.body.requestId,
          code: "ZONGZI_NETWORK_ERROR",
          message: "商品同步失败",
          details: {
            apiPath: "/v3/product/list",
            phase: "请求",
          },
        },
      });
    },
  });

  assert.deepEqual(calls, [
    "/local/sync/WAREHOUSES",
    "/local/sync/PRODUCTS",
  ]);
  assert.equal(states[0].status, "SUCCESS");
  assert.deepEqual(states[0].result, terminalReport("WAREHOUSES", {
    taskId: states[0].taskId,
    requestId: states[0].result.requestId,
  }));
  assert.equal(states[1].status, "FAILED");
  assert.deepEqual(states[1].error, {
    accountId: "account-a",
    storeId: "store-a",
    type: "PRODUCTS",
    timestamp: "2026-07-29T12:00:01.000Z",
    taskId: states[1].taskId,
    requestId: states[1].error.requestId,
    code: "ZONGZI_NETWORK_ERROR",
    message: "商品同步失败",
    details: {
      apiPath: "/v3/product/list",
      phase: "请求",
    },
  });
});

test("single-type retry calls only the requested backend endpoint", async () => {
  const calls = [];
  const snapshots = [];
  const states = await runBackendStoreSync({
    storeId: "store-a",
    types: ["PRODUCTS"],
    request: async (path, options) => {
      calls.push({ path, options });
      return {
        ok: true,
        job: terminalReport("PRODUCTS", {
          taskId: options.body.jobId,
          requestId: options.body.requestId,
        }),
      };
    },
    onState(snapshot) {
      snapshots.push(structuredClone(snapshot));
    },
  });

  assert.deepEqual(calls.map((call) => call.path), ["/local/sync/PRODUCTS"]);
  assert.equal(states.length, 1);
  assert.equal(states[0].type, "PRODUCTS");
  assert.equal(states[0].status, "SUCCESS");
  assert.deepEqual(statusHistory(snapshots, "PRODUCTS"), [
    "PENDING",
    "RUNNING",
    "SUCCESS",
  ]);
});

test("a transport failure does not expose unstructured error text", async () => {
  const [state] = await runBackendStoreSync({
    storeId: "store-a",
    types: ["PRODUCTS"],
    request: async () => {
      throw Object.assign(new Error("Bearer transport-secret"), {
        code: "NETWORK_ERROR",
      });
    },
  });

  assert.equal(state.status, "FAILED");
  assert.equal(state.error.code, "NETWORK_ERROR");
  assert.equal(state.error.message, "店铺同步失败");
  assert.equal(JSON.stringify(state.error).includes("transport-secret"), false);
});

test("retired order and promotion syncs are rejected without a backend request", async () => {
  for (const type of ["POSTINGS", "PROMOTIONS"]) {
    let calls = 0;
    await assert.rejects(runBackendStoreSync({
      storeId: "store-a",
      types: [type],
      request: async () => { calls += 1; },
    }), { code: "STORE_SYNC_TYPE_UNSUPPORTED" });
    assert.equal(calls, 0);
  }
});
