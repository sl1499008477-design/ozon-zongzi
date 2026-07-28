import crypto from "node:crypto";
import { getPostgresPool, postgresEnabled } from "./db/connection.mjs";
import { calculatePricing, validatePricingConfig } from "./pricing-engine.mjs";
import { applyLiveExchangeRate } from "./pricing-fx-service.mjs";

const id = (prefix) => `${prefix}_${crypto.randomUUID()}`;
const jsonHash = (value) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const number = (value) => value === null || value === undefined ? null : Number(value);
const dateOnly = (value) => {
  if (!value) return null;
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  const pad = (part) => String(part).padStart(2, "0");
  return `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())}`;
};

async function writePricingAudit(client, { actorId = null, action, versionId, metadata = {} }) {
  await client.query(`INSERT INTO audit_events
    (account_id, action, entity_type, entity_id, correlation_id, metadata)
    VALUES ($1,$2,'pricing_config',$3,$4,$5::jsonb)`,
  [actorId || null, action, versionId, id("pricing_audit"), JSON.stringify(metadata)]);
}

export const DEFAULT_PRICING_CONFIG = Object.freeze({
  id: "pricing_builtin_default",
  versionNo: 1,
  scopeType: "global",
  scopeId: "",
  status: "ACTIVE",
  ruleConfirmationStatus: "UNCONFIRMED",
  note: "系统示例参数，业务依据待管理员确认",
  effectiveFrom: "2026-01-01T00:00:00.000Z",
  effectiveTo: null,
  defaults: {
    adRate: 0,
    withdrawalRate: 3,
    returnLossRate: 2,
    targetMarginRate: 20,
    frontendDiscountRate: 50,
    otherFixedFeeCny: 0,
    currencyCode: "CNY",
  },
  exchangeRate: { baseCurrency: "CNY", quoteCurrency: "RUB", rate: 11.97, source: "initial-manual", quotedAt: "2026-07-11T00:00:00.000Z" },
  commissionRules: [
    { id: "commission_default_1", ruleName: "默认低价档", ozonCategoryId: "*", fulfillmentType: "RFBS", minPriceRub: 0, maxPriceRub: 1500, commissionRate: 12, priority: 100 },
    { id: "commission_default_2", ruleName: "默认中价档", ozonCategoryId: "*", fulfillmentType: "RFBS", minPriceRub: 1500.0001, maxPriceRub: 5000, commissionRate: 14, priority: 100 },
    { id: "commission_default_3", ruleName: "默认高价档", ozonCategoryId: "*", fulfillmentType: "RFBS", minPriceRub: 5000.0001, maxPriceRub: null, commissionRate: 18, priority: 100 },
  ],
  logisticsRules: [
    { id: "logistics_xy_500", provider: "XY", routeCode: "", warehouseId: "*", minWeightG: 0, maxWeightG: 500, baseFeeCny: 3, feePerKgCny: 0, minimumFeeCny: 3, useVolumeWeight: false, volumeDivisor: 6000, priority: 100 },
    { id: "logistics_xy_1000", provider: "XY", routeCode: "", warehouseId: "*", minWeightG: 500.0001, maxWeightG: 1000, baseFeeCny: 6, feePerKgCny: 0, minimumFeeCny: 6, useVolumeWeight: false, volumeDivisor: 6000, priority: 100 },
    { id: "logistics_xy_2000", provider: "XY", routeCode: "", warehouseId: "*", minWeightG: 1000.0001, maxWeightG: 2000, baseFeeCny: 12, feePerKgCny: 0, minimumFeeCny: 12, useVolumeWeight: false, volumeDivisor: 6000, priority: 100 },
    { id: "logistics_xy_5000", provider: "XY", routeCode: "", warehouseId: "*", minWeightG: 2000.0001, maxWeightG: 5000, baseFeeCny: 30, feePerKgCny: 0, minimumFeeCny: 30, useVolumeWeight: false, volumeDivisor: 6000, priority: 100 },
    { id: "logistics_xy_10000", provider: "XY", routeCode: "", warehouseId: "*", minWeightG: 5000.0001, maxWeightG: 10000, baseFeeCny: 60, feePerKgCny: 0, minimumFeeCny: 60, useVolumeWeight: false, volumeDivisor: 6000, priority: 100 },
    { id: "logistics_guoo", provider: "GUOO", routeCode: "", warehouseId: "*", minWeightG: 0, maxWeightG: null, baseFeeCny: 0, feePerKgCny: 55, minimumFeeCny: 0, useVolumeWeight: false, volumeDivisor: 6000, priority: 100 },
    { id: "logistics_cainiao", provider: "CAINIAO", routeCode: "", warehouseId: "*", minWeightG: 0, maxWeightG: null, baseFeeCny: 0, feePerKgCny: 48, minimumFeeCny: 0, useVolumeWeight: false, volumeDivisor: 6000, priority: 100 },
  ],
  domesticFeeRules: [
    { id: "domestic_default", warehouseId: "*", domesticShippingCny: 0, labelingFeeCny: 0, packagingFeeCny: 0, operationFeeCny: 0, priority: 100 },
  ],
});

