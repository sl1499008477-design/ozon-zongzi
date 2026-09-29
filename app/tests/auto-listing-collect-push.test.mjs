import assert from "node:assert/strict";
import test from "node:test";

import { buildAutoListingCollectPush } from "../src/auto-listing-collect-push.js";

test("rejects an empty selection with a stable user-facing code", () => {
  assert.throws(() => buildAutoListingCollectPush({
    selectedIds: [], visibleItems: [], accountId: "account-a",
  }), { code: "AUTO_LISTING_COLLECT_SELECTION_EMPTY" });
});

test("deduplicates in first-seen order and safely encodes the navigation query", () => {
  const result = buildAutoListingCollectPush({
    selectedIds: ["collect/a", "collect b", "collect/a"],
    visibleItems: [
      { id: "collect/a", accountId: "account-a" },
      { id: "collect b", accountId: "account-a" },
    ],
    accountId: "account-a",
  });
  assert.deepEqual(result, {
    ids: ["collect/a", "collect b"],
    path: "/ozon/tools/ai-listing?source=collect&ids=collect%2Fa%2Ccollect%20b",
  });
});

test("refuses hidden, foreign-account, or malformed selected rows", () => {
  for (const fixture of [
    {
      selectedIds: ["hidden"],
      visibleItems: [{ id: "visible", accountId: "account-a" }],
    },
    {
      selectedIds: ["foreign"],
      visibleItems: [{ id: "foreign", accountId: "account-b" }],
    },
    {
      selectedIds: ["\u0000bad"],
      visibleItems: [{ id: "\u0000bad", accountId: "account-a" }],
    },
  ]) {
    assert.throws(() => buildAutoListingCollectPush({ ...fixture, accountId: "account-a" }), {
      code: "AUTO_LISTING_COLLECT_SELECTION_INVALID",
    });
  }
});

test("produces navigation data only and has no transport dependency", () => {
  let calls = 0;
  const result = buildAutoListingCollectPush({
    selectedIds: ["collect-a"],
    visibleItems: [{ id: "collect-a" }],
    accountId: "account-a",
    apiRequest: () => { calls += 1; },
  });
  assert.equal(result.path, "/ozon/tools/ai-listing?source=collect&ids=collect-a");
  assert.equal(calls, 0);
});

test("defaults to AI listing and rejects retired destinations", () => {
  const input = {
    selectedIds: ["collect-a"],
    visibleItems: [{ id: "collect-a", accountId: "account-a" }],
    accountId: "account-a",
  };
  assert.equal(buildAutoListingCollectPush(input).path, "/ozon/tools/ai-listing?source=collect&ids=collect-a");
  assert.equal(buildAutoListingCollectPush({ ...input, destination: "ai-listing" }).path,
    "/ozon/tools/ai-listing?source=collect&ids=collect-a");
  assert.throws(() => buildAutoListingCollectPush({ ...input, destination: "auto-listing" }), {
    code: "AUTO_LISTING_COLLECT_SELECTION_INVALID",
  });
});
