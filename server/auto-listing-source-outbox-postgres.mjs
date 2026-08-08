import crypto from "node:crypto";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/u;
const FAILURE_CODES = new Set([
  "OZON_SKU_COLLECTION_FAILED",
  "OZON_SKU_SCRAPE_EMPTY",
  "AUTO_LISTING_SOURCE_RESULT_INVALID",
]);

function outboxError(code, status = 422, retryable = false) {
  const error = new Error(code);
  error.code = code;
  error.status = status;
  error.retryable = retryable;
  return error;
}

function id(value) {
  const result = typeof value === "string" ? value.trim() : "";
  if (!SAFE_ID.test(result)) throw outboxError("AUTO_LISTING_SOURCE_OUTBOX_INVALID");
  return result;
}

function recordId(value) {
  const result = typeof value === "string" ? value.trim() : "";
  if (!result || result.length > 240 || /[/\\\u0000-\u001f\u007f]/u.test(result)) {
    throw outboxError("AUTO_LISTING_SOURCE_OUTBOX_INVALID");
  }
  return result;
}

function integer(value, { min, max }) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw outboxError("AUTO_LISTING_SOURCE_OUTBOX_INVALID");
  }
  return value;
}

function mapClaim(row, accountId) {
  if (!row || row.account_id !== accountId || row.event_type !== "COLLECT_EXCEL_SKU"
    || row.state !== "PROCESSING" || row.row_status !== "COLLECTING"
    || typeof row.normalized_sku !== "string" || !row.normalized_sku.trim()) {
    throw outboxError("AUTO_LISTING_SOURCE_OUTBOX_PERSIST_FAILED", 503, true);
  }
  return Object.freeze({
    id: id(row.id),
    accountId,
    importFileId: id(row.import_file_id),
    rowId: id(row.row_id),
    sku: row.normalized_sku.trim(),
    state: "PROCESSING",
    stateVersion: Number(row.state_version),
    attempts: Number(row.attempts),
    leaseToken: id(row.lease_token),
    leaseGeneration: Number(row.lease_generation),
  });
}

async function rollback(client) {
  try { await client.query("ROLLBACK"); } catch { /* best effort */ }
}

