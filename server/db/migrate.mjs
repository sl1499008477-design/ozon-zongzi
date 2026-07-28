import "../env.mjs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { closePostgresPool, getPostgresPool, postgresEnabled } from "./connection.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(__dirname, "migrations");
const MIGRATION_LOCK_KEY = "sonli-schema-migrations-v1";

async function migrationFiles() {
  const files = await fs.readdir(migrationsDir);
  return files.filter((file) => /^\d+_.+\.sql$/.test(file)).sort();
}

async function ensureMigrationsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function applyMigration(client, sql, version) {
  let transactionOpen = false;
  try {
    await client.query("BEGIN");
    transactionOpen = true;
    await client.query(sql);
    await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [version]);
    await client.query("COMMIT");
    transactionOpen = false;
  } catch (error) {
    if (transactionOpen) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve the migration error; it is more useful than a rollback error.
      }
    }
    throw error;
  }
}

export async function runMigrations(pool = null) {
  if (!postgresEnabled()) {
    return { ok: true, skipped: true, applied: [] };
  }
  const resolvedPool = pool || await getPostgresPool();
  const client = await resolvedPool.connect();
  const applied = [];
  let lockAcquired = false;
  let migrationError = null;
  try {
    // A transaction-scoped lock would be released after each migration. Keep a
    // session lock on this exact connection so the initial scan and every
    // per-file transaction form one serialized migration run.
    await client.query("SELECT pg_advisory_lock(hashtext($1))", [MIGRATION_LOCK_KEY]);
    lockAcquired = true;
    await ensureMigrationsTable(client);
    const current = await client.query("SELECT version FROM schema_migrations");
    const completed = new Set(current.rows.map((row) => row.version));
    for (const file of await migrationFiles()) {
      const version = file.replace(/\.sql$/, "");
      if (completed.has(version)) continue;
      const sql = await fs.readFile(path.join(migrationsDir, file), "utf8");
      await applyMigration(client, sql, version);
      completed.add(version);
      applied.push(version);
    }
    return { ok: true, skipped: false, applied };
  } catch (error) {
    migrationError = error;
    throw error;
  } finally {
    let finalizationError = null;
    if (lockAcquired) {
      try {
        const result = await client.query(
          "SELECT pg_advisory_unlock(hashtext($1)) AS unlocked",
          [MIGRATION_LOCK_KEY],
        );
        if (result.rows[0]?.unlocked !== true) {
          throw new Error("PostgreSQL migration advisory lock was not held by this session");
        }
      } catch (error) {
        finalizationError = error;
      }
    }
    try {
      client.release(finalizationError || undefined);
    } catch (error) {
      finalizationError ||= error;
    }
    if (!migrationError && finalizationError) throw finalizationError;
  }
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  try {
    const result = await runMigrations();
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await closePostgresPool();
  }
}
