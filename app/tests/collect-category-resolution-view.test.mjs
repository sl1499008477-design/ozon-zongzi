import assert from "node:assert/strict";
import test from "node:test";
import { categoryResolutionView } from "../src/collect-category-resolution-view.js";

const summary = (overrides = {}) => ({
  status: "ACTIVE", taxonomyScope: "OZON:DEFAULT",
  sourceDescriptionCategoryId: 10, sourceTypeId: 20,
  currentDescriptionCategoryId: 30, currentTypeId: 40,
  source: "SOURCE_DIRECT", version: 3, validatedAt: null,
  action: "NONE", message: "使用采集类目准备上架",
  ...overrides,
});

test("presents only complete account-shared source, repair, continuation, and review states", () => {
  assert.deepEqual(categoryResolutionView(summary()), {
    tone: "success", label: "使用采集类目准备上架", action: "NONE",
  });
  assert.deepEqual(categoryResolutionView(summary({
    status: "INVALIDATED", source: "OZON_REFRESH",
    validatedAt: "2026-08-12T01:02:03.000Z", action: "WAIT",
    message: "Ozon 类目已失效，正在自动修复",
  })), {
    tone: "processing", label: "Ozon 类目已失效，正在自动修复", action: "NONE",
  });
  assert.deepEqual(categoryResolutionView(summary({
    source: "OZON_REFRESH", validatedAt: "2026-08-12T01:02:03.000Z",
  })), {
    tone: "success", label: "类目已重新匹配，正在继续上架", action: "NONE",
  });
  assert.deepEqual(categoryResolutionView(summary({
    source: "MANUAL", validatedAt: "2026-08-12T01:02:03.000Z",
  })), {
    tone: "success", label: "类目已重新匹配，正在继续上架", action: "NONE",
  });
  assert.deepEqual(categoryResolutionView({
    status: "NEEDS_REVIEW", taxonomyScope: "OZON:DEFAULT",
    sourceDescriptionCategoryId: null, sourceTypeId: null,
    currentDescriptionCategoryId: null, currentTypeId: null,
    source: null, version: null, validatedAt: null,
    action: "REVIEW", message: "无法确认商品类目，请人工选择",
  }), {
    tone: "warning", label: "无法确认商品类目，请人工选择", action: "ADMIN_CONFIRM",
  });
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

test("rejects incomplete, accessor, proxy, and extra shared summaries without executing data", () => {
  let calls = 0;
  const accessor = summary();
  Object.defineProperty(accessor, "message", {
    enumerable: true,
    get() { calls += 1; return "使用采集类目准备上架"; },
  });
  const transparent = new Proxy(summary(), {});
  const { proxy, revoke } = Proxy.revocable(summary(), {});
  revoke();
  const generic = {
    tone: "default", label: "商品类目状态暂时无法确认，请联系管理员", action: "NONE",
  };
  for (const candidate of [
    { status: "ACTIVE", source: "SOURCE_DIRECT" },
    { ...summary(), raw: "<script>secret</script>" },
    accessor,
    transparent,
    proxy,
  ]) assert.deepEqual(categoryResolutionView(candidate), generic);
  assert.equal(calls, 0);
});
