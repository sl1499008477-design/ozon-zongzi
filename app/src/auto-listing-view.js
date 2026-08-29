const STATUS = Object.freeze({
  CREATED: ["等待准备商品资料", "default"],
  SOURCE_READY: ["商品资料已准备", "default"],
  PLANNING: ["正在规划图片内容", "processing"],
  GENERATING: ["正在生成图片和内容", "processing"],
  READY_FOR_REVIEW: ["等待审核", "success"],
  UPLOAD_QUEUED: ["等待处理上传任务", "processing"],
  UPLOADING: ["正在准备上传资料", "processing"],
  SUCCEEDED: ["已完成上架", "success"],
  RETRYABLE_ERROR: ["处理暂时失败", "warning"],
  BLOCKED: ["需要处理问题", "error"],
  CANCELLED: ["已取消", "default"],
});

const FAILURE = Object.freeze({
  OZON_SKU_COLLECTION_FAILED: "暂时无法读取 Ozon 商品资料，可以重试",
  OZON_SKU_SCRAPE_EMPTY: "暂时无法读取 Ozon 商品资料，可以重试",
  PRODUCT_DIMENSIONS_UNAVAILABLE: "历史任务缺少可信参数，已改用其他图片角色",
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
  AI_GATEWAY_RATE_LIMITED: "AI 网关额度或频率受限，请检查额度后重试",
  CHECKER_UNAVAILABLE: "图片已生成，但质量检查服务暂时不可用，可以重试",
  CHECKER_RESPONSE_INVALID: "图片已生成，但质检结果格式异常；系统自动纠正后仍未通过，可以重试",
  CHECKER_EVIDENCE_INVALID: "图片已生成，但质检证据不一致；系统自动纠正后仍未通过，可以重试",
  RETRYABLE_GATEWAY: "当前 AI 图片通道暂时不可用，请检查通道后重试",
  AUTO_LISTING_IMAGE_GATEWAY_INVALID: "图片服务返回异常结果，可以重试；已通过的图片不会重复生成",
  AUTO_LISTING_AI_PHASE_CONTEXT_EVIDENCE_INVALID: "图片生成规则校验失败，可以重试；已通过的图片不会重复生成",
  PRODUCT_IDENTITY_MISMATCH: "生成图片中的商品与采集来源不一致，请重新生成",
  UNVERIFIED_CLAIM: "生成图片含有商品资料未支持的文案或功能信息，请重新生成",
  LANGUAGE_MISMATCH: "生成图片文案不符合俄语或已确认名称，请重新生成",
  PROHIBITED_CONTENT: "生成图片含有不受商品资料支持的承诺、配件关系或推广内容，请重新生成",
  IMAGE_QUALITY_FAILED: "生成图片存在模糊、裁切、遮挡或文字失真，请重新生成",
  CATEGORY_STYLE_MISMATCH: "生成图片与已发布的类目图片策略风格不一致，请重新生成",
  BLUR: "生成图片清晰度不足，请重新生成",
  CROP: "生成图片中的商品或文案被裁切，请重新生成",
  OBSTRUCTION: "生成图片中的商品被遮挡，请重新生成",
  TEXT_DISTORTION: "生成图片中的文字失真，请重新生成",
  DIMENSION_ANNOTATION_MISSING: "历史尺寸图缺少必要标注，请重新生成产品实拍图",
  ROLE_MISMATCH: "生成图片没有完成当前图片角色，请重新生成",
  DETAIL_NOT_CLOSEUP: "细节图没有清楚展示商品细节，请重新生成",
  SUBJECT_NOT_DOMINANT: "生成图片中的商品主体不够突出，请重新生成",
  LABEL_OVERLAP: "生成图片中的标签遮挡商品，请重新生成",
  LABEL_READABILITY_LOW: "生成图片中的标签不易阅读，请重新生成",
  AUTO_LISTING_MAIN_IMAGE_REQUIRED: "主图连续检查未通过，请重新生成整组图片",
  AUTO_LISTING_MINIMUM_IMAGE_COUNT_NOT_MET: "通过检查的图片数量不足，请重新生成未通过的图片",
  AUTO_LISTING_IMAGE_POLICY_REJECTED: "部分图片未通过检查，已保留其他通过检查的图片",
  AUTO_LISTING_IMAGE_FAILED: "图片生成阶段未完成，请重试；已通过的图片不会重复生成",
  AUTO_LISTING_CONTENT_PLAN_FAILED: "图片内容规划失败，可以重试",
  AUTO_LISTING_RICH_CONTENT_INPUT_INVALID: "商品资料中的内部字段未正确排除，可以重试；已通过的图片不会重复生成",
  AUTO_LISTING_RICH_CONTENT_REPOSITORY_FAILED: "保存生成内容失败，可以重试；已通过的图片不会重复生成",
  AUTO_LISTING_UPLOAD_POLICY_BLOCKED: "上传前策略校验未通过，可以安全重试",
  AUTO_LISTING_UPLOAD_EVIDENCE_INVALID: "逐商品图片配置校验未通过，可以安全重试",
  OZON_RICH_CONTENT_REJECTED_REQUIRES_REVIEW: "商品和库存已提交，但 Ozon 拒绝了富文本内容，请检查后重试",
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
const MULTIPLIER_PRICE_KEYS = Object.freeze(["preMultiplierPriceKopecks", "priceMultiplierMicros"]);
const HIGH_PRICE_KEYS = Object.freeze(PRICE_KEYS);
const LOW_PRICE_KEYS = Object.freeze(PRICE_KEYS.filter((key) => key !== "greenKopecks"));
const WORKFLOW_PROGRESS_KEYS = Object.freeze(["phase", "state", "attemptCount", "updatedAt", "nextRetryAt"]);
const WORKFLOW_PHASES = Object.freeze({
  PLAN_CONTENT: "图片内容规划",
  MATERIALIZE_SOURCE_ASSET: "准备原始图片",
  FINALIZE_MATERIALIZED_PLAN: "确认图片方案",
  GENERATE_IMAGE_SLOT: "生成商品图片",
  GENERATE_RICH_CONTENT: "生成富文本",
});
const WORKFLOW_STATES = new Set(["QUEUED", "RUNNING", "RETRY_WAIT", "COMPLETED", "FAILED"]);
const AI_QUEUE_STATES = new Set([
  "WAITING_FOR_AI_CHANNEL", "CALLING_AI", "SWITCHING_AI_CHANNEL",
]);
const STATUS_PERCENT = Object.freeze({
  CREATED: 5,
  SOURCE_READY: 15,
  PLANNING: 30,
  GENERATING: 60,
  READY_FOR_REVIEW: 80,
  UPLOAD_QUEUED: 85,
  UPLOADING: 95,
  SUCCEEDED: 100,
});
const PROCESSING_STATUSES = new Set([
  "CREATED", "SOURCE_READY", "PLANNING", "GENERATING", "UPLOAD_QUEUED", "UPLOADING",
]);
const TASK_FILTERS = new Set([
  "all", "processing", "review", "generation-failed", "upload-failed", "succeeded", "cancelled",
]);
const AUTO_LISTING_CHINA_TIME_FORMATTER = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

const runtimeIsProxy = (() => {
  try {
    const candidate = globalThis.process?.getBuiltinModule?.("node:util")?.types?.isProxy;
    return typeof candidate === "function" ? candidate : () => false;
  } catch {
    return () => false;
  }
})();

function descriptorTreeSafe(value, seen = new WeakSet()) {
  if (value === null || ["string", "number", "boolean", "undefined"].includes(typeof value)) return true;
  if (typeof value !== "object" || runtimeIsProxy(value) || seen.has(value)) return false;
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
  if (!value || typeof value !== "object" || runtimeIsProxy(value)) return null;
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
  if (!descriptors || !descriptors.currency || !descriptors.branch) return null;
  const currency = descriptors.currency.value;
  const branch = descriptors.branch.value;
  const branchKeys = branch === "BLACK_GTE_80" ? HIGH_PRICE_KEYS
    : branch === "BLACK_LT_80" ? LOW_PRICE_KEYS : null;
  const hasPreMultiplierPrice = Object.hasOwn(descriptors, "preMultiplierPriceKopecks");
  const hasPriceMultiplier = Object.hasOwn(descriptors, "priceMultiplierMicros");
  if (hasPreMultiplierPrice !== hasPriceMultiplier) return null;
  const expectedKeys = branchKeys && hasPreMultiplierPrice
    ? [...branchKeys.slice(0, -1), ...MULTIPLIER_PRICE_KEYS, branchKeys.at(-1)]
    : branchKeys;
  if (!descriptors.currency.enumerable || !descriptors.branch.enumerable
    || !["RUB", "CNY"].includes(currency)
    || !expectedKeys || keys.length !== expectedKeys.length
    || keys.some((key) => typeof key !== "string" || !expectedKeys.includes(key))) return null;
  const result = { currency, branch };
  for (const key of expectedKeys.slice(2)) {
    if (!descriptors[key]) return null;
    const amount = descriptors[key].value;
    const pattern = key === "adjustmentKopecks"
      ? /^(?:0|-?[1-9]\d{0,29})$/u : /^[1-9]\d{0,29}$/u;
    if (!descriptors[key].enumerable || typeof amount !== "string" || !pattern.test(amount)) return null;
    result[key] = amount;
  }
  return Object.freeze(result);
}

function projectWorkflowProgress(value) {
  const descriptors = safeDataRoot(value);
  if (!descriptors || Reflect.ownKeys(descriptors).length !== WORKFLOW_PROGRESS_KEYS.length
    || WORKFLOW_PROGRESS_KEYS.some((key) => descriptors[key]?.enumerable !== true
      || !Object.hasOwn(descriptors[key], "value"))) return null;
  const phase = descriptors.phase.value;
  const state = descriptors.state.value;
  const attemptCount = descriptors.attemptCount.value;
  const updatedAt = canonicalTimestamp(descriptors.updatedAt.value);
  const nextRetryAt = descriptors.nextRetryAt.value === null ? null : canonicalTimestamp(descriptors.nextRetryAt.value);
  if (!Object.hasOwn(WORKFLOW_PHASES, phase) || !WORKFLOW_STATES.has(state)
    || !Number.isSafeInteger(attemptCount) || attemptCount < 0 || !updatedAt
    || (state === "RETRY_WAIT" ? !nextRetryAt : nextRetryAt !== null)) return null;
  return Object.freeze({ phase, state, attemptCount, updatedAt, nextRetryAt });
}

function projectUploadPreparation(value, status) {
  if (!["UPLOAD_QUEUED", "UPLOADING"].includes(status)) return undefined;
  const descriptors = safeDataRoot(value);
  if (!descriptors || Reflect.ownKeys(descriptors).length !== 2
    || descriptors.published?.enumerable !== true || descriptors.total?.enumerable !== true
    || !Object.hasOwn(descriptors.published, "value") || !Object.hasOwn(descriptors.total, "value")) {
    return undefined;
  }
  const published = descriptors.published.value;
  const total = descriptors.total.value;
  if (!Number.isSafeInteger(published) || !Number.isSafeInteger(total)
    || total < 1 || published < 0 || published > total) return undefined;
  return Object.freeze({ published, total });
}

function projectAiQueue(descriptors, status) {
  const keys = ["aiQueueState", "aiChannelDisplayName", "aiChannelSwitching", "aiChannelWaitStartedAt"];
  const present = keys.filter((key) => descriptors[key]);
  if (present.length === 0) return undefined;
  if (present.length !== keys.length || present.some((key) => !descriptors[key].enumerable
    || !Object.hasOwn(descriptors[key], "value"))) return null;
  const state = descriptors.aiQueueState.value;
  const rawDisplayName = descriptors.aiChannelDisplayName.value;
  const displayName = rawDisplayName === null ? null
    : typeof rawDisplayName === "string" && rawDisplayName.trim()
      && rawDisplayName.length <= 200 && !/[\u0000-\u001f\u007f]/u.test(rawDisplayName)
      ? rawDisplayName : undefined;
  const switching = descriptors.aiChannelSwitching.value;
  const rawWaitStartedAt = descriptors.aiChannelWaitStartedAt.value;
  const waitStartedAt = rawWaitStartedAt === null ? null : canonicalTimestamp(rawWaitStartedAt);
  if (state === null) {
    return displayName === null && switching === false && rawWaitStartedAt === null
      ? Object.freeze({ aiQueueState: null, aiChannelDisplayName: null,
        aiChannelSwitching: false, aiChannelWaitStartedAt: null }) : null;
  }
  if (!AI_QUEUE_STATES.has(state) || !["PLANNING", "GENERATING"].includes(status)
    || displayName === undefined || typeof switching !== "boolean"
    || switching !== (state === "SWITCHING_AI_CHANNEL")
    || (state === "CALLING_AI" && (!displayName || rawWaitStartedAt !== null))
    || (state !== "CALLING_AI" && !waitStartedAt)) return null;
  return Object.freeze({
    aiQueueState: state,
    aiChannelDisplayName: displayName,
    aiChannelSwitching: switching,
    aiChannelWaitStartedAt: state === "CALLING_AI" ? null : waitStartedAt,
  });
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
    "sourceRecordId", "sourceVersion", "sourceHash", "sourceThumbnailUrl",
    "sourceTitle", "sourceSku", "failureCode",
  ]) {
    if (!descriptors[key]) continue;
    const text = boundedString(field(key));
    if (text === null) return null;
    output[key] = text;
  }
  if (descriptors.sourceOrder) {
    const sourceOrder = field("sourceOrder");
    if (!Number.isSafeInteger(sourceOrder) || sourceOrder < 1) return null;
    output.sourceOrder = sourceOrder;
  }
  if (descriptors.failureStage) {
    const failureStage = field("failureStage");
    if (failureStage !== null && !["PREPARATION", "GENERATION", "UPLOAD"].includes(failureStage)) return null;
    output.failureStage = failureStage;
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
  if (descriptors.workflowProgress) {
    const workflowProgress = projectWorkflowProgress(field("workflowProgress"));
    if (!workflowProgress) return null;
    output.workflowProgress = workflowProgress;
  }
  if (descriptors.uploadPreparation) {
    const uploadPreparation = projectUploadPreparation(field("uploadPreparation"), status);
    if (uploadPreparation) output.uploadPreparation = uploadPreparation;
  }
  const aiQueue = projectAiQueue(descriptors, status);
  if (aiQueue === null) return null;
  if (aiQueue) Object.assign(output, aiQueue);
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
  const [baseStatusLabel, tone] = STATUS[status] || ["未知状态", "default"];
  const uploadPreparation = safe.uploadPreparation;
  const statusLabel = status === "UPLOADING" && uploadPreparation
    ? uploadPreparation.published === uploadPreparation.total
      ? "图片已准备，正在提交到 Ozon"
      : `正在准备图片 ${uploadPreparation.published}/${uploadPreparation.total}`
    : baseStatusLabel;
  const failureCode = typeof safe.failureCode === "string" ? safe.failureCode : "";
  const progress = safe.workflowProgress;
  const progressLabels = {
    QUEUED: "等待后台领取", RUNNING: "AI 正在执行", RETRY_WAIT: "等待自动重试",
    COMPLETED: "当前阶段已完成", FAILED: "当前阶段执行失败",
  };
  const attemptLabel = progress?.state === "RUNNING"
    ? `第 ${Math.max(1, progress.attemptCount)} 次`
    : progress?.attemptCount > 0 ? `已尝试 ${progress.attemptCount} 次` : "尚未尝试";
  const aiQueueLabel = safe.aiQueueState === "WAITING_FOR_AI_CHANNEL" ? "等待可用 AI 通道"
    : safe.aiQueueState === "CALLING_AI" ? `正在使用「${safe.aiChannelDisplayName}」生成`
      : safe.aiQueueState === "SWITCHING_AI_CHANNEL" ? "原通道暂不可用，正在等待其他通道" : "";
  return Object.freeze({
    itemId,
    status,
    statusLabel,
    tone,
    failureLabel: failureCode
      ? (FAILURE[failureCode] || "商品暂时无法继续处理，请检查资料或联系管理员")
      : "",
    ...(aiQueueLabel ? { aiQueueLabel } : {}),
    ...(progress ? { workflowProgress: Object.freeze({
      label: progressLabels[progress.state],
      detail: `${WORKFLOW_PHASES[progress.phase]} · ${attemptLabel}`,
      updatedLabel: `最后更新 ${autoListingCreatedAtLabel(progress.updatedAt)}`,
      retryLabel: progress.nextRetryAt ? `下次重试 ${autoListingCreatedAtLabel(progress.nextRetryAt)}` : "",
    }) } : {}),
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
  if (!timestamp) return "—";
  const parts = Object.fromEntries(
    AUTO_LISTING_CHINA_TIME_FORMATTER.formatToParts(new Date(timestamp))
      .filter(({ type }) => ["year", "month", "day", "hour", "minute", "second"].includes(type))
      .map(({ type, value: partValue }) => [type, partValue]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

function displayText(value) {
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
}

export function autoListingCollectSelectionRows(localData = {}, collectIds = []) {
  let localDescriptors = null;
  try {
    if (localData && typeof localData === "object" && !Array.isArray(localData) && !runtimeIsProxy(localData)) {
      const localPrototype = Object.getPrototypeOf(localData);
      if (localPrototype !== Object.prototype && localPrototype !== null) throw new Error("unsafe carrier");
      localDescriptors = Object.getOwnPropertyDescriptors(localData);
    }
  } catch {}
  const cacheDescriptor = localDescriptors?.caches;
  const cache = cacheDescriptor?.enumerable && Object.hasOwn(cacheDescriptor, "value") ? cacheDescriptor.value : null;
  let cacheDescriptors = null;
  try {
    if (cache && typeof cache === "object" && !Array.isArray(cache) && !runtimeIsProxy(cache)) {
      const cachePrototype = Object.getPrototypeOf(cache);
      if (cachePrototype !== Object.prototype && cachePrototype !== null) throw new Error("unsafe carrier");
      cacheDescriptors = Object.getOwnPropertyDescriptors(cache);
    }
  } catch {}
  const cachedRowsDescriptor = cacheDescriptors?.collectBox;
  const localRowsDescriptor = localDescriptors?.collectBox;
  const sourceRows = cachedRowsDescriptor?.enumerable && Object.hasOwn(cachedRowsDescriptor, "value")
    && Array.isArray(cachedRowsDescriptor.value) ? cachedRowsDescriptor.value
    : localRowsDescriptor?.enumerable && Object.hasOwn(localRowsDescriptor, "value")
      && Array.isArray(localRowsDescriptor.value) ? localRowsDescriptor.value : null;
  const byId = new Map();
  try {
    if (sourceRows && !runtimeIsProxy(sourceRows)) {
      const rowDescriptors = Object.getOwnPropertyDescriptors(sourceRows);
      const rowLength = rowDescriptors.length?.value;
      if (Number.isSafeInteger(rowLength) && rowLength >= 0) {
        for (let index = 0; index < rowLength; index += 1) {
          const rowDescriptor = rowDescriptors[String(index)];
          const row = rowDescriptor?.enumerable && Object.hasOwn(rowDescriptor, "value") ? rowDescriptor.value : null;
          let sourceDescriptors = null;
          try {
            if (row && typeof row === "object" && !Array.isArray(row) && !runtimeIsProxy(row)) {
              const sourcePrototype = Object.getPrototypeOf(row);
              if (sourcePrototype !== Object.prototype && sourcePrototype !== null) throw new Error("unsafe carrier");
              sourceDescriptors = Object.getOwnPropertyDescriptors(row);
            }
          } catch {}
          const idDescriptor = sourceDescriptors?.id;
          const id = idDescriptor?.enumerable && Object.hasOwn(idDescriptor, "value")
            ? displayText(idDescriptor.value) : "";
          if (!id || !sourceDescriptors) continue;
          byId.set(id, sourceDescriptors);
        }
      }
    }
  } catch {}
  if (!Array.isArray(collectIds)) return Object.freeze([]);
  return Object.freeze(collectIds.flatMap((collectId) => {
    const id = displayText(collectId);
    const source = byId.get(id);
    if (!id || !source) return [];
    const field = (key) => {
      const descriptor = source[key];
      return descriptor?.enumerable && Object.hasOwn(descriptor, "value") ? displayText(descriptor.value) : "";
    };
    let firstImage = "";
    const imagesDescriptor = source.images;
    const images = imagesDescriptor?.enumerable && Object.hasOwn(imagesDescriptor, "value") ? imagesDescriptor.value : null;
    try {
      if (Array.isArray(images) && !runtimeIsProxy(images)) {
        const imageDescriptor = Object.getOwnPropertyDescriptor(images, "0");
        if (imageDescriptor?.enumerable && Object.hasOwn(imageDescriptor, "value")) firstImage = displayText(imageDescriptor.value);
      }
    } catch {}
    const thumbnailUrl = field("image") || field("primaryImage") || firstImage;
    return [Object.freeze({
      id,
      thumbnailUrl,
      title: field("name") || field("title") || field("productUrl"),
      sku: field("sku") || id,
    })];
  }));
}

function failurePercent(row) {
  if (row?.failureStage === "UPLOAD") return STATUS_PERCENT.UPLOADING;
  if (row?.failureStage === "GENERATION") return STATUS_PERCENT.GENERATING;
  const phase = row?.workflowProgress?.phase;
  if (phase === "GENERATE_IMAGE_SLOT" || phase === "GENERATE_RICH_CONTENT") {
    return STATUS_PERCENT.GENERATING;
  }
  if (phase === "PLAN_CONTENT" || phase === "MATERIALIZE_SOURCE_ASSET" || phase === "FINALIZE_MATERIALIZED_PLAN") {
    return STATUS_PERCENT.PLANNING;
  }
  return STATUS_PERCENT.CREATED;
}

export function autoListingTaskProgress(row = {}) {
  const status = typeof row?.status === "string" ? row.status : "";
  const waitingForChannel = ["WAITING_FOR_AI_CHANNEL", "SWITCHING_AI_CHANNEL"].includes(row?.aiQueueState);
  const completedPercent = row?.workflowProgress?.phase === "PLAN_CONTENT"
    ? STATUS_PERCENT.SOURCE_READY : STATUS_PERCENT.PLANNING;
  const uploadPreparation = projectUploadPreparation(row?.uploadPreparation, status);
  const uploadPercent = status === "UPLOADING" && uploadPreparation
    ? STATUS_PERCENT.UPLOAD_QUEUED
      + Math.floor((STATUS_PERCENT.UPLOADING - STATUS_PERCENT.UPLOAD_QUEUED)
        * uploadPreparation.published / uploadPreparation.total)
    : null;
  const percent = waitingForChannel ? completedPercent
    : uploadPercent ?? (Object.hasOwn(STATUS_PERCENT, status) ? STATUS_PERCENT[status]
      : ["RETRYABLE_ERROR", "BLOCKED", "CANCELLED"].includes(status) ? failurePercent(row) : 0);
  return Object.freeze({ percent: Math.min(percent, 99) === percent ? percent : 100 });
}

function timestampMilliseconds(value) {
  if (typeof value !== "string") return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

export function autoListingTaskDuration(row = {}, nowMs = Date.now()) {
  const status = typeof row?.status === "string" ? row.status : "";
  const start = timestampMilliseconds(row?.jobCreatedAt);
  const failed = status === "RETRYABLE_ERROR" || status === "BLOCKED";
  const cancelled = status === "CANCELLED";
  const terminal = status === "SUCCEEDED" || failed || cancelled;
  const end = terminal ? timestampMilliseconds(row?.updatedAt) : nowMs;
  const milliseconds = start === null || !Number.isFinite(end) ? 0 : Math.max(0, end - start);
  return Object.freeze({
    milliseconds,
    terminal,
    prefix: status === "SUCCEEDED" ? "总用时" : failed || cancelled ? "未上架 · 已用时" : "已用时",
  });
}

export function autoListingStageDuration(row = {}, nowMs = Date.now()) {
  const status = typeof row?.status === "string" ? row.status : "";
  if (!["UPLOAD_QUEUED", "UPLOADING"].includes(status)) return null;
  const start = timestampMilliseconds(row?.updatedAt);
  const milliseconds = start === null || !Number.isFinite(nowMs) ? 0 : Math.max(0, nowMs - start);
  return Object.freeze({ milliseconds, prefix: "当前阶段" });
}

export function autoListingTaskMatchesFilter(row = {}, filter) {
  if (!TASK_FILTERS.has(filter)) return false;
  if (filter === "all") return true;
  const status = typeof row?.status === "string" ? row.status : "";
  if (filter === "processing") return PROCESSING_STATUSES.has(status);
  if (filter === "review") return status === "READY_FOR_REVIEW";
  if (filter === "generation-failed") {
    return ["RETRYABLE_ERROR", "BLOCKED"].includes(status)
      && ["PREPARATION", "GENERATION"].includes(row?.failureStage);
  }
  if (filter === "upload-failed") {
    return ["RETRYABLE_ERROR", "BLOCKED"].includes(status) && row?.failureStage === "UPLOAD";
  }
  return filter === "succeeded" ? status === "SUCCEEDED" : status === "CANCELLED";
}
