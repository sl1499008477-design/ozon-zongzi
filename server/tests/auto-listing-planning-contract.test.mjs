import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  AUTO_LISTING_PLANNING_CONTRACTS,
  selectAutoListingPlanningContract,
} from "../auto-listing-planning-contract.mjs";

test("all new collect-box and Excel items use the server-owned fixed skeleton by default", () => {
  for (const candidate of [
    { accountId: "account-a", sourceType: "COLLECT_BOX", collectItemId: "collect-a" },
    { accountId: "account-b", sourceType: "COLLECT_BOX", collectItemId: "collect-b" },
    { accountId: "account-a", sourceType: "EXCEL_SKU", collectItemId: "excel-a" },
  ]) {
    assert.equal(
      selectAutoListingPlanningContract(candidate),
      AUTO_LISTING_PLANNING_CONTRACTS.FIXED,
    );
  }
});

test("invalid selectors keep the legacy contract", () => {
  for (const candidate of [
    { accountId: "", sourceType: "COLLECT_BOX", collectItemId: "collect-a" },
    { accountId: "account-a", sourceType: "COLLECT_BOX", collectItemId: "" },
    { accountId: "account-a", sourceType: "UNKNOWN", collectItemId: "collect-a" },
    {},
  ]) {
    assert.equal(
      selectAutoListingPlanningContract(candidate),
      AUTO_LISTING_PLANNING_CONTRACTS.LEGACY,
    );
  }
});

test("selector rejects extra authority and hostile carriers without executing them", () => {
  let hits = 0;
  const selectorProxy = new Proxy({}, { get() { hits += 1; throw new Error("secret"); } });
  assert.equal(selectAutoListingPlanningContract(selectorProxy), AUTO_LISTING_PLANNING_CONTRACTS.LEGACY);
  assert.equal(hits, 0);

  assert.equal(selectAutoListingPlanningContract({
    accountId: "account-a",
    sourceType: "COLLECT_BOX",
    collectItemId: "collect-a",
    planningContract: "LEGACY_FULL_PLAN_V3",
  }), AUTO_LISTING_PLANNING_CONTRACTS.LEGACY);
});

test("content planning has one authoritative business validator", () => {
  const planner = fs.readFileSync(new URL("../auto-listing-content-planner.mjs", import.meta.url), "utf8");
  const validator = fs.readFileSync(new URL("../auto-listing-content-plan-validator.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(planner, /validateContentPlanLegacy/u);
  assert.match(validator, /const issues = collectIssues\(projected\.plan, projected\.plannerContext\);/u);
});
