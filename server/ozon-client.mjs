const OZON_API_BASE = process.env.OZON_API_BASE || "https://api-seller.ozon.ru";

function shortText(value, max = 600) {
  return String(value ?? "").trim().slice(0, max);
}

function redactedText(value, store, max = 600) {
  let text = shortText(value, max);
  for (const credential of [store?.clientId, store?.apiKey]) {
    const secret = String(credential ?? "");
    if (secret) text = text.replaceAll(secret, "[REDACTED]");
  }
  return text;
}

function safeOzonMachineCode(data, store) {
  const candidate = data?.code ?? data?.error_code ?? data?.error?.code ?? "";
  const bounded = redactedText(candidate, store, 80);
  return /^[A-Za-z0-9_.-]+$/.test(bounded) ? bounded : "";
}

function safeNetworkCause(error, store, code) {
  const source = error?.cause || error;
  const cause = new Error(redactedText(source?.message || source, store, 500) || "Ozon network error");
  cause.name = String(source?.name || "Error");
  if (code) cause.code = code;
  return cause;
}

function networkError(store, apiPath, error, timeoutMs, phase = "请求") {
  const aborted = error?.name === "AbortError";
  const detail = redactedText(error?.cause?.message || error?.message || error, store, 500);
  const code = aborted
    ? "OZON_TIMEOUT"
    : redactedText(error?.cause?.code || error?.code, store, 80);
  const next = new Error(
    aborted
      ? `Ozon API 请求超时：${apiPath}（${timeoutMs}ms）`
      : `Ozon API ${phase}失败：${apiPath}${code ? `（${code}）` : ""}${detail ? `：${detail}` : ""}`,
  );
  next.status = aborted ? 504 : 502;
  next.code = code || (aborted ? "OZON_TIMEOUT" : "OZON_NETWORK_ERROR");
  next.body = {
    apiPath,
    network: true,
    code: next.code,
    detail,
    phase,
  };
  next.cause = safeNetworkCause(error, store, code);
  return next;
}

function credentialsError(apiPath) {
  const error = new Error("Ozon Client ID / API Key 未配置");
  error.status = 400;
  error.code = "OZON_CREDENTIALS_MISSING";
  error.body = { apiPath, code: error.code };
  error.cause = null;
  return error;
}

function responseReadFailure(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function cancelResponseBody(response, controller, reason) {
  controller.abort();
  try { await response?.body?.cancel?.(reason); } catch {}
}

async function readBoundedResponseText(response, controller, maxResponseBytes) {
  const contentLengthText = response?.headers?.get?.("content-length") ?? "";
  if (/^\d+$/u.test(contentLengthText) && Number(contentLengthText) > maxResponseBytes) {
    const failure = responseReadFailure("OZON_RESPONSE_TOO_LARGE", "Ozon 响应超过安全大小限制");
    await cancelResponseBody(response, controller, failure);
    throw failure;
  }
  if (!response?.body || typeof response.body.getReader !== "function") {
    throw responseReadFailure("OZON_RESPONSE_READ_FAILED", "Ozon 响应不支持受限读取");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks = [];
  let bytesRead = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) {
        throw responseReadFailure("OZON_RESPONSE_READ_FAILED", "Ozon 响应分块无效");
      }
      bytesRead += value.byteLength;
      if (bytesRead > maxResponseBytes) {
        const failure = responseReadFailure("OZON_RESPONSE_TOO_LARGE", "Ozon 响应超过安全大小限制");
        controller.abort();
        try { await reader.cancel(failure); } catch {}
        throw failure;
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join("");
  } finally {
    try { reader.releaseLock(); } catch {}
  }
}

async function requestOzonSellerApi(store, apiPath, {
  method,
  body,
  timeoutMs = 60000,
  maxResponseBytes = 0,
  signal,
}) {
  if (!store?.clientId || !store?.apiKey) {
    throw credentialsError(apiPath);
  }
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    throw new TypeError("Ozon request signal must be an AbortSignal");
  }
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(signal.reason);
  if (signal?.aborted) abortFromCaller();
  else signal?.addEventListener("abort", abortFromCaller, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response;
    try {
      const headers = {
        "Client-Id": String(store.clientId),
        "Api-Key": String(store.apiKey),
        ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
      };
      response = await fetch(`${OZON_API_BASE}${apiPath}`, {
        method,
        headers,
        ...(method === "POST" ? { body: JSON.stringify(body || {}) } : {}),
        signal: controller.signal,
      });
    } catch (error) {
      throw networkError(store, apiPath, error, timeoutMs);
    }
    let responseText = "";
    try {
      responseText = maxResponseBytes > 0
        ? await readBoundedResponseText(response, controller, maxResponseBytes)
        : await response.text();
    } catch (error) {
      throw networkError(store, apiPath, error, timeoutMs, "读取响应");
    }
    let data = null;
    let responseFormat = "empty";
    try {
      if (responseText.trim()) {
        data = JSON.parse(responseText);
        responseFormat = "json";
      }
    } catch {
      data = { raw: shortText(responseText) };
      responseFormat = "text";
    }
    if (!response.ok) {
      const status = Number.isFinite(Number(response.status)) ? Number(response.status) : 0;
      const code = `OZON_HTTP_${status}`;
      const ozonCode = responseFormat === "json" ? safeOzonMachineCode(data, store) : "";
      const error = new Error(
        `Ozon ${status}: ${apiPath} (${code})`,
      );
      error.status = status;
      error.code = code;
      error.body = {
        apiPath,
        status,
        code,
        responseFormat,
        ...(ozonCode ? { ozonCode } : {}),
      };
      error.cause = null;
      throw error;
    }
    return data;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abortFromCaller);
  }
}

export function callOzonSellerApi(store, apiPath, body, timeoutMs = 60000, options = {}) {
  const maxResponseBytes = Number(options?.maxResponseBytes || 0);
  return requestOzonSellerApi(store, apiPath, {
    method: "POST",
    body: body || {},
    timeoutMs,
    maxResponseBytes: Number.isSafeInteger(maxResponseBytes) && maxResponseBytes > 0 ? maxResponseBytes : 0,
    signal: options?.signal,
  });
}

export function getOzonSellerApi(store, apiPath, timeoutMs = 60000) {
  return requestOzonSellerApi(store, apiPath, { method: "GET", timeoutMs });
}
