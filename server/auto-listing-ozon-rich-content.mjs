import crypto from "node:crypto";
import net from "node:net";

export const AUTO_LISTING_OZON_RICH_CONTENT_VERSION = "AUTO_LISTING_OZON_RICH_CONTENT_V2";
const VERIFIED_AUTO_LISTING_OZON_RICH_CONTENT_VERSIONS = new Set([
  AUTO_LISTING_OZON_RICH_CONTENT_VERSION,
]);

export function isVerifiedAutoListingOzonRichContentVersion(value) {
  return typeof value === "string"
    && VERIFIED_AUTO_LISTING_OZON_RICH_CONTENT_VERSIONS.has(value);
}

const INTERNAL_VERSION = "AUTO_LISTING_RICH_CONTENT_V1";
const MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_TEXT_BYTES = 8_192;
const MAX_URL_BYTES = 8_192;
const HASH = /^[a-f0-9]{64}$/u;
const INPUT_KEYS = new Set(["richContent", "publishedAssets", "scope", "publicationPolicy"]);
const SCOPE_KEYS = new Set(["accountId", "jobId", "itemId", "planId", "visualGroupKey"]);
const PUBLICATION_POLICY_KEYS = new Set(["origin"]);
const DOCUMENT_KEYS = new Set(["version", "language", "blocks"]);
const ASSET_KEYS = new Set([
  "assetId", "status", "accountId", "jobId", "itemId", "planId", "visualGroupKey", "slotKey", "role", "publishedUrl", "contentHash",
  "width", "height", "publicationVersion",
]);
const FACT_BINDING_KEYS = new Set(["sourceFactId", "field", "value", "numericValue", "unit"]);
const TEXT_BLOCK_KEYS = new Set(["type", "text", "sourceFactIds", "factBindings"]);
const IMAGE_TEXT_BLOCK_KEYS = new Set(["type", "assetId", "text", "sourceFactIds", "factBindings"]);
const HERO_BLOCK_KEYS = new Set(["type", "assetId"]);
const ROLES = new Set(["MAIN", "SELLING_POINT", "DETAIL", "SCENE", "SPECIFICATION", "INFOGRAPHIC"]);
const TEMPORARY_QUERY = /(?:^|[?&])(?:x-amz-(?:algorithm|credential|date|expires|security-token|signature)|expires?|signature|token|auth|key)=/iu;

function invalid() {
  const error = new Error("Ozon 富文本转换输入无效");
  error.code = "AUTO_LISTING_OZON_RICH_CONTENT_INVALID";
  error.retryable = false;
  return error;
}

const plainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const exactObject = (value, keys) => plainObject(value)
  && Object.keys(value).length === keys.size && Object.keys(value).every((key) => keys.has(key));

function cleanText(value, maximum = 240) {
  return typeof value === "string" && value.length > 0 && value === value.trim()
    && Buffer.byteLength(value, "utf8") <= maximum
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function publicationOrigin(value) {
  if (!exactObject(value, PUBLICATION_POLICY_KEYS) || !cleanText(value.origin, 2_048)) throw invalid();
  let parsed;
  try { parsed = new URL(value.origin); } catch { throw invalid(); }
  const hostname = parsed.hostname.toLowerCase();
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.pathname !== "/"
    || parsed.search || parsed.hash || parsed.origin !== value.origin || !hostname.includes(".")
    || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")
    || net.isIP(hostname) || hostname.includes(":")) throw invalid();
  return parsed.origin;
}

function publicHttpsUrl(value, requiredOrigin) {
  if (!cleanText(value, MAX_URL_BYTES)) throw invalid();
  let parsed;
  try { parsed = new URL(value); } catch { throw invalid(); }
  const normalized = parsed.toString();
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash
    || TEMPORARY_QUERY.test(parsed.search) || parsed.search || normalized !== value
    || parsed.origin !== requiredOrigin) throw invalid();
  return normalized;
}

function normalizeAsset(value, scope, requiredOrigin) {
  if (!exactObject(value, ASSET_KEYS) || !cleanText(value.assetId) || value.status !== "ACCEPTED"
    || !cleanText(value.slotKey) || !ROLES.has(value.role)
    || [...SCOPE_KEYS].some((key) => value[key] !== scope[key])
    || !HASH.test(value.contentHash || "") || !cleanText(value.publicationVersion)
    || !Number.isSafeInteger(value.width) || value.width < 1 || value.width > 100_000
    || !Number.isSafeInteger(value.height) || value.height < 1 || value.height > 100_000) throw invalid();
  return {
    assetId: value.assetId,
    role: value.role,
    url: publicHttpsUrl(value.publishedUrl, requiredOrigin),
    width: value.width,
    height: value.height,
  };
}

