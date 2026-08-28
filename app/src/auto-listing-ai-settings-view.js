const REASONS = Object.freeze({
  DECLARED_STRUCTURED_TEXT: "支持结构化输出",
  DECLARED_RESPONSES_PROTOCOL: "支持 Responses 协议",
  DECLARED_IMAGE_GENERATION: "支持图片生成",
  DECLARED_REFERENCE_IMAGE: "支持参考图",
  DECLARED_TARGET_RESOLUTION: "支持目标分辨率",
  MODEL_ID_TEXT_HINT: "模型名称推测",
  MODEL_ID_IMAGE_HINT: "模型名称推测",
  SUB2API_OAUTH_IMAGE_ORCHESTRATOR_HINT: "OAuth 图片编排兼容提示（待验证）",
});
const WARNINGS = Object.freeze({ RECOMMENDATIONS_UNVERIFIED: "推荐结果尚未验证", NO_TEXT_MODEL_CANDIDATE: "未找到文本模型候选", NO_IMAGE_MODEL_CANDIDATE: "未找到图片模型候选" });
const VERIFICATION = Object.freeze({
  PASSED: "已验证", FAILED: "验证失败", MISSING: "模型不可用", UNKNOWN: "验证结果未知",
  STALE: "验证已过期", NOT_TESTED: "待验证",
});
const PAID_FEATURES = new Set([
  "STRUCTURED_TEXT", "IMAGE_GENERATION", "IMAGE_DECODE_PNG", "IMAGE_DECODE_JPEG", "IMAGE_DECODE_WEBP",
]);
const DECODE_FEATURES = new Set(["IMAGE_DECODE_PNG", "IMAGE_DECODE_JPEG", "IMAGE_DECODE_WEBP"]);
const PAID_ERROR_CODES = new Set([
  "AI_GATEWAY_CAPABILITY_FAILED", "AI_GATEWAY_PROFILE_INVALID", "AI_GATEWAY_PROFILE_DISABLED",
  "AI_GATEWAY_REQUEST_INVALID", "AI_GATEWAY_SECRET_MISSING", "AI_GATEWAY_PROTOCOL_UNSUPPORTED",
  "AI_GATEWAY_MODEL_MISMATCH", "AI_GATEWAY_INPUT_UNSUPPORTED", "GATEWAY_REDIRECT_BLOCKED",
  "GATEWAY_TIMEOUT", "GATEWAY_CANCELLED", "RETRYABLE_GATEWAY", "NON_RETRYABLE_AUTH",
  "NON_RETRYABLE_GATEWAY", "INVALID_GATEWAY_RESPONSE",
]);
const CHANNEL_STATUS_LABELS = Object.freeze({ AVAILABLE: "可用", BUSY: "使用中", COOLDOWN: "冷却中",
  REQUIRES_REVALIDATION: "需要重新验证", DISABLED: "已停用" });
const CHANNEL_KEYS = ["channelId", "displayName", "channelOrder", "enabled", "status", "connectionDisplayName",
  "connectionId", "connectionVersion", "assignedItemId", "cooldownUntil", "requiresRevalidation", "lastErrorCode"];
const CHANNEL_CANDIDATE_KEYS = ["connectionId", "connectionVersion", "connectionDisplayName"];

function record(value) {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(value).some((key) => typeof key !== "string" || descriptors[key]?.enumerable !== true || !Object.hasOwn(descriptors[key], "value"))) return null;
    return Object.fromEntries(Object.keys(descriptors).map((key) => [key, descriptors[key].value]));
  } catch {
    return null;
  }
}

function strings(value) {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : [];
}

function exactRecord(value, keys) {
  const input = record(value);
  return input && Object.keys(input).length === keys.length && keys.every((key) => Object.hasOwn(input, key)) ? input : null;
}

function safeEntityId(value) {
  return typeof value === "string" && value === value.trim() && value.length > 0 && value.length <= 240
    && !value.includes("..") && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/u.test(value);
}

function safeModelId(value) {
  return typeof value === "string" && value === value.trim() && value.length > 0 && value.length <= 300
    && /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,299}$/u.test(value)
    && value.split("/").every((part) => part && part !== "." && part !== "..");
}

function safeChannelText(value) {
  return typeof value === "string" && value === value.trim() && value.length > 0 && value.length <= 200;
}

function safeChannelErrorCode(value) {
  return value === null || (typeof value === "string" && /^[A-Z][A-Z0-9_]{0,119}$/u.test(value));
}

