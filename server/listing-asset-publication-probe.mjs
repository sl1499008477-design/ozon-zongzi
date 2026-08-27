import crypto from "node:crypto";
import dns from "node:dns/promises";
import https from "node:https";
import { isIP } from "node:net";

import { verifySub2ApiGatewayDnsBoundary } from "./sub2api-gateway-boundary.mjs";

const CONTENT_TYPE = "application/octet-stream";
const MAX_READ_BYTES = 1_024;
const TIMEOUT_MS = 5_000;
const SAFE_PREFIX = /^[A-Za-z0-9][A-Za-z0-9/_-]{0,159}$/u;
const SAFE_VERSION = /^[A-Z0-9][A-Z0-9_-]{0,63}$/u;
const SAFE_UUID = /^[a-f0-9-]{36}$/u;
const HTTPS_DNS_ENDPOINT = "https://cloudflare-dns.com/dns-query";

function probeError(code = "LISTING_ASSET_PUBLICATION_PROBE_INVALID") {
  const error = new Error("公开媒体可访问检查配置无效");
  error.code = code;
  error.status = 422;
  error.retryable = false;
  return error;
}

function exactPolicy(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) throw probeError();
  const keys = Reflect.ownKeys(raw);
  if (keys.length !== 4
    || keys.some((key) => typeof key !== "string"
      || !["origin", "baseUrl", "prefix", "publicationVersion"].includes(key))) throw probeError();
  let url;
  try { url = new URL(raw.baseUrl); } catch { throw probeError(); }
  const hostname = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash
    || !url.pathname.endsWith("/") || url.origin !== raw.origin || !hostname.includes(".")
    || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")
    || hostname.endsWith(".internal") || isIP(hostname) !== 0
    || !SAFE_PREFIX.test(raw.prefix || "") || raw.prefix.includes("//") || raw.prefix.endsWith("/")
    || !SAFE_VERSION.test(raw.publicationVersion || "")) throw probeError();
  return Object.freeze({ ...raw, baseUrl: url.href });
}

function evidence(httpStatus = 503, contentTypeMatched = false, bytesMatched = false) {
  return Object.freeze({
    probeKind: "PUBLIC_READBACK",
    httpStatus: Number.isSafeInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599 ? httpStatus : 503,
    contentTypeMatched: contentTypeMatched === true,
    bytesMatched: bytesMatched === true,
  });
}

function aborted(signal) {
  return signal?.reason || Object.assign(new Error("request aborted"), { name: "AbortError" });
}

async function abortable(promise, signal) {
  if (signal?.aborted) throw aborted(signal);
  let removeAbort = () => {};
  try {
    return await Promise.race([Promise.resolve(promise), new Promise((_, reject) => {
      if (!signal?.addEventListener) return;
      const onAbort = () => reject(aborted(signal));
      signal.addEventListener("abort", onAbort, { once: true });
      removeAbort = () => signal.removeEventListener?.("abort", onAbort);
    })]);
  } finally { removeAbort(); }
}

async function boundedBody(response, signal) {
  const reader = response?.body?.getReader?.();
  if (!reader || typeof reader.read !== "function") {
    if (!response || typeof response[Symbol.asyncIterator] !== "function") return null;
    const iterator = response[Symbol.asyncIterator]();
    if (!iterator || typeof iterator.next !== "function") return null;
    const chunks = [];
    let total = 0;
    let interrupted = false;
    try {
      while (true) {
        const part = await abortable(iterator.next(), signal);
        if (part?.done) break;
        const bytes = Buffer.from(part?.value || []);
        total += bytes.length;
        if (total > MAX_READ_BYTES) {
          interrupted = true;
          return null;
        }
        chunks.push(bytes);
      }
      return Buffer.concat(chunks);
    } finally {
      if (interrupted || signal?.aborted) {
        try { response.destroy?.(); } catch {}
        try { Promise.resolve(iterator.return?.()).catch(() => {}); } catch {}
      }
    }
  }
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const part = await abortable(reader.read(), signal);
      if (part?.done) break;
      const bytes = Buffer.from(part?.value || []);
      total += bytes.length;
      if (total > MAX_READ_BYTES) {
        try { await reader.cancel?.(); } catch {}
        return null;
      }
      chunks.push(bytes);
    }
    return Buffer.concat(chunks);
  } finally {
    if (signal?.aborted) {
      try { await reader.cancel?.(); } catch {}
    }
    try { reader.releaseLock?.(); } catch {}
  }
}

function proxyFakeIpAnswers(value) {
  return Array.isArray(value) && value.length > 0 && value.every((answer) => {
    const address = typeof answer === "string" ? answer : answer?.address;
    if (isIP(address) !== 4) return false;
    const [first, second] = address.split(".").map(Number);
    return first === 198 && (second === 18 || second === 19);
  });
}

async function resolvePublicHostnameOverHttps(hostname, { signal, fetchDns = globalThis.fetch } = {}) {
  if (typeof fetchDns !== "function") throw probeError();
  const url = new URL(HTTPS_DNS_ENDPOINT);
  url.searchParams.set("name", hostname);
  url.searchParams.set("type", "A");
  const response = await fetchDns(url, {
    method: "GET",
    redirect: "error",
    signal,
    headers: { accept: "application/dns-json", "cache-control": "no-store" },
  });
  const status = Number(response?.status);
  const contentType = String(response?.headers?.get?.("content-type") || "")
    .split(";", 1)[0].trim().toLowerCase();
  if (status !== 200 || !["application/dns-json", "application/json"].includes(contentType)) {
    throw probeError();
  }
  const bytes = await boundedBody(response, signal);
  if (!Buffer.isBuffer(bytes)) throw probeError();
  let payload;
  try { payload = JSON.parse(bytes.toString("utf8")); } catch { throw probeError(); }
  if (payload?.Status !== 0 || !Array.isArray(payload.Answer) || payload.Answer.length > 32) {
    throw probeError();
  }
  const answers = payload.Answer
    .filter((answer) => answer?.type === 1 && typeof answer.data === "string" && isIP(answer.data) === 4)
    .map((answer) => Object.freeze({ address: answer.data, family: 4 }));
  if (!answers.length) throw probeError();
  return answers;
}

