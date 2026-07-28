import assert from "node:assert/strict";
import test from "node:test";

process.env.QH_LOCAL_NO_DOTENV = "1";
delete process.env.DATABASE_URL;
delete process.env.POSTGRES_HOST;

const { savePricingSnapshot } = await import("../pricing-config-service.mjs");

function snapshotInput(transactionPool) {
  return {
    accountId: "acct_a",
    storeId: "store_a",
    draftId: "draft_a",
    submissionSnapshotId: "submission_a",
    input: { purchaseCostCny: 1 },
    result: { mode: "profit" },
    config: { id: "config_a" },
    transactionPool,
  };
}

function createTransactionalPool({ draftRowCount = 1, submissionRowCount = 1 } = {}) {
  const calls = [];
  const committed = { inserts: 0, draftUpdates: 0, submissionUpdates: 0 };
  let pending = null;
  const client = {
    async query(sql) {
      const normalized = String(sql).trim();
      if (normalized === "BEGIN") { calls.push("BEGIN"); pending = { inserts: 0, draftUpdates: 0, submissionUpdates: 0 }; return { rowCount: 0 }; }
      if (normalized === "COMMIT") { calls.push("COMMIT"); Object.assign(committed, pending); pending = null; return { rowCount: 0 }; }
      if (normalized === "ROLLBACK") { calls.push("ROLLBACK"); pending = null; return { rowCount: 0 }; }
      if (normalized.startsWith("UPDATE product_drafts")) { calls.push("DRAFT_UPDATE"); if (draftRowCount === 1) pending.draftUpdates += 1; return { rowCount: draftRowCount }; }
      if (normalized.startsWith("UPDATE submission_snapshots")) { calls.push("SUBMISSION_UPDATE"); if (submissionRowCount === 1) pending.submissionUpdates += 1; return { rowCount: submissionRowCount }; }
      if (normalized.startsWith("INSERT INTO pricing_calculation_snapshots")) { calls.push("SNAPSHOT_INSERT"); pending.inserts += 1; return { rowCount: 1 }; }
      throw new Error(`unexpected SQL: ${normalized}`);
    },
    release() { calls.push("RELEASE"); },
  };
  return { pool: { async connect() { calls.push("CONNECT"); return client; } }, calls, committed };
}

test("savePricingSnapshot atomically commits same-scope targets and snapshot on one client", async () => {
  const fixture = createTransactionalPool();
  await savePricingSnapshot(snapshotInput(fixture.pool));
  assert.deepEqual(fixture.calls, ["CONNECT", "BEGIN", "DRAFT_UPDATE", "SUBMISSION_UPDATE", "SNAPSHOT_INSERT", "COMMIT", "RELEASE"]);
  assert.deepEqual(fixture.committed, { inserts: 1, draftUpdates: 1, submissionUpdates: 1 });
});

test("savePricingSnapshot rolls back without an insert when a draft target is cross-tenant", async () => {
  const fixture = createTransactionalPool({ draftRowCount: 0 });
  await assert.rejects(
    () => savePricingSnapshot(snapshotInput(fixture.pool)),
    (error) => error?.status === 403 && error?.code === "PRICING_SNAPSHOT_TARGET_FORBIDDEN",
  );
  assert.deepEqual(fixture.calls, ["CONNECT", "BEGIN", "DRAFT_UPDATE", "ROLLBACK", "RELEASE"]);
  assert.deepEqual(fixture.committed, { inserts: 0, draftUpdates: 0, submissionUpdates: 0 });
});

test("savePricingSnapshot rolls back a prior draft update when submission scope rejects", async () => {
  const fixture = createTransactionalPool({ submissionRowCount: 0 });
  await assert.rejects(
    () => savePricingSnapshot(snapshotInput(fixture.pool)),
    (error) => error?.status === 403 && error?.code === "PRICING_SNAPSHOT_TARGET_FORBIDDEN",
  );
  assert.deepEqual(fixture.calls, ["CONNECT", "BEGIN", "DRAFT_UPDATE", "SUBMISSION_UPDATE", "ROLLBACK", "RELEASE"]);
  assert.deepEqual(fixture.committed, { inserts: 0, draftUpdates: 0, submissionUpdates: 0 });
});
