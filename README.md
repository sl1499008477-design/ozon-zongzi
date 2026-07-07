# QH Ozon Local Clone

This workspace contains a local QH Ozon dashboard clone and a copied QH browser extension.

## Structure

- `app/`: React + Vite + Ant Design local dashboard.
- `server/`: local Node API shim for binding stores, read-only Ozon sync, sync leases, and extension cache endpoints.
- `extension/`: copied QH browser extension source, version `0.13.46.1`.
- `app/public/qh-extension-0.13.46.1.zip`: downloadable extension bundle used by the dashboard plugin page.
- `implementation-dashboard.png`: latest local dashboard screenshot.
- `interaction-plugin-drawer.png`: latest plugin drawer interaction screenshot.
- `design-qa.md`: current visual QA status.

## Data Policy

No sample shop, product, order, GMV, inventory, or customer data is inserted. The dashboard starts in an unbound state and only shows zero/empty states until a real store is bound.

Credentials are written only to `server-data/local-state.json` on this Mac. `server-data/` is ignored by git and is not bundled into the frontend build.

## Run Locally

Use one command from the workspace root:

```bash
pnpm dev
```

This starts:

- local API: `http://127.0.0.1:3001`
- dashboard: `http://127.0.0.1:5173/ozon/dashboard/`
- source-plugin-compatible proxy: `http://localhost:3000/ozon/dashboard/`

The dashboard binding form saves Ozon `Client ID` and `API Key` to the local API. `全部同步` starts the copied browser extension sync when the extension is installed; if the extension is not detected, it falls back to the local API's read-only Ozon Seller API sync for products, postings, and warehouses.

## Browser Extension

Load the unpacked extension from:

`/Users/songliang/Documents/sonli ozon3.0/extension`

The downloadable bundle is regenerated from the same directory:

`app/public/qh-extension-0.13.46.1.zip`

The local copy has been adjusted to recognize:

- `http://localhost:3000/*`
- `http://store.localhost:3000/*`
- `http://127.0.0.1:5173/*`
- `http://localhost:5173/*`

and to open the local dashboard when the local API is detected.

Chrome loading checklist:

1. Open `chrome://extensions/` and enable Developer mode.
2. Load the unpacked extension directory above, or click reload on the existing local QH extension card.
3. Open the local plugin page and click `重新检测`.

After loading/reloading the unpacked extension in Chrome, open either local URL:

`http://127.0.0.1:5173/ozon/dashboard/`

`http://localhost:3000/ozon/dashboard/`

Click `全部同步`. If the extension bridge is active, the page should show that the plugin sync task started. If it shows `插件未响应，改用本地只读同步`, Chrome is still not running this local unpacked extension.

The source QH extension can respond on `localhost:3000`. If the plugin page shows `源插件兼容采集模式`, collect-box listing will use the source plugin's `prefetch` collector and then call the local backend preview/import endpoints. If the page shows `已连接 0.13.46.1`, the full local `follow-sell` bridge is active.

For collect-box listing verification, use one of these test SKUs:

- `1424490696`
- `2855190785`
- `3278119665`

The collect edit page submits through the available extension bridge:

`采集箱/商品列表 -> 查看 -> 上架预检 -> 提交上架到 Ozon`

The preferred local-extension path performs `SKU sourceVariant collection -> V3 item build -> followSell(dryRun) -> /ozon/products/import/preview`. In source-plugin compatibility mode it performs `prefetch.request -> sourceVariant import item -> /ozon/products/import/preview`. Both preview paths validate type/category/attribute conversion without calling Ozon `/v3/product/import` and without saving an import job.

The final `提交上架到 Ozon` button uses the same collection/build path and then submits to `/ozon/products/import`. The local store currently used for listing tests is `数据 01test`; credentials are kept only in ignored local state and must not be committed.

To regenerate extension zips after extension edits:

```bash
pnpm package-extension
```

## Verify

Run the focused local verification suite:

```bash
pnpm verify
```

It checks the app build, source-extension parity, extension zip parity, server/proxy/bridge syntax, manifest JSON, follow-sell bridge smoke, batch-upload smoke, popup smoke, diff whitespace, and secret scanning.

## Current Local URL

`http://127.0.0.1:5173/ozon/dashboard/`

Compatibility entry:

`http://localhost:3000/ozon/dashboard/`
