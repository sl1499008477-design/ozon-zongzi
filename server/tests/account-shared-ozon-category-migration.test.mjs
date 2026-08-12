import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { mirrorStateToRelationalTablesInTransaction } from "../formal-persistence.mjs";

const migrationUrl = new URL(
  "../db/migrations/063_account_shared_ozon_categories.sql",
  import.meta.url,
);

function normalizedSql(sql) {
  return String(sql).replace(/\s+/g, " ").trim();
}

test("063 creates closed account-scoped source evidence and shared category contracts", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  const compact = normalizedSql(sql);

  assert.match(sql, /CREATE TABLE collect_ozon_category_source_evidence/i);
  assert.match(sql, /CREATE TABLE account_ozon_shared_categories/i);
  assert.match(sql, /CREATE TABLE account_ozon_shared_category_events/i);

  assert.match(compact, /FOREIGN KEY \(account_id,collect_item_id\) REFERENCES collect_items\(account_id,id\)/i);
  assert.match(compact, /FOREIGN KEY \(account_id,enrichment_source,enrichment_sku,enrichment_contract_version\) REFERENCES collector_ozon_enrichment_cache\(account_id,source,sku,contract_version\)/i);
  assert.match(compact, /UNIQUE \(account_id,source_kind,source_record_id,source_version\)/i);
  assert.match(compact, /source_description_category_id BIGINT NOT NULL CHECK \(source_description_category_id > 0\)/i);
  assert.match(compact, /source_type_id BIGINT NOT NULL CHECK \(source_type_id > 0\)/i);
  assert.match(compact, /captured_at TIMESTAMPTZ NOT NULL/i);
  assert.match(compact, /raw_response_hash TEXT NOT NULL CHECK \(raw_response_hash ~ '\^\[0-9a-f\]\{64\}\$'\)/i);
  assert.match(compact, /raw_response_ref TEXT NOT NULL CHECK \(NULLIF\(BTRIM\(raw_response_ref\), ''\) IS NOT NULL\)/i);
  assert.match(compact, /provenance JSONB NOT NULL[\s\S]*jsonb_typeof\(provenance\) = 'object'/i);

  assert.match(
    compact,
    /UNIQUE \(account_id,source_description_category_id,source_type_id,taxonomy_scope\)/i,
  );
  assert.match(compact, /status TEXT NOT NULL CHECK \(status IN \('ACTIVE','INVALIDATED','NEEDS_REVIEW'\)\)/i);
  assert.match(compact, /source TEXT NOT NULL CHECK \(source IN \('SOURCE_DIRECT','OZON_REFRESH','MANUAL'\)\)/i);
  assert.match(compact, /version INTEGER NOT NULL DEFAULT 1 CHECK \(version > 0\)/i);
  assert.match(compact, /current_description_category_id BIGINT NOT NULL CHECK \(current_description_category_id > 0\)/i);
  assert.match(compact, /current_type_id BIGINT NOT NULL CHECK \(current_type_id > 0\)/i);
  assert.match(compact, /taxonomy_fingerprint TEXT CHECK \(taxonomy_fingerprint IS NULL OR taxonomy_fingerprint ~ '\^\[0-9a-f\]\{64\}\$'\)/i);
  assert.match(compact, /safe_failure_code TEXT NOT NULL DEFAULT ''/i);
  assert.match(compact, /FOREIGN KEY \(account_id,source_evidence_id\) REFERENCES collect_ozon_category_source_evidence\(account_id,id\)/i);
  assert.match(compact, /FOREIGN KEY \(account_id,raw_response_ref,collect_item_id\) REFERENCES collect_raw_payloads\(account_id,id,collect_item_id\)/i);
  assert.match(compact, /account_ozon_shared_categories_due_idx/i);
  assert.match(compact, /account_ozon_shared_categories_read_idx/i);
});

test("063 guards current transitions, freezes evidence/events, and removes only retired category tables", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  const compact = normalizedSql(sql);

  assert.match(compact, /CREATE OR REPLACE FUNCTION guard_account_ozon_shared_category_transition\(\)/i);
  assert.match(compact, /NEW\.version <> OLD\.version \+ 1/i);
  assert.match(compact, /CREATE TRIGGER account_ozon_shared_categories_transition_guard BEFORE UPDATE OR DELETE/i);
  assert.match(compact, /CREATE OR REPLACE FUNCTION record_account_ozon_shared_category_transition\(\)/i);
  assert.match(compact, /CREATE TRIGGER account_ozon_shared_categories_transition_event AFTER UPDATE/i);
  assert.match(compact, /CREATE OR REPLACE FUNCTION reject_collect_ozon_category_source_evidence_mutation\(\)/i);
  assert.match(compact, /CREATE TRIGGER collect_ozon_category_source_evidence_immutable BEFORE UPDATE OR DELETE/i);
  assert.match(compact, /CREATE OR REPLACE FUNCTION reject_account_ozon_shared_category_event_mutation\(\)/i);
  assert.match(compact, /CREATE TRIGGER account_ozon_shared_category_events_append_only BEFORE UPDATE OR DELETE/i);
  assert.match(compact, /ERRCODE='23514'/i);
  assert.match(compact, /MIGRATED_SOURCE_DIRECT/i);

  assert.match(compact, /DROP TABLE collect_category_resolution_runtime_cursors/i);
  assert.match(compact, /DROP TABLE collect_category_resolutions/i);
  for (const protectedTable of [
    "audit_events",
    "auto_listing_events",
    "submission_events",
    "collect_raw_payloads",
    "product_drafts",
    "collector_ozon_enrichment_cache",
  ]) {
    assert.doesNotMatch(
      compact,
      new RegExp(`(?:DELETE\\s+FROM|UPDATE|DROP\\s+TABLE|TRUNCATE\\s+TABLE)\\s+${protectedTable}\\b`, "i"),
    );
  }
});

