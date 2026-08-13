import { types as utilTypes } from "node:util";

const REQUEST_KEYS = new Set(["accountId", "itemId", "submissionLinkId", "correlationId"]);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/u;
const SAFE_CODE = /^[A-Z][A-Z0-9_]{0,119}$/u;
const IN_PROGRESS = new Set([
  "QUEUE_PENDING", "QUEUED", "VALIDATING", "SUBMITTING", "OZON_ACCEPTED", "CHECKING",
  "RETRY_PENDING", "CANCEL_REQUESTED",
]);
const LINK_TERMINAL = new Set(["SUCCEEDED", "FAILED", "BLOCKED"]);

function reconcileError(code, status = 422, retryable = false) {
  const error = new Error("自动上架结果暂时无法确认");
  error.code = code;
  error.status = status;
  error.retryable = retryable;
  return error;
}

function plain(value) {
  try {
    return value !== null && typeof value === "object" && !Array.isArray(value)
      && [Object.prototype, null].includes(Object.getPrototypeOf(value));
  } catch { return false; }
}

function exactRequest(raw) {
  if (!plain(raw)) throw reconcileError("AUTO_LISTING_RECONCILE_INVALID");
  const keys = Reflect.ownKeys(raw);
  const descriptors = Object.getOwnPropertyDescriptors(raw);
  if (keys.length !== REQUEST_KEYS.size || keys.some((key) => typeof key !== "string"
    || !REQUEST_KEYS.has(key) || descriptors[key]?.enumerable !== true
    || !Object.hasOwn(descriptors[key], "value"))) {
    throw reconcileError("AUTO_LISTING_RECONCILE_INVALID");
  }
  const result = Object.fromEntries(keys.map((key) => [key, descriptors[key].value]));
  if (Object.values(result).some((value) => typeof value !== "string" || !SAFE_ID.test(value.trim()))) {
    throw reconcileError("AUTO_LISTING_RECONCILE_INVALID");
  }
  return Object.freeze(Object.fromEntries(Object.entries(result).map(([key, value]) => [key, value.trim()])));
}

function integer(value, maximum = 2_147_483_647) {
  return Number.isSafeInteger(value) && value >= 0 && value <= maximum ? value : 0;
}

function safeText(value, maximum = 240) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text && text.length <= maximum ? text : null;
}

function safeCode(value) {
  const result = typeof value === "string" ? value.trim().toUpperCase() : "";
  return SAFE_CODE.test(result) ? result : null;
}

function safeVariants(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 100).map((entry) => Object.freeze({
    offerId: safeText(entry?.offerId ?? entry?.offer_id),
    status: safeCode(entry?.status) || "UNKNOWN",
    productId: safeText(entry?.productId ?? entry?.product_id),
    errorCode: safeCode(entry?.errorCode ?? entry?.error_code),
  }));
}

