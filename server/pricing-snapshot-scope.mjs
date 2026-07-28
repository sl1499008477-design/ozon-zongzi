function forbiddenTarget() {
  const error = new Error("算价快照目标不属于当前账号或经营店铺");
  error.status = 403;
  error.code = "PRICING_SNAPSHOT_TARGET_FORBIDDEN";
  return error;
}

export async function updateScopedPricingSnapshotTargets({ pool, accountId, storeId, draftId = null, submissionSnapshotId = null, pricingSnapshot }) {
  const snapshotJson = JSON.stringify(pricingSnapshot);
  if (draftId) {
    const result = await pool.query(`UPDATE product_drafts draft
      SET pricing_snapshot = $2::jsonb, updated_at = NOW()
      FROM collect_items item
      WHERE draft.id = $1
        AND draft.collect_item_id = item.id
        AND item.account_id = $3
        AND item.store_id = $4`, [draftId, snapshotJson, accountId, storeId]);
    if (result.rowCount !== 1) throw forbiddenTarget();
  }
  if (submissionSnapshotId) {
    const result = await pool.query(`UPDATE submission_snapshots
      SET pricing_snapshot = $2::jsonb
      WHERE id = $1 AND account_id = $3 AND store_id = $4`, [submissionSnapshotId, snapshotJson, accountId, storeId]);
    if (result.rowCount !== 1) throw forbiddenTarget();
  }
}
