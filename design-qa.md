# Design QA

## Comparison target

Reference:

- Prototype: `https://ozon-operations-prototype.sl1499008477.chatgpt.site/#/plugin`
- Data panel: `docs/superpowers/verification/assets/ozon-zongzi-reference-panel.png`
- Settings: `docs/superpowers/verification/assets/ozon-zongzi-reference-settings.png`

Implementation:

- Production renderer fixture: `extension/tests/fixtures/data-panel-visual-browser.fixture.html`, loaded in real Chrome at `http://127.0.0.1:9324/extension/tests/fixtures/data-panel-visual-browser.fixture.html`.
- Data panel: `docs/superpowers/verification/assets/ozon-zongzi-implementation-panel.png`
- Settings: `docs/superpowers/verification/assets/ozon-zongzi-implementation-settings.png`

The fixture is not a mock panel: it serves the packaged production `extension/content/ozon-data-panel.js`, `extension/content/ozon-product.css`, `extension/content/shared-utils.js`, and `extension/lib/sidebar-section-toggle.js`, with only the Chrome storage/message boundary isolated. It uses the active, real 32-field catalogue.

## Capture normalization and state

| Surface | Reference pixels | Implementation capture | CSS viewport | Density normalization | State |
| --- | --- | --- | --- | --- | --- |
| Data panel | 1280 × 706 | Chrome capture 2880 × 1589, normalized to 1280 × 706 | 1280 × 706 | Chrome device density was 2.25; downsampled once to match the reference's 1× pixel grid | Default production data fixture; all 32 real fields visible; no modal |
| Settings | 1580 × 871 | Chrome capture 3555 × 1959, normalized to 1580 × 871 | 1580 × 871 | Chrome device density was 2.25; downsampled once to match the reference's 1× pixel grid | Same fixture; settings opened by the visible production gear button; all 32 real fields visible; monthly period selected |

The two source files are byte-for-byte mechanical copies of the supplied reference captures. No source image was edited. The implementation PNGs are browser screenshots, not generated mockups.

## Evidence

- Full-view comparison input: `docs/superpowers/verification/assets/ozon-zongzi-panel-comparison.html`, rendered to `docs/superpowers/verification/assets/ozon-zongzi-panel-comparison.png`.
- Full-view comparison input: `docs/superpowers/verification/assets/ozon-zongzi-settings-comparison.html`, rendered to `docs/superpowers/verification/assets/ozon-zongzi-settings-comparison.png`.
- Focused comparison input (title/brand/gear/metric start and modal header/summary/groups/actions): `docs/superpowers/verification/assets/ozon-zongzi-focused-comparison.html`, rendered to `docs/superpowers/verification/assets/ozon-zongzi-focused-comparison.png`.

Each comparison input places the actual reference and actual browser implementation next to each other. Focused comparison is required because title type, icon treatment, card gutters, checkbox rhythm, and modal controls are too small to judge reliably from the full frames alone.

## Findings

**P0:** none.

**P1:** none.

**P2:** none.

**P3:** none.

### Required fidelity surfaces

- Fonts and typography: both panel and modal retain the compact sans-serif hierarchy, strong dark-navy titles, small secondary status/note text, bold metric values, and non-overflowing Chinese labels. The fixture intentionally displays real no-data values rather than prototype merchandise copy.
- Spacing and layout rhythm: white rounded panel, separated header/metric/group/action regions, pale-blue metric cards, group gutters, rounded field cards, and the centered 960px desktop modal preserve the target's information hierarchy. The fixture's host has no product-page chrome, so host-page geometry was excluded from component fidelity judgment.
- Colors and visual tokens: the visible production panel uses white and pale-blue surfaces, `#1268FF` actions/icons, `#10234A` foreground, green update state, pale borders, and the navy translucent modal mask. Those token roles match the intended prototype language.
- Image quality and assets: the production brand symbol is the generated supplied brand asset; no visual target logo, illustration, or non-standard icon was replaced with CSS art, text glyphs, or handcrafted SVG. Logo fallback keeps readable product text and hides the failed image.
- Copy and content: `ozon 粽子 · 选品助手`, `插件展示设置`, group names, actions, and period labels are production copy. The 32/32 count reflects the real catalogue and deliberately does not copy the reference mock's 35 fields.
- Icons and affordances: the visible gear, close, section disclosure, checked native controls, restore/cancel/finish controls, primary blue action, hover/focus contracts, and compact status affordance are present. The gear opened the actual production settings DOM in Chrome.
- States, responsiveness, and accessibility: the active browser test covers 3/2/1 modal columns at 1280/880/600-width states, visible native checkbox/radio semantics, group/all controls, cancel, restore, atomic save/retry, disabled while save is pending, persisted visibility/period, hidden-field application, logo error fallback, collapsed sections, and legacy card control contrast. The full GUI test could not complete in this sandbox (see Functional checks), so these state assertions are not claimed as a fresh end-to-end pass here.

