import assert from "node:assert/strict";
import test from "node:test";
import {
  createStoreSwitchGate,
  storeSwitchActionState,
} from "../src/store-switch-gate.js";

test("store switch gate admits one target and cannot be released by another target", () => {
  const gate = createStoreSwitchGate();

  assert.equal(gate.begin("store-b"), true);
  assert.equal(gate.activeStoreId(), "store-b");
  assert.equal(gate.begin("store-c"), false);
  assert.equal(gate.finish("store-c"), false);
  assert.equal(gate.activeStoreId(), "store-b");
  assert.equal(gate.finish("store-b"), true);
  assert.equal(gate.activeStoreId(), "");
  assert.equal(gate.begin("store-c"), true);
});

test("store switch gate rejects missing identifiers without entering a busy state", () => {
  const gate = createStoreSwitchGate();

  assert.equal(gate.begin(""), false);
  assert.equal(gate.begin(null), false);
  assert.equal(gate.activeStoreId(), "");
});

test("store switch action renders the active target as loading and disables other targets", () => {
  assert.deepEqual(storeSwitchActionState({
    storeId: "store-b",
    switchingStoreId: "store-b",
  }), {
    disabled: true,
    loading: true,
    label: "切换中…",
  });
  assert.deepEqual(storeSwitchActionState({
    storeId: "store-c",
    switchingStoreId: "store-b",
  }), {
    disabled: true,
    loading: false,
    label: "切换",
  });
  assert.deepEqual(storeSwitchActionState({
    storeId: "store-c",
    switchingStoreId: "",
  }), {
    disabled: false,
    loading: false,
    label: "切换",
  });
});