function channelStatusFieldsAreConsistent(value) {
  if (value.status === "AVAILABLE") return value.enabled === true && value.requiresRevalidation === false
    && value.assignedItemId === null;
  if (value.status === "BUSY") return value.enabled === true && value.requiresRevalidation === false
    && value.assignedItemId !== null;
  if (value.status === "COOLDOWN") return value.enabled === true && value.requiresRevalidation === false
    && value.cooldownUntil !== null;
  if (value.status === "REQUIRES_REVALIDATION") return value.requiresRevalidation === true;
  return value.status === "DISABLED" && value.enabled === false && value.requiresRevalidation === false;
}

function channelPresentation(raw) {
  const value = exactRecord(raw, CHANNEL_KEYS);
  if (!value || !safeEntityId(value.channelId) || !safeChannelText(value.displayName)
    || !Number.isSafeInteger(value.channelOrder) || value.channelOrder < 1 || typeof value.enabled !== "boolean"
    || !Object.hasOwn(CHANNEL_STATUS_LABELS, value.status) || !safeChannelText(value.connectionDisplayName)
    || !safeEntityId(value.connectionId) || !Number.isSafeInteger(value.connectionVersion) || value.connectionVersion < 1
    || !(value.assignedItemId === null || safeEntityId(value.assignedItemId))
    || !(value.cooldownUntil === null || iso(value.cooldownUntil)) || typeof value.requiresRevalidation !== "boolean"
    || !safeChannelErrorCode(value.lastErrorCode) || !channelStatusFieldsAreConsistent(value)) return null;
  return Object.freeze({
    channelId: value.channelId,
    displayName: value.displayName,
    channelOrder: value.channelOrder,
    enabled: value.enabled,
    status: value.status,
    statusLabel: CHANNEL_STATUS_LABELS[value.status],
    connectionDisplayName: value.connectionDisplayName,
    connectionId: value.connectionId,
    connectionVersion: value.connectionVersion,
    assignedItemId: value.assignedItemId,
    cooldownUntil: value.cooldownUntil,
    requiresRevalidation: value.requiresRevalidation,
    lastErrorCode: value.lastErrorCode,
  });
}

function channelCandidatePresentation(raw) {
  const value = exactRecord(raw, CHANNEL_CANDIDATE_KEYS);
  if (!value || !safeEntityId(value.connectionId) || !Number.isSafeInteger(value.connectionVersion)
    || value.connectionVersion < 1 || !safeChannelText(value.connectionDisplayName)) return null;
  return Object.freeze({ connectionId: value.connectionId, connectionVersion: value.connectionVersion,
    connectionDisplayName: value.connectionDisplayName });
}

function channelsPresentation(rawChannels, rawCandidates) {
  if (!Array.isArray(rawChannels) || !Array.isArray(rawCandidates) || rawCandidates.length > 100) {
    return Object.freeze({ channels: Object.freeze([]), channelCandidates: Object.freeze([]), channelsWarning: null });
  }
  const channels = rawChannels.map(channelPresentation);
  const candidates = rawCandidates.map(channelCandidatePresentation);
  if (channels.some((row) => row === null) || candidates.some((row) => row === null)
    || new Set(channels.map((row) => row.channelId)).size !== channels.length
    || new Set(candidates.map((row) => row.connectionId)).size !== candidates.length) {
    return Object.freeze({ channels: Object.freeze([]), channelCandidates: Object.freeze([]), channelsWarning: null });
  }
  const frozenChannels = Object.freeze(channels);
  return Object.freeze({ channels: frozenChannels, channelCandidates: Object.freeze(candidates),
    channelsWarning: frozenChannels.length && !frozenChannels.some((row) => ["AVAILABLE", "BUSY"].includes(row.status))
      ? "当前没有可用的独立通道，请检查通道配置" : null });
}

function actionContract(value) {
  const input = record(value);
  const keys = ["canCreateConnection", "syncableConnectionIds", "profileCreatableCatalogIds",
    "testableProfileIds", "publishableProfileIds", "rollbackProfileIds"];
  if (!input || Object.keys(input).length !== keys.length || keys.some((key) => !Object.hasOwn(input, key))
    || typeof input.canCreateConnection !== "boolean" || keys.slice(1).some((key) => !Array.isArray(input[key])
      || new Set(input[key]).size !== input[key].length || input[key].some((id) => !safeEntityId(id)))) return null;
  return input;
}

function verification(result) {
  const value = record(result);
  const outcome = typeof value?.outcome === "string" ? value.outcome : "NOT_TESTED";
  return { outcome, label: VERIFICATION[outcome] || "验证状态未知", passed: outcome === "PASSED" };
}

function iso(value) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
}

