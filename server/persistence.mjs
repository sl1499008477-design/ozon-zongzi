import { promises as fs } from "node:fs";

const STATE_ROW_ID = "local-state";
let poolPromise = null;
let schemaReady = false;

function postgresEnabled() {
  return Boolean(process.env.DATABASE_URL || process.env.POSTGRES_HOST);
}

function stateTableName() {
  const name = process.env.POSTGRES_STATE_TABLE || "local_state";
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error("POSTGRES_STATE_TABLE 只能包含字母、数字和下划线");
  }
  return name;
}

function postgresConfig() {
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

function postgresSslConfig() {
  const value = String(process.env.POSTGRES_SSL || "false").toLowerCase();
  return value === "1" || value === "true" ? { rejectUnauthorized: false } : false;
}

async function getPool() {
  if (!poolPromise) {
    poolPromise = import("pg")
      .then(({ Pool }) => new Pool(postgresConfig()))
      .catch((error) => {
        throw new Error(`PostgreSQL 依赖未安装或不可用，请先执行 pnpm install。原始错误: ${error.message}`);
      });
  }
  return poolPromise;
}

async function ensureSchema(pool) {
  if (schemaReady) return;
  const table = stateTableName();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${table} (
      id TEXT PRIMARY KEY,
      state JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  schemaReady = true;
}

async function readJsonState(dataFile) {
  try {
    const raw = await fs.readFile(dataFile, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export function persistenceMode() {
  return postgresEnabled() ? "postgres" : "json";
}

export async function loadPersistedState({ dataFile }) {
  if (!postgresEnabled()) return readJsonState(dataFile);

  const pool = await getPool();
  await ensureSchema(pool);
  const table = stateTableName();
  const result = await pool.query(`SELECT state FROM ${table} WHERE id = $1`, [STATE_ROW_ID]);
  if (result.rows[0]?.state) return result.rows[0].state;

  const legacyState = await readJsonState(dataFile);
  if (legacyState) await savePersistedState({ state: legacyState });
  return legacyState;
}

export async function savePersistedState({ dataDir, dataFile, state }) {
  if (!postgresEnabled()) {
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(dataFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    return;
  }

  const pool = await getPool();
  await ensureSchema(pool);
  const table = stateTableName();
  await pool.query(
    `
      INSERT INTO ${table} (id, state, updated_at)
      VALUES ($1, $2::jsonb, NOW())
      ON CONFLICT (id)
      DO UPDATE SET state = EXCLUDED.state, updated_at = NOW()
    `,
    [STATE_ROW_ID, JSON.stringify(state)]
  );
}

export async function persistenceHealth({ dataFile } = {}) {
  if (!postgresEnabled()) {
    let jsonFileExists = false;
    if (dataFile) {
      try {
        await fs.access(dataFile);
        jsonFileExists = true;
      } catch {
        jsonFileExists = false;
      }
    }
    return {
      ok: true,
      mode: "json",
      dataFile,
      jsonFileExists,
    };
  }

  const pool = await getPool();
  await ensureSchema(pool);
  await pool.query("SELECT 1");
  return {
    ok: true,
    mode: "postgres",
    host: process.env.POSTGRES_HOST || "DATABASE_URL",
    port: Number(process.env.POSTGRES_PORT || 5432),
    database: process.env.POSTGRES_DB || "",
    table: stateTableName(),
  };
}
