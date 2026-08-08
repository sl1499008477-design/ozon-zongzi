import crypto from "node:crypto";

const INPUT_KEYS = new Set([
  "accountId", "actorId", "mode", "publicationReason", "idempotencyKey", "correlationId",
  "publicationOrigin", "publicationBaseUrl", "publicationPrefix", "publicationVersion",
  "publicationPolicyHash", "healthEvidenceId",
]);
const REPLAY_INPUT_KEYS = new Set(["accountId", "mode", "publicationReason", "idempotencyKey"]);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/u;
const SAFE_HASH = /^[a-f0-9]{64}$/u;
const COLUMNS = `id,account_id,version,mode,enabled,publication_reason,published_by,published_at,
  publication_origin,publication_base_url,publication_prefix,publication_version,publication_policy_hash`;

function repositoryError(code, status = 422, retryable = false) {
  const error = new Error("自动上架上传策略数据操作失败");
  error.code = code;
  error.status = status;
  error.retryable = retryable;
  return error;
}

function invalid() {
  return repositoryError("AUTO_LISTING_UPLOAD_POLICY_ADMIN_REPOSITORY_INVALID");
}

function databaseFailed() {
  return repositoryError("AUTO_LISTING_UPLOAD_POLICY_ADMIN_FAILED", 503, true);
}

function id(value) {
  const result = typeof value === "string" ? value.trim() : "";
  if (!SAFE_ID.test(result)) throw invalid();
  return result;
}

function map(row, duplicate = false) {
  if (!row) return null;
  return {
    id: row.id, accountId: row.account_id, version: Number(row.version), mode: row.mode,
    enabled: row.enabled === true, publicationReason: row.publication_reason,
    publishedBy: row.published_by, publishedAt: new Date(row.published_at).toISOString(),
    publicationOrigin: row.publication_origin, publicationBaseUrl: row.publication_base_url,
    publicationPrefix: row.publication_prefix, publicationVersion: row.publication_version,
    publicationPolicyHash: row.publication_policy_hash, duplicate,
  };
}

function exactInput(raw) {
  try {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) throw invalid();
    const own = Reflect.ownKeys(raw);
    const descriptors = Object.getOwnPropertyDescriptors(raw);
    if (own.length !== INPUT_KEYS.size || own.some((key) => typeof key !== "string" || !INPUT_KEYS.has(key)
      || descriptors[key]?.enumerable !== true || !Object.hasOwn(descriptors[key], "value"))) throw invalid();
    const input = Object.fromEntries(own.map((key) => [key, descriptors[key].value]));
    input.accountId = id(input.accountId);
    input.actorId = id(input.actorId);
    input.idempotencyKey = id(input.idempotencyKey);
    input.correlationId = id(input.correlationId);
    if (input.actorId !== input.accountId || !["REVIEW", "DIRECT"].includes(input.mode)
      || typeof input.publicationReason !== "string" || !input.publicationReason.trim()
      || Buffer.byteLength(input.publicationReason.trim(), "utf8") > 500
      || typeof input.publicationOrigin !== "string" || typeof input.publicationBaseUrl !== "string"
      || typeof input.publicationPrefix !== "string" || typeof input.publicationVersion !== "string"
      || !SAFE_HASH.test(input.publicationPolicyHash || "")
      || (input.mode === "REVIEW" && input.healthEvidenceId !== null)
      || (input.mode === "DIRECT" && !SAFE_ID.test(input.healthEvidenceId || ""))) throw invalid();
    let url;
    try { url = new URL(input.publicationBaseUrl); } catch { throw invalid(); }
    if (url.protocol !== "https:" || url.origin !== input.publicationOrigin || url.href !== input.publicationBaseUrl
      || !url.pathname.endsWith("/") || !/^[A-Za-z0-9][A-Za-z0-9/_-]{0,159}$/u.test(input.publicationPrefix)
      || input.publicationPrefix.includes("//") || input.publicationPrefix.endsWith("/")
      || !/^[A-Z0-9][A-Z0-9_-]{0,63}$/u.test(input.publicationVersion)) throw invalid();
    input.publicationReason = input.publicationReason.trim();
    return input;
  } catch (error) {
    if (error?.code === "AUTO_LISTING_UPLOAD_POLICY_ADMIN_REPOSITORY_INVALID") throw error;
    throw invalid();
  }
}

