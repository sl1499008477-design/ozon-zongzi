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

const ACTION_KEYS = Object.freeze(["review", "approve", "retry", "regenerate", "cancel"]);
const PRICE_KEYS = Object.freeze([
  "currency", "branch", "blackKopecks", "greenKopecks", "realPriceKopecks",
  "adjustmentKopecks", "finalPriceKopecks",
]);

function descriptorTreeSafe(value, seen = new WeakSet()) {
  if (value === null || ["string", "number", "boolean", "undefined"].includes(typeof value)) return true;
  if (typeof value !== "object" || seen.has(value)) return false;
  try {
    const array = Array.isArray(value);
    if (Object.getPrototypeOf(value) !== (array ? Array.prototype : Object.prototype)) return false;
    seen.add(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(value);
    if (array) {
      if (!Object.hasOwn(descriptors, "length") || !("value" in descriptors.length)
        || descriptors.length.value !== value.length) return false;
      const indexes = keys.filter((key) => key !== "length");
      if (indexes.length !== value.length
        || indexes.some((key, index) => key !== String(index))) return false;
    }
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!("value" in descriptor) || (key !== "length" && !descriptor.enumerable)
        || !descriptorTreeSafe(descriptor.value, seen)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function safeDataRoot(value, { array = false } = {}) {
  try {
    if ((array ? !Array.isArray(value) : Array.isArray(value)) || !descriptorTreeSafe(value)) return null;
    structuredClone(value);
    return Object.getOwnPropertyDescriptors(value);
  } catch {
    return null;
  }
}

function boundedString(value, { required = false } = {}) {
  return typeof value === "string" && value.length <= 512 && (!required || value.length > 0)
    ? value : null;
}

function projectActions(value) {
  const descriptors = safeDataRoot(value);
  if (!descriptors || Reflect.ownKeys(descriptors).length !== ACTION_KEYS.length
    || ACTION_KEYS.some((key) => !descriptors[key]?.enumerable
      || !("value" in descriptors[key]) || typeof descriptors[key].value !== "boolean")) return null;
  return Object.freeze(Object.fromEntries(ACTION_KEYS.map((key) => [key, descriptors[key].value])));
}

function projectPrice(value) {
  const descriptors = safeDataRoot(value);
  const keys = descriptors ? Reflect.ownKeys(descriptors) : [];
  if (!descriptors || keys.some((key) => typeof key !== "string" || !PRICE_KEYS.includes(key))
    || !descriptors.currency || !descriptors.branch) return null;
  const currency = descriptors.currency.value;
  const branch = descriptors.branch.value;
  if (!descriptors.currency.enumerable || !descriptors.branch.enumerable
    || !["RUB", "CNY"].includes(currency)
    || !["BLACK_GTE_80", "BLACK_LT_80"].includes(branch)) return null;
  const result = { currency, branch };
  for (const key of PRICE_KEYS.slice(2)) {
    if (!descriptors[key]) continue;
    const amount = descriptors[key].value;
    if (!descriptors[key].enumerable || typeof amount !== "string"
      || amount.length > 80 || !/^[+-]?\d+$/u.test(amount)) return null;
    result[key] = amount;
  }
  return Object.freeze(result);
}

function projectItem(value, { allowJobFields = true } = {}) {
  const descriptors = safeDataRoot(value);
  if (!descriptors) return null;
  const field = (key) => descriptors[key]?.value;
  const itemId = boundedString(field("itemId"), { required: true });
  const status = boundedString(field("status"), { required: true });
  if (!itemId || !Object.hasOwn(STATUS, status)) return null;
  const output = { itemId, status };
  for (const key of [
    "createdAt", "updatedAt", "targetStoreId", "targetWarehouseId",
    "sourceRecordId", "sourceVersion", "sourceHash", "failureCode",
  ]) {
    if (!descriptors[key]) continue;
    const text = boundedString(field(key));
    if (text === null) return null;
    output[key] = text;
  }
  if (descriptors.statusVersion) {
    const statusVersion = field("statusVersion");
    if (!Number.isSafeInteger(statusVersion) || statusVersion < 1) return null;
    output.statusVersion = statusVersion;
  }
  if (descriptors.price) {
    const price = projectPrice(field("price"));
    if (!price) return null;
    output.price = price;
  }
  if (descriptors.actions) {
    const actions = projectActions(field("actions"));
    if (!actions) return null;
    output.actions = actions;
  }
  if (allowJobFields) {
    if (descriptors.jobId) {
      const jobId = boundedString(field("jobId"), { required: true });
      if (!jobId) return null;
      output.jobId = jobId;
    }
    if (descriptors.jobCreatedAt) {
      const jobCreatedAt = field("jobCreatedAt");
      if (jobCreatedAt !== null && canonicalTimestamp(jobCreatedAt) !== jobCreatedAt) return null;
      output.jobCreatedAt = jobCreatedAt;
    }
  }
  return Object.freeze(output);
}

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

function serverActions(value) {
  return projectActions(value)
    || Object.freeze({ review: false, approve: false, retry: false, regenerate: false, cancel: false });
}

export function autoListingItemPresentation(item = {}) {
  const safe = projectItem(item) || {};
  const itemId = typeof safe.itemId === "string" ? safe.itemId : "";
  const status = typeof safe.status === "string" ? safe.status : "";
  const [statusLabel, tone] = STATUS[status] || ["未知状态", "default"];
  const failureCode = typeof safe.failureCode === "string" ? safe.failureCode : "";
  return Object.freeze({
    itemId,
    status,
    statusLabel,
    tone,
    failureLabel: failureCode
      ? (FAILURE[failureCode] || "商品暂时无法继续处理，请检查资料或联系管理员")
      : "",
    actions: serverActions(safe.actions),
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
  const root = safeDataRoot(jobs, { array: true });
  if (!root) return [];
  const rows = [];
  for (let index = 0; index < jobs.length; index += 1) {
    const job = root[String(index)]?.value;
    const descriptors = safeDataRoot(job);
    if (!descriptors) continue;
    const jobId = boundedString(descriptors.jobId?.value, { required: true });
    const items = descriptors.items?.value;
    if (!jobId || !Array.isArray(items)) continue;
    const jobCreatedAt = canonicalTimestamp(descriptors.createdAt?.value);
    for (const item of items) {
      const projected = projectItem(item, { allowJobFields: false });
      if (projected) rows.push(Object.freeze({ ...projected, jobId, jobCreatedAt }));
    }
  }
  return Object.freeze(rows);
}

export function autoListingCreatedAtLabel(value) {
  const timestamp = canonicalTimestamp(value);
  return timestamp ? `${timestamp.slice(0, 10)} ${timestamp.slice(11, 19)}` : "—";
}
