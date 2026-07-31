# Design QA

## Comparison target

Reference:

- Prototype: `https://ozon-operations-prototype.sl1499008477.chatgpt.site/#/plugin`
- Full data panel: `docs/superpowers/verification/assets/ozon-zongzi-reference-panel.png`
- Full settings state: `docs/superpowers/verification/assets/ozon-zongzi-reference-settings.png`
- Panel component crop: `docs/superpowers/verification/assets/ozon-zongzi-reference-panel-component.png`
- Settings component crop: `docs/superpowers/verification/assets/ozon-zongzi-reference-settings-component.png`

Implementation:

- Active production fixture: `extension/tests/fixtures/data-panel-visual-browser.fixture.html`
- Full data panel: `docs/superpowers/verification/assets/ozon-zongzi-implementation-panel.png`
- Full settings state: `docs/superpowers/verification/assets/ozon-zongzi-implementation-settings.png`
- Panel component crop: `docs/superpowers/verification/assets/ozon-zongzi-implementation-panel-component.png`
- Settings component crop: `docs/superpowers/verification/assets/ozon-zongzi-implementation-settings-component.png`

The screenshot fixture loads the production V2 path from `extension/content/ozon-data-panel.js`, `extension/content/ozon-product.css`, `extension/content/shared-utils.js`, and `extension/lib/sidebar-section-toggle.js`; it does not load `extension/content/ozon-product.js`. A separate PDP DOM regression dynamically loads the real `ozon-product.js` on a synthetic PDP URL. Together they cover both production renderers against the real 32-field catalogue while isolating only the Chrome storage/message boundary; neither test recreates the panel DOM.

## Capture normalization and state

| Surface | Reference pixels | Implementation pixels | CSS viewport/component size | Density | State |
| --- | --- | --- | --- | --- | --- |
| Full data panel | 1280 × 706 | 1280 × 706 | viewport 1280 × 706 | 1× | Production renderer; 353px host width; modal closed |
| Panel component | 353 × 489 | 353 × 489 | both component crops 353 × 489 | 1× | Same visible top region |
| Full settings | 1580 × 871 | 1580 × 871 | viewport 1580 × 871 | 1× | Opened through production gear; all 32 fields; monthly selected |
| Settings component | 956 × 713 | 962 × 609 | natural modal bounds, shown at native scale | 1× | Modal body only |

The reference full screenshots remain byte-for-byte copies of the supplied files. Reference component crops were taken mechanically from those copies. Implementation captures came from real Chrome with `deviceScaleFactor: 1`; no density resampling was used.

## Evidence

- Context comparisons: `docs/superpowers/verification/assets/ozon-zongzi-panel-comparison.png` and `docs/superpowers/verification/assets/ozon-zongzi-settings-comparison.png`.
- Authoritative same-scale input: `docs/superpowers/verification/assets/ozon-zongzi-focused-comparison.html`.
- Authoritative rendered comparison: `docs/superpowers/verification/assets/ozon-zongzi-focused-comparison.png`.

The focused comparison is the judging surface. Panel crops have identical CSS and pixel dimensions. Settings modals are shown at natural 1× scale and top-aligned; neither is scaled to the other.

## Findings

**P0:** none.

**P1:** none in the production fixture after `7a2808d`.

**P2:** none in the production fixture after `7a2808d`.

**P3:** settings density remains intentionally different from the reference. The implementation modal is 962 × 609, 104px shorter than the 956 × 713 reference. This is visible, so the surfaces are not claimed to be pixel-identical. The difference is consistent with the production catalogue having 32 rather than 35 fields and with the approved compact inline period control; all controls remain readable and reachable, so no corrective production change is required.

The two prior actionable findings are resolved:

- Panel composition now follows the approved hierarchy: a shallow-blue real-current-SKU status card, one compact row for monthly sales/listing time/follow-sell count, a separate shallow-blue weight/size summary, then the real 32-field groups. Normal PDP, V2, and list/card entry points call the same overview helper. The reference's mock SKU records were deliberately not copied into production.
- The period control is inline with the summary instead of consuming a standalone field-group row. The desktop modal is now 609px tall, below the 740px acceptance ceiling and 216px shorter than the previous 825px implementation capture. Field groups begin immediately below the summary.

### Required fidelity surfaces

