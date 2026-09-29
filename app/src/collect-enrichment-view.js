const fieldLabels = Object.freeze({
  descriptionCategoryId: "产品类目",
  weightG: "包装重量",
  lengthMm: "包装长度",
  widthMm: "包装宽度",
  heightMm: "包装高度",
});

const statusViews = Object.freeze({
  COLLECTION_FAILED: Object.freeze({ tone: "danger", label: "商品抓取失败" }),
  PENDING_ENRICHMENT: Object.freeze({ tone: "processing", label: "商品资料采集中" }),
  WAITING_FOR_SELLER: Object.freeze({ tone: "warning", label: "等待 Seller 登录" }),
  RETRYING: Object.freeze({ tone: "processing", label: "正在自动重试" }),
  NEEDS_ATTENTION: Object.freeze({ tone: "danger", label: "资料补全需处理" }),
  COMPLETE: Object.freeze({ tone: "success", label: "类目与包装已补全" }),
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
  const status = enrichmentStatus(summary);
  return status !== 'COMPLETE' && (summary.hasActiveJobs === true
    || recoveryExecutionStates.has(String(summary.executionState || '').toUpperCase())
    || pollingStatuses.has(status));
}

export function collectEnrichmentListNeedsPolling(items = []) {
  return (Array.isArray(items) ? items : []).some((item) =>
    collectEnrichmentNeedsPolling(item?.enrichment || item),
  );
}

export function collectEnrichmentPollingIds(items = []) {
  return [...new Set(items.filter(item => collectEnrichmentNeedsPolling(item?.enrichment))
    .map(itemIdentity).filter(Boolean))];
}

export async function refreshCollectEnrichmentProgress({ids, request, apply, signal, isCurrent = () => true}) {
  const requestedIds = [...new Set(ids)];
  const data = [];
  for (let offset = 0; offset < requestedIds.length; offset += 100) {
    if (signal?.aborted || !isCurrent()) return null;
    const query = new URLSearchParams();
    for (const id of requestedIds.slice(offset, offset + 100)) query.append('ids', id);
    const response = await request(`/ozon/collect-box/progress?${query}`, {signal});
    if (!Array.isArray(response?.data)) throw new Error('COLLECT_PROGRESS_RESPONSE_INVALID');
    data.push(...response.data);
  }
  if (!requestedIds.length || signal?.aborted || !isCurrent()) return null;
  const progress = {ids:requestedIds, data};
  apply(progress);
  return progress;
}

export function mergeCollectEnrichmentProgress(localData, {ids, data}, baseItems) {
  // A full refresh or saved edit supersedes a read that started from older items.
  if (localData?.caches?.collectBox !== baseItems) return localData;
  const requested = new Set(ids);
  const byId = new Map(data.map(item => [itemIdentity(item), item]));
  const collectBox = baseItems.flatMap(item => {
    const id = itemIdentity(item);
    if (!requested.has(id)) return [item];
    const updated = byId.get(id);
    return updated ? [updated] : []; // Deleted or fully listed items leave this view.
  });
  return {...localData, caches:{...localData.caches, collectBox}};
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
  if (collectEnrichmentEffectiveSummary(item)?.status === "COLLECTION_FAILED") return "失败";
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
  if (!item?.enrichment && item?.raw?.error === "scrape_failed"
    && !item.image && !item.images?.length && !item.listingDraft?.images?.length) {
    return { status: "COLLECTION_FAILED", lastErrorCode: "ZONGZI_SKU_SCRAPE_EMPTY" };
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
  const controller = new AbortController();
  const tick = async () => {
    if (!active || refreshInFlight) return;
    refreshInFlight = true;
    try {
      await refresh({signal:controller.signal});
    } catch {
      // A later tick remains eligible to recover the visible state.
    } finally {
      if (active) refreshInFlight = false;
    }
  };
  const timer = setIntervalFn(tick, 5000);
  return () => {
    active = false;
    controller.abort();
    clearIntervalFn(timer);
  };
}

const recoveryExecutionStates = new Set(['WAITING_FOR_EXTENSION', 'TIMED_OUT']);

const failureLabels = Object.freeze({
  ZONGZI_SKU_SCRAPE_EMPTY: '上次链接抓取失败，旧记录尚未恢复。请先留存手工填写的资料，再删除这条失败记录，并在采集助手中重新采集、发送。',
  ZONGZI_ENRICH_DATA_CONFLICT: '来源包装参数冲突，请核实后填写',
  ZONGZI_ENRICH_BUNDLE_UNCERTAIN: '上次商品包创建结果未确认，已停止重复创建',
  ZONGZI_ENRICH_INCOMPLETE: '来源资料缺失，请核实并补填包装参数',
  ZONGZI_ENRICH_NOT_FOUND: '来源未找到该 SKU',
  ZONGZI_ENRICH_UPSTREAM_FAILED: '来源读取失败',
  ZONGZI_ENRICH_BUSY: '来源请求受限，等待重试',
  ZONGZI_ENRICH_RETRY_EXHAUSTED: '自动重试已用尽，请检查来源后手动重试',
  SELLER_CONTEXT_REQUIRED: '请打开并登录 Seller 页面',
  SELLER_CONTEXT_CHANGED: 'Seller 店铺已切换，等待重新读取',
});

function enrichmentFailureDetail(failure, includeSku = false) {
  const diagnostic = failure.diagnostic || {};
  return [
    includeSku ? `SKU ${failure.sku || '未记录'}` : '',
    diagnostic.stage ? `阶段：${diagnostic.stage}` : (includeSku ? '阶段未记录' : ''),
    diagnostic.upstreamCode || '',
    diagnostic.upstreamStatus ? `HTTP ${diagnostic.upstreamStatus}` : '',
    failure.code !== diagnostic.upstreamCode ? failure.code : '',
    diagnostic.requestSent === false ? '未发送请求' : (diagnostic.requestSent === true ? '已发送请求' : ''),
    diagnostic.extensionVersion ? `扩展 ${diagnostic.extensionVersion}` : '',
    failure.message || failureLabels[failure.code] || failureLabels[String(failure.code || '').replace(/^OZON_/, 'ZONGZI_')] || '原因未记录',
  ].filter(Boolean).join(' · ');
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
  const complete = status === 'COMPLETE';
  const executionState = String(summary.executionState || '').toUpperCase();
  const waitingForExtension = !complete && recoveryExecutionStates.has(executionState);
  const failures = !complete && Array.isArray(summary.failures) ? summary.failures.filter(Boolean) : [];
  const failed = failures.some(failure => !failure.status || String(failure.status).toUpperCase() === 'FAILED');
  const legacyFailure = {
    code: summary.lastErrorCode || summary.lastError?.code || summary.error?.code || '',
    message: summary.lastErrorMessage || summary.lastError?.message || summary.error?.message || '',
    diagnostic: summary.lastErrorDiagnostic || summary.lastError?.diagnostic || summary.error?.diagnostic,
  };
  const showLegacyFailure = !complete && !Array.isArray(summary.failures) && !waitingForExtension
    && (legacyFailure.code || legacyFailure.message || legacyFailure.diagnostic);
  const view = statusViews[status] || { tone: "warning", label: "资料状态待确认" };
  return {
    ...view,
    ...(status === 'RETRYING' && Date.parse(summary.nextAttemptAt) > Date.now() ? {label:'等待自动重试'} : {}),
    ...(!complete && executionState ? ({
      PROCESSING: {label:'正在采集商品资料'},
      PENDING: {label:Date.parse(summary.nextAttemptAt)>Date.now()?'等待自动重试':'等待扩展处理'},
      FAILED: {label:'资料补全需处理',tone:'danger'},
    }[executionState] || {}) : {}),
    ...(summary.packagingConflicts?.length ? {label:'已采集，包装参数待核实',tone:'warning'} : {}),
    ...(waitingForExtension ? {label:'等待扩展恢复',tone:'warning'} : {}),
    ...(failed ? {label:'资料补全需处理',tone:'danger'} : {}),
    detail: [
      Number(summary.totalSkus)>0 ? `已完成 ${Number(summary.completedSkus)||0}/${Number(summary.totalSkus)} 个 SKU` : '',
      missingFieldDetail(summary?.packagingConflicts?.length ? (summary.missingFields||[]).filter(f=>f==='descriptionCategoryId') : summary?.missingFields),
      ...failures.map(failure => enrichmentFailureDetail(failure, true)),
      showLegacyFailure ? enrichmentFailureDetail(legacyFailure) : '',
      !complete && !waitingForExtension && Number(summary.attemptCount)>0 ? `已尝试 ${Number(summary.attemptCount)} 次` : '',
      status === 'RETRYING' && !waitingForExtension && summary.nextAttemptAt && Number.isFinite(Date.parse(summary.nextAttemptAt))
        ? `下次重试：${new Date(summary.nextAttemptAt).toLocaleString('zh-CN', {hour12:false})}` : '',
      ...(summary.packagingConflicts || []).map(conflict => `SKU ${conflict.sku}：` + conflict.candidates.map((v,i)=>`方案${i+1} ${v.weightG}g / ${v.lengthMm}×${v.widthMm}×${v.heightMm}mm`).join('；')),
      !summary.packagingConflicts?.length && Array.isArray(summary?.missingSkus) && summary.missingSkus.length
        ? `待补全 SKU：${summary.missingSkus.slice(0, 3).join("、")}${summary.missingSkus.length > 3 ? ` 等 ${summary.missingSkus.length} 个` : ""}` : "",
    ].filter(Boolean).join("；"),
    retryable: failed || (status === 'NEEDS_ATTENTION' && !waitingForExtension && !summary.packagingConflicts?.length),
    listingBlocked: !complete,
  };
}
