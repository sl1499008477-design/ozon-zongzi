import crypto from "node:crypto";

import { isSafeAutoListingAiIdentifier } from "./auto-listing-ai-message.mjs";
import {
  cacheAutoListingReviewPreview,
  readAutoListingReviewPreview,
} from "./auto-listing-review-preview.mjs";
import { getObjectBuffer } from "./object-storage.mjs";
import { autoListingEnabled } from "./runtime-config.mjs";

const ROUTE = /^\/auto-listing\/items\/([^/]+)\/assets\/([^/]+)(\/preview)?$/u;
const MAX_ASSET_BYTES = 25 * 1024 * 1024;
const MAX_PREVIEW_BYTES = 2 * 1024 * 1024;
const CONTENT_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

function routeError(code, status = 400) {
  const error = new Error("自动上架审核图片读取失败");
  error.code = code;
  error.status = status;
  return error;
}

function decodeId(value) {
  try {
    const decoded = decodeURIComponent(value);
    if (!isSafeAutoListingAiIdentifier(decoded)) throw routeError("AUTO_LISTING_REVIEW_ASSET_INVALID");
    return decoded;
  } catch (error) {
    if (error?.code === "AUTO_LISTING_REVIEW_ASSET_INVALID") throw error;
    throw routeError("AUTO_LISTING_REVIEW_ASSET_INVALID");
  }
}

function evidence(value, { accountId, itemId, assetId }) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || value.accountId !== accountId || value.itemId !== itemId || value.assetId !== assetId
    || typeof value.objectKey !== "string" || !value.objectKey || value.objectKey.length > 1024
    || !CONTENT_TYPES.has(value.contentType)
    || typeof value.contentHash !== "string" || !/^[a-f0-9]{64}$/u.test(value.contentHash)
    || !Number.isInteger(value.sizeBytes) || value.sizeBytes < 1 || value.sizeBytes > MAX_ASSET_BYTES) {
    throw routeError("AUTO_LISTING_REVIEW_ASSET_UNAVAILABLE", 503);
  }
  return value;
}

function safeError(error) {
  if (Number(error?.status) === 401) {
    return { status: 401, code: "AUTO_LISTING_UNAUTHENTICATED", message: "请先登录" };
  }
  if (Number(error?.status) === 403 || error?.code === "PERMISSION_FORBIDDEN") {
    return { status: 403, code: "PERMISSION_FORBIDDEN", message: "没有查看自动上架审核图片的权限" };
  }
  if (error?.code === "AUTO_LISTING_REVIEW_ASSET_NOT_FOUND") {
    return { status: 404, code: error.code, message: "审核图片不存在" };
  }
  if (error?.code === "AUTO_LISTING_REVIEW_ASSET_INVALID") {
    return { status: 400, code: error.code, message: "审核图片请求无效" };
  }
  return { status: 503, code: "AUTO_LISTING_REVIEW_ASSET_UNAVAILABLE", message: "审核图片暂时无法读取" };
}

export function createAutoListingReviewAssetHttpHandler({
  isEnabled = autoListingEnabled,
  authenticate,
  getService,
  getObject = getObjectBuffer,
  readPreview = readAutoListingReviewPreview,
  cachePreview = cacheAutoListingReviewPreview,
  sendJson,
} = {}) {
  if (typeof isEnabled !== "function" || typeof authenticate !== "function"
    || typeof getService !== "function" || typeof getObject !== "function"
    || typeof readPreview !== "function" || typeof cachePreview !== "function"
    || typeof sendJson !== "function") {
    throw new TypeError("Auto-listing review asset route dependencies are required");
  }
  return async function handleAutoListingReviewAsset(req, res, url) {
    const match = url.pathname.match(ROUTE);
    if (!match) return false;
    try {
      const actor = await authenticate(req);
      if (req.method !== "GET") {
        sendJson(res, 405, { ok: false, code: "AUTO_LISTING_REVIEW_ASSET_METHOD_NOT_ALLOWED", message: "不支持的审核图片操作" });
        return true;
      }
      if (!isEnabled()) {
        sendJson(res, 503, { ok: false, code: "AUTO_LISTING_DISABLED", message: "自动上架功能暂未启用" });
        return true;
      }
      if ([...url.searchParams.keys()].length) throw routeError("AUTO_LISTING_REVIEW_ASSET_INVALID");
      const itemId = decodeId(match[1]);
      const assetId = decodeId(match[2]);
      const previewRequested = match[3] === "/preview";
      const service = await getService();
      if (typeof service?.getAcceptedAsset !== "function") {
        throw routeError("AUTO_LISTING_REVIEW_ASSET_UNAVAILABLE", 503);
      }
      const record = evidence(await service.getAcceptedAsset({ actor, itemId, assetId }), {
        accountId: actor?.id, itemId, assetId,
      });
      let responseBytes;
      let responseContentType;
      if (previewRequested) {
        responseBytes = await readPreview({ contentHash: record.contentHash });
        if (responseBytes === null) {
          const stored = await getObject(record.objectKey, { maxBytes: record.sizeBytes });
          if (!Buffer.isBuffer(stored) || stored.length !== record.sizeBytes
            || crypto.createHash("sha256").update(stored).digest("hex") !== record.contentHash) {
            throw routeError("AUTO_LISTING_REVIEW_ASSET_UNAVAILABLE", 503);
          }
          responseBytes = await cachePreview({ contentHash: record.contentHash, bytes: stored });
        }
        if (!Buffer.isBuffer(responseBytes) || responseBytes.length < 1 || responseBytes.length > MAX_PREVIEW_BYTES) {
          throw routeError("AUTO_LISTING_REVIEW_ASSET_UNAVAILABLE", 503);
        }
        responseContentType = "image/webp";
      } else {
        responseBytes = await getObject(record.objectKey, { maxBytes: record.sizeBytes });
        if (!Buffer.isBuffer(responseBytes) || responseBytes.length !== record.sizeBytes
          || crypto.createHash("sha256").update(responseBytes).digest("hex") !== record.contentHash) {
          throw routeError("AUTO_LISTING_REVIEW_ASSET_UNAVAILABLE", 503);
        }
        responseContentType = record.contentType;
      }
      if (typeof res?.writeHead !== "function" || typeof res?.end !== "function") {
        throw routeError("AUTO_LISTING_REVIEW_ASSET_UNAVAILABLE", 503);
      }
      res.writeHead(200, {
        "Content-Type": responseContentType,
        "Content-Length": String(responseBytes.length),
        "Cache-Control": previewRequested ? "private, max-age=86400, immutable" : "private, max-age=60",
        "X-Content-Type-Options": "nosniff",
      });
      res.end(responseBytes);
    } catch (error) {
      const response = safeError(error);
      sendJson(res, response.status, { ok: false, code: response.code, message: response.message });
    }
    return true;
  };
}
