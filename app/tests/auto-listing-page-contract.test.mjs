import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const page = await readFile(new URL("../src/AutoListingPage.jsx", import.meta.url), "utf8").catch(() => "");
const css = await readFile(new URL("../src/auto-listing-page.css", import.meta.url), "utf8").catch(() => "");
const app = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8").catch(() => "");

test("automatic listing page owns the complete review-mode ordinary-user workflow", () => {
  for (const required of [
    "自动上架",
    "采集箱推送",
    "Excel SKU",
    "上架店铺",
    "活跃 FBS 仓库",
    "上架库存",
    "售价加减",
    "图片比例",
    "图片数量",
    "图片语言",
    "图片分辨率",
    "图片质量",
    "主图",
    "卖点图",
    "细节图",
    "场景图",
    "尺寸图",
    "信息图",
    "任务进度",
    "生成结果审核",
    "重新生成",
    "重试",
    "查看失败行",
    "重试失败行",
    "取消任务",
  ]) assert.match(page, new RegExp(required));
});

test("page uses focused pure models and stable backend routes without direct Ozon writes", () => {
  assert.match(page, /from "\.\/auto-listing-config\.js"/);
  assert.match(page, /from "\.\/auto-listing-view\.js"/);
  assert.match(page, /from "\.\/client-transport\.js"/);
  assert.match(page, /\/auto-listing\/preferences/);
  assert.match(page, /\/auto-listing\/imports\/excel/);
  assert.match(page, /`\/auto-listing\/imports\/\$\{encodeURIComponent\(item\.id\)\}`/);
  assert.match(page, /`\/auto-listing\/imports\/\$\{encodeURIComponent\(importDetail\.id\)\}\/retry`/);
  assert.match(page, /\/auto-listing\/jobs\/from-collect-box/);
  assert.match(page, /\/auto-listing\/items\//);
  assert.doesNotMatch(page, /callOzonSellerApi|\/v[123]\/product\/import|api[_-]?key|prompt/i);
});

test("Excel UI uses server-provided byte and row limits instead of fixed upload policy", () => {
  assert.match(page, /const \[excelLimits, setExcelLimits\] = useState/);
  assert.match(page, /maxBytes:\s*excelLimits\.maxBytes/);
  assert.match(page, /excelLimits\.maxRows/);
  assert.match(page, /maxSerializedBodyBytes: autoListingExcelSerializedBodyLimit\(excelLimits\.maxBytes\)/);
  assert.doesNotMatch(page, /最大 2 MB/);
});

test("closing or replacing import detail invalidates late responses", () => {
  assert.match(page, /const importDetailRequestRef = useRef\(0\)/);
  assert.match(page, /const requestVersion = \+\+importDetailRequestRef\.current/);
  assert.match(page, /requestVersion !== importDetailRequestRef\.current/);
  assert.match(page, /const closeImportDetail = \(\) => \{[\s\S]*importDetailRequestRef\.current \+= 1/);
  assert.match(page, /onClose=\{closeImportDetail\}/);
});

test("preference save sends the backend version and idempotency contract and keeps the returned version", () => {
  assert.match(page, /const \[preferenceVersion, setPreferenceVersion\] = useState\(0\)/);
  assert.match(page, /expectedVersion:\s*intent\.expectedPreferenceVersion/);
  assert.match(page, /idempotencyKey:\s*intent\.preferenceIdempotencyKey/);
  assert.match(page, /correlationId/);
  assert.match(page, /setPreferenceVersion\(savedPreference\?\.data\?\.configVersion\)/);
  assert.doesNotMatch(page, /String\(Number\(preference\.priceAdjustmentKopecks\) \/ 100\)/);
});

test("item commands carry the owning job and exact status version instead of trusting stale UI state", () => {
  assert.match(page, /jobId:\s*row\.jobId/);
  assert.match(page, /expectedStatusVersion:\s*row\.statusVersion/);
  assert.match(page, /performAction\(row,\s*"regenerate"\)/);
  assert.match(page, /performAction\(row,\s*"approve"\)/);
  assert.match(page, /performAction\(row,\s*"retry"\)/);
  assert.match(page, /performAction\(row,\s*"cancel"\)/);
  assert.match(page, /const \[actionItemId, setActionItemId\] = useState\(""\)/);
  assert.match(page, /loading=\{actionItemId === row\.itemId\}/);
  assert.match(page, /disabled=\{Boolean\(actionItemId\)\}/);
  assert.match(page, /caught\?\.status === 409/);
  assert.match(page, /await loadData\(\)/);
  assert.match(page, /商品状态已变化，请查看刷新后的任务状态/);
});

test("review approval shows the frozen upload summary before invoking the approval command", () => {
  assert.match(page, /Modal\.confirm/);
  assert.match(page, /确认上传到 Ozon/);
  for (const field of [
    "storeLabel", "warehouseLabel", "stock", "finalPriceKopecks", "variantCount", "images.length",
  ]) assert.match(page, new RegExp(field.replace(".", "\\.")));
  assert.match(page, /performAction\(row,\s*"approve"\)/);
});

test("late list and review responses cannot overwrite the newest visible request", () => {
  assert.match(page, /useRef/);
  assert.match(page, /loadRequestRef\.current/);
  assert.match(page, /reviewRequestRef\.current/);
  assert.match(page, /if \(requestVersion !== loadRequestRef\.current\) return/);
  assert.match(page, /if \(requestVersion !== reviewRequestRef\.current\) return/);
  assert.match(page, /setReview\(null\)/);
  assert.match(page, /reviewLoading/);
});

test("background local-state polling cannot overwrite an in-progress auto-listing form", () => {
  assert.match(page, /const hydratedAccountRef = useRef/);
  assert.match(page, /hydratedAccountRef\.current !== accountId/);
  assert.doesNotMatch(page, /\}, \[form, stores\]\)/);
});

