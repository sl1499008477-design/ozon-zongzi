import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { createAutoListingCategoryStrategyPostgres } from "../auto-listing-category-strategy-postgres.mjs";

const sha = (value) => crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
const normalized = (sql) => String(sql).replaceAll(/\s+/gu, " ").trim();

function sample(ordinal) {
  const sampleId = `sample-${ordinal}`;
  const objectPrefix = `category-strategy/account-a/draft-a/sample-set-a/${sampleId}`;
  return {
    sampleSetId: "sample-set-a",
    sampleId,
    sku: `sku-${ordinal}`,
    sourceProductId: 10_000 + ordinal,
    sourceProductRef: `ozon-product-${ordinal}`,
    sourceProductResponseHash: sha(`product-${ordinal}`),
    taxonomyScope: "OZON:DEFAULT",
    descriptionCategoryId: 170,
    typeId: 99,
    images: [{
      imageId: `ozon-${10_000 + ordinal}-0`,
      role: "MAIN",
      ordinal: 0,
      sourceUrlHost: "cdn.example.test",
      sourceRefHash: sha(`source-ref-${ordinal}`),
      sourceResponseHash: sha(`image-response-${ordinal}`),
      sourceContentHash: sha(`source-content-${ordinal}`),
      analysisObjectKey: `${objectPrefix}/analysis.webp`,
      analysisContentHash: sha(`analysis-${ordinal}`),
      thumbnailObjectKey: `${objectPrefix}/thumbnail.webp`,
      thumbnailContentHash: sha(`thumbnail-${ordinal}`),
      contentType: "image/webp",
      width: 1200,
      height: 1600,
      capturedAt: "2026-08-22T00:00:00.000Z",
    }],
  };
}

function fixture() {
  const imageInserts = [];
  const client = {
    async query(sql, parameters = []) {
      const text = normalized(sql);
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(text)) return { rows: [] };
      if (text.startsWith("SELECT id FROM accounts")) return { rows: [{ id: "account-a" }] };
      if (text.includes("FROM auto_listing_category_strategy_events")
        || text.includes("FROM audit_events")
        || text.includes("FROM auto_listing_category_strategy_analysis_attempts")
        || text.includes("FROM auto_listing_category_strategy_analysis_results")) {
        if (text.startsWith("SELECT event_payload")) return { rows: [{ event_payload: {} }] };
        return { rows: [] };
      }
      if (text.includes("FROM auto_listing_category_strategy_sample_sets sample_set")) return { rows: [] };
      if (text.startsWith("SELECT mode FROM auto_listing_category_strategy_account_settings")) {
        return { rows: [{ mode: "REQUIRE_EXACT_STRATEGY" }] };
      }
      if (text.startsWith("SELECT * FROM auto_listing_category_strategy_drafts")) {
        return { rows: [{
          id: "draft-a",
          account_id: "account-a",
          taxonomy_scope: "OZON:DEFAULT",
          description_category_id: 170,
          type_id: 99,
          draft_version: 1,
          status: "COLLECTING",
          source_collect_item_id: "collect-a",
          expected_source_version: "draft:7",
        }] };
      }
      if (text.includes("JOIN collect_ozon_category_current_sources pointer")) {
        return { rows: [{ id: "collect-a" }] };
      }
      if (text.startsWith("SELECT *,expires_at>STATEMENT_TIMESTAMP() AS unexpired")) {
        return { rows: [{
          id: "session-a",
          state: "ACTIVE",
          unexpired: true,
          session_secret_hash: sha("secret"),
          idempotency_key: "sampling-session-command-a",
        }] };
      }
      if (text.startsWith("INSERT INTO auto_listing_category_strategy_sample_images")) {
        imageInserts.push({ text, parameters });
        return { rows: [] };
      }
      if (text.startsWith("SELECT auto_listing_category_strategy_canonical_sample_set_hash")) {
        return { rows: [{ hash: "a".repeat(64) }] };
      }
      if (text.startsWith("UPDATE auto_listing_category_strategy_sample_sets")) {
        return { rows: [{
          sample_set_id: "sample-set-a",
          account_id: "account-a",
          draft_id: "draft-a",
          sample_set_hash: "a".repeat(64),
          sample_count: 5,
          idempotency_key: "commit-a",
        }] };
      }
      if (text.startsWith("UPDATE auto_listing_category_strategy_drafts")) {
        return { rows: [{
          id: "draft-a",
          account_id: "account-a",
          taxonomy_scope: "OZON:DEFAULT",
          description_category_id: 170,
          type_id: 99,
          draft_version: 2,
          status: "SAMPLES_READY",
        }] };
      }
      if (text.startsWith("INSERT INTO")) return { rows: [] };
      throw new Error(`unexpected query: ${text}`);
    },
    release() {},
  };
  return {
    imageInserts,
    pool: {
      async connect() { return client; },
      async query(sql, parameters) { return client.query(sql, parameters); },
    },
  };
}

test("sample image database ids are scoped to a commit while preserving the reusable Ozon image id", async () => {
  const database = fixture();
  const repository = createAutoListingCategoryStrategyPostgres({ pool: database.pool });
  const samples = Array.from({ length: 5 }, (_, ordinal) => sample(ordinal));

  const committed = await repository.commitSampleSetCanonical({
    accountId: "account-a",
    actorId: "account-a",
    draftId: "draft-a",
    sessionId: "session-a",
    sessionSecretHash: sha("secret"),
    expectedDraftVersion: 1,
    samples,
    idempotencyKey: "commit-a",
    correlationId: "correlation-a",
  });

  assert.equal(committed.status, "SAMPLES_READY");
  assert.equal(database.imageInserts.length, 5);
  for (const [ordinal, insert] of database.imageInserts.entries()) {
    assert.notEqual(insert.parameters[0], samples[ordinal].images[0].imageId);
    assert.equal(insert.parameters[8], samples[ordinal].images[0].imageId);
  }
});
