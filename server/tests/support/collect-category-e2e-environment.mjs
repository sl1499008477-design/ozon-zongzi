import path from "node:path";

export const COLLECT_CATEGORY_E2E_DATABASE_ENVIRONMENT_KEYS = Object.freeze([
  "DATABASE_URL",
  "POSTGRES_HOST",
  "POSTGRES_PORT",
  "POSTGRES_DB",
  "POSTGRES_USER",
  "POSTGRES_PASSWORD",
  "POSTGRES_SSL",
  "POSTGRES_STATE_TABLE",
  "PG_BOSS_SCHEMA",
  "PG_BOSS_APPLICATION_NAME",
  "PG_BOSS_POOL_SIZE",
]);

export function isolateCollectCategoryE2EEnvironment({ dataDir } = {}) {
  const isolatedDataDir = path.resolve(String(dataDir || ""));
  if (!path.isAbsolute(isolatedDataDir) || !String(dataDir || "").trim()) {
    throw new TypeError("an absolute E2E temporary data directory is required");
  }
  for (const key of COLLECT_CATEGORY_E2E_DATABASE_ENVIRONMENT_KEYS) {
    delete process.env[key];
  }
  process.env.QH_LOCAL_DATA_DIR = isolatedDataDir;
  process.env.QH_LOCAL_NO_DOTENV = "1";
  process.env.QH_LOCAL_NO_LISTEN = "1";
  process.env.LISTING_PIPELINE_V3 = "0";
  return Object.freeze({
    dataDir: isolatedDataDir,
    databaseEnvironmentKeys: COLLECT_CATEGORY_E2E_DATABASE_ENVIRONMENT_KEYS,
  });
}
