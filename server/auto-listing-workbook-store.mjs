import { getObjectBuffer, putObjectFromBuffer, removeObject } from "./object-storage.mjs";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const DEFAULT_MAX_BYTES = 2_097_152;
const MAX_CONFIGURED_BYTES = 64 * 1024 * 1024;

function storageError(code) {
  const error = new Error(code === "AUTO_LISTING_IMPORT_STORAGE_FAILED"
    ? "自动上架 Excel 文件存储暂时不可用" : code);
  error.code = code;
  error.status = code === "AUTO_LISTING_IMPORT_STORAGE_FAILED" ? 503 : 422;
  error.retryable = code === "AUTO_LISTING_IMPORT_STORAGE_FAILED";
  return error;
}

function id(value) {
  const result = typeof value === "string" ? value.trim() : "";
  if (!SAFE_ID.test(result)) throw storageError("AUTO_LISTING_IMPORT_STORAGE_INVALID");
  return result;
}

function scoped(input) {
  const accountId = id(input?.accountId);
  const importId = id(input?.importId);
  const objectKey = typeof input?.objectKey === "string" ? input.objectKey.trim() : "";
  if (objectKey !== `auto-listing/imports/v1/${accountId}/${importId}/workbook.xlsx`) {
    throw storageError("AUTO_LISTING_IMPORT_STORAGE_INVALID");
  }
  return { accountId, importId, objectKey };
}

export function createAutoListingWorkbookStore({
  putObject = putObjectFromBuffer,
  getObject = getObjectBuffer,
  removeObject: removeStoredObject = removeObject,
  maxBytes = DEFAULT_MAX_BYTES,
} = {}) {
  if (typeof putObject !== "function" || typeof getObject !== "function" || typeof removeStoredObject !== "function"
    || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_CONFIGURED_BYTES) {
    throw storageError("AUTO_LISTING_IMPORT_STORAGE_INVALID");
  }
  return Object.freeze({
    async putWorkbook(input = {}) {
      const scope = scoped(input);
      if (!Buffer.isBuffer(input.bytes) || input.bytes.length < 1 || input.bytes.length > maxBytes
        || input.contentType !== CONTENT_TYPE || !HASH.test(input.fileHash || "")) {
        throw storageError("AUTO_LISTING_IMPORT_STORAGE_INVALID");
      }
      try {
        const result = await putObject({
          key: scope.objectKey,
          name: "workbook.xlsx",
          contentType: CONTENT_TYPE,
          buffer: input.bytes,
          maxBytes,
        });
        if (result?.key !== scope.objectKey || result?.size !== input.bytes.length || result?.sha256 !== input.fileHash) {
          throw storageError("AUTO_LISTING_IMPORT_STORAGE_FAILED");
        }
        return Object.freeze({ objectKey: result.key, sizeBytes: result.size, fileHash: result.sha256 });
      } catch (error) {
        if (error?.code === "AUTO_LISTING_IMPORT_STORAGE_INVALID") throw error;
        throw storageError("AUTO_LISTING_IMPORT_STORAGE_FAILED");
      }
    },

    async readWorkbook(input = {}) {
      const scope = scoped(input);
      try {
        const value = await getObject(scope.objectKey, { maxBytes });
        if (!Buffer.isBuffer(value) || value.length < 1 || value.length > maxBytes) {
          throw storageError("AUTO_LISTING_IMPORT_STORAGE_FAILED");
        }
        return value;
      } catch (error) {
        if (error?.code === "AUTO_LISTING_IMPORT_STORAGE_INVALID") throw error;
        throw storageError("AUTO_LISTING_IMPORT_STORAGE_FAILED");
      }
    },

    async removeWorkbook(input = {}) {
      const scope = scoped(input);
      try { await removeStoredObject(scope.objectKey); } catch {
        throw storageError("AUTO_LISTING_IMPORT_STORAGE_FAILED");
      }
    },
  });
}
