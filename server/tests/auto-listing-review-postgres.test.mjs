import assert from "node:assert/strict";
import test from "node:test";

import { createPostgresAutoListingReviewRepository } from "../auto-listing-review-postgres.mjs";

const price = {
  currency: "RUB", branch: "BLACK_GTE_80", blackKopecks: "10000", greenKopecks: "8000",
  realPriceKopecks: "14500", adjustmentKopecks: "0", finalPriceKopecks: "14500",
};

function mainRow(overrides = {}) {
  return {
    id: "item-a", account_id: "account-a", job_id: "job-a", status: "READY_FOR_REVIEW",
    status_version: 5, failure_code: null, target_store_id: "store-a",
    target_warehouse_id: "warehouse-a", active_content_plan_id: "plan-a",
    source_record_id: "collect-a", snapshot: {
      identity: { primaryName: "Термос", primarySku: "1001" },
      media: { images: ["https://cdn.example/source.jpg"] },
    },
    config_snapshot: { stock: 5 },
    store_id: "store-a", store_account_id: "account-a", store_label: "主店", store_company_name: "",
    warehouse_id: "warehouse-a", warehouse_name: "CEL-陆运", plan_id: "plan-a",
    variant_count: 2,
    visual_groups: { groups: [{ visualGroupKey: "group-a", referenceImages: [{ assetId: "source-a" }] }] },
    ...overrides,
  };
}

function asset(index, role = index === 0 ? "MAIN" : "SELLING_POINT") {
  return {
    id: `asset-${index + 1}`, account_id: "account-a", visual_group_key: "group-a", role, slot_key: `slot-${index + 1}`,
    object_key: `private/${index + 1}.png`, content_type: "image/png", content_hash: String(index + 1).repeat(64),
  };
}

function scripted({ row = mainRow(), assets = Array.from({ length: 6 }, (_, index) => asset(index)), rich = {
  account_id: "account-a", status: "ACCEPTED", rich_content: {
    version: "AUTO_LISTING_RICH_CONTENT_V1", language: "ru",
    blocks: [{ type: "HEADING", text: "Новый заголовок" },
      { type: "IMAGE_TEXT", assetId: "asset-1", text: "Текст рядом с изображением" },
      { type: "TEXT", text: "Описание" }, { type: "HERO_IMAGE", assetId: "asset-1" }],
  },
}, events = [
  { account_id: "account-a", event_type: "SOURCE_CAPTURED", to_status: "SOURCE_READY", details: { price }, created_at: new Date("2026-08-08T00:00:00.000Z") },
  { account_id: "account-a", event_type: "CONTENT_READY", to_status: "READY_FOR_REVIEW", details: {}, created_at: new Date("2026-08-08T01:00:00.000Z") },
] } = {}) {
  const calls = []; const control = [];
  const client = {
    async query(sql, values = []) {
      if (/^(BEGIN|COMMIT|ROLLBACK)/u.test(sql)) { control.push(sql); return { rows: [] }; }
      calls.push({ sql, values });
      if (/FROM auto_listing_job_items AS item/i.test(sql)) return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      if (/FROM ai_generation_assets AS asset/i.test(sql)) return { rows: assets, rowCount: assets.length };
      if (/FROM ai_rich_content_results AS rich/i.test(sql)) return { rows: rich ? [rich] : [], rowCount: rich ? 1 : 0 };
      if (/FROM auto_listing_events AS event/i.test(sql)) return { rows: events, rowCount: events.length };
      throw new Error(`unexpected SQL: ${sql}`);
    },
    release() {},
  };
  return { pool: { async connect() { return client; }, async query() {} }, calls, control };
}