test("an ambiguous task-creation retry reuses one intent and idempotency identity", () => {
  assert.match(page, /const createIntentRef = useRef/);
  assert.match(page, /const createInFlightRef = useRef/);
  assert.match(page, /expectedPreferenceVersion/);
  assert.match(page, /createIntentRef\.current = null/);
  assert.match(page, /if \(createInFlightRef\.current\) return/);
});

test("a confirmed task is never resubmitted when only the follow-up refresh fails", () => {
  assert.match(page, /const \[notice, setNotice\] = useState\(""\)/);
  assert.match(page, /createIntentRef\.current = null;[\s\S]*setNotice\("任务已创建"\)/);
  assert.match(page, /let refreshed = await loadData\(\)/);
  assert.match(page, /任务已创建，但列表刷新失败，请手动刷新/);
  assert.match(page, /notice \? <Alert type="success"/);
});

test("review visibly separates the source product image from generated visual groups", () => {
  assert.match(page, /review\.source\?\.thumbnailUrl/);
  assert.match(page, /采集来源图片/);
  assert.match(page, /review\.visualGroups/);
  assert.match(page, /image\.visualGroupKey === group\.key/);
});

test("ordinary-user page contains no gateway, model, strategy, or key controls", () => {
  for (const forbidden of ["网关", "模型路由", "策略版本", "API Key", "提示词"]) {
    assert.doesNotMatch(page, new RegExp(forbidden, "i"));
  }
  assert.match(page, /按当前上传策略处理/);
  assert.doesNotMatch(page, /先审核后上传/);
  assert.doesNotMatch(page, />\s*直接上传\s*</);
});

test("page describes immutable and configurable fields accurately and keys Excel intent by content", () => {
  assert.match(page, /类目、属性、SKU、重量、尺寸等商品底稿保持不变/);
  assert.doesNotMatch(page, /其他商品资料保持来源数据不变/);
  assert.match(page, /contentSha256/);
  assert.match(page, /const \{ contentSha256, \.\.\.uploadFile \} = excelFile/);
  assert.doesNotMatch(page, /name:\s*workbook\.name,\s*size:\s*workbook\.size,\s*lastModified/u);
});

test("responsive styles keep cards and generated images usable on narrow screens", () => {
  assert.match(css, /\.auto-listing-page/);
  assert.match(css, /@media\s*\(max-width:\s*768px\)/);
  assert.match(css, /grid-template-columns/);
  assert.match(css, /object-fit:\s*contain/);
  assert.match(css, /overflow-wrap:\s*anywhere/);
});

test("App wires one AI-tools route and collect-box navigation without duplicating task creation", () => {
  assert.match(app, /import AutoListingPage from "\.\/AutoListingPage\.jsx"/);
  assert.match(app, /"\/ozon\/tools\/auto-listing": "自动上架"/);
  assert.match(app, /key: "\/ozon\/tools\/auto-listing", label: "自动上架"/);
  assert.match(app, /route === "\/ozon\/tools\/auto-listing"/);
  assert.match(app, /推送到自动上架/);
  assert.match(app, /buildAutoListingCollectPush/);
  const collectPage = app.slice(app.indexOf("function CollectPage"), app.indexOf("function ImportHistoryPage"));
  assert.doesNotMatch(collectPage, /\/auto-listing\/jobs\/from-collect-box|\/auto-listing\/imports\/excel/);
});

test("automatic listing shows the AI model settings entry only to administrators", () => {
  assert.match(page, /navigate\s*=\s*\(\)\s*=>\s*\{\}/);
  assert.match(page, /account\?\.role === "admin"/);
  assert.match(page, /navigate\("\/ozon\/tools\/auto-listing\/ai-settings"\)/);
  assert.match(page, /AI 模型配置/);
});
