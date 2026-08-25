import { normalizeAndHashAutoListingConfig, normalizeAutoListingConfig } from "./auto-listing-contract.mjs";
import { assertPermission, PERMISSIONS } from "./permissions.mjs";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/u;
const CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function workflowError(code) {
  const error = new Error(code);
  error.code = code;
  error.status = 422;
  return error;
}

function id(value) {
  const result = typeof value === "string" ? value.trim() : "";
  if (!SAFE_ID.test(result)) throw workflowError("AUTO_LISTING_USER_REQUEST_INVALID");
  return result;
}

function account(actor) {
  assertPermission(actor, PERMISSIONS.TENANT_OPERATE);
  return id(actor.id);
}

function safeImport(row, accountId) {
  if (!row || typeof row !== "object" || Array.isArray(row) || row.accountId !== accountId) {
    throw workflowError("AUTO_LISTING_USER_DATA_BOUNDARY");
  }
  return Object.freeze({
    id: id(row.id),
    sourceFileName: typeof row.sourceFileName === "string" ? row.sourceFileName.slice(0, 512) : "",
    status: typeof row.status === "string" ? row.status.slice(0, 40) : "FAILED",
    totalRows: Number(row.totalRows) || 0,
    readyRows: Number(row.readyRows) || 0,
    failedRows: Number(row.failedRows) || 0,
    rejectedRows: Number(row.rejectedRows) || 0,
    duplicateRows: Number(row.duplicateRows) || 0,
    createdAt: typeof row.createdAt === "string" ? row.createdAt : row.createdAt?.toISOString?.() || null,
  });
}

function safePreference(row, accountId) {
  if (row === null || row === undefined) return null;
  if (!row || typeof row !== "object" || Array.isArray(row)
    || (row.accountId !== undefined && row.accountId !== accountId)) {
    throw workflowError("AUTO_LISTING_USER_DATA_BOUNDARY");
  }
  const config = normalizeAutoListingConfig({
    targetStoreId: row.targetStoreId,
    targetWarehouseId: row.targetWarehouseId,
    stock: row.stock,
    priceAdjustmentKopecks: row.priceAdjustmentKopecks,
    priceMultiplierMicros: row.priceMultiplierMicros,
    image: row.image,
  });
  const configVersion = Number(row.configVersion);
  if (!Number.isInteger(configVersion) || configVersion < 1) {
    throw workflowError("AUTO_LISTING_USER_DATA_BOUNDARY");
  }
  return Object.freeze({ ...config, configVersion });
}

export function createAutoListingUserWorkflowService({
  preferencesRepository,
  importRepository,
  importService,
  recoveryService,
  limits,
} = {}) {
  if (typeof preferencesRepository?.getPreferences !== "function"
    || typeof preferencesRepository?.savePreferences !== "function"
    || typeof importRepository?.listImports !== "function"
    || typeof importService?.createExcelImport !== "function"
    || typeof recoveryService?.getImportDetail !== "function"
    || typeof recoveryService?.retryImport !== "function"
    || !Number.isSafeInteger(limits?.maxBytes) || limits.maxBytes < 1
    || !Number.isSafeInteger(limits?.maxRows) || limits.maxRows < 1) {
    throw new TypeError("Auto-listing user workflow dependencies are required");
  }
  return Object.freeze({
    async getOverview(input = {}) {
      const accountId = account(input.actor);
      const importLimit = input.importLimit ?? 50;
      if (!Number.isInteger(importLimit) || importLimit < 1 || importLimit > 100) {
        throw workflowError("AUTO_LISTING_USER_REQUEST_INVALID");
      }
      const [preference, imports] = await Promise.all([
        preferencesRepository.getPreferences({ accountId }),
        importRepository.listImports({ accountId, limit: importLimit }),
      ]);
      return Object.freeze({
        preference: safePreference(preference, accountId),
        limits: Object.freeze({ maxBytes: limits.maxBytes, maxRows: limits.maxRows }),
        imports: Object.freeze((Array.isArray(imports) ? imports : []).map((row) => safeImport(row, accountId))),
      });
    },

    async savePreferences(input = {}) {
      const accountId = account(input.actor);
      const expectedVersion = Number(input.expectedVersion);
      if (!Number.isInteger(expectedVersion) || expectedVersion < 0 || expectedVersion > 2_147_483_646) {
        throw workflowError("AUTO_LISTING_USER_REQUEST_INVALID");
      }
      const idempotencyKey = id(input.idempotencyKey);
      const correlationId = id(input.correlationId);
      let frozen;
      try { frozen = normalizeAndHashAutoListingConfig(input.config); } catch {
        throw workflowError("AUTO_LISTING_USER_REQUEST_INVALID");
      }
      const saved = await preferencesRepository.savePreferences({
        accountId, actorId: accountId, expectedVersion, idempotencyKey, correlationId,
        config: frozen.config, configHash: frozen.configHash,
      });
      return safePreference(saved, accountId);
    },

    async createExcelImport(input = {}) {
      const accountId = account(input.actor);
      if (!Buffer.isBuffer(input.buffer) || input.buffer.length < 1 || input.buffer.length > limits.maxBytes
        || input.contentType !== CONTENT_TYPE || typeof input.name !== "string"
        || !input.name.toLowerCase().endsWith(".xlsx")) {
        throw workflowError("AUTO_LISTING_USER_REQUEST_INVALID");
      }
      id(input.idempotencyKey);
      id(input.correlationId);
      let config;
      try { config = normalizeAutoListingConfig(input.config); } catch {
        throw workflowError("AUTO_LISTING_USER_REQUEST_INVALID");
      }
      const created = await importService.createExcelImport({
        actor: input.actor,
        name: input.name,
        contentType: input.contentType,
        buffer: input.buffer,
        config,
        idempotencyKey: input.idempotencyKey,
        correlationId: input.correlationId,
      });
      return safeImport(created, accountId);
    },

    getImportDetail(input = {}) {
      return recoveryService.getImportDetail(input);
    },

    retryImport(input = {}) {
      return recoveryService.retryImport(input);
    },
  });
}
