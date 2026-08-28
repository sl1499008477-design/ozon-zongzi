import assert from "node:assert/strict";
import test from "node:test";
import {
  aiSettingsCatalogForSummary,
  aiSettingsModelOptions,
  aiSettingsPresentation,
} from "../src/auto-listing-ai-settings-view.js";

const CHECKED_AT = "2026-08-08T00:00:00.000Z";

test("catalog detail is unavailable until both detail and its matching summary exist", () => {
  const catalog = { id: "catalog-a", catalog: { models: [] } };
  const detail = { catalog };
  assert.equal(aiSettingsCatalogForSummary(null, null), null);
  assert.equal(aiSettingsCatalogForSummary(detail, null), null);
  assert.equal(aiSettingsCatalogForSummary(null, { id: "catalog-a" }), null);
  assert.equal(aiSettingsCatalogForSummary(detail, { id: "catalog-b" }), null);
  assert.equal(aiSettingsCatalogForSummary(detail, { id: "catalog-a" }), catalog);
});

test("model selection keeps every catalog model reachable while ranking recommendations first", () => {
  const models = Array.from({ length: 2_000 }, (_unused, index) => ({
    id: `model-${String(index).padStart(4, "0")}`, ownedBy: "provider", metadata: {},
  }));
  const options = aiSettingsModelOptions({ catalog: { models } }, [
    { modelId: "model-1999", reasons: ["支持图片生成"] },
  ]);
  assert.equal(options.length, 2_000);
  assert.deepEqual(options[0], {
    value: "model-1999", recommended: true, reasons: ["支持图片生成"],
  });
  assert.equal(options.at(-1).value, "model-1998");
});

function paidCapability(overrides = {}) {
  return { outcome: "PASSED", features: ["STRUCTURED_TEXT", "IMAGE_GENERATION", "IMAGE_DECODE_PNG"],
    latencyMs: 123, models: { text: "text-a", image: "image-a" }, checkedAt: CHECKED_AT,
    errorCode: null, ...overrides };
}

function channel(overrides = {}) {
  return { channelId: "channel-a", displayName: "独立通道", channelOrder: 2, enabled: true,
    status: "BUSY", connectionDisplayName: "已验证 Gateway", connectionId: "connection-b", connectionVersion: 2,
    assignedItemId: "item-a", cooldownUntil: null, requiresRevalidation: false, lastErrorCode: null, ...overrides };
}

function channelCandidate(overrides = {}) {
  return { connectionId: "connection-b", connectionVersion: 2, connectionDisplayName: "已验证 Gateway", ...overrides };
}

function overview(overrides = {}) {
  return { connections: [{ id: "connection-a", displayName: "本地 sub2API", baseUrl: "https://gateway.example/v1", version: 1, status: "VALIDATED", validationResult: { outcome: "PASSED" } }], catalogs: [], syncTasks: [], profiles: [{ id: "profile-a", displayName: "商品模型", configVersion: 1, textModel: "text-a", imageModel: "image-a", textProtocol: "SUB2API_RESPONSES", imageProtocol: "SUB2API_OPENAI_IMAGES", enabled: false, capabilityResult: paidCapability(), capabilityCheckedAt: CHECKED_AT, connectionId: "connection-a", connectionVersion: 1 }], channels: [], channelCandidates: [], actions: { canCreateConnection: true, syncableConnectionIds: ["connection-a"], profileCreatableCatalogIds: [], testableProfileIds: ["profile-a"], publishableProfileIds: ["profile-a"], rollbackProfileIds: [] }, ...overrides };
}

test("channel presentation maps only known channel statuses and keeps the DTO closed", () => {
  const view = aiSettingsPresentation(overview({ channels: [channel()], channelCandidates: [channelCandidate()] }));
  assert.deepEqual(view.channels, [{ ...channel(), statusLabel: "使用中" }]);
  assert.deepEqual(view.channelCandidates, [channelCandidate()]);
  assert.equal(Object.isFrozen(view.channels[0]), true);
  assert.equal(view.channelsWarning, null);

  for (const mutation of [
    { status: "UNKNOWN" }, { cooldownUntil: "2026-08-08T00:00:00Z" }, { ciphertext: "must-not-leak" },
  ]) assert.deepEqual(aiSettingsPresentation(overview({ channels: [{ ...channel(), ...mutation }] })).channels, []);
});

test("channel presentation warns only when configured channels cannot process work", () => {
  assert.equal(aiSettingsPresentation(overview({ channels: [channel({ status: "DISABLED", enabled: false })] })).channelsWarning,
    "当前没有可用的独立通道，请检查通道配置");
  assert.equal(aiSettingsPresentation(overview({ channels: [channel({ status: "COOLDOWN", cooldownUntil: CHECKED_AT })] })).channelsWarning,
    "当前没有可用的独立通道，请检查通道配置");
  assert.equal(aiSettingsPresentation(overview({ channels: [channel({ status: "AVAILABLE" })] })).channelsWarning, null);
});

