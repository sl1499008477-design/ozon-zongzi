import crypto from "node:crypto";
import { types as utilTypes } from "node:util";

const INPUT_KEYS = Object.freeze([
  "accountId", "actorAccountId", "targetStoreId", "targetWarehouseId", "correlationId",
]);
const RESPONSE_LIMIT_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_DEPTH = 32;
const MAX_RESPONSE_NODES = 100_000;
const DISABLED_STATUSES = new Set(["DISABLED", "INACTIVE", "ARCHIVED", "DELETED", "BLOCKED"]);
const ACTIVE_STATUSES = new Set(["ACTIVE", "ENABLED", "WORKING", "CREATED"]);
const trustedErrors = new WeakSet();

const ERROR_MESSAGES = Object.freeze({
  RFBS_WAREHOUSE_NOT_FOUND: "未找到目标 RFBS 仓库",
  RFBS_WAREHOUSE_DISABLED: "目标 RFBS 仓库不可用",
  RFBS_WAREHOUSE_SCOPE_MISMATCH: "RFBS 仓库不属于当前账号或店铺",
  RFBS_WAREHOUSE_CHANGED: "RFBS 仓库信息已变化",
  RFBS_WAREHOUSE_EVIDENCE_EXPIRED: "RFBS 仓库验证证据已过期",
  RFBS_VALIDATION_REQUIRED: "RFBS 仓库需要重新验证",
  AUTO_LISTING_RFBS_VALIDATION_FAILED: "RFBS 仓库验证失败",
});

function verifierError(code, retryable = false) {
  const error = new Error(ERROR_MESSAGES[code] || ERROR_MESSAGES.AUTO_LISTING_RFBS_VALIDATION_FAILED);
  error.code = code;
  error.retryable = retryable === true;
  trustedErrors.add(error);
  return error;
}

function throwVerifierError(code, retryable = false) {
  throw verifierError(code, retryable);
}

function plainDataRecord(value) {
  if (!value || typeof value !== "object") return null;
  try {
    if (utilTypes.isProxy(value)) return null;
    if (Array.isArray(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string")) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const result = Object.create(null);
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) return null;
      result[key] = descriptor.value;
    }
    return result;
  } catch {
    return null;
  }
}

function closedInput(value) {
  const record = plainDataRecord(value);
  if (!record) return null;
  const keys = Object.keys(record);
  if (![INPUT_KEYS.length, INPUT_KEYS.length + 1].includes(keys.length)
    || keys.some((key) => !INPUT_KEYS.includes(key) && key !== "signal")
    || (keys.length === INPUT_KEYS.length + 1 && !Object.hasOwn(record, "signal"))) return null;
  const result = {};
  for (const key of INPUT_KEYS) {
    const candidate = record[key];
    if (typeof candidate !== "string" || candidate !== candidate.trim()
      || candidate.length < 1 || candidate.length > 240 || /[\u0000-\u001f\u007f]/u.test(candidate)) return null;
    result[key] = candidate;
  }
  if (Object.hasOwn(record, "signal")) {
    if (!(record.signal instanceof AbortSignal)) return null;
    result.signal = record.signal;
  }
  if (result.actorAccountId !== result.accountId) return null;
  return Object.freeze(result);
}

function aliasText(record, keys, max = 240) {
  const values = [];
  for (const key of keys) {
    if (record[key] === undefined || record[key] === null || record[key] === "") continue;
    if (typeof record[key] !== "string") return { valid: false, value: "" };
    const value = record[key].trim();
    if (!value || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) return { valid: false, value: "" };
    values.push(value);
  }
  const unique = [...new Set(values)];
  return unique.length <= 1
    ? { valid: true, value: unique[0] || "" }
    : { valid: false, value: "" };
}

