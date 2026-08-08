import crypto from "node:crypto";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const FILE_KEYS = new Set([
  "id", "accountId", "sourceFileName", "sourceContentType", "sourceSizeBytes", "fileHash", "objectKey",
  "worksheetName", "totalRows", "acceptedRows", "rejectedRows", "duplicateRows", "readyRows", "failedRows",
  "status", "statusVersion", "configSnapshot", "configHash", "idempotencyKey", "createdBy", "correlationId",
  "generatedJobId", "lastErrorCode", "lastErrorSafe", "createdAt", "updatedAt", "completedAt",
]);
const ROW_KEYS = new Set([
  "id", "accountId", "importFileId", "rowNumber", "rawSku", "normalizedSku", "status", "statusVersion",
  "attemptCount", "collectItemId", "autoListingItemId", "lastErrorCode", "lastErrorSafe", "createdAt", "updatedAt",
  "completedAt",
]);
const OUTBOX_KEYS = new Set([
  "id", "accountId", "importFileId", "rowId", "eventType", "dedupeKey", "state", "stateVersion", "attempts",
  "availableAt", "leaseOwner", "leaseToken", "leaseExpiresAt", "leaseGeneration", "lastErrorCode", "lastErrorSafe",
  "createdAt", "updatedAt", "completedAt",
]);
const ROW_STATUSES = new Set(["PENDING", "INVALID_SKU", "DUPLICATE_IN_FILE"]);
const DEFAULT_MAX_ROWS = 1_000;
const MAX_CONFIGURED_ROWS = 100_000;
const INSERT_BATCH_SIZE = 1_000;

function repositoryError(code, status = 422, retryable = false) {
  const error = new Error(code === "AUTO_LISTING_IMPORT_PERSIST_FAILED"
    ? "自动上架 Excel 导入数据暂时无法保存" : code);
  error.code = code;
  error.status = status;
  error.retryable = retryable;
  return error;
}

