import assert from "node:assert/strict";
import test from "node:test";
import { deleteRemovedAccountScopes } from "../formal-persistence.mjs";

function statefulRelationalClient() {
  const calls = [];
  const rows = {
    accounts: [{ id: "account-target" }, { id: "account-other" }],
    collector_ozon_enrichment_cache: [
      { id: "cache-target", account_id: "account-target" },
      { id: "cache-other", account_id: "account-other" },
    ],
    collector_ozon_enrichment_jobs: [
      { id: "job-target", account_id: "account-target" },
      { id: "job-other", account_id: "account-other" },
    ],
    collector_auth_tickets: [
      { id: "ticket-target", account_id: "account-target" },
      { id: "ticket-other", account_id: "account-other" },
    ],
    collector_sessions: [
      { id: "session-target", account_id: "account-target" },
      { id: "session-other", account_id: "account-other" },
    ],
  };
  return {
    calls,
    rows,
    async query(sql, params = []) {
      const normalized = String(sql).replace(/\s+/g, " ").trim();
      calls.push({ sql: normalized, params });
      if (normalized.startsWith("SELECT id FROM accounts") && normalized.endsWith("FOR UPDATE")) {
        const found = rows.accounts.find((record) => record.id === params[0]);
        return { rows: found ? [found] : [], rowCount: found ? 1 : 0 };
      }
      if (normalized.startsWith("SELECT id FROM stores")) return { rows: [], rowCount: 0 };
      if (normalized.startsWith("SELECT data_collection_store_id")) return { rows: [], rowCount: 0 };
      const scopedDelete = normalized.match(/^DELETE FROM (collector_ozon_enrichment_jobs|collector_ozon_enrichment_cache|collector_auth_tickets|collector_sessions) WHERE account_id=\$1$/);
      if (scopedDelete) {
        const table = scopedDelete[1];
        const before = rows[table].length;
        rows[table] = rows[table].filter((record) => record.account_id !== params[0]);
        return { rows: [], rowCount: before - rows[table].length };
      }
      if (normalized === "DELETE FROM accounts WHERE id=$1") {
        const before = rows.accounts.length;
        rows.accounts = rows.accounts.filter((record) => record.id !== params[0]);
        return { rows: [], rowCount: before - rows.accounts.length };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

function deletionState() {
  const state = {
    auditEvents: [{
      action: "ACCOUNT_DELETED",
      entityId: "account-target",
      metadata: {
        deletedCollectorAuthTicketCount: 9,
        deletedCollectorSessionCount: 8,
        deletedCollectorOzonEnrichmentCacheCount: 7,
        deletedCollectorOzonEnrichmentJobCount: 6,
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
    configurable: true,
  });
  return state;
}

test("deleteRemovedAccountScopes removes only A, keeps B, and consumes the marker after commit", async () => {
  const client = statefulRelationalClient();
  const state = deletionState();

  const result = await deleteRemovedAccountScopes(client, state);

  const sql = client.calls.map((call) => call.sql);
  const accountDeleteIndex = sql.findIndex((statement) => statement.startsWith("DELETE FROM accounts"));
  const storeDeleteIndex = sql.findIndex((statement) => statement.startsWith("DELETE FROM stores"));
  const taskDeleteIndex = sql.findIndex((statement) => statement.startsWith("DELETE FROM collector_tasks"));
  const submissionDeleteIndex = sql.findIndex((statement) => statement.startsWith("DELETE FROM submission_jobs"));
  const collectorTicketDeleteIndex = sql.findIndex((statement) => statement.startsWith("DELETE FROM collector_auth_tickets"));
  const collectorSessionDeleteIndex = sql.findIndex((statement) => statement.startsWith("DELETE FROM collector_sessions"));
  const enrichmentCacheDeleteIndex = sql.findIndex((statement) => statement.startsWith("DELETE FROM collector_ozon_enrichment_cache"));
  const enrichmentJobDeleteIndex = sql.findIndex((statement) => statement.startsWith("DELETE FROM collector_ozon_enrichment_jobs"));
  const accountLockIndex = sql.findIndex((statement) =>
    statement.startsWith("SELECT id FROM accounts") && statement.endsWith("FOR UPDATE"));

  assert.ok(accountDeleteIndex > storeDeleteIndex);
  assert.ok(storeDeleteIndex > taskDeleteIndex);
  assert.ok(storeDeleteIndex > submissionDeleteIndex);
  assert.ok(accountLockIndex >= 0);
  assert.ok(collectorTicketDeleteIndex > accountLockIndex);
  assert.ok(collectorSessionDeleteIndex > accountLockIndex);
  assert.ok(accountDeleteIndex > collectorTicketDeleteIndex);
  assert.ok(accountDeleteIndex > collectorSessionDeleteIndex);
  assert.ok(enrichmentCacheDeleteIndex > accountLockIndex);
  assert.ok(enrichmentJobDeleteIndex > accountLockIndex);
  assert.ok(accountDeleteIndex > enrichmentCacheDeleteIndex);
  assert.ok(accountDeleteIndex > enrichmentJobDeleteIndex);
  assert.equal(sql.some((statement) => statement.includes("DELETE FROM audit_events")), false);
  assert.deepEqual(state.auditEvents[0].metadata, {
    deletedCollectorAuthTicketCount: 1,
    deletedCollectorSessionCount: 1,
    deletedCollectorOzonEnrichmentCacheCount: 1,
    deletedCollectorOzonEnrichmentJobCount: 1,
  });
  assert.deepEqual(client.rows.accounts, [{ id: "account-other" }]);
  assert.deepEqual(client.rows.collector_ozon_enrichment_cache, [
    { id: "cache-other", account_id: "account-other" },
  ]);
  assert.deepEqual(client.rows.collector_ozon_enrichment_jobs, [
    { id: "job-other", account_id: "account-other" },
  ]);
  assert.deepEqual(client.rows.collector_auth_tickets, [
    { id: "ticket-other", account_id: "account-other" },
  ]);
  assert.deepEqual(client.rows.collector_sessions, [
    { id: "session-other", account_id: "account-other" },
  ]);
  assert.equal(result.persistedStateChanged, true);
  assert.equal(Object.hasOwn(state, "__deletedAccountScopes"), true);

  result.afterCommit();
  assert.equal(Object.hasOwn(state, "__deletedAccountScopes"), false);
  const callCountAfterCommit = client.calls.length;
  await deleteRemovedAccountScopes(client, state);
  assert.equal(client.calls.length, callCountAfterCommit);
  assert.deepEqual(state.auditEvents[0].metadata, {
    deletedCollectorAuthTicketCount: 1,
    deletedCollectorSessionCount: 1,
    deletedCollectorOzonEnrichmentCacheCount: 1,
    deletedCollectorOzonEnrichmentJobCount: 1,
  });
});

test("deleteRemovedAccountScopes aborts before child deletes when the account lock finds no row", async () => {
  const client = statefulRelationalClient();
  client.rows.accounts = [{ id: "account-other" }];
  const state = deletionState();

  await assert.rejects(
    deleteRemovedAccountScopes(client, state),
    (error) => error?.code === "ACCOUNT_NOT_FOUND",
  );
  assert.equal(client.calls.filter((call) => call.sql.startsWith("DELETE FROM")).length, 0);
  assert.equal(Object.hasOwn(state, "__deletedAccountScopes"), true);
});

test("deleteRemovedAccountScopes is a no-op without a transaction marker", async () => {
  let called = false;
  await deleteRemovedAccountScopes({ query: async () => { called = true; } }, {});
  assert.equal(called, false);
});