test("failed relational mirror does not mutate retired fields on the caller state", async () => {
  const state = {
    accounts: [{ id: "account-a", username: "account-a" }],
    collectCategoryResolutions: [{
      id: "legacy-target",
      accountId: "account-a",
      targetDescriptionCategoryId: 999_999,
      targetTypeId: 888_888,
      status: "MATCHED",
    }],
    collectCategoryResolutionRuntimeCursors: { global: "legacy-cursor" },
    caches: {
      collectBox: [{
        id: "collect-a",
        accountId: "account-a",
        sourceCategory: {
          descriptionCategoryId: 17_039_736,
          typeIdCandidate: 123_456,
        },
      }],
    },
  };
  const client = {
    async query() {
      throw new Error("forced relational mirror failure");
    },
  };
  const before = structuredClone(state);

  await assert.rejects(
    mirrorStateToRelationalTablesInTransaction(client, state),
    /forced relational mirror failure/,
  );

  assert.deepEqual(state, before);
  assert.deepEqual(state.caches.collectBox[0].sourceCategory, {
    descriptionCategoryId: 17_039_736,
    typeIdCandidate: 123_456,
  });
});

test("JSON first load atomically removes retired category state and preserves source facts", async () => {
  process.env.QH_LOCAL_NO_DOTENV = "1";
  delete process.env.DATABASE_URL;
  delete process.env.POSTGRES_HOST;
  const { loadPersistedState } = await import("../persistence.mjs");
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "shared-category-json-load-"));
  const dataFile = path.join(dataDir, "local-state.json");
  const fixture = {
    collectCategoryResolutions: [{ targetDescriptionCategoryId: 999_999, targetTypeId: 888_888 }],
    collectCategoryResolutionRuntimeCursors: { global: "legacy" },
    caches: {
      collectBox: [{
        id: "collect-a",
        sourceCategory: { descriptionCategoryId: 17_039_736, typeIdCandidate: 123_456 },
      }],
    },
  };
  await writeFile(dataFile, JSON.stringify(fixture), "utf8");

  const loaded = await loadPersistedState({ dataFile });
  const stored = JSON.parse(await readFile(dataFile, "utf8"));

  for (const state of [loaded, stored]) {
    assert.equal(Object.hasOwn(state, "collectCategoryResolutions"), false);
    assert.equal(Object.hasOwn(state, "collectCategoryResolutionRuntimeCursors"), false);
    assert.deepEqual(state.caches.collectBox[0].sourceCategory, {
      descriptionCategoryId: 17_039_736,
      typeIdCandidate: 123_456,
    });
  }
});

test("JSON save removes retired category state only after the atomic write succeeds", async () => {
  process.env.QH_LOCAL_NO_DOTENV = "1";
  delete process.env.DATABASE_URL;
  delete process.env.POSTGRES_HOST;
  const { savePersistedState } = await import("../persistence.mjs");
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "shared-category-json-save-"));
  const dataFile = path.join(dataDir, "local-state.json");
  const state = {
    collectCategoryResolutions: [{ targetDescriptionCategoryId: 999_999, targetTypeId: 888_888 }],
    collectCategoryResolutionRuntimeCursors: { global: "legacy" },
    caches: {
      collectBox: [{
        id: "collect-a",
        sourceCategory: { descriptionCategoryId: 17_039_736, typeIdCandidate: 123_456 },
      }],
    },
  };

  await savePersistedState({ dataDir, dataFile, state });
  const stored = JSON.parse(await readFile(dataFile, "utf8"));

  for (const value of [state, stored]) {
    assert.equal(Object.hasOwn(value, "collectCategoryResolutions"), false);
    assert.equal(Object.hasOwn(value, "collectCategoryResolutionRuntimeCursors"), false);
    assert.deepEqual(value.caches.collectBox[0].sourceCategory, {
      descriptionCategoryId: 17_039_736,
      typeIdCandidate: 123_456,
    });
  }
});