function plain(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function exact(value, keys) {
  if (!plain(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.size && actual.every((key) => keys.has(key));
}

function id(value) {
  const result = typeof value === "string" ? value.trim() : "";
  if (!SAFE_ID.test(result)) throw repositoryError("AUTO_LISTING_IMPORT_REPOSITORY_INVALID");
  return result;
}

function timestamp(value) {
  const result = typeof value === "string" ? value : "";
  if (!result || Number.isNaN(Date.parse(result))) throw repositoryError("AUTO_LISTING_IMPORT_REPOSITORY_INVALID");
  return result;
}

function integer(value, { min = 0, max = 1_000_000 } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw repositoryError("AUTO_LISTING_IMPORT_REPOSITORY_INVALID");
  }
  return value;
}

function configHash(value) {
  let encoded;
  try { encoded = JSON.stringify(value); } catch { throw repositoryError("AUTO_LISTING_IMPORT_REPOSITORY_INVALID"); }
  return crypto.createHash("sha256").update(encoded, "utf8").digest("hex");
}

function normalizeGraph(input, maxRows) {
  if (!exact(input, new Set(["importFile", "rows", "outbox"]))
    || !exact(input.importFile, FILE_KEYS) || !Array.isArray(input.rows) || !Array.isArray(input.outbox)
    || input.rows.length > maxRows || input.outbox.length > maxRows) {
    throw repositoryError("AUTO_LISTING_IMPORT_REPOSITORY_INVALID");
  }
  const file = input.importFile;
  const accountId = id(file.accountId);
  const importId = id(file.id);
  if (file.createdBy !== accountId || file.status !== "QUEUED" || file.statusVersion !== 1
    || file.sourceContentType !== CONTENT_TYPE || !HASH.test(file.fileHash) || !HASH.test(file.configHash)
    || !plain(file.configSnapshot) || configHash(file.configSnapshot) !== file.configHash
    || file.objectKey !== `auto-listing/imports/v1/${accountId}/${importId}/workbook.xlsx`
    || typeof file.sourceFileName !== "string" || !file.sourceFileName.toLowerCase().endsWith(".xlsx")
    || Buffer.byteLength(file.sourceFileName, "utf8") > 512
    || !Number.isSafeInteger(file.sourceSizeBytes) || file.sourceSizeBytes < 1
    || file.generatedJobId !== null || file.lastErrorCode !== null || file.lastErrorSafe !== null
    || file.completedAt !== null || timestamp(file.createdAt) !== timestamp(file.updatedAt)) {
    throw repositoryError("AUTO_LISTING_IMPORT_REPOSITORY_INVALID");
  }
  const countFields = ["totalRows", "acceptedRows", "rejectedRows", "duplicateRows", "readyRows", "failedRows"];
  for (const field of countFields) integer(file[field]);
  id(file.idempotencyKey);
  id(file.correlationId);
  const rowIds = new Set();
  const rowNumbers = new Set();
  const normalizedSkus = new Set();
  const rows = input.rows.map((row) => {
    if (!exact(row, ROW_KEYS) || id(row.accountId) !== accountId || id(row.importFileId) !== importId
      || !ROW_STATUSES.has(row.status) || row.statusVersion !== 0 || row.attemptCount !== 0
      || row.collectItemId !== null || row.autoListingItemId !== null || row.lastErrorSafe !== null
      || timestamp(row.createdAt) !== timestamp(row.updatedAt)) {
      throw repositoryError("AUTO_LISTING_IMPORT_REPOSITORY_INVALID");
    }
    const rowId = id(row.id);
    integer(row.rowNumber, { min: 1 });
    if (rowIds.has(rowId) || rowNumbers.has(row.rowNumber) || typeof row.rawSku !== "string"
      || Buffer.byteLength(row.rawSku, "utf8") > 131_072) {
      throw repositoryError("AUTO_LISTING_IMPORT_REPOSITORY_INVALID");
    }
    rowIds.add(rowId);
    rowNumbers.add(row.rowNumber);
    if (row.status === "INVALID_SKU") {
      if (row.normalizedSku !== null || !["INVALID_SKU", "FORMULA_RESULT_MISSING", "SKU_COLUMN_MUST_BE_TEXT"].includes(row.lastErrorCode)
        || row.completedAt === null) throw repositoryError("AUTO_LISTING_IMPORT_REPOSITORY_INVALID");
    } else {
      const sku = typeof row.normalizedSku === "string" ? row.normalizedSku.trim() : "";
      if (!sku || Buffer.byteLength(sku, "utf8") > 160 || row.normalizedSku !== sku) {
        throw repositoryError("AUTO_LISTING_IMPORT_REPOSITORY_INVALID");
      }
      if (row.status === "PENDING") {
        if (row.lastErrorCode !== null || row.completedAt !== null || normalizedSkus.has(sku)) {
          throw repositoryError("AUTO_LISTING_IMPORT_REPOSITORY_INVALID");
        }
        normalizedSkus.add(sku);
      } else if (row.lastErrorCode !== "DUPLICATE_IN_FILE" || row.completedAt === null) {
        throw repositoryError("AUTO_LISTING_IMPORT_REPOSITORY_INVALID");
      }
    }
    return row;
  });
  const pendingRows = new Set(rows.filter((row) => row.status === "PENDING").map((row) => row.id));
  const outboxIds = new Set();
  const outboxRows = new Set();
  const outbox = input.outbox.map((row) => {
    if (!exact(row, OUTBOX_KEYS) || id(row.accountId) !== accountId || id(row.importFileId) !== importId
      || row.eventType !== "COLLECT_EXCEL_SKU" || row.state !== "PENDING" || row.stateVersion !== 0
      || row.attempts !== 0 || row.leaseGeneration !== 0 || row.leaseOwner !== null || row.leaseToken !== null
      || row.leaseExpiresAt !== null || row.lastErrorCode !== null || row.lastErrorSafe !== null
      || row.completedAt !== null || timestamp(row.createdAt) !== timestamp(row.updatedAt)
      || !pendingRows.has(row.rowId) || outboxRows.has(row.rowId)) {
      throw repositoryError("AUTO_LISTING_IMPORT_REPOSITORY_INVALID");
    }
    const outboxId = id(row.id);
    id(row.dedupeKey);
    timestamp(row.availableAt);
    if (outboxIds.has(outboxId)) throw repositoryError("AUTO_LISTING_IMPORT_REPOSITORY_INVALID");
    outboxIds.add(outboxId);
    outboxRows.add(row.rowId);
    return row;
  });
  if (outboxRows.size !== pendingRows.size || file.totalRows !== rows.length
    || file.acceptedRows !== pendingRows.size
    || file.rejectedRows !== rows.filter((row) => row.status === "INVALID_SKU").length
    || file.duplicateRows !== rows.filter((row) => row.status === "DUPLICATE_IN_FILE").length
    || file.readyRows !== 0 || file.failedRows !== 0) {
    throw repositoryError("AUTO_LISTING_IMPORT_REPOSITORY_INVALID");
  }
  return { accountId, importId, file, rows, outbox };
}

function fromFile(row, duplicate = false) {
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
    createdAt: row.created_at, updatedAt: row.updated_at, completedAt: row.completed_at,
    ...(duplicate ? { duplicate: true } : {}),
  });
}