function exactReplayInput(raw) {
  try {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) throw invalid();
    const own = Reflect.ownKeys(raw);
    const descriptors = Object.getOwnPropertyDescriptors(raw);
    if (own.length !== REPLAY_INPUT_KEYS.size || own.some((key) => typeof key !== "string"
      || !REPLAY_INPUT_KEYS.has(key) || descriptors[key]?.enumerable !== true
      || !Object.hasOwn(descriptors[key], "value"))) throw invalid();
    const input = Object.fromEntries(own.map((key) => [key, descriptors[key].value]));
    input.accountId = id(input.accountId);
    input.idempotencyKey = id(input.idempotencyKey);
    if (!["REVIEW", "DIRECT"].includes(input.mode) || typeof input.publicationReason !== "string"
      || !input.publicationReason.trim() || Buffer.byteLength(input.publicationReason.trim(), "utf8") > 500) {
      throw invalid();
    }
    input.publicationReason = input.publicationReason.trim();
    return input;
  } catch (error) {
    if (error?.code === "AUTO_LISTING_UPLOAD_POLICY_ADMIN_REPOSITORY_INVALID") throw error;
    throw invalid();
  }
}

function canonical(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") throw invalid();
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function hash(value) {
  return crypto.createHash("sha256").update(JSON.stringify(canonical(value)), "utf8").digest("hex");
}

function deterministicId(prefix, ...parts) {
  return `${prefix}-${crypto.createHash("sha256").update(parts.join("\0"), "utf8").digest("hex").slice(0, 40)}`;
}

async function query(target, sql, params = []) {
  try { return await target.query(sql, params); } catch (error) {
    if (typeof error?.code === "string" && error.code.startsWith("AUTO_LISTING_UPLOAD_POLICY_ADMIN_")) throw error;
    throw databaseFailed();
  }
}

async function transaction(pool, operation) {
  let client;
  try { client = await pool.connect(); } catch { throw databaseFailed(); }
  let committed = false;
  try {
    await query(client, "BEGIN");
    await query(client, "SET LOCAL statement_timeout='25s'");
    await query(client, "SET LOCAL lock_timeout='5s'");
    await query(client, "SET LOCAL idle_in_transaction_session_timeout='30s'");
    const result = await operation(client);
    await query(client, "COMMIT");
    committed = true;
    return result;
  } catch (error) {
    if (!committed) await query(client, "ROLLBACK").catch(() => {});
    throw error;
  } finally {
    try { await client.release(); } catch { /* best effort */ }
  }
}

export function createPostgresAutoListingUploadPolicyAdminRepository({ pool } = {}) {
  if (typeof pool?.query !== "function" || typeof pool?.connect !== "function") {
    throw new TypeError("Auto-listing upload policy admin PostgreSQL pool is required");
  }
  return Object.freeze({
    async findPolicyReplay(raw = {}) {
      const input = exactReplayInput(raw);
      const requestHash = hash({ mode: input.mode, publicationReason: input.publicationReason });
      const auditId = deterministicId("audit-auto-listing-upload-policy", input.accountId, input.idempotencyKey);
      const replay = await query(pool,
        `SELECT metadata FROM audit_events
         WHERE event_id=$1 AND account_id=$2 AND action='AUTO_LISTING_UPLOAD_POLICY_PUBLISHED'`,
        [auditId, input.accountId]);
      if (!replay.rows[0]) return null;
      const metadata = replay.rows[0].metadata;
      if (metadata?.requestHash !== requestHash || !SAFE_ID.test(metadata?.policyId || "")) {
        throw repositoryError("AUTO_LISTING_UPLOAD_POLICY_ADMIN_CONFLICT", 409);
      }
      const existing = await query(pool,
        `SELECT ${COLUMNS} FROM auto_listing_upload_policy_versions
         WHERE account_id=$1 AND id=$2`, [input.accountId, metadata.policyId]);
      if (!existing.rows[0]) throw repositoryError("AUTO_LISTING_UPLOAD_POLICY_ADMIN_DATA_BOUNDARY", 500);
      return map(existing.rows[0], true);
    },

    async listPolicies({ accountId } = {}) {
      const account = id(accountId);
      const result = await query(pool,
        `SELECT ${COLUMNS} FROM auto_listing_upload_policy_versions
         WHERE account_id=$1 AND enabled=TRUE AND published_at IS NOT NULL
           AND publication_origin IS NOT NULL AND publication_base_url IS NOT NULL
           AND publication_prefix IS NOT NULL AND publication_version IS NOT NULL
           AND publication_policy_hash ~ '^[a-f0-9]{64}$'
         ORDER BY version DESC,id DESC LIMIT 1000`, [account]);
      return result.rows.map((row) => map(row));
    },

    async publishPolicy(raw = {}) {
      const input = exactInput(raw);
      const requestHash = hash({ mode: input.mode, publicationReason: input.publicationReason });
      const auditId = deterministicId("audit-auto-listing-upload-policy", input.accountId, input.idempotencyKey);
      const policyId = deterministicId("auto-listing-upload-policy", input.accountId, input.idempotencyKey);
      return transaction(pool, async (client) => {
        const account = await query(client,
          "SELECT id,role FROM accounts WHERE id=$1 FOR UPDATE", [input.accountId]);
        if (account.rows[0]?.id !== input.accountId || account.rows[0]?.role !== "admin") {
          throw repositoryError("AUTO_LISTING_UPLOAD_POLICY_ADMIN_SCOPE_NOT_FOUND", 404);
        }
        const replay = await query(client,
          `SELECT metadata FROM audit_events
           WHERE event_id=$1 AND account_id=$2 AND action='AUTO_LISTING_UPLOAD_POLICY_PUBLISHED'
           FOR UPDATE`, [auditId, input.accountId]);
        if (replay.rows[0]) {
          const metadata = replay.rows[0].metadata;
          if (metadata?.requestHash !== requestHash || !SAFE_ID.test(metadata?.policyId || "")) {
            throw repositoryError("AUTO_LISTING_UPLOAD_POLICY_ADMIN_CONFLICT", 409);
          }
          const existing = await query(client,
            `SELECT ${COLUMNS} FROM auto_listing_upload_policy_versions
             WHERE account_id=$1 AND id=$2`, [input.accountId, metadata.policyId]);
          if (!existing.rows[0]) throw repositoryError("AUTO_LISTING_UPLOAD_POLICY_ADMIN_DATA_BOUNDARY", 500);
          return map(existing.rows[0], true);
        }
        if (input.mode === "DIRECT") {
          const ready = await query(client,
            `SELECT id FROM auto_listing_asset_publication_health_evidence
             WHERE account_id=$1 AND id=$2 AND outcome='PASSED' AND expires_at>NOW()
               AND publication_version=$3 AND public_base_url=$4 AND public_prefix=$5
             FOR SHARE`, [input.accountId, input.healthEvidenceId, input.publicationVersion,
              input.publicationBaseUrl, input.publicationPrefix]);
          if (ready.rows[0]?.id !== input.healthEvidenceId) {
            throw repositoryError("AUTO_LISTING_DIRECT_POLICY_NOT_READY", 503, true);
          }
        }
        const versionResult = await query(client,
          `SELECT COALESCE(MAX(version),0)::INTEGER AS current_version
           FROM auto_listing_upload_policy_versions WHERE account_id=$1`, [input.accountId]);
        const version = Number(versionResult.rows[0]?.current_version || 0) + 1;
        if (!Number.isSafeInteger(version) || version < 1 || version > 2_147_483_647) throw invalid();
        const inserted = await query(client,
          `INSERT INTO auto_listing_upload_policy_versions (
             id,account_id,mode,enabled,version,publication_reason,created_by,published_by,
             created_at,published_at,publication_origin,publication_base_url,publication_prefix,
             publication_version,publication_policy_hash
           ) VALUES ($1,$2,$3,TRUE,$4,$5,$2,$2,NOW(),NOW(),$6,$7,$8,$9,$10)
           RETURNING ${COLUMNS}`,
          [policyId, input.accountId, input.mode, version, input.publicationReason,
            input.publicationOrigin, input.publicationBaseUrl, input.publicationPrefix,
            input.publicationVersion, input.publicationPolicyHash]);
        if (!inserted.rows[0]) throw databaseFailed();
        const metadata = {
          requestHash, policyId, version, mode: input.mode,
          publicationPolicyHash: input.publicationPolicyHash,
          healthEvidenceId: input.healthEvidenceId,
        };
        const audit = await query(client,
          `INSERT INTO audit_events (
             event_id,account_id,store_id,action,status,actor_type,actor_id,device_id,source,
             entity_type,entity_id,correlation_id,metadata,occurred_at,created_at
           ) VALUES ($1,$2,NULL,'AUTO_LISTING_UPLOAD_POLICY_PUBLISHED','SUCCESS','account',$2,'',
             'auto-listing-upload-policy','auto_listing_upload_policy',$3,$4,$5::JSONB,NOW(),NOW())
           ON CONFLICT (event_id) WHERE event_id IS NOT NULL DO NOTHING RETURNING event_id`,
          [auditId, input.accountId, policyId, input.correlationId, JSON.stringify(metadata)]);
        if (audit.rowCount !== 1) throw repositoryError("AUTO_LISTING_UPLOAD_POLICY_ADMIN_CONFLICT", 409);
        return map(inserted.rows[0], false);
      });
    },
  });
}
