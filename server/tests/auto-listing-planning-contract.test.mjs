import assert from "node:assert/strict";
import test from "node:test";
import { autoListingFixedSkeletonPilotScope } from "../runtime-config.mjs";
import {
  AUTO_LISTING_PLANNING_CONTRACTS,
  selectAutoListingPlanningContract,
} from "../auto-listing-planning-contract.mjs";

test("selects fixed skeleton only for the exact enabled account and collect item", () => {
  const pilotScope = autoListingFixedSkeletonPilotScope({
    AUTO_LISTING_FIXED_SKELETON_PILOT_ENABLED: "true",
    AUTO_LISTING_FIXED_SKELETON_PILOT_ACCOUNT_ID: "account-a",
    AUTO_LISTING_FIXED_SKELETON_PILOT_COLLECT_ITEM_ID: "collect-a",
  });

  assert.equal(selectAutoListingPlanningContract({
    pilotScope,
    accountId: "account-a",
    sourceType: "COLLECT_BOX",
    collectItemId: "collect-a",
  }), AUTO_LISTING_PLANNING_CONTRACTS.FIXED);

  for (const candidate of [
    { accountId: "account-b", sourceType: "COLLECT_BOX", collectItemId: "collect-a" },
    { accountId: "account-a", sourceType: "COLLECT_BOX", collectItemId: "collect-b" },
    { accountId: "account-a", sourceType: "EXCEL_SKU", collectItemId: "collect-a" },
  ]) {
    assert.equal(selectAutoListingPlanningContract({ pilotScope, ...candidate }),
      AUTO_LISTING_PLANNING_CONTRACTS.LEGACY);
  }
});

test("disabled or incomplete pilot configuration fails closed", () => {
  assert.equal(autoListingFixedSkeletonPilotScope({}), null);
  assert.throws(() => autoListingFixedSkeletonPilotScope({
    AUTO_LISTING_FIXED_SKELETON_PILOT_ENABLED: "true",
    AUTO_LISTING_FIXED_SKELETON_PILOT_ACCOUNT_ID: "account-a",
  }), (error) => error?.code === "AUTO_LISTING_FIXED_SKELETON_CONFIG_INVALID");
});

test("pilot configuration and selector reject hostile carriers without executing them", () => {
  let hits = 0;
  const activeEnvProxy = new Proxy({
    AUTO_LISTING_FIXED_SKELETON_PILOT_ENABLED: "true",
    AUTO_LISTING_FIXED_SKELETON_PILOT_ACCOUNT_ID: "account-a",
    AUTO_LISTING_FIXED_SKELETON_PILOT_COLLECT_ITEM_ID: "collect-a",
  }, { get() { hits += 1; throw new Error("secret"); } });
  assert.throws(() => autoListingFixedSkeletonPilotScope(activeEnvProxy),
    (error) => error?.code === "AUTO_LISTING_FIXED_SKELETON_CONFIG_INVALID" && error?.cause === null);
  assert.equal(hits, 0);

  const accessorEnv = {};
  Object.defineProperty(accessorEnv, "AUTO_LISTING_FIXED_SKELETON_PILOT_ENABLED", {
    enumerable: true,
    get() { hits += 1; throw new Error("secret"); },
  });
  assert.throws(() => autoListingFixedSkeletonPilotScope(accessorEnv),
    (error) => error?.code === "AUTO_LISTING_FIXED_SKELETON_CONFIG_INVALID" && error?.cause === null);
  assert.equal(hits, 0);

  const selectorProxy = new Proxy({}, { get() { hits += 1; throw new Error("secret"); } });
  assert.equal(selectAutoListingPlanningContract(selectorProxy), AUTO_LISTING_PLANNING_CONTRACTS.LEGACY);
  assert.equal(hits, 0);
  assert.equal(selectAutoListingPlanningContract({
    pilotScope: { accountId: "account-a", collectItemId: "collect-a" },
    accountId: "account-a",
    sourceType: "COLLECT_BOX",
    collectItemId: "collect-a",
    planningContract: "FIXED_SKELETON_V1",
  }), AUTO_LISTING_PLANNING_CONTRACTS.LEGACY);
});

test("valid pilot scope is an immutable exact two-field value", () => {
  const scope = autoListingFixedSkeletonPilotScope({
    AUTO_LISTING_FIXED_SKELETON_PILOT_ENABLED: "1",
    AUTO_LISTING_FIXED_SKELETON_PILOT_ACCOUNT_ID: "account-a",
    AUTO_LISTING_FIXED_SKELETON_PILOT_COLLECT_ITEM_ID: "collect-a",
  });
  assert.deepEqual(Object.keys(scope), ["accountId", "collectItemId"]);
  assert.equal(Object.isFrozen(scope), true);
});
