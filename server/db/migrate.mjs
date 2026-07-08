import "../env.mjs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { closePostgresPool, getPostgresPool, postgresEnabled } from "./connection.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(__dirname, "migrations");

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

export async function runMigrations(pool = null) {
  if (!postgresEnabled()) {
    return { ok: true, skipped: true, applied: [] };
  }
  const resolvedPool = pool || await getPostgresPool();
  const client = await resolvedPool.connect();
  const applied = [];
  try {
    await ensureMigrationsTable(client);
    const current = await client.query("SELECT version FROM schema_migrations");
    const completed = new Set(current.rows.map((row) => row.version));
    for (const file of await migrationFiles()) {
      const version = file.replace(/\.sql$/, "");
      if (completed.has(version)) continue;
      const sql = await fs.readFile(path.join(migrationsDir, file), "utf8");
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [version]);
      await client.query("COMMIT");
      applied.push(version);
    }
    return { ok: true, skipped: false, applied };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Ignore rollback errors; the original migration error is more useful.
    }
    throw error;
  } finally {
    client.release();
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