let memoryVersions = [{ ...structuredClone(DEFAULT_PRICING_CONFIG), configHash: jsonHash(DEFAULT_PRICING_CONFIG), createdAt: new Date().toISOString() }];

function mapVersion(row) {
  return {
    id: row.id,
    versionNo: Number(row.version_no),
    scopeType: row.scope_type,
    scopeId: row.scope_id,
    status: row.status,
    ruleConfirmationStatus: row.rule_confirmation_status || "UNCONFIRMED",
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
    configHash: row.config_hash,
    note: row.note,
    createdBy: row.created_by,
    publishedBy: row.published_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    publishedAt: row.published_at,
  };
}

async function hydrateVersion(client, row) {
  const version = mapVersion(row);
  const [commission, logistics, domestic, defaults, exchange, officialImports] = await Promise.all([
    client.query("SELECT * FROM pricing_commission_rules WHERE version_id = $1 ORDER BY priority, min_price_rub", [row.id]),
    client.query("SELECT * FROM pricing_logistics_rules WHERE version_id = $1 ORDER BY priority, provider, min_weight_g", [row.id]),
    client.query("SELECT * FROM pricing_domestic_fee_rules WHERE version_id = $1 ORDER BY priority, warehouse_id", [row.id]),
    client.query("SELECT * FROM pricing_default_rules WHERE version_id = $1", [row.id]),
    client.query("SELECT * FROM pricing_exchange_rates WHERE version_id = $1 AND base_currency = 'CNY' AND quote_currency = 'RUB' LIMIT 1", [row.id]),
    client.query("SELECT * FROM pricing_official_imports WHERE version_id = $1 ORDER BY created_at", [row.id]),
  ]);
  version.commissionRules = commission.rows.map((item) => ({
    id: item.id, ruleName: item.rule_name, ozonCategoryId: item.ozon_category_id, fulfillmentType: item.fulfillment_type,
    minPriceRub: number(item.min_price_rub), maxPriceRub: number(item.max_price_rub), commissionRate: number(item.commission_rate),
    priority: item.priority, sourceName: item.source_name, sourceDate: dateOnly(item.source_date),
  }));
  version.logisticsRules = logistics.rows.map((item) => ({
    id: item.id, provider: item.provider, routeCode: item.route_code, warehouseId: item.warehouse_id,
    minWeightG: number(item.min_weight_g), maxWeightG: number(item.max_weight_g), baseFeeCny: number(item.base_fee_cny),
    feePerKgCny: number(item.fee_per_kg_cny), minimumFeeCny: number(item.minimum_fee_cny), useVolumeWeight: item.use_volume_weight,
    volumeDivisor: number(item.volume_divisor), maxLengthCm: number(item.max_length_cm), maxDimensionSumCm: number(item.max_dimension_sum_cm),
    surchargeRate: number(item.surcharge_rate), priority: item.priority,
  }));
  version.domesticFeeRules = domestic.rows.map((item) => ({
    id: item.id, warehouseId: item.warehouse_id, domesticShippingCny: number(item.domestic_shipping_cny),
    labelingFeeCny: number(item.labeling_fee_cny), packagingFeeCny: number(item.packaging_fee_cny),
    operationFeeCny: number(item.operation_fee_cny), priority: item.priority,
  }));
  const d = defaults.rows[0] || {};
  version.defaults = {
    adRate: number(d.ad_rate) || 0, withdrawalRate: number(d.withdrawal_rate) ?? 3, returnLossRate: number(d.return_loss_rate) ?? 2,
    targetMarginRate: number(d.target_margin_rate) ?? 20, frontendDiscountRate: number(d.frontend_discount_rate) ?? 50,
    otherFixedFeeCny: number(d.other_fixed_fee_cny) || 0, currencyCode: d.currency_code || "CNY",
  };
  const fx = exchange.rows[0] || {};
  version.exchangeRate = { id: fx.id, baseCurrency: fx.base_currency || "CNY", quoteCurrency: fx.quote_currency || "RUB", rate: number(fx.rate) || 11.97, source: fx.source || "manual", quotedAt: fx.quoted_at };
  version.officialImports = officialImports.rows.map((item) => ({
    id: item.id,
    sourceName: item.source_name,
    sourceDate: dateOnly(item.source_date),
    objectKey: item.object_key,
    objectBucket: item.object_bucket,
    contentType: item.content_type,
    fileSize: Number(item.file_size || 0),
    sha256: item.sha256,
    fulfillmentTypes: item.fulfillment_types || [],
    summaryRuleCount: Number(item.summary_rule_count || 0),
    detailMappingCount: Number(item.detail_mapping_count || 0),
    metadata: item.metadata || {},
    createdAt: item.created_at,
  }));
  return version;
}