function aliasBoolean(record, keys) {
  const values = [];
  for (const key of keys) {
    if (record[key] === undefined || record[key] === null) continue;
    if (typeof record[key] !== "boolean") return { valid: false, present: true, value: false };
    values.push(record[key]);
  }
  const unique = [...new Set(values)];
  return unique.length <= 1
    ? { valid: true, present: unique.length === 1, value: unique[0] === true }
    : { valid: false, present: true, value: false };
}

function aliasPlatformWarehouseId(record, keys) {
  const values = [];
  for (const key of keys) {
    const candidate = record[key];
    if (candidate === undefined || candidate === null || candidate === "") continue;
    if (typeof candidate === "string") {
      const value = candidate.trim();
      if (!value || value.length > 240 || /[\u0000-\u001f\u007f]/u.test(value)) {
        return { valid: false, value: "" };
      }
      values.push(value);
      continue;
    }
    if (typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate > 0) {
      values.push(String(candidate));
      continue;
    }
    return { valid: false, value: "" };
  }
  const unique = [...new Set(values)];
  return unique.length <= 1
    ? { valid: true, value: unique[0] || "" }
    : { valid: false, value: "" };
}

function validPlatformWarehouseId(value) {
  return typeof value === "string" && value.length > 0 && !/^wh_/iu.test(value);
}

function normalizedType(record) {
  const explicit = aliasText(record, [
    "warehouse_type", "warehouseType", "fulfillment_type", "fulfillmentType", "type",
  ], 40);
  const rfbs = aliasBoolean(record, ["is_rfbs", "isRfbs"]);
  if (!explicit.valid || !rfbs.valid) return null;
  const type = explicit.value.toUpperCase();
  if (rfbs.present && type && (type === "RFBS") !== rfbs.value) return null;
  if (type) return type;
  if (rfbs.present) return rfbs.value ? "RFBS" : "FBS";
  return "";
}

function normalizedStatus(record) {
  const status = aliasText(record, ["status", "state", "warehouse_status", "warehouseStatus"], 40);
  const active = aliasBoolean(record, ["is_active", "isActive", "active"]);
  const archived = aliasBoolean(record, ["is_archived", "isArchived", "archived"]);
  const disabled = aliasBoolean(record, ["is_disabled", "isDisabled", "disabled"]);
  if (!status.valid || !active.valid || !archived.valid || !disabled.valid) return null;
  const value = status.value.toUpperCase();
  if (DISABLED_STATUSES.has(value) || (active.present && !active.value)
    || (archived.present && archived.value) || (disabled.present && disabled.value)) return "DISABLED";
  if (ACTIVE_STATUSES.has(value) || (!value && active.present && active.value)) return "ACTIVE";
  return "CHANGED";
}

function validateLocalTarget(value, input) {
  if (value === null || value === undefined) throwVerifierError("RFBS_WAREHOUSE_NOT_FOUND");
  const target = plainDataRecord(value);
  if (!target) throwVerifierError("AUTO_LISTING_RFBS_VALIDATION_FAILED");
  const accountId = aliasText(target, ["accountId", "account_id", "ownerAccountId", "owner_account_id"]);
  const storeId = aliasText(target, ["storeId", "store_id"]);
  const recordId = aliasText(target, ["id", "warehouseRecordId", "warehouse_record_id"]);
  const platformId = aliasText(target, ["warehouse_id", "warehouseId", "platformWarehouseId"]);
  if (!accountId.valid || !storeId.valid || !recordId.valid
    || accountId.value !== input.accountId || storeId.value !== input.targetStoreId
    || recordId.value !== input.targetWarehouseId) throwVerifierError("RFBS_WAREHOUSE_SCOPE_MISMATCH");
  if (!platformId.valid || !validPlatformWarehouseId(platformId.value)) {
    throwVerifierError("RFBS_WAREHOUSE_CHANGED");
  }
  const status = normalizedStatus(target);
  if (status === "DISABLED") throwVerifierError("RFBS_WAREHOUSE_DISABLED");
  if (normalizedType(target) !== "RFBS" || status !== "ACTIVE") throwVerifierError("RFBS_WAREHOUSE_CHANGED");
  return Object.freeze({ platformWarehouseId: platformId.value });
}

