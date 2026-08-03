function configured(name) {
  return Boolean(String(process.env[name] || "").trim());
}

export function autoListingEnabled(env = process.env) {
  const value = String(env?.AUTO_LISTING_ENABLED || "").trim().toLowerCase();
  return value === "1" || value === "true";
}

export function autoListingAiEnabled(env = process.env) {
  const value = String(env?.AUTO_LISTING_AI_ENABLED || "").trim().toLowerCase();
  return value === "1" || value === "true";
}

function aiConfigurationError(code) {
  const error = new Error(code);
  error.code = code;
  error.status = 500;
  return error;
}

export function assertAutoListingAiRuntimeConfiguration({ env = process.env, profile = null } = {}) {
  if (!autoListingAiEnabled(env)) return null;
  const profileId = String(env?.AUTO_LISTING_AI_PROFILE_ID || "").trim();
  if (!profileId) throw aiConfigurationError("AUTO_LISTING_AI_PROFILE_REQUIRED");
  const storedProfileId = String(profile?.id || "").trim();
  if (!storedProfileId || storedProfileId !== profileId) throw aiConfigurationError("AUTO_LISTING_AI_PROFILE_MISMATCH");
  const configVersion = Number(profile?.configVersion ?? profile?.config_version);
  if (!Number.isInteger(configVersion) || configVersion < 1) throw aiConfigurationError("AUTO_LISTING_AI_PROFILE_INVALID");
  if (profile?.enabled !== true) throw aiConfigurationError("AUTO_LISTING_AI_PROFILE_NOT_ENABLED");
  const envName = String(profile?.apiKeyEnvName ?? profile?.api_key_env_name ?? "").trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(envName)
    || ["__proto__", "prototype", "constructor"].includes(envName.toLowerCase())) {
    throw aiConfigurationError("AUTO_LISTING_AI_PROFILE_INVALID");
  }
  if (!envName || !String(env?.[envName] || "").trim()) throw aiConfigurationError("AUTO_LISTING_AI_SECRET_REQUIRED");
  return Object.freeze({ profileId, configVersion });
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
  if (autoListingAiEnabled(process.env) && !configured("AUTO_LISTING_AI_PROFILE_ID")) {
    errors.push("启用自动上架 AI 时必须配置 AUTO_LISTING_AI_PROFILE_ID");
  }
  if (errors.length) {
    throw new Error(`正式环境配置不合格：${errors.join("；")}`);
  }
}
