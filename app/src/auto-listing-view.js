const STATUS = Object.freeze({
  CREATED: ["等待准备商品资料", "default"],
  SOURCE_READY: ["商品资料已准备", "default"],
  PLANNING: ["正在规划图片内容", "processing"],
  GENERATING: ["正在生成图片和内容", "processing"],
  READY_FOR_REVIEW: ["等待审核", "success"],
  UPLOAD_QUEUED: ["等待上传到 Ozon", "processing"],
  UPLOADING: ["正在上传到 Ozon", "processing"],
  SUCCEEDED: ["已完成上架", "success"],
  RETRYABLE_ERROR: ["处理暂时失败", "warning"],
  BLOCKED: ["需要处理问题", "error"],
  CANCELLED: ["已取消", "default"],
});

const FAILURE = Object.freeze({
  OZON_SKU_COLLECTION_FAILED: "暂时无法读取 Ozon 商品资料，可以重试",
  OZON_SKU_SCRAPE_EMPTY: "暂时无法读取 Ozon 商品资料，可以重试",
  PRODUCT_DIMENSIONS_UNAVAILABLE: "没有可靠的商品尺寸，将不生成尺寸图",
  AUTO_LISTING_CATEGORY_NOT_READY: "商品类目尚未准备完成，可以稍后重试",
  AUTO_LISTING_CATEGORY_RECOVERY_INVALIDATED: "Ozon 类目已失效，正在自动修复",
  AUTO_LISTING_CATEGORY_RECOVERY_MATCHED: "类目已重新匹配，正在继续上架",
  AUTO_LISTING_CATEGORY_RECOVERY_NEEDS_REVIEW: "无法确认商品类目，请人工选择",
  AUTO_LISTING_CATEGORY_RECOVERY_MATCH_AMBIGUOUS: "无法确认商品类目，请人工选择",
  AUTO_LISTING_CATEGORY_RECOVERY_INCOMPLETE: "无法确认商品类目，请人工选择",
  AUTO_LISTING_CATEGORY_RECOVERY_RETRY_FAILED: "无法确认商品类目，请人工选择",
  AUTO_LISTING_CATEGORY_RETRY_SUBMIT_FAILED: "无法确认商品类目，请人工选择",
  AUTO_LISTING_CATEGORY_RETRY_TASK_UNKNOWN: "Ozon 返回结果不明确，正在核对原任务",
  AUTO_LISTING_CATEGORY_RECOVERY_PRODUCT_UNKNOWN: "Ozon 返回结果不明确，正在核对原任务",
});

const IMPORT_STATUS = Object.freeze({
  RECEIVED: "文件已接收",
  QUEUED: "等待采集",
  COLLECTING: "正在采集商品资料",
  READY: "全部商品已准备",
  PARTIAL: "部分商品已准备",
  BLOCKED: "没有可处理的商品",
  CANCELLED: "导入已取消",
  FAILED: "导入失败",
});

const IMPORT_ROW_STATUS = Object.freeze({
  PENDING: "等待采集", COLLECTING: "正在采集", READY: "采集成功", FAILED: "采集失败",
  INVALID_SKU: "SKU 无效", DUPLICATE_IN_FILE: "文件内重复", CANCELLED: "已取消",
});

const IMPORT_ROW_ERROR = Object.freeze({
  OZON_SKU_COLLECTION_FAILED: "暂时无法读取 Ozon 商品资料，可以重试",
  OZON_SKU_SCRAPE_EMPTY: "暂时无法读取 Ozon 商品资料，可以重试",
  AUTO_LISTING_SOURCE_RESULT_INVALID: "采集结果不完整，不能自动重试",
  INVALID_SKU: "SKU 格式无效",
  FORMULA_RESULT_MISSING: "SKU 公式没有可读取的结果",
  SKU_COLUMN_MUST_BE_TEXT: "SKU 单元格必须是文本",
  DUPLICATE_IN_FILE: "该 SKU 在文件中重复",
});

