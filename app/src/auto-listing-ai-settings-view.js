const REASONS = Object.freeze({
  DECLARED_STRUCTURED_TEXT: "支持结构化输出",
  DECLARED_RESPONSES_PROTOCOL: "支持 Responses 协议",
  DECLARED_IMAGE_GENERATION: "支持图片生成",
  DECLARED_REFERENCE_IMAGE: "支持参考图",
  DECLARED_TARGET_RESOLUTION: "支持目标分辨率",
  MODEL_ID_TEXT_HINT: "模型名称推测",
  MODEL_ID_IMAGE_HINT: "模型名称推测",
});
const WARNINGS = Object.freeze({ RECOMMENDATIONS_UNVERIFIED: "推荐结果尚未验证", NO_TEXT_MODEL_CANDIDATE: "未找到文本模型候选", NO_IMAGE_MODEL_CANDIDATE: "未找到图片模型候选" });
const VERIFICATION = Object.freeze({
  PASSED: "已验证", FAILED: "验证失败", MISSING: "模型不可用", UNKNOWN: "验证结果未知",
  STALE: "验证已过期", NOT_TESTED: "待验证",
});

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

function actionContract(value) {
  const input = record(value);
  const keys = ["canCreateConnection", "syncableConnectionIds", "testableProfileIds", "publishableProfileIds", "rollbackProfileIds"];
  if (!input || Object.keys(input).length !== keys.length || keys.some((key) => !Object.hasOwn(input, key))
    || typeof input.canCreateConnection !== "boolean" || keys.slice(1).some((key) => !Array.isArray(input[key]) || input[key].some((id) => typeof id !== "string"))) return null;
  return input;
}

function verification(result) {
  const value = record(result);
  const outcome = typeof value?.outcome === "string" ? value.outcome : "NOT_TESTED";
  return { outcome, label: VERIFICATION[outcome] || "验证状态未知", passed: outcome === "PASSED" };
}

function iso(value) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function catalogSelection(catalogs, syncTasks, profile) {
  for (const raw of Array.isArray(catalogs) ? catalogs : []) {
    const row = record(raw); const catalog = record(row?.catalog);
    const task = (Array.isArray(syncTasks) ? syncTasks : []).map(record).find((entry) => entry?.id === row?.syncTaskId
      && entry.status === "SUCCEEDED" && entry.syncPurpose === "CATALOG_SYNC");
    const evidence = record(catalog?.activeSelection);
    if (task && row?.connectionId === profile.connectionId && row?.connectionVersion === profile.connectionVersion
      && evidence?.profileId === profile.id && evidence?.configVersion === profile.configVersion
      && evidence?.textModel === profile.textModel && evidence?.imageModel === profile.imageModel
      && typeof catalog?.activeSelectionState === "string") return catalog.activeSelectionState;
  }
  return "NOT_SELECTED";
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
  const testable = new Set(actions?.testableProfileIds || []);
  const publishable = new Set(actions?.publishableProfileIds || []);
  const rollback = new Set(actions?.rollbackProfileIds || []);
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
    const state = selection === "MISSING" ? { outcome: "MISSING", label: VERIFICATION.MISSING, passed: false }
      : capability.passed && (!iso(row.capabilityCheckedAt) || !iso(record(row.capabilityResult)?.checkedAt))
        ? { outcome: "UNKNOWN", label: VERIFICATION.UNKNOWN, passed: false } : capability;
    const id = typeof row.id === "string" ? row.id : "";
    const confirmed = confirmedProfiles.has(id);
    return Object.freeze({ id, displayName: typeof row.displayName === "string" ? row.displayName : "",
      textModel: typeof row.textModel === "string" ? row.textModel : "", imageModel: typeof row.imageModel === "string" ? row.imageModel : "",
      status: state.outcome, statusLabel: state.label, verificationLabel: state.label,
      selected: row.enabled === true,
      management: row.connectionId === null ? "legacy" : "managed", disabled: row.enabled !== true,
      connection: row.connectionId === null ? null : Object.freeze({ id: typeof row.connectionId === "string" ? row.connectionId : "", version: Number.isSafeInteger(row.connectionVersion) ? row.connectionVersion : 0 }),
      paidTest: Object.freeze({ costWarning: "能力测试可能产生费用，请确认后继续", requiresCostConfirmation: true, ready: confirmed }),
      actions: Object.freeze({ canTest: Boolean(id) && testable.has(id), canPublish: Boolean(id) && state.passed && publishable.has(id),
        canRollback: Boolean(id) && rollback.has(id) }) });
  });
  return Object.freeze({ canCreateConnection: actions?.canCreateConnection === true, connections: Object.freeze(connections),
    profiles: Object.freeze(profiles), recommendations: recommendations(source.catalogs) });
}