function validateCredential(value, input) {
  if (value === null || value === undefined) throwVerifierError("RFBS_VALIDATION_REQUIRED", true);
  const credential = plainDataRecord(value);
  if (!credential) throwVerifierError("RFBS_VALIDATION_REQUIRED", true);
  const storeId = aliasText(credential, ["id", "storeId", "store_id"]);
  const accountId = aliasText(credential, ["accountId", "account_id", "ownerAccountId", "owner_account_id"]);
  const clientId = aliasText(credential, ["clientId", "client_id"]);
  const apiKey = aliasText(credential, ["apiKey", "api_key"], 16_384);
  if (!storeId.valid || storeId.value !== input.targetStoreId
    || !accountId.valid || (accountId.value && accountId.value !== input.accountId)) {
    throwVerifierError("RFBS_WAREHOUSE_SCOPE_MISMATCH");
  }
  if (!clientId.valid || !clientId.value || !apiKey.valid || !apiKey.value) {
    throwVerifierError("RFBS_VALIDATION_REQUIRED", true);
  }
  return Object.freeze({ id: storeId.value, clientId: clientId.value, apiKey: apiKey.value,
    ...(['CN','RU','LEGACY'].includes(credential.ozonRoute)?{ozonRoute:credential.ozonRoute}:{}) });
}

function safeJsonSnapshot(value) {
  let nodes = 0;
  let approximateBytes = 0;
  const active = new Set();

  function addBytes(valueToCount) {
    approximateBytes += Buffer.byteLength(valueToCount, "utf8");
    if (approximateBytes > RESPONSE_LIMIT_BYTES) throw new Error("response limit exceeded");
  }

  function visit(current, depth) {
    nodes += 1;
    if (nodes > MAX_RESPONSE_NODES || depth > MAX_RESPONSE_DEPTH) throw new Error("response shape exceeded");
    if (current === null || typeof current === "boolean") return current;
    if (typeof current === "string") {
      addBytes(current);
      return current;
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current)) throw new Error("non-finite response number");
      return current;
    }
    if (!current || typeof current !== "object") throw new Error("unsupported response value");
    if (utilTypes.isProxy(current)) throw new Error("proxy response value");
    if (active.has(current)) throw new Error("cyclic response");
    active.add(current);
    try {
      const prototype = Object.getPrototypeOf(current);
      const keys = Reflect.ownKeys(current);
      const descriptors = Object.getOwnPropertyDescriptors(current);
      if (Array.isArray(current)) {
        if (prototype !== Array.prototype || keys.some((key) => typeof key !== "string")
          || keys.length !== current.length + 1 || !keys.includes("length")) throw new Error("open response array");
        const output = [];
        for (let index = 0; index < current.length; index += 1) {
          const descriptor = descriptors[String(index)];
          if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
            throw new Error("sparse or accessor response array");
          }
          output.push(visit(descriptor.value, depth + 1));
        }
        return output;
      }
      if (prototype !== Object.prototype && prototype !== null) throw new Error("non-plain response object");
      if (keys.some((key) => typeof key !== "string")) throw new Error("symbol response key");
      const output = Object.create(null);
      for (const key of keys) {
        const descriptor = descriptors[key];
        if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
          throw new Error("accessor response object");
        }
        addBytes(key);
        output[key] = visit(descriptor.value, depth + 1);
      }
      return output;
    } finally {
      active.delete(current);
    }
  }

  const snapshot = visit(value, 0);
  const encoded = JSON.stringify(snapshot);
  if (typeof encoded !== "string" || Buffer.byteLength(encoded, "utf8") > RESPONSE_LIMIT_BYTES) {
    throw new Error("response limit exceeded");
  }
  return snapshot;
}

