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

test("formal mirror audit mutations refresh local state in the same version before commit", async () => {
  const queries = [];
  const client = {
    async query(sql, values = []) {
      const normalized = String(sql).trim();
      queries.push({ sql: normalized, values });
      if (normalized.startsWith("UPDATE local_state")) {
        return { rowCount: 1, rows: [{ version: 8 }] };
      }
      return { rowCount: 1, rows: [] };
    },
  };
  const state = {
    auditEvents: [{
      action: "ACCOUNT_DELETED",
      metadata: {
        deletedCollectorAuthTicketCount: 0,
        deletedCollectorSessionCount: 0,
      },
    }],
  };
  Object.defineProperty(state, "__storageVersion", { value: 7, writable: true, configurable: true });

  await persistPostgresStateAtomically({
    client,
    table: "local_state",
    state,
    protectedState: structuredClone(state),
    refreshProtectedState: (currentState) => structuredClone(currentState),
    mirror: async () => {
      state.auditEvents[0].metadata.deletedCollectorAuthTicketCount = 1;
      state.auditEvents[0].metadata.deletedCollectorSessionCount = 1;
      return { persistedStateChanged: true };
    },
  });

  const stateUpdates = queries.filter((query) => query.sql.startsWith("UPDATE local_state"));
  assert.equal(stateUpdates.length, 2);
  assert.deepEqual(
    JSON.parse(stateUpdates[1].values[0]).auditEvents[0].metadata,
    {
      deletedCollectorAuthTicketCount: 1,
      deletedCollectorSessionCount: 1,
    },
  );
  assert.equal(stateUpdates[1].values[2], 8);
  assert.equal(queries.at(-1).sql, "COMMIT");
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