test("channel presentation fails closed on contradictory derived status fields", () => {
  for (const mutation of [
    { status: "BUSY", assignedItemId: null },
    { status: "AVAILABLE", enabled: false },
    { status: "DISABLED", enabled: true },
    { status: "REQUIRES_REVALIDATION", requiresRevalidation: false },
    { status: "COOLDOWN", cooldownUntil: null },
  ]) assert.deepEqual(aiSettingsPresentation(overview({ channels: [channel(mutation)] })).channels, []);

  assert.equal(aiSettingsPresentation(overview({ channels: [channel({ status: "DISABLED", enabled: false,
    assignedItemId: "item-a" })] })).channels[0].assignedItemId, "item-a");
});

test("presentation exposes only closed audit-backed activation evidence and never falls back to createdAt", () => {
  const activated = aiSettingsPresentation(overview({ profiles: [{ ...overview().profiles[0],
    createdAt: "2026-08-01T00:00:00.000Z",
    activation: { kind: "PUBLISH", occurredAt: "2026-08-09T02:03:04.000Z", actorId: "account-admin-a" },
  }] }));
  assert.deepEqual(activated.profiles[0].activation, {
    kind: "PUBLISH", kindLabel: "发布启用", occurredAt: "2026-08-09T02:03:04.000Z", actorId: "account-admin-a",
  });

  const legacy = aiSettingsPresentation(overview({ profiles: [{ ...overview().profiles[0],
    createdAt: "2026-08-01T00:00:00.000Z", activation: null,
  }] }));
  assert.equal(legacy.profiles[0].activation, null);
});

test("presentation exposes actions only from the complete server action contract", () => {
  const view = aiSettingsPresentation(overview());
  assert.deepEqual(view.connections[0].actions, { canSync: true });
  assert.deepEqual(view.profileCreatableCatalogIds, []);
  assert.deepEqual(view.profiles[0].actions, { canTest: true, canPublish: true, canRollback: false });
  assert.deepEqual(aiSettingsPresentation(overview({ actions: undefined })).profiles[0].actions, { canTest: false, canPublish: false, canRollback: false });
  assert.deepEqual(aiSettingsPresentation(overview({ actions: { ...overview().actions, extra: true } })).profiles[0].actions, { canTest: false, canPublish: false, canRollback: false });
});

test("presentation exposes profile creation only from the exact server catalog action", () => {
  const allowed = aiSettingsPresentation(overview({ actions: {
    ...overview().actions, profileCreatableCatalogIds: ["catalog-a"],
  } }));
  assert.deepEqual(allowed.profileCreatableCatalogIds, ["catalog-a"]);
  assert.deepEqual(aiSettingsPresentation(overview({ actions: undefined })).profileCreatableCatalogIds, []);
});

test("presentation renders only safe recommendation reasons and candidates stay unverified", () => {
  const view = aiSettingsPresentation(overview({ catalogs: [{ id: "catalog-a", connectionId: "connection-a", connectionVersion: 1, catalog: { recommendation: { verified: false, warnings: [], imageCandidates: [{ modelId: "image-a", reasonCodes: ["DECLARED_STRUCTURED_TEXT", "DECLARED_IMAGE_GENERATION", "DECLARED_REFERENCE_IMAGE", "internal-note"] }] } } }], profiles: [{ id: "profile-a", displayName: "商品模型", configVersion: 1, textModel: "text-a", imageModel: "image-a", capabilityResult: { outcome: "NOT_TESTED", checkedAt: CHECKED_AT, text: false, image: false }, capabilityCheckedAt: CHECKED_AT, enabled: false }] }));
  assert.deepEqual(view.recommendations, { verified: false, warnings: [], text: [], image: [{ modelId: "image-a", reasons: ["支持结构化输出", "支持图片生成", "支持参考图"] }] });
  assert.equal(view.profiles[0].verificationLabel, "待验证");
});

test("paid tests require an explicit warning and unconfirmed state", () => {
  assert.deepEqual(aiSettingsPresentation(overview()).profiles[0].paidTest, { costWarning: "能力测试可能产生费用，请确认后继续", requiresCostConfirmation: true, ready: false });
  assert.equal(aiSettingsPresentation(overview(), { costConfirmedProfileIds: ["profile-a"] }).profiles[0].paidTest.ready, true);
});

