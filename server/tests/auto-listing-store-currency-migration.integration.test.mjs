import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

const databaseUrl = process.env.SONLI_MIGRATION_TEST_DATABASE_URL;
const enabled = process.env.AUTO_LISTING_POSTGRES_TESTS === "1" && Boolean(databaseUrl);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migration = path.join(__dirname, "../db/migrations/062_auto_listing_store_currency.sql");
const schema = `store_currency_${crypto.randomUUID().replaceAll("-", "")}`;
const quote = (value) => `"${value.replaceAll('"', '""')}"`;

test("062 preserves V1 RUB and enforces V2 store and variant currency", { skip: !enabled }, async () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  try {
    await client.query(`CREATE SCHEMA ${quote(schema)}`);
    await client.query(`SET search_path TO ${quote(schema)}, public`);
    await client.query(`
      CREATE TABLE accounts (id TEXT PRIMARY KEY);
      CREATE TABLE stores (
        id TEXT NOT NULL, owner_account_id TEXT NOT NULL REFERENCES accounts(id), currency_code TEXT NOT NULL,
        PRIMARY KEY (owner_account_id,id)
      );
      CREATE TABLE auto_listing_listing_bases (
        id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), target_store_id TEXT NOT NULL,
        pricing_evidence JSONB NOT NULL CHECK (pricing_evidence->>'currency'='RUB'),
        ozon_ready_variants JSONB NOT NULL,
        rich_content_attribute_supported BOOLEAN NOT NULL,
        listing_base_version TEXT NOT NULL CHECK (listing_base_version='AUTO_LISTING_LISTING_BASE_V1'),
        FOREIGN KEY (account_id,target_store_id) REFERENCES stores(owner_account_id,id)
      );
      CREATE FUNCTION auto_listing_reject_listing_base_mutation() RETURNS TRIGGER LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'append-only' USING ERRCODE='23514'; END $$;
      CREATE TRIGGER auto_listing_listing_bases_append_only BEFORE UPDATE OR DELETE ON auto_listing_listing_bases
      FOR EACH ROW EXECUTE FUNCTION auto_listing_reject_listing_base_mutation();
      CREATE FUNCTION auto_listing_require_complete_listing_base_v1() RETURNS TRIGGER LANGUAGE plpgsql AS $$
      BEGIN RETURN NEW; END $$;
      CREATE TRIGGER auto_listing_listing_bases_complete_v1 BEFORE INSERT ON auto_listing_listing_bases
      FOR EACH ROW EXECUTE FUNCTION auto_listing_require_complete_listing_base_v1();
    `);
    await client.query("INSERT INTO accounts(id) VALUES ('account-a'),('account-b')");
    await client.query("INSERT INTO stores(id,owner_account_id,currency_code) VALUES ('rub','account-a','RUB'),('cny','account-a','CNY'),('cny-b','account-b','CNY')");
    const rubEvidence = { currency: "RUB", blackKopecks: "10000", greenKopecks: "8000", evidenceHash: "a".repeat(64) };
    const rubVariants = [{ item: { currency_code: "RUB" } }];
    await client.query(
      "INSERT INTO auto_listing_listing_bases VALUES ('legacy','account-a','rub',$1,$2,true,'AUTO_LISTING_LISTING_BASE_V1')",
      [rubEvidence, JSON.stringify(rubVariants)],
    );

    await client.query(await readFile(migration, "utf8"));
    assert.deepEqual((await client.query("SELECT pricing_evidence,listing_base_version FROM auto_listing_listing_bases WHERE id='legacy'" )).rows[0], {
      pricing_evidence: rubEvidence, listing_base_version: "AUTO_LISTING_LISTING_BASE_V1",
    });

    const cnyEvidence = { currency: "CNY", currencySource: "TARGET_STORE", blackKopecks: "10000", greenKopecks: "8000", evidenceHash: "b".repeat(64) };
    await client.query(
      "INSERT INTO auto_listing_listing_bases VALUES ('v2-cny','account-a','cny',$1,$2,true,'AUTO_LISTING_LISTING_BASE_V2')",
      [cnyEvidence, JSON.stringify([{ item: { currency_code: "CNY" } }])],
    );
    for (const [id, accountId, storeId, evidence, variants, version] of [
      ["v1-cny", "account-a", "cny", { ...cnyEvidence, currencySource: undefined }, [{ item: { currency_code: "CNY" } }], "AUTO_LISTING_LISTING_BASE_V1"],
      ["v2-usd", "account-a", "cny", { ...cnyEvidence, currency: "USD" }, [{ item: { currency_code: "USD" } }], "AUTO_LISTING_LISTING_BASE_V2"],
      ["v2-missing-source", "account-a", "cny", { ...cnyEvidence, currencySource: undefined }, [{ item: { currency_code: "CNY" } }], "AUTO_LISTING_LISTING_BASE_V2"],
      ["v2-store-mismatch", "account-a", "rub", cnyEvidence, [{ item: { currency_code: "CNY" } }], "AUTO_LISTING_LISTING_BASE_V2"],
      ["v2-item-mismatch", "account-a", "cny", cnyEvidence, [{ item: { currency_code: "RUB" } }], "AUTO_LISTING_LISTING_BASE_V2"],
      ["v2-cross-tenant", "account-a", "cny-b", cnyEvidence, [{ item: { currency_code: "CNY" } }], "AUTO_LISTING_LISTING_BASE_V2"],
    ]) {
      await assert.rejects(client.query(
        "INSERT INTO auto_listing_listing_bases VALUES ($1,$2,$3,$4,$5,true,$6)",
        [id, accountId, storeId, JSON.stringify(evidence), JSON.stringify(variants), version],
      ), (error) => ["23514", "23503"].includes(error?.code), id);
    }
    await assert.rejects(client.query("UPDATE auto_listing_listing_bases SET target_store_id='rub' WHERE id='v2-cny'"), { code: "23514" });
  } finally {
    await client.query(`DROP SCHEMA IF EXISTS ${quote(schema)} CASCADE`);
    client.release();
    await pool.end();
  }
});
