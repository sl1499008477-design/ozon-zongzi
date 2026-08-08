import crypto from "node:crypto";

const XLSX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const DEFAULT_MAX_BYTES = 2_097_152;
const DEFAULT_MAX_ROWS = 1_000;
const MAX_CONFIGURED_ROWS = 100_000;
const SAFE_ID = /^[A-Za-z0-9._:-]{1,240}$/;
const SENSITIVE_CONFIG_KEY = /(?:api.?key|authorization|bearer|credential|password|secret|token|cookie)/iu;

function serviceError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function hashBytes(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function hashIdentity(...parts) {
  return crypto.createHash("sha256").update(parts.join("\0"), "utf8").digest("hex");
}

function canonical(value, path = "config", seen = new WeakSet()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (!value || typeof value !== "object" || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
    || seen.has(value)) throw serviceError("AUTO_LISTING_IMPORT_REQUEST_INVALID");
  seen.add(value);
  const output = {};
  for (const key of Object.keys(value).sort()) {
    if (!key || SENSITIVE_CONFIG_KEY.test(key)) throw serviceError("AUTO_LISTING_IMPORT_REQUEST_INVALID");
    output[key] = canonical(value[key], `${path}.${key}`, seen);
  }
  seen.delete(value);
  return output;
}

function validateRequest(input, maxBytes) {
  const accountId = typeof input?.actor?.id === "string" ? input.actor.id.trim() : "";
  const name = typeof input?.name === "string" ? input.name.trim() : "";
  const contentType = typeof input?.contentType === "string" ? input.contentType.trim() : "";
  const idempotencyKey = typeof input?.idempotencyKey === "string" ? input.idempotencyKey.trim() : "";
  const correlationId = typeof input?.correlationId === "string" ? input.correlationId.trim() : "";
  if (!SAFE_ID.test(accountId) || !Buffer.isBuffer(input?.buffer)
    || input.buffer.length < 1 || input.buffer.length > maxBytes
    || !name.toLowerCase().endsWith(".xlsx") || name.length > 512 || /[/\\\u0000-\u001f\u007f]/u.test(name)
    || contentType !== XLSX_CONTENT_TYPE
    || !SAFE_ID.test(idempotencyKey) || !SAFE_ID.test(correlationId)
    || !input.config || typeof input.config !== "object" || Array.isArray(input.config)) {
    throw serviceError("AUTO_LISTING_IMPORT_REQUEST_INVALID");
  }
  const configSnapshot = canonical(input.config);
  const configText = JSON.stringify(configSnapshot);
  if (Buffer.byteLength(configText, "utf8") > 32_768) {
    throw serviceError("AUTO_LISTING_IMPORT_REQUEST_INVALID");
  }
  return { accountId, name, contentType, idempotencyKey, correlationId, configSnapshot, configText };
}

function buildRow({ accountId, importId, row, status, now, normalizedSku = null, extra = {} }) {
  const rowNumber = Number(row.rowNumber);
  return Object.freeze({
    id: `row_${hashIdentity(accountId, importId, String(rowNumber)).slice(0, 40)}`,
    accountId,
    importFileId: importId,
    rowNumber,
    rawSku: String(row.rawSku || ""),
    normalizedSku,
    status,
    statusVersion: 0,
    attemptCount: 0,
    collectItemId: null,
    autoListingItemId: null,
    lastErrorCode: extra.lastErrorCode || null,
    lastErrorSafe: null,
    createdAt: now,
    updatedAt: now,
    completedAt: status === "PENDING" ? null : now,
    ...(extra.firstRowNumber ? { firstRowNumber: extra.firstRowNumber } : {}),
  });
}

function buildPersistence({ request, parsed, fileHash, configHash, importId, objectKey, now }) {
  const rows = [
    ...parsed.acceptedRows.map((row) => buildRow({
      accountId: request.accountId, importId, row, status: "PENDING", now, normalizedSku: row.sku,
    })),
    ...parsed.rejectedRows.map((row) => buildRow({
      accountId: request.accountId, importId, row, status: "INVALID_SKU", now,
      extra: { lastErrorCode: row.code || "INVALID_SKU" },
    })),
    ...parsed.duplicateRows.map((row) => buildRow({
      accountId: request.accountId, importId, row, status: "DUPLICATE_IN_FILE", now,
      normalizedSku: row.sku,
      extra: { lastErrorCode: "DUPLICATE_IN_FILE", firstRowNumber: row.firstRowNumber },
    })),
  ].sort((left, right) => left.rowNumber - right.rowNumber);

  const outbox = rows.filter((row) => row.status === "PENDING").map((row) => {
    const dedupeKey = hashIdentity(request.accountId, importId, row.id, "COLLECT_EXCEL_SKU");
    return Object.freeze({
      id: `source_${dedupeKey.slice(0, 40)}`,
      accountId: request.accountId,
      importFileId: importId,
      rowId: row.id,
      eventType: "COLLECT_EXCEL_SKU",
      dedupeKey,
      state: "PENDING",
      stateVersion: 0,
      attempts: 0,
      availableAt: now,
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAt: null,
      leaseGeneration: 0,
      lastErrorCode: null,
      lastErrorSafe: null,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    });
  });

  return Object.freeze({
    importFile: Object.freeze({
      id: importId,
      accountId: request.accountId,
      sourceFileName: request.name,
      sourceContentType: request.contentType,
      sourceSizeBytes: request.buffer.length,
      fileHash,
      objectKey,
      worksheetName: parsed.sheetName,
      totalRows: parsed.totals.rows,
      acceptedRows: parsed.totals.accepted,
      rejectedRows: parsed.totals.rejected,
      duplicateRows: parsed.totals.duplicates,
      readyRows: 0,
      failedRows: 0,
      status: "QUEUED",
      statusVersion: 1,
      configSnapshot: request.configSnapshot,
      configHash,
      idempotencyKey: request.idempotencyKey,
      createdBy: request.accountId,
      correlationId: request.correlationId,
      generatedJobId: null,
      lastErrorCode: null,
      lastErrorSafe: null,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    }),
    rows: Object.freeze(rows),
    outbox: Object.freeze(outbox),
  });
}

function sameReplay(existing, fileHash, configHash) {
  return existing && existing.fileHash === fileHash && existing.configHash === configHash;
}

function sameCommittedImport(existing, persistence) {
  const expected = persistence?.importFile;
  return sameReplay(existing, expected?.fileHash, expected?.configHash)
    && existing.id === expected?.id
    && existing.accountId === expected?.accountId
    && existing.idempotencyKey === expected?.idempotencyKey
    && existing.objectKey === expected?.objectKey;
}

export function createAutoListingImportService({
  parseWorkbook,
  repository,
  workbookStore,
  now = () => new Date().toISOString(),
  maxBytes = DEFAULT_MAX_BYTES,
  maxRows = DEFAULT_MAX_ROWS,
} = {}) {
  if (typeof parseWorkbook !== "function" || typeof repository?.findImportByIdempotency !== "function"
    || typeof repository?.createImportWithRows !== "function" || typeof repository?.enqueueObjectCleanup !== "function"
    || typeof workbookStore?.putWorkbook !== "function" || typeof workbookStore?.readWorkbook !== "function"
    || typeof now !== "function"
    || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isSafeInteger(maxRows) || maxRows < 1
    || maxRows > MAX_CONFIGURED_ROWS) {
    throw new TypeError("Auto-listing import dependencies are required");
  }

  async function recordCleanup({ accountId, importId, objectKey }) {
    try {
      await repository.enqueueObjectCleanup({
        accountId,
        importId,
        objectKey,
        reasonCode: "AUTO_LISTING_IMPORT_ORPHANED_WORKBOOK",
      });
    } catch {
      throw serviceError("AUTO_LISTING_IMPORT_CLEANUP_PERSIST_FAILED");
    }
  }

  // Every import identity has a deterministic object key, so another concurrent
  // request may already have committed a row that references these same bytes.
  // Only the cleanup repository can atomically prove that deletion is safe.
  const removeOrRecordCleanup = recordCleanup;

  return Object.freeze({
    async createExcelImport(input = {}) {
      const base = validateRequest(input, maxBytes);
      const request = { ...base, buffer: input.buffer };
      const fileHash = hashBytes(input.buffer);
      const configHash = hashBytes(Buffer.from(base.configText, "utf8"));
      let existing;
      try {
        existing = await repository.findImportByIdempotency({
          accountId: base.accountId,
          idempotencyKey: base.idempotencyKey,
        });
      } catch {
        throw serviceError("AUTO_LISTING_IMPORT_PERSIST_FAILED");
      }
      if (existing) {
        if (!sameReplay(existing, fileHash, configHash)) {
          throw serviceError("AUTO_LISTING_IMPORT_IDEMPOTENCY_CONFLICT");
        }
        return existing;
      }

      const identity = hashIdentity(base.accountId, base.idempotencyKey);
      const importId = `import_${identity.slice(0, 40)}`;
      const objectKey = `auto-listing/imports/v1/${base.accountId}/${importId}/workbook.xlsx`;
      let stored = false;
      try {
        const put = await workbookStore.putWorkbook({
          accountId: base.accountId,
          importId,
          objectKey,
          bytes: input.buffer,
          fileHash,
          contentType: base.contentType,
        });
        stored = true;
        if (!put || put.objectKey !== objectKey || put.sizeBytes !== input.buffer.length || put.fileHash !== fileHash) {
          throw serviceError("AUTO_LISTING_IMPORT_STORAGE_VERIFY_FAILED");
        }
        const readback = await workbookStore.readWorkbook({ accountId: base.accountId, importId, objectKey });
        if (!Buffer.isBuffer(readback) || readback.length !== input.buffer.length || hashBytes(readback) !== fileHash) {
          throw serviceError("AUTO_LISTING_IMPORT_STORAGE_VERIFY_FAILED");
        }
      } catch (caught) {
        if (stored) await removeOrRecordCleanup({ accountId: base.accountId, importId, objectKey });
        if (caught?.code === "AUTO_LISTING_IMPORT_CLEANUP_PERSIST_FAILED") throw caught;
        throw serviceError(caught?.code === "AUTO_LISTING_IMPORT_STORAGE_VERIFY_FAILED"
          ? caught.code : "AUTO_LISTING_IMPORT_STORAGE_FAILED");
      }

      let parsed;
      try {
        parsed = await parseWorkbook({
          buffer: input.buffer,
          name: base.name,
          contentType: base.contentType,
          maxRows,
          maxBytes,
        });
      } catch (caught) {
        await removeOrRecordCleanup({ accountId: base.accountId, importId, objectKey });
        if (caught?.code === "AUTO_LISTING_IMPORT_CLEANUP_PERSIST_FAILED") throw caught;
        if (/^AUTO_LISTING_EXCEL_[A-Z0-9_]+$/.test(String(caught?.code || ""))) throw caught;
        throw serviceError("AUTO_LISTING_EXCEL_WORKBOOK_INVALID");
      }

      const timestamp = now();
      const persistence = buildPersistence({
        request, parsed, fileHash, configHash, importId, objectKey, now: timestamp,
      });
      try {
        return await repository.createImportWithRows(persistence);
      } catch {
        let committed = null;
        try {
          committed = await repository.findImportByIdempotency({
            accountId: base.accountId,
            idempotencyKey: base.idempotencyKey,
          });
        } catch { /* ambiguous outcome: cleanup worker performs the reference check */ }
        if (sameCommittedImport(committed, persistence)) return committed;
        await recordCleanup({ accountId: base.accountId, importId, objectKey });
        throw serviceError("AUTO_LISTING_IMPORT_PERSIST_FAILED");
      }
    },
  });
}