export function createPostgresAutoListingSourceOutboxRepository({
  pool,
  maxAttempts = 5,
  randomUUID = () => crypto.randomUUID(),
} = {}) {
  if (typeof pool?.query !== "function" || typeof pool?.connect !== "function"
    || typeof randomUUID !== "function" || !Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 20) {
    throw outboxError("AUTO_LISTING_SOURCE_OUTBOX_INVALID");
  }

  async function transaction(work) {
    let client;
    try { client = await pool.connect(); } catch {
      throw outboxError("AUTO_LISTING_SOURCE_OUTBOX_PERSIST_FAILED", 503, true);
    }
    let committed = false;
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL statement_timeout = '25s'");
      await client.query("SET LOCAL lock_timeout = '5s'");
      await client.query("SET LOCAL idle_in_transaction_session_timeout = '30s'");
      const result = await work(client);
      await client.query("COMMIT");
      committed = true;
      return result;
    } catch (error) {
      if (!committed) await rollback(client);
      if (typeof error?.code === "string" && error.code.startsWith("AUTO_LISTING_SOURCE_OUTBOX_")) throw error;
      throw outboxError("AUTO_LISTING_SOURCE_OUTBOX_PERSIST_FAILED", 503, true);
    } finally {
      try { client.release(); } catch { /* best effort */ }
    }
  }

  return Object.freeze({
    async listRunnableAccountIds(input = {}) {
      const cursor = input.cursor === null || input.cursor === undefined || input.cursor === ""
        ? null : id(input.cursor);
      const limit = integer(input.limit ?? 100, { min: 1, max: 500 });
      let result;
      try {
        result = await pool.query(
          `SELECT DISTINCT account_id
             FROM auto_listing_source_outbox
            WHERE ((state='PENDING' AND available_at<=statement_timestamp())
                OR (state='PROCESSING' AND lease_expires_at<=statement_timestamp()))
              AND ($1::TEXT IS NULL OR account_id>$1)
            ORDER BY account_id LIMIT $2`,
          [cursor, limit],
        );
      } catch {
        throw outboxError("AUTO_LISTING_SOURCE_OUTBOX_PERSIST_FAILED", 503, true);
      }
      return Object.freeze((result.rows || []).map((row) => id(row.account_id)));
    },

    async claimNext(input = {}) {
      const accountId = id(input.accountId);
      const workerId = id(input.workerId);
      const leaseSeconds = integer(input.leaseSeconds ?? 120, { min: 15, max: 300 });
      return transaction(async (client) => {
        const selected = await client.query(
          `SELECT o.*,r.normalized_sku,r.status AS row_status,r.status_version AS row_status_version,
                  f.status AS file_status,f.status_version AS file_status_version
             FROM auto_listing_source_outbox o
             JOIN auto_listing_import_rows r
               ON r.account_id=o.account_id AND r.import_file_id=o.import_file_id AND r.id=o.row_id
             JOIN auto_listing_import_files f
               ON f.account_id=o.account_id AND f.id=o.import_file_id
            WHERE o.account_id=$1 AND o.event_type='COLLECT_EXCEL_SKU'
              AND ((o.state='PENDING' AND o.available_at<=statement_timestamp() AND r.status='PENDING')
                OR (o.state='PROCESSING' AND o.lease_expires_at<=statement_timestamp() AND r.status='COLLECTING'))
              AND f.status IN ('QUEUED','COLLECTING')
            ORDER BY o.available_at,o.created_at,o.id
            FOR UPDATE OF o,r,f SKIP LOCKED LIMIT 1`,
          [accountId],
        );
        const current = selected.rows?.[0];
        if (!current) return null;
        if (current.account_id !== accountId || current.event_type !== "COLLECT_EXCEL_SKU") {
          throw outboxError("AUTO_LISTING_SOURCE_OUTBOX_PERSIST_FAILED", 503, true);
        }
        if (current.file_status === "QUEUED") {
          const file = await client.query(
            `UPDATE auto_listing_import_files
                SET status='COLLECTING',status_version=status_version+1,updated_at=statement_timestamp()
              WHERE account_id=$1 AND id=$2 AND status='QUEUED' AND status_version=$3
              RETURNING id`,
            [accountId, current.import_file_id, Number(current.file_status_version)],
          );
          if (file.rowCount !== 1) throw outboxError("AUTO_LISTING_SOURCE_OUTBOX_PERSIST_FAILED", 503, true);
        }
        const leaseToken = id(`lease-${randomUUID()}`);
        const claimed = await client.query(
          `UPDATE auto_listing_source_outbox
              SET state='PROCESSING',state_version=state_version+1,attempts=attempts+1,
                  lease_owner=$3,lease_token=$4,
                  lease_expires_at=statement_timestamp()+($5 * INTERVAL '1 second'),
                  lease_generation=lease_generation+1,updated_at=statement_timestamp()
            WHERE account_id=$1 AND id=$2 AND state=$6 AND state_version=$7
            RETURNING *`,
          [accountId, current.id, workerId, leaseToken, leaseSeconds, current.state, Number(current.state_version)],
        );
        if (claimed.rowCount !== 1) throw outboxError("AUTO_LISTING_SOURCE_OUTBOX_PERSIST_FAILED", 503, true);
        if (current.row_status === "PENDING") {
          const rowResult = await client.query(
            `UPDATE auto_listing_import_rows
                SET status='COLLECTING',status_version=status_version+1,
                    attempt_count=attempt_count+1,updated_at=statement_timestamp()
              WHERE account_id=$1 AND id=$2 AND import_file_id=$3
                AND status='PENDING' AND status_version=$4
              RETURNING id`,
            [accountId, current.row_id, current.import_file_id, Number(current.row_status_version)],
          );
          if (rowResult.rowCount !== 1) throw outboxError("AUTO_LISTING_SOURCE_OUTBOX_PERSIST_FAILED", 503, true);
        }
        return mapClaim({ ...current, ...claimed.rows[0], row_status: "COLLECTING" }, accountId);
      });
    },

    async completeCollection(input = {}) {
      const accountId = id(input.accountId);
      const outboxId = id(input.outboxId);
      const rowId = id(input.rowId);
      const leaseToken = id(input.leaseToken);
      const collectItemId = recordId(input.collectItemId);
      return transaction(async (client) => {
        const locked = await client.query(
          `SELECT o.*,r.status AS row_status,r.collect_item_id,f.status AS file_status
             FROM auto_listing_source_outbox o
             JOIN auto_listing_import_rows r ON r.account_id=o.account_id AND r.id=o.row_id
             JOIN auto_listing_import_files f ON f.account_id=o.account_id AND f.id=o.import_file_id
            WHERE o.account_id=$1 AND o.id=$2 AND o.row_id=$3
            FOR UPDATE OF o,r,f`,
          [accountId, outboxId, rowId],
        );
        const current = locked.rows?.[0];
        if (current?.state === "COMPLETED" && current.row_status === "READY"
          && current.collect_item_id === collectItemId) return { completed: true, duplicate: true };
        if (!current || current.account_id !== accountId || current.state !== "PROCESSING"
          || current.row_status !== "COLLECTING" || current.file_status !== "COLLECTING"
          || current.lease_token !== leaseToken) {
          throw outboxError("AUTO_LISTING_SOURCE_OUTBOX_LEASE_CONFLICT", 409, true);
        }
        const ready = await client.query(
          `UPDATE auto_listing_import_rows SET status='READY',status_version=status_version+1,
                  collect_item_id=$3,last_error_code=NULL,last_error_safe=NULL,
                  updated_at=statement_timestamp(),completed_at=statement_timestamp()
            WHERE account_id=$1 AND id=$2 AND status='COLLECTING' RETURNING id`,
          [accountId, rowId, collectItemId],
        );
        if (ready.rowCount !== 1) throw outboxError("AUTO_LISTING_SOURCE_OUTBOX_PERSIST_FAILED", 503, true);
        const counted = await client.query(
          `UPDATE auto_listing_import_files SET ready_rows=ready_rows+1,updated_at=statement_timestamp()
            WHERE account_id=$1 AND id=$2 AND status='COLLECTING' RETURNING id`,
          [accountId, current.import_file_id],
        );
        if (counted.rowCount !== 1) throw outboxError("AUTO_LISTING_SOURCE_OUTBOX_PERSIST_FAILED", 503, true);
        const completed = await client.query(
          `UPDATE auto_listing_source_outbox SET state='COMPLETED',state_version=state_version+1,
                  lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,lease_cas_token=$4,
                  last_error_code=NULL,last_error_safe=NULL,updated_at=statement_timestamp(),
                  completed_at=statement_timestamp()
            WHERE account_id=$1 AND id=$2 AND row_id=$3 AND state='PROCESSING'
            RETURNING id`,
          [accountId, outboxId, rowId, leaseToken],
        );
        if (completed.rowCount !== 1) throw outboxError("AUTO_LISTING_SOURCE_OUTBOX_PERSIST_FAILED", 503, true);
        return { completed: true, duplicate: false };
      });
    },

    async failCollection(input = {}) {
      const accountId = id(input.accountId);
      const outboxId = id(input.outboxId);
      const rowId = id(input.rowId);
      const leaseToken = id(input.leaseToken);
      if (!FAILURE_CODES.has(input.errorCode) || typeof input.retryable !== "boolean") {
        throw outboxError("AUTO_LISTING_SOURCE_OUTBOX_INVALID");
      }
      const errorCode = input.errorCode;
      return transaction(async (client) => {
        const locked = await client.query(
          `SELECT o.*,r.status AS row_status,f.status AS file_status
             FROM auto_listing_source_outbox o
             JOIN auto_listing_import_rows r ON r.account_id=o.account_id AND r.id=o.row_id
             JOIN auto_listing_import_files f ON f.account_id=o.account_id AND f.id=o.import_file_id
            WHERE o.account_id=$1 AND o.id=$2 AND o.row_id=$3
            FOR UPDATE OF o,r,f`,
          [accountId, outboxId, rowId],
        );
        const current = locked.rows?.[0];
        if (current?.state === "DEAD" && current.row_status === "FAILED") {
          return { state: "DEAD", attempts: Number(current.attempts) };
        }
        if (!current || current.account_id !== accountId || current.state !== "PROCESSING"
          || current.row_status !== "COLLECTING" || current.file_status !== "COLLECTING"
          || current.lease_token !== leaseToken) {
          throw outboxError("AUTO_LISTING_SOURCE_OUTBOX_LEASE_CONFLICT", 409, true);
        }
        const attempts = Number(current.attempts);
        const shouldRetry = input.retryable && attempts < maxAttempts;
        if (shouldRetry) {
          const rowRetry = await client.query(
            `UPDATE auto_listing_import_rows SET status='PENDING',status_version=status_version+1,
                    source_lease_cas_token=$4,last_error_code=$5,last_error_safe=NULL,
                    updated_at=statement_timestamp()
              WHERE account_id=$1 AND id=$2 AND import_file_id=$3 AND status='COLLECTING'
              RETURNING id`,
            [accountId, rowId, current.import_file_id, leaseToken, errorCode],
          );
          if (rowRetry.rowCount !== 1) throw outboxError("AUTO_LISTING_SOURCE_OUTBOX_PERSIST_FAILED", 503, true);
          const backoffSeconds = Math.min(3_600, 30 * (2 ** Math.max(0, attempts - 1)));
          const released = await client.query(
            `UPDATE auto_listing_source_outbox SET state='PENDING',state_version=state_version+1,
                    available_at=statement_timestamp() + ($6 * INTERVAL '1 second'),
                    lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,lease_cas_token=$4,
                    last_error_code=$5,last_error_safe=NULL,updated_at=statement_timestamp()
              WHERE account_id=$1 AND id=$2 AND row_id=$3 AND state='PROCESSING'
              RETURNING id`,
            [accountId, outboxId, rowId, leaseToken, errorCode, backoffSeconds],
          );
          if (released.rowCount !== 1) throw outboxError("AUTO_LISTING_SOURCE_OUTBOX_PERSIST_FAILED", 503, true);
          return { state: "PENDING", attempts };
        }
        const failed = await client.query(
          `UPDATE auto_listing_import_rows SET status='FAILED',status_version=status_version+1,
                  last_error_code=$3,last_error_safe=NULL,updated_at=statement_timestamp(),
                  completed_at=statement_timestamp()
            WHERE account_id=$1 AND id=$2 AND status='COLLECTING' RETURNING id`,
          [accountId, rowId, errorCode],
        );
        if (failed.rowCount !== 1) throw outboxError("AUTO_LISTING_SOURCE_OUTBOX_PERSIST_FAILED", 503, true);
        const counted = await client.query(
          `UPDATE auto_listing_import_files SET failed_rows=failed_rows+1,updated_at=statement_timestamp()
            WHERE account_id=$1 AND id=$2 AND status='COLLECTING' RETURNING id`,
          [accountId, current.import_file_id],
        );
        if (counted.rowCount !== 1) throw outboxError("AUTO_LISTING_SOURCE_OUTBOX_PERSIST_FAILED", 503, true);
        const dead = await client.query(
          `UPDATE auto_listing_source_outbox SET state='DEAD',state_version=state_version+1,
                  lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,lease_cas_token=$4,
                  last_error_code=$5,last_error_safe=NULL,updated_at=statement_timestamp(),
                  completed_at=statement_timestamp()
            WHERE account_id=$1 AND id=$2 AND row_id=$3 AND state='PROCESSING'
            RETURNING id`,
          [accountId, outboxId, rowId, leaseToken, errorCode],
        );
        if (dead.rowCount !== 1) throw outboxError("AUTO_LISTING_SOURCE_OUTBOX_PERSIST_FAILED", 503, true);
        return { state: "DEAD", attempts };
      });
    },
  });
}