function warehouseRows(response) {
  const snapshot = safeJsonSnapshot(response);
  const root = plainDataRecord(snapshot);
  if (!root) throw new Error("malformed warehouse response");
  const candidates = [];
  if (Array.isArray(root.result)) candidates.push(root.result);
  if (root.result && !Array.isArray(root.result)) {
    const result = plainDataRecord(root.result);
    if (!result) throw new Error("malformed warehouse result");
    if (Array.isArray(result.warehouses)) candidates.push(result.warehouses);
    if (Array.isArray(result.items)) candidates.push(result.items);
  }
  if (Array.isArray(root.warehouses)) candidates.push(root.warehouses);
  if (Array.isArray(root.items)) candidates.push(root.items);
  if (candidates.length !== 1) throw new Error("ambiguous warehouse response");
  return candidates[0].map((row) => {
    const record = plainDataRecord(row);
    if (!record) throw new Error("malformed warehouse row");
    const platformId = aliasPlatformWarehouseId(record, ["warehouse_id", "warehouseId", "id"]);
    if (!platformId.valid || !validPlatformWarehouseId(platformId.value)) {
      throw new Error("malformed warehouse id");
    }
    return { record, platformWarehouseId: platformId.value };
  });
}

function mapOzonFailure(error) {
  try {
    if (!error || (typeof error !== "object" && typeof error !== "function")) {
      return verifierError("AUTO_LISTING_RFBS_VALIDATION_FAILED");
    }
    const descriptors = Object.getOwnPropertyDescriptors(error);
    const statusDescriptor = descriptors.status;
    const codeDescriptor = descriptors.code;
    if ((statusDescriptor && !Object.hasOwn(statusDescriptor, "value"))
      || (codeDescriptor && !Object.hasOwn(codeDescriptor, "value"))) {
      return verifierError("AUTO_LISTING_RFBS_VALIDATION_FAILED");
    }
    const status = Number(statusDescriptor?.value);
    const code = typeof codeDescriptor?.value === "string" ? codeDescriptor.value.toUpperCase() : "";
    if ([401, 403].includes(status) || ["ZONGZI_HTTP_401", "ZONGZI_HTTP_403"].includes(code)) {
      return verifierError("RFBS_WAREHOUSE_SCOPE_MISMATCH");
    }
    if (status >= 500 || status === 408 || status === 429
      || code === "ZONGZI_TIMEOUT" || /^ZONGZI_HTTP_5\d\d$/u.test(code)) {
      return verifierError("RFBS_VALIDATION_REQUIRED", true);
    }
  } catch {
    return verifierError("AUTO_LISTING_RFBS_VALIDATION_FAILED");
  }
  return verifierError("AUTO_LISTING_RFBS_VALIDATION_FAILED");
}