function paidCapabilityResult(raw) {
  const value = exactRecord(raw, ["outcome", "features", "latencyMs", "models", "checkedAt", "errorCode"]);
  const models = exactRecord(value?.models, ["text", "image"]);
  if (!value || !["PASSED", "FAILED"].includes(value.outcome) || !Array.isArray(value.features)
    || new Set(value.features).size !== value.features.length || value.features.some((feature) => !PAID_FEATURES.has(feature))
    || !models || !safeModelId(models.text) || !safeModelId(models.image) || !iso(value.checkedAt)) return null;
  if (value.outcome === "PASSED") {
    if (value.features.length !== 3 || !value.features.includes("STRUCTURED_TEXT")
      || !value.features.includes("IMAGE_GENERATION")
      || value.features.filter((feature) => DECODE_FEATURES.has(feature)).length !== 1
      || !Number.isInteger(value.latencyMs) || value.latencyMs < 0 || value.errorCode !== null) return null;
  } else if (value.features.length !== 0 || value.latencyMs !== null || !PAID_ERROR_CODES.has(value.errorCode)) return null;
  return value;
}

function currentPaidEvidence(profile) {
  const result = paidCapabilityResult(profile.capabilityResult);
  return Boolean(result) && iso(profile.capabilityCheckedAt) && result.checkedAt === profile.capabilityCheckedAt
    && result.models.text === profile.textModel && result.models.image === profile.imageModel
    && !(result.outcome === "FAILED" && profile.enabled === true);
}

function activationEvidence(raw) {
  if (raw === null || raw === undefined) return null;
  const value = exactRecord(raw, ["kind", "occurredAt", "actorId"]);
  if (!value || !["PUBLISH", "ROLLBACK"].includes(value.kind)
    || !iso(value.occurredAt) || !safeEntityId(value.actorId)) return null;
  return Object.freeze({
    kind: value.kind,
    kindLabel: value.kind === "PUBLISH" ? "发布启用" : "安全回退",
    occurredAt: value.occurredAt,
    actorId: value.actorId,
  });
}

function catalogSelection(catalogs, syncTasks, profile) {
  const evidenceRows = [];
  for (const raw of Array.isArray(catalogs) ? catalogs : []) {
    const row = record(raw); const catalog = record(row?.catalog);
    const task = (Array.isArray(syncTasks) ? syncTasks : []).map(record).find((entry) => entry?.id === row?.syncTaskId
      && entry.status === "SUCCEEDED" && entry.syncPurpose === "CATALOG_SYNC"
      && entry.connectionId === row?.connectionId && entry.connectionVersion === row?.connectionVersion);
    if (task && safeEntityId(row?.id) && iso(row?.createdAt)
      && row.connectionId === profile.connectionId && row.connectionVersion === profile.connectionVersion) evidenceRows.push({ row, catalog });
  }
  evidenceRows.sort((left, right) => right.row.createdAt.localeCompare(left.row.createdAt) || right.row.id.localeCompare(left.row.id));
  const latest = evidenceRows[0]?.catalog;
  const evidence = exactRecord(latest?.activeSelection, ["profileId", "configVersion", "textModel", "imageModel"]);
  if (!["AVAILABLE", "MISSING"].includes(latest?.activeSelectionState) || !evidence
    || evidence.profileId !== profile.id || evidence.configVersion !== profile.configVersion
    || evidence.textModel !== profile.textModel || evidence.imageModel !== profile.imageModel) return null;
  return latest.activeSelectionState;
}

function recommendations(catalogs) {
  const empty = Object.freeze({ verified: false, warnings: Object.freeze([]), text: Object.freeze([]), image: Object.freeze([]) });
  for (const catalog of Array.isArray(catalogs) ? catalogs : []) {
    const recommendation = record(record(catalog)?.catalog)?.recommendation;
    const recommendationValue = record(recommendation);
    if (!recommendationValue || recommendationValue.verified !== false || !Array.isArray(recommendationValue.warnings)) continue;
    const role = (candidates) => Object.freeze((Array.isArray(candidates) ? candidates : []).flatMap((candidate) => {
      const value = record(candidate); const modelId = typeof value?.modelId === "string" ? value.modelId : "";
      const reasons = [...new Set(strings(value?.reasonCodes).map((code) => REASONS[code]).filter(Boolean))];
      return modelId && reasons.length ? [Object.freeze({ modelId, reasons: Object.freeze(reasons) })] : [];
    }));
    return Object.freeze({ verified: false, warnings: Object.freeze(recommendationValue.warnings.map((code) => WARNINGS[code]).filter(Boolean)),
      text: role(recommendationValue.textCandidates), image: role(recommendationValue.imageCandidates) });
  }
  return empty;
}

