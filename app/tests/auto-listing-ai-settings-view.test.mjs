import assert from "node:assert/strict";
import test from "node:test";
import { aiSettingsPresentation } from "../src/auto-listing-ai-settings-view.js";

function overview(overrides = {}) {
  return { connections: [{ id: "connection-a", displayName: "本地 sub2API", baseUrl: "https://gateway.example/v1", version: 1, status: "VALIDATED", validationResult: { outcome: "PASSED" } }], catalogs: [], syncTasks: [], profiles: [{ id: "profile-a", displayName: "商品模型", configVersion: 1, textModel: "text-a", imageModel: "image-a", textProtocol: "SUB2API_RESPONSES", imageProtocol: "SUB2API_OPENAI_IMAGES", enabled: false, capabilityResult: { outcome: "PASSED", features: ["STRUCTURED_TEXT", "IMAGE_GENERATION", "IMAGE_DECODE_PNG"] }, capabilityCheckedAt: "2026-08-08T00:00:00.000Z", connectionId: "connection-a", connectionVersion: 1 }], actions: { canCreateConnection: true, syncableConnectionIds: ["connection-a"], testableProfileIds: ["profile-a"], publishableProfileIds: ["profile-a"], rollbackProfileIds: [] }, ...overrides };
}

test("presentation exposes actions only from the complete server action contract", () => {
  const view = aiSettingsPresentation(overview());
  assert.deepEqual(view.connections[0].actions, { canSync: true });
  assert.deepEqual(view.profiles[0].actions, { canTest: true, canPublish: true, canRollback: false });
  assert.deepEqual(aiSettingsPresentation(overview({ actions: undefined })).profiles[0].actions, { canTest: false, canPublish: false, canRollback: false });
  assert.deepEqual(aiSettingsPresentation(overview({ actions: { ...overview().actions, extra: true } })).profiles[0].actions, { canTest: false, canPublish: false, canRollback: false });
});

test("presentation renders only safe recommendation reasons and candidates stay unverified", () => {
  const view = aiSettingsPresentation(overview({ catalogs: [{ id: "catalog-a", connectionId: "connection-a", connectionVersion: 1, catalog: { recommendation: { imageCandidates: [{ modelId: "image-a", reasonCodes: ["DECLARED_STRUCTURED_TEXT", "DECLARED_IMAGE_GENERATION", "DECLARED_REFERENCE_IMAGE", "internal-note"] }] } } }], profiles: [{ id: "profile-a", displayName: "商品模型", configVersion: 1, textModel: "text-a", imageModel: "image-a", capabilityResult: { outcome: "NOT_TESTED" }, enabled: false }] }));
  assert.deepEqual(view.recommendations, [{ modelId: "image-a", reasons: ["支持结构化输出", "支持图片生成", "支持参考图"] }]);
  assert.equal(view.profiles[0].verificationLabel, "待验证");
});

test("paid tests require an explicit warning and unconfirmed state", () => {
  assert.deepEqual(aiSettingsPresentation(overview()).profiles[0].paidTest, { costWarning: "能力测试可能产生费用，请确认后继续", requiresCostConfirmation: true, ready: false });
  assert.equal(aiSettingsPresentation(overview({ profiles: [{ ...overview().profiles[0], costConfirmed: true }] })).profiles[0].paidTest.ready, true);
});

test("MISSING FAILED and UNKNOWN stay explicit and never imply selection or publication", () => {
  for (const [outcome, label] of [["MISSING", "模型不可用"], ["FAILED", "验证失败"], ["UNKNOWN", "验证结果未知"]]) {
    const view = aiSettingsPresentation(overview({ profiles: [{ ...overview().profiles[0], capabilityResult: { outcome }, enabled: false }], actions: { canCreateConnection: true, syncableConnectionIds: [], testableProfileIds: [], publishableProfileIds: ["profile-a"], rollbackProfileIds: [] } }));
    assert.equal(view.profiles[0].verificationLabel, label); assert.equal(view.profiles[0].actions.canPublish, false); assert.equal(view.profiles[0].selected, false);
  }
});
