import { localApiAssetUrl } from "./client-transport.js";

const REVIEW_ASSET_PATH = /^\/auto-listing\/items\/[A-Za-z0-9][A-Za-z0-9._:-]{0,239}\/assets\/[A-Za-z0-9][A-Za-z0-9._:-]{0,239}(?:\/preview)?$/u;
const REVIEW_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const MAX_REVIEW_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_CONCURRENT_REVIEW_IMAGES = 2;
const pendingLoads = [];
let activeLoads = 0;

function runPendingLoads() {
  while (activeLoads < MAX_CONCURRENT_REVIEW_IMAGES && pendingLoads.length) {
    const entry = pendingLoads.shift();
    if (entry.signal?.aborted) {
      entry.cleanup();
      entry.reject(entry.signal.reason || reviewImageError());
      continue;
    }
    entry.started = true;
    activeLoads += 1;
    Promise.resolve().then(entry.operation).then(entry.resolve, entry.reject).finally(() => {
      activeLoads -= 1;
      entry.cleanup();
      runPendingLoads();
    });
  }
}

function queuedLoad(operation, signal) {
  return new Promise((resolve, reject) => {
    const entry = {
      operation, signal, resolve, reject, started: false,
      cleanup: () => signal?.removeEventListener?.("abort", onAbort),
    };
    const onAbort = () => {
      if (entry.started) return;
      const index = pendingLoads.indexOf(entry);
      if (index >= 0) pendingLoads.splice(index, 1);
      entry.cleanup();
      reject(signal.reason || reviewImageError());
    };
    signal?.addEventListener?.("abort", onAbort, { once: true });
    pendingLoads.push(entry);
    runPendingLoads();
  });
}

function reviewImageError() {
  return Object.assign(new Error("AUTO_LISTING_REVIEW_IMAGE_INVALID"), {
    code: "AUTO_LISTING_REVIEW_IMAGE_INVALID",
  });
}

async function boundedImageBytes(response) {
  const declaredLength = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declaredLength)
    && (!Number.isSafeInteger(declaredLength) || declaredLength < 1 || declaredLength > MAX_REVIEW_IMAGE_BYTES)) {
    throw reviewImageError();
  }
  if (!response.body?.getReader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!bytes.byteLength || bytes.byteLength > MAX_REVIEW_IMAGE_BYTES) throw reviewImageError();
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_REVIEW_IMAGE_BYTES) {
        await reader.cancel();
        throw reviewImageError();
      }
      chunks.push(next.value);
    }
    if (!total) throw reviewImageError();
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  } finally {
    reader.releaseLock?.();
  }
}

export async function loadAutoListingReviewImage(rawPath, {
  token = globalThis.localStorage?.getItem?.("token") || "",
  fetchImpl = globalThis.fetch,
  signal,
} = {}) {
  try {
    const path = typeof rawPath === "string" ? rawPath.trim() : "";
    if (!REVIEW_ASSET_PATH.test(path) || typeof token !== "string" || !token || token.length > 8_192
      || typeof fetchImpl !== "function") throw reviewImageError();
    return await queuedLoad(async () => {
      const response = await fetchImpl(localApiAssetUrl(`/api${path}`), {
        headers: {
          Accept: "image/png,image/jpeg,image/webp",
          Authorization: `Bearer ${token}`,
        },
        signal,
      });
      const contentType = String(response?.headers?.get?.("content-type") || "")
        .split(";")[0].trim().toLowerCase();
      if (!response?.ok || !REVIEW_IMAGE_TYPES.has(contentType)) throw reviewImageError();
      return new Blob([await boundedImageBytes(response)], { type: contentType });
    }, signal);
  } catch {
    throw reviewImageError();
  }
}
