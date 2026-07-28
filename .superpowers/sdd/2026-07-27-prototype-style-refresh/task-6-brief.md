### Task 6: Add accessible mobile navigation and responsive safeguards

**Files:**
- Modify: `app/tests/prototype-style-contract.test.mjs`
- Modify: `app/src/App.jsx:29-65`
- Modify: `app/src/App.jsx:785-870`
- Modify: `app/src/App.jsx:1303-1395`
- Modify: `app/src/styles.css:4490-4691`
- Modify: `app/src/styles.css` final override section

**Interfaces:**
- Consumes: existing `menuItems`, `route`, `openKeys`, `setOpenKeys`, and `navigate`.
- Produces: `mobileNavOpen`, `.prototype-mobile-menu-trigger`, `.prototype-mobile-nav`, and page-contained overflow behavior.

- [ ] **Step 1: Add the failing mobile contract**

Append:

```js
test("provides mobile navigation and contained overflow", () => {
  assert.match(appSource, /mobileNavOpen/);
  assert.match(appSource, /prototype-mobile-menu-trigger/);
  assert.match(appSource, /prototype-mobile-nav/);
  assert.match(cssSource, /@media \(max-width: 600px\)/);
  assert.match(cssSource, /\.prototype-shell \.source-table-wrap[\s\S]*overflow-x:\s*auto/);
  assert.match(cssSource, /\.prototype-shell[\s\S]*overflow-x:\s*clip/);
});
```

- [ ] **Step 2: Verify the mobile contract fails**

Run `node --test app/tests/prototype-style-contract.test.mjs`.

Expected: new mobile assertions FAIL.

- [ ] **Step 3: Add mobile navigation using existing Ant Design components**

Import `MenuOutlined` from `@ant-design/icons`.

Add state:

```js
const [mobileNavOpen, setMobileNavOpen] = useState(false);
```

Add a header button:

```jsx
<Button
  aria-label="打开导航"
  className="prototype-mobile-menu-trigger"
  icon={<MenuOutlined />}
  onClick={() => setMobileNavOpen(true)}
  type="text"
/>
```

Add a Drawer beside the existing plugin Drawer:

```jsx
<Drawer
  className="prototype-mobile-nav"
  open={mobileNavOpen}
  onClose={() => setMobileNavOpen(false)}
  placement="left"
  rootClassName="prototype-overlay"
  title="sonli · Ozon 运营台"
  width={288}
>
  <Menu
    mode="inline"
    selectedKeys={[route]}
    openKeys={openKeys}
    onOpenChange={setOpenKeys}
    items={menuItems}
    onClick={({ key }) => {
      setMobileNavOpen(false);
      navigate(key);
    }}
  />
</Drawer>
```

- [ ] **Step 4: Add breakpoint rules**

At 1180px, reduce the desktop sidebar to 76px and hide menu labels without changing route selection. At 800px, convert multi-column cards and forms to one column. At 600px:

```css
.prototype-shell .qh-sider {
  display: none;
}

.prototype-shell .qh-topbar {
  inset: 12px 12px auto;
}

.prototype-shell .qh-content {
  margin-left: 0;
  padding: 92px 12px 32px;
}

.prototype-mobile-menu-trigger {
  display: inline-flex;
}

.prototype-shell .source-table-wrap {
  max-width: 100%;
  overflow-x: auto;
}
```

Above 600px, `.prototype-mobile-menu-trigger` must be `display: none`.

- [ ] **Step 5: Verify and checkpoint**

Run:

```bash
node --test app/tests/prototype-style-contract.test.mjs
pnpm --dir app build
git diff --check -- app/src/App.jsx app/src/styles.css app/tests/prototype-style-contract.test.mjs
```

Expected: PASS.

---
