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
import {
  createSub2ApiGatewayPolicy,
  requireSub2ApiGatewayPolicy,
} from "./sub2api-gateway-boundary.mjs";

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

function assertEncryptedProfileConfiguration(env, profile) {
  const connectionId = typeof profile?.connection_id === "string" ? profile.connection_id.trim() : "";
  const connectionVersion = Number(profile?.connection_version);
  if (profile?.api_key_env_name !== "SUB2API_ENCRYPTED_KEY" || !SAFE_ID.test(connectionId)
    || !Number.isSafeInteger(connectionVersion) || connectionVersion < 1
    || profile?.connection_status !== "ACTIVE" || profile?.connection_bound !== true
    || profile?.connection_base_url !== profile?.base_url) throw notReady();
  const allowLocalGateway = enabled(env.AUTO_LISTING_AI_ALLOW_LOCAL_GATEWAY);
  if (allowLocalGateway && String(env.NODE_ENV || "").trim().toLowerCase() === "production") throw notReady();
  const list = (name) => String(env?.[name] || "").split(",").map((value) => value.trim()).filter(Boolean);
  try {
    const policy = createSub2ApiGatewayPolicy({
      allowedSecretEnvNames: [...list("AUTO_LISTING_AI_ALLOWED_SECRET_ENV_NAMES"), "SUB2API_ENCRYPTED_KEY"],
      allowedGatewayBaseUrls: list("AUTO_LISTING_AI_ALLOWED_GATEWAY_BASE_URLS"),
      allowedGatewayOrigins: list("AUTO_LISTING_AI_ALLOWED_GATEWAY_ORIGINS"),
      allowLocalGateway,
    });
    requireSub2ApiGatewayPolicy(profile, policy);
  } catch {
    throw notReady();
  }
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
          `SELECT p.id,p.account_id,p.config_version,p.base_url,p.api_key_env_name,
                  p.text_protocol,p.image_protocol,p.text_model,p.image_model,p.enabled,
                  p.capability_result,p.capability_checked_at,p.connection_id,p.connection_version,
                  c.status AS connection_status,c.base_url AS connection_base_url,
                  c.id IS NOT NULL AS connection_bound
             FROM ai_gateway_profiles p
             LEFT JOIN ai_gateway_connection_versions c
               ON c.account_id=p.account_id AND c.id=p.connection_id AND c.version=p.connection_version
              AND c.status='ACTIVE'
            WHERE p.account_id=$1 AND p.enabled IS TRUE
            ORDER BY p.id ASC`,
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
      if (profiles.rows[0].api_key_env_name === "SUB2API_ENCRYPTED_KEY") {
        assertEncryptedProfileConfiguration(env, profiles.rows[0]);
      } else {
        if (profiles.rows[0].connection_id !== null && profiles.rows[0].connection_id !== undefined) throw notReady();
        assertAutoListingAiRuntimeConfiguration({ env, profile: profiles.rows[0] });
      }
      return Object.freeze({ ready: true });
    } catch (error) {
      if (error?.code === "AUTO_LISTING_DIRECT_SYSTEM_HEALTH_NOT_READY") throw error;
      throw notReady();
    }
  };
}
