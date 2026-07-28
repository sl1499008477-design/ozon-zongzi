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
      return { rows: [], rowCount: 1 };
    },
  };
  const state = {};
  Object.defineProperty(state, "__deletedAccountScopes", {
    value: [{ accountId: "account-target", storeIds: ["store-local"] }],
    enumerable: false,
  });

  await deleteRemovedAccountScopes(client, state);

  const sql = calls.map((call) => call.sql);
  const accountDeleteIndex = sql.findIndex((statement) => statement.startsWith("DELETE FROM accounts"));
  const storeDeleteIndex = sql.findIndex((statement) => statement.startsWith("DELETE FROM stores"));
  const taskDeleteIndex = sql.findIndex((statement) => statement.startsWith("DELETE FROM collector_tasks"));
  const submissionDeleteIndex = sql.findIndex((statement) => statement.startsWith("DELETE FROM submission_jobs"));

  assert.ok(accountDeleteIndex > storeDeleteIndex);
  assert.ok(storeDeleteIndex > taskDeleteIndex);
  assert.ok(storeDeleteIndex > submissionDeleteIndex);
  assert.equal(sql.some((statement) => statement.includes("DELETE FROM audit_events")), false);
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
