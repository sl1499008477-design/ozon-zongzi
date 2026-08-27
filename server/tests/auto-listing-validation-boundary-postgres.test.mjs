import assert from "node:assert/strict";
import test from "node:test";
import { Pool } from "pg";

const databaseConfig = process.env.SONLI_MIGRATION_TEST_DATABASE_URL
  ? { connectionString: process.env.SONLI_MIGRATION_TEST_DATABASE_URL }
  : process.env.POSTGRES_HOST
    ? {
        host: process.env.POSTGRES_HOST,
        port: Number(process.env.POSTGRES_PORT || 5432),
        database: process.env.POSTGRES_DB,
        user: process.env.POSTGRES_USER,
        password: process.env.POSTGRES_PASSWORD,
        ssl: false,
      }
    : null;

test("PostgreSQL accepts forward-compatible ACCEPTED semantics while preserving its envelope", {
  skip: !databaseConfig,
}, async () => {
  const pool = new Pool(databaseConfig);
  try {
    const sourceFact = {
      factId: "fact.identity.name",
      field: "identity.name",
      kind: "IDENTITY_NAME",
      value: "Pragma Kelm",
      numericValue: null,
      unit: null,
      sourcePath: "identity.name",
    };
    const sourceAsset = {
      assetId: "source-a",
      contentHash: "a".repeat(64),
      contentType: "image/png",
      width: 768,
      height: 1024,
      size: 2048,
    };
    const contentHash = "b".repeat(64);
    const checkerEvidence = {
      checkerResult: {
        presentationAudit: { version: "future-checker-v1", warnings: [] },
      },
      textRequired: true,
      sourceFactIds: [sourceFact.factId],
      sourceFacts: [sourceFact],
      sourceAssets: [sourceAsset],
      generatedHash: contentHash,
      checkerModel: "text-model",
      checkerModelEvidence: {
        requestedTextModel: "text-model",
        gatewayReportedTextModel: "text-model",
        gatewayReportedTextModelPresent: true,
      },
      profileId: "profile-a",
      profileAccountId: "account-a",
      profileVersion: 1,
      templateVersion: "future-image-template",
      requestId: "checker-a",
    };

    const valid = await pool.query(
      `SELECT auto_listing_rich_asset_checker_evidence_valid(
         $1::jsonb,$2::jsonb,$3,$4,$5,$6,$7,$8,$9
       ) AS value`,
      [JSON.stringify(checkerEvidence), JSON.stringify([sourceAsset]), contentHash,
        "checker-a", "text-model", "profile-a", "account-a", 1, "future-image-template"],
    );
    assert.equal(valid.rows[0].value, true);

    const forged = structuredClone(checkerEvidence);
    forged.generatedHash = "0".repeat(64);
    const invalid = await pool.query(
      `SELECT auto_listing_rich_asset_checker_evidence_valid(
         $1::jsonb,$2::jsonb,$3,$4,$5,$6,$7,$8,$9
       ) AS value`,
      [JSON.stringify(forged), JSON.stringify([sourceAsset]), contentHash,
        "checker-a", "text-model", "profile-a", "account-a", 1, "future-image-template"],
    );
    assert.equal(invalid.rows[0].value, false);

    const textRules = await pool.query(
      `SELECT auto_listing_rich_policy_rules_valid($1) AS package_ok,
              auto_listing_rich_policy_rules_valid($2) AS gift_ok,
              auto_listing_rich_russian_text_valid($3,$4::jsonb,$5::jsonb) AS fact_word_ok`,
      ["В комплекте кабель USB", "Подарок чехол", "Лампа Pragma Kelm",
        JSON.stringify([sourceFact]), JSON.stringify([sourceFact.factId])],
    );
    assert.deepEqual(textRules.rows[0], {
      package_ok: true,
      gift_ok: false,
      fact_word_ok: true,
    });
  } finally {
    await pool.end();
  }
});
