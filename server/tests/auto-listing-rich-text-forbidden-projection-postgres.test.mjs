import "./support/dedicated-postgres-test-environment.mjs";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

const databaseConfig = process.env.SONLI_MIGRATION_TEST_DATABASE_URL
  ? { connectionString: process.env.SONLI_MIGRATION_TEST_DATABASE_URL }
  : null;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migration083 = path.join(__dirname, "../db/migrations/083_auto_listing_rich_claim_projection.sql");
const migration095 = path.join(__dirname, "../db/migrations/095_auto_listing_rich_text_forbidden_projection.sql");
const quote = (value) => `"${value.replaceAll('"', '""')}"`;

function noCopyAssetEvidence(overrides = {}) {
  const sourceAsset = { assetId: "source-a" };
  const checkerEvidence = {
    checkerResult: {
      claimsVerified: true,
      evidence: { claims: [], detectedTexts: [] },
    },
    textRequired: false,
    textForbidden: true,
    sourceFactIds: [],
    sourceFacts: [],
    sourceAssets: [sourceAsset],
    ...overrides,
  };
  return [{ sourceAssetEvidence: [sourceAsset], checkerEvidence }];
}

test("095 projects valid no-copy evidence and rejects contradictory textForbidden evidence", {
  skip: !databaseConfig,
}, async () => {
  const pool = new Pool(databaseConfig);
  const client = await pool.connect();
  const schema = `rich_text_forbidden_${crypto.randomUUID().replaceAll("-", "")}`;
  try {
    await client.query(`CREATE SCHEMA ${quote(schema)}`);
    await client.query(`SET search_path TO ${quote(schema)}, public`);
    await client.query(`
      CREATE FUNCTION auto_listing_ai_model_identity_compatible(requested TEXT, reported TEXT)
      RETURNS BOOLEAN LANGUAGE SQL IMMUTABLE
      AS $function$ SELECT requested = reported $function$
    `);
    await client.query(await readFile(migration083, "utf8"));
    await client.query(await readFile(migration095, "utf8").catch(() => ""));
    await client.query(await readFile(migration095, "utf8").catch(() => ""));

    const project = async (value) => (await client.query(
      "SELECT auto_listing_rich_asset_evidence_for_validation($1::jsonb) AS value",
      [JSON.stringify(value)],
    )).rows[0].value;

    const projected = await project(noCopyAssetEvidence());
    assert.equal(projected[0].checkerEvidence.textForbidden, undefined);
    assert.equal(projected[0].checkerEvidence.textRequired, false);
    assert.deepEqual(projected[0].checkerEvidence.sourceFactIds, []);
    assert.deepEqual(projected[0].checkerEvidence.checkerResult.evidence.claims, []);
    assert.deepEqual(projected[0].checkerEvidence.checkerResult.evidence.detectedTexts, []);

    const contradictoryEvidence = [
      noCopyAssetEvidence({ textForbidden: false }),
      noCopyAssetEvidence({ textForbidden: "true" }),
      noCopyAssetEvidence({ textRequired: true }),
      noCopyAssetEvidence({ sourceFactIds: ["fact-a"] }),
      noCopyAssetEvidence({
        checkerResult: {
          claimsVerified: true,
          evidence: { claims: [{ text: "unsupported" }], detectedTexts: [] },
        },
      }),
      noCopyAssetEvidence({
        checkerResult: {
          claimsVerified: true,
          evidence: { claims: [], detectedTexts: ["unsupported"] },
        },
      }),
    ];
    for (const evidence of contradictoryEvidence) assert.equal(await project(evidence), null);
  } finally {
    await client.query(`DROP SCHEMA IF EXISTS ${quote(schema)} CASCADE`);
    client.release();
    await pool.end();
  }
});
