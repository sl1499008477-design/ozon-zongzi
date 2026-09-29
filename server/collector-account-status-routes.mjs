import crypto from 'node:crypto';
import { getPostgresPool } from './db/connection.mjs';
import { withoutListedSkus } from './collection-sku-rules.mjs';
import { sanitizeCollectorText } from './collector-auth-service.mjs';
import * as defaultFxService from './pricing-fx-service.mjs';

// Counts need SKU identities only; do not hydrate media, attributes or enrichment jobs.
export async function readCollectorAccountCounts({ pool, accountId }) {
  const [products, items, completed] = await Promise.all([
    pool.query(`SELECT COUNT(*)::int AS count FROM products p
      JOIN stores s ON s.id=p.store_id WHERE s.owner_account_id=$1`, [accountId]),
    pool.query(`SELECT c.source_sku AS sku, COALESCE(
        NULLIF(jsonb_path_query_array(COALESCE(d.data,raw.payload->'normalized'->'listingDraft'), '$.variants[*].sku'),'[]'::jsonb),
        jsonb_path_query_array(raw.payload, '$.normalized.variants[*].sku'),'[]'::jsonb) AS variant_skus
      FROM collect_items c
      LEFT JOIN product_drafts d ON d.id=c.current_draft_id AND d.collect_item_id=c.id
      LEFT JOIN LATERAL (SELECT payload FROM collect_raw_payloads r
        WHERE r.collect_item_id=c.id AND r.account_id=c.account_id
        ORDER BY r.created_at DESC LIMIT 1) raw ON TRUE
      WHERE c.account_id=$1 AND c.deleted_at IS NULL`, [accountId]),
    pool.query(`SELECT status, jsonb_path_query_array(body, '$.source.items[*].sku') AS skus,
        jsonb_path_query_array(body, '$.submissionResults[*] ? (@.importStatus == "SUCCEEDED").sku') AS succeeded_skus
      FROM ai_image_listing_tasks WHERE account_id=$1 AND
        (status='COMPLETED' OR body->'submissionResults' @> '[{"importStatus":"SUCCEEDED"}]'::jsonb)`, [accountId]),
  ]);
  const pending = withoutListedSkus(
    items.rows.map(row => ({ sku: row.sku, variants: (row.variant_skus || []).map(sku => ({ sku })) })),
    completed.rows.map(row => ({ status: row.status, source: { items: (row.skus || []).map(sku => ({ sku })) },
      submissionResults: (row.succeeded_skus || []).map(sku => ({ sku, importStatus: 'SUCCEEDED' })) })),
  );
  return { collect: pending.length, products: Number(products.rows[0]?.count || 0) };
}

function invalid(message, status = 400, code = 'COLLECTOR_ACCOUNT_STATUS_INVALID') {
  return Object.assign(new Error(message), { status, code });
}

function noQueryScope(url) {
  if (url.searchParams.size) throw invalid('账号与店铺范围由采集会话确定');
}

function publicRate(rate) {
  if (!rate) return null;
  const { baseCurrency, quoteCurrency, rate: value, source, computedAt, acceptedCount, confidence, stale } = rate;
  return { baseCurrency, quoteCurrency, rate: value, source, computedAt, acceptedCount, confidence, stale };
}

export function createCollectorAccountStatusRoutes({
  readAccountCounts = async accountId => readCollectorAccountCounts({ pool: await getPostgresPool(), accountId }),
  fxService = defaultFxService,
} = {}) {
  return [
    { path: /^\/collector\/account-summary\/?$/, methods: {
      GET: async ({ account, url }) => {
        noQueryScope(url);
        const [counts, rate] = await Promise.all([
          readAccountCounts(account.id), fxService.getLatestLiveExchangeRate(),
        ]);
        return { counts: { collect: counts.collect, products: counts.products }, rate: publicRate(rate) };
      },
    } },
    { path: /^\/collector\/fx\/probes\/active\/?$/, methods: {
      GET: async ({ url }) => {
        noQueryScope(url);
        const [probes, rate] = await Promise.all([
          fxService.listFxProbes({ includeDisabled: false }), fxService.getLatestLiveExchangeRate(),
        ]);
        return { probes: probes.map(({ sku }) => ({ sku })), rate: publicRate(rate) };
      },
    } },
    { path: /^\/collector\/fx\/observations\/?$/, methods: {
      POST: async ({ account, body, req, url }) => {
        noQueryScope(url);
        if (Object.keys(body).some(key => !['observations', 'errors', 'deviceId', 'idempotencyKey'].includes(key))) {
          throw invalid('采价结果包含不允许的字段');
        }
        const idempotencyKey = String(req.headers?.['idempotency-key'] || '').trim();
        if (!idempotencyKey) throw invalid('缺少 Idempotency-Key', 422, 'IDEMPOTENCY_KEY_REQUIRED');
        if (body.idempotencyKey && body.idempotencyKey !== idempotencyKey) {
          throw invalid('采价幂等键不一致');
        }
        if (!Array.isArray(body.observations) || !Array.isArray(body.errors)
          || body.observations.some(row => !row || typeof row !== 'object')
          || body.errors.some(row => !row || typeof row !== 'object')) throw invalid('采价结果格式错误');
        // Ingest only the price pair, never arbitrary page JSON, credentials or caller scope.
        // The existing service validates active probes, prices, outliers and idempotency.
        const observations = body.observations.map(({ sku, rubPrice, cnyPrice, observedAt }) => ({
          sku, rubPrice, cnyPrice, observedAt, source: 'ozon_buyer_bff_variant_frontend',
        }));
        const errors = body.errors.map(({ sku, error }) => ({ sku,
          error: sanitizeCollectorText(error, { max: 500 }).replace(/bearer\s+[A-Za-z0-9._~+/-]+=*/gi, '[REDACTED]'),
        }));
        const payload = { observations, errors, deviceId: String(body.deviceId || '').slice(0, 240) };
        const result = await fxService.ingestFxObservations({ ...payload, accountId: account.id, idempotencyKey,
          // Match the existing Web FX hash so pre-migration pending receipts remain replayable.
          payloadHash: crypto.createHash('sha256').update(JSON.stringify({ observations: body.observations,
            errors: body.errors, deviceId: body.deviceId || '' })).digest('hex') });
        return { status: 201, payload: { rate: publicRate(result.rate),
          accepted: result.accepted, rejected: result.rejected, errors: result.errors } };
      },
    } },
  ];
}