function requestPinnedHttpsObject(url, { method, headers, signal, address, requestHttps = https.request } = {}) {
  return new Promise((resolve, reject) => {
    let request;
    try {
      request = requestHttps(url, {
        method,
        headers,
        signal,
        lookup(hostname, options, callback) {
          const expected = new URL(url).hostname.toLowerCase();
          if (String(hostname).toLowerCase() !== expected) {
            callback(probeError());
            return;
          }
          if (options?.all === true) {
            callback(null, [{ address: address.address, family: address.family }]);
            return;
          }
          callback(null, address.address, address.family);
        },
      }, resolve);
    } catch (error) {
      reject(error);
      return;
    }
    request.once("error", reject);
    request.end();
  });
}

export function createListingAssetPublicationProbe({
  storage,
  resolveHostname = (hostname) => dns.lookup(hostname, { all: true, verbatim: true }),
  resolvePublicHostname = resolvePublicHostnameOverHttps,
  requestPublicObject = null,
  requestHttps = https.request,
  randomUUID = crypto.randomUUID,
  randomBytes = crypto.randomBytes,
  timers = { setTimeout, clearTimeout },
  timeoutMs = TIMEOUT_MS,
} = {}) {
  if (typeof storage?.putObjectFromBuffer !== "function" || typeof storage?.removeObject !== "function"
    || typeof resolveHostname !== "function"
    || typeof resolvePublicHostname !== "function"
    || !(requestPublicObject === null || typeof requestPublicObject === "function")
    || typeof requestHttps !== "function"
    || typeof randomUUID !== "function" || typeof randomBytes !== "function"
    || typeof timers?.setTimeout !== "function" || typeof timers?.clearTimeout !== "function"
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 60_000) {
    throw new TypeError("Listing asset publication probe dependencies are required");
  }
  const fetchPublicObject = requestPublicObject
    || ((url, options) => requestPinnedHttpsObject(url, { ...options, requestHttps }));
  return async function probePublicPolicy(raw = {}) {
    const policy = exactPolicy(raw);
    let uuid; let bytes;
    try {
      uuid = String(randomUUID()).toLowerCase();
      bytes = Buffer.from(randomBytes(32));
    } catch { throw probeError(); }
    if (!SAFE_UUID.test(uuid) || bytes.length < 8 || bytes.length > 64) throw probeError();
    const key = `${policy.prefix}/health/${uuid}.bin`;
    const url = new URL(key, policy.baseUrl);
    if (url.origin !== policy.origin || !url.pathname.endsWith(`/${key}`)) throw probeError();
    const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
    let wrote = false;
    let result = evidence();
    try {
      // The object key is deterministic for this probe attempt. Treat a lost
      // put response as a possible write and always try the same-key cleanup.
      wrote = true;
      const ack = await storage.putObjectFromBuffer({
        key, name: `${uuid}.bin`, contentType: CONTENT_TYPE, buffer: bytes, maxBytes: 64,
      });
      if (!ack || ack.key !== key || ack.sha256 !== sha256 || ack.contentType !== CONTENT_TYPE
        || ack.size !== bytes.length) return Object.freeze({ ok: false, evidence: result });
      const controller = new AbortController();
      const timer = timers.setTimeout(() => controller.abort(), timeoutMs);
      let response;
      try {
        let answers;
        await verifySub2ApiGatewayDnsBoundary({
          hostname: url.hostname,
          signal: controller.signal,
          resolveHostname: async (hostname) => {
            const systemAnswers = await resolveHostname(hostname);
            answers = proxyFakeIpAnswers(systemAnswers)
              ? await resolvePublicHostname(hostname, { signal: controller.signal })
              : systemAnswers;
            return answers;
          },
        });
        const first = Array.isArray(answers) ? answers[0] : null;
        const address = typeof first === "string"
          ? { address: first, family: isIP(first) }
          : { address: first?.address, family: Number(first?.family) || isIP(first?.address) };
        if (!address.address || ![4, 6].includes(address.family)) throw probeError();
        response = await fetchPublicObject(url.toString(), {
          method: "GET", redirect: "manual", signal: controller.signal,
          headers: { accept: CONTENT_TYPE, "cache-control": "no-store" },
          address: Object.freeze(address),
        });
        const status = Number(response?.status ?? response?.statusCode);
        const rawType = response?.headers?.get?.("content-type")
          ?? response?.headers?.["content-type"] ?? "";
        const type = String(rawType).split(";", 1)[0].trim().toLowerCase();
        const body = status >= 200 && status < 300
          ? await boundedBody(response, controller.signal) : null;
        const typeMatched = type === CONTENT_TYPE;
        const bytesMatched = Buffer.isBuffer(body) && body.length === bytes.length
          && crypto.timingSafeEqual(body, bytes);
        result = evidence(status, typeMatched, bytesMatched);
      } finally { timers.clearTimeout(timer); }
    } catch {
      result = evidence();
    } finally {
      if (wrote) {
        try { await storage.removeObject(key); } catch { result = evidence(result.httpStatus, false, false); }
      }
    }
    return Object.freeze({
      ok: result.httpStatus >= 200 && result.httpStatus < 300
        && result.contentTypeMatched && result.bytesMatched,
      evidence: result,
    });
  };
}