test("MISSING FAILED and UNKNOWN stay explicit and never imply selection or publication", () => {
  for (const [outcome, label] of [["MISSING", "模型不可用"], ["FAILED", "验证失败"], ["UNKNOWN", "验证结果未知"]]) {
    const capabilityResult = outcome === "FAILED"
      ? paidCapability({ outcome: "FAILED", features: [], latencyMs: null, errorCode: "GATEWAY_TIMEOUT" }) : { outcome };
    const view = aiSettingsPresentation(overview({ profiles: [{ ...overview().profiles[0], capabilityResult, enabled: false }], actions: { canCreateConnection: true, syncableConnectionIds: [], profileCreatableCatalogIds: [], testableProfileIds: [], publishableProfileIds: ["profile-a"], rollbackProfileIds: [] } }));
    assert.equal(view.profiles[0].verificationLabel, label); assert.equal(view.profiles[0].actions.canPublish, true); assert.equal(view.profiles[0].selected, false);
  }
});

test("recommendations retain independent text and image roles with all Task 5 reason codes", () => {
  const view = aiSettingsPresentation(overview({ catalogs: [{ catalog: { recommendation: { verified: false,
    warnings: ["RECOMMENDATIONS_UNVERIFIED", "NO_TEXT_MODEL_CANDIDATE"], textCandidates: [{ modelId: "same", reasonCodes: ["DECLARED_STRUCTURED_TEXT", "DECLARED_RESPONSES_PROTOCOL", "MODEL_ID_TEXT_HINT"] }],
    imageCandidates: [{ modelId: "same", reasonCodes: ["DECLARED_IMAGE_GENERATION", "DECLARED_REFERENCE_IMAGE", "DECLARED_TARGET_RESOLUTION", "MODEL_ID_IMAGE_HINT"] }] } } }] }));
  assert.deepEqual(view.recommendations, { verified: false, warnings: ["推荐结果尚未验证", "未找到文本模型候选"],
    text: [{ modelId: "same", reasons: ["支持结构化输出", "支持 Responses 协议", "模型名称推测"] }],
    image: [{ modelId: "same", reasons: ["支持图片生成", "支持参考图", "支持目标分辨率", "模型名称推测"] }] });
});

test("OAuth image-orchestrator recommendations remain visibly unverified", () => {
  const view = aiSettingsPresentation(overview({ catalogs: [{ catalog: { recommendation: {
    ruleVersion: "AUTO_LISTING_MODEL_RECOMMENDATION_V2",
    verified: false,
    warnings: ["RECOMMENDATIONS_UNVERIFIED"],
    textCandidates: [{ modelId: "gpt-5.4", reasonCodes: [
      "MODEL_ID_TEXT_HINT", "SUB2API_OAUTH_IMAGE_ORCHESTRATOR_HINT",
    ] }],
    imageCandidates: [{ modelId: "gpt-image-2", reasonCodes: ["MODEL_ID_IMAGE_HINT"] }],
  } } }] }));

  assert.deepEqual(view.recommendations.text, [{
    modelId: "gpt-5.4",
    reasons: ["模型名称推测", "OAuth 图片编排兼容提示（待验证）"],
  }]);
  assert.equal(view.recommendations.verified, false);
});

test("a passed profile is only verified with its exact latest successful catalog evidence", () => {
  const profile = overview().profiles[0];
  const catalog = { id: "catalog-a", connectionId: "connection-a", connectionVersion: 1, syncTaskId: "task-a", createdAt: CHECKED_AT, catalog: {
    activeSelectionState: "AVAILABLE", activeSelection: { profileId: "profile-a", configVersion: 1, textModel: "text-a", imageModel: "image-a" } } };
  const current = aiSettingsPresentation(overview({ profiles: [{ ...profile, enabled: true }], catalogs: [catalog], syncTasks: [{ id: "task-a", status: "SUCCEEDED", syncPurpose: "CATALOG_SYNC", connectionId: "connection-a", connectionVersion: 1 }] }));
  assert.equal(current.profiles[0].verificationLabel, "已验证");
  const stale = aiSettingsPresentation(overview({ profiles: [{ ...profile, enabled: true }], catalogs: [catalog], syncTasks: [{ id: "task-a", status: "SUCCEEDED", syncPurpose: "CATALOG_SYNC", connectionId: "other", connectionVersion: 1 }] }));
  assert.equal(stale.profiles[0].verificationLabel, "待刷新");
  assert.equal(stale.profiles[0].selected, true);
  assert.equal(stale.profiles[0].actions.canPublish, true);
});

test("publish remains the server action contract even when current enabled-health evidence is unavailable", () => {
  const view = aiSettingsPresentation(overview({ actions: { canCreateConnection: true, syncableConnectionIds: [], profileCreatableCatalogIds: [], testableProfileIds: [], publishableProfileIds: ["profile-a"], rollbackProfileIds: [] } }));
  assert.equal(view.profiles[0].verificationLabel, "已验证");
  assert.equal(view.profiles[0].actions.canPublish, true);
});

