import { assertPermission, PERMISSIONS } from "./permissions.mjs";
import { createAutoListingReviewView } from "./auto-listing-view.mjs";
import { hasCompleteReviewImageGroups } from "./auto-listing-review-evidence.mjs";
import { isSafeAutoListingPreOzonRetryFailure } from "./auto-listing-state-machine.mjs";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/u;

function reviewError(code, status = 422) {
  const error = new Error(code);
  error.code = code;
  error.status = status;
  return error;
}

function id(value) {
  const result = typeof value === "string" ? value.trim() : "";
  if (!SAFE_ID.test(result)) throw reviewError("AUTO_LISTING_REVIEW_INVALID");
  return result;
}

function input(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw reviewError("AUTO_LISTING_REVIEW_INVALID");
  const actual = Reflect.ownKeys(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (actual.length !== keys.length || actual.some((key) => typeof key !== "string" || !keys.includes(key)
    || descriptors[key]?.enumerable !== true || !Object.hasOwn(descriptors[key], "value"))) {
    throw reviewError("AUTO_LISTING_REVIEW_INVALID");
  }
  return value;
}

function account(actor) {
  assertPermission(actor, PERMISSIONS.TENANT_OPERATE);
  return id(actor?.id);
}

function reviewIsReady(evidence) {
  const images = Array.isArray(evidence?.images) ? evidence.images : [];
  const reviewableStatus = ["READY_FOR_REVIEW", "SUCCEEDED"].includes(evidence?.item?.status)
    || (evidence?.item?.status === "BLOCKED"
      && isSafeAutoListingPreOzonRetryFailure(evidence.item.failureCode));
  return reviewableStatus
    && hasCompleteReviewImageGroups({ visualGroups: evidence?.visualGroups, images })
    && evidence?.richContent?.accepted === true;
}

export function createAutoListingReviewService({ repository } = {}) {
  if (typeof repository?.loadReviewEvidence !== "function") {
    throw new TypeError("Auto-listing review repository is required");
  }
  return Object.freeze({
    async getReview(value = {}) {
      const { actor, itemId: rawItemId } = input(value, ["actor", "itemId"]);
      const accountId = account(actor);
      const itemId = id(rawItemId);
      const evidence = await repository.loadReviewEvidence({ accountId, itemId });
      if (!evidence || evidence.accountId !== accountId) throw reviewError("AUTO_LISTING_REVIEW_NOT_FOUND", 404);
      if (!reviewIsReady(evidence)) throw reviewError("AUTO_LISTING_REVIEW_NOT_READY");
      return createAutoListingReviewView(evidence);
    },

    async getAcceptedAsset(value = {}) {
      const { actor, itemId: rawItemId, assetId: rawAssetId } = input(value, ["actor", "itemId", "assetId"]);
      const accountId = account(actor);
      const itemId = id(rawItemId);
      const assetId = id(rawAssetId);
      if (typeof repository.loadAcceptedAsset !== "function") {
        throw new TypeError("Auto-listing review asset repository is required");
      }
      const asset = await repository.loadAcceptedAsset({ accountId, itemId, assetId });
      if (!asset || asset.accountId !== accountId || asset.itemId !== itemId || asset.assetId !== assetId) {
        throw reviewError("AUTO_LISTING_REVIEW_ASSET_NOT_FOUND", 404);
      }
      return asset;
    },
  });
}
