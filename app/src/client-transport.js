const localApiBase = String(import.meta.env?.VITE_LOCAL_API_BASE || "/api").replace(/\/$/, "");

export function localApiAssetUrl(path) {
  if (typeof path !== "string" || !path.startsWith("/api/") || path.includes("?") || path.includes("#")) {
    throw Object.assign(new Error("CLIENT_REQUEST_INVALID"), { code: "CLIENT_REQUEST_INVALID" });
  }
  return `${localApiBase}${path.slice(4)}`;
}

export function apiResponseError(response = {}, data = null) {
  return Object.assign(
    new Error(data?.message || data?.error || `HTTP ${response.status}`),
    {
      status: Number(response.status) || 0,
      code: data?.code || "",
      body: data,
    },
  );
}

async function readResponseText(response, maximumBytes) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    return response.text();
  }
  if (!response.body?.getReader) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maximumBytes) {
      throw Object.assign(new Error("RESPONSE_TOO_LARGE"), { code: "RESPONSE_TOO_LARGE" });
    }
    return text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > maximumBytes) {
        await reader.cancel();
        throw Object.assign(new Error("RESPONSE_TOO_LARGE"), { code: "RESPONSE_TOO_LARGE" });
      }
      chunks.push(next.value);
    }
    const joined = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
    return new TextDecoder().decode(joined);
  } finally {
    reader.releaseLock?.();
  }
}

export const apiRequest = async (path, options = {}) => {
  const hasBody = Object.hasOwn(options, "body");
  const hasSerializedBody = Object.hasOwn(options, "serializedBody");
  const maxSerializedBodyBytes = options.maxSerializedBodyBytes ?? 8_388_608;
  const maxResponseBytes = options.maxResponseBytes;
  if ((hasBody && hasSerializedBody)
    || !Number.isSafeInteger(maxSerializedBodyBytes) || maxSerializedBodyBytes < 1
    || maxSerializedBodyBytes > 96 * 1024 * 1024
    || (maxResponseBytes !== undefined && (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > 96 * 1024 * 1024))
    || (hasSerializedBody && (typeof options.serializedBody !== "string"
      || new TextEncoder().encode(options.serializedBody).byteLength > maxSerializedBodyBytes))) {
    throw Object.assign(new Error("CLIENT_REQUEST_INVALID"), { code: "CLIENT_REQUEST_INVALID" });
  }
  const timeoutMs = options.timeoutMs;
  if (timeoutMs !== undefined
    && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000)) {
    throw Object.assign(new Error("CLIENT_REQUEST_INVALID"), { code: "CLIENT_REQUEST_INVALID" });
  }
  const token = globalThis.localStorage?.getItem?.("token") || "";
  const controller = timeoutMs === undefined ? null : new AbortController();
  let timedOut = false;
  const onExternalAbort = () => controller?.abort(options.signal?.reason);
  if (controller && options.signal?.aborted) onExternalAbort();
  else if (controller) options.signal?.addEventListener?.("abort", onExternalAbort, { once: true });
  const timer = controller ? setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs) : null;
  const signal = controller?.signal ?? options.signal;
  try {
    const response = await fetch(`${localApiBase}${path}`, {
      method: options.method || "GET",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(options.headers || {}),
      },
      body: hasSerializedBody ? options.serializedBody : (hasBody ? JSON.stringify(options.body) : undefined),
      signal,
    });
    const text = await readResponseText(response, maxResponseBytes);
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        throw Object.assign(new Error("INVALID_JSON_RESPONSE"), {
          code: "INVALID_JSON_RESPONSE",
          status: Number(response.status) || 0,
        });
      }
    }
    if (!response.ok) throw apiResponseError(response, data);
    return data;
  } catch (error) {
    if (timedOut) throw Object.assign(new Error("REQUEST_TIMEOUT"), { code: "REQUEST_TIMEOUT" });
    if (signal?.aborted && error?.code !== "INVALID_JSON_RESPONSE") {
      throw Object.assign(new Error("REQUEST_ABORTED"), { code: "REQUEST_ABORTED" });
    }
    throw error;
  } finally {
    if (timer !== null) clearTimeout(timer);
    if (controller) options.signal?.removeEventListener?.("abort", onExternalAbort);
  }
};

export const postMessageRequest = (message, responseKey, timeoutMs = 1200) =>
  new Promise((resolve, reject) => {
    const id = message.id || `local-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const timer = setTimeout(() => {
      window.removeEventListener("message", onMessage);
      reject(new Error("浏览器插件未响应"));
    }, timeoutMs);
    const onMessage = (event) => {
      if (event.source !== window) return;
      const data = event.data;
      if (!data || data[responseKey] !== 1 || data.id !== id) return;
      clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      if (data.ok === false) reject(new Error(data.error || "插件返回失败"));
      else resolve(data);
    };
    window.addEventListener("message", onMessage);
    window.postMessage({ ...message, id }, window.location.origin);
  });
