function configured(name) {
  return Boolean(String(process.env[name] || "").trim());
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
  if (errors.length) {
    throw new Error(`正式环境配置不合格：${errors.join("；")}`);
  }
}