function hashEvidence(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

export function createAutoListingRfbsWarehouseVerifier({
  loadTarget,
  readCredential,
  callOzonSellerApi,
  now = () => new Date(),
  ttlMs = 600_000,
} = {}) {
  if (typeof loadTarget !== "function" || typeof readCredential !== "function"
    || typeof callOzonSellerApi !== "function" || typeof now !== "function"
    || !Number.isFinite(Number(ttlMs))) {
    throw new TypeError("RFBS warehouse verifier dependencies are required");
  }

  async function verifyRfbsWarehouse(untrustedInput = {}) {
    const input = closedInput(untrustedInput);
    if (!input) throwVerifierError("RFBS_WAREHOUSE_SCOPE_MISMATCH");
    try {
      let targetValue;
      try {
        targetValue = await loadTarget({
          accountId: input.accountId,
          targetStoreId: input.targetStoreId,
          targetWarehouseId: input.targetWarehouseId,
        });
      } catch {
        throwVerifierError("AUTO_LISTING_RFBS_VALIDATION_FAILED");
      }
      const target = validateLocalTarget(targetValue, input);

      let credentialValue;
      try {
        credentialValue = await readCredential({
          accountId: input.accountId,
          targetStoreId: input.targetStoreId,
        });
      } catch {
        throwVerifierError("AUTO_LISTING_RFBS_VALIDATION_FAILED");
      }
      const credential = validateCredential(credentialValue, input);

      const readWarehouse = credential => callOzonSellerApi(
          credential,
          "/v2/warehouse/list",
          {},
          REQUEST_TIMEOUT_MS,
          {
            maxResponseBytes: RESPONSE_LIMIT_BYTES,
            ...(input.signal ? { signal: input.signal } : {}),
          },
        );
      let response;
      try {
        response = await readWarehouse(credential);
      } catch (error) {
        const fields=error && typeof error==='object'?Object.getOwnPropertyDescriptors(error):{};
        // Only this read-only lookup may use the alternate host. A transport
        // failure merely wrapped as status 502 is not a remote HTTP 502.
        if(credential.ozonRoute!=='CN' || fields.status?.value!==502 || fields.code?.value!=='ZONGZI_HTTP_502')throw mapOzonFailure(error);
        try { response=await readWarehouse(Object.freeze({...credential,ozonRoute:'RU'})); }
        catch (backupError) { throw mapOzonFailure(backupError); }
      }

      let rows;
      try {
        rows = warehouseRows(response);
      } catch {
        throwVerifierError("RFBS_VALIDATION_REQUIRED", true);
      }
      const matches = rows.filter((row) => row.platformWarehouseId === target.platformWarehouseId);
      if (matches.length === 0) throwVerifierError("RFBS_WAREHOUSE_NOT_FOUND");
      if (matches.length !== 1) throwVerifierError("RFBS_WAREHOUSE_CHANGED");
      const match = matches[0].record;
      const status = normalizedStatus(match);
      if (status === "DISABLED") throwVerifierError("RFBS_WAREHOUSE_DISABLED");
      if (normalizedType(match) !== "RFBS" || status !== "ACTIVE") {
        throwVerifierError("RFBS_WAREHOUSE_CHANGED");
      }

      let observed;
      try {
        observed = now();
      } catch {
        throwVerifierError("AUTO_LISTING_RFBS_VALIDATION_FAILED");
      }
      if (!(observed instanceof Date) || !Number.isFinite(observed.getTime())) {
        throwVerifierError("AUTO_LISTING_RFBS_VALIDATION_FAILED");
      }
      const observedMillis = observed.getTime();
      const expiresMillis = observedMillis + Number(ttlMs);
      if (!Number.isFinite(expiresMillis) || expiresMillis <= observedMillis) {
        throwVerifierError("RFBS_WAREHOUSE_EVIDENCE_EXPIRED");
      }
      const normalized = {
        schemaVersion: "AUTO_LISTING_RFBS_WAREHOUSE_EVIDENCE_V1",
        accountId: input.accountId,
        storeId: input.targetStoreId,
        warehouseRecordId: input.targetWarehouseId,
        platformWarehouseId: target.platformWarehouseId,
        fulfillmentType: "RFBS",
        status: "ACTIVE",
        outcome: "PASSED",
        observedAt: observed.toISOString(),
        expiresAt: new Date(expiresMillis).toISOString(),
        correlationId: input.correlationId,
        actorAccountId: input.actorAccountId,
      };
      return Object.freeze({
        schemaVersion: normalized.schemaVersion,
        accountId: normalized.accountId,
        storeId: normalized.storeId,
        warehouseRecordId: normalized.warehouseRecordId,
        platformWarehouseId: normalized.platformWarehouseId,
        fulfillmentType: normalized.fulfillmentType,
        status: normalized.status,
        outcome: normalized.outcome,
        observedAt: normalized.observedAt,
        expiresAt: normalized.expiresAt,
        evidenceHash: hashEvidence(normalized),
        correlationId: normalized.correlationId,
        actorAccountId: normalized.actorAccountId,
      });
    } catch (error) {
      if (trustedErrors.has(error)) throw error;
      throw verifierError("AUTO_LISTING_RFBS_VALIDATION_FAILED");
    }
  }

  return Object.freeze({ verifyRfbsWarehouse });
}
