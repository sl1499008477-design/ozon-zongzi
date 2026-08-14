import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const databaseUrl = process.env.TEST_DATABASE_URL;
const postgresEnabled = process.env.AUTO_LISTING_CATEGORY_STRATEGY_POSTGRES_TESTS === "1" && Boolean(databaseUrl);
const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../db/migrations");
const migrationPath = path.join(migrationsDir, "075_auto_listing_category_strategy_sampling.sql");
const quote = (value) => `"${String(value).replaceAll('"', '""')}"`;
const H = (digit) => digit.repeat(64);

function draftInput(ids) {
  return [
    ids.draft, ids.accountA, "OZON:DEFAULT", 170, 99, 1, "COLLECTING",
    `draft-key-${ids.suffix}`, `draft-correlation-${ids.suffix}`, H("a"), ids.accountA,
  ];
}

async function applyMigrations(client) {
  const migrations = (await readdir(migrationsDir)).filter((file) => /^\d{3}_.+\.sql$/u.test(file)).sort();
  assert.equal(migrations.at(-1), "075_auto_listing_category_strategy_sampling.sql");
  for (const migration of migrations) await client.query(await readFile(path.join(migrationsDir, migration), "utf8"));
}

test("075 supplies account-scoped category-strategy evidence and closed settings", async () => {
  const sql = await readFile(migrationPath, "utf8");
  for (const table of [
    "auto_listing_category_strategy_drafts",
    "auto_listing_category_strategy_account_settings",
    "auto_listing_category_strategy_sampling_sessions",
    "auto_listing_category_strategy_sample_sets",
    "auto_listing_category_strategy_samples",
    "auto_listing_category_strategy_sample_images",
    "auto_listing_category_strategy_analysis_attempts",
    "auto_listing_category_strategy_analysis_results",
    "auto_listing_category_strategy_events",
  ]) assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`, "iu"));
  assert.match(sql, /mode TEXT NOT NULL DEFAULT 'LEGACY_FALLBACK' CHECK \(mode IN \('LEGACY_FALLBACK','REQUIRE_EXACT_STRATEGY'\)\)/iu);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS auto_listing_category_strategy_account_settings[\s\S]*?account_id TEXT PRIMARY KEY/iu);
  assert.match(sql, /account_id,taxonomy_scope,description_category_id,type_id/iu);
  assert.match(sql, /published_strategy_version_id[\s\S]*?FOREIGN KEY \(account_id,published_strategy_version_id\)[\s\S]*?REFERENCES ai_content_strategy_versions\(account_id,id\)/iu);
  assert.match(sql, /auto_listing_category_strategy_(?:sample_set|sample_image|analysis_result|event)_append_only/iu);
  assert.match(sql, /ERRCODE\s*=\s*'23514'/iu);
  assert.doesNotMatch(sql, /\b(?:DROP TABLE|TRUNCATE|DELETE FROM)\b/iu);
});

if (!postgresEnabled) {
  test("075 PostgreSQL attack matrix requires an explicit disposable PostgreSQL gate", {
    skip: "requires AUTO_LISTING_CATEGORY_STRATEGY_POSTGRES_TESTS=1 and TEST_DATABASE_URL",
  }, () => {});
} else {
  test("075 isolates exact scopes and rejects mutation of immutable category-strategy evidence", { timeout: 30_000 }, async () => {
    const { Pool } = await import("pg");
    const root = new Pool({ connectionString: databaseUrl, max: 1 });
    const client = await root.connect();
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const schema = `category_strategy_${suffix}`;
    const ids = {
      suffix, accountA: `account-a-${suffix}`, accountB: `account-b-${suffix}`,
      draft: `draft-${suffix}`, session: `session-${suffix}`, sampleSet: `set-${suffix}`,
      sample: `sample-${suffix}`, attempt: `attempt-${suffix}`, result: `result-${suffix}`,
      event: `event-${suffix}`, strategy: `strategy-${suffix}`,
    };
    try {
      await client.query(`CREATE SCHEMA ${quote(schema)}`);
      await client.query(`SET search_path TO ${quote(schema)}, public`);
      await applyMigrations(client);
      await client.query(
        "INSERT INTO accounts (id,username,display_name,role,status) VALUES ($1,$2,$2,'admin','active'),($3,$4,$4,'admin','active')",
        [ids.accountA, `admin-a-${suffix}`, ids.accountB, `admin-b-${suffix}`],
      );
      await client.query(
        "INSERT INTO ai_content_strategy_versions (id,account_id,strategy_key,version,status,content,content_hash) VALUES ($1,$2,'category-strategy',1,'DRAFT','{}'::JSONB,$3)",
        [ids.strategy, ids.accountA, H("b")],
      );
      await client.query(
        "UPDATE ai_content_strategy_versions SET status='PUBLISHED',published_at=STATEMENT_TIMESTAMP(),published_by=$2 WHERE id=$1",
        [ids.strategy, ids.accountA],
      );
      await client.query(
        `INSERT INTO auto_listing_category_strategy_drafts
           (id,account_id,taxonomy_scope,description_category_id,type_id,draft_version,status,idempotency_key,correlation_id,request_hash,actor_account_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        draftInput(ids),
      );
      const settings = await client.query(
        "SELECT mode,version FROM auto_listing_category_strategy_account_settings WHERE account_id=$1",
        [ids.accountA],
      );
      assert.deepEqual(settings.rows, [{ mode: "LEGACY_FALLBACK", version: "1" }]);
      await client.query(
        `UPDATE auto_listing_category_strategy_account_settings
            SET mode='REQUIRE_EXACT_STRATEGY',version=2,idempotency_key=$2,
                correlation_id=$3,request_hash=$4,actor_account_id=$1
          WHERE account_id=$1`,
        [ids.accountA, `settings-key-${suffix}`, `settings-correlation-${suffix}`, H("0")],
      );
      assert.deepEqual((await client.query(
        `SELECT setting.mode,setting.version,event.event_type,event.settings_version
           FROM auto_listing_category_strategy_account_settings setting
           JOIN auto_listing_category_strategy_events event
             ON event.account_id=setting.account_id AND event.settings_version=setting.version
          WHERE setting.account_id=$1`,
        [ids.accountA],
      )).rows, [{
        mode: "REQUIRE_EXACT_STRATEGY", version: "2", event_type: "ACCOUNT_SETTINGS_CHANGED", settings_version: "2",
      }]);
      await assert.rejects(client.query(
        `INSERT INTO auto_listing_category_strategy_sampling_sessions
           (id,account_id,draft_id,taxonomy_scope,description_category_id,type_id,expires_at,idempotency_key,correlation_id,request_hash,actor_account_id)
         VALUES ($1,$2,$3,'OZON:DEFAULT',170,99,STATEMENT_TIMESTAMP()-INTERVAL '1 second',$4,$5,$6,$2)`,
        [ids.session, ids.accountA, ids.draft, `session-key-${suffix}`, `session-correlation-${suffix}`, H("c")],
      ), (error) => error?.code === "23514");
      await client.query(
        `INSERT INTO auto_listing_category_strategy_sampling_sessions
           (id,account_id,draft_id,taxonomy_scope,description_category_id,type_id,expires_at,idempotency_key,correlation_id,request_hash,actor_account_id)
         VALUES ($1,$2,$3,'OZON:DEFAULT',170,99,STATEMENT_TIMESTAMP()+INTERVAL '1 hour',$4,$5,$6,$2)`,
        [ids.session, ids.accountA, ids.draft, `session-key-${suffix}`, `session-correlation-${suffix}`, H("c")],
      );
      await assert.rejects(client.query(
        `INSERT INTO auto_listing_category_strategy_sample_sets
           (id,account_id,draft_id,taxonomy_scope,description_category_id,type_id,session_id,sample_set_hash,idempotency_key,correlation_id,request_hash,actor_account_id)
         VALUES ($1,$2,$3,'OZON:DEFAULT',170,100,$4,$5,$6,$7,$8,$2)`,
        [ids.sampleSet, ids.accountA, ids.draft, ids.session, H("d"), `set-key-${suffix}`, `set-correlation-${suffix}`, H("e")],
      ), (error) => error?.code === "23503");
      await client.query(
        `INSERT INTO auto_listing_category_strategy_sample_sets
           (id,account_id,draft_id,taxonomy_scope,description_category_id,type_id,session_id,sample_set_hash,idempotency_key,correlation_id,request_hash,actor_account_id)
         VALUES ($1,$2,$3,'OZON:DEFAULT',170,99,$4,$5,$6,$7,$8,$2)`,
        [ids.sampleSet, ids.accountA, ids.draft, ids.session, H("d"), `set-key-${suffix}`, `set-correlation-${suffix}`, H("e")],
      );
      await assert.rejects(client.query(
        `INSERT INTO auto_listing_category_strategy_samples
           (id,account_id,draft_id,taxonomy_scope,description_category_id,type_id,sample_set_id,sku,idempotency_key,correlation_id,request_hash,actor_account_id)
         VALUES ($1,$2,$3,'OZON:DEFAULT',170,99,$4,'sku-a',$5,$6,$7,$2)`,
        [ids.sample, ids.accountB, ids.draft, ids.sampleSet, `sample-key-${suffix}`, `sample-correlation-${suffix}`, H("f")],
      ), (error) => error?.code === "23503");
      await client.query(
        `INSERT INTO auto_listing_category_strategy_samples
           (id,account_id,draft_id,taxonomy_scope,description_category_id,type_id,sample_set_id,sku,idempotency_key,correlation_id,request_hash,actor_account_id)
         VALUES ($1,$2,$3,'OZON:DEFAULT',170,99,$4,'sku-a',$5,$6,$7,$2)`,
        [ids.sample, ids.accountA, ids.draft, ids.sampleSet, `sample-key-${suffix}`, `sample-correlation-${suffix}`, H("f")],
      );
      await client.query(
        `INSERT INTO auto_listing_category_strategy_sample_images
           (id,account_id,draft_id,taxonomy_scope,description_category_id,type_id,sample_set_id,sample_id,image_id,role,ordinal,idempotency_key,correlation_id,request_hash,actor_account_id)
         VALUES ($1,$2,$3,'OZON:DEFAULT',170,99,$4,$5,'image-main','MAIN',0,$6,$7,$8,$2)`,
        [`image-${suffix}`, ids.accountA, ids.draft, ids.sampleSet, ids.sample, `image-key-${suffix}`, `image-correlation-${suffix}`, H("1")],
      );
      await client.query(
        `INSERT INTO auto_listing_category_strategy_analysis_attempts
           (id,account_id,draft_id,taxonomy_scope,description_category_id,type_id,sample_set_id,sample_set_hash,analysis_input_hash,model_config_snapshot,model_config_hash,cost_confirmed,idempotency_key,correlation_id,request_hash,actor_account_id)
         VALUES ($1,$2,$3,'OZON:DEFAULT',170,99,$4,$5,$6,'{"model":"test"}'::JSONB,$7,TRUE,$8,$9,$10,$2)`,
        [ids.attempt, ids.accountA, ids.draft, ids.sampleSet, H("d"), H("3"), H("2"), `attempt-key-${suffix}`, `attempt-correlation-${suffix}`, H("3")],
      );
      await client.query(
        `INSERT INTO auto_listing_category_strategy_analysis_results
           (id,account_id,draft_id,taxonomy_scope,description_category_id,type_id,attempt_id,sample_set_id,sample_set_hash,analysis_input_hash,raw_response,raw_response_hash,guidance,guidance_hash,idempotency_key,correlation_id,request_hash,actor_account_id)
         VALUES ($1,$2,$3,'OZON:DEFAULT',170,99,$4,$5,$6,$7,'{"result":"raw"}'::JSONB,$8,'{"overallStyle":"clean"}'::JSONB,$9,$10,$11,$12,$2)`,
        [ids.result, ids.accountA, ids.draft, ids.attempt, ids.sampleSet, H("d"), H("3"), H("4"), H("5"), `result-key-${suffix}`, `result-correlation-${suffix}`, H("6")],
      );
      await client.query(
        `INSERT INTO auto_listing_category_strategy_events
           (id,account_id,draft_id,taxonomy_scope,description_category_id,type_id,event_type,analysis_result_id,published_strategy_version_id,idempotency_key,correlation_id,request_hash,actor_account_id)
         VALUES ($1,$2,$3,'OZON:DEFAULT',170,99,'PUBLISHED',$4,$5,$6,$7,$8,$2)`,
        [ids.event, ids.accountA, ids.draft, ids.result, ids.strategy, `event-key-${suffix}`, `event-correlation-${suffix}`, H("7")],
      );
      for (const [table, id] of [
        ["auto_listing_category_strategy_sample_sets", ids.sampleSet],
        ["auto_listing_category_strategy_sample_images", `image-${suffix}`],
        ["auto_listing_category_strategy_analysis_results", ids.result],
        ["auto_listing_category_strategy_events", ids.event],
      ]) {
        await assert.rejects(client.query(`UPDATE ${table} SET correlation_id='mutated' WHERE id=$1`, [id]), (error) => error?.code === "23514");
        await assert.rejects(client.query(`DELETE FROM ${table} WHERE id=$1`, [id]), (error) => error?.code === "23514");
      }
      await assert.rejects(client.query(
        "DELETE FROM auto_listing_category_strategy_sampling_sessions WHERE id=$1",
        [ids.session],
      ), (error) => error?.code === "23514");
      await assert.rejects(client.query(
        "DELETE FROM auto_listing_category_strategy_account_settings WHERE account_id=$1",
        [ids.accountA],
      ), (error) => error?.code === "23514");
      await client.query("DELETE FROM auto_listing_category_strategy_drafts WHERE id=$1", [ids.draft]);
      assert.equal((await client.query("SELECT COUNT(*)::int AS count FROM auto_listing_category_strategy_events WHERE account_id=$1 AND draft_id=$2", [ids.accountA, ids.draft])).rows[0].count, 0);
    } finally {
      await client.query("SET search_path TO public").catch(() => {});
      await client.query(`DROP SCHEMA IF EXISTS ${quote(schema)} CASCADE`).catch(() => {});
      client.release();
      await root.end();
    }
  });
}
