import {
  AUTO_LISTING_OZON_RICH_CONTENT_VERSION,
  isVerifiedAutoListingOzonRichContentVersion,
} from "./auto-listing-ozon-rich-content.mjs";
import {
  assertAutoListingAiRuntimeConfiguration,
  autoListingAiEnabled,
  autoListingEnabled,
  autoListingUploadEnabled,
} from "./runtime-config.mjs";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/u;

function notReady() {
  const error = new Error("自动上架直接上传运行条件尚未满足");
  error.code = "AUTO_LISTING_DIRECT_SYSTEM_HEALTH_NOT_READY";
  error.status = 503;
  error.retryable = true;
  return error;
}

function enabled(value) {
  return ["1", "true"].includes(String(value ?? "").trim().toLowerCase());
}

function capableProfile(row) {
  const result = row?.capability_result;
  const features = Array.isArray(result?.features) ? result.features : [];
  const checkedAt = row?.capability_checked_at instanceof Date
    ? row.capability_checked_at.toISOString() : String(row?.capability_checked_at || "");
  return row?.enabled === true && result?.outcome === "PASSED"
    && features.includes("STRUCTURED_TEXT") && features.includes("IMAGE_GENERATION")
    && features.some((feature) => ["IMAGE_DECODE_PNG", "IMAGE_DECODE_JPEG", "IMAGE_DECODE_WEBP"].includes(feature))
    && result?.models?.text === row.text_model && result?.models?.image === row.image_model
    && typeof result?.checkedAt === "string" && result.checkedAt === checkedAt;
}

export function createAutoListingDirectSystemReadiness({
  env = process.env,
  resolvePool,
  richContentContractVersion = AUTO_LISTING_OZON_RICH_CONTENT_VERSION,
} = {}) {
  if (!env || typeof env !== "object" || Array.isArray(env) || typeof resolvePool !== "function"
    || typeof richContentContractVersion !== "string" || !richContentContractVersion.trim()) {
    throw new TypeError("Auto-listing direct readiness dependencies are required");
  }
  return async function assertDirectSystemReady({ accountId } = {}) {
    const scope = typeof accountId === "string" ? accountId.trim() : "";
    if (!SAFE_ID.test(scope) || !autoListingEnabled(env) || !autoListingAiEnabled(env)
      || !autoListingUploadEnabled(env) || !enabled(env.AUTO_LISTING_DIRECT_UPLOAD_ALLOWED)
      || String(env.LISTING_PIPELINE_V3 ?? "1").trim() === "0"
      || !isVerifiedAutoListingOzonRichContentVersion(richContentContractVersion)) throw notReady();
    try {
      const pool = await resolvePool();
      if (typeof pool?.query !== "function") throw notReady();
      const [account, profiles, strategies] = await Promise.all([
        pool.query("SELECT id FROM accounts WHERE id=$1", [scope]),
        pool.query(
          `SELECT id,account_id,config_version,base_url,api_key_env_name,text_protocol,image_protocol,
                  text_model,image_model,enabled,capability_result,capability_checked_at
             FROM ai_gateway_profiles
            WHERE account_id=$1 AND enabled IS TRUE
            ORDER BY id ASC`,
          [scope],
        ),
        pool.query(
          `SELECT version.id
             FROM ai_content_strategy_versions AS version
            WHERE version.account_id=$1 AND version.status='PUBLISHED'
              AND EXISTS (
                SELECT 1 FROM ai_content_strategy_rules AS rule
                 WHERE rule.account_id=version.account_id AND rule.strategy_version_id=version.id
              )
            ORDER BY version.version DESC,version.id ASC`,
          [scope],
        ),
      ]);
      if (account?.rows?.length !== 1 || profiles?.rows?.length !== 1
        || strategies?.rows?.length < 1 || !capableProfile(profiles.rows[0])) throw notReady();
      assertAutoListingAiRuntimeConfiguration({ env, profile: profiles.rows[0] });
      return Object.freeze({ ready: true });
    } catch (error) {
      if (error?.code === "AUTO_LISTING_DIRECT_SYSTEM_HEALTH_NOT_READY") throw error;
      throw notReady();
    }
  };
}