test("disabled publish candidate uses its own current paid capability rather than active-selection evidence", () => {
  const view = aiSettingsPresentation(overview({ profiles: [{ ...overview().profiles[0], enabled: false }], actions: { canCreateConnection: true, syncableConnectionIds: [], profileCreatableCatalogIds: [], testableProfileIds: [], publishableProfileIds: ["profile-a"], rollbackProfileIds: [] } }));
  assert.equal(view.profiles[0].verificationLabel, "已验证");
  assert.equal(view.profiles[0].actions.canPublish, true);
});

test("duplicate action IDs make the pure presentation fail closed even without the client", () => {
  for (const key of ["syncableConnectionIds", "profileCreatableCatalogIds", "testableProfileIds", "publishableProfileIds", "rollbackProfileIds"]) {
    const actions = structuredClone(overview().actions);
    const id = key === "syncableConnectionIds" ? "connection-a"
      : key === "profileCreatableCatalogIds" ? "catalog-a" : "profile-a";
    actions[key] = [id, id];
    const view = aiSettingsPresentation(overview({ actions }));
    assert.equal(view.canCreateConnection, false, key);
    assert.deepEqual(view.connections[0].actions, { canSync: false }, key);
    assert.deepEqual(view.profiles[0].actions, { canTest: false, canPublish: false, canRollback: false }, key);
  }
});

test("disabled profile is verified only by exact current paid evidence for its selected models", () => {
  const cases = [
    ["checkedAt mismatch", { capabilityCheckedAt: "2026-08-08T00:00:01.000Z" }],
    ["noncanonical stored timestamp", { capabilityCheckedAt: "2026-08-08T00:00:00Z" }],
    ["noncanonical result timestamp", { capabilityResult: paidCapability({ checkedAt: "2026-08-08T00:00:00Z" }) }],
    ["text model mismatch", { capabilityResult: paidCapability({ models: { text: "text-b", image: "image-a" } }) }],
    ["image model mismatch", { capabilityResult: paidCapability({ models: { text: "text-a", image: "image-b" } }) }],
    ["missing paid feature", { capabilityResult: paidCapability({ features: ["STRUCTURED_TEXT", "IMAGE_GENERATION"] }) }],
    ["open paid evidence", { capabilityResult: { ...paidCapability(), extra: true } }],
  ];
  for (const [label, mutation] of cases) {
    const profile = { ...overview().profiles[0], ...mutation };
    const view = aiSettingsPresentation(overview({ profiles: [profile] }));
    assert.equal(view.profiles[0].verificationLabel, "待刷新", label);
    assert.equal(view.profiles[0].actions.canPublish, true, label);
  }
  assert.equal(aiSettingsPresentation(overview()).profiles[0].verificationLabel, "已验证");
});

test("enabled profile requires matching canonical paid timestamps and the latest exact catalog evidence", () => {
  const profile = { ...overview().profiles[0], enabled: true };
  const available = { id: "catalog-old", connectionId: "connection-a", connectionVersion: 1, syncTaskId: "task-old",
    createdAt: "2026-08-08T00:01:00.000Z", catalog: { activeSelectionState: "AVAILABLE",
      activeSelection: { profileId: "profile-a", configVersion: 1, textModel: "text-a", imageModel: "image-a" } } };
  const missing = { id: "catalog-new", connectionId: "connection-a", connectionVersion: 1, syncTaskId: "task-new",
    createdAt: "2026-08-08T00:02:00.000Z", catalog: { activeSelectionState: "MISSING",
      activeSelection: { profileId: "profile-a", configVersion: 1, textModel: "text-a", imageModel: "image-a" } } };
  const tasks = [
    { id: "task-old", status: "SUCCEEDED", syncPurpose: "CATALOG_SYNC", connectionId: "connection-a", connectionVersion: 1 },
    { id: "task-new", status: "SUCCEEDED", syncPurpose: "CATALOG_SYNC", connectionId: "connection-a", connectionVersion: 1 },
  ];
  const latestMissing = aiSettingsPresentation(overview({ profiles: [profile], catalogs: [available, missing], syncTasks: tasks }));
  assert.equal(latestMissing.profiles[0].verificationLabel, "模型不可用");
  assert.equal(latestMissing.profiles[0].actions.canPublish, true);

  const current = aiSettingsPresentation(overview({ profiles: [profile], catalogs: [available], syncTasks: [tasks[0]] }));
  assert.equal(current.profiles[0].verificationLabel, "已验证");
  const stale = aiSettingsPresentation(overview({ profiles: [{ ...profile, capabilityCheckedAt: "2026-08-08T00:00:01.000Z" }], catalogs: [available], syncTasks: [tasks[0]] }));
  assert.equal(stale.profiles[0].verificationLabel, "待刷新");
  assert.equal(stale.profiles[0].selected, true);
  assert.equal(stale.profiles[0].actions.canPublish, true);
});