- Fonts and typography: compact sans-serif hierarchy, dark-navy titles, subdued labels, and numeric emphasis are aligned; no clipping was observed.
- Spacing and layout: the approved first-screen hierarchy is present at 353px. Settings use 3/2/1 columns at desktop/tablet/mobile and remain within the desktop-height contract.
- Colors and tokens: white surfaces, pale-blue overview/field fills, `#1268FF` controls, `#10234A` text, green update state, subtle borders, and navy mask treatment remain aligned.
- Image quality and assets: the supplied brand asset is used; no visible target asset is replaced by CSS art, emoji, or a fabricated placeholder.
- Copy/content: production uses `ozon 粽子 · 选品助手`, `插件展示设置`, the actual SKU, and a dynamic 32/32 count. The reference's mock 35-field count and mock SKU list remain intentionally excluded.
- Icons and controls: gear, close, section, checkbox/radio, restore/cancel/finish, and primary-action affordances remain present.
- States/accessibility: loading, ready, partial, error, and locked status contracts remain covered. Native radio/checkbox controls, dialog ARIA, focus loop, Escape close/focus restore, atomic save/retry, pending-save lock, field/period persistence, collapse state, and responsive layouts pass the active Chrome regression.

## Comparison history

1. The original full-frame comparison was invalidated because different component proportions prevented a reliable component-level judgment.
2. A fresh 1× component comparison found the prior P1 panel-composition and P2 modal-density issues.
3. Tests were changed first and proved RED against the old four-card hero and standalone period section.
4. Production commit `7a2808d` introduced the shared overview hierarchy and compact settings layout.
5. Chrome regression turned GREEN, then exact-scale evidence was recaptured. The panel crop is 353 × 489 on both sides; the implementation settings modal is now 962 × 609 at 1×.

## Functional checks

- The previous visual baseline's GUI-capable Chrome fixture passed 2/2. After the latest 32-field contract patch, that CLI suite was not rerun because the session's elevated Chrome-launch quota was exhausted; the sandboxed attempt stopped at browser launch and did not reach assertions.
- A fresh connected-Chrome integration check loaded both the production V2 renderer and an independently dynamic-loaded `ozon-product.js` PDP renderer. RED found V2 missing `discount`, `views`, `stock`, `followMinPrice`, and `canFollow`; GREEN found no missing catalogue fields in either renderer. Both rendered the controlled real-source values `17.25%`, `3456`, `9`, `$8.50`, and `不能`.
- Focused non-GUI regression: 6 passed, 0 failed; UI parity mutation gate: 1 passed, 0 failed.
- Gear-to-settings transition: passed; capture was opened through the production gear.
- Field visibility and monthly/weekly persistence: passed.
- Atomic save failure/retry, duplicate-save lock, cancel, restore, group/all controls: passed.
- Responsive settings grid: 3 columns desktop, 2 columns at 880px, 1 column at 600px.
- Collect/follow-sell/edit-list controls: production DOM contracts present; no external write was invoked.
- Source, distribution, UI, and capture-only diff parity: passed after full CSS fingerprint review.
- Public and dist ZIP tree checks and packaged smoke suites: passed.
- Real logged-in Ozon page: previously opened and inspected by the owning browser task.
- Real installed new-extension acceptance: blocked. Chrome currently has the old `sonliERP` extension loaded. Automated navigation to `chrome://extensions` is denied by browser security policy, so the new unpacked package could not be loaded into the real logged-in profile.
- External side effects: no collection, calculation, follow-sell, listing, or other Ozon write was executed.

## Console errors

- Production fixture capture: none.
- Connected-Chrome field-contract integration: no visible application exception; the CLI regression did not reach browser assertions in this latest round.
- Existing web checks emitted only known Ant Design deprecation warnings; no application exception was observed.

## Verification evidence

- Latest `node --test extension/tests/data-panel-visual-browser.test.js`: not completed. Elevated Chrome launch was denied after the session quota was exhausted; the sandboxed attempt failed during browser launch, before any contract assertion. The prior pre-contract-patch baseline was 2 passed, 0 failed and is not presented as fresh evidence for this patch.
- Fresh connected Chrome: V2 RED missing set was `[discount, views, stock, followMinPrice, canFollow]`; after the patch, V2 and PDP missing sets were both `[]`, with both renderers showing `discount=17.25%`, `views=3456`, `stock=9`, `followMinPrice=$8.50`, and `canFollow=不能`.
- `node --test` focused brand/fallback/copy/logistics/follow-copy/sidebar suite: 6 passed, 0 failed.
- UI parity exception mutation test with the required upstream environment: 1 passed, 0 failed.
- Source parity: passed.
- Distribution parity: passed.
- UI parity: passed after updating the reviewed local CSS fingerprint.
- Capture-only diff contract: passed.
- Public/dist ZIP tree parity: passed, 115 files.
- Public/dist packaged smoke suites: passed.
- Exact capture facts: panel `353 × 1002.75` natural bounds with a `353 × 489` judging crop; settings modal `962 × 609`; all at 1× density.

final result: blocked

Blocker:

1. Fixture-level P0/P1/P2 findings are cleared, but the new unpacked extension still has not been loaded and accepted in the real logged-in Ozon Chrome profile because browser security policy prohibits automated access to `chrome://extensions`. The currently loaded extension is the old `sonliERP` build.
