import { isIP } from "node:net";

function configured(name) {
  return Boolean(String(process.env[name] || "").trim());
}

const AUTO_LISTING_EXCEL_DEFAULTS = Object.freeze({ maxBytes: 2_097_152, maxRows: 1_000 });
const AUTO_LISTING_EXCEL_MAXIMUMS = Object.freeze({ maxBytes: 64 * 1024 * 1024, maxRows: 100_000 });

function configuredPositiveInteger(env, name, fallback, maximum) {
  const raw = String(env?.[name] ?? "").trim();
  if (!raw) return fallback;
  if (!/^[1-9]\d*$/u.test(raw)) throw aiConfigurationError("AUTO_LISTING_EXCEL_LIMIT_INVALID");
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > maximum) {
    throw aiConfigurationError("AUTO_LISTING_EXCEL_LIMIT_INVALID");
  }
  return value;
}

export function autoListingExcelImportLimits(env = process.env) {
  return Object.freeze({
    maxBytes: configuredPositiveInteger(env, "AUTO_LISTING_EXCEL_MAX_BYTES",
      AUTO_LISTING_EXCEL_DEFAULTS.maxBytes, AUTO_LISTING_EXCEL_MAXIMUMS.maxBytes),
    maxRows: configuredPositiveInteger(env, "AUTO_LISTING_EXCEL_MAX_ROWS",
      AUTO_LISTING_EXCEL_DEFAULTS.maxRows, AUTO_LISTING_EXCEL_MAXIMUMS.maxRows),
  });
}

export function autoListingExcelRequestBodyLimit(limits) {
  if (!Number.isSafeInteger(limits?.maxBytes) || limits.maxBytes < 1
    || limits.maxBytes > AUTO_LISTING_EXCEL_MAXIMUMS.maxBytes) {
    throw aiConfigurationError("AUTO_LISTING_EXCEL_LIMIT_INVALID");
  }
  return (Math.ceil(limits.maxBytes / 3) * 4) + (256 * 1024);
}

export function autoListingEnabled(env = process.env) {
  const value = String(env?.AUTO_LISTING_ENABLED || "").trim().toLowerCase();
  return value === "1" || value === "true";
}

export function autoListingAiEnabled(env = process.env) {
  const value = String(env?.AUTO_LISTING_AI_ENABLED || "").trim().toLowerCase();
  return value === "1" || value === "true";
}

export function autoListingSourceImageIntelligenceEnabled(env = process.env) {
  const value = env?.AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_V1_ENABLED;
  if (value === undefined || value === null || String(value).trim() === "") return false;
  if (typeof value === "boolean") return value;
  if (String(value).trim() === "true") return true;
  if (String(value).trim() === "false") return false;
  throw aiConfigurationError("AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_CONFIG_INVALID");
}

export function autoListingUploadEnabled(env = process.env) {
  const value = String(env?.AUTO_LISTING_UPLOAD_ENABLED || "").trim().toLowerCase();
  return value === "1" || value === "true";
}

export function listingAssetPublicationConfig(env = process.env) {
  if (!autoListingUploadEnabled(env)) return null;
  return listingAssetPublicationLocation(env);
}

export function listingMediaStorageConfig(env = process.env) {
  const provider = String(env.LISTING_MEDIA_STORAGE || "minio").trim().toLowerCase();
  if (!provider || provider === "minio") return Object.freeze({ provider: "minio" });
  if (provider !== "cos") throw aiConfigurationError("LISTING_MEDIA_STORAGE_CONFIG_INVALID");
  const bucket = String(env.LISTING_COS_BUCKET || "").trim();
  const region = String(env.LISTING_COS_REGION || "").trim();
  const secretId = String(env.LISTING_COS_SECRET_ID || "").trim();
  const secretKey = String(env.LISTING_COS_SECRET_KEY || "").trim();
  if (!bucket || !region || !secretId || !secretKey) throw aiConfigurationError("LISTING_MEDIA_STORAGE_CONFIG_INVALID");
  return Object.freeze({ provider, bucket, region, secretId, secretKey });
}

// Shared storage location only; each independent workflow owns its upload policy.
export function listingAssetPublicationLocation(env = process.env) {
  const rawBaseUrl = String(env?.LISTING_ASSET_PUBLIC_BASE_URL || "").trim();
  const prefix = String(env?.LISTING_ASSET_PUBLIC_PREFIX || "listing-media/v1").trim();
  const publicationVersion = String(env?.LISTING_ASSET_PUBLICATION_VERSION || "LISTING_MEDIA_V1").trim();
  let parsed;
  try { parsed = new URL(rawBaseUrl); } catch { throw aiConfigurationError("LISTING_ASSET_PUBLICATION_CONFIG_INVALID"); }
  const hostname = parsed.hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash
    || !hostname.includes(".") || hostname === "localhost" || hostname.endsWith(".localhost")
    || hostname.endsWith(".local") || hostname.endsWith(".internal") || isIP(hostname) !== 0
    || !/^[A-Za-z0-9][A-Za-z0-9/_-]{0,159}$/u.test(prefix) || prefix.includes("//") || prefix.endsWith("/")
    || !/^[A-Z0-9][A-Z0-9_-]{0,63}$/u.test(publicationVersion)) {
    throw aiConfigurationError("LISTING_ASSET_PUBLICATION_CONFIG_INVALID");
  }
  const baseUrl = parsed.toString().endsWith("/") ? parsed.toString() : `${parsed.toString()}/`;
  return Object.freeze({ baseUrl, prefix, publicationVersion });
}

