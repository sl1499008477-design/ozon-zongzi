// Ordinary checks must not inherit a running application's data or credentials.
// Database/paid end-to-end tests are separate, explicit entry points.
export function isolatedTestEnvironment(environment, dataDir) {
  const env = { ...environment };
  for (const key of Object.keys(env)) {
    if (/^(DATABASE_URL$|POSTGRES_|PG|MINIO_|AUTO_LISTING_|SUB2API_|SONLI_|APP_ENCRYPTION_|QH_LOCAL_|LISTING_|NODE_OPTIONS$)/.test(key)
      || /(?:_DATABASE_URL|_DSN|_KEY|_TOKEN|_PASSWORD|_SECRET)$/.test(key)) {
      delete env[key];
    }
  }
  return {
    ...env,
    QH_LOCAL_DATA_DIR: dataDir,
    QH_LOCAL_NO_DOTENV: "1",
    QH_LOCAL_NO_LISTEN: "1",
    LISTING_PIPELINE_V3: "0",
    AUTO_LISTING_AI_ENABLED: "false",
    AUTO_LISTING_UPLOAD_ENABLED: "false",
    AUTO_LISTING_DIRECT_UPLOAD_ALLOWED: "false",
  };
}