function safeCategoryRecovery(value) {
  if (value === null || value === undefined) return null;
  const keys = ["attemptId", "status", "originalOzonTaskId", "retryOzonTaskId",
    "oldSharedCategoryVersion", "replacementSharedCategoryVersion"];
  try {
    if (utilTypes.isProxy(value) || !plain(value)) throw new Error("invalid recovery DTO");
    const ownKeys = Reflect.ownKeys(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (ownKeys.length !== keys.length || ownKeys.some((key) => typeof key !== "string"
      || !keys.includes(key) || descriptors[key]?.enumerable !== true
      || !Object.hasOwn(descriptors[key], "value"))) throw new Error("invalid recovery DTO");
    const projected = Object.fromEntries(keys.map((key) => [key, descriptors[key].value]));
    if (!SAFE_ID.test(projected.attemptId || "")
      || !["SUCCEEDED", "NEEDS_REVIEW"].includes(projected.status)
      || !SAFE_ID.test(projected.originalOzonTaskId || "")
      || !SAFE_ID.test(projected.retryOzonTaskId || "")
      || projected.originalOzonTaskId === projected.retryOzonTaskId
      || !Number.isSafeInteger(projected.oldSharedCategoryVersion)
      || projected.oldSharedCategoryVersion < 1
      || !Number.isSafeInteger(projected.replacementSharedCategoryVersion)
      || projected.replacementSharedCategoryVersion <= projected.oldSharedCategoryVersion) {
      throw new Error("invalid recovery DTO");
    }
    return Object.freeze(projected);
  } catch {
    throw reconcileError("AUTO_LISTING_RECONCILE_EVIDENCE_INVALID", 409);
  }
}

function submissionCategoryRecovery(submission) {
  try {
    if (utilTypes.isProxy(submission) || !plain(submission)) {
      throw new Error("invalid submission DTO");
    }
    const descriptor = Object.getOwnPropertyDescriptor(submission, "categoryRecovery");
    if (!descriptor) return null;
    if (descriptor.enumerable !== true || !Object.hasOwn(descriptor, "value")) {
      throw new Error("invalid recovery descriptor");
    }
    const recovery = safeCategoryRecovery(descriptor.value);
    if (recovery === null) return null;
    const taskDescriptor = Object.getOwnPropertyDescriptor(submission, "ozonTaskId")
      || Object.getOwnPropertyDescriptor(submission, "ozon_task_id");
    const statusDescriptor = Object.getOwnPropertyDescriptor(submission, "status");
    const taskId = taskDescriptor && Object.hasOwn(taskDescriptor, "value")
      ? taskDescriptor.value : null;
    const submissionStatus = statusDescriptor && Object.hasOwn(statusDescriptor, "value")
      ? statusDescriptor.value : null;
    const statusConsistent = recovery.status === "SUCCEEDED"
      ? ["CHECKING", "RECONCILING", "SUCCEEDED", "PARTIAL_SUCCESS"].includes(submissionStatus)
      : ["CHECKING", "RECONCILING", "FAILED", "PARTIAL_SUCCESS"].includes(submissionStatus);
    if (recovery.retryOzonTaskId !== taskId || !statusConsistent) {
      throw new Error("inconsistent recovery DTO");
    }
    return recovery;
  } catch (error) {
    if (error?.code === "AUTO_LISTING_RECONCILE_EVIDENCE_INVALID") throw error;
    throw reconcileError("AUTO_LISTING_RECONCILE_EVIDENCE_INVALID", 409);
  }
}

function summary(submission) {
  const result = plain(submission?.resultSummary) ? submission.resultSummary : {};
  return Object.freeze({
    submissionJobId: safeText(submission?.id),
    ozonTaskId: safeText(submission?.ozonTaskId ?? submission?.ozon_task_id),
    counts: Object.freeze({
      success: integer(submission?.successCount ?? result.success),
      failed: integer(submission?.failedCount ?? result.failed),
      skipped: integer(submission?.skippedCount ?? result.skipped),
      stockCount: integer(result.stockCount),
    }),
    variants: Object.freeze(safeVariants(submission?.items)),
    categoryRecovery: submissionCategoryRecovery(submission),
  });
}

function mapping(evidence) {
  const submission = evidence.submission;
  const status = safeCode(submission?.status);
  if (!status) throw reconcileError("AUTO_LISTING_RECONCILE_EVIDENCE_INVALID", 409);
  if (IN_PROGRESS.has(status)) {
    if (evidence.submissionLinkStatus === "RECONCILING") return {
      itemStatus: "BLOCKED", linkStatus: "RECONCILING",
      failureCode: "OZON_RECONCILIATION_REQUIRED",
      enqueueNextCheck: true, allowResubmission: false,
    };
    return {
      itemStatus: "UPLOADING", linkStatus: "SUBMITTED", failureCode: null,
      enqueueNextCheck: true, allowResubmission: false,
    };
  }
  if (status === "SUCCEEDED") return {
    itemStatus: "SUCCEEDED", linkStatus: "SUCCEEDED", failureCode: null,
    enqueueNextCheck: false, allowResubmission: false,
  };
  if (status === "PARTIAL_SUCCESS") return {
    itemStatus: "BLOCKED", linkStatus: "BLOCKED",
    failureCode: "OZON_PARTIAL_SUCCESS_REQUIRES_REVIEW",
    enqueueNextCheck: false, allowResubmission: false,
  };
  if (status === "RECONCILING") return {
    itemStatus: "BLOCKED", linkStatus: "RECONCILING",
    failureCode: "OZON_RECONCILIATION_REQUIRED",
    enqueueNextCheck: true, allowResubmission: false,
  };
  if (status === "FAILED") {
    const taskId = safeText(submission?.ozonTaskId ?? submission?.ozon_task_id);
    const errorCode = safeCode(submission?.errorCode ?? submission?.error_code);
    const provedNotSent = !taskId && errorCode === "SUBMISSION_NOT_SENT";
    return {
      itemStatus: "BLOCKED", linkStatus: "BLOCKED", failureCode: "OZON_SUBMISSION_FAILED_REQUIRES_REVIEW",
      enqueueNextCheck: false, allowResubmission: false,
      ...(provedNotSent ? { failureCode: "OZON_SUBMISSION_NOT_SENT_REQUIRES_ADMIN_RECOVERY" } : {}),
    };
  }
  if (status === "CANCELLED") {
    const accepted = Boolean(safeText(submission?.ozonTaskId ?? submission?.ozon_task_id));
    return accepted ? {
      itemStatus: "BLOCKED", linkStatus: "BLOCKED", failureCode: "OZON_RECONCILIATION_REQUIRED",
      enqueueNextCheck: false, allowResubmission: false,
    } : {
      itemStatus: "CANCELLED", linkStatus: "FAILED", failureCode: null,
      enqueueNextCheck: false, allowResubmission: false,
    };
  }
  throw reconcileError("AUTO_LISTING_RECONCILE_EVIDENCE_INVALID", 409);
}

function assertEvidence(value, request) {
  if (!plain(value) || value.accountId !== request.accountId || value.itemId !== request.itemId
    || value.submissionLinkId !== request.submissionLinkId || !SAFE_ID.test(value.jobId || "")
    || !Number.isSafeInteger(value.itemStatusVersion) || value.itemStatusVersion < 1
    || !SAFE_CODE.test(value.itemStatus || "") || !SAFE_CODE.test(value.submissionLinkStatus || "")
    || !plain(value.submission) || value.submission.accountId !== request.accountId
    || value.submission.id !== value.submissionJobId) {
    throw reconcileError("AUTO_LISTING_RECONCILE_EVIDENCE_INVALID", 409);
  }
  return value;
}

function duplicateResult(evidence) {
  return Object.freeze({
    itemId: evidence.itemId,
    status: evidence.itemStatus,
    statusVersion: evidence.itemStatusVersion,
    linkStatus: evidence.submissionLinkStatus,
    duplicate: true,
  });
}

export function createAutoListingSubmissionReconciler({ repository } = {}) {
  if (typeof repository?.loadReconciliationEvidence !== "function"
    || typeof repository?.applyReconciliation !== "function") {
    throw new TypeError("Auto-listing reconciliation repository is required");
  }
  return Object.freeze({
    async reconcile(raw = {}) {
      const request = exactRequest(raw);
      const evidence = assertEvidence(await repository.loadReconciliationEvidence(request), request);
      const next = mapping(evidence);
      if (evidence.itemStatus === next.itemStatus && evidence.submissionLinkStatus === next.linkStatus
        && (evidence.failureCode || null) === next.failureCode
        && LINK_TERMINAL.has(next.linkStatus)) {
        return duplicateResult(evidence);
      }
      const resolveReconciliationBlock = evidence.itemStatus === "BLOCKED"
        && evidence.failureCode === "OZON_RECONCILIATION_REQUIRED" && next.itemStatus === "SUCCEEDED";
      return repository.applyReconciliation({
        ...request,
        jobId: evidence.jobId,
        submissionJobId: evidence.submissionJobId,
        expectedItemStatus: evidence.itemStatus,
        expectedItemStatusVersion: evidence.itemStatusVersion,
        expectedLinkStatus: evidence.submissionLinkStatus,
        itemStatus: next.itemStatus,
        linkStatus: next.linkStatus,
        failureCode: next.failureCode,
        summary: summary(evidence.submission),
        advanceItemVersion: evidence.itemStatus !== next.itemStatus
          || (evidence.failureCode || null) !== next.failureCode,
        enqueueNextCheck: next.enqueueNextCheck,
        allowResubmission: next.allowResubmission,
        resolveReconciliationBlock,
      });
    },
  });
}