function aiConfigurationError(code) {
  const error = new Error(code);
  error.code = code;
  error.status = 500;
  return error;
}

export function assertAutoListingAiRuntimeConfiguration({ env = process.env, profile = null } = {}) {
  if (!autoListingAiEnabled(env)) return null;
  const storedProfileId = String(profile?.id || "").trim();
  if (!storedProfileId) throw aiConfigurationError("AUTO_LISTING_AI_PROFILE_REQUIRED");
  const configVersion = Number(profile?.configVersion ?? profile?.config_version);
  if (!Number.isInteger(configVersion) || configVersion < 1) throw aiConfigurationError("AUTO_LISTING_AI_PROFILE_INVALID");
  if (profile?.enabled !== true) throw aiConfigurationError("AUTO_LISTING_AI_PROFILE_NOT_ENABLED");
  const envName = String(profile?.apiKeyEnvName ?? profile?.api_key_env_name ?? "").trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(envName)
    || ["__proto__", "prototype", "constructor"].includes(envName.toLowerCase())) {
    throw aiConfigurationError("AUTO_LISTING_AI_PROFILE_INVALID");
  }
  if (!envName || !String(env?.[envName] || "").trim()) throw aiConfigurationError("AUTO_LISTING_AI_SECRET_REQUIRED");
  try {
    const list = (name) => String(env?.[name] || "").split(",").map((value) => value.trim()).filter(Boolean);
    const policy = createSub2ApiGatewayPolicy({
      allowedSecretEnvNames: list("AUTO_LISTING_AI_ALLOWED_SECRET_ENV_NAMES"),
      allowedGatewayBaseUrls: list("AUTO_LISTING_AI_ALLOWED_GATEWAY_BASE_URLS"),
      allowedGatewayOrigins: list("AUTO_LISTING_AI_ALLOWED_GATEWAY_ORIGINS"),
    });
    requireSub2ApiGatewayPolicy(profile, policy);
  } catch {
    throw aiConfigurationError("AUTO_LISTING_AI_PROFILE_INVALID");
  }
  return Object.freeze({ profileId: storedProfileId, configVersion });
}

function secureSecret(name, minimumLength) {
  const value = String(process.env[name] || "");
  return value.length >= minimumLength
    && !/(replace|change|example|default|password|secret)/i.test(value);
}

export function assertProductionConfiguration(role = "api") {
  if (process.env.NODE_ENV !== "production") return;
  const errors = [];
  if (!configured("DATABASE_URL") && !configured("POSTGRES_HOST")) errors.push("必须配置 PostgreSQL");
  if (!secureSecret("APP_ENCRYPTION_KEY", 32)) {
    errors.push("APP_ENCRYPTION_KEY 必须是至少 32 字符的随机密钥");
  }
  if (!secureSecret("POSTGRES_PASSWORD", 16)) {
    errors.push("POSTGRES_PASSWORD 必须是至少 16 字符的随机密码");
  }
  if (role === "api") {
    if (!secureSecret("SONLI_ADMIN_PASSWORD", 12)) errors.push("必须配置至少 12 字符的随机管理员密码");
    for (const name of ["MINIO_ENDPOINT", "MINIO_ACCESS_KEY", "MINIO_SECRET_KEY", "MINIO_BUCKET"]) {
      if (!configured(name)) errors.push(`必须配置 ${name}`);
    }
    if (!secureSecret("MINIO_SECRET_KEY", 16)) {
      errors.push("MINIO_SECRET_KEY 必须是至少 16 字符的随机密码");
    }
  }
  if (String(process.env.LISTING_PIPELINE_V3 || "1") === "0") errors.push("正式环境不能禁用 LISTING_PIPELINE_V3");
  if (autoListingUploadEnabled(process.env)) {
    try { listingAssetPublicationConfig(process.env); } catch {
      errors.push("启用自动上架上传时必须配置可公开访问的 HTTPS 图片地址");
    }
  }
  if (errors.length) {
    throw new Error(`正式环境配置不合格：${errors.join("；")}`);
  }
}
import {
  createSub2ApiGatewayPolicy,
  requireSub2ApiGatewayPolicy,
} from "./sub2api-gateway-boundary.mjs";