### Accepted, non-actionable scope differences

The supplied reference is a complete prototype product page and contains mock merchandise plus 35 mock fields. The implementation evidence is the production renderer isolated in its active fixture and contains only real fields/data. Its host-page background, real field count (32), no-data content, and resulting group-card height differ by design; copying the prototype's host or mock fields would violate the agreed production contract. These are not P0/P1/P2 visual findings.

## Comparison history

1. Initial full and focused comparison on the normalized browser captures: no actionable P0/P1/P2 difference was found in the in-scope panel and settings component surfaces. Therefore no visual fix/re-capture iteration was required.

## Functional checks

- Brand asset regeneration and extension packaging: passed.
- Extension source parity, UI parity, diff contract, release-tree/ZIP parity, and ZIP smoke: passed against `QH_SOURCE_EXTENSION_DIR=/Users/songliang/Desktop/0.13.46.1`.
- Chrome production fixture panel and gear-to-settings transition: passed manually; the settings modal was opened from the visible production gear control.
- Field visibility persisted: not freshly confirmed end-to-end in the restricted Chrome session; covered by the active browser fixture contract, which requires GUI execution.
- Monthly/weekly period persisted: not freshly confirmed end-to-end in the restricted Chrome session; covered by the active browser fixture contract, which requires GUI execution.
- Collect action preserved: DOM control present in the production renderer; no external collection action was invoked.
- Calculation/edit action preserved: DOM control present in the production renderer; no external action was invoked.
- Account/session state preserved: not verified in an authenticated local Web/API environment.
- Web browser check from this worktree's real Vite build (`127.0.0.1:5174`): `/login` rendered the `ozon 粽子` image and page title. `/ozon/dashboard`, `/datascreen`, and `/extension/` rendered `ozon 粽子` titles but stayed in the unauthenticated login-check state because this independently started frontend had no local API session. `/datascreen` title was `ozon 粽子 · 订单数据大屏`.
- Real Ozon product/installed-extension acceptance: blocked. A live Ozon product tab was visible in Chrome but was already controlled by another browser task, so it was not safely claimed or operated. No real collect, calculation, follow-sell, or other external write was performed.

## Console errors

- Production renderer fixture: no browser console errors.
- Web Vite check: no application exception; Chrome recorded pre-existing Ant Design deprecation warnings for `ConfigProvider.autoInsertSpaceInButton`, `Dropdown.overlayClassName`, and `Drawer.width` (the earlier unrelated 3000 server also recorded `Alert.message`).

## Verification result

`QH_SOURCE_EXTENSION_DIR=/Users/songliang/Desktop/0.13.46.1 node scripts/verify.mjs` completed all package/parity/smoke/gate checks. The complete active suite reported 345 tests: 344 passed and 1 failed. The sole failure was `extension/tests/data-panel-visual-browser.test.js` because sandbox-launched headless Chrome closed immediately after launch; its cleanup regression passed. This is a GUI execution-environment blocker, not a test assertion failure.

final result: blocked

Blocker: the task requires a fresh, safely controllable real logged-in Ozon page with the packaged extension and a GUI-capable run of the active Chrome fixture. This session supplied real-Chrome fixture evidence but could not safely take over the already-controlled Ozon product tab, and the sandbox prevented the CLI fixture Chrome from staying open. Re-run the active fixture and the real-Ozon interaction checks in the GUI-permitted owning browser session before changing the final result to `passed`.