export function autoListingActionAvailability(status) {
  if (status === "READY_FOR_REVIEW") return { review: true, approve: true, retry: false, regenerate: true, cancel: true };
  if (status === "RETRYABLE_ERROR") return { review: false, approve: false, retry: false, regenerate: false, cancel: true };
  if (status === "SUCCEEDED") return { review: true, approve: false, retry: false, regenerate: false, cancel: false };
  if (["CREATED", "SOURCE_READY", "PLANNING", "GENERATING", "UPLOAD_QUEUED", "UPLOADING"].includes(status)) {
    return { review: false, approve: false, retry: false, regenerate: false, cancel: true };
  }
  if (status === "BLOCKED") return { review: false, approve: false, retry: false, regenerate: false, cancel: false };
  return { review: false, approve: false, retry: false, regenerate: false, cancel: false };
}

function serverActions(value, status) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
    || Reflect.ownKeys(value).length !== 5
    || ["review", "approve", "retry", "regenerate", "cancel"].some((key) => typeof value[key] !== "boolean")) {
    return Object.freeze({ review: false, approve: false, retry: false, regenerate: false, cancel: false });
  }
  return Object.freeze({
    review: value.review, approve: value.approve, retry: value.retry,
    regenerate: value.regenerate, cancel: value.cancel,
  });
}

export function autoListingItemPresentation(item = {}) {
  const itemId = typeof item.itemId === "string" ? item.itemId : "";
  const status = typeof item.status === "string" ? item.status : "";
  const [statusLabel, tone] = STATUS[status] || ["未知状态", "default"];
  const failureCode = typeof item.failureCode === "string" ? item.failureCode : "";
  return Object.freeze({
    itemId,
    status,
    statusLabel,
    tone,
    failureLabel: failureCode
      ? (FAILURE[failureCode] || "商品暂时无法继续处理，请检查资料或联系管理员")
      : "",
    actions: serverActions(item.actions, status),
  });
}

function count(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

export function autoListingImportProgress(value = {}) {
  const total = count(value.totalRows);
  const ready = count(value.readyRows);
  const failed = count(value.failedRows);
  const duplicates = count(value.duplicateRows);
  const invalid = count(value.rejectedRows);
  const completed = Math.min(total, ready + failed + duplicates + invalid);
  return Object.freeze({
    total,
    completed,
    pending: Math.max(0, total - completed),
    ready,
    failed,
    duplicates,
    invalid,
    percent: total ? Math.round((completed / total) * 100) : 0,
    statusLabel: IMPORT_STATUS[value.status] || "未知导入状态",
  });
}

export function autoListingImportRowPresentation(value = {}) {
  const rowNumber = Number.isSafeInteger(value.rowNumber) && value.rowNumber > 0 ? value.rowNumber : 0;
  const sku = typeof value.sku === "string" ? value.sku.slice(0, 160) : "";
  const status = typeof value.status === "string" ? value.status : "";
  const errorCode = typeof value.errorCode === "string" ? value.errorCode : "";
  return Object.freeze({
    rowNumber,
    sku,
    statusLabel: IMPORT_ROW_STATUS[status] || "未知状态",
    attemptCount: Number.isSafeInteger(value.attemptCount) && value.attemptCount >= 0 ? value.attemptCount : 0,
    errorLabel: errorCode ? (IMPORT_ROW_ERROR[errorCode] || "该行暂时无法处理") : "",
    recoverable: value.recoverable === true,
  });
}

function canonicalTimestamp(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime()) ? null : timestamp.toISOString();
}

export function autoListingTaskRows(jobs) {
  return (Array.isArray(jobs) ? jobs : []).flatMap((job) => {
    if (!job || typeof job !== "object" || typeof job.jobId !== "string" || !job.jobId.trim()
      || !Array.isArray(job.items)) return [];
    const jobCreatedAt = canonicalTimestamp(job.createdAt);
    return job.items.filter((item) => item && typeof item === "object" && !Array.isArray(item))
      .map((item) => ({ ...item, jobId: job.jobId, jobCreatedAt }));
  });
}

export function autoListingCreatedAtLabel(value) {
  const timestamp = canonicalTimestamp(value);
  return timestamp ? `${timestamp.slice(0, 10)} ${timestamp.slice(11, 19)}` : "—";
}
