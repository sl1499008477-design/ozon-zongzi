import assert from "node:assert/strict";
import test from "node:test";
import { aiSettingsPresentation } from "../src/auto-listing-ai-settings-view.js";

function overview(overrides = {}) {
  return { connections: [{ id: "connection-a", displayName: "本地 sub2API", baseUrl: "https://gateway.example/v1", version: 1, status: "VALIDATED", validationResult: { outcome: "PASSED" } }], catalogs: [], syncTasks: [], profiles: [{ id: "profile-a", displayName: "商品模型", configVersion: 1, textModel: "text-a", imageModel: "image-a", textProtocol: "SUB2API_RESPONSES", imageProtocol: "SUB2API_OPENAI_IMAGES", enabled: false, capabilityResult: { outcome: "PASSED", checkedAt: "2026-08-08T00:00:00.000Z", features: ["STRUCTURED_TEXT", "IMAGE_GENERATION", "IMAGE_DECODE_PNG"] }, capabilityCheckedAt: "2026-08-08T00:00:00.000Z", connectionId: "connection-a", connectionVersion: 1 }], actions: { canCreateConnection: true, syncableConnectionIds: ["connection-a"], testableProfileIds: ["profile-a"], publishableProfileIds: ["profile-a"], rollbackProfileIds: [] }, ...overrides };
}

test("presentation exposes actions only from the complete server action contract", () => {
  const view = aiSettingsPresentation(overview());
  assert.deepEqual(view.connections[0].actions, { canSync: true });
  assert.deepEqual(view.profiles[0].actions, { canTest: true, canPublish: true, canRollback: false });
  assert.deepEqual(aiSettingsPresentation(overview({ actions: undefined })).profiles[0].actions, { canTest: false, canPublish: false, canRollback: false });
  assert.deepEqual(aiSettingsPresentation(overview({ actions: { ...overview().actions, extra: true } })).profiles[0].actions, { canTest: false, canPublish: false, canRollback: false });
});

test("presentation renders only safe recommendation reasons and candidates stay unverified", () => {
  const view = aiSettingsPresentation(overview({ catalogs: [{ id: "catalog-a", connectionId: "connection-a", connectionVersion: 1, catalog: { recommendation: { verified: false, warnings: [], imageCandidates: [{ modelId: "image-a", reasonCodes: ["DECLARED_STRUCTURED_TEXT", "DECLARED_IMAGE_GENERATION", "DECLARED_REFERENCE_IMAGE", "internal-note"] }] } } }], profiles: [{ id: "profile-a", displayName: "商品模型", configVersion: 1, textModel: "text-a", imageModel: "image-a", capabilityResult: { outcome: "NOT_TESTED" }, enabled: false }] }));
  assert.deepEqual(view.recommendations, { verified: false, warnings: [], text: [], image: [{ modelId: "image-a", reasons: ["支持结构化输出", "支持图片生成", "支持参考图"] }] });
  assert.equal(view.profiles[0].verificationLabel, "待刷新");
});

test("paid tests require an explicit warning and unconfirmed state", () => {
  assert.deepEqual(aiSettingsPresentation(overview()).profiles[0].paidTest, { costWarning: "能力测试可能产生费用，请确认后继续", requiresCostConfirmation: true, ready: false });
  assert.equal(aiSettingsPresentation(overview(), { costConfirmedProfileIds: ["profile-a"] }).profiles[0].paidTest.ready, true);
});

test("MISSING FAILED and UNKNOWN stay explicit and never imply selection or publication", () => {
  for (const [outcome, label] of [["MISSING", "待刷新"], ["FAILED", "待刷新"], ["UNKNOWN", "待刷新"]]) {
    const view = aiSettingsPresentation(overview({ profiles: [{ ...overview().profiles[0], capabilityResult: { outcome }, enabled: false }], actions: { canCreateConnection: true, syncableConnectionIds: [], testableProfileIds: [], publishableProfileIds: ["profile-a"], rollbackProfileIds: [] } }));
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

test("a passed profile is only verified with its exact latest successful catalog evidence", () => {
  const profile = overview().profiles[0];
  const catalog = { id: "catalog-a", connectionId: "connection-a", connectionVersion: 1, syncTaskId: "task-a", catalog: {
    activeSelectionState: "AVAILABLE", activeSelection: { profileId: "profile-a", configVersion: 1, textModel: "text-a", imageModel: "image-a" } } };
  const current = aiSettingsPresentation(overview({ catalogs: [catalog], syncTasks: [{ id: "task-a", status: "SUCCEEDED", syncPurpose: "CATALOG_SYNC", connectionId: "connection-a", connectionVersion: 1 }] }));
  assert.equal(current.profiles[0].verificationLabel, "已验证");
  const stale = aiSettingsPresentation(overview({ profiles: [{ ...profile, enabled: true }], catalogs: [catalog], syncTasks: [{ id: "task-a", status: "SUCCEEDED", syncPurpose: "CATALOG_SYNC", connectionId: "other", connectionVersion: 1 }] }));
  assert.equal(stale.profiles[0].verificationLabel, "待刷新");
  assert.equal(stale.profiles[0].selected, true);
  assert.equal(stale.profiles[0].actions.canPublish, true);
});

test("publish remains the server action contract even when current enabled-health evidence is unavailable", () => {
  const view = aiSettingsPresentation(overview({ actions: { canCreateConnection: true, syncableConnectionIds: [], testableProfileIds: [], publishableProfileIds: ["profile-a"], rollbackProfileIds: [] } }));
  assert.equal(view.profiles[0].verificationLabel, "待刷新");
  assert.equal(view.profiles[0].actions.canPublish, true);
});
