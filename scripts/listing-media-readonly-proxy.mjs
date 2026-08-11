import crypto from "node:crypto";
import http from "node:http";
import { pathToFileURL } from "node:url";

import { getObjectBuffer } from "../server/object-storage.mjs";

const DEFAULT_PREFIX = "listing-media/v1";
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const HEALTH_PATH = /^health\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.bin$/u;
const IMAGE_PATH = /^([a-f0-9]{2})\/([a-f0-9]{64})\.(png|jpg|webp)$/u;
const CONTENT_TYPES = Object.freeze({ png: "image/png", jpg: "image/jpeg", webp: "image/webp" });

function safePrefix(value) {
  const prefix = String(value || DEFAULT_PREFIX).trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9/_-]{0,159}$/u.test(prefix)
    || prefix.includes("//") || prefix.endsWith("/")) {
    throw new TypeError("LISTING_MEDIA_PROXY_PREFIX_INVALID");
  }
  return prefix;
}

function routeFor(requestUrl, prefix) {
  const raw = typeof requestUrl === "string" ? requestUrl : "";
  if (!raw.startsWith("/") || raw.includes("%") || raw.includes("?") || raw.includes("#")) return null;
  let url;
  try { url = new URL(raw, "http://127.0.0.1"); } catch { return null; }
  const marker = `/${prefix}/`;
  if (!url.pathname.startsWith(marker)) return null;
  const suffix = url.pathname.slice(marker.length);
  if (HEALTH_PATH.test(suffix)) {
    return Object.freeze({ key: `${prefix}/${suffix}`, contentType: "application/octet-stream", maxBytes: 64, hash: null });
  }
  const image = suffix.match(IMAGE_PATH);
  if (!image || image[1] !== image[2].slice(0, 2)) return null;
  return Object.freeze({
    key: `${prefix}/${suffix}`,
    contentType: CONTENT_TYPES[image[3]],
    maxBytes: MAX_IMAGE_BYTES,
    hash: image[2],
  });
}

function respond(res, method, statusCode, headers = {}, body = null) {
  res.writeHead(statusCode, {
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
    ...headers,
  });
  res.end(method === "HEAD" ? null : body);
}

export function createListingMediaReadonlyHandler({
  getObject = getObjectBuffer,
  prefix: rawPrefix = DEFAULT_PREFIX,
} = {}) {
  if (typeof getObject !== "function") throw new TypeError("LISTING_MEDIA_PROXY_STORAGE_INVALID");
  const prefix = safePrefix(rawPrefix);
  return async function handleListingMediaReadonly(req, res) {
    const method = String(req?.method || "").toUpperCase();
    const route = routeFor(req?.url, prefix);
    if (!route) {
      respond(res, method, 404, { "Cache-Control": "no-store" }, "Not Found");
      return;
    }
    if (!new Set(["GET", "HEAD"]).has(method)) {
      respond(res, method, 405, { Allow: "GET, HEAD", "Cache-Control": "no-store" }, "Method Not Allowed");
      return;
    }
    try {
      const bytes = await getObject(route.key, { maxBytes: route.maxBytes });
      if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > route.maxBytes) throw new Error("invalid object");
      if (route.hash && crypto.createHash("sha256").update(bytes).digest("hex") !== route.hash) {
        throw new Error("content hash mismatch");
      }
      respond(res, method, 200, {
        "Content-Type": route.contentType,
        "Content-Length": String(bytes.length),
        "Cache-Control": route.hash ? "public, max-age=31536000, immutable" : "no-store",
      }, bytes);
    } catch {
      respond(res, method, 404, { "Cache-Control": "no-store" }, "Not Found");
    }
  };
}

export function startListingMediaReadonlyProxy({
  host = "127.0.0.1",
  port = Number(process.env.LISTING_MEDIA_PROXY_PORT || 38127),
  prefix = process.env.LISTING_ASSET_PUBLIC_PREFIX || DEFAULT_PREFIX,
  getObject = getObjectBuffer,
} = {}) {
  if (host !== "127.0.0.1" || !Number.isSafeInteger(port) || port < 1024 || port > 65535) {
    throw new TypeError("LISTING_MEDIA_PROXY_BINDING_INVALID");
  }
  const handler = createListingMediaReadonlyHandler({ getObject, prefix });
  const server = http.createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch(() => respond(res, req?.method, 500, { "Cache-Control": "no-store" }, "Unavailable"));
  });
  server.listen(port, host, () => {
    process.stdout.write(`${JSON.stringify({ event: "listing_media_proxy_ready", host, port, prefix: safePrefix(prefix) })}\n`);
  });
  return server;
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) startListingMediaReadonlyProxy();
