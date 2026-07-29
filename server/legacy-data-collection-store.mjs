function accountScopeRequired() {
  const error = new Error("历史数据采集店铺查询必须指定 sonli 账号");
  error.code = "ACCOUNT_SCOPE_REQUIRED";
  return error;
}

function publicLegacyRecord(row = {}) {
  return {
    id: row.data_collection_store_id || "",
    accountId: row.account_id || "",
    sellerCompanyId: row.seller_company_id || "",
    label: row.label || "",
    status: row.status || "",
    note: row.note || "",
    isCurrent: row.is_current === true,
    lastVerifiedAt: row.last_verified_at || "",
    createdAt: row.membership_created_at || "",
    updatedAt: row.membership_updated_at || "",
    readOnly: true,
  };
}

export async function readLegacyDataCollectionStoresForAudit(pool, { accountId } = {}) {
  const ownerId = String(accountId || "").trim();
  if (!ownerId) throw accountScopeRequired();
  if (!pool || typeof pool.query !== "function") {
    throw new TypeError("历史数据采集店铺查询需要 PostgreSQL 连接池");
  }
  const result = await pool.query(
    `SELECT m.account_id, m.data_collection_store_id, m.label, m.status, m.note,
            m.is_current, m.last_verified_at, m.created_at AS membership_created_at,
            m.updated_at AS membership_updated_at, s.seller_company_id
     FROM account_data_collection_stores m
     JOIN data_collection_stores s ON s.id=m.data_collection_store_id
     WHERE m.account_id=$1
     ORDER BY m.updated_at DESC, m.data_collection_store_id`,
    [ownerId],
  );
  return (result.rows || []).map(publicLegacyRecord);
}
