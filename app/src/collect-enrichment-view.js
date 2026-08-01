const fieldLabels = Object.freeze({
  descriptionCategoryId: "产品类目",
  weightG: "包装重量",
  lengthMm: "包装长度",
  widthMm: "包装宽度",
  heightMm: "包装高度",
});

const statusViews = Object.freeze({
  PENDING_ENRICHMENT: Object.freeze({ tone: "processing", label: "资料补全中" }),
  WAITING_FOR_SELLER: Object.freeze({ tone: "warning", label: "等待 Seller 登录" }),
  RETRYING: Object.freeze({ tone: "processing", label: "正在自动重试" }),
  NEEDS_ATTENTION: Object.freeze({ tone: "danger", label: "资料补全需处理" }),
  COMPLETE: Object.freeze({ tone: "success", label: "资料已补全" }),
});

const pollingStatuses = new Set([
  "PENDING_ENRICHMENT",
  "WAITING_FOR_SELLER",
  "RETRYING",
]);

const enrichmentStatus = (summary = {}) => String(summary?.status || "").trim().toUpperCase();

const positiveCategoryId = (value) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
};

export function collectEditSourceCategorySnapshot(item = {}) {
  const candidates = [
    item?.listingDraft?.sourceCategory,
    item?.sourceCategory,
    item?.listingDraft?.categoryResolution?.source,
    item?.categoryResolution?.source,
  ].filter((value) => value && typeof value === "object" && !Array.isArray(value));
  return candidates.reduce((snapshot, candidate) => ({
    descriptionCategoryId: snapshot.descriptionCategoryId
      || positiveCategoryId(candidate.descriptionCategoryId ?? candidate.description_category_id),
    typeName: snapshot.typeName || String(candidate.typeName ?? candidate.type_name ?? "").trim(),
    typeIdCandidate: snapshot.typeIdCandidate
      || positiveCategoryId(candidate.typeIdCandidate ?? candidate.type_id_candidate),
    path: snapshot.path.length
      ? snapshot.path
      : (Array.isArray(candidate.path)
          ? candidate.path.map((value) => String(value ?? "").trim()).filter(Boolean)
          : []),
    attributes: snapshot.attributes.length
      ? snapshot.attributes
      : (Array.isArray(candidate.attributes)
          ? structuredClone(candidate.attributes.slice(0, 100))
          : []),
  }), {
    descriptionCategoryId: 0,
    typeName: "",
    typeIdCandidate: 0,
    path: [],
    attributes: [],
  });
}

export function collectEditSourceCategoryVariant(item = {}) {
  const source = collectEditSourceCategorySnapshot(item);
  return {
    ...(source.descriptionCategoryId
      ? { description_category_id: source.descriptionCategoryId }
      : {}),
    ...(source.typeIdCandidate ? { type_id: source.typeIdCandidate } : {}),
    ...(source.attributes.length ? { attributes: structuredClone(source.attributes) } : {}),
  };
}

const positivePackageValue = (...values) => {
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (!text) continue;
    const number = Number(text);
    if (Number.isFinite(number) && number > 0) return text;
  }
  return "";
};

const itemIdentity = (item = {}) => String(item?.id || item?.collectItemId || "").trim();

export function collectEditEnrichmentBackfill({
  current,
  item,
  activeItemId,
  generation,
  latestGeneration,
  dirtyFields = [],
} = {}) {
  if (
    !current
    || typeof current !== "object"
    || enrichmentStatus(item?.enrichment) !== "COMPLETE"
    || itemIdentity(item) !== String(activeItemId || "").trim()
    || Number(generation) !== Number(latestGeneration)
  ) return current;
  const draft = item?.listingDraft && typeof item.listingDraft === "object"
    ? item.listingDraft
    : {};
  const logistics = draft.logistics && typeof draft.logistics === "object"
    ? draft.logistics
    : {};
  const raw = item?.raw && typeof item.raw === "object" ? item.raw : {};
  const dirty = new Set(Array.isArray(dirtyFields) ? dirtyFields : []);
  const evidence = {
    packageWeight: positivePackageValue(
      draft.packageWeight,
      logistics.weightG,
      item?.packageWeight,
      item?.weightG,
      raw.packageWeight,
      raw.weight,
    ),
    packageLength: positivePackageValue(
      draft.packageLength,
      logistics.lengthMm,
      item?.packageLength,
      item?.lengthMm,
      raw.packageLength,
      raw.depth,
    ),
    packageWidth: positivePackageValue(
      draft.packageWidth,
      logistics.widthMm,
      item?.packageWidth,
      item?.widthMm,
      raw.packageWidth,
      raw.width,
    ),
    packageHeight: positivePackageValue(
      draft.packageHeight,
      logistics.heightMm,
      item?.packageHeight,
      item?.heightMm,
      raw.packageHeight,
      raw.height,
    ),
  };
  let changed = false;
  const merged = { ...current };
  for (const [field, value] of Object.entries(evidence)) {
    if (!dirty.has(field) && !String(merged[field] ?? "").trim() && value) {
      merged[field] = value;
      changed = true;
    }
  }
  return changed ? merged : current;
}

