import assert from "node:assert/strict";
import test from "node:test";
import { updateScopedPricingSnapshotTargets } from "../pricing-snapshot-scope.mjs";

test("pricing snapshot updates same-account same-store targets", async () => {
  const calls = [];
  const pool = { query: async (sql, params) => { calls.push({ sql, params }); return { rowCount: 1 }; } };
  await updateScopedPricingSnapshotTargets({
    pool, accountId: "acct_a", storeId: "store_a", draftId: "draft_a", submissionSnapshotId: "submission_a", pricingSnapshot: { id: "pricing_a" },
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].params.slice(0, 3), ["draft_a", JSON.stringify({ id: "pricing_a" }), "acct_a"]);
  assert.deepEqual(calls[1].params.slice(0, 4), ["submission_a", JSON.stringify({ id: "pricing_a" }), "acct_a", "store_a"]);
});

for (const [name, result] of [["cross-account", { rowCount: 0 }], ["cross-store", { rowCount: 0 }]]) {
  test(`pricing snapshot rejects ${name} target updates`, async () => {
    const pool = { query: async () => result };
    await assert.rejects(
      () => updateScopedPricingSnapshotTargets({ pool, accountId: "acct_a", storeId: "store_a", draftId: "draft_x", pricingSnapshot: {} }),
      (error) => error?.status === 403 && error?.code === "PRICING_SNAPSHOT_TARGET_FORBIDDEN",
    );
  });
}
