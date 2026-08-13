const SOURCE_READY = Object.freeze({
  tone: "success", label: "使用采集类目准备上架", action: "NONE",
});
const REPAIRING = Object.freeze({
  tone: "processing", label: "Ozon 类目已失效，正在自动修复", action: "NONE",
});
const CONTINUING = Object.freeze({
  tone: "success", label: "类目已重新匹配，正在继续上架", action: "NONE",
});
const ADMIN_CONFIRM = Object.freeze({
  tone: "warning", label: "无法确认商品类目，请人工选择", action: "ADMIN_CONFIRM",
});
const RECONCILING = Object.freeze({
  tone: "processing", label: "Ozon 返回结果不明确，正在核对原任务", action: "NONE",
});
const UNKNOWN = Object.freeze({
  tone: "default", label: "商品类目状态暂时无法确认，请联系管理员", action: "NONE",
});

export function categoryResolutionView(summary = {}) {
  const status = typeof summary?.status === "string" ? summary.status.trim().toUpperCase() : "";
  if (status === "ACTIVE") {
    return summary?.source === "SOURCE_DIRECT" ? SOURCE_READY : CONTINUING;
  }
  if (["INVALIDATED", "QUEUED", "MATCHING", "RETRYABLE_ERROR"].includes(status)) return REPAIRING;
  if (status === "NEEDS_REVIEW") return ADMIN_CONFIRM;
  if (["RECONCILING", "TASK_UNKNOWN"].includes(status)) return RECONCILING;
  return UNKNOWN;
}