async function insertOfficialMappings(client, versionId, sourceImportId, mappings = []) {
  const columnsPerRow = 14;
  const batchSize = 250;
  for (let offset = 0; offset < mappings.length; offset += batchSize) {
    const batch = mappings.slice(offset, offset + batchSize);
    const values = [];
    const placeholders = batch.map((mapping, index) => {
      const base = index * columnsPerRow;
      values.push(
        id("pocm"), versionId, sourceImportId,
        mapping.descriptiveTypeRu, mapping.descriptiveTypeZh || "", mapping.descriptiveTypeEn || "",
        mapping.descriptiveCategoryRu || "", mapping.descriptiveCategoryZh || "", mapping.descriptiveCategoryEn || "",
        mapping.marketplaceCategoryRu, mapping.marketplaceCategoryZh || "", mapping.marketplaceCategoryEn || "",
        mapping.brandName || "All", JSON.stringify(mapping.tariffJson || {}),
      );
      return `(${Array.from({ length: columnsPerRow }, (_, column) => `$${base + column + 1}`).join(",")})`;
    });
    await client.query(`INSERT INTO pricing_official_category_mappings (
      id,version_id,source_import_id,descriptive_type_ru,descriptive_type_zh,descriptive_type_en,
      descriptive_category_ru,descriptive_category_zh,descriptive_category_en,
      marketplace_category_ru,marketplace_category_zh,marketplace_category_en,brand_name,tariff_json
    ) VALUES ${placeholders.join(",")}`, values);
  }
}

