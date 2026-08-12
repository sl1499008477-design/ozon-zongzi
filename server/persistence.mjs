import { promises as fs } from "node:fs";
import path from "node:path";
import {
  encryptionHealth,
  protectStateForStorage,
  stateNeedsSecretProtection,
  unprotectStateFromStorage,
} from "./crypto-secrets.mjs";
import { getPostgresPool, postgresEnabled } from "./db/connection.mjs";
import {
  ensureFormalSchema,
  formalPersistenceHealth,
  hydrateStoreCatalogFromRelationalTables,
  mirrorStateToRelationalTables,
  mirrorStateToRelationalTablesInTransaction,
} from "./formal-persistence.mjs";
import { persistPostgresStateAtomically } from "./postgres-state-transaction.mjs";
import { writeJsonAtomically } from "./json-state-writer.mjs";
import { normalizeCollectorRevokeReason } from "./collector-auth-service.mjs";

const STATE_ROW_ID = "local-state";
let schemaReady = false;
let formalBackfillComplete = false;
let formalBackfillError = "";
const RETIRED_CATEGORY_STATE_KEYS = Object.freeze([
  "collectCategoryResolutions",
  "collectCategoryResolutionRuntimeCursors",
]);

function clonePersistenceState(state = {}) {
  const clone = structuredClone(state);
  for (const key of ["__storageVersion", "__deletedAccountScopes"]) {
    if (!Object.hasOwn(state, key)) continue;
    Object.defineProperty(clone, key, {
      value: structuredClone(state[key]),
      enumerable: false,
      configurable: true,
      writable: true,
    });
  }
  return clone;
}

export function normalizeRetiredCategoryState(state = {}) {
  const normalized = clonePersistenceState(state);
  let changed = false;
  for (const key of RETIRED_CATEGORY_STATE_KEYS) {
    if (!Object.hasOwn(normalized, key)) continue;
    delete normalized[key];
    changed = true;
  }
  return { state: normalized, changed };
}

function commitNormalizedState(target, normalized) {
  for (const key of RETIRED_CATEGORY_STATE_KEYS) delete target[key];
  const targetStoresById = new Map(
    (Array.isArray(target.stores) ? target.stores : [])
      .filter((store) => store && typeof store === "object")
      .map((store) => [String(store.id || ""), store]),
  );
  for (const store of Array.isArray(normalized.stores) ? normalized.stores : []) {
    if (!store || typeof store !== "object" || !Object.hasOwn(store, "ownerAccountId")) continue;
    const targetStore = targetStoresById.get(String(store.id || ""));
    if (targetStore) targetStore.ownerAccountId = store.ownerAccountId;
  }
  for (const key of ["auditEvents"]) {
    if (Object.hasOwn(normalized, key)) target[key] = normalized[key];
  }
  for (const key of ["__storageVersion", "__deletedAccountScopes"]) {
    if (!Object.hasOwn(normalized, key)) {
      delete target[key];
      continue;
    }
    Object.defineProperty(target, key, {
      value: normalized[key],
      enumerable: false,
      configurable: true,
      writable: true,
    });
  }
}

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
    const result = normalizeRetiredCategoryState(
      unprotectStateFromStorage(JSON.parse(raw)),
    );
    if (result.changed) {
      await writeJsonAtomically({
        dataDir: path.dirname(dataFile),
        dataFile,
        value: protectStateForStorage(result.state),
      });
    }
    return result.state;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export function persistenceMode() {
  return postgresEnabled() ? "postgres" : "json";
}

export async function revokePersistedSessions({ token = "", accountId = "", reason = "logout" } = {}) {
  const normalizedToken = String(token || "").trim();
  const normalizedAccountId = String(accountId || "").trim();
  if (!normalizedToken && !normalizedAccountId) return { revoked: 0, mode: persistenceMode() };
  if (!postgresEnabled()) return { revoked: 0, mode: "json" };

  const pool = await getPostgresPool();
  await ensureSchema(pool);
  const collectorResult = normalizedToken
    ? await pool.query(
      `UPDATE collector_sessions
       SET revoked_at=COALESCE(revoked_at,NOW()),
           revoked_reason=$2
       WHERE parent_session_token=$1 AND revoked_at IS NULL`,
      [normalizedToken, normalizeCollectorRevokeReason(reason, { secrets: [normalizedToken] })],
    )
    : await pool.query(
      `UPDATE collector_sessions
       SET revoked_at=COALESCE(revoked_at,NOW()),
           revoked_reason=$2
       WHERE account_id=$1 AND revoked_at IS NULL`,
      [normalizedAccountId, normalizeCollectorRevokeReason(reason)],
    );
  const result = normalizedToken
    ? await pool.query(
      `UPDATE sessions
       SET revoked_at=COALESCE(revoked_at,NOW()),
           last_seen_at=NOW(),
           raw=raw || jsonb_build_object('revokedReason',$2::text)
       WHERE token=$1 AND revoked_at IS NULL`,
      [normalizedToken, String(reason || "logout").slice(0, 80)],
    )
    : await pool.query(
      `UPDATE sessions
       SET revoked_at=COALESCE(revoked_at,NOW()),
           last_seen_at=NOW(),
           raw=raw || jsonb_build_object('revokedReason',$2::text)
       WHERE account_id=$1 AND revoked_at IS NULL`,
      [normalizedAccountId, String(reason || "account-change").slice(0, 80)],
    );
  return {
    revoked: Number(result.rowCount || 0),
    collectorRevoked: Number(collectorResult.rowCount || 0),
    mode: "postgres",
  };
}

