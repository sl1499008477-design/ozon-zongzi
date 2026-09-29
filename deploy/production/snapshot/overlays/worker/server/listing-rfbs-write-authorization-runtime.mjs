import { getPostgresPool } from "./db/connection.mjs";
import { authorizeDirectRfbsPhase } from "./listing-direct-rfbs.mjs";
import crypto from "node:crypto";
import { types as utilTypes } from "node:util";

import { createAutoListingRfbsWarehouseVerifier } from "./auto-listing-rfbs-warehouse-verifier.mjs";
import { authorizeSubmissionRfbsWriteV3, readStoreCredentialV3 } from "./listing-pipeline.mjs";
import { callOzonSellerApi } from "./ozon-client.mjs";

const PHASES = new Set(["PRE_IMPORT", "PRE_STOCK"]);
const HANDOFF_FIELDS = Object.freeze([
  "rfbs_handoff_id", "rfbs_account_id", "rfbs_store_id", "rfbs_local_warehouse_id",
  "rfbs_platform_warehouse_id", "rfbs_fulfillment_type", "rfbs_link_identity_evidence_id",
  "rfbs_attempt_authorization_evidence_id", "rfbs_reserved_attempt_id",
  "rfbs_submission_link_id", "rfbs_business_idempotency_key",
]);

function runtimeError(code, retryable = false) {
  const error = new Error("RFBS 仓库写入前验证暂时不可用");
  error.code = code;
  error.status = 409;
  error.retryable = retryable === true;
  return error;
}

function plainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  try {
    if (utilTypes.isProxy(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(value).some((key) => typeof key !== "string")) return null;
    if (Object.values(descriptors).some((descriptor) => !Object.hasOwn(descriptor, "value"))) return null;
    return value;
  } catch { return null; }
}

function text(value, max = 240) {
  return typeof value === "string" && value === value.trim() && value.length > 0 && value.length <= max
    && !/[\u0000-\u001f\u007f]/u.test(value) ? value : "";
}

function closedWork(value, phase) {
  const work = plainRecord(value);
  if (!work || !PHASES.has(phase)) throw runtimeError("LISTING_RFBS_PHASE_SCOPE_INVALID");
  if (work.rfbs_authorization_required !== true) {
    if (work.rfbs_authorization_required !== false
      || HANDOFF_FIELDS.some((field) => work[field] != null)
      || work.rfbs_handoff_materialization_required !== false) {
      throw runtimeError("LISTING_RFBS_PHASE_SCOPE_INVALID");
    }
    return null;
  }
  const result = {
    jobId: text(work.id), accountId: text(work.account_id), snapshotId: text(work.snapshot_id),
    storeId: text(work.store_id), handoffId: work.rfbs_handoff_id == null
      ? null : text(work.rfbs_handoff_id),
    handoffAccountId: text(work.rfbs_account_id), handoffStoreId: text(work.rfbs_store_id),
    localWarehouseId: text(work.rfbs_local_warehouse_id),
    platformWarehouseId: text(work.rfbs_platform_warehouse_id),
    fulfillmentType: text(work.rfbs_fulfillment_type, 16),
    linkIdentityEvidenceId: text(work.rfbs_link_identity_evidence_id),
    attemptAuthorizationEvidenceId: text(work.rfbs_attempt_authorization_evidence_id),
    reservedAttemptId: text(work.rfbs_reserved_attempt_id),
    submissionLinkId: text(work.rfbs_submission_link_id),
    businessIdempotencyKey: text(work.rfbs_business_idempotency_key, 512),
    materializationRequired: work.rfbs_handoff_materialization_required,
    warehouseType: work.rfbs_current_warehouse_type == null
      ? null : text(work.rfbs_current_warehouse_type, 16),
    warehouseStatus: work.rfbs_current_warehouse_status == null
      ? null : text(work.rfbs_current_warehouse_status, 40),
    warehouseActive: work.rfbs_current_warehouse_active,
    warehouseArchived: work.rfbs_current_warehouse_archived,
  };
  if (Object.values(result).some((entry) => entry === "")
    || result.accountId !== result.handoffAccountId || result.storeId !== result.handoffStoreId
    || result.fulfillmentType !== "RFBS" || /^wh_/iu.test(result.platformWarehouseId)
    || typeof result.materializationRequired !== "boolean"
    || (result.materializationRequired ? result.handoffId !== null : !result.handoffId)
    || !((result.warehouseType === null && result.warehouseStatus === null
      && result.warehouseActive === null && result.warehouseArchived === null)
      || (typeof result.warehouseActive === "boolean" && typeof result.warehouseArchived === "boolean"))) {
    throw runtimeError("LISTING_RFBS_PHASE_SCOPE_INVALID");
  }
  return Object.freeze(result);
}

