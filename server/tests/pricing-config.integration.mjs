import assert from "node:assert/strict";
import crypto from "node:crypto";
import "./support/dedicated-postgres-test-environment.mjs";
import { closePostgresPool, getPostgresPool, postgresEnabled } from "../db/connection.mjs";
import { runMigrations } from "../db/migrate.mjs";
import {
  createPricingDraft,
  getPricingVersion,
  publishPricingVersion,
  updatePricingDraft,
  validatePricingVersion,
  calculateWithActivePricing,
} from "../pricing-config-service.mjs";

if (!postgresEnabled()) {
  console.log("pricing config integration test skipped: PostgreSQL disabled");
  process.exit(0);
}

const scopeId = `pricing_qa_${crypto.randomUUID()}`;
let versionId = "";

try {
  await runMigrations(await getPostgresPool());
  const draft = await createPricingDraft(null, {
    scopeType: "account",
    scopeId,
    note: "自动化验证临时版本",
  });
  versionId = draft.id;
  assert.equal(draft.status, "DRAFT");
  await assert.rejects(
    () => calculateWithActivePricing({ configVersionId: versionId }, { accountId: scopeId }),
    (error) => error?.status === 409 && error?.code === "PRICING_RULES_UNCONFIRMED",
  );

  const updated = await updatePricingDraft(versionId, {
    ...draft,
    note: "自动化验证已保存",
    ruleConfirmationStatus: "CONFIRMED",
    defaults: { ...draft.defaults, targetMarginRate: 23 },
  });
  assert.equal(updated.config.defaults.targetMarginRate, 23);
  assert.equal(updated.validation.valid, true);

  const validation = await validatePricingVersion(versionId);
  assert.equal(validation.valid, true);

  const effectiveFrom = new Date(Date.now() + 86_400_000).toISOString();
  const published = await publishPricingVersion(versionId, null, effectiveFrom);
  assert.equal(published.status, "SCHEDULED");

  const commissionRule = updated.config.commissionRules.find(
    (rule) => rule.fulfillmentType === "RFBS" && Number(rule.minPriceRub) === 0,
  );
  assert.ok(commissionRule, "临时草稿应包含一条 RFBS 低价档规则");
  const exchangeRate = Number(updated.config.exchangeRate.rate);
  const sellingPriceCny = 1_000 / exchangeRate;

  const pricingInput = {
    configVersionId: versionId,
    mode: "profit",
    sellingPriceCny,
    purchaseCostCny: 25,
    weightG: 600,
    logisticsProvider: "XY",
    fulfillmentType: commissionRule.fulfillmentType,
    categoryId: commissionRule.ozonCategoryId,
  };
  const { result } = await calculateWithActivePricing(pricingInput, { accountId: scopeId });
  assert.equal(result.configVersionId, versionId);
  assert.ok(Number.isFinite(result.netProfitCny));
  await assert.rejects(
    () => calculateWithActivePricing(pricingInput, { accountId: "another-account" }),
    (error) => error?.status === 403 && error?.code === "PRICING_CONFIG_SCOPE_FORBIDDEN",
  );

  const pool = await getPostgresPool();
  const audit = await pool.query(
    "SELECT action FROM audit_events WHERE entity_type = 'pricing_config' AND entity_id = $1",
    [versionId],
  );
  assert.deepEqual(
    new Set(audit.rows.map((row) => row.action)),
    new Set([
      "PRICING_CONFIG_CREATED",
      "PRICING_CONFIG_UPDATED",
      "PRICING_CONFIG_VALIDATED",
      "PRICING_CONFIG_SCHEDULED",
    ]),
  );

  console.log("pricing config integration test passed");
} finally {
  if (versionId) {
    const pool = await getPostgresPool();
    await pool.query("DELETE FROM audit_events WHERE entity_type = 'pricing_config' AND entity_id = $1", [versionId]);
    await pool.query("DELETE FROM pricing_config_versions WHERE id = $1", [versionId]);
  }
  await closePostgresPool();
}
