### Task 1: Establish the pre-change baseline and global design tokens

**Files:**
- Create: `app/tests/prototype-style-contract.test.mjs`
- Modify: `app/src/App.jsx:1180-1230`
- Modify: `app/src/styles.css:1-20`

**Interfaces:**
- Consumes: the existing `themeConfig` object and root stylesheet.
- Produces: CSS custom properties `--prototype-page-bg`, `--prototype-surface`, `--prototype-surface-muted`, `--prototype-primary`, `--prototype-primary-hover`, `--prototype-primary-soft`, `--prototype-ink`, `--prototype-ink-secondary`, `--prototype-ink-light`, `--prototype-border`, `--prototype-border-strong`, `--prototype-success`, `--prototype-warning`, `--prototype-danger`, `--prototype-purple`, and `--prototype-shadow`.

- [ ] **Step 1: Record the narrow baseline**

Run:

```bash
git status --short --branch
git diff -- app/src/App.jsx app/src/styles.css
pnpm --dir app build
```

Expected: the existing user changes are recorded; the build result is saved as the pre-change baseline. Do not repair unrelated baseline failures.

- [ ] **Step 2: Write the failing token contract**

Create `app/tests/prototype-style-contract.test.mjs` with:

```js
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
    assert.match(normalized, new RegExp(`${name}:\\\\s*${value.replace("#", "\\\\#")}`), name);
  }
});

test("maps Ant Design to the approved prototype palette", () => {
  assert.match(appSource, /colorPrimary:\s*"#005af8"/);
  assert.match(appSource, /colorText:\s*"#071737"/);
  assert.match(appSource, /colorBorder:\s*"#dce8f7"/);
  assert.match(appSource, /borderRadiusLG:\s*18/);
});
```

- [ ] **Step 3: Run the contract and verify the intended failure**

Run:

```bash
node --test app/tests/prototype-style-contract.test.mjs
```

Expected: FAIL because the prototype token names and approved Ant Design values do not yet exist.

- [ ] **Step 4: Add the exact global token block**

At the start of `app/src/styles.css`, extend `:root` with:

```css
  --prototype-page-bg: #f6fafe;
  --prototype-surface: #ffffff;
  --prototype-surface-muted: #f7fafe;
  --prototype-primary: #005af8;
  --prototype-primary-hover: #004fe0;
  --prototype-primary-soft: #eef5ff;
  --prototype-ink: #071737;
  --prototype-ink-secondary: #65718a;
  --prototype-ink-light: #8c98ac;
  --prototype-border: #dce8f7;
  --prototype-border-strong: #cbdcf2;
  --prototype-success: #14994a;
  --prototype-warning: #b76708;
  --prototype-danger: #d93632;
  --prototype-purple: #6c4de6;
  --prototype-shadow: 0 12px 38px rgba(24, 79, 151, 0.06),
    0 1px 2px rgba(24, 79, 151, 0.04);
```

Use the approved font stack in the same `:root` rule:

```css
font-family:
  Inter, "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC",
  system-ui, -apple-system, sans-serif;
```

- [ ] **Step 5: Map the existing Ant Design theme**

In `themeConfig.token`, set:

```js
colorPrimary: "#005af8",
colorPrimaryHover: "#004fe0",
colorText: "#071737",
colorTextSecondary: "#65718a",
colorBorder: "#dce8f7",
colorBgLayout: "#f6fafe",
colorBgContainer: "#ffffff",
borderRadius: 12,
borderRadiusLG: 18,
boxShadowSecondary: "0 12px 38px rgba(24, 79, 151, 0.08)",
```

Update existing component tokens to use 18px card rounding and 12px control rounding without changing component behavior.

- [ ] **Step 6: Verify and checkpoint**

Run:

```bash
node --test app/tests/prototype-style-contract.test.mjs
pnpm --dir app build
git diff --check -- app/src/App.jsx app/src/styles.css app/tests/prototype-style-contract.test.mjs
git diff --stat -- app/src/App.jsx app/src/styles.css app/tests/prototype-style-contract.test.mjs
```

Expected: token contract PASS, build matches or improves on the baseline, and diff check reports no whitespace errors.

---
