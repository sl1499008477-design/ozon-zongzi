import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const appSource = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
const cssSource = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

const requiredTokens = new Map([
  ["--prototype-page-bg", "#f6fafe"],
  ["--prototype-surface", "#ffffff"],
  ["--prototype-surface-muted", "#f7fafe"],
  ["--prototype-primary", "#005af8"],
  ["--prototype-primary-hover", "#004fe0"],
  ["--prototype-primary-soft", "#eef5ff"],
  ["--prototype-ink", "#071737"],
  ["--prototype-ink-secondary", "#65718a"],
  ["--prototype-ink-light", "#8c98ac"],
  ["--prototype-border", "#dce8f7"],
  ["--prototype-border-strong", "#cbdcf2"],
  ["--prototype-success", "#14994a"],
  ["--prototype-warning", "#b76708"],
  ["--prototype-danger", "#d93632"],
  ["--prototype-purple", "#6c4de6"],
]);

test("declares the approved prototype token values", () => {
  const normalized = cssSource.toLowerCase();
  for (const [name, value] of requiredTokens) {
    assert.match(normalized, new RegExp(`${name}:\\s*${value.replace("#", "\\#")}`), name);
  }
});

test("maps Ant Design to the approved prototype palette", () => {
  assert.match(appSource, /colorPrimary:\s*"#005af8"/);
  assert.match(appSource, /colorText:\s*"#071737"/);
  assert.match(appSource, /colorBorder:\s*"#dce8f7"/);
  assert.match(appSource, /borderRadiusLG:\s*18/);
});

test("scopes the visual refresh to the authenticated application shell", () => {
  assert.match(appSource, /className="qh-shell prototype-shell"/);
  assert.match(appSource, /className="prototype-eyebrow"/);
  assert.match(appSource, /OZON SELLER WORKSPACE/);
});

test("defines the prototype application shell selectors", () => {
  for (const selector of [
    ".prototype-shell",
    ".prototype-shell .qh-sider",
    ".prototype-shell .qh-topbar",
    ".prototype-shell .qh-content",
    ".prototype-shell .qh-sider .ant-menu-item-selected",
  ]) {
    assert.ok(cssSource.includes(selector), selector);
  }
});

test("keeps the scoped prototype shell usable at narrow breakpoints", () => {
  const overrides = cssSource.slice(cssSource.indexOf("/* Prototype shell overrides */"));
  const mediaBlock = (maxWidth) => {
    const marker = `@media (max-width: ${maxWidth}px)`;
    const start = overrides.indexOf(marker);
    assert.notEqual(start, -1, marker);
    const openBrace = overrides.indexOf("{", start);
    let depth = 0;
    for (let index = openBrace; index < overrides.length; index += 1) {
      if (overrides[index] === "{") depth += 1;
      if (overrides[index] === "}") depth -= 1;
      if (depth === 0) return overrides.slice(start, index + 1);
    }
    assert.fail(`unterminated ${marker}`);
  };

  const desktopCompact = mediaBlock(1180);
  const tablet = mediaBlock(800);
  const mobile = mediaBlock(600);
  for (const [block, rule] of [
    [desktopCompact, ".prototype-shell .qh-topbar {\n    inset: 24px 24px auto 112px;"],
    [desktopCompact, ".prototype-shell .qh-content {\n    margin-left: 112px;"],
    [tablet, ".prototype-shell .qh-content {\n    margin-left: 112px;\n    padding: 92px 12px 28px 0;"],
    [tablet, ".prototype-shell .qh-page-head h1 {\n    font-size: 24px;"],
    [mobile, ".prototype-shell .qh-topbar {\n    inset: 12px 12px auto 12px;"],
    [mobile, ".prototype-shell .qh-content {\n    margin-left: 0;\n    padding: 80px 12px 28px;"],
  ]) {
    assert.ok(block.includes(rule), rule);
  }
});

test("styles shared controls and data surfaces inside the prototype scope", () => {
  for (const selector of [
    ".prototype-shell .ant-btn",
    ".prototype-shell .ant-input",
    ".prototype-shell .ant-select-selector",
    ".prototype-shell .ant-card",
    ".prototype-shell .source-table .ant-table",
    ".prototype-shell .ant-table-thead > tr > th",
    ".prototype-overlay .ant-modal-content",
    ".prototype-overlay .ant-drawer-content",
    ".sonli-login-card",
  ]) {
    assert.ok(cssSource.includes(selector), selector);
  }
});

test("styles portal popup surfaces through the prototype overlay scope", () => {
  for (const selector of [
    ".prototype-overlay .ant-dropdown-menu",
    ".prototype-overlay .ant-popover-inner",
    ".prototype-overlay .ant-tooltip-inner",
  ]) {
    assert.ok(cssSource.includes(selector), selector);
  }
});

test("scopes the binding modal and plugin drawer as prototype overlays", () => {
  const bindingModalStart = appSource.indexOf('title={isEditingBindingStore ? "修改 API 授权门店"');
  const bindingModal = appSource.slice(bindingModalStart, appSource.indexOf("</Modal>", bindingModalStart));
  const pluginDrawerStart = appSource.indexOf('<Drawer\n        title="浏览器插件"');
  const pluginDrawer = appSource.slice(pluginDrawerStart, appSource.indexOf("</Drawer>", pluginDrawerStart));

  assert.match(bindingModal, /rootClassName="prototype-overlay"/);
  assert.match(pluginDrawer, /rootClassName="prototype-overlay"/);
});

test("marks application popup portals as prototype overlays", () => {
  assert.match(appSource, /overlayClassName="topbar-overlay store-topbar-overlay prototype-overlay"/);
  assert.match(appSource, /overlayClassName="topbar-overlay user-topbar-overlay prototype-overlay"/);

  const tooltipCount = (appSource.match(/<Tooltip\b/g) || []).length;
  const prototypeTooltipCount = (
    appSource.match(/<Tooltip\b[^>]*rootClassName="prototype-overlay"/g) || []
  ).length;
  assert.equal(prototypeTooltipCount, tooltipCount);
});
