import crypto from "node:crypto";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/u;
const RECOVERABLE_CODES = new Set(["OZON_SKU_COLLECTION_FAILED", "OZON_SKU_SCRAPE_EMPTY"]);
const RETRYABLE_IMPORT_STATUSES = new Set(["PARTIAL", "BLOCKED", "FAILED"]);

function recoveryError(code, status = 422, retryable = false) {
  const error = new Error(code);
  error.code = code;
  error.status = status;
  error.retryable = retryable;
  return error;
}

function id(value) {
  const result = typeof value === "string" ? value.trim() : "";
  if (!SAFE_ID.test(result)) throw recoveryError("AUTO_LISTING_IMPORT_RECOVERY_INVALID");
  return result;
}

function integer(value) {
  if (!Number.isInteger(value) || value < 0 || value > 2_147_483_646) {
    throw recoveryError("AUTO_LISTING_IMPORT_RECOVERY_INVALID");
  }
  return value;
}

function hash(...parts) {
  return crypto.createHash("sha256").update(parts.join("\0"), "utf8").digest("hex");
}

function mapFile(row, duplicate = false) {
  if (!row) return null;
  return Object.freeze({
    id: row.id, accountId: row.account_id, sourceFileName: row.source_file_name,
    sourceContentType: row.source_content_type, sourceSizeBytes: Number(row.source_size_bytes),
    fileHash: row.file_hash, objectKey: row.object_key, worksheetName: row.worksheet_name,
    totalRows: Number(row.total_rows), acceptedRows: Number(row.accepted_rows), rejectedRows: Number(row.rejected_rows),
    duplicateRows: Number(row.duplicate_rows), readyRows: Number(row.ready_rows), failedRows: Number(row.failed_rows),
    status: row.status, statusVersion: Number(row.status_version), configSnapshot: row.config_snapshot,
    configHash: row.config_hash, idempotencyKey: row.idempotency_key, createdBy: row.created_by,
    correlationId: row.correlation_id, generatedJobId: row.generated_job_id,
    lastErrorCode: row.last_error_code, lastErrorSafe: row.last_error_safe,
    retryOfImportId: row.retry_of_import_id || null,
    createdAt: row.created_at, updatedAt: row.updated_at, completedAt: row.completed_at,
    ...(duplicate ? { duplicate: true } : {}),
  });
}

function mapRow(row) {
  return Object.freeze({
    id: row.id, accountId: row.account_id, importFileId: row.import_file_id,
    rowNumber: Number(row.row_number), rawSku: row.raw_sku, normalizedSku: row.normalized_sku,
    status: row.status, statusVersion: Number(row.status_version), attemptCount: Number(row.attempt_count),
    collectItemId: row.collect_item_id, autoListingItemId: row.auto_listing_item_id,
    lastErrorCode: row.last_error_code, lastErrorSafe: row.last_error_safe,
    createdAt: row.created_at, updatedAt: row.updated_at, completedAt: row.completed_at,
  });
}

function mapCommand(row) {
  if (!row) return null;
  return {
    accountId: row.account_id, importFileId: row.import_file_id, retryImportFileId: row.retry_import_file_id,
    expectedStatusVersion: Number(row.expected_status_version), idempotencyKey: row.idempotency_key,
    correlationId: row.correlation_id, actorId: row.actor_id,
  };
}

async function rollback(client) {
  try { await client.query("ROLLBACK"); } catch { /* best effort */ }
}