function normalizeAssets(values, scope, requiredOrigin) {
  if (!Array.isArray(values) || values.length < 1 || values.length > 260) throw invalid();
  const byId = new Map();
  for (const value of values) {
    const asset = normalizeAsset(value, scope, requiredOrigin);
    if (byId.has(asset.assetId)) throw invalid();
    byId.set(asset.assetId, asset);
  }
  return byId;
}

function validateBindings(block) {
  if (!cleanText(block.text, MAX_TEXT_BYTES) || !/[А-Яа-яЁё]/u.test(block.text)
    || !Array.isArray(block.sourceFactIds) || block.sourceFactIds.length < 1 || block.sourceFactIds.length > 32
    || new Set(block.sourceFactIds).size !== block.sourceFactIds.length
    || block.sourceFactIds.some((factId) => !cleanText(factId))
    || !Array.isArray(block.factBindings) || block.factBindings.length !== block.sourceFactIds.length) throw invalid();
  const boundIds = new Set();
  for (const binding of block.factBindings) {
    if (!exactObject(binding, FACT_BINDING_KEYS) || !cleanText(binding.sourceFactId)
      || !cleanText(binding.field, 512) || !cleanText(binding.value, 2_048)
      || !(binding.numericValue === null || (typeof binding.numericValue === "number" && Number.isFinite(binding.numericValue)))
      || !(binding.unit === null || cleanText(binding.unit, 64))
      || !block.sourceFactIds.includes(binding.sourceFactId) || boundIds.has(binding.sourceFactId)) throw invalid();
    boundIds.add(binding.sourceFactId);
  }
}

function imageBlock(asset) {
  return { img: { src: asset.url, srcMobile: asset.url } };
}

function convertBlock(block, index, assetsById) {
  if (!plainObject(block) || !cleanText(block.type, 80)) throw invalid();
  if (block.type === "HERO_IMAGE") {
    if (!exactObject(block, HERO_BLOCK_KEYS) || index !== 0 || !cleanText(block.assetId)) throw invalid();
    const asset = assetsById.get(block.assetId);
    if (!asset || asset.role !== "MAIN") throw invalid();
    return { widgetName: "raShowcase", type: "billboard", blocks: [imageBlock(asset)] };
  }
  if (block.type === "HEADING" || block.type === "TEXT") {
    if (!exactObject(block, TEXT_BLOCK_KEYS)) throw invalid();
    validateBindings(block);
    return block.type === "HEADING"
      ? { widgetName: "raTextBlock", title: { content: [block.text] } }
      : { widgetName: "raTextBlock", text: { content: [block.text] } };
  }
  if (block.type === "IMAGE_TEXT") {
    if (!exactObject(block, IMAGE_TEXT_BLOCK_KEYS) || !cleanText(block.assetId)) throw invalid();
    validateBindings(block);
    const asset = assetsById.get(block.assetId);
    if (!asset) throw invalid();
    return {
      widgetName: "raShowcase",
      type: "billboard",
      blocks: [{ ...imageBlock(asset), title: { content: [block.text] } }],
    };
  }
  throw invalid();
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

/**
 * Deterministic adapter for the Ozon 0.3 rich-content contract.
 * V2 was accepted by a controlled real Ozon import before this release gate was opened.
 */
export function convertAutoListingRichContentToOzon(input = {}) {
  if (!exactObject(input, INPUT_KEYS)) throw invalid();
  if (!exactObject(input.scope, SCOPE_KEYS) || [...SCOPE_KEYS].some((key) => !cleanText(input.scope[key]))) throw invalid();
  const requiredOrigin = publicationOrigin(input.publicationPolicy);
  const document = input.richContent;
  if (!exactObject(document, DOCUMENT_KEYS) || document.version !== INTERNAL_VERSION || document.language !== "ru"
    || !Array.isArray(document.blocks) || document.blocks.length < 3 || document.blocks.length > 20) throw invalid();
  const assetsById = normalizeAssets(input.publishedAssets, input.scope, requiredOrigin);
  if (document.blocks.filter((block) => block?.type === "HERO_IMAGE").length !== 1) throw invalid();
  const ozonDocument = {
    content: document.blocks.map((block, index) => convertBlock(block, index, assetsById)),
    version: 0.3,
  };
  const value = JSON.stringify(ozonDocument);
  if (Buffer.byteLength(value, "utf8") > MAX_OUTPUT_BYTES) throw invalid();
  return deepFreeze({
    version: AUTO_LISTING_OZON_RICH_CONTENT_VERSION,
    value,
    valueHash: crypto.createHash("sha256").update(value, "utf8").digest("hex"),
  });
}
