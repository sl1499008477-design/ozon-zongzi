import assert from "node:assert/strict";
import { test } from "node:test";
import {
  persistPostgresStateAtomically,
} from "../postgres-state-transaction.mjs";

function fakeClient({ updateRows = [{ version: 8 }] } = {}) {
  const queries = [];
  return {
    queries,
    async query(sql) {
      const normalized = String(sql).trim();
      queries.push(normalized);
      if (normalized.startsWith("UPDATE local_state")) {
        return { rowCount: updateRows.length, rows: updateRows };
      }
      return { rowCount: 1, rows: [] };
    },
  };
}

test("formal mirror succeeds before the local state transaction commits", async () => {
  const state = {};
  Object.defineProperty(state, "__storageVersion", { value: 7, writable: true, configurable: true });
  const client = fakeClient();
  let mirrored = false;
  await persistPostgresStateAtomically({
    client,
    table: "local_state",
    state,
    protectedState: { ok: true },
    mirror: async () => {
      mirrored = true;
      assert.equal(client.queries.includes("COMMIT"), false);
    },
  });
  assert.equal(mirrored, true);
  assert.equal(client.queries.at(-1), "COMMIT");
  assert.equal(state.__storageVersion, 8);
});

test("formal mirror failure rolls back both representations and keeps the old version", async () => {
  const state = {};
  Object.defineProperty(state, "__storageVersion", { value: 7, writable: true, configurable: true });
  const client = fakeClient();
  await assert.rejects(
    persistPostgresStateAtomically({
      client,
      table: "local_state",
      state,
      protectedState: { ok: true },
      mirror: async () => {
        throw new Error("formal mirror unavailable");
      },
    }),
    /formal mirror unavailable/,
  );
  assert.equal(client.queries.includes("COMMIT"), false);
  assert.equal(client.queries.at(-1), "ROLLBACK");
  assert.equal(state.__storageVersion, 7);
});

test("version conflict fails before formal tables are changed", async () => {
  const state = {};
  Object.defineProperty(state, "__storageVersion", { value: 7, writable: true, configurable: true });
  const client = fakeClient({ updateRows: [] });
  let mirrorCalls = 0;
  await assert.rejects(
    persistPostgresStateAtomically({
      client,
      table: "local_state",
      state,
      protectedState: { ok: true },
      mirror: async () => {
        mirrorCalls += 1;
      },
    }),
    (error) => error.code === "LOCAL_STATE_VERSION_CONFLICT" && error.status === 409,
  );
  assert.equal(mirrorCalls, 0);
  assert.equal(client.queries.at(-1), "ROLLBACK");
});