export function createListingRfbsWriteAuthorizationRuntime({
  readStoreCredential,
  callOzonSellerApi: callOzon,
  authorizeSubmissionRfbsWrite,
  createVerifier = createAutoListingRfbsWarehouseVerifier,
} = {}) {
  if (![readStoreCredential, callOzon, authorizeSubmissionRfbsWrite, createVerifier]
    .every((value) => typeof value === "function")) {
    throw new TypeError("RFBS write-authorization runtime dependencies are required");
  }
  return Object.freeze({
    async authorizePhase(untrustedWork, untrustedPhase) {
      const phase = text(untrustedPhase, 20);
      const work = closedWork(untrustedWork, phase);
      if (!work) return Object.freeze({ required: false, phase });
      const correlationId = `rfbs-phase-${phase.toLowerCase()}-${crypto.createHash("sha256")
        .update(work.jobId).digest("hex").slice(0, 32)}`;
      const verifier = createVerifier({
        async loadTarget({ accountId, targetStoreId, targetWarehouseId }) {
          if (accountId !== work.accountId || targetStoreId !== work.storeId
            || targetWarehouseId !== work.localWarehouseId) {
            throw runtimeError("LISTING_RFBS_PHASE_SCOPE_INVALID");
          }
          if (work.warehouseType === null) return null;
          return {
            id: work.localWarehouseId,
            accountId: work.accountId,
            storeId: work.storeId,
            warehouse_id: work.platformWarehouseId,
            warehouse_type: work.warehouseType,
            status: work.warehouseStatus,
            is_active: work.warehouseActive,
            is_archived: work.warehouseArchived,
          };
        },
        async readCredential({ accountId, targetStoreId }) {
          if (accountId !== work.accountId || targetStoreId !== work.storeId) {
            throw runtimeError("LISTING_RFBS_PHASE_SCOPE_INVALID");
          }
          return readStoreCredential(targetStoreId, accountId, null, untrustedWork.ozon_route);
        },
        callOzonSellerApi: callOzon,
      });
      let warehouseValidation;
      try {
        warehouseValidation = await verifier.verifyRfbsWarehouse({
          accountId: work.accountId,
          actorAccountId: work.accountId,
          targetStoreId: work.storeId,
          targetWarehouseId: work.localWarehouseId,
          correlationId,
        });
      } catch {
        throw runtimeError("LISTING_RFBS_PHASE_VALIDATION_REQUIRED", true);
      }
      try {
        return await authorizeSubmissionRfbsWrite({
          submissionJobId: work.jobId,
          phase,
          warehouseValidation,
        });
      } catch {
        throw runtimeError("LISTING_RFBS_PHASE_AUTHORIZATION_FAILED", true);
      }
    },
  });
}

const productionRuntime = createListingRfbsWriteAuthorizationRuntime({
  readStoreCredential: readStoreCredentialV3,
  callOzonSellerApi,
  authorizeSubmissionRfbsWrite: authorizeSubmissionRfbsWriteV3,
});

export const authorizeListingRfbsWritePhase = async (work, phase, {stocks} = {}) => work.type === "AUTO_LISTING"
  ? productionRuntime.authorizePhase(work, phase)
  : authorizeDirectRfbsPhase(work, phase, {pool: await getPostgresPool(), readCredential: (storeId,accountId)=>readStoreCredentialV3(storeId,accountId,null,work.ozon_route), callOzonSellerApi, stocks});