export function aiSettingsModelOptions(rawCatalog, rawRecommendations = []) {
  const catalog = record(rawCatalog);
  const envelope = record(catalog?.catalog);
  const models = Array.isArray(envelope?.models) ? envelope.models.map(record).filter(Boolean) : [];
  const available = new Set(models.map((model) => model.id).filter(safeModelId));
  const output = [];
  const added = new Set();
  for (const raw of Array.isArray(rawRecommendations) ? rawRecommendations : []) {
    const recommendation = record(raw);
    const modelId = recommendation?.modelId;
    if (!safeModelId(modelId) || !available.has(modelId) || added.has(modelId)) continue;
    const reasons = [...new Set(strings(recommendation.reasons))];
    output.push(Object.freeze({ value: modelId, recommended: true, reasons: Object.freeze(reasons) }));
    added.add(modelId);
  }
  for (const model of models) {
    if (!safeModelId(model.id) || added.has(model.id)) continue;
    output.push(Object.freeze({ value: model.id, recommended: false, reasons: Object.freeze([]) }));
    added.add(model.id);
  }
  return Object.freeze(output);
}

export function aiSettingsCatalogForSummary(rawDetail, rawSummary) {
  const detail = record(rawDetail);
  const summary = record(rawSummary);
  const catalog = record(detail?.catalog);
  if (!catalog || !summary || !safeEntityId(catalog.id) || !safeEntityId(summary.id)
    || catalog.id !== summary.id) return null;
  return detail.catalog;
}

/**
 * Pure safe projection of the server-owned settings contract.  It deliberately never derives
 * permission from status, catalog membership, or an optimistic local selection.
 */
export function aiSettingsPresentation(overview = {}, rawViewState = {}) {
  const source = record(overview) || {};
  const viewState = record(rawViewState) || {};
  const confirmedProfiles = new Set(strings(viewState.costConfirmedProfileIds));
  const actions = actionContract(source.actions);
  const syncable = new Set(actions?.syncableConnectionIds || []);
  const profileCreatableCatalogIds = Object.freeze([...(actions?.profileCreatableCatalogIds || [])]);
  const testable = new Set(actions?.testableProfileIds || []);
  const publishable = new Set(actions?.publishableProfileIds || []);
  const rollback = new Set(actions?.rollbackProfileIds || []);
  const channelState = channelsPresentation(source.channels, source.channelCandidates);
  const connections = (Array.isArray(source.connections) ? source.connections : []).map((raw) => {
    const row = record(raw) || {};
    return Object.freeze({ id: typeof row.id === "string" ? row.id : "", displayName: typeof row.displayName === "string" ? row.displayName : "",
      status: typeof row.status === "string" ? row.status : "UNKNOWN", statusLabel: typeof row.status === "string" ? row.status : "UNKNOWN",
      actions: Object.freeze({ canSync: typeof row.id === "string" && syncable.has(row.id) }) });
  });
  const profiles = (Array.isArray(source.profiles) ? source.profiles : []).map((raw) => {
    const row = record(raw) || {};
    const capability = verification(row.capabilityResult);
    const selection = catalogSelection(source.catalogs, source.syncTasks, row);
    const currentPaid = currentPaidEvidence(row);
    const stale = { outcome: "REFRESH", label: "待刷新", passed: false };
    const state = row.enabled !== true ? (["PASSED", "FAILED"].includes(capability.outcome) && !currentPaid ? stale : capability)
      : selection === "MISSING" ? { outcome: "MISSING", label: VERIFICATION.MISSING, passed: false }
      : selection !== "AVAILABLE" || !currentPaid ? stale : capability;
    const id = typeof row.id === "string" ? row.id : "";
    const confirmed = confirmedProfiles.has(id);
    return Object.freeze({ id, displayName: typeof row.displayName === "string" ? row.displayName : "",
      textModel: typeof row.textModel === "string" ? row.textModel : "", imageModel: typeof row.imageModel === "string" ? row.imageModel : "",
      status: state.outcome, statusLabel: state.label, verificationLabel: state.label,
      activation: activationEvidence(row.activation),
      selected: row.enabled === true,
      management: row.connectionId === null ? "legacy" : "managed", disabled: row.enabled !== true,
      connection: row.connectionId === null ? null : Object.freeze({ id: typeof row.connectionId === "string" ? row.connectionId : "", version: Number.isSafeInteger(row.connectionVersion) ? row.connectionVersion : 0 }),
      paidTest: Object.freeze({ costWarning: "能力测试可能产生费用，请确认后继续", requiresCostConfirmation: true, ready: confirmed }),
      actions: Object.freeze({ canTest: Boolean(id) && testable.has(id), canPublish: Boolean(id) && publishable.has(id),
        canRollback: Boolean(id) && rollback.has(id) }) });
  });
  return Object.freeze({ canCreateConnection: actions?.canCreateConnection === true,
    profileCreatableCatalogIds, connections: Object.freeze(connections),
    profiles: Object.freeze(profiles), recommendations: recommendations(source.catalogs), ...channelState });
}
