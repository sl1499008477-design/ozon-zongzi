import { downloadCollectorExcelImage } from "./collector-excel-service.mjs";
import { inspectSourceListingImage } from "./auto-listing-asset-store.mjs";

export const AUTO_LISTING_SOURCE_DOWNLOAD_POLICY = Object.freeze({
  policyVersion: "SOURCE_DOWNLOAD_V1",
  timeoutMs: 10_000,
  maxBytes: 8 * 1024 * 1024,
  maxPixels: 40_000_000,
  maxRedirects: 3,
  maxAttempts: 3,
  forbidHttpsDowngrade: true,
});
const DOWNLOAD_INPUT_KEYS = new Set(["sourceUrl", "timeoutMs", "maxBytes", "maxPixels", "maxRedirects", "forbidHttpsDowngrade"]);
const DOWNLOAD_REQUIRED_KEYS = Object.freeze(["sourceUrl", "timeoutMs", "maxBytes", "maxRedirects", "forbidHttpsDowngrade"]);

function sourceDownloadError(code, retryable = false) {
  const value = new Error("自动上架来源图片暂时无法读取");
  value.code = code;
  value.retryable = retryable;
  return value;
}

function positiveInteger(value, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  return Number.isSafeInteger(value) && value >= min && value <= max;
}

function assertInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw sourceDownloadError("AUTO_LISTING_SOURCE_DOWNLOAD_INPUT_INVALID");
  }
  if (Object.keys(input).some((key) => !DOWNLOAD_INPUT_KEYS.has(key))
    || DOWNLOAD_REQUIRED_KEYS.some((key) => !Object.hasOwn(input, key))) {
    throw sourceDownloadError("AUTO_LISTING_SOURCE_DOWNLOAD_INPUT_INVALID");
  }
  let parsed;
  try { parsed = new URL(input.sourceUrl); } catch { throw sourceDownloadError("AUTO_LISTING_SOURCE_DOWNLOAD_BLOCKED"); }
  const maxPixels = input.maxPixels ?? AUTO_LISTING_SOURCE_DOWNLOAD_POLICY.maxPixels;
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password
    || Buffer.byteLength(parsed.href, "utf8") > 8192) {
    throw sourceDownloadError("AUTO_LISTING_SOURCE_DOWNLOAD_BLOCKED");
  }
  if (!positiveInteger(input.timeoutMs, { min: 250, max: 60_000 })
    || !positiveInteger(input.maxBytes, { min: 1, max: AUTO_LISTING_SOURCE_DOWNLOAD_POLICY.maxBytes })
    || !positiveInteger(maxPixels, { min: 1, max: AUTO_LISTING_SOURCE_DOWNLOAD_POLICY.maxPixels })
    || !positiveInteger(input.maxRedirects, { min: 0, max: AUTO_LISTING_SOURCE_DOWNLOAD_POLICY.maxRedirects })
    || input.forbidHttpsDowngrade !== true) throw sourceDownloadError("AUTO_LISTING_SOURCE_DOWNLOAD_INPUT_INVALID");
  return { sourceUrl: parsed.href, maxPixels };
}

function normalizeDownloadFailure(error) {
  const code = typeof error?.code === "string" ? error.code : "";
  if (/_(?:PROTOCOL|URL_CREDENTIALS|HOST|PRIVATE_ADDRESS|HTTPS_DOWNGRADE)_?BLOCKED$|_PRIVATE_ADDRESS$/u.test(code)) {
    return sourceDownloadError("AUTO_LISTING_SOURCE_DOWNLOAD_BLOCKED");
  }
  if (code === "COLLECTOR_EXCEL_IMAGE_TOO_LARGE" || code === "COLLECTOR_EXCEL_DATA_URL_TOO_LARGE") {
    return sourceDownloadError("AUTO_LISTING_SOURCE_IMAGE_TOO_LARGE");
  }
  if (/_(?:CONTENT_TYPE|CONTENT_ENCODING)_BLOCKED$|_SIGNATURE_INVALID$|_DATA_URL_INVALID$/u.test(code)) {
    return sourceDownloadError("AUTO_LISTING_SOURCE_IMAGE_INVALID");
  }
  if (code === "COLLECTOR_EXCEL_IMAGE_URL_INVALID" || code === "COLLECTOR_EXCEL_IMAGE_URL_TOO_LONG") {
    return sourceDownloadError("AUTO_LISTING_SOURCE_DOWNLOAD_BLOCKED");
  }
  return sourceDownloadError("AUTO_LISTING_SOURCE_DOWNLOAD_FAILED", true);
}

export function createAutoListingSourceImageDownloader({
  lookupHost,
  requestImage,
  downloadImage = downloadCollectorExcelImage,
} = {}) {
  if (typeof downloadImage !== "function") throw sourceDownloadError("AUTO_LISTING_SOURCE_DOWNLOAD_INPUT_INVALID");
  return Object.freeze({
    async downloadSourceImage(input = {}) {
      const validated = assertInput(input);
      let downloaded;
      try {
        downloaded = await downloadImage(validated.sourceUrl, {
          timeoutMs: input.timeoutMs,
          maxImageBytes: input.maxBytes,
          maxImageRedirects: input.maxRedirects,
          forbidHttpsDowngrade: true,
          imageDnsLookup: lookupHost,
          imageRequest: requestImage,
        });
      } catch (error) {
        throw normalizeDownloadFailure(error);
      }
      const bytes = Buffer.isBuffer(downloaded?.buffer) ? downloaded.buffer : Buffer.from(downloaded?.buffer || []);
      let inspected;
      try {
        inspected = await inspectSourceListingImage({
          bytes,
          maxInputBytes: input.maxBytes,
          maxInputPixels: validated.maxPixels,
        });
      } catch {
        throw sourceDownloadError("AUTO_LISTING_SOURCE_IMAGE_INVALID");
      }
      if (bytes.length > input.maxBytes || downloaded.contentType !== inspected.contentType) {
        throw sourceDownloadError(bytes.length > input.maxBytes
          ? "AUTO_LISTING_SOURCE_IMAGE_TOO_LARGE"
          : "AUTO_LISTING_SOURCE_IMAGE_INVALID");
      }
      return Object.freeze({
        bytes,
        contentHash: inspected.contentHash,
        contentType: inspected.contentType,
        width: inspected.width,
        height: inspected.height,
        sizeBytes: bytes.length,
      });
    },
  });
}

const defaultDownloader = createAutoListingSourceImageDownloader();
export const downloadSourceImage = (input) => defaultDownloader.downloadSourceImage(input);
