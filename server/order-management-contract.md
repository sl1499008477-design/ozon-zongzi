# Order management backend contract

All routes accept `/ozon/...` and `/api/ozon/...`. Authentication and the current account's ownership of `storeId` are checked in the backend. `storeId` is required. Money values are decimal strings; unavailable values are null. No platform write or buyer-message endpoints are invoked.

```ts
type Money = { amount: string; currency: string | null };
type Product = {
  productId: string | null; sku: string; offerId: string; name: string;
  imageUrl: string | null; quantity: number | null;
  unitCostCny: string | null; costSource: 'MANUAL' | 'PRODUCT_AUTO' | null;
  lineCostCny: string | null;
  sale: Money | null; commission: Money | null; payout: Money | null;
};
type StatusGroup = 'awaiting_packaging' | 'awaiting_deliver' | 'delivering'
  | 'disputed' | 'delivered' | 'cancelled' | 'other';
type Posting = {
  postingNumber: string; orderNumber: string; scheme: 'FBS' | 'rFBS' | 'FBO';
  status: string; statusGroup: StatusGroup; substatus: string;
  inProcessAt: string | null; createdAt: string | null;
  shipmentDate: string | null; deliveringDate: string | null;
  trackingNumber: string; deliveryMethod: string;
  cancellation: { reason: string; reasonId: string; type: string } | null;
  products: Product[];
  sale: Money | null; commission: Money | null; payout: Money | null;
  commissionMatch: 'MATCHED' | 'PARTIAL' | 'MISSING';
  purchaseCostCny: string | null; grossProfitCny: string | null;
  profitUnavailableReason: string | null;
};
type Sync = {
  status: 'IDLE' | 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED';
  since: string | null; to: string | null; scheme: 'FBS' | 'FBO' | null;
  pages: number; processed: number;
  startedAt: string | null; updatedAt: string | null; completedAt: string | null;
  lastError: string | null;
};
type Overview = {
  items: Posting[]; total: number; page: number; pageSize: number;
  statusCounts: Record<StatusGroup | 'all', number>; sync: Sync;
};
type ProductCost = { productId: string; unitCostCny: string | null; autoApply: boolean };
```

- `GET /ozon/order-management/overview?storeId&q&status&since&to&page&pageSize` returns `Overview`. Defaults: last 30 days, status `all`, page 1, pageSize 50 (maximum 100). Status counts apply the search/date filters, before the status filter. Dates accept ISO instants or UTC date-only strings; a date-only `to` includes the whole day.
- `POST /ozon/order-management/sync?storeId` body `{since?,to?}` returns `{sync:Sync}` immediately. Default last 30 days; maximum one year per requested range. Cursor pagination is durable and has no page cap. Both FBS/rFBS and FBO are read. A failed run preserves previously imported pages and reports `lastError`; requesting again retries the range by idempotent upsert.
- `GET /ozon/order-management/sync?storeId` returns `{sync:Sync}`.
- `GET /ozon/order-management/postings/:postingNumber?storeId&scheme` returns `{posting:Posting}` from the formal database, including historical orders. `scheme` is required; `FBS` and `rFBS` use the same upstream scheme family.
- `PUT /ozon/order-management/postings/:postingNumber/costs?storeId&scheme` body `{items:[{sku:string,unitCostCny:string|null}]}` returns `{posting:Posting}`. Only supplied items change. Manual null stays manual and blocks automatic refill. Cost strings must be nonnegative with at most two decimals.
- `GET /ozon/product-costs?storeId` returns `{items:ProductCost[]}` (saved settings only; absent products have no cost and autoApply off).
- `PUT /ozon/product-costs/:productId?storeId` body `{unitCostCny:string|null,autoApply:boolean}` returns `ProductCost`. The catalog product must exist in the current store. Enabling automatic cost fills missing order SKU costs, without changing any previous manual or automatic snapshot.

`createOrderManagementRuntime({authenticate,readJson,sendJson,resolveService?,resolvePool?})` returns `{handleRoute,start,stop}`. The normal runtime resolves the PostgreSQL pool, runs additive migrations and creates the service on first use. `start()` processes at most one page per background tick; `stop()` waits for the current page. Tests inject `resolveService` with mock Ozon and an independent database. The parent integrates this runtime in `server/index.mjs`.

The monetary `sale` is the price after seller promotions, excluding Ozon-funded discounts, multiplied by the actual product quantity. Commission/payout retain platform line totals and signs; commission is not multiplied again. Gross margin is sale less the absolute commission charge less purchase cost, all in CNY. Cancelled orders always return grossProfitCny null with reason `取消订单不计利润`. It excludes shipping, refunds, other fees and actual settlement. No documented transaction FX is available from the current list response, so foreign/missing currencies produce null gross profit. The payout response does not document its currency; its numeric amount is retained with currency null. An aggregate across different/unknown currencies is null, with the underlying product amounts retained.

Official API verified 2026-09-11:
- https://docs.ozon.ru/api/seller/#operation/PostingFbsList — `/v4/posting/fbs/list`, cursor, limit 1–100, financial_data.
- https://docs.ozon.ru/api/seller/#operation/PostingFboList — `/v3/posting/fbo/list`, cursor, limit 1–100, financial_data.
- https://docs.ozon.ru/api/seller/#operation/PostingAPI_GetFbsPostingV3 and https://docs.ozon.ru/api/seller/#operation/PostingAPI_GetFboPosting — legacy scalar fields and distinct seller/commission currencies, used to interpret existing formal data. Details are served locally without making one network call per order.
