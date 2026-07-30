import assert from "node:assert/strict";
import test from "node:test";
import { deleteRemovedAccountScopes } from "../formal-persistence.mjs";

test("deleteRemovedAccountScopes removes relational business data before the account and keeps audit events", async () => {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      const normalized = String(sql).replace(/\s+/g, " ").trim();
      calls.push({ sql: normalized, params });
      if (normalized.startsWith("SELECT id FROM stores")) {
        return { rows: [{ id: "store-formal" }] };
      }
      if (normalized.startsWith("SELECT data_collection_store_id")) {
        return { rows: [{ data_collection_store_id: "collector-formal" }] };
      }
      if (normalized.startsWith("DELETE FROM collector_auth_tickets")) {
        return { rows: [], rowCount: 2 };
      }
      if (normalized.startsWith("DELETE FROM collector_sessions")) {
        return { rows: [], rowCount: 3 };
      }
      return { rows: [], rowCount: 1 };
    },
  };
  const state = {
    auditEvents: [{
      action: "ACCOUNT_DELETED",
      entityId: "account-target",
      metadata: {
        deletedCollectorAuthTicketCount: 9,
        deletedCollectorSessionCount: 8,
      },
    }],
  };
  Object.defineProperty(state, "__deletedAccountScopes", {
    value: [{
      accountId: "account-target",
      storeIds: ["store-local"],
      legacyDataStorePurgePolicy: {
        actor: { type: "account", id: "admin-test" },
        reason: "ACCOUNT_DELETION_PRIVACY_ERASURE",
        occurredAt: "2026-07-30T10:00:00.000Z",
      },
    }],
    enumerable: false,
  });

  const result = await deleteRemovedAccountScopes(client, state);

  const sql = calls.map((call) => call.sql);
  const accountDeleteIndex = sql.findIndex((statement) => statement.startsWith("DELETE FROM accounts"));
  const storeDeleteIndex = sql.findIndex((statement) => statement.startsWith("DELETE FROM stores"));
  const taskDeleteIndex = sql.findIndex((statement) => statement.startsWith("DELETE FROM collector_tasks"));
  const submissionDeleteIndex = sql.findIndex((statement) => statement.startsWith("DELETE FROM submission_jobs"));
  const collectorTicketDeleteIndex = sql.findIndex(
    (statement) => statement.startsWith("DELETE FROM collector_auth_tickets"),
  );
  const collectorSessionDeleteIndex = sql.findIndex(
    (statement) => statement.startsWith("DELETE FROM collector_sessions"),
  );
  const accountLockIndex = sql.findIndex(
    (statement) => statement.startsWith("SELECT id FROM accounts")
      && statement.endsWith("FOR UPDATE"),
  );

  assert.ok(accountDeleteIndex > storeDeleteIndex);
  assert.ok(storeDeleteIndex > taskDeleteIndex);
  assert.ok(storeDeleteIndex > submissionDeleteIndex);
  assert.ok(accountLockIndex >= 0);
  assert.ok(collectorTicketDeleteIndex > accountLockIndex);
  assert.ok(collectorSessionDeleteIndex > accountLockIndex);
  assert.ok(accountDeleteIndex > collectorTicketDeleteIndex);
  assert.ok(accountDeleteIndex > collectorSessionDeleteIndex);
  assert.equal(sql.some((statement) => statement.includes("DELETE FROM audit_events")), false);
  assert.deepEqual(state.auditEvents[0].metadata, {
    deletedCollectorAuthTicketCount: 2,
    deletedCollectorSessionCount: 3,
  });
  assert.equal(result.persistedStateChanged, true);
  assert.ok(
    calls.some((call) =>
      call.params.some((param) => Array.isArray(param) && param.includes("store-formal"))),
  );
});

test("deleteRemovedAccountScopes is a no-op without a transaction marker", async () => {
  let called = false;
  await deleteRemovedAccountScopes({ query: async () => { called = true; } }, {});
  assert.equal(called, false);
});