async function replaceVersionChildren(client, versionId, config) {
  await client.query("DELETE FROM pricing_commission_rules WHERE version_id = $1", [versionId]);
  await client.query("DELETE FROM pricing_logistics_rules WHERE version_id = $1", [versionId]);
  await client.query("DELETE FROM pricing_domestic_fee_rules WHERE version_id = $1", [versionId]);
  await client.query("DELETE FROM pricing_default_rules WHERE version_id = $1", [versionId]);
  await client.query("DELETE FROM pricing_exchange_rates WHERE version_id = $1", [versionId]);
  for (const rule of config.commissionRules || []) {
    await client.query(`INSERT INTO pricing_commission_rules
      (id, version_id, rule_name, ozon_category_id, fulfillment_type, min_price_rub, max_price_rub, commission_rate, priority, source_name, source_date)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [id("pcr"), versionId, rule.ruleName || "", rule.ozonCategoryId || "*", rule.fulfillmentType || "RFBS", rule.minPriceRub || 0, rule.maxPriceRub ?? null, rule.commissionRate, rule.priority || 100, rule.sourceName || "", rule.sourceDate || null]);
  }
  for (const rule of config.logisticsRules || []) {
    await client.query(`INSERT INTO pricing_logistics_rules
      (id, version_id, provider, route_code, warehouse_id, min_weight_g, max_weight_g, base_fee_cny, fee_per_kg_cny, minimum_fee_cny, use_volume_weight, volume_divisor, max_length_cm, max_dimension_sum_cm, surcharge_rate, priority)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
    [id("plr"), versionId, rule.provider, rule.routeCode || "", rule.warehouseId || "*", rule.minWeightG || 0, rule.maxWeightG ?? null, rule.baseFeeCny || 0, rule.feePerKgCny || 0, rule.minimumFeeCny || 0, Boolean(rule.useVolumeWeight), rule.volumeDivisor || 6000, rule.maxLengthCm || null, rule.maxDimensionSumCm || null, rule.surchargeRate || 0, rule.priority || 100]);
  }
  for (const rule of config.domesticFeeRules || []) {
    await client.query(`INSERT INTO pricing_domestic_fee_rules
      (id, version_id, warehouse_id, domestic_shipping_cny, labeling_fee_cny, packaging_fee_cny, operation_fee_cny, priority)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id("pdr"), versionId, rule.warehouseId || "*", rule.domesticShippingCny || 0, rule.labelingFeeCny || 0, rule.packagingFeeCny || 0, rule.operationFeeCny || 0, rule.priority || 100]);
  }
  const d = config.defaults || {};
  await client.query(`INSERT INTO pricing_default_rules
    (version_id, ad_rate, withdrawal_rate, return_loss_rate, target_margin_rate, frontend_discount_rate, other_fixed_fee_cny, currency_code)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
  [versionId, d.adRate || 0, d.withdrawalRate ?? 3, d.returnLossRate ?? 2, d.targetMarginRate ?? 20, d.frontendDiscountRate ?? 50, d.otherFixedFeeCny || 0, d.currencyCode || "CNY"]);
  const fx = config.exchangeRate || {};
  await client.query(`INSERT INTO pricing_exchange_rates
    (id, version_id, base_currency, quote_currency, rate, source, quoted_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
  [id("pfx"), versionId, fx.baseCurrency || "CNY", fx.quoteCurrency || "RUB", fx.rate || 11.97, fx.source || "manual", fx.quotedAt || new Date().toISOString()]);
}

async function ensureBootstrap() {
  if (!postgresEnabled()) return;
  const pool = await getPostgresPool();
  const found = await pool.query("SELECT id FROM pricing_config_versions LIMIT 1");
  if (found.rows.length) return;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const config = structuredClone(DEFAULT_PRICING_CONFIG);
    await client.query(`INSERT INTO pricing_config_versions
      (id, version_no, scope_type, scope_id, status, rule_confirmation_status, effective_from, config_hash, note, created_at, updated_at, published_at)
      VALUES ($1,1,'global','','ACTIVE','UNCONFIRMED',$2,$3,$4,NOW(),NOW(),NOW())`,
    [config.id, config.effectiveFrom, jsonHash(config), config.note]);
    await replaceVersionChildren(client, config.id, config);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function listPricingVersions() {
  if (!postgresEnabled()) return memoryVersions.map((item) => ({ ...item, commissionRules: undefined, logisticsRules: undefined, domesticFeeRules: undefined }));
  await ensureBootstrap();
  const pool = await getPostgresPool();
  const result = await pool.query("SELECT * FROM pricing_config_versions ORDER BY created_at DESC");
  return result.rows.map(mapVersion);
}

export async function getPricingVersion(versionId) {
  if (!postgresEnabled()) return memoryVersions.find((item) => item.id === versionId) || null;
  await ensureBootstrap();
  const pool = await getPostgresPool();
  const row = await pool.query("SELECT * FROM pricing_config_versions WHERE id = $1", [versionId]);
  return row.rows[0] ? hydrateVersion(pool, row.rows[0]) : null;
}

export async function getActivePricingConfig({ accountId = "", storeId = "", at = new Date() } = {}) {
  if (!postgresEnabled()) return structuredClone(memoryVersions.find((item) => item.status === "ACTIVE") || DEFAULT_PRICING_CONFIG);
  await ensureBootstrap();
  const pool = await getPostgresPool();
  const result = await pool.query(`SELECT * FROM pricing_config_versions
    WHERE status IN ('ACTIVE','SCHEDULED')
      AND (effective_from IS NULL OR effective_from <= $1)
      AND (effective_to IS NULL OR effective_to > $1)
      AND ((scope_type = 'store' AND scope_id = $2) OR (scope_type = 'account' AND scope_id = $3) OR scope_type = 'global')
    ORDER BY CASE scope_type WHEN 'store' THEN 1 WHEN 'account' THEN 2 ELSE 3 END, effective_from DESC NULLS LAST, version_no DESC
    LIMIT 1`, [at, storeId || "", accountId || ""]);
  const config = result.rows[0] ? await hydrateVersion(pool, result.rows[0]) : structuredClone(DEFAULT_PRICING_CONFIG);
  return applyLiveExchangeRate(config);
}

export async function createPricingDraft(actorId, { scopeType = "global", scopeId = "", note = "", cloneVersionId = "" } = {}) {
  const base = cloneVersionId ? await getPricingVersion(cloneVersionId) : await getActivePricingConfig({ accountId: scopeType === "account" ? scopeId : "", storeId: scopeType === "store" ? scopeId : "" });
  const config = structuredClone(base || DEFAULT_PRICING_CONFIG);
  const versions = await listPricingVersions();
  const nextNo = Math.max(0, ...versions.filter((item) => item.scopeType === scopeType && item.scopeId === scopeId).map((item) => Number(item.versionNo) || 0)) + 1;
  config.id = id("pcv");
  config.versionNo = nextNo;
  config.scopeType = scopeType;
  config.scopeId = scopeId;
  config.status = "DRAFT";
  config.note = note || `版本 ${nextNo}`;
  config.effectiveFrom = null;
  config.effectiveTo = null;
  if (!postgresEnabled()) {
    config.configHash = jsonHash(config);
    memoryVersions.unshift(config);
    return config;
  }
  const pool = await getPostgresPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`INSERT INTO pricing_config_versions
      (id, version_no, scope_type, scope_id, status, rule_confirmation_status, config_hash, note, created_by)
      VALUES ($1,$2,$3,$4,'DRAFT',$5,$6,$7,$8)`,
    [
      config.id,
      nextNo,
      scopeType,
      scopeId,
      config.ruleConfirmationStatus === "CONFIRMED" ? "CONFIRMED" : "UNCONFIRMED",
      jsonHash(config),
      config.note,
      actorId || null,
    ]);
    await replaceVersionChildren(client, config.id, config);
    await writePricingAudit(client, {
      actorId,
      action: "PRICING_CONFIG_CREATED",
      versionId: config.id,
      metadata: { versionNo: nextNo, scopeType, scopeId, cloneVersionId: cloneVersionId || null },
    });
    await client.query("COMMIT");
    return getPricingVersion(config.id);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function createOfficialCommissionDraft(actorId, {
  cloneVersionId = "",
  parsedImports = [],
  archivedFiles = [],
  merged,
} = {}) {
  if (!postgresEnabled()) {
    throw Object.assign(new Error("官方佣金表导入需要 PostgreSQL 持久化环境"), {
      status: 503,
      code: "OFFICIAL_COMMISSION_POSTGRES_REQUIRED",
    });
  }
  if (!parsedImports.length || parsedImports.length !== archivedFiles.length || !merged?.rules?.length) {
    throw Object.assign(new Error("官方佣金表导入数据不完整"), { status: 422, code: "OFFICIAL_COMMISSION_IMPORT_INVALID" });
  }
  const sourceNames = parsedImports.map((item) => item.name).join("、");
  const draft = await createPricingDraft(actorId, {
    scopeType: "global",
    cloneVersionId,
    note: `Ozon 官方佣金表：${sourceNames}`,
  });
  try {
    await updatePricingDraft(draft.id, {
      ...draft,
      note: `Ozon 官方佣金表：${sourceNames}`,
      // 官方导入是完整替换，不继承通用 12% / 14% / 18% 规则。
      commissionRules: merged.rules,
    }, actorId);

    const pool = await getPostgresPool();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (let index = 0; index < parsedImports.length; index += 1) {
        const parsed = parsedImports[index];
        const archived = archivedFiles[index];
        const importId = id("poci");
        await client.query(`INSERT INTO pricing_official_imports (
          id,version_id,source_name,source_date,object_key,object_bucket,content_type,file_size,sha256,
          fulfillment_types,summary_rule_count,detail_mapping_count,metadata,created_by
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14)`, [
          importId, draft.id, parsed.name, parsed.sourceDate, archived.key, archived.bucket,
          archived.contentType, archived.size, archived.sha256, parsed.fulfillments,
          parsed.rules.length, parsed.mappings.length, JSON.stringify(parsed.metadata || {}), actorId || null,
        ]);
        await insertOfficialMappings(client, draft.id, importId, parsed.mappings);
      }
      await writePricingAudit(client, {
        actorId,
        action: "PRICING_OFFICIAL_COMMISSION_IMPORTED",
        versionId: draft.id,
        metadata: {
          sourceNames: parsedImports.map((item) => item.name),
          fulfillmentTypes: merged.fulfillmentTypes,
          categoryCount: merged.categoryCount,
          summaryRuleCount: merged.rules.length,
          detailMappingCount: merged.detailMappingCount,
          genericRulesRemoved: true,
        },
      });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    const config = await getPricingVersion(draft.id);
    return {
      config,
      summary: {
        fulfillmentTypes: merged.fulfillmentTypes,
        categoryCount: merged.categoryCount,
        summaryRuleCount: merged.rules.length,
        detailMappingCount: merged.detailMappingCount,
        genericRulesRemoved: true,
      },
    };
  } catch (error) {
    const pool = await getPostgresPool();
    await pool.query("DELETE FROM pricing_config_versions WHERE id = $1 AND status IN ('DRAFT','VALIDATED')", [draft.id]).catch(() => {});
    throw error;
  }
}

export async function updatePricingDraft(versionId, config, actorId = null) {
  const current = await getPricingVersion(versionId);
  if (!current) throw Object.assign(new Error("算价配置版本不存在"), { status: 404 });
  if (!["DRAFT", "VALIDATED"].includes(current.status)) throw Object.assign(new Error("只有草稿版本可以修改"), { status: 409 });
  const merged = { ...current, ...config, id: current.id, versionNo: current.versionNo, status: "DRAFT" };
  const validation = validatePricingConfig(merged);
  if (!postgresEnabled()) {
    memoryVersions = memoryVersions.map((item) => item.id === versionId ? { ...merged, configHash: jsonHash(merged) } : item);
    return { config: merged, validation };
  }
  const pool = await getPostgresPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await replaceVersionChildren(client, versionId, merged);
    await client.query(
      `UPDATE pricing_config_versions
       SET status='DRAFT', rule_confirmation_status=$2, note=$3, config_hash=$4, updated_at=NOW()
       WHERE id=$1`,
      [
        versionId,
        merged.ruleConfirmationStatus === "CONFIRMED" ? "CONFIRMED" : "UNCONFIRMED",
        merged.note || "",
        jsonHash(merged),
      ],
    );
    await writePricingAudit(client, {
      actorId,
      action: "PRICING_CONFIG_UPDATED",
      versionId,
      metadata: { versionNo: merged.versionNo, validation },
    });
    await client.query("COMMIT");
    return { config: await getPricingVersion(versionId), validation };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function validatePricingVersion(versionId, actorId = null) {
  const config = await getPricingVersion(versionId);
  if (!config) throw Object.assign(new Error("算价配置版本不存在"), { status: 404 });
  const validation = validatePricingConfig(config);
  if (validation.valid && postgresEnabled()) {
    const pool = await getPostgresPool();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("UPDATE pricing_config_versions SET status = 'VALIDATED', updated_at = NOW() WHERE id = $1 AND status IN ('DRAFT','VALIDATED')", [versionId]);
      await writePricingAudit(client, {
        actorId,
        action: "PRICING_CONFIG_VALIDATED",
        versionId,
        metadata: validation,
      });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  } else if (validation.valid) {
    memoryVersions = memoryVersions.map((item) => item.id === versionId ? { ...item, status: "VALIDATED" } : item);
  }
  return validation;
}

export async function publishPricingVersion(versionId, actorId, effectiveFrom = new Date().toISOString()) {
  const config = await getPricingVersion(versionId);
  if (!config) throw Object.assign(new Error("算价配置版本不存在"), { status: 404 });
  const validation = validatePricingConfig(config);
  if (!validation.valid) throw Object.assign(new Error(`配置校验失败：${validation.errors.join("；")}`), { status: 400 });
  const scheduled = new Date(effectiveFrom).getTime() > Date.now();
  const status = scheduled ? "SCHEDULED" : "ACTIVE";
  if (!postgresEnabled()) {
    memoryVersions = memoryVersions.map((item) => item.scopeType === config.scopeType && item.scopeId === config.scopeId && item.status === "ACTIVE" ? { ...item, status: "RETIRED" } : item.id === versionId ? { ...item, status, effectiveFrom, publishedAt: new Date().toISOString() } : item);
    return getPricingVersion(versionId);
  }
  const pool = await getPostgresPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (!scheduled) await client.query("UPDATE pricing_config_versions SET status = 'RETIRED', effective_to = $3, updated_at = NOW() WHERE scope_type = $1 AND scope_id = $2 AND status = 'ACTIVE' AND id <> $4", [config.scopeType, config.scopeId, effectiveFrom, versionId]);
    await client.query("UPDATE pricing_config_versions SET status = $2, effective_from = $3, published_by = $4, published_at = NOW(), updated_at = NOW() WHERE id = $1", [versionId, status, effectiveFrom, actorId || null]);
    await writePricingAudit(client, {
      actorId,
      action: scheduled ? "PRICING_CONFIG_SCHEDULED" : "PRICING_CONFIG_PUBLISHED",
      versionId,
      metadata: { status, effectiveFrom, scopeType: config.scopeType, scopeId: config.scopeId },
    });
    await client.query("COMMIT");
    return getPricingVersion(versionId);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function resolveOfficialTypeCommissionRules(config, input = {}) {
  if (!postgresEnabled() || !config?.officialImports?.length) return null;
  const names = [
    input.descriptiveTypeNameRu,
    input.descriptiveTypeRu,
    input.productTypeNameRu,
    input.typeNameRu,
    input.typeName,
  ].map((value) => String(value || "").trim()).filter(Boolean);
  if (!names.length) return null;
  const fulfillment = String(input.fulfillmentType || "RFBS").toUpperCase();
  const brand = String(input.brandName || input.brand || "").trim();
  const marketplaceCategory = String(input.marketplaceCategoryNameRu || input.marketplaceCategoryRu || "").trim();
  const pool = await getPostgresPool();
  const result = await pool.query(`SELECT * FROM pricing_official_category_mappings
    WHERE version_id = $1
      AND lower(descriptive_type_ru) = ANY($2::text[])
      AND tariff_json ? $3
      AND (brand_name = 'All' OR lower(brand_name) = lower($4))
      AND ($5 = '' OR lower(marketplace_category_ru) = lower($5))
    ORDER BY CASE WHEN lower(brand_name) = lower($4) AND $4 <> '' THEN 0 ELSE 1 END, created_at DESC
    LIMIT 50`, [config.id, names.map((name) => name.toLowerCase()), fulfillment, brand, marketplaceCategory]);
  const bestBrandRank = result.rows.length && brand && String(result.rows[0].brand_name).toLowerCase() === brand.toLowerCase() ? 0 : 1;
  const candidates = result.rows.filter((row) => (brand && String(row.brand_name).toLowerCase() === brand.toLowerCase() ? 0 : 1) === bestBrandRank);
  const categories = new Set(candidates.map((row) => String(row.marketplace_category_ru || "").toLowerCase()));
  // 同名商品类型跨多个官方类目时，缺少类目上下文就拒绝猜测，避免套错佣金。
  if (!marketplaceCategory && categories.size > 1) return null;
  const mapping = candidates[0];
  const bands = mapping?.tariff_json?.[fulfillment];
  if (!mapping || !Array.isArray(bands) || !bands.length) return null;
  const categoryId = `official:${mapping.id}`;
  return {
    categoryId,
    rules: bands.map((band, index) => ({
      id: `${mapping.id}:${fulfillment}:${index}`,
      ruleName: `${mapping.descriptive_type_zh || mapping.descriptive_type_ru} · ${fulfillment}`,
      ozonCategoryId: categoryId,
      fulfillmentType: fulfillment,
      minPriceRub: number(band.minPriceRub) || 0,
      maxPriceRub: number(band.maxPriceRub),
      commissionRate: number(band.commissionRate),
      priority: 1,
      sourceName: config.officialImports.find((item) => item.id === mapping.source_import_id)?.sourceName || "Ozon official",
      sourceDate: config.officialImports.find((item) => item.id === mapping.source_import_id)?.sourceDate || null,
      marketplaceCategoryRu: mapping.marketplace_category_ru,
      descriptiveTypeRu: mapping.descriptive_type_ru,
      brandName: mapping.brand_name,
    })),
  };
}

export async function calculateWithActivePricing(input, context = {}) {
  const storedConfig = input.configVersionId ? await getPricingVersion(input.configVersionId) : await getActivePricingConfig(context);
  const config = await applyLiveExchangeRate(storedConfig);
  if (!config) {
    throw Object.assign(new Error("算价配置版本不存在"), { status: 404, code: "PRICING_CONFIG_NOT_FOUND" });
  }
  if (config.ruleConfirmationStatus !== "CONFIRMED") {
    throw Object.assign(new Error("算价规则依据尚未确认，请管理员核对佣金、物流、汇率和费用来源"), {
      status: 409,
      code: "PRICING_RULES_UNCONFIRMED",
    });
  }
  const scopeType = String(config.scopeType || "global");
  const scopeId = String(config.scopeId || "");
  const allowed = scopeType === "global"
    || (scopeType === "account" && scopeId && scopeId === String(context.accountId || ""))
    || (scopeType === "store" && scopeId && scopeId === String(context.storeId || ""));
  if (!allowed) {
    throw Object.assign(new Error("算价配置版本不属于当前账号或经营店铺"), {
      status: 403,
      code: "PRICING_CONFIG_SCOPE_FORBIDDEN",
    });
  }
  const runtimeInput = config.exchangeRate?.dynamic
    ? { ...input, exchangeRate: Number(config.exchangeRate.rate) }
    : input;
  const officialTypeRules = await resolveOfficialTypeCommissionRules(config, runtimeInput);
  const effectiveInput = officialTypeRules
    ? { ...runtimeInput, categoryId: officialTypeRules.categoryId }
    : runtimeInput.marketplaceCategoryNameRu
      ? { ...runtimeInput, categoryId: String(runtimeInput.marketplaceCategoryNameRu) }
      : runtimeInput;
  const effectiveConfig = officialTypeRules
    ? { ...config, commissionRules: officialTypeRules.rules }
    : config;
  const result = calculatePricing(effectiveConfig, effectiveInput);
  return { config, result };
}

export async function savePricingSnapshot({ accountId = null, storeId = null, productId = null, draftId = null, submissionSnapshotId = null, input, result, config }) {
  const snapshot = { id: id("pcs"), accountId, storeId, productId, draftId, submissionSnapshotId, configVersionId: config.id, mode: result.mode, input, result, config, createdAt: new Date().toISOString() };
  if (!postgresEnabled()) return snapshot;
  const pool = await getPostgresPool();
  await pool.query(`INSERT INTO pricing_calculation_snapshots
    (id, account_id, store_id, product_id, draft_id, submission_snapshot_id, config_version_id, mode, input_json, result_json, config_snapshot_json)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb)`,
  [snapshot.id, accountId, storeId, productId, draftId, submissionSnapshotId, config.id, result.mode, JSON.stringify(input), JSON.stringify(result), JSON.stringify(config)]);
  if (draftId) {
    await pool.query("UPDATE product_drafts SET pricing_snapshot = $2::jsonb, updated_at = NOW() WHERE id = $1", [draftId, JSON.stringify(snapshot)]);
  }
  if (submissionSnapshotId) {
    await pool.query("UPDATE submission_snapshots SET pricing_snapshot = $2::jsonb WHERE id = $1", [submissionSnapshotId, JSON.stringify(snapshot)]);
  }
  return snapshot;
}