function sameReplay(row, file) {
  return row?.accountId === file.accountId && row?.id === file.id
    && row?.fileHash === file.fileHash && row?.configHash === file.configHash
    && row?.objectKey === file.objectKey;
}

async function rollback(client) {
  try { await client.query("ROLLBACK"); } catch { /* best effort */ }
}

export function createPostgresAutoListingImportRepository({
  pool, cleanupRepository, maxRows = DEFAULT_MAX_ROWS,
} = {}) {
  if (typeof pool?.query !== "function" || typeof pool?.connect !== "function"
    || typeof cleanupRepository?.enqueueObjectCleanup !== "function"
    || !Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > MAX_CONFIGURED_ROWS) {
    throw repositoryError("AUTO_LISTING_IMPORT_REPOSITORY_INVALID");
  }
  const directQuery = async (sql, params) => {
    try { return await pool.query(sql, params); } catch {
      throw repositoryError("AUTO_LISTING_IMPORT_PERSIST_FAILED", 503, true);
    }
  };
  return Object.freeze({
    async findImportByIdempotency(input = {}) {
      const accountId = id(input.accountId);
      const idempotencyKey = id(input.idempotencyKey);
      const result = await directQuery(
        "SELECT * FROM auto_listing_import_files WHERE account_id=$1 AND idempotency_key=$2",
        [accountId, idempotencyKey],
      );
      const row = fromFile(result.rows?.[0]);
      if (row && row.accountId !== accountId) throw repositoryError("AUTO_LISTING_IMPORT_PERSIST_FAILED", 503, true);
      return row;
    },

    async createImportWithRows(input = {}) {
      const graph = normalizeGraph(input, maxRows);
      let client;
      try { client = await pool.connect(); } catch {
        throw repositoryError("AUTO_LISTING_IMPORT_PERSIST_FAILED", 503, true);
      }
      let committed = false;
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL statement_timeout = '25s'");
        await client.query("SET LOCAL lock_timeout = '5s'");
        await client.query("SET LOCAL idle_in_transaction_session_timeout = '30s'");
        const account = await client.query("SELECT id FROM accounts WHERE id=$1 FOR UPDATE", [graph.accountId]);
        if (!account.rows?.[0]) throw repositoryError("AUTO_LISTING_IMPORT_ACCOUNT_NOT_FOUND", 404);
        const existingResult = await client.query(
          "SELECT * FROM auto_listing_import_files WHERE account_id=$1 AND idempotency_key=$2 FOR UPDATE",
          [graph.accountId, graph.file.idempotencyKey],
        );
        const existing = fromFile(existingResult.rows?.[0]);
        if (existing) {
          if (!sameReplay(existing, graph.file)) throw repositoryError("AUTO_LISTING_IMPORT_IDEMPOTENCY_CONFLICT", 409);
          await client.query("COMMIT");
          committed = true;
          return Object.freeze({ ...existing, duplicate: true });
        }
        const file = graph.file;
        const cleanupReservation = await client.query(
          `SELECT id FROM auto_listing_import_object_cleanup
            WHERE account_id=$1 AND object_key=$2 AND status='PROCESSING'
            FOR UPDATE`,
          [graph.accountId, file.objectKey],
        );
        if (cleanupReservation.rows?.[0]) {
          throw repositoryError("AUTO_LISTING_IMPORT_OBJECT_CLEANUP_IN_PROGRESS", 409, true);
        }
        await client.query(
          `INSERT INTO auto_listing_import_files (
             id,account_id,source_file_name,source_content_type,source_size_bytes,file_hash,object_key,
             worksheet_name,total_rows,accepted_rows,rejected_rows,duplicate_rows,ready_rows,failed_rows,
             status,status_version,config_snapshot,config_hash,idempotency_key,created_by,correlation_id,
             generated_job_id,last_error_code,last_error_safe,created_at,updated_at,completed_at
           ) VALUES (
             $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,0,0,'RECEIVED',0,$13::JSONB,$14,$15,$16,$17,
             NULL,NULL,NULL,$18,$18,NULL
           )`,
          [file.id, graph.accountId, file.sourceFileName, file.sourceContentType, file.sourceSizeBytes,
            file.fileHash, file.objectKey, file.worksheetName, file.totalRows, file.acceptedRows,
            file.rejectedRows, file.duplicateRows, JSON.stringify(file.configSnapshot), file.configHash,
            file.idempotencyKey, file.createdBy, file.correlationId, file.createdAt],
        );
        for (let offset = 0; offset < graph.rows.length; offset += INSERT_BATCH_SIZE) {
          const batch = graph.rows.slice(offset, offset + INSERT_BATCH_SIZE);
          const rows = batch.map((row) => ({
            id: row.id, account_id: row.accountId, import_file_id: row.importFileId, row_number: row.rowNumber,
            raw_sku: row.rawSku, normalized_sku: row.normalizedSku, status: row.status,
            last_error_code: row.lastErrorCode, created_at: row.createdAt, completed_at: row.completedAt,
          }));
          await client.query(
            `INSERT INTO auto_listing_import_rows (
               id,account_id,import_file_id,row_number,raw_sku,normalized_sku,status,status_version,attempt_count,
               collect_item_id,auto_listing_item_id,last_error_code,last_error_safe,created_at,updated_at,completed_at
             ) SELECT id,account_id,import_file_id,row_number,raw_sku,normalized_sku,status,0,0,
                      NULL,NULL,last_error_code,NULL,created_at,created_at,completed_at
                 FROM jsonb_to_recordset($1::JSONB) AS r(
                   id TEXT,account_id TEXT,import_file_id TEXT,row_number INTEGER,raw_sku TEXT,
                   normalized_sku TEXT,status TEXT,last_error_code TEXT,created_at TIMESTAMPTZ,completed_at TIMESTAMPTZ
                 )`,
            [JSON.stringify(rows)],
          );
        }
        for (let offset = 0; offset < graph.outbox.length; offset += INSERT_BATCH_SIZE) {
          const batch = graph.outbox.slice(offset, offset + INSERT_BATCH_SIZE);
          const outbox = batch.map((row) => ({
            id: row.id, account_id: row.accountId, import_file_id: row.importFileId, row_id: row.rowId,
            event_type: row.eventType, dedupe_key: row.dedupeKey, available_at: row.availableAt, created_at: row.createdAt,
          }));
          await client.query(
            `INSERT INTO auto_listing_source_outbox (
               id,account_id,import_file_id,row_id,event_type,dedupe_key,state,state_version,attempts,
               available_at,lease_owner,lease_token,lease_expires_at,lease_generation,last_error_code,
               last_error_safe,created_at,updated_at,completed_at
             ) SELECT id,account_id,import_file_id,row_id,event_type,dedupe_key,'PENDING',0,0,
                      available_at,NULL,NULL,NULL,0,NULL,NULL,created_at,created_at,NULL
                 FROM jsonb_to_recordset($1::JSONB) AS r(
                   id TEXT,account_id TEXT,import_file_id TEXT,row_id TEXT,event_type TEXT,dedupe_key TEXT,
                   available_at TIMESTAMPTZ,created_at TIMESTAMPTZ
                 )`,
            [JSON.stringify(outbox)],
          );
        }
        const updated = await client.query(
          `UPDATE auto_listing_import_files
              SET status='QUEUED',status_version=1,updated_at=$3
            WHERE account_id=$1 AND id=$2 AND status='RECEIVED' AND status_version=0
            RETURNING *`,
          [graph.accountId, graph.importId, file.updatedAt],
        );
        const result = fromFile(updated.rows?.[0]);
        if (!result || !sameReplay(result, file) || result.status !== "QUEUED" || result.statusVersion !== 1) {
          throw repositoryError("AUTO_LISTING_IMPORT_PERSIST_FAILED", 503, true);
        }
        await client.query("COMMIT");
        committed = true;
        return result;
      } catch (error) {
        if (!committed) await rollback(client);
        if (typeof error?.code === "string" && error.code.startsWith("AUTO_LISTING_IMPORT_")) throw error;
        throw repositoryError("AUTO_LISTING_IMPORT_PERSIST_FAILED", 503, true);
      } finally {
        try { client.release(); } catch { /* best effort */ }
      }
    },

    enqueueObjectCleanup(input) {
      return cleanupRepository.enqueueObjectCleanup(input);
    },

    async listImports(input = {}) {
      const accountId = id(input.accountId);
      const limit = integer(input.limit ?? 50, { min: 1, max: 100 });
      const result = await directQuery(
        "SELECT * FROM auto_listing_import_files WHERE account_id=$1 ORDER BY created_at DESC,id DESC LIMIT $2",
        [accountId, limit],
      );
      return (result.rows || []).map((row) => {
        const mapped = fromFile(row);
        if (mapped.accountId !== accountId) throw repositoryError("AUTO_LISTING_IMPORT_PERSIST_FAILED", 503, true);
        return mapped;
      });
    },
  });
}
