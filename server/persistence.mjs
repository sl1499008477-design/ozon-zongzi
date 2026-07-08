import { promises as fs } from "node:fs";
import {
  encryptionHealth,
  protectStateForStorage,
  stateNeedsSecretProtection,
  unprotectStateFromStorage,
} from "./crypto-secrets.mjs";
import { getPostgresPool, postgresEnabled } from "./db/connection.mjs";
import { ensureFormalSchema, formalPersistenceHealth, mirrorStateToRelationalTables } from "./formal-persistence.mjs";

const STATE_ROW_ID = "local-state";
let schemaReady = false;
let formalBackfillComplete = false;
let formalBackfillError = "";

function stateTableName() {
  const name = process.env.POSTGRES_STATE_TABLE || "local_state";
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error("POSTGRES_STATE_TABLE 只能包含字母、数字和下划线");
  }
  return name;
}

async function ensureSchema(pool) {
  if (schemaReady) return;
  const table = stateTableName();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${table} (
      id TEXT PRIMARY KEY,
      state JSONB NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1`);
  await ensureFormalSchema(pool);
  schemaReady = true;
}

async function readJsonState(dataFile) {
  try {
    const raw = await fs.readFile(dataFile, "utf8");
    return unprotectStateFromStorage(JSON.parse(raw));
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

  const pool = await getPostgresPool();
  await ensureSchema(pool);
  const table = stateTableName();
  const result = await pool.query(`SELECT state, version FROM ${table} WHERE id = $1`, [STATE_ROW_ID]);
  if (result.rows[0]?.state) {
    let version = Number(result.rows[0].version) || 1;
    const state = unprotectStateFromStorage(result.rows[0].state);
    if (stateNeedsSecretProtection(result.rows[0].state)) {
      const protectedState = protectStateForStorage(state);
      const update = await pool.query(
        `
          UPDATE ${table}
          SET state = $1::jsonb, version = version + 1, updated_at = NOW()
          WHERE id = $2 AND version = $3
          RETURNING version
        `,
        [JSON.stringify(protectedState), STATE_ROW_ID, version],
      );
      version = Number(update.rows[0]?.version || version);
    }
    Object.defineProperty(state, "__storageVersion", {
      value: version,
      enumerable: false,
      configurable: true,
      writable: true,
    });
    if (!formalBackfillComplete) {
      try {
        await mirrorStateToRelationalTables(pool, state);
        formalBackfillComplete = true;
        formalBackfillError = "";
      } catch (error) {
        formalBackfillError = String(error?.message || error).slice(0, 500);
        console.warn(`正式数据表回填失败: ${formalBackfillError}`);
      }
    }
    return state;
  }

  const legacyState = await readJsonState(dataFile);
  if (legacyState) await savePersistedState({ state: legacyState });
  return legacyState;
}

export async function savePersistedState({ dataDir, dataFile, state }) {
  const protectedState = protectStateForStorage(state);
  if (!postgresEnabled()) {
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(dataFile, `${JSON.stringify(protectedState, null, 2)}\n`, "utf8");
    return;
  }

  const pool = await getPostgresPool();
  await ensureSchema(pool);
  const table = stateTableName();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["sonli-local-state"]);
    const currentVersion = Number(state?.__storageVersion || 0);
    let nextVersion = currentVersion + 1;
    if (currentVersion > 0) {
      const result = await client.query(
        `
          UPDATE ${table}
          SET state = $1::jsonb, version = version + 1, updated_at = NOW()
          WHERE id = $2 AND version = $3
          RETURNING version
        `,
        [JSON.stringify(protectedState), STATE_ROW_ID, currentVersion]
      );
      if (!result.rowCount) {
        const err = new Error("本地状态已被其他操作更新，请刷新后重试");
        err.code = "LOCAL_STATE_VERSION_CONFLICT";
        err.status = 409;
        throw err;
      }
      nextVersion = Number(result.rows[0]?.version || nextVersion);
    } else {
      const result = await client.query(
        `
          INSERT INTO ${table} (id, state, version, updated_at)
          VALUES ($1, $2::jsonb, 1, NOW())
          ON CONFLICT (id)
          DO UPDATE SET state = EXCLUDED.state, version = ${table}.version + 1, updated_at = NOW()
          RETURNING version
        `,
        [STATE_ROW_ID, JSON.stringify(protectedState)]
      );
      nextVersion = Number(result.rows[0]?.version || 1);
    }
    await client.query("COMMIT");
    Object.defineProperty(state, "__storageVersion", {
      value: nextVersion,
      enumerable: false,
      configurable: true,
      writable: true,
    });
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Preserve the original save failure.
    }
    throw error;
  } finally {
    client.release();
  }
  await mirrorStateToRelationalTables(pool, state);
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

  const pool = await getPostgresPool();
  await ensureSchema(pool);
  await pool.query("SELECT 1");
  let formal;
  try {
    formal = await formalPersistenceHealth(pool);
  } catch (error) {
    formal = { ok: false, message: error.message };
  }
  return {
    ok: true,
    mode: "postgres",
    host: process.env.POSTGRES_HOST || "DATABASE_URL",
    port: Number(process.env.POSTGRES_PORT || 5432),
    database: process.env.POSTGRES_DB || "",
    table: stateTableName(),
    formal,
    encryption: encryptionHealth(),
    backfill: {
      completed: formalBackfillComplete,
      error: formalBackfillError,
    },
  };
}