export async function disablePersistedOperatingStores({ accountId = "", storeIds = [] } = {}) {
  const normalizedAccountId = String(accountId || "").trim();
  const normalizedStoreIds = [...new Set((Array.isArray(storeIds) ? storeIds : [storeIds])
    .map((storeId) => String(storeId || "").trim())
    .filter(Boolean))];
  if (!normalizedAccountId || !normalizedStoreIds.length) return { disabled: 0, credentialsRemoved: 0, mode: persistenceMode() };
  if (!postgresEnabled()) return { disabled: 0, credentialsRemoved: 0, mode: "json" };

  const pool = await getPostgresPool();
  await ensureSchema(pool);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const disabled = await client.query(
      `UPDATE stores
       SET status='disabled', is_current=FALSE, updated_at=NOW()
       WHERE owner_account_id=$1 AND id=ANY($2::text[])`,
      [normalizedAccountId, normalizedStoreIds],
    );
    const credentials = await client.query(
      `DELETE FROM store_credentials credentials
       USING stores
       WHERE credentials.store_id=stores.id
         AND stores.owner_account_id=$1
         AND stores.id=ANY($2::text[])`,
      [normalizedAccountId, normalizedStoreIds],
    );
    await client.query("COMMIT");
    return {
      disabled: Number(disabled.rowCount || 0),
      credentialsRemoved: Number(credentials.rowCount || 0),
      mode: "postgres",
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function loadPersistedState({ dataFile }) {
  if (!postgresEnabled()) return readJsonState(dataFile);

  const pool = await getPostgresPool();
  await ensureSchema(pool);
  const table = stateTableName();
  const result = await pool.query(`SELECT state, version FROM ${table} WHERE id = $1`, [STATE_ROW_ID]);
  if (result.rows[0]?.state) {
    let version = Number(result.rows[0].version) || 1;
    const normalized = normalizeRetiredCategoryState(
      unprotectStateFromStorage(result.rows[0].state),
    );
    const state = normalized.state;
    if (normalized.changed || stateNeedsSecretProtection(result.rows[0].state)) {
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
      if (update.rowCount !== 1) {
        const error = new Error("本地状态已被其他操作更新，请刷新后重试");
        error.code = "LOCAL_STATE_VERSION_CONFLICT";
        error.status = 409;
        throw error;
      }
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
    try {
      await hydrateStoreCatalogFromRelationalTables(pool, state);
    } catch (error) {
      console.warn(`正式商品/仓库数据恢复失败: ${String(error?.message || error).slice(0, 500)}`);
    }
    return state;
  }

  const legacyState = await readJsonState(dataFile);
  if (legacyState) await savePersistedState({ state: legacyState });
  return legacyState;
}

export async function savePersistedState({ dataDir, dataFile, state }) {
  const normalized = normalizeRetiredCategoryState(state);
  const persistenceState = normalized.state;
  const protectedState = protectStateForStorage(persistenceState);
  if (!postgresEnabled()) {
    await writeJsonAtomically({ dataDir, dataFile, value: protectedState });
    commitNormalizedState(state, persistenceState);
    return;
  }

  const pool = await getPostgresPool();
  await ensureSchema(pool);
  const table = stateTableName();
  const client = await pool.connect();
  try {
    await persistPostgresStateAtomically({
      client,
      table,
      state: persistenceState,
      protectedState,
      refreshProtectedState: protectStateForStorage,
      mirror: mirrorStateToRelationalTablesInTransaction,
    });
    commitNormalizedState(state, persistenceState);
  } finally {
    client.release();
  }
}

export async function savePersistedCollectBox({ dataDir, dataFile, state }) {
  state.updatedAt = new Date().toISOString();
  if (!postgresEnabled()) {
    await savePersistedState({ dataDir, dataFile, state });
    return;
  }

  const pool = await getPostgresPool();
  await ensureSchema(pool);
  const table = stateTableName();
  const currentVersion = Number(state?.__storageVersion || 0);
  if (currentVersion <= 0) {
    await savePersistedState({ dataDir, dataFile, state });
    return;
  }

  const protectedCollectBox = protectStateForStorage({
    caches: { collectBox: Array.isArray(state?.caches?.collectBox) ? state.caches.collectBox : [] },
  }).caches.collectBox;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["sonli-local-state"]);
    const result = await client.query(
      `
        UPDATE ${table}
        SET state = jsonb_set(
              jsonb_set(state, '{caches,collectBox}', $1::jsonb, true),
              '{updatedAt}',
              to_jsonb($2::text),
              true
            ),
            version = version + 1,
            updated_at = NOW()
        WHERE id = $3 AND version = $4
        RETURNING version
      `,
      [JSON.stringify(protectedCollectBox), state.updatedAt, STATE_ROW_ID, currentVersion],
    );
    if (!result.rowCount) {
      const error = new Error("本地状态已被其他操作更新，请刷新后重试");
      error.code = "LOCAL_STATE_VERSION_CONFLICT";
      error.status = 409;
      throw error;
    }
    await client.query("COMMIT");
    Object.defineProperty(state, "__storageVersion", {
      value: Number(result.rows[0]?.version || currentVersion + 1),
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
    ok: Boolean(formal?.ok && !formalBackfillError),
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
