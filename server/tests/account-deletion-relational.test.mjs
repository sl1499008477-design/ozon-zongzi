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
      { id: "job-target", account_id: "account-target", collect_item_id: "collect-target" },
      { id: "job-other", account_id: "account-other", collect_item_id: "collect-other" },
    ],
    collect_ozon_category_source_evidence: [
      { id: "evidence-target", account_id: "account-target", collect_item_id: "collect-target" },
      { id: "evidence-other", account_id: "account-other", collect_item_id: "collect-other" },
    ],
    account_ozon_shared_categories: [
      { id: "shared-target", account_id: "account-target", source_evidence_id: "evidence-target" },
      { id: "shared-other", account_id: "account-other", source_evidence_id: "evidence-other" },
    ],
    account_ozon_shared_category_events: [
      { id: "event-target", account_id: "account-target", shared_category_id: "shared-target" },
      { id: "event-other", account_id: "account-other", shared_category_id: "shared-other" },
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
      if (normalized.startsWith("SELECT (SELECT COUNT(*)::INT FROM account_ozon_shared_category_events")) {
        return {
          rows: [{
            deleted_account_ozon_shared_category_event_count:
              rows.account_ozon_shared_category_events.filter((record) => record.account_id === params[0]).length,
            deleted_account_ozon_shared_category_count:
              rows.account_ozon_shared_categories.filter((record) => record.account_id === params[0]).length,
            deleted_collect_ozon_category_source_evidence_count:
              rows.collect_ozon_category_source_evidence.filter((record) => record.account_id === params[0]).length,
          }],
          rowCount: 1,
        };
      }
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
        for (const table of [
          "account_ozon_shared_category_events",
          "account_ozon_shared_categories",
          "collect_ozon_category_source_evidence",
        ]) {
          rows[table] = rows[table].filter((record) => record.account_id !== params[0]);
        }
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
        deletedAccountOzonSharedCategoryEventCount: 5,
        deletedAccountOzonSharedCategoryCount: 4,
        deletedCollectOzonCategorySourceEvidenceCount: 3,
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
  const categoryCountIndex = sql.findIndex((statement) =>
    statement.startsWith("SELECT (SELECT COUNT(*)::INT FROM account_ozon_shared_category_events"));
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
  assert.ok(categoryCountIndex > accountLockIndex);
  assert.ok(accountDeleteIndex > categoryCountIndex);
  assert.equal(sql.some((statement) => statement.includes("collect_category_resolutions")), false);
  assert.equal(sql.some((statement) => statement.startsWith("DELETE FROM account_ozon_shared_")), false);
  assert.equal(sql.some((statement) => statement.startsWith("DELETE FROM collect_ozon_category_source_evidence")), false);
  assert.equal(sql.some((statement) => statement.includes("DELETE FROM audit_events")), false);
  assert.deepEqual(state.auditEvents[0].metadata, {
    deletedCollectorAuthTicketCount: 1,
    deletedCollectorSessionCount: 1,
    deletedCollectorOzonEnrichmentCacheCount: 1,
    deletedCollectorOzonEnrichmentJobCount: 1,
    deletedAccountOzonSharedCategoryEventCount: 1,
    deletedAccountOzonSharedCategoryCount: 1,
    deletedCollectOzonCategorySourceEvidenceCount: 1,
  });
  assert.deepEqual(client.rows.accounts, [{ id: "account-other" }]);
  assert.deepEqual(client.rows.collector_ozon_enrichment_cache, [
    { id: "cache-other", account_id: "account-other" },
  ]);
  assert.deepEqual(client.rows.collector_ozon_enrichment_jobs, [
    { id: "job-other", account_id: "account-other", collect_item_id: "collect-other" },
  ]);
  assert.deepEqual(client.rows.collect_ozon_category_source_evidence, [
    { id: "evidence-other", account_id: "account-other", collect_item_id: "collect-other" },
  ]);
  assert.deepEqual(client.rows.account_ozon_shared_categories, [
    { id: "shared-other", account_id: "account-other", source_evidence_id: "evidence-other" },
  ]);
  assert.deepEqual(client.rows.account_ozon_shared_category_events, [
    { id: "event-other", account_id: "account-other", shared_category_id: "shared-other" },
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
    deletedAccountOzonSharedCategoryEventCount: 1,
    deletedAccountOzonSharedCategoryCount: 1,
    deletedCollectOzonCategorySourceEvidenceCount: 1,
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
