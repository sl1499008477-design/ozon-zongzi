import { assertPermission, PERMISSIONS } from "./permissions.mjs";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/u;
const RECOVERABLE_CODES = new Set(["OZON_SKU_COLLECTION_FAILED", "OZON_SKU_SCRAPE_EMPTY"]);
const ROW_STATUSES = new Set(["FAILED", "INVALID_SKU", "DUPLICATE_IN_FILE"]);
const RETRYABLE_IMPORT_STATUSES = new Set(["PARTIAL", "BLOCKED", "FAILED"]);

function recoveryError(code, status = 422) {
  const error = new Error(code);
  error.code = code;
  error.status = status;
  return error;
}

function id(value) {
  const result = typeof value === "string" ? value.trim() : "";
  if (!SAFE_ID.test(result)) throw recoveryError("AUTO_LISTING_IMPORT_RECOVERY_INVALID");
  return result;
}

function account(actor) {
  assertPermission(actor, PERMISSIONS.TENANT_OPERATE);
  return id(actor.id);
}

function integer(value, { min = 0, max = 2_147_483_646 } = {}) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw recoveryError("AUTO_LISTING_IMPORT_RECOVERY_INVALID");
  }
  return value;
}

function timestamp(value) {
  if (typeof value === "string" && value.length <= 80 && !Number.isNaN(Date.parse(value))) return value;
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
  return null;
}

function safeFile(file, accountId) {
  if (!file || typeof file !== "object" || Array.isArray(file) || file.accountId !== accountId) {
    throw recoveryError("AUTO_LISTING_IMPORT_RECOVERY_BOUNDARY", 503);
  }
  return {
    id: id(file.id), sourceFileName: typeof file.sourceFileName === "string" ? file.sourceFileName.slice(0, 512) : "",
    status: typeof file.status === "string" ? file.status.slice(0, 40) : "FAILED",
    statusVersion: integer(Number(file.statusVersion)), totalRows: integer(Number(file.totalRows)),
    readyRows: integer(Number(file.readyRows)), failedRows: integer(Number(file.failedRows)),
    rejectedRows: integer(Number(file.rejectedRows)), duplicateRows: integer(Number(file.duplicateRows)),
    retryOfImportId: file.retryOfImportId ? id(file.retryOfImportId) : null,
    createdAt: timestamp(file.createdAt), updatedAt: timestamp(file.updatedAt),
  };
}

function safeRow(row, accountId, importId) {
  if (!row || typeof row !== "object" || Array.isArray(row) || row.accountId !== accountId
    || row.importFileId !== importId || !ROW_STATUSES.has(row.status)) {
    throw recoveryError("AUTO_LISTING_IMPORT_RECOVERY_BOUNDARY", 503);
  }
  const errorCode = typeof row.lastErrorCode === "string" && /^[A-Z][A-Z0-9_]{0,119}$/u.test(row.lastErrorCode)
    ? row.lastErrorCode : null;
  const sku = typeof row.normalizedSku === "string" ? row.normalizedSku.trim().slice(0, 160) : "";
  const recoverable = row.status === "FAILED" && RECOVERABLE_CODES.has(errorCode);
  return Object.freeze({
    rowNumber: integer(Number(row.rowNumber), { min: 1 }), sku, status: row.status,
    attemptCount: integer(Number(row.attemptCount)), errorCode, recoverable,
  });
}

function safeSummary(file, accountId) {
  return Object.freeze(safeFile(file, accountId));
}

export function createAutoListingImportRecoveryService({ repository } = {}) {
  if (typeof repository?.getImportDetail !== "function" || typeof repository?.retryFailedRows !== "function") {
    throw new TypeError("Auto-listing import recovery dependencies are required");
  }
  return Object.freeze({
    async getImportDetail(input = {}) {
      const accountId = account(input.actor);
      const importId = id(input.importId);
      const detail = await repository.getImportDetail({ accountId, importId });
      if (!detail) throw recoveryError("AUTO_LISTING_IMPORT_NOT_FOUND", 404);
      const file = safeFile(detail.importFile, accountId);
      const rows = Object.freeze((Array.isArray(detail.rows) ? detail.rows : []).map((row) => safeRow(row, accountId, importId)));
      const recoverableFailedRows = integer(Number(detail.recoverableFailedRows));
      const hasRetrySuccessor = detail.hasRetrySuccessor === true;
      return Object.freeze({
        ...file,
        recoverableFailedRows,
        rowsTruncated: detail.rowsTruncated === true,
        actions: Object.freeze({
          retry: recoverableFailedRows > 0 && RETRYABLE_IMPORT_STATUSES.has(file.status) && !hasRetrySuccessor,
        }),
        rows,
      });
    },

    async retryImport(input = {}) {
      const accountId = account(input.actor);
      const command = {
        accountId, actorId: accountId, importId: id(input.importId),
        expectedStatusVersion: integer(input.expectedStatusVersion),
        idempotencyKey: id(input.idempotencyKey), correlationId: id(input.correlationId),
      };
      const retried = await repository.retryFailedRows(command);
      return safeSummary(retried, accountId);
    },
  });
}
