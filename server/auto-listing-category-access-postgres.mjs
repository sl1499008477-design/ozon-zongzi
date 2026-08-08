import { decryptSecret as defaultDecryptSecret } from "./crypto-secrets.mjs";

function invalid() {
  const error = new Error("AUTO_LISTING_CATEGORY_ACCESS_INVALID");
  error.code = "AUTO_LISTING_CATEGORY_ACCESS_INVALID";
  error.status = 422;
  error.retryable = false;
  return error;
}

const required = (value) => {
  const result = typeof value === "string" ? value.trim() : "";
  if (!result) throw invalid();
  return result;
};

export function createAutoListingCategoryAccessPostgres({
  pool,
  decryptSecret = defaultDecryptSecret,
} = {}) {
  if (!pool || typeof pool.query !== "function" || typeof decryptSecret !== "function") {
    throw new TypeError("Auto listing category access dependencies are required");
  }
  return async function loadStoreAccess({ accountId, targetStoreId } = {}) {
    const scope = required(accountId);
    const storeId = required(targetStoreId);
    const result = await pool.query(
      `SELECT s.id,s.owner_account_id,s.client_id,
              sc.encrypted_api_key,sc.iv,sc.auth_tag
         FROM stores s
         JOIN store_credentials sc ON sc.store_id=s.id
        WHERE s.id=$1 AND s.owner_account_id=$2 AND s.status <> 'disabled'
          AND sc.encrypted_api_key <> '' AND sc.iv <> '' AND sc.auth_tag <> ''
        LIMIT 1`,
      [storeId, scope],
    );
    const row = result.rows?.[0];
    if (!row) return null;
    const apiKey = decryptSecret({
      encrypted_api_key: row.encrypted_api_key,
      iv: row.iv,
      auth_tag: row.auth_tag,
    });
    if (typeof apiKey !== "string" || !apiKey) throw invalid();
    return Object.freeze({
      id: row.id,
      ownerAccountId: row.owner_account_id,
      clientId: row.client_id,
      apiKey,
    });
  };
}
