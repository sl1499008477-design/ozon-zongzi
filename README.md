# QH Ozon Local Clone

This workspace contains a local QH Ozon dashboard clone and a copied QH browser extension.

## Structure

- `app/`: React + Vite + Ant Design local dashboard.
- `server/`: local Node API shim for binding stores, read-only Ozon sync, sync leases, and extension cache endpoints.
- `extension/`: copied QH browser extension source, version `0.13.46.1`.
- `desktop/`: sonli 统一账号的 macOS/Windows Ozon 采集助手。
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

正式上架链路使用独立的 V3 关系模型，不再把 `local_state` JSONB 当作任务事实来源：

- `collect_raw_payloads`：每次真实采集产生一份不可变原始快照
- `collect_items`：采集箱索引、归属和当前状态
- `product_drafts`、`product_draft_revisions`、`product_draft_variants`：当前预处理草稿、修订历史和逐变体数据
- `submission_snapshots`、`submission_items`：提交时冻结的不可变请求快照和逐变体结果
- `submission_jobs`、`submission_events`：任务状态机和完整事件历史
- `outbox_events`：事务内可靠投递事件
- `audit_events`：账号、店铺和提交操作审计

`local_state` 目前只保留为尚未迁完的旧页面兼容缓存。采集箱和上架记录读取时由关系表覆盖，后续可在其余页面全部关系化后删除该兼容表。

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
curl http://127.0.0.1:3000/api/local/storage/health
```

The health response includes relational table row counts, product image/video asset counts, and encryption status. In production, `encryption.configured` should be `true`.

If `.env` is absent, the API keeps using JSON file storage.

## Run Locally

Use one command from the workspace root:

```bash
pnpm dev
```

This starts:

- 统一入口: `http://127.0.0.1:3000`（API 统一位于 `/api`，容器内 `3001` 不对外发布）
- listing Worker: PostgreSQL Outbox relay + `pg-boss` consumer
- unified dashboard entry: `http://127.0.0.1:3000/ozon/dashboard/`

The dashboard binding form saves Ozon `Client ID` and `API Key` to the local API. `全部同步` starts the copied browser extension sync when the extension is installed; if the extension is not detected, it falls back to the local API's read-only Ozon Seller API sync for products, postings, and warehouses.

### Local sub2API for automatic listing

The AI model gateway is an isolated local Compose project. Bootstrap and start it from the workspace root:

```bash
pnpm sub2api:bootstrap
pnpm sub2api:upgrade # first install: explicitly pull the entire pinned stack and start it
pnpm sub2api:status
```

After the images have been installed, normal restarts use `pnpm sub2api:up`; that command never pulls or upgrades images implicitly.

- sub2API dashboard: `http://127.0.0.1:8080/`
- `ozon 粽子` AI model settings: `http://127.0.0.1:3000/ozon/tools/auto-listing/ai-settings`
- show the local sub2API administrator once in the current terminal: `pnpm sub2api:credentials`
- show only a whitelisted container state/health summary (no vendor log text): `pnpm sub2api:logs`
- stream untrusted vendor logs only after accepting the terminal warning: `pnpm sub2api:logs:raw`
- stop only the isolated project while retaining data: `pnpm sub2api:down`

Configure the upstream AI account in the sub2API dashboard, create a dedicated gateway Key, then enter that Key on the Web settings page. Model synchronization reads only `/v1/models` and does not generate text or images. The explicit capability test performs one structured-text probe and one minimum-cost image probe, so it must be run only after acknowledging the cost warning. The full Key is encrypted and cannot be read back.

The ordinary diagnostic command never forwards third-party free-text logs. Raw logs can contain secrets, prompts, or upstream responses; the explicit raw command must not be redirected to a file, pasted into a ticket, or treated as sanitized output. Detailed start/stop, paired business-database/master-key backup and restore, upgrade, production replacement, safe errors, and rollback instructions are in [`docs/architecture/local-sub2api-operations.md`](docs/architecture/local-sub2api-operations.md).

## Desktop Collector

The cross-platform collector lives in `desktop/`. It uses the Sonli account/session, account-owned operating store and verified Seller data store. Tasks, runs, leases, events, item results, Seller Analytics snapshots, 63-column Excel exports and collect-box ingestion are persisted through the Sonli API.

- Verify: `pnpm --dir desktop verify`
- macOS Intel/ARM ZIP: `pnpm --dir desktop run dist:mac:zip`
- Windows x64 setup/portable: `pnpm --dir desktop run dist:win`

Generated packages are written to `desktop/release/`. Direct `batchCreateGoods` publishing is intentionally excluded; qualified results enter the Sonli collect box and continue through the existing draft/listing queue.

The exact delivery matrix, verified package checksums and known external-dependency gaps are recorded in `desktop/IMPLEMENTATION_STATUS.md`.

## Browser Extension

Load the unpacked extension from:

`/Users/songliang/Documents/sonli ozon3.0/extension`

The downloadable bundle is regenerated from the same directory:

`app/public/qh-extension-0.13.46.1.zip`

The local copy has been adjusted to recognize:

- `http://localhost:3000/*`
- `http://127.0.0.1:3000/*`
- `http://store.localhost:3000/*`

and to open the local dashboard when the local API is detected.

Chrome loading checklist:

1. Open `chrome://extensions/` and enable Developer mode.
2. Load the unpacked extension directory above, or click reload on the existing local QH extension card.
3. Open the local plugin page and click `重新检测`.

After loading/reloading the unpacked extension in Chrome, open the unified local URL:

`http://127.0.0.1:3000/ozon/dashboard/`

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

The V3 flow is `server-side validation -> draft revision -> immutable snapshot -> Outbox -> pg-boss -> independent Worker -> Ozon item-level reconciliation`. The API process never calls `/v3/product/import` for V3 jobs. Start a production API and Worker as separate processes:

```bash
pnpm server
pnpm worker
```

Do not run more than one compatibility JSON writer during migration. Multiple API/Worker replicas are supported for V3 submission jobs because row leases, Outbox locking, idempotency keys, and pg-boss singleton jobs protect the formal pipeline.

The same code can run as production-style containers. Set production secrets in `.env`, then start the application profile:

```bash
docker compose --profile application up -d --build
```

This starts PostgreSQL, MinIO, API, the independent listing Worker, and an Nginx-served production frontend at `http://127.0.0.1:3000`. Never keep the example administrator password or encryption key in a deployed environment.

When `NODE_ENV=production`, the API refuses to start unless PostgreSQL, MinIO, a random encryption key of at least 32 characters, and a non-default administrator password are configured. The Worker also refuses to start without PostgreSQL, encryption, and the V3 pipeline.

To regenerate extension zips after extension edits:

```bash
pnpm package-extension
```

## Verify

Run the focused local verification suite:

```bash
pnpm verify
```

It checks the app build, source-extension parity, extension zip parity, server/bridge syntax, manifest JSON, follow-sell bridge smoke, batch-upload smoke, popup smoke, diff whitespace, and secret scanning.

## Current Local URL

`http://127.0.0.1:3000/ozon/dashboard/`