test("review repository reads one account-scoped repeatable snapshot and returns only public evidence", async () => {
  const db = scripted();
  const repository = createPostgresAutoListingReviewRepository({ pool: db.pool });
  const evidence = await repository.loadReviewEvidence({ accountId: "account-a", itemId: "item-a" });
  assert.equal(evidence.item.statusVersion, 5);
  assert.equal(evidence.item.stock, 5);
  assert.equal(evidence.item.variantCount, 2);
  assert.deepEqual(evidence.item.price, price);
  assert.equal(evidence.images.length, 6);
  assert.equal(evidence.images[0].visualGroupKey, "group-a");
  assert.equal(evidence.images[0].publicUrl, "/auto-listing/items/item-a/assets/asset-1");
  assert.equal(evidence.richContent.previewText, "Новый заголовок\nТекст рядом с изображением\nОписание");
  assert.deepEqual(db.control, ["BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY", "COMMIT"]);
  assert.match(db.calls[0].sql, /JOIN auto_listing_jobs AS job[\s\S]*job\.account_id=item\.account_id/u);
  assert.match(db.calls[0].sql, /JOIN auto_listing_source_snapshots AS source[\s\S]*source\.account_id=item\.account_id/u);
  assert.match(db.calls[0].sql, /store\.owner_account_id=item\.account_id/u);
  assert.match(db.calls[0].sql, /warehouse\.store_id=store\.id/u);
  assert.match(db.calls[0].sql, /plan\.id=item\.active_content_plan_id/u);
  assert.match(db.calls[0].sql, /JOIN auto_listing_listing_bases AS base[\s\S]*base\.source_snapshot_id=item\.snapshot_id/u);
  assert.match(db.calls.find((call) => /FROM ai_generation_assets AS asset/i.test(call.sql)).sql, /visual_group_key/u);
  for (const call of db.calls) assert.equal(call.values[0], "account-a");
  assert.doesNotMatch(JSON.stringify(evidence), /object_key|private\//i);
});

test("review store label falls back from blank label to company name", async () => {
  const db = scripted({ row: mainRow({ store_label: "", store_company_name: "SonliShop" }) });
  const evidence = await createPostgresAutoListingReviewRepository({ pool: db.pool })
    .loadReviewEvidence({ accountId: "account-a", itemId: "item-a" });
  assert.equal(evidence.store.label, "SonliShop");
});

test("missing item returns null while incomplete current-plan evidence fails closed", async () => {
  const missing = scripted({ row: null });
  assert.equal(await createPostgresAutoListingReviewRepository({ pool: missing.pool })
    .loadReviewEvidence({ accountId: "account-a", itemId: "item-a" }), null);

  for (const fixture of [scripted({ rich: null }), scripted({ assets: [asset(0)] }), scripted({ row: mainRow({ active_content_plan_id: null }) })]) {
    await assert.rejects(createPostgresAutoListingReviewRepository({ pool: fixture.pool })
      .loadReviewEvidence({ accountId: "account-a", itemId: "item-a" }), {
      code: "AUTO_LISTING_REVIEW_NOT_READY",
    });
  }
});

test("review asset lookup never accepts an object key and is bound to current accepted plan", async () => {
  const calls = [];
  const pool = { async query(sql, values) {
    calls.push({ sql, values });
    return { rows: [{
      account_id: "account-a", item_id: "item-a", id: "asset-1", object_key: "private/1.png",
      content_type: "image/png", content_hash: "a".repeat(64), size_bytes: 1024,
    }], rowCount: 1 };
  }, async connect() {} };
  const repository = createPostgresAutoListingReviewRepository({ pool });
  assert.deepEqual(await repository.loadAcceptedAsset({ accountId: "account-a", itemId: "item-a", assetId: "asset-1" }), {
    accountId: "account-a", itemId: "item-a", assetId: "asset-1", objectKey: "private/1.png",
    contentType: "image/png", contentHash: "a".repeat(64), sizeBytes: 1024,
  });
  assert.deepEqual(calls[0].values, ["account-a", "item-a", "asset-1"]);
  assert.match(calls[0].sql, /asset\.plan_id=item\.active_content_plan_id/i);
  assert.match(calls[0].sql, /asset\.status='ACCEPTED'/i);
});

test("review repository rolls back and returns a stable failure when a database query fails", async () => {
  const controls = [];
  const pool = { async connect() { return {
    async query(sql) {
      if (/^(BEGIN|ROLLBACK)/u.test(sql)) { controls.push(sql); return { rows: [] }; }
      throw new Error("password=database-secret");
    },
    release() {},
  }; }, async query() {} };
  await assert.rejects(
    createPostgresAutoListingReviewRepository({ pool }).loadReviewEvidence({ accountId: "account-a", itemId: "item-a" }),
    (error) => error?.code === "AUTO_LISTING_REVIEW_FAILED" && !/password|secret/u.test(error.message),
  );
  assert.deepEqual(controls, ["BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY", "ROLLBACK"]);
});
