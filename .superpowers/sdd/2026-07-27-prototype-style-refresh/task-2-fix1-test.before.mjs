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
