import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const appSource = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
const dataScreenSource = readFileSync(new URL("../src/DataScreenPage.jsx", import.meta.url), "utf8");
const cssSource = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

const cssLeafRules = (source) => {
  const rules = [];
  const stack = [];
  let segmentStart = 0;

  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "{") {
      if (stack.length) stack[stack.length - 1].hasNestedRule = true;
      stack.push({
        selectors: source.slice(segmentStart, index).trim(),
        declarationStart: index + 1,
        hasNestedRule: false,
      });
      segmentStart = index + 1;
    }
    if (source[index] === "}") {
      const rule = stack.pop();
      if (rule && !rule.hasNestedRule && !rule.selectors.startsWith("@")) {
        rules.push({
          selectors: rule.selectors,
          declarations: source.slice(rule.declarationStart, index),
        });
      }
      segmentStart = index + 1;
    }
  }

  return rules;
};

const isScopedMetricValueSelector = (selector) => {
  return selector.includes(".prototype-shell") &&
    /\.metric-card\b[\s\S]*?(?:\s|>|\+|~)\s*strong\b/.test(selector);
};

const assertMetricValueSelectorsHaveNoMinHeight = (source) => {
  for (const { selectors, declarations } of cssLeafRules(source)) {
    for (const selector of selectors.split(",")) {
      if (isScopedMetricValueSelector(selector)) {
        assert.doesNotMatch(declarations, /\bmin-height\s*:/, `${selector.trim()} must not declare min-height`);
      }
    }
  }
};

const jsxOpeningTags = (source, tagName) => {
  const tags = [];
  const marker = `<${tagName}`;
  let searchFrom = 0;

  while (true) {
    const start = source.indexOf(marker, searchFrom);
    if (start === -1) return tags;
    let braceDepth = 0;
    let quote = "";

    for (let index = start + marker.length; index < source.length; index += 1) {
      const char = source[index];
      const previous = source[index - 1];
      if (quote) {
        if (char === quote && previous !== "\\") quote = "";
        continue;
      }
      if (char === '"' || char === "'" || char === "`") {
        quote = char;
        continue;
      }
      if (char === "{") braceDepth += 1;
      if (char === "}") braceDepth -= 1;
      if (char === ">" && braceDepth === 0) {
        tags.push(source.slice(start, index + 1));
        searchFrom = index + 1;
        break;
      }
    }
  }
};

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
    [mobile, ".prototype-shell .qh-content {\n    margin-left: 0;\n    padding: 92px 12px 32px;"],
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
    ".prototype-overlay.ant-modal-root .ant-modal .ant-modal-container",
    ".prototype-overlay.ant-drawer .ant-drawer-section",
    ".sonli-login-card",
  ]) {
    assert.ok(cssSource.includes(selector), selector);
  }
  assert.match(cssSource, /border:\s*1px solid var\(--prototype-border\) !important/);
  assert.match(cssSource, /box-shadow:\s*0 22px 60px rgba\(10, 36, 78, 0\.18\) !important/);
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

