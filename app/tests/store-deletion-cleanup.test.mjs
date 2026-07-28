import assert from "node:assert/strict";
import test from "node:test";
import { createStoreDeletionCleanup } from "../src/store-deletion-cleanup.js";
import { createStoreDeletionController } from "../src/store-deletion-controller.js";

const deletedStore = { id: "store-a", label: "Store A" };

test("successor store cleanup preserves the refreshed successor binding, syncs it, and does not log out", async () => {
  const calls = [];
  const storage = new Map([
    ["qh-local-binding-v1", JSON.stringify({ id: "store-b", storeName: "Store B" })],
    ["currentOzonStoreId", "store-b"],
    ["token", "token-b"],
  ]);
  let globalClearCalls = 0;
  const cleanup = createStoreDeletionCleanup({
    clearStoreStorage: () => {
      globalClearCalls += 1;
      storage.delete("qh-local-binding-v1");
      storage.delete("currentOzonStoreId");
    },
    readToken: () => storage.get("token"),
    setCurrentStoreId: (storeId) => {
      storage.set("currentOzonStoreId", storeId);
      calls.push(["current", storeId]);
    },
    syncAuthToExtension: async (payload) => {
      calls.push(["sync", payload]);
      return true;
    },
    logoutExtension: async () => calls.push(["logout"]),
  });

  await cleanup({ deletedStore, state: { currentStoreId: "store-b" } });

  assert.equal(globalClearCalls, 0);
  assert.equal(storage.get("qh-local-binding-v1"), JSON.stringify({ id: "store-b", storeName: "Store B" }));
  assert.deepEqual(calls, [
    ["current", "store-b"],
    ["sync", { token: "token-b", storeId: "store-b" }],
  ]);
});

test("no-successor cleanup clears deleted-store storage and logs out without syncing a store", async () => {
  const calls = [];
  const cleanup = createStoreDeletionCleanup({
    clearStoreStorage: (store) => calls.push(["clear", store]),
    readToken: () => "token-a",
    setCurrentStoreId: (storeId) => calls.push(["current", storeId]),
    syncAuthToExtension: async (payload) => calls.push(["sync", payload]),
    logoutExtension: async () => {
      calls.push(["logout"]);
      return true;
    },
  });

  await cleanup({ deletedStore, state: { currentStoreId: "" } });

  assert.deepEqual(calls, [
    ["clear", deletedStore],
    ["logout"],
  ]);
});

test("a cleanup handler error returns from the controller as cleanupError after deletion succeeds", async () => {
  const cleanup = createStoreDeletionCleanup({
    clearStoreStorage: () => {},
    readToken: () => "token-b",
    setCurrentStoreId: () => {},
    syncAuthToExtension: async () => {
      throw new Error("extension bridge unavailable");
    },
    logoutExtension: async () => true,
  });
  const refreshedState = { currentStoreId: "store-b" };
  const controller = createStoreDeletionController({
    deleteStore: async () => ({ state: {} }),
    refresh: async () => refreshedState,
    onStoreDeleted: cleanup,
  });

  const result = await controller.delete(deletedStore);

  assert.equal(result.state, refreshedState);
  assert.match(result.cleanupError?.message || "", /extension bridge unavailable/);
});
