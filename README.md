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

When PostgreSQL environment variables are configured, the local API stores the compatibility state document in PostgreSQL table `local_state` instead of `server-data/local-state.json`. If the table is empty and the JSON file already exists, the API imports the JSON state on first boot.

The production data model is mirrored into relational PostgreSQL tables on every save:

- `accounts`, `sessions`
- `stores`, `store_credentials`
- `products`, `product_prices`
- `warehouses`, `product_stocks`
- `orders`, `order_items`
- `files`, `product_assets`（商品主图、图库图、视频资源）
- `sync_jobs`

Ozon `Api-Key` values are encrypted before they are written to `local_state` or `store_credentials`. Set `APP_ENCRYPTION_KEY` in `.env` before using real stores in a deployable environment. If this value changes, previously encrypted credentials cannot be decrypted and must be re-bound.

Local files are stored through MinIO by the `/local/files` API. Product image and video resources synced from Ozon are mirrored into `product_assets` with their external `origin_url`; locally uploaded images/videos can be linked later through `file_id`. Existing browser-side utilities that only process files in memory still work without uploading anything.

## Local Persistent Storage

Docker Desktop is required for the PostgreSQL and MinIO services.

Copy the environment template once:

```bash
cp .env.example .env
```

Start local storage:

```bash
docker compose up -d postgres minio minio-init
```

Apply database migrations explicitly when needed:

```bash
pnpm db:migrate
```

The API also runs pending migrations automatically on startup when PostgreSQL is enabled.

Default endpoints:

- PostgreSQL: `127.0.0.1:5432`, database `sonli_local`, user `sonli`
- MinIO API: `http://127.0.0.1:9000`
- MinIO console: `http://127.0.0.1:9001`
- MinIO bucket: `sonli-local-files`

Health check:

```bash
curl http://127.0.0.1:3001/local/storage/health
```

The health response includes relational table row counts, product image/video asset counts, and encryption status. In production, `encryption.configured` should be `true`.

If `.env` is absent, the API keeps using JSON file storage.

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
