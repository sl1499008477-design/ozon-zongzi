import { downloadCollectorExcelImage } from "./collector-excel-service.mjs";
import { inspectSourceListingImage } from "./auto-listing-asset-store.mjs";
import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { setTimeout as delay } from "node:timers/promises";

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
const OZON_IMAGE_HOST = /^(?:(?:ir(?:-\d+)?|cdn\d+)\.ozone\.ru|ir(?:-\d+)?\.ozonstatic\.cn)$/u;
const RETRYABLE_DOWNLOAD_CODES = new Set([
  "COLLECTOR_EXCEL_IMAGE_DNS_FAILED",
  "COLLECTOR_EXCEL_IMAGE_DOWNLOAD_FAILED",
  "COLLECTOR_EXCEL_IMAGE_TIMEOUT",
]);

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
  return {
    sourceUrl: parsed.href,
    maxPixels,
    allowBenchmarkAddressHost: parsed.protocol === "https:" && OZON_IMAGE_HOST.test(parsed.hostname)
      ? parsed.hostname
      : "",
  };
}

function safeSourceUrl(value) {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) return "";
    url.username = ""; url.password = ""; url.search = ""; url.hash = "";
    return url.href.slice(0, 1024);
  } catch { return ""; }
}

function underlyingCode(error) {
  let code = "";
  for (let depth = 0, value = error; value && depth < 4; depth++, value = value.cause) {
    if (typeof value.code === "string" && /^[A-Za-z0-9_:-]{1,100}$/u.test(value.code)) code = value.code;
  }
  return code;
}

function normalizeDownloadFailure(error, httpStatus = 0) {
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
  const deterministicCause = /CERT|TLS|SSL|ERR_INVALID/u.test(underlyingCode(error));
  const transientStatus = !httpStatus || httpStatus < 400 || [408, 429, 500, 502, 503, 504].includes(httpStatus);
  return sourceDownloadError("AUTO_LISTING_SOURCE_DOWNLOAD_FAILED", RETRYABLE_DOWNLOAD_CODES.has(code) && transientStatus && !deterministicCause);
}

export function createAutoListingSourceImageDownloader({
  lookupHost,
  requestImage,
  downloadImage = downloadCollectorExcelImage,
  sleep = delay,
  clock = Date.now,
} = {}) {
  if (typeof downloadImage !== "function") throw sourceDownloadError("AUTO_LISTING_SOURCE_DOWNLOAD_INPUT_INVALID");
  return Object.freeze({
    async downloadSourceImage(input = {}) {
      const startedAt = clock(), attempts = [];
      const elapsed = since => Math.max(0, clock() - since);
      const fail = (error, trace) => {
        error.diagnostic = { stage: "source_download", sourceUrl: safeSourceUrl(input?.sourceUrl),
          failedUrl: trace?.url || safeSourceUrl(input?.sourceUrl), attemptCount: attempts.length,
          elapsedMs: elapsed(startedAt), attempts };
        return error;
      };
      let validated;
      try { validated = assertInput(input); } catch (error) { throw fail(error); }
      let downloaded, trace, attemptStarted;
      for (let attempt = 1; attempt <= AUTO_LISTING_SOURCE_DOWNLOAD_POLICY.maxAttempts; attempt += 1) {
        attemptStarted = clock();
        trace = { attempt, stage: "download", url: safeSourceUrl(validated.sourceUrl), dnsMs: 0, requestMs: 0, bodyMs: 0 };
        let bodyStarted, requestStarted;
        try {
          downloaded = await downloadImage(validated.sourceUrl, {
            timeoutMs: input.timeoutMs,
            maxImageBytes: input.maxBytes,
            maxImageRedirects: input.maxRedirects,
            forbidHttpsDowngrade: true,
            imageDnsLookup: async (...args) => {
              trace.stage = "dns"; const at = clock();
              delete trace.httpStatus;
              try { return await (lookupHost || lookup)(...args); }
              finally { trace.dnsMs += elapsed(at); }
            },
            imageRequest: (target, options, respond) => {
              trace.stage = "request"; trace.url = safeSourceUrl(target.href);
              const at = clock(), request = requestImage || (target.protocol === "https:" ? https : http).request;
              requestStarted = at;
              return request(target, options, response => {
                trace.requestMs += elapsed(at);
                requestStarted = undefined;
                trace.httpStatus = Number(response.statusCode) || 0;
                const location = response.headers?.location;
                if ([301, 302, 303, 307, 308].includes(trace.httpStatus) && location) {
                  try { trace.url = safeSourceUrl(new URL(Array.isArray(location) ? location[0] : location, target).href); } catch { /* downloader rejects malformed redirects */ }
                }
                if (trace.httpStatus >= 200 && trace.httpStatus < 300) { trace.stage = "body"; bodyStarted = clock(); }
                respond(response);
              });
            },
            allowBenchmarkAddressHost: validated.allowBenchmarkAddressHost,
          });
          if (bodyStarted !== undefined) trace.bodyMs += elapsed(bodyStarted);
          trace.elapsedMs = elapsed(attemptStarted);
          attempts.push(trace);
          break;
        } catch (error) {
          if (requestStarted !== undefined) trace.requestMs += elapsed(requestStarted);
          if (bodyStarted !== undefined) trace.bodyMs += elapsed(bodyStarted);
          Object.assign(trace, { elapsedMs: elapsed(attemptStarted), upstreamCode: underlyingCode(error) });
          attempts.push(trace);
          const normalized = normalizeDownloadFailure(error, trace.httpStatus);
          if (!normalized.retryable || attempt === AUTO_LISTING_SOURCE_DOWNLOAD_POLICY.maxAttempts) {
            throw fail(normalized, trace);
          }
          await sleep(250 * 2 ** (attempt - 1));
        }
      }
      const bytes = Buffer.isBuffer(downloaded?.buffer) ? downloaded.buffer : Buffer.from(downloaded?.buffer || []);
      let inspected;
      const inspectionStarted = clock();
      try {
        inspected = await inspectSourceListingImage({
          bytes,
          maxInputBytes: input.maxBytes,
          maxInputPixels: validated.maxPixels,
        });
      } catch (error) {
        Object.assign(trace, { stage: "inspect", upstreamCode: underlyingCode(error), elapsedMs: elapsed(attemptStarted), inspectMs: elapsed(inspectionStarted) });
        throw fail(sourceDownloadError("AUTO_LISTING_SOURCE_IMAGE_INVALID"), trace);
      }
      if (bytes.length > input.maxBytes || downloaded.contentType !== inspected.contentType) {
        trace.stage = "inspect"; trace.elapsedMs = elapsed(attemptStarted); trace.inspectMs = elapsed(inspectionStarted);
        throw fail(sourceDownloadError(bytes.length > input.maxBytes
          ? "AUTO_LISTING_SOURCE_IMAGE_TOO_LARGE"
          : "AUTO_LISTING_SOURCE_IMAGE_INVALID"), trace);
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