export function createPostgresAutoListingImportRecoveryRepository({
  pool,
  randomUUID = () => crypto.randomUUID(),
} = {}) {
  if (typeof pool?.connect !== "function" || typeof randomUUID !== "function") {
    throw recoveryError("AUTO_LISTING_IMPORT_RECOVERY_INVALID");
  }

  async function transaction(begin, work) {
    let client;
    try { client = await pool.connect(); } catch {
      throw recoveryError("AUTO_LISTING_IMPORT_RECOVERY_PERSIST_FAILED", 503, true);
    }
    let committed = false;
    try {
      await client.query(begin);
      await client.query("SET LOCAL statement_timeout = '25s'");
      await client.query("SET LOCAL lock_timeout = '5s'");
      await client.query("SET LOCAL idle_in_transaction_session_timeout = '30s'");
      const result = await work(client);
      await client.query("COMMIT");
      committed = true;
      return result;
    } catch (error) {
      if (!committed) await rollback(client);
      if (typeof error?.code === "string" && error.code.startsWith("AUTO_LISTING_IMPORT_")) throw error;
      throw recoveryError("AUTO_LISTING_IMPORT_RECOVERY_PERSIST_FAILED", 503, true);
    } finally {
      try { client.release(); } catch { /* best effort */ }
    }
  }

  return Object.freeze({
    async getImportDetail(input = {}) {
      const accountId = id(input.accountId);
      const importId = id(input.importId);
      return transaction("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY", async (client) => {
        const fileResult = await client.query(
          "SELECT * FROM auto_listing_import_files WHERE account_id=$1 AND id=$2",
          [accountId, importId],
        );
        const importFile = mapFile(fileResult.rows?.[0]);
        if (!importFile) return null;
        if (importFile.accountId !== accountId) throw recoveryError("AUTO_LISTING_IMPORT_RECOVERY_PERSIST_FAILED", 503, true);
        const rowResult = await client.query(
          `SELECT id,account_id,import_file_id,row_number,raw_sku,normalized_sku,status,status_version,
                  attempt_count,collect_item_id,auto_listing_item_id,last_error_code,last_error_safe,
                  created_at,updated_at,completed_at
             FROM auto_listing_import_rows
            WHERE account_id=$1 AND import_file_id=$2
              AND status IN ('FAILED','INVALID_SKU','DUPLICATE_IN_FILE')
            ORDER BY row_number,id LIMIT 1001`,
          [accountId, importId],
        );
        const aggregateResult = await client.query(
          `SELECT COUNT(*) FILTER (
                    WHERE status='FAILED'
                      AND last_error_code IN ('OZON_SKU_COLLECTION_FAILED','OZON_SKU_SCRAPE_EMPTY')
                  ) AS recoverable_failed_rows,
                  EXISTS (
                    SELECT 1 FROM auto_listing_import_retry_commands
                     WHERE account_id=$1 AND import_file_id=$2
                  ) AS has_retry_successor
             FROM auto_listing_import_rows
            WHERE account_id=$1 AND import_file_id=$2`,
          [accountId, importId],
        );
        const mappedRows = (rowResult.rows || []).map(mapRow);
        const rowsTruncated = mappedRows.length > 1000;
        const rows = mappedRows.slice(0, 1000);
        if (rows.some((row) => row.accountId !== accountId || row.importFileId !== importId)) {
          throw recoveryError("AUTO_LISTING_IMPORT_RECOVERY_PERSIST_FAILED", 503, true);
        }
        const aggregate = aggregateResult.rows?.[0] || {};
        const recoverableFailedRows = Number(aggregate.recoverable_failed_rows);
        if (!Number.isSafeInteger(recoverableFailedRows) || recoverableFailedRows < 0) {
          throw recoveryError("AUTO_LISTING_IMPORT_RECOVERY_PERSIST_FAILED", 503, true);
        }
        return Object.freeze({
          importFile,
          recoverableFailedRows,
          hasRetrySuccessor: aggregate.has_retry_successor === true,
          rowsTruncated,
          rows: Object.freeze(rows),
        });
      });
    },

    async retryFailedRows(input = {}) {
      const accountId = id(input.accountId);
      const actorId = id(input.actorId);
      const importId = id(input.importId);
      const expectedStatusVersion = integer(input.expectedStatusVersion);
      const idempotencyKey = id(input.idempotencyKey);
      const correlationId = id(input.correlationId);
      if (actorId !== accountId) throw recoveryError("AUTO_LISTING_IMPORT_RECOVERY_INVALID");
      return transaction("BEGIN", async (client) => {
        const account = await client.query("SELECT id FROM accounts WHERE id=$1 FOR UPDATE", [accountId]);
        if (!account.rows?.[0]) throw recoveryError("AUTO_LISTING_IMPORT_NOT_FOUND", 404);
        const replayResult = await client.query(
          `SELECT account_id,import_file_id,retry_import_file_id,expected_status_version,
                  idempotency_key,correlation_id,actor_id
             FROM auto_listing_import_retry_commands
            WHERE account_id=$1 AND idempotency_key=$2`,
          [accountId, idempotencyKey],
        );
        const replay = mapCommand(replayResult.rows?.[0]);
        if (replay) {
          if (replay.accountId !== accountId || replay.importFileId !== importId
            || replay.expectedStatusVersion !== expectedStatusVersion || replay.correlationId !== correlationId
            || replay.actorId !== actorId) {
            throw recoveryError("AUTO_LISTING_IMPORT_RECOVERY_IDEMPOTENCY_CONFLICT", 409);
          }
          const childResult = await client.query(
            "SELECT * FROM auto_listing_import_files WHERE account_id=$1 AND id=$2",
            [accountId, replay.retryImportFileId],
          );
          const child = mapFile(childResult.rows?.[0], true);
          if (!child || child.accountId !== accountId || child.retryOfImportId !== importId) {
            throw recoveryError("AUTO_LISTING_IMPORT_RECOVERY_PERSIST_FAILED", 503, true);
          }
          return child;
        }

        const successorResult = await client.query(
          `SELECT retry_import_file_id,idempotency_key
             FROM auto_listing_import_retry_commands
            WHERE account_id=$1 AND import_file_id=$2`,
          [accountId, importId],
        );
        if (successorResult.rows?.[0]) {
          throw recoveryError("AUTO_LISTING_IMPORT_ALREADY_RETRIED", 409);
        }

        const sourceResult = await client.query(
          "SELECT * FROM auto_listing_import_files WHERE account_id=$1 AND id=$2 FOR UPDATE",
          [accountId, importId],
        );
        const source = mapFile(sourceResult.rows?.[0]);
        if (!source) throw recoveryError("AUTO_LISTING_IMPORT_NOT_FOUND", 404);
        if (source.accountId !== accountId || source.statusVersion !== expectedStatusVersion) {
          throw recoveryError("AUTO_LISTING_IMPORT_RECOVERY_CONFLICT", 409, true);
        }
        if (!RETRYABLE_IMPORT_STATUSES.has(source.status)) {
          throw recoveryError("AUTO_LISTING_IMPORT_NOT_RETRYABLE", 409);
        }
        const failedResult = await client.query(
          `SELECT * FROM auto_listing_import_rows
            WHERE account_id=$1 AND import_file_id=$2 AND status='FAILED'
            ORDER BY row_number,id FOR UPDATE`,
          [accountId, importId],
        );
        const failedRows = (failedResult.rows || []).map(mapRow)
          .filter((row) => row.accountId === accountId && row.importFileId === importId
            && RECOVERABLE_CODES.has(row.lastErrorCode));
        if (!failedRows.length) throw recoveryError("AUTO_LISTING_IMPORT_NOT_RETRYABLE", 409);

        const retryImportId = id(`retry-${randomUUID()}`);
        const commandId = id(`retrycmd-${hash(accountId, importId, idempotencyKey).slice(0, 40)}`);
        const createdAt = new Date().toISOString();
        await client.query(
          `INSERT INTO auto_listing_import_files (
             id,account_id,source_file_name,source_content_type,source_size_bytes,file_hash,object_key,
             worksheet_name,total_rows,accepted_rows,rejected_rows,duplicate_rows,ready_rows,failed_rows,
             status,status_version,config_snapshot,config_hash,idempotency_key,created_by,correlation_id,
             generated_job_id,last_error_code,last_error_safe,retry_of_import_id,created_at,updated_at,completed_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,0,0,0,0,'RECEIVED',0,$10::JSONB,$11,$12,$13,$14,
                     NULL,NULL,NULL,$15,$16,$16,NULL)`,
          [retryImportId, accountId, source.sourceFileName, source.sourceContentType, source.sourceSizeBytes,
            source.fileHash, source.objectKey, source.worksheetName, failedRows.length,
            JSON.stringify(source.configSnapshot), source.configHash, idempotencyKey, actorId,
            correlationId, importId, createdAt],
        );
        const childRows = failedRows.map((row) => ({
          id: `retryrow-${hash(accountId, retryImportId, row.id).slice(0, 40)}`,
          account_id: accountId, import_file_id: retryImportId, row_number: row.rowNumber,
          raw_sku: row.rawSku, normalized_sku: row.normalizedSku,
          retry_source_row_id: row.id, created_at: createdAt,
        }));
        await client.query(
          `INSERT INTO auto_listing_import_rows (
             id,account_id,import_file_id,row_number,raw_sku,normalized_sku,status,status_version,attempt_count,
             collect_item_id,auto_listing_item_id,last_error_code,last_error_safe,retry_source_row_id,
             created_at,updated_at,completed_at
           ) SELECT id,account_id,import_file_id,row_number,raw_sku,normalized_sku,'PENDING',0,0,
                    NULL,NULL,NULL,NULL,retry_source_row_id,created_at,created_at,NULL
               FROM jsonb_to_recordset($1::JSONB) AS r(
                 id TEXT,account_id TEXT,import_file_id TEXT,row_number INTEGER,raw_sku TEXT,
                 normalized_sku TEXT,retry_source_row_id TEXT,created_at TIMESTAMPTZ
               )`,
          [JSON.stringify(childRows)],
        );
        const outboxRows = childRows.map((row) => ({
          id: `retrysource-${hash(accountId, retryImportId, row.id).slice(0, 40)}`,
          account_id: accountId, import_file_id: retryImportId, row_id: row.id,
          dedupe_key: hash(accountId, retryImportId, row.id, "COLLECT_EXCEL_SKU"), created_at: createdAt,
        }));
        await client.query(
          `INSERT INTO auto_listing_source_outbox (
             id,account_id,import_file_id,row_id,event_type,dedupe_key,state,state_version,attempts,
             available_at,lease_owner,lease_token,lease_expires_at,lease_generation,last_error_code,
             last_error_safe,created_at,updated_at,completed_at
           ) SELECT id,account_id,import_file_id,row_id,'COLLECT_EXCEL_SKU',dedupe_key,'PENDING',0,0,
                    created_at,NULL,NULL,NULL,0,NULL,NULL,created_at,created_at,NULL
               FROM jsonb_to_recordset($1::JSONB) AS r(
                 id TEXT,account_id TEXT,import_file_id TEXT,row_id TEXT,dedupe_key TEXT,created_at TIMESTAMPTZ
               )`,
          [JSON.stringify(outboxRows)],
        );
        const queuedResult = await client.query(
          `UPDATE auto_listing_import_files
              SET status='QUEUED',status_version=1,updated_at=$3
            WHERE account_id=$1 AND id=$2 AND status='RECEIVED' AND status_version=0
            RETURNING *`,
          [accountId, retryImportId, createdAt],
        );
        const child = mapFile(queuedResult.rows?.[0]);
        if (!child || child.accountId !== accountId || child.retryOfImportId !== importId
          || child.status !== "QUEUED" || child.statusVersion !== 1) {
          throw recoveryError("AUTO_LISTING_IMPORT_RECOVERY_PERSIST_FAILED", 503, true);
        }
        await client.query(
          `INSERT INTO auto_listing_import_retry_commands (
             id,account_id,import_file_id,retry_import_file_id,expected_status_version,
             idempotency_key,correlation_id,actor_id,retried_row_count,created_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [commandId, accountId, importId, retryImportId, expectedStatusVersion,
            idempotencyKey, correlationId, actorId, failedRows.length, createdAt],
        );
        return Object.freeze({ ...child, duplicate: false });
      });
    },
  });
}
