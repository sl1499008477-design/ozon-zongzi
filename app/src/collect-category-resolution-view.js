const statusViews = Object.freeze({
  QUEUED: Object.freeze({ tone: "processing", label: "类目匹配中", action: "NONE" }),
  MATCHING: Object.freeze({ tone: "processing", label: "类目匹配中", action: "NONE" }),
  MATCHED: Object.freeze({ tone: "success", label: "类目已匹配", action: "NONE" }),
  WAITING_STORE: Object.freeze({ tone: "warning", label: "等待选择经营店铺", action: "NONE" }),
  WAITING_ENRICHMENT: Object.freeze({ tone: "warning", label: "等待商品资料补全", action: "NONE" }),
  NEEDS_REVIEW: Object.freeze({ tone: "warning", label: "需要人工选择类目", action: "SELECT_MANUALLY" }),
  RETRYABLE_ERROR: Object.freeze({ tone: "warning", label: "类目匹配暂时失败，系统将自动重试", action: "NONE" }),
  INVALIDATED: Object.freeze({ tone: "warning", label: "需要人工选择类目", action: "SELECT_MANUALLY" }),
});

const fallbackView = Object.freeze({
  tone: "default",
  label: "类目状态待更新",
  action: "NONE",
});

export function categoryResolutionView(summary = {}) {
  const status = String(summary?.status || "").trim().toUpperCase();
  return statusViews[status] || fallbackView;
}
