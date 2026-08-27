const TRANSITIONS = {
  CREATED: {
    SOURCE_CAPTURED: "SOURCE_READY",
    BLOCK: "BLOCKED",
    CANCEL: "CANCELLED",
  },
  SOURCE_READY: {
    START_PLANNING: "PLANNING",
    BLOCK: "BLOCKED",
    CANCEL: "CANCELLED",
  },
  PLANNING: {
    PLAN_READY: "GENERATING",
    RETRYABLE_FAILURE: "RETRYABLE_ERROR",
    BLOCK: "BLOCKED",
    CANCEL: "CANCELLED",
  },
  GENERATING: {
    CONTENT_READY_FOR_REVIEW: "READY_FOR_REVIEW",
    CONTENT_READY_FOR_DIRECT_UPLOAD: "UPLOAD_QUEUED",
    RETRYABLE_FAILURE: "RETRYABLE_ERROR",
    BLOCK: "BLOCKED",
    CANCEL: "CANCELLED",
  },
  READY_FOR_REVIEW: {
    APPROVE_UPLOAD: "UPLOAD_QUEUED",
    REGENERATE: "PLANNING",
    BLOCK: "BLOCKED",
    CANCEL: "CANCELLED",
  },
  UPLOAD_QUEUED: {
    START_UPLOAD: "UPLOADING",
    RETRYABLE_FAILURE: "RETRYABLE_ERROR",
    BLOCK: "BLOCKED",
    CANCEL: "CANCELLED",
  },
  UPLOADING: {
    UPLOAD_SUCCEEDED: "SUCCEEDED",
    RETRYABLE_FAILURE: "RETRYABLE_ERROR",
    BLOCK: "BLOCKED",
  },
  RETRYABLE_ERROR: { CANCEL: "CANCELLED" },
  SUCCEEDED: {},
  BLOCKED: {
    APPROVE_UPLOAD: "UPLOAD_QUEUED",
    CANCEL: "CANCELLED",
  },
  CANCELLED: {},
};

const RECOVERY_POINTS_BY_FAILURE_STATUS = Object.freeze({
  PLANNING: "PLANNING",
  GENERATING: "GENERATION",
  UPLOAD_QUEUED: "UPLOAD",
  UPLOADING: "UPLOAD",
});

const RETRY_EVENTS_BY_RECOVERY_POINT = Object.freeze({
  PLANNING: "RETRY_PLANNING",
  GENERATION: "RETRY_GENERATION",
  UPLOAD: "RETRY_UPLOAD",
});

const RETRY_TARGETS_BY_EVENT = Object.freeze({
  RETRY_PLANNING: "PLANNING",
  RETRY_GENERATION: "GENERATING",
  RETRY_UPLOAD: "UPLOAD_QUEUED",
});

const SAFE_PRE_OZON_RETRY_FAILURES = new Set([
  "AUTO_LISTING_DIRECT_UPLOAD_DISABLED",
  "AUTO_LISTING_UPLOAD_POLICY_BLOCKED",
  "AUTO_LISTING_UPLOAD_EVIDENCE_INVALID",
]);

const SAFE_PRE_OZON_BLOCKED_CANCELLATION_FAILURES = new Set([
  "AUTO_LISTING_CONTENT_PLAN_FAILED",
  "AUTO_LISTING_CONTENT_PLANNER_INPUT_INVALID",
  "AUTO_LISTING_CONTENT_PLAN_GATEWAY_FAILED",
  "AUTO_LISTING_CONTENT_PLAN_INVALID",
  "AUTO_LISTING_CONTENT_PLAN_REPOSITORY_FAILED",
  "AUTO_LISTING_CONTENT_PLAN_RESERVATION_FAILED",
  "AUTO_LISTING_CONTENT_PLAN_VERSION_CONFLICT",
]);

export function isSafeAutoListingPreOzonRetryFailure(failureCode) {
  return typeof failureCode === "string" && SAFE_PRE_OZON_RETRY_FAILURES.has(failureCode);
}

export function isSafeAutoListingBlockedCancellationFailure(failureCode) {
  return typeof failureCode === "string" && SAFE_PRE_OZON_BLOCKED_CANCELLATION_FAILURES.has(failureCode);
}

const transitionError = () => {
  const error = new Error("AUTO_LISTING_TRANSITION_FORBIDDEN");
  error.code = "AUTO_LISTING_TRANSITION_FORBIDDEN";
  return error;
};

const recoveryPointError = () => {
  const error = new Error("AUTO_LISTING_RECOVERY_POINT_INVALID");
  error.code = "AUTO_LISTING_RECOVERY_POINT_INVALID";
  return error;
};

export function recoveryPointForRetryableFailure(currentStatus) {
  if (typeof currentStatus !== "string" || !Object.hasOwn(RECOVERY_POINTS_BY_FAILURE_STATUS, currentStatus)) {
    throw recoveryPointError();
  }
  return RECOVERY_POINTS_BY_FAILURE_STATUS[currentStatus];
}

export function assertAutoListingRetryEvent(recoveryPoint, eventType) {
  if (typeof recoveryPoint !== "string" || typeof eventType !== "string"
    || !Object.hasOwn(RETRY_EVENTS_BY_RECOVERY_POINT, recoveryPoint)
    || RETRY_EVENTS_BY_RECOVERY_POINT[recoveryPoint] !== eventType) {
    throw recoveryPointError();
  }
}

export function nextAutoListingStatus(currentStatus, eventType, recoveryPoint) {
  if (typeof currentStatus !== "string" || typeof eventType !== "string") {
    throw transitionError();
  }
  if (currentStatus === "RETRYABLE_ERROR" && Object.hasOwn(RETRY_TARGETS_BY_EVENT, eventType)) {
    if (typeof recoveryPoint !== "string"
      || RETRY_EVENTS_BY_RECOVERY_POINT[recoveryPoint] !== eventType) {
      throw transitionError();
    }
    return RETRY_TARGETS_BY_EVENT[eventType];
  }
  if (!Object.hasOwn(TRANSITIONS, currentStatus)
    || !Object.hasOwn(TRANSITIONS[currentStatus], eventType)) {
    throw transitionError();
  }
  const nextStatus = TRANSITIONS[currentStatus][eventType];
  if (typeof nextStatus !== "string") throw transitionError();
  return nextStatus;
}

export function assertAutoListingTransition(currentStatus, eventType, targetStatus, recoveryPoint) {
  if (typeof targetStatus !== "string") throw transitionError();
  if (targetStatus !== nextAutoListingStatus(currentStatus, eventType, recoveryPoint)) {
    throw transitionError();
  }
}
