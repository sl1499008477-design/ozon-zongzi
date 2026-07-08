let poolPromise = null;

export function postgresEnabled() {
  return Boolean(process.env.DATABASE_URL || process.env.POSTGRES_HOST);
}

export function postgresSslConfig() {
  const value = String(process.env.POSTGRES_SSL || "false").toLowerCase();
  return value === "1" || value === "true" ? { rejectUnauthorized: false } : false;
}

export function postgresConfig() {
  if (process.env.DATABASE_URL) {
    return {
      connectionString: process.env.DATABASE_URL,
      ssl: postgresSslConfig(),
    };
  }
  return {
    host: process.env.POSTGRES_HOST || "127.0.0.1",
    port: Number(process.env.POSTGRES_PORT || 5432),
    database: process.env.POSTGRES_DB || "sonli_local",
    user: process.env.POSTGRES_USER || "sonli",
    password: process.env.POSTGRES_PASSWORD || "sonli_password",
    ssl: postgresSslConfig(),
  };
}

export async function getPostgresPool() {
  if (!poolPromise) {
    poolPromise = import("pg")
      .then(({ Pool }) => new Pool(postgresConfig()))
      .catch((error) => {
        throw new Error(`PostgreSQL 依赖未安装或不可用，请先执行 pnpm install。原始错误: ${error.message}`);
      });
  }
  return poolPromise;
}

export async function closePostgresPool() {
  if (!poolPromise) return;
  const pool = await poolPromise;
  poolPromise = null;
  await pool.end();
}
