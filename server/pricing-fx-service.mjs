import crypto from "node:crypto";
import { getPostgresPool, postgresEnabled } from "./db/connection.mjs";

const MIN_RATE = 5;
const MAX_RATE = 30;
const STALE_AFTER_MS = 6 * 60 * 60 * 1000;
const CACHE_MS = 30_000;

let latestCache = { at: 0, value: null };

function fxError(message, status = 400, code = "PRICING_FX_INVALID") {
  return Object.assign(new Error(message), { status, code });
}

function clean(value, max = 240) {
  return String(value ?? "").trim().slice(0, max);
}

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function round(value, digits = 8) {
  const factor = 10 ** digits;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}

function median(values = []) {
  const sorted = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function normalizeSku(value) {
  const sku = clean(value, 32).replace(/\s+/g, "");
  if (!/^\d{6,16}$/.test(sku)) throw fxError("SKU 必须为 6-16 位数字", 422, "PRICING_FX_SKU_INVALID");
  return sku;
}

export function computeRobustExchangeRate(rows = [], previousRate = 0) {
  const normalized = rows.map((row) => {
    const rubPrice = finite(row.rubPrice ?? row.rub_price);
    const cnyPrice = finite(row.cnyPrice ?? row.cny_price);
    const impliedRate = cnyPrice > 0 ? rubPrice / cnyPrice : 0;
    const base = { ...row, rubPrice, cnyPrice, impliedRate: round(impliedRate) };
    if (!(rubPrice > 0) || !(cnyPrice > 0)) return { ...base, accepted: false, rejectReason: "价格必须大于 0" };
    if (impliedRate < MIN_RATE || impliedRate > MAX_RATE) {
      return { ...base, accepted: false, rejectReason: `隐含汇率超出 ${MIN_RATE}-${MAX_RATE}` };
    }
    return { ...base, accepted: true, rejectReason: "" };
  });
  const candidates = normalized.filter((row) => row.accepted);
  if (!candidates.length) return { rate: 0, accepted: [], rejected: normalized, confidence: "LOW", method: "median" };

  const center = median(candidates.map((row) => row.impliedRate));
  let accepted = candidates;
  if (candidates.length >= 3) {
    const mad = median(candidates.map((row) => Math.abs(row.impliedRate - center)));
    const tolerance = Math.max(center * 0.025, mad * 3);
    accepted = candidates.filter((row) => Math.abs(row.impliedRate - center) <= tolerance);
  } else if (candidates.length === 2) {
    const relativeGap = Math.abs(candidates[0].impliedRate - candidates[1].impliedRate) / center;
    if (relativeGap > 0.05) {
      accepted = previousRate > 0
        ? [candidates.sort((a, b) => Math.abs(a.impliedRate - previousRate) - Math.abs(b.impliedRate - previousRate))[0]]
        : [];
    }
  }
  const acceptedSet = new Set(accepted.map((row) => row.sku));
  const finalized = normalized.map((row) => row.accepted && !acceptedSet.has(row.sku)
    ? { ...row, accepted: false, rejectReason: "与多 SKU 中位数偏差过大" }
    : row);
  const finalAccepted = finalized.filter((row) => row.accepted);
  const rate = median(finalAccepted.map((row) => row.impliedRate));
  const confidence = finalAccepted.length >= 3 ? "HIGH" : finalAccepted.length === 2 ? "MEDIUM" : "LOW";
  return {
    rate: round(rate),
    accepted: finalAccepted,
    rejected: finalized.filter((row) => !row.accepted),
    confidence,
    method: "median",
  };
}

function mapProbe(row = {}) {
  return {
    id: row.id,
    sku: row.sku,
    label: row.label || "",
    status: row.status,
    lastObservedAt: row.last_observed_at,
    lastError: row.last_error || "",
    rubPrice: row.rub_price == null ? null : Number(row.rub_price),
    cnyPrice: row.cny_price == null ? null : Number(row.cny_price),
    impliedRate: row.implied_rate == null ? null : Number(row.implied_rate),
    observationAccepted: row.accepted ?? null,
    observedAt: row.observed_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapRate(row = {}) {
  if (!row?.id) return null;
  const computedAt = row.computed_at ? new Date(row.computed_at).toISOString() : null;
  const ageMs = computedAt ? Date.now() - new Date(computedAt).getTime() : Number.POSITIVE_INFINITY;
  return {
    id: row.id,
    baseCurrency: row.base_currency || "CNY",
    quoteCurrency: row.quote_currency || "RUB",
    rate: Number(row.rate),
    method: row.method || "median",
    source: row.source || "ozon_sku_frontend",
    sampleCount: Number(row.sample_count || 0),
    acceptedCount: Number(row.accepted_count || 0),
    rejectedCount: Number(row.rejected_count || 0),
    confidence: row.confidence || "LOW",
    observedFrom: row.observed_from,
    observedTo: row.observed_to,
    evidence: Array.isArray(row.evidence) ? row.evidence : [],
    computedAt,
    stale: ageMs > STALE_AFTER_MS,
    ageMs,
  };
}

export async function listFxProbes({ includeDisabled = true } = {}) {
  if (!postgresEnabled()) return [];
  const pool = await getPostgresPool();
  const result = await pool.query(
    `SELECT p.*,o.rub_price,o.cny_price,o.implied_rate,o.accepted,o.observed_at
       FROM pricing_fx_probes p
       LEFT JOIN LATERAL (
         SELECT rub_price,cny_price,implied_rate,accepted,observed_at
         FROM pricing_fx_observations WHERE probe_id=p.id
         ORDER BY observed_at DESC,created_at DESC LIMIT 1
       ) o ON TRUE
      WHERE ($1::boolean OR p.status='ACTIVE')
      ORDER BY p.status='ACTIVE' DESC,p.created_at,p.id`,
    [includeDisabled],
  );
  return result.rows.map(mapProbe);
}

export async function createFxProbe({ sku, label = "", actorId = null } = {}) {
  const normalizedSku = normalizeSku(sku);
  const pool = await getPostgresPool();
  try {
    const result = await pool.query(
      `INSERT INTO pricing_fx_probes (id,sku,label,created_by,updated_by)
       VALUES ($1,$2,$3,$4,$4) RETURNING *`,
      [`fxp_${crypto.randomUUID()}`, normalizedSku, clean(label, 120), actorId || null],
    );
    return mapProbe(result.rows[0]);
  } catch (error) {
    if (error?.code === "23505") throw fxError("该 SKU 已存在", 409, "PRICING_FX_SKU_EXISTS");
    throw error;
  }
}

export async function updateFxProbe(id, { sku, label, status, actorId = null } = {}) {
  const normalizedStatus = status === undefined ? null : clean(status, 20).toUpperCase();
  if (normalizedStatus && !["ACTIVE", "DISABLED"].includes(normalizedStatus)) {
    throw fxError("探针状态无效", 422, "PRICING_FX_STATUS_INVALID");
  }
  const normalizedSku = sku === undefined ? null : normalizeSku(sku);
  const pool = await getPostgresPool();
  try {
    const result = await pool.query(
      `UPDATE pricing_fx_probes SET
         sku=COALESCE($2,sku),label=COALESCE($3,label),status=COALESCE($4,status),
         updated_by=$5,updated_at=NOW()
       WHERE id=$1 RETURNING *`,
      [clean(id, 240), normalizedSku, label === undefined ? null : clean(label, 120), normalizedStatus, actorId || null],
    );
    if (!result.rows[0]) throw fxError("汇率 SKU 不存在", 404, "PRICING_FX_PROBE_NOT_FOUND");
    return mapProbe(result.rows[0]);
  } catch (error) {
    if (error?.code === "23505") throw fxError("该 SKU 已存在", 409, "PRICING_FX_SKU_EXISTS");
    throw error;
  }
}

export async function deleteFxProbe(id) {
  const pool = await getPostgresPool();
  const result = await pool.query("DELETE FROM pricing_fx_probes WHERE id=$1 RETURNING id", [clean(id, 240)]);
  if (!result.rows[0]) throw fxError("汇率 SKU 不存在", 404, "PRICING_FX_PROBE_NOT_FOUND");
  return true;
}

export async function getLatestLiveExchangeRate({ bypassCache = false } = {}) {
  if (!postgresEnabled()) return null;
  if (!bypassCache && latestCache.at && Date.now() - latestCache.at < CACHE_MS) return latestCache.value;
  const pool = await getPostgresPool();
  const result = await pool.query(
    `SELECT * FROM pricing_live_exchange_rates
      WHERE base_currency='CNY' AND quote_currency='RUB'
      ORDER BY computed_at DESC,created_at DESC LIMIT 1`,
  );
  latestCache = { at: Date.now(), value: mapRate(result.rows[0]) };
  return latestCache.value;
}

export async function getFxStatus() {
  const [probes, rate] = await Promise.all([listFxProbes(), getLatestLiveExchangeRate()]);
  return { probes, rate, intervalMinutes: 120, staleAfterMinutes: STALE_AFTER_MS / 60_000 };
}

export async function ingestFxObservations({ observations = [], errors = [], accountId = null, deviceId = "" } = {}) {
  if (!Array.isArray(observations) || !Array.isArray(errors)) throw fxError("采价结果格式错误");
  const pool = await getPostgresPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const active = await client.query("SELECT * FROM pricing_fx_probes WHERE status='ACTIVE' ORDER BY id FOR UPDATE");
    const bySku = new Map(active.rows.map((row) => [row.sku, row]));
    const previousResult = await client.query(
      `SELECT rate FROM pricing_live_exchange_rates
       WHERE base_currency='CNY' AND quote_currency='RUB' ORDER BY computed_at DESC LIMIT 1`,
    );
    const previousRate = Number(previousResult.rows[0]?.rate || 0);
    const deduped = new Map();
    for (const row of observations) {
      const sku = normalizeSku(row.sku);
      if (!bySku.has(sku)) continue;
      deduped.set(sku, { ...row, sku });
    }
    const computed = computeRobustExchangeRate([...deduped.values()], previousRate);
    const observedAt = new Date().toISOString();
    for (const row of [...computed.accepted, ...computed.rejected]) {
      const probe = bySku.get(row.sku);
      if (!probe || !(row.rubPrice > 0) || !(row.cnyPrice > 0) || !(row.impliedRate > 0)) continue;
      await client.query(
        `INSERT INTO pricing_fx_observations
          (id,probe_id,sku,rub_price,cny_price,implied_rate,accepted,reject_reason,source,account_id,device_id,raw,observed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13)`,
        [
          `fxo_${crypto.randomUUID()}`, probe.id, row.sku, row.rubPrice, row.cnyPrice, row.impliedRate,
          row.accepted, clean(row.rejectReason, 500), clean(row.source || "ozon_frontend", 120),
          accountId || null, clean(deviceId, 240), JSON.stringify(row.raw && typeof row.raw === "object" ? row.raw : {}), observedAt,
        ],
      );
      await client.query(
        "UPDATE pricing_fx_probes SET last_observed_at=$2,last_error=$3,updated_at=NOW() WHERE id=$1",
        [probe.id, observedAt, row.accepted ? "" : clean(row.rejectReason, 500)],
      );
    }
    for (const item of errors) {
      const sku = clean(item.sku, 32);
      const probe = bySku.get(sku);
      if (probe) await client.query(
        "UPDATE pricing_fx_probes SET last_error=$2,updated_at=NOW() WHERE id=$1",
        [probe.id, clean(item.error || "采价失败", 500)],
      );
    }
    let rate = null;
    if (computed.rate > 0 && computed.accepted.length > 0) {
      const times = computed.accepted.map((row) => row.observedAt || observedAt).sort();
      const evidence = computed.accepted.map((row) => ({
        sku: row.sku,
        rubPrice: round(row.rubPrice, 6),
        cnyPrice: round(row.cnyPrice, 6),
        impliedRate: row.impliedRate,
      }));
      const inserted = await client.query(
        `INSERT INTO pricing_live_exchange_rates
          (id,rate,method,source,sample_count,accepted_count,rejected_count,confidence,observed_from,observed_to,evidence,computed_at)
         VALUES ($1,$2,$3,'ozon_sku_frontend',$4,$5,$6,$7,$8,$9,$10::jsonb,NOW()) RETURNING *`,
        [
          `fxr_${crypto.randomUUID()}`, computed.rate, computed.method, deduped.size,
          computed.accepted.length, computed.rejected.length, computed.confidence,
          times[0] || observedAt, times.at(-1) || observedAt, JSON.stringify(evidence),
        ],
      );
      rate = mapRate(inserted.rows[0]);
    }
    await client.query("COMMIT");
    latestCache = { at: Date.now(), value: rate || await getLatestLiveExchangeRate({ bypassCache: true }) };
    return { rate: latestCache.value, accepted: computed.accepted.length, rejected: computed.rejected.length, errors: errors.length };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function applyLiveExchangeRate(config) {
  if (!config) return config;
  const live = await getLatestLiveExchangeRate();
  if (!live?.rate) return config;
  return {
    ...config,
    exchangeRate: {
      id: live.id,
      baseCurrency: live.baseCurrency,
      quoteCurrency: live.quoteCurrency,
      rate: live.rate,
      source: live.source,
      quotedAt: live.computedAt,
      sampleCount: live.sampleCount,
      acceptedCount: live.acceptedCount,
      confidence: live.confidence,
      stale: live.stale,
      dynamic: true,
    },
  };
}
