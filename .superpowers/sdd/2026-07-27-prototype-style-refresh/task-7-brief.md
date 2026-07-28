### Task 7: Run route regression and blocking visual QA

**Files:**
- Modify: `design-qa.md`

**Interfaces:**
- Consumes: the completed app build and the approved source prototype.
- Produces: evidence that desktop, intermediate, and mobile views preserve interactions and pass same-viewport visual comparison.

- [ ] **Step 1: Run automated verification**

Run:

```bash
node --test app/tests/prototype-style-contract.test.mjs
pnpm --dir app build
pnpm verify
```

Expected: the focused contract and app build PASS. If `pnpm verify` has a pre-existing unrelated failure, record the exact baseline comparison and do not edit unrelated files.

- [ ] **Step 2: Start the local target without external side effects**

Run from the repository root:

```bash
pnpm dev
```

Do not click sync, publish, delete, import, store-binding, or other operations that can call an external service or mutate business data.

- [ ] **Step 3: Capture the visual reference**

In the approved browser, open `http://localhost:5173/` and capture the same page state at:

- 1440px desktop
- 1280px intermediate desktop
- 390px mobile

Record the source title, visible navigation, main heading, shell geometry, colors, card radius, and responsive changes.

- [ ] **Step 4: Capture and inspect the target**

Open the target local application and inspect:

- dashboard
- product list
- collection/listing
- orders
- profit trend
- stores
- pricing
- messaging
- plugin
- login or logged-out state
- 404

Capture dashboard, product list, orders, profit, stores, and pricing at 1440px. Capture dashboard and product list at 390px. Capture at least dashboard at 1280px to prove the source prototype’s horizontal-cropping defect was not copied.

- [ ] **Step 5: Run interaction smoke checks**

Verify without external writes:

- Desktop and mobile navigation reach the expected route heading.
- Menu selection and submenu expansion remain correct.
- Product status tabs, a query input, and a table pagination control respond.
- One non-destructive modal or drawer opens and closes.
- Topbar store and account menus open without changing data.
- The mobile navigation drawer opens, navigates once, and closes.
- Browser console has no new uncaught errors.

- [ ] **Step 6: Perform same-viewport visual comparison**

Compare source and target screenshots together at 1440px and 390px. Inspect:

- layout hierarchy
- sidebar/topbar geometry
- background and surfaces
- typography and weights
- card/input/table radii
- border and shadow strength
- spacing and density
- overflow, clipping, and overlays

Fix every P0, P1, and P2 visual or interaction finding, recapture, and repeat until none remain.

- [ ] **Step 7: Write the QA result**

Update `design-qa.md` with:

```md
# Prototype Style Refresh Design QA

- reference: http://localhost:5173/
- target: local Sonli Ozon app
- desktop viewports: 1440px, 1280px
- mobile viewport: 390px
- automated contract: passed
- app build: passed
- route smoke: passed
- interaction smoke: passed
- P0/P1/P2 remaining: 0
- P3 follow-ups: none, or list only optional polish
- final result: passed
```

If valid source or target capture is unavailable, write `final result: blocked` and stop before completion claims.

- [ ] **Step 8: Final diff and secret review**

Run:

```bash
git diff --check -- app/src/App.jsx app/src/styles.css app/tests/prototype-style-contract.test.mjs design-qa.md
git diff --stat -- app/src/App.jsx app/src/styles.css app/tests/prototype-style-contract.test.mjs design-qa.md
git diff -- app/src/App.jsx app/src/styles.css app/tests/prototype-style-contract.test.mjs design-qa.md
rg -n -i "(api[-_ ]?key|apikey|client[-_ ]?id).{0,80}([0-9a-f]{8}-[0-9a-f]{4}|[0-9]{6,})" app/src app/tests design-qa.md
```

Expected: only declared files changed, no whitespace errors, no lockfile drift, no secrets, and no unrelated formatting churn.
