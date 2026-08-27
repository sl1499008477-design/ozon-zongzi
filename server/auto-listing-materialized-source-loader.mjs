import crypto from "node:crypto";

import {
  isSafeSourceScopeIdentifier,
} from "./auto-listing-source-asset-store.mjs";
import {
  verifySourceMaterializationObjectKey,
} from "./auto-listing-source-materialization-repository.mjs";

const REQUEST_KEYS = new Set([
  "accountId", "jobId", "itemId", "planId", "visualGroupKey", "slotKey",
  "expectedStatusVersion", "assetId", "sourceRef", "evidenceKind",
]);
const FACTORY_KEYS = new Set(["pool", "repository", "storage"]);
const HASH = /^[a-f0-9]{64}$/u;
const CONTENT_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const MAX_SOURCE_BYTES = 8 * 1024 * 1024;

function loaderError(code, retryable = false) {
  const error = new Error("自动上架来源图片暂时无法读取");
  error.code = code;
  error.retryable = retryable;
  return error;
}

function plainObject(value) {
  try {
    return value !== null && typeof value === "object" && !Array.isArray(value)
      && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
  } catch {
    return false;
  }
}

function exactObject(value, keys) {
  try {
    const actual = Reflect.ownKeys(value);
    return plainObject(value) && actual.length === keys.size
      && actual.every((key) => typeof key === "string" && keys.has(key));
  } catch {
    return false;
  }
}

function validRequest(input) {
  return exactObject(input, REQUEST_KEYS)
    && ["accountId", "jobId", "itemId", "planId", "visualGroupKey", "slotKey", "assetId"]
      .every((key) => isSafeSourceScopeIdentifier(input[key]))
    && Number.isInteger(input.expectedStatusVersion) && input.expectedStatusVersion >= 1
    && input.expectedStatusVersion <= 2_147_483_647
    && input.sourceRef === null && input.evidenceKind === "CONTENT_HASH";
}

function validAccepted(record, request, parentPlanId) {
  return plainObject(record) && record.status === "ACCEPTED"
    && record.accountId === request.accountId && record.jobId === request.jobId
    && record.itemId === request.itemId && record.parentPlanId === parentPlanId
    && record.sourceAssetId === request.assetId
    && record.objectKeyVersion === "SOURCE_V1"
    && verifySourceMaterializationObjectKey(record)
    && HASH.test(record.contentHash || "") && CONTENT_TYPES.has(record.contentType)
    && Number.isInteger(record.width) && record.width >= 1
    && Number.isInteger(record.height) && record.height >= 1
    && Number.isInteger(record.sizeBytes) && record.sizeBytes >= 1
    && record.sizeBytes <= MAX_SOURCE_BYTES;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function createActiveMaterializedSourceAssetLoader(options = {}) {
  if (!exactObject(options, FACTORY_KEYS)
    || typeof options.pool?.query !== "function"
    || typeof options.repository?.listAcceptedSourceMaterializationsForPlan !== "function"
    || typeof options.storage?.getObjectBuffer !== "function") {
    throw loaderError("AUTO_LISTING_SOURCE_ASSET_LOADER_INVALID");
  }
  const { pool, repository, storage } = options;

  async function loadSourceAsset(input) {
    if (!validRequest(input)) throw loaderError("AUTO_LISTING_SOURCE_ASSET_LOADER_INVALID");
    try {
      const result = await pool.query(
        `SELECT plan.parent_plan_id
           FROM auto_listing_job_items AS item
           JOIN ai_content_plans AS plan
             ON plan.account_id=item.account_id AND plan.job_id=item.job_id
            AND plan.item_id=item.id AND plan.id=$4
          WHERE item.account_id=$1 AND item.job_id=$2 AND item.id=$3
            AND item.active_content_plan_id=plan.id AND item.status='GENERATING'
            AND item.status_version=$5
            AND plan.derivation_kind='SOURCE_MATERIALIZATION'`,
        [input.accountId, input.jobId, input.itemId, input.planId, input.expectedStatusVersion],
      );
      if (!result || !Array.isArray(result.rows) || result.rows.length !== 1
        || !isSafeSourceScopeIdentifier(result.rows[0]?.parent_plan_id)) {
        throw loaderError("AUTO_LISTING_SOURCE_ASSET_LOADER_UNAVAILABLE", true);
      }
      const parentPlanId = result.rows[0].parent_plan_id;
      const records = await repository.listAcceptedSourceMaterializationsForPlan({
        accountId: input.accountId,
        jobId: input.jobId,
        itemId: input.itemId,
        parentPlanId,
      });
      if (!Array.isArray(records)) throw loaderError("AUTO_LISTING_SOURCE_ASSET_LOADER_UNAVAILABLE", true);
      const matches = records.filter((record) => record?.sourceAssetId === input.assetId);
      if (matches.length !== 1 || !validAccepted(matches[0], input, parentPlanId)) {
        throw loaderError("AUTO_LISTING_SOURCE_ASSET_LOADER_UNAVAILABLE", true);
      }
      const record = matches[0];
      const stored = await storage.getObjectBuffer(record.objectKey, { maxBytes: MAX_SOURCE_BYTES });
      const bytes = Buffer.isBuffer(stored) ? Buffer.from(stored) : null;
      if (!bytes || bytes.length !== record.sizeBytes || sha256(bytes) !== record.contentHash) {
        throw loaderError("AUTO_LISTING_SOURCE_ASSET_LOADER_UNAVAILABLE", true);
      }
      return Object.freeze({
        assetId: record.sourceAssetId,
        sourceRef: null,
        evidenceKind: "CONTENT_HASH",
        bytes,
        contentType: record.contentType,
        width: record.width,
        height: record.height,
      });
    } catch (error) {
      if (error?.code === "AUTO_LISTING_SOURCE_ASSET_LOADER_UNAVAILABLE") throw error;
      throw loaderError("AUTO_LISTING_SOURCE_ASSET_LOADER_UNAVAILABLE", true);
    }
  }

  return Object.freeze({ loadSourceAsset });
}
