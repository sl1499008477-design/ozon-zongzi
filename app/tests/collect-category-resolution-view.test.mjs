import assert from "node:assert/strict";
import test from "node:test";
import { categoryResolutionView } from "../src/collect-category-resolution-view.js";

test("groups saved category statuses into the six collection-list business states", () => {
  assert.deepEqual(categoryResolutionView({ status: "MATCHING" }), {
    tone: "processing",
    label: "类目匹配中",
    action: "NONE",
  });
  assert.deepEqual(categoryResolutionView({ status: "QUEUED" }), {
    tone: "processing",
    label: "类目匹配中",
    action: "NONE",
  });
  assert.deepEqual(categoryResolutionView({ status: "MATCHED" }), {
    tone: "success",
    label: "类目已匹配",
    action: "NONE",
  });
  assert.deepEqual(categoryResolutionView({ status: "WAITING_STORE" }), {
    tone: "warning",
    label: "等待选择经营店铺",
    action: "NONE",
  });
  assert.deepEqual(categoryResolutionView({ status: "WAITING_ENRICHMENT" }), {
    tone: "warning",
    label: "等待商品资料补全",
    action: "NONE",
  });
  assert.deepEqual(categoryResolutionView({ status: "NEEDS_REVIEW" }), {
    tone: "warning",
    label: "需要人工选择类目",
    action: "SELECT_MANUALLY",
  });
  assert.deepEqual(categoryResolutionView({ status: "RETRYABLE_ERROR" }), {
    tone: "warning",
    label: "类目匹配暂时失败，系统将自动重试",
    action: "NONE",
  });
});

test("keeps invalidated categories selectable by hand without turning collection into a failure", () => {
  assert.deepEqual(categoryResolutionView({ status: "INVALIDATED" }), {
    tone: "warning",
    label: "需要人工选择类目",
    action: "SELECT_MANUALLY",
  });
  assert.deepEqual(categoryResolutionView({ status: "unexpected" }), {
    tone: "default",
    label: "类目状态待更新",
    action: "NONE",
  });
});