const missingFieldDetail = (missingFields = []) => {
  const labels = [];
  for (const field of Array.isArray(missingFields) ? missingFields : []) {
    const label = fieldLabels[String(field || "").trim()] || "其他必填资料";
    if (!labels.includes(label)) labels.push(label);
  }
  return labels.length ? `缺少：${labels.join("、")}` : "";
};

export function collectEnrichmentNeedsPolling(summary = {}) {
  return pollingStatuses.has(enrichmentStatus(summary));
}

export function collectEnrichmentListNeedsPolling(items = []) {
  return (Array.isArray(items) ? items : []).some((item) =>
    collectEnrichmentNeedsPolling(item?.enrichment || item),
  );
}

export function collectEnrichmentSuccessMessage(summary = {}) {
  const status = enrichmentStatus(summary);
  return status && status !== "COMPLETE"
    ? "已加入采集箱，资料正在后台补全"
    : "已加入采集箱";
}

export function collectEnrichmentErrorSummary(error = {}) {
  const code = String(error?.code || error?.body?.code || "").trim();
  if (code !== "COLLECT_ENRICHMENT_INCOMPLETE") return null;
  const missingFields = error?.body?.missingFields ?? error?.missingFields;
  return {
    status: "PENDING_ENRICHMENT",
    missingFields: Array.isArray(missingFields) ? missingFields : [],
  };
}

export function collectEnrichmentRetryPath(collectItemId) {
  const itemId = String(collectItemId || "").trim();
  if (!itemId) throw new Error("COLLECT_ITEM_REQUIRED");
  return `/ozon/collect-box/${encodeURIComponent(itemId)}/enrichment/retry`;
}

export function collectWorkflowStatus(item = {}) {
  const status = String(item?.status || "").trim();
  if (!status || statusViews[status.toUpperCase()]) return "待处理";
  return status;
}

export function collectEnrichmentRetryOverride({ item, response } = {}) {
  const responseSummary = response?.data?.enrichment || response?.enrichment || {};
  const missingFields = Array.isArray(responseSummary?.missingFields)
    ? responseSummary.missingFields
    : (Array.isArray(item?.enrichment?.missingFields) ? item.enrichment.missingFields : []);
  return {
    itemId: String(item?.id || "").trim(),
    baseItem: item,
    summary: {
      status: "RETRYING",
      missingFields: [...missingFields],
    },
  };
}

export function collectEnrichmentEffectiveSummary(item = {}, retryOverride = null) {
  const itemId = String(item?.id || "").trim();
  if (
    retryOverride?.baseItem === item
    && retryOverride?.itemId === itemId
    && retryOverride?.summary
  ) {
    return retryOverride.summary;
  }
  return item?.enrichment;
}

export function collectEnrichmentRetryNotice(refreshedState) {
  return refreshedState
    ? { type: "success", content: "已重新提交资料补全" }
    : { type: "warning", content: "已重新提交，状态刷新暂时失败，页面将自动重试" };
}

export async function runCollectEnrichmentRetry({
  item,
  request,
  applyOverride,
  refresh,
  refreshSource = "collect-enrichment-retry",
} = {}) {
  if (typeof request !== "function" || typeof applyOverride !== "function") {
    throw new TypeError("COLLECT_ENRICHMENT_RETRY_DEPENDENCIES_REQUIRED");
  }
  const response = await request(collectEnrichmentRetryPath(item?.id), { method: "POST" });
  const override = collectEnrichmentRetryOverride({ item, response });
  applyOverride(override);
  let refreshedState = null;
  try {
    refreshedState = await refresh?.({ silent: true, source: refreshSource });
  } catch {
    // The optimistic RETRYING state keeps polling until a later refresh succeeds.
  }
  return {
    response,
    override,
    refreshedState,
    notice: collectEnrichmentRetryNotice(refreshedState),
  };
}

export function startCollectEnrichmentPolling({
  refresh,
  setIntervalFn = globalThis.setInterval?.bind(globalThis),
  clearIntervalFn = globalThis.clearInterval?.bind(globalThis),
} = {}) {
  if (
    typeof refresh !== "function"
    || typeof setIntervalFn !== "function"
    || typeof clearIntervalFn !== "function"
  ) {
    throw new TypeError("COLLECT_ENRICHMENT_POLLER_DEPENDENCIES_REQUIRED");
  }
  let active = true;
  let refreshInFlight = false;
  const tick = async () => {
    if (!active || refreshInFlight) return;
    refreshInFlight = true;
    try {
      await refresh();
    } catch {
      // A later tick remains eligible to recover the visible state.
    } finally {
      if (active) refreshInFlight = false;
    }
  };
  const timer = setIntervalFn(tick, 5000);
  return () => {
    active = false;
    clearIntervalFn(timer);
  };
}

export function collectEnrichmentView(summary = {}) {
  const status = enrichmentStatus(summary);
  if (!status) {
    return {
      tone: "default",
      label: "",
      detail: "",
      retryable: false,
      listingBlocked: false,
    };
  }
  const view = statusViews[status] || { tone: "warning", label: "资料状态待确认" };
  return {
    ...view,
    detail: missingFieldDetail(summary?.missingFields),
    retryable: status === "NEEDS_ATTENTION",
    listingBlocked: status !== "COMPLETE",
  };
}
