export function resolveSubmissionFailureDisposition(error = {}) {
  if (error?.body?.network || Number(error?.status || 0) >= 500) return "RECONCILING";
  if (error?.code === "SUBMISSION_NOT_SENT") return "RETRY_PENDING";
  return "FAILED";
}
