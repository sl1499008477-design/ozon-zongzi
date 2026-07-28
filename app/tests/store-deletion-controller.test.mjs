import assert from "node:assert/strict";
import test from "node:test";
import { createStoreDeletionController } from "../src/store-deletion-controller.js";

const deletedStore = { id: "store-a", label: "Store A" };

test("successful local deletion refreshes state before notifying AppShell once with the deleted store", async () => {
  const calls = [];
  const refreshedState = { currentStoreId: "store-b" };
  const controller = createStoreDeletionController({
    deleteStore: async (storeId) => {
      calls.push(["delete", storeId]);
      return { state: { currentStoreId: "ignored-before-refresh" } };
    },
    refresh: async (options) => {
      calls.push(["refresh", options]);
      return refreshedState;
    },
    onStoreDeleted: async (event) => {
      calls.push(["cleanup", event]);
    },
  });

  const result = await controller.delete(deletedStore);

  assert.equal(result, refreshedState);
  assert.deepEqual(calls, [
    ["delete", "store-a"],
    ["refresh", { silent: true }],
    ["cleanup", { deletedStore, state: refreshedState }],
  ]);
});

test("failed local deletion does not refresh or notify AppShell cleanup", async () => {
  const calls = [];
  const controller = createStoreDeletionController({
    deleteStore: async () => {
      calls.push("delete");
      throw new Error("delete rejected");
    },
    refresh: async () => calls.push("refresh"),
    onStoreDeleted: async () => calls.push("cleanup"),
  });

  await assert.rejects(controller.delete(deletedStore), /delete rejected/);
  assert.deepEqual(calls, ["delete"]);
});
