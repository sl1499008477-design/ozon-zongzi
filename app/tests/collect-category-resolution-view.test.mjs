import assert from "node:assert/strict";
import test from "node:test";
import { categoryResolutionView } from "../src/collect-category-resolution-view.js";

test("presents account-shared source, repair, continuation, review, and unknown-task states with fixed copy", () => {
  assert.deepEqual(categoryResolutionView({ status: "ACTIVE", source: "SOURCE_DIRECT" }), {
    tone: "success", label: "使用采集类目准备上架", action: "NONE",
  });
  for (const status of ["INVALIDATED", "QUEUED", "MATCHING", "RETRYABLE_ERROR"]) {
    assert.deepEqual(categoryResolutionView({ status }), {
      tone: "processing", label: "Ozon 类目已失效，正在自动修复", action: "NONE",
    }, status);
  }
  assert.deepEqual(categoryResolutionView({ status: "ACTIVE", source: "OZON_REFRESH" }), {
    tone: "success", label: "类目已重新匹配，正在继续上架", action: "NONE",
  });
  assert.deepEqual(categoryResolutionView({ status: "ACTIVE", source: "MANUAL" }), {
    tone: "success", label: "类目已重新匹配，正在继续上架", action: "NONE",
  });
  assert.deepEqual(categoryResolutionView({ status: "NEEDS_REVIEW" }), {
    tone: "warning", label: "无法确认商品类目，请人工选择", action: "ADMIN_CONFIRM",
  });
  for (const status of ["RECONCILING", "TASK_UNKNOWN"]) {
    assert.deepEqual(categoryResolutionView({ status }), {
      tone: "processing", label: "Ozon 返回结果不明确，正在核对原任务", action: "NONE",
    }, status);
  }
});

test("unknown backend or vendor text maps to one generic safe message", () => {
  const view = categoryResolutionView({
    status: "PRIVATE_VENDOR_STATE",
    message: "SQL: secret_table api_key=secret",
    error: "raw Ozon response",
  });
  assert.deepEqual(view, {
    tone: "default",
    label: "商品类目状态暂时无法确认，请联系管理员",
    action: "NONE",
  });
  assert.doesNotMatch(JSON.stringify(view), /secret|SQL|raw Ozon/u);
});