test("scopes every application modal and drawer portal as a prototype overlay", () => {
  for (const tagName of ["Modal", "Drawer"]) {
    const tags = jsxOpeningTags(appSource, tagName);
    assert.ok(tags.length > 0, tagName);
    for (const tag of tags) {
      assert.match(tag, /rootClassName="prototype-overlay"/, tag);
    }
  }
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

test("defines dashboard and data-screen visual contracts", () => {
  assert.match(dataScreenSource, /className="datascreen-page prototype-datascreen"/);
  for (const selector of [
    ".prototype-shell .metric-grid",
    ".prototype-shell .metric-card",
    ".prototype-shell .dashboard-main-grid",
    ".prototype-shell .panel-card",
    ".prototype-shell .quick-actions",
    ".prototype-datascreen",
  ]) {
    assert.ok(cssSource.includes(selector), selector);
  }
});

test("rejects min-height in every scoped metric value selector", () => {
  assertMetricValueSelectorsHaveNoMinHeight(cssSource);

  for (const dangerousCss of [
    ".prototype-shell .metric-card.compact strong { min-height: 112px; }",
    ".prototype-shell .metric-card.compact strong, .prototype-shell .metric-card.compact { min-height: 112px; }",
    "@media (max-width: 800px) { .prototype-shell .metric-card strong { min-height: 112px; } }",
  ]) {
    assert.throws(
      () => assertMetricValueSelectorsHaveNoMinHeight(dangerousCss),
      /min-height/,
    );
  }
});

test("covers every shared operational page family", () => {
  for (const selector of [
    ".prototype-shell .source-page",
    ".prototype-shell .source-section-title",
    ".prototype-shell .source-card",
    ".prototype-shell .source-query-grid",
    ".prototype-shell .source-status-tabs",
    ".prototype-shell .product-status-filters",
    ".prototype-shell .profit-main-grid",
    ".prototype-shell .pricing-settings-layout",
    ".prototype-shell .stores-settings-page",
    ".prototype-shell .collect-edit-body",
    ".prototype-shell .source-404-page",
  ]) {
    assert.ok(cssSource.includes(selector), selector);
  }
});

test("covers gated AI and category-analysis surfaces with accessible state colors", () => {
  for (const selector of [
    ".prototype-shell .ai-image-gated-page",
    ".prototype-shell .ai-image-gated-content",
    ".prototype-shell .category-tabs",
    ".prototype-shell .category-filter-grid",
    ".prototype-shell .stat-strip",
  ]) {
    assert.ok(cssSource.includes(selector), selector);
  }

  assert.ok(
    cssSource.includes("background: color-mix(in srgb, var(--prototype-success) 70%, var(--prototype-ink));"),
    "success state uses the contrast-safe derived background",
  );
  assert.ok(
    cssSource.includes("color: color-mix(in srgb, var(--prototype-warning) 70%, var(--prototype-ink)) !important;"),
    "warning action uses the contrast-safe derived foreground",
  );
  assert.ok(!cssSource.includes(".prototype-shell .collect-edit-attribute-row"));
  assert.ok(!cssSource.includes(".prototype-shell .stores-control-row"));
});

test("provides an accessible mobile navigation drawer with contained overflow", () => {
  const triggerStart = appSource.indexOf('className="prototype-mobile-menu-trigger"');
  const triggerEnd = appSource.indexOf('type="text"', triggerStart) + 'type="text"'.length;
  const trigger = appSource.slice(appSource.lastIndexOf("<Button", triggerStart), triggerEnd);
  const drawerStart = appSource.indexOf('className="prototype-mobile-nav"');
  const drawer = appSource.slice(appSource.lastIndexOf("<Drawer", drawerStart), appSource.indexOf("</Drawer>", drawerStart));

  assert.notEqual(triggerStart, -1, "mobile menu trigger");
  assert.match(trigger, /aria-label="打开导航"/);
  assert.match(trigger, /onClick=\{\(\) => setMobileNavOpen\(true\)\}/);
  assert.match(trigger, /icon=\{<MenuOutlined \/>\}/);
  assert.match(appSource, /const \[mobileNavOpen, setMobileNavOpen\] = useState\(false\)/);

  assert.notEqual(drawerStart, -1, "mobile navigation drawer");
  assert.match(drawer, /open=\{mobileNavOpen\}/);
  assert.match(drawer, /onClose=\{\(\) => setMobileNavOpen\(false\)\}/);
  assert.match(drawer, /rootClassName="prototype-overlay"/);
  assert.match(drawer, /selectedKeys=\{\[route\]\}/);
  assert.match(drawer, /openKeys=\{openKeys\}/);
  assert.match(drawer, /onOpenChange=\{setOpenKeys\}/);
  assert.match(drawer, /items=\{menuItems\}/);
  assert.match(drawer, /setMobileNavOpen\(false\);\s*navigate\(key\);/);
  assert.match(appSource, /window\.matchMedia\("\(max-width: 600px\)"\)/);
  assert.match(appSource, /if \(!event\.matches\) setMobileNavOpen\(false\)/);
  assert.match(appSource, /addEventListener\("change", handleMobileViewportChange\)/);
  assert.match(appSource, /removeEventListener\("change", handleMobileViewportChange\)/);

  const overrides = cssSource.slice(cssSource.indexOf("/* Prototype shell overrides */"));
  const breakpointBlock = (maxWidth) => {
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

  const compactDesktop = breakpointBlock(1180);
  const tablet = breakpointBlock(800);
  const mobile = breakpointBlock(600);
  assert.match(compactDesktop, /\.prototype-shell \.qh-sider\s*\{[\s\S]*width:\s*76px !important/);
  assert.match(compactDesktop, /\.prototype-shell \.qh-content\s*\{[\s\S]*margin-left:\s*112px/);
  assert.match(tablet, /\.prototype-shell \.source-query-grid[\s\S]*grid-template-columns:\s*1fr/);
  assert.match(tablet, /\.prototype-shell \.pricing-default-grid[\s\S]*grid-template-columns:\s*1fr/);
  assert.match(tablet, /\.prototype-shell \.pricing-domestic-list > div[\s\S]*grid-template-columns:\s*1fr/);
  assert.match(tablet, /\.prototype-shell \.pricing-simulation-result[\s\S]*grid-template-columns:\s*1fr/);
  assert.match(mobile, /\.prototype-shell \.qh-sider\s*\{[\s\S]*display:\s*none/);
  assert.match(mobile, /\.prototype-mobile-menu-trigger\s*\{[\s\S]*display:\s*inline-flex/);
  assert.match(mobile, /\.prototype-shell \.source-table-wrap\s*\{[\s\S]*overflow-x:\s*auto/);
  assert.match(overrides, /\.prototype-mobile-menu-trigger\s*\{[\s\S]*display:\s*none/);
  assert.match(overrides, /\.prototype-shell\s*\{[\s\S]*overflow-x:\s*clip/);
  assert.match(overrides, /\.prototype-overlay \.prototype-mobile-nav \.ant-drawer-body/);
});
