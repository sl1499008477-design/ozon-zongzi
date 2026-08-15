import assert from "node:assert/strict";
import test from "node:test";

import { createAutoListingCategoryStrategyPostgres } from "../auto-listing-category-strategy-postgres.mjs";

const ACCOUNT_ID = "account-current-scope";
const SOURCE_SCOPE = Object.freeze({
  taxonomyScope: "OZON:DEFAULT",
  descriptionCategoryId: 43_434_952,
  typeId: 95_402,
});
const CURRENT_SCOPE = Object.freeze({
  taxonomyScope: "OZON:DEFAULT",
  descriptionCategoryId: 88_265_327,
  typeId: 95_402,
});

function normalized(sql) {
  return String(sql).replaceAll(/\s+/gu, " ").trim();
}

function currentSourceFixture() {
  const calls = [];
  const draftRow = (parameters) => ({
    id: parameters[0],
    account_id: ACCOUNT_ID,
    taxonomy_scope: parameters[2],
    description_category_id: parameters[3],
    type_id: parameters[4],
    draft_version: 1,
    status: "COLLECTING",
    source_collect_item_id: parameters[5],
    expected_source_version: parameters[8],
  });
  const client = {
    async query(sql, parameters = []) {
      const text = normalized(sql);
      calls.push({ text, parameters });
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(text)) return { rows: [] };
      if (text.startsWith("SELECT id FROM accounts")) return { rows: [{ id: ACCOUNT_ID }] };
      if (text.includes("FROM auto_listing_category_strategy_events")
        || text.includes("FROM audit_events")
        || text.includes("FROM auto_listing_category_strategy_analysis_attempts")
        || text.includes("FROM auto_listing_category_strategy_analysis_results")) return { rows: [] };
      if (text.startsWith("SELECT * FROM auto_listing_category_strategy_drafts")) return { rows: [] };
      if (text.startsWith("SELECT mode FROM auto_listing_category_strategy_account_settings")) {
        return { rows: [{ mode: "REQUIRE_EXACT_STRATEGY" }] };
      }
      if (text.includes("JOIN collect_ozon_category_current_sources pointer")) {
        const requestedDescriptionCategoryId = Number(parameters[4]);
        const requestedTypeId = Number(parameters[5]);
        let accepted = parameters[3] === CURRENT_SCOPE.taxonomyScope;
        if (text.includes("evidence.source_description_category_id=$5")) {
          accepted &&= requestedDescriptionCategoryId === SOURCE_SCOPE.descriptionCategoryId;
        }
        if (text.includes("evidence.source_type_id=$6")) {
          accepted &&= requestedTypeId === SOURCE_SCOPE.typeId;
        }
        if (text.includes("shared.current_description_category_id=$5")) {
          accepted &&= requestedDescriptionCategoryId === CURRENT_SCOPE.descriptionCategoryId;
        }
        if (text.includes("shared.current_type_id=$6")) {
          accepted &&= requestedTypeId === CURRENT_SCOPE.typeId;
        }
        return { rows: accepted ? [{ id: "collect-current-scope" }] : [] };
      }
      if (text.startsWith("SELECT draft.id FROM collect_items item")) {
        return { rows: [{ id: "product-draft-current-scope" }] };
      }
      if (text.startsWith("INSERT INTO auto_listing_category_strategy_drafts")) {
        return { rows: [draftRow(parameters)] };
      }
      if (text.startsWith("INSERT INTO auto_listing_category_strategy_events")) return { rows: [] };
      throw new Error(`unexpected query: ${text}`);
    },
    release() {},
  };
  return {
    calls,
    pool: {
      async connect() { return client; },
      async query(sql, parameters) { return client.query(sql, parameters); },
    },
  };
}

function createInput(scope, suffix) {
  return {
    accountId: ACCOUNT_ID,
    actorId: ACCOUNT_ID,
    scope: { accountId: ACCOUNT_ID, ...scope },
    sourceCollectItemId: "collect-current-scope",
    expectedSourceVersion: "draft:7",
    idempotencyKey: `create-current-scope-${suffix}`,
    correlationId: `create-current-scope-correlation-${suffix}`,
  };
}

test("draft creation accepts the active shared current scope after a verified source-category remap", async () => {
  const fixture = currentSourceFixture();
  const repository = createAutoListingCategoryStrategyPostgres({ pool: fixture.pool });

  const created = await repository.createDraft(createInput(CURRENT_SCOPE, "accepted"));

  assert.equal(created.status, "COLLECTING");
  assert.equal(created.scope.descriptionCategoryId, CURRENT_SCOPE.descriptionCategoryId);
  assert.equal(created.scope.typeId, CURRENT_SCOPE.typeId);
});

test("draft creation rejects the immutable source scope after the shared current scope was remapped", async () => {
  const fixture = currentSourceFixture();
  const repository = createAutoListingCategoryStrategyPostgres({ pool: fixture.pool });

  await assert.rejects(repository.createDraft(createInput(SOURCE_SCOPE, "rejected")), {
    code: "AUTO_LISTING_CATEGORY_STRATEGY_SOURCE_NOT_FOUND",
    status: 404,
  });
});
