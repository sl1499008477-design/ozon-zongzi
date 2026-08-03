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
    REGENERATE: "GENERATING",
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
  RETRYABLE_ERROR: {
    RETRY_PLANNING: "PLANNING",
    RETRY_GENERATION: "GENERATING",
    RETRY_UPLOAD: "UPLOAD_QUEUED",
    CANCEL: "CANCELLED",
  },
  SUCCEEDED: {},
  BLOCKED: {},
  CANCELLED: {},
};

const transitionError = () => {
  const error = new Error("AUTO_LISTING_TRANSITION_FORBIDDEN");
  error.code = "AUTO_LISTING_TRANSITION_FORBIDDEN";
  return error;
};

export function nextAutoListingStatus(currentStatus, eventType) {
  const nextStatus = TRANSITIONS[currentStatus]?.[eventType];
  if (typeof nextStatus !== "string") throw transitionError();
  return nextStatus;
}

export function assertAutoListingTransition(currentStatus, eventType, targetStatus) {
  if (targetStatus !== nextAutoListingStatus(currentStatus, eventType)) {
    throw transitionError();
  }
}
