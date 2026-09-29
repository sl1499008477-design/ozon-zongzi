let poolPromise = null;
const closingByInitialization = new Map();
let closingWithoutPoolPromise = null;

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
  const required = ["POSTGRES_HOST", "POSTGRES_DB", "POSTGRES_USER", "POSTGRES_PASSWORD"];
  const missing = required.filter((name) => !String(process.env[name] || "").trim());
  if (missing.length) {
    throw new Error(`PostgreSQL 已启用但缺少配置：${missing.join("、")}`);
  }
  return {
    host: process.env.POSTGRES_HOST,
    port: Number(process.env.POSTGRES_PORT || 5432),
    database: process.env.POSTGRES_DB,
    user: process.env.POSTGRES_USER,
    password: process.env.POSTGRES_PASSWORD,
    ssl: postgresSslConfig(),
  };
}

export async function getPostgresPool() {
  if (!poolPromise) {
    const initialization = import("pg")
      .then(({ Pool, Query }) => {
        const pool = new Pool({ ...postgresConfig(), max: Number(process.env.POSTGRES_POOL_MAX || 10) });
        const connectionErrors = new WeakMap();
        const onConnectionError = (error, client) => {
          if (connectionErrors.has(client)) return;
          connectionErrors.set(client, error);
          // Do not log the Error/Client object: pg adds connection details to it.
          console.error("[PostgreSQL] connection lost", { code: error.code, message: error.message });
        };
        pool.on("error", onConnectionError);
        pool.on("connect", (client) => {
          // pg removes its idle error listener while a client is checked out.
          client.on("error", (error) => onConnectionError(error, client));
          const query = client.query;
          client.query = function (config, values, callback) {
            const error = connectionErrors.get(client);
            if (!error) return query.call(this, config, values, callback);
            // A held transaction may lose its connection between queries. Return
            // that original failure on COMMIT/ROLLBACK too, without sending SQL.
            const failedQuery = typeof config?.submit === "function" ? config : new Query(config, values, callback);
            if (!failedQuery.callback) {
              failedQuery.callback = typeof values === "function" ? values : callback;
            }
            if (failedQuery.callback || failedQuery === config) {
              process.nextTick(() => failedQuery.handleError(error, client.connection));
              return failedQuery === config ? failedQuery : undefined;
            }
            return Promise.reject(error);
          };
          // pg marks errored clients non-queryable and discards them on release;
          // idle clients are removed before the pool emits its error event.
        });
        return pool;
      })
      .catch((error) => {
        throw new Error(`PostgreSQL 依赖未安装或不可用，请先执行 pnpm install。原始错误: ${error.message}`);
      });
    poolPromise = initialization;
    initialization.catch(() => {
      if (poolPromise === initialization) poolPromise = null;
    });
  }
  return poolPromise;
}

export function closePostgresPool() {
  const initialization = poolPromise;
  if (!initialization) return closingWithoutPoolPromise || Promise.resolve();
  const existing = closingByInitialization.get(initialization);
  if (existing) return existing;
  const closing = (async () => {
    let pool;
    try {
      pool = await initialization;
    } catch {
      if (poolPromise === initialization) poolPromise = null;
      return;
    }
    if (poolPromise === initialization) poolPromise = null;
    await pool.end();
  })();
  closingByInitialization.set(initialization, closing);
  closingWithoutPoolPromise = closing;
  const clearClosing = () => {
    if (closingByInitialization.get(initialization) === closing) closingByInitialization.delete(initialization);
    if (closingWithoutPoolPromise === closing) closingWithoutPoolPromise = null;
  };
  closing.then(clearClosing, clearClosing);
  return closing;
}
